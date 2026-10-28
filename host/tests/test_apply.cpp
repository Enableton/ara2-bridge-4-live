#include "check.h"
#include "testutil.h"

#include "hostcore/ApplyJob.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <string>
#include <utility>
#include <vector>

namespace
{
    // A gliding tone with weak partials, so the realignment can lock onto it.
    bridge::Audio tone (int sampleRate, int64_t frames, int channels, double offset = 0.0)
    {
        bridge::Audio audio;
        audio.sampleRate = sampleRate;
        audio.channels.assign (static_cast<size_t> (channels), std::vector<float> (static_cast<size_t> (frames)));
        for (int c { 0 }; c < channels; ++c)
            for (int64_t i { 0 }; i < frames; ++i)
            {
                const double t { (static_cast<double> (i) + offset) / sampleRate };
                const double v { 0.3 * std::sin (2.0 * M_PI * (220.0 * t + 40.0 * t * t)) + 0.05 * std::sin (2.0 * M_PI * 1377.3 * t + c)
                                 + 0.03 * std::sin (2.0 * M_PI * 3187.7 * t) + 0.02 * std::sin (2.0 * M_PI * 5041.1 * t + 2.0 * c) };
                audio.channels[static_cast<size_t> (c)][static_cast<size_t> (i)] = static_cast<float> (v);
            }
        return audio;
    }

    bridge::Job job (const std::string& dir, const std::string& plugin, bool realign)
    {
        bridge::Job j;
        j.id = "job-" + plugin;
        j.plugin = plugin;
        j.realign = realign;
        j.dir = dir;
        return j;
    }

    bridge::RenderFunction returns (const bridge::Audio& audio)
    {
        return [audio] (bridge::Audio& out, std::string&, std::string&) { out = audio; return true; };
    }

    bool readBack (const std::string& dir, bridge::ResultInfo& info, bridge::Audio& audio)
    {
        std::string error;
        if (! bridge::readResult (dir, info, error))
        {
            std::printf ("    readResult: %s\n", error.c_str ());
            return false;
        }
        if (info.status == "ok" && ! bridge::readWav (dir + "/result.wav", audio, error))
        {
            std::printf ("    readWav: %s\n", error.c_str ());
            return false;
        }
        return true;
    }
}

TEST (apply_writes_an_unedited_render_unchanged)
{
    const std::string dir { makeTempDir ("apply_plain") };
    const bridge::Audio original { tone (44100, 44100, 2) };
    const auto info { bridge::applyJob (job (dir, "melodyne", true), original, 0, returns (original), true) };
    CHECK (info.status == "ok");
    CHECK (! info.realignApplied);
    CHECK (info.resultPath == dir + "/result.wav");

    bridge::ResultInfo read;
    bridge::Audio audio;
    REQUIRE (readBack (dir, read, audio));
    CHECK (read.id == "job-melodyne");
    CHECK (read.status == "ok");
    CHECK (read.resultPath == dir + "/result.wav");
    CHECK (audio.sampleRate == 44100);
    CHECK (audio.channels == original.channels);
    CHECK (! std::filesystem::exists (dir + "/result.wav.tmp"));
}

TEST (apply_realigns_an_early_melodyne_tail)
{
    const std::string dir { makeTempDir ("apply_realign") };
    const int64_t frames { 2 * 44100 };
    const bridge::Audio original { tone (44100, frames, 1) };
    // render: identical first second, then the original moved 30 samples early
    bridge::Audio render { original };
    const bridge::Audio early { tone (44100, frames, 1, 30.0) };
    for (int64_t i { 44100 }; i < frames; ++i)
        render.channels[0][static_cast<size_t> (i)] = early.channels[0][static_cast<size_t> (i)];

    const auto info { bridge::applyJob (job (dir, "melodyne", true), original, 0, returns (render), true) };
    CHECK (info.status == "ok");
    CHECK (info.realignApplied);
    REQUIRE (! info.shifts.empty ());

    bridge::ResultInfo read;
    bridge::Audio audio;
    REQUIRE (readBack (dir, read, audio));
    CHECK (read.realignApplied);
    CHECK (read.message == "Melodyne's timing shift after the edit was corrected.");
    CHECK (read.diagnostics.rfind ("realign: moved ", 0) == 0);
    REQUIRE (read.shifts.size () == info.shifts.size ());
    bool foundTail { false };
    for (const auto& s : read.shifts)
    {
        CHECK (s.start >= 0);
        CHECK (s.end <= frames);
        if (std::fabs (s.shift - 30.0) < 0.5)
            foundTail = true;
    }
    CHECK (foundTail);
    REQUIRE (audio.frames () == static_cast<size_t> (frames));
    double worst { 0.0 };
    for (int64_t i { 60000 }; i < 80000; ++i)
        worst = std::max (worst, std::fabs (static_cast<double> (audio.channels[0][static_cast<size_t> (i)]) - original.channels[0][static_cast<size_t> (i)]));
    CHECK (worst < 1e-3);
}

