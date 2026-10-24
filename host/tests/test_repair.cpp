#include "check.h"

#include "hostcore/RenderRepair.h"

#include <cmath>
#include <cstdint>
#include <numeric>
#include <utility>
#include <vector>

namespace
{
    bridge::Audio voice (int64_t frames, int channels)
    {
        bridge::Audio audio;
        audio.sampleRate = 44100;
        audio.channels.assign (static_cast<size_t> (channels), std::vector<float> (static_cast<size_t> (frames)));
        for (int c { 0 }; c < channels; ++c)
            for (int64_t i { 0 }; i < frames; ++i)
            {
                const double t { static_cast<double> (i) / 44100.0 };
                audio.channels[static_cast<size_t> (c)][static_cast<size_t> (i)]
                    = static_cast<float> (0.2 * std::sin (2.0 * M_PI * 220.0 * t + c + 0.3) + 0.05 * std::sin (2.0 * M_PI * 3100.0 * t));
            }
        return audio;
    }

    // what Melodyne does: one frame doubled in every channel
    void doubleFrame (bridge::Audio& audio, size_t frame)
    {
        for (auto& channel : audio.channels)
            channel[frame] *= 2.0f;
    }

    // the grids BridgeHost uses: 4096 from the region start, 3001 with a pre-roll of 1000
    bridge::RepairParams grids ()
    {
        bridge::RepairParams params;
        params.firstGrid = { 4096, 0 };
        params.secondGrid = { 3001, 1000 };
        return params;
    }
}

TEST (repair_fixes_a_doubled_sample_in_either_render)
{
    const bridge::Audio clean { voice (20000, 2) };
    bridge::Audio a { clean }, b { clean };
    doubleFrame (a, 4096);              // a block start of the first grid
    doubleFrame (b, 3001 * 3 - 1000);   // a block start of the second grid
    const auto result { bridge::repairRenderGlitches (a, b, grids ()) };
    CHECK ((result.repairedAt == std::vector<int64_t> { 4096, 8003 }));
    CHECK (result.differingStretches == 0);
    CHECK (result.diagnostics.empty ());
    CHECK (a.channels == clean.channels);
}

TEST (repair_handles_the_first_and_the_last_frame)
{
    const bridge::Audio clean { voice (11005, 2) };
    bridge::Audio a { clean }, b { clean };
    doubleFrame (a, 0);                 // the first grid starts at frame 0, the second does not
    doubleFrame (b, 11004);             // the last frame: (1000 + 11004) % 3001 == 0
    const auto result { bridge::repairRenderGlitches (a, b, grids ()) };
    CHECK ((result.repairedAt == std::vector<int64_t> { 0, 11004 }));
    CHECK (a.channels == clean.channels);
}

TEST (repair_leaves_material_both_renders_agree_on_untouched)
{
    bridge::Audio a { voice (10000, 2) };
    for (size_t i { 3000 }; i < 6000; ++i)
        a.channels[0][i] = a.channels[1][i] = 0.7f * std::sin (static_cast<float> (i) * 0.3f);    // "edited"
    bridge::Audio b { a };
    for (size_t i { 0 }; i < b.frames (); i += 5)
        b.channels[1][i] = std::nextafter (b.channels[1][i], 1.0f);                             // ulp noise
    const bridge::Audio before { a };
    const auto result { bridge::repairRenderGlitches (a, b, grids ()) };
    CHECK (result.repairedAt.empty ());
    CHECK (result.differingStretches == 0);
    CHECK (a.channels == before.channels);
}

TEST (repair_needs_the_doubled_signature)
{
    const bridge::Audio clean { voice (10000, 2) };
    bridge::Audio a { clean }, b { clean };
    for (auto& channel : a.channels)
        channel[4096] += 0.05f;                     // a block start, but not doubled
    a.channels[1][8192] *= 2.0f;                    // doubled in one channel only
    const bridge::Audio before { a };
    const auto result { bridge::repairRenderGlitches (a, b, grids ()) };
    CHECK (result.repairedAt.empty ());
    CHECK (result.differingStretches == 2);
    CHECK (! result.diagnostics.empty ());
    CHECK (a.channels == before.channels);
}

