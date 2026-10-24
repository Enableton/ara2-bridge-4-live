#include "hostcore/RunGuard.h"

#include "hostcore/Options.h"
#include "jobio/Job.h"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cerrno>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <fcntl.h>
#include <pthread.h>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <string>
#include <unistd.h>

namespace bridge
{
    namespace
    {
        constexpr int kSlots { 32 };    // signal numbers 1..31; slot 0 is the timeout
        const int kCrashSignals[] { SIGSEGV, SIGBUS, SIGILL, SIGFPE, SIGABRT, SIGTRAP };
        const int kStopSignals[] { SIGTERM, SIGINT, SIGHUP };

        // Written before the handlers are installed, only read afterwards.
        std::string gTexts[kSlots];
        std::string gExitText;                      // status "cancelled", for a process exit without a result
        std::string gFinalPath;
        std::string gTmpPath;
        std::atomic<bool> gPrepared { false };
        std::atomic<bool> gResultWritten { false };
        std::atomic<bool> gWriting { false };       // claim: only one writer of the fallback at a time
        std::atomic<int> gStopSignal { 0 };
        std::atomic<int> gWriteDelayMs { 0 };       // test only

        struct sigaction gPrevious[kSlots];
        bool gInstalled { false };

        static_assert (std::atomic<bool>::is_always_lock_free && std::atomic<int>::is_always_lock_free, "signal handlers need lock-free atomics");

        const char* signalName (int signal)
        {
            switch (signal)
            {
                case SIGSEGV: return "SIGSEGV";
                case SIGBUS: return "SIGBUS";
                case SIGILL: return "SIGILL";
                case SIGFPE: return "SIGFPE";
                case SIGABRT: return "SIGABRT";
                case SIGTRAP: return "SIGTRAP";
                case SIGTERM: return "SIGTERM";
                case SIGINT: return "SIGINT";
                case SIGHUP: return "SIGHUP";
                default: return "?";
            }
        }

        // The exact bytes writeResult produces, by letting it write into a scratch folder.
        bool renderResultText (const std::string& jobId, const std::string& message, std::string& text, std::string& error,
                               const char* status = "error")
        {
            std::string pattern { (std::filesystem::temp_directory_path () / "bridgehost-fallback-XXXXXX").string () };
            if (::mkdtemp (pattern.data ()) == nullptr)
            {
                error = "cannot create a scratch folder for the fallback result";
                return false;
            }
            ResultInfo info;
            info.status = status;
            info.message = message;
            const bool ok { writeResult (pattern, jobId, info, error) };
            if (ok)
            {
                std::ifstream file (pattern + "/result.json", std::ios::binary);
                text.assign (std::istreambuf_iterator<char> (file), std::istreambuf_iterator<char> ());
            }
            std::error_code ignored;
            std::filesystem::remove_all (pattern, ignored);
            return ok && ! text.empty ();
        }

        void onCrash (int signal)
        {
            // SA_RESETHAND has restored the default action; the re-raised signal is delivered when this returns
            writeFallbackResult (signal);
            std::raise (signal);
        }

        void onStop (int signal)
        {
            int expected { 0 };
            if (gStopSignal.compare_exchange_strong (expected, signal))
                return;
            writeFallbackResult (signal);
            _exit (kExitStopped);
        }

        [[noreturn]] void onAlarm (int)
        {
            writeFallbackResult (0);
            _exit (kExitStopped);
        }

        void install (int signal, void (*handler) (int), int flags)
        {
            struct sigaction action {};
            action.sa_handler = handler;
            sigfillset (&action.sa_mask);       // no other handled signal interrupts a handler
            action.sa_flags = flags;
            sigaction (signal, &action, &gPrevious[signal]);
        }
    }

    bool prepareFallbackResults (const std::string& jobDir, const std::string& jobId, double timeoutSec, std::string& error)
    {
        gPrepared = false;
        for (auto& text : gTexts)
            text.clear ();
        gExitText.clear ();

        for (int signal : kCrashSignals)
            if (! renderResultText (jobId, std::string ("BridgeHost crashed (") + signalName (signal) + ") while working on the job", gTexts[signal], error))
                return false;
        for (int signal : kStopSignals)
            if (! renderResultText (jobId, std::string ("BridgeHost was stopped (") + signalName (signal) + ") before it finished", gTexts[signal], error))
                return false;
        char seconds[32];
        std::snprintf (seconds, sizeof seconds, "%.0f", timeoutSec);
        if (! renderResultText (jobId, std::string ("BridgeHost timed out after ") + seconds + " s (the plug-in did not finish)", gTexts[0], error))
            return false;
        if (! renderResultText (jobId, "BridgeHost quit before the job was finished", gExitText, error, "cancelled"))
            return false;

        gFinalPath = jobDir + "/result.json";
        gTmpPath = jobDir + "/result.json.fallback.tmp";
        gResultWritten = false;
        gPrepared = true;
        return true;
    }