TEST (apply_keeps_a_nearly_identical_melodyne_render_verbatim)
{
    // Melodyne's unedited renders can differ from the source by an ulp or two; realign must leave them as rendered
    const std::string dir { makeTempDir ("apply_ulp") };
    const bridge::Audio original { tone (44100, 44100, 2) };
    bridge::Audio render { original };
    for (auto& channel : render.channels)
        for (size_t i { 0 }; i < channel.size (); i += 3)
            channel[i] = std::nextafter (channel[i], (i % 2) ? 1.0f : -1.0f);
    const auto info { bridge::applyJob (job (dir, "melodyne", true), original, 0, returns (render), true) };
    CHECK (info.status == "ok");
    CHECK (! info.realignApplied);
    bridge::ResultInfo read;
    bridge::Audio audio;
    REQUIRE (readBack (dir, read, audio));
    CHECK (audio.channels == render.channels);
}

TEST (apply_does_not_realign_when_switched_off_or_for_vocalign)
{
    const int64_t frames { 2 * 44100 };
    const bridge::Audio original { tone (44100, frames, 1) };
    const bridge::Audio early { tone (44100, frames, 1, 30.0) };

    for (const auto& variant : { std::make_pair (std::string ("melodyne"), false), std::make_pair (std::string ("vocalign"), true) })
    {
        const std::string dir { makeTempDir ("apply_norealign_" + variant.first) };
        const auto info { bridge::applyJob (job (dir, variant.first, variant.second), original, 0, returns (early), true) };
        CHECK (info.status == "ok");
        CHECK (! info.realignApplied);
        CHECK (info.shifts.empty ());
        bridge::ResultInfo read;
        bridge::Audio audio;
        REQUIRE (readBack (dir, read, audio));
        CHECK (audio.channels == early.channels);       // exactly as rendered
    }
}

TEST (apply_reports_a_failed_render)
{
    const std::string dir { makeTempDir ("apply_fail") };
    const bridge::Audio original { tone (44100, 1000, 2) };
    const auto info { bridge::applyJob (job (dir, "melodyne", true), original, 0,
                                        [] (bridge::Audio&, std::string& error, std::string&) { error = "plug-in exploded"; return false; }, true) };
    CHECK (info.status == "error");
    CHECK (info.message.find ("plug-in exploded") != std::string::npos);
    bridge::ResultInfo read;
    bridge::Audio audio;
    REQUIRE (readBack (dir, read, audio));
    CHECK (read.status == "error");
    CHECK (read.message.find ("plug-in exploded") != std::string::npos);
    CHECK (! std::filesystem::exists (dir + "/result.wav"));
}

TEST (apply_without_result_on_error_writes_nothing)
{
    const std::string dir { makeTempDir ("apply_fail_ui") };
    const bridge::Audio original { tone (44100, 1000, 2) };
    const auto info { bridge::applyJob (job (dir, "melodyne", true), original, 0,
                                        [] (bridge::Audio&, std::string& error, std::string&) { error = "nope"; return false; }, false) };
    CHECK (info.status == "error");
    CHECK (! std::filesystem::exists (dir + "/result.json"));
}

