// BridgeHost --job <job folder> [--autorender] | --version | --find-plugins
//
// --version prints "BridgeHost <build> job-protocol 1"; --find-plugins prints one line of JSON saying which
// plug-ins were found (hostcore/Commands.h), with the same settings.json overrides and folders (and the
// environment below) as a job. Both exit 0, touch no job and start no app.
//
// Loads the job, hosts the plug-in as an ARA plug-in and either renders the job headlessly
// (--autorender: no window and no edits, so the result equals the source region) or opens the editor
// window (app/HostApp.h). Exit codes: hostcore/Options.h. Whenever the job folder is known, every outcome
// ends in a result.json (headless: status ok or error; window: ok after Apply, cancelled when the window
// is closed or the process is asked to stop, error if it cannot start), except when one is already there:
// results are never overwritten. A crash or a second stop signal writes a prepared fallback result.json
// (hostcore/RunGuard.h).
//
// Environment (for tests and diagnosis):
//   ARABRIDGE_SETTINGS     settings.json to read plug-in path overrides and "keepRaw" from (default: Application Support)
//   ARABRIDGE_PLUGIN_DIRS  ':'-separated VST3 folders searched instead of the standard ones
//   ARABRIDGE_AUDIO_OUTPUT_UID
//                          window: play to the output device with this CoreAudio UID ("default": the system
//                          default) instead of audio.json's choice; never written to audio.json
//   ARABRIDGE_AUDIO_SETTINGS
//                          window: audio.json (the Output menu's choice) to read and write instead of
//                          Application Support's
//   ARABRIDGE_TIMEOUT_SEC  time budget in seconds instead of 300 + 4 per second of audio (headless: the
//                          whole job; window: one Apply)
//   ARABRIDGE_TEST_HANG    test only: "main" (main thread hangs, headless only), "render" (render hangs and
//                          ignores stop requests) or "render-soft" (render hangs until asked to stop)
//   ARABRIDGE_TEST_AUTOPLAY, ARABRIDGE_TEST_AUTOAPPLY, ARABRIDGE_TEST_AUTOCANCEL, ARABRIDGE_TEST_AUDIO_RESTART,
//   ARABRIDGE_TEST_KEYS    test only (window): press Play, Apply or Cancel, simulate an output device change,
//                          or press keys, this many seconds after the editor opened (app/HostApp.h)
//   ARABRIDGE_TEST_SELECT_OUTPUT
//                          test only (window): "seconds:UID;seconds:default": choices in the Output menu
//                          (saved only when ARABRIDGE_AUDIO_SETTINGS is set)
//   ARABRIDGE_TEST_ARA_ASSERT
//                          test only: one ARA API validation failure after the plug-in is loaded (window:
//                          logged, the job goes on; headless: abort, crash fallback result.json)
//   ARABRIDGE_TEST_STARTUP_DELAY
//                          test only (window): wait this many seconds in a modal event loop before the
//                          licence check, as a licence dialog would; then, with ARABRIDGE_TEST_STARTUP_TERMINATE
//                          set, [NSApp terminate:] (or exit() if it is "exit")

// SDK headers first (see MemoryAudioFile.h)
#include "TestHost.h"
#include "app/BridgeDocument.h"
#include "app/HostApp.h"
#include "app/MemoryAudioFile.h"
#include "app/JobRender.h"

#include "audio/AudioDecode.h"
#include "hostcore/ApplyJob.h"
#include "hostcore/Commands.h"
#include "hostcore/JobLayout.h"
#include "hostcore/Options.h"
#include "hostcore/RunGuard.h"
#include "jobio/Job.h"
#include "plugins/PlugInFinder.h"

#import <Cocoa/Cocoa.h>
#include <os/log.h>

#include <atomic>
#include <chrono>
#include <climits>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <map>
#include <memory>
#include <string>
#include <unistd.h>
#include <vector>

// ARA API validation failures (the host's ARA_VALIDATE_* checks and the plug-in's, which call this function
// through the reference passed to initializeARA). Headless they abort (ARA::ARAInterfaceAssert): the crash
// fallback writes an error result.json, which is what a script wants. In window mode an abort would lose
// the user's editing session, so they are logged (stderr and the unified log) and the call goes on;
// run() picks the function before the plug-in is loaded. ARA_INTERNAL_ASSERT still aborts in both modes.
ARA::ARAAssertFunction assertFunction { &ARA::ARAInterfaceAssert };
ARA::ARAAssertFunction* assertFunctionReference { &assertFunction };

