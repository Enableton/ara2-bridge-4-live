# ARA2 Bridge 4 Live – v0.2.1

This Max for Live device sends an audio clip from Ableton Live's **Arrangement View** to **Melodyne** or **VocAlign**, lets you edit it there in its own window (with playback), and puts the result back into your project when you press **Apply**. Live does not support ARA2 itself; a small helper program ("BridgeHost") hosts the plug-ins.

This is an early version (v0.2.1). Please report errors and oddities as a GitHub issue (see "Reporting problems" at the bottom).

## What you need

| | |
|---|---|
| Mac | **Apple Silicon** (M1 or newer). Intel Macs do not work. The program is built for macOS 12 or newer, but has so far only been tested on the latest macOS. |
| Ableton Live | **Live 12** with **Max for Live** (Suite, or Standard plus Max for Live). Tested with Live 12.4.6. |
| Melodyne | **Melodyne 5** in an edition with ARA support (for example editor or studio), installed as **VST3**. |
| VocAlign | **VocAlign 6 Pro** (or newer), installed as **VST3** (optional if you only need Melodyne). |

You bring the plug-ins and their licenses yourself. This package contains **no** plug-ins and no licenses, and the device does not bypass any license check. The VST3 files are normally in `/Library/Audio/Plug-Ins/VST3` (for example `Melodyne.vst3`, `VocAlign6Pro.vst3`).

## Installation

1. Unzip the ZIP file (double-click). This creates the folder `ARA2-Bridge-4-Live`.
2. Open **Terminal** (Spotlight: "Terminal").
3. Type `bash ` in Terminal (with a space at the end), then drag the file **`install.sh`** from the folder into the Terminal window and press Enter. It looks roughly like this:

   ```
   bash /Users/YOURNAME/Downloads/ARA2-Bridge-4-Live/install.sh
   ```

4. The script runs four steps and prints them. At the end it says "Fertig." (German for "Done."). The important line is the one under "Plug-ins suchen" (searching for plug-ins): for each plug-in you want to use it must say `"found": true`. If it says `false`, the plug-in is not installed as VST3 in the usual place (see "Problems").
5. **Start Live** (if Live was already open: quit and restart it).
6. In Live's browser on the left, under **User Library** → **Audio Effects** → **Max Audio Effect**, you will find **ARABridge**. Drag it onto an **audio track**, namely the track that holds the clip.
7. After a few seconds the device shows **"Ready."** and a list of the plug-ins found. If it keeps saying "Starting…" for more than half a minute, see "Problems".

The installation does not change any macOS settings. It only creates these files:

- `/Users/Shared/ARABridge/device/` – the three device files (the path is built in, please do not move it)
- `~/Library/Application Support/ARABridge/bin/BridgeHost` – the helper program
- `~/Music/Ableton/User Library/Presets/Audio Effects/Max Audio Effect/ARABridge.amxd` – the device in Live's library

To remove everything: in Terminal type `bash ` and drag `uninstall.sh` from the folder into the window (as above). With `--alles` appended, jobs and results are deleted as well. (The scripts print their messages in German.)

If macOS says it cannot open BridgeHost the first time it starts: the install script already removes the download quarantine mark. If that does not help, open Terminal and run

```
xattr -dr com.apple.quarantine "$HOME/Library/Application Support/ARABridge/bin/BridgeHost" /Users/Shared/ARABridge
```

## Usage

The device works with an **audio clip in the Arrangement** (not in Session View). The clip must be on the main lane (not in a take lane), **warp must be off**, it must not be looped or transposed, and the track must not be frozen. Gain is carried over. If the clip violates one of these, the device says what to change and does not alter anything.

### Placement: where the result goes

- **Take lane** – the result becomes a new take lane under the original (the original stays unchanged).
- **New track** – the result goes onto a new track.
- **Replace in place** – the result replaces the clip; the original stays on a muted backup track.

Everything can be undone with Undo (Cmd+Z).

### Melodyne

