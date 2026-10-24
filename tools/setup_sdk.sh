#!/usr/bin/env bash
# Prepares Celemony's ARA SDK for building BridgeHost: pinned clone, VST3/AudioUnit SDKs,
# our patch to the SDK's example code, and the BridgeHost target hook. Safe to run repeatedly.
# ARABRIDGE_THIRD_PARTY overrides the install folder (default: <repo>/third_party).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TP="${ARABRIDGE_THIRD_PARTY:-$ROOT/third_party}"
SDK="$TP/ARA_SDK"
EX="$SDK/ARA_Examples"

ARA_SDK_URL="https://github.com/Celemony/ARA_SDK.git"
ARA_SDK_COMMIT="a2b1aac1d1d5c4eed387db85a9c0cdb7d460254c"
ARA_EXAMPLES_COMMIT="abd7c8aa5854591995e1fbf16f854c65b0998e8d"
PATCH="$ROOT/host/patches/ara-examples-bridgehost.patch"

die() { echo "setup_sdk: $*" >&2; exit 1; }

for tool in git cmake; do
    command -v "$tool" >/dev/null 2>&1 || die "'$tool' not found in PATH"
done
[ -f "$PATCH" ] || die "missing patch file $PATCH"

mkdir -p "$TP"
if [ ! -d "$SDK/.git" ]; then
    [ ! -e "$SDK" ] || die "$SDK exists but is not a git checkout; remove it and rerun"
    git clone "$ARA_SDK_URL" "$SDK"
fi

# pin the SDK; --init updates submodules that are not initialized yet. An already initialized
# ARA_Examples is left alone, so a patched or edited working tree survives a rerun.
if [ "$(git -C "$SDK" rev-parse HEAD)" != "$ARA_SDK_COMMIT" ]; then
    git -C "$SDK" cat-file -e "$ARA_SDK_COMMIT^{commit}" 2>/dev/null || git -C "$SDK" fetch --quiet origin
    git -C "$SDK" -c advice.detachedHead=false checkout --quiet "$ARA_SDK_COMMIT" \
        || die "cannot check out $ARA_SDK_COMMIT in $SDK (local changes? fix or remove the folder and rerun)"
fi
git -C "$SDK" submodule update --init --recursive

actual="$(git -C "$EX" rev-parse HEAD)"
[ "$actual" = "$ARA_EXAMPLES_COMMIT" ] \
    || die "unexpected ARA_Examples commit $actual (wanted $ARA_EXAMPLES_COMMIT)"

# companion SDKs, installed next to the ARA SDK by Celemony's own scripts. The guards are ours:
# install_AudioUnitSDK.cmake checks for a file that its own pinned release no longer contains
# and fails on every rerun.
[ -f "$SDK/vst3sdk/cmake/modules/SMTG_VST3_SDK.cmake" ] || cmake -P "$SDK/install_vst3sdk.cmake"
[ -f "$SDK/AudioUnitSDK/Source/AUBase.cpp" ] || cmake -P "$SDK/install_AudioUnitSDK.cmake"

# our changes to the SDK's example code
if git -C "$EX" apply --reverse --check "$PATCH" 2>/dev/null; then
    echo "patch already applied"
elif git -C "$EX" apply --check "$PATCH" 2>/dev/null; then
    git -C "$EX" apply "$PATCH"
    echo "patch applied"
else
    die "the patch neither applies nor is it fully applied in $EX (half-applied or edited files). Revert with: git -C '$EX' checkout -- ExamplesCommon TestHost  and rerun"
fi

# warn about edits to tracked SDK files other than the patched ones and the hook below
# (the patched files are the ones the patch names)
expected="$( (sed -n 's#^diff --git a/\([^ ]*\) .*#\1#p' "$PATCH"; echo CMakeLists.txt) | sort -u)"
unexpected="$(git -C "$EX" status --porcelain --untracked-files=no | while IFS= read -r line; do
    grep -qxF "${line:3}" <<< "$expected" || echo "$line"
done)"
if [ -n "$unexpected" ]; then
    echo "setup_sdk: warning: other local changes in $EX:" >&2
    echo "$unexpected" >&2
fi

# the BridgeHost target: a symlink to host/ (the SDK's CMake helpers want sources under its own
# tree) and one include line at the end of the SDK's CMakeLists.txt
if [ -e "$EX/BridgeHost" ] && [ ! -L "$EX/BridgeHost" ]; then
    die "$EX/BridgeHost exists and is not a symlink"
fi
ln -sfn "$ROOT/host" "$EX/BridgeHost"
HOOK='include("${CMAKE_CURRENT_SOURCE_DIR}/BridgeHost/app/BridgeHost.cmake")'
if ! grep -qF "$HOOK" "$EX/CMakeLists.txt"; then
    printf '\n# BridgeHost hook (tools/setup_sdk.sh)\n%s\n' "$HOOK" >> "$EX/CMakeLists.txt"
fi

echo "SDK ready: $EX"
