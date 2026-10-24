#include "check.h"

#include "jobio/Job.h"
#include "realign/Delay.h"
#include "realign/Realign.h"

#include <algorithm>
#include <cmath>
#include <limits>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <string>
#include <vector>

namespace
{
    const double kPi { 3.14159265358979323846 };

    // A fully analytic gliding two-tone signal with a slow envelope plus 12 weak fixed sinusoids,
    // evaluated at (i + offsetSamples). Being analytic it can be moved by a FRACTIONAL number of
    // samples exactly, and the weak sinusoids keep the correlation peak sharp (no periodic ambiguity).
    // The seed (and the channel index) only change the 12 phases, so stereo channels differ.
    bridge::Audio makeSignal (int sampleRate, double seconds, int channels, uint32_t seed, double offsetSamples = 0.0)
    {
        static const double kRippleHz[12] { 1013.7, 1377.3, 1822.9, 2291.1, 2713.5, 3187.7, 3659.3, 4327.9, 5041.1, 5733.7, 6571.3, 7619.9 };
        bridge::Audio audio;
        audio.sampleRate = sampleRate;
        const size_t frames { static_cast<size_t> (seconds * sampleRate) };
        audio.channels.assign (static_cast<size_t> (channels), std::vector<float> (frames));
        for (int c { 0 }; c < channels; ++c)
        {
            double phase[12];
            uint32_t state { seed + static_cast<uint32_t> (c) * 7919U };
            for (double& p : phase)
            {
                state = state * 1664525U + 1013904223U;
                p = 2.0 * kPi * static_cast<double> (state >> 8) / 16777216.0;
            }
            for (size_t i { 0 }; i < frames; ++i)
            {
                const double t { (static_cast<double> (i) + offsetSamples) / sampleRate };
                const double envelope { 0.6 + 0.4 * std::sin (2.0 * kPi * 1.7 * t) };
                const double tone { 0.3 * std::sin (2.0 * kPi * (200.0 * t + 30.0 * t * t)) + 0.2 * std::sin (2.0 * kPi * (400.0 * t + 60.0 * t * t)) };
                double ripple { 0.0 };
                for (int k { 0 }; k < 12; ++k)
                    ripple += 0.02 * std::sin (2.0 * kPi * kRippleHz[k] * t + phase[k]);
                audio.channels[static_cast<size_t> (c)][i] = static_cast<float> (envelope * tone + ripple);
            }
        }
        return audio;
    }

    // Mimics what Melodyne did in the spike: [editStart, editEnd) is a different (edited) tone and
    // everything after it is the same signal moved 'early' samples EARLIER (negative: later).
    // 'early' may be fractional. Samples before editStart are identical to makeSignal(..., 0).
    bridge::Audio makeRender (int sampleRate, double seconds, int channels, uint32_t seed, int64_t editStart, int64_t editEnd, double early)
    {
        bridge::Audio render { makeSignal (sampleRate, seconds, channels, seed, 0.0) };
        const bridge::Audio tail { makeSignal (sampleRate, seconds, channels, seed, early) };
        const int64_t frames { static_cast<int64_t> (render.frames ()) };
        for (size_t c { 0 }; c < render.channels.size (); ++c)
        {
            for (int64_t i { editStart }; i < frames; ++i)
            {
                render.channels[c][static_cast<size_t> (i)] = i >= editEnd
                    ? tail.channels[c][static_cast<size_t> (i)]
                    : static_cast<float> (0.4 * std::sin (2.0 * kPi * 330.0 * static_cast<double> (i) / sampleRate));
            }
        }
        return render;
    }

    // Audio with nothing in common with makeSignal(): a steady 517 Hz tone plus noise.
    bridge::Audio makeUnrelated (int sampleRate, double seconds, uint32_t seed)
    {
        bridge::Audio audio;
        audio.sampleRate = sampleRate;
        const size_t frames { static_cast<size_t> (seconds * sampleRate) };
        audio.channels.assign (1, std::vector<float> (frames));
        uint32_t state { seed };
        for (size_t i { 0 }; i < frames; ++i)
        {
            state = state * 1664525U + 1013904223U;
            const double noise { static_cast<double> (state >> 8) / 8388608.0 - 1.0 };
            audio.channels[0][i] = static_cast<float> (0.3 * std::sin (2.0 * kPi * 517.0 * static_cast<double> (i) / sampleRate) + 0.1 * noise);
        }
        return audio;
    }

    // A sustained note: exactly 118 samples per period (44.1 kHz / 118 = 373.7 Hz), six harmonics,
    // plus a tiny non-periodic ripple. Moving it by a multiple of 118 samples looks (almost) identical.
    std::vector<float> makeHarmonic (size_t frames, double offsetSamples)
    {
        std::vector<float> x (frames);
        for (size_t i { 0 }; i < frames; ++i)
        {
            const double n { static_cast<double> (i) + offsetSamples };
            double v { 0.0 };
            for (int h { 1 }; h <= 6; ++h)
                v += (0.3 / h) * std::sin (2.0 * kPi * h * n / 118.0 + 0.4 * h);
            v += 0.004 * std::sin (2.0 * kPi * 0.0731 * n) + 0.003 * std::sin (2.0 * kPi * 0.2193 * n + 1.0);
            x[i] = static_cast<float> (v);
        }
        return x;
    }

    // signal + independent noise whose RMS follows the signal's local RMS, so that the correlation
    // between the two is about 'correlation' in every window (uniform noise, 512-sample blocks).
    std::vector<float> makeNoisyCopy (const std::vector<float>& signal, double correlation, uint32_t seed)
    {
        const double ratio { std::tan (std::acos (correlation)) };
        std::vector<float> out { signal };
        uint32_t state { seed };
        const size_t block { 512 };
        for (size_t start { 0 }; start < signal.size (); start += block)
        {
            const size_t stop { std::min (signal.size (), start + block) };
            double energy { 0.0 };
            for (size_t i { start }; i < stop; ++i)
                energy += static_cast<double> (signal[i]) * signal[i];
            const double rms { std::sqrt (energy / static_cast<double> (stop - start)) };
            for (size_t i { start }; i < stop; ++i)
            {
                state = state * 1664525U + 1013904223U;
                const double unit { (static_cast<double> (state >> 8) / 8388608.0 - 1.0) * std::sqrt (3.0) };   // RMS 1
                out[i] = static_cast<float> (signal[i] + unit * rms * ratio);
            }
        }
        return out;
    }

    bool isNear (double value, double expected, double tolerance) { return std::fabs (value - expected) <= tolerance; }
}

TEST (detectShifts_reports_zero_for_identical_audio)
{
    const bridge::Audio signal { makeSignal (44100, 3.0, 1, 1) };
    const bridge::RealignParams params;

    const auto segments = bridge::detectShifts (signal.channels[0], signal.channels[0], signal.sampleRate, params);

    REQUIRE (segments.size () == 1);
    CHECK (std::fabs (segments[0].shift) < 0.01);
    CHECK (segments[0].start == 0);
    CHECK (segments[0].end >= static_cast<int64_t> (signal.frames ()) - 2 * 1102);   // within two hops of the end
    CHECK (segments[0].correlation > 0.999);
}

TEST (detectShifts_finds_early_tail_after_an_edit)
{
    const int64_t editStart { 44100 };           // 1.0 s
    const int64_t editEnd { 61740 };             // 1.4 s
    const bridge::Audio original { makeSignal (44100, 3.0, 1, 1) };
    const bridge::Audio render { makeRender (44100, 3.0, 1, 1, editStart, editEnd, 30.0) };

    const auto segments = bridge::detectShifts (original.channels[0], render.channels[0], 44100, bridge::RealignParams {});

    REQUIRE (segments.size () == 2);
    CHECK (std::fabs (segments[0].shift) < 0.1);
    CHECK (segments[0].end <= editStart + 2205);        // ends before the edit (one window of slack)
    CHECK_NEAR (segments[1].shift, 30.0, 0.1);          // render is early by 30: it must move LATER by 30
    CHECK (segments[1].start >= editEnd - 2205);
}

TEST (detectShifts_finds_a_fractional_early_tail)
{
    const int64_t editStart { 44100 };
    const int64_t editEnd { 61740 };
    const bridge::Audio original { makeSignal (44100, 3.0, 1, 1) };
    const bridge::Audio render { makeRender (44100, 3.0, 1, 1, editStart, editEnd, 30.75) };

    const auto segments = bridge::detectShifts (original.channels[0], render.channels[0], 44100, bridge::RealignParams {});

    REQUIRE (segments.size () == 2);
    CHECK (std::fabs (segments[0].shift) < 0.1);
    CHECK_NEAR (segments[1].shift, 30.75, 0.1);
    CHECK (segments[1].correlation > 0.999);
}

