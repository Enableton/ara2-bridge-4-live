// wavdiff reference.wav candidate.wav [--a-start SECONDS] [--tol X]
// Compares the whole candidate with the reference starting at --a-start. Exit codes:
//   0  the largest absolute sample difference is <= tol (default 0)
//   1  it is larger, or any difference is not finite (NaN/inf samples never pass)
//   2  usage, argument or file format errors (unknown flag, flag without value, unparseable or
//      non-finite --a-start/--tol, negative --tol, candidate does not fit in the reference)
#include "common/Wav.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>

namespace
{
    int usage ()
    {
        std::printf ("usage: wavdiff reference.wav candidate.wav [--a-start SECONDS] [--tol X]\n");
        return 2;
    }

    bool parseNumber (const char* text, double& value)
    {
        char* end { nullptr };
        value = std::strtod (text, &end);
        return end != text && *end == '\0' && std::isfinite (value);
    }
}

int main (int argc, char** argv)
{
    if (argc < 3)
        return usage ();
    double aStart { 0.0 }, tolerance { 0.0 };
    for (int i { 3 }; i < argc; i += 2)
    {
        double* target { std::strcmp (argv[i], "--a-start") == 0 ? &aStart : std::strcmp (argv[i], "--tol") == 0 ? &tolerance : nullptr };
        if (target == nullptr || i + 1 >= argc || ! parseNumber (argv[i + 1], *target))
            return usage ();
    }
    if (tolerance < 0.0)
        return usage ();

    bridge::Audio a, b;
    std::string error;
    if (! bridge::readWav (argv[1], a, error) || ! bridge::readWav (argv[2], b, error))
    {
        std::printf ("%s\n", error.c_str ());
        return 2;
    }
    if (a.channelCount () != b.channelCount () || a.sampleRate != b.sampleRate)
    {
        std::printf ("format differs: %d ch @ %d Hz vs %d ch @ %d Hz\n", a.channelCount (), a.sampleRate, b.channelCount (), b.sampleRate);
        return 2;
    }
    // Check the start in seconds before converting it to samples, so llround never sees an out-of-range value.
    const double offsetSamples { aStart * a.sampleRate };
    if (! (offsetSamples >= 0.0 && offsetSamples <= static_cast<double> (a.frames ())))
    {
        std::printf ("--a-start %g s is outside the reference (%zu frames)\n", aStart, a.frames ());
        return 2;
    }
    const size_t offset { static_cast<size_t> (std::llround (offsetSamples)) };
    if (offset > a.frames () || b.frames () > a.frames () - offset)
    {
        std::printf ("candidate (%zu frames) does not fit in the reference from %.3f s\n", b.frames (), aStart);
        return 2;
    }
    double worst { 0.0 };
    for (int c { 0 }; c < a.channelCount (); ++c)
        for (size_t i { 0 }; i < b.frames (); ++i)
        {
            const double d { std::fabs (static_cast<double> (a.channels[static_cast<size_t> (c)][offset + i]) - b.channels[static_cast<size_t> (c)][i]) };
            worst = std::isfinite (d) ? std::max (worst, d) : std::numeric_limits<double>::infinity ();
            if (std::isinf (worst))
                break;
        }
    std::printf ("frames %zu, max abs diff %.9g\n", b.frames (), worst);
    return worst <= tolerance ? 0 : 1;
}
