#include "check.h"
#include "testutil.h"

#include "common/Wav.h"

#include <cstdint>
#include <string>
#include <vector>

namespace
{
    bridge::Audio makeStereoRamp (int frames)
    {
        bridge::Audio audio;
        audio.sampleRate = 48000;
        audio.channels.assign (2, std::vector<float> (static_cast<size_t> (frames)));
        for (int i = 0; i < frames; ++i)
        {
            audio.channels[0][static_cast<size_t> (i)] = static_cast<float> (i) / static_cast<float> (frames);
            audio.channels[1][static_cast<size_t> (i)] = -static_cast<float> (i) / static_cast<float> (frames);
        }
        return audio;
    }

    void put16 (std::string& s, uint16_t v) { s.push_back (static_cast<char> (v & 0xFF)); s.push_back (static_cast<char> (v >> 8)); }
    void put32 (std::string& s, uint32_t v) { put16 (s, static_cast<uint16_t> (v & 0xFFFF)); put16 (s, static_cast<uint16_t> (v >> 16)); }
}

TEST (wav_float32_roundtrip_is_exact)
{
    const std::string dir { makeTempDir ("wav") };
    const bridge::Audio original { makeStereoRamp (1000) };
    std::string error;

    CHECK (bridge::writeWavFloat32 (dir + "/a.wav", original, error));

    bridge::Audio loaded;
    REQUIRE (bridge::readWav (dir + "/a.wav", loaded, error));
    CHECK (loaded.sampleRate == 48000);
    REQUIRE (loaded.channelCount () == 2);
    REQUIRE (loaded.frames () == 1000);
    CHECK (loaded.channels == original.channels);
}

TEST (wav_reads_16_bit_pcm)
{
    const std::string dir { makeTempDir ("wav16") };

    // mono, 44100 Hz, 3 samples: 0, 16384, -32768
    std::string bytes;
    bytes += "RIFF";
    put32 (bytes, 36 + 6);
    bytes += "WAVEfmt ";
    put32 (bytes, 16);
    put16 (bytes, 1);        // PCM
    put16 (bytes, 1);        // channels
    put32 (bytes, 44100);
    put32 (bytes, 44100 * 2);
    put16 (bytes, 2);
    put16 (bytes, 16);
    bytes += "data";
    put32 (bytes, 6);
    put16 (bytes, 0);
    put16 (bytes, 16384);
    put16 (bytes, 0x8000);
    writeTextFile (dir + "/pcm16.wav", bytes);

    bridge::Audio audio;
    std::string error;
    REQUIRE (bridge::readWav (dir + "/pcm16.wav", audio, error));
    CHECK (audio.sampleRate == 44100);
    REQUIRE (audio.channelCount () == 1);
    REQUIRE (audio.frames () == 3);
    CHECK_NEAR (audio.channels[0][0], 0.0, 1e-9);
    CHECK_NEAR (audio.channels[0][1], 0.5, 1e-9);
    CHECK_NEAR (audio.channels[0][2], -1.0, 1e-9);
}

TEST (wav_rejects_garbage)
{
    const std::string dir { makeTempDir ("wavbad") };
    writeTextFile (dir + "/bad.wav", "this is not a wav file at all");

    bridge::Audio audio;
    std::string error;
    CHECK (! bridge::readWav (dir + "/bad.wav", audio, error));
    CHECK (! error.empty ());
    CHECK (! bridge::readWav (dir + "/missing.wav", audio, error));
}

TEST (wav_crop_copies_a_range_and_zero_pads)
{
    const bridge::Audio ramp { makeStereoRamp (10) };

    const bridge::Audio inside { bridge::cropAudio (ramp, 2, 3) };
    REQUIRE (inside.channelCount () == 2);
    REQUIRE (inside.frames () == 3);
    CHECK (inside.sampleRate == 48000);
    CHECK_NEAR (inside.channels[0][0], 0.2, 1e-6);
    CHECK_NEAR (inside.channels[1][2], -0.4, 1e-6);

    const bridge::Audio padded { bridge::cropAudio (ramp, 8, 5) };
    REQUIRE (padded.channelCount () == 2);
    REQUIRE (padded.frames () == 5);
    CHECK_NEAR (padded.channels[0][1], 0.9, 1e-6);
    CHECK_NEAR (padded.channels[0][2], 0.0, 1e-9);
    CHECK_NEAR (padded.channels[0][4], 0.0, 1e-9);
}

TEST (wav_reads_24_bit_pcm_with_sign_extension)
{
    const std::string dir { makeTempDir ("wav24") };

    // mono, 48000 Hz, 3 samples: 0, +full scale (0x7FFFFF), -full scale (0x800000)
    std::string bytes;
    bytes += "RIFF";
    put32 (bytes, 36 + 9 + 1);      // the odd data chunk is followed by a pad byte
    bytes += "WAVEfmt ";
    put32 (bytes, 16);
    put16 (bytes, 1);
    put16 (bytes, 1);
    put32 (bytes, 48000);
    put32 (bytes, 48000 * 3);
    put16 (bytes, 3);
    put16 (bytes, 24);
    bytes += "data";
    put32 (bytes, 9);
    bytes += std::string ("\x00\x00\x00", 3);
    bytes += "\xFF\xFF\x7F";
    bytes += std::string ("\x00\x00\x80", 3);
    bytes += std::string (1, '\0');
    writeTextFile (dir + "/pcm24.wav", bytes);

    bridge::Audio audio;
    std::string error;
    REQUIRE (bridge::readWav (dir + "/pcm24.wav", audio, error));
    CHECK (audio.sampleRate == 48000);
    REQUIRE (audio.channelCount () == 1);
    REQUIRE (audio.frames () == 3);
    CHECK_NEAR (audio.channels[0][0], 0.0, 1e-9);
    CHECK_NEAR (audio.channels[0][1], 8388607.0 / 8388608.0, 1e-7);
    CHECK_NEAR (audio.channels[0][2], -1.0, 1e-9);
}

