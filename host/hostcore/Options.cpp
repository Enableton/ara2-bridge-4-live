#include "hostcore/Options.h"

namespace bridge
{
    bool parseHostArguments (const std::vector<std::string>& args, HostOptions& options, std::string& error)
    {
        HostOptions parsed;
        bool haveJob { false };
        const std::string* command { nullptr };    // --version or --find-plugins
        for (size_t i { 0 }; i < args.size (); ++i)
        {
            const std::string& arg { args[i] };
            if (arg == "--job")
            {
                if (haveJob)
                {
                    error = "--job given twice";
                    return false;
                }
                if (i + 1 >= args.size () || args[i + 1].empty ())
                {
                    error = "--job needs a folder";
                    return false;
                }
                parsed.jobDir = args[++i];
                haveJob = true;
            }
            else if (arg == "--autorender")
            {
                parsed.autorender = true;
            }
            else if (arg == "--version" || arg == "--find-plugins")
            {
                if (command != nullptr)
                {
                    error = arg + " cannot be combined with " + *command;
                    return false;
                }
                command = &arg;
            }
            else if (arg.rfind ("-psn_", 0) == 0)
            {
                // added by macOS when an app is launched from the Finder or with 'open'
            }
            else
            {
                error = "unknown argument '" + arg + "'";
                return false;
            }
        }
        if (command != nullptr)
        {
            if (haveJob || parsed.autorender)
            {
                error = *command + " takes no other arguments";
                return false;
            }
            parsed.command = *command == "--version" ? HostCommand::version : HostCommand::findPlugIns;
            options = parsed;
            return true;
        }
        if (! haveJob)
        {
            error = "missing --job";
            return false;
        }
        options = parsed;
        return true;
    }

    std::vector<std::string> splitPathList (const std::string& list)
    {
        std::vector<std::string> result;
        size_t from { 0 };
        while (from <= list.size ())
        {
            const size_t colon { list.find (':', from) };
            const size_t to { colon == std::string::npos ? list.size () : colon };
            if (to > from)
                result.push_back (list.substr (from, to - from));
            if (colon == std::string::npos)
                break;
            from = colon + 1;
        }
        return result;
    }
}