TEST (detectShifts_ignores_unrelated_audio)
{
    const bridge::Audio a { makeSignal (44100, 2.0, 1, 1) };
    const bridge::Audio b { makeUnrelated (44100, 2.0, 99) };

    const auto segments = bridge::detectShifts (a.channels[0], b.channels[0], 44100, bridge::RealignParams {});

    CHECK (segments.empty ());
}

TEST (detectShifts_skips_silence_without_breaking_a_run)
{
    bridge::Audio a { makeSignal (44100, 3.0, 1, 1) };
    for (size_t i { 44100 }; i < 66150; ++i)      // 0.5 s of digital silence in the middle
        a.channels[0][i] = 0.0f;

    const auto segments = bridge::detectShifts (a.channels[0], a.channels[0], 44100, bridge::RealignParams {});

    REQUIRE (segments.size () == 1);
    CHECK (std::fabs (segments[0].shift) < 0.01);
}

TEST (detectShifts_does_not_mistake_a_period_multiple_for_the_shift)
{
    const size_t frames { 3 * 44100 };
    const std::vector<float> original { makeHarmonic (frames, 0.0) };
    std::vector<float> render { original };
    const std::vector<float> tail { makeHarmonic (frames, 30.0) };      // early by 30
    for (size_t i { 44100 }; i < frames; ++i)
        render[i] = i >= 61740 ? tail[i] : static_cast<float> (0.4 * std::sin (2.0 * kPi * 330.0 * static_cast<double> (i) / 44100.0));

    const auto segments = bridge::detectShifts (original, render, 44100, bridge::RealignParams {});

    REQUIRE (! segments.empty ());
    bool sawTail { false };
    for (const auto& segment : segments)
    {
        const bool plausible { isNear (segment.shift, 0.0, 0.5) || isNear (segment.shift, 30.0, 0.5) };
        if (! plausible)
            std::printf ("    unexpected segment [%lld,%lld) shift %g\n", static_cast<long long> (segment.start), static_cast<long long> (segment.end), segment.shift);
        CHECK (plausible);
        sawTail = sawTail || isNear (segment.shift, 30.0, 0.5);
    }
    CHECK (sawTail);
}

TEST (detectShifts_tolerates_noise_up_to_the_threshold)
{
    const bridge::Audio signal { makeSignal (44100, 3.0, 1, 1) };
    const bridge::RealignParams params;

    const auto tooNoisy = bridge::detectShifts (signal.channels[0], makeNoisyCopy (signal.channels[0], 0.975, 5), 44100, params);
    CHECK (tooNoisy.empty ());

    const auto fine = bridge::detectShifts (signal.channels[0], makeNoisyCopy (signal.channels[0], 0.985, 5), 44100, params);
    REQUIRE (fine.size () == 1);
    CHECK (std::fabs (fine[0].shift) < 0.5);
    CHECK (fine[0].start == 0);
}

TEST (detectShifts_reports_an_edit_without_timing_change_as_two_unshifted_segments)
{
    const int64_t editStart { 44100 };
    const int64_t editEnd { 61740 };
    const bridge::Audio original { makeSignal (44100, 3.0, 1, 1) };
    const bridge::Audio render { makeRender (44100, 3.0, 1, 1, editStart, editEnd, 0.0) };

    const auto segments = bridge::detectShifts (original.channels[0], render.channels[0], 44100, bridge::RealignParams {});

    REQUIRE (segments.size () == 2);
    CHECK (std::fabs (segments[0].shift) < 0.1);
    CHECK (std::fabs (segments[1].shift) < 0.1);
    CHECK (segments[0].end < segments[1].start);        // the edited stretch is the gap
    CHECK (segments[0].end <= editStart + 2205);
    CHECK (segments[1].start >= editEnd - 2205);
}

TEST (detectShifts_handles_a_clip_that_is_early_as_a_whole)
{
    const bridge::Audio original { makeSignal (44100, 3.0, 1, 1) };
    const bridge::Audio render { makeSignal (44100, 3.0, 1, 1, 40.0) };

    const auto segments = bridge::detectShifts (original.channels[0], render.channels[0], 44100, bridge::RealignParams {});

    REQUIRE (segments.size () == 1);
    CHECK (segments[0].start == 0);
    CHECK_NEAR (segments[0].shift, 40.0, 0.1);
}

TEST (detectShifts_rejects_bad_parameters_and_empty_input)
{
    const bridge::Audio signal { makeSignal (44100, 1.0, 1, 1) };
    const std::vector<float>& x { signal.channels[0] };
    const std::vector<float> none;

    CHECK (bridge::detectShifts (x, x, 44100, bridge::RealignParams {}).size () == 1);   // sanity: the defaults do work

    CHECK (bridge::detectShifts (x, x, 0, bridge::RealignParams {}).empty ());
    CHECK (bridge::detectShifts (x, x, -44100, bridge::RealignParams {}).empty ());
    CHECK (bridge::detectShifts (none, x, 44100, bridge::RealignParams {}).empty ());
    CHECK (bridge::detectShifts (x, none, 44100, bridge::RealignParams {}).empty ());

    bridge::RealignParams params;
    params.windowSec = 0.0;
    CHECK (bridge::detectShifts (x, x, 44100, params).empty ());
    params = bridge::RealignParams {};
    params.hopSec = 0.0;
    CHECK (bridge::detectShifts (x, x, 44100, params).empty ());
    params = bridge::RealignParams {};
    params.maxShift = -1;
    CHECK (bridge::detectShifts (x, x, 44100, params).empty ());
    params = bridge::RealignParams {};
    params.minCorrelation = 0.0;
    CHECK (bridge::detectShifts (x, x, 44100, params).empty ());
    params.minCorrelation = 1.5;
    CHECK (bridge::detectShifts (x, x, 44100, params).empty ());
    params = bridge::RealignParams {};
    params.minRunWindows = 0;
    CHECK (bridge::detectShifts (x, x, 44100, params).empty ());
}

TEST (detectShifts_drops_a_single_window_that_matches_at_a_wrong_shift)
{
    const size_t window { 2205 };
    const size_t hop { 1103 };                      // llround (0.025 * 44100)
    const size_t spurious { 12 * hop };             // starts exactly on an analysis window
    const bridge::Audio original { makeSignal (44100, 3.0, 1, 1) };
    const bridge::Audio moved { makeSignal (44100, 3.0, 1, 1, 200.0) };
    bridge::Audio render { original };
    for (size_t i { spurious }; i < spurious + window; ++i)
        render.channels[0][i] = moved.channels[0][i];       // this window alone is early by 200

    const auto segments = bridge::detectShifts (original.channels[0], render.channels[0], 44100, bridge::RealignParams {});

    REQUIRE (! segments.empty ());
    REQUIRE (segments.size () <= 2);
    for (const auto& segment : segments)
        CHECK (std::fabs (segment.shift) < 0.1);
}

TEST (detectShifts_separates_neighbouring_shifts_that_differ_by_more_than_half_a_sample)
{
    const bridge::Audio original { makeSignal (44100, 3.0, 1, 1) };
    const bridge::Audio early10 { makeSignal (44100, 3.0, 1, 1, 10.0) };
    const bridge::Audio early12 { makeSignal (44100, 3.0, 1, 1, 12.5) };
    bridge::Audio render { original };
    for (size_t i { 44100 }; i < 88200; ++i)
        render.channels[0][i] = early10.channels[0][i];
    for (size_t i { 88200 }; i < original.frames (); ++i)
        render.channels[0][i] = early12.channels[0][i];

    const auto segments = bridge::detectShifts (original.channels[0], render.channels[0], 44100, bridge::RealignParams {});

    REQUIRE (segments.size () == 3);
    CHECK_NEAR (segments[0].shift, 0.0, 0.1);
    CHECK_NEAR (segments[1].shift, 10.0, 0.1);
    CHECK_NEAR (segments[2].shift, 12.5, 0.1);
}

