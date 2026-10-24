# ARA Bridge M4L Device Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development to execute this plan task by task (implementer, then spec review, then code-quality review). Steps use checkbox (`- [ ]`) syntax.

**Goal:** the Max for Live device "ARA Bridge" that sends a selected Arrangement clip to BridgeHost (Melodyne or VocAlign) and puts the result back into Live as a take lane, a new track, or a replacement.

**Architecture:** three layers, each testable without Live. (1) `core.js`: pure ES5 logic (clip validation, region math, job.json, result interpretation, placement plans). (2) `bridge.js` (Max `js` object, LiveAPI): reads the selected clip and performs the placement through the LOM. (3) `runner.js` (Node for Max): creates job folders, launches and supervises BridgeHost, reports back. The `.amxd` wires the UI to them. LOM is only reachable from `js`; files and processes only from Node, so the two exchange short messages (URL-encoded JSON in one symbol).

**Tech stack:** Max 9.1.5 inside Live 12.4.6, classic `js` (ES5 only), Node for Max (Node 22), Python builder for the staging `.amxd`, BridgeHost (finished, see `specs/2026-10-23-host-device-contract.md`).

**Inputs:** design `specs/2026-10-22-ara-bridge-design.md`, host contract `specs/2026-10-23-host-device-contract.md`, probe device `device/probe/` (code, container builder and tests to reuse; results in `device/probe/out/`, git-ignored).

---

## Findings from the Live probes (2026-10-23, Live 12.4.6, Max 9.1.5)

These are measured facts; the tasks below depend on them.

1. **Selected clip:** `live_set view detail_clip` gives the clicked Arrangement clip (`is_arrangement_clip` 1, track via `canonical_parent`).
2. **Clip units (unwarped audio clip):**
   - `start_time`/`end_time`/`length` are in beats; `loop_start`/`loop_end` and `start_marker` are in **seconds** of the file. `sample_length` and `sample_rate` give the file extent.
   - `end_marker` is **stale and unusable** for unwarped clips (it read 32 for a 14.6 s clip and for a 20 s clip: the leftover of the warped state). Never use it.
   - Trimmed clip a: `start_marker` = `loop_start` = 1.8243 s, `loop_end` = 16.4189 s, `length` 32 beats = 14.5946 s at 131.555 bpm. So `loop_end - loop_start` equals `length * 60 / tempo` (constant tempo). Use the pair as a consistency check; refuse if they differ by more than 2 ms.
   - Numbers can come back as strings such as `"7.105427357601002e-15"`: always `parseFloat`.
   - Warped clips use beats for markers and loop (clip b: markers 4..., loop 4..36): refused in v1.
   - `gain` is the raw value 0.4 for 0 dB (`gain_display_string` "0.00 dB").
3. **Placement calls (all verified in the real set):**
   - `Track.create_take_lane` returns `["id", N]`. `TakeLane.create_audio_clip(path, position)` works (the clip appears in the lane). The lane's clips are read from child `arrangement_clips`, not `clips` (that returns a count).
   - `Track.create_audio_clip(path, position)` works on the track and on a track made by `Song.create_audio_track(index)`.
   - `Track.duplicate_clip_to_arrangement(["id", N], position)` keeps the clip unwarped at its true length. `Track.delete_clip(["id", N])` removes a clip.
   - **Quirk:** `create_audio_clip` makes a **warped 8-bar clip** (warping 1). Setting `warping` to 0 immediately restores the true length (confirmed for the 20 s source and for a 19.9 s 32-bit float WAV written by BridgeHost; both exactly right).
   - **Quirk:** a freshly created clip also reads `looping` 1 until `warping` is set to 0 (then `looping` 0 and the true length). The verify checks `looping` 0.
   - `duplicate_clip_to_arrangement` of a *trimmed* clip and of a clip on a scratch track back onto the source track: not measured in the probes; measured in the Replace run in Live (2026-10-23): the trim and the unwarped state are kept.
   - **Quirk:** `Track.create_audio_clip` at a position that already holds a clip **replaces** that clip. Placements on the main lane must never land on an existing clip (take-lane placements overlay a different lane and are fine).
