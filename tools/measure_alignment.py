#!/usr/bin/env python3
"""Measures how far a signal lags behind a guide, in 1 s windows (needs numpy).

  measure_alignment.py guide.wav signal.wav [signal_start_sec [guide_start_sec]]
  measure_alignment.py --job JOB_DIR                (a VocAlign job folder: reads job.json and result.wav;
                                                    output "guide": the result starts at the guide clip's start,
                                                    otherwise at the dub clip's arrangement position)
  measure_alignment.py --self-test

Typical uses:
  measure_alignment.py guide.wav dub.wav                          the unaligned dub: expect about 40 ms
  measure_alignment.py guide.wav JOB_DIR/result.wav               a VocAlign result of a job over the whole files
  measure_alignment.py guide.wav result.wav 0 2.0                 a result of a job with --start 2.0 (guide region starts 2.0 s into guide.wav)
  measure_alignment.py guide.wav dub.wav 2.0 2.0                  the matching unaligned region of the full dub

signal_start_sec / guide_start_sec: seconds into signal.wav / guide.wav where the compared region begins
(both default to 0; the host's result.wav is the job's region only, so its start is 0). Files may have
different lengths (the overlap is compared), and different channel counts (channels are averaged).
Reads 16/24/32-bit integer PCM and 32/64-bit float WAV (as written by the host).

Method: 10 ms smoothed magnitude envelope at 1 ms resolution; for every 1 s window the lag (+-150 ms,
sub-millisecond by parabolic interpolation) with the best normalised correlation between the signal's and
the guide's envelope. Offsets are in milliseconds, positive = the signal is late. Windows where either side
is nearly silent, or the correlation is below 0.3, are listed but left out of the mean.
Prints the mean absolute offset (ms) over the usable windows, plus the mean signed and the largest one.
"""
import json
import os
import sys
import tempfile

try:
    import numpy as np
except ImportError:
    raise SystemExit("this script needs numpy: run it with a Python that has it, e.g. /opt/homebrew/Caskroom/miniforge/base/bin/python3")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from make_dub import read_wav, write_wav, warp, delay_at     # noqa: E402

ENV_RATE = 1000         # envelope samples per second (1 ms)
SMOOTH_MS = 10
MAX_LAG_MS = 150
WINDOW_SEC = 1.0
MIN_CORR = 0.3
SILENCE_REL = 0.05      # a window is silent when its envelope mean is below this fraction of the clip's envelope mean


