#include "check.h"
#include "testutil.h"

#include "audio/AudioDecode.h"
#include "common/Wav.h"

#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <string>
#include <sys/stat.h>
#include <vector>

namespace
{
    void put16 (std::string& s, uint16_t v) { s.push_back (static_cast<char> (v & 0xFF)); s.push_back (static_cast<char> (v >> 8)); }
    void put32 (std::string& s, uint32_t v) { put16 (s, static_cast<uint16_t> (v & 0xFFFF)); put16 (s, static_cast<uint16_t> (v >> 16)); }

    // Writes integer PCM WAV (16 or 24 bit) from interleaved samples that fit the bit depth.
    void writePcmWav (const std::string& path, int rate, int channels, int bits, const std::vector<int32_t>& interleaved)
    {
        const uint32_t bytes { static_cast<uint32_t> (interleaved.size () * static_cast<size_t> (bits / 8)) };
        std::string out;
        out += "RIFF";
        put32 (out, 36 + bytes);
        out += "WAVEfmt ";
        put32 (out, 16);
        put16 (out, 1);
        put16 (out, static_cast<uint16_t> (channels));
        put32 (out, static_cast<uint32_t> (rate));
        put32 (out, static_cast<uint32_t> (rate * channels * bits / 8));
        put16 (out, static_cast<uint16_t> (channels * bits / 8));
        put16 (out, static_cast<uint16_t> (bits));
        out += "data";
        put32 (out, bytes);
        for (const int32_t v : interleaved)
        {
            out.push_back (static_cast<char> (v & 0xFF));
            out.push_back (static_cast<char> ((v >> 8) & 0xFF));
            if (bits == 24)
                out.push_back (static_cast<char> ((v >> 16) & 0xFF));
        }
        writeTextFile (path, out);
    }

    // A stereo test signal that is not periodic at any chunk size.
    bridge::Audio makeSignal (int rate, int channels, size_t frames)
    {
        bridge::Audio audio;
        audio.sampleRate = rate;
        audio.channels.assign (static_cast<size_t> (channels), std::vector<float> (frames));
        for (size_t c { 0 }; c < audio.channels.size (); ++c)
            for (size_t i { 0 }; i < frames; ++i)
                audio.channels[c][i] = static_cast<float> (0.7 * std::sin (0.013 * static_cast<double> (i) * static_cast<double> (c + 1) + static_cast<double> (c))
                                                           + 0.2 * std::cos (0.00071 * static_cast<double> (i * i % 100003)));
        return audio;
    }

    double maxAbsDiff (const bridge::Audio& a, const bridge::Audio& b)
    {
        if (a.channels.size () != b.channels.size () || a.frames () != b.frames ())
            return 1e9;
        double worst { 0.0 };
        for (size_t c { 0 }; c < a.channels.size (); ++c)
            for (size_t i { 0 }; i < a.channels[c].size (); ++i)
                worst = std::max (worst, std::fabs (static_cast<double> (a.channels[c][i]) - static_cast<double> (b.channels[c][i])));
        return worst;
    }

    double rms (const bridge::Audio& a)
    {
        double sum { 0.0 };
        size_t n { 0 };
        for (const auto& channel : a.channels)
            for (const float v : channel)
            {
                sum += static_cast<double> (v) * static_cast<double> (v);
                ++n;
            }
        return n == 0 ? 0.0 : std::sqrt (sum / static_cast<double> (n));
    }

    // Runs a shell command (tools used to make fixtures in other formats). False if it is missing or fails.
    bool runTool (const std::string& command)
    {
        return std::system ((command + " >/dev/null 2>&1").c_str ()) == 0;
    }

    void skip (const char* what) { std::printf ("    [ SKIP ] %s: needed tool unavailable\n", what); }

    // Converts a source file with afconvert and decodes the result next to the reference decoded from the source.
    // Returns false (after printing a note) if the conversion could not be made.
    bool convertAndDecode (const std::string& dir, const std::string& source, const std::string& name, const std::string& afArgs, bridge::Audio& decoded)
    {
        const std::string target { dir + "/" + name };
        if (! runTool ("/usr/bin/afconvert " + afArgs + " '" + source + "' '" + target + "'"))
        {
            skip (name.c_str ());
            return false;
        }
        std::string error;
        const bool ok { bridge::decodeAudioFile (target, decoded, error) };
        if (! ok)
            std::printf ("    decode of %s failed: %s\n", name.c_str (), error.c_str ());
        CHECK (ok);
        return ok;
    }
}