1. Click the clip in the Arrangement and press **Send to Melodyne**.
2. The Melodyne window opens in front. Press the **space bar** to play. If you hear nothing, choose your audio interface in the window's **Output** menu.
3. Edit as usual, then press **Apply to Live** in the window. The window closes and the result appears in the Arrangement. **Cancel** aborts.

**Preview** and **Sync transport** are on in a new device:

- **Sync transport:** Play, Stop and the playhead in Live move the cursor in Melodyne's window, and Play, Space, Stop or a click in Melodyne's time ruler start, stop or move Live. Melodyne's own playback is silent, you hear Live. Constant tempo only.
- **Preview:** after each edit, two helper tracks ("Preview A" and "Preview B") play the new version in sync with the rest of your project. The original clip is muted meanwhile and unmuted when you apply or cancel; the helper tracks disappear then. Undo steps pile up while you edit.

The **Skip timing fix** switch (timing correction) is normally off. After an edit Melodyne shifts the rest of the clip by fractions of a millisecond; the device compensates for that. If the result still crackles or sounds different from the Melodyne window, switch it on, repeat the process, and report it.

### VocAlign

VocAlign needs two clips: the **guide** (the model, for example the lead vocal) and the **dub** (the clip that gets adjusted, for example a backing vocal).

1. Put the device on the **guide track and on the dub track** (Live only shows the devices of the currently selected track).
2. Select the guide clip and press **Set guide (VocAlign)** in the device on the guide track.
3. Select the dub clip and press **Send to VocAlign** in the device on the dub track.
4. Adjust in the VocAlign window and press **Apply to Live**.

The result starts **exactly at the start of the guide clip**, so the tracks start together. If the dub starts before the guide, that part is left out (the status says so).

## Limits

- One job at a time per device. While one is running, a second one is refused.
- Source files as **WAV or AIFF** are the most accurate. MP3 and M4A can come back offset by a few milliseconds.
- If you change the clip, the track or the tempo in Live while the plug-in window is open, the result is not inserted and the status line says why. The project stays unchanged.
- Empty take lanes left after an aborted operation cannot be removed automatically by Live; delete them by hand.
- Clips shorter than about 0.8 seconds are not covered by the automatic timing correction (the Melodyne result then stays exactly as Melodyne delivers it).

## Problems

- **The device says "BridgeHost is not installed":** run the installation again, then press **Refresh plug-ins** in the device.
- **Plug-in "found: false":** the plug-in must be installed as **VST3** in `/Library/Audio/Plug-Ins/VST3` (or the same folder under your user). If it is somewhere else, set its location in `~/Library/Application Support/ARABridge/settings.json`, for example:

  ```
  {"pluginPaths": {"melodyne": "/path/to/Melodyne.vst3", "vocalign": "/path/to/VocAlign6Pro.vst3"}}
  ```

  Then press **Refresh plug-ins**. If several versions of a plug-in are installed, the device uses the one with the highest version number.
- **The device stays at "Starting…":** delete the device from the track and add it again. If that does not help, restart Live.
- **No sound in the plug-in window:** choose your interface in the window's **Output** menu.
- **The plug-in reports a license or authorization problem:** that is a question for Melodyne/VocAlign, not for this software. Melodyne and VocAlign must be licensed and activated on your computer in the normal way.

Logs (please send them along with error reports):

- `~/Library/Application Support/ARABridge/device.log`
- `~/Library/Application Support/ARABridge/jobs/<newest folder>/host.log` and `result.json`

In Finder: menu **Go → Go to Folder…**, then paste `~/Library/Application Support/ARABridge`.

## Reporting problems

Open an issue on the project page (https://github.com/Enableton/ara2-bridge-4-live/issues) and include:

1. Whether the installation worked (if not, the output of `install.sh`).
2. Mac model, macOS version, Live version, Melodyne / VocAlign version.
3. What you did (Melodyne or VocAlign, which placement mode) and what happened, for example a crackle or a wrong length.
4. For VocAlign: whether the result starts at the guide's start.
5. For errors: the text of the status line and the logs from above.

## Licenses and source code

See `LICENSES.md`. The source code is in `source/`.
