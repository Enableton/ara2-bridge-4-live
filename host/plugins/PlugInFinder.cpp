#include "plugins/PlugInFinder.h"

#include <CoreFoundation/CoreFoundation.h>

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <dirent.h>
#include <fstream>
#include <iterator>
#include <pwd.h>
#include <sys/stat.h>
#include <unistd.h>

namespace bridge
{
    namespace
    {
        constexpr size_t kMaxEntriesPerDir { 100000 };      // directory entries looked at per folder
        constexpr size_t kMaxCandidatesPerDir { 2000 };     // bundles with a matching name looked at per folder
        constexpr size_t kMaxPlistBytes { 1u << 20 };

        const char* const kSystemDir { "/Library/Audio/Plug-Ins/VST3" };

        struct Product
        {
            const char* key;                        // as used in job.json and settings.json
            const char* display;                    // for messages
            std::vector<std::string> editionWords;  // words allowed after the product word, besides version numbers
        };

        const Product* productFor (const std::string& lowered)
        {
            static const Product products[] {
                { "melodyne", "Melodyne", { "essential", "assistant", "editor", "studio" } },
                { "vocalign", "VocAlign", { "pro", "ultra" } },
            };
            for (const Product& product : products)
                if (lowered == product.key)
                    return &product;
            return nullptr;
        }

        std::string lower (std::string text)
        {
            std::transform (text.begin (), text.end (), text.begin (), [] (unsigned char c) { return static_cast<char> (std::tolower (c)); });
            return text;
        }

        bool isDigit (char c) { return c >= '0' && c <= '9'; }
        bool isLetter (char c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || static_cast<unsigned char> (c) >= 0x80; }

        std::string withoutTrailingSlashes (std::string path)
        {
            while (path.size () > 1 && path.back () == '/')
                path.pop_back ();
            return path;
        }

        std::string join (const std::string& dir, const std::string& name)
        {
            return withoutTrailingSlashes (dir) == "/" ? "/" + name : withoutTrailingSlashes (dir) + "/" + name;
        }

        std::string homeDir ()
        {
            const char* home { std::getenv ("HOME") };
            if (home != nullptr && home[0] != '\0')
                return withoutTrailingSlashes (home);
            if (const passwd* entry = ::getpwuid (::getuid ()))
                if (entry->pw_dir != nullptr && entry->pw_dir[0] != '\0')
                    return withoutTrailingSlashes (entry->pw_dir);
            return {};
        }

        // "5.4.2" -> {5, 4, 2}; anything that is not a digit separates numbers; absurdly long numbers are capped.
        using Version = std::vector<long>;

        Version parseVersion (const std::string& text)
        {
            Version version;
            long current { 0 };
            bool inNumber { false };
            for (const char c : text)
            {
                if (isDigit (c))
                {
                    current = std::min (current * 10 + (c - '0'), 1000000000L);
                    inNumber = true;
                }
                else if (inNumber)
                {
                    version.push_back (current);
                    current = 0;
                    inNumber = false;
                }
            }
            if (inNumber)
                version.push_back (current);
            return version;
        }

        int compareVersions (const Version& a, const Version& b)
        {
            const size_t count { std::max (a.size (), b.size ()) };
            for (size_t i { 0 }; i < count; ++i)
            {
                const long x { i < a.size () ? a[i] : 0 };
                const long y { i < b.size () ? b[i] : 0 };
                if (x != y)
                    return x < y ? -1 : 1;
            }
            return 0;
        }

        // "Melodyne-5.4 Studio" -> melodyne, 5.4, studio. Letters, numbers (digits with inner dots) and separators.
        std::vector<std::string> tokenize (const std::string& stem)
        {
            std::vector<std::string> tokens;
            std::string current;
            enum class Kind { none, letters, number } kind { Kind::none };
            auto flush = [&] ()
            {
                if (! current.empty ())
                    tokens.push_back (lower (current));
                current.clear ();
                kind = Kind::none;
            };
            for (size_t i { 0 }; i < stem.size (); ++i)
            {
                const char c { stem[i] };
                if (isDigit (c))
                {
                    if (kind != Kind::number)
                        flush ();
                    kind = Kind::number;
                    current += c;
                }
                else if (c == '.' && kind == Kind::number && i + 1 < stem.size () && isDigit (stem[i + 1]))
                    current += c;
                else if (isLetter (c))
                {
                    if (kind != Kind::letters)
                        flush ();
                    kind = Kind::letters;
                    current += c;
                }
                else
                    flush ();
            }
            flush ();
            return tokens;
        }