def envelope(x, rate):
    """Magnitude envelope of a mono signal at ENV_RATE, smoothed over SMOOTH_MS."""
    n = int(len(x) * ENV_RATE // rate)
    edges = np.round(np.arange(n + 1) * (rate / ENV_RATE)).astype(np.int64)
    c = np.concatenate([[0.0], np.cumsum(np.abs(x))])
    env = (c[edges[1:]] - c[edges[:-1]]) / np.maximum(edges[1:] - edges[:-1], 1)
    return np.convolve(env, np.ones(SMOOTH_MS) / SMOOTH_MS, mode="same")


def window_lag(sig, gui, a, b, max_lag):
    """Best lag in envelope samples (float, + = sig late) of sig[a:b] against the guide, and its correlation;
    None if not measurable. The guide is taken as silent outside its range."""
    seg = sig[a:b]
    padded = np.concatenate([np.zeros(max_lag), gui, np.zeros(max_lag)])
    s0 = seg - seg.mean()
    scores = np.full(2 * max_lag + 1, -2.0)
    for i, lag in enumerate(range(-max_lag, max_lag + 1)):
        g = padded[a - lag + max_lag:b - lag + max_lag]
        g0 = g - g.mean()
        denom = np.sqrt((s0 * s0).sum() * (g0 * g0).sum())
        if denom > 0:
            scores[i] = float((s0 * g0).sum() / denom)
    best = int(np.argmax(scores))
    if scores[best] <= -2.0:
        return None
    frac = 0.0
    if 0 < best < len(scores) - 1 and scores[best - 1] > -2.0 and scores[best + 1] > -2.0:
        l, c, r = scores[best - 1], scores[best], scores[best + 1]
        d = l - 2 * c + r
        if d < 0:
            frac = 0.5 * (l - r) / d
    return best - max_lag + frac, float(scores[best])


def measure(guide, signal, rate, signal_start=0.0, guide_start=0.0):
    """guide, signal: frames x channels arrays at 'rate'. Returns a list of (start_sec, offset_ms or None, corr, note)."""
    g = guide.mean(axis=1)[int(round(guide_start * rate)):]
    s = signal.mean(axis=1)[int(round(signal_start * rate)):]
    n = min(len(g), len(s))
    if n < rate * 0.5:
        raise SystemExit("the compared region is too short (%.2f s)" % (n / rate))
    ge, se = envelope(g[:n], rate), envelope(s[:n], rate)
    gm, sm = ge.mean(), se.mean()
    win = int(WINDOW_SEC * ENV_RATE)
    max_lag = MAX_LAG_MS * ENV_RATE // 1000
    rows = []
    for a in range(0, len(se) - win // 2, win):
        b = min(a + win, len(se))
        if b - a < win // 2:
            break
        if se[a:b].mean() < SILENCE_REL * sm or ge[a:b].mean() < SILENCE_REL * gm:
            rows.append((a / ENV_RATE, None, 0.0, "silent"))
            continue
        found = window_lag(se, ge, a, b, max_lag)
        if found is None:
            rows.append((a / ENV_RATE, None, 0.0, "flat envelope"))
        elif found[1] < MIN_CORR:
            rows.append((a / ENV_RATE, None, found[1], "weak correlation"))
        else:
            rows.append((a / ENV_RATE, found[0] * 1000.0 / ENV_RATE, found[1], ""))
    return rows


def summarize(rows):
    """(mean abs ms, mean signed ms, max abs ms, usable windows) or None."""
    used = [r[1] for r in rows if r[1] is not None]
    if not used:
        return None
    u = np.array(used)
    return float(np.abs(u).mean()), float(u.mean()), float(np.abs(u).max()), len(u)


def run(guide_path, signal_path, signal_start=0.0, guide_start=0.0, quiet=False):
    guide, r1 = read_wav(guide_path)
    signal, r2 = read_wav(signal_path)
    if r1 != r2:
        raise SystemExit("sample rates differ: guide %d Hz, signal %d Hz" % (r1, r2))
    rows = measure(guide, signal, r1, signal_start, guide_start)
    summary = summarize(rows)
    if not quiet:
        print("guide %s (%.2f s, %d ch) from %.2f s; signal %s (%.2f s, %d ch) from %.2f s; %d Hz" % (
            os.path.basename(guide_path), len(guide) / r1, guide.shape[1], guide_start,
            os.path.basename(signal_path), len(signal) / r1, signal.shape[1], signal_start, r1))
        print("offset of the signal against the guide per %.0f s window (ms, + = late):" % WINDOW_SEC)
        for start, off, corr, note in rows:
            print("  %6.2f s  %s  corr %.2f" % (start, ("%+8.1f" % off) if off is not None else "     n/a", corr) + (("  (%s, not counted)" % note) if note else ""))
        if summary:
            print("mean |offset| %.1f ms   mean signed %+.1f ms   max |offset| %.1f ms   (%d of %d windows)" % (
                summary[0], summary[1], summary[2], summary[3], len(rows)))
        else:
            print("no usable window")
    return rows, summary


def speechlike(rate, seconds, seed):
    """Stereo noise bursts with syllable-like envelopes (0.1 to 0.35 s, short gaps)."""
    rng = np.random.default_rng(seed)
    n = int(rate * seconds)
    env = np.zeros(n)
    pos = 0
    while pos < n:
        length = int(rng.uniform(0.1, 0.35) * rate)
        env[pos:pos + length] = rng.uniform(0.3, 1.0) * np.hanning(length)[:max(0, min(length, n - pos))] if pos + length <= n else 0
        pos += length + int(rng.uniform(0.02, 0.08) * rate)
    return (env[:, None] * rng.standard_normal((n, 2)) * 0.3)


def self_test():
    rate = 16000
    guide = speechlike(rate, 18.0, 5)
    dub = warp(guide, rate)
    truth = np.abs(delay_at(np.arange(0.5, 17.5, 1.0))).mean() * 1000

    # unaligned dub: close to the known delay, per window and on average
    rows, summ = measure(guide, dub, rate), None
    summ = summarize(rows)
    assert summ and summ[3] >= 15, summ
    for start, off, corr, note in rows:
        if off is not None:
            known = delay_at(np.arange(start, start + 1.0, 0.01)) * 1000      # the delay changes within a window: any value in its range is right
            assert known.min() - 3.0 <= off <= known.max() + 3.0, (start, off, known.min(), known.max())
    assert abs(summ[0] - truth) < 3.0, (summ, truth)

    # aligned: the guide against itself, in different file formats and channel counts
    rows = measure(guide, guide.copy(), rate)
    assert summarize(rows)[0] < 0.5, summarize(rows)
    mono = guide.mean(axis=1, keepdims=True)
    assert summarize(measure(guide, mono, rate))[0] < 0.5

    # a mild residual error (+3 ms constant) is seen as 3 ms
    shifted = np.concatenate([np.zeros((int(0.003 * rate), 2)), guide])[:len(guide)]
    assert abs(summarize(measure(guide, shifted, rate))[1] - 3.0) < 1.0

    # length differences: a shorter and a longer signal
    for sig in (dub[:int(rate * 14.3)], np.concatenate([dub, np.zeros((rate // 2, 2))])):
        s = summarize(measure(guide, sig, rate))
        assert s and abs(s[0] - truth) < 4.0, (s, truth)

    # starts: a signal that is the dub region from 2 s, against the guide from 2 s; and a result-like file
    # (the region only, signal_start 0) against the guide from 2 s
    region = dub[2 * rate:12 * rate]
    s = summarize(measure(guide, region, rate, 0.0, 2.0))
    truth_region = np.abs(delay_at(np.arange(2.0, 12.0, 0.01))).mean() * 1000
    assert abs(s[0] - truth_region) < 3.5, (s, truth_region)
    s = summarize(measure(guide, dub, rate, 2.0, 2.0))
    assert abs(s[0] - np.abs(delay_at(np.arange(2.0, 18.0, 0.01))).mean() * 1000) < 3.5, s

    # silence is not counted; a whole-file run through the WAV reader (float32 and 24-bit) and the CLI path
    quiet = guide.copy()
    quiet[5 * rate:7 * rate] = 0
    rows = measure(quiet, warp(quiet, rate), rate)
    assert sum(1 for r in rows if r[3] == "silent") >= 1 and summarize(rows)
    with tempfile.TemporaryDirectory() as tmp:
        gp, dp, tp = (os.path.join(tmp, n) for n in ("g.wav", "d.wav", "t.wav"))
        write_wav(gp, guide, rate, "i24")
        write_wav(dp, dub, rate, "f32")
        write_wav(tp, dub[:int(rate * 16)], rate, "f32")
        _, s1 = run(gp, dp, quiet=True)
        _, s2 = run(gp, tp, quiet=True)
        assert abs(s1[0] - truth) < 3.0 and abs(s2[0] - truth) < 4.0, (s1, s2)
        run(gp, dp)
    # --job: where the result starts (output "dub": at the dub's arrangement position; "guide": at the guide's start)
    with tempfile.TemporaryDirectory() as tmp:
        clips = [{"role": "guide", "path": "/g.wav", "startSec": 1.5, "endSec": 9.0, "startBeats": 8.0},
                 {"role": "dub", "path": "/d.wav", "startSec": 0.25, "endSec": 8.0, "startBeats": 10.0}]
        job = {"version": 1, "plugin": "vocalign", "song": {"tempo": 120.0}, "clips": clips}
        for output, expected in ((None, 1.5 + 1.0), ("dub", 1.5 + 1.0), ("guide", 1.5)):
            if output is None:
                job.pop("output", None)
            else:
                job["output"] = output
            with open(os.path.join(tmp, "job.json"), "w") as f:
                json.dump(job, f)
            g, sig, s0, g0 = job_arguments(tmp)
            assert g == "/g.wav" and sig == os.path.join(tmp, "result.wav"), (g, sig)
            assert s0 == 0.0 and abs(g0 - expected) < 1e-12, (output, s0, g0)
        # a dub before the guide (output dub): the guide is compared from before its region start
        clips[1]["startBeats"] = 6.0
        job.pop("output")
        with open(os.path.join(tmp, "job.json"), "w") as f:
            json.dump(job, f)
        assert abs(job_arguments(tmp)[3] - 0.5) < 1e-12
    print("measure_alignment self-test OK")


def job_arguments(job_dir):
    """guide path, signal path, signal_start, guide_start for a VocAlign job folder. With "output": "guide" the
    host's result.wav starts at the guide clip's arrangement position, so the guide is compared from its own region
    start (guide.startSec) and the result from 0. Otherwise (output "dub", the default) result.wav starts at the dub
    clip's arrangement position, so the guide is compared from the same arrangement time (guide.startSec +
    (dub arrangement time - guide arrangement time))."""
    with open(os.path.join(job_dir, "job.json")) as f:
        job = json.load(f)
    clips = {c["role"]: c for c in job["clips"]}
    if "guide" not in clips or "dub" not in clips:
        raise SystemExit("--job needs a VocAlign job (guide and dub clips in job.json)")
    guide, dub = clips["guide"], clips["dub"]
    if job.get("output") == "guide":
        return guide["path"], os.path.join(job_dir, "result.wav"), 0.0, float(guide.get("startSec") or 0.0)
    tempo = float(job["song"]["tempo"])
    shift_sec = (float(dub["startBeats"]) - float(guide["startBeats"])) * 60.0 / tempo
    return guide["path"], os.path.join(job_dir, "result.wav"), 0.0, float(guide["startSec"]) + shift_sec


def main(argv):
    if argv == ["--self-test"]:
        self_test()
        return
    if len(argv) == 2 and argv[0] == "--job":
        guide, signal, s0, g0 = job_arguments(argv[1])
        with open(os.path.join(argv[1], "job.json")) as f:
            at_guide = json.load(f).get("output") == "guide"
        print("job %s: comparing the result from the %s, guide from %.4f s" % (
            argv[1], "guide's start (output guide)" if at_guide else "dub's arrangement position", g0))
        run(guide, signal, s0, g0)
        return
    if not 2 <= len(argv) <= 4:
        raise SystemExit(__doc__)
    run(argv[0], argv[1], float(argv[2]) if len(argv) > 2 else 0.0, float(argv[3]) if len(argv) > 3 else 0.0)


if __name__ == "__main__":
    main(sys.argv[1:])