4. **Launching BridgeHost from Live:**
   - Node for Max runs inside Live's bundled Max 9.1.5 with Node 22.18.0 (cwd = the script folder, PATH = the N4M bins plus /usr/bin:/bin:/usr/sbin:/sbin, normal HOME and TMPDIR).
   - From there `BridgeHost --version`, `--find-plugins` and headless Melodyne jobs ran with exit 0, with job folders in `~/Library/Application Support/ARABridge/jobs/` and in `/tmp` (no sandbox problem).
   - **Window mode:** the host window appears in front of Live within 2 s, with a Dock icon, and takes keyboard focus. Space goes to whichever app is frontmost (Melodyne's playhead moves when the host is in front, Live's when Live is). Apply wrote `result.json` (ok) and the process exited 0.
5. **Live's `js` object** can write and read files (`File`), detect existing files, and run Tasks. `live.thisdevice` fires when the device is ready.

## Decisions for the device (v1)

- **Placement:** user setting with `takeLane` (default), `newTrack`, `replace`, as in the design. Result clip: unwarped (`warping` 0 right after creation, re-read and verified), start at the source clip's `start_time`, name `<name> (Melodyne)` / `(VocAlign)`, gain copied from the source clip.
- **Refusals (status line says why):** not an Arrangement audio clip, warped, looping, `pitch_coarse`/`pitch_fine` not 0, frozen track, file missing, unit consistency check fails (tempo changes under the clip), plug-in not found (`--find-plugins`), host binary missing, a job already running for this device. Gain is **not** a refusal: it is copied to the result clip (0 dB is raw 0.4).
- **Result file:** the host always writes `<job>/result.wav`. The device copies it to `~/Library/Application Support/ARABridge/results/<jobid>.wav` (unique, never overwritten) before `create_audio_clip`. If Live later collects and saves, Live copies it into the project.
- **VocAlign guide:** originally held in the device's memory; changed after the Live test to be shared between device instances through `~/Library/Application Support/ARABridge/guide.json` (Live's Device View hides a device when a clip on another track is selected). Guide and dub positions come from `start_time` (beats), so the relative timing is preserved; `song.tempo` from `live_set tempo`.
- **Host binary:** `~/Library/Application Support/ARABridge/bin/BridgeHost` (installed with `tools/install_host.sh`); optional `hostPath` in `~/Library/Application Support/ARABridge/settings.json`; the status line tells the user to run the install script if neither exists.
- **Supervision:** one job per device instance. The host runs detached with stdout/stderr in `<job>/host.log`. The device waits for `result.json` or process exit; no timeout in window mode. Cancel button sends SIGTERM (ladder from the contract). If the device is removed while a job runs, the job keeps running and its result stays in the job folder (no recovery in v1).
- **Packaging:** staging `.amxd` generated by `device/make_amxd.py` with absolute paths to the scripts in the repo (same method as the working probe). A frozen single-file release is later work (milestone 7).

## File structure

