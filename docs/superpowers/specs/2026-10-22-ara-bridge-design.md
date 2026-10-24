# ARA Bridge for Ableton Live — Design

Date: 2026-10-22
Status: host and device implemented, verified in Live 12.4.6 (2026-10-23) for Melodyne (take lane, new track, replace) and VocAlign
(branch feature/bridge-host, with Melodyne 5.4.2 and VocAlign 6 Pro). Retail plug-in check and packaging are open.
The host as built and what the device must do to drive it: `2026-10-23-host-device-contract.md`.

## 1. Goal

Ableton Live has no ARA2 support, so Melodyne and VocAlign cannot be used on a clip without playing the
take through in real time. ARA Bridge gives Live an offline round trip: select a clip in Live, edit it in
Melodyne (or align it with VocAlign) in a separate host app, and bring the result back into the Arrangement.

It is a personal tool for now. It is built cleanly (no hardcoded paths, settings and plug-in discovery in
one place) so that packaging for others is later work, not a rewrite.

## 2. Evidence this is feasible (spike, 2026-10-21)

Source: `spike/EditHost/`, notes in project memory (`ara-host-spike-results`).

- Melodyne 5.4.2 loads as an ARA plug-in in a host that is not a DAW, opens its full editor, analyses a
  real vocal and renders offline. A manual +3 semitone edit changed the render as expected. An unedited
  render matched the input (re-measured in the bridge host, 2026-10-22: bit-identical for many regions, for
  others within 1-2 float ulps, at most 6e-8; see 2.1).
- VocAlign 6 Pro works the same way. With a guide and a dub warped by 3–85 ms, the rendered dub averaged
  1.4 ms from the guide (44.3 ms before).
- Known quirk: after a Melodyne pitch edit, the audio after the edited note is a copy of the original shifted
  early by a small, fractional number of samples (measured about 30.75 and 118.66 samples; an earlier whole-sample
  reading of 31 and 119 was too coarse). Melodyne reports 0 latency and the host's region timing is identical, so this
  happens inside Melodyne. Section 7 handles it.
- Second quirk (found 2026-10-22, see 2.1): Melodyne sometimes outputs one sample at exactly twice its value.
- Caveat: all results so far come from the author's own installs of Melodyne and VocAlign. Behaviour with other
  installs and versions must be re-verified (milestone 7).

### 2.1 Melodyne's doubled samples and the two-render repair

