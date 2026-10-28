#include "check.h"
#include "testutil.h"

#include "jobio/Job.h"

#include <cmath>
#include <filesystem>
#include <cstdlib>
#include <limits>
#include <cerrno>
#include <cstring>
#include <string>
#include <sys/stat.h>
#include <sys/wait.h>

namespace
{
    const char* kMelodyneJob = R"({
      "version": 1, "id": "job-1", "plugin": "melodyne", "placement": "newTrack", "realign": false,
      "song": { "tempo": 100.0 },
      "live": { "trackIndex": 3 },
      "clips": [ { "role": "source", "path": "/tmp/vocal.wav", "startSec": 1.5, "endSec": 4.0,
                   "startBeats": 8.0, "name": "Lead", "sampleRate": 44100, "channels": 2 } ]
    })";

    const char* kVocAlignJob = R"({
      "version": 1, "id": "job-2", "plugin": "vocalign",
      "song": { "tempo": 120.0 },
      "clips": [ { "role": "guide", "path": "/tmp/guide.wav", "startSec": 0, "endSec": 2, "startBeats": 0, "name": "G" },
                 { "role": "dub",   "path": "/tmp/dub.wav",   "startSec": 0, "endSec": 2, "startBeats": 4, "name": "D" } ]
    })";

    // Fills a one-clip melodyne job around the given pieces so each test changes one thing.
    std::string melodyneJob (const std::string& top, const std::string& clip)
    {
        return R"({"version": 1, "id": "x", "plugin": "melodyne", )" + top
               + R"("clips": [{"role": "source", "path": "/a.wav", "startSec": 0, "endSec": 1)" + clip + "}]}";
    }

    bool loads (const std::string& tag, const std::string& json, bridge::Job& job, std::string& error)
    {
        const std::string dir { makeTempDir (tag) };
        writeTextFile (dir + "/job.json", json);
        return bridge::loadJob (dir, job, error);
    }

    // True if the job is rejected with a message containing 'expected'.
    bool rejects (const std::string& tag, const std::string& json, const std::string& expected)
    {
        bridge::Job job;
        std::string error;
        if (loads (tag, json, job, error))
            return false;
        if (error.find (expected) == std::string::npos)
        {
            std::printf ("    error was '%s', expected it to mention '%s'\n", error.c_str (), expected.c_str ());
            return false;
        }
        return true;
    }

    bool resultRejects (const std::string& tag, const std::string& json, const std::string& expected)
    {
        const std::string dir { makeTempDir (tag) };
        writeTextFile (dir + "/result.json", json);
        bridge::ResultInfo info;
        info.message = "untouched";
        std::string error;
        if (bridge::readResult (dir, info, error) || info.message != "untouched")
            return false;
        if (error.find (expected) == std::string::npos)
        {
            std::printf ("    error was '%s', expected it to mention '%s'\n", error.c_str (), expected.c_str ());
            return false;
        }
        return true;
    }

    bridge::ShiftSegment segment (int64_t start, int64_t end, double shift, double correlation)
    {
        bridge::ShiftSegment s;
        s.start = start;
        s.end = end;
        s.shift = shift;
        s.correlation = correlation;
        return s;
    }
}

TEST (job_loads_a_melodyne_job)
{
    bridge::Job job;
    std::string error;
    CHECK (loads ("jm", kMelodyneJob, job, error));
    CHECK (error.empty ());
    CHECK (job.version == 1);
    CHECK (job.id == "job-1");
    CHECK (job.plugin == "melodyne");
    CHECK (job.placement == "newTrack");
    CHECK (! job.realign);
    CHECK_NEAR (job.tempo, 100.0, 1e-9);
    CHECK (job.dir == makeTempDir ("jm"));
    REQUIRE (job.clips.size () == 1);
    CHECK (job.clips[0].role == "source");
    CHECK (job.clips[0].path == "/tmp/vocal.wav");
    CHECK_NEAR (job.clips[0].startSec, 1.5, 1e-9);
    CHECK_NEAR (job.clips[0].endSec, 4.0, 1e-9);
    CHECK_NEAR (job.clips[0].startBeats, 8.0, 1e-9);
    CHECK (job.clips[0].name == "Lead");
}

TEST (job_loads_a_vocalign_job)
{
    bridge::Job job;
    std::string error;
    CHECK (loads ("jv", kVocAlignJob, job, error));
    REQUIRE (job.clips.size () == 2);
    CHECK (job.clips[0].role == "guide");
    CHECK (job.clips[1].role == "dub");
    CHECK (job.clips[1].path == "/tmp/dub.wav");
    CHECK_NEAR (job.clips[1].startBeats, 4.0, 1e-9);
    CHECK (job.clips[1].name == "D");
}

TEST (job_applies_defaults)
{
    bridge::Job job;
    std::string error;
    CHECK (loads ("jd", kVocAlignJob, job, error));
    CHECK (job.placement == "takeLane");
    CHECK (job.realign);
    CHECK (job.clips.size () == 2);

    // Only the required keys: tempo, startSec, startBeats and name fall back to their defaults.
    bridge::Job minimal;
    CHECK (loads ("jmin", melodyneJob ("", ""), minimal, error));
    CHECK_NEAR (minimal.tempo, 120.0, 1e-9);
    REQUIRE (minimal.clips.size () == 1);
    CHECK_NEAR (minimal.clips[0].startSec, 0.0, 1e-9);
    CHECK_NEAR (minimal.clips[0].startBeats, 0.0, 1e-9);
    CHECK (minimal.clips[0].name == "source");
}

TEST (job_tolerates_unknown_keys_and_null_optionals)
{
    bridge::Job job;
    std::string error;
    CHECK (loads ("jn", melodyneJob (R"("future": {"a": [1, 2]}, "placement": null, "realign": null, "song": null, )",
                                     R"(, "name": null, "extra": "x", "startBeats": null)"), job, error));
    CHECK (job.placement == "takeLane");
    CHECK (job.realign);
    CHECK (! job.preview);
    CHECK_NEAR (job.tempo, 120.0, 1e-9);
    REQUIRE (job.clips.size () == 1);
    CHECK (job.clips[0].name == "source");

    // "preview" is optional: absent or null is false
    CHECK (loads ("jp1", melodyneJob (R"("preview": true, )", ""), job, error));
    CHECK (job.preview);
    CHECK (loads ("jp2", melodyneJob (R"("preview": false, )", ""), job, error));
    CHECK (! job.preview);
    CHECK (loads ("jp3", melodyneJob (R"("preview": null, )", ""), job, error));
    CHECK (! job.preview);

    // The song object without a tempo keeps the default.
    CHECK (loads ("jn2", melodyneJob (R"("song": {}, )", ""), job, error));
    CHECK_NEAR (job.tempo, 120.0, 1e-9);
}

