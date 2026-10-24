#include "check.h"
#include "testutil.h"

#include "hostcore/Options.h"
#include "hostcore/RunGuard.h"
#include "jobio/Job.h"

#include <csignal>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <string>
#include <pthread.h>
#include <sys/wait.h>
#include <thread>
#include <unistd.h>
#include <vector>

namespace
{
    bool parses (const std::vector<std::string>& args, bridge::HostOptions& options)
    {
        std::string error;
        options = {};
        return bridge::parseHostArguments (args, options, error);
    }

    // Runs 'body' in a child process and returns its wait status.
    template <typename Body>
    int inChild (Body body)
    {
        std::fflush (stdout);
        const pid_t pid { fork () };
        if (pid == 0)
        {
            body ();
            _exit (0);
        }
        int status { 0 };
        waitpid (pid, &status, 0);
        return status;
    }
}

TEST (options_parse_job_and_autorender)
{
    bridge::HostOptions options;
    REQUIRE (parses ({ "--job", "/tmp/j", "--autorender" }, options));
    CHECK (options.jobDir == "/tmp/j");
    CHECK (options.autorender);
    REQUIRE (parses ({ "-psn_0_12345", "--job", "/tmp/k" }, options));
    CHECK (options.jobDir == "/tmp/k");
    CHECK (! options.autorender);
}

TEST (options_reject_bad_arguments)
{
    bridge::HostOptions options;
    CHECK (! parses ({}, options));
    CHECK (! parses ({ "--job" }, options));
    CHECK (! parses ({ "--job", "" }, options));
    CHECK (! parses ({ "--autorender" }, options));
    CHECK (! parses ({ "--job", "/a", "--job", "/b" }, options));
    CHECK (! parses ({ "--job", "/a", "--frobnicate" }, options));
    std::string error;
    CHECK (! bridge::parseHostArguments ({ "--job", "/a", "extra" }, options, error));
    CHECK (error.find ("extra") != std::string::npos);
}

TEST (path_lists_split_on_colons)
{
    CHECK ((bridge::splitPathList ("/a:/b c::/d:") == std::vector<std::string> { "/a", "/b c", "/d" }));
    CHECK (bridge::splitPathList ("").empty ());
}

TEST (fallback_is_written_only_once_and_never_over_a_result)
{
    const std::string dir { makeTempDir ("fallback") };
    std::string error;
    REQUIRE (bridge::prepareFallbackResults (dir, "job-f", 42.0, error));

    CHECK (bridge::writeFallbackResult (0));
    bridge::ResultInfo info;
    REQUIRE (bridge::readResult (dir, info, error));
    CHECK (info.id == "job-f");
    CHECK (info.status == "error");
    CHECK (info.message.find ("42") != std::string::npos);

    CHECK (! bridge::writeFallbackResult (SIGSEGV));     // result.json exists now
    REQUIRE (bridge::readResult (dir, info, error));
    CHECK (info.message.find ("42") != std::string::npos);
    CHECK (! std::filesystem::exists (dir + "/result.json.fallback.tmp"));
}

TEST (fallback_is_not_written_after_the_normal_result)
{
    const std::string dir { makeTempDir ("fallback_marked") };
    std::string error;
    REQUIRE (bridge::prepareFallbackResults (dir, "job-g", 10.0, error));
    const int status { inChild ([] { bridge::markResultWritten (); _exit (bridge::writeFallbackResult (SIGTERM) ? 1 : 0); }) };
    CHECK (WIFEXITED (status) && WEXITSTATUS (status) == 0);
    CHECK (! std::filesystem::exists (dir + "/result.json"));
}

TEST (a_crash_signal_writes_the_fallback_and_still_kills_the_process)
{
    const std::string dir { makeTempDir ("fallback_crash") };
    std::string error;
    REQUIRE (bridge::prepareFallbackResults (dir, "job-c", 10.0, error));
    const int status { inChild ([] { bridge::installSignalHandlers (); std::raise (SIGABRT); }) };
    CHECK (WIFSIGNALED (status) && WTERMSIG (status) == SIGABRT);
    bridge::ResultInfo info;
    REQUIRE (bridge::readResult (dir, info, error));
    CHECK (info.status == "error");
    CHECK (info.message.find ("crashed") != std::string::npos);
    CHECK (info.message.find ("SIGABRT") != std::string::npos);
}

