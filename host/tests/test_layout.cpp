#include "check.h"

#include "hostcore/JobLayout.h"

#include <cmath>
#include <cstdint>
#include <limits>
#include <string>
#include <vector>

namespace
{
    bridge::Audio silence (int sampleRate, int64_t frames, int channels = 2)
    {
        bridge::Audio audio;
        audio.sampleRate = sampleRate;
        audio.channels.assign (static_cast<size_t> (channels), std::vector<float> (static_cast<size_t> (frames), 0.0f));
        return audio;
    }

    bridge::JobClip clip (const std::string& role, double startSec, double endSec, double startBeats = 0.0)
    {
        bridge::JobClip c;
        c.role = role;
        c.name = role;
        c.path = "/x/" + role + ".wav";
        c.startSec = startSec;
        c.endSec = endSec;
        c.startBeats = startBeats;
        return c;
    }

    bridge::Job melodyneJob (double startSec, double endSec)
    {
        bridge::Job job;
        job.id = "m";
        job.plugin = "melodyne";
        job.clips = { clip ("source", startSec, endSec) };
        return job;
    }

    bridge::Job vocalignJob (double guideBeats, double dubBeats, double tempo = 120.0)
    {
        bridge::Job job;
        job.id = "v";
        job.plugin = "vocalign";
        job.tempo = tempo;
        job.clips = { clip ("guide", 0.5, 2.5, guideBeats), clip ("dub", 1.0, 3.0, dubBeats) };
        return job;
    }

    bool rejectsWith (const bridge::Job& job, const std::vector<bridge::Audio>& audio, const std::string& expected)
    {
        bridge::JobLayout layout;
        layout.renderClip = 77;
        std::string error;
        if (bridge::layoutJob (job, audio, layout, error))
            return false;
        if (layout.renderClip != 77 || ! layout.regions.empty ())
            return false;
        if (error.find (expected) == std::string::npos)
        {
            std::printf ("    error was '%s', expected it to mention '%s'\n", error.c_str (), expected.c_str ());
            return false;
        }
        return true;
    }
}

TEST (layout_puts_a_melodyne_region_on_the_sample_grid)
{
    bridge::JobLayout layout;
    std::string error;
    REQUIRE (bridge::layoutJob (melodyneJob (1.0, 3.0), { silence (44100, 5 * 44100) }, layout, error));
    REQUIRE (layout.regions.size () == 1);
    CHECK (layout.renderClip == 0);
    CHECK (layout.regions[0].sourceStart == 44100);
    CHECK (layout.regions[0].frames == 88200);
    CHECK (layout.regions[0].playbackStart == 0);
}

TEST (layout_rounds_marker_times_to_the_nearest_frame)
{
    // 1.00001 s at 48 kHz is frame 48000.48 -> 48000; 2.99999 s is 143999.52 -> 144000
    bridge::JobLayout layout;
    std::string error;
    REQUIRE (bridge::layoutJob (melodyneJob (1.00001, 2.99999), { silence (48000, 4 * 48000) }, layout, error));
    CHECK (layout.regions[0].sourceStart == 48000);
    CHECK (layout.regions[0].frames == 96000);
}

TEST (layout_cuts_a_region_that_ends_just_past_the_file)
{
    bridge::JobLayout layout;
    std::string error;
    REQUIRE (bridge::layoutJob (melodyneJob (1.0, 2.0005), { silence (44100, 2 * 44100) }, layout, error));
    CHECK (layout.regions[0].frames == 44100);
}

TEST (layout_rejects_a_region_beyond_the_file)
{
    CHECK (rejectsWith (melodyneJob (1.0, 2.01), { silence (44100, 2 * 44100) }, "ends after the end of its audio file"));
    CHECK (rejectsWith (melodyneJob (2.0, 2.5), { silence (44100, 2 * 44100) }, "starts at or after the end"));
}

TEST (layout_rejects_regions_shorter_than_a_frame)
{
    CHECK (rejectsWith (melodyneJob (1.0, 1.000001), { silence (44100, 2 * 44100) }, "shorter than one sample"));
}

