#pragma once

#include "app/BridgeDocument.h"
#include "common/Wav.h"

#include <cstdint>
#include <functional>
#include <string>

struct RenderReport
{
    int latency { -1 };         // as reported by the plug-in after startRendering (-1: unknown)
    double headSec { 0.0 };     // the plug-in's head and tail time for the track's region(s)
    double tailSec { 0.0 };
    double seconds { 0.0 };     // wall-clock time of the render
    int blockSize { 0 };        // process blocks started at buffer indices 0, blockSize, ...
    int64_t cropFrom { 0 };     // buffer index of the region's first frame
};

// Renders one track's region offline through a fresh playback-renderer instance of the plug-in.
// The render runs on a worker thread; the calling thread keeps calling idle() (pump the run loop) until it
// finishes. If idle() returns false the worker stops after the current block and the render fails.
// Head and tail time are rendered and cropped, a reported latency is compensated, so 'out' has exactly the
// region's frames at the track's sample rate and channel count.
// blockSize: samples per process() call (1 .. kMaxRenderBlockSize). preRoll: frames rendered (and dropped)
// before the usual start, which moves the block grid (0 .. kMaxRenderBlockSize).
constexpr int kDefaultRenderBlockSize { 2048 };
constexpr int kMaxRenderBlockSize { 8192 };
bool renderTrack (BridgeDocument& document, size_t track, int blockSize, int preRoll, const std::function<bool ()>& idle,
                  bridge::Audio& out, std::string& error, RenderReport* report = nullptr);
