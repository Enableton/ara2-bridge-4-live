#!/usr/bin/env bash
# Failure cases of BridgeHost --autorender: each must end with the documented exit code and, where the job
# folder is known, a result.json with status "error" and a message that says what went wrong.
# Needs BridgeHost built (tools/build_host.sh) and, for the cases that get as far as the plug-in, Melodyne.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TP="${ARABRIDGE_THIRD_PARTY:-$ROOT/third_party}"
HOST="$TP/ARA_SDK/ARA_Examples/build/bin/Release/BridgeHost"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
failures=0

run_host() {    # job dir, then env assignments; sets $code
    local dir="$1"; shift
    set +e
    env "$@" perl -e 'alarm 300; exec @ARGV' "$HOST" --job "$dir" --autorender >"$dir.out" 2>&1
    code=$?
    set -e
}

expect_error() {    # name, job dir, exit code, message part, env assignments...
    local name="$1" dir="$2" want="$3" part="$4"; shift 4
    run_host "$dir" "$@"
    local ok=1
    [ "$code" = "$want" ] || { echo "   exit code $code, expected $want"; ok=0; }
    if [ -f "$dir/result.json" ]; then
        grep -Eq '"status" *: *"error"' "$dir/result.json" || { echo "   result.json status is not error"; ok=0; }
        grep -qF -- "$part" "$dir/result.json" || { echo "   result.json message lacks '$part'"; ok=0; }
    else
        echo "   no result.json"; ok=0
    fi
    if [ "$ok" = 1 ]; then
        echo "ok   $name (exit $code): $(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["message"])' "$dir/result.json")"
    else
        echo "FAIL $name"; sed 's/^/   | /' "$dir.out"; failures=$((failures + 1))
    fi
}

job() {     # name, make_test_job.py arguments... -> prints the job dir
    python3 "$ROOT/tools/make_test_job.py" "$WORK/$1" "${@:2}" >/dev/null
    echo "$WORK/$1"
}

edit_job() {    # job dir, python statement on 'j' (the parsed job.json)
    python3 - "$1/job.json" "$2" <<'EOF'
import json, sys
path, statement = sys.argv[1], sys.argv[2]
j = json.load(open(path))
exec(statement)
json.dump(j, open(path, "w"), indent=2)
EOF
}

# plug-in not found: no settings file, an empty plug-in folder
dir="$(job noplugin --plugin melodyne)"
mkdir -p "$WORK/empty-plugins"
expect_error "missing plug-in" "$dir" 3 "$WORK/empty-plugins" ARABRIDGE_PLUGIN_DIRS="$WORK/empty-plugins" ARABRIDGE_SETTINGS="$WORK/none.json"

# job.json that is not JSON, or misses a required key
dir="$(job badjson --plugin melodyne)"; printf '{ not json' > "$dir/job.json"
expect_error "malformed job.json" "$dir" 2 "bad job"
dir="$(job noclips --plugin melodyne)"; edit_job "$dir" "del j['clips']"
expect_error "job without clips" "$dir" 2 "clips"
dir="$WORK/nojob"; mkdir -p "$dir"
expect_error "folder without job.json" "$dir" 2 "bad job"

# audio problems
dir="$(job missingaudio --plugin melodyne)"; edit_job "$dir" "j['clips'][0]['path'] = '/nonexistent/vocal.wav'"
expect_error "missing audio file" "$dir" 4 "clip 'source'"
dir="$(job headeronly --plugin melodyne)"; head -c 44 "$dir/source.wav" > "$dir/short.wav"; mv "$dir/short.wav" "$dir/source.wav"
expect_error "WAV with a header only" "$dir" 4 "clip 'source'"
dir="$(job shortdata --plugin melodyne)"; head -c $((44 + 44100 * 4 * 2)) "$dir/source.wav" > "$dir/short.wav"; mv "$dir/short.wav" "$dir/source.wav"
expect_error "WAV cut short (2 s of 5)" "$dir" 4 "ends after the end of its audio file"
dir="$(job threechannels --plugin melodyne)"
python3 - "$dir/source.wav" <<'EOF'
import sys, wave
with wave.open(sys.argv[1], "wb") as w:
    w.setnchannels(3); w.setsampwidth(2); w.setframerate(44100); w.writeframes(b"\x01\x00" * 3 * 44100 * 5)