TEST (detectShifts_finds_the_peak_for_low_frequency_content)
{
    // Two slow sinusoids: moving them by 2 samples still correlates at 0.9996, higher than the fast-path
    // threshold, but shift 0 is not the peak. The detector must still find shift 2.
    const size_t frames { 4500 };       // just three analysis windows: no time for a wrong first guess to correct itself
    std::vector<float> original (frames), render (frames);
    for (size_t i { 0 }; i < frames; ++i)
    {
        const double n { static_cast<double> (i) };
        original[i] = static_cast<float> (std::sin (2.0 * kPi * 100.0 * n / 44100.0) + 0.5 * std::sin (2.0 * kPi * 37.0 * n / 44100.0 + 1.0));
        render[i] = static_cast<float> (std::sin (2.0 * kPi * 100.0 * (n + 2.0) / 44100.0) + 0.5 * std::sin (2.0 * kPi * 37.0 * (n + 2.0) / 44100.0 + 1.0));
    }

    const auto segments = bridge::detectShifts (original, render, 44100, bridge::RealignParams {});

    REQUIRE (segments.size () == 1);
    CHECK_NEAR (segments[0].shift, 2.0, 0.1);
    CHECK (segments[0].start == 0);
}

TEST (detectShifts_caps_the_analysis_window_at_one_second)
{
    const bridge::Audio signal { makeSignal (44100, 3.0, 1, 1) };
    bridge::RealignParams params;
    params.windowSec = 5.0;         // longer than the clip: would find nothing without the cap

    const auto segments = bridge::detectShifts (signal.channels[0], signal.channels[0], 44100, params);

    REQUIRE (segments.size () == 1);
    CHECK (std::fabs (segments[0].shift) < 0.01);
}

TEST (detectShifts_survives_huge_or_non_finite_window_and_hop)
{
    const bridge::Audio signal { makeSignal (44100, 3.0, 1, 1) };
    const std::vector<float>& x { signal.channels[0] };
    const double inf { std::numeric_limits<double>::infinity () };
    const double nan { std::numeric_limits<double>::quiet_NaN () };

    bridge::RealignParams params;
    params.hopSec = inf;
    CHECK (bridge::detectShifts (x, x, 44100, params).empty ());
    params.hopSec = nan;
    CHECK (bridge::detectShifts (x, x, 44100, params).empty ());
    params = bridge::RealignParams {};
    params.windowSec = inf;
    CHECK (bridge::detectShifts (x, x, 44100, params).empty ());
    params.windowSec = nan;
    CHECK (bridge::detectShifts (x, x, 44100, params).empty ());

    // a huge but finite hop is capped at one second: windows at 0 s, 1 s and 2 s
    params = bridge::RealignParams {};
    params.hopSec = 1e300;
    const auto segments = bridge::detectShifts (x, x, 44100, params);
    REQUIRE (segments.size () == 1);
    CHECK (segments[0].start == 0);
    CHECK (segments[0].end > 88200 && segments[0].end <= static_cast<int64_t> (x.size ()));
    CHECK (std::fabs (segments[0].shift) < 0.01);
}

TEST (detectShifts_does_not_trust_windows_with_non_finite_samples)
{
    const bridge::Audio original { makeSignal (44100, 3.0, 1, 1) };
    std::vector<float> render { original.channels[0] };
    const size_t infIndex { 70000 }, nanIndex { 100000 };
    render[infIndex] = std::numeric_limits<float>::infinity ();
    render[nanIndex] = std::numeric_limits<float>::quiet_NaN ();

    const auto segments = bridge::detectShifts (original.channels[0], render, 44100, bridge::RealignParams {});

    REQUIRE (! segments.empty ());
    for (const auto& segment : segments)
    {
        CHECK (std::isfinite (segment.shift));
        CHECK (std::isfinite (segment.correlation));
        CHECK (segment.start >= 0 && segment.end > segment.start);
        CHECK (! (static_cast<int64_t> (infIndex) >= segment.start && static_cast<int64_t> (infIndex) < segment.end));
        CHECK (! (static_cast<int64_t> (nanIndex) >= segment.start && static_cast<int64_t> (nanIndex) < segment.end));
    }

    // and a non-finite sample in the ORIGINAL must not produce NaN results either
    bridge::Audio bad { original };
    bad.channels[0][50000] = std::numeric_limits<float>::quiet_NaN ();
    for (const auto& segment : bridge::detectShifts (bad.channels[0], original.channels[0], 44100, bridge::RealignParams {}))
    {
        CHECK (std::isfinite (segment.shift));
        CHECK (std::isfinite (segment.correlation));
        CHECK (! (50000 >= segment.start && 50000 < segment.end));
    }
}

TEST (detectShifts_rejects_inconsistent_early_accept_threshold)
{
    const bridge::Audio signal { makeSignal (44100, 1.0, 1, 1) };
    const std::vector<float>& x { signal.channels[0] };
    bridge::RealignParams params;

    params.earlyAcceptCorrelation = 0.9;            // below minCorrelation (0.98)
    CHECK (bridge::detectShifts (x, x, 44100, params).empty ());
    params.earlyAcceptCorrelation = 1.5;
    CHECK (bridge::detectShifts (x, x, 44100, params).empty ());
    params.earlyAcceptCorrelation = std::numeric_limits<double>::quiet_NaN ();
    CHECK (bridge::detectShifts (x, x, 44100, params).empty ());
    params.earlyAcceptCorrelation = 1.0;            // allowed: the fast path is then effectively off
    CHECK (bridge::detectShifts (x, x, 44100, params).size () == 1);
}

TEST (detectShifts_does_not_match_a_polarity_inverted_copy)
{
    // A single chirp with a little noise: its inverted copy looks like a shifted copy at many
    // half-period offsets, giving short chance runs (19 of them with minRunWindows 2).
    const size_t frames { 3 * 44100 };
    std::vector<float> chirp (frames), inverted (frames);
    uint32_t state { 1 };
    for (size_t i { 0 }; i < frames; ++i)
    {
        state = state * 1664525U + 1013904223U;
        const double t { static_cast<double>(i) / 44100.0 };
        chirp[i] = static_cast<float> (0.3 * std::sin (2.0 * kPi * (200.0 * t + 30.0 * t * t)) + 0.05 * (static_cast<double> (state >> 8) / 8388608.0 - 1.0));
        inverted[i] = -chirp[i];
    }

    const auto segments = bridge::detectShifts (chirp, inverted, 44100, bridge::RealignParams {});

    CHECK (segments.size () <= 4);
}

namespace
{
    double maxAbsDiff (const bridge::Audio& a, const bridge::Audio& b, int64_t from, int64_t to)
    {
        double worst { 0.0 };
        for (size_t c { 0 }; c < a.channels.size (); ++c)
            for (int64_t i { from }; i < to; ++i)
                worst = std::max (worst, static_cast<double> (std::fabs (a.channels[c][static_cast<size_t> (i)] - b.channels[c][static_cast<size_t> (i)])));
        return worst;
    }
}

TEST (realign_recovers_a_whole_sample_early_tail_exactly)
{
    const bridge::Audio original { makeSignal (44100, 3.0, 1, 1) };
    const bridge::Audio render { makeRender (44100, 3.0, 1, 1, 44100, 61740, 30.0) };

    bridge::Audio out;
    const auto result = bridge::realign (original, render, bridge::RealignParams {}, out);

    REQUIRE (result.applied);
    REQUIRE (out.frames () == original.frames ());
    CHECK (out.sampleRate == 44100);
    CHECK (maxAbsDiff (out, original, 0, 40000) < 1e-9);                       // before the edit: untouched
    CHECK (maxAbsDiff (out, render, 46000, 50000) < 1e-9);                     // inside the edited note, before the junction: as rendered
    CHECK (maxAbsDiff (out, original, 66150, static_cast<int64_t> (original.frames ())) < 1e-6);   // after the edit: back on the original timeline
}

TEST (realign_recovers_a_fractionally_early_tail)
{
    const bridge::Audio original { makeSignal (44100, 3.0, 1, 1) };
    const bridge::Audio render { makeRender (44100, 3.0, 1, 1, 44100, 61740, 30.75) };

    bridge::Audio out;
    const auto result = bridge::realign (original, render, bridge::RealignParams {}, out);

    REQUIRE (result.applied);
    const int64_t end { static_cast<int64_t> (original.frames ()) };
    const double before { maxAbsDiff (render, original, 66150, end) };
    const double after { maxAbsDiff (out, original, 66150, end) };
    std::printf ("    tail peak error: %g before, %g after\n", before, after);
    CHECK (after < 3e-3);                   // windowed-sinc interpolation error
    CHECK (after * 10.0 < before);          // and clearly better than doing nothing
    CHECK (maxAbsDiff (out, original, 0, 40000) < 1e-9);
}