TEST (layout_rejects_unsupported_channel_counts_and_missing_audio)
{
    CHECK (rejectsWith (melodyneJob (0.0, 1.0), { silence (44100, 44100, 3) }, "only mono and stereo"));
    CHECK (rejectsWith (melodyneJob (0.0, 1.0), { silence (44100, 44100, 0) }, "has no audio"));
    CHECK (rejectsWith (melodyneJob (0.0, 1.0), {}, "audio files"));
}

TEST (layout_accepts_mono)
{
    bridge::JobLayout layout;
    std::string error;
    CHECK (bridge::layoutJob (melodyneJob (0.0, 1.0), { silence (44100, 44100, 1) }, layout, error));
}

TEST (layout_keeps_the_relative_timing_of_guide_and_dub)
{
    // the dub starts 2 beats (1 s at 120 bpm) after the guide
    bridge::JobLayout layout;
    std::string error;
    REQUIRE (bridge::layoutJob (vocalignJob (8.0, 10.0), { silence (48000, 5 * 48000), silence (48000, 5 * 48000) }, layout, error));
    REQUIRE (layout.regions.size () == 2);
    CHECK (layout.renderClip == 1);
    CHECK (layout.regions[0].playbackStart == 0);
    CHECK (layout.regions[1].playbackStart == 48000);
    CHECK (layout.regions[0].sourceStart == 24000);
    CHECK (layout.regions[1].sourceStart == 48000);
    CHECK (layout.regions[1].frames == 96000);
}

TEST (layout_rounds_the_playback_start_to_a_frame)
{
    // 1 beat at 97 bpm = 0.618556... s = 27278.3 frames at 44.1 kHz
    bridge::JobLayout layout;
    std::string error;
    REQUIRE (bridge::layoutJob (vocalignJob (1.0, 0.0, 97.0), { silence (44100, 5 * 44100), silence (44100, 5 * 44100) }, layout, error));
    CHECK (layout.regions[0].playbackStart == 27278);
    CHECK (layout.regions[1].playbackStart == 0);
}

TEST (layout_rejects_guide_and_dub_at_different_rates)
{
    CHECK (rejectsWith (vocalignJob (0.0, 0.0), { silence (44100, 5 * 44100), silence (48000, 5 * 48000) }, "sample rate"));
}

TEST (layout_rejects_clips_too_far_apart)
{
    CHECK (rejectsWith (vocalignJob (0.0, 1.0e7, 1.0), { silence (44100, 5 * 44100), silence (44100, 5 * 44100) }, "apart"));
}

TEST (span_without_head_tail_or_latency_is_the_region)
{
    bridge::RenderSpan span;
    std::string error;
    REQUIRE (bridge::renderSpan (1000, 500, 0.0, 0.0, 0, 44100, span, error));
    CHECK (span.first == 1000);
    CHECK (span.end == 1500);
    CHECK (span.cropFrom == 0);
    CHECK (span.frames == 500);
}

TEST (span_adds_head_and_tail_rounded_up)
{
    bridge::RenderSpan span;
    std::string error;
    // 0.01 s = 441 frames, 0.00001 s = 0.441 frames -> 1
    REQUIRE (bridge::renderSpan (0, 1000, 0.01, 0.00001, 0, 44100, span, error));
    CHECK (span.first == -441);
    CHECK (span.end == 1001);
    CHECK (span.cropFrom == 441);
    CHECK (span.frames == 1000);
}

TEST (span_compensates_latency)
{
    // with latency L the region's frames come out L samples later: render L more, keep from L later
    bridge::RenderSpan span;
    std::string error;
    REQUIRE (bridge::renderSpan (100, 1000, 0.0, 0.0, 64, 44100, span, error));
    CHECK (span.first == 100);
    CHECK (span.end == 1164);
    CHECK (span.cropFrom == 64);
    CHECK (span.cropFrom + span.frames <= span.end - span.first);

    REQUIRE (bridge::renderSpan (100, 1000, 0.01, 0.02, 64, 44100, span, error));
    CHECK (span.first == 100 - 441);
    CHECK (span.end == 1100 + 882 + 64);
    CHECK (span.cropFrom == 441 + 64);
}

