#include "hostcore/ApplyJob.h"

#include "hostcore/JobLayout.h"
#include "hostcore/KeepRaw.h"
#include "realign/Realign.h"

#include <algorithm>
#include <filesystem>
#include <cerrno>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#include <utility>
#include <vector>

namespace bridge
{
    namespace
    {
        ResultInfo failed (const Job& job, const std::string& message, bool writeResultOnError)
        {
            ResultInfo info;
            info.id = job.id;
            info.status = "error";
            info.message = message;
            std::string ignored;
            if (writeResultOnError)
                writeErrorResult (job.dir, job.id, message, ignored);
            return info;
        }

        // Realign.h: a segment's end can lie past the render, and windows overlap the clip edges.
        std::vector<ShiftSegment> clampSegments (const std::vector<ShiftSegment>& segments, int64_t frames)
        {
            std::vector<ShiftSegment> result;
            for (auto s : segments)
            {
                s.start = std::clamp<int64_t> (s.start, 0, frames);
                s.end = std::clamp<int64_t> (s.end, 0, frames);
                if (s.end > s.start)
                    result.push_back (s);
            }
            return result;
        }
    }

    bool writeWavAtomically (const std::string& path, const Audio& audio, std::string& error, bool durable)
    {
        const std::string tmp { path + ".tmp" };
        if (! writeWavFloat32 (tmp, audio, error))
        {
            std::remove (tmp.c_str ());
            return false;
        }
        // flush to disk before the rename makes it visible (result.json follows and claims it is complete)
        const int fd { durable ? ::open (tmp.c_str (), O_RDONLY | O_CLOEXEC) : -1 };
        const bool synced { ! durable || (fd >= 0 && ::fsync (fd) == 0) };
        if (fd >= 0)
            ::close (fd);
        if (! synced)
        {
            error = "cannot flush " + tmp + ": " + std::strerror (errno);
            std::remove (tmp.c_str ());
            return false;
        }
        if (std::rename (tmp.c_str (), path.c_str ()) != 0)
        {
            error = "cannot rename " + tmp + " to " + path + ": " + std::strerror (errno);
            std::remove (tmp.c_str ());
            return false;
        }
        return true;
    }

    bool resultExists (const std::string& jobDir)
    {
        struct stat st {};
        return ::lstat ((jobDir + "/result.json").c_str (), &st) == 0;
    }

    std::string realignReason (bool requested, const RealignResult& result)
    {
        if (! requested)
            return "not-requested";
        if (result.applied)
            return "applied";
        // the shifts found were chance matches or the choice was unstable: left as rendered
        if (result.inconsistent)
            return "inconsistent-shifts";
        // the rest (no confident window, candidates that no block preferred, unusable input) is left as rendered
        return result.nothingToDo ? "nothing-to-do" : "no-confident-match";
    }

    bool writeErrorResult (const std::string& jobDir, const std::string& jobId, const std::string& message, std::string& error)
    {
        if (resultExists (jobDir))
        {
            error = jobDir + "/result.json already exists";
            return false;
        }
        ResultInfo info;
        info.status = "error";
        info.message = message;
        return writeResult (jobDir, jobId, info, error, true);     // exclusive: never over a result written meanwhile
    }

