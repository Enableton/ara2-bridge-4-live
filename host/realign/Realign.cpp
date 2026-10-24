#include "realign/Realign.h"

#include "realign/Delay.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

namespace bridge
{
    namespace
    {
        // Normalised correlation of a[start, start+window) with b[start-shift, start-shift+window),
        // over the part of the window where b actually exists. Returns 0 if less than half of the
        // window overlaps. energyA is the original's energy over the whole window (used when the
        // overlap is complete; otherwise it is recomputed over the overlapping samples only).
        double correlationAt (const std::vector<float>& a, const std::vector<float>& b, int64_t start, int64_t window, int64_t shift, double energyA)
        {
            const int64_t from { start - shift };
            const int64_t first { std::max<int64_t> (0, -from) };
            const int64_t last { std::min<int64_t> (window, static_cast<int64_t> (b.size ()) - from) };
            if (last - first < window / 2 || last <= first)
                return 0.0;

            const float* pa { a.data () + start };
            const float* pb { b.data () + from };
            const bool complete { first == 0 && last == window };

            double dot[4] {}, energyB[4] {}, energyOverlap[4] {};
            int64_t i { first };
            for (; i + 4 <= last; i += 4)
            {
                for (int k { 0 }; k < 4; ++k)
                {
                    const double x { pa[i + k] };
                    const double y { pb[i + k] };
                    dot[k] += x * y;
                    energyB[k] += y * y;
                    if (! complete)
                        energyOverlap[k] += x * x;
                }
            }
            for (int k { 0 }; i < last; ++i, ++k)
            {
                const double x { pa[i] };
                const double y { pb[i] };
                dot[k] += x * y;
                energyB[k] += y * y;
                if (! complete)
                    energyOverlap[k] += x * x;
            }

            const double d { (dot[0] + dot[1]) + (dot[2] + dot[3]) };
            const double eB { (energyB[0] + energyB[1]) + (energyB[2] + energyB[3]) };
            const double eA { complete ? energyA : (energyOverlap[0] + energyOverlap[1]) + (energyOverlap[2] + energyOverlap[3]) };
            const double denominator { std::sqrt (eA * eB) };
            const double result { denominator > 0.0 ? d / denominator : 0.0 };
            return std::isfinite (result) ? result : 0.0;       // inf/NaN samples carry no information
        }

        // Parabola through the correlations at s0-1, s0, s0+1: sub-sample position of the peak.
        void refine (double cm, double c0, double cp, double& delta, double& peak)
        {
            const double denom { cm - 2.0 * c0 + cp };
            if (denom < 0.0)
            {
                delta = std::max (-0.5, std::min (0.5, 0.5 * (cm - cp) / denom));
                peak = c0 - 0.25 * (cm - cp) * delta;
            }
            else
            {
                delta = 0.0;
                peak = c0;
            }
        }

        struct Run
        {
            ShiftSegment segment;
            double shiftSum { 0.0 };
            int windows { 0 };
        };
    }