namespace
{
    std::atomic<long> gAraAssertCount { 0 };

    void ARA_CALL logAraAssertAndContinue (ARA::ARAAssertCategory category, const void* problematicArgument, const char* diagnosis)
    {
        // the first 20, then every 100th: a per-block violation must not flood the log
        const long count { ++gAraAssertCount };
        if (count > 20 && count % 100 != 0)
            return;
        const char* kind { category == ARA::kARAAssertInvalidArgument ? "invalid argument"
                           : category == ARA::kARAAssertInvalidState ? "invalid state"
                           : category == ARA::kARAAssertInvalidThread ? "invalid thread" : "unspecified" };
        const char* text { diagnosis != nullptr ? diagnosis : "" };
        std::fprintf (stderr, "BridgeHost: ARA API violation #%ld (%s, pointer %p): %s (continuing)\n", count, kind, problematicArgument, text);
        std::fflush (stderr);
        os_log_error (OS_LOG_DEFAULT, "BridgeHost: ARA API violation #%ld (%{public}s, pointer %p): %{public}s (continuing)", count, kind, problematicArgument, text);
    }
}

ARA_SETUP_DEBUG_MESSAGE_PREFIX ("BridgeHost");

const char* bridgeHostBuild ();     // generated: app/BuildInfo.cpp.in

namespace
{
    // Headless budget: generous, since analysis and the offline render are usually faster than real time.
    constexpr double kBaseTimeoutSec { 300.0 };
    constexpr double kTimeoutPerAudioSecond { 4.0 };
    constexpr double kMaxStopGraceSec { 15.0 };     // how long a stopped render may take to end before giving up
    constexpr double kWatchdogSlackSec { 5.0 };     // SIGALRM backstop after timeout + grace
    constexpr double kTeardownSec { 30.0 };         // budget for tearing down after the result is written

    double stopGraceSec (double timeoutSec) { return std::min (kMaxStopGraceSec, std::max (1.0, timeoutSec / 4.0)); }

    void say (const std::string& text)
    {
        std::printf ("BridgeHost: %s\n", text.c_str ());
        std::fflush (stdout);
    }

    int fail (const std::string& jobDir, const std::string& jobId, const std::string& message, int exitCode)
    {
        std::fprintf (stderr, "BridgeHost: error: %s\n", message.c_str ());
        std::string error;
        if (! jobDir.empty ())
        {
            if (bridge::writeErrorResult (jobDir, jobId.empty () ? "unknown" : jobId, message, error))
                bridge::markResultWritten ();
            else
                std::fprintf (stderr, "BridgeHost: result.json not written: %s\n", error.c_str ());
        }
        return exitCode;
    }

    std::string environment (const char* name)
    {
        const char* value { std::getenv (name) };
        return value ? std::string { value } : std::string {};
    }

    std::string absolutePath (const std::string& path)
    {
        char resolved[PATH_MAX];
        return ::realpath (path.c_str (), resolved) ? std::string { resolved } : std::string {};
    }

    std::string settingsPath ()
    {
        return environment ("ARABRIDGE_SETTINGS").empty () ? bridge::defaultSettingsPath () : environment ("ARABRIDGE_SETTINGS");
    }

    // settings.json's plug-in paths (ARABRIDGE_SETTINGS or Application Support); a problem is a warning
    std::map<std::string, std::string> plugInOverrides ()
    {
        std::string settingsProblem;
        auto overrides { bridge::loadPlugInOverrides (settingsPath (), &settingsProblem) };
        if (! settingsProblem.empty ())
            std::fprintf (stderr, "BridgeHost: warning: %s\n", settingsProblem.c_str ());
        return overrides;
    }

    // settings.json's "keepRaw" (diagnostics); a value that is not a boolean is a warning
    bool keepRawSetting ()
    {
        std::string warning;
        const bool keepRaw { bridge::loadKeepRaw (settingsPath (), &warning) };
        if (! warning.empty ())
            std::fprintf (stderr, "BridgeHost: warning: %s\n", warning.c_str ());
        return keepRaw;
    }

    std::vector<std::string> plugInDirs ()
    {
        return environment ("ARABRIDGE_PLUGIN_DIRS").empty () ? bridge::defaultPlugInDirs () : bridge::splitPathList (environment ("ARABRIDGE_PLUGIN_DIRS"));
    }