TEST (job_rejects_bad_input)
{
    bridge::Job job;
    std::string error;

    CHECK (! loads ("b1", "not json", job, error));
    CHECK (! loads ("b2", R"({"version": 2, "id": "x", "plugin": "melodyne", "clips": []})", job, error));
    CHECK (! loads ("b3", R"({"version": 1, "id": "x", "plugin": "autotune", "clips": [{"role":"source","path":"/a.wav","startSec":0,"endSec":1}]})", job, error));
    CHECK (error.find ("autotune") != std::string::npos);
    CHECK (! loads ("b4", R"({"version": 1, "id": "x", "plugin": "melodyne", "clips": []})", job, error));
    CHECK (! loads ("b5", R"({"version": 1, "id": "x", "plugin": "melodyne", "clips": [{"role":"source","path":"/a.wav","startSec":2,"endSec":1}]})", job, error));
    CHECK (! loads ("b6", R"({"version": 1, "id": "x", "plugin": "vocalign", "clips": [{"role":"guide","path":"/a.wav","startSec":0,"endSec":1}]})", job, error));
    CHECK (! loads ("b7", R"({"version": 1, "id": "x", "plugin": "melodyne", "placement": "sideways", "clips": [{"role":"source","path":"/a.wav","startSec":0,"endSec":1}]})", job, error));

    bridge::Job missing;
    CHECK (! bridge::loadJob (makeTempDir ("nofile"), missing, error));
    CHECK (error.find ("job.json") != std::string::npos);
}

TEST (job_rejects_malformed_json_documents)
{
    CHECK (rejects ("m1", "", "job.json"));
    CHECK (rejects ("m2", "   ", "job.json"));
    CHECK (rejects ("m3", "[1, 2]", "not a valid JSON object"));
    CHECK (rejects ("m4", "\"melodyne\"", "not a valid JSON object"));
    CHECK (rejects ("m5", "42", "not a valid JSON object"));
    CHECK (rejects ("m6", "null", "not a valid JSON object"));
    CHECK (rejects ("m7", R"({"version": 1, "id": "x")", "not a valid JSON object"));            // truncated
    CHECK (rejects ("m8", R"({"version": NaN, "id": "x"})", "not a valid JSON object"));
    CHECK (rejects ("m9", R"({"version": 1,, "id": "x"})", "not a valid JSON object"));
    CHECK (rejects ("m10", std::string ("{\"version\": 1, \"id\": \"\xff\xfe\"}"), "not a valid JSON object"));    // invalid UTF-8

    // A directory called job.json and an oversized file are refused without reading them.
    const std::string dir { makeTempDir ("m11") };
    std::filesystem::create_directories (dir + "/job.json");
    bridge::Job job;
    std::string error;
    CHECK (! bridge::loadJob (dir, job, error));

    const std::string big { makeTempDir ("m12") };
    writeTextFile (big + "/job.json", std::string (17 * 1024 * 1024, ' '));
    CHECK (! bridge::loadJob (big, job, error));
    CHECK (error.find ("too large") != std::string::npos);
}

TEST (job_rejects_missing_fields)
{
    CHECK (rejects ("f1", R"({"id": "x", "plugin": "melodyne", "clips": [{"role":"source","path":"/a.wav","endSec":1}]})", "'version'"));
    CHECK (rejects ("f2", R"({"version": 1, "plugin": "melodyne", "clips": [{"role":"source","path":"/a.wav","endSec":1}]})", "'id'"));
    CHECK (rejects ("f3", R"({"version": 1, "id": "x", "clips": [{"role":"source","path":"/a.wav","endSec":1}]})", "'plugin'"));
    CHECK (rejects ("f4", R"({"version": 1, "id": "x", "plugin": "melodyne"})", "'clips'"));
    CHECK (rejects ("f5", R"({"version": 1, "id": "x", "plugin": "melodyne", "clips": [{"path":"/a.wav","endSec":1}]})", "'clips[0].role'"));
    CHECK (rejects ("f6", R"({"version": 1, "id": "x", "plugin": "melodyne", "clips": [{"role":"source","endSec":1}]})", "'clips[0].path'"));
    CHECK (rejects ("f7", R"({"version": 1, "id": "x", "plugin": "melodyne", "clips": [{"role":"source","path":"/a.wav"}]})", "'clips[0].endSec'"));
    CHECK (rejects ("f8", R"({})", "'version'"));
    CHECK (rejects ("f9", R"({"version": 1, "id": "", "plugin": "melodyne", "clips": []})", "no id"));
    CHECK (rejects ("f10", melodyneJob ("", "").replace (melodyneJob ("", "").find ("/a.wav"), 6, ""), "'clips[0].path' is empty"));
}

TEST (job_rejects_relative_clip_paths)
{
    const std::string job { melodyneJob ("", "") };
    const size_t at { job.find ("/a.wav") };
    for (const char* path : { "a.wav", "./a.wav", "../x/a.wav", "~/a.wav", " /a.wav" })
        CHECK (rejects ("rel", std::string { job }.replace (at, 6, path), "'clips[0].path' must be an absolute path"));
    // the second clip of a vocalign job is checked too
    std::string vocalign { kVocAlignJob };
    vocalign.replace (vocalign.find ("/tmp/dub.wav"), 12, "dub.wav");
    CHECK (rejects ("rel2", vocalign, "'clips[1].path' must be an absolute path"));
    bridge::Job loaded;
    std::string error;
    CHECK (loads ("abs", job, loaded, error));
}

TEST (job_rejects_wrong_types)
{
    const std::string okClip { R"("clips": [{"role":"source","path":"/a.wav","endSec":1}]})" };
    CHECK (rejects ("t1", R"({"version": "1", "id": "x", "plugin": "melodyne", )" + okClip, "'version' must be a number"));
    CHECK (rejects ("t2", R"({"version": true, "id": "x", "plugin": "melodyne", )" + okClip, "'version' must be a number"));
    CHECK (rejects ("t3", R"({"version": 1, "id": 7, "plugin": "melodyne", )" + okClip, "'id' must be a string"));
    CHECK (rejects ("t4", R"({"version": 1, "id": "x", "plugin": ["melodyne"], )" + okClip, "'plugin' must be a string"));
    CHECK (rejects ("t5", melodyneJob (R"("placement": 3, )", ""), "'placement' must be a string"));
    CHECK (rejects ("t6", melodyneJob (R"("realign": 1, )", ""), "'realign' must be true or false"));
    CHECK (rejects ("t7", melodyneJob (R"("realign": "yes", )", ""), "'realign' must be true or false"));
    CHECK (rejects ("t7b", melodyneJob (R"("preview": 1, )", ""), "'preview' must be true or false"));
    CHECK (rejects ("t8", melodyneJob (R"("song": [120], )", ""), "'song' must be an object"));
    CHECK (rejects ("t9", melodyneJob (R"("song": {"tempo": "fast"}, )", ""), "'song.tempo' must be a number"));
    CHECK (rejects ("t10", R"({"version": 1, "id": "x", "plugin": "melodyne", "clips": {"role": "source"}})", "'clips' must be an array"));
    CHECK (rejects ("t11", R"({"version": 1, "id": "x", "plugin": "melodyne", "clips": ["a.wav"]})", "'clips[0]' must be an object"));
    CHECK (rejects ("t12", R"({"version": 1, "id": "x", "plugin": "melodyne", "clips": [null]})", "'clips[0]' must be an object"));
    CHECK (rejects ("t13", melodyneJob ("", R"(, "name": 5)"), "'clips[0].name' must be a string"));
    CHECK (rejects ("t14", R"({"version": 1, "id": "x", "plugin": "melodyne", "clips": [{"role":"source","path":"/a.wav","endSec":"1"}]})",
                    "'clips[0].endSec' must be a number"));
    CHECK (rejects ("t15", R"({"version": 1, "id": "x", "plugin": "melodyne", "clips": [{"role":"source","path":"/a.wav","endSec":true}]})",
                    "'clips[0].endSec' must be a number"));
    CHECK (rejects ("t16", R"({"version": 1, "id": "x", "plugin": "melodyne", "clips": [{"role":"source","path":"/a.wav","startSec":[0],"endSec":1}]})",
                    "'clips[0].startSec' must be a number"));
    CHECK (rejects ("t17", melodyneJob ("", R"(, "startBeats": {})"), "'clips[0].startBeats' must be a number"));
    CHECK (rejects ("t18", R"({"version": 1, "id": "x", "plugin": "melodyne", "clips": [{"role":5,"path":"/a.wav","endSec":1}]})",
                    "'clips[0].role' must be a string"));
    CHECK (rejects ("t19", R"({"version": 1, "id": "x", "plugin": "melodyne", "clips": [{"role":"source","path":["/a.wav"],"endSec":1}]})",
                    "'clips[0].path' must be a string"));
}

