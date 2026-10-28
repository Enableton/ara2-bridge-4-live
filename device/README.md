# ARA2 Bridge 4 Live – M4L device

Max for Live device that sends a selected Arrangement clip to BridgeHost (Melodyne or VocAlign) and puts the result
back into Live. Plan: `docs/superpowers/plans/2026-10-23-m4l-device-implementation.md`. Host contract:
`docs/superpowers/specs/2026-10-23-host-device-contract.md`.

**The .amxd loads generated code.** `device/build/` is git-ignored, but `ARABridge.amxd` loads
`<repo>/device/build/bridge.js` (core.js + bridge.js) by absolute path. After EVERY checkout, pull or branch switch that
touches `device/src/`, run `python3 device/build.py` (or `python3 device/make_amxd.py`, which runs it) and re-open the
device in Live (remove it and add it again). In a fresh clone or worktree the `.amxd`'s absolute paths point at the
old folder: run `python3 device/make_amxd.py` there first.

## Layout

| Path | What |
|---|---|
| `src/core.js` | Pure ES5 logic (clip validation and region math, `job.json`, result interpretation, placement plans, unique file names). Runs in Max's classic `js` and in node. |
| `tests/test_core.js` | Tests for `core.js`: `node device/tests/test_core.js` (exit code 1 on failure). Includes an ES5 scan. |
| `tests/fixtures/` | Raw LiveAPI values of three real clips measured in Live 12.4.6 (trimmed unwarped, warped, untouched unwarped). |
| `src/bridge.js` | Max classic `js` side (ES5): reads the selected clip through LiveAPI, validates it, sends the job to the runner, copies the result through the runner and executes the placement plan with verification and rollback. Message forms in its header. |
| `ui/ara2bridge_ui.html` | The device's face: ONE self-contained HTML page (no remote assets, system fonts) shown in a `jweb` object of 800 x 169 px. It keeps no saved state (the `live.*` objects do) and talks to the patch with `window.max.outlet` / `bindInlet`: out `ui_action <name>`, `ui_set <placement\|skip\|preview\|sync> <value>`, `ui_loaded`; in `ui_state ...` and `ui_status <text>` (header of the file). Without Max it runs in a demo mode that answers itself: open the file in a browser to see it. |
| `tests/test_ui.js` | `node device/tests/test_ui.js`: no remote URLs; every control sends exactly its own message; values from Max change the page and are never sent back; fills the jweb. The behavioural part needs Chrome (skipped otherwise). |
| `src/runner.js` | Node for Max side: job folders, BridgeHost launch and supervision, `--find-plugins`, result copy. |
| `build.py` | `python3 device/build.py` concatenates `src/core.js` + `src/bridge.js` into `build/bridge.js` (Max's `js` has no module loader), then runs the ES5 scan and `node --check`. `build/` is generated and git-ignored; the `.amxd` refers to `build/bridge.js` by absolute path, so `make_amxd.py` runs `build.py` first. |
| `tests/test_bridge.js` | `node device/tests/test_bridge.js [--skip-real]`: builds, then runs the built file against a fake Live (measured LOM quirks, delayed visibility, fault injection), a fake runner, and once end to end through the real runner and the real BridgeHost `--autorender`. |
| `tests/test_runner.js` | `node device/tests/test_runner.js [--skip-real]`. |
| `make_amxd.py` | `python3 device/make_amxd.py [out.amxd]` runs `build.py`, then writes `ARABridge.amxd` (committed). The `js` and `node.script` boxes use ABSOLUTE paths to `device/build/bridge.js` and `device/src/runner.js`, resolved from the script's own location. Deterministic: two runs give identical bytes. Re-run it (and commit) after any change to the patch, and if the repo folder is moved. In another checkout (worktree, fresh clone) just run `python3 device/make_amxd.py` there: the paths come from the script's own location, no option needed. |
| `ARABridge.amxd` | The Max for Live Audio Effect (audio passes through unchanged). |
| `tests/test_amxd_container.py` | `python3 -I device/tests/test_amxd_container.py`: parses the `.amxd` bytes independently of the builder, checks ports, parameters, presentation rectangles, simulates the message flow of every button/setting/node message, and fails if the committed `.amxd` differs from a fresh build. In a checkout at another path than the one the committed `.amxd` was built for, the two path-dependent tests (committed file current, scripts exist) are skipped with `rebuild with python3 device/make_amxd.py`; after rebuilding there they run strictly. |

## Install and load

1. Build the host once: `tools/build_host.sh`, then **`tools/install_host.sh`** (you run this; it copies BridgeHost to
   `~/Library/Application Support/ARABridge/bin/BridgeHost`). The device also works when you start it first: it
   says "BridgeHost is not installed. Run tools/install_host.sh, then press Refresh." and **Refresh plug-ins** re-checks.
2. `python3 device/make_amxd.py`: it runs `build.py` (writes the git-ignored `device/build/bridge.js` the device loads)
   and rewrites `device/ARABridge.amxd` with this folder's absolute paths. Run it in every fresh clone or worktree, and
   run at least `python3 device/build.py` after every checkout, pull or branch switch that touches `device/src/`; then
   remove and re-add the device in Live. Do not move or rename the repo folder (or re-run `make_amxd.py` if you do).
3. In Live drag `device/ARABridge.amxd` from Finder onto an **audio track** (it is an Audio Effect; audio passes
   through unchanged). Use the track that holds the clip. The device is 800 px wide and 169 px high (the maximum height of a device in Live); its whole face is one HTML page.
4. Within a few seconds the status line says `Ready. <plug-in report>`. If it keeps saying "Starting..." or "Waiting for
   it...", the Node script did not start: remove the device and add it again, and look at Live's Max console
   (Options > Max Window Console... or Max's Console) for lines starting `ARABridge:`.

## The device

The page shows the status as two lines at the bottom (Max's console and `device.log` have the full text), the plug-in check as two chips (Melodyne / VocAlign: checking, found, not found, no host), a blinking LED plus a sweeping bar while a job runs, and a red **Cancel** while a job can be cancelled. Buttons are dimmed while busy, never disabled.

| Control | Does |
|---|---|
| **Placement** menu (Take lane / New track / Replace in place) | Where the result goes. Sent to the device as `settings placement <0\|1\|2>`. Saved with the set. |
| **Send to Melodyne** | Sends the selected Arrangement clip to Melodyne in the host window. |
| **Set guide (VocAlign)** / **Send to VocAlign** | VocAlign: select the guide clip and press Set guide; select the dub clip and press Send to VocAlign. Live's Device View shows only the selected track's devices, so **put the device on the guide track and on the dub track**: the guide is shared between all ARA Bridge devices through `~/Library/Application Support/ARABridge/guide.json` (the newest Set guide wins; the file is only ever overwritten). **The result clip starts exactly at the guide clip's start** (all placement modes, on the dub's side): it runs to the later of the guide's and the dub's end, with silence where the dub has no audio; a dub part before the guide's start is left out (the status says how much). |
| **Skip realign** toggle, label "Skip timing correction" (Melodyne only, default off) | Inverted on purpose so that realign is ON by default whatever Live restores for a fresh device: the patch sends `settings realign <1 - toggle>`. Switch it on to send `settings realign 0`. |
| **Live preview** toggle, label "Preview" (Melodyne, on for a new device) | Sent as `settings preview <0\|1>` and written into the next Melodyne job as `"preview": true`. With it on, the host renders the clip again after every edit (0.12 s after the last change) and the device plays the result from **two Preview tracks, A and B, that take turns** right below the source track: the new clip is put onto the silent one (Live has time to load it, `ram_mode` is set if Live has it), then the tracks swap their mute state and the old clip is removed, so the edit is heard without a gap. Live plays the clip itself, so it is in sync with all other tracks. The preview skips the timing correction (it would take seconds on a long clip for a shift of well under a millisecond); the result you apply still has it. **The source clip is muted while a preview plays** (only that clip, not its track, so other clips on the track keep playing; a clip you had muted yourself is left alone) and unmuted again when you press Apply (before the result is placed), Cancel, or the job ends any other way. Undo steps pile up while you edit. A failed preview never removes the audible one; a deleted Preview track is made again. If Live refuses a step, the status says "No preview: ..." and the job goes on. `device.log` has the time each preview took from the host's publish to the swap. |
| **Sync transport** toggle, label "Sync transport" (Melodyne, on for a new device) | Sent as `settings sync <0\|1>` and written into the next Melodyne job as `"sync": true`. With it on, Live's transport and the host window stay together: Play, Stop and the playhead in Live move the cursor in Melodyne's window (its playback is silent; you hear Live), and Play, Space, Stop or a click in Melodyne's time ruler start, stop or move Live. Works best together with **Preview**: the Preview track is what plays the edit in Live. Constant tempo only (a tempo change pauses it with a note). The device reads Live's position every 40 ms (the Live API is not sample accurate, so expect the cursor to be within a few tens of milliseconds). |
| **Cancel** | Always clickable (red while there is a job to cancel); says `Nothing to cancel.` when idle. Cancelling is not possible while the result is being placed. |
| **Refresh plug-ins** | Re-runs the host's plug-in check (after installing the host or a plug-in). |
| Status line | Last message of the device (below). Nothing is disabled: while a job is busy a second Send is refused with a status message (enforced in bridge.js). |

On load (and when a saved set is opened) the device loads the page, bangs the Placement menu so its saved value is re-sent to the script; the Skip realign toggle is deliberately NOT banged (a bang flips a `live.toggle`), Live outputs its restored value itself and the script defaults to realign on. The patch sends `ready` to the script afterwards
before it says `ready`. The page may load after all of that: when its handlers are bound it sends `ui_loaded`, the patch sends `uiRefresh` to the script, and the script re-emits its settings, state and last status line to the page. If the page has not said `ui_loaded` 5 s after `readfile <abs path>`, the patch loads it once more with `url file://<abs path>` (nobody has tried yet whether a `jweb` in Live resolves the absolute `readfile` path).

## Reading the status

The status box shows the last status line; the Max console has the same lines prefixed with `ARABridge:`. The box
holds about four lines; longer texts are cut off in the box but complete in the console.

| Status | Meaning |
|---|---|
| `Starting...` / `Checking the host and plug-ins...` | The Node script is starting or the plug-in check runs. Sends are refused until `Ready.` |
| `Ready. ...` | The runner answered and BridgeHost lists the plug-ins found. |
| `BridgeHost is not installed. Run tools/install_host.sh, then press Refresh.` | Host binary missing (or `hostPath` in `~/Library/Application Support/ARABridge/settings.json` is wrong). |
| `Starting Melodyne...` / `Starting VocAlign...` | The job was validated and the host is launching; its window opens in front of Live. Edit, then Apply (or Cancel) in the host. |
| `Cancelling...` | Cancel was pressed or the host is being stopped. |
| `Copying the result...` / `Placing the result...` | The host finished; the file is copied and the clip is placed (do not touch the set). |
| `Done. The first 0.50 s of the dub lay before the guide and were left out.` | VocAlign: the dub started before the guide; the result starts at the guide. |
| `The dub clip ends before the guide clip starts. Move it so that it overlaps the guide.` | VocAlign: the result starts at the guide, so a dub that is over by then cannot be placed. |
| `... Note: placed at the dub, not the guide: update BridgeHost (tools/install_host.sh).` | The installed BridgeHost is older than this device: it laid the result out at the dub, so it was placed there. Run `tools/install_host.sh`. |
| `Not placed: ...`, `Could not build the job: ...`, other sentences | A refusal or failure with its reason (warped, looping or transposed clip, frozen track, no clip selected, a job already running, missing file ...). The set is unchanged unless the text says otherwise. |
| `The Node script stopped (...)` | Node for Max terminated or restarted; a running host keeps its result in its job folder under `~/Library/Application Support/ARABridge/jobs/`. |

Job folders hold `job.json`, `host.log` and `result.json`; results are copied to `~/Library/Application Support/ARABridge/results/`.

`~/Library/Application Support/ARABridge/device.log` (rotated to `device.log.1` above about 200 KB) has one line per
message the script received (button clicks, runner messages), per launch and per finish, so a job that started without a
click can be traced. A Send within 1.5 s of the end of a job or of the previous Send is ignored
(`Ignored a repeated Send click.`).

## Design notes (found in Live tests)

- No `active`/greying messages are sent to any `live.*` object after load: they made a button emit by itself and launched a
  second job. The Plug-in menu was removed because it could only grey buttons. The UI state outlet of the script
  (`busy`, `cancel`, ...) now goes to the HTML page only (`[prepend ui_state] -> jweb`), never to a `live.*` object, and
  the page only dims.
- The `live.menu` and the three `live.toggle` objects still exist (not presented): they own the saved values, so a set
  saved with an older (native UI) build keeps its placement and switches. The page sets them with an int (`ui_set`), and
  every output of theirs is tapped to the page (`ui_state setting <name> <value>`; `skip` is the raw toggle value), so a
  value restored by Live reaches the page too. The old hidden `live.text` buttons are gone: each page button is a
  `ui_action <name>` that [route] turns into a message box to the script (one click, one message; the page itself sends
  one message per click).
- `jweb` has ONE outlet: it carries the page's `max.outlet` messages AND onloadstart, onloadend, url and title. Only
  `ui_action`, `ui_set` and `ui_loaded` are routed on, everything else is dropped.
- No `color-mix()` and no remote fonts in the page: the Chromium in Live's `jweb` may be older than the one in a browser.

## Not verified outside Live

The container, ports, parameters, the jweb rectangle and the message flow (page to js, live objects, and back) are tested
without Live (`test_amxd_container.py`), the page's own behaviour in headless Chrome (`test_ui.js`). The following can
only be checked in Live: that Live accepts the file, that the `jweb` finds and renders the page (`readfile` with an
absolute path, or the `url` fallback), that clicks, the dropdown and the switches work in Live's `jweb`, the exact lifecycle messages of node.script's right outlet (`terminated`, `restarted`), that the saved
Placement and Skip realign values come back after reopening a set (the menu is re-output by the startup bang, the
toggle by Live itself), and `route` behaviour with long single-symbol payloads.

## What the placement checks (and what it does not)

- The source clip must still be where it was when the host opened (same track, start and end within 0.001 beats),
  the song tempo must be unchanged and the source track must still exist; otherwise the result is not placed and
  nothing is changed. **Take lane and New track do not refuse a source that was deleted or moved to another track**
  while the host was open: only a move on the same track is caught (the result is placed at the original position).
  Replace refuses both.
- VocAlign: the guide clip is checked again at Send to VocAlign and before placement, also when it comes from
  `guide.json` (set by another device). If it was moved, trimmed, deleted, put on a take lane or points to another
  file, the device says "The guide clip changed or was removed since Set guide. Set the guide again." (or
  "Not placed: ..." after the host ran); a changed song tempo also needs a new Set guide. A missing, unreadable or
  other-format `guide.json` counts as no guide ("Set a guide first: ...").
- VocAlign: the result clip goes to the guide's start on the dub's side. The dub itself is still checked as the
  source (moved or trimmed while the host was open: not placed). Replace removes the dub and puts the result at the
  guide's start on the dub track: if another clip there starts inside the result or the result would run into one,
  nothing is changed ("Not placed: the new clip would overwrite another clip on the track" / "... run into the next
  clip ...").
- Replace: the original stays on a muted backup track. If removing the temporary scratch track fails at the very end,
  the verified result is kept and the status says to delete the scratch track by hand.
- A rollback never removes a clip or track it did not make. Leftovers (an empty take lane: Live has no call to delete
  one; a track that holds a clip you dropped on it during placement) are named in the status line.

## Live checklist (Task 5 and 6)

Things the fake Live in `tests/test_bridge.js` cannot prove; run them in a throw-away set:

1. **Paths with spaces.** A clip Live recorded itself (its file name has spaces, digits and brackets, e.g.
   `1-Audio 0001 [2026-10-23 101500].wav`) as the source, and the result placed from
   `~/Library/Application Support/ARABridge/results/` (a path with a space). Symptom if LiveAPI splits paths: every
   placement ends with "the new clip did not appear" and a clean rollback.
2. **Replace end to end**: `Song.delete_track` (scratch track removed), `Track` mute on the backup track,
   `duplicate_clip_to_arrangement` of a trimmed clip (backup keeps the trim), and of the scratch clip back onto the
   source track.
3. **Rollbacks** in Live (provoke one, e.g. by deleting the scratch track by hand while "Placing..." runs).
4. **Name and gain** of the result clip (`<name> (Melodyne)`, gain copied; a clip at -6 dB stays at -6 dB).
5. **A take-lane clip selected** -> "This clip is on a take lane. Select a clip on the track's main lane."
6. **Guide moved after Set guide** -> the guide-changed message; also moved while VocAlign is open -> "Not placed".
   **Guide shared between devices**: Set guide on the guide track's device, Send to VocAlign on the dub track's device.
7. **Two devices at once** (two tracks, one job each).
8. **Device deleted during "Placing..."** (replace): nothing more happens; the original is on the muted backup track.
9. **Placement completes** (the Task reschedules itself; if it stalls on its first step label, reload the device).
10. **Source moved, tempo changed, track deleted while the host is open** -> "Not placed: ..." and nothing changed.
11. **VocAlign result at the guide's start**: guide and dub at different arrangement positions (dub later, then dub
    earlier than the guide); in each placement mode the result clip starts exactly at the guide clip's start.

12. **Still to check in Live:**
    - Undo after each placement mode.
    - Collect All and Save picks up `results/*.wav`.
    - Cancel from the device button and from the host window.
    - Two window jobs at once.
    - Deleting the device during "Placing...".
    - A node.script restart during a job.
    - Reopening a set with a stale `guide.json`.
    - Umlaut and emoji clip/track names.
    - An MP3 or M4A source on the timeline.
    - The saved Placement and Skip realign values surviving a set reopen.
    - The page: renders, every control does its job, a duplicated device behaves the same.

## Known limits

- **Compressed sources:** MP3 files without a Xing/LAME tag and raw ADTS AAC can come back offset by about 13-48 ms
  (encoder padding that CoreAudio keeps). They are not refused; use WAV/AIFF sources for exact timing.
- **No job-protocol check yet:** the device does not check `BridgeHost --version` for `job-protocol 1` before writing jobs.
- **Late or missing runner answers:** if node.script stops or a runner answer gets lost (device removed, Node restarted),
  a finished result stays in its job folder (`~/Library/Application Support/ARABridge/jobs/<id>/result.wav`) and is not
  placed; there is no recovery in v1.
- **Take lane / New track** do not refuse a source deleted or moved to another track while the host was open.
- **Take lanes** cannot be deleted through Live's API: a rolled-back take-lane placement leaves an empty lane.
- **The UI state outlet** of the script (busy, cancel, ...) only dims the page; a second Send while busy is refused with a
  status message instead.

## Troubleshooting

- **Device log:** `~/Library/Application Support/ARABridge/device.log` (rotated to `device.log.1` above about 200 KB): one
  line per message the script received, per launch and per finish. Use it to see whether a job started from a click.
  The Max console has the status lines prefixed `ARABridge:`.
- **Host log:** `~/Library/Application Support/ARABridge/jobs/<job id>/host.log` per job, next to `job.json` and
  `result.json` (`result.json` is authoritative; its `message` and `diagnostics` say what happened).
- **`~/Library/Application Support/ARABridge/settings.json`** keys: `hostPath` (BridgeHost binary to launch instead of
  `bin/BridgeHost`; read by the device), `pluginPaths` (`{"melodyne": "...", "vocalign": "..."}`; read by the host) and
  `keepRaw` (JSON `true`: the host keeps the raw renders `render-raw-1/2.wav` and `realign-debug.json` in the job folder,
  for diagnosing a bad result; any other value is ignored with a warning).
- **Sound:** "No sound? Choose your interface in the host window's Output menu." (the status line says so when the host
  window opens). The host plays on the system default output unless you pick one in the host window's **Output** menu; the
  choice is saved in `~/Library/Application Support/ARABridge/audio.json` (delete the file to go back to the default).
- **"Still busy" / a job already running:** one job per device. Press **Cancel** (it says `Nothing to cancel.` when idle).
  If the status stays busy after the host window is gone, check `host.log` and `result.json` of the last job; removing
  and re-adding the device restarts the Node script (a running job's state is lost; its result stays in the job folder).
  A Send within 1.5 s of the previous Send or the end of a job is ignored on purpose.
- **Checking a Melodyne result:** `python3 tools/check_edit.py JOB_DIR` (prefix identical, edited note, tail relative RMS,
  worst windows, fail reasons; needs numpy, e.g. `/opt/homebrew/Caskroom/miniforge/base/bin/python3`).
- **Checking a VocAlign result:** `python3 tools/measure_alignment.py --job JOB_DIR` reads `job.json` and `result.wav`
  and compares the result with the guide. The result starts at the guide clip's start (`"output": "guide"` in
  `job.json`; jobs from before 2026-10-23 have no `output` and start at the dub clip's position); the tool accounts for
  both.
