#pragma once

#include "common/Wav.h"

#include <string>

namespace bridge
{
    // Limits of decodeAudioFile. A longer or wider file is refused rather than decoded.
    constexpr int kMaxDecodeChannels { 16 };
    constexpr double kMaxDecodeSeconds { 3600.0 };      // at the file's own sample rate
    constexpr int kMinDecodeSampleRate { 1000 };
    constexpr int kMaxDecodeSampleRate { 768000 };

    // Decodes any audio file CoreAudio understands (WAV, AIFF, CAF, MP3, FLAC, M4A, ...) to planar float
    // at the file's own sample rate and channel count (no resampling, channel order as in the file).
    // Fails with a readable message if the file is missing, not a regular file, empty, unreadable, in an
    // unsupported format, without audio, or beyond the limits above. 'out' is only touched on success.
    bool decodeAudioFile (const std::string& path, Audio& out, std::string& error);
}
