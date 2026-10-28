#pragma once

#include "realign/Realign.h"

#include <map>
#include <string>
#include <vector>

namespace bridge
{
    struct JobClip
    {
        std::string role;           // "source" (melodyne), "guide" or "dub" (vocalign)
        std::string path;           // absolute path of the audio file
        double startSec { 0.0 };    // region inside the file
        double endSec { 0.0 };
        double startBeats { 0.0 };  // position in the Arrangement
        std::string name;
    };

    struct Job
    {
        int version { 1 };
        std::string id;
        std::string plugin;                     // "melodyne" | "vocalign"
        std::string placement { "takeLane" };   // "takeLane" | "newTrack" | "replace" (used by the device only)
        bool realign { true };
        // window mode, melodyne only: while the editor is open, render the clip again after every edit and publish
        // each state as preview-<n>/result.wav + result.json (hostcore/ApplyJob.h, writePreview); the device plays
        // it as a clip in Live. Absent = false.
        bool preview { false };
        // window mode, melodyne only: the host follows Live's transport and reports what the user does in its window
        // or in the plug-in back (hostcore/SyncFollow.h). Absent = false.
        bool sync { false };
        // where result.wav starts: "dub" (default) = at the rendered clip's region (the dub for vocalign, the
        // source for melodyne); "guide" (vocalign only) = at the guide clip's arrangement position, the aligned dub
        // placed inside a window of digital silence (hostcore/JobLayout.h, GuideWindow)
        std::string output { "dub" };
        double tempo { 120.0 };
        std::vector<JobClip> clips;
        std::string dir;                        // the job folder
        // not from job.json (loadJob never sets it): settings.json's "keepRaw" (loadKeepRaw), set by the host
        // after loading; keeps the raw renders and the realignment's details in the job folder
        bool keepRaw { false };
    };

    // result.json. The device must treat it as authoritative, not BridgeHost's exit code: a crash or hang while
    // tearing down after an "ok" result can still end the process with a non-zero code or a signal.
    struct ResultInfo
    {
        std::string id;             // the job id; filled by readResult, writeResult takes it as an argument
        std::string status;         // "ok" | "cancelled" | "error"
        std::string message;        // for the user (the device's status line)
        std::string diagnostics;    // for logs only; the device ignores it
        std::string resultPath;
        // what result.wav covers (ok results): the region's first frame in the source file, its length in
        // frames (result.wav has exactly this many) and the sample rate; 0 when unknown
        int64_t sourceStartFrame { 0 };
        int64_t frames { 0 };
        int sampleRate { 0 };
        bool realignApplied { false };
        // why realign did or did not move audio (ok results): "not-requested" (realign off, or a vocalign
        // job), "nothing-to-do" (the render already lines up with the source), "no-confident-match" (no part
        // of the render matched a moved copy of the source; left as rendered), "inconsistent-shifts" (only
        // short, isolated matches at a shift, or an unstable choice; no consistent timing shift, left as
        // rendered) or "applied". Empty: the key is not written (error and cancelled results).
        std::string realignReason;
        std::vector<ShiftSegment> shifts;
        // job output "guide" (ok results): placeAt "guide" (result.wav starts at the guide clip's arrangement
        // position), offsetFrames = index in result.wav of the first rendered dub frame that was kept, droppedFrames =
        // how many rendered dub frames lay before the guide's start and were left out. Empty placeAt: none of the
        // three keys is written (result.wav starts at the rendered clip's region, as before). readResult accepts
        // "guide" and "dub".
        std::string placeAt;
        int64_t offsetFrames { 0 };
        int64_t droppedFrames { 0 };
    };

    // true for the four values of ResultInfo::realignReason (not for an empty one)
    bool isRealignReason (const std::string& reason);

    // Reads and validates <jobDir>/job.json, which comes from another process and is not trusted.
    // Unknown keys are ignored and a key set to null counts as absent. A required key that is missing, a key
    // of the wrong type (a boolean is not a number), a number that is not finite or lies outside its range
    // (times 0 to 86400 s, beats 0 to 1e7, tempo above 0 up to 1e4), a string with a NUL character, a file over
    // 16 MB, more than 16 clips or a clip path that does not start with '/' is an error: false is returned,
    // 'error' says which key and 'job' is not touched.
    // A vocalign job must also give song.tempo and every clip's startBeats (guide and dub keep their relative
    // timing only through them); a melodyne job defaults them to 120 and 0.
    // 'output' is optional: "dub" (default) or "guide"; "guide" needs a vocalign job, any other value is an error.
    bool loadJob (const std::string& jobDir, Job& job, std::string& error);

    // Writes <jobDir>/result.json atomically (temp file + rename): its existence means "done".
    // Writes only what readResult accepts. 'message' and 'diagnostics' lose their NULs and are cut to 4096 bytes on a character
    // boundary. An unknown status, an id or resultPath with a NUL or over 64 KB, or a shift that is not
    // finite or out of range makes it return false with 'error' set and nothing written. Text that is not
    // valid UTF-8 is written as Latin-1 instead of failing. Failures to write say why (strerror).
    // With exclusive true an existing result.json is never replaced (the temp file is published with link(),
    // which fails if result.json exists): false is returned and 'error' says that it exists.
    bool writeResult (const std::string& jobDir, const std::string& jobId, const ResultInfo& info, std::string& error,
                      bool exclusive = false);

    // Reads and validates <jobDir>/result.json with the same strictness as loadJob; 'info' is not touched on failure.
    bool readResult (const std::string& jobDir, ResultInfo& info, std::string& error);

    // ~/Library/Application Support/ARABridge/settings.json
    std::string defaultSettingsPath ();

    // {"pluginPaths": {"melodyne": "...", "vocalign": "..."}}; entries that are not non-empty strings are skipped.
    // Other keys are ignored, e.g. "hostPath" (the BridgeHost binary the device launches; read by the device only).
    // A missing file gives an empty map; so does a malformed one, and then *error (if given) says why
    // (it stays empty for a missing file).
    std::map<std::string, std::string> loadPlugInOverrides (const std::string& settingsPath, std::string* error = nullptr);

    // settings.json's "keepRaw" (diagnostics: keep the raw renders and realign-debug.json in the job folder).
    // true only for a JSON true. A missing file, a malformed one (loadPlugInOverrides reports that), a missing key
    // or null give false with no warning; any other value (1, "true", ...) gives false and *warning (if given) says so.
    bool loadKeepRaw (const std::string& settingsPath, std::string* warning = nullptr);

    // ~/Library/Application Support/ARABridge/audio.json: the window's Output menu choice (written by the host
    // only; ARABRIDGE_AUDIO_SETTINGS points the host at another file).
    std::string defaultAudioSettingsPath ();

    // {"outputUID": "<CoreAudio device UID>", "outputName": "<name when saved, for people and the log>"};
    // no outputUID (or {}) means the system default output.
    struct AudioSettings
    {
        std::string outputUID;
        std::string outputName;
    };

    // A missing file gives empty settings (the system default) and true. An unreadable or malformed file,
    // or an outputUID / outputName that is not a string (or has a NUL, or is over 64 KB), gives empty settings,
    // false and 'error' says why. Unknown keys are ignored, null counts as absent.
    bool loadAudioSettings (const std::string& path, AudioSettings& settings, std::string& error);

    // Writes the file atomically (temp file + rename), creating its folder; replaces a malformed file. An empty
    // outputUID writes {} (the system default) and drops outputName. false with 'error' on failure.
    bool saveAudioSettings (const std::string& path, const AudioSettings& settings, std::string& error);
}