TEST (a_stop_signal_sets_the_flag_and_a_second_one_exits)
{
    const std::string dir { makeTempDir ("fallback_stop") };
    std::string error;
    REQUIRE (bridge::prepareFallbackResults (dir, "job-s", 10.0, error));

    // first signal: only the flag
    const int first { inChild ([] {
        bridge::installSignalHandlers ();
        std::raise (SIGTERM);
        _exit (bridge::stopRequested () && bridge::stopSignal () == SIGTERM ? 0 : 1);
    }) };
    CHECK (WIFEXITED (first) && WEXITSTATUS (first) == 0);
    CHECK (! std::filesystem::exists (dir + "/result.json"));

    // second signal: fallback result and exit code kExitStopped
    const int second { inChild ([] {
        bridge::installSignalHandlers ();
        std::raise (SIGINT);
        std::raise (SIGINT);
        _exit (0);
    }) };
    CHECK (WIFEXITED (second) && WEXITSTATUS (second) == bridge::kExitStopped);
    bridge::ResultInfo info;
    REQUIRE (bridge::readResult (dir, info, error));
    CHECK (info.status == "error");
    CHECK (info.message.find ("SIGINT") != std::string::npos);
}

TEST (handlers_can_be_restored)
{
    const int status { inChild ([] {
        bridge::installSignalHandlers ();
        bridge::restoreSignalHandlers ();
        std::raise (SIGTERM);
        _exit (0);
    }) };
    CHECK (WIFSIGNALED (status) && WTERMSIG (status) == SIGTERM);
    bridge::clearStopRequest ();
    CHECK (! bridge::stopRequested ());
}

TEST (fallback_never_replaces_a_result_written_without_marking)
{
    const std::string dir { makeTempDir ("fallback_unmarked") };
    std::string error;
    REQUIRE (bridge::prepareFallbackResults (dir, "job-u", 10.0, error));
    bridge::ResultInfo ok;
    ok.status = "ok";
    ok.message = "good";
    REQUIRE (bridge::writeResult (dir, "job-u", ok, error));
    std::ifstream before (dir + "/result.json", std::ios::binary);
    const std::string original ((std::istreambuf_iterator<char> (before)), std::istreambuf_iterator<char> ());

    CHECK (! bridge::writeFallbackResult (SIGSEGV));
    CHECK (! bridge::writeFallbackResult (0));
    std::ifstream after (dir + "/result.json", std::ios::binary);
    const std::string now ((std::istreambuf_iterator<char> (after)), std::istreambuf_iterator<char> ());
    CHECK (now == original);
    CHECK (! std::filesystem::exists (dir + "/result.json.fallback.tmp"));
}

TEST (the_watchdog_writes_the_timeout_fallback_and_exits)
{
    const std::string dir { makeTempDir ("fallback_alarm") };
    std::string error;
    REQUIRE (bridge::prepareFallbackResults (dir, "job-w", 1.0, error));
    const int status { inChild ([] {
        bridge::installSignalHandlers ();
        bridge::armWatchdog (1.0);
        for (;;)
            pause ();
    }) };
    CHECK (WIFEXITED (status) && WEXITSTATUS (status) == bridge::kExitStopped);
    bridge::ResultInfo info;
    REQUIRE (bridge::readResult (dir, info, error));
    CHECK (info.status == "error");
    CHECK (info.message.find ("timed out") != std::string::npos);
}

// A signal that loses the claim to a writer in another thread waits for it: _exit must not cut the winner
// off between open and link (that left no result.json and a stray temp file).
TEST (a_stop_signal_waits_for_a_fallback_another_thread_is_writing)
{
    const std::string dir { makeTempDir ("fallback_race_thread") };
    std::string error;
    REQUIRE (bridge::prepareFallbackResults (dir, "job-r", 7.0, error));
    const int status { inChild ([] {
        bridge::installSignalHandlers ();
        bridge::setFallbackWriteDelayForTests (300);
        std::thread writer ([] { bridge::writeFallbackResult (0); for (;;) pause (); });
        writer.detach ();
        usleep (50 * 1000);
        std::raise (SIGTERM);
        std::raise (SIGTERM);       // loses the claim, must wait for the writer, then exits
        _exit (0);
    }) };
    CHECK (WIFEXITED (status) && WEXITSTATUS (status) == bridge::kExitStopped);
    bridge::ResultInfo info;
    REQUIRE (bridge::readResult (dir, info, error));
    CHECK (info.message.find ("timed out") != std::string::npos);
    CHECK (! std::filesystem::exists (dir + "/result.json.fallback.tmp"));
}

