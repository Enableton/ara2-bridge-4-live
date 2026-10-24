#pragma once

#include "common/Wav.h"
#include "realign/Realign.h"

#include <cstdint>
#include <string>

namespace bridge
{
    // Diagnostics for settings.json's "keepRaw" (Job::keepRaw): the raw renders and the realignment's details
    // are kept in the job folder so edited renders can be analysed offline. Writing them never fails a job;
    // callers only log a failure.

    // <jobDir>/render-raw-<index>.wav (index 1: the first render, 2: the second, Melodyne only)
    std::string rawRenderPath (const std::string& jobDir, int index);

    // Writes the render as it came from the plug-in (before the doubled-sample repair and the realignment) to
    // rawRenderPath as 32-bit float WAV (temp file + rename). false with 'error' on failure.
    bool writeRawRender (const std::string& jobDir, int index, const Audio& audio, std::string& error);

    // <jobDir>/realign-debug.json
    std::string realignDebugPath (const std::string& jobDir);

    struct RealignDebugInfo
    {
        std::string jobId;
        int sampleRate { 0 };
        int64_t frames { 0 };               // region length
        int64_t sourceStartFrame { 0 };
        double seconds { 0.0 };             // how long realign() took
        std::string reason;                 // result.json's realign.reason
    };

    // The JSON object written to realign-debug.json: the outcome (applied, nothingToDo, inconsistent, unstable,
    // reason, note), the parameters used, the support of every distinct shift found (shift, segments, seconds,
    // kept), the candidate shifts, the pieces (count, moved count and each start/shift) and the
    // segments as detected (not clamped to the region, with correlation), frames plus seconds. Non-finite
    // numbers are written as null.
    std::string realignDebugJson (const RealignResult& result, const RealignDebugInfo& info);

    // Writes 'json' to realignDebugPath (temp file, flushed, renamed). false with 'error' on failure.
    bool writeRealignDebug (const std::string& jobDir, const std::string& json, std::string& error);
}
