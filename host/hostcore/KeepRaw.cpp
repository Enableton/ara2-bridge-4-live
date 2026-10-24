#include "hostcore/KeepRaw.h"

#include "hostcore/ApplyJob.h"

#include <cerrno>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <unistd.h>

namespace bridge
{
    namespace
    {
        std::string number (double value)
        {
            if (! std::isfinite (value))
                return "null";
            char text[40];
            std::snprintf (text, sizeof text, "%.10g", value);
            return text;
        }

        std::string number (int64_t value) { return std::to_string (value); }

        std::string quoted (const std::string& text)
        {
            std::string out { "\"" };
            for (const char ch : text)
            {
                const auto c { static_cast<unsigned char> (ch) };
                if (c == '"' || c == '\\')
                    out += std::string { '\\' } + ch;
                else if (c == '\n')
                    out += "\\n";
                else if (c == '\t')
                    out += "\\t";
                else if (c < 0x20)
                {
                    char escaped[8];
                    std::snprintf (escaped, sizeof escaped, "\\u%04x", c);
                    out += escaped;
                }
                else
                    out += ch;
            }
            return out + "\"";
        }

        std::string seconds (int64_t frame, int sampleRate)
        {
            return sampleRate > 0 ? number (static_cast<double> (frame) / sampleRate) : "null";
        }
    }

    std::string rawRenderPath (const std::string& jobDir, int index)
    {
        return jobDir + "/render-raw-" + std::to_string (index) + ".wav";
    }

    bool writeRawRender (const std::string& jobDir, int index, const Audio& audio, std::string& error)
    {
        return writeWavAtomically (rawRenderPath (jobDir, index), audio, error);
    }

    std::string realignDebugPath (const std::string& jobDir)
    {
        return jobDir + "/realign-debug.json";
    }

    std::string realignDebugJson (const RealignResult& result, const RealignDebugInfo& info)
    {
        const int rate { info.sampleRate };
        const RealignParams& p { result.params };
        std::string json { "{\n" };
        json += "  \"version\": 1,\n";
        json += "  \"jobId\": " + quoted (info.jobId) + ",\n";
        json += "  \"sampleRate\": " + std::to_string (rate) + ",\n";
        json += "  \"frames\": " + number (info.frames) + ",\n";
        json += "  \"sourceStartFrame\": " + number (info.sourceStartFrame) + ",\n";
        json += "  \"realignSeconds\": " + number (info.seconds) + ",\n";
        json += std::string ("  \"applied\": ") + (result.applied ? "true" : "false") + ",\n";
        json += std::string ("  \"nothingToDo\": ") + (result.nothingToDo ? "true" : "false") + ",\n";
        json += std::string ("  \"inconsistent\": ") + (result.inconsistent ? "true" : "false") + ",\n";
        json += std::string ("  \"unstable\": ") + (result.unstable ? "true" : "false") + ",\n";
        json += "  \"reason\": " + quoted (info.reason) + ",\n";
        json += "  \"note\": " + quoted (result.note) + ",\n";
        json += "  \"params\": {\"windowSec\": " + number (p.windowSec) + ", \"hopSec\": " + number (p.hopSec)
                + ", \"maxShift\": " + std::to_string (p.maxShift) + ", \"minCorrelation\": " + number (p.minCorrelation)
                + ", \"earlyAcceptCorrelation\": " + number (p.earlyAcceptCorrelation) + ", \"silenceRms\": " + number (p.silenceRms)
                + ", \"crossfadeSec\": " + number (p.crossfadeSec) + ", \"minRunWindows\": " + std::to_string (p.minRunWindows)
                + ", \"classifyBlockSec\": " + number (p.classifyBlockSec) + ", \"classifyRatio\": " + number (p.classifyRatio)
                + ", \"classifyMaxRelError\": " + number (p.classifyMaxRelError)
                + ", \"classifySwitchBlocks\": " + std::to_string (p.classifySwitchBlocks)
                + ", \"minSupportSegments\": " + std::to_string (p.minSupportSegments) + ", \"minSupportSeconds\": " + number (p.minSupportSeconds)
                + ", \"minSupportFraction\": " + number (p.minSupportFraction)
                + ", \"singleSegmentSupportSeconds\": " + number (p.singleSegmentSupportSeconds)
                + ", \"maxSwitchesPerSecond\": " + number (p.maxSwitchesPerSecond) + "},\n";

        json += "  \"support\": [";
        for (size_t k { 0 }; k < result.support.size (); ++k)
        {
            const auto& s { result.support[k] };
            json += std::string (k == 0 ? "" : ", ") + "{\"shift\": " + number (s.shift) + ", \"segments\": " + std::to_string (s.segments)
                    + ", \"seconds\": " + number (s.seconds) + ", \"kept\": " + (s.kept ? "true" : "false") + "}";
        }
        json += "],\n";

        json += "  \"candidates\": [";
        for (size_t k { 0 }; k < result.candidates.size (); ++k)
            json += (k == 0 ? "" : ", ") + number (result.candidates[k]);
        json += "],\n";

        json += "  \"pieceCount\": " + std::to_string (result.pieces.size ()) + ",\n";
        json += "  \"movedPieces\": " + std::to_string (result.movedPieces) + ",\n";
        json += "  \"pieces\": [";
        for (size_t k { 0 }; k < result.pieces.size (); ++k)
        {
            const auto& piece { result.pieces[k] };
            json += std::string (k == 0 ? "\n" : ",\n") + "    {\"start\": " + number (piece.start) + ", \"startSec\": " + seconds (piece.start, rate)
                    + ", \"shift\": " + number (piece.shift) + "}";
        }
        json += result.pieces.empty () ? "],\n" : "\n  ],\n";

        json += "  \"segments\": [";
        for (size_t k { 0 }; k < result.segments.size (); ++k)
        {
            const auto& s { result.segments[k] };
            json += std::string (k == 0 ? "\n" : ",\n") + "    {\"start\": " + number (s.start) + ", \"end\": " + number (s.end)
                    + ", \"startSec\": " + seconds (s.start, rate) + ", \"endSec\": " + seconds (s.end, rate)
                    + ", \"shift\": " + number (s.shift) + ", \"correlation\": " + number (s.correlation) + "}";
        }
        json += result.segments.empty () ? "]\n" : "\n  ]\n";
        json += "}\n";
        return json;
    }

    bool writeRealignDebug (const std::string& jobDir, const std::string& json, std::string& error)
    {
        const std::string path { realignDebugPath (jobDir) };
        const std::string tmp { path + ".tmp" };
        std::FILE* file { std::fopen (tmp.c_str (), "wb") };
        if (file == nullptr)
        {
            error = "cannot write " + tmp + ": " + std::strerror (errno);
            return false;
        }
        const bool written { std::fwrite (json.data (), 1, json.size (), file) == json.size () && std::fflush (file) == 0
                             && ::fsync (::fileno (file)) == 0 };
        const int writeErrno { errno };
        const bool closed { std::fclose (file) == 0 };
        if (! written || ! closed)
        {
            error = "cannot write " + tmp + ": " + std::strerror (written ? errno : writeErrno);
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
}
