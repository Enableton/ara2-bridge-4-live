# ARA2 Bridge 4 Live – v0.2.1

Mit diesem Max-for-Live-Gerät schickst Du einen Audio-Clip aus der **Arrangement-Ansicht** von Ableton Live an **Melodyne** oder **VocAlign**, bearbeitest ihn dort in einem eigenen Fenster (mit Wiedergabe) und bekommst das Ergebnis mit **Apply** zurück in Dein Projekt. Live selbst unterstützt ARA2 nicht; ein kleines Hilfsprogramm („BridgeHost“) übernimmt das Hosten der Plug-ins.

Das ist eine frühe Version (v0.2.1). Bitte Fehler und Auffälligkeiten als GitHub-Issue melden (siehe ganz unten, „Probleme melden“).

## Was Du brauchst

| | |
|---|---|
| Mac | **Apple Silicon** (M1 oder neuer). Intel-Macs gehen nicht. Das Programm ist für macOS 12 oder neuer gebaut, bisher aber nur unter der neuesten macOS-Version getestet. |
| Ableton Live | **Live 12** mit **Max for Live** (Suite, oder Standard plus Max for Live). Getestet mit Live 12.4.6. |
| Melodyne | **Melodyne 5** in einer Ausführung mit ARA-Unterstützung (zum Beispiel editor oder studio), als **VST3** installiert. |
| VocAlign | **VocAlign 6 Pro**, als **VST3** installiert (optional, wenn Du nur Melodyne brauchst). |

Die Plug-ins und ihre Lizenzen bringst Du selbst mit. In diesem Paket sind **keine** Plug-ins und keine Lizenzen enthalten, und das Gerät umgeht keine Lizenzprüfung. Die VST3-Dateien liegen normalerweise in `/Library/Audio/Plug-Ins/VST3` (zum Beispiel `Melodyne.vst3`, `VocAlign6Pro.vst3`).

## Installation

1. ZIP-Datei entpacken (Doppelklick). Es entsteht der Ordner `ARA2-Bridge-4-Live`.
2. **Terminal** öffnen (Spotlight: „Terminal“).
3. Im Terminal `bash ` eingeben (mit Leerzeichen am Ende), dann die Datei **`install.sh`** aus dem Ordner ins Terminal-Fenster ziehen und Enter drücken. Das sieht dann ungefähr so aus:

   ```
   bash /Users/DEINNAME/Downloads/ARA2-Bridge-4-Live/install.sh
   ```

4. Das Skript macht vier Schritte und schreibt sie mit. Am Ende steht „Fertig.“ Wichtig ist die Zeile bei „Plug-ins suchen“: Dort muss bei den Plug-ins, die Du nutzen willst, `"found": true` stehen. Wenn dort `false` steht, ist das Plug-in nicht als VST3 an der üblichen Stelle installiert (siehe „Probleme“).
5. **Live starten** (war Live schon offen: beenden und neu starten).
6. Im Live-Browser links unter **Benutzerbibliothek** (User Library) → **Audio Effects** → **Max Audio Effect** liegt **ARABridge**. Auf eine **Audiospur** ziehen, und zwar auf die Spur, auf der der Clip liegt.
7. Nach wenigen Sekunden steht im Gerät **„Ready.“** und eine Liste der gefundenen Plug-ins. Steht dort „Starting…“ länger als eine halbe Minute, siehe „Probleme“.

Beim Installieren wird nichts an macOS-Einstellungen geändert. Es werden nur diese Dateien angelegt:

- `/Users/Shared/ARABridge/device/` – die drei Gerätedateien (der Pfad ist fest eingebaut, bitte nicht verschieben)
- `~/Library/Application Support/ARABridge/bin/BridgeHost` – das Hilfsprogramm
- `~/Music/Ableton/User Library/Presets/Audio Effects/Max Audio Effect/ARABridge.amxd` – das Gerät in der Live-Bibliothek

Wieder entfernen: im Terminal `bash` und dann `uninstall.sh` aus dem Ordner (wie oben). Mit angehängtem `--alles` werden auch Aufträge und Ergebnisse gelöscht.

Falls macOS beim ersten Start von BridgeHost meldet, es könne nicht geöffnet werden: Das Installationsskript entfernt die Download-Markierung bereits. Hilft das nicht, Terminal öffnen und

```
xattr -dr com.apple.quarantine "$HOME/Library/Application Support/ARABridge/bin/BridgeHost" /Users/Shared/ARABridge
```

ausführen.

## Benutzung

Das Gerät arbeitet mit einem **Audio-Clip im Arrangement** (nicht in der Session-Ansicht). Der Clip muss auf der Hauptspur liegen (nicht in einer Take-Lane), **Warp muss aus sein**, er darf nicht geloopt oder transponiert sein, und die Spur darf nicht eingefroren sein. Gain wird übernommen. Verstößt der Clip dagegen, steht im Gerät, was zu ändern ist, und es wird nichts verändert.

### Placement: wohin das Ergebnis kommt

- **Take lane** – das Ergebnis liegt als neue Take-Lane unter dem Original (Original bleibt unverändert).
- **New track** – das Ergebnis kommt auf eine neue Spur.
- **Replace in place** – das Ergebnis ersetzt den Clip; das Original bleibt auf einer stummgeschalteten Sicherungsspur.

Alles lässt sich mit Rückgängig (Cmd+Z) zurücknehmen.

### Melodyne

1. Clip im Arrangement anklicken, **Send to Melodyne** drücken.
2. Das Melodyne-Fenster öffnet sich vorne. Mit der **Leertaste** spielst Du ab. Hörst Du nichts, wähle im Fenster im Menü **Output** Deine Audio-Schnittstelle.
3. Bearbeiten wie gewohnt, dann im Fenster **Apply to Live** drücken. Das Fenster schließt sich, das Ergebnis erscheint im Arrangement. Mit **Cancel** brichst Du ab.

