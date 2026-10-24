#pragma once

#include <map>
#include <string>
#include <vector>

namespace bridge
{
    // "/Library/Audio/Plug-Ins/VST3" and "$HOME/Library/Audio/Plug-Ins/VST3" (the home folder comes from
    // $HOME, else from the user database; if neither is known, only the system folder is returned).
    std::vector<std::string> defaultPlugInDirs ();

    // Finds the VST3 bundle of a plug-in. 'plugin' is "melodyne" or "vocalign" (any letter case).
    //
    // An override (the settings.json pluginPaths entry, a leading "~/" is expanded) wins when it is a
    // complete bundle. A bad override is not an error: it is reported through 'problem' and discovery runs
    // as if there were none.
    //
    // Discovery looks at the direct children of each folder in 'dirs' (not deeper, so symlink loops cannot
    // trap it; at most 100000 entries per folder are looked at; folders that cannot be read are skipped).
    // A bundle name matches when, ignoring case, it is "<name>.vst3" where <name> is the product word
    // ("Melodyne", "VocAlign") followed only by version numbers and edition words ("Melodyne 5", "Melodyne5",
    // "Melodyne Studio", "VocAlign 6 Pro", "VocAlign6Pro", "VocAlign Ultra"). Other products ("VocAlign
    // Project 5"), helpers, backups ("Melodyne.vst3.bak_stock") and hidden files do not match. A candidate
    // must be a complete bundle: a folder (a symlink to one is fine) with a Contents/Info.plist file and an
    // executable file in Contents/MacOS.
    //
    // Among several candidates the highest version wins (CFBundleShortVersionString from Info.plist, else the
    // number in the file name, else 0); equal versions go to the earlier folder in 'dirs', then to the
    // name that sorts first. The result is "<dir>/<name>.vst3" (a trailing '/' on dir is dropped); an empty
    // string means nothing was found.
    //
    // 'problem' (optional) is cleared first, and is set when a bad override was ignored (also when
    // discovery then succeeded), when the plug-in name is unknown, or when nothing was found (then it lists
    // the folders searched). It is empty when everything went as expected.
    std::string findPlugIn (const std::string& plugin, const std::map<std::string, std::string>& overrides,
                            const std::vector<std::string>& dirs, std::string* problem = nullptr);
}