    std::vector<ShiftSegment> detectShifts (const std::vector<float>& a, const std::vector<float>& b, int sampleRate, const RealignParams& params)
    {
        std::vector<ShiftSegment> segments;
        if (sampleRate <= 0 || ! std::isfinite (params.windowSec) || ! (params.windowSec > 0.0)
            || ! std::isfinite (params.hopSec) || ! (params.hopSec > 0.0) || params.maxShift < 0
            || params.minRunWindows < 1 || ! (params.minCorrelation > 0.0 && params.minCorrelation <= 1.0)
            || ! (params.earlyAcceptCorrelation >= params.minCorrelation && params.earlyAcceptCorrelation <= 1.0)
            || a.empty () || b.empty ())
            return segments;

        const int64_t n { static_cast<int64_t> (a.size ()) };
        const int64_t window { std::max<int64_t> (16, std::llround (std::min (params.windowSec, 1.0) * sampleRate)) };
        const int64_t hop { std::max<int64_t> (1, std::llround (std::min (params.hopSec, 1.0) * sampleRate)) };
        const int64_t maxShift { std::min<int64_t> (params.maxShift, n) };      // a shift beyond the clip length means nothing

        std::vector<Run> runs;
        bool haveRun { false };
        Run run;
        double lastShift { 0.0 };
        int64_t nonSilentWindows { 0 };
        std::vector<double> corrs (static_cast<size_t> (2 * maxShift + 1));

        const auto closeRun = [&]
        {
            if (haveRun)
                runs.push_back (run);
            haveRun = false;
        };

        if (n < window)
            return segments;
        for (int64_t start { 0 }; start <= n - window; start += hop)
        {
            double energyA { 0.0 };
            for (int64_t i { 0 }; i < window; ++i)
            {
                const double v { a[static_cast<size_t> (start + i)] };
                energyA += v * v;
            }
            if (std::sqrt (energyA / static_cast<double> (window)) < params.silenceRms)
                continue;       // silence: neither extends nor breaks a run
            ++nonSilentWindows;

            const int64_t last { std::llround (lastShift) };
            int64_t bestShift { 0 };
            double cm { 0.0 }, c0 { 0.0 }, cp { 0.0 };
            bool settled { false };

            // cheap check first: most windows keep the previous shift (or are unshifted).
            // Only a local correlation peak above the accept threshold counts.
            const int64_t candidates[2] { last, 0 };
            for (int which { 0 }; which < (last == 0 ? 1 : 2); ++which)
            {
                const int64_t candidate { candidates[which] };
                if (std::abs (candidate) >= maxShift)
                    continue;
                const double centre { correlationAt (a, b, start, window, candidate, energyA) };
                if (centre < params.earlyAcceptCorrelation)
                    continue;
                const double below { correlationAt (a, b, start, window, candidate - 1, energyA) };
                const double above { correlationAt (a, b, start, window, candidate + 1, energyA) };
                if (centre >= below && centre >= above)
                {
                    bestShift = candidate;
                    cm = below;
                    c0 = centre;
                    cp = above;
                    settled = true;
                    break;
                }
            }

            if (! settled)
            {
                double bestCorrelation { -2.0 };
                for (int64_t shift { -maxShift }; shift <= maxShift; ++shift)
                {
                    const double corr { correlationAt (a, b, start, window, shift, energyA) };
                    corrs[static_cast<size_t> (shift + maxShift)] = corr;
                    const bool clearlyBetter { corr > bestCorrelation + 1e-9 };
                    bool tieWins { false };
                    if (! clearlyBetter && corr >= bestCorrelation - 1e-9)
                    {
                        const int64_t distNew { std::abs (shift - last) }, distOld { std::abs (bestShift - last) };
                        tieWins = distNew < distOld || (distNew == distOld && std::abs (shift) < std::abs (bestShift));
                    }
                    if (clearlyBetter || tieWins)
                    {
                        bestShift = shift;
                        bestCorrelation = std::max (bestCorrelation, corr);
                    }
                }
                c0 = corrs[static_cast<size_t> (bestShift + maxShift)];
                if (std::abs (bestShift) < maxShift)
                {
                    cm = corrs[static_cast<size_t> (bestShift - 1 + maxShift)];
                    cp = corrs[static_cast<size_t> (bestShift + 1 + maxShift)];
                }
            }

            double delta { 0.0 }, peak { c0 };
            if (std::abs (bestShift) < maxShift)
                refine (cm, c0, cp, delta, peak);
            const double windowShift { static_cast<double> (bestShift) + delta };

            if (! (peak >= params.minCorrelation))
            {
                closeRun ();        // an edited stretch ends the run
                continue;
            }

            lastShift = windowShift;
            if (haveRun && std::fabs (windowShift - run.segment.shift) <= 0.5)
            {
                run.segment.end = start + window;
                run.segment.correlation = std::min (run.segment.correlation, peak);
                run.shiftSum += windowShift;
                ++run.windows;
                run.segment.shift = run.shiftSum / run.windows;
            }
            else
            {
                closeRun ();
                run = Run {};
                run.segment.start = start;
                run.segment.end = start + window;
                run.segment.shift = windowShift;
                run.segment.correlation = peak;
                run.shiftSum = windowShift;
                run.windows = 1;
                haveRun = true;
            }
        }
        closeRun ();

        // A run shorter than minRunWindows is a chance match (e.g. a period multiple), i.e. an edit,
        // unless the whole input is too short to ever contain a longer run.
        const bool keepShortRuns { nonSilentWindows < params.minRunWindows };
        for (const Run& r : runs)
            if (keepShortRuns || r.windows >= params.minRunWindows)
                segments.push_back (r.segment);
        return segments;
    }

