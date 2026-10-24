#include "audio/AudioDecode.h"

#import <AudioToolbox/AudioToolbox.h>
#import <Foundation/Foundation.h>

#include <algorithm>
#include <cerrno>
#include <climits>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <new>
#include <sys/stat.h>

namespace bridge
{
    namespace
    {
        constexpr UInt32 kChunkFrames { 65536 };
        constexpr uint64_t kMaxSamples { 1ULL << 30 };      // frames x channels: 4 GiB of floats

        // Four-character codes are how AudioToolbox reports most file errors.
        std::string fourCC (OSStatus status)
        {
            const uint32_t v { static_cast<uint32_t> (status) };
            const char text[4] { static_cast<char> (v >> 24), static_cast<char> (v >> 16), static_cast<char> (v >> 8), static_cast<char> (v) };
            for (const char c : text)
                if (c < 0x20 || c > 0x7E)
                    return {};
            return std::string ("'") + std::string (text, 4) + "'";
        }

        std::string describeStatus (OSStatus status)
        {
            const char* meaning { nullptr };
            switch (status)
            {
                case kAudioFileUnsupportedFileTypeError:        meaning = "not a recognised audio file type"; break;
                case kAudioFileUnsupportedDataFormatError:      meaning = "unsupported audio data format"; break;
                case kAudioFileInvalidFileError:                meaning = "damaged or invalid file"; break;
                case kAudioFileInvalidChunkError:               meaning = "damaged file (bad chunk)"; break;
                case kAudioFilePermissionsError:                meaning = "permission denied"; break;
                case kAudioFileFileNotFoundError:               meaning = "file not found"; break;
                case kAudioFileEndOfFileError:                  meaning = "unexpected end of file"; break;
                case kAudioFilePositionError:                   meaning = "bad file position"; break;
                case kAudioFileUnspecifiedError:                meaning = "unspecified file error"; break;
                case kAudioFileOperationNotSupportedError:      meaning = "operation not supported"; break;
                case kExtAudioFileError_InvalidDataFormat:      meaning = "invalid data format"; break;
                case kExtAudioFileError_NonPCMClientFormat:     meaning = "cannot convert to PCM"; break;
                case kExtAudioFileError_InvalidChannelMap:      meaning = "unsupported channel layout"; break;
                case kExtAudioFileError_InvalidSeek:            meaning = "offset out of bounds"; break;
                default: break;
            }
            std::string text { "OSStatus " + std::to_string (static_cast<int> (status)) };
            const std::string code { fourCC (status) };
            if (! code.empty ())
                text += " " + code;
            return meaning != nullptr ? std::string (meaning) + " (" + text + ")" : text;
        }

        bool fail (std::string& error, const std::string& message)
        {
            error = message;
            return false;
        }

        struct FileGuard
        {
            ExtAudioFileRef file { nullptr };
            ~FileGuard () { if (file != nullptr) ExtAudioFileDispose (file); }
        };