// The main-thread grace writer is not interrupted by stop signals sent to its own thread (a handler there
// would wait for a writer that cannot go on).
TEST (a_writer_outside_a_handler_is_not_cut_off_by_signals_to_its_thread)
{
    const std::string dir { makeTempDir ("fallback_race_main") };
    std::string error;
    REQUIRE (bridge::prepareFallbackResults (dir, "job-m", 9.0, error));
    const int status { inChild ([] {
        bridge::installSignalHandlers ();
        bridge::setFallbackWriteDelayForTests (300);
        const pthread_t mainThread { pthread_self () };
        std::thread killer ([mainThread] {
            usleep (50 * 1000);
            pthread_kill (mainThread, SIGTERM);
            pthread_kill (mainThread, SIGTERM);
            pthread_kill (mainThread, SIGALRM);
        });
        killer.detach ();
        const bool wrote { bridge::writeFallbackResult (0) };
        _exit (wrote ? bridge::kExitStopped : 99);
    }) };
    CHECK (WIFEXITED (status) && WEXITSTATUS (status) == bridge::kExitStopped);
    bridge::ResultInfo info;
    REQUIRE (bridge::readResult (dir, info, error));
    CHECK (info.message.find ("timed out") != std::string::npos);
    CHECK (! std::filesystem::exists (dir + "/result.json.fallback.tmp"));
}

// A burst of crash and stop signals from outside: whoever wins publishes a complete result.json.
TEST (a_burst_of_signals_still_publishes_one_complete_fallback)
{
    const std::string dir { makeTempDir ("fallback_burst") };
    std::string error;
    REQUIRE (bridge::prepareFallbackResults (dir, "job-b", 9.0, error));
    std::fflush (stdout);
    const pid_t pid { fork () };
    if (pid == 0)
    {
        bridge::installSignalHandlers ();
        bridge::setFallbackWriteDelayForTests (300);
        for (int i { 0 }; i < 3; ++i)
            std::thread ([] { for (;;) pause (); }).detach ();
        for (;;)
            pause ();
    }
    usleep (100 * 1000);
    for (const int signal : { SIGSEGV, SIGBUS, SIGTERM, SIGTERM })
    {
        kill (pid, signal);
        usleep (5 * 1000);
    }
    int status { 0 };
    waitpid (pid, &status, 0);
    CHECK (WIFSIGNALED (status) || (WIFEXITED (status) && WEXITSTATUS (status) == bridge::kExitStopped));
    bridge::ResultInfo info;
    REQUIRE (bridge::readResult (dir, info, error));
    CHECK (info.status == "error");
    CHECK (! std::filesystem::exists (dir + "/result.json.fallback.tmp"));
}

TEST (an_exit_without_a_result_writes_cancelled_once_armed)
{
    const std::string dir { makeTempDir ("exit_fallback") };
    std::string error;
    REQUIRE (bridge::prepareFallbackResults (dir, "job-x", 9.0, error));
    const int status { inChild ([] { bridge::armExitFallback (); std::exit (3); }) };
    CHECK (WIFEXITED (status) && WEXITSTATUS (status) == 3);
    bridge::ResultInfo info;
    REQUIRE (bridge::readResult (dir, info, error));
    CHECK (info.status == "cancelled");
    CHECK (info.id == "job-x");
    CHECK (! std::filesystem::exists (dir + "/result.json.fallback.tmp"));

    // not after the normal result, not without arming, not over an existing result
    const std::string dir2 { makeTempDir ("exit_fallback_marked") };
    REQUIRE (bridge::prepareFallbackResults (dir2, "job-y", 9.0, error));
    inChild ([] { bridge::armExitFallback (); bridge::markResultWritten (); std::exit (0); });
    inChild ([] { std::exit (0); });
    CHECK (! std::filesystem::exists (dir2 + "/result.json"));
    CHECK (bridge::writeExitFallbackResult ());             // in this process nothing is marked: written now
    REQUIRE (bridge::readResult (dir2, info, error));
    CHECK (info.status == "cancelled");
    CHECK (! bridge::writeExitFallbackResult ());           // already there
}