    namespace
    {
        // Mono mix of planar channels; non-finite samples count as 0 (they carry no information and would
        // otherwise spread through the interpolation filter).
        std::vector<float> mixToMono (const std::vector<std::vector<float>>& channels)
        {
            std::vector<float> mono (channels.empty () ? 0 : channels[0].size (), 0.0f);
            for (const auto& channel : channels)
                for (size_t i { 0 }; i < channel.size () && i < mono.size (); ++i)
                    mono[i] += std::isfinite (channel[i]) ? channel[i] : 0.0f;
            if (channels.size () > 1)
                for (auto& value : mono)
                    value /= static_cast<float> (channels.size ());
            return mono;
        }

        std::vector<float> withoutNonFinite (std::vector<float> channel)
        {
            for (auto& value : channel)
                if (! std::isfinite (value))
                    value = 0.0f;
            return channel;
        }

        // Parameters outside their sensible range fall back to the defaults.
        RealignParams validated (RealignParams p)
        {
            const RealignParams defaults;
            if (! (std::isfinite (p.silenceRms) && p.silenceRms > 0.0 && p.silenceRms <= 0.1))
                p.silenceRms = defaults.silenceRms;
            if (! (std::isfinite (p.crossfadeSec) && p.crossfadeSec >= 0.0 && p.crossfadeSec <= 0.05))
                p.crossfadeSec = defaults.crossfadeSec;
            if (! (std::isfinite (p.classifyBlockSec) && p.classifyBlockSec > 0.0 && p.classifyBlockSec <= 0.1))
                p.classifyBlockSec = defaults.classifyBlockSec;
            if (! (std::isfinite (p.classifyRatio) && p.classifyRatio > 0.0 && p.classifyRatio <= 1.0))
                p.classifyRatio = defaults.classifyRatio;
            if (! (std::isfinite (p.classifyMaxRelError) && p.classifyMaxRelError > 0.0 && p.classifyMaxRelError <= 1.0))
                p.classifyMaxRelError = defaults.classifyMaxRelError;
            if (p.classifySwitchBlocks < 1 || p.classifySwitchBlocks > 1000)
                p.classifySwitchBlocks = defaults.classifySwitchBlocks;
            if (p.minSupportSegments < 1 || p.minSupportSegments > 1000)
                p.minSupportSegments = defaults.minSupportSegments;
            if (! (std::isfinite (p.minSupportSeconds) && p.minSupportSeconds >= 0.0 && p.minSupportSeconds <= 10.0))
                p.minSupportSeconds = defaults.minSupportSeconds;
            if (! (std::isfinite (p.minSupportFraction) && p.minSupportFraction >= 0.0 && p.minSupportFraction <= 1.0))
                p.minSupportFraction = defaults.minSupportFraction;
            if (! (std::isfinite (p.singleSegmentSupportSeconds) && p.singleSegmentSupportSeconds >= 0.0 && p.singleSegmentSupportSeconds <= 60.0))
                p.singleSegmentSupportSeconds = defaults.singleSegmentSupportSeconds;
            if (! (std::isfinite (p.maxSwitchesPerSecond) && p.maxSwitchesPerSecond > 0.0 && p.maxSwitchesPerSecond <= 1000.0))
                p.maxSwitchesPerSecond = defaults.maxSwitchesPerSecond;
            return p;
        }

        // A shift of ~0 is no shift at all (exact copy); a shift within 0.01 of a whole number is that number.
        double snapped (double shift)
        {
            if (std::fabs (shift) < 0.05)
                return 0.0;
            if (std::fabs (shift - std::round (shift)) < 0.01)
                return std::round (shift);
            return shift;
        }

