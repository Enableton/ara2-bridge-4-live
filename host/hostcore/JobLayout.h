#pragma once

#include "common/Wav.h"
#include "jobio/Job.h"

#include <cstdint>
#include <string>
#include <vector>

namespace bridge
{
    // Where one clip goes in the ARA document, in whole samples of its own audio file, so that an unedited
    // render can be bit-identical to the source region.
    struct ClipRegion
    {
        int64_t sourceStart { 0 };      // first frame of the region in the audio file
        int64_t frames { 0 };           // region length; result.wav has exactly this many frames
        int64_t playbackStart { 0 };    // region start on the playback timeline (keeps guide/dub timing)
    };

    // Job output "guide" (vocalign): result.wav covers the arrangement window [T_g, W_end) with
    // W_end = max(T_g + guide length, T_d + dub length), T_g / T_d the guide's / dub's region start on the
    // playback timeline. The rendered dub goes in at 'offset' = T_d - T_g frames (negative: its frames before
    // T_g are dropped), everything else is digital silence.
    struct GuideWindow
    {
        bool atGuide { false };         // false: result.wav is the rendered region as it is (output "dub")
        int64_t offset { 0 };           // T_d - T_g in frames (regions' playbackStart difference)
        int64_t frames { 0 };           // W_end - T_g: result.wav's length
    };

    struct JobLayout
    {
        std::vector<ClipRegion> regions;    // regions[i] belongs to job.clips[i]
        size_t renderClip { 0 };            // melodyne: the source, vocalign: the dub
        GuideWindow guideWindow;            // set for vocalign jobs with output "guide"
    };

    // A clip's end may lie this far past the end of its audio file; the region is then cut at the file end.
    constexpr double kClipEndToleranceSec { 0.001 };
    // Guide and dub may be at most this far apart on the timeline.
    constexpr double kMaxPlaybackOffsetSec { 86400.0 };
    // Output "guide": the window may be at most this long (two sources of the longest allowed length, 3600 s).
    constexpr double kMaxGuideWindowSec { 7200.0 };

    // The window for output "guide" from the regions on the sample grid: offset = dub playbackStart - guide
    // playbackStart, frames = max(guideFrames, offset + dubFrames). Errors (false, 'error' says why, 'window'
    // untouched): guideFrames or dubFrames <= 0, a dub that ends at or before the guide's start (offset + dubFrames
    // <= 0: nothing of it would be kept), or a window longer than kMaxGuideWindowSec at 'sampleRate'.
    bool guideWindow (int64_t offset, int64_t guideFrames, int64_t dubFrames, int sampleRate, GuideWindow& window, std::string& error);

    // Puts the rendered dub into a window of silence: 'out' gets the dub's rate and channel count and exactly
    // window.frames frames, out[offset + i] = dub[i] where 0 <= offset + i < window.frames, zeros elsewhere.
    // offsetFrames = max(offset, 0) (where the first kept dub frame is), droppedFrames = the dub frames before the
    // window (min(-offset, dub frames) for a negative offset, else 0). Errors (false, 'out' untouched): a window
    // that is not atGuide or has no frames, an empty dub, or a dub that would be dropped entirely.
    struct GuidePlacement
    {
        int64_t offsetFrames { 0 };
        int64_t droppedFrames { 0 };
    };
    bool placeAtGuide (const Audio& dub, const GuideWindow& window, Audio& out, GuidePlacement& placement, std::string& error);

    // Checks the job's clips against their decoded audio (audio[i] belongs to job.clips[i]) and puts every
    // region on the sample grid: startSec and endSec are rounded to the nearest frame of the file, the
    // playback start ((startBeats - earliest startBeats) at the song tempo) to the nearest frame too.
    // Errors (false, 'error' says why, 'layout' untouched): count mismatch, a clip without audio or with
    // other than 1 or 2 channels, a region shorter than one frame, starting at or after the end of the file
    // or ending more than kClipEndToleranceSec after it, guide and dub at different sample rates, or clips
    // further apart than kMaxPlaybackOffsetSec. A vocalign job with output "guide" also gets its guideWindow
    // (and fails as guideWindow does).
    bool layoutJob (const Job& job, const std::vector<Audio>& audio, JobLayout& layout, std::string& error);

    // The span of the playback timeline an offline render has to cover, as sample positions.
    struct RenderSpan
    {
        int64_t first { 0 };        // first sample position to render
        int64_t end { 0 };          // one past the last
        int64_t cropFrom { 0 };     // index into the rendered buffer where the region's first frame is
        int64_t frames { 0 };       // the region length (what is kept)
    };

    // Covers the region plus the plug-in's head and tail time (seconds, rounded up to whole samples) plus
    // 'latency' samples at the end; cropFrom skips the head and the latency, so the kept frames line up with
    // the source. Head/tail that are negative or not finite count as 0, and are capped at kMaxHeadTailSec;
    // a negative latency (unknown) counts as 0 and one above kMaxLatencySamples is an error. Also an error:
    // frames <= 0, a sample rate outside [1000, 768000], or a span that does not fit in int64.
    constexpr double kMaxHeadTailSec { 60.0 };
    constexpr int kMaxLatencySamples { 1 << 20 };
    bool renderSpan (int64_t regionStart, int64_t frames, double headSec, double tailSec, int latency, int sampleRate,
                     RenderSpan& span, std::string& error);
}