TEST (job_rejects_out_of_range_numbers)
{
    CHECK (rejects ("r1", melodyneJob (R"("song": {"tempo": 0}, )", ""), "'song.tempo' must be positive"));
    CHECK (rejects ("r2", melodyneJob (R"("song": {"tempo": -90}, )", ""), "'song.tempo' is out of range"));
    CHECK (rejects ("r3", melodyneJob (R"("song": {"tempo": 1e9}, )", ""), "'song.tempo' is out of range"));
    CHECK (rejects ("r4", melodyneJob (R"("song": {"tempo": 1e999}, )", ""), "job.json"));          // the parser refuses a number beyond double
    CHECK (rejects ("r5", R"({"version": 1, "id": "x", "plugin": "melodyne", "clips": [{"role":"source","path":"/a.wav","startSec":-1,"endSec":1}]})",
                    "'clips[0].startSec' is out of range"));
    CHECK (rejects ("r6", R"({"version": 1, "id": "x", "plugin": "melodyne", "clips": [{"role":"source","path":"/a.wav","endSec":1e9}]})",
                    "'clips[0].endSec' is out of range"));
    CHECK (rejects ("r7", R"({"version": 1, "id": "x", "plugin": "melodyne", "clips": [{"role":"source","path":"/a.wav","endSec":1e999}]})",
                    "job.json"));
    CHECK (rejects ("r8", R"({"version": 1, "id": "x", "plugin": "melodyne", "clips": [{"role":"source","path":"/a.wav","startSec":1,"endSec":1}]})",
                    "invalid time range"));
    CHECK (rejects ("r9", melodyneJob ("", R"(, "startBeats": -4)"), "'clips[0].startBeats' is out of range"));
    CHECK (rejects ("r10", melodyneJob ("", R"(, "startBeats": 1e30)"), "'clips[0].startBeats' is out of range"));
    CHECK (rejects ("r11", R"({"version": 1e30, "id": "x", "plugin": "melodyne", "clips": []})", "'version' is out of range"));
    CHECK (rejects ("r12", R"({"version": 1.5, "id": "x", "plugin": "melodyne", "clips": []})", "unsupported job version 1.5"));
    CHECK (rejects ("r13", R"({"version": 0, "id": "x", "plugin": "melodyne", "clips": []})", "unsupported job version"));

    // Many clips are refused before any of them is examined.
    std::string clips;
    for (int i { 0 }; i < 1000; ++i)
        clips += std::string (i ? "," : "") + R"({"role":"dub","path":"/a.wav","endSec":1,"startBeats":0})";
    CHECK (rejects ("r14", R"({"version": 1, "id": "x", "plugin": "vocalign", "song": {"tempo": 120}, "clips": [)" + clips + "]}", "too many clips"));

    // Long strings are refused too.
    CHECK (rejects ("r15", R"({"version": 1, "id": ")" + std::string (70000, 'a') + R"(", "plugin": "melodyne", "clips": []})", "'id' is too long"));
}

TEST (job_rejects_bad_strings)
{
    CHECK (rejects ("s1", melodyneJob ("", "").replace (melodyneJob ("", "").find ("/a.wav"), 6, R"(/a\u0000.wav)"), "NUL"));
    CHECK (rejects ("s2", R"({"version": 1, "id": "x\u0000y", "plugin": "melodyne", "clips": []})", "NUL"));
    CHECK (rejects ("s3", R"({"version": 1, "id": "\ud800", "plugin": "melodyne", "clips": []})", "job.json"));    // lone surrogate: refused by the parser

    // Unicode that is valid is kept.
    bridge::Job job;
    std::string error;
    CHECK (loads ("s4", melodyneJob ("", R"(, "name": "Gesang äö 🎤")"), job, error));
    REQUIRE (job.clips.size () == 1);
    CHECK (job.clips[0].name == "Gesang \xc3\xa4\xc3\xb6 \xf0\x9f\x8e\xa4");
}

TEST (job_rejects_wrong_roles_for_the_plugin)
{
    CHECK (rejects ("w1", R"({"version": 1, "id": "x", "plugin": "melodyne", "clips": [{"role":"guide","path":"/a.wav","endSec":1}]})", "melodyne job needs"));
    CHECK (rejects ("w2", R"({"version": 1, "id": "x", "plugin": "melodyne", "clips": [{"role":"source","path":"/a.wav","endSec":1},
                                                                                   {"role":"source","path":"/b.wav","endSec":1}]})", "melodyne job needs"));
    CHECK (rejects ("w3", R"({"version": 1, "id": "x", "plugin": "vocalign", "song": {"tempo": 120}, "clips": [{"role":"dub","path":"/a.wav","endSec":1,"startBeats":0},
                                                                                   {"role":"dub","path":"/b.wav","endSec":1,"startBeats":0}]})", "vocalign job needs"));
    CHECK (rejects ("w4", R"({"version": 1, "id": "x", "plugin": "vocalign", "song": {"tempo": 120}, "clips": [{"role":"guide","path":"/a.wav","endSec":1,"startBeats":0},
                                                                                   {"role":"dub","path":"/b.wav","endSec":1,"startBeats":0},
                                                                                   {"role":"dub","path":"/c.wav","endSec":1,"startBeats":0}]})", "vocalign job needs"));
    CHECK (rejects ("w5", R"({"version": 1, "id": "x", "plugin": "vocalign", "song": {"tempo": 120}, "clips": [{"role":"source","path":"/a.wav","endSec":1,"startBeats":0}]})", "vocalign job needs"));
    CHECK (rejects ("w6", R"({"version": 1, "id": "x", "plugin": "melodyne", "clips": [{"role":"","path":"/a.wav","endSec":1}]})", "melodyne job needs"));
}