        // Does 'fileName' (like "Melodyne 5.vst3") belong to the product? Fills the version found in the name.
        bool nameMatches (const Product& product, const std::string& fileName, Version& nameVersion)
        {
            constexpr size_t extLength { 5 };
            if (fileName.size () <= extLength || fileName[0] == '.' || lower (fileName.substr (fileName.size () - extLength)) != ".vst3")
                return false;

            const auto tokens = tokenize (fileName.substr (0, fileName.size () - extLength));
            if (tokens.empty () || tokens[0] != product.key)
                return false;

            nameVersion.clear ();
            for (size_t i { 1 }; i < tokens.size (); ++i)
            {
                if (isDigit (tokens[i][0]))
                {
                    if (nameVersion.empty ())
                        nameVersion = parseVersion (tokens[i]);
                }
                else if (std::find (product.editionWords.begin (), product.editionWords.end (), tokens[i]) == product.editionWords.end ())
                    return false;
            }
            return true;
        }

        bool isRegularFile (const std::string& path)
        {
            struct stat info;
            return ::stat (path.c_str (), &info) == 0 && S_ISREG (info.st_mode);
        }

        bool hasExecutable (const std::string& macOsDir)
        {
            DIR* dir { ::opendir (macOsDir.c_str ()) };
            if (dir == nullptr)
                return false;
            bool found { false };
            size_t seen { 0 };
            while (const dirent* entry = ::readdir (dir))
            {
                if (++seen > 1000)
                    break;
                if (entry->d_name[0] == '.')
                    continue;
                const std::string path { macOsDir + "/" + entry->d_name };
                if (isRegularFile (path) && ::access (path.c_str (), X_OK) == 0)
                {
                    found = true;
                    break;
                }
            }
            ::closedir (dir);
            return found;
        }

        // Empty when 'path' is a complete bundle, else why not.
        std::string bundleProblem (const std::string& path)
        {
            struct stat info;
            if (::stat (path.c_str (), &info) != 0)
                return "does not exist";
            if (! S_ISDIR (info.st_mode))
                return "is not a folder";
            if (! isRegularFile (path + "/Contents/Info.plist"))
                return "is not a VST3 bundle (no Contents/Info.plist)";
            if (! hasExecutable (path + "/Contents/MacOS"))
                return "is not a VST3 bundle (no executable in Contents/MacOS)";
            return {};
        }

        // CFBundleShortVersionString of the bundle, or an empty string when the plist cannot be read or has none.
        std::string plistVersion (const std::string& bundle)
        {
            std::ifstream file (bundle + "/Contents/Info.plist", std::ios::binary);
            if (! file)
                return {};
            std::string bytes;
            bytes.assign (std::istreambuf_iterator<char> (file), std::istreambuf_iterator<char> ());
            if (bytes.empty () || bytes.size () > kMaxPlistBytes)
                return {};

            std::string result;
            CFDataRef data { CFDataCreate (kCFAllocatorDefault, reinterpret_cast<const UInt8*> (bytes.data ()), static_cast<CFIndex> (bytes.size ())) };
            if (data == nullptr)
                return {};
            CFPropertyListRef plist { CFPropertyListCreateWithData (kCFAllocatorDefault, data, kCFPropertyListImmutable, nullptr, nullptr) };
            if (plist != nullptr)
            {
                if (CFGetTypeID (plist) == CFDictionaryGetTypeID ())
                {
                    const void* value { CFDictionaryGetValue (static_cast<CFDictionaryRef> (plist), CFSTR ("CFBundleShortVersionString")) };
                    if (value != nullptr && CFGetTypeID (value) == CFStringGetTypeID ())
                    {
                        char buffer[128];
                        if (CFStringGetCString (static_cast<CFStringRef> (value), buffer, sizeof (buffer), kCFStringEncodingUTF8))
                            result = buffer;
                    }
                }
                CFRelease (plist);
            }
            CFRelease (data);
            return result;
        }

