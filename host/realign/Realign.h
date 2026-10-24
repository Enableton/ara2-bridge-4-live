#pragma once

#include "common/Wav.h"

#include <cstdint>
#include <string>
#include <vector>

namespace bridge
{
    struct RealignParams
    {
        double windowSec { 0.050 };
        double hopSec { 0.025 };
        int maxShift { 400 };                   // samples searched in both directions
        double minCorrelation { 0.98 };         // windows below this are treated as edited
        double earlyAcceptCorrelation { 0.9995 };   // speed-up: accept the previous shift (or 0) without a full search
        double silenceRms { 1e-4 };             // windows quieter than this carry no information; realign() uses the default outside (0, 0.1]
        double crossfadeSec { 0.003 };          // realign() only: crossfade at each switch of shift; [0, 0.05], else the default
        int minRunWindows { 3 };                // runs shorter than this are treated as edited (spurious matches)
        // realign() only: the per-block choice between the detected shifts (see realign()).
        double classifyBlockSec { 0.005 };      // block length, (0, 0.1]
        double classifyRatio { 0.25 };          // a block prefers a shift whose error is below this x every other shift's, (0, 1]
        double classifyMaxRelError { 0.5 };     // ... and below this x the block's own RMS, (0, 1]
        int classifySwitchBlocks { 3 };         // consecutive blocks that must agree before the shift is switched, [1, 1000]
        // realign() only: the support a NONZERO shift needs before it is used (see realign()). Its segments (after
        // the 0.5-sample merging) must cover at least max(minSupportSeconds, minSupportFraction x clip length), and
        // there must be at least minSupportSegments of them, unless their total alone reaches
        // singleSegmentSupportSeconds (one long stretch is enough).
        int minSupportSegments { 2 };               // [1, 1000]
        double minSupportSeconds { 0.4 };           // [0, 10]
        double minSupportFraction { 0.03 };         // [0, 1]
        double singleSegmentSupportSeconds { 0.75 }; // [0, 60]
        // realign() only: more switches between shifts than this per second of clip (two switches, i.e. one moved
        // stretch, are always allowed) means the choice is unstable, and nothing is applied. (0, 1000]
        double maxSwitchesPerSecond { 4.0 };
    };

    // A stretch of the render that is a copy of the original, moved by 'shift' samples (fractional).
    // shift > 0: the render is EARLY and has to be moved LATER by that many samples
    // (render[n - shift] ~ original[n]).
    struct ShiftSegment
    {
        int64_t start { 0 };            // sample range [start, end) on the original's timeline
        int64_t end { 0 };
        double shift { 0.0 };           // mean of the window shifts in the segment
        double correlation { 0.0 };     // lowest window correlation inside the segment
    };

    // realign(): from 'start' (a frame of the original's timeline) to the next piece, the render is moved by
    // 'shift' (one of the candidates; 0 is left as rendered).
    struct RealignPiece
    {
        int64_t start { 0 };
        double shift { 0.0 };
    };

    // realign(): the evidence for one distinct shift found by detectShifts (after merging and snapping): how many
    // segments and how many seconds of the clip support it, and whether it was used as a candidate.
    struct ShiftSupport
    {
        double shift { 0.0 };
        int segments { 0 };
        double seconds { 0.0 };
        bool kept { false };
    };

    struct RealignResult
    {
        bool applied { false };
        bool nothingToDo { false };     // not applied because the render already lines up (only shift 0 was found)
        std::vector<ShiftSegment> segments;
        std::string note;
        // for diagnostics (realign() only): the parameters actually used (after validation), the candidate
        // shifts (0 first, then the nonzero shifts with enough support; empty when no segment was found) and
        // the pieces of the block classification (empty when it did not run), of which movedPieces have a
        // shift != 0
        RealignParams params;
        std::vector<double> candidates;
        std::vector<RealignPiece> pieces;
        size_t movedPieces { 0 };
        // realign() only: not applied because the shifts found are not consistent: every nonzero shift had too
        // little support, or (unstable) the block classification switched more often than maxSwitchesPerSecond
        bool inconsistent { false };
        bool unstable { false };
        std::vector<ShiftSupport> support;      // every distinct shift found (0 first when found), in order of appearance
    };

    // Mono analysis: finds runs of windows where render[n - shift] matches original[n] with
    // correlation >= params.minCorrelation. Silent windows are skipped; edited windows end a run.
    // Segments are listed in time order; consecutive segments can overlap by up to one window.
    // The last (less than one hop of the) clip is not analysed. Returns nothing for invalid
    // parameters (non-finite or non-positive window/hop, minCorrelation outside (0, 1],
    // earlyAcceptCorrelation outside [minCorrelation, 1], ...) or empty input; window and hop are
    // capped at one second.
    // A segment's 'end' can lie up to half a window past the end of the render (windows are
    // correlated over their valid overlap only), so callers must clamp to the render length.
    // Inherent ambiguity: for a perfectly periodic note, a true shift of an exact multiple of the
    // period cannot be told from shift 0 (or from another multiple); the detector may report 0.
    std::vector<ShiftSegment> detectShifts (const std::vector<float>& original, const std::vector<float>& render,
                                            int sampleRate, const RealignParams& params);

    // Moves the parts of an edited render that are copies of the original back onto the original's timeline.
    // 'out' has the original's length and the render's channels and sample rate (so a render without channels
    // gives an empty 'out'); a mono original with a stereo render works (the analysis is on mono mixes).
    // Candidates are 0 and the shifts found by detectShifts (result.segments); the render is then split into
    // 5 ms blocks, each block takes the candidate that fits the original clearly best, and edited blocks keep
    // the previous choice (as rendered before the first switch, otherwise moved like the stretch before them).
    // Switches are crossfaded.
    // Safety guards: a nonzero shift is only a candidate when enough of the clip supports it (see the
    // minSupport... parameters); short, isolated stretches at another shift (chance matches or brief local
    // moves) are dropped. If no nonzero shift is left, or if the block classification switches more often than
    // maxSwitchesPerSecond, nothing is applied and 'inconsistent' is set (and 'unstable' for the latter).
    // On any failure (different sample rates, no confident match, inconsistent shifts, nothing to move) applied
    // is false, 'note' says why and 'out' is the render trimmed or zero-padded to the original's length.
    // Non-finite render samples are replaced by 0 in the moved parts. A shift is applied with a 32-tap
    // interpolator that sees 0 outside the clip, so a fractional shift reaching the first or last ~16 samples
    // of the clip rings there.
    RealignResult realign (const Audio& original, const Audio& render, const RealignParams& params, Audio& out);
}
