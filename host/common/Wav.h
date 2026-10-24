#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace bridge
{
    // Planar float audio: channels[c][frame]. All channels must have the same length.
    struct Audio
    {
        int sampleRate { 44100 };
        std::vector<std::vector<float>> channels;

        int channelCount () const { return static_cast<int> (channels.size ()); }
        size_t frames () const { return channels.empty () ? 0 : channels[0].size (); }
    };

    // Reads 16/24/32-bit integer PCM and 32-bit float WAV files.
    bool readWav (const std::string& path, Audio& out, std::string& error);

    // Writes a 32-bit float WAV file.
    bool writeWavFloat32 (const std::string& path, const Audio& audio, std::string& error);

    // Copies frameCount frames starting at startFrame; anything outside the source is zero.
    Audio cropAudio (const Audio& audio, int64_t startFrame, int64_t frameCount);
}