Measured with the bridge host on unedited jobs (Melodyne 5.4.2): now and then one output frame is exactly twice
the source value in every channel (up to 0.01, about -40 dB, on the spike's vocal). It always falls on the first
sample of a process block, and only some block starts are affected; which ones depends on the region (a given
source position can glitch for one region start and not for another). Ruled out on the host side: separate
input buffers instead of in-place processing, realtime vs. offline process mode, block continuity. Block sizes
that put no block start on an affected position avoid it, but the host cannot know those positions in advance.

The host therefore renders Melodyne twice, with block sizes 4096 and 3001, the second with a pre-roll chosen so
that the two block grids do not meet inside the region (holds for regions up to 12,288,000 frames: about
4.6 minutes at 44.1 kHz, 4.3 minutes at 48 kHz, 2.1 minutes at 96 kHz).
A frame is repaired only if exactly one render starts a block there, its value is about twice the other render's
in every channel (within 1% of the level plus twice the renders' largest difference one or two frames away, so
small legitimate differences in edited material do not hide a glitch) and the neighbouring frames agree (the
renders' differences one and two frames away are below 25% of the difference at the frame); everything else keeps the first render, and remaining
disagreements are only logged (`result.json` `diagnostics`). VocAlign showed no such glitch and is rendered once.
With this, unedited Melodyne results stay within 1e-7 of the source on every region tried (20 regions of three
files), bit-identical on many.

Observed in the first end-to-end run with an edited note (19.9 s vocal, one note moved up about 3 semitones,
realignment ON): (i) the renders at block sizes 4096 and 3001 differ over most of the shifted tail (1424
stretches, 633124 frames), so for edited material the doubled-sample repair cannot compare renders and the first
render is kept; the host only records this in `result.json` `diagnostics`. (ii) The shift after the edit was
about 100.44 samples (30.75 and 118.66 in the spike runs), so it depends on the edit and must be measured per
job, never assumed.

## 3. Decisions

| Topic | Decision |
|---|---|
| Architecture | Out-of-process: M4L device in Live + separate Bridge Host app. Hosting inside Live's Max process is rejected (a plug-in crash would take Live down). |
| Result placement | A device setting with three choices: **new take lane** (default), **new track**, **replace in place** (original kept as a muted backup). |
| VocAlign clip selection | Two steps: select the guide clip and press **Set guide**; select the dub clip and press **Send to VocAlign**. The guide stays remembered. |
| Audience | Personal tool, built so packaging later is only packaging. |
| Supported clips (v1) | Unwarped, non-looping Arrangement audio clips on a track's main lane, transposition 0. Clip gain is not a refusal: it is copied to the result clip. Transposition (`pitch_coarse`/`pitch_fine` not 0) is refused. |
| Platform | macOS on Apple silicon only. |

## 4. Architecture

```
 Live (Arrangement)
   │  select clip, press button
   ▼
 M4L device "ARA Bridge"  ── writes job folder ──►  ~/Library/Application Support/ARABridge/jobs/<id>/
   │  launches host (Node for Max)                      job.json
   │  watches for result.json                           result.wav     (written by host)
   │                                                    result.json    (written by host)
   ▼                                                         ▲
 creates clip(s) in Live  ◄──────────────────────────────────┘
                                                      Bridge Host app
                                                      (ARA host + plug-in editor window + playback)
```

Components:

1. **M4L device "ARA Bridge"**: an audio effect that sits on an audio track (audio passes through). Controls: result
   placement, a **Skip timing correction** toggle (Melodyne realign, on by default), buttons **Send to Melodyne**,
   **Set guide**, **Send to VocAlign**, **Cancel**, **Refresh plug-ins**, and a status line. Reads clip data through the Live Object Model (LOM), writes
   job files, launches the host, watches for the result, and creates the result clip(s).
2. **Bridge Host app**: Cocoa app with a C++ ARA host core derived from the spike. One window per job with
   the plug-in's editor, play/stop, and **Apply to Live** / **Cancel**. Also has a headless mode
   (`--job <dir> --autorender`) that renders a job without opening a window.
3. **Job folder protocol**: files only, no network ports. The device writes `job.json`, then launches the
   host with the job path. The host writes `result.wav` and then `result.json` (written last, so its
   existence signals completion).

Third-party code and licences (relevant only if shared later): Celemony ARA SDK (Apache 2.0); Steinberg
VST3 SDK (dual-licensed GPLv3 / proprietary agreement). The tool does not handle plug-in licences in any
way: Melodyne and VocAlign must be licensed by the user.

## 5. Data flow

### 5.1 Melodyne

1. The user selects an Arrangement audio clip and presses **Send to Melodyne**.
2. The device reads the clip via the LOM: `file_path`, `start_marker`, `end_marker` (seconds for unwarped
   clips), `start_time` (beats), track, name, plus `warping`, `looping`, `gain`, `pitch_coarse`, `pitch_fine`. It
   refuses to send (status line explains why) in the cases of section 8. `end_marker` is not used (stale for
   unwarped clips, section 6); the region comes from `loop_start`/`loop_end`.
3. The device writes `job.json` and launches the host.
4. The host builds an ARA document with the whole source file as the audio source and one playback region
   covering `start_marker..end_marker`. Melodyne's editor opens in the window. The user edits (with
   playback in the host to hear the take; the host plays on the output chosen in its window's Output menu, saved in
   `audio.json`, default: the system output) and presses **Apply to Live**.
5. The host renders the region offline, realigns it (section 7), and writes `result.wav` (32-bit float
   WAV, same sample rate and channel count as the source, exactly the length of the region) and then
   `result.json`.
6. The device creates the result clip at the original position with the name `<name> (Melodyne)`,
   according to the placement setting (section 6).

### 5.2 VocAlign

- **Set guide** stores the selected clip's data (same fields as above) in the device and in
  `~/Library/Application Support/ARABridge/guide.json`, so that it is shared between device instances (the newest
  Set guide wins). Reason: Live's Device View hides a device when a clip on another track is selected, so the guide
  clip's device is not reachable while the dub clip is selected. Put the device on the guide track and on the dub
  track: press Set guide on the first, Send to VocAlign on the second. The guide is re-checked at Send and before
  placement (moved, trimmed, deleted or other file: refused).
- **Send to VocAlign** sends the selected dub. `job.json` carries both clips with their real arrangement
  positions, so their relative timing is preserved. Converting beats to seconds uses the song tempo and
  requires constant tempo (otherwise the send is refused).
- The host puts guide and dub on two tracks, binds the plug-in instance like a DAW track insert (all three
  ARA roles, dub region assigned), and offers **Select track 1/2** to drive the ARA view selection the way a
  DAW would. After the user captures guide and dub and presses **Apply to Live**, the host renders the dub
  track only.
- No realignment is applied to VocAlign output (its whole purpose is time-warping the dub).
- The device places the aligned dub as `<name> (VocAlign)` using the placement setting. **The result clip starts
  exactly at the guide clip's start** (use case: main vocal = guide, backing = dub; the aligned backing begins with
  the main vocal's clip), in every placement mode, on the dub's side (take lane of the dub track, new track below it,
  or replacing the dub). The job says `output: "guide"`; the host renders the dub as before and composes `result.wav`
  over `[guide start, max(guide end, dub end))`: the aligned dub at its arrangement offset, digital silence elsewhere,
  the dub's part before the guide's start dropped (the status line says how much). A dub that ends at or before the
  guide's start is refused at Send. The content is aligned to the guide's timing; `tools/measure_alignment.py --job
  JOB_DIR` compares such a result from the guide's start. Until 2026-10-23 the result started at the dub clip's
  position with the dub's length (output `"dub"`, still the host's default).

