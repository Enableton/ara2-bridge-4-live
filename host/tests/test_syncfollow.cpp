#include "check.h"

#include "hostcore/SyncFollow.h"

namespace
{
    bridge::LiveReport live (double pos, bool playing, long long seq = 1)
    {
        bridge::LiveReport r;
        r.seq = seq;
        r.posSec = pos;
        r.playing = playing;
        return r;
    }
}

TEST (sync_line_parses_only_a_wellformed_report)
{
    bridge::LiveReport r;
    CHECK (bridge::parseLiveLine ("L 7 12.5 1\n", r));
    CHECK (r.seq == 7);
    CHECK_NEAR (r.posSec, 12.5, 1e-12);
    CHECK (r.playing);
    CHECK (bridge::parseLiveLine ("L 8 -0.25 0", r));
    CHECK_NEAR (r.posSec, -0.25, 1e-12);
    CHECK (! r.playing);
    CHECK (bridge::parseLiveLine ("L 9 3 1\r\n", r));
    for (const char* bad : { "", "L", "L 1 2", "L 1 2 3", "L x 2 1", "L 1 y 1", "L 1 2 1 extra", "l 1 2 1", "L 1 nan 1", "L 1 inf 1",
                             "L 1 1e300 1", "L  1 2 1", "L 1 2 true", "E 1 2 1", "L 1 2 1x" })
        CHECK (! bridge::parseLiveLine (bad, r));
}

TEST (sync_events_round_trip)
{
    const std::string line { bridge::formatSyncEvent (3, "start", 12.345678901) };
    CHECK (line == "E 3 start 12.345679\n");
    bridge::SyncEvent e;
    CHECK (bridge::parseSyncEvent (line, e));
    CHECK (e.seq == 3);
    CHECK (e.kind == "start");
    CHECK_NEAR (e.posSec, 12.345679, 1e-9);
    CHECK (bridge::parseSyncEvent (bridge::formatSyncEvent (4, "stop", 0.0), e));
    CHECK (e.kind == "stop");
    CHECK (bridge::parseSyncEvent (bridge::formatSyncEvent (5, "seek", -1.5), e));
    CHECK_NEAR (e.posSec, -1.5, 1e-9);
    for (const char* bad : { "", "E 1 jump 2", "E 1 start", "E x start 1", "E 1 start y", "L 1 start 2", "E 1 start 2 3" })
        CHECK (! bridge::parseSyncEvent (bad, e));
}

TEST (follow_starts_a_stopped_host_when_live_plays_inside_the_region)
{
    const auto d { bridge::decideFollow (live (2.0, true), 0.05, { false, 0.0 }, 10.0) };
    CHECK (d.start);
    CHECK (d.seek);
    CHECK_NEAR (d.seekSec, 2.05, 1e-12);       // Live has moved on since the report
    CHECK (! d.stop);
}

TEST (follow_leaves_a_host_alone_that_is_close_and_moves_one_that_is_far)
{
    CHECK (! bridge::decideFollow (live (2.0, true), 0.0, { true, 2.05 }, 10.0).seek);
    CHECK (! bridge::decideFollow (live (2.0, true), 0.0, { true, 1.93 }, 10.0).seek);
    const auto far { bridge::decideFollow (live (2.0, true), 0.0, { true, 3.0 }, 10.0) };
    CHECK (far.seek);
    CHECK (! far.start);
    CHECK_NEAR (far.seekSec, 2.0, 1e-12);
    // the tolerance is a parameter
    CHECK (bridge::decideFollow (live (2.0, true), 0.0, { true, 2.05 }, 10.0, 0.01).seek);
}

TEST (follow_stops_when_live_plays_outside_the_region)
{
    CHECK (bridge::decideFollow (live (-1.0, true), 0.0, { true, 4.0 }, 10.0).stop);       // before the clip
    CHECK (bridge::decideFollow (live (10.0, true), 0.0, { true, 9.9 }, 10.0).stop);       // at its end
    CHECK (bridge::decideFollow (live (12.0, true), 0.0, { true, 9.9 }, 10.0).stop);       // after it
    const auto idle { bridge::decideFollow (live (-1.0, true), 0.0, { false, 0.0 }, 10.0) };
    CHECK (! idle.stop && ! idle.start && ! idle.seek);
    // Live is before the clip but will be inside it by the time the report is acted on
    CHECK (bridge::decideFollow (live (-0.01, true), 0.05, { false, 0.0 }, 10.0).start);
}

TEST (follow_a_stopped_live_stops_the_host_and_shows_its_position)
{
    const auto d { bridge::decideFollow (live (4.0, false), 5.0, { true, 6.0 }, 10.0) };   // time since the report does not matter
    CHECK (d.stop);
    CHECK (d.seek);
    CHECK_NEAR (d.seekSec, 4.0, 1e-12);
    const auto same { bridge::decideFollow (live (4.0, false), 0.0, { false, 4.0005 }, 10.0) };
    CHECK (! same.seek && ! same.stop && ! same.start);
    // a stopped Live outside the region leaves the cursor where it is
    const auto outside { bridge::decideFollow (live (20.0, false), 0.0, { false, 3.0 }, 10.0) };
    CHECK (! outside.seek && ! outside.stop);
    CHECK (bridge::decideFollow (live (20.0, false), 0.0, { true, 3.0 }, 10.0).stop);
}
