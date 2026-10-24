#pragma once

#include <filesystem>
#include <fstream>
#include <iterator>
#include <string>
#include <unistd.h>

// A fresh, empty temporary directory, removed and recreated if it already exists.
inline std::string makeTempDir (const std::string& tag)
{
    const auto path = std::filesystem::temp_directory_path () / ("bridge_test_" + tag + "_" + std::to_string (getpid ()));
    std::filesystem::remove_all (path);
    std::filesystem::create_directories (path);
    return path.string ();
}

inline void writeTextFile (const std::string& path, const std::string& text)
{
    std::ofstream file (path, std::ios::binary);
    file << text;
}

inline std::string readTextFile (const std::string& path)
{
    std::ifstream file (path, std::ios::binary);
    return std::string { std::istreambuf_iterator<char> (file), std::istreambuf_iterator<char> () };
}