TEST (span_ignores_bad_head_tail_and_unknown_latency)
{
    bridge::RenderSpan span;
    std::string error;
    REQUIRE (bridge::renderSpan (0, 10, -1.0, std::numeric_limits<double>::quiet_NaN (), -1, 44100, span, error));
    CHECK (span.first == 0);
    CHECK (span.end == 10);
    CHECK (span.cropFrom == 0);

    REQUIRE (bridge::renderSpan (0, 10, 1.0e9, std::numeric_limits<double>::infinity (), 0, 1000, span, error));
    CHECK (span.first == -static_cast<int64_t> (bridge::kMaxHeadTailSec * 1000));
    CHECK (span.end == 10);         // an infinite tail counts as 0 (not finite)
}

TEST (span_rejects_bad_input)
{
    bridge::RenderSpan span;
    std::string error;
    CHECK (! bridge::renderSpan (0, 0, 0.0, 0.0, 0, 44100, span, error));
    CHECK (! bridge::renderSpan (0, 10, 0.0, 0.0, 0, 10, span, error));
    CHECK (! bridge::renderSpan (0, 10, 0.0, 0.0, bridge::kMaxLatencySamples + 1, 44100, span, error));
    CHECK (! bridge::renderSpan (std::numeric_limits<int64_t>::max () - 5, 10, 0.0, 0.0, 0, 44100, span, error));
    CHECK (! error.empty ());
}

namespace
{
    bridge::Job guideOutputJob (double guideBeats, double dubBeats, double tempo = 120.0)
    {
        bridge::Job job { vocalignJob (guideBeats, dubBeats, tempo) };
        job.output = "guide";
        return job;
    }

    // frames x channels with sample (c, i) = 1 + i + 0.5 c, so every frame is distinct and never zero
    bridge::Audio ramp (int sampleRate, int64_t frames, int channels)
    {
        bridge::Audio audio;
        audio.sampleRate = sampleRate;
        audio.channels.assign (static_cast<size_t> (channels), std::vector<float> (static_cast<size_t> (frames)));
        for (int c { 0 }; c < channels; ++c)
            for (int64_t i { 0 }; i < frames; ++i)
                audio.channels[static_cast<size_t> (c)][static_cast<size_t> (i)] = static_cast<float> (1 + i) + 0.5f * static_cast<float> (c);
        return audio;
    }

    bridge::GuideWindow window (int64_t offset, int64_t frames)
    {
        bridge::GuideWindow w;
        w.atGuide = true;
        w.offset = offset;
        w.frames = frames;
        return w;
    }

    // out must be: zeros, then dub[dropped...] from 'first', then zeros
    bool placedAs (const bridge::Audio& out, const bridge::Audio& dub, int64_t frames, int64_t first, int64_t dropped)
    {
        if (out.sampleRate != dub.sampleRate || out.channelCount () != dub.channelCount () || static_cast<int64_t> (out.frames ()) != frames)
            return false;
        for (size_t c { 0 }; c < dub.channels.size (); ++c)
            for (int64_t j { 0 }; j < frames; ++j)
            {
                const int64_t i { j - first + dropped };
                const float expected { (j >= first && i >= dropped && i < static_cast<int64_t> (dub.frames ())) ? dub.channels[c][static_cast<size_t> (i)] : 0.0f };
                if (out.channels[c][static_cast<size_t> (j)] != expected)
                {
                    std::printf ("    channel %zu frame %lld: %g, expected %g\n", c, static_cast<long long> (j), out.channels[c][static_cast<size_t> (j)], expected);
                    return false;
                }
            }
        return true;
    }
}

TEST (layout_output_dub_has_no_guide_window)
{
    bridge::JobLayout layout;
    std::string error;
    REQUIRE (bridge::layoutJob (vocalignJob (8.0, 10.0), { silence (48000, 5 * 48000), silence (48000, 5 * 48000) }, layout, error));
    CHECK (! layout.guideWindow.atGuide);
    REQUIRE (bridge::layoutJob (melodyneJob (1.0, 3.0), { silence (44100, 5 * 44100) }, layout, error));
    CHECK (! layout.guideWindow.atGuide);
}