    ResultInfo applyJob (const Job& job, const Audio& original, int64_t sourceStartFrame, const RenderFunction& render,
                         bool writeResultOnError, const LogFunction& log, const GuideWindow& guideWindow)
    {
        if (resultExists (job.dir))
            return failed (job, job.dir + "/result.json already exists; results are never overwritten", false);

        std::string error, diagnostics;
        Audio rendered;
        if (! render (rendered, error, diagnostics))
            return failed (job, error.empty () ? std::string ("the render failed") : error, writeResultOnError);
        if (rendered.sampleRate != original.sampleRate || rendered.channelCount () != original.channelCount ()
            || rendered.frames () != original.frames ())
            return failed (job, "the render has the wrong format (" + std::to_string (rendered.channelCount ()) + " ch, "
                                    + std::to_string (rendered.frames ()) + " frames @ " + std::to_string (rendered.sampleRate) + " Hz, expected "
                                    + std::to_string (original.channelCount ()) + " ch, " + std::to_string (original.frames ()) + " frames @ "
                                    + std::to_string (original.sampleRate) + " Hz)",
                           writeResultOnError);

        ResultInfo info;
        info.id = job.id;
        Audio finalAudio;
        const bool realignRequested { job.plugin == "melodyne" && job.realign };
        info.realignReason = realignReason (false, RealignResult {});
        if (realignRequested)
        {
            const auto started { std::chrono::steady_clock::now () };
            const auto realigned { realign (original, rendered, RealignParams {}, finalAudio) };
            const std::chrono::duration<double> took { std::chrono::steady_clock::now () - started };
            info.realignApplied = realigned.applied;
            info.realignReason = realignReason (true, realigned);
            if (job.keepRaw)
            {
                RealignDebugInfo debug;
                debug.jobId = job.id;
                debug.sampleRate = original.sampleRate;
                debug.frames = static_cast<int64_t> (original.frames ());
                debug.sourceStartFrame = sourceStartFrame;
                debug.seconds = took.count ();
                debug.reason = info.realignReason;
                std::string debugError;
                const std::string line { writeRealignDebug (job.dir, realignDebugJson (realigned, debug), debugError)
                                             ? "keepRaw: wrote " + realignDebugPath (job.dir)
                                             : "warning: keepRaw: " + debugError };
                if (log)
                    log (line);
                else
                    std::fprintf (stderr, "BridgeHost: %s\n", line.c_str ());
            }
            info.shifts = clampSegments (realigned.segments, static_cast<int64_t> (original.frames ()));
            // the user sees a plain sentence; realign's own note goes to the logs
            if (realigned.applied)
                info.message = "Melodyne's timing shift after the edit was corrected.";
            if (! realigned.note.empty ())
                diagnostics += (diagnostics.empty () ? "" : "; ") + std::string ("realign: ") + realigned.note;
        }
        else
        {
            finalAudio = std::move (rendered);
        }

        info.sourceStartFrame = sourceStartFrame;
        info.frames = static_cast<int64_t> (original.frames ());
        info.sampleRate = original.sampleRate;

        // output "guide": the aligned dub goes into the window that starts at the guide (JobLayout.h)
        if (job.output == "guide")
        {
            if (! guideWindow.atGuide)
                return failed (job, "internal error: output \"guide\" without a window at the guide", writeResultOnError);
            Audio placed;
            GuidePlacement placement;
            if (! placeAtGuide (finalAudio, guideWindow, placed, placement, error))
                return failed (job, error, writeResultOnError);
            finalAudio = std::move (placed);
            info.placeAt = "guide";
            info.offsetFrames = placement.offsetFrames;
            info.droppedFrames = placement.droppedFrames;
            info.frames = guideWindow.frames;
            if (placement.droppedFrames > 0)
                diagnostics += (diagnostics.empty () ? "" : "; ") + std::string ("output: the first ") + std::to_string (placement.droppedFrames)
                               + " frames of the dub lie before the guide's start and were dropped";
        }
        info.diagnostics = diagnostics;

        const std::string resultPath { job.dir + "/result.wav" };
        if (! writeWavAtomically (resultPath, finalAudio, error, job.durable))
            return failed (job, error, writeResultOnError);

        info.status = "ok";
        info.resultPath = resultPath;
        if (! writeResult (job.dir, job.id, info, error, true))     // exclusive: never over a result written meanwhile
            return failed (job, error, writeResultOnError);
        return info;
    }

    ResultInfo writePreview (const Job& job, int index, const Audio& original, int64_t sourceStartFrame, const RenderFunction& render,
                             const LogFunction& log, const GuideWindow& guideWindow)
    {
        Job preview { job };
        preview.dir = job.dir + "/preview-" + std::to_string (index);
        preview.keepRaw = false;
        preview.durable = false;
        preview.realign = false;    // measured: the timing correction takes 1-4 s for a 44 s clip and moves audio by well under a millisecond; the
                                    // preview is for listening, Apply still corrects the real result
        std::error_code ec;
        std::filesystem::create_directory (preview.dir, ec);
        if (ec || ! std::filesystem::is_directory (preview.dir))
        {
            ResultInfo info;
            info.id = job.id;
            info.status = "error";
            info.message = "cannot create " + preview.dir;
            return info;
        }
        ResultInfo info { applyJob (preview, original, sourceStartFrame, render, false, log, guideWindow) };
        if (info.status != "ok")
            std::filesystem::remove_all (preview.dir, ec);
        return info;
    }

    int prunePreviews (const std::string& jobDir, int keepNewest)
    {
        std::vector<std::pair<long long, std::filesystem::path>> found;
        std::error_code ec;
        for (const auto& entry : std::filesystem::directory_iterator (jobDir, ec))
        {
            const std::string name { entry.path ().filename ().string () };
            if (name.size () <= 8 || name.compare (0, 8, "preview-") != 0 || ! entry.is_directory (ec))
                continue;
            const std::string digits { name.substr (8) };
            if (digits.empty () || digits.size () > 9 || ! std::all_of (digits.begin (), digits.end (), [] (char c) { return c >= '0' && c <= '9'; }))
                continue;
            found.emplace_back (std::stoll (digits), entry.path ());
        }
        std::sort (found.begin (), found.end ());
        int removed { 0 };
        for (size_t i { 0 }; i + static_cast<size_t> (std::max (keepNewest, 0)) < found.size (); ++i)
        {
            std::filesystem::remove_all (found[i].second, ec);
            if (! ec)
                ++removed;
        }
        return removed;
    }
}