EOF
expect_error "three-channel audio" "$dir" 4 "only mono and stereo"

# VocAlign output "guide": a dub that ends where the guide starts has nothing to place there (checked before the
# plug-in is loaded); an unknown output is a bad job
dir="$(job dubbeforeguide --plugin vocalign --output guide --guide-beats 4 --dub-beats 0)"
expect_error "output guide, dub ends before the guide" "$dir" 4 "ends before the guide clip starts"
dir="$(job badoutput --plugin vocalign)"; edit_job "$dir" "j['output'] = 'sideways'"
expect_error "unknown output" "$dir" 2 "unknown output 'sideways'"
dir="$(job outputmelodyne --plugin melodyne)"; edit_job "$dir" "j['output'] = 'guide'"
expect_error "output guide for melodyne" "$dir" 2 "needs a vocalign job"

# time budget (ARABRIDGE_TIMEOUT_SEC) with a simulated hang (ARABRIDGE_TEST_HANG, test only):
# the render stops when asked -> normal error result; it ignores the request -> fallback after the grace
# time; the main thread hangs -> the SIGALRM watchdog writes the fallback
dir="$(job hangsoft --plugin melodyne)"
expect_error "render times out and stops" "$dir" 6 "timed out after 2 s while rendering" ARABRIDGE_TIMEOUT_SEC=2 ARABRIDGE_TEST_HANG=render-soft
dir="$(job hanghard --plugin melodyne)"
expect_error "render times out and hangs (grace exit)" "$dir" 6 "timed out after 2 s (the plug-in did not finish)" ARABRIDGE_TIMEOUT_SEC=2 ARABRIDGE_TEST_HANG=render
dir="$(job hangmain --plugin melodyne)"
expect_error "main thread hangs (watchdog)" "$dir" 6 "timed out after 2 s (the plug-in did not finish)" ARABRIDGE_TIMEOUT_SEC=2 ARABRIDGE_TEST_HANG=main

# an existing result.json is left alone (exit 2, nothing written)
dir="$(job exists --plugin melodyne)"; printf 'previous result' > "$dir/result.json"
run_host "$dir"
if [ "$code" = 2 ] && [ "$(cat "$dir/result.json")" = "previous result" ] && [ ! -e "$dir/result.wav" ]; then
    echo "ok   existing result.json kept (exit 2)"
else
    echo "FAIL existing result.json (exit $code)"; failures=$((failures + 1))
fi

# a reader that closes stdout early must not kill the host (SIGPIPE)
dir="$(job sigpipe --plugin melodyne)"
set +e; perl -e 'alarm 300; exec @ARGV' "$HOST" --job "$dir" --autorender 2>/dev/null | true; code=${PIPESTATUS[0]}; set -e
if [ "$code" = 0 ] && grep -Eq '"status" *: *"ok"' "$dir/result.json"; then
    echo "ok   closed stdout (exit 0, result ok)"
else
    echo "FAIL closed stdout (exit $code)"; failures=$((failures + 1))
fi

# usage errors write nothing
set +e; "$HOST" >/dev/null 2>&1; code=$?; "$HOST" --job "$WORK/does-not-exist" --autorender >/dev/null 2>&1; code2=$?; set -e
if [ "$code" = 2 ] && [ "$code2" = 2 ]; then echo "ok   usage errors (exit 2)"; else echo "FAIL usage errors ($code, $code2)"; failures=$((failures + 1)); fi

[ "$failures" = 0 ] && echo "headless failure cases OK" || { echo "$failures failure(s)"; exit 1; }