TEST (job_load_failure_leaves_the_job_untouched)
{
    bridge::Job job;
    std::string error;
    CHECK (loads ("u1", kMelodyneJob, job, error));
    const bridge::Job before { job };

    CHECK (! loads ("u2", melodyneJob ("", R"(, "startBeats": "x")"), job, error));
    CHECK (job.id == before.id);
    CHECK (job.plugin == before.plugin);
    CHECK (job.clips.size () == before.clips.size ());
    CHECK (job.dir == before.dir);

    // A later success clears the error and replaces the old clips.
    CHECK (loads ("u3", kVocAlignJob, job, error));
    CHECK (error.empty ());
    CHECK (job.clips.size () == 2);
    CHECK (job.id == "job-2");
}

TEST (result_roundtrip_and_atomic_write)
{
    const std::string dir { makeTempDir ("res") };
    bridge::ResultInfo info;
    info.status = "ok";
    info.message = "moved 1 stretch(es)";
    info.resultPath = dir + "/result.wav";
    info.realignApplied = true;
    info.shifts.push_back (segment (100, 900, 30.75, 0.9999));

    std::string error;
    CHECK (bridge::writeResult (dir, "job-9", info, error));
    CHECK (! std::filesystem::exists (dir + "/result.json.tmp"));
    CHECK (std::filesystem::exists (dir + "/result.json"));

    bridge::ResultInfo back;
    CHECK (bridge::readResult (dir, back, error));
    CHECK (back.id == "job-9");
    CHECK (back.status == "ok");
    CHECK (back.message == info.message);
    CHECK (back.resultPath == info.resultPath);
    CHECK (back.realignApplied);
    REQUIRE (back.shifts.size () == 1);
    CHECK (back.shifts[0].start == 100);
    CHECK (back.shifts[0].end == 900);
    CHECK_NEAR (back.shifts[0].shift, 30.75, 1e-12);
    CHECK_NEAR (back.shifts[0].correlation, 0.9999, 1e-12);
}

TEST (result_roundtrips_every_field_and_status)
{
    const std::string dir { makeTempDir ("res2") };
    std::string error;

    bridge::ResultInfo info;
    info.status = "ok";
    info.message = "quote \" backslash \\ slash / tab \t newline \n umlaut \xc3\xa4 mic \xf0\x9f\x8e\xa4";
    info.resultPath = "/Users/x/My Songs/take \"1\"/result.wav";
    info.diagnostics = "renders differ in 1 stretch \xc3\xa4";
    info.sourceStartFrame = 123456789012LL;
    info.frames = 9007199254740992LL;
    info.sampleRate = 768000;
    info.realignApplied = true;
    info.shifts.push_back (segment (0, 44100, 0.0, 1.0));
    info.shifts.push_back (segment (44100, 123456789012LL, -118.66012345678, 0.98));      // negative, fractional, beyond 32 bits
    info.shifts.push_back (segment (5, 6, 1e-9, -0.5));
    CHECK (bridge::writeResult (dir, "id with spaces/and-slash", info, error));

    bridge::ResultInfo back;
    CHECK (bridge::readResult (dir, back, error));
    CHECK (back.id == "id with spaces/and-slash");
    CHECK (back.message == info.message);
    CHECK (back.resultPath == info.resultPath);
    CHECK (back.diagnostics == info.diagnostics);
    CHECK (back.sourceStartFrame == info.sourceStartFrame);
    CHECK (back.frames == info.frames);
    CHECK (back.sampleRate == 768000);
    CHECK (back.realignApplied);
    REQUIRE (back.shifts.size () == 3);
    for (size_t i { 0 }; i < 3; ++i)
    {
        CHECK (back.shifts[i].start == info.shifts[i].start);
        CHECK (back.shifts[i].end == info.shifts[i].end);
        CHECK_NEAR (back.shifts[i].shift, info.shifts[i].shift, 1e-12);
        CHECK_NEAR (back.shifts[i].correlation, info.shifts[i].correlation, 1e-12);
    }

    // The other statuses, without a result file or shifts, and with realign not applied.
    for (const char* status : { "cancelled", "error" })
    {
        bridge::ResultInfo bare;
        bare.status = status;
        bare.message = std::string { "no audio: " } + status;
        CHECK (bridge::writeResult (dir, "job-b", bare, error));

        bridge::ResultInfo read;
        read.realignApplied = true;
        CHECK (bridge::readResult (dir, read, error));
        CHECK (read.id == "job-b");
        CHECK (read.status == status);
        CHECK (read.message == bare.message);
        CHECK (read.resultPath.empty ());
        CHECK (read.diagnostics.empty ());
        CHECK (read.frames == 0 && read.sourceStartFrame == 0 && read.sampleRate == 0);
        CHECK (! read.realignApplied);
        CHECK (read.shifts.empty ());
    }
}

TEST (result_write_replaces_an_existing_file_and_leaves_no_temp)
{
    const std::string dir { makeTempDir ("res3") };
    std::string error;

    writeTextFile (dir + "/result.json", "stale");
    writeTextFile (dir + "/result.json.tmp", "stale temp from a crashed run");

    bridge::ResultInfo info;
    info.status = "error";
    info.message = "second";
    CHECK (bridge::writeResult (dir, "j", info, error));
    CHECK (! std::filesystem::exists (dir + "/result.json.tmp"));

    bridge::ResultInfo back;
    CHECK (bridge::readResult (dir, back, error));
    CHECK (back.message == "second");

    info.message = "third";
    CHECK (bridge::writeResult (dir, "j", info, error));
    CHECK (bridge::readResult (dir, back, error));
    CHECK (back.message == "third");

    int files { 0 };
    for (const auto& entry : std::filesystem::directory_iterator (dir))
    {
        (void) entry;
        ++files;
    }
    CHECK (files == 1);
}

TEST (result_write_failures_write_nothing)
{
    const std::string dir { makeTempDir ("res4") };
    std::string error;
    bridge::ResultInfo info;
    info.status = "ok";

    // Unknown status.
    bridge::ResultInfo badStatus { info };
    badStatus.status = "done";
    CHECK (! bridge::writeResult (dir, "j", badStatus, error));
    CHECK (error.find ("done") != std::string::npos);
    CHECK (! std::filesystem::exists (dir + "/result.json"));

    // Non-finite numbers would make Foundation raise an exception if they reached the encoder.
    for (double bad : { std::numeric_limits<double>::quiet_NaN (), std::numeric_limits<double>::infinity () })
    {
        bridge::ResultInfo withBadShift { info };
        withBadShift.shifts.push_back (segment (0, 10, bad, 1.0));
        CHECK (! bridge::writeResult (dir, "j", withBadShift, error));
        bridge::ResultInfo withBadCorrelation { info };
        withBadCorrelation.shifts.push_back (segment (0, 10, 1.0, bad));
        CHECK (! bridge::writeResult (dir, "j", withBadCorrelation, error));
    }
    CHECK (! std::filesystem::exists (dir + "/result.json"));
    CHECK (! std::filesystem::exists (dir + "/result.json.tmp"));

    // A folder that does not exist.
    CHECK (! bridge::writeResult (dir + "/missing", "j", info, error));
    CHECK (error.find ("result.json") != std::string::npos);
    CHECK (! std::filesystem::exists (dir + "/missing"));
}

