#!/usr/bin/env python3
"""Checks result.wav of a job against the source region (needs numpy).

  check_edit.py JOB_DIR [--blocks]
  check_edit.py --self-test

Reads JOB_DIR/job.json, result.json and result.wav and reports, relative to the start of the region:
  (a) the prefix: the first frame where |result - source| > 1e-5 and the largest difference before it;
  (b) the edited stretch: windows of 50 ms right after the first difference whose error relative to the
      source is > 0.5 (gaps of one window are bridged); start and end in seconds;
  (c) the tail after the edited stretch (+0.25 s margin): relative RMS error, peak error and a per-second
      relative-error profile against the source. The shifted audio Melodyne returns is only about 95% similar
      to the original, so the tail is NOT bit-identical even when the realignment worked: expect a relative
      RMS of about 0.1 with realignment ON and about 1.4 without. Seconds whose source is below -80 dBFS
      (digital silence) show "(silence)" instead of a meaningless ratio. Then the tail in windows of 250 ms
      (on the region's 0.25 s grid; silent ones left out): the 8 worst by error energy with source level, error
      level (dBFS), relative error, share of the tail error and the best residual shift (searched +-120 samples,
      realign's sign: + = the render is early; 0 unless some shift fits clearly better, error at most half of
      the unshifted one), and a quality summary (share of windows with error below -40/-30/-20 dBFS, share of
      the tail error energy in the worst 5 windows);
  (d) a verdict for realign ON jobs: PASS if the prefix is identical, an edit was found and the tail
      relative RMS is <= 0.15, else FAIL with the reason. With realign OFF (job.json "realign": false)
      the numbers are printed with a note that a large tail error is expected. When the tail fails, the
      reasons follow: of the windows with relative error > 0.15, how many fit clearly better at a shift != 0
      (an alignment problem) and how many do not (the content differs); "content differs, not a timing
      problem" when at least 80% of them are of the second kind.
Also prints what result.json says about the realignment (applied, shifts) and its diagnostics.
--blocks additionally lists the blocks of frames that differ at all (> 1e-5, blocks closer than 20 ms merged).

The compared clip is the source (melodyne) or the dub (vocalign). The region starts at result.json's
sourceStartFrame and is result.json's frames long when those are given (BridgeHost writes them), else it is
taken from the clip's startSec (rounded half away from zero, like the host) and result.wav's length.
WAV sources: 16-, 24- and 32-bit integer PCM or 32/64-bit float, mono or stereo (also WAVE_FORMAT_EXTENSIBLE).
"""
import json
import math
import os
import struct
import sys
import tempfile

try:
    import numpy as np
except ImportError:
    raise SystemExit("check_edit.py needs numpy: run it with a Python that has it, or: python3 -m pip install numpy")

THRESHOLD = 1e-5        # a frame differs when any channel differs by more than this
GAP_SEC = 0.02          # differences closer than this belong to one block
WINDOW_SEC = 0.05       # window for the relative error that finds the edited stretch
EDIT_REL = 0.5          # a window is "edited" when its error relative to the source is above this
TAIL_MARGIN_SEC = 0.25  # the tail starts this long after the edited stretch
TAIL_PASS_REL = 0.15    # realign ON: the tail relative RMS must not exceed this
MAX_EDIT_LEAD_SEC = 0.5 # the first difference must lie at most this long before the edited stretch
SILENCE_DB = -80.0      # source below this (dBFS, RMS over all channels) is digital silence: no ratio there
TAIL_WINDOW_SEC = 0.25  # windows of the tail for the worst-window list and the quality summary
WORST_WINDOWS = 8       # how many of the worst tail windows are listed
WORST_ENERGY = 5        # the quality summary gives the share of the tail error in this many worst windows
SHIFT_SEARCH = 120      # best residual shift: searched in samples, both directions
SHIFT_GAIN = 0.5        # ... a shift != 0 counts only if its error energy is at most this x the unshifted one
BAD_WINDOW_REL = TAIL_PASS_REL      # a tail window is "bad" when its relative error is above this
CONTENT_SHARE = 0.8     # "content differs" when at least this share of the bad windows has shift 0


