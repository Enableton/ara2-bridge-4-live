#include "app/OfflineRenderer.h"

#include "ExamplesCommon/PlugInHosting/VST3Loader.h"

#include <algorithm>
#include <atomic>
#include <cstdlib>
#include <string>
#include <chrono>
#include <thread>
#include <vector>

namespace
{
    // switches the loader to offline processing for the lifetime of the object
    struct OfflineMode
    {
        OfflineMode () { VST3SetOfflineRendering (1); }
        ~OfflineMode () { VST3SetOfflineRendering (0); }
    };
}

bool renderTrack (BridgeDocument& document, size_t track, int blockSize, int preRoll, const std::function<bool ()>& idle,
                  bridge::Audio& out, std::string& error, RenderReport* report)
{
    if (blockSize < 1 || blockSize > kMaxRenderBlockSize || preRoll < 0 || preRoll > kMaxRenderBlockSize)
    {
        error = "invalid render block size " + std::to_string (blockSize) + " or pre-roll " + std::to_string (preRoll);
        return false;
    }
    const auto regions { document.regions (track) };
    if (regions.empty ())
    {
        error = "the track has no region to render";
        return false;
    }
    const auto& region { document.region (track) };
    const int sampleRate { document.sampleRate (track) };
    const int channelCount { document.channelCount (track) };
    const auto started { std::chrono::steady_clock::now () };

    OfflineMode offline;
    auto instance { document.entry ()->createPlugInInstance () };
    instance->bindToDocumentControllerWithRoles (document.controller ()->getDocumentController ()->getRef (), ARA::kARAPlaybackRendererRole);
    auto renderer { instance->getPlaybackRenderer () };

    RenderReport info;
    for (auto* playbackRegion : regions)
    {
        renderer.addPlaybackRegion (document.controller ()->getRef (playbackRegion));
        double head { 0.0 }, tail { 0.0 };
        document.controller ()->getPlaybackRegionHeadAndTailTime (playbackRegion, &head, &tail);
        info.headSec = std::max (info.headSec, head);
        info.tailSec = std::max (info.tailSec, tail);
    }

    instance->startRendering (channelCount, blockSize, static_cast<double> (sampleRate));
    info.latency = instance->getLatencySamples ();

    bool ok { false };
    bridge::RenderSpan span;
    if (bridge::renderSpan (region.playbackStart, region.frames, info.headSec, info.tailSec, info.latency, sampleRate, span, error))
    {
        span.first -= preRoll;
        span.cropFrom += preRoll;
        info.blockSize = blockSize;
        info.cropFrom = span.cropFrom;
        const size_t length { static_cast<size_t> (span.end - span.first) };
        std::vector<std::vector<float>> buffer (static_cast<size_t> (channelCount), std::vector<float> (length, 0.0f));

        std::atomic<bool> finished { false };
        std::atomic<bool> stop { false };
        PlugInInstance* plugIn { instance.get () };
        // not registered as a 'render thread': this is an offline render, and plug-ins (VocAlign) read audio samples while processing
        const char* testHang { std::getenv ("ARABRIDGE_TEST_HANG") };   // test only, see main.mm
        const std::string hang { testHang ? testHang : "" };
        std::thread worker ([&] {
            if (hang == "render")
                for (;;)
                    std::this_thread::sleep_for (std::chrono::seconds (1));
            if (hang == "render-soft")
                while (! stop)
                    std::this_thread::sleep_for (std::chrono::milliseconds (10));
            std::vector<float*> pointers (static_cast<size_t> (channelCount));
            for (auto position { span.first }; position < span.end && ! stop; position += blockSize)
            {
                const int count { static_cast<int> (std::min<int64_t> (blockSize, span.end - position)) };
                for (size_t c { 0 }; c < pointers.size (); ++c)
                    pointers[c] = buffer[c].data () + (position - span.first);
                plugIn->renderSamples (count, position, pointers.data ());
            }
            finished = true;
        });
        while (! finished)
            if (! idle ())
                stop = true;
        worker.join ();

        if (stop)
        {
            error = "the render was stopped";
        }
        else
        {
            out.sampleRate = sampleRate;
            out.channels.assign (static_cast<size_t> (channelCount), std::vector<float> ());
            for (size_t c { 0 }; c < out.channels.size (); ++c)
                out.channels[c].assign (buffer[c].begin () + span.cropFrom, buffer[c].begin () + span.cropFrom + span.frames);
            ok = true;
        }
    }

    instance->stopRendering ();
    for (auto* playbackRegion : regions)
        renderer.removePlaybackRegion (document.controller ()->getRef (playbackRegion));
    instance.reset ();

    info.seconds = std::chrono::duration<double> (std::chrono::steady_clock::now () - started).count ();
    if (report)
        *report = info;
    return ok;
}
