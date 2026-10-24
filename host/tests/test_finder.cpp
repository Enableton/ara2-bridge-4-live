#include "check.h"
#include "testutil.h"

#include "plugins/PlugInFinder.h"

#include <cstdlib>
#include <filesystem>
#include <sys/stat.h>
#include <unistd.h>

namespace
{
    namespace fs = std::filesystem;

    // A fake VST3 bundle: Contents/Info.plist and an executable in Contents/MacOS. 'version' goes into
    // CFBundleShortVersionString when it is not empty.
    std::string makeBundle (const std::string& dir, const std::string& name, const std::string& version = {})
    {
        const std::string bundle { dir + "/" + name };
        fs::create_directories (bundle + "/Contents/MacOS");
        std::string plist { "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
                            "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n"
                            "<plist version=\"1.0\"><dict><key>CFBundleExecutable</key><string>exe</string>" };
        if (! version.empty ())
            plist += "<key>CFBundleShortVersionString</key><string>" + version + "</string>";
        plist += "</dict></plist>\n";
        writeTextFile (bundle + "/Contents/Info.plist", plist);
        writeTextFile (bundle + "/Contents/MacOS/exe", "#!/bin/sh\n");
        ::chmod ((bundle + "/Contents/MacOS/exe").c_str (), 0755);
        return bundle;
    }

    bool contains (const std::string& text, const std::string& part)
    {
        return text.find (part) != std::string::npos;
    }

    // Sets an environment variable for the lifetime of the object.
    struct ScopedEnv
    {
        ScopedEnv (const char* n, const char* value) : name (n)
        {
            if (const char* old = std::getenv (n))
            {
                had = true;
                previous = old;
            }
            ::setenv (n, value, 1);
        }
        ~ScopedEnv ()
        {
            if (had)
                ::setenv (name, previous.c_str (), 1);
            else
                ::unsetenv (name);
        }
        const char* name;
        bool had { false };
        std::string previous;
    };
}

TEST (finder_locates_bundles_in_search_dirs)
{
    const std::string a { makeTempDir ("fa") };
    const std::string b { makeTempDir ("fb") };
    makeBundle (b, "Melodyne.vst3");
    makeBundle (a, "VocAlign6Pro.vst3");

    const std::vector<std::string> dirs { a, b };
    CHECK (bridge::findPlugIn ("melodyne", {}, dirs) == b + "/Melodyne.vst3");
    CHECK (bridge::findPlugIn ("vocalign", {}, dirs) == a + "/VocAlign6Pro.vst3");
}

TEST (finder_returns_empty_when_missing_or_unknown)
{
    const std::string dir { makeTempDir ("fm") };
    std::string problem;
    CHECK (bridge::findPlugIn ("melodyne", {}, { dir }, &problem).empty ());
    CHECK (contains (problem, "Melodyne") && contains (problem, dir));          // says what was searched, and where
    CHECK (bridge::findPlugIn ("autotune", {}, { dir }, &problem).empty ());
    CHECK (contains (problem, "autotune"));
    CHECK (bridge::findPlugIn ("melodyne", {}, {}).empty ());                   // no folders at all
}

TEST (finder_prefers_an_existing_override)
{
    const std::string dir { makeTempDir ("fo") };
    makeBundle (dir, "Melodyne.vst3");
    makeBundle (dir, "Custom.vst3");

    std::string problem;
    const std::map<std::string, std::string> good { { "melodyne", dir + "/Custom.vst3" } };
    CHECK (bridge::findPlugIn ("melodyne", good, { dir }, &problem) == dir + "/Custom.vst3");
    CHECK (problem.empty ());

    // A stale override is reported, then discovery takes over.
    const std::map<std::string, std::string> stale { { "melodyne", dir + "/Gone.vst3" } };
    CHECK (bridge::findPlugIn ("melodyne", stale, { dir }, &problem) == dir + "/Melodyne.vst3");
    CHECK (contains (problem, dir + "/Gone.vst3"));
    CHECK (contains (problem, "does not exist"));

    // An override for the other plug-in does not matter.
    const std::map<std::string, std::string> other { { "vocalign", dir + "/Gone.vst3" } };
    problem = "left over";
    CHECK (bridge::findPlugIn ("melodyne", other, { dir }, &problem) == dir + "/Melodyne.vst3");
    CHECK (problem.empty ());
}