TEST (decode_float_wav_is_exact)
{
    const std::string dir { makeTempDir ("dec1") };
    bridge::Audio original;
    original.sampleRate = 44100;
    original.channels.assign (2, std::vector<float> (4000));
    for (size_t i { 0 }; i < 4000; ++i)
    {
        original.channels[0][i] = static_cast<float> (std::sin (0.01 * static_cast<double> (i)));
        original.channels[1][i] = static_cast<float> (0.5 * std::cos (0.02 * static_cast<double> (i)));
    }
    std::string error;
    CHECK (bridge::writeWavFloat32 (dir + "/f.wav", original, error));

    bridge::Audio decoded;
    CHECK (bridge::decodeAudioFile (dir + "/f.wav", decoded, error));
    CHECK (decoded.sampleRate == 44100);
    CHECK (decoded.channelCount () == 2);
    CHECK (decoded.frames () == 4000);
    CHECK (decoded.channels == original.channels);
}

TEST (decode_reports_errors)
{
    const std::string dir { makeTempDir ("dec2") };
    bridge::Audio decoded;
    std::string error;
    CHECK (! bridge::decodeAudioFile (dir + "/nothing.wav", decoded, error));
    CHECK (! error.empty ());

    writeTextFile (dir + "/junk.wav", "definitely not audio");
    error.clear ();
    CHECK (! bridge::decodeAudioFile (dir + "/junk.wav", decoded, error));
    CHECK (! error.empty ());
}

TEST (decode_error_messages_are_readable)
{
    const std::string dir { makeTempDir ("dec3") };
    bridge::Audio decoded;
    std::string error;

    CHECK (! bridge::decodeAudioFile (dir + "/nothing.wav", decoded, error));
    CHECK (error.find ("nothing.wav") != std::string::npos);
    CHECK (error.find ("No such file") != std::string::npos);

    // A file CoreAudio cannot identify: the message says so in words, not only as a number.
    writeTextFile (dir + "/junk.wav", "definitely not audio, just some bytes that no decoder will accept");
    CHECK (! bridge::decodeAudioFile (dir + "/junk.wav", decoded, error));
    CHECK (error.find ("junk.wav") != std::string::npos);
    CHECK (error.find ("not a recognised audio file type") != std::string::npos);

    // Empty file, directory, empty path, embedded NUL, a path that is not valid UTF-8.
    writeTextFile (dir + "/empty.wav", "");
    CHECK (! bridge::decodeAudioFile (dir + "/empty.wav", decoded, error));
    CHECK (error.find ("empty") != std::string::npos);

    CHECK (! bridge::decodeAudioFile (dir, decoded, error));
    CHECK (error.find ("not a regular file") != std::string::npos);

    CHECK (! bridge::decodeAudioFile ("", decoded, error));
    CHECK (! error.empty ());
    CHECK (! bridge::decodeAudioFile (std::string ("a\0b.wav", 7), decoded, error));
    CHECK (! error.empty ());
    error.clear ();
    CHECK (! bridge::decodeAudioFile (dir + "/\xff\xfe.wav", decoded, error));
    CHECK (! error.empty ());
}

TEST (decode_leaves_output_untouched_on_failure)
{
    const std::string dir { makeTempDir ("dec4") };
    bridge::Audio decoded { makeSignal (48000, 1, 10) };
    const bridge::Audio before { decoded };
    std::string error;
    CHECK (! bridge::decodeAudioFile (dir + "/missing.wav", decoded, error));
    writeTextFile (dir + "/junk.wav", "RIFFxxxxWAVEnonsense");
    CHECK (! bridge::decodeAudioFile (dir + "/junk.wav", decoded, error));
    CHECK (decoded.sampleRate == before.sampleRate);
    CHECK (decoded.channels == before.channels);
}

TEST (decode_does_not_block_on_a_fifo)
{
    const std::string dir { makeTempDir ("dec5") };
    REQUIRE (::mkfifo ((dir + "/pipe.wav").c_str (), 0600) == 0);
    bridge::Audio decoded;
    std::string error;
    CHECK (! bridge::decodeAudioFile (dir + "/pipe.wav", decoded, error));
    CHECK (error.find ("not a regular file") != std::string::npos);
}

