#pragma once

#include <cstdint>
#include <string>

// Transport sync with Live (job.sync, window mode, Melodyne). Live is the master: the device reports Live's
// position and play state to the host over its stdin, the host follows with a silent playback of the clip (the
// plug-in's editor shows the cursor and the clip as it plays), and what the user does in the host window or in the
// plug-in (Play, Space, a click in the time ruler, Stop) goes back to the device as events that it applies to Live.
// SDK-free so the decisions can be unit-tested.
//
// Times are seconds from the START OF THE RENDERED CLIP REGION (the host's playback timeline starts there; the device
// converts from Live's beats): negative before the region, beyond regionSec after it.
//
// stdin, one line per report (device -> host): "L <seq> <posSec> <playing 0|1>\n"
// events file <job>/sync-events.txt, one line per event (host -> device): "E <seq> <start|stop|seek> <posSec>\n"
namespace bridge
{
    struct LiveReport
    {
        long long seq { 0 };
        double posSec { 0.0 };
        bool playing { false };
    };

    // false for anything that is not exactly such a line (a trailing newline is allowed)
    bool parseLiveLine (const std::string& line, LiveReport& report);

    // "E 3 start 12.345678\n"; kind is "start", "stop" or "seek"
    std::string formatSyncEvent (long long seq, const std::string& kind, double posSec);

    // false for a line that is not an event; posSec is the host's position
    struct SyncEvent
    {
        long long seq { 0 };
        std::string kind;
        double posSec { 0.0 };
    };
    bool parseSyncEvent (const std::string& line, SyncEvent& event);

    struct HostPlayState
    {
        bool playing { false };
        double posSec { 0.0 };
    };

    struct FollowDecision
    {
        bool stop { false };
        bool start { false };
        bool seek { false };
        double seekSec { 0.0 };     // for seek (and for start: where playback begins)
    };

    // What the host has to do after a report. 'sinceReportSec' is how long ago the report arrived (a playing Live has
    // moved on since); 'regionSec' the length of the clip region. While Live plays inside the region the host plays
    // along and is moved only when it is more than 'toleranceSec' off (a seek that is not needed would only jitter the
    // plug-in's cursor); outside the region it stops; while Live is stopped the host stops and shows Live's position
    // (clamped into the region only when that lies inside it: a stopped Live before or after the clip leaves the cursor alone).
    FollowDecision decideFollow (const LiveReport& live, double sinceReportSec, const HostPlayState& host, double regionSec,
                                 double toleranceSec = 0.08);
}