TEST (realign_recovers_a_late_tail_on_stereo_audio)
{
    const bridge::Audio original { makeSignal (44100, 3.0, 2, 5) };
    const bridge::Audio render { makeRender (44100, 3.0, 2, 5, 44100, 61740, -20.0) };

    bridge::Audio out;
    const auto result = bridge::realign (original, render, bridge::RealignParams {}, out);

    REQUIRE (result.applied);
    REQUIRE (out.channelCount () == 2);
    // The last 20 samples cannot be recovered: a render that is 20 samples late is cut off 20 samples early.
    CHECK (maxAbsDiff (out, original, 66150, static_cast<int64_t> (original.frames ()) - 20) < 1e-6);
    bool sawNegativeShift { false };
    for (const auto& segment : result.segments)
        sawNegativeShift = sawNegativeShift || std::fabs (segment.shift + 20.0) < 0.1;
    CHECK (sawNegativeShift);
}

TEST (realign_handles_unshifted_stretches_inside_the_tail)
{
    // Real Melodyne renders leave some stretches of the tail unshifted (pauses, unpitched sounds).
    // 0-1.0 s as is; 1.0-1.4 s edited; 1.4-2.5 s early by 30; 2.5-2.9 s unshifted; 2.9-4.0 s early by 30 again.
    const int rate { 44100 };
    const bridge::Audio original { makeSignal (rate, 4.0, 1, 3) };
    const bridge::Audio early { makeSignal (rate, 4.0, 1, 3, 30.0) };
    bridge::Audio render { original };
    for (int64_t i { rate }; i < static_cast<int64_t> (original.frames ()); ++i)
    {
        const double t { static_cast<double> (i) / rate };
        float value { early.channels[0][static_cast<size_t> (i)] };
        if (t < 1.4)
            value = static_cast<float> (0.4 * std::sin (2.0 * kPi * 330.0 * static_cast<double> (i) / rate));
        else if (t >= 2.5 && t < 2.9)
            value = original.channels[0][static_cast<size_t> (i)];
        render.channels[0][static_cast<size_t> (i)] = value;
    }

    bridge::Audio out;
    const auto result = bridge::realign (original, render, bridge::RealignParams {}, out);

    REQUIRE (result.applied);
    CHECK (maxAbsDiff (out, original, 0, 40000) < 1e-9);
    CHECK (maxAbsDiff (out, original, static_cast<int64_t> (1.5 * rate), static_cast<int64_t> (2.45 * rate)) < 1e-6);
    CHECK (maxAbsDiff (out, original, static_cast<int64_t> (2.55 * rate), static_cast<int64_t> (2.85 * rate)) < 1e-9);   // snapped to shift 0: exact copy
    CHECK (maxAbsDiff (out, original, static_cast<int64_t> (3.0 * rate), static_cast<int64_t> (4.0 * rate)) < 1e-6);
}

TEST (realign_leaves_an_aligned_render_alone)
{
    const bridge::Audio original { makeSignal (44100, 2.0, 1, 1) };

    bridge::Audio out;
    const auto result = bridge::realign (original, original, bridge::RealignParams {}, out);

    CHECK (! result.applied);
    CHECK (result.nothingToDo);
    CHECK (! result.note.empty ());
    CHECK (out.channels == original.channels);
}

TEST (realign_gives_up_on_unrelated_audio)
{
    const bridge::Audio original { makeSignal (44100, 2.0, 1, 1) };
    const bridge::Audio render { makeUnrelated (44100, 2.0, 99) };

    bridge::Audio out;
    const auto result = bridge::realign (original, render, bridge::RealignParams {}, out);

    CHECK (! result.applied);
    CHECK (! result.nothingToDo);
    CHECK (! result.note.empty ());
    CHECK (out.channels == render.channels);        // nothing is changed silently
}

TEST (realign_reports_candidates_pieces_and_the_parameters_used)
{
    // the layout of realign_handles_unshifted_stretches_inside_the_tail: shift 0, edit, 30 early, 0, 30 early
    const int rate { 44100 };
    const bridge::Audio original { makeSignal (rate, 4.0, 1, 3) };
    const bridge::Audio early { makeSignal (rate, 4.0, 1, 3, 30.0) };
    bridge::Audio render { original };
    for (int64_t i { rate }; i < static_cast<int64_t> (original.frames ()); ++i)
    {
        const double t { static_cast<double> (i) / rate };
        float value { early.channels[0][static_cast<size_t> (i)] };
        if (t < 1.4)
            value = static_cast<float> (0.4 * std::sin (2.0 * kPi * 330.0 * static_cast<double> (i) / rate));
        else if (t >= 2.5 && t < 2.9)
            value = original.channels[0][static_cast<size_t> (i)];
        render.channels[0][static_cast<size_t> (i)] = value;
    }

    bridge::RealignParams params;
    params.crossfadeSec = 1.0;      // out of range: the default is used and reported
    bridge::Audio out;
    const auto result = bridge::realign (original, render, params, out);

    REQUIRE (result.applied);
    CHECK_NEAR (result.params.crossfadeSec, bridge::RealignParams {}.crossfadeSec, 1e-12);
    CHECK_NEAR (result.params.minCorrelation, bridge::RealignParams {}.minCorrelation, 1e-12);
    REQUIRE (result.candidates.size () == 2);
    CHECK (result.candidates[0] == 0.0);
    CHECK_NEAR (result.candidates[1], 30.0, 0.05);
    // 0 (prefix and edit), 30, 0, 30
    REQUIRE (result.pieces.size () == 4);
    CHECK (result.movedPieces == 2);
    CHECK (result.pieces[0].start == 0 && result.pieces[0].shift == 0.0);
    CHECK_NEAR (result.pieces[1].shift, 30.0, 0.05);
    CHECK (result.pieces[2].shift == 0.0);
    CHECK_NEAR (result.pieces[3].shift, 30.0, 0.05);
    CHECK (result.pieces[1].start > static_cast<int64_t> (1.0 * rate) && result.pieces[1].start < static_cast<int64_t> (1.5 * rate));
    CHECK (result.pieces[2].start > static_cast<int64_t> (2.4 * rate) && result.pieces[2].start < static_cast<int64_t> (2.6 * rate));
    CHECK (result.pieces[3].start > static_cast<int64_t> (2.8 * rate) && result.pieces[3].start < static_cast<int64_t> (3.0 * rate));
    for (size_t k { 1 }; k < result.pieces.size (); ++k)
        CHECK (result.pieces[k].start > result.pieces[k - 1].start);

    // an aligned render: candidates {0}, no pieces; unrelated audio: no candidates
    const auto aligned { bridge::realign (original, original, bridge::RealignParams {}, out) };
    CHECK (aligned.nothingToDo && aligned.candidates == std::vector<double> { 0.0 } && aligned.pieces.empty () && aligned.movedPieces == 0);
    const auto unrelated { bridge::realign (original, makeUnrelated (rate, 4.0, 99), bridge::RealignParams {}, out) };
    CHECK (! unrelated.applied && unrelated.candidates.empty () && unrelated.pieces.empty ());
}

TEST (realign_pads_or_trims_the_render_to_the_original_length)
{
    const bridge::Audio original { makeSignal (44100, 2.0, 1, 1) };
    bridge::Audio shortRender { original };
    shortRender.channels[0].resize (original.frames () - 1000);

    bridge::Audio out;
    bridge::realign (original, shortRender, bridge::RealignParams {}, out);

    CHECK (out.frames () == original.frames ());
}

TEST (realign_leaves_the_edited_note_exactly_as_rendered)
{
    // The edited note (1.0-1.4 s) is not a copy of the original at any shift, so it must come out untouched,
    // and the switch to the moved tail has to happen after it, not in it.
    const bridge::Audio original { makeSignal (44100, 3.0, 1, 1) };
    const bridge::Audio render { makeRender (44100, 3.0, 1, 1, 44100, 61740, 30.0) };

    bridge::Audio out;
    REQUIRE (bridge::realign (original, render, bridge::RealignParams {}, out).applied);
    CHECK (maxAbsDiff (out, render, 0, 61740) == 0.0);
}