TEST (result_write_survives_invalid_utf8_text)
{
    const std::string dir { makeTempDir ("res5") };
    std::string error;
    bridge::ResultInfo info;
    info.status = "error";
    info.message = "plug-in said \xff\xfe garbage";            // not UTF-8
    CHECK (bridge::writeResult (dir, "j", info, error));

    bridge::ResultInfo back;
    CHECK (bridge::readResult (dir, back, error));
    CHECK (back.message.find ("plug-in said") == 0);
}

TEST (result_write_only_writes_what_read_accepts)
{
    const std::string dir { makeTempDir ("res6") };
    std::string error;
    bridge::ResultInfo back;

    // A NUL in the message is dropped.
    bridge::ResultInfo info;
    info.status = "error";
    info.message = std::string { "ab\0cd", 5 };
    CHECK (bridge::writeResult (dir, "j", info, error));
    CHECK (bridge::readResult (dir, back, error));
    CHECK (back.message == "abcd");

    // A long message is cut to 4096 bytes on a character boundary: 2-byte and 4-byte characters at the cut.
    for (const std::string unit : { std::string { "x" }, std::string { "\xc3\xa4" }, std::string { "\xf0\x9f\x8e\xa4" } })
    {
        info.message = "a";                                   // shifts the unit so that the cut can fall inside it
        while (info.message.size () < 20000)
            info.message += unit;
        CHECK (bridge::writeResult (dir, "j", info, error));
        CHECK (bridge::readResult (dir, back, error));
        CHECK (back.message.size () <= 4096);
        CHECK (back.message.size () > 4096 - 4);
        CHECK (back.message.compare (0, 1, "a") == 0);
        // Everything kept is whole characters: the tail is a multiple of the unit.
        CHECK ((back.message.size () - 1) % unit.size () == 0);
    }

    // A message that is not UTF-8 and would double in size is still cut to the limit.
    info.message = std::string (6000, '\xe9');
    CHECK (bridge::writeResult (dir, "j", info, error));
    CHECK (bridge::readResult (dir, back, error));
    CHECK (back.message.size () <= 4096);

    // A resultPath or id with a NUL, or one longer than the read limit, is refused and nothing is written.
    std::filesystem::remove (dir + "/result.json");
    info.message = "m";
    info.resultPath = std::string { "/a\0b.wav", 8 };
    CHECK (! bridge::writeResult (dir, "j", info, error));
    CHECK (error.find ("'resultPath'") != std::string::npos && error.find ("NUL") != std::string::npos);
    info.resultPath = "/" + std::string (70000, 'a');
    CHECK (! bridge::writeResult (dir, "j", info, error));
    CHECK (error.find ("'resultPath' is too long") != std::string::npos);
    info.resultPath = std::string (40000, '\xe9');           // under the limit as bytes, over it as UTF-8
    CHECK (! bridge::writeResult (dir, "j", info, error));
    info.resultPath = "/a.wav";
    CHECK (! bridge::writeResult (dir, std::string { "j\0k", 3 }, info, error));
    CHECK (error.find ("'id'") != std::string::npos);
    CHECK (! bridge::writeResult (dir, std::string (70000, 'j'), info, error));
    CHECK (! std::filesystem::exists (dir + "/result.json"));
    CHECK (! std::filesystem::exists (dir + "/result.json.tmp"));

    // The longest accepted path round-trips.
    info.resultPath = "/" + std::string (65535 - 1, 'a');
    CHECK (bridge::writeResult (dir, "j", info, error));
    CHECK (bridge::readResult (dir, back, error));
    CHECK (back.resultPath == info.resultPath);

    // Segment numbers that readResult would refuse are refused on writing.
    info.resultPath = "/a.wav";
    info.shifts.push_back (segment (0, int64_t { 1 } << 60, 1.0, 1.0));
    CHECK (! bridge::writeResult (dir, "j", info, error));
    info.shifts.clear ();
    info.shifts.push_back (segment (0, 10, 1e13, 1.0));
    CHECK (! bridge::writeResult (dir, "j", info, error));
}

TEST (result_write_failure_messages_give_the_reason)
{
    std::string error;
    bridge::ResultInfo info;
    info.status = "ok";

    // A missing folder: the OS reason is part of the message.
    CHECK (! bridge::writeResult (makeTempDir ("res7") + "/missing", "j", info, error));
    CHECK (error.find ("cannot write") != std::string::npos);
    CHECK (error.find (std::strerror (ENOENT)) != std::string::npos);

    // A folder we may not write to (root ignores permissions, so skip there).
    if (geteuid () != 0)
    {
        const std::string dir { makeTempDir ("res8") };
        std::filesystem::permissions (dir, std::filesystem::perms::owner_read | std::filesystem::perms::owner_exec);
        const bool written { bridge::writeResult (dir, "j", info, error) };
        std::filesystem::permissions (dir, std::filesystem::perms::owner_all);
        CHECK (! written);
        CHECK (error.find (std::strerror (EACCES)) != std::string::npos);
        CHECK (! std::filesystem::exists (dir + "/result.json"));
        CHECK (! std::filesystem::exists (dir + "/result.json.tmp"));
    }
}

TEST (result_write_removes_the_temp_file_when_the_rename_fails)
{
    const std::string dir { makeTempDir ("res9") };
    std::string error;
    bridge::ResultInfo info;
    info.status = "ok";

    // A folder in the place of result.json makes the rename fail after the temp file is complete.
    std::filesystem::create_directories (dir + "/result.json/inner");
    CHECK (! bridge::writeResult (dir, "j", info, error));
    CHECK (error.find ("cannot rename") != std::string::npos);
    CHECK (error.find (":") != std::string::npos);
    CHECK (! std::filesystem::exists (dir + "/result.json.tmp"));
    CHECK (std::filesystem::is_directory (dir + "/result.json"));
}

TEST (job_that_is_not_a_regular_file_is_rejected_without_opening_it)
{
    // Opening a FIFO for reading blocks until a writer appears, so the loaders must refuse it before open().
    // The check runs in a child process with an alarm: a loader that opened the FIFO would be killed, not hang the suite.
    const std::string dir { makeTempDir ("fifo") };
    REQUIRE (mkfifo ((dir + "/job.json").c_str (), 0600) == 0);
    REQUIRE (mkfifo ((dir + "/result.json").c_str (), 0600) == 0);
    REQUIRE (mkfifo ((dir + "/settings.json").c_str (), 0600) == 0);

    const pid_t child { fork () };
    REQUIRE (child >= 0);
    if (child == 0)
    {
        alarm (10);
        bridge::Job job;
        bridge::ResultInfo info;
        std::string jobError, resultError, settingsError;
        const bool refused { ! bridge::loadJob (dir, job, jobError) && ! bridge::readResult (dir, info, resultError) };
        const bool settings { bridge::loadPlugInOverrides (dir + "/settings.json", &settingsError).empty () };
        _exit (refused && settings && jobError.find ("cannot read") != std::string::npos && ! settingsError.empty () ? 0 : 1);
    }

    int status { 0 };
    CHECK (waitpid (child, &status, 0) == child);
    CHECK (WIFEXITED (status) && WEXITSTATUS (status) == 0);
    if (WIFSIGNALED (status))
        std::printf ("    loader was killed by signal %d (it blocked on the FIFO)\n", WTERMSIG (status));
}