### 5.3 `job.json` fields

```
version, id, plugin ("melodyne" | "vocalign"), createdAt,
placement ("takeLane" | "newTrack" | "replace"),
realign (bool),
output ("dub" | "guide"; optional, default "dub"; "guide" for VocAlign only: result.wav starts at the guide),
clips: [ { role ("source" | "guide" | "dub"), path, startSec, endSec, startBeats, name, sampleRate, channels } ],
song: { tempo },
live: { trackIndex }
```

The host ignores `createdAt`, `sampleRate`, `channels` and `live.trackIndex` (it decodes rate and channels from
the audio file; the device keeps `trackIndex` for itself) and tolerates unknown keys; a key set to `null` counts as
absent. Clip paths must be absolute (start with `/`).

`result.json`: `{ version, id, status ("ok" | "cancelled" | "error"), message, diagnostics, resultPath,
sourceStartFrame, frames, sampleRate, realign: { applied, reason, shifts[] }, placeAt, offsetFrames, droppedFrames }`
(`reason`: section 7, step 5; the last three only for output "guide": `placeAt` "guide", where the first kept dub frame
is in `result.wav`, and how many dub frames before the guide's start were dropped). `message` is for the device's status
line; `diagnostics` is for logs only and the device ignores it. `sourceStartFrame`, `frames` and `sampleRate`
say what `result.wav` covers (the region's first frame in the source file, its exact length, its rate), so the
device uses them instead of recomputing the length. The device must treat `result.json` as authoritative, not
the host's exit code: a crash or hang while tearing down after an "ok" result can still end the process with a
non-zero code or a signal.

## 6. Result placement in Live (via LOM)

Placement as implemented (`device/src/core.js` `planPlacement`, executed and verified step by step by
`device/src/bridge.js`). Every created clip is unwarped, named `<name> (Melodyne|VocAlign)`, gets the source clip's
gain, and is then verified (warping 0, looping 0, start, length within 2 ms of `frames/sampleRate`).

- **New take lane** (default): `Track.create_take_lane()`, then `TakeLane.create_audio_clip(path, startBeats)`.
- **New track**: `Song.create_audio_track(index below source)`, then `Track.create_audio_clip(path, startBeats)`.
- `startBeats` is the source clip's start; for VocAlign (result `placeAt` "guide") it is the guide clip's start
  (`planPlacement`'s `placeAtBeats`), on the dub's track. The stale checks, the replace backup and the restore keep
  using the dub's own position.
- **Replace in place**: build the result on a scratch track first; keep the original on a muted backup track.
  Order: backup track, `duplicate_clip_to_arrangement(original)` onto it (verified, muted), scratch track with the
  verified result clip, then `Track.delete_clip(original)`, `duplicate_clip_to_arrangement(scratch clip)` onto the
  source track, verify, `Song.delete_track(scratch)`. A failure before the delete removes what was made; a failure
  after it restores the original from the backup track (verified before the scratch and backup tracks are deleted).
  If the restore fails, the backup track stays and the status says the original is there.
  VocAlign: the dub is replaced and the result goes to the guide's start on the dub's track; the usual overlap checks
  (nothing may start inside, or be run into by, the moved result) apply there, otherwise nothing is changed.
- `create_audio_clip` is never run on the user's main lane (see the quirk below).
- The host always writes the result as `<job folder>/result.wav` (and never overwrites a job's result). The device
  copies it to a unique name in `~/Library/Application Support/ARABridge/results/` before creating the clip. Files
  placed in Live are never overwritten.

Measured LOM facts (Live 12.4.6, Max 9.1.5, 2026-10-23, probes and the user's Live session):

- `live_set view detail_clip` gives the selected Arrangement clip (`is_arrangement_clip` 1). Numbers can arrive as
  strings (`"7.1e-15"`): always `parseFloat`.
- For an unwarped clip `start_time`/`end_time`/`length` are in beats, `loop_start`/`loop_end`/`start_marker` in
  seconds of the file. `end_marker` is stale and unusable (it read 32 for a 14.6 s and for a 20 s clip).
  `loop_end - loop_start` equals `length * 60 / tempo` for constant tempo; the device refuses if they differ by more
  than 2 ms. `gain` is raw: 0.4 is 0 dB.
- `Track.create_take_lane` returns the new lane; `TakeLane.create_audio_clip(path, position)` works, and the lane's
  clips are read as children via `arrangement_clips` (not `clips`).
- `Track.create_audio_clip(path, position)` makes a **warped 8-bar looping clip** until `warping` is set to 0, which
  restores the true length and `looping` 0 (verified for a 20 s source and for the host's 32-bit float result WAV).
- `Track.create_audio_clip` at a position that holds a clip **replaces** that clip on the main lane. Take-lane
  placements overlay another lane and are fine.
- `Track.duplicate_clip_to_arrangement` keeps the clip unwarped and its trims (checked in the Replace run with a
  trimmed clip). `Track.delete_clip` removes a clip. `Song.delete_track` exists (used for the scratch track); there
  is **no call to delete a take lane**.
- A device cannot rely on the Device View: Live shows only the selected track's devices (see 5.2).

## 7. Realignment after Melodyne edits

Problem: after an edited note, the rest of the render is a copy of the original shifted earlier by a small
constant that is not a whole number of samples (measured about 30.75, 118.66 and 100.44 samples; see 2.1). Between edits there can
be stretches that are not shifted at all (quiet passages stay bit-identical), so the shift changes a few times per edit. Melodyne reports 0 latency, so the host cannot compensate
through the plug-in API.

Algorithm (runs in the host after rendering, on the Melodyne result only):

1. Compare the render with the original in 50 ms windows (25 ms hop), searching lags of ±400 samples with
   normalised cross-correlation over the overlapping samples, then refine the best whole-sample lag to a
   fractional one with a parabola through the correlation values on either side.
2. Windows whose refined peak correlation is ≥ 0.98 are confident matches: "unshifted" windows (shift ≈ 0) and
   "shifted" windows (the render is early by a constant). Group consecutive ones whose shifts differ by at most
   half a sample into segments, and ignore runs shorter than 3 windows (about 100 ms; a short match at a different shift is a
   coincidence, not an unshifted stretch). Windows below the threshold are treated as edited.
3. The candidate shifts are 0 plus the distinct shifts found in step 2 that have enough support: a nonzero
   shift's segments must cover at least max(0.4 s, 3% of the region), in at least 2 segments unless they
   reach 0.75 s on their own. Shifts with less support are short, isolated stretches at another shift (a
   chance match or a brief local move; measured: one segment of at most 0.2 s, at most 2.4% of the region).
   The block test of this step is looser than step 2, so such a shift wins blocks all over pitch-edited
   material (measured on a snap-to-scale edit of a whole 9.2 s vocal: one 0.2 s match at +144.85 samples
   moved 4.7 s in 9 stretches), and moving them crossfades the render with a copy of itself delayed by a
   millisecond or two, which crackles. Real Melodyne timing shifts recur over much of the region (measured:
   5-20 segments, 1.3-8 s, 21-56% of the region). If no nonzero shift is left, nothing is applied. Known
   limit: a brief real local move (measured once: 0.13 s, 5.1 ms) now keeps Melodyne's timing. Split the render into 5 ms blocks and
   compare each block with the original under every candidate shift (the render moved by a windowed-sinc
   fractional delay; whole-sample shifts are exact copies). A block takes a candidate only if that candidate fits
   clearly better than all the others and fits the block well in absolute terms. The chosen candidate is switched
   only after 3 consecutive blocks agree, with a 3 ms crossfade at every switch. Blocks that fit no candidate (the
   edited note) keep the previous choice, so an edited note is left exactly as rendered. As a backstop, a
   classification that switches more than 4 times per second of region (two switches are always allowed) is
   not applied (measured maximum for real edits: 2.7 per second).
4. Keep the total length equal to the region length (trim or pad with silence).
5. If no confident lag is found, apply nothing and report `applied: false` in `result.json`; the device
   shows this in the status line. Nothing is changed silently. `realign.reason` (ok results) says why:
   `"applied"` (audio was moved), `"nothing-to-do"` (the render already lines up with the source, e.g. no
   edit), `"no-confident-match"` (no part of the render matched a moved copy of the source, including a silent
   region; left as rendered), `"inconsistent-shifts"` (only short, isolated matches at a nonzero shift, or an
   unstable classification; left as rendered, i.e. Melodyne's own timing) or `"not-requested"` (realign off, or a VocAlign job). Error and cancelled
   results have no `reason`.

Acceptance criteria, measured on the spike's captured renders (`spike/out_session1`, `out_session2`; the test
uses a 2-8 s excerpt of session 2): the prefix before the edit stays bit-identical to the original, the edited
note is bit-identical to the render (realignment does not modify it), and in the tail after the edit the relative
RMS error against the original, measured from 0.5 s after the end of the edited note, is at least 10x lower than
for the unaligned render (full-file figures: 0.085 vs 1.46 for session 2, 0.105 vs 1.46 for session 1; the 2-8 s
test excerpt gives 0.0844 vs 1.496 for session 2; the numbers depend on where the tail starts, e.g. session 1 is
0.105 from 7.7 s but 0.127 from 7.6 s). A relative error of 1% (−40 dB) is not reachable on this data:
Melodyne's shifted audio is itself only about 95% similar to the original, so even a perfect delay leaves about
4.7% error inside the detected stretches.

## 8. Errors and edge cases

- Refused before sending, with a status message (`validateClip` codes in `device/src/core.js`): no clip selected
  (`no-clip`), MIDI clip (`midi`), Session clip (`session`), unreadable clip properties (`unsupported`), warped
  (`warped`), looping (`looping`), transposed (`transposed`), frozen track (`frozen`), missing or offline file
  (`no-file`, `offline`), relative path (`relative-path`), unreadable or inconsistent region, e.g. tempo change under
  the clip (`region`, `tempo`), plug-in not found (`no-plugin`), host not installed (`no-host`), a job already
  running for this device (`busy`), and for VocAlign no guide (`no-guide`), different sample rates
  (`rate-mismatch`), tempo changed since Set guide (`guide-tempo`), a dub that ends at or before the guide's start
  (`dub-before-guide`: the result starts at the guide) and a window from the guide longer than 2 hours (`too-far`).
  A clip on a take lane is refused too. Clip gain
  is not refused (copied to the result).
- After the host ran, nothing is placed ("Not placed: ...") if the source clip moved or was trimmed, the tempo
  changed, or (Replace) the source or its track is gone.
- Plug-in not found: the status line says so and the Send is refused; the host searches the standard VST3 folders.
- Host crash, a second stop signal or a hung render: the host writes a prepared `result.json` with status
  "error" when possible (published so that it never replaces a real result; a crash the signal handlers do not
  see writes nothing). Window closed, Cancel, Quit, or a first stop signal (SIGTERM etc.) while the window is
  open, or a Quit before the window has opened (e.g. during a licence dialog): `result.json` with status
  "cancelled" (a render in progress is stopped first). If no `result.json`
  appears, the device times out of the "waiting" state when it sees the host process end. Nothing in Live
  changes. The device trusts `result.json`, not the exit code.
- Several jobs at once: each job has its own folder and host window.
- Result files are never overwritten.

### 8.1 Known limits

- Melodyne's edited render differs from the original in some stretches even at perfect alignment; this depends on
  the material. Measured with `tools/check_edit.py`: one vocal tail relative RMS 0.10; another 0.22, with the worst
  stretches at 0.4-0.8, in windows where Melodyne's own output differs from the source at any alignment (best lag
  0). Decision: keep Melodyne's output as it is.
- VocAlign residual: about 6 ms observed for a 256 ms arrangement offset between identical clips (0.0 ms for
  20 ms).
- A rollback in Take lane mode leaves an empty take lane (no call to delete one); the status line names it.
- Compressed sources (mp3/m4a etc.) with encoder padding: not verified; the clip's seconds may not match the decoded
  file by the padding.
- Window mode has no timeout: a host window left open keeps the device busy until Apply, Cancel or Quit.
- Device state (running job, guide held in memory) is lost when the node script restarts; the guide survives in
  `guide.json`, a running host keeps its result in its job folder but nothing places it.
- One window job at a time per device.

## 9. Testing

- Realignment: automated tests on the spike's captured renders and on synthetic shifts.
- Host: headless mode. A job with no edits must produce a result equal to the source region: bit-identical for
  VocAlign; for Melodyne within 1e-7 (it adds 1-2 float ulps of noise on some regions, bit-identical on many),
  with the doubled-sample repair of 2.1 in place.
- Device: unit tests with a fake Live (`device/tests/`) plus a manual checklist in Live for each placement and each refusal case, plus a small probe patch that
  logs what the LOM reports for a selected clip. Max patches do not unit-test well.
- Real material: the user's own vocals and doubles; later a re-check on retail plug-in installs.
- Principle: measure the output (as in the spike), do not only check that nothing crashes.

## 10. Out of scope for version 1

Session clips, warped clips, transposed clips, re-editing an earlier edit later (needs saving
Melodyne's ARA archive), several clips at once, tempo automation, Windows, Intel Macs, sharing/packaging.

## 11. Build order

Each step has a check before the next starts.

1. **Host core**: turn the spike into a proper Bridge Host target (job in, result out, headless mode). Move
   the local SDK changes into a documented patch set. *Check:* headless no-edit job matches the source (section 9).
2. **Playback and Apply/Cancel**: CoreAudio output from the editor renderer, transport controls, buttons.
   *Check:* you can hear the take, Apply writes `result.wav` and `result.json`.
3. **Realignment module** with tests. *Check:* acceptance criteria in section 7.
4. **M4L device, Melodyne path**: LOM probe, job writer, host launcher, result import with take lane first,
   then new track and replace. *Check:* manual checklist in Live. Done, run by the user in Live 2026-10-23.
5. **VocAlign flow**: guide memory, two-track job. *Check:* guide/dub measurement as in the spike. Done in Live 2026-10-23.
6. **Polish**: error messages, status line, settings persistence.
7. **Retail check and packaging notes**: re-run milestones 2–5 on retail plug-in installs; write down what
   sharing would require (signing, notarisation, Steinberg licence, terms of both plug-in vendors).

## 12. Open risks

- Cause of Melodyne's post-edit timing shift is unknown (guess: note-length quantisation). If it appears
  inside edited notes too, the realignment may need refinement.
- Results come from the installed plug-in copies; retail behaviour may differ.
- The host depends on local changes to the SDK's example code; they must be kept in the documented patch set.