TEST (decode_follows_symlinks)
{
    const std::string dir { makeTempDir ("dec6") };
    std::string error;
    const bridge::Audio original { makeSignal (44100, 2, 1000) };
    REQUIRE (bridge::writeWavFloat32 (dir + "/real.wav", original, error));
    std::filesystem::create_symlink (dir + "/real.wav", dir + "/link.wav");
    bridge::Audio decoded;
    CHECK (bridge::decodeAudioFile (dir + "/link.wav", decoded, error));
    CHECK (decoded.channels == original.channels);
}

TEST (decode_integer_wavs_match_readwav)
{
    const std::string dir { makeTempDir ("dec7") };
    std::vector<int32_t> pcm16, pcm24;
    for (int i { 0 }; i < 3000; ++i)
    {
        pcm16.push_back (static_cast<int32_t> (std::lround (30000.0 * std::sin (0.02 * i))));          // L
        pcm16.push_back (static_cast<int32_t> (std::lround (-32768.0 * std::cos (0.011 * i))));        // R, reaches -32768
        pcm24.push_back (static_cast<int32_t> (std::lround (8000000.0 * std::sin (0.02 * i))));
        pcm24.push_back (static_cast<int32_t> (std::lround (-8388608.0 * std::cos (0.011 * i))));
    }
    writePcmWav (dir + "/p16.wav", 44100, 2, 16, pcm16);
    writePcmWav (dir + "/p24.wav", 48000, 2, 24, pcm24);

    for (const char* name : { "p16.wav", "p24.wav" })
    {
        bridge::Audio expected, decoded;
        std::string error;
        REQUIRE (bridge::readWav (dir + "/" + name, expected, error));
        REQUIRE (bridge::decodeAudioFile (dir + "/" + name, decoded, error));
        CHECK (decoded.sampleRate == expected.sampleRate);
        CHECK (decoded.channelCount () == 2);
        CHECK (decoded.frames () == 3000);
        CHECK (maxAbsDiff (decoded, expected) < 1e-6);
    }
}

TEST (decode_preserves_rate_and_channel_count)
{
    const std::string dir { makeTempDir ("dec8") };
    std::string error;
    for (const int rate : { 8000, 22050, 44100, 48000, 96000, 192000 })
    {
        for (const int channels : { 1, 2, 3, 6, 16 })
        {
            const bridge::Audio original { makeSignal (rate, channels, 777) };
            REQUIRE (bridge::writeWavFloat32 (dir + "/x.wav", original, error));
            bridge::Audio decoded;
            if (! bridge::decodeAudioFile (dir + "/x.wav", decoded, error))
            {
                std::printf ("    %d Hz x %d ch: %s\n", rate, channels, error.c_str ());
                CHECK (false);
                continue;
            }
            CHECK (decoded.sampleRate == rate);
            CHECK (decoded.channelCount () == channels);
            CHECK (decoded.channels == original.channels);       // channel order and content kept
        }
    }
}

TEST (decode_rejects_too_many_channels_and_bad_rates)
{
    const std::string dir { makeTempDir ("dec9") };
    std::string error;
    bridge::Audio decoded;

    REQUIRE (bridge::writeWavFloat32 (dir + "/c17.wav", makeSignal (44100, 17, 100), error));
    CHECK (! bridge::decodeAudioFile (dir + "/c17.wav", decoded, error));
    CHECK (error.find ("17 channels") != std::string::npos);

    REQUIRE (bridge::writeWavFloat32 (dir + "/r500.wav", makeSignal (500, 1, 100), error));
    CHECK (! bridge::decodeAudioFile (dir + "/r500.wav", decoded, error));
    CHECK (error.find ("sample rate") != std::string::npos);

    REQUIRE (bridge::writeWavFloat32 (dir + "/r1m.wav", makeSignal (1000000, 1, 100), error));
    CHECK (! bridge::decodeAudioFile (dir + "/r1m.wav", decoded, error));
    CHECK (error.find ("sample rate") != std::string::npos);
}

TEST (decode_rejects_zero_length_audio)
{
    const std::string dir { makeTempDir ("dec10") };
    std::string error;
    bridge::Audio decoded;
    bridge::Audio empty;
    empty.sampleRate = 44100;
    empty.channels.assign (2, std::vector<float> ());
    REQUIRE (bridge::writeWavFloat32 (dir + "/zero.wav", empty, error));
    CHECK (! bridge::decodeAudioFile (dir + "/zero.wav", decoded, error));
    CHECK (error.find ("no audio") != std::string::npos);
}