TEST (repair_needs_a_block_start_in_exactly_one_render)
{
    const bridge::Audio clean { voice (20000, 1) };
    bridge::Audio a { clean }, b { clean };
    doubleFrame (a, 5000);                          // no block start in either grid
    bridge::RepairParams same;
    same.firstGrid = { 4096, 0 };
    same.secondGrid = { 4096, 0 };
    bridge::Audio a2 { clean };
    doubleFrame (a2, 4096);                         // both grids start here
    const auto result { bridge::repairRenderGlitches (a, b, grids ()) };
    const auto result2 { bridge::repairRenderGlitches (a2, b, same) };
    CHECK (result.repairedAt.empty ());
    CHECK (result2.repairedAt.empty ());
    CHECK (a.channels[0][5000] == 2.0f * clean.channels[0][5000]);
}

TEST (repair_works_inside_a_long_difference_and_reports_it)
{
    // edited material that depends on the block size (small differences), with a glitch in the middle
    const bridge::Audio clean { voice (12000, 2) };
    bridge::Audio a { clean }, b { clean };
    for (size_t i { 3000 }; i < 6000; ++i)
        for (auto& channel : b.channels)
            channel[i] += 1e-4f * std::sin (static_cast<float> (i));
    doubleFrame (a, 4096);
    const auto result { bridge::repairRenderGlitches (a, b, grids ()) };
    CHECK ((result.repairedAt == std::vector<int64_t> { 4096 }));
    CHECK (std::fabs (a.channels[0][4096] - clean.channels[0][4096]) < 1e-3f);
    CHECK (result.differingStretches >= 1);
    CHECK (! result.diagnostics.empty ());
    for (size_t i { 3000 }; i < 6000; ++i)                       // the rest of 'a' kept as rendered
        if (i != 4096)
            CHECK (a.channels[0][i] == clean.channels[0][i]);
}

TEST (repair_skips_a_glitch_whose_neighbours_differ_too)
{
    const bridge::Audio clean { voice (10000, 1) };
    bridge::Audio a { clean }, b { clean };
    doubleFrame (a, 4096);
    b.channels[0][4097] += 0.5f * std::fabs (clean.channels[0][4096]);
    const auto result { bridge::repairRenderGlitches (a, b, grids ()) };
    CHECK (result.repairedAt.empty ());
}

TEST (repair_works_on_mono_and_skips_renders_of_different_shape)
{
    const bridge::Audio clean { voice (8192 + 10, 1) };
    bridge::Audio a { clean }, b { clean };
    doubleFrame (a, 8192);
    CHECK (bridge::repairRenderGlitches (a, b, grids ()).repairedAt.size () == 1);
    CHECK (a.channels == clean.channels);

    bridge::Audio c { voice (1000, 2) };
    const bridge::Audio d { voice (999, 2) };
    const bridge::Audio before { c };
    const auto result { bridge::repairRenderGlitches (c, d, grids ()) };
    CHECK (! result.diagnostics.empty ());
    CHECK (c.channels == before.channels);
}

TEST (block_grid_marks_block_starts)
{
    const bridge::BlockGrid grid { 4096, 100 };
    CHECK (grid.startsBlock (3996));
    CHECK (grid.startsBlock (3996 + 4096));
    CHECK (! grid.startsBlock (0));
    CHECK ((bridge::BlockGrid { 3001, -5 }.startsBlock (5)));
    CHECK (! bridge::BlockGrid {}.startsBlock (0));
}