TEST (layout_guide_window_for_a_dub_after_the_guide)
{
    // guide 0.5..2.5 s of its file at beat 8, dub 1.0..3.0 s at beat 10: the dub starts 1 s (48000 frames) later and
    // ends 1 s after the guide, so the window is 2 s + 1 s
    bridge::JobLayout layout;
    std::string error;
    REQUIRE (bridge::layoutJob (guideOutputJob (8.0, 10.0), { silence (48000, 5 * 48000), silence (48000, 5 * 48000) }, layout, error));
    CHECK (layout.guideWindow.atGuide);
    CHECK (layout.guideWindow.offset == 48000);
    CHECK (layout.guideWindow.frames == 3 * 48000);
}

TEST (layout_guide_window_for_a_dub_before_the_guide)
{
    // the dub starts 1 s earlier and ends 1 s earlier: the window is the guide's 2 s, offset -48000
    bridge::JobLayout layout;
    std::string error;
    REQUIRE (bridge::layoutJob (guideOutputJob (10.0, 8.0), { silence (48000, 5 * 48000), silence (48000, 5 * 48000) }, layout, error));
    CHECK (layout.guideWindow.offset == -48000);
    CHECK (layout.guideWindow.frames == 2 * 48000);
}

TEST (layout_guide_window_rounds_the_offset_like_the_playback_start)
{
    // 0.25 beats at 120 bpm = 0.125 s = 5512.5 frames at 44.1 kHz: half away from zero, in both directions
    bridge::JobLayout layout;
    std::string error;
    REQUIRE (bridge::layoutJob (guideOutputJob (8.0, 8.25), { silence (44100, 5 * 44100), silence (44100, 5 * 44100) }, layout, error));
    CHECK (layout.guideWindow.offset == 5513);
    CHECK (layout.guideWindow.offset == layout.regions[1].playbackStart - layout.regions[0].playbackStart);
    CHECK (layout.guideWindow.frames == 5513 + 88200);
    REQUIRE (bridge::layoutJob (guideOutputJob (8.25, 8.0), { silence (44100, 5 * 44100), silence (44100, 5 * 44100) }, layout, error));
    CHECK (layout.guideWindow.offset == -5513);
    CHECK (layout.guideWindow.frames == 88200);
}

TEST (layout_guide_window_rejects_a_dub_that_ends_before_the_guide)
{
    // dub 2 s long at beat 0, guide at beat 4 (2 s later): the dub ends exactly where the guide starts
    CHECK (rejectsWith (guideOutputJob (4.0, 0.0), { silence (44100, 5 * 44100), silence (44100, 5 * 44100) }, "ends before the guide clip starts"));
    CHECK (rejectsWith (guideOutputJob (40.0, 0.0), { silence (44100, 5 * 44100), silence (44100, 5 * 44100) }, "ends before the guide clip starts"));
}

TEST (guide_window_end_rules_and_limits)
{
    bridge::GuideWindow w;
    std::string error;
    // the guide is longer: the window is the guide
    REQUIRE (bridge::guideWindow (100, 1000, 500, 44100, w, error));
    CHECK (w.atGuide && w.offset == 100 && w.frames == 1000);
    // the dub runs past the guide's end: the window ends with the dub
    REQUIRE (bridge::guideWindow (800, 1000, 500, 44100, w, error));
    CHECK (w.frames == 1300);
    // the dub starts after the guide's end (no overlap): silence, then the dub
    REQUIRE (bridge::guideWindow (5000, 1000, 500, 44100, w, error));
    CHECK (w.frames == 5500);
    // negative offsets: the dub's end decides only when it is past the guide's end
    REQUIRE (bridge::guideWindow (-200, 1000, 500, 44100, w, error));
    CHECK (w.offset == -200 && w.frames == 1000);
    REQUIRE (bridge::guideWindow (-200, 100, 500, 44100, w, error));
    CHECK (w.frames == 300);
    // equal starts and lengths: the window is the dub region exactly
    REQUIRE (bridge::guideWindow (0, 500, 500, 44100, w, error));
    CHECK (w.offset == 0 && w.frames == 500);

    bridge::GuideWindow untouched;
    untouched.frames = 77;
    CHECK (! bridge::guideWindow (-500, 1000, 500, 44100, untouched, error));     // ends exactly at the guide's start
    CHECK (error.find ("ends before the guide clip starts") != std::string::npos);
    CHECK (! bridge::guideWindow (-501, 1000, 500, 44100, untouched, error));
    CHECK (! bridge::guideWindow (0, 0, 500, 44100, untouched, error));
    CHECK (! bridge::guideWindow (0, 500, 0, 44100, untouched, error));
    CHECK (! bridge::guideWindow (0, 500, 500, 0, untouched, error));
    // the window limit: 7200 s is fine, one frame more is not
    REQUIRE (bridge::guideWindow (7200 * 1000 - 500, 1000, 500, 1000, w, error));
    CHECK (w.frames == 7200 * 1000);
    CHECK (! bridge::guideWindow (7200 * 1000 - 499, 1000, 500, 1000, untouched, error));
    CHECK (error.find ("too far apart") != std::string::npos);
    CHECK (untouched.frames == 77 && ! untouched.atGuide);
}

