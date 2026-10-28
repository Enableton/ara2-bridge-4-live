#include "hostcore/SyncFollow.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <vector>

namespace bridge
{
    namespace
    {
        bool parseNumber (const std::string& text, double& out)
        {
            if (text.empty ())
                return false;
            char* end { nullptr };
            const double value { std::strtod (text.c_str (), &end) };
            if (end == text.c_str () || *end != '\0' || ! std::isfinite (value))
                return false;
            out = value;
            return true;
        }

        bool parseInteger (const std::string& text, long long& out)
        {
            if (text.empty () || text.size () > 18)
                return false;
            char* end { nullptr };
            const long long value { std::strtoll (text.c_str (), &end, 10) };
            if (end == text.c_str () || *end != '\0')
                return false;
            out = value;
            return true;
        }

        std::vector<std::string> fields (std::string line)
        {
            while (! line.empty () && (line.back () == '\n' || line.back () == '\r'))
                line.pop_back ();
            std::vector<std::string> parts;
            std::string current;
            for (const char c : line)
            {
                if (c == ' ')
                {
                    parts.push_back (current);
                    current.clear ();
                }
                else
                    current += c;
            }
            parts.push_back (current);
            return parts;
        }
    }

    bool parseLiveLine (const std::string& line, LiveReport& report)
    {
        const auto parts { fields (line) };
        long long seq { 0 };
        double pos { 0.0 };
        if (parts.size () != 4 || parts[0] != "L" || ! parseInteger (parts[1], seq) || ! parseNumber (parts[2], pos)
            || (parts[3] != "0" && parts[3] != "1") || std::fabs (pos) > 1.0e7)
            return false;
        report.seq = seq;
        report.posSec = pos;
        report.playing = parts[3] == "1";
        return true;
    }

    std::string formatSyncEvent (long long seq, const std::string& kind, double posSec)
    {
        char buffer[96];
        std::snprintf (buffer, sizeof buffer, "E %lld %s %.6f\n", seq, kind.c_str (), posSec);
        return buffer;
    }

    bool parseSyncEvent (const std::string& line, SyncEvent& event)
    {
        const auto parts { fields (line) };
        long long seq { 0 };
        double pos { 0.0 };
        if (parts.size () != 4 || parts[0] != "E" || ! parseInteger (parts[1], seq) || ! parseNumber (parts[3], pos)
            || (parts[2] != "start" && parts[2] != "stop" && parts[2] != "seek"))
            return false;
        event.seq = seq;
        event.kind = parts[2];
        event.posSec = pos;
        return true;
    }

    FollowDecision decideFollow (const LiveReport& live, double sinceReportSec, const HostPlayState& host, double regionSec, double toleranceSec)
    {
        FollowDecision decision;
        const double expected { live.playing ? live.posSec + std::max (sinceReportSec, 0.0) : live.posSec };
        const bool inside { expected >= 0.0 && expected < regionSec };
        if (live.playing)
        {
            if (! inside)
            {
                decision.stop = host.playing;
                return decision;
            }
            if (! host.playing)
            {
                decision.start = true;
                decision.seek = true;
                decision.seekSec = expected;
            }
            else if (std::fabs (host.posSec - expected) > toleranceSec)
            {
                decision.seek = true;
                decision.seekSec = expected;
            }
            return decision;
        }
        decision.stop = host.playing;
        if (inside && std::fabs (host.posSec - expected) > 0.001)
        {
            decision.seek = true;
            decision.seekSec = expected;
        }
        return decision;
    }
}
