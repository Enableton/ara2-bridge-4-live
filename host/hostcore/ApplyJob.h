#pragma once

#include "common/Wav.h"
#include "hostcore/JobLayout.h"
#include "jobio/Job.h"
#include "realign/Realign.h"

#include <cstdint>
#include <functional>
#include <string>

namespace bridge
{
    // Renders the job's clip (through 'render', which must fill 'rendered' with exactly original.frames()
    // frames at original's sample rate and channel count), realigns the render onto 'original' when the job
    // asks for it (melodyne jobs with realign true only; VocAlign output is never realigned), then writes
    // <job.dir>/result.wav (32-bit float, written to a temp file and renamed) and <job.dir>/result.json, in that
    // order; result.json is published exclusively (never over one written meanwhile, e.g. a fallback).
    // 'original' is the source region of the rendered clip, starting at frame 'sourceStartFrame' of its
    // file; result.json reports that frame, the region length and the sample rate.
    //
    // Nothing is written if <job.dir>/result.json already exists (results are never overwritten): the
    // returned status is "error". On any other failure result.json gets status "error" and the reason when
    // writeResultOnError is true (headless mode; in the UI the user can simply retry). Realign segments are
    // clamped to the region length before they are reported. Text the render function puts into
    // 'diagnostics' goes into result.json's diagnostics field (logs only, not shown to the user), followed by
    // the realignment's note ("realign: ..."); 'message' only says, in plain words, when the timing was corrected.
    // With job.keepRaw and a realignment, <job.dir>/realign-debug.json (hostcore/KeepRaw.h) is written after the
    // realignment and before result.wav and result.json; a failure there is only logged (through 'log', or to
    // stderr without one) and never fails the job.
    // Output "guide" (job.output, vocalign): after the render, result.wav is the window 'guideWindow' (layoutJob's
    // JobLayout::guideWindow) with the render placed by placeAtGuide; result.json then has frames = the window
    // length, placeAt "guide", offsetFrames and droppedFrames (and diagnostics says how many frames were dropped).
    // sourceStartFrame stays the dub's first frame in its file. A window that is not atGuide is an error then.
    using RenderFunction = std::function<bool (Audio& rendered, std::string& error, std::string& diagnostics)>;
    using LogFunction = std::function<void (const std::string& line)>;
    ResultInfo applyJob (const Job& job, const Audio& original, int64_t sourceStartFrame, const RenderFunction& render,
                         bool writeResultOnError, const LogFunction& log = {}, const GuideWindow& guideWindow = {});

    // Live preview (window mode): the same pipeline as applyJob for the editor's current state, published in its own
    // folder <job.dir>/preview-<index>/ (result.wav, then result.json: its existence means "done", exactly as for
    // the job) so that the job's own result.wav / result.json stay untouched and the job is not finished. keepRaw is
    // not applied. Returns applyJob's result; on failure the folder is removed again. 'index' must be 1 or more.
    ResultInfo writePreview (const Job& job, int index, const Audio& original, int64_t sourceStartFrame, const RenderFunction& render,
                             const LogFunction& log = {}, const GuideWindow& guideWindow = {});

    // Removes all preview-<n> folders of the job except the newest 'keepNewest' (by n); the device may still play the
    // last one. Other entries are never touched. Returns how many folders were removed.
    int prunePreviews (const std::string& jobDir, int keepNewest);

    // Writes a 32-bit float WAV to a temp file next to 'path', flushes it to disk and renames it to 'path'.
    // false with 'error' (and no temp file left) on failure.
    // 'durable' false skips the flush to disk (the rename is still atomic).
    bool writeWavAtomically (const std::string& path, const Audio& audio, std::string& error, bool durable = true);

    // Writes result.json with status "error" and 'message' unless result.json already exists.
    // Returns false (and says why) if nothing was written.
    bool writeErrorResult (const std::string& jobDir, const std::string& jobId, const std::string& message, std::string& error);

    bool resultExists (const std::string& jobDir);

    // result.json's realign.reason for an ok result (see ResultInfo::realignReason); 'requested' is true for
    // a melodyne job with realign on, and 'result' is realign's outcome then (ignored otherwise).
    std::string realignReason (bool requested, const RealignResult& result);
}