def read_wav(path):
    """(frames x channels float32 array, sample rate) of a WAV file."""
    with open(path, "rb") as f:
        data = f.read()
    if data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise SystemExit("%s is not a WAV file (convert it to WAV to compare)" % path)
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
                tag = struct.unpack("<H", body[24:26])[0]     # sub-format GUID starts with the real tag
            fmt = (tag, channels, rate, bits)
        elif ident == b"data":
            samples = body
        pos += 8 + size + (size & 1)
    if fmt is None or samples is None:
        raise SystemExit("%s has no fmt or data chunk" % path)
    tag, channels, rate, bits = fmt
    if tag == 3 and bits == 32:
        values = np.frombuffer(samples, dtype="<f4").astype(np.float32)
    elif tag == 3 and bits == 64:
        values = np.frombuffer(samples, dtype="<f8").astype(np.float32)
    elif tag == 1 and bits == 16:
        values = np.frombuffer(samples, dtype="<i2").astype(np.float32) / 32768.0
    elif tag == 1 and bits == 24:
        b = np.frombuffer(samples[:len(samples) // 3 * 3], dtype=np.uint8).reshape(-1, 3).astype(np.int32)
        v = b[:, 0] | (b[:, 1] << 8) | (b[:, 2] << 16)
        v = np.where(v >= 1 << 23, v - (1 << 24), v)
        values = (v / float(1 << 23)).astype(np.float32)
    elif tag == 1 and bits == 32:
        values = (np.frombuffer(samples, dtype="<i4") / float(1 << 31)).astype(np.float32)
    else:
        raise SystemExit("%s: unsupported WAV format (tag %d, %d bits)" % (path, tag, bits))
    frames = len(values) // channels
    return values[:frames * channels].reshape(frames, channels), rate


def find_blocks(diff, threshold, gap):
    """[(first, last)] frame ranges where diff > threshold; ranges closer than 'gap' frames are merged."""
    idx = np.nonzero(diff > threshold)[0]
    if len(idx) == 0:
        return []
    parts = np.split(idx, np.nonzero(np.diff(idx) > gap)[0] + 1)
    return [(int(p[0]), int(p[-1])) for p in parts]


def compared_clip(job):
    want = "dub" if job.get("plugin") == "vocalign" else "source"
    for clip in job["clips"]:
        if clip.get("role") == want:
            return clip
    return job["clips"][0]


def print_realign(result):
    if not result:
        return
    realign = result.get("realign") or {}
    shifts = realign.get("shifts") or []
    rate = result.get("sampleRate") or 0
    print("result.json: status %s, message %r" % (result.get("status"), result.get("message", "")))
    print("realign applied: %s, %d segment(s)" % (realign.get("applied", False), len(shifts)))
    for s in shifts:
        where = ("%.3f s .. %.3f s" % (s["start"] / rate, s["end"] / rate)) if rate else ("frames %d .. %d" % (s["start"], s["end"]))
        print("  %s: shift %+.2f samples, correlation %.3f" % (where, s.get("shift", 0.0), s.get("correlation", 0.0)))
    if result.get("diagnostics"):
        print("diagnostics: %s" % result["diagnostics"])


def window_rel_errors(source, rendered, win):
    """Per window of 'win' frames (the last, partial one included): error RMS / source RMS (all channels).
    The source RMS is floored at 1% of the whole clip's RMS so silent windows do not blow up."""
    n, channels = source.shape
    pad = (-n) % win
    s = np.concatenate([source, np.zeros((pad, channels), source.dtype)]).astype(np.float64)
    e = np.concatenate([source - rendered, np.zeros((pad, channels), source.dtype)]).astype(np.float64)
    counts = np.full(len(s) // win, float(win * channels))
    if pad:
        counts[-1] = (win - pad) * channels
    err = np.sqrt((e.reshape(-1, win, channels) ** 2).sum(axis=(1, 2)) / counts)
    ref = np.sqrt((s.reshape(-1, win, channels) ** 2).sum(axis=(1, 2)) / counts)
    floor = 0.01 * math.sqrt(float((source.astype(np.float64) ** 2).mean())) + 1e-12
    return err / np.maximum(ref, floor)


def tail_stats(source, rendered, first, last, rate):
    """Relative RMS, peak error and source peak of frames [first, last), plus per-second relative RMS
    (nan where the source is digital silence, below SILENCE_DB)."""
    s = source[first:last].astype(np.float64)
    e = (rendered[first:last] - source[first:last]).astype(np.float64)
    energy = float((s ** 2).sum())
    rel = math.sqrt(float((e ** 2).sum()) / energy) if energy > 0 else float("inf")
    profile = []
    pos = first
    while pos < last:
        stop = min(last, (pos // rate + 1) * rate)       # bins end on whole seconds of the region
        se = float((source[pos:stop].astype(np.float64) ** 2).sum())
        ee = float(((rendered[pos:stop] - source[pos:stop]).astype(np.float64) ** 2).sum())
        silent = level_db(se / ((stop - pos) * source.shape[1])) < SILENCE_DB
        profile.append((pos / rate, stop / rate, float("nan") if silent else math.sqrt(ee / se)))
        pos = stop
    return {"rel_rms": rel, "peak_err": float(np.abs(e).max()), "src_peak": float(np.abs(s).max()), "profile": profile}


def level_db(power):
    """dBFS of a mean square (a full-scale sine is about -3 dBFS); 0 gives -300."""
    return 10.0 * math.log10(max(power, 1e-30))


def best_shift(source, rendered, first, last):
    """(shift, error energy there, error energy at shift 0) for frames [first, last): the shift in
    [-SHIFT_SEARCH, SHIFT_SEARCH] (realign's sign: rendered[n - shift] ~ source[n], + = the render is early)
    with the least error energy against the source; 0 unless that error is at most SHIFT_GAIN x the unshifted one.
    The render outside the clip counts as silence."""
    n, channels = rendered.shape
    m = SHIFT_SEARCH
    a, b = first - m, last + m                         # rendered[first - m .. last + m) covers every shift
    padded = np.zeros((b - a, channels), np.float64)
    lo, hi = max(a, 0), min(b, n)
    padded[lo - a:hi - a] = rendered[lo:hi]
    s = source[first:last].astype(np.float64)
    length = last - first
    cross = np.zeros(2 * m + 1)
    for c in range(channels):
        cross += np.correlate(padded[:, c], s[:, c], mode="valid")      # k: sum rendered[first - m + k + t] * s[t]
    sq = np.concatenate([[0.0], np.cumsum((padded ** 2).sum(axis=1))])
    window_energy = sq[length:length + 2 * m + 1] - sq[:2 * m + 1]
    errors = float((s ** 2).sum()) + window_energy - 2.0 * cross     # index k is shift m - k
    errors = np.maximum(errors, 0.0)
    at_zero = float(errors[m])
    k = int(np.argmin(errors))
    if k != m and errors[k] <= SHIFT_GAIN * at_zero:
        return m - k, float(errors[k]), at_zero
    return 0, at_zero, at_zero


def tail_windows(source, rendered, first, last, rate):
    """The tail [first, last) in windows on the region's TAIL_WINDOW_SEC grid (the first and last can be partial):
    dicts with start, end (frames), src_db, err_db (dBFS), rel (nan when silent), err_energy, src_energy, silent;
    shift and shift_rel (the best residual shift and the relative error there) are filled in by window_summary."""
    win = max(1, int(round(TAIL_WINDOW_SEC * rate)))
    out = []
    pos = first
    while pos < last:
        stop = min(last, (pos // win + 1) * win)
        s = source[pos:stop].astype(np.float64)
        e = (rendered[pos:stop] - source[pos:stop]).astype(np.float64)
        count = float(s.size)
        sp, ee = float((s ** 2).sum()), float((e ** 2).sum())
        silent = level_db(sp / count) < SILENCE_DB
        out.append({"start": pos, "end": stop, "src_db": level_db(sp / count), "err_db": level_db(ee / count),
                    "rel": float("nan") if silent else math.sqrt(ee / sp), "err_energy": ee, "src_energy": sp, "silent": silent,
                    "shift": None, "shift_rel": None})
        pos = stop
    return out


def window_summary(source, rendered, windows):
    """Fills in the best shift of the worst and the bad windows; returns the summary dict: counts (non-silent),
    below (dBFS -> share), worst (the WORST_WINDOWS worst windows by error energy), worst_share (share of the tail
    error energy in the WORST_ENERGY worst), bad, bad_shifted, bad_content."""
    audible = [w for w in windows if not w["silent"]]
    total = sum(w["err_energy"] for w in windows)
    ranked = sorted(audible, key=lambda w: w["err_energy"], reverse=True)
    worst = ranked[:WORST_WINDOWS]
    bad = [w for w in audible if w["rel"] > BAD_WINDOW_REL]
    for w in worst + bad:
        if w["shift"] is None:
            shift, err, _ = best_shift(source, rendered, w["start"], w["end"])
            w["shift"] = shift
            w["shift_rel"] = math.sqrt(err / w["src_energy"])
    count = len(audible)
    below = {limit: (100.0 * sum(1 for w in audible if w["err_db"] < limit) / count if count else float("nan"))
             for limit in (-40.0, -30.0, -20.0)}
    worst_share = sum(w["err_energy"] for w in ranked[:WORST_ENERGY]) / total if total > 0 else float("nan")
    shifted = [w for w in bad if w["shift"] != 0]
    return {"count": count, "silent": len(windows) - count, "below": below, "worst": worst, "worst_share": worst_share,
            "total_energy": total, "bad": bad, "bad_shifted": len(shifted), "bad_content": len(bad) - len(shifted)}


def fail_reasons(res):
    """(lines, content_differs) explaining a tail over TAIL_PASS_REL from the bad windows; ([], False) without a tail."""
    summary = res.get("summary")
    if summary is None:
        return [], False
    bad = summary["bad"]
    if not bad:
        return ["no single 250 ms window has a relative error above %.2f: the error is spread over the whole tail" % BAD_WINDOW_REL], False
    lines = ["%d of %d non-silent 250 ms windows have a relative error above %.2f: %d fit clearly better at a shift != 0"
             " (alignment problem), %d do not (best shift 0: the content differs)"
             % (len(bad), summary["count"], BAD_WINDOW_REL, summary["bad_shifted"], summary["bad_content"])]
    content = summary["bad_content"] >= CONTENT_SHARE * len(bad)
    if content:
        lines.append("=> content differs, not a timing problem")
    else:
        shifts = sorted(set(w["shift"] for w in bad if w["shift"] != 0))
        lines.append("=> timing problem: %d window(s) still fit better moved (shifts %s samples)"
                     % (summary["bad_shifted"], ", ".join("%+d" % x for x in shifts)))
    return lines, content


def analyze(source, rendered, rate):
    """Compares equally long arrays (frames x channels). Returns a dict (frame numbers are region frames):
    first (first frame differing by more than THRESHOLD or None), prefix_max, edit (first, end) frames or None,
    tail_start, tail (tail_stats or None), blocks."""
    n = min(len(source), len(rendered))
    source, rendered = source[:n], rendered[:n]
    diff = np.abs(source - rendered).max(axis=1)
    out = {"frames": n, "diff": diff, "first": None, "prefix_max": 0.0, "edit": None, "tail_start": None, "tail": None, "after": None,
           "windows": None, "summary": None,
           "differing": int(np.count_nonzero(diff > THRESHOLD)), "blocks": find_blocks(diff, THRESHOLD, int(GAP_SEC * rate))}
    idx = np.nonzero(diff > THRESHOLD)[0]
    if len(idx) == 0:
        return out
    first = int(idx[0])
    out["first"] = first
    out["prefix_max"] = float(diff[:first].max()) if first > 0 else 0.0
    win = max(1, int(round(WINDOW_SEC * rate)))
    large = window_rel_errors(source, rendered, win) > EDIT_REL
    w = first // win
    while w < len(large) and not large[w]:
        w += 1
    if w >= len(large):
        return out
    w_end = w
    while w_end + 1 < len(large) and (large[w_end + 1] or (w_end + 2 < len(large) and large[w_end + 2])):
        w_end += 1
    out["edit"] = (w * win, min(n, (w_end + 1) * win))
    tail_start = out["edit"][1] + int(round(TAIL_MARGIN_SEC * rate))
    out["tail_start"] = tail_start
    if tail_start < n:
        out["tail"] = tail_stats(source, rendered, tail_start, n, rate)
        out["windows"] = tail_windows(source, rendered, tail_start, n, rate)
        out["summary"] = window_summary(source, rendered, out["windows"])
    else:
        out["after"] = tail_stats(source, rendered, first, n, rate)     # nothing separable: all of it counts as edited
    return out


def verdict(res, realign, rate):
    """(passed or None, text). None: no verdict (realign OFF)."""
    if not realign:
        return None, "realign OFF: no verdict; a large tail error (about 1.4) is expected here (the timing shift is not corrected)"
    if res["first"] is None:
        return False, "FAIL: result is identical to the source (no edit found)"
    if res["first"] == 0:
        return False, "FAIL: the result differs from the very first frame (no identical prefix)"
    if res["edit"] is None:
        return False, "FAIL: no edited stretch found (no 50 ms window with relative error > %.1f after the first difference)" % EDIT_REL
    lead = (res["edit"][0] - res["first"]) / rate
    if lead > MAX_EDIT_LEAD_SEC:
        return False, "FAIL: the first difference (%.3f s) lies %.2f s before the edited stretch: the prefix is not identical" % (res["first"] / rate, lead)
    if res["tail"] is None:
        return False, "FAIL: the edited stretch runs to the end of the clip: no tail to measure"
    if not res["tail"]["rel_rms"] <= TAIL_PASS_REL:
        return False, "FAIL: tail relative RMS %.3f > %.2f (the shifted tail is not back on the original timeline)" % (res["tail"]["rel_rms"], TAIL_PASS_REL)
    return True, "PASS: prefix identical, edit at %.3f s .. %.3f s, tail relative RMS %.3f <= %.2f" % (
        res["edit"][0] / rate, res["edit"][1] / rate, res["tail"]["rel_rms"], TAIL_PASS_REL)


def print_report(res, rate, realign, show_blocks):
    n = res["frames"]
    if res["first"] is None:
        print("(a) prefix: no frame differs by more than %g (%.2f s): result is identical to the source (no edit?)" % (THRESHOLD, n / rate))
    else:
        print("(a) prefix: first difference (> %g) at %.3f s (frame %d); everything before it is within that threshold (largest difference %.3g)"
              % (THRESHOLD, res["first"] / rate, res["first"], res["prefix_max"]))
        print("    %d differing frame(s) in all (%.1f%% of %.2f s)" % (res["differing"], 100.0 * res["differing"] / n, n / rate))
    if res["edit"] is None:
        print("(b) edited stretch: none found (no %g s window with relative error > %.1f after the first difference)" % (WINDOW_SEC, EDIT_REL))
    else:
        a, b = res["edit"]
        print("(b) edited stretch: %.3f s .. %.3f s (%.3f s long; windows of %g s with relative error > %.1f)" % (a / rate, b / rate, (b - a) / rate, WINDOW_SEC, EDIT_REL))
    if res["tail_start"] is not None:
        tail = res["tail"]
        if tail is None:
            print("(c) tail: none; the edited stretch runs to the end of the clip (within the %.2f s margin)" % TAIL_MARGIN_SEC)
            after = res["after"]
            print("    everything after the first difference (%.3f s on): relative RMS error %.4f, peak error %.3g (source peak %.3g)"
                  % (res["first"] / rate, after["rel_rms"], after["peak_err"], after["src_peak"]))
        else:
            print("(c) tail from %.3f s (stretch end + %.2f s): relative RMS error %.4f, peak error %.3g (source peak %.3g)"
                  % (res["tail_start"] / rate, TAIL_MARGIN_SEC, tail["rel_rms"], tail["peak_err"], tail["src_peak"]))
            print("    relative RMS error per second:")
            for a, b, r in tail["profile"]:
                print("      %6.2f .. %6.2f s  %s" % (a, b, ("%.3f" % r) if r == r else "(silence)"))
            print_windows(res["summary"], rate)
    else:
        print("(c) tail: n/a (no edited stretch)")
    if show_blocks:
        if not res["blocks"]:
            print("blocks: none")
        else:
            print("blocks of difference (> %g, merged within %g s): %d" % (THRESHOLD, GAP_SEC, len(res["blocks"])))
            for first, last in res["blocks"]:
                print("  %.3f s .. %.3f s (%.3f s)" % (first / rate, last / rate, (last - first + 1) / rate))
    passed, text = verdict(res, realign, rate)
    print("(d) " + text)
    if passed is False and res["tail"] is not None and not res["tail"]["rel_rms"] <= TAIL_PASS_REL:
        for line in fail_reasons(res)[0]:
            print("    " + line)


def print_windows(summary, rate):
    if summary["count"] == 0:
        print("    250 ms windows: all %d silent" % summary["silent"])
        return
    print("    worst %d of %d non-silent 250 ms windows by error energy (%d silent left out); shift: best residual shift"
          % (len(summary["worst"]), summary["count"], summary["silent"]))
    print("    in samples (+-%d searched, + = render early, 0 unless one fits clearly better) and the relative error there:" % SHIFT_SEARCH)
    print("          time            source    error   relative  share of   shift  rel. error")
    print("                           dBFS      dBFS    error    tail err.          shifted")
    total = summary["total_energy"]
    for w in summary["worst"]:
        share = 100.0 * w["err_energy"] / total if total > 0 else 0.0
        print("      %6.2f .. %6.2f s  %7.1f  %7s   %7.3f   %6.1f%%   %5s   %7.3f"
              % (w["start"] / rate, w["end"] / rate, w["src_db"], ("%.1f" % w["err_db"]) if w["err_db"] > -200 else "-inf",
                 w["rel"], share, ("%+d" % w["shift"]) if w["shift"] else "0", w["shift_rel"]))
    below = summary["below"]
    share = ("the worst %d hold %.0f%% of the tail error energy" % (WORST_ENERGY, 100.0 * summary["worst_share"])
             if summary["total_energy"] > 0 else "the tail has no error at all")
    print("    quality summary: of %d non-silent 250 ms windows %.0f%% have an error below -40 dBFS, %.0f%% below -30 dBFS,"
          " %.0f%% below -20 dBFS; %s" % (summary["count"], below[-40.0], below[-30.0], below[-20.0], share))


def check(job_dir, show_blocks=False):
    job = json.load(open(os.path.join(job_dir, "job.json")))
    result_path = os.path.join(job_dir, "result.json")
    result = json.load(open(result_path)) if os.path.exists(result_path) else None
    if result and result.get("status") != "ok":
        print_realign(result)
        raise SystemExit("result.json status is %r: nothing to compare" % result.get("status"))
    clip = compared_clip(job)
    source, rate = read_wav(clip["path"])
    rendered, rate2 = read_wav(os.path.join(job_dir, "result.wav"))
    if rate != rate2:
        raise SystemExit("sample rates differ: source %d Hz, result %d Hz" % (rate, rate2))
    if source.shape[1] != rendered.shape[1]:
        raise SystemExit("channel counts differ: source %d, result %d" % (source.shape[1], rendered.shape[1]))
    if result and result.get("frames"):
        start, frames = int(result.get("sourceStartFrame", 0)), int(result["frames"])
        if frames != len(rendered):
            print("warning: result.wav has %d frames, result.json says %d" % (len(rendered), frames))
    else:
        start, frames = int(math.floor(clip["startSec"] * rate + 0.5)), len(rendered)
    region = source[start:start + frames]
    n = min(len(region), len(rendered))
    if n == 0:
        raise SystemExit("the region is empty (start frame %d, %d frames)" % (start, frames))
    realign = bool(job.get("realign", True))
    print("%s, region from frame %d, %.2f s (%d frames), %d channel(s), realign %s" % (
        os.path.basename(clip["path"]), start, n / rate, n, source.shape[1], "ON" if realign else "OFF"))
    res = analyze(region[:n], rendered[:n], rate)
    print_report(res, rate, realign, show_blocks)
    print_realign(result)
    return res


def write_wav(path, audio, rate, kind):
    """Test helper: kind 'f32', 'i16' or 'i24'; audio is frames x channels in [-1, 1)."""
    channels = audio.shape[1]
    if kind == "f32":
        tag, bits, payload = 3, 32, audio.astype("<f4").tobytes()
    elif kind == "i16":
        tag, bits, payload = 1, 16, np.round(audio * 32767).astype("<i2").tobytes()
    else:
        v = np.round(audio * 8388607).astype(np.int32).reshape(-1)
        b = np.stack([v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF], axis=1).astype(np.uint8)
        tag, bits, payload = 1, 24, b.tobytes()
    block = channels * bits // 8
    fmt = struct.pack("<HHIIHH", tag, channels, rate, rate * block, block, bits)
    with open(path, "wb") as f:
        f.write(b"RIFF" + struct.pack("<I", 4 + 8 + len(fmt) + 8 + 4 + 8 + len(payload)) + b"WAVE")
        f.write(b"fmt " + struct.pack("<I", len(fmt)) + fmt)
        f.write(b"LIST" + struct.pack("<I", 4) + b"INFO")      # an extra chunk before the data
        f.write(b"data" + struct.pack("<I", len(payload)) + payload)


def self_test():
    assert find_blocks(np.zeros(100), 1e-5, 10) == []
    d = np.zeros(1000)
    d[100:120] = 1.0
    d[125] = 1.0            # within the gap: same block
    d[600:610] = 1.0        # far away: second block
    assert find_blocks(d, 1e-5, 10) == [(100, 125), (600, 609)], find_blocks(d, 1e-5, 10)
    d2 = np.zeros(10)
    d2[0] = d2[9] = 1e-6    # below the threshold
    assert find_blocks(d2, 1e-5, 2) == []

    rate = 44100
    t = np.arange(4410) / rate
    for channels in (1, 2):
        audio = np.stack([0.5 * np.sin(2 * np.pi * 220 * t + c) for c in range(channels)], axis=1)
        for kind, tolerance in (("f32", 0.0), ("i16", 1.0 / 32767), ("i24", 1.0 / 8388607)):
            with tempfile.TemporaryDirectory() as tmp:
                path = os.path.join(tmp, "x.wav")
                write_wav(path, audio, rate, kind)
                back, r = read_wav(path)
                assert r == rate and back.shape == audio.shape, (kind, channels, back.shape)
                assert np.abs(back - audio).max() <= tolerance + 1e-7, (kind, channels, np.abs(back - audio).max())

    # a whole job: mono 24-bit source, an edit at 0.5 s, result.json with the frame range
    with tempfile.TemporaryDirectory() as tmp:
        source = np.stack([0.4 * np.sin(2 * np.pi * 200 * np.arange(rate * 2) / rate)], axis=1)
        write_wav(os.path.join(tmp, "src.wav"), source, rate, "i24")
        src, _ = read_wav(os.path.join(tmp, "src.wav"))
        region = src[rate // 2:rate // 2 + rate].copy()
        region[rate // 2:rate // 2 + 4410] *= 0.2
        write_wav(os.path.join(tmp, "result.wav"), region, rate, "f32")
        json.dump({"plugin": "melodyne", "clips": [{"role": "source", "path": os.path.join(tmp, "src.wav"), "startSec": 0.5, "endSec": 1.5}]},
                  open(os.path.join(tmp, "job.json"), "w"))
        json.dump({"status": "ok", "message": "", "sourceStartFrame": rate // 2, "frames": rate, "sampleRate": rate,
                   "realign": {"applied": False, "shifts": []}, "diagnostics": ""}, open(os.path.join(tmp, "result.json"), "w"))
        res = check(tmp, show_blocks=True)
        blocks = res["blocks"]
        assert len(blocks) == 1 and abs(blocks[0][0] - rate // 2) <= 1, blocks
        assert res["first"] is not None and abs(res["first"] - rate // 2) <= 1, res["first"]

    # the new metrics on synthetic signals: 12 s of noise, an edit at 3.0 .. 3.4 s
    rng = np.random.default_rng(1)
    clip = (0.1 * rng.standard_normal((rate * 12, 2))).astype(np.float32)
    edit_a, edit_b = int(3.0 * rate), int(3.4 * rate)

    def edited(tail):
        out = clip.copy()
        out[edit_a:edit_b] = (0.1 * rng.standard_normal((edit_b - edit_a, 2))).astype(np.float32)   # unrelated audio
        out[edit_b:] = tail
        return out

    # no edit
    res = analyze(clip, clip.copy(), rate)
    assert res["first"] is None and res["edit"] is None and res["tail"] is None and res["blocks"] == []
    assert verdict(res, True, rate)[0] is False and "no edit" in verdict(res, True, rate)[1]

    # an edit followed by an exact copy of the source (a perfectly realigned tail)
    res = analyze(clip, edited(clip[edit_b:]), rate)
    assert abs(res["first"] - edit_a) <= 1 and res["prefix_max"] == 0.0, res["first"]
    assert abs(res["edit"][0] - edit_a) <= rate * 0.05 and abs(res["edit"][1] - edit_b) <= rate * 0.05, res["edit"]
    assert res["tail"]["rel_rms"] < 1e-6 and res["tail"]["peak_err"] == 0.0
    assert abs(res["tail_start"] - (res["edit"][1] + int(0.25 * rate))) <= 1
    assert verdict(res, True, rate)[0] is True, verdict(res, True, rate)
    assert verdict(res, False, rate)[0] is None

    # an edit followed by a noisy copy: relative error 10% passes, 30% fails
    for level, ok in ((0.10, True), (0.30, False)):
        noisy = clip[edit_b:] + level * 0.1 * rng.standard_normal(clip[edit_b:].shape).astype(np.float32)
        res = analyze(clip, edited(noisy), rate)
        assert abs(res["tail"]["rel_rms"] - level) < 0.02, (level, res["tail"]["rel_rms"])
        assert res["tail"]["peak_err"] > 0 and len(res["tail"]["profile"]) >= 8
        assert all(abs(r - level) < 0.03 for _, _, r in res["tail"]["profile"]), res["tail"]["profile"]
        assert verdict(res, True, rate)[0] is ok, (level, verdict(res, True, rate))
        assert all(w["shift"] == 0 for w in res["summary"]["worst"]), [w["shift"] for w in res["summary"]["worst"]]
        if not ok:      # noise everywhere: every window is bad, none fits better shifted
            lines, content = fail_reasons(res)
            assert content and "content differs, not a timing problem" in lines[-1], lines

    # an unaligned tail (delayed by 100 samples) is far above 0.15
    delayed = np.concatenate([np.zeros((100, 2), np.float32), clip])[edit_b:len(clip) + 100 - 100]
    res = analyze(clip, edited(delayed[:len(clip) - edit_b]), rate)
    assert res["tail"] is None and res["edit"][1] >= len(clip) - rate * 0.05          # it all counts as edited
    assert res["after"]["rel_rms"] > 1.0 and verdict(res, True, rate)[0] is False
    assert verdict(res, False, rate)[0] is None

    # a stray difference long before the edit: the prefix is not identical
    glitched = edited(clip[edit_b:])
    glitched[rate] += 1e-3
    res = analyze(clip, glitched, rate)
    assert res["first"] == rate and res["edit"] is not None and abs(res["edit"][0] - edit_a) <= rate * 0.05
    assert verdict(res, True, rate)[0] is False and "prefix" in verdict(res, True, rate)[1]

    # an edit that runs to the end of the clip: no tail
    res = analyze(clip, edited(0.1 * rng.standard_normal(clip[edit_b:].shape).astype(np.float32)), rate)
    assert res["tail"] is None and "no tail" in verdict(res, True, rate)[1]
    assert res["summary"] is None and fail_reasons(res) == ([], False)

    # the 250 ms windows of a perfect tail: all far below -40 dBFS, no bad window
    res = analyze(clip, edited(clip[edit_b:]), rate)
    summary = res["summary"]
    win = int(TAIL_WINDOW_SEC * rate)
    assert res["windows"][0]["start"] == res["tail_start"] and res["windows"][1]["start"] % win == 0
    assert res["windows"][-1]["end"] == len(clip) and summary["silent"] == 0 and summary["count"] == len(res["windows"])
    assert summary["below"] == {-40.0: 100.0, -30.0: 100.0, -20.0: 100.0} and summary["bad"] == []
    assert len(summary["worst"]) == WORST_WINDOWS and all(w["shift"] == 0 for w in summary["worst"])

    # a silent source at the end (digital silence, the render has a little noise there): "(silence)" in the profile,
    # left out of the windows, and no effect on the verdict
    quiet = clip.copy()
    quiet[11 * rate:] = 0.0
    rendered = edited(quiet[edit_b:])
    rendered[11 * rate:] = (1e-7 * rng.standard_normal((len(clip) - 11 * rate, 2))).astype(np.float32)
    res = analyze(quiet, rendered, rate)
    profile = res["tail"]["profile"]
    assert profile[-1][0] == 11.0 and profile[-1][2] != profile[-1][2], profile[-1]          # nan: silence
    assert all(r == r for _, _, r in profile[:-1]), profile
    assert res["summary"]["silent"] == 4 and all(not w["silent"] for w in res["summary"]["worst"])
    assert all(w["start"] < 11 * rate for w in res["summary"]["worst"])
    assert res["summary"]["below"][-40.0] == 100.0 and verdict(res, True, rate)[0] is True

    # one window of unrelated audio in the tail (the content differs there): it is the worst window, at shift 0
    bad_a, bad_b = 8 * rate, 8 * rate + win
    rendered = edited(clip[edit_b:])
    rendered[bad_a:bad_b] = (0.1 * rng.standard_normal((win, 2))).astype(np.float32)
    res = analyze(clip, rendered, rate)
    summary = res["summary"]
    worst = summary["worst"][0]
    assert worst["start"] == bad_a and worst["end"] == bad_b and worst["shift"] == 0, worst
    assert abs(worst["rel"] - math.sqrt(2.0)) < 0.1 and summary["worst_share"] > 0.999, (worst["rel"], summary["worst_share"])
    assert len(summary["bad"]) == 1 and summary["bad_content"] == 1 and summary["bad_shifted"] == 0
    assert abs(summary["below"][-40.0] - 100.0 * (summary["count"] - 1) / summary["count"]) < 1e-9
    assert verdict(res, True, rate)[0] is False and "tail relative RMS" in verdict(res, True, rate)[1]
    lines, content = fail_reasons(res)
    assert content and lines[-1] == "=> content differs, not a timing problem", lines

    # one window that is still shifted (the render is 40 samples late there): found at shift -40, an alignment problem
    rendered = edited(clip[edit_b:])
    rendered[bad_a:bad_b] = clip[bad_a - 40:bad_b - 40]
    res = analyze(clip, rendered, rate)
    summary = res["summary"]
    worst = summary["worst"][0]
    assert worst["start"] == bad_a and worst["shift"] == -40 and worst["shift_rel"] < 0.1 * worst["rel"], worst
    assert summary["bad_shifted"] == 1 and summary["bad_content"] == 0
    assert verdict(res, True, rate)[0] is False
    lines, content = fail_reasons(res)
    assert not content and "timing problem" in lines[-1] and "-40" in lines[-1], lines
    # the same, 40 samples early: + (realign's sign)
    rendered[bad_a:bad_b] = clip[bad_a + 40:bad_b + 40]
    assert analyze(clip, rendered, rate)["summary"]["worst"][0]["shift"] == 40

    # best_shift directly: a whole-clip shift of 7 samples, and near the clip's edges (zeros outside)
    late = np.concatenate([np.zeros((7, 2), np.float32), clip[:-7]])
    assert best_shift(clip, late, rate, 2 * rate)[0] == -7
    assert best_shift(clip, late, 0, win)[0] == -7 and best_shift(clip, late, len(clip) - win, len(clip))[0] == -7
    same = best_shift(clip, clip, 0, win)
    assert same[0] == 0 and same[1] < 1e-9 * float((clip[:win].astype(np.float64) ** 2).sum()), same
    print("check_edit self-test OK")


def main():
    args = sys.argv[1:]
    show_blocks = "--blocks" in args
    args = [a for a in args if a != "--blocks"]
    if len(args) != 1:
        raise SystemExit(__doc__)
    if args[0] == "--self-test":
        self_test()
    else:
        check(args[0], show_blocks)


if __name__ == "__main__":
    main()