TEST (vocalign_job_needs_beats_and_tempo)
{
    const std::string clipA { R"({"role":"guide","path":"/g.wav","endSec":2,"startBeats":0})" };
    const std::string clipB { R"({"role":"dub","path":"/d.wav","endSec":2,"startBeats":4})" };
    const std::string head { R"({"version": 1, "id": "x", "plugin": "vocalign", )" };

    bridge::Job job;
    std::string error;
    CHECK (loads ("va0", head + R"("song": {"tempo": 120}, "clips": [)" + clipA + "," + clipB + "]}", job, error));

    // No song, no tempo or a null tempo.
    CHECK (rejects ("va1", head + R"("clips": [)" + clipA + "," + clipB + "]}", "missing 'song.tempo'"));
    CHECK (rejects ("va2", head + R"("song": null, "clips": [)" + clipA + "," + clipB + "]}", "missing 'song.tempo'"));
    CHECK (rejects ("va3", head + R"("song": {}, "clips": [)" + clipA + "," + clipB + "]}", "missing 'song.tempo'"));
    CHECK (rejects ("va4", head + R"("song": {"tempo": null}, "clips": [)" + clipA + "," + clipB + "]}", "missing 'song.tempo'"));

    // startBeats missing or null on either clip.
    const std::string noBeats { R"({"role":"dub","path":"/d.wav","endSec":2})" };
    const std::string nullBeats { R"({"role":"dub","path":"/d.wav","endSec":2,"startBeats":null})" };
    CHECK (rejects ("va5", head + R"("song": {"tempo": 120}, "clips": [)" + clipA + "," + noBeats + "]}", "missing 'clips[1].startBeats'"));
    CHECK (rejects ("va6", head + R"("song": {"tempo": 120}, "clips": [)" + clipA + "," + nullBeats + "]}", "missing 'clips[1].startBeats'"));
    CHECK (rejects ("va7", head + R"("song": {"tempo": 120}, "clips": [)" + noBeats + "," + clipB + "]}", "missing 'clips[0].startBeats'"));

    // Melodyne keeps its defaults (tested in job_applies_defaults).
    CHECK (loads ("va8", melodyneJob ("", ""), job, error));
}

TEST (job_error_messages_print_the_value)
{
    CHECK (rejects ("e1", R"({"version": 2, "id": "x", "plugin": "melodyne", "clips": []})", "unsupported job version 2"));
    CHECK (rejects ("e2", R"({"version": 1.5, "id": "x", "plugin": "melodyne", "clips": []})", "unsupported job version 1.5"));
    CHECK (rejects ("e3", R"({"version": -3, "id": "x", "plugin": "melodyne", "clips": []})", "unsupported job version -3"));
}

TEST (result_read_rejects_bad_files)
{
    CHECK (resultRejects ("rr1", "", "result.json"));
    CHECK (resultRejects ("rr2", "not json", "not a valid JSON object"));
    CHECK (resultRejects ("rr3", "[]", "not a valid JSON object"));
    CHECK (resultRejects ("rr4", R"({"id": "x"})", "missing 'status'"));
    CHECK (resultRejects ("rr5", R"({"status": "finished"})", "finished"));
    CHECK (resultRejects ("rr6", R"({"status": 1})", "'status' must be a string"));
    CHECK (resultRejects ("rr7", R"({"status": "ok", "message": 5})", "'message' must be a string"));
    CHECK (resultRejects ("rr8", R"({"status": "ok", "resultPath": []})", "'resultPath' must be a string"));
    CHECK (resultRejects ("rr9", R"({"status": "ok", "id": {}})", "'id' must be a string"));
    CHECK (resultRejects ("rr10", R"({"status": "ok", "realign": 1})", "'realign' must be an object"));
    CHECK (resultRejects ("rr11", R"({"status": "ok", "realign": {"applied": "yes"}})", "'realign.applied' must be true or false"));
    CHECK (resultRejects ("rr12", R"({"status": "ok", "realign": {"applied": 1}})", "'realign.applied' must be true or false"));
    CHECK (resultRejects ("rr13", R"({"status": "ok", "realign": {"shifts": {}}})", "'realign.shifts' must be an array"));
    CHECK (resultRejects ("rr14", R"({"status": "ok", "realign": {"shifts": [3]}})", "'realign.shifts[0]' must be an object"));
    CHECK (resultRejects ("rr15", R"({"status": "ok", "realign": {"shifts": [{"start": 0, "end": 1}]}})", "'realign.shifts[0].shift'"));
    CHECK (resultRejects ("rr16", R"({"status": "ok", "realign": {"shifts": [{"start": 0.5, "end": 1, "shift": 1}]}})", "must be a whole number"));
    CHECK (resultRejects ("rr17", R"({"status": "ok", "realign": {"shifts": [{"start": 0, "end": 1e30, "shift": 1}]}})", "'realign.shifts[0].end' is out of range"));
    CHECK (resultRejects ("rr18", R"({"status": "ok", "realign": {"shifts": [{"start": 0, "end": 1, "shift": "1"}]}})", "'realign.shifts[0].shift' must be a number"));
    CHECK (resultRejects ("rr19", R"({"status": "ok", "realign": {"shifts": [{"start": 0, "end": 1, "shift": 1e999}]}})", "result.json"));
    CHECK (resultRejects ("rr20", R"({"status": "ok", "realign": {"shifts": [{"start": 0, "end": 1, "shift": 1, "correlation": true}]}})",
                          "'realign.shifts[0].correlation' must be a number"));
    CHECK (resultRejects ("rr22", R"({"status": "ok", "realign": {"reason": "maybe"}})", "unknown 'realign.reason' 'maybe'"));
    CHECK (resultRejects ("rr23", R"({"status": "ok", "realign": {"reason": 3}})", "'realign.reason' must be a string"));
    // The valid shifts before a bad one are not returned.
    CHECK (resultRejects ("rr21", R"({"status": "ok", "realign": {"shifts": [{"start": 0, "end": 1, "shift": 1}, 7]}})", "'realign.shifts[1]'"));

    bridge::ResultInfo info;
    std::string error;
    CHECK (! bridge::readResult (makeTempDir ("rrnone"), info, error));
}

TEST (result_read_accepts_minimal_files)
{
    const std::string dir { makeTempDir ("rm") };
    writeTextFile (dir + "/result.json", R"({"status": "cancelled", "future": [1]})");
    bridge::ResultInfo info;
    std::string error;
    CHECK (bridge::readResult (dir, info, error));
    CHECK (info.status == "cancelled");
    CHECK (info.id.empty ());
    CHECK (! info.realignApplied);
    CHECK (info.shifts.empty ());
}

TEST (settings_overrides_are_read)
{
    const std::string dir { makeTempDir ("set") };
    writeTextFile (dir + "/settings.json", R"({"pluginPaths": {"melodyne": "/custom/Melodyne.vst3"}})");

    const auto overrides = bridge::loadPlugInOverrides (dir + "/settings.json");
    CHECK (overrides.size () == 1);
    CHECK (overrides.count ("melodyne") == 1 && overrides.at ("melodyne") == "/custom/Melodyne.vst3");

    CHECK (bridge::loadPlugInOverrides (dir + "/missing.json").empty ());
}

