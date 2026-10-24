#include "app/JobRender.h"

#include "app/OfflineRenderer.h"
#include "hostcore/KeepRaw.h"
#include "hostcore/RenderRepair.h"

#include <cstdio>
#include <utility>

namespace
{
    constexpr int kMelodyneFirstBlock { 4096 };
    constexpr int kMelodyneSecondBlock { 3001 };   // coprime to 4096

    void logRender (const std::function<void (const std::string&)>& log, const RenderReport& report, int preRoll)
    {
        char text[200];
        std::snprintf (text, sizeof text, "render (block %d, pre-roll %d): latency %d samples, head %.4f s, tail %.4f s, %.2f s",
                       report.blockSize, preRoll, report.latency, report.headSec, report.tailSec, report.seconds);
        log (text);
        if (report.latency > 0)
            log ("warning: the plug-in reports a latency of " + std::to_string (report.latency) + " samples (compensated)");
    }

    // settings.json "keepRaw": the render as the plug-in returned it, for offline analysis; never fails the job
    void keepRawRender (const bridge::Job& job, int index, const bridge::Audio& audio, const std::function<void (const std::string&)>& log)
    {
        if (! job.keepRaw)
            return;
        std::string error;
        if (bridge::writeRawRender (job.dir, index, audio, error))
            log ("keepRaw: wrote " + bridge::rawRenderPath (job.dir, index));
        else
            log ("warning: keepRaw: " + error);
    }
}

bool renderJobClip (BridgeDocument& document, const bridge::Job& job, const bridge::JobLayout& layout,
                    const std::function<bool ()>& idle, const std::function<void (const std::string&)>& log,
                    bridge::Audio& out, std::string& error, std::string& diagnostics)
{
    const size_t track { layout.renderClip };
    RenderReport firstReport;
    bridge::Audio first;
    const int firstBlock { job.plugin == "melodyne" ? kMelodyneFirstBlock : kDefaultRenderBlockSize };
    const bool ok { renderTrack (document, track, firstBlock, 0, idle, first, error, &firstReport) };
    logRender (log, firstReport, 0);
    if (! ok)
        return false;
    keepRawRender (job, 1, first, log);
    if (job.plugin != "melodyne")
    {
        out = std::move (first);
        return true;
    }

    // Melodyne doubles single samples at some block starts: a second render whose block starts never meet the
    // first one's inside the region shows them
    const bridge::BlockGrid firstGrid { firstReport.blockSize, firstReport.cropFrom };
    int64_t coincidence { -1 };
    const int preRoll { bridge::chooseSecondPreRoll (layout.regions[track].frames, firstGrid, kMelodyneSecondBlock, firstReport.cropFrom, &coincidence) };
    RenderReport secondReport;
    bridge::Audio second;
    const bool ok2 { renderTrack (document, track, kMelodyneSecondBlock, preRoll, idle, second, error, &secondReport) };
    logRender (log, secondReport, preRoll);
    if (! ok2)
        return false;
    keepRawRender (job, 2, second, log);

    bridge::RepairParams params;
    params.firstGrid = firstGrid;
    params.secondGrid = { secondReport.blockSize, secondReport.cropFrom };
    const auto repair { bridge::repairRenderGlitches (first, second, params) };
    second = {};    // free it early

    std::string where;
    for (const auto frame : repair.repairedAt)
        where += (where.empty () ? " at frame " : ", ") + std::to_string (frame);
    log ("doubled-sample check: " + std::to_string (repair.repairedAt.size ()) + " repaired" + where
         + (coincidence >= 0 && coincidence < layout.regions[track].frames ? " (block grids coincide from frame " + std::to_string (coincidence) + ")" : ""));
    if (! repair.diagnostics.empty ())
    {
        log ("note: " + repair.diagnostics);
        diagnostics = repair.diagnostics;
    }
    out = std::move (first);
    return true;
}
