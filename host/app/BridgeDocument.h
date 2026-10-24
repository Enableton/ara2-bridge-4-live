#pragma once

#include "TestHost.h"
#include "app/MemoryAudioFile.h"
#include "hostcore/JobLayout.h"
#include "jobio/Job.h"

#include <functional>
#include <memory>
#include <string>
#include <vector>

// Builds the ARA document for a job: one track (region sequence) per clip, each with one playback region
// placed as in the JobLayout (sample-aligned). Track i belongs to job.clips[i].
class BridgeDocument
{
public:
    BridgeDocument (PlugInEntry* entry, const bridge::Job& job, const bridge::JobLayout& layout,
                    std::vector<std::shared_ptr<MemoryAudioFile>> files);
    ~BridgeDocument ();

    BridgeDocument (const BridgeDocument&) = delete;
    BridgeDocument& operator= (const BridgeDocument&) = delete;

    // Checks the plug-in licence and starts the analysis of all audio sources. With allowLicenceDialog
    // false an unlicensed plug-in is an error (no dialog is shown); with true the plug-in may show its
    // activation dialog. Returns false with 'error' set if the plug-in is not licensed.
    bool startAnalysis (bool allowLicenceDialog, std::string& error);

    // Waits (calling idle) until the plug-in reports the analysis complete. Returns false if idle()
    // returned false first. 'seconds' gets the time spent waiting.
    bool waitForAnalysis (const std::function<bool ()>& idle, double& seconds);

    // Lets the plug-in send model updates (analysis progress, content changes). ARA hosts call this
    // periodically on the main thread while they are not editing the document (both idle functions and the
    // window's 100 ms timer do).
    void notifyModelUpdates () { _controller->notifyModelUpdates (); }

    ARADocumentController* controller () const { return _controller; }
    Document* document () const { return _document; }
    PlugInEntry* entry () const { return _entry; }

    size_t trackCount () const { return _files.size (); }
    const bridge::ClipRegion& region (size_t track) const { return _layout.regions[track]; }
    std::vector<PlaybackRegion*> regions (size_t track) const;

    const bridge::Audio& sourceAudio (size_t track) const { return _files[track]->audio (); }
    int sampleRate (size_t track) const { return _files[track]->audio ().sampleRate; }
    int channelCount (size_t track) const { return _files[track]->audio ().channelCount (); }

private:
    PlugInEntry* const _entry;
    const bridge::JobLayout _layout;
    std::unique_ptr<TestHost> _host;
    std::vector<std::shared_ptr<MemoryAudioFile>> _files;
    std::vector<RegionSequence*> _tracks;
    Document* _document {};
    ARADocumentController* _controller {};
};