        // The distinct shifts found by detectShifts (neighbours within 0.5 samples are one shift, valued at their
        // length-weighted mean, then snapped), in order of appearance, with the number of segments and the seconds
        // of the clip that support each. A shift of 0 is always kept; a nonzero shift only with enough support
        // (see RealignParams::minSupportSegments).
        std::vector<ShiftSupport> shiftSupport (const std::vector<ShiftSegment>& segments, int64_t n, int sampleRate, const RealignParams& params)
        {
            struct Cluster
            {
                double sum { 0.0 };
                double weight { 0.0 };
                int segments { 0 };
            };
            std::vector<Cluster> clusters;
            for (const ShiftSegment& segment : segments)
            {
                const double length { static_cast<double> (std::max<int64_t> (1, std::min (segment.end, n) - segment.start)) };
                Cluster* home { nullptr };
                for (Cluster& cluster : clusters)
                    if (std::fabs (cluster.sum / cluster.weight - segment.shift) <= 0.5)
                        home = &cluster;
                if (home == nullptr)
                    home = &clusters.emplace_back ();
                home->sum += segment.shift * length;
                home->weight += length;
                ++home->segments;
            }

            std::vector<ShiftSupport> support;
            for (const Cluster& cluster : clusters)
            {
                const double shift { snapped (cluster.sum / cluster.weight) };
                auto known { std::find_if (support.begin (), support.end (), [shift] (const ShiftSupport& s) { return std::fabs (s.shift - shift) < 1e-9; }) };
                if (known == support.end ())
                {
                    support.push_back (ShiftSupport { shift, 0, 0.0, false });
                    known = support.end () - 1;
                }
                known->segments += cluster.segments;
                known->seconds += cluster.weight / sampleRate;
            }

            const double clipSeconds { static_cast<double> (n) / sampleRate };
            const double required { std::max (params.minSupportSeconds, params.minSupportFraction * clipSeconds) };
            for (ShiftSupport& s : support)
                s.kept = s.shift == 0.0
                         || (s.seconds >= required
                             && (s.segments >= params.minSupportSegments || s.seconds >= std::max (required, params.singleSegmentSupportSeconds)));
            return support;
        }
    }

