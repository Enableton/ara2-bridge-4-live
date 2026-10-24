// realign_tool original.wav render.wav out.wav
// Runs the realignment on two WAV files and prints what it found. Extra arguments are ignored, and the exit
// code is 0 even when realignment was not applied (check the 'applied:' line); 2 means usage or file errors.
#include "realign/Realign.h"

#include <cstdio>

int main (int argc, char** argv)
{
    if (argc < 4)
    {
        std::printf ("usage: realign_tool original.wav render.wav out.wav\n");
        return 2;
    }
    bridge::Audio original, render, out;
    std::string error;
    if (! bridge::readWav (argv[1], original, error) || ! bridge::readWav (argv[2], render, error))
    {
        std::printf ("%s\n", error.c_str ());
        return 2;
    }
    const auto result = bridge::realign (original, render, bridge::RealignParams {}, out);
    std::printf ("applied: %s (%s)\n", result.applied ? "yes" : "no", result.note.c_str ());
    std::printf ("%zu distinct shift(s):\n", result.support.size ());
    for (const auto& s : result.support)
        std::printf ("  shift %+.2f  %d segment(s), %.3f s  %s\n", s.shift, s.segments, s.seconds, s.kept ? "kept" : "dropped (too little support)");
    std::printf ("%zu piece(s), %zu moved, %zu switch(es) (%.2f per second)\n", result.pieces.size (), result.movedPieces,
                 result.pieces.empty () ? size_t { 0 } : result.pieces.size () - 1,
                 original.frames () > 0 && ! result.pieces.empty () ? static_cast<double> (result.pieces.size () - 1) * original.sampleRate / static_cast<double> (original.frames ()) : 0.0);
    std::printf ("%zu detected segment(s):\n", result.segments.size ());
    for (const auto& segment : result.segments)
        std::printf ("  segment %.3f s .. %.3f s  shift %+.2f  min correlation %.4f\n",
                     static_cast<double> (segment.start) / original.sampleRate, static_cast<double> (segment.end) / original.sampleRate, segment.shift, segment.correlation);
    if (! bridge::writeWavFloat32 (argv[3], out, error))
    {
        std::printf ("%s\n", error.c_str ());
        return 2;
    }
    return 0;
}
