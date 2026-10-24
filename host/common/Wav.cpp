#include "common/Wav.h"

#include <algorithm>
#include <cstring>
#include <fstream>
#include <iterator>

namespace bridge
{
    namespace
    {
        uint16_t rd16 (const uint8_t* p) { return static_cast<uint16_t> (p[0] | (p[1] << 8)); }

        uint32_t rd32 (const uint8_t* p)
        {
            return static_cast<uint32_t> (p[0]) | (static_cast<uint32_t> (p[1]) << 8) | (static_cast<uint32_t> (p[2]) << 16) | (static_cast<uint32_t> (p[3]) << 24);
        }

        void wr16 (std::ostream& s, uint16_t v)
        {
            const char b[2] { static_cast<char> (v & 0xFF), static_cast<char> ((v >> 8) & 0xFF) };
            s.write (b, 2);
        }

        void wr32 (std::ostream& s, uint32_t v)
        {
            const char b[4] { static_cast<char> (v & 0xFF), static_cast<char> ((v >> 8) & 0xFF), static_cast<char> ((v >> 16) & 0xFF), static_cast<char> ((v >> 24) & 0xFF) };
            s.write (b, 4);
        }
    }

    bool readWav (const std::string& path, Audio& out, std::string& error)
    {
        std::ifstream file (path, std::ios::binary);
        if (! file)
        {
            error = "cannot open " + path;
            return false;
        }
        const std::vector<uint8_t> d { std::istreambuf_iterator<char> (file), std::istreambuf_iterator<char> () };
        if (d.size () < 12 || std::memcmp (d.data (), "RIFF", 4) != 0 || std::memcmp (d.data () + 8, "WAVE", 4) != 0)
        {
            error = path + " is not a RIFF/WAVE file";
            return false;
        }

        uint16_t format { 0 }, channels { 0 }, bits { 0 };
        uint32_t rate { 0 };
        const uint8_t* data { nullptr };
        size_t dataSize { 0 };

        size_t pos { 12 };
        while (pos + 8 <= d.size ())
        {
            const uint32_t size { rd32 (&d[pos + 4]) };
            const uint8_t* body { &d[pos + 8] };
            if (std::memcmp (&d[pos], "fmt ", 4) == 0 && size >= 16 && pos + 8 + 16 <= d.size ())
            {
                format = rd16 (body);
                channels = rd16 (body + 2);
                rate = rd32 (body + 4);
                bits = rd16 (body + 14);
                if (format == 0xFFFE && size >= 26 && pos + 8 + 26 <= d.size ())
                    format = rd16 (body + 24);      // WAVE_FORMAT_EXTENSIBLE: real format is the sub-format
            }
            else if (std::memcmp (&d[pos], "data", 4) == 0)
            {
                data = body;
                dataSize = std::min<size_t> (size, d.size () - pos - 8);
                break;
            }
            pos += 8 + static_cast<size_t> (size) + (size & 1U);
        }

        const bool supported { (format == 3 && bits == 32) || (format == 1 && (bits == 16 || bits == 24 || bits == 32)) };
        if (data == nullptr || channels == 0 || ! supported)
        {
            error = path + ": unsupported or incomplete WAV (format " + std::to_string (format) + ", " + std::to_string (bits) + " bits)";
            return false;
        }

        const size_t bytesPerSample { bits / 8U };
        const size_t frames { dataSize / (bytesPerSample * channels) };
        out.sampleRate = static_cast<int> (rate);
        out.channels.assign (channels, std::vector<float> (frames));
        for (size_t f { 0 }; f < frames; ++f)
        {
            for (size_t c { 0 }; c < channels; ++c)
            {
                const uint8_t* p { data + (f * channels + c) * bytesPerSample };
                float v { 0.0f };
                if (format == 3)
                {
                    std::memcpy (&v, p, 4);
                }
                else if (bits == 16)
                {
                    v = static_cast<float> (static_cast<int16_t> (rd16 (p))) / 32768.0f;
                }
                else if (bits == 24)
                {
                    int32_t s { p[0] | (p[1] << 8) | (p[2] << 16) };
                    if ((s & 0x800000) != 0)
                        s -= 0x1000000;
                    v = static_cast<float> (s) / 8388608.0f;
                }
                else
                {
                    v = static_cast<float> (static_cast<int32_t> (rd32 (p))) / 2147483648.0f;
                }
                out.channels[c][f] = v;
            }
        }
        return true;
    }

    bool writeWavFloat32 (const std::string& path, const Audio& audio, std::string& error)
    {
        const size_t channelTotal { audio.channels.size () };
        if (channelTotal == 0)
        {
            error = "no channels to write";
            return false;
        }
        if (channelTotal > 65535)
        {
            error = "too many channels";
            return false;
        }
        if (audio.sampleRate <= 0)
        {
            error = "invalid sample rate";
            return false;
        }
        for (const auto& channel : audio.channels)
        {
            if (channel.size () != audio.frames ())
            {
                error = "channels have different lengths";
                return false;
            }
        }
        if (static_cast<uint64_t> (audio.frames ()) * channelTotal * 4U > 0xFFFFFFFFULL - 36U)
        {
            error = "audio too long for a WAV file";
            return false;
        }

        std::ofstream file (path, std::ios::binary);
        if (! file)
        {
            error = "cannot write " + path;
            return false;
        }
        const uint32_t channels { static_cast<uint32_t> (channelTotal) };
        const uint32_t frames { static_cast<uint32_t> (audio.frames ()) };
        const uint32_t rate { static_cast<uint32_t> (audio.sampleRate) };
        const uint32_t dataBytes { frames * channels * 4U };

        file.write ("RIFF", 4);
        wr32 (file, 36U + dataBytes);
        file.write ("WAVEfmt ", 8);
        wr32 (file, 16U);
        wr16 (file, 3U);                                // IEEE float
        wr16 (file, static_cast<uint16_t> (channels));
        wr32 (file, rate);
        wr32 (file, rate * channels * 4U);
        wr16 (file, static_cast<uint16_t> (channels * 4U));
        wr16 (file, 32U);
        file.write ("data", 4);
        wr32 (file, dataBytes);

        std::vector<float> block (channels);
        for (uint32_t f { 0 }; f < frames; ++f)
        {
            for (uint32_t c { 0 }; c < channels; ++c)
                block[c] = audio.channels[c][f];
            file.write (reinterpret_cast<const char*> (block.data ()), static_cast<std::streamsize> (channels * 4U));
        }
        file.close ();
        if (file.fail ())
        {
            error = "write failed for " + path;
            return false;
        }
        return true;
    }

    Audio cropAudio (const Audio& audio, int64_t startFrame, int64_t frameCount)
    {
        frameCount = std::max<int64_t> (0, frameCount);
        Audio result;
        result.sampleRate = audio.sampleRate;
        result.channels.assign (audio.channels.size (), std::vector<float> (static_cast<size_t> (frameCount), 0.0f));
        for (size_t c { 0 }; c < audio.channels.size (); ++c)
        {
            for (int64_t i { 0 }; i < frameCount; ++i)
            {
                const int64_t source { startFrame + i };
                if (source >= 0 && source < static_cast<int64_t> (audio.channels[c].size ()))
                    result.channels[c][static_cast<size_t> (i)] = audio.channels[c][static_cast<size_t> (source)];
            }
        }
        return result;
    }
}