TEST (realign_crossfades_the_switch_to_the_moved_tail)
{
    // Where the render switches from "as rendered" to "moved by 30 samples" the two copies differ by up to ~0.4.
    // Without a crossfade the output jumps by that much (largest sample step 0.188 in this test); the 3 ms
    // crossfade spreads it over ~130 samples (0.090). The signal's own largest step in this stretch is far lower.
    const bridge::Audio original { makeSignal (44100, 3.0, 1, 1) };
    const bridge::Audio render { makeRender (44100, 3.0, 1, 1, 44100, 61740, 30.0) };

    bridge::Audio out;
    REQUIRE (bridge::realign (original, render, bridge::RealignParams {}, out).applied);
    double worstStep { 0.0 };
    for (int64_t i { 61000 }; i < 64000; ++i)
        worstStep = std::max (worstStep, static_cast<double> (std::fabs (out.channels[0][static_cast<size_t> (i)] - out.channels[0][static_cast<size_t> (i - 1)])));
    std::printf ("    largest step across the switch: %g\n", worstStep);
    CHECK (worstStep < 0.12);

    bridge::RealignParams hardCut;
    hardCut.crossfadeSec = 0.0;
    bridge::Audio cut;
    REQUIRE (bridge::realign (original, render, hardCut, cut).applied);
    double hardStep { 0.0 };
    for (int64_t i { 61000 }; i < 64000; ++i)
        hardStep = std::max (hardStep, static_cast<double> (std::fabs (cut.channels[0][static_cast<size_t> (i)] - cut.channels[0][static_cast<size_t> (i - 1)])));
    CHECK (hardStep > 0.15);        // the test can tell the two apart
}

TEST (realign_puts_the_tail_back_soon_after_the_edit)
{
    // The tail matches the original from sample 61740 + 30 (the edit ends at 61740, the render is early by 30).
    // The first 5 ms block that fits completely starts at 61880 and its crossfade ends 66 samples later.
    const bridge::Audio original { makeSignal (44100, 3.0, 1, 1) };
    const bridge::Audio render { makeRender (44100, 3.0, 1, 1, 44100, 61740, 30.0) };

    bridge::Audio out;
    REQUIRE (bridge::realign (original, render, bridge::RealignParams {}, out).applied);
    CHECK (maxAbsDiff (out, original, 62000, static_cast<int64_t> (original.frames ())) < 1e-6);
}

TEST (realign_rejects_different_sample_rates)
{
    const bridge::Audio original { makeSignal (44100, 2.0, 1, 1) };
    bridge::Audio render { makeRender (44100, 2.0, 1, 1, 30000, 40000, 30.0) };
    render.sampleRate = 48000;

    bridge::Audio out;
    const auto result = bridge::realign (original, render, bridge::RealignParams {}, out);

    CHECK (! result.applied);
    CHECK (! result.note.empty ());
    CHECK (out.channels == render.channels);
    CHECK (out.sampleRate == 48000);
}

TEST (realign_treats_a_few_hundredths_of_a_sample_as_no_shift)
{
    const bridge::Audio original { makeSignal (44100, 3.0, 1, 1) };
    const bridge::Audio render { makeSignal (44100, 3.0, 1, 1, 0.03) };      // the whole clip 0.03 samples early

    bridge::Audio out;
    const auto result = bridge::realign (original, render, bridge::RealignParams {}, out);

    CHECK (! result.applied);
    CHECK (out.channels == render.channels);
}

TEST (realign_ignores_out_of_range_crossfade_lengths)
{
    const bridge::Audio original { makeSignal (44100, 3.0, 1, 1) };
    const bridge::Audio render { makeRender (44100, 3.0, 1, 1, 44100, 61740, 30.0) };

    for (const double crossfade : { 1e300, -1.0, 0.5, std::numeric_limits<double>::quiet_NaN (), std::numeric_limits<double>::infinity () })
    {
        bridge::RealignParams params;
        params.crossfadeSec = crossfade;
        bridge::Audio out;
        const auto result = bridge::realign (original, render, params, out);

        REQUIRE (result.applied);
        CHECK (maxAbsDiff (out, render, 0, 61740) == 0.0);      // an absurd fade must not eat the note or the start
        CHECK (maxAbsDiff (out, original, 62000, static_cast<int64_t> (original.frames ())) < 1e-6);
    }
}

TEST (realign_ignores_out_of_range_silence_thresholds)
{
    const bridge::Audio original { makeSignal (44100, 3.0, 1, 1) };
    const bridge::Audio render { makeRender (44100, 3.0, 1, 1, 44100, 61740, 30.0) };

    // A NaN, zero, negative or huge threshold would make every block "silent" or "loud"; all fall back to the default.
    for (const double silence : { std::numeric_limits<double>::quiet_NaN (), std::numeric_limits<double>::infinity (), 0.0, -1.0, 1e300 })
    {
        bridge::RealignParams params;
        params.silenceRms = silence;
        bridge::Audio out;
        const auto result = bridge::realign (original, render, params, out);

        REQUIRE (result.applied);
        CHECK (maxAbsDiff (out, original, 62000, static_cast<int64_t> (original.frames ())) < 1e-6);
    }
}

TEST (realign_does_not_spread_non_finite_samples)
{
    // Early by a fractional amount, so the 32-tap filter is used. One NaN and one infinity in the tail may spoil
    // the samples that read them (32 outputs each) but nothing else.
    const bridge::Audio original { makeSignal (44100, 3.0, 1, 1) };
    bridge::Audio render { makeRender (44100, 3.0, 1, 1, 44100, 61740, 30.75) };
    render.channels[0][90000] = std::numeric_limits<float>::quiet_NaN ();
    render.channels[0][100000] = std::numeric_limits<float>::infinity ();

    bridge::Audio out;
    REQUIRE (bridge::realign (original, render, bridge::RealignParams {}, out).applied);

    for (const float value : out.channels[0])
        REQUIRE (std::isfinite (value));
    CHECK (maxAbsDiff (out, original, 70000, 90000 + 30 - 20) < 3e-3);
    CHECK (maxAbsDiff (out, original, 90000 + 30 + 20, 100000 + 30 - 20) < 3e-3);
    CHECK (maxAbsDiff (out, original, 100000 + 30 + 20, 132300) < 3e-3);
}

TEST (realign_works_on_a_different_layout_of_edits_and_shifts)
{
    // Not the layout the thresholds were tuned on: stereo, LATE by a fractional 17.4 samples, two edited notes,
    // an unshifted pause in between.
    //   0 - 1.0 s   as is
    //   1.0 - 1.6 s edited note A (220 Hz)
    //   1.6 - 2.4 s late by 17.4
    //   2.4 - 2.8 s unshifted (a pause)
    //   2.8 - 3.1 s edited note B (440 Hz)
    //   3.1 - 4.5 s late by 17.4
    const int rate { 44100 };
    const bridge::Audio original { makeSignal (rate, 4.5, 2, 11) };
    const bridge::Audio late { makeSignal (rate, 4.5, 2, 11, -17.4) };
    bridge::Audio render { original };
    const auto at = [] (double seconds) { return static_cast<int64_t> (seconds * rate); };
    for (size_t c { 0 }; c < 2; ++c)
        for (int64_t i { at (1.0) }; i < static_cast<int64_t> (original.frames ()); ++i)
        {
            const double t { static_cast<double> (i) / rate };
            float value { late.channels[c][static_cast<size_t> (i)] };
            if (t < 1.6)
                value = static_cast<float> (0.4 * std::sin (2.0 * kPi * 220.0 * t));
            else if (t >= 2.4 && t < 2.8)
                value = original.channels[c][static_cast<size_t> (i)];
            else if (t >= 2.8 && t < 3.1)
                value = static_cast<float> (0.3 * std::sin (2.0 * kPi * 440.0 * t));
            render.channels[c][static_cast<size_t> (i)] = value;
        }

    bridge::Audio out;
    const auto result = bridge::realign (original, render, bridge::RealignParams {}, out);

    REQUIRE (result.applied);
    CHECK (maxAbsDiff (out, original, 0, at (1.0)) == 0.0);
    CHECK (maxAbsDiff (out, render, at (1.0), at (1.6)) == 0.0);                 // note A: as rendered
    CHECK (maxAbsDiff (out, original, at (1.7), at (2.35)) < 3e-3);              // moved back
    CHECK (maxAbsDiff (out, original, at (2.45), at (2.75)) == 0.0);             // pause: exact copy
    CHECK (maxAbsDiff (out, render, at (2.8), at (3.1)) == 0.0);                 // note B: as rendered
    CHECK (maxAbsDiff (out, original, at (3.2), at (4.5) - 20) < 3e-3);          // moved back (the last 17 samples are cut off)
}

