#pragma once

#include <string>

// Last-resort result.json for situations the normal error path cannot handle: a crash signal inside the
// plug-in, a stop request that the process does not honour in time, or a hung render. The texts are
// prepared up front (prepareFallbackResults uses Foundation); writing them only uses async-signal-safe
// calls (open, write, fsync, close, link, unlink). A fallback is published with link(), so it never replaces
// an existing result.json; it is also skipped after markResultWritten(), and only one writer runs at a time.
namespace bridge
{
    // Prepares the fallback result.json texts for this job. timeoutSec only goes into the timeout message.
    bool prepareFallbackResults (const std::string& jobDir, const std::string& jobId, double timeoutSec, std::string& error);

    // Crash signals (SIGSEGV, SIGBUS, SIGILL, SIGFPE, SIGABRT, SIGTRAP) write the crash fallback and then
    // re-raise with the default action, so the process still dies of the signal. SIGTERM, SIGINT and SIGHUP
    // set the stop request the first time (the host then stops after the current render block and writes
    // its own error result); a second one writes the stop fallback and exits with kExitStopped at once.
    // SIGALRM (the watchdog) writes the timeout fallback and exits with kExitStopped.
    void installSignalHandlers ();
    void restoreSignalHandlers ();

    bool stopRequested ();
    int stopSignal ();          // the signal that asked to stop (0 if none)
    void clearStopRequest ();   // for tests

    // Hard watchdog: SIGALRM after 'seconds' (rounded up, at least 1) unless re-armed or disarmed.
    void armWatchdog (double seconds);
    void disarmWatchdog ();

    // Writes the fallback for a crash or stop signal, or for a timeout (signal 0). Async-signal-safe.
    // Returns false if nothing was written (not prepared, result already there, or an I/O error).
    // If another thread is writing a fallback right now, waits (up to about 1.5 s) until it is done, so a
    // caller that exits or re-raises afterwards does not cut that writer off. All signals are blocked on the
    // calling thread while it writes.
    bool writeFallbackResult (int signal);

    // Window mode: a process exit through exit() (or returning from main) while no result.json has been
    // written publishes a prepared one with status "cancelled" (for example AppKit's terminate:, which calls
    // exit(), before the window opened). Uses the same writer as the fallbacks; _exit() skips it.
    void armExitFallback ();
    bool writeExitFallbackResult ();    // what the exit handler does (for tests)

    // Call once the normal path has written result.json.
    void markResultWritten ();

    // Test only: writeFallbackResult sleeps this long between writing the temp file and publishing it.
    void setFallbackWriteDelayForTests (int milliseconds);
}
