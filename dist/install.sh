#!/usr/bin/env bash
# ARA Bridge installieren. Aufruf im entpackten Ordner:   bash install.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHARED="/Users/Shared/ARABridge"
SUPPORT="$HOME/Library/Application Support/ARABridge"
HOST_DEST="$SUPPORT/bin/BridgeHost"
USER_LIB="$HOME/Music/Ableton/User Library"
DEVICE_DIR="$USER_LIB/Presets/Audio Effects/Max Audio Effect"

die() { echo "FEHLER: $*" >&2; exit 1; }

[ -n "${HOME:-}" ] || die "HOME ist nicht gesetzt."
[ "$(uname -s)" = "Darwin" ] || die "Dieses Paket läuft nur auf dem Mac."
[ "$(uname -m)" = "arm64" ] || die "Dieses Paket braucht einen Mac mit Apple-Silicon-Chip (M1 oder neuer)."
for f in BridgeHost device/ARABridge.amxd device/bridge.js device/runner.js; do
    [ -f "$HERE/$f" ] || die "Im Paket fehlt $f. Bitte das ZIP neu entpacken."
done

echo "1/4  Geräte-Dateien nach $SHARED/device"
mkdir -p "$SHARED/device" || die "Konnte $SHARED nicht anlegen."
for f in ARABridge.amxd bridge.js runner.js; do
    cp "$HERE/device/$f" "$SHARED/device/$f" || die "Konnte $f nicht nach $SHARED/device kopieren (Rechte?)."
done
chmod -R a+rX "$SHARED" 2>/dev/null || true
xattr -dr com.apple.quarantine "$SHARED" 2>/dev/null || true

echo "2/4  Programm BridgeHost nach $HOST_DEST"
mkdir -p "$SUPPORT/bin"
if [ -e "$HOST_DEST" ]; then
    pids="$(lsof -t -- "$HOST_DEST" 2>/dev/null | sort -u | tr '\n' ' ' || true)"
    [ -z "$pids" ] || die "BridgeHost läuft gerade (Prozess ${pids% }). Bitte das Melodyne-/VocAlign-Fenster schließen und noch einmal starten."
fi
tmp="$HOST_DEST.install.$$"
trap 'rm -f "$tmp"' EXIT
cp "$HERE/BridgeHost" "$tmp"
chmod 755 "$tmp"
xattr -dr com.apple.quarantine "$tmp" 2>/dev/null || true
mv -f "$tmp" "$HOST_DEST"
trap - EXIT
"$HOST_DEST" --version >/dev/null 2>&1 || die "BridgeHost startet nicht. Läuft das Paket auf einem Mac mit Apple-Silicon und macOS 12 oder neuer?"
echo "     $("$HOST_DEST" --version)"

echo "3/4  Plug-ins suchen"
"$HOST_DEST" --find-plugins 2>&1 | sed 's/^/     /'
echo "     (\"found\": true = gefunden. Es werden VST3-Plug-ins in /Library/Audio/Plug-Ins/VST3 gesucht.)"

echo "4/4  Gerät in die Ableton-Benutzerbibliothek legen"
if [ -d "$USER_LIB" ]; then
    mkdir -p "$DEVICE_DIR"
    cp "$HERE/device/ARABridge.amxd" "$DEVICE_DIR/ARABridge.amxd"
    echo "     $DEVICE_DIR/ARABridge.amxd"
else
    echo "     Keine Benutzerbibliothek unter $USER_LIB gefunden."
    echo "     Ziehe $SHARED/device/ARABridge.amxd direkt auf eine Audiospur in Live."
fi

echo
echo "Fertig. Live neu starten (oder den Browser aktualisieren) und ARABridge auf eine Audiospur ziehen."
