#!/usr/bin/env bash
# Headless round trip with the real plug-ins: with no edits, BridgeHost's result must equal the source
# region (Melodyne) or the dub region (VocAlign) at exactly the region's length; for VocAlign with output "guide" the
# dub region at its arrangement offset inside silence over the guide's window (make_test_job.py writes expected.wav).
# Needs the plug-ins installed and BridgeHost + wavdiff built (tools/build_host.sh, tools/build_tests.sh).
#
# What the plug-ins do (measured 2026-10-22, Melodyne 5.4.2, VocAlign 6 Pro):
# - VocAlign passes the dub through bit for bit: checked with tolerance 0.
# - Melodyne's unedited render is bit-identical for some regions; for others it differs from the source by
#   1-2 float ulps on some samples (max 3e-8 to 6e-8). That is accepted: Melodyne cases pass at
#   MELODYNE_TOL (default 1e-7). The exact region (generated file, 0..2 s) runs at tolerance 0 and guards the
#   host: an offset, gain or length bug in the host shows up far above 1e-7.
# - Melodyne also doubles single samples at some block starts (up to 0.01 here); BridgeHost renders Melodyne
#   twice and repairs them (hostcore/RenderRepair.h). The spike's 20 s vocal (git-ignored, used when present)
#   has such glitches in the regions 5..9 s and 0.75265..6.80272 s (4096 grid), and had one in 9.87..19.99 s
#   with a 3001 grid without pre-roll.
# Extra Melodyne sources (any WAV of at least 20 s) can be passed as arguments; they run with MELODYNE_TOL.
# Every case runs with a copy of settings.json (ARABRIDGE_SETTINGS; plug-in paths kept) whose "keepRaw" is false and
# must leave no render-raw-*.wav or realign-debug.json; the keepRaw cases set it to true (and to a string: ignored).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TP="${ARABRIDGE_THIRD_PARTY:-$ROOT/third_party}"
HOST="$TP/ARA_SDK/ARA_Examples/build/bin/Release/BridgeHost"
WAVDIFF="$ROOT/build/host-tests/wavdiff"
MELODYNE_TOL="${MELODYNE_TOL:-1e-7}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

settings() {    # keepRaw JSON value -> settings file: the user's settings.json (if any) with that keepRaw
    local file="$WORK/settings-$(printf '%s' "$1" | tr -dc 'a-z0-9').json"
    python3 - "$HOME/Library/Application Support/ARABridge/settings.json" "$1" "$file" <<'PY'
import json, os, sys
source, value, target = sys.argv[1:]
try:
    data = json.load(open(source)) if os.path.exists(source) else {}
except ValueError:
    data = {}
data = data if isinstance(data, dict) else {}
data["keepRaw"] = json.loads(value)
json.dump(data, open(target, "w"))
PY
    echo "$file"
}
SETTINGS_OFF="$(settings false)"

no_raw_files() {    # job dir
    if ls "$1"/render-raw-* "$1"/realign-debug.json* >/dev/null 2>&1; then
        echo "keepRaw files written although keepRaw is off:"; ls "$1"; exit 1
    fi
}

roundtrip() {   # name, tolerance, make_test_job.py arguments...
    local name="$1" tol="$2"; shift 2
    echo "== $name (tolerance $tol)"
    python3 "$ROOT/tools/make_test_job.py" "$WORK/$name" "$@" >/dev/null
    ARABRIDGE_SETTINGS="$SETTINGS_OFF" perl -e 'alarm 600; exec @ARGV' "$HOST" --job "$WORK/$name" --autorender
    test -f "$WORK/$name/result.json"
    grep -Eq '"status" *: *"ok"' "$WORK/$name/result.json"
    IFS=$'\t' read -r compared start frames < "$WORK/$name/compare.txt"
    "$WAVDIFF" "$compared" "$WORK/$name/result.wav" --a-start "$start" --tol "$tol" | tee "$WORK/$name/diff.txt"
    grep -q "^frames $frames," "$WORK/$name/diff.txt" || { echo "expected $frames frames"; exit 1; }
    no_raw_files "$WORK/$name"
    if [ -f "$WORK/$name/expected_result.json" ]; then     # output "guide": the placement fields
        python3 - "$WORK/$name/expected_result.json" "$WORK/$name/result.json" <<'PY'
import json, sys
expected, result = json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))
for key, value in expected.items():
    assert result.get(key) == value, (key, result.get(key), value)
print("result.json: " + ", ".join("%s %s" % (k, result[k]) for k in sorted(expected)))
PY
    elif grep -q placeAt "$WORK/$name/result.json"; then
        echo "placeAt written for output dub"; exit 1
    fi
}

