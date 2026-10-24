#!/usr/bin/env bash
# Installs the built BridgeHost (tools/build_host.sh) where the M4L device launches it:
#   ~/Library/Application Support/ARABridge/bin/BridgeHost
# Creates the folder, refuses to replace a copy that is running, and prints the installed path.
# Safe to run repeatedly (an identical copy is left alone). ARABRIDGE_THIRD_PARTY selects the SDK folder,
# as for build_host.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TP="${ARABRIDGE_THIRD_PARTY:-$ROOT/third_party}"
SRC="$TP/ARA_SDK/ARA_Examples/build/bin/Release/BridgeHost"
DEST_DIR="$HOME/Library/Application Support/ARABridge/bin"
DEST="$DEST_DIR/BridgeHost"

die() { echo "install_host: $*" >&2; exit 1; }

[ -n "${HOME:-}" ] || die "HOME is not set"
[ -f "$SRC" ] && [ -x "$SRC" ] || die "no built BridgeHost at $SRC; run tools/build_host.sh first"
"$SRC" --version >/dev/null 2>&1 || die "$SRC does not run (--version failed)"

mkdir -p "$DEST_DIR"

if [ -f "$DEST" ] && cmp -s "$SRC" "$DEST"; then
    echo "install_host: up to date ($("$DEST" --version))" >&2
    echo "$DEST"
    exit 0
fi

# a running copy (lsof sees the mapped executable however it was launched)
if [ -e "$DEST" ]; then
    pids="$(lsof -t -- "$DEST" 2>/dev/null | sort -u | tr '\n' ' ' || true)"
    [ -z "$pids" ] || die "$DEST is running (pid ${pids% }); quit it first"
fi

# never write into an existing executable (macOS caches code signatures per file): copy next to it and rename
tmp="$DEST.install.$$"
trap 'rm -f "$tmp"' EXIT
cp "$SRC" "$tmp"
chmod 755 "$tmp"
mv -f "$tmp" "$DEST"
trap - EXIT

echo "install_host: installed $("$DEST" --version)" >&2
echo "$DEST"