TEST (place_at_guide_positive_offset_pads_with_silence)
{
    for (int channels { 1 }; channels <= 2; ++channels)
    {
        const bridge::Audio dub { ramp (44100, 500, channels) };
        bridge::Audio out;
        bridge::GuidePlacement p;
        std::string error;
        // dub inside the guide: zeros before and after
        REQUIRE (bridge::placeAtGuide (dub, window (100, 1000), out, p, error));
        CHECK (p.offsetFrames == 100 && p.droppedFrames == 0);
        CHECK (placedAs (out, dub, 1000, 100, 0));
        // dub past the guide's end: zeros before only
        REQUIRE (bridge::placeAtGuide (dub, window (800, 1300), out, p, error));
        CHECK (p.offsetFrames == 800 && p.droppedFrames == 0);
        CHECK (placedAs (out, dub, 1300, 800, 0));
        // offset 0, same length: the dub itself
        REQUIRE (bridge::placeAtGuide (dub, window (0, 500), out, p, error));
        CHECK (out.channels == dub.channels);
    }
}

TEST (place_at_guide_negative_offset_drops_the_frames_before_the_guide)
{
    for (int channels { 1 }; channels <= 2; ++channels)
    {
        const bridge::Audio dub { ramp (48000, 500, channels) };
        bridge::Audio out;
        bridge::GuidePlacement p;
        std::string error;
        // 200 frames before the guide: dropped; the rest from frame 0, then zeros up to the guide's end
        REQUIRE (bridge::placeAtGuide (dub, window (-200, 1000), out, p, error));
        CHECK (p.offsetFrames == 0 && p.droppedFrames == 200);
        CHECK (placedAs (out, dub, 1000, 0, 200));
        CHECK (out.channels[0][0] == 201.0f);
        CHECK (out.channels[0][299] == 500.0f && out.channels[0][300] == 0.0f);
        // the dub runs past a short guide: no padding at the end
        REQUIRE (bridge::placeAtGuide (dub, window (-200, 300), out, p, error));
        CHECK (placedAs (out, dub, 300, 0, 200));
        // only the last frame is kept
        REQUIRE (bridge::placeAtGuide (dub, window (-499, 10), out, p, error));
        CHECK (p.droppedFrames == 499 && out.channels[0][0] == 500.0f && out.channels[0][1] == 0.0f);
    }
}

TEST (place_at_guide_rejects_what_cannot_be_placed)
{
    const bridge::Audio dub { ramp (44100, 500, 2) };
    bridge::Audio out { ramp (44100, 3, 1) };
    bridge::GuidePlacement p;
    p.offsetFrames = 9;
    std::string error;
    CHECK (! bridge::placeAtGuide (dub, bridge::GuideWindow {}, out, p, error));        // not atGuide
    CHECK (! bridge::placeAtGuide (dub, window (0, 0), out, p, error));
    CHECK (! bridge::placeAtGuide (dub, window (-500, 1000), out, p, error));          // everything before the guide
    CHECK (error.find ("entirely before") != std::string::npos);
    CHECK (! bridge::placeAtGuide (bridge::Audio {}, window (0, 10), out, p, error));
    CHECK (out.frames () == 3 && p.offsetFrames == 9);                                 // untouched
}
