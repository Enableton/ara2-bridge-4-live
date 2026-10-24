#include "app/BridgeDocument.h"

#include <chrono>
#include <cstdio>

BridgeDocument::BridgeDocument (PlugInEntry* entry, const bridge::Job& job, const bridge::JobLayout& layout,
                                std::vector<std::shared_ptr<MemoryAudioFile>> files)
: _entry { entry },
  _layout { layout },
  _host { std::make_unique<TestHost> () },
  _files { std::move (files) }
{
    _document = _host->addDocument ("ARABridge " + job.id, entry);
    _controller = _host->getDocumentController (_document);

    _controller->beginEditing ();
    auto musicalContext { _host->addMusicalContext (_document, "Musical Context", { 1.0f, 0.0f, 0.0f }) };
    for (size_t i { 0 }; i < job.clips.size (); ++i)
    {
        const auto& clip { job.clips[i] };
        const auto& region { _layout.regions[i] };
        const double sampleRate { static_cast<double> (_files[i]->audio ().sampleRate) };
        // persistent IDs are unique per job and role
        const std::string id { job.id + ":" + clip.role };

        auto regionSequence { _host->addRegionSequence (_document, clip.name + " (" + clip.role + ")", musicalContext, { 0.0f, 1.0f, 0.0f }) };
        auto audioSource { _host->addAudioSource (_document, _files[i].get (), "audioSource " + id) };
        auto audioModification { _host->addAudioModification (_document, audioSource, clip.name, "audioModification " + id) };

        // whole samples: a region start or length between two samples would make the plug-in interpolate
        const double start { static_cast<double> (region.sourceStart) / sampleRate };
        const double duration { static_cast<double> (region.frames) / sampleRate };
        const double playbackStart { static_cast<double> (region.playbackStart) / sampleRate };
        _host->addPlaybackRegion (_document, audioModification, ARA::kARAPlaybackTransformationNoChanges,
                                  start, duration, playbackStart, duration, regionSequence, clip.name, { 0.0f, 0.0f, 1.0f });
        _tracks.push_back (regionSequence);
    }
    _controller->endEditing ();

    for (auto& audioSource : _document->getAudioSources ())
        _controller->enableAudioSourceSamplesAccess (audioSource.get (), true);
}

BridgeDocument::~BridgeDocument ()
{
    for (auto& audioSource : _document->getAudioSources ())
        _controller->enableAudioSourceSamplesAccess (audioSource.get (), false);
    _host.reset ();     // destroys the document and its document controller
}

bool BridgeDocument::startAnalysis (bool allowLicenceDialog, std::string& error)
{
    const auto factory { _entry->getARAFactory () };
    const auto count { static_cast<ARA::ARASize> (factory->analyzeableContentTypesCount) };
    const auto types { factory->analyzeableContentTypes };
    auto dc { _controller->getDocumentController () };

    // the SDK's ARADocumentController::requestAudioSourceContentAnalysis would turn a command line process
    // into a foreground app and let the plug-in show its activation dialog, so the licence is checked here
    if (! dc->isLicensedForCapabilities (false, count, types, ARA::kARAPlaybackTransformationNoChanges))
    {
        if (! allowLicenceDialog || ! dc->isLicensedForCapabilities (true, count, types, ARA::kARAPlaybackTransformationNoChanges))
        {
            error = std::string { factory->plugInName } + " is not licensed (or not activated) on this Mac; open it once in a DAW or in BridgeHost's window to activate it";
            return false;
        }
    }

    if (count > 0)
        for (auto& audioSource : _document->getAudioSources ())
            dc->requestAudioSourceContentAnalysis (_controller->getRef (audioSource.get ()), count, types);
    return true;
}

bool BridgeDocument::waitForAnalysis (const std::function<bool ()>& idle, double& seconds)
{
    const auto factory { _entry->getARAFactory () };
    auto dc { _controller->getDocumentController () };
    const auto started { std::chrono::steady_clock::now () };
    while (true)
    {
        bool incomplete { false };
        for (auto& audioSource : _document->getAudioSources ())
            for (ARA::ARASize t { 0 }; t < factory->analyzeableContentTypesCount && ! incomplete; ++t)
                incomplete = dc->isAudioSourceContentAnalysisIncomplete (_controller->getRef (audioSource.get ()), factory->analyzeableContentTypes[t]);
        seconds = std::chrono::duration<double> (std::chrono::steady_clock::now () - started).count ();
        if (! incomplete)
            return true;
        if (! idle ())
            return false;
    }
}

std::vector<PlaybackRegion*> BridgeDocument::regions (size_t track) const
{
    std::vector<PlaybackRegion*> result;
    if (track < _tracks.size ())
        for (auto* region : _tracks[track]->getPlaybackRegions ())
            result.push_back (region);
    return result;
}