    void installSignalHandlers ()
    {
        if (gInstalled)
            return;
        for (int signal : kCrashSignals)
            install (signal, onCrash, SA_RESETHAND);
        for (int signal : kStopSignals)
            install (signal, onStop, 0);
        install (SIGALRM, onAlarm, 0);
        gInstalled = true;
    }

    void restoreSignalHandlers ()
    {
        if (! gInstalled)
            return;
        for (int signal : kCrashSignals)
            sigaction (signal, &gPrevious[signal], nullptr);
        for (int signal : kStopSignals)
            sigaction (signal, &gPrevious[signal], nullptr);
        ::alarm (0);
        sigaction (SIGALRM, &gPrevious[SIGALRM], nullptr);
        gInstalled = false;
    }

    bool stopRequested () { return gStopSignal.load () != 0; }
    int stopSignal () { return gStopSignal.load (); }
    void clearStopRequest () { gStopSignal = 0; }
    void markResultWritten () { gResultWritten = true; }
    void setFallbackWriteDelayForTests (int milliseconds) { gWriteDelayMs = std::max (milliseconds, 0); }

    void armWatchdog (double seconds)
    {
        const double clamped { std::min (std::max (seconds, 1.0), 1.0e6) };
        ::alarm (static_cast<unsigned> (std::ceil (clamped)));
    }

    void disarmWatchdog () { ::alarm (0); }

    namespace
    {
        // Writes the temp file and links it into place. The caller holds the claim.
        bool publishFallback (const std::string& text)
        {
            bool published { false };
            const int fd { ::open (gTmpPath.c_str (), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0644) };
            if (fd >= 0)
            {
                size_t done { 0 };
                while (done < text.size ())
                {
                    const ssize_t n { ::write (fd, text.data () + done, text.size () - done) };
                    if (n < 0 && errno == EINTR)
                        continue;
                    if (n <= 0)
                        break;
                    done += static_cast<size_t> (n);
                }
                if (const int delay { gWriteDelayMs.load () }; delay > 0)
                {
                    struct timespec pause { delay / 1000, (delay % 1000) * 1000000L };
                    while (::nanosleep (&pause, &pause) != 0 && errno == EINTR)
                        ;
                }
                const bool synced { ::fsync (fd) == 0 };
                const bool closed { ::close (fd) == 0 };
                // link() fails if result.json exists, so a result written meanwhile is never replaced
                published = done == text.size () && synced && closed && ::link (gTmpPath.c_str (), gFinalPath.c_str ()) == 0;
                ::unlink (gTmpPath.c_str ());
            }
            return published;
        }

        // A writer that loses the claim waits (bounded) until the winner is done: the loser's caller then
        // exits or re-raises, which must not cut the winner off between open() and link().
        constexpr int kClaimWaitStepMs { 10 };
        constexpr int kClaimWaitSteps { 150 };  // about 1.5 s

        void waitForClaimRelease ()
        {
            for (int i { 0 }; i < kClaimWaitSteps && gWriting.load (); ++i)
            {
                struct timespec step { 0, kClaimWaitStepMs * 1000000L };
                ::nanosleep (&step, nullptr);   // async-signal-safe; an EINTR just ends this step early
            }
        }
    }

    namespace
    {
        // The claim, the signal mask and the retry around publishFallback.
        bool writeFallbackText (const std::string& text)
        {
            if (! gPrepared.load () || gResultWritten.load () || text.empty ())
                return false;

            // No signal handler may run on this thread while it holds the claim (inside a handler sa_mask
            // already blocks them; this covers the main-thread grace writer): a handler here would wait for a
            // writer that cannot go on. Signals sent meanwhile go to other threads or stay pending until the
            // mask is restored.
            sigset_t all, previous;
            sigfillset (&all);
            pthread_sigmask (SIG_BLOCK, &all, &previous);

            bool published { false };
            for (int attempt { 0 }; attempt < 2 && ! published && ! gResultWritten.load (); ++attempt)
            {
                if (gWriting.exchange (true))
                {
                    waitForClaimRelease ();     // another writer is at work; if it failed, try once more
                    continue;
                }
                published = publishFallback (text);
                if (published)
                    gResultWritten = true;
                gWriting = false;
            }

            pthread_sigmask (SIG_SETMASK, &previous, nullptr);
            return published;
        }

        void onExit () { writeFallbackText (gExitText); }
    }

    bool writeFallbackResult (int signal)
    {
        if (signal < 0 || signal >= kSlots)
            return false;
        return writeFallbackText (gTexts[signal]);
    }

    bool writeExitFallbackResult () { return writeFallbackText (gExitText); }

    void armExitFallback ()
    {
        static bool armed { false };
        if (! armed)
            armed = std::atexit (onExit) == 0;
    }
}
