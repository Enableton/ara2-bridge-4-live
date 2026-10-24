#include "hostcore/JobLayout.h"

#include <algorithm>
#include <cmath>
#include <limits>

namespace bridge
{
    namespace
    {
        bool fail (std::string& error, const std::string& message)
        {
            error = message;
            return false;
        }

        // Times are at most 86400 s (loadJob) and rates at most 768 kHz (decodeAudioFile), so this fits easily.
        int64_t frameAt (double seconds, int sampleRate)
        {
            return static_cast<int64_t> (std::llround (seconds * static_cast<double> (sampleRate)));
        }

        int64_t framesUp (double seconds, int sampleRate)
        {
            if (! std::isfinite (seconds) || seconds <= 0.0)
                return 0;
            return static_cast<int64_t> (std::ceil (std::min (seconds, kMaxHeadTailSec) * static_cast<double> (sampleRate) - 1e-9));
        }
    }

    bool layoutJob (const Job& job, const std::vector<Audio>& audio, JobLayout& layout, std::string& error)
    {
        if (job.clips.empty () || audio.size () != job.clips.size ())
            return fail (error, "the job has " + std::to_string (job.clips.size ()) + " clip(s) but " + std::to_string (audio.size ()) + " audio files");

        JobLayout result;
        double firstBeat { job.clips.front ().startBeats };
        for (const auto& clip : job.clips)
            firstBeat = std::min (firstBeat, clip.startBeats);

        for (size_t i { 0 }; i < job.clips.size (); ++i)
        {
            const auto& clip { job.clips[i] };
            const auto& a { audio[i] };
            const std::string what { "clip '" + clip.name + "'" };
            if (a.channelCount () == 0 || a.frames () == 0 || a.sampleRate <= 0)
                return fail (error, what + " has no audio");
            if (a.channelCount () > 2)
                return fail (error, what + " has " + std::to_string (a.channelCount ()) + " channels; only mono and stereo clips are supported");

            const int64_t fileFrames { static_cast<int64_t> (a.frames ()) };
            const int64_t start { frameAt (clip.startSec, a.sampleRate) };
            int64_t end { frameAt (clip.endSec, a.sampleRate) };
            if (start >= fileFrames)
                return fail (error, what + " starts at or after the end of its audio file");
            if (end > fileFrames)
            {
                if (end - fileFrames > frameAt (kClipEndToleranceSec, a.sampleRate))
                    return fail (error, what + " ends after the end of its audio file");
                end = fileFrames;
            }
            if (end <= start)
                return fail (error, what + " is shorter than one sample");

            const double offsetSec { (clip.startBeats - firstBeat) * 60.0 / job.tempo };
            if (! (offsetSec <= kMaxPlaybackOffsetSec))
                return fail (error, "the clips are too far apart on the timeline");

            ClipRegion region;
            region.sourceStart = start;
            region.frames = end - start;
            region.playbackStart = frameAt (offsetSec, a.sampleRate);
            result.regions.push_back (region);

            if (clip.role == "source" || clip.role == "dub")
                result.renderClip = i;
        }

        if (job.plugin == "vocalign")
        {
            for (size_t i { 1 }; i < audio.size (); ++i)
                if (audio[i].sampleRate != audio[0].sampleRate)
                    return fail (error, "guide and dub have different sample rates (" + std::to_string (audio[0].sampleRate) + " and "
                                            + std::to_string (audio[i].sampleRate) + " Hz)");
            if (job.output == "guide")
            {
                size_t guide { job.clips.size () };
                for (size_t i { 0 }; i < job.clips.size (); ++i)
                    if (job.clips[i].role == "guide")
                        guide = i;
                if (guide == job.clips.size () || guide == result.renderClip)
                    return fail (error, "output \"guide\" needs a guide and a dub clip");
                const auto& g { result.regions[guide] };
                const auto& d { result.regions[result.renderClip] };
                if (! guideWindow (d.playbackStart - g.playbackStart, g.frames, d.frames, audio[result.renderClip].sampleRate, result.guideWindow, error))
                    return false;
            }
        }

        layout = std::move (result);
        return true;
    }