TEST (delay_has_a_flat_frequency_response_up_to_15_khz)
{
    // out[i] = x[i - shift] for a sine of 1, 10 and 15 kHz at 44.1 kHz; amplitude 1, away from the clip ends.
    for (const double shift : { -0.25, -0.5, -0.75, 0.25, 0.5, 0.75 })
        for (const double hz : { 1000.0, 10000.0, 15000.0 })
        {
            std::vector<float> x (2000);
            for (size_t i { 0 }; i < x.size (); ++i)
                x[i] = static_cast<float> (std::sin (2.0 * kPi * hz * static_cast<double> (i) / 44100.0));
            const bridge::detail::Delay delay { shift };
            double worst { 0.0 };
            for (int64_t i { 100 }; i < 1900; ++i)
            {
                const double wanted { std::sin (2.0 * kPi * hz * (static_cast<double> (i) - shift) / 44100.0) };
                worst = std::max (worst, std::fabs (static_cast<double> (delay.at (x, i)) - wanted));
            }
            std::printf ("    shift %5.2f at %5.0f Hz: worst error %g\n", shift, hz, worst);
            CHECK (worst < 1e-3);
        }
}

TEST (realign_does_not_switch_for_a_short_chance_match_inside_an_edited_note)
{
    // 1.2 s: 400 samples (9 ms) of the edited note happen to be a copy of the original moved by 30 samples.
    // That is one or two full 5 ms blocks, fewer than the three that must agree before the shift is switched.
    const bridge::Audio original { makeSignal (44100, 3.0, 1, 1) };
    bridge::Audio render { makeRender (44100, 3.0, 1, 1, 44100, 61740, 30.0) };
    const bridge::Audio early { makeSignal (44100, 3.0, 1, 1, 30.0) };
    for (size_t i { 52900 }; i < 53300; ++i)
        render.channels[0][i] = early.channels[0][i];

    bridge::Audio out;
    REQUIRE (bridge::realign (original, render, bridge::RealignParams {}, out).applied);
    CHECK (maxAbsDiff (out, render, 0, 61740) == 0.0);
}

TEST (realign_copes_with_a_render_without_channels)
{
    const bridge::Audio original { makeSignal (44100, 1.0, 1, 1) };
    bridge::Audio render;
    render.sampleRate = 44100;

    bridge::Audio out;
    const auto result = bridge::realign (original, render, bridge::RealignParams {}, out);

    CHECK (! result.applied);
    CHECK (! result.note.empty ());
    CHECK (out.channelCount () == 0);
}

TEST (realign_accepts_a_mono_original_with_a_stereo_render)
{
    const bridge::Audio original { makeSignal (44100, 3.0, 1, 1) };
    bridge::Audio render { makeRender (44100, 3.0, 1, 1, 44100, 61740, 30.0) };
    render.channels.push_back (render.channels[0]);

    bridge::Audio out;
    const auto result = bridge::realign (original, render, bridge::RealignParams {}, out);

    REQUIRE (result.applied);
    REQUIRE (out.channelCount () == 2);
    CHECK (out.channels[0] == out.channels[1]);
    CHECK (maxAbsDiff (out, render, 0, 61740) == 0.0);
}

namespace
{
    double rmsOf (const bridge::Audio& a, int64_t from, int64_t to)
    {
        double sum { 0.0 };
        size_t count { 0 };
        for (const auto& channel : a.channels)
            for (int64_t i { from }; i < to; ++i, ++count)
                sum += static_cast<double> (channel[static_cast<size_t> (i)]) * channel[static_cast<size_t> (i)];
        return count ? std::sqrt (sum / static_cast<double> (count)) : 0.0;
    }

    double rmsDiff (const bridge::Audio& a, const bridge::Audio& b, int64_t from, int64_t to)
    {
        double sum { 0.0 };
        size_t count { 0 };
        for (size_t c { 0 }; c < a.channels.size (); ++c)
            for (int64_t i { from }; i < to; ++i, ++count)
            {
                const double d { static_cast<double> (a.channels[c][static_cast<size_t> (i)]) - b.channels[c][static_cast<size_t> (i)] };
                sum += d * d;
            }
        return count ? std::sqrt (sum / static_cast<double> (count)) : 0.0;
    }
}

TEST (realign_acceptance_on_the_spike_captures)
{
    // The spike's Melodyne render after a +3 semitone edit (2-8 s excerpt of session 2). The edit starts at
    // 2.0659 s (sample 91104) and the edited note is rendered exactly as Melodyne produced it up to sample
    // 107562 (2.4390 s); after it the audio is the original moved about 30.75 samples EARLY, except for a few
    // quiet or unpitched stretches that stay unshifted. Melodyne's shifted audio is not an exact copy of the
    // original (about 4.7% error remains even with a perfect delay), so the design's 1% target cannot be met;
    // the measured result is about 0.084 vs 1.496 relative RMS error.
    // The two captures are recordings of the author and are not part of the repository: the test is skipped without them.
    const std::string dir { std::string { BRIDGE_TEST_DIR } + "/fixtures" };
    bridge::Audio original, edited;
    std::string error;
    if (! std::filesystem::exists (dir + "/spike_original_2_8s.wav") || ! std::filesystem::exists (dir + "/spike_edited_2_8s.wav"))
    {
        std::printf ("    skipped: host/tests/fixtures/spike_*_2_8s.wav are not in this checkout\n");
        return;
    }
    REQUIRE (bridge::readWav (dir + "/spike_original_2_8s.wav", original, error));
    REQUIRE (bridge::readWav (dir + "/spike_edited_2_8s.wav", edited, error));

    bridge::Audio out;
    const auto result = bridge::realign (original, edited, bridge::RealignParams {}, out);

    REQUIRE (result.applied);
    REQUIRE (out.frames () == original.frames ());
    std::printf ("    %zu segment(s):", result.segments.size ());
    for (const auto& segment : result.segments)
        std::printf (" [%lld, %lld) shift %+.2f corr %.4f;", static_cast<long long> (segment.start), static_cast<long long> (segment.end), segment.shift, segment.correlation);
    std::printf ("\n");

    bool foundTheShift { false };
    for (const auto& segment : result.segments)
        foundTheShift = foundTheShift || std::fabs (segment.shift - 30.75) < 0.3;
    CHECK (foundTheShift);

    const int64_t rate { original.sampleRate };
    const int64_t end { static_cast<int64_t> (original.frames ()) };
    const int64_t from { 2 * rate + 600 * rate / 1000 };                  // 2.6 s into the excerpt: after the edited note
    const double signal { rmsOf (original, from, end) };
    const double before { rmsDiff (edited, original, from, end) };
    const double after { rmsDiff (out, original, from, end) };
    std::printf ("    tail RMS error vs original: %.4f before, %.4f after (signal RMS %.4f, relative %.4f -> %.4f, ratio %.3f)\n",
                 before, after, signal, before / signal, after / signal, after / before);
    CHECK (after < 0.1 * before);                                          // at least 20 dB better than doing nothing

    CHECK (rmsDiff (out, original, 0, 2 * rate) == 0.0);                   // before the edit: bit-identical

    // The edited note (2.07-2.43 s; the render is untouched up to 2.4390 s) stays exactly as Melodyne rendered it.
    const int64_t noteFrom { 207 * rate / 100 };
    const int64_t noteTo { 243 * rate / 100 };
    CHECK (rmsDiff (edited, original, noteFrom, noteTo) > 0.01);           // the note really is different (the check is not vacuous)
    CHECK (rmsDiff (out, edited, noteFrom, noteTo) == 0.0);
}

// ------------------------------------------------------------------------------------------ support guard

namespace
{
    // makeSignal() with every frequency (and the envelope) raised by 44100/43000 (about +44 cents): "pitch-changed"
    // material that is a copy of the original at no shift.
    bridge::Audio makePitchChanged (double seconds, uint32_t seed)
    {
        bridge::Audio audio { makeSignal (43000, seconds * 44100.0 / 43000.0 + 0.01, 1, seed) };
        audio.sampleRate = 44100;
        audio.channels[0].resize (static_cast<size_t> (seconds * 44100));
        return audio;
    }

    // What the user's snap-to-scale edit looked like to realign(): 0-0.8 s as is, then pitch-changed material to
    // the end, except 1.5-1.7 s, which happens to be an exact copy of the original 145 samples EARLY.
    bridge::Audio makeChanceMatchRender (const bridge::Audio& original, uint32_t seed)
    {
        const int rate { original.sampleRate };
        const double seconds { static_cast<double> (original.frames ()) / rate };
        bridge::Audio render { original };
        const bridge::Audio changed { makePitchChanged (seconds, seed) };
        const bridge::Audio early { makeSignal (rate, seconds, 1, seed, 145.0) };
        for (size_t i { static_cast<size_t> (0.8 * rate) }; i < original.frames (); ++i)
        {
            const double t { static_cast<double> (i) / rate };
            render.channels[0][i] = (t >= 1.5 && t < 1.7) ? early.channels[0][i] : changed.channels[0][i];
        }
        return render;
    }