# keepRaw on, nothing edited: both raw renders and realign-debug.json are in the job folder, and the first raw render
# equals result.wav exactly (this generated region has no doubled-sample glitch, so the repair changes nothing, and
# realign has nothing to do)
keepraw() {
    local name=melodyne-keepraw dir="$WORK/melodyne-keepraw"
    echo "== $name"
    python3 "$ROOT/tools/make_test_job.py" "$dir" --plugin melodyne --start 0 --end 2 >/dev/null
    ARABRIDGE_SETTINGS="$(settings true)" perl -e 'alarm 600; exec @ARGV' "$HOST" --job "$dir" --autorender | tee "$dir.out"
    grep -Eq '"status" *: *"ok"' "$dir/result.json"
    for file in render-raw-1.wav render-raw-2.wav realign-debug.json; do
        test -f "$dir/$file" || { echo "keepRaw: $file missing"; ls "$dir"; exit 1; }
        grep -qE "keepRaw: wrote .*/$name/$file\$" "$dir.out" || { echo "keepRaw: not logged: $file"; exit 1; }     # the host logs the resolved path
    done
    if ls "$dir"/*.tmp >/dev/null 2>&1; then echo "keepRaw: temp files left"; ls "$dir"; exit 1; fi
    IFS=$'\t' read -r compared start frames < "$dir/compare.txt"
    "$WAVDIFF" "$dir/render-raw-1.wav" "$dir/result.wav" --tol 0 | tee "$dir/diff-raw-1.txt"
    grep -q "^frames $frames," "$dir/diff-raw-1.txt" || { echo "render-raw-1.wav: expected $frames frames"; exit 1; }
    "$WAVDIFF" "$compared" "$dir/render-raw-2.wav" --a-start "$start" --tol "$MELODYNE_TOL" | tee "$dir/diff-raw-2.txt"
    grep -q "^frames $frames," "$dir/diff-raw-2.txt" || { echo "render-raw-2.wav: expected $frames frames"; exit 1; }
    python3 - "$dir/realign-debug.json" "$dir/result.json" "$frames" <<'PY'
import json, sys
debug, result, frames = json.load(open(sys.argv[1])), json.load(open(sys.argv[2])), int(sys.argv[3])
assert debug["jobId"] == result["id"], (debug["jobId"], result["id"])
assert debug["reason"] == result["realign"]["reason"], (debug["reason"], result["realign"])
assert debug["frames"] == frames and debug["sampleRate"] == result["sampleRate"], debug
assert debug["candidates"][:1] == [0] and isinstance(debug["params"], dict) and debug["realignSeconds"] >= 0, debug
print("realign-debug.json: reason %s, %d candidate(s), %d piece(s), %d segment(s)"
      % (debug["reason"], len(debug["candidates"]), debug["pieceCount"], len(debug["segments"])))
PY
}

# keepRaw that is not a boolean: a warning, and nothing extra is written
keepraw_ignored() {
    local name=melodyne-keepraw-string dir="$WORK/melodyne-keepraw-string"
    echo "== $name"
    python3 "$ROOT/tools/make_test_job.py" "$dir" --plugin melodyne --start 0 --end 2 >/dev/null
    ARABRIDGE_SETTINGS="$(settings '"yes"')" perl -e 'alarm 600; exec @ARGV' "$HOST" --job "$dir" --autorender >"$dir.out" 2>&1
    grep -Eq '"status" *: *"ok"' "$dir/result.json"
    grep -qF "warning: settings.json: 'keepRaw' must be true or false; ignored" "$dir.out" || { echo "no keepRaw warning"; cat "$dir.out"; exit 1; }
    no_raw_files "$dir"
    echo "ignored with a warning"
}

roundtrip vocalign 0 --plugin vocalign
roundtrip vocalign-half-sample-start 0 --plugin vocalign --start 0.125 --end 2.0     # 5512.5 frames: rounds up
roundtrip vocalign-output-dub 0 --plugin vocalign --output dub --guide-beats 0 --dub-beats 1
# output "guide": the result starts at the guide; with nothing captured VocAlign passes the dub through, so result.wav
# is the dub region at its arrangement offset inside digital silence (bit for bit)
roundtrip vocalign-guide-dub-later 0 --plugin vocalign --output guide --guide-beats 4 --dub-beats 5        # +0.5 s: silence first, window ends with the dub
roundtrip vocalign-guide-dub-earlier 0 --plugin vocalign --output guide --guide-beats 5 --dub-beats 4      # -0.5 s: 22050 frames dropped, silence at the end
roundtrip vocalign-guide-half-sample 0 --plugin vocalign --output guide --guide-beats 0 --dub-beats 0.25   # 5512.5 frames: 5513
roundtrip vocalign-guide-same-start 0 --plugin vocalign --output guide --guide-beats 2 --dub-beats 2        # the dub region itself
roundtrip melodyne-exact 0 --plugin melodyne --start 0 --end 2
roundtrip melodyne "$MELODYNE_TOL" --plugin melodyne
FIXTURE="$ROOT/host/tests/fixtures/spike_original_2_8s.wav"
if [ -f "$FIXTURE" ]; then
    roundtrip melodyne-fixture "$MELODYNE_TOL" --plugin melodyne --source "$FIXTURE" --start 0.5 --end 5.5
else
    echo "SKIP melodyne-fixture: $FIXTURE not found (a recording of the author, not part of the repository)"
fi
VOCAL="$ROOT/spike/out_session2/render_1.wav"
if [ -f "$VOCAL" ]; then
    roundtrip melodyne-vocal-glitch-1 "$MELODYNE_TOL" --plugin melodyne --source "$VOCAL" --start 5 --end 9
    roundtrip melodyne-vocal-glitch-2 "$MELODYNE_TOL" --plugin melodyne --source "$VOCAL" --start 0.7526530612244898 --end 6.802721088435374
    roundtrip melodyne-vocal-glitch-3 "$MELODYNE_TOL" --plugin melodyne --source "$VOCAL" --start 9.87 --end 19.99
else
    echo "SKIP melodyne-vocal-glitch-1..3: $VOCAL not found (the spike's vocal, git-ignored)"
fi
i=0
for source in "$@"; do
    i=$((i + 1))
    roundtrip "melodyne-extra-$i" "$MELODYNE_TOL" --plugin melodyne --source "$source" --start 0.25 --end 19.5
done
keepraw
keepraw_ignored
echo "headless round trip OK"