TEST (finder_rejects_an_override_that_is_not_a_bundle)
{
    const std::string dir { makeTempDir ("fob") };
    makeBundle (dir, "Melodyne.vst3");
    fs::create_directories (dir + "/Empty.vst3");
    writeTextFile (dir + "/File.vst3", "x");

    for (const char* bad : { "Empty.vst3", "File.vst3" })
    {
        std::string problem;
        const std::map<std::string, std::string> overrides { { "melodyne", dir + "/" + bad } };
        CHECK (bridge::findPlugIn ("melodyne", overrides, { dir }, &problem) == dir + "/Melodyne.vst3");
        CHECK (contains (problem, bad));
    }

    // With no discoverable bundle either, the result is empty and the message names the override problem too.
    const std::string empty { makeTempDir ("fob2") };
    fs::create_directories (empty + "/Empty.vst3");
    std::string problem;
    const std::map<std::string, std::string> overrides { { "vocalign", empty + "/Empty.vst3" } };
    CHECK (bridge::findPlugIn ("vocalign", overrides, { empty }, &problem).empty ());
    CHECK (contains (problem, "Empty.vst3") && contains (problem, "VocAlign"));
}

TEST (finder_default_dirs_include_system_and_user_folders)
{
    const auto dirs = bridge::defaultPlugInDirs ();
    CHECK (dirs.size () == 2);
    CHECK (dirs[0] == "/Library/Audio/Plug-Ins/VST3");
    CHECK (dirs[1].find ("/Library/Audio/Plug-Ins/VST3") != std::string::npos && dirs[1] != dirs[0]);
}

TEST (finder_user_folder_follows_home_and_expands_tilde)
{
    const std::string home { makeTempDir ("fh") };
    makeBundle (home + "/custom", "Mine.vst3");
    fs::create_directories (home + "/custom");

    {
        ScopedEnv env ("HOME", (home + "/").c_str ());                      // a trailing slash must not double up
        const auto dirs = bridge::defaultPlugInDirs ();
        REQUIRE (dirs.size () == 2);
        CHECK (dirs[1] == home + "/Library/Audio/Plug-Ins/VST3");

        const std::map<std::string, std::string> overrides { { "melodyne", "~/custom/Mine.vst3" } };
        CHECK (bridge::findPlugIn ("melodyne", overrides, {}) == home + "/custom/Mine.vst3");
    }
}

TEST (finder_matches_bundle_names_loosely)
{
    // Every name here should be accepted for its plug-in, one folder per name.
    struct Good { const char* plugin; const char* name; };
    const Good good[] {
        { "melodyne", "Melodyne.vst3" },     { "melodyne", "melodyne.vst3" },      { "melodyne", "MELODYNE.VST3" },
        { "melodyne", "Melodyne 5.vst3" },   { "melodyne", "Melodyne5.vst3" },     { "melodyne", "Melodyne-5.4.vst3" },
        { "melodyne", "Melodyne_5 Studio.vst3" },
        { "vocalign", "VocAlign6Pro.vst3" }, { "vocalign", "VocAlign 6 Pro.vst3" }, { "vocalign", "vocalign_6_pro.vst3" },
        { "vocalign", "VocAlign Pro 6.vst3" }, { "vocalign", "VocAlign.vst3" },     { "vocalign", "VocAlign Ultra 4.vst3" },
    };
    int index { 0 };
    for (const Good& test : good)
    {
        const std::string dir { makeTempDir ("fn" + std::to_string (index++)) };
        makeBundle (dir, test.name);
        const std::string found { bridge::findPlugIn (test.plugin, {}, { dir }) };
        if (found != dir + "/" + test.name)
            std::printf ("    %s should match %s, got '%s'\n", test.name, test.plugin, found.c_str ());
        CHECK (found == dir + "/" + test.name);
    }

    // None of these may match: other products, helpers, backups, other formats, look-alike names.
    const char* bad[] {
        "Melodyne.vst3.bak_stock", "Melodyne.vst", "Melodyne.component", "Melodyne", "Melodyne.vst3.zip",
        "MelodyneX.vst3", "My Melodyne.vst3", "Melodyne Helper.vst3", "Celemony Melodyne.vst3", ".Melodyne.vst3",
        "VocAlignProject5.vst3", "VocAlign Project 5.vst3", "VocAlignX.vst3", "Joe Chiccarelli Vocal Strip.vst3",
    };
    const std::string dir { makeTempDir ("fnb") };
    for (const char* name : bad)
        makeBundle (dir, name);
    CHECK (bridge::findPlugIn ("melodyne", {}, { dir }).empty ());
    CHECK (bridge::findPlugIn ("vocalign", {}, { dir }).empty ());
    CHECK (bridge::findPlugIn ("MELODYNE", {}, { dir }).empty ());
}

