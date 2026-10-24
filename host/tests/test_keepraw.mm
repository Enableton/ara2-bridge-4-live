#include "check.h"
#include "testutil.h"

#include "hostcore/ApplyJob.h"
#include "hostcore/KeepRaw.h"

#import <Foundation/Foundation.h>

#include <cmath>
#include <filesystem>
#include <limits>
#include <string>
#include <vector>

namespace
{
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

    // identical first second, then the original moved 30 samples early
    bridge::Audio earlyTail (const bridge::Audio& original)
    {
        bridge::Audio render { original };
        const bridge::Audio early { tone (original.sampleRate, static_cast<int64_t> (original.frames ()), original.channelCount (), 30.0) };
        for (size_t c { 0 }; c < render.channels.size (); ++c)
            for (size_t i { static_cast<size_t> (original.sampleRate) }; i < original.frames (); ++i)
                render.channels[c][i] = early.channels[c][i];
        return render;
    }

    bridge::Job job (const std::string& dir, const std::string& plugin, bool realign, bool keepRaw)
    {
        bridge::Job j;
        j.id = "job-keepraw";
        j.plugin = plugin;
        j.realign = realign;
        j.dir = dir;
        j.keepRaw = keepRaw;
        return j;
    }

    bridge::RenderFunction returns (const bridge::Audio& audio)
    {
        return [audio] (bridge::Audio& out, std::string&, std::string&) { out = audio; return true; };
    }

    NSDictionary* parseJson (const std::string& text)
    {
        NSData* data = [NSData dataWithBytes: text.data () length: text.size ()];
        id parsed = [NSJSONSerialization JSONObjectWithData: data options: 0 error: nil];
        return [parsed isKindOfClass: [NSDictionary class]] ? parsed : nil;
    }

    bool exists (const std::string& path)
    {
        return std::filesystem::exists (path);
    }

    double number (NSDictionary* dict, NSString* key)
    {
        id value = dict[key];
        return [value isKindOfClass: [NSNumber class]] ? [value doubleValue] : std::numeric_limits<double>::quiet_NaN ();
    }

    std::string text (NSDictionary* dict, NSString* key)
    {
        id value = dict[key];
        return [value isKindOfClass: [NSString class]] ? std::string { [value UTF8String] } : std::string { "<not a string>" };
    }
}

TEST (keepraw_writes_a_raw_render_as_float_wav)
{
    const std::string dir { makeTempDir ("keepraw_wav") };
    bridge::Audio audio { tone (48000, 4800, 2) };
    audio.channels[1][7] = 1.5f;        // a float WAV keeps values beyond full scale
    std::string error;
    REQUIRE (bridge::writeRawRender (dir, 2, audio, error));
    CHECK (bridge::rawRenderPath (dir, 2) == dir + "/render-raw-2.wav");
    CHECK (! exists (dir + "/render-raw-2.wav.tmp"));

    bridge::Audio back;
    REQUIRE (bridge::readWav (dir + "/render-raw-2.wav", back, error));
    CHECK (back.sampleRate == 48000);
    CHECK (back.channels == audio.channels);

    // replaced on a second write (Apply again in the window)
    REQUIRE (bridge::writeRawRender (dir, 2, tone (48000, 100, 1), error));
    REQUIRE (bridge::readWav (dir + "/render-raw-2.wav", back, error));
    CHECK (back.frames () == 100 && back.channelCount () == 1);

    // a missing folder fails with a reason and leaves nothing behind
    error.clear ();
    CHECK (! bridge::writeRawRender (dir + "/missing", 1, audio, error));
    CHECK (! error.empty ());
    CHECK (! exists (dir + "/missing"));
}