TEST (settings_defaults_when_missing_or_unusable)
{
    const std::string dir { makeTempDir ("set2") };
    std::string error { "stale" };

    // A missing file is normal: empty map, no error.
    CHECK (bridge::loadPlugInOverrides (dir + "/missing.json", &error).empty ());
    CHECK (error.empty ());

    // Unusable files give an empty map and say why.
    writeTextFile (dir + "/bad.json", "not json");
    CHECK (bridge::loadPlugInOverrides (dir + "/bad.json", &error).empty ());
    CHECK (! error.empty ());

    writeTextFile (dir + "/array.json", "[]");
    CHECK (bridge::loadPlugInOverrides (dir + "/array.json", &error).empty ());
    CHECK (! error.empty ());

    writeTextFile (dir + "/shape.json", R"({"pluginPaths": ["/x.vst3"]})");
    CHECK (bridge::loadPlugInOverrides (dir + "/shape.json", &error).empty ());
    CHECK (error.find ("pluginPaths") != std::string::npos);

    // No pluginPaths key, or a null one: nothing to override.
    writeTextFile (dir + "/none.json", R"({"other": 1})");
    CHECK (bridge::loadPlugInOverrides (dir + "/none.json", &error).empty ());
    CHECK (error.empty ());
    writeTextFile (dir + "/null.json", R"({"pluginPaths": null})");
    CHECK (bridge::loadPlugInOverrides (dir + "/null.json", &error).empty ());
    CHECK (error.empty ());

    // The error pointer is optional.
    CHECK (bridge::loadPlugInOverrides (dir + "/bad.json").empty ());

    // A directory is not a settings file.
    std::filesystem::create_directories (dir + "/folder.json");
    CHECK (bridge::loadPlugInOverrides (dir + "/folder.json", &error).empty ());
}

TEST (settings_skips_entries_that_are_not_strings)
{
    const std::string dir { makeTempDir ("set3") };
    writeTextFile (dir + "/settings.json", R"({"pluginPaths": {"melodyne": "/m.vst3", "vocalign": 5, "empty": "", "nested": {"a": "b"}, "list": ["x"],
                                                              "null": null, "vocalign2": "/v.vst3"}})");
    const auto overrides = bridge::loadPlugInOverrides (dir + "/settings.json");
    CHECK (overrides.size () == 2);
    CHECK (overrides.count ("melodyne") == 1 && overrides.at ("melodyne") == "/m.vst3");
    CHECK (overrides.count ("vocalign2") == 1 && overrides.at ("vocalign2") == "/v.vst3");
    CHECK (overrides.count ("vocalign") == 0);
}

TEST (settings_keep_raw_is_read)
{
    const std::string dir { makeTempDir ("set_keepraw") };
    std::string warning { "stale" };

    writeTextFile (dir + "/on.json", R"({"pluginPaths": {"melodyne": "/m.vst3"}, "keepRaw": true, "hostPath": "/x", "future": [1]})");
    CHECK (bridge::loadKeepRaw (dir + "/on.json", &warning));
    CHECK (warning.empty ());
    CHECK (bridge::loadPlugInOverrides (dir + "/on.json").size () == 1);       // the overrides do not mind the key
    CHECK (bridge::loadKeepRaw (dir + "/on.json"));                             // the warning pointer is optional

    writeTextFile (dir + "/off.json", R"({"keepRaw": false})");
    CHECK (! bridge::loadKeepRaw (dir + "/off.json", &warning));
    CHECK (warning.empty ());

    // missing file, missing key, null, malformed file: off, no warning (a malformed file is reported by loadPlugInOverrides)
    CHECK (! bridge::loadKeepRaw (dir + "/missing.json", &warning));
    CHECK (warning.empty ());
    writeTextFile (dir + "/none.json", R"({"pluginPaths": {}})");
    CHECK (! bridge::loadKeepRaw (dir + "/none.json", &warning));
    CHECK (warning.empty ());
    writeTextFile (dir + "/null.json", R"({"keepRaw": null})");
    CHECK (! bridge::loadKeepRaw (dir + "/null.json", &warning));
    CHECK (warning.empty ());
    writeTextFile (dir + "/bad.json", R"({"keepRaw": true)");
    CHECK (! bridge::loadKeepRaw (dir + "/bad.json", &warning));
    CHECK (warning.empty ());
    std::filesystem::create_directories (dir + "/folder.json");
    CHECK (! bridge::loadKeepRaw (dir + "/folder.json", &warning));

    // anything but a boolean: off, with a warning
    for (const char* value : { "1", "0", "\"true\"", "[true]", "{}" })
    {
        writeTextFile (dir + "/typed.json", std::string { R"({"keepRaw": )" } + value + "}");
        warning.clear ();
        CHECK (! bridge::loadKeepRaw (dir + "/typed.json", &warning));
        CHECK (warning.find ("keepRaw") != std::string::npos);
    }
}

TEST (job_never_takes_keep_raw_from_job_json)
{
    bridge::Job job;
    std::string error;
    REQUIRE (loads ("keepraw", melodyneJob (R"("keepRaw": true, )", ""), job, error));
    CHECK (! job.keepRaw);
}

TEST (default_settings_path_is_in_application_support)
{
    const std::string path { bridge::defaultSettingsPath () };
    const char* home { std::getenv ("HOME") };
    CHECK (home != nullptr && path.rfind (home, 0) == 0);
    const std::string tail { "/Library/Application Support/ARABridge/settings.json" };
    CHECK (path.size () > tail.size () && path.compare (path.size () - tail.size (), tail.size (), tail) == 0);
}

TEST (result_exclusive_write_never_replaces_a_file)
{
    const std::string dir { makeTempDir ("result_exclusive") };
    bridge::ResultInfo info;
    info.status = "error";
    info.message = "first";
    std::string error;
    REQUIRE (bridge::writeResult (dir, "id", info, error, true));
    info.message = "second";
    CHECK (! bridge::writeResult (dir, "id", info, error, true));
    CHECK (error.find ("already exists") != std::string::npos);
    bridge::ResultInfo read;
    REQUIRE (bridge::readResult (dir, read, error));
    CHECK (read.message == "first");
    CHECK (! std::filesystem::exists (dir + "/result.json.tmp"));
}

TEST (result_frame_range_is_validated)
{
    const std::string dir { makeTempDir ("result_range") };
    std::string error;
    bridge::ResultInfo info;
    info.status = "ok";
    for (int bad { 0 }; bad < 4; ++bad)
    {
        bridge::ResultInfo b { info };
        if (bad == 0) b.frames = -1;
        if (bad == 1) b.sourceStartFrame = -5;
        if (bad == 2) b.sampleRate = 768001;
        if (bad == 3) b.frames = 9007199254740994LL;      // 2^53 + 2
        CHECK (! bridge::writeResult (dir, "id", b, error));
        CHECK (! std::filesystem::exists (dir + "/result.json"));
    }
    writeTextFile (dir + "/result.json", R"({"status": "ok", "frames": 1.5})");
    bridge::ResultInfo read;
    CHECK (! bridge::readResult (dir, read, error));
    writeTextFile (dir + "/result.json", R"({"status": "ok", "sampleRate": -1})");
    CHECK (! bridge::readResult (dir, read, error));
    writeTextFile (dir + "/result.json", R"({"status": "ok", "frames": 10, "sourceStartFrame": 3, "sampleRate": 44100, "diagnostics": "x"})");
    REQUIRE (bridge::readResult (dir, read, error));
    CHECK (read.frames == 10 && read.sourceStartFrame == 3 && read.sampleRate == 44100 && read.diagnostics == "x");
}