TEST (pre_roll_keeps_block_starts_from_coinciding_inside_the_region)
{
    // small grids, checked by brute force: 8 and 5 coincide every 40 frames
    for (int64_t frames : { 1, 7, 20, 39, 40 })
    {
        int64_t at { 0 };
        const bridge::BlockGrid first { 8, 3 };
        const int k { bridge::chooseSecondPreRoll (frames, first, 5, 2, &at) };
        const bridge::BlockGrid second { 5, 2 + k };
        int64_t firstHit { -1 };
        for (int64_t f { 0 }; f < 200 && firstHit < 0; ++f)
            if (first.startsBlock (f) && second.startsBlock (f))
                firstHit = f;
        CHECK (firstHit == at);
        // the first grid starts blocks at 5, 13, 21, 29, 37, one in each residue modulo 5, so a region of
        // more than 37 frames always contains a coincidence
        if (frames <= 37)
            CHECK (at >= frames);
        else
            CHECK (at == 37);
        CHECK (k >= 0 && k < 5);
    }

    // the real grids: region frame 0 is a block start of the first render only
    int64_t at { 0 };
    const int k { bridge::chooseSecondPreRoll (20 * 44100, { 4096, 0 }, 3001, 0, &at) };
    CHECK (k > 0);
    CHECK (at >= 20 * 44100);
    CHECK ((! bridge::BlockGrid { 3001, k }.startsBlock (0)));

    // a region longer than the common period cannot avoid coincidences; the first one is as late as possible
    const int64_t period { 4096LL * 3001 };
    bridge::chooseSecondPreRoll (period + 10, { 4096, 0 }, 3001, 0, &at);
    CHECK (at == 4096LL * 3000);
    CHECK (bridge::chooseSecondPreRoll (100, { 4096, 0 }, 2048, 0) == 0);    // not coprime
}

namespace
{
    // a steady stretch around 'frame' (level 'level' in every channel) so the tests control every value
    void flatten (bridge::Audio& audio, size_t frame, float level)
    {
        for (auto& channel : audio.channels)
            for (size_t i { frame - 3 }; i <= frame + 3; ++i)
                channel[i] = level;
    }

    // adds a legitimate difference (edited material rendered with another block size) at 'frame' +- 2
    void addNoise (bridge::Audio& audio, size_t frame, float amount)
    {
        for (auto& channel : audio.channels)
            for (size_t i { frame - 2 }; i <= frame + 2; ++i)
                channel[i] += (i % 2 == 0) ? amount : -amount;
    }
}

TEST (repair_tolerance_grows_with_the_difference_next_to_the_glitch)
{
    // the renders differ by 3% of the level around the glitch and at it: a fixed 1% tolerance misses it
    bridge::Audio a { voice (10000, 2) };
    flatten (a, 4096, 0.2f);
    bridge::Audio b { a };
    addNoise (a, 4096, 0.006f);
    const float expected { b.channels[0][4096] };
    doubleFrame (a, 4096);
    const auto result { bridge::repairRenderGlitches (a, b, grids ()) };
    CHECK ((result.repairedAt == std::vector<int64_t> { 4096 }));
    CHECK (a.channels[0][4096] == expected);
    CHECK (a.channels[1][4096] == expected);
}

TEST (repair_tolerance_without_neighbour_differences_stays_at_one_percent)
{
    bridge::Audio a { voice (10000, 1) };
    flatten (a, 4096, 0.2f);
    const bridge::Audio b { a };
    a.channels[0][4096] = 2.0f * 0.2f * 1.03f;      // 3% off the doubled value, neighbours identical
    const auto result { bridge::repairRenderGlitches (a, b, grids ()) };
    CHECK (result.repairedAt.empty ());
    bridge::Audio c { b };
    c.channels[0][4096] = 2.0f * 0.2f * 1.004f;     // 0.4% off (0.8 x the 1% of the level): repaired
    CHECK ((bridge::repairRenderGlitches (c, b, grids ()).repairedAt == std::vector<int64_t> { 4096 }));
}

TEST (repair_never_takes_one_and_a_half_or_three_and_a_half_times_for_doubled)
{
    // neighbours differ by just under the isolation limit (0.25 x the difference at the frame), which is
    // where the grown tolerance is largest
    for (const float ratio : { 1.5f, 3.5f })
    {
        bridge::Audio a { voice (10000, 2) };
        flatten (a, 4096, 0.2f);
        bridge::Audio b { a };
        const float d { (ratio - 1.0f) * 0.2f };
        for (auto& channel : a.channels)
        {
            channel[4096] = ratio * 0.2f;
            for (const size_t n : { 4094, 4095, 4097, 4098 })
                channel[n] += 0.24f * d;
        }
        const bridge::Audio before { a };
        const auto result { bridge::repairRenderGlitches (a, b, grids ()) };
        CHECK (result.repairedAt.empty ());
        CHECK (a.channels == before.channels);
    }
}
