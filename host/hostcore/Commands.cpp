#include "hostcore/Commands.h"

#include "hostcore/Options.h"
#include "plugins/PlugInFinder.h"

#include <cstdio>

namespace bridge
{
    std::string versionLine (const std::string& build)
    {
        return "BridgeHost " + (build.empty () ? std::string ("unknown") : build) + " job-protocol " + std::to_string (kJobProtocolVersion);
    }

    std::string jsonString (const std::string& text)
    {
        std::string out { "\"" };
        for (const char c : text)
        {
            const auto byte { static_cast<unsigned char> (c) };
            if (c == '"' || c == '\\')
            {
                out += '\\';
                out += c;
            }
            else if (byte < 0x20)
            {
                char escaped[8];
                std::snprintf (escaped, sizeof escaped, "\\u%04x", byte);
                out += escaped;
            }
            else
            {
                out += c;
            }
        }
        return out + "\"";
    }

    std::string plugInReportJson (const std::map<std::string, std::string>& overrides, const std::vector<std::string>& dirs)
    {
        std::string json { "{" };
        for (const char* plugin : { "melodyne", "vocalign" })
        {
            std::string problem;
            const std::string path { findPlugIn (plugin, overrides, dirs, &problem) };
            if (json.size () > 1)
                json += ", ";
            json += jsonString (plugin) + ": {";
            if (path.empty ())
            {
                json += "\"found\": false, \"problem\": " + jsonString (problem);
            }
            else
            {
                json += "\"found\": true, \"path\": " + jsonString (path);
                if (! problem.empty ())
                    json += ", \"warning\": " + jsonString (problem);
            }
            json += "}";
        }
        return json + "}";
    }
}
