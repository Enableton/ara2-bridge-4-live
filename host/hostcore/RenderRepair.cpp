#include "hostcore/RenderRepair.h"

#include <algorithm>
#include <cmath>
#include <numeric>
#include <utility>

namespace bridge
{
    namespace
    {
        int64_t positiveModulo (int64_t value, int64_t modulus)
        {
            const int64_t r { value % modulus };
            return r < 0 ? r + modulus : r;
        }

        // inverse of a modulo m (gcd (a, m) == 1), by the extended Euclidean algorithm
        int64_t inverse (int64_t a, int64_t m)
        {
            int64_t t { 0 }, newT { 1 }, r { m }, newR { positiveModulo (a, m) };
            while (newR != 0)
            {
                const int64_t q { r / newR };
                t = std::exchange (newT, t - q * newT);
                r = std::exchange (newR, r - q * newR);
            }
            return positiveModulo (t, m);
        }

        float difference (const Audio& a, const Audio& b, size_t frame)
        {
            float worst { 0.0f };
            for (size_t c { 0 }; c < a.channels.size (); ++c)
            {
                const float d { std::fabs (a.channels[c][frame] - b.channels[c][frame]) };
                worst = std::isfinite (d) ? std::max (worst, d) : INFINITY;
            }
            return worst;
        }

        // every channel about twice the other render's: relative to the frame's largest magnitude (a channel
        // near zero cannot show the doubling) plus a multiple of the renders' difference next to the frame
        // (edited material differs a little between block sizes, at the glitch too)
        bool isDoubled (const Audio& glitched, const Audio& other, size_t frame, const RepairParams& params, float neighbourDifference)
        {
            float level { 0.0f };
            for (const auto& channel : other.channels)
                level = std::max (level, std::fabs (channel[frame]));
            const float tolerance { params.doubleTolerance * level + params.neighbourTolerance * neighbourDifference + 1e-6f };
            for (size_t c { 0 }; c < glitched.channels.size (); ++c)
            {
                const float g { glitched.channels[c][frame] }, o { other.channels[c][frame] };
                if (! (std::fabs (g - 2.0f * o) <= tolerance))
                    return false;
            }
            return true;
        }
    }

    int chooseSecondPreRoll (int64_t frames, const BlockGrid& first, int secondBlock, int64_t secondOffset, int64_t* firstCoincidence)
    {
        if (firstCoincidence)
            *firstCoincidence = -1;
        const int64_t b1 { first.blockSize }, b2 { secondBlock };
        if (b1 <= 0 || b2 <= 0 || std::gcd (b1, b2) != 1)
            return 0;

        // f = a1 (mod b1) and f = a2 (mod b2) has one solution in [0, b1 * b2)
        const int64_t a1 { positiveModulo (-first.offset, b1) };
        const int64_t inv { inverse (b1, b2) };
        int best { 0 };
        int64_t bestAt { -1 };
        for (int k { 0 }; k < secondBlock; ++k)
        {
            const int64_t a2 { positiveModulo (-(secondOffset + k), b2) };
            const int64_t f { a1 + b1 * positiveModulo ((a2 - a1) % b2 * inv, b2) };
            if (f >= frames)
            {
                best = k;       // the smallest pre-roll that keeps the region free of coincidences
                bestAt = f;
                break;
            }
            if (f > bestAt)
            {
                best = k;
                bestAt = f;
            }
        }
        if (firstCoincidence)
            *firstCoincidence = bestAt;
        return best;
    }

    RepairResult repairRenderGlitches (Audio& first, const Audio& second, const RepairParams& params)
    {
        RepairResult result;
        if (first.sampleRate != second.sampleRate || first.channelCount () != second.channelCount () || first.frames () != second.frames ())
        {
            result.diagnostics = "the two renders differ in format; doubled-sample check skipped";
            return result;
        }
        const size_t frames { first.frames () };
        if (frames == 0 || first.channels.empty ())
            return result;

        // candidates are the block starts of either grid (sparse); every other frame is left alone
        std::vector<size_t> repaired;
        for (const BlockGrid* grid : { &params.firstGrid, &params.secondGrid })
        {
            if (grid->blockSize <= 0)
                continue;
            for (int64_t f { positiveModulo (-grid->offset, grid->blockSize) }; f < static_cast<int64_t> (frames); f += grid->blockSize)
            {
                const auto i { static_cast<size_t> (f) };
                const bool firstStarts { params.firstGrid.startsBlock (f) }, secondStarts { params.secondGrid.startsBlock (f) };
                if (firstStarts == secondStarts)
                    continue;   // both grids start a block here: no reference
                const float d { difference (first, second, i) };
                if (! (d > params.agreeThreshold))
                    continue;
                bool isolated { true };
                float neighbourDifference { 0.0f };
                for (int64_t n { f - 2 }; n <= f + 2 && isolated; ++n)
                    if (n != f && n >= 0 && n < static_cast<int64_t> (frames))
                    {
                        const float nd { difference (first, second, static_cast<size_t> (n)) };
                        isolated = nd < params.neighbourRatio * d;
                        neighbourDifference = std::max (neighbourDifference, nd);
                    }
                if (! isolated)
                    continue;
                if (firstStarts && isDoubled (first, second, i, params, neighbourDifference))
                {
                    for (size_t c { 0 }; c < first.channels.size (); ++c)
                        first.channels[c][i] = second.channels[c][i];
                    repaired.push_back (i);
                }
                else if (secondStarts && isDoubled (second, first, i, params, neighbourDifference))
                {
                    repaired.push_back (i);     // 'first' is already right here
                }
            }
        }
        std::sort (repaired.begin (), repaired.end ());
        for (const auto i : repaired)
            result.repairedAt.push_back (static_cast<int64_t> (i));

        // what still differs (counted, not changed)
        size_t stretchEnd { 0 };
        bool open { false };
        for (size_t i { 0 }; i < frames; ++i)
        {
            if (! (difference (first, second, i) > params.agreeThreshold) || std::binary_search (repaired.begin (), repaired.end (), i))
                continue;
            if (open && i - stretchEnd < static_cast<size_t> (std::max (params.mergeGapFrames, 0)))
            {
                result.differingFrames += static_cast<int64_t> (i + 1 - stretchEnd);
            }
            else
            {
                ++result.differingStretches;
                result.differingFrames += 1;
            }
            stretchEnd = i + 1;
            open = true;
        }
        if (result.differingStretches > 0)
            result.diagnostics = "renders with two block sizes differ in " + std::to_string (result.differingStretches) + " stretch(es) ("
                                 + std::to_string (result.differingFrames) + " frames) without the doubled-sample signature; the first render was kept there";
        return result;
    }
}
