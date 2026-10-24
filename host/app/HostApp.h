#pragma once

#include "app/BridgeDocument.h"
#include "common/Wav.h"
#include "hostcore/JobLayout.h"
#include "jobio/Job.h"

struct AppContext
{
    PlugInEntry* entry {};
    BridgeDocument* document {};
    bridge::Job job;
    bridge::JobLayout layout;
    bridge::Audio original;     // source region of the rendered clip (realign reference)
    double applyTimeoutSec { 300.0 };   // budget for one Apply (analysis wait + render)
    double stopGraceSec { 15.0 };       // how long a stopped render may take to end before the process gives up
};

// Runs the editor window until the job is closed (Apply, Cancel, window closed, Quit or a stop signal) and
// tears the editor instance down; the caller then destroys the document. Every way out writes result.json
// first (ok, or cancelled) unless one is already there. Returns the process exit code (hostcore/Options.h):
// kExitOk after Apply, kExitCancelled when the user closed the job, kExitStopped after SIGTERM/SIGINT/SIGHUP.
//
// Test hooks (environment, seconds after the editor opened; they call the same code as the buttons):
//   ARABRIDGE_TEST_AUTOPLAY, ARABRIDGE_TEST_AUTOAPPLY, ARABRIDGE_TEST_AUTOCANCEL
//   ARABRIDGE_TEST_AUDIO_RESTART  simulate an output device change (the engine stops and is restarted)
//   ARABRIDGE_TEST_KEYS           "seconds:key,..." with key space or escape: key presses posted to the window;
//                                 request-start / request-stop: the plug-in's playback requests (Space + request);
//                                 bg-start / bg-stop: the same from a background thread through the SDK's
//                                 playback controller (the interface the plug-in calls)
//   ARABRIDGE_TEST_TRANSPORT      the plug-in's transport requests: position 1 s + start, stop after 1 s, then
//                                 a 0.5 .. 1 s cycle from 0.6 s for 2 s
//   ARABRIDGE_TEST_SELECT_OUTPUT  "seconds:UID;seconds:default": choices in the Output menu (same path as the
//                                 menu; written to audio.json only when ARABRIDGE_AUDIO_SETTINGS is set)
//
// Output device (the Output menu in the bar): ARABRIDGE_AUDIO_OUTPUT_UID (a CoreAudio device UID, or
// "default"), else audio.json's outputUID (ARABRIDGE_AUDIO_SETTINGS, else Application Support/ARABridge/
// audio.json), else the system default. A choice in the menu switches at once (also while playing) and is
// saved to audio.json; a saved device that is not connected falls back to the system default (status line
// "Output: System default (saved device not available)") and is used again when it comes back.
int runHostApp (AppContext& context);

// Window mode, call before anything can show a dialog (licence check): until runHostApp runs, a quit Apple
// event or [NSApp terminate:] only marks the job to be closed, and runHostApp then writes "cancelled"
// without opening the window.
void installEarlyQuitHandler ();
