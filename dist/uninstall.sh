#!/usr/bin/env bash
# ARA Bridge entfernen. Aufruf:   bash uninstall.sh
# Löscht die Programmdateien und das Gerät. Die Arbeitsdaten (Aufträge, Ergebnisse, Protokolle) bleiben stehen,
# solange Du nicht   bash uninstall.sh --alles   angibst.
set -euo pipefail

SUPPORT="$HOME/Library/Application Support/ARABridge"
HOST="$SUPPORT/bin/BridgeHost"
if [ -e "$HOST" ]; then
    pids="$(lsof -t -- "$HOST" 2>/dev/null | sort -u | tr '\n' ' ' || true)"
    [ -z "$pids" ] || { echo "FEHLER: BridgeHost läuft (Prozess ${pids% }). Bitte zuerst das Fenster schließen." >&2; exit 1; }
fi
rm -rf "/Users/Shared/ARABridge/device"
rmdir "/Users/Shared/ARABridge" 2>/dev/null || true
rm -f "$HOME/Music/Ableton/User Library/Presets/Audio Effects/Max Audio Effect/ARABridge.amxd"
rm -f "$HOST"
rmdir "$SUPPORT/bin" 2>/dev/null || true
if [ "${1:-}" = "--alles" ]; then
    rm -rf "$SUPPORT"
    echo "Alles entfernt, auch $SUPPORT."
else
    echo "Entfernt. Arbeitsdaten bleiben in $SUPPORT (mit 'bash uninstall.sh --alles' löschen)."
fi