    std::string stopMessage ()
    {
        const int signal { bridge::stopSignal () };
        return std::string ("stopped by ") + (signal == SIGTERM ? "SIGTERM" : signal == SIGINT ? "SIGINT" : signal == SIGHUP ? "SIGHUP" : "a signal")
               + " before the result was written";
    }

    // Pumps the main run loop (plug-ins may dispatch work to the main queue), lets the plug-in send model
    // updates (BridgeDocument::notifyModelUpdates) and enforces the headless
    // time budget. Returns false once the work should stop; if it does not stop within the grace time,
    // the fallback result is written and the process exits. (If idle() is not called at all, the SIGALRM
    // watchdog does the same a little later.)
    class HeadlessIdle
    {
    public:
        HeadlessIdle (BridgeDocument& document, double timeoutSec, std::chrono::steady_clock::time_point started)
        : _document { document }, _timeoutSec { timeoutSec }, _graceSec { stopGraceSec (timeoutSec) }, _started { started } {}

        bool operator() ()
        {
            CFRunLoopRunInMode (kCFRunLoopDefaultMode, 0.01, true);
            _document.notifyModelUpdates ();
            const double elapsed { std::chrono::duration<double> (std::chrono::steady_clock::now () - _started).count () };
            if (! _stopping && (bridge::stopRequested () || elapsed > _timeoutSec))
            {
                _stopping = true;
                _timedOut = ! bridge::stopRequested ();
                _stoppedAt = elapsed;
            }
            if (_stopping && elapsed > _stoppedAt + _graceSec)
            {
                std::fprintf (stderr, "BridgeHost: error: the plug-in did not stop in time; giving up\n");
                bridge::writeFallbackResult (_timedOut ? 0 : bridge::stopSignal ());
                _exit (bridge::kExitStopped);
            }
            return ! _stopping;
        }

        bool timedOut () const { return _timedOut; }
        double timeoutSec () const { return _timeoutSec; }

    private:
        BridgeDocument& _document;
        const double _timeoutSec;
        const double _graceSec;
        const std::chrono::steady_clock::time_point _started;
        bool _stopping { false };
        bool _timedOut { false };
        double _stoppedAt { 0.0 };
    };