TEST (keepraw_realign_debug_json_has_the_details)
{
    const bridge::Audio original { tone (44100, 2 * 44100, 1) };
    bridge::Audio out;
    const auto result { bridge::realign (original, earlyTail (original), bridge::RealignParams {}, out) };
    REQUIRE (result.applied);

    bridge::RealignDebugInfo info;
    info.jobId = "id \"quoted\" \\ \n\x01 end";
    info.sampleRate = 44100;
    info.frames = 2 * 44100;
    info.sourceStartFrame = 12345;
    info.seconds = 0.25;
    info.reason = "applied";
    NSDictionary* root = parseJson (bridge::realignDebugJson (result, info));
    REQUIRE (root != nil);
    CHECK (number (root, @"version") == 1.0);
    CHECK (text (root, @"jobId") == info.jobId);
    CHECK (number (root, @"sampleRate") == 44100.0);
    CHECK (number (root, @"frames") == 2.0 * 44100);
    CHECK (number (root, @"sourceStartFrame") == 12345.0);
    CHECK (number (root, @"realignSeconds") == 0.25);
    CHECK ([root[@"applied"] isEqual: @YES]);
    CHECK ([root[@"nothingToDo"] isEqual: @NO]);
    CHECK ([root[@"inconsistent"] isEqual: @NO]);
    CHECK ([root[@"unstable"] isEqual: @NO]);
    CHECK (text (root, @"reason") == "applied");
    CHECK (text (root, @"note") == result.note);

    NSDictionary* params = root[@"params"];
    REQUIRE ([params isKindOfClass: [NSDictionary class]]);
    CHECK (params.count == 17);
    CHECK (number (params, @"windowSec") == result.params.windowSec);
    CHECK (number (params, @"maxShift") == result.params.maxShift);
    CHECK (number (params, @"classifySwitchBlocks") == result.params.classifySwitchBlocks);
    CHECK (number (params, @"minSupportSegments") == result.params.minSupportSegments);
    CHECK (number (params, @"minSupportSeconds") == result.params.minSupportSeconds);
    CHECK (number (params, @"minSupportFraction") == result.params.minSupportFraction);
    CHECK (number (params, @"singleSegmentSupportSeconds") == result.params.singleSegmentSupportSeconds);
    CHECK (number (params, @"maxSwitchesPerSecond") == result.params.maxSwitchesPerSecond);

    NSArray* support = root[@"support"];
    REQUIRE ([support isKindOfClass: [NSArray class]] && support.count == result.support.size () && support.count > 0);
    for (NSUInteger k { 0 }; k < support.count; ++k)
    {
        const auto& s { result.support[k] };
        CHECK (std::fabs (number (support[k], @"shift") - s.shift) < 1e-6);
        CHECK (number (support[k], @"segments") == static_cast<double> (s.segments));
        CHECK (std::fabs (number (support[k], @"seconds") - s.seconds) < 1e-6);
        CHECK ([support[k][@"kept"] isEqual: s.kept ? @YES : @NO]);
    }

    NSArray* candidates = root[@"candidates"];
    REQUIRE ([candidates isKindOfClass: [NSArray class]] && candidates.count == result.candidates.size ());
    CHECK ([candidates[0] doubleValue] == 0.0);
    CHECK (std::fabs ([candidates[1] doubleValue] - 30.0) < 0.05);

    NSArray* pieces = root[@"pieces"];
    REQUIRE ([pieces isKindOfClass: [NSArray class]] && pieces.count == result.pieces.size ());
    CHECK (number (root, @"pieceCount") == static_cast<double> (result.pieces.size ()));
    CHECK (number (root, @"movedPieces") == static_cast<double> (result.movedPieces));
    for (NSUInteger k { 0 }; k < pieces.count; ++k)
    {
        CHECK (number (pieces[k], @"start") == static_cast<double> (result.pieces[k].start));
        CHECK (std::fabs (number (pieces[k], @"startSec") - static_cast<double> (result.pieces[k].start) / 44100.0) < 1e-9);
        CHECK (std::fabs (number (pieces[k], @"shift") - result.pieces[k].shift) < 1e-6);
    }

    NSArray* segments = root[@"segments"];
    REQUIRE ([segments isKindOfClass: [NSArray class]] && segments.count == result.segments.size () && segments.count > 0);
    for (NSUInteger k { 0 }; k < segments.count; ++k)
    {
        const auto& s { result.segments[k] };
        CHECK (number (segments[k], @"start") == static_cast<double> (s.start));
        CHECK (number (segments[k], @"end") == static_cast<double> (s.end));
        CHECK (std::fabs (number (segments[k], @"endSec") - static_cast<double> (s.end) / 44100.0) < 1e-9);
        CHECK (std::fabs (number (segments[k], @"shift") - s.shift) < 1e-6);
        CHECK (std::fabs (number (segments[k], @"correlation") - s.correlation) < 1e-6);
    }

    // empty lists, non-finite numbers and an unknown rate stay valid JSON
    bridge::RealignResult empty;
    empty.segments.push_back ({ 0, 10, std::numeric_limits<double>::quiet_NaN (), std::numeric_limits<double>::infinity () });
    bridge::RealignDebugInfo none;
    none.seconds = std::numeric_limits<double>::infinity ();
    NSDictionary* nulls = parseJson (bridge::realignDebugJson (empty, none));
    REQUIRE (nulls != nil);
    CHECK ([nulls[@"realignSeconds"] isEqual: [NSNull null]]);
    CHECK ([nulls[@"candidates"] count] == 0 && [nulls[@"pieces"] count] == 0 && [nulls[@"support"] count] == 0);
    CHECK ([nulls[@"segments"][0][@"shift"] isEqual: [NSNull null]]);
    CHECK ([nulls[@"segments"][0][@"startSec"] isEqual: [NSNull null]]);
}