**Preview** und **Sync transport** sind bei einem neuen Gerät eingeschaltet:

- **Sync transport:** Play, Stop und die Abspielposition in Live bewegen den Cursor im Melodyne-Fenster, und Play, Leertaste, Stop oder ein Klick ins Lineal in Melodyne starten, stoppen oder verschieben Live. Melodynes eigene Wiedergabe ist stumm, Du hörst Live. Nur bei gleichbleibendem Tempo.
- **Preview:** Nach jeder Änderung spielen zwei Hilfsspuren („Preview A“ und „Preview B“) die neue Fassung im Takt Deines Projekts. Der Original-Clip ist währenddessen stumm und wird bei Apply oder Cancel wieder eingeschaltet; die Hilfsspuren verschwinden dann. Beim Bearbeiten sammeln sich Rückgängig-Schritte.

Der Schalter **Skip timing fix** (Zeitkorrektur) ist normalerweise aus. Melodyne verschiebt den Rest des Clips nach einer Bearbeitung um Bruchteile von Millisekunden; das Gerät gleicht das aus. Wenn das Ergebnis trotzdem knistert oder anders klingt als im Melodyne-Fenster, schalte den Schalter ein und wiederhole den Vorgang, und melde es.

### VocAlign

VocAlign braucht zwei Clips: den **Guide** (Vorbild, zum Beispiel die Lead-Stimme) und den **Dub** (der Clip, der angepasst wird, zum Beispiel ein Backing).

1. Das Gerät auf die **Guide-Spur und auf die Dub-Spur** legen (Live zeigt immer nur die Geräte der gerade gewählten Spur).
2. Guide-Clip auswählen, im Gerät auf der Guide-Spur **Set guide (VocAlign)** drücken.
3. Dub-Clip auswählen, im Gerät auf der Dub-Spur **Send to VocAlign** drücken.
4. Im VocAlign-Fenster anpassen und **Apply to Live** drücken.

Das Ergebnis beginnt **genau am Anfang des Guide-Clips**, so dass die Spuren zusammen starten. Ragt der Dub vor den Guide, wird dieser Teil weggelassen (das steht im Status).

## Grenzen

- Einen Auftrag nach dem anderen pro Gerät. Während einer läuft, wird ein zweiter abgelehnt.
- Quelldateien als **WAV oder AIFF** sind am genauesten. MP3 und M4A können um einige Millisekunden versetzt zurückkommen.
- Wenn Du in Live Clip, Spur oder Tempo veränderst, während das Plug-in-Fenster offen ist, wird das Ergebnis nicht eingesetzt und die Statuszeile sagt warum. Das Projekt bleibt dann unverändert.
- Leere Take-Lanes nach einem abgebrochenen Vorgang kann Live nicht automatisch entfernen; lösche sie von Hand.
- Kurze Clips unter etwa 0,8 Sekunden werden von der automatischen Zeitkorrektur nicht erfasst (Melodyne-Ergebnis bleibt dann so, wie Melodyne es liefert).

## Probleme

- **Im Gerät steht „BridgeHost is not installed“:** Installation wiederholen, dann im Gerät **Refresh plug-ins** drücken.
- **Plug-in „found: false“:** Das Plug-in muss als **VST3** in `/Library/Audio/Plug-Ins/VST3` (oder im selben Ordner unter Deinem Benutzer) liegen. Liegt es woanders, lege in `~/Library/Application Support/ARABridge/settings.json` fest, wo es ist, zum Beispiel:

  ```
  {"pluginPaths": {"melodyne": "/Pfad/zu/Melodyne.vst3", "vocalign": "/Pfad/zu/VocAlign6Pro.vst3"}}
  ```

  Danach **Refresh plug-ins**. Sind mehrere Versionen eines Plug-ins installiert, nimmt das Gerät die mit der höchsten Versionsnummer.
- **Das Gerät bleibt bei „Starting…“:** Gerät von der Spur löschen und neu hinzufügen. Hilft das nicht, Live neu starten.
- **Kein Ton im Plug-in-Fenster:** Im Fenster im Menü **Output** die eigene Schnittstelle wählen.
- **Das Plug-in meldet ein Lizenz- oder Autorisierungsproblem:** Das ist eine Frage an Melodyne/VocAlign, nicht an diese Software. Melodyne und VocAlign müssen auf Deinem Rechner ganz normal lizenziert und aktiviert sein.

Protokolle (bitte bei Fehlern mitschicken):

- `~/Library/Application Support/ARABridge/device.log`
- `~/Library/Application Support/ARABridge/jobs/<neuester Ordner>/host.log` und `result.json`

Im Finder: Menü **Gehe zu → Gehe zum Ordner…**, dann `~/Library/Application Support/ARABridge` einfügen.

## Probleme melden

Eröffne ein Issue auf der Projektseite (https://github.com/Enableton/ara2-bridge-4-live/issues) und schreibe dazu:

1. Ob die Installation geklappt hat (wenn nicht: die Ausgabe von `install.sh`).
2. Mac-Modell, macOS-Version, Live-Version, Melodyne-/VocAlign-Version.
3. Was Du gemacht hast (Melodyne oder VocAlign, welcher Placement-Modus) und was passiert ist, zum Beispiel Knistern oder falsche Länge.
4. Bei VocAlign: ob das Ergebnis am Guide-Anfang beginnt.
5. Bei Fehlern: Text der Statuszeile und die Protokolle von oben.

## Lizenzen und Quellcode

Siehe `LICENSES.md`. Der Quellcode liegt unter `source/`.