TEST (decode_enforces_the_duration_limit)
{
    const std::string dir { makeTempDir ("dec11") };
    std::string error;
    bridge::Audio decoded;

    // At the lowest accepted rate an hour is 3.6 million frames, so the limit is cheap to cross.
    const size_t limit { static_cast<size_t> (bridge::kMaxDecodeSeconds) * static_cast<size_t> (bridge::kMinDecodeSampleRate) };
    REQUIRE (bridge::writeWavFloat32 (dir + "/long.wav", makeSignal (bridge::kMinDecodeSampleRate, 1, limit + 1), error));
    CHECK (! bridge::decodeAudioFile (dir + "/long.wav", decoded, error));
    CHECK (error.find ("too long") != std::string::npos);

    REQUIRE (bridge::writeWavFloat32 (dir + "/exact.wav", makeSignal (bridge::kMinDecodeSampleRate, 1, limit), error));
    CHECK (bridge::decodeAudioFile (dir + "/exact.wav", decoded, error));
    CHECK (decoded.frames () == limit);
    std::filesystem::remove_all (dir);
}

TEST (decode_chunk_boundaries)
{
    const std::string dir { makeTempDir ("dec12") };
    std::string error;
    for (const size_t frames : { size_t { 1 }, size_t { 65535 }, size_t { 65536 }, size_t { 65537 }, size_t { 131072 }, size_t { 200001 } })
    {
        const bridge::Audio original { makeSignal (44100, 2, frames) };
        REQUIRE (bridge::writeWavFloat32 (dir + "/b.wav", original, error));
        bridge::Audio decoded;
        REQUIRE (bridge::decodeAudioFile (dir + "/b.wav", decoded, error));
        CHECK (decoded.frames () == frames);
        CHECK (decoded.channels == original.channels);
    }
}

TEST (decode_five_minute_stereo_file_is_fast)
{
    const std::string dir { makeTempDir ("dec13") };
    std::string error;
    const size_t frames { 5 * 60 * 44100 };
    const bridge::Audio original { makeSignal (44100, 2, frames) };
    REQUIRE (bridge::writeWavFloat32 (dir + "/long.wav", original, error));

    bridge::Audio decoded;
    const auto start = std::chrono::steady_clock::now ();
    REQUIRE (bridge::decodeAudioFile (dir + "/long.wav", decoded, error));
    const double seconds { std::chrono::duration<double> (std::chrono::steady_clock::now () - start).count () };
    std::printf ("    decoded 5 min stereo in %.3f s\n", seconds);

    CHECK (seconds < 5.0);          // a few hundred ms in practice; the slack is for sanitizer builds
    CHECK (decoded.frames () == frames);
    CHECK (decoded.channels == original.channels);
    std::filesystem::remove_all (dir);
}

TEST (decode_aiff_flac_caf_match_source)
{
    const std::string dir { makeTempDir ("dec14") };
    std::vector<int32_t> pcm16, pcm24;
    for (int i { 0 }; i < 5000; ++i)
    {
        pcm16.push_back (static_cast<int32_t> (std::lround (30000.0 * std::sin (0.02 * i))));
        pcm16.push_back (static_cast<int32_t> (std::lround (-20000.0 * std::cos (0.011 * i))));
        pcm24.push_back (static_cast<int32_t> (std::lround (8000000.0 * std::sin (0.02 * i))));
        pcm24.push_back (static_cast<int32_t> (std::lround (-6000000.0 * std::cos (0.011 * i))));
    }
    writePcmWav (dir + "/s16.wav", 44100, 2, 16, pcm16);
    writePcmWav (dir + "/s24.wav", 48000, 2, 24, pcm24);
    std::string error;
    bridge::Audio ref16, ref24;
    REQUIRE (bridge::readWav (dir + "/s16.wav", ref16, error));
    REQUIRE (bridge::readWav (dir + "/s24.wav", ref24, error));

    struct Case { const char* name; const char* source; const char* args; };
    const Case cases[] {
        { "a16.aiff", "s16.wav", "-f AIFF -d BEI16" },
        { "a24.aiff", "s24.wav", "-f AIFF -d BEI24" },
        { "a16.aifc", "s16.wav", "-f AIFC -d BEI16" },
        { "f16.flac", "s16.wav", "-f flac -d flac" },
        { "f24.flac", "s24.wav", "-f flac -d flac" },
        { "c16.caf",  "s16.wav", "-f caff -d LEI16" },
        { "c32.caf",  "s24.wav", "-f caff -d LEF32" },
    };
    for (const Case& test : cases)
    {
        bridge::Audio decoded;
        if (! convertAndDecode (dir, dir + "/" + test.source, test.name, test.args, decoded))
            continue;
        const bridge::Audio& ref { std::string (test.source) == "s16.wav" ? ref16 : ref24 };
        CHECK (decoded.sampleRate == ref.sampleRate);
        CHECK (decoded.channelCount () == 2);
        CHECK (decoded.frames () == ref.frames ());
        const double diff { maxAbsDiff (decoded, ref) };
        if (diff >= 1e-6)
            std::printf ("    %s differs from its source by %g\n", test.name, diff);
        CHECK (diff < 1e-6);
    }
}

