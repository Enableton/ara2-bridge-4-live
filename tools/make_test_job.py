#!/usr/bin/env python3
"""Creates a job folder for BridgeHost.

  make_test_job.py JOB_DIR --plugin melodyne [--source file.wav] [--start 1.0] [--end 3.0] [--no-realign]
  make_test_job.py JOB_DIR --plugin vocalign [--guide guide.wav --dub dub.wav] [--start 1.0] [--end 3.0]
                   [--output dub|guide] [--guide-beats 0] [--dub-beats 0]

Without --source/--guide/--dub, 5 s test files are generated (a gliding tone with light noise).
Also writes compare.txt: "<file>\t<start seconds>\t<frames>" naming the file region the result must equal
when nothing is edited, and its length in frames (used by host/tests/headless_roundtrip.sh).
--output guide (VocAlign) writes "output": "guide" into job.json, plus expected.wav: what result.wav must be with
nothing captured (VocAlign passes the dub through): the dub region placed at (dub - guide) arrangement offset in
digital silence over the window [guide start, max(guide end, dub end)); compare.txt then names expected.wav from 0.
It also writes expected_result.json with the placeAt / offsetFrames / droppedFrames / frames result.json must have.
The dub must be a 16-bit PCM WAV then (the generated files are).
"""
import argparse
import json
import math
import os
import random
import struct
import wave

SR = 44100


def write_test_wav(path, seconds, seed):
    rng = random.Random(seed)
    frames = int(seconds * SR)
    data = bytearray()
    for i in range(frames):
        t = i / SR
        env = 0.6 + 0.4 * math.sin(2 * math.pi * 1.7 * t)
        tone = 0.3 * math.sin(2 * math.pi * (200 * t + 30 * t * t)) + 0.2 * math.sin(2 * math.pi * (400 * t + 60 * t * t))
        for _ in range(2):
            v = env * tone + 0.03 * (rng.random() * 2 - 1)
            data += struct.pack("<h", int(max(-1.0, min(1.0, v)) * 32767))
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(bytes(data))


def wav_sample_rate(path):
    """Sample rate from the fmt chunk (works for PCM and float WAVs, which the wave module rejects)."""
    with open(path, "rb") as f:
        header = f.read(12)
        if header[:4] != b"RIFF" or header[8:12] != b"WAVE":
            raise SystemExit("%s is not a WAV file" % path)
        while True:
            chunk = f.read(8)
            if len(chunk) < 8:
                raise SystemExit("%s has no fmt chunk" % path)
            ident, size = chunk[:4], struct.unpack("<I", chunk[4:])[0]
            if ident == b"fmt ":
                return struct.unpack("<I", f.read(16)[4:8])[0]
            f.seek(size + (size & 1), 1)


def clip(role, path, start, end, name, beats=0.0):
    return {"role": role, "path": os.path.abspath(path), "startSec": start, "endSec": end, "startBeats": beats, "name": name}


def frame_at(seconds, rate):
    """The host's llround (half away from zero); Python's round() rounds half to even."""
    x = seconds * rate
    return int(math.floor(x + 0.5)) if x >= 0 else -int(math.floor(-x + 0.5))


def write_expected(path, dub_path, start, end, offset, window):
    """expected.wav for output "guide": window frames of silence with the dub region (16-bit PCM) at offset."""
    with wave.open(dub_path, "rb") as w:
        if w.getsampwidth() != 2:
            raise SystemExit("--output guide needs a 16-bit PCM dub")
        rate, channels = w.getframerate(), w.getnchannels()
        first, last = frame_at(start, rate), frame_at(end, rate)
        w.setpos(first)
        region = w.readframes(last - first)
    frame_bytes = 2 * channels
    dropped = min(max(-offset, 0), last - first)
    kept = region[dropped * frame_bytes:]
    lead = max(offset, 0)
    data = bytes(lead * frame_bytes) + kept
    data = data[:window * frame_bytes]
    data += bytes(window * frame_bytes - len(data))
    with wave.open(path, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(data)
    return lead, dropped


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("job_dir")
    ap.add_argument("--plugin", choices=["melodyne", "vocalign"], required=True)
    ap.add_argument("--source")
    ap.add_argument("--guide")
    ap.add_argument("--dub")
    ap.add_argument("--start", type=float, default=1.0)
    ap.add_argument("--end", type=float, default=3.0)
    ap.add_argument("--no-realign", action="store_true")
    ap.add_argument("--output", choices=["dub", "guide"])
    ap.add_argument("--guide-beats", type=float, default=0.0)
    ap.add_argument("--dub-beats", type=float, default=0.0)
    args = ap.parse_args()
    if args.output == "guide" and args.plugin != "vocalign":
        raise SystemExit("--output guide needs --plugin vocalign")

    job_dir = os.path.abspath(args.job_dir)
    os.makedirs(job_dir, exist_ok=True)

    def generated(name, seed):
        path = os.path.join(job_dir, name)
        write_test_wav(path, 5.0, seed)
        return path

    if args.plugin == "melodyne":
        source = args.source or generated("source.wav", 1)
        clips = [clip("source", source, args.start, args.end, "source")]
        compared = source
    else:
        guide = args.guide or generated("guide.wav", 1)
        dub = args.dub or generated("dub.wav", 2)
        clips = [clip("guide", guide, args.start, args.end, "guide", args.guide_beats),
                 clip("dub", dub, args.start, args.end, "dub", args.dub_beats)]
        compared = dub

    tempo = 120.0
    job = {"version": 1, "id": "test-" + args.plugin, "plugin": args.plugin, "placement": "takeLane",
           "realign": not args.no_realign, "song": {"tempo": tempo}, "clips": clips}
    if args.output:
        job["output"] = args.output
    with open(os.path.join(job_dir, "job.json"), "w") as f:
        json.dump(job, f, indent=2)
    rate = wav_sample_rate(compared)
    frames = frame_at(args.end, rate) - frame_at(args.start, rate)
    compared_start = args.start
    if args.output == "guide":
        # as layoutJob: playback starts relative to the earliest clip, each rounded to a frame
        first_beat = min(args.guide_beats, args.dub_beats)
        guide_at = frame_at((args.guide_beats - first_beat) * 60.0 / tempo, rate)
        dub_at = frame_at((args.dub_beats - first_beat) * 60.0 / tempo, rate)
        offset = dub_at - guide_at
        guide_frames = frame_at(args.end, wav_sample_rate(guide)) - frame_at(args.start, wav_sample_rate(guide))
        window = max(guide_frames, offset + frames)
        lead, dropped = write_expected(os.path.join(job_dir, "expected.wav"), dub, args.start, args.end, offset, window)
        with open(os.path.join(job_dir, "expected_result.json"), "w") as f:
            json.dump({"placeAt": "guide", "offsetFrames": lead, "droppedFrames": dropped, "frames": window,
                       "sourceStartFrame": frame_at(args.start, rate)}, f, indent=2)
        compared, compared_start, frames = os.path.join(job_dir, "expected.wav"), 0.0, window
    with open(os.path.join(job_dir, "compare.txt"), "w") as f:
        f.write("%s\t%s\t%d\n" % (os.path.abspath(compared), compared_start, frames))
    print("job written to", job_dir)


if __name__ == "__main__":
    main()