TEST (apply_rejects_a_render_of_the_wrong_shape)
{
    const bridge::Audio original { tone (44100, 1000, 2) };
    bridge::Audio shorter { tone (44100, 999, 2) };
    bridge::Audio mono { tone (44100, 1000, 1) };
    bridge::Audio otherRate { tone (48000, 1000, 2) };
    int index { 0 };
    for (const auto* render : { &shorter, &mono, &otherRate })
    {
        const std::string dir { makeTempDir ("apply_shape_" + std::to_string (index++)) };
        const auto info { bridge::applyJob (job (dir, "vocalign", false), original, 0, returns (*render), true) };
        CHECK (info.status == "error");
        CHECK (! std::filesystem::exists (dir + "/result.wav"));
        bridge::ResultInfo read;
        bridge::Audio audio;
        REQUIRE (readBack (dir, read, audio));
        CHECK (read.status == "error");
    }
}

TEST (apply_never_overwrites_a_result)
{
    const std::string dir { makeTempDir ("apply_exists") };
    writeTextFile (dir + "/result.json", "old");
    const bridge::Audio original { tone (44100, 1000, 2) };
    bool rendered { false };
    const auto info { bridge::applyJob (job (dir, "melodyne", true), original, 0,
                                        [&] (bridge::Audio& out, std::string&, std::string&) { rendered = true; out = original; return true; }, true) };
    CHECK (info.status == "error");
    CHECK (! rendered);
    CHECK (! std::filesystem::exists (dir + "/result.wav"));
    std::ifstream file (dir + "/result.json");
    std::string text ((std::istreambuf_iterator<char> (file)), std::istreambuf_iterator<char> ());
    CHECK (text == "old");
}

TEST (apply_reports_an_unwritable_job_folder)
{
    const std::string dir { makeTempDir ("apply_nodir") + "/missing" };
    const bridge::Audio original { tone (44100, 1000, 2) };
    const auto info { bridge::applyJob (job (dir, "melodyne", true), original, 0, returns (original), true) };
    CHECK (info.status == "error");
    CHECK (! info.message.empty ());
}

TEST (error_result_is_written_once)
{
    const std::string dir { makeTempDir ("error_result") };
    std::string error;
    CHECK (! bridge::resultExists (dir));
    REQUIRE (bridge::writeErrorResult (dir, "id-1", "first", error));
    CHECK (bridge::resultExists (dir));
    CHECK (! bridge::writeErrorResult (dir, "id-1", "second", error));
    CHECK (! error.empty ());
    bridge::ResultInfo read;
    REQUIRE (bridge::readResult (dir, read, error));
    CHECK (read.status == "error");
    CHECK (read.message == "first");
}

TEST (apply_reports_render_diagnostics_and_the_frame_range)
{
    const std::string dir { makeTempDir ("apply_diagnostics") };
    const bridge::Audio original { tone (48000, 48000, 1) };
    const auto render = [&] (bridge::Audio& out, std::string&, std::string& diagnostics) { out = original; diagnostics = "renders differ"; return true; };
    const auto info { bridge::applyJob (job (dir, "melodyne", true), original, 12345, render, true) };
    CHECK (info.status == "ok");
    bridge::ResultInfo read;
    bridge::Audio audio;
    REQUIRE (readBack (dir, read, audio));
    CHECK (read.status == "ok");
    CHECK (read.diagnostics.rfind ("renders differ; realign: ", 0) == 0);  // the realign note follows the render's
    CHECK (read.message.empty ());                                         // nothing moved: nothing to tell the user
    CHECK (read.sourceStartFrame == 12345);
    CHECK (read.frames == 48000);
    CHECK (read.sampleRate == 48000);
    CHECK (audio.channels == original.channels);
}

