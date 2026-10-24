#include "check.h"
#include "testutil.h"

#include "hostcore/Commands.h"
#include "hostcore/Options.h"

#include <filesystem>
#include <string>
#include <sys/stat.h>
#include <vector>

namespace
{
    namespace fs = std::filesystem;

    bool parses (const std::vector<std::string>& args, bridge::HostOptions& options, std::string& error)
    {
        options = {};
        error.clear ();
        return bridge::parseHostArguments (args, options, error);
    }

    // a fake VST3 bundle (Contents/Info.plist and an executable in Contents/MacOS)
    std::string makeBundle (const std::string& dir, const std::string& name)
    {
        const std::string bundle { dir + "/" + name };
        fs::create_directories (bundle + "/Contents/MacOS");
        writeTextFile (bundle + "/Contents/Info.plist", "<?xml version=\"1.0\"?><plist version=\"1.0\"><dict></dict></plist>\n");
        writeTextFile (bundle + "/Contents/MacOS/exe", "#!/bin/sh\n");
        ::chmod ((bundle + "/Contents/MacOS/exe").c_str (), 0755);
        return bundle;
    }

    bool contains (const std::string& text, const std::string& part)
    {
        if (text.find (part) != std::string::npos)
            return true;
        std::printf ("    '%s' does not contain '%s'\n", text.c_str (), part.c_str ());
        return false;
    }
}

TEST (options_parse_version_and_find_plugins)
{
    bridge::HostOptions options;
    std::string error;
    REQUIRE (parses ({ "--version" }, options, error));
    CHECK (options.command == bridge::HostCommand::version);
    REQUIRE (parses ({ "--find-plugins" }, options, error));
    CHECK (options.command == bridge::HostCommand::findPlugIns);
    REQUIRE (parses ({ "-psn_0_1", "--version" }, options, error));
    CHECK (options.command == bridge::HostCommand::version);
    REQUIRE (parses ({ "--job", "/a" }, options, error));
    CHECK (options.command == bridge::HostCommand::run);

    CHECK (! parses ({ "--version", "--job", "/a" }, options, error));
    CHECK (contains (error, "--version takes no other arguments"));
    CHECK (! parses ({ "--find-plugins", "--autorender" }, options, error));
    CHECK (contains (error, "--find-plugins takes no other arguments"));
    CHECK (! parses ({ "--version", "--find-plugins" }, options, error));
    CHECK (contains (error, "cannot be combined"));
    CHECK (! parses ({ "--version", "--version" }, options, error));
    CHECK (! parses ({ "--version", "extra" }, options, error));
    CHECK (contains (error, "unknown argument 'extra'"));
}

TEST (version_line_names_the_build_and_the_protocol)
{
    CHECK (bridge::versionLine ("97bdf5c") == "BridgeHost 97bdf5c job-protocol 1");
    CHECK (bridge::versionLine ("") == "BridgeHost unknown job-protocol 1");
    CHECK (bridge::kJobProtocolVersion == 1);
}

TEST (json_strings_are_escaped)
{
    CHECK (bridge::jsonString ("a\"b\\c") == "\"a\\\"b\\\\c\"");
    CHECK (bridge::jsonString ("tab\tnl\n\x01") == "\"tab\\u0009nl\\u000a\\u0001\"");
    CHECK (bridge::jsonString ("M\xC3\xBCller \xF0\x9F\x8E\xA4") == "\"M\xC3\xBCller \xF0\x9F\x8E\xA4\"");    // UTF-8 kept
    CHECK (bridge::jsonString ("") == "\"\"");
}

TEST (plugin_report_says_what_was_found)
{
    const std::string root { makeTempDir ("report") };
    const std::string dir { root + "/Plug-Ins \"M\xC3\xBCller\"" };
    fs::create_directories (dir);
    const std::string melodyne { makeBundle (dir, "Melodyne.vst3") };

    const std::string json { bridge::plugInReportJson ({}, { dir }) };
    CHECK (json.rfind ("{\"melodyne\": {\"found\": true, \"path\": ", 0) == 0);
    CHECK (contains (json, bridge::jsonString (melodyne)));
    CHECK (contains (json, "\"vocalign\": {\"found\": false, \"problem\": \"No VocAlign VST3 bundle found in "));
    CHECK (contains (json, "Plug-Ins \\\"M\xC3\xBCller\\\""));
    CHECK (json.back () == '}');
    CHECK (json.find ('\n') == std::string::npos);

    // an override wins; a bad override is a warning when the standard folders still have the plug-in
    const std::string other { makeBundle (root, "VocAlign 6 Pro.vst3") };
    const std::string withOverrides { bridge::plugInReportJson ({ { "vocalign", other }, { "melodyne", root + "/missing.vst3" } }, { dir }) };
    CHECK (contains (withOverrides, "\"vocalign\": {\"found\": true, \"path\": " + bridge::jsonString (other) + "}"));
    CHECK (contains (withOverrides, "\"melodyne\": {\"found\": true, \"path\": " + bridge::jsonString (melodyne) + ", \"warning\": "));
    CHECK (contains (withOverrides, "missing.vst3"));

    // nothing found anywhere
    const std::string none { bridge::plugInReportJson ({}, {}) };
    CHECK (contains (none, "\"melodyne\": {\"found\": false, \"problem\": \"No Melodyne VST3 bundle found in (no folders)\"}"));
}