TEST (wav_reads_extensible_float32)
{
    const std::string dir { makeTempDir ("wavext") };

    // mono, 44100 Hz, WAVE_FORMAT_EXTENSIBLE with a float sub-format, 2 samples: 0.25, -0.5
    const float samples[2] { 0.25f, -0.5f };
    std::string bytes;
    bytes += "RIFF";
    put32 (bytes, 4 + 8 + 40 + 8 + 8);
    bytes += "WAVEfmt ";
    put32 (bytes, 40);
    put16 (bytes, 0xFFFE);
    put16 (bytes, 1);
    put32 (bytes, 44100);
    put32 (bytes, 44100 * 4);
    put16 (bytes, 4);
    put16 (bytes, 32);
    put16 (bytes, 22);              // extension size
    put16 (bytes, 32);              // valid bits
    put32 (bytes, 4);               // channel mask
    put16 (bytes, 3);               // sub-format: IEEE float
    bytes += std::string ("\x00\x00\x00\x00\x10\x00\x80\x00\x00\xAA\x00\x38\x9B\x71", 14);
    bytes += "data";
    put32 (bytes, 8);
    bytes.append (reinterpret_cast<const char*> (samples), sizeof (samples));
    writeTextFile (dir + "/ext.wav", bytes);

    bridge::Audio audio;
    std::string error;
    REQUIRE (bridge::readWav (dir + "/ext.wav", audio, error));
    REQUIRE (audio.channelCount () == 1);
    REQUIRE (audio.frames () == 2);
    CHECK_NEAR (audio.channels[0][0], 0.25, 1e-9);
    CHECK_NEAR (audio.channels[0][1], -0.5, 1e-9);
}

TEST (wav_skips_odd_sized_chunk_before_data)
{
    const std::string dir { makeTempDir ("wavjunk") };

    // A 3-byte chunk is followed by one pad byte; the data chunk comes after that.
    std::string bytes;
    bytes += "RIFF";
    put32 (bytes, 4 + 24 + 12 + 8 + 4);
    bytes += "WAVEfmt ";
    put32 (bytes, 16);
    put16 (bytes, 1);
    put16 (bytes, 1);
    put32 (bytes, 44100);
    put32 (bytes, 44100 * 2);
    put16 (bytes, 2);
    put16 (bytes, 16);
    bytes += "junk";
    put32 (bytes, 3);
    bytes += "abc";
    bytes += std::string (1, '\0');   // pad byte
    bytes += "data";
    put32 (bytes, 4);
    put16 (bytes, 16384);
    put16 (bytes, 0xC000);
    writeTextFile (dir + "/junk.wav", bytes);

    bridge::Audio audio;
    std::string error;
    REQUIRE (bridge::readWav (dir + "/junk.wav", audio, error));
    REQUIRE (audio.channelCount () == 1);
    REQUIRE (audio.frames () == 2);
    CHECK_NEAR (audio.channels[0][0], 0.5, 1e-9);
    CHECK_NEAR (audio.channels[0][1], -0.5, 1e-9);
}

TEST (wav_rejects_zero_channels_in_file)
{
    const std::string dir { makeTempDir ("wavzero") };

    std::string bytes;
    bytes += "RIFF";
    put32 (bytes, 36 + 4);
    bytes += "WAVEfmt ";
    put32 (bytes, 16);
    put16 (bytes, 1);
    put16 (bytes, 0);               // zero channels
    put32 (bytes, 44100);
    put32 (bytes, 0);
    put16 (bytes, 0);
    put16 (bytes, 16);
    bytes += "data";
    put32 (bytes, 4);
    put32 (bytes, 0);
    writeTextFile (dir + "/zero.wav", bytes);

    bridge::Audio audio;
    std::string error;
    CHECK (! bridge::readWav (dir + "/zero.wav", audio, error));
    CHECK (! error.empty ());
}

TEST (wav_write_rejects_ragged_channels)
{
    const std::string dir { makeTempDir ("wavragged") };
    bridge::Audio audio;
    audio.channels.push_back (std::vector<float> (4, 0.5f));
    audio.channels.push_back (std::vector<float> (6, 0.5f));

    std::string error;
    CHECK (! bridge::writeWavFloat32 (dir + "/ragged.wav", audio, error));
    CHECK (error == "channels have different lengths");
}

TEST (wav_write_rejects_zero_channels)
{
    const std::string dir { makeTempDir ("wavnochan") };
    const bridge::Audio audio;

    std::string error;
    CHECK (! bridge::writeWavFloat32 (dir + "/none.wav", audio, error));
    CHECK (! error.empty ());
}

TEST (wav_crop_with_negative_count_is_empty)
{
    const bridge::Audio ramp { makeStereoRamp (10) };

    const bridge::Audio cropped { bridge::cropAudio (ramp, 2, -5) };
    CHECK (cropped.channelCount () == 2);
    CHECK (cropped.frames () == 0);
}