TEST (decode_lossy_formats_keep_rate_channels_and_length)
{
    const std::string dir { makeTempDir ("dec15") };
    std::string error;
    const size_t frames { 2 * 44100 };
    bridge::Audio source { makeSignal (44100, 2, frames) };
    for (auto& channel : source.channels)
        for (float& v : channel)
            v *= 0.5f;
    REQUIRE (bridge::writeWavFloat32 (dir + "/src.wav", source, error));

    struct Case { const char* name; const char* command; };      // %s are source and target
    const std::string src { "'" + dir + "/src.wav'" };
    const Case cases[] {
        { "l.m4a", "/usr/bin/afconvert -f m4af -d aac -b 128000" },
        { "l.mp3", "lame --silent" },
    };
    for (const Case& test : cases)
    {
        const std::string target { dir + "/" + test.name };
        if (! runTool (std::string (test.command) + " " + src + " '" + target + "'"))
        {
            skip (test.name);
            continue;
        }
        bridge::Audio decoded;
        const bool ok { bridge::decodeAudioFile (target, decoded, error) };
        if (! ok)
            std::printf ("    decode of %s failed: %s\n", test.name, error.c_str ());
        REQUIRE (ok);
        CHECK (decoded.sampleRate == 44100);
        CHECK (decoded.channelCount () == 2);
        // Codec delay and padding move the length by up to a couple of frames of the codec.
        CHECK (std::llabs (static_cast<long long> (decoded.frames ()) - static_cast<long long> (frames)) <= 4608);
        CHECK (rms (decoded) > 0.5 * rms (source));
        CHECK (rms (decoded) < 1.5 * rms (source));
    }
}

TEST (decode_survives_damaged_files)
{
    // Truncations and byte flips of a valid file: any outcome is fine except a crash, a hang or a
    // success with inconsistent data. (The sanitizer builds make this test meaningful.)
    const std::string dir { makeTempDir ("dec16") };
    std::string error;
    REQUIRE (bridge::writeWavFloat32 (dir + "/good.wav", makeSignal (44100, 2, 30000), error));
    std::string good;
    {
        std::FILE* file { std::fopen ((dir + "/good.wav").c_str (), "rb") };
        REQUIRE (file != nullptr);
        char buffer[65536];
        size_t n;
        while ((n = std::fread (buffer, 1, sizeof (buffer), file)) > 0)
            good.append (buffer, n);
        std::fclose (file);
    }

    uint32_t state { 12345 };
    const auto next = [&state] { state = state * 1664525U + 1013904223U; return state >> 8; };
    int accepted { 0 }, rejected { 0 };
    for (int round { 0 }; round < 200; ++round)
    {
        std::string bytes { good };
        if (round % 2 == 0)
            bytes.resize (next () % bytes.size ());                     // truncate anywhere
        else
            for (int k { 0 }; k < 4; ++k)                                // damage mostly the header
                bytes[next () % (round % 4 == 1 ? 48U : bytes.size ())] = static_cast<char> (next ());
        writeTextFile (dir + "/bad.wav", bytes);

        bridge::Audio decoded;
        if (bridge::decodeAudioFile (dir + "/bad.wav", decoded, error))
        {
            ++accepted;
            CHECK (decoded.channelCount () >= 1 && decoded.channelCount () <= bridge::kMaxDecodeChannels);
            CHECK (decoded.frames () > 0);
            CHECK (decoded.sampleRate >= bridge::kMinDecodeSampleRate && decoded.sampleRate <= bridge::kMaxDecodeSampleRate);
            for (const auto& channel : decoded.channels)
                CHECK (channel.size () == decoded.frames ());
        }
        else
        {
            ++rejected;
            CHECK (! error.empty ());
        }
    }
    std::printf ("    damaged files: %d decoded, %d rejected\n", accepted, rejected);
}