    // A guard that lets every shift through and never calls the choice unstable: realign() as it was before the
    // support guard.
    bridge::RealignParams withoutGuard ()
    {
        bridge::RealignParams params;
        params.minSupportSegments = 1;
        params.minSupportSeconds = 0.0;
        params.minSupportFraction = 0.0;
        params.singleSegmentSupportSeconds = 0.0;
        params.maxSwitchesPerSecond = 1000.0;
        return params;
    }

    const bridge::ShiftSupport* supportNear (const bridge::RealignResult& result, double shift)
    {
        for (const auto& s : result.support)
            if (std::fabs (s.shift - shift) < 0.5)
                return &s;
        return nullptr;
    }
}

TEST (realign_ignores_a_short_chance_match_inside_pitch_changed_material)
{
    const bridge::Audio original { makeSignal (44100, 4.0, 1, 21) };
    const bridge::Audio render { makeChanceMatchRender (original, 21) };

    bridge::Audio out;
    const auto result = bridge::realign (original, render, bridge::RealignParams {}, out);

    const auto* chance { supportNear (result, 145.0) };
    REQUIRE (chance != nullptr);                    // detectShifts does see the match ...
    std::printf ("    shift %+.2f: %d segment(s), %.3f s, %s\n", chance->shift, chance->segments, chance->seconds, chance->kept ? "kept" : "dropped");
    CHECK (! chance->kept);                         // ... but 0.2 s in one segment is not a timing shift
    CHECK (chance->segments == 1 && chance->seconds < 0.25);
    CHECK (! result.applied);
    CHECK (result.inconsistent);
    CHECK (! result.unstable);
    CHECK (! result.nothingToDo);                   // not "already aligned": there was something, but nothing consistent
    CHECK (result.candidates == std::vector<double> { 0.0 });
    CHECK (result.pieces.empty ());
    CHECK (result.note.find ("no consistent timing shift") != std::string::npos);
    CHECK (out.channels == render.channels);        // exactly as rendered

    // Without the guard the stretch (and whatever pitch-changed blocks happen to fit it better) would be moved.
    bridge::Audio unguarded;
    const auto old { bridge::realign (original, render, withoutGuard (), unguarded) };
    CHECK (old.applied);
    CHECK (unguarded.channels != render.channels);
}

TEST (realign_keeps_a_genuine_shift_with_many_short_segments_exactly_as_before)
{
    // 0-1.0 s as is; 1.0-1.3 s edited; then 30 samples early, broken every 0.35 s by a 50 ms edited blip (each
    // segment alone is shorter than minSupportSeconds), with an unshifted pause at 3.5-3.9 s (itself broken by
    // the blip at 3.65-3.7 s).
    const int rate { 44100 };
    const double seconds { 6.0 };
    const bridge::Audio original { makeSignal (rate, seconds, 1, 7) };
    const bridge::Audio early { makeSignal (rate, seconds, 1, 7, 30.0) };
    bridge::Audio render { original };
    for (int64_t i { rate }; i < static_cast<int64_t> (original.frames ()); ++i)
    {
        const double t { static_cast<double> (i) / rate };
        const double phase { std::fmod (t - 1.3, 0.4) };
        float value { early.channels[0][static_cast<size_t> (i)] };
        if (t < 1.3 || phase >= 0.35)
            value = static_cast<float> (0.4 * std::sin (2.0 * kPi * 330.0 * t));
        else if (t >= 3.5 && t < 3.9)
            value = original.channels[0][static_cast<size_t> (i)];
        render.channels[0][static_cast<size_t> (i)] = value;
    }

    bridge::Audio out;
    const auto result = bridge::realign (original, render, bridge::RealignParams {}, out);

    REQUIRE (result.applied);
    CHECK (! result.inconsistent && ! result.unstable);
    REQUIRE (result.candidates.size () == 2);
    CHECK_NEAR (result.candidates[1], 30.0, 0.05);
    const auto* tail { supportNear (result, 30.0) };
    REQUIRE (tail != nullptr);
    std::printf ("    shift %+.2f: %d segment(s), %.3f s\n", tail->shift, tail->segments, tail->seconds);
    CHECK (tail->kept && tail->segments >= 8);
    for (const auto& segment : result.segments)
        if (std::fabs (segment.shift - 30.0) < 0.5)
            CHECK (static_cast<double> (segment.end - segment.start) / rate < result.params.minSupportSeconds);

    // bit-identical to realign() without the guard
    bridge::Audio unguarded;
    REQUIRE (bridge::realign (original, render, withoutGuard (), unguarded).applied);
    CHECK (out.channels == unguarded.channels);
    // and correct: the shifted stretches are back on the original timeline, the edits as rendered
    CHECK (maxAbsDiff (out, original, 0, rate) == 0.0);
    CHECK (maxAbsDiff (out, render, rate, static_cast<int64_t> (1.3 * rate)) == 0.0);
    CHECK (maxAbsDiff (out, original, static_cast<int64_t> (1.32 * rate), static_cast<int64_t> (1.64 * rate)) < 1e-6);
    CHECK (maxAbsDiff (out, original, static_cast<int64_t> (3.55 * rate), static_cast<int64_t> (3.62 * rate)) == 0.0);
    CHECK (maxAbsDiff (out, original, static_cast<int64_t> (3.75 * rate), static_cast<int64_t> (3.85 * rate)) == 0.0);
}

TEST (realign_works_on_a_short_clip_with_enough_support)
{
    const int rate { 44100 };
    const auto at = [rate] (double t) { return static_cast<int64_t> (t * rate); };

    // 1.2 s: as is to 0.3 s, edited 0.3-0.4 s, early by 30 at 0.4-0.7 s and 0.75-1.2 s (two segments, ~0.7 s)
    {
        const bridge::Audio original { makeSignal (rate, 1.2, 1, 9) };
        const bridge::Audio early { makeSignal (rate, 1.2, 1, 9, 30.0) };
        bridge::Audio render { original };
        for (int64_t i { at (0.3) }; i < static_cast<int64_t> (original.frames ()); ++i)
        {
            const double t { static_cast<double> (i) / rate };
            const bool edited { t < 0.4 || (t >= 0.7 && t < 0.75) };
            render.channels[0][static_cast<size_t> (i)]
                = edited ? static_cast<float> (0.4 * std::sin (2.0 * kPi * 330.0 * t)) : early.channels[0][static_cast<size_t> (i)];
        }
        bridge::Audio out;
        const auto result = bridge::realign (original, render, bridge::RealignParams {}, out);
        REQUIRE (result.applied);
        const auto* tail { supportNear (result, 30.0) };
        REQUIRE (tail != nullptr);
        std::printf ("    two segments: %d, %.3f s\n", tail->segments, tail->seconds);
        CHECK (tail->segments == 2);
        CHECK (maxAbsDiff (out, original, at (0.42), at (0.68)) < 1e-6);
        CHECK (maxAbsDiff (out, original, at (0.77), at (1.15)) < 1e-6);
    }

    // 1.5 s: one long early tail (0.6-1.5 s, a single segment of ~0.85 s) is enough on its own
    {
        const bridge::Audio original { makeSignal (rate, 1.5, 1, 9) };
        const bridge::Audio render { makeRender (rate, 1.5, 1, 9, at (0.5), at (0.6), 30.0) };
        bridge::Audio out;
        const auto result = bridge::realign (original, render, bridge::RealignParams {}, out);
        REQUIRE (result.applied);
        const auto* tail { supportNear (result, 30.0) };
        REQUIRE (tail != nullptr);
        std::printf ("    one segment: %d, %.3f s\n", tail->segments, tail->seconds);
        CHECK (tail->segments == 1 && tail->seconds >= result.params.singleSegmentSupportSeconds);
        CHECK (maxAbsDiff (out, original, at (0.62), at (1.45)) < 1e-6);
    }

    // 1.2 s with a single 0.3 s early stretch (0.4-0.7 s): too little to trust; left as rendered
    {
        const bridge::Audio original { makeSignal (rate, 1.2, 1, 9) };
        const bridge::Audio early { makeSignal (rate, 1.2, 1, 9, 30.0) };
        bridge::Audio render { original };
        for (int64_t i { at (0.3) }; i < static_cast<int64_t> (original.frames ()); ++i)
        {
            const double t { static_cast<double> (i) / rate };
            render.channels[0][static_cast<size_t> (i)]
                = (t >= 0.4 && t < 0.7) ? early.channels[0][static_cast<size_t> (i)] : static_cast<float> (0.4 * std::sin (2.0 * kPi * 330.0 * t));
        }
        bridge::Audio out;
        const auto result = bridge::realign (original, render, bridge::RealignParams {}, out);
        CHECK (! result.applied && result.inconsistent);
        CHECK (out.channels == render.channels);
    }
}

