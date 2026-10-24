#pragma once

#include <string>
#include <vector>

namespace bridge
{
    // BridgeHost exit codes. A crash ends the process through the signal instead (see RunGuard.h).
    enum ExitCode : int
    {
        kExitOk = 0,            // result.json says "ok"
        kExitCancelled = 1,     // the user closed the window or pressed Cancel (UI mode)
        kExitBadJob = 2,        // usage error, unreadable or invalid job.json, result.json already there
        kExitPlugIn = 3,        // plug-in not found, not loadable as ARA, or not licensed (headless)
        kExitAudio = 4,         // a clip's audio is missing, unreadable or does not fit the job
        kExitRender = 5,        // rendering or writing the result failed
        kExitStopped = 6,       // stopped by SIGTERM/SIGINT/SIGHUP or timed out
    };

    // The job.json / result.json protocol version this host speaks (job.json "version", result.json "version").
    constexpr int kJobProtocolVersion { 1 };

    enum class HostCommand
    {
        run,            // --job <dir> [--autorender]
        version,        // --version: one line with the build and the job protocol version
        findPlugIns,    // --find-plugins: JSON saying which plug-ins were found (hostcore/Commands.h)
    };

    struct HostOptions
    {
        HostCommand command { HostCommand::run };
        std::string jobDir;
        bool autorender { false };
    };

    // BridgeHost --job <dir> [--autorender] | --version | --find-plugins; 'args' excludes argv[0]. Arguments
    // macOS adds when launching an app (-psn_...) are ignored; anything else unknown, a missing or empty
    // --job, --job given twice, or --version / --find-plugins together with any other argument is an error.
    bool parseHostArguments (const std::vector<std::string>& args, HostOptions& options, std::string& error);

    // Splits a ':'-separated folder list (ARABRIDGE_PLUGIN_DIRS); empty items are dropped.
    std::vector<std::string> splitPathList (const std::string& list);
}