TEST (decode_ignores_a_header_that_claims_too_much_data)
{
    // Streamed or cut-off WAV files declare a data size (here nearly 4 GB, or the "unknown" marker
    // 0xFFFFFFFF) that the file does not hold. Only the audio that is really there is decoded.
    const std::string dir { makeTempDir ("dec17") };
    std::string error;
    const bridge::Audio original { makeSignal (44100, 2, 5000) };
    REQUIRE (bridge::writeWavFloat32 (dir + "/ok.wav", original, error));
    std::string bytes;
    {
        std::FILE* file { std::fopen ((dir + "/ok.wav").c_str (), "rb") };
        REQUIRE (file != nullptr);
        char buffer[65536];
        size_t n;
        while ((n = std::fread (buffer, 1, sizeof (buffer), file)) > 0)
            bytes.append (buffer, n);
        std::fclose (file);
    }
    REQUIRE (bytes.size () == 44 + 5000 * 8);

    for (const uint32_t claimed : { 0xFFFFFFFFU, 0xF0000000U })
    {
        std::string lying { bytes };
        for (int i { 0 }; i < 4; ++i)
        {
            lying[4 + static_cast<size_t> (i)] = static_cast<char> ((claimed >> (8 * i)) & 0xFF);       // RIFF size
            lying[40 + static_cast<size_t> (i)] = static_cast<char> ((claimed >> (8 * i)) & 0xFF);      // data size
        }
        writeTextFile (dir + "/lying.wav", lying);
        bridge::Audio decoded;
        REQUIRE (bridge::decodeAudioFile (dir + "/lying.wav", decoded, error));
        CHECK (decoded.frames () == 5000);
        CHECK (decoded.channels == original.channels);
    }

    // The same file cut short: the audio that is there is returned, as readWav does.
    writeTextFile (dir + "/cut.wav", bytes.substr (0, 44 + 2500 * 8 + 3));
    bridge::Audio decoded, viaReadWav;
    REQUIRE (bridge::decodeAudioFile (dir + "/cut.wav", decoded, error));
    REQUIRE (bridge::readWav (dir + "/cut.wav", viaReadWav, error));
    CHECK (decoded.frames () == 2500);
    CHECK (decoded.channels == viaReadWav.channels);
}

namespace
{
    void putBytes (std::string& s, const void* data, size_t n) { s.append (static_cast<const char*> (data), n); }

    // Hand-written WAV with any format tag and bit depth. With 'extensible' the fmt chunk is the 40-byte
    // WAVE_FORMAT_EXTENSIBLE form whose sub-format carries 'tag' (1 = PCM, 3 = float).
    void writeRawWav (const std::string& path, uint16_t tag, int rate, int channels, int bits, const std::string& payload, bool extensible = false)
    {
        std::string out;
        out += "RIFF";
        put32 (out, static_cast<uint32_t> (4 + 8 + (extensible ? 40 : 16) + 8 + payload.size () + (payload.size () & 1U)));
        out += "WAVEfmt ";
        put32 (out, extensible ? 40U : 16U);
        put16 (out, extensible ? 0xFFFE : tag);
        put16 (out, static_cast<uint16_t> (channels));
        put32 (out, static_cast<uint32_t> (rate));
        put32 (out, static_cast<uint32_t> (rate * channels * bits / 8));
        put16 (out, static_cast<uint16_t> (channels * bits / 8));
        put16 (out, static_cast<uint16_t> (bits));
        if (extensible)
        {
            put16 (out, 22);                    // cbSize
            put16 (out, static_cast<uint16_t> (bits));
            put32 (out, channels == 1 ? 4U : 3U);   // channel mask: front centre, or front left + right
            put16 (out, tag);                   // sub-format GUID: tag, then the fixed KSDATAFORMAT tail
            const unsigned char tail[14] { 0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xAA, 0, 0x38, 0x9B, 0x71 };
            putBytes (out, tail, sizeof (tail));
        }
        out += "data";
        put32 (out, static_cast<uint32_t> (payload.size ()));
        out += payload;
        if ((payload.size () & 1U) != 0)
            out.push_back ('\0');
        writeTextFile (path, out);
    }