TEST (keepraw_apply_writes_realign_debug_json_for_a_realigned_job)
{
    const std::string dir { makeTempDir ("keepraw_apply") };
    const bridge::Audio original { tone (44100, 2 * 44100, 2) };
    std::vector<std::string> lines;
    const auto info { bridge::applyJob (job (dir, "melodyne", true, true), original, 77, returns (earlyTail (original)), true,
                                        [&] (const std::string& line) { lines.push_back (line); }) };
    REQUIRE (info.status == "ok");
    CHECK (info.realignApplied);
    CHECK (! exists (dir + "/realign-debug.json.tmp"));
    NSDictionary* root = parseJson (readTextFile (dir + "/realign-debug.json"));
    REQUIRE (root != nil);
    CHECK (text (root, @"jobId") == "job-keepraw");
    CHECK (text (root, @"reason") == info.realignReason);
    CHECK (number (root, @"sourceStartFrame") == 77.0);
    CHECK (number (root, @"frames") == 2.0 * 44100);
    CHECK (number (root, @"realignSeconds") >= 0.0);
    CHECK ([root[@"segments"] count] >= info.shifts.size ());      // as detected, before clamping
    CHECK ([root[@"movedPieces"] intValue] >= 1);
    REQUIRE (lines.size () == 1);
    CHECK (lines[0] == "keepRaw: wrote " + dir + "/realign-debug.json");
    // the raw renders are JobRender's: applyJob never writes them
    CHECK (! exists (dir + "/render-raw-1.wav"));

    // an unedited render: written too (nothing to do)
    const std::string plain { makeTempDir ("keepraw_apply_plain") };
    REQUIRE (bridge::applyJob (job (plain, "melodyne", true, true), original, 0, returns (original), true, [] (const std::string&) {}).status == "ok");
    NSDictionary* nothing = parseJson (readTextFile (plain + "/realign-debug.json"));
    REQUIRE (nothing != nil);
    CHECK (text (nothing, @"reason") == "nothing-to-do");
    CHECK ([nothing[@"candidates"] count] == 1);
}

TEST (keepraw_apply_writes_nothing_extra_when_off_or_without_realignment)
{
    const bridge::Audio original { tone (44100, 2 * 44100, 1) };
    struct Case
    {
        std::string plugin;
        bool realign, keepRaw;
    };
    for (const Case& c : { Case { "melodyne", true, false }, Case { "melodyne", false, true }, Case { "vocalign", false, true } })
    {
        const std::string dir { makeTempDir ("keepraw_off_" + c.plugin + std::to_string (c.realign) + std::to_string (c.keepRaw)) };
        std::vector<std::string> lines;
        const auto info { bridge::applyJob (job (dir, c.plugin, c.realign, c.keepRaw), original, 0, returns (earlyTail (original)), true,
                                            [&] (const std::string& line) { lines.push_back (line); }) };
        CHECK (info.status == "ok");
        CHECK (! exists (dir + "/realign-debug.json"));
        CHECK (lines.empty ());
        size_t files { 0 };
        for (const auto& entry : std::filesystem::directory_iterator (dir))
        {
            const std::string name { entry.path ().filename ().string () };
            CHECK (name == "result.wav" || name == "result.json");
            ++files;
        }
        CHECK (files == 2);
    }
}

TEST (keepraw_a_failed_debug_write_is_only_logged)
{
    const std::string dir { makeTempDir ("keepraw_fail") };
    std::filesystem::create_directories (dir + "/realign-debug.json/blocked");     // a folder in the way: the rename fails
    const bridge::Audio original { tone (44100, 2 * 44100, 1) };
    std::vector<std::string> lines;
    const auto info { bridge::applyJob (job (dir, "melodyne", true, true), original, 0, returns (earlyTail (original)), true,
                                        [&] (const std::string& line) { lines.push_back (line); }) };
    CHECK (info.status == "ok");
    CHECK (info.realignApplied);
    CHECK (exists (dir + "/result.wav") && exists (dir + "/result.json"));
    CHECK (! exists (dir + "/realign-debug.json.tmp"));
    REQUIRE (lines.size () == 1);
    CHECK (lines[0].rfind ("warning: keepRaw: cannot rename ", 0) == 0);
}