        struct Candidate
        {
            std::string path;
            std::string name;
            Version version;
            size_t dirIndex { 0 };
        };

        bool isBetter (const Candidate& a, const Candidate& b)
        {
            const int byVersion { compareVersions (a.version, b.version) };
            if (byVersion != 0)
                return byVersion > 0;
            if (a.dirIndex != b.dirIndex)
                return a.dirIndex < b.dirIndex;
            return a.name < b.name;
        }

        void note (std::string* problem, const std::string& text)
        {
            if (problem == nullptr)
                return;
            if (! problem->empty ())
                *problem += "; ";
            *problem += text;
        }
    }

    std::vector<std::string> defaultPlugInDirs ()
    {
        std::vector<std::string> dirs { kSystemDir };
        const std::string home { homeDir () };
        if (! home.empty ())
            dirs.push_back (home + "/Library/Audio/Plug-Ins/VST3");
        return dirs;
    }

    std::string findPlugIn (const std::string& plugin, const std::map<std::string, std::string>& overrides,
                            const std::vector<std::string>& dirs, std::string* problem)
    {
        if (problem != nullptr)
            problem->clear ();

        const std::string key { lower (plugin) };
        const Product* product { productFor (key) };
        if (product == nullptr)
        {
            note (problem, "Unknown plug-in '" + plugin + "' (expected melodyne or vocalign)");
            return {};
        }

        const auto override = overrides.find (key);
        if (override != overrides.end () && ! override->second.empty ())
        {
            std::string path { override->second };
            if (path.compare (0, 2, "~/") == 0)
            {
                const std::string home { homeDir () };
                if (! home.empty ())
                    path = home + path.substr (1);
            }
            const std::string why { bundleProblem (path) };
            if (why.empty ())
                return path;
            note (problem, "The " + std::string (product->key) + " path in settings.json ('" + path + "') " + why + "; searching the standard folders instead");
        }

        Candidate best;
        bool haveBest { false };
        for (size_t dirIndex { 0 }; dirIndex < dirs.size (); ++dirIndex)
        {
            if (dirs[dirIndex].empty ())
                continue;
            DIR* dir { ::opendir (dirs[dirIndex].c_str ()) };
            if (dir == nullptr)
                continue;                                   // missing, not a folder or not readable

            size_t entries { 0 };
            size_t candidates { 0 };
            while (const dirent* entry = ::readdir (dir))
            {
                if (++entries > kMaxEntriesPerDir || candidates >= kMaxCandidatesPerDir)
                    break;

                const std::string name { entry->d_name };
                Version nameVersion;
                if (! nameMatches (*product, name, nameVersion))
                    continue;
                ++candidates;

                Candidate candidate;
                candidate.path = join (dirs[dirIndex], name);
                candidate.name = name;
                candidate.dirIndex = dirIndex;
                if (! bundleProblem (candidate.path).empty ())
                    continue;

                const std::string fromPlist { plistVersion (candidate.path) };
                candidate.version = fromPlist.empty () ? nameVersion : parseVersion (fromPlist);
                if (candidate.version.empty ())
                    candidate.version = nameVersion;

                if (! haveBest || isBetter (candidate, best))
                {
                    best = candidate;
                    haveBest = true;
                }
            }
            ::closedir (dir);
        }

        if (haveBest)
            return best.path;

        std::string searched;
        for (const std::string& dir : dirs)
            if (! dir.empty ())
                searched += (searched.empty () ? "" : ", ") + dir;
        note (problem, "No " + std::string (product->display) + " VST3 bundle found in " + (searched.empty () ? "(no folders)" : searched));
        return {};
    }
}