- `device/src/core.js`: pure logic, UMD style (`module.exports` under Node, globals in Max), ES5 only.
- `device/src/bridge.js`: Max `js` object: inlets/outlets, LiveAPI glue (uses `core.js` via the build step).
- `device/src/runner.js`: Node for Max script (max-api).
- `device/build.py`: concatenates `core.js` + `bridge.js` into `device/build/bridge.js` (Max's `js` has no module loader).
- `device/make_amxd.py`: builds `device/ARABridge.amxd`.
- `device/tests/`: `test_core.js`, `test_bridge.js` (fake LiveAPI that reproduces the measured quirks), `test_runner.js` (fake and real BridgeHost), `test_amxd_container.py`.
- `device/README.md`: install and Live test checklist.

---

## Task 1: core.js, the pure logic

**Files:** create `device/src/core.js`, `device/tests/test_core.js`.

Functions (each with tests; plain `node device/tests/test_core.js`, no framework):

- `normalizeClip(props)`: takes a plain object of raw LOM values (strings or numbers) and returns numbers (`parseFloat`, treat `"7.1e-15"` as ~0).
- `clipRegion(clip, tempo)`: for an unwarped audio clip returns `{startSec, endSec, startBeats, lengthBeats, name, path, gain, ...}` using `loop_start`/`loop_end` (seconds) and the consistency check against `length * 60 / tempo` (2 ms tolerance). Never reads `end_marker`.
- `validateClip(clip, track, song)`: returns `{ok: true}` or `{ok: false, reason: "<short user message>"}` for every refusal in the decisions list.
- `buildJob({id, plugin, placement, realign, clips, tempo, trackIndex})` (job ids are folder names: letters, digits, `_`, `-`, `.`, no `:`; names lose control characters and are capped at 200 characters) returns the object for `job.json` per the contract (required fields only plus `createdAt`, `live.trackIndex`); VocAlign requires both clips with `startBeats` and the tempo; clip paths must be absolute.
- `interpretResult(resultJson, exitInfo)`: returns `{kind: "ok"|"cancelled"|"error"|"crashed", statusLine, resultPath, frames, sampleRate, sourceStartFrame}`; handles missing `result.json` plus process exit (crashed), an `ok` without a result file, and long messages.
- `planPlacement({mode, region, result, tempo, trackIndex, sourceClipId, resultFile, pluginLabel, existingClips})`: returns `{ok, ops, rollbackAfter, onRestoreFailure}` (or `{ok:false, reason}`), so `bridge.js` only executes and verifies. Ops are plain objects `{op, target, label, args | property+value | verify, produces?, destructive?}` (schema in the header of `core.js`). Rules:
  - `create_audio_clip` is **never** run on the user's main lane (Live first makes a warped looping 32-beat clip there and replaces whatever it lands on). Take lane: `create_take_lane`, clip on the lane. New track: `create_audio_track(trackIndex+1)`, clip on it. Every created clip is unwarped (`set warping 0`) right away, then named `<name> (Melodyne|VocAlign)` (an existing suffix is replaced, not doubled), gain copied (raw), then `verify` (warping 0, looping 0, start = `region.startBeats`, length seconds = `frames/sampleRate` within 2 ms).
  - **Replace** order: backup track at `trackIndex+1`, `duplicate_clip_to_arrangement(source)` onto it, verify the backup, mute it, **scratch track** at `trackIndex+2`, result clip created/unwarped/named/gain/verified there, then the single `destructive` step (`delete_clip` source), `duplicate_clip_to_arrangement(scratch clip)` onto the source track at `region.startBeats`, unwarp/name/gain again, verify, `delete_track(scratch)` (marked `optional`: after the verified result its failure is only a warning, "delete it by hand", never a rollback).
  - **Rollback.** Failure before the destructive op: delete what was produced so far, in reverse. Failure at or after it (except an `optional` op): run `rollbackAfter` (delete the failed final clip if any, duplicate the backup clip back onto the source track, verify it, only then delete the scratch and backup tracks). If the restore or its verify fails, delete nothing in `onRestoreFailure.keep` and show `onRestoreFailure.message` (the original is on the muted backup track).
  - Safety (`checkPlanSafety`, structural): a main-lane `create_audio_clip` is refused if any not-yet-deleted clip overlaps `[start, start + max(TEMP_WARPED_BEATS = 32, resultBeats))`; a main-lane duplicate is refused if it would start inside another clip (1e-9 beat tolerance) or run into the next one by more than 2 ms.
  - Stale source: when `sourceClipId` and `existingClips` are given, the source's `start_time`/`end_time` must still match the region within 0.001 beats ("the source clip changed while the host was open"; window mode has no time limit). Replace also needs the source in `existingClips`.
- `uniqueName(dir, base, exists)` for result copies.

- [x] Step 1: write `test_core.js` first using the measured clips a, b, c from `device/probe/out/p1-clip-1..3.json` as fixtures (copy the three `detail_clip` property sets into `device/tests/fixtures/` as JSON; they are small).
- [x] Step 2: implement until green; add edge tests (NaN, strings, missing fields, clips with `looping` 1, tempo mismatch, relative paths, empty names with emoji/umlauts).
- [x] Step 3: commit.

## Task 2: runner.js, the Node side

**Files:** create `device/src/runner.js` (derived from `device/probe/probe-node.js`), `device/tests/test_runner.js`.

Behaviour: handlers `launch <urlencoded json>` (job object, mode window or headless), `cancel`, `status`, `findplugins`. Resolves the host binary (installed copy, then settings `hostPath`), creates `~/Library/Application Support/ARABridge/jobs/<id>/` with `job.json` (write temp then rename), spawns detached with stdio to `<job>/host.log`, polls `result.json` every 250 ms and watches the exit; outlets a single message `done <urlencoded json>` with `{jobDir, resultJson?, exitCode, signal, hostLogTail}`. Cancel uses the SIGTERM ladder (SIGTERM, 3 s, SIGTERM, SIGKILL). One job at a time. Never throws into Max (every handler in try/catch, errors outlet as `error`).

- [x] Step 1: tests with a fake host script (result before exit, exit without result, hang until SIGTERM, crash with signal), plus one test with the real BridgeHost (`--autorender` job from `tools/make_test_job.py`).
- [x] Step 2: implement; run tests with plain `node` and a stubbed `max-api`.
- [x] Step 3: commit.

## Task 3: bridge.js, the LiveAPI side

**Files:** create `device/src/bridge.js`, `device/build.py`, `device/tests/test_bridge.js`.

Behaviour: message handlers `sendMelodyne`, `setGuide`, `sendVocAlign`, `cancel`, `hostDone <urlencoded json>`, `settings` (placement, realign). Reads the detail clip and track through LiveAPI, applies `core.validateClip`, builds the job, hands it to the runner (outlet), and on `hostDone` copies `result.wav`, executes the `planPlacement` ops step by step (re-reading ids after every mutating call, as the probe does; a Task-based sequence with 300 ms settle times; `produces` names remember created objects, `verify` ops re-read Live), and on a failed step rolls back: before a `destructive` op it deletes only the objects it produced, in reverse; at or after it (replace mode) it runs `rollbackAfter` (restore the original from the backup track, verify, then delete scratch and backup), and if the restore fails it keeps the backup track and says the original is there (`onRestoreFailure`). A failed `optional` op (the final scratch-track removal) is a warning, not a rollback. For VocAlign the guide clip is re-read at Send and before placement; a moved, trimmed or removed guide is refused. It never deletes an existing user clip other than the destructive delete after the backup and the scratch result are verified. Status line text to an outlet for a `comment` or `textedit`.

- [x] Step 1: write `test_bridge.js` with a fake LiveAPI that reproduces: create_audio_clip makes a warped 8-bar clip, `warping=0` restores the length, `TakeLane` children via `arrangement_clips`, main-lane `create_audio_clip` replacing an existing clip at that position, ids as `["id", N]`, string numbers, delayed visibility of new clips.
- [x] Step 2: implement, including the three placement modes and rollback; test each failure injection (a call throws, a clip never appears, the length is wrong after warping 0).
- [x] Step 3: `build.py` concatenation plus an ES5 syntax check (`node --check` plus a scan for `let`/`const`/arrow functions/template literals, which Max's `js` does not support).
- [x] Step 4: commit.

## Task 4: the patch and the .amxd

**Files:** create `device/make_amxd.py`, `device/tests/test_amxd_container.py`; generate `device/ARABridge.amxd`.

Reuse the probe's container writer and its verified header/length logic. Presentation view (about 330 x 170): `live.menu` plug-in (Melodyne / VocAlign), `live.menu` placement, `live.toggle` realign (Melodyne only), buttons Send to Melodyne, Set guide, Send to VocAlign (guide/dub buttons shown for VocAlign; use `live.text` in button mode wired through `[t b]` as in the probe), a Cancel button, a status `comment`/`textedit`. Parameters saved with the set (`parameter_enable`), stable names. Objects: `js <abs>/build/bridge.js`, `node.script <abs>/src/runner.js @autostart 1`, `live.thisdevice`, audio passthrough `plugin~`/`plugout~`.

- [x] Step 1: container test (marker offsets, payload length, JSON validity, patchline/port consistency, every UI object wired to its message).
- [x] Step 2: build; commit.
- [x] Step 3: `tools/install_host.sh` is run by the user (one command) and the README says so.

## Task 5: manual Live checklist, Melodyne

Run by the user in Live 12.4.6 (2026-10-23, own material), not by an agent. Checklist as in `device/README.md`.

Results:

- Install and load: OK. Melodyne take lane flow: OK end to end (edit, Apply, result in a new take lane, unwarped, right start and length).
- New track: OK. Replace: OK, including a trimmed clip (the original stays on a muted backup track).
- Refusals: OK.
- Bugs found and fixed:
  1. The startup bang flipped the `live.toggle` (Skip timing correction); the toggle is no longer banged.
  2. The runner stayed busy after a finished job ("still busy" on the next Send); fixed.
  3. A ghost relaunch (a job started without a click) was traced through `device.log` to the wiring that sent active/greying messages to the buttons; that wiring was removed (the Plug-in menu with it). Added `~/Library/Application Support/ARABridge/device.log`, and a Send within 1.5 s of the previous one is ignored.
- Host: the host plays on the system default output, so an **Output** menu was added in the host window (choice saved in `audio.json`).
- Measured on the results: Melodyne's edited render differs from the original in some stretches at any alignment (tail relative RMS 0.10 on one vocal, 0.22 on another with the worst windows at 0.4-0.8); decision: keep Melodyne's output as is. `tools/check_edit.py JOB_DIR` reports the worst windows and fail reasons.
- Not reported as run: the remaining items of the README "Live checklist" (deliberate rollback provocations, two devices at once, device deleted during placement, source moved or tempo changed while the host is open).

- [x] Run, record results in the plan, fix defects.

## Task 6: manual Live checklist, VocAlign

Run by the user in Live (2026-10-23). Set guide, Send to VocAlign, capture guide and dub in the window, Apply: the aligned dub appears per the placement. VocAlign flow: OK with the shared guide (device on the guide track and on the dub track; the guide is stored in `guide.json`). The result clip is placed at the dub clip's arrangement position, with content aligned to the guide's timing. Measured with `tools/measure_alignment.py --job JOB_DIR` (reads job.json, compares the result from the dub's arrangement position against the guide): residual about 6 ms for a 256 ms arrangement offset between identical clips, 0.0 ms for 20 ms.

- [x] Run and record.

Follow-up (2026-10-23, user request): the result clip must start exactly at the guide clip's start (main vocal = guide,
backing = dub). Done: job.json `output: "guide"` (sent by the device for every VocAlign job); the host composes
`result.wav` over `[guide start, max(guide end, dub end))` with the aligned dub at its arrangement offset and silence
elsewhere (frames before the guide dropped; `result.json` `placeAt`, `offsetFrames`, `droppedFrames`); the device
places the clip at the guide region's `startBeats` in all three modes (`planPlacement` `placeAtBeats`; replace removes
the dub and keeps the overlap checks at the new position; a result without `placeAt` from an older host is placed at
the dub with a note); a dub that ends before the guide's start is refused at Send. Headless with the real VocAlign:
bit-identical to the expected padded dub for dub later, earlier, a half-sample offset and the same start.
`measure_alignment.py --job` compares such results from the guide's start.

- [ ] Re-run in Live: guide and dub at different positions, each placement mode, result clip starts at the guide.

## Task 7: wrap-up

- [x] Update the design spec (status, section 6 with the measured LOM facts, section 3 gain handling, section 8 refusals, known limits), memory notes, README (Troubleshooting).
- [ ] Final whole-branch review (opus) of `device/` against this plan and the host contract.
- [ ] Milestone 7: re-run the Melodyne and VocAlign checks on the retail plug-in installs once available, and write down what sharing would require (frozen single-file device, signing and notarisation of BridgeHost, Steinberg VST3 licence, both vendors' terms).
- [ ] Use superpowers:finishing-a-development-branch.
