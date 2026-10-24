# Lizenzen und Quellcode (ARA2 Bridge 4 Live)

ARA2 Bridge 4 Live besteht aus einem Max-for-Live-Gerät (`device/`) und dem Hilfsprogramm `BridgeHost`. Das Paket enthält **weder Melodyne noch VocAlign** und keine Lizenzen dafür; beides sind Produkte von Celemony beziehungsweise Synchro Arts und müssen separat und rechtmäßig lizenziert sein. Die Programme von ARA2 Bridge 4 Live umgehen keine Lizenzprüfung.

## Bestandteile von BridgeHost

| Bestandteil | Lizenz | Quelle |
|---|---|---|
| ARA SDK / ARA Library / ARA Examples (Celemony Software GmbH), Commits `a2b1aac1d1d5c4eed387db85a9c0cdb7d460254c` und `abd7c8aa5854591995e1fbf16f854c65b0998e8d` | Apache License 2.0 | https://github.com/Celemony/ARA_SDK |
| cpp-base64 (René Nyffenegger) | zlib | in den ARA Examples enthalten |
| ICST_AudioFile (Celemony) | BSD 2-Clause | in den ARA Examples enthalten |
| pugixml | MIT | in den ARA Examples enthalten |
| Steinberg VST3 SDK, Version 3.7.11 | Doppellizenz: proprietäre Steinberg-VST3-Lizenz **oder GPLv3** | https://github.com/steinbergmedia/vst3sdk |
| Eigener Code (Host, Gerät, Patch für die ARA Examples) | siehe unten | `source/` |

## GPLv3 und Weitergabe

BridgeHost enthält Code des Steinberg VST3 SDK, der hier unter der Option **GNU General Public License Version 3** genutzt wird (https://www.gnu.org/licenses/gpl-3.0.html). Deshalb wird BridgeHost zusammen mit dem vollständigen entsprechenden Quellcode weitergegeben: Das Archiv `source/arabridge-source.tar.gz` enthält den eigenen Code, den Patch für die ARA Examples (`host/patches/ara-examples-bridgehost.patch`) und die Skripte, die das SDK in genau den verwendeten Versionen herunterladen (`tools/setup_sdk.sh`) und BridgeHost bauen (`tools/build_host.sh`). Das Paket ist nur zum Testen im privaten Kreis gedacht. Wer es weiterverteilt, muss die GPLv3-Bedingungen einhalten (insbesondere den Quellcode mitgeben und Empfängern dieselben Rechte einräumen).

Der eigene Code (Host, Gerät, Max-Patch, JavaScript, Skripte) steht unter der **GNU General Public License Version 3** (Copyright (C) 2026 Enableton). Der Lizenztext ist im Quellarchiv als `LICENSE`, die Texte der Drittanbieter-Bestandteile sind in `docs/licenses/`.

## Marken

Ableton, Live und Max for Live sind Marken der Ableton AG und der Cycling '74. Melodyne und ARA sind Marken der Celemony Software GmbH. VocAlign ist eine Marke von Synchro Arts. ARA2 Bridge 4 Live steht in keiner Verbindung zu diesen Firmen und wird von ihnen weder unterstützt noch geprüft.
