#pragma once

// SDK headers first: the SDK's audio file header defines a constant that clashes with a macro from Cocoa.
#include "ExamplesCommon/AudioFiles/AudioFiles.h"

#include "common/Wav.h"

#include <cstdint>
#include <utility>

// An ARA audio source backed by audio already decoded into memory. Read-only after construction, so the
// plug-in may read it from any thread.
class MemoryAudioFile : public AudioFileBase
{
public:
    MemoryAudioFile (const std::string& name, bridge::Audio audio)
    : AudioFileBase { name }, _audio { std::move (audio) }
    {}

    const bridge::Audio& audio () const { return _audio; }

    int64_t getSampleCount () const noexcept override { return static_cast<int64_t> (_audio.frames ()); }
    double getSampleRate () const noexcept override { return static_cast<double> (_audio.sampleRate); }
    int getChannelCount () const noexcept override { return _audio.channelCount (); }
    bool merits64BitSamples () const noexcept override { return false; }

    bool readSamples (int64_t samplePosition, int64_t samplesPerChannel, void* const buffers[], bool use64BitSamples) noexcept override
    {
        const int64_t frames { static_cast<int64_t> (_audio.frames ()) };
        for (int c { 0 }; c < _audio.channelCount (); ++c)
        {
            const auto& channel { _audio.channels[static_cast<size_t> (c)] };
            for (int64_t i { 0 }; i < samplesPerChannel; ++i)
            {
                const int64_t position { samplePosition + i };
                const float value { (position >= 0 && position < frames) ? channel[static_cast<size_t> (position)] : 0.0f };
                if (use64BitSamples)
                    static_cast<double*> (buffers[c])[i] = static_cast<double> (value);
                else
                    static_cast<float*> (buffers[c])[i] = value;
            }
        }
        return true;
    }

    bool saveToFile (const std::string&) override { return false; }

private:
    const bridge::Audio _audio;
};