TEST (realign_gives_up_when_the_choice_switches_too_often)
{
    // the layout of realign_handles_unshifted_stretches_inside_the_tail: 3 switches in 4 s (0.75 per second)
    const int rate { 44100 };
    const bridge::Audio original { makeSignal (rate, 4.0, 1, 3) };
    const bridge::Audio early { makeSignal (rate, 4.0, 1, 3, 30.0) };
    bridge::Audio render { original };
    for (int64_t i { rate }; i < static_cast<int64_t> (original.frames ()); ++i)
    {
        const double t { static_cast<double> (i) / rate };
        float value { early.channels[0][static_cast<size_t> (i)] };
        if (t < 1.4)
            value = static_cast<float> (0.4 * std::sin (2.0 * kPi * 330.0 * static_cast<double> (i) / rate));
        else if (t >= 2.5 && t < 2.9)
            value = original.channels[0][static_cast<size_t> (i)];
        render.channels[0][static_cast<size_t> (i)] = value;
    }

    bridge::RealignParams strict;
    strict.maxSwitchesPerSecond = 0.5;
    bridge::Audio out;
    const auto result = bridge::realign (original, render, strict, out);
    CHECK (! result.applied);
    CHECK (result.inconsistent && result.unstable && ! result.nothingToDo);
    CHECK (result.pieces.size () == 4);             // the classification is still reported
    CHECK (result.note.find ("unstable") != std::string::npos);
    CHECK (out.channels == render.channels);

    bridge::RealignParams enough;
    enough.maxSwitchesPerSecond = 1.0;
    const auto applied { bridge::realign (original, render, enough, out) };
    CHECK (applied.applied && ! applied.inconsistent && ! applied.unstable);

    // two switches (one moved stretch) are always allowed, however short the clip
    bridge::RealignParams tiny;
    tiny.maxSwitchesPerSecond = 1e-3;
    const bridge::Audio shortOriginal { makeSignal (rate, 3.0, 1, 1) };
    bridge::Audio shortRender { makeRender (rate, 3.0, 1, 1, rate, 61740, 30.0) };
    const auto one { bridge::realign (shortOriginal, shortRender, tiny, out) };
    CHECK (one.applied && one.pieces.size () == 2);
}

TEST (realign_validates_the_support_and_switch_parameters)
{
    const bridge::Audio original { makeSignal (44100, 3.0, 1, 1) };
    const bridge::Audio render { makeRender (44100, 3.0, 1, 1, 44100, 61740, 30.0) };
    const bridge::RealignParams defaults;
    const double nan { std::numeric_limits<double>::quiet_NaN () };
    const double inf { std::numeric_limits<double>::infinity () };

    for (const int segments : { 0, -1, 1001 })
    {
        bridge::RealignParams params;
        params.minSupportSegments = segments;
        bridge::Audio out;
        const auto result { bridge::realign (original, render, params, out) };
        CHECK (result.params.minSupportSegments == defaults.minSupportSegments);
        CHECK (result.applied);
    }
    for (const double value : { -0.1, 10.5, nan, inf })
    {
        bridge::RealignParams params;
        params.minSupportSeconds = value;
        bridge::Audio out;
        const auto result { bridge::realign (original, render, params, out) };
        CHECK (result.params.minSupportSeconds == defaults.minSupportSeconds);
        CHECK (result.applied);
    }
    for (const double value : { -0.1, 1.5, nan, inf })
    {
        bridge::RealignParams params;
        params.minSupportFraction = value;
        bridge::Audio out;
        const auto result { bridge::realign (original, render, params, out) };
        CHECK (result.params.minSupportFraction == defaults.minSupportFraction);
        CHECK (result.applied);
    }
    for (const double value : { -1.0, 61.0, nan, inf })
    {
        bridge::RealignParams params;
        params.singleSegmentSupportSeconds = value;
        bridge::Audio out;
        const auto result { bridge::realign (original, render, params, out) };
        CHECK (result.params.singleSegmentSupportSeconds == defaults.singleSegmentSupportSeconds);
        CHECK (result.applied);
    }
    for (const double value : { 0.0, -1.0, 1001.0, nan, inf })
    {
        bridge::RealignParams params;
        params.maxSwitchesPerSecond = value;
        bridge::Audio out;
        const auto result { bridge::realign (original, render, params, out) };
        CHECK (result.params.maxSwitchesPerSecond == defaults.maxSwitchesPerSecond);
        CHECK (result.applied);
    }

    // in-range values are used as given: requiring 3 s of support (more than the clip has) drops the shift
    bridge::RealignParams demanding;
    demanding.minSupportSeconds = 3.0;
    bridge::Audio out;
    const auto result { bridge::realign (original, render, demanding, out) };
    CHECK (result.params.minSupportSeconds == 3.0);
    CHECK (! result.applied && result.inconsistent);
    CHECK (out.channels == render.channels);
    // ... and so does a fraction of the clip that cannot be reached
    bridge::RealignParams fraction;
    fraction.minSupportFraction = 0.9;
    CHECK (! bridge::realign (original, render, fraction, out).applied);
}

namespace
{
    // A job folder of the user's (written by the host with keepRaw on); never modified. False (with a note) when
    // it, its source file or its raw render is not on this machine.
    bool loadRealJob (const std::string& id, bridge::Audio& original, bridge::Audio& render)
    {
        const char* home { std::getenv ("HOME") };
        const std::string dir { std::string (home ? home : "") + "/Library/Application Support/ARABridge/jobs/" + id };
        bridge::Job job;
        std::string error;
        bridge::Audio source;
        if (! std::filesystem::exists (dir + "/render-raw-1.wav") || ! bridge::loadJob (dir, job, error) || job.clips.empty ()
            || ! bridge::readWav (job.clips[0].path, source, error) || ! bridge::readWav (dir + "/render-raw-1.wav", render, error))
        {
            std::printf ("    skipped: job %s (or its source) is not on this machine\n", id.c_str ());
            return false;
        }
        const int64_t start { std::llround (job.clips[0].startSec * source.sampleRate) };
        const int64_t frames { static_cast<int64_t> (render.frames ()) };
        if (start < 0 || start + frames > static_cast<int64_t> (source.frames ()))
        {
            std::printf ("    skipped: job %s does not fit its source\n", id.c_str ());
            return false;
        }
        original.sampleRate = source.sampleRate;
        for (const auto& channel : source.channels)
            original.channels.emplace_back (channel.begin () + start, channel.begin () + start + frames);
        return true;
    }
}

TEST (realign_end_to_end_on_the_users_snap_to_scale_job)
{
    // The report: a 9.2 s vocal (88.2 kHz) snapped to the scale; realign moved 9 stretches by +144.85 samples on
    // the strength of one 0.2 s match and crackled. Now: nothing is applied and the output is the raw render.
    bridge::Audio original, render;
    if (! loadRealJob ("20261024-102329-7411", original, render))
        return;
    bridge::Audio out;
    const auto result { bridge::realign (original, render, bridge::RealignParams {}, out) };
    for (const auto& s : result.support)
        std::printf ("    shift %+.2f: %d segment(s), %.3f s, %s\n", s.shift, s.segments, s.seconds, s.kept ? "kept" : "dropped");
    CHECK (! result.applied);
    CHECK (result.inconsistent && ! result.unstable);
    CHECK (out.channels == render.channels);
}

TEST (realign_end_to_end_on_a_genuine_live_job)
{
    // A real Melodyne edit whose timing shift (-24.91 samples, 5 segments, 1.7 s) has to be corrected.
    bridge::Audio original, render;
    if (! loadRealJob ("20261023-175055-788o", original, render))
        return;
    bridge::Audio out;
    const auto result { bridge::realign (original, render, bridge::RealignParams {}, out) };
    CHECK (result.applied);
    REQUIRE (result.candidates.size () == 2);
    CHECK_NEAR (result.candidates[1], -24.91, 0.05);
    bridge::Audio unguarded;
    REQUIRE (bridge::realign (original, render, withoutGuard (), unguarded).applied);
    CHECK (out.channels == unguarded.channels);
}