    int run (const bridge::HostOptions& options)
    {
        const std::string jobDir { absolutePath (options.jobDir) };
        if (jobDir.empty ())
        {
            std::fprintf (stderr, "BridgeHost: error: job folder '%s' not found\n", options.jobDir.c_str ());
            return bridge::kExitBadJob;
        }
        if (bridge::resultExists (jobDir))
        {
            std::fprintf (stderr, "BridgeHost: error: %s/result.json already exists; results are never overwritten\n", jobDir.c_str ());
            return bridge::kExitBadJob;
        }

        bridge::Job job;
        std::string error;
        if (! bridge::loadJob (jobDir, job, error))
            return fail (jobDir, "", "bad job: " + error, bridge::kExitBadJob);
        job.dir = jobDir;
        job.keepRaw = keepRawSetting ();
        if (job.keepRaw)
            say ("keepRaw: the raw renders and the realignment's details are kept in the job folder");

        double audioSeconds { 0.0 };
        for (const auto& clip : job.clips)
            audioSeconds += clip.endSec - clip.startSec;
        double timeoutSec { kBaseTimeoutSec + kTimeoutPerAudioSecond * audioSeconds };
        if (const std::string text { environment ("ARABRIDGE_TIMEOUT_SEC") }; ! text.empty ())
        {
            char* end { nullptr };
            const double value { std::strtod (text.c_str (), &end) };
            if (end != text.c_str () && *end == '\0' && value > 0.0 && value <= 1.0e6)
                timeoutSec = value;
            else
                std::fprintf (stderr, "BridgeHost: warning: ignoring ARABRIDGE_TIMEOUT_SEC='%s'\n", text.c_str ());
        }
        if (! bridge::prepareFallbackResults (jobDir, job.id, timeoutSec, error))
            std::fprintf (stderr, "BridgeHost: warning: no fallback result prepared: %s\n", error.c_str ());
        bridge::installSignalHandlers ();
        const auto started { std::chrono::steady_clock::now () };
        if (options.autorender)
            bridge::armWatchdog (timeoutSec + stopGraceSec (timeoutSec) + kWatchdogSlackSec);

        // plug-in
        const auto overrides { plugInOverrides () };
        const auto dirs { plugInDirs () };
        std::string problem;
        const std::string pluginPath { bridge::findPlugIn (job.plugin, overrides, dirs, &problem) };
        if (pluginPath.empty ())
            return fail (jobDir, job.id, "the " + job.plugin + " plug-in was not found" + (problem.empty () ? "" : ": " + problem), bridge::kExitPlugIn);
        if (! problem.empty ())
            std::fprintf (stderr, "BridgeHost: warning: %s\n", problem.c_str ());

        // audio, checked before the plug-in is loaded
        std::vector<bridge::Audio> audio;
        for (const auto& clip : job.clips)
        {
            bridge::Audio decoded;
            if (! bridge::decodeAudioFile (clip.path, decoded, error))
                return fail (jobDir, job.id, "clip '" + clip.name + "': " + error, bridge::kExitAudio);
            audio.push_back (std::move (decoded));
        }
        bridge::JobLayout layout;
        if (! bridge::layoutJob (job, audio, layout, error))
            return fail (jobDir, job.id, error, bridge::kExitAudio);
        const auto& renderRegion { layout.regions[layout.renderClip] };
        const bridge::Audio original { bridge::cropAudio (audio[layout.renderClip], renderRegion.sourceStart, renderRegion.frames) };

        std::vector<std::shared_ptr<MemoryAudioFile>> files;
        for (size_t i { 0 }; i < job.clips.size (); ++i)
            files.push_back (std::make_shared<MemoryAudioFile> (job.clips[i].name, std::move (audio[i])));
        audio.clear ();

        // Plug-ins expect an NSApplication; headless it never shows a window or a Dock icon. The window mode
        // is a regular app from here on, as the plug-in may show its licence dialog before the window opens.
        NSApplication* app { [NSApplication sharedApplication] };
        [app setActivationPolicy: options.autorender ? NSApplicationActivationPolicyProhibited : NSApplicationActivationPolicyRegular];
        if (! options.autorender)
            installEarlyQuitHandler ();     // until the window is open, Quit only marks the job as cancelled

        say ("job " + job.id + ": " + job.plugin + " from " + pluginPath);
        assertFunction = options.autorender ? &ARA::ARAInterfaceAssert : &logAraAssertAndContinue;
        ARA::ARASetExternalAssertReference (assertFunctionReference);
        auto entry { PlugInEntry::parsePlugInEntry ({ "BridgeHost", "-vst3", pluginPath }) };
        if (! entry || ! entry->getARAFactory ())
            return fail (jobDir, job.id, pluginPath + " could not be loaded as an ARA plug-in", bridge::kExitPlugIn);

        entry->initializeARA (assertFunctionReference);
        // a plug-in built for debugging may switch the shared assert function to its own (ARAPlug.cpp does this
        // without NDEBUG); the window keeps its policy
        if (! options.autorender && assertFunction != &logAraAssertAndContinue)
        {
            say ("the plug-in replaced the ARA assert function; window mode restores its own (log and continue)");
            assertFunction = &logAraAssertAndContinue;
        }
        // test only: one ARA API validation failure (window mode logs it and goes on, headless aborts)
        if (! environment ("ARABRIDGE_TEST_ARA_ASSERT").empty ())
        {
            say ("test: ARA API validation failure");
            ARA_VALIDATE_API_CONDITION (environment ("ARABRIDGE_TEST_ARA_ASSERT").empty ());
            say ("test: still running after the validation failure");
        }
        int exitCode { bridge::kExitOk };
        {
            BridgeDocument document { entry.get (), job, layout, files };
            // window mode: an exit() from here on (it should not happen: Quit is handled) still leaves a
            // "cancelled" result.json. Armed after the plug-in is loaded, so it runs before the plug-in's own
            // exit-time destructors, which may crash.
            if (! options.autorender)
                bridge::armExitFallback ();
            // test only: a modal wait before the licence check, as a licence dialog would cause
            if (const double delay { environment ("ARABRIDGE_TEST_STARTUP_DELAY").empty () ? 0.0 : std::atof (environment ("ARABRIDGE_TEST_STARTUP_DELAY").c_str ()) };
                delay > 0.0 && ! options.autorender)
            {
                say ("test: startup delay of " + std::to_string (delay) + " s");
                const auto until { std::chrono::steady_clock::now () + std::chrono::duration<double> (std::min (delay, 600.0)) };
                while (std::chrono::steady_clock::now () < until)
                    @autoreleasepool
                    {
                        NSEvent* event { [app nextEventMatchingMask: NSEventMaskAny untilDate: [NSDate dateWithTimeIntervalSinceNow: 0.05]
                                                             inMode: NSModalPanelRunLoopMode dequeue: YES] };
                        if (event != nil)
                            [app sendEvent: event];
                    }
                if (environment ("ARABRIDGE_TEST_STARTUP_TERMINATE") == "exit")
                {
                    say ("test: exit() before the window opened");
                    std::exit (0);
                }
                if (! environment ("ARABRIDGE_TEST_STARTUP_TERMINATE").empty ())
                {
                    say ("test: [NSApp terminate:] before the window opened");
                    [app terminate: nil];       // without the early delegate AppKit would call exit()
                }
            }
            if (! document.startAnalysis (! options.autorender, error))
            {
                exitCode = fail (jobDir, job.id, error, bridge::kExitPlugIn);
            }
            else if (options.autorender)
            {
                HeadlessIdle idle { document, timeoutSec, started };
                if (environment ("ARABRIDGE_TEST_HANG") == "main")
                    for (;;)
                        ::pause ();
                double analysisSeconds { 0.0 };
                if (! document.waitForAnalysis (std::ref (idle), analysisSeconds))
                {
                    exitCode = fail (jobDir, job.id, idle.timedOut () ? "timed out while the plug-in was analysing the audio" : stopMessage (), bridge::kExitStopped);
                }
                else
                {
                    char text[160];
                    std::snprintf (text, sizeof text, "analysis done after %.2f s", analysisSeconds);
                    say (text);

                    const auto render = [&] (bridge::Audio& out, std::string& renderError, std::string& diagnostics) {
                        const bool ok { renderJobClip (document, job, layout, std::ref (idle), say, out, renderError, diagnostics) };
                        if (! ok && bridge::stopRequested ())
                            renderError = stopMessage ();
                        else if (! ok && idle.timedOut ())
                            renderError = "timed out after " + std::to_string (static_cast<int> (idle.timeoutSec ())) + " s while rendering";
                        return ok;
                    };
                    const auto info { bridge::applyJob (job, original, renderRegion.sourceStart, render, true, say, layout.guideWindow) };
                    bridge::markResultWritten ();
                    say (info.status + (info.message.empty () ? "" : " - " + info.message));
                    exitCode = info.status == "ok" ? bridge::kExitOk : (bridge::stopRequested () || idle.timedOut ()) ? bridge::kExitStopped : bridge::kExitRender;
                }
            }
            else
            {
                AppContext context;
                context.entry = entry.get ();
                context.document = &document;
                context.job = job;
                context.layout = layout;
                context.original = original;
                context.applyTimeoutSec = timeoutSec;
                context.stopGraceSec = stopGraceSec (timeoutSec);
                exitCode = runHostApp (context);
            }
            // the result is written: a hang while tearing down must not keep the caller waiting
            bridge::armWatchdog (kTeardownSec);
        }
        entry->uninitializeARA ();
        entry.reset ();
        bridge::disarmWatchdog ();
        say ("torn down, exit code " + std::to_string (exitCode));
        return exitCode;
    }
}

int main (int argc, const char* argv[])
{
    // a caller that closes our stdout (e.g. "| head") must not kill the process before result.json is written
    std::signal (SIGPIPE, SIG_IGN);
    @autoreleasepool
    {
        bridge::HostOptions options;
        std::string error;
        if (! bridge::parseHostArguments (std::vector<std::string> (argv + 1, argv + argc), options, error))
        {
            std::fprintf (stderr, "BridgeHost: %s\nusage: BridgeHost --job <job folder> [--autorender] | --version | --find-plugins\n", error.c_str ());
            return bridge::kExitBadJob;
        }
        if (options.command == bridge::HostCommand::version)
        {
            std::printf ("%s\n", bridge::versionLine (bridgeHostBuild ()).c_str ());
            return bridge::kExitOk;
        }
        if (options.command == bridge::HostCommand::findPlugIns)
        {
            std::printf ("%s\n", bridge::plugInReportJson (plugInOverrides (), plugInDirs ()).c_str ());
            return bridge::kExitOk;
        }
        return run (options);
    }
}