    // Shift (in frames, within +-maxLag) at which 'decoded' best matches 'source'; 0 means sample aligned.
    int bestLag (const bridge::Audio& source, const bridge::Audio& decoded, int maxLag)
    {
        const int window { 8192 }, start { 20000 };
        int best { 0 };
        double bestValue { -1e30 };
        for (int lag { -maxLag }; lag <= maxLag; ++lag)
        {
            double sum { 0.0 };
            for (int i { 0 }; i < window; ++i)
                sum += static_cast<double> (source.channels[0][static_cast<size_t> (start + i)])
                       * static_cast<double> (decoded.channels[0][static_cast<size_t> (start + i + lag)]);
            if (sum > bestValue)
            {
                bestValue = sum;
                best = lag;
            }
        }
        return best;
    }
}

TEST (decode_32_bit_integer_wav)
{
    const std::string dir { makeTempDir ("dec18") };
    std::string payload;
    for (int i { 0 }; i < 4000; ++i)
    {
        const int32_t l { static_cast<int32_t> (std::llround (2000000000.0 * std::sin (0.02 * i))) };
        const int32_t r { i == 7 ? INT32_MIN : static_cast<int32_t> (std::llround (-2100000000.0 * std::cos (0.011 * i))) };
        putBytes (payload, &l, 4);
        putBytes (payload, &r, 4);
    }
    writeRawWav (dir + "/i32.wav", 1, 48000, 2, 32, payload);
    bridge::Audio expected, decoded;
    std::string error;
    REQUIRE (bridge::readWav (dir + "/i32.wav", expected, error));
    REQUIRE (bridge::decodeAudioFile (dir + "/i32.wav", decoded, error));
    CHECK (decoded.sampleRate == 48000);
    CHECK (decoded.frames () == 4000);
    CHECK (maxAbsDiff (decoded, expected) < 1e-6);
    CHECK (decoded.channels[1][7] == -1.0f);
}

TEST (decode_64_bit_float_wav)
{
    const std::string dir { makeTempDir ("dec19") };
    const bridge::Audio source { makeSignal (44100, 2, 3000) };
    std::string payload;
    for (size_t i { 0 }; i < 3000; ++i)
        for (size_t c { 0 }; c < 2; ++c)
        {
            const double v { static_cast<double> (source.channels[c][i]) };
            putBytes (payload, &v, 8);
        }
    writeRawWav (dir + "/f64.wav", 3, 44100, 2, 64, payload);
    bridge::Audio decoded;
    std::string error;
    REQUIRE (bridge::decodeAudioFile (dir + "/f64.wav", decoded, error));
    CHECK (decoded.frames () == 3000);
    CHECK (decoded.channels == source.channels);       // float -> double -> float is exact
}

TEST (decode_unsigned_8_bit_wav)
{
    const std::string dir { makeTempDir ("dec20") };
    std::string payload;
    std::vector<float> expected;
    for (int i { 0 }; i < 1000; ++i)
    {
        const int v { (i * 37) % 256 };         // every value from 0 to 255 appears
        payload.push_back (static_cast<char> (v));
        expected.push_back (static_cast<float> (v - 128) / 128.0f);
    }
    writeRawWav (dir + "/u8.wav", 1, 22050, 1, 8, payload);
    bridge::Audio decoded;
    std::string error;
    REQUIRE (bridge::decodeAudioFile (dir + "/u8.wav", decoded, error));
    CHECK (decoded.sampleRate == 22050);
    REQUIRE (decoded.channelCount () == 1);
    REQUIRE (decoded.frames () == 1000);
    for (size_t i { 0 }; i < 1000; ++i)
        CHECK_NEAR (decoded.channels[0][i], expected[i], 1e-6);
}