TEST (finder_accepts_the_plugin_name_in_any_case)
{
    const std::string dir { makeTempDir ("fc") };
    makeBundle (dir, "Melodyne.vst3");
    CHECK (bridge::findPlugIn ("Melodyne", {}, { dir }) == dir + "/Melodyne.vst3");
}

TEST (finder_prefers_the_highest_version)
{
    const std::string dir { makeTempDir ("fv") };
    makeBundle (dir, "Melodyne 4.vst3");
    makeBundle (dir, "Melodyne 5.vst3");
    makeBundle (dir, "Melodyne 10.vst3");                                   // numeric, not alphabetical
    makeBundle (dir, "Melodyne 9.vst3");
    CHECK (bridge::findPlugIn ("melodyne", {}, { dir }) == dir + "/Melodyne 10.vst3");

    // Across folders the higher version wins, whatever the folder order.
    const std::string a { makeTempDir ("fva") };
    const std::string b { makeTempDir ("fvb") };
    makeBundle (a, "VocAlign 5 Pro.vst3");
    makeBundle (b, "VocAlign6Pro.vst3");
    CHECK (bridge::findPlugIn ("vocalign", {}, { a, b }) == b + "/VocAlign6Pro.vst3");
    CHECK (bridge::findPlugIn ("vocalign", {}, { b, a }) == b + "/VocAlign6Pro.vst3");

    // Equal versions: the earlier folder wins.
    const std::string c { makeTempDir ("fvc") };
    const std::string d { makeTempDir ("fvd") };
    makeBundle (c, "Melodyne.vst3", "5.4.2");
    makeBundle (d, "Melodyne.vst3", "5.4.2");
    CHECK (bridge::findPlugIn ("melodyne", {}, { c, d }) == c + "/Melodyne.vst3");
    CHECK (bridge::findPlugIn ("melodyne", {}, { d, c }) == d + "/Melodyne.vst3");
}

TEST (finder_reads_the_version_from_info_plist)
{
    const std::string dir { makeTempDir ("fvp") };
    makeBundle (dir, "Melodyne.vst3", "5.4.2");                             // no number in the name, but the plist has one
    makeBundle (dir, "Melodyne 4.vst3", "4.2.1");
    CHECK (bridge::findPlugIn ("melodyne", {}, { dir }) == dir + "/Melodyne.vst3");

    // The plist wins over the name; 5.10 is newer than 5.9.
    const std::string two { makeTempDir ("fvq") };
    makeBundle (two, "Melodyne A.vst3", "5.9.0");                           // "A" is not an accepted word: ignored
    makeBundle (two, "Melodyne 7.vst3", "5.9.0");
    makeBundle (two, "Melodyne 6.vst3", "5.10.0");
    CHECK (bridge::findPlugIn ("melodyne", {}, { two }) == two + "/Melodyne 6.vst3");

    // A plist that is not parseable still counts (the version then comes from the name).
    const std::string three { makeTempDir ("fvr") };
    makeBundle (three, "Melodyne 5.vst3");
    writeTextFile (three + "/Melodyne 5.vst3/Contents/Info.plist", "this is not a plist");
    CHECK (bridge::findPlugIn ("melodyne", {}, { three }) == three + "/Melodyne 5.vst3");
}