TEST (apply_reports_why_realign_did_or_did_not_move_audio)
{
    const int64_t frames { 2 * 44100 };
    const bridge::Audio original { tone (44100, frames, 1) };
    bridge::Audio editedTail { original };
    const bridge::Audio early { tone (44100, frames, 1, 30.0) };
    for (int64_t i { 44100 }; i < frames; ++i)
        editedTail.channels[0][static_cast<size_t> (i)] = early.channels[0][static_cast<size_t> (i)];
    // a short (0.2 s) chance match at +145 samples inside otherwise edited audio: no consistent timing shift
    bridge::Audio chance { original };
    const bridge::Audio far { tone (44100, frames, 1, 145.0) };
    for (int64_t i { 35280 }; i < frames; ++i)
        chance.channels[0][static_cast<size_t> (i)] = (i >= 52920 && i < 61740)
            ? far.channels[0][static_cast<size_t> (i)]
            : static_cast<float> (0.4 * std::sin (2.0 * M_PI * 330.0 * static_cast<double> (i) / 44100.0));
    bridge::Audio silent { original };
    for (auto& channel : silent.channels)
        std::fill (channel.begin (), channel.end (), 0.0f);
    bridge::Audio unrelated { original };
    uint32_t seed { 12345 };
    for (auto& value : unrelated.channels[0])
    {
        seed = seed * 1664525u + 1013904223u;
        value = static_cast<float> (seed >> 8) / 16777216.0f - 0.5f;
    }

    struct Case
    {
        const char* name;
        const char* plugin;
        bool realign;
        const bridge::Audio* source;
        const bridge::Audio* render;
        const char* reason;
    };
    const Case cases[] {
        { "applied", "melodyne", true, &original, &editedTail, "applied" },
        { "unedited", "melodyne", true, &original, &original, "nothing-to-do" },
        { "off", "melodyne", false, &original, &editedTail, "not-requested" },
        { "vocalign", "vocalign", true, &original, &editedTail, "not-requested" },
        { "silent", "melodyne", true, &silent, &silent, "no-confident-match" },
        { "unrelated", "melodyne", true, &original, &unrelated, "no-confident-match" },
        { "chance", "melodyne", true, &original, &chance, "inconsistent-shifts" },
    };
    for (const Case& c : cases)
    {
        const std::string dir { makeTempDir (std::string ("apply_reason_") + c.name) };
        const auto info { bridge::applyJob (job (dir, c.plugin, c.realign), *c.source, 0, returns (*c.render), true) };
        CHECK (info.status == "ok");
        bridge::ResultInfo read;
        bridge::Audio audio;
        REQUIRE (readBack (dir, read, audio));
        if (read.realignReason != c.reason)
            std::printf ("    %s: reason '%s', expected '%s'\n", c.name, read.realignReason.c_str (), c.reason);
        CHECK (read.realignReason == c.reason);
        CHECK (read.realignApplied == (std::string (c.reason) == "applied"));
        if (std::string (c.reason) != "applied")
            CHECK (audio.channels == c.render->channels);       // left exactly as rendered
    }
}

TEST (realign_reason_maps_every_outcome)
{
    bridge::RealignResult result;
    CHECK (bridge::realignReason (false, result) == "not-requested");
    result.applied = true;
    CHECK (bridge::realignReason (false, result) == "not-requested");
    CHECK (bridge::realignReason (true, result) == "applied");
    result.applied = false;
    CHECK (bridge::realignReason (true, result) == "no-confident-match");    // also: candidates, but no block moved
    result.nothingToDo = true;
    CHECK (bridge::realignReason (true, result) == "nothing-to-do");
    result.nothingToDo = false;
    result.inconsistent = true;
    CHECK (bridge::realignReason (true, result) == "inconsistent-shifts");
    result.unstable = true;
    CHECK (bridge::realignReason (true, result) == "inconsistent-shifts");
    CHECK (bridge::realignReason (false, result) == "not-requested");
}

namespace
{
    bridge::Job guideJob (const std::string& dir)
    {
        bridge::Job j { job (dir, "vocalign", false) };
        j.output = "guide";
        return j;
    }

    bridge::GuideWindow at (int64_t offset, int64_t frames)
    {
        bridge::GuideWindow w;
        w.atGuide = true;
        w.offset = offset;
        w.frames = frames;
        return w;
    }
}

