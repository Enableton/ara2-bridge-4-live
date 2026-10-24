#pragma once

#include <map>
#include <string>
#include <vector>

// The informational commands (SDK-free, so they are unit tested): BridgeHost --version and --find-plugins.
namespace bridge
{
    // "BridgeHost <build> job-protocol <kJobProtocolVersion>", e.g. "BridgeHost 97bdf5c job-protocol 1".
    std::string versionLine (const std::string& build);

    // One line of JSON for --find-plugins, with the same finder (findPlugIn) and inputs as a real run:
    //   {"melodyne": {"found": true, "path": "/Library/Audio/Plug-Ins/VST3/Melodyne.vst3"},
    //    "vocalign": {"found": false, "problem": "No VocAlign VST3 bundle found in ..."}}
    // A found plug-in also gets "warning" when findPlugIn reported a problem anyway (a bad settings.json
    // override that was ignored). Strings are UTF-8 as given, with '"', '\' and control characters escaped.
    std::string plugInReportJson (const std::map<std::string, std::string>& overrides, const std::vector<std::string>& dirs);

    // 'text' as a JSON string literal (with the quotes).
    std::string jsonString (const std::string& text);
}