    // Why blocks are classified instead of trusting the confident windows of detectShifts:
    // detectShifts only reports stretches where a window correlates >= 0.98 with a shifted original. Real edits
    // leave quiet or unvoiced stretches inside the tail that are not reported, and the boundary of a reported
    // stretch is only known to within a window. Cutting between two reported stretches (e.g. at their midpoint)
    // therefore lands inside the edited note, or inside a stretch that was fine. Instead every short block is
    // compared with the original under each candidate shift, and a block is only moved when one candidate fits
    // it clearly better than all others. Edited blocks fit none, so they keep whatever was chosen before; a
    // switch happens only after several consecutive blocks agree.
    // Why candidates need support: the block test is much looser than detectShifts (a block only has to fit one
    // candidate clearly better than the others), so a candidate backed by one short, isolated stretch (a chance
    // match or a brief local move, e.g. 0.2 s at +144.85 samples in a snap-to-scale edit of a whole vocal) wins
    // blocks all over the pitch-edited material. Moving those
    // blocks crossfades the render with itself delayed by a millisecond or two, which clicks and phases. Melodyne's
    // real timing shift is one value that recurs over much of the clip (measured: 5 to 20 segments, 1.3 to 8 s,
    // 21 to 56% of the clip; the isolated ones: 1 segment, at most 0.2 s, 2.4% of the clip). The price: a brief
    // real local move (measured once: 0.13 s) keeps Melodyne's timing.
    RealignResult realign (const Audio& original, const Audio& render, const RealignParams& givenParams, Audio& out)
    {
        using detail::Delay;

        const RealignParams params { validated (givenParams) };
        RealignResult result;
        result.params = params;
        const int64_t n { static_cast<int64_t> (original.frames ()) };

        // Start from the render, trimmed or zero-padded to the original length.
        out.sampleRate = render.sampleRate;
        out.channels.assign (render.channels.size (), std::vector<float> (static_cast<size_t> (n), 0.0f));
        for (size_t c { 0 }; c < render.channels.size (); ++c)
            for (int64_t i { 0 }; i < n && i < static_cast<int64_t> (render.channels[c].size ()); ++i)
                out.channels[c][static_cast<size_t> (i)] = render.channels[c][static_cast<size_t> (i)];

        if (original.channelCount () < 1 || render.channelCount () < 1 || n == 0)
        {
            result.note = "original or render contains no audio; left as rendered";
            return result;
        }
        if (original.sampleRate != render.sampleRate)
        {
            result.note = "original and render have different sample rates; audio left as rendered";
            return result;
        }

        // All analysis is on mono mixes; the delay is linear, so the same shifts apply to every channel.
        std::vector<std::vector<float>> clean;
        for (const auto& channel : render.channels)
            clean.push_back (withoutNonFinite (channel));
        const std::vector<float> originalMono { mixToMono (original.channels) };
        const std::vector<float> renderMono { mixToMono (clean) };

        result.segments = detectShifts (originalMono, renderMono, original.sampleRate, params);
        if (result.segments.empty ())
        {
            result.note = "no confident match between render and original; audio left as rendered";
            return result;
        }

        result.support = shiftSupport (result.segments, n, original.sampleRate, params);
        std::vector<double> candidates { 0.0 };
        size_t dropped { 0 };
        for (const ShiftSupport& s : result.support)
        {
            if (s.shift == 0.0)
                continue;
            if (s.kept)
                candidates.push_back (s.shift);
            else
                ++dropped;
        }
        result.candidates = candidates;
        if (candidates.size () == 1)
        {
            if (dropped > 0)
            {
                // Only short, isolated matches at a nonzero shift, not a timing shift (a real one is one value that
                // recurs over much of the clip). Moving audio by them would add clicks across the edited material.
                result.inconsistent = true;
                result.note = "no consistent timing shift found (" + std::to_string (dropped)
                              + " shift(s) with too little support ignored); audio left as rendered";
                return result;
            }
            result.nothingToDo = true;
            result.note = "render already aligned; nothing to do";
            return result;
        }
        std::vector<Delay> delays;
        std::vector<std::vector<float>> moved;          // the mono render under each candidate shift
        for (const double shift : candidates)
        {
            delays.emplace_back (shift);
            moved.emplace_back (static_cast<size_t> (n));
            for (int64_t i { 0 }; i < n; ++i)
                moved.back ()[static_cast<size_t> (i)] = delays.back ().at (renderMono, i);
        }

        // Which candidate does each block clearly prefer (-1: none)? "Clearly" means its error energy against the
        // original is below classifyRatio times that of every other candidate, and the block fits to within
        // classifyMaxRelError of its own energy. Silent blocks and edited blocks prefer nothing.
        const int64_t block { std::max<int64_t> (16, std::llround (params.classifyBlockSec * original.sampleRate)) };
        const int64_t blocks { (n + block - 1) / block };
        const size_t count { candidates.size () };
        std::vector<int> preferred (static_cast<size_t> (blocks), -1);
        std::vector<double> error (count);
        for (int64_t b { 0 }; b < blocks; ++b)
        {
            const int64_t from { b * block };
            const int64_t to { std::min (n, from + block) };
            double energy { 0.0 };
            std::fill (error.begin (), error.end (), 0.0);
            for (int64_t i { from }; i < to; ++i)
            {
                const double x { originalMono[static_cast<size_t> (i)] };
                energy += x * x;
                for (size_t k { 0 }; k < count; ++k)
                {
                    const double d { static_cast<double> (moved[k][static_cast<size_t> (i)]) - x };
                    error[k] += d * d;
                }
            }

            size_t best { 0 };
            for (size_t k { 1 }; k < count; ++k)
                if (error[k] < error[best])
                    best = k;
            bool clear { energy > params.silenceRms * params.silenceRms * static_cast<double> (to - from)
                         && error[best] < params.classifyMaxRelError * params.classifyMaxRelError * energy };
            for (size_t k { 0 }; k < count && clear; ++k)
                if (k != best && ! (error[best] < params.classifyRatio * error[k]))
                    clear = false;
            if (clear)
                preferred[static_cast<size_t> (b)] = static_cast<int> (best);
        }

        // Keep the current candidate until classifySwitchBlocks consecutive blocks prefer another one.
        std::vector<int> chosen (static_cast<size_t> (blocks), 0);
        int current { 0 };
        for (int64_t b { 0 }; b < blocks; ++b)
        {
            const int want { preferred[static_cast<size_t> (b)] };
            if (want >= 0 && want != current)
            {
                bool agreed { true };
                for (int64_t q { b }; q < std::min<int64_t> (blocks, b + params.classifySwitchBlocks); ++q)
                    agreed = agreed && preferred[static_cast<size_t> (q)] == want;
                if (agreed)
                    current = want;
            }
            chosen[static_cast<size_t> (b)] = current;
        }

        // Pieces: stretches of equal choice, each starting on a block boundary.
        struct Piece
        {
            int64_t start;
            size_t candidate;
        };
        std::vector<Piece> pieces { Piece { 0, static_cast<size_t> (chosen[0]) } };
        for (int64_t b { 1 }; b < blocks; ++b)
            if (chosen[static_cast<size_t> (b)] != chosen[static_cast<size_t> (b - 1)])
                pieces.push_back (Piece { b * block, static_cast<size_t> (chosen[static_cast<size_t> (b)]) });
        size_t movedPieces { 0 };
        for (const Piece& piece : pieces)
        {
            movedPieces += piece.candidate != 0 ? 1U : 0U;
            result.pieces.push_back (RealignPiece { piece.start, candidates[piece.candidate] });
        }
        result.movedPieces = movedPieces;
        if (movedPieces == 0)
        {
            result.note = "no stretch of the render matched a moved copy of the original; audio left as rendered";
            return result;
        }
        // Backstop: a choice that flips back and forth all the time is not a timing shift being undone.
        const size_t switches { pieces.size () - 1 };
        const double clipSeconds { static_cast<double> (n) / original.sampleRate };
        if (switches > 2 && static_cast<double> (switches) > params.maxSwitchesPerSecond * clipSeconds)
        {
            result.inconsistent = true;
            result.unstable = true;
            char text[160];
            std::snprintf (text, sizeof text, "the timing shift choice was unstable (%zu switches in %.1f s); audio left as rendered", switches, clipSeconds);
            result.note = text;
            return result;
        }

        // Crossfade at each junction, never longer than half of either neighbouring piece.
        const int64_t wantedHalf { std::llround (params.crossfadeSec * original.sampleRate) / 2 };
        std::vector<int64_t> half (pieces.size (), 0);
        for (size_t k { 1 }; k < pieces.size (); ++k)
        {
            const int64_t before { pieces[k].start - pieces[k - 1].start };
            const int64_t after { (k + 1 < pieces.size () ? pieces[k + 1].start : n) - pieces[k].start };
            half[k] = std::min ({ wantedHalf, before / 2, after / 2 });
        }

        for (size_t c { 0 }; c < clean.size (); ++c)
        {
            const std::vector<float>& src { clean[c] };
            std::vector<float>& dst { out.channels[c] };

            for (size_t k { 0 }; k < pieces.size (); ++k)
            {
                const int64_t to { (k + 1 < pieces.size ()) ? pieces[k + 1].start : n };
                for (int64_t i { pieces[k].start }; i < to; ++i)
                    dst[static_cast<size_t> (i)] = delays[pieces[k].candidate].at (src, i);
            }

            for (size_t k { 1 }; k < pieces.size (); ++k)
            {
                const int64_t junction { pieces[k].start };
                const Delay& earlier { delays[pieces[k - 1].candidate] };
                const Delay& later { delays[pieces[k].candidate] };
                for (int64_t i { junction - half[k] }; i < junction + half[k]; ++i)
                {
                    const double t { static_cast<double> (i - (junction - half[k])) / static_cast<double> (2 * half[k]) };
                    dst[static_cast<size_t> (i)] = static_cast<float> ((1.0 - t) * static_cast<double> (earlier.at (src, i)) + t * static_cast<double> (later.at (src, i)));
                }
            }
        }

        result.applied = true;
        result.note = "moved " + std::to_string (movedPieces) + " stretch(es) back onto the original timeline";
        return result;
    }
}