TEST (apply_output_guide_places_the_render_in_the_window)
{
    const int64_t frames { 44100 };
    const bridge::Audio original { tone (44100, frames, 2) };
    const bridge::Audio render { tone (44100, frames, 2, 7.0) };       // what VocAlign returned (any audio)
    const std::string dir { makeTempDir ("apply_guide_pos") };
    const auto info { bridge::applyJob (guideJob (dir), original, 4410, returns (render), true, {}, at (22050, 88200)) };
    REQUIRE (info.status == "ok");
    bridge::ResultInfo read;
    bridge::Audio audio;
    REQUIRE (readBack (dir, read, audio));
    CHECK (read.frames == 88200 && read.sampleRate == 44100 && read.sourceStartFrame == 4410);
    CHECK (read.placeAt == "guide" && read.offsetFrames == 22050 && read.droppedFrames == 0);
    CHECK (read.diagnostics.find ("dropped") == std::string::npos);
    REQUIRE (audio.frames () == 88200 && audio.channelCount () == 2);
    for (size_t c { 0 }; c < 2; ++c)
    {
        CHECK (std::all_of (audio.channels[c].begin (), audio.channels[c].begin () + 22050, [] (float v) { return v == 0.0f; }));
        CHECK (std::equal (render.channels[c].begin (), render.channels[c].end (), audio.channels[c].begin () + 22050));
        CHECK (std::all_of (audio.channels[c].begin () + 22050 + frames, audio.channels[c].end (), [] (float v) { return v == 0.0f; }));
    }
}

TEST (apply_output_guide_drops_the_part_before_the_guide_and_says_so)
{
    const int64_t frames { 44100 };
    const bridge::Audio original { tone (44100, frames, 1) };
    const std::string dir { makeTempDir ("apply_guide_neg") };
    const auto info { bridge::applyJob (guideJob (dir), original, 0, returns (original), true, {}, at (-1000, 44100)) };
    REQUIRE (info.status == "ok");
    bridge::ResultInfo read;
    bridge::Audio audio;
    REQUIRE (readBack (dir, read, audio));
    CHECK (read.frames == 44100 && read.offsetFrames == 0 && read.droppedFrames == 1000);
    CHECK (read.diagnostics.find ("the first 1000 frames of the dub lie before the guide's start and were dropped") != std::string::npos);
    CHECK (read.message.empty ());
    REQUIRE (audio.frames () == 44100);
    CHECK (std::equal (original.channels[0].begin () + 1000, original.channels[0].end (), audio.channels[0].begin ()));
    CHECK (std::all_of (audio.channels[0].end () - 1000, audio.channels[0].end (), [] (float v) { return v == 0.0f; }));
}

TEST (apply_output_dub_is_unchanged_and_guide_needs_a_window)
{
    const int64_t frames { 4410 };
    const bridge::Audio original { tone (44100, frames, 2) };
    // output "dub" ignores a window and writes no placeAt
    const std::string dir { makeTempDir ("apply_guide_dub") };
    const auto info { bridge::applyJob (job (dir, "vocalign", false), original, 0, returns (original), true, {}, at (100, 9000)) };
    REQUIRE (info.status == "ok");
    bridge::ResultInfo read;
    bridge::Audio audio;
    REQUIRE (readBack (dir, read, audio));
    CHECK (read.frames == frames && read.placeAt.empty ());
    CHECK (readTextFile (dir + "/result.json").find ("placeAt") == std::string::npos);
    CHECK (audio.channels == original.channels);
    // output "guide" without a window is an error result
    const std::string bad { makeTempDir ("apply_guide_nowindow") };
    const auto failed { bridge::applyJob (guideJob (bad), original, 0, returns (original), true) };
    CHECK (failed.status == "error");
    CHECK (failed.message.find ("without a window at the guide") != std::string::npos);
    CHECK (! std::filesystem::exists (bad + "/result.wav"));
    std::string error;
    REQUIRE (bridge::readResult (bad, read, error));
    CHECK (read.status == "error");
}