TEST (decode_wave_format_extensible)
{
    const std::string dir { makeTempDir ("dec21") };
    std::string error;

    const bridge::Audio source { makeSignal (48000, 2, 2500) };
    std::string floats;
    for (size_t i { 0 }; i < 2500; ++i)
        for (size_t c { 0 }; c < 2; ++c)
            putBytes (floats, &source.channels[c][i], 4);
    writeRawWav (dir + "/ext_f32.wav", 3, 48000, 2, 32, floats, true);
    bridge::Audio decoded;
    REQUIRE (bridge::decodeAudioFile (dir + "/ext_f32.wav", decoded, error));
    CHECK (decoded.sampleRate == 48000);
    CHECK (decoded.channels == source.channels);

    std::string pcm;
    for (int i { 0 }; i < 2500; ++i)
    {
        const int16_t v { static_cast<int16_t> (std::lround (20000.0 * std::sin (0.03 * i))) };
        putBytes (pcm, &v, 2);
    }
    writeRawWav (dir + "/ext_pcm16.wav", 1, 44100, 1, 16, pcm, true);
    bridge::Audio expected;
    REQUIRE (bridge::readWav (dir + "/ext_pcm16.wav", expected, error));
    REQUIRE (bridge::decodeAudioFile (dir + "/ext_pcm16.wav", decoded, error));
    CHECK (decoded.channelCount () == 1);
    CHECK (decoded.frames () == 2500);
    CHECK (maxAbsDiff (decoded, expected) < 1e-6);
}

TEST (decode_odd_length_24_bit_mono_across_a_chunk_boundary)
{
    const std::string dir { makeTempDir ("dec22") };
    std::vector<int32_t> samples;
    for (int i { 0 }; i < 65537; ++i)
        samples.push_back (static_cast<int32_t> (std::lround (8000000.0 * std::sin (0.0171 * i))));
    writePcmWav (dir + "/m24.wav", 44100, 1, 24, samples);      // 196611 data bytes: odd, and written without a pad byte
    std::string raw;
    {
        std::FILE* file { std::fopen ((dir + "/m24.wav").c_str (), "rb") };
        REQUIRE (file != nullptr);
        char buffer[65536];
        size_t n;
        while ((n = std::fread (buffer, 1, sizeof (buffer), file)) > 0)
            raw.append (buffer, n);
        std::fclose (file);
    }
    CHECK (raw.size () == 44 + 65537 * 3);          // a common real-world variant: the odd chunk has no pad byte
    bridge::Audio expected, decoded;
    std::string error;
    REQUIRE (bridge::readWav (dir + "/m24.wav", expected, error));
    REQUIRE (bridge::decodeAudioFile (dir + "/m24.wav", decoded, error));
    CHECK (decoded.frames () == 65537);
    CHECK (maxAbsDiff (decoded, expected) < 1e-6);
}

TEST (decode_codec_priming_is_removed)
{
    // The decoded length equals the source length and the audio is not shifted, so a decoded clip lines up
    // with the original on the Live timeline. (Tagless MP3 and raw ADTS AAC are different: see the plan.)
    const std::string dir { makeTempDir ("dec23") };
    std::string error;
    const size_t frames { 3 * 44100 };
    const bridge::Audio source { makeSignal (44100, 2, frames) };
    REQUIRE (bridge::writeWavFloat32 (dir + "/src.wav", source, error));
    const std::string src { "'" + dir + "/src.wav'" };

    // Control for the lag measurement: a copy delayed by 5 frames is found at lag 5.
    bridge::Audio delayed { bridge::cropAudio (source, -5, static_cast<int64_t> (frames)) };
    CHECK (bestLag (source, delayed, 3000) == 5);

    struct Case { const char* name; const char* command; };
    const Case cases[] {
        { "p.m4a", "/usr/bin/afconvert -f m4af -d aac -b 128000" },
        { "p.mp3", "lame --silent -b 192" },       // writes the LAME/Xing tag that holds the encoder delay
    };
    for (const Case& test : cases)
    {
        const std::string target { dir + "/" + test.name };
        if (! runTool (std::string (test.command) + " " + src + " '" + target + "'"))
        {
            skip (test.name);
            continue;
        }
        bridge::Audio decoded;
        REQUIRE (bridge::decodeAudioFile (target, decoded, error));
        std::printf ("    %s: %zu frames decoded for %zu in the source\n", test.name, decoded.frames (), frames);
        CHECK (decoded.frames () == frames);
        if (decoded.frames () >= frames)
            CHECK (bestLag (source, decoded, 3000) == 0);
    }
}
