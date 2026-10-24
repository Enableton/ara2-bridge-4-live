#pragma once

#include "common/Wav.h"

#include <cstdint>
#include <string>
#include <vector>

namespace bridge
{
    // Melodyne 5.4.2 sometimes outputs one frame at exactly twice its value (all channels) when a process block
    // starts there; which block starts are affected depends on the region, so the host cannot avoid them.
    // BridgeHost renders Melodyne twice with block grids that do not coincide inside the region and repairs
    // every frame that carries this signature in exactly one of the renders.

    // Where a render's process blocks start: region frame f was the first sample of a block when
    // (offset + f) % blockSize == 0 (offset: buffer index of the region's first frame).
    struct BlockGrid
    {
        int blockSize { 0 };        // 0: unknown (never matches)
        int64_t offset { 0 };
        bool startsBlock (int64_t frame) const
        {
            if (blockSize <= 0)
                return false;
            const int64_t r { (offset + frame) % blockSize };
            return r == 0;
        }
    };

    // The pre-roll (0 .. secondBlock - 1 frames, added to the second render's offset 'secondOffset') that puts
    // the first frame where both grids start a block past the region if possible (the smallest such pre-roll),
    // else as late as possible. For coprime block sizes b1, b2 that works for regions of up to
    // r + b1 x (b2 - 1) frames, r being the first grid's first block start in the region (for 4096 and 3001
    // from the region start: 12,288,000 frames, about 4.6 min at 44.1 kHz, 4.3 min at 48 kHz, 2.1 min at 96 kHz).
    // 'firstCoincidence' (optional) gets that frame (-1 if the grids never coincide). Block sizes that are
    // not coprime or not positive give 0.
    int chooseSecondPreRoll (int64_t frames, const BlockGrid& first, int secondBlock, int64_t secondOffset,
                             int64_t* firstCoincidence = nullptr);

    struct RepairParams
    {
        float agreeThreshold { 1e-5f };     // frames whose channels all differ by at most this agree
        // per channel |glitch - 2 x other| <= doubleTolerance x the frame's largest |other|
        //                                     + neighbourTolerance x the largest difference 1-2 frames away + 1e-6
        // (edited material differs a little between the block sizes, at the glitch as well as next to it)
        float doubleTolerance { 0.01f };
        float neighbourTolerance { 2.0f };
        float neighbourRatio { 0.25f };     // differences 1-2 frames away must stay below this x the glitch's
        int mergeGapFrames { 8 };           // for the report: differences closer than this form one stretch
        BlockGrid firstGrid, secondGrid;
    };

    struct RepairResult
    {
        std::vector<int64_t> repairedAt;    // frames repaired in 'first'
        int differingStretches { 0 };       // stretches where the renders still disagree after the repair
        int64_t differingFrames { 0 };
        std::string diagnostics;            // set when the renders still disagree (for logs, not for the user)
    };

    // Repairs 'first' in place: a frame is replaced (or, if the glitch is in 'second', confirmed) only if
    // exactly one render starts a block there, that render's frame is about twice the other's in every
    // channel (see doubleTolerance), it differs from the other by more than agreeThreshold, and the
    // differences one and two frames away are below neighbourRatio x this one. With these limits a frame at
    // 1.5 or 3.5 x the other render's is never taken for a doubled one (accepted: about 1.66 to 3.0 x when
    // the neighbours differ as much as allowed, 1.99 to 2.01 x when they agree). A glitch in 'first' takes the frame from 'second'.
    // Everything else in 'first' is left as it is, also inside stretches where the renders disagree (which
    // are only counted). Renders of different format leave 'first' untouched, with diagnostics.
    RepairResult repairRenderGlitches (Audio& first, const Audio& second, const RepairParams& params);
}