TEST (result_realign_reason_roundtrips_and_is_optional)
{
    std::string error;
    for (const char* reason : { "not-requested", "nothing-to-do", "no-confident-match", "inconsistent-shifts", "applied" })
    {
        const std::string dir { makeTempDir ("reason") };
        bridge::ResultInfo info;
        info.status = "ok";
        info.realignReason = reason;
        REQUIRE (bridge::writeResult (dir, "job-r", info, error));
        CHECK (readTextFile (dir + "/result.json").find (std::string ("\"reason\" : \"") + reason + "\"") != std::string::npos);
        bridge::ResultInfo back;
        REQUIRE (bridge::readResult (dir, back, error));
        CHECK (back.realignReason == reason);
    }
    // no reason (error and cancelled results): the key is not written, and a file without it reads fine
    const std::string dir { makeTempDir ("reason_none") };
    bridge::ResultInfo bare;
    bare.status = "cancelled";
    REQUIRE (bridge::writeResult (dir, "job-r", bare, error));
    CHECK (readTextFile (dir + "/result.json").find ("reason") == std::string::npos);
    bridge::ResultInfo back;
    REQUIRE (bridge::readResult (dir, back, error));
    CHECK (back.realignReason.empty ());
    // an unknown reason is not written
    const std::string bad { makeTempDir ("reason_bad") };
    bridge::ResultInfo info;
    info.status = "ok";
    info.realignReason = "sometimes";
    CHECK (! bridge::writeResult (bad, "job-r", info, error));
    CHECK (error.find ("unknown realign reason") != std::string::npos);
    CHECK (! std::filesystem::exists (bad + "/result.json"));
    CHECK (bridge::isRealignReason ("applied"));
    CHECK (! bridge::isRealignReason (""));
}

TEST (job_output_defaults_to_dub_and_accepts_guide_for_vocalign)
{
    bridge::Job job;
    std::string error;
    REQUIRE (loads ("out0", kVocAlignJob, job, error));
    CHECK (job.output == "dub");
    std::string guide { kVocAlignJob };
    guide.replace (guide.find ("\"plugin\": \"vocalign\","), 21, "\"plugin\": \"vocalign\", \"output\": \"guide\",");
    REQUIRE (loads ("out1", guide, job, error));
    CHECK (job.output == "guide");
    std::string dub { kVocAlignJob };
    dub.replace (dub.find ("\"plugin\": \"vocalign\","), 21, "\"plugin\": \"vocalign\", \"output\": \"dub\",");
    REQUIRE (loads ("out2", dub, job, error));
    CHECK (job.output == "dub");
    // null counts as absent; "dub" is fine for melodyne too
    REQUIRE (loads ("out3", melodyneJob (R"("output": null, )", ""), job, error));
    CHECK (job.output == "dub");
    REQUIRE (loads ("out4", melodyneJob (R"("output": "dub", )", ""), job, error));
    CHECK (job.output == "dub");
}

TEST (job_output_rejects_bad_values)
{
    CHECK (rejects ("outb1", melodyneJob (R"("output": "guide", )", ""), "'output' \"guide\" needs a vocalign job"));
    CHECK (rejects ("outb2", melodyneJob (R"("output": "Guide", )", ""), "unknown output 'Guide'"));
    CHECK (rejects ("outb3", melodyneJob (R"("output": "", )", ""), "unknown output ''"));
    CHECK (rejects ("outb4", melodyneJob (R"("output": 1, )", ""), "'output' must be a string"));
    CHECK (rejects ("outb5", melodyneJob (R"("output": true, )", ""), "'output' must be a string"));
    std::string vocalign { kVocAlignJob };
    vocalign.replace (vocalign.find ("\"plugin\": \"vocalign\","), 21, "\"plugin\": \"vocalign\", \"output\": \"both\",");
    CHECK (rejects ("outb6", vocalign, "unknown output 'both'"));
}

TEST (result_place_at_guide_roundtrips_and_is_optional)
{
    std::string error;
    const std::string dir { makeTempDir ("placeat") };
    bridge::ResultInfo info;
    info.status = "ok";
    info.frames = 100;
    info.placeAt = "guide";
    info.offsetFrames = 22050;
    info.droppedFrames = 0;
    REQUIRE (bridge::writeResult (dir, "job-p", info, error));
    const std::string text { readTextFile (dir + "/result.json") };
    CHECK (text.find ("\"placeAt\" : \"guide\"") != std::string::npos);
    CHECK (text.find ("\"offsetFrames\" : 22050") != std::string::npos);
    CHECK (text.find ("\"droppedFrames\" : 0") != std::string::npos);
    bridge::ResultInfo back;
    REQUIRE (bridge::readResult (dir, back, error));
    CHECK (back.placeAt == "guide" && back.offsetFrames == 22050 && back.droppedFrames == 0);

    // no placeAt (output "dub", melodyne, errors): none of the three keys is written
    const std::string none { makeTempDir ("placeat_none") };
    bridge::ResultInfo bare;
    bare.status = "ok";
    bare.offsetFrames = 7;      // ignored without placeAt
    REQUIRE (bridge::writeResult (none, "job-p", bare, error));
    const std::string bareText { readTextFile (none + "/result.json") };
    CHECK (bareText.find ("placeAt") == std::string::npos);
    CHECK (bareText.find ("offsetFrames") == std::string::npos);
    CHECK (bareText.find ("droppedFrames") == std::string::npos);
    REQUIRE (bridge::readResult (none, back, error));
    CHECK (back.placeAt.empty () && back.offsetFrames == 0 && back.droppedFrames == 0);

    // bad values are neither written nor read
    for (int bad { 0 }; bad < 3; ++bad)
    {
        const std::string b { makeTempDir ("placeat_bad" + std::to_string (bad)) };
        bridge::ResultInfo r { info };
        if (bad == 0) r.placeAt = "track";
        if (bad == 1) r.offsetFrames = -1;
        if (bad == 2) r.droppedFrames = -3;
        CHECK (! bridge::writeResult (b, "job-p", r, error));
        CHECK (! std::filesystem::exists (b + "/result.json"));
    }
    CHECK (resultRejects ("placeat_r1", R"({"status": "ok", "placeAt": "track"})", "unknown 'placeAt' 'track'"));
    CHECK (resultRejects ("placeat_r2", R"({"status": "ok", "placeAt": 1})", "'placeAt' must be a string"));
    CHECK (resultRejects ("placeat_r3", R"({"status": "ok", "placeAt": "guide", "offsetFrames": -1})", "'offsetFrames' is out of range"));
    CHECK (resultRejects ("placeat_r4", R"({"status": "ok", "placeAt": "guide", "droppedFrames": 1.5})", "'droppedFrames' must be a whole number"));
    writeTextFile (none + "/result.json", R"({"status": "ok", "placeAt": "dub"})");
    REQUIRE (bridge::readResult (none, back, error));
    CHECK (back.placeAt == "dub");
}