TEST (finder_ignores_things_that_are_not_complete_bundles)
{
    const std::string dir { makeTempDir ("fi") };
    const std::string good { makeBundle (dir, "Melodyne 1.vst3") };         // the only valid one; the others have higher numbers

    writeTextFile (dir + "/Melodyne 9.vst3", "a plain file");

    fs::create_directories (dir + "/Melodyne 8.vst3");                      // empty directory

    makeBundle (dir, "Melodyne 7.vst3");
    fs::remove (dir + "/Melodyne 7.vst3/Contents/Info.plist");              // no Info.plist

    makeBundle (dir, "Melodyne 6.vst3");
    fs::remove_all (dir + "/Melodyne 6.vst3/Contents/MacOS");               // no MacOS folder

    makeBundle (dir, "Melodyne 5.vst3");
    fs::remove (dir + "/Melodyne 5.vst3/Contents/MacOS/exe");               // MacOS folder is empty

    makeBundle (dir, "Melodyne 4.vst3");
    ::chmod ((dir + "/Melodyne 4.vst3/Contents/MacOS/exe").c_str (), 0644); // not executable

    makeBundle (dir, "Melodyne 3.vst3");
    fs::remove (dir + "/Melodyne 3.vst3/Contents/Info.plist");
    fs::create_directories (dir + "/Melodyne 3.vst3/Contents/Info.plist");  // Info.plist is a directory

    makeBundle (dir, "Melodyne 2.vst3");
    fs::remove (dir + "/Melodyne 2.vst3/Contents/MacOS/exe");
    fs::create_directories (dir + "/Melodyne 2.vst3/Contents/MacOS/exe");   // the "executable" is a directory

    fs::create_symlink (dir + "/does-not-exist.vst3", dir + "/Melodyne 10.vst3");   // broken symlink
    fs::create_symlink (dir + "/Melodyne 10.vst3", dir + "/Melodyne 11.vst3");      // symlink to a broken symlink

    CHECK (bridge::findPlugIn ("melodyne", {}, { dir }) == good);
}

TEST (finder_follows_a_symlink_to_a_bundle)
{
    const std::string real { makeTempDir ("fs1") };
    const std::string links { makeTempDir ("fs2") };
    const std::string bundle { makeBundle (real, "Melodyne 5.vst3") };
    fs::create_directory_symlink (bundle, links + "/Melodyne.vst3");
    CHECK (bridge::findPlugIn ("melodyne", {}, { links }) == links + "/Melodyne.vst3");
}

TEST (finder_survives_odd_search_folders)
{
    const std::string dir { makeTempDir ("fq") };
    makeBundle (dir, "Melodyne.vst3");
    writeTextFile (dir + "/afile", "x");

    // Symlink loops: a bundle name that points at itself, and a folder that points back at its parent.
    fs::create_symlink (dir + "/Melodyne 9.vst3", dir + "/Melodyne 9.vst3");
    fs::create_directory_symlink (dir, dir + "/loop");
    fs::create_directory_symlink (dir, dir + "/Melodyne 8.vst3");

    const std::string unreadable { makeTempDir ("fq2") };
    makeBundle (unreadable, "Melodyne 7.vst3");
    ::chmod (unreadable.c_str (), 0000);

    const std::vector<std::string> dirs {
        "", "/does/not/exist", dir + "/afile", unreadable, dir + "/loop", dir,
    };
    const std::string found { bridge::findPlugIn ("melodyne", {}, dirs) };
    ::chmod (unreadable.c_str (), 0755);                                    // so makeTempDir can clean up later
    if (::geteuid () != 0)
        CHECK (found == dir + "/loop/Melodyne.vst3" || found == dir + "/Melodyne.vst3");
    else
        CHECK (! found.empty ());

    // Names are returned with the folder exactly as given, also with a trailing slash.
    CHECK (bridge::findPlugIn ("melodyne", {}, { dir + "/" }) == dir + "/Melodyne.vst3");
}

TEST (finder_handles_a_large_folder)
{
    const std::string dir { makeTempDir ("fl") };
    for (int i = 0; i < 3000; ++i)
        writeTextFile (dir + "/other_" + std::to_string (i) + ".txt", "x");
    for (int i = 0; i < 300; ++i)
        fs::create_directories (dir + "/Other" + std::to_string (i) + ".vst3");
    makeBundle (dir, "VocAlign6Pro.vst3");
    CHECK (bridge::findPlugIn ("vocalign", {}, { dir }) == dir + "/VocAlign6Pro.vst3");
}

// Not a unit test of the logic: it checks the real machine, and reports SKIP when nothing is installed there.
TEST (finder_sanity_check_on_this_machine)
{
    const auto dirs = bridge::defaultPlugInDirs ();
    for (const char* plugin : { "melodyne", "vocalign" })
    {
        std::string problem;
        const std::string found { bridge::findPlugIn (plugin, {}, dirs, &problem) };
        if (found.empty ())
        {
            std::printf ("    [ SKIP ] %s is not installed in the standard VST3 folders\n", plugin);
            continue;
        }
        std::printf ("    %s -> %s\n", plugin, found.c_str ());
        struct stat info;
        CHECK (::stat ((found + "/Contents/Info.plist").c_str (), &info) == 0);
        CHECK (found.size () > 5 && found.compare (found.size () - 5, 5, ".vst3") == 0);
    }
}