TEST (preview_is_published_in_its_own_folder_and_leaves_the_job_alone)
{
    const std::string dir { makeTempDir ("preview_basic") };
    const bridge::Audio original { tone (44100, 44100, 2) };
    bridge::Job j { job (dir, "melodyne", true) };
    j.keepRaw = true;      // never applied to a preview
    const auto info { bridge::writePreview (j, 3, original, 100, returns (original)) };
    CHECK (info.status == "ok");
    CHECK (info.resultPath == dir + "/preview-3/result.wav");
    CHECK (info.sourceStartFrame == 100);
    CHECK (info.frames == 44100);

    CHECK (! bridge::resultExists (dir));
    CHECK (! std::filesystem::exists (dir + "/result.wav"));
    CHECK (std::filesystem::exists (dir + "/preview-3/result.json"));
    CHECK (std::filesystem::exists (dir + "/preview-3/result.wav"));
    CHECK (! std::filesystem::exists (dir + "/preview-3/result.wav.tmp"));
    CHECK (! std::filesystem::exists (dir + "/preview-3/realign-debug.json"));

    bridge::ResultInfo read;
    bridge::Audio audio;
    REQUIRE (readBack (dir + "/preview-3", read, audio));
    CHECK (read.status == "ok");
    CHECK (read.resultPath == dir + "/preview-3/result.wav");
    CHECK (audio.channels == original.channels);

    // the real result can still be written afterwards
    const auto final { bridge::applyJob (job (dir, "melodyne", true), original, 100, returns (original), true) };
    CHECK (final.status == "ok");
    CHECK (bridge::resultExists (dir));
}

TEST (preview_realigns_like_apply)
{
    const std::string dir { makeTempDir ("preview_realign") };
    const int64_t frames { 2 * 44100 };
    const bridge::Audio original { tone (44100, frames, 1) };
    bridge::Audio early { tone (44100, frames, 1, 31.0) };      // the tail arrives 31 samples early, as after a Melodyne edit
    const auto plain { bridge::applyJob (job (makeTempDir ("preview_realign_ref"), "melodyne", true), original, 0, returns (early), true) };
    const auto info { bridge::writePreview (job (dir, "melodyne", true), 1, original, 0, returns (early)) };
    CHECK (info.status == "ok");
    CHECK (info.realignApplied == plain.realignApplied);
    CHECK (info.realignReason == plain.realignReason);
}

TEST (preview_failure_leaves_no_folder)
{
    const std::string dir { makeTempDir ("preview_fail") };
    const bridge::Audio original { tone (44100, 22050, 1) };
    const auto info { bridge::writePreview (job (dir, "melodyne", true), 1, original, 0,
                                            [] (bridge::Audio&, std::string& error, std::string&) { error = "the render was stopped"; return false; }) };
    CHECK (info.status == "error");
    CHECK (info.message == "the render was stopped");
    CHECK (! std::filesystem::exists (dir + "/preview-1"));
    CHECK (! bridge::resultExists (dir));

    // a render of the wrong shape fails the same way
    const auto wrong { bridge::writePreview (job (dir, "melodyne", true), 2, original, 0, returns (tone (44100, 100, 1))) };
    CHECK (wrong.status == "error");
    CHECK (! std::filesystem::exists (dir + "/preview-2"));
}

TEST (prune_previews_keeps_the_newest_and_touches_nothing_else)
{
    const std::string dir { makeTempDir ("preview_prune") };
    for (const char* name : { "preview-1", "preview-2", "preview-9", "preview-10", "preview-x", "preview-", "previews", "other" })
        std::filesystem::create_directory (dir + "/" + name);
    { std::ofstream (dir + "/preview-5") << "a file, not a folder"; }
    { std::ofstream (dir + "/job.json") << "{}"; }

    CHECK (bridge::prunePreviews (dir, 2) == 2);     // 1 and 2 go; 9 and 10 stay (numeric order, not text order)
    CHECK (! std::filesystem::exists (dir + "/preview-1"));
    CHECK (! std::filesystem::exists (dir + "/preview-2"));
    CHECK (std::filesystem::exists (dir + "/preview-9"));
    CHECK (std::filesystem::exists (dir + "/preview-10"));
    for (const char* name : { "preview-x", "preview-", "previews", "other", "preview-5", "job.json" })
        CHECK (std::filesystem::exists (dir + "/" + name));

    CHECK (bridge::prunePreviews (dir, 2) == 0);
    CHECK (bridge::prunePreviews (dir, 0) == 2);
    CHECK (bridge::prunePreviews (dir + "/missing", 2) == 0);
}
