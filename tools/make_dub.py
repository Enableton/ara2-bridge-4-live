#!/usr/bin/env python3
"""Makes a 'dub' from a WAV by warping its timing (needs numpy).

  make_dub.py guide.wav dub.wav
  make_dub.py --self-test

The signal is delayed by an amount that wanders between -10 ms and +90 ms (a 6 s sine around +40 ms),
so VocAlign has something measurable to fix; the mean absolute offset is about 40 ms.
Reads 16/24/32-bit integer PCM and 32/64-bit float WAV, mono or stereo, also WAVE_FORMAT_EXTENSIBLE.
Writes a 32-bit float WAV with the same rate and channel count (the format the host's result.wav has).
measure_alignment.py imports read_wav, write_wav and warp from here.
"""
import os
import struct
import sys
import tempfile

try:
    import numpy as np
except ImportError:
    raise SystemExit("this script needs numpy: run it with a Python that has it, e.g. /opt/homebrew/Caskroom/miniforge/base/bin/python3")

BASE_DELAY = 0.04       # seconds
DELAY_SWING = 0.05      # seconds: the delay runs from BASE - SWING to BASE + SWING
DELAY_PERIOD = 6.0      # seconds


def read_wav(path):
    """(frames x channels float64 array, sample rate) of a WAV file."""
    with open(path, "rb") as f:
        data = f.read()
    if data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise SystemExit("%s is not a WAV file (convert it to WAV first)" % path)
    fmt = None
    samples = None
    pos = 12
    while pos + 8 <= len(data):
        ident = data[pos:pos + 4]
        size = struct.unpack("<I", data[pos + 4:pos + 8])[0]
        body = data[pos + 8:pos + 8 + size]
        if ident == b"fmt " and size >= 16:
            tag, channels, rate = struct.unpack("<HHI", body[:8])
            bits = struct.unpack("<H", body[14:16])[0]
            if tag == 0xFFFE and size >= 26:
                tag = struct.unpack("<H", body[24:26])[0]       # WAVE_FORMAT_EXTENSIBLE: the sub-format GUID starts with the real tag
            fmt = (tag, channels, rate, bits)
        elif ident == b"data":
            samples = body
        pos += 8 + size + (size & 1)
    if fmt is None or samples is None:
        raise SystemExit("%s has no fmt or data chunk" % path)
    tag, channels, rate, bits = fmt
    if tag == 3 and bits == 32:
        values = np.frombuffer(samples[:len(samples) // 4 * 4], dtype="<f4").astype(np.float64)
    elif tag == 3 and bits == 64:
        values = np.frombuffer(samples[:len(samples) // 8 * 8], dtype="<f8").astype(np.float64)
    elif tag == 1 and bits == 16:
        values = np.frombuffer(samples[:len(samples) // 2 * 2], dtype="<i2").astype(np.float64) / 32768.0
    elif tag == 1 and bits == 24:
        b = np.frombuffer(samples[:len(samples) // 3 * 3], dtype=np.uint8).reshape(-1, 3).astype(np.int32)
        v = b[:, 0] | (b[:, 1] << 8) | (b[:, 2] << 16)
        values = np.where(v >= 1 << 23, v - (1 << 24), v) / float(1 << 23)
    elif tag == 1 and bits == 32:
        values = np.frombuffer(samples[:len(samples) // 4 * 4], dtype="<i4").astype(np.float64) / float(1 << 31)
    else:
        raise SystemExit("%s: unsupported WAV format (tag %d, %d bits)" % (path, tag, bits))
    frames = len(values) // channels
    return values[:frames * channels].reshape(frames, channels), rate


def write_wav(path, audio, rate, kind="f32"):
    """Writes frames x channels audio as a 32-bit float ('f32') or 16-bit ('i16') or 24-bit ('i24') PCM WAV."""
    channels = audio.shape[1]
    if kind == "f32":
        tag, bits, payload = 3, 32, audio.astype("<f4").tobytes()
    elif kind == "i16":
        tag, bits, payload = 1, 16, np.clip(np.round(audio * 32767), -32768, 32767).astype("<i2").tobytes()
    elif kind == "i24":
        v = np.clip(np.round(audio * 8388607), -8388608, 8388607).astype(np.int32).reshape(-1)
        tag, bits, payload = 1, 24, np.stack([v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF], axis=1).astype(np.uint8).tobytes()
    else:
        raise ValueError(kind)
    block = channels * bits // 8
    fmt = struct.pack("<HHIIHH", tag, channels, rate, rate * block, block, bits)
    with open(path, "wb") as f:
        f.write(b"RIFF" + struct.pack("<I", 4 + 8 + len(fmt) + 8 + len(payload)) + b"WAVE")
        f.write(b"fmt " + struct.pack("<I", len(fmt)) + fmt)
        f.write(b"data" + struct.pack("<I", len(payload)) + payload)


def delay_at(t):
    """The delay in seconds that make_dub applies at time t (the dub at t is the guide at t - delay)."""
    return BASE_DELAY + DELAY_SWING * np.sin(2 * np.pi * t / DELAY_PERIOD)


def warp(audio, rate):
    """frames x channels audio delayed by delay_at(t)."""
    t = np.arange(len(audio)) / rate
    return np.stack([np.interp(t - delay_at(t), t, audio[:, c], left=0.0, right=0.0) for c in range(audio.shape[1])], axis=1)


def self_test():
    rate = 8000
    t = np.arange(rate * 12) / rate
    audio = np.stack([0.5 * np.sin(2 * np.pi * 300 * t), 0.3 * np.sin(2 * np.pi * 410 * t + 1)], axis=1)
    with tempfile.TemporaryDirectory() as tmp:
        for kind, tol in (("f32", 1e-7), ("i16", 1.0 / 32767), ("i24", 1.0 / 8388607)):
            path = os.path.join(tmp, kind + ".wav")
            write_wav(path, audio, rate, kind)
            back, r = read_wav(path)
            assert r == rate and back.shape == audio.shape and np.abs(back - audio).max() <= tol + 1e-7, (kind, np.abs(back - audio).max())
        # WAVE_FORMAT_EXTENSIBLE, 32-bit float, mono, with an odd-sized chunk before the data
        mono = audio[:1000, :1]
        payload = mono.astype("<f4").tobytes()
        sub = struct.pack("<H", 3) + bytes.fromhex("000000001000800000aa00389b71")
        fmt = struct.pack("<HHIIHH", 0xFFFE, 1, rate, rate * 4, 4, 32) + struct.pack("<HHI", 22, 32, 4) + sub
        ext = os.path.join(tmp, "ext.wav")
        with open(ext, "wb") as f:
            f.write(b"RIFF" + struct.pack("<I", 4 + 8 + len(fmt) + 8 + 4 + 8 + len(payload)) + b"WAVE")
            f.write(b"fmt " + struct.pack("<I", len(fmt)) + fmt)
            f.write(b"junk" + struct.pack("<I", 3) + b"abc" + b"\x00")
            f.write(b"data" + struct.pack("<I", len(payload)) + payload)
        back, r = read_wav(ext)
        assert r == rate and back.shape == (1000, 1) and np.abs(back - mono).max() < 1e-7
        # the warp: an impulse at 1.0 s appears at the time t where t - delay_at(t) = 1.0
        imp = np.zeros((rate * 3, 1))
        imp[rate] = 1.0
        moved = warp(imp, rate)
        peak = np.argmax(np.abs(moved[:, 0])) / rate
        assert abs((peak - delay_at(peak)) - 1.0) < 2.0 / rate, peak
        # the command line end to end
        src = os.path.join(tmp, "src.wav")
        out = os.path.join(tmp, "out.wav")
        write_wav(src, audio, rate, "i24")
        main([src, out])
        dub, r = read_wav(out)
        assert r == rate and dub.shape == audio.shape
    print("make_dub self-test OK")


def main(argv):
    if len(argv) == 1 and argv[0] == "--self-test":
        self_test()
        return
    if len(argv) != 2:
        raise SystemExit(__doc__)
    guide, rate = read_wav(argv[0])
    write_wav(argv[1], warp(guide, rate), rate, "f32")
    print("wrote %s (%.2f s, %d Hz, %d channel(s), delay %+.0f .. %+.0f ms)" % (
        argv[1], len(guide) / rate, rate, guide.shape[1], 1000 * (BASE_DELAY - DELAY_SWING), 1000 * (BASE_DELAY + DELAY_SWING)))


if __name__ == "__main__":
    main(sys.argv[1:])
