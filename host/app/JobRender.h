#pragma once

#include "app/BridgeDocument.h"
#include "common/Wav.h"
#include "hostcore/JobLayout.h"
#include "jobio/Job.h"

#include <functional>
#include <string>

// Renders the job's clip for result.wav, for headless mode and for Apply in the window alike.
// VocAlign: one render. Melodyne: two renders (block sizes 4096 and 3001, the second with a pre-roll that
// keeps the two block grids from coinciding inside the region) and the doubled-sample repair
// (hostcore/RenderRepair.h); disagreements without the glitch signature go into 'diagnostics'.
// With job.keepRaw each render is also written, as the plug-in returned it, to <job.dir>/render-raw-<n>.wav
// (hostcore/KeepRaw.h; n = 1, 2) before the repair; a failure there is only logged.
// idle: as for renderTrack (returning false stops the render). log: progress lines.
bool renderJobClip (BridgeDocument& document, const bridge::Job& job, const bridge::JobLayout& layout,
                    const std::function<bool ()>& idle, const std::function<void (const std::string&)>& log,
                    bridge::Audio& out, std::string& error, std::string& diagnostics);