    bool guideWindow (int64_t offset, int64_t guideFrames, int64_t dubFrames, int sampleRate, GuideWindow& window, std::string& error)
    {
        if (guideFrames <= 0 || dubFrames <= 0)
            return fail (error, "the guide or the dub region is empty");
        if (sampleRate <= 0)
            return fail (error, "unsupported sample rate " + std::to_string (sampleRate));
        // regions and offsets come from layoutJob (at most 86400 s at 768 kHz each), so the sums cannot overflow
        if (offset + dubFrames <= 0)
            return fail (error, "the dub clip ends before the guide clip starts in the Arrangement, so nothing of it can be placed at the guide");
        const int64_t frames { std::max (guideFrames, offset + dubFrames) };
        if (static_cast<double> (frames) > kMaxGuideWindowSec * static_cast<double> (sampleRate))
            return fail (error, "guide and dub are too far apart: the result starting at the guide would be longer than "
                                    + std::to_string (static_cast<int> (kMaxGuideWindowSec / 3600.0)) + " hours");
        GuideWindow result;
        result.atGuide = true;
        result.offset = offset;
        result.frames = frames;
        window = result;
        return true;
    }

    bool placeAtGuide (const Audio& dub, const GuideWindow& window, Audio& out, GuidePlacement& placement, std::string& error)
    {
        if (! window.atGuide || window.frames <= 0)
            return fail (error, "no output window at the guide");
        const int64_t n { static_cast<int64_t> (dub.frames ()) };
        if (dub.channelCount () == 0 || n == 0)
            return fail (error, "the rendered dub is empty");
        const int64_t dropped { window.offset < 0 ? std::min (-window.offset, n) : 0 };
        if (dropped >= n)
            return fail (error, "the rendered dub lies entirely before the guide's start");

        Audio result;
        result.sampleRate = dub.sampleRate;
        result.channels.assign (dub.channels.size (), std::vector<float> (static_cast<size_t> (window.frames), 0.0f));
        const int64_t first { window.offset + dropped };                       // >= 0: where the first kept frame goes
        const int64_t count { std::min (n - dropped, window.frames - first) };  // what fits into the window
        for (size_t c { 0 }; c < dub.channels.size (); ++c)
            if (count > 0)
                std::copy (dub.channels[c].begin () + dropped, dub.channels[c].begin () + dropped + count, result.channels[c].begin () + first);

        out = std::move (result);
        placement.offsetFrames = first;
        placement.droppedFrames = dropped;
        return true;
    }

    bool renderSpan (int64_t regionStart, int64_t frames, double headSec, double tailSec, int latency, int sampleRate,
                     RenderSpan& span, std::string& error)
    {
        if (frames <= 0)
            return fail (error, "empty render range");
        if (sampleRate < 1000 || sampleRate > 768000)
            return fail (error, "unsupported sample rate " + std::to_string (sampleRate));
        if (latency > kMaxLatencySamples)
            return fail (error, "the plug-in reports an implausible latency of " + std::to_string (latency) + " samples");

        const int64_t head { framesUp (headSec, sampleRate) };
        const int64_t tail { framesUp (tailSec, sampleRate) };
        const int64_t lat { std::max (latency, 0) };
        // everything added to regionStart is below 2^31 + 2 * 60 * 768000 + 2^20, so only regionStart and frames can overflow
        const int64_t limit { std::numeric_limits<int64_t>::max () / 4 };
        if (regionStart > limit || regionStart < -limit || frames > limit)
            return fail (error, "render range out of bounds");

        RenderSpan result;
        result.first = regionStart - head;
        result.end = regionStart + frames + tail + lat;
        result.cropFrom = head + lat;
        result.frames = frames;
        span = result;
        return true;
    }
}