        bool decode (const std::string& path, Audio& out, std::string& error)
        {
            if (path.empty () || path.find ('\0') != std::string::npos)
                return fail (error, "invalid audio file path");

            struct stat info {};
            if (::stat (path.c_str (), &info) != 0)
                return fail (error, "cannot read " + path + ": " + std::strerror (errno));
            if (! S_ISREG (info.st_mode))
                return fail (error, path + " is not a regular file");
            if (info.st_size == 0)
                return fail (error, path + " is empty");

            char resolved[PATH_MAX];
            if (::realpath (path.c_str (), resolved) == nullptr)
                return fail (error, "cannot resolve " + path + ": " + std::strerror (errno));

            // Built from the raw bytes, so a path that is not valid UTF-8 cannot produce a nil URL.
            CFURLRef url = CFURLCreateFromFileSystemRepresentation (kCFAllocatorDefault, reinterpret_cast<const UInt8*> (resolved),
                                                                    static_cast<CFIndex> (std::strlen (resolved)), false);
            if (url == nullptr)
                return fail (error, "invalid audio file path " + path);

            FileGuard guard;
            OSStatus status { ExtAudioFileOpenURL (url, &guard.file) };
            CFRelease (url);
            if (status != noErr)
            {
                guard.file = nullptr;
                return fail (error, "cannot open audio file " + path + ": " + describeStatus (status));
            }

            AudioStreamBasicDescription fileFormat {};
            UInt32 size { sizeof (fileFormat) };
            status = ExtAudioFileGetProperty (guard.file, kExtAudioFileProperty_FileDataFormat, &size, &fileFormat);
            if (status != noErr)
                return fail (error, "cannot read the format of " + path + ": " + describeStatus (status));

            const UInt32 channels { fileFormat.mChannelsPerFrame };
            const double rate { fileFormat.mSampleRate };
            if (channels == 0)
                return fail (error, path + " has no audio channels");
            if (channels > static_cast<UInt32> (kMaxDecodeChannels))
                return fail (error, path + " has " + std::to_string (channels) + " channels; at most " + std::to_string (kMaxDecodeChannels) + " are supported");
            if (! std::isfinite (rate) || rate < kMinDecodeSampleRate || rate > kMaxDecodeSampleRate)
                return fail (error, path + " has an unsupported sample rate (" + std::to_string (rate) + " Hz)");

            // The length is exact for PCM and usually an estimate for compressed formats; it can also be
            // unknown, so the same limits are enforced again while reading.
            const uint64_t maxFrames { std::min<uint64_t> (static_cast<uint64_t> (kMaxDecodeSeconds * rate), kMaxSamples / channels) };
            SInt64 declared { 0 };
            size = sizeof (declared);
            if (ExtAudioFileGetProperty (guard.file, kExtAudioFileProperty_FileLengthFrames, &size, &declared) != noErr || declared < 0)
                declared = 0;
            if (static_cast<uint64_t> (declared) > maxFrames)
                return fail (error, path + " is too long (" + std::to_string (static_cast<double> (declared) / rate) + " s, limit "
                                        + std::to_string (static_cast<long long> (kMaxDecodeSeconds)) + " s)");

            // Same rate and channel count as the file; only the sample format changes.
            AudioStreamBasicDescription client {};
            client.mSampleRate = rate;
            client.mFormatID = kAudioFormatLinearPCM;
            client.mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked | kAudioFormatFlagIsNonInterleaved;
            client.mBitsPerChannel = 32;
            client.mChannelsPerFrame = channels;
            client.mFramesPerPacket = 1;
            client.mBytesPerFrame = 4;
            client.mBytesPerPacket = 4;
            status = ExtAudioFileSetProperty (guard.file, kExtAudioFileProperty_ClientDataFormat, sizeof (client), &client);
            if (status != noErr)
                return fail (error, "cannot convert " + path + " to float: " + describeStatus (status));

            Audio decoded;
            decoded.sampleRate = static_cast<int> (std::lround (rate));
            decoded.channels.assign (channels, std::vector<float> ());
            for (auto& channel : decoded.channels)
                channel.reserve (static_cast<size_t> (declared) + kChunkFrames);       // declared <= maxFrames, checked above

            std::vector<uint8_t> storage (offsetof (AudioBufferList, mBuffers) + sizeof (AudioBuffer) * channels);
            auto* list = reinterpret_cast<AudioBufferList*> (storage.data ());
            size_t total { 0 };

            // Reads straight into the destination vectors; no per-sample work and no extra copy.
            for (;;)
            {
                for (auto& channel : decoded.channels)
                    channel.resize (total + kChunkFrames);
                list->mNumberBuffers = channels;
                for (UInt32 c { 0 }; c < channels; ++c)
                {
                    list->mBuffers[c].mNumberChannels = 1;
                    list->mBuffers[c].mDataByteSize = kChunkFrames * sizeof (float);
                    list->mBuffers[c].mData = decoded.channels[c].data () + total;
                }
                UInt32 frames { kChunkFrames };
                status = ExtAudioFileRead (guard.file, &frames, list);
                if (status != noErr)
                    return fail (error, "error while reading " + path + ": " + describeStatus (status));
                if (frames == 0)
                    break;
                total += frames;
                if (total > maxFrames)
                    return fail (error, path + " is too long (limit " + std::to_string (static_cast<long long> (kMaxDecodeSeconds)) + " s)");
            }

            if (total == 0)
                return fail (error, path + " contains no audio");
            // For PCM the declared length is exact (CoreAudio already limits it to what the file holds), so
            // fewer frames at EOF means the file shrank while it was read. Compressed lengths are only estimates.
            if (fileFormat.mFormatID == kAudioFormatLinearPCM && static_cast<uint64_t> (declared) > total)
                return fail (error, path + ": file changed or truncated while reading");
            for (auto& channel : decoded.channels)
                channel.resize (total);
            out = std::move (decoded);
            return true;
        }
    }

    bool decodeAudioFile (const std::string& path, Audio& out, std::string& error)
    {
        @autoreleasepool
        {
            try
            {
                return decode (path, out, error);
            }
            catch (const std::bad_alloc&)
            {
                return fail (error, "out of memory decoding " + path);
            }
            catch (const std::exception& e)
            {
                return fail (error, "cannot decode " + path + ": " + e.what ());
            }
        }
    }
}
