#!/usr/bin/env python3
"""Cuts 2.0-8.0 s out of the spike's session-2 renders into small test fixtures.

render_1.wav is the unedited render (bit-identical to the input), render_2.wav the render after
moving one note up 3 semitones (the tail after the note is ~31 samples early).
Needs numpy and the (git-ignored) spike/out_session2 folder.
"""
import os
import struct
import sys

import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SRC = os.path.join(ROOT, "spike", "out_session2")
DST = os.path.join(ROOT, "host", "tests", "fixtures")
START_SEC, END_SEC = 2.0, 8.0


def read_float32_wav(path):
    d = open(path, "rb").read()
    channels = struct.unpack("<H", d[22:24])[0]
    rate = struct.unpack("<I", d[24:28])[0]
    assert d[36:40] == b"data", "expected the 44-byte header written by the spike host"
    return np.frombuffer(d[44:], dtype="<f4").reshape(-1, channels), rate


def write_float32_wav(path, samples, rate):
    channels = samples.shape[1]
    data = samples.astype("<f4").tobytes()
    header = b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVEfmt " + struct.pack(
        "<IHHIIHH", 16, 3, channels, rate, rate * channels * 4, channels * 4, 32) + b"data" + struct.pack("<I", len(data))
    open(path, "wb").write(header + data)


def main():
    os.makedirs(DST, exist_ok=True)
    for name, out in (("render_1.wav", "spike_original_2_8s.wav"), ("render_2.wav", "spike_edited_2_8s.wav")):
        samples, rate = read_float32_wav(os.path.join(SRC, name))
        cut = samples[int(START_SEC * rate):int(END_SEC * rate)]
        write_float32_wav(os.path.join(DST, out), cut, rate)
        print("wrote", out, cut.shape)


if __name__ == "__main__":
    sys.exit(main())
