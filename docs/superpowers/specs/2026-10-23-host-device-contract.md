# BridgeHost <-> M4L device contract

Date: 2026-10-23
Status: derived from the final review of the host implementation (branch feature/bridge-host) and updated with the
review fixes (`--version`, `--find-plugins`, `tools/install_host.sh`, `realign.reason`); input for the device plan.

This is what the M4L device (Node for Max / JS) must do to drive BridgeHost, and what it can rely on. The design is in
`2026-10-22-ara-bridge-design.md`; where the two differ, this file describes the code as built.

## Binary and launch

- The binary is a bare Mach-O (not an .app) built by `tools/build_host.sh` at
  `<repo>/third_party/ARA_SDK/ARA_Examples/build/bin/Release/BridgeHost`. A rebuild or SDK setup rerun can replace it, so the
  device should use an installed copy: `tools/install_host.sh` copies it to
  `~/Library/Application Support/ARABridge/bin/BridgeHost` (creates the folder, refuses while that copy is running, leaves
  an identical copy alone, prints the path). settings.json may name another binary with `hostPath` (see below).
- `BridgeHost --job <absolute job dir>` opens the editor window. `--autorender` renders without a window.
- `BridgeHost --version` prints one line, `BridgeHost <build> job-protocol 1` (build: `git describe --always --dirty` of
  the repository at build time, e.g. `BridgeHost 5c0f245 job-protocol 1`, or `built-YYYY-MM-DD` without git), exit 0.
  The device should check `job-protocol 1` before writing jobs.
- `BridgeHost --find-plugins` prints one line of JSON, exit 0, using the same finder, settings.json overrides and VST3
  folders as a real run, so the device does not duplicate that logic:
  `{"melodyne": {"found": true, "path": "/Library/Audio/Plug-Ins/VST3/Melodyne.vst3"}, "vocalign": {"found": false,
  "problem": "No VocAlign VST3 bundle found in /Library/Audio/Plug-Ins/VST3, /Users/<you>/Library/Audio/Plug-Ins/VST3"}}`. A found
  plug-in also gets `"warning"` when a settings.json override was bad and ignored. A broken settings.json is a warning
  on stderr only.
- `--version` and `--find-plugins` take no other arguments, touch no job and open no window.
  `-psn_*` arguments are ignored; other unknown arguments give exit 2 and a usage line.
- Redirect stdout and stderr to `<job>/host.log` (or drain the pipes: an unread full pipe blocks the host). The host and the
  plug-ins write line logs there (VocAlign prints "Delteted Dir ..."). Do not parse them.

## Job folder

- One fresh, unique folder per launch, e.g. `~/Library/Application Support/ARABridge/jobs/<id>/`. Never reuse one: if
  `result.json` already exists the host exits 2 and writes nothing.
- The host only writes `result.wav`, `result.json` and their `.tmp` files (and `result.json.fallback.tmp`) in the job
  folder, plus a scratch folder in TMPDIR that it removes. Exception: with `"keepRaw": true` in settings.json (below) it
  also writes the diagnostic files `render-raw-1.wav`, `render-raw-2.wav` and `realign-debug.json` (and their `.tmp`
  files), always before `result.json`, so they are complete when the device sees the result. It reads any path given in `job.json` (acceptable for a personal
  tool). Clip paths must be absolute (start with `/`); a relative one is a bad job (exit 2, `result.json` error).
- The host always writes `<job>/result.wav`. The device copies it to a unique name (Live project folder, or Application
  Support) before `create_audio_clip`, and only then cleans up job folders.

## settings.json (`~/Library/Application Support/ARABridge/settings.json`, optional)

- `pluginPaths`: `{"melodyne": "<bundle path>", "vocalign": "<bundle path>"}` (a leading `~/` is expanded). Read by the
  host (a job and `--find-plugins`); a path that is not a complete VST3 bundle is ignored with a warning and the standard
  folders are searched.
- `hostPath` (optional): the BridgeHost binary the device launches instead of the installed copy. Read by the device
  only; the host ignores it (unknown keys are fine).
- `keepRaw` (optional, default false; diagnostics): `true` makes the host keep, in the job folder, what it needs to
  analyse an edited render offline:
  - `render-raw-1.wav`, `render-raw-2.wav`: the plug-in's renders exactly as returned, before the doubled-sample repair
    and the realignment (32-bit float WAV, region length, the source's rate and channels). Melodyne renders twice
    (block sizes 4096 and 3001, hence two files); VocAlign renders once (`render-raw-1.wav` only). With nothing edited
    and no doubled-sample glitch in the region, `render-raw-1.wav` equals `result.wav` (output `"dub"`; with output
    `"guide"` `result.wav` is that render placed in the guide's window, see job.json).
  - `realign-debug.json` (Melodyne jobs with realign on only): the realignment's outcome (`applied`, `nothingToDo`,
    `inconsistent`, `unstable`, `reason`, `note`), the parameters used, `support` (every distinct shift found, with
    the number of `segments` and `seconds` that support it and whether it was `kept` as a candidate), the candidate
    shifts, the pieces (`pieceCount`, `movedPieces`, each
    `start`/`startSec`/`shift`), the segments as detected (not clamped to the region; `start`/`end` frames and seconds,
    `shift`, `correlation`), `sampleRate`, `frames`, `sourceStartFrame` and `realignSeconds` (how long it took).
    Shift sign as in result.json (+ = the render was early).
  Each file is written to a temp file and renamed; a failure is only logged (`host.log`: `warning: keepRaw: ...`) and
  never fails the job. In the window every Apply rewrites them. Only a JSON boolean counts: any other value is ignored
  with a warning (`settings.json: 'keepRaw' must be true or false; ignored`); `null` counts as absent. The device does
  not need to know about this key.
- `ARABRIDGE_SETTINGS` points the host at another settings file (tests); it is read for `pluginPaths` and `keepRaw`.

## audio.json and the output device (window mode)

- The editor window plays through the device chosen in its **Output** menu ("System default (<name>)" or any CoreAudio
  output, e.g. "P1 (USB)"). The choice is saved by the host in `~/Library/Application Support/ARABridge/audio.json`:
  `{"outputUID": "<CoreAudio device UID>", "outputName": "P1"}`; `{}` or no file means the system default. The host
  writes it only when the user picks an output in the menu; the device never needs to write it (it may, while no host
  runs, with the same keys). A corrupt file is a warning (system default) and is replaced by the next choice.
- **A host launched from Max inherits the system default output, which may differ from Live's audio interface**
  (seen: Live on "P1", the host on "MacBook Pro Speakers", so nothing was heard). The device's status text or help
  should say: "No sound in the editor? Choose your interface in the window's Output menu." The window's status line
  shows the output while editing (`Edit, then press Apply to Live.   Output: P1`) and says
  `No audio from the output device - choose another output` when the device gives no audio after Play.
- A saved device that is not connected falls back to the system default (`Output: System default (saved device not
  available)`) and is used again when it is plugged back in. The device's rate is never changed (the host converts),
  so sharing P1 with Live is fine; the host uses the first two output channels.
- `ARABRIDGE_AUDIO_OUTPUT_UID=<UID>` (or `default`) overrides audio.json for one run and is never saved;
  `ARABRIDGE_AUDIO_SETTINGS=<path>` uses another audio.json (tests). `host.log` lists the devices and UIDs at startup
  (`audio devices: ...`, `audio output UIDs: ...`) and every switch (`audio output: P1 (device 152), 2 ch, rate 88200 Hz, ...`).
- Headless (`--autorender`) plays nothing and ignores all of this.

## job.json (device writes)

Max 16 MB, max 16 clips, unknown keys ignored, `null` counts as absent.

- Required: `version` = 1; `id` (non-empty string); `plugin` (`"melodyne"` or `"vocalign"`); `clips[]`, each with `role`,
  `path` (absolute) and `endSec` > `startSec`.
- Optional: `startSec` (default 0), `name` (default role), `placement` (`takeLane` default | `newTrack` | `replace`),
  `realign` (default true; Melodyne only), `output` (`dub` default | `guide`; `guide` needs a VocAlign job, any other
  value, an empty string and a non-string are a bad job). The device must write real booleans for `realign` and a
  non-empty `placement` (the loader rejects 0/1 and empty strings). The device sends `output: "guide"` for every
  VocAlign job.
- `output: "guide"` (VocAlign): `result.wav` starts at the guide clip's arrangement position instead of the dub's. The
  host renders the dub exactly as for `"dub"` (dub region, VocAlign's alignment, arrangement timing kept) and then
  composes the window `[T_g, W_end)`, `W_end = max(T_g + guide length, T_d + dub length)`, where `T_g`/`T_d` are the
  regions' playback starts: `(startBeats - earliest startBeats) * 60 / tempo` rounded to the nearest frame like the
  regions (half away from zero), so the offset is `T_d - T_g` in whole frames. The rendered dub goes in at that offset,
  everything else is digital silence (zeros). A negative offset drops the dub's frames before `T_g` (counted in
  `droppedFrames`, noted in `diagnostics`). Errors (exit 4, before the plug-in loads): a dub that ends at or before
  `T_g` (nothing of it would be kept) and a window longer than 7200 s. Guide and dub must have the same sample rate
  (already required). A dub after the guide's end is allowed (silence, then the dub).
- `preview` (optional boolean, default false; window mode, Melodyne only, otherwise ignored): see "Live preview" below.
  A non-boolean is a bad job.
- Melodyne: exactly one clip, role `source`.
- VocAlign: exactly one `guide` and one `dub`; `song.tempo` (0 < t <= 1e4) and every clip's `startBeats` are required;
  guide and dub must have the same sample rate.
- Ranges: times 0..86400 s, beats 0..1e7; sources mono or stereo, at most 3600 s. The end may lie up to 1 ms past the
  file end (it is cut there). Regions are rounded to whole frames, half away from zero.
- Ignored by the host: `createdAt`, `sampleRate`, `channels`, `live.*`.
- Compressed sources (MP3/AAC): MP3 files without a Xing/LAME tag and raw ADTS AAC keep ~576 / ~2112 leading samples of
  encoder padding in CoreAudio's output. Check how Live's `start_marker` relates to them, or restrict v1 to PCM sources.

## Live preview (window mode, Melodyne, `preview: true`)

While the editor is open the host renders the clip again after every edit and publishes each new state as
`<job>/preview-<n>/` (n = 1, 2, ...): `result.wav` (written first, temp file + rename) and then `result.json` (same format
and `realign` handling as the job's result, `resultPath` pointing into that folder). The job's own `result.wav` /
`result.json` are never touched and the job does not end: **only the real `result.json` of the job means done**.

- When it renders: the plug-in's ARA "content changed" notifications (audio modification / playback region) are counted
  (SDK patch, `gBridgeContentChanges`); 0.4 s after the last one the host renders (the same pipeline as Apply: two renders for
  Melodyne with the doubled-sample repair, then realign). The first render, 2 s after the window opened, only
  fixes what "unedited" sounds like (hash of the render): a preview is published only when the render differs from the
  last published one (the unedited state at first), so notifications that do not change the audio publish nothing.
  Measured with a real Melodyne: 0.06-0.1 s for a 7 s clip (also while the window plays), editor and playback unaffected.
- The host keeps the newest 3 `preview-<n>` folders and removes older ones. Cancel, Quit or a stop signal during a preview render
  stop it and close the job as usual; Apply during a preview render waits for it.
- The runner (`preview: true` jobs, window mode only) scans the job folder with its normal poll and reports each new complete
  `preview-<n>/result.json` once (newest first; an older one that was skipped is dropped, one that does not parse yet is looked at
  again) as `status {state: "preview", n, previewDir, resultJson (slimmed like `done`), jobId, ...}`. No new selector: the patch routes
  `status` to js already. Nothing is reported after the job's result.
- The device places each preview as an ordinary clip on a track it makes (`Preview: <clip name>`, right below the source
  track, clip `<name> (preview)`), so Live itself plays it in sync with every other track. The next preview removes the
  previous clip first. The track is removed when the job ends (before the result is placed for Apply; by a cleanup sequence for
  Cancel and failures). The source track is never changed; the user mutes it to compare.

## result.json (host writes; authoritative)

Published atomically and exclusively; never overwritten. Fields: `version`, `id`, `status` (`ok` | `cancelled` | `error`),
`message` (user-facing status line, <= 4096 bytes), `diagnostics` (logs only, the device ignores it), `resultPath`,
`sourceStartFrame`, `frames`, `sampleRate`, `realign { applied, reason, shifts[{start, end, shift, correlation}] }`
(`reason` only in ok results, see below), and for output `"guide"` only: `placeAt`, `offsetFrames`, `droppedFrames`.

- `start`/`end` are frames relative to the region start (the `result.wav` index); `shift` is in fractional samples,
  positive = the render was early.
- `resultPath` is the realpath (`/tmp` comes back as `/private/tmp`); use it as given.
- On a bad job.json the `id` is `"unknown"`: match results by folder, not by id.
- Use `result.wav` only if `status == "ok"`: a stray `result.wav` can exist after a failed window Apply.
- `result.wav` is 32-bit float with the source's rate and channel count, exactly `frames` long, fsynced and renamed before
  `result.json` is written.
- Output `"guide"` (ok results): `placeAt` is `"guide"` (the result clip goes to the guide clip's `startBeats`),
  `frames` is the window length `W_end - T_g`, `offsetFrames` is the index in `result.wav` of the first kept dub frame
  (`max(T_d - T_g, 0)`), `droppedFrames` the number of dub frames before `T_g` that were left out (0 unless the dub
  starts before the guide). `sourceStartFrame` stays the dub region's first frame in its file (informational).
  `message` stays empty. Without output `"guide"` none of the three keys is written: a result without `placeAt`
  starts at the rendered clip's region (Melodyne source, VocAlign dub), which is also what an older host returns for a
  job with output `"guide"` (it ignores the unknown key), so the device must check `placeAt` before placing at the
  guide. Readers accept `placeAt` `"guide"` or `"dub"`.

## Done detection and exit codes

Watch for `result.json` (it may appear ~1.2 s before the window closes) OR the process exiting. An exit without
`result.json` (SIGKILL, OOM, write failure, usage error, missing folder) means failed with no result. The outcome comes from
`result.json`, never from the exit code; codes are informational:

| Code | Meaning |
|---|---|
| 0 | ok |
| 1 | cancelled by the user |
| 2 | usage / bad job / result exists |
| 3 | plug-in |
| 4 | audio |
| 5 | render or write |
| 6 | signal or timeout |
| 128+n | crash |

## Timeouts

- Headless budget T = 300 s + 4 s x (sum of clip lengths); `ARABRIDGE_TIMEOUT_SEC` overrides it (leave unset in
  production). Grace = min(15, max(1, T/4)); SIGALRM backstop at T + grace + 5 s; teardown alarm 30 s. Device backstop for
  headless: T + grace + 40 s, then SIGKILL.
- Window mode has no overall limit while editing (a licence dialog or the user can take any time); only each Apply has
  budget T. The device must not time out a window job; it waits for the process to exit.
- Known limitation: the realignment (Melodyne, realign on) runs on the main thread during Apply, after the render:
  about 4-6 s per 4 minutes of audio. Meanwhile the window does not respond (the Apply sheet's Cancel, Quit and a first SIGTERM
  take effect only after it, when the ok result is already written; a second SIGTERM still writes the error fallback at
  once) and no watchdog covers it in window mode (the Apply budget is checked by the render's
  idle function, which realign does not call). Headless, the SIGALRM watchdog still covers it.

## Cancel from the device

Send SIGTERM. Window mode: `cancelled`, exit 6 (polled every 100 ms, not serviced while a modal licence dialog is up).
Headless: `error` "stopped by SIGTERM", exit 6. If the process is still there after ~3 s (+ grace during a render), send a
second SIGTERM (error fallback, exit 6 at once), then SIGKILL (writes nothing). Never send SIGUSR1/SIGUSR2 unless the host
documents them (unhandled signals kill the process without a result).

## Concurrency and focus

- Each job is its own process and folder. Four concurrent headless jobs were verified; concurrent window sessions were not:
  allow one window job at a time in v1, or test two first.
- Device runner busy rule (`device/src/runner.js`): the runner is busy from `launch` until the job's `done` is sent,
  that is, a job whose result has not been reported. Once `done` was sent the job is finished; a new `launch` is
  accepted at once, although the old host process may still be winding down (window mode: about 1.2 s after
  `result.json`, teardown can take longer). The runner keeps watching the old process silently (its exit sends nothing
  and does not touch the new job); `cancel` targets only the current job (the one without a reported result). A host
  that exits or crashes without a `result.json` is reported through `done` (after a 0.5 s wait for a late file), which
  frees the runner as well.
- There is no bring-to-front mechanism; a second launch opens a second window. Planned: a SIGUSR1 handler that activates
  and orders the window front, plus `host.json` {pid, startedAt} in the job folder so a reloaded device can find a running
  host.
- Probe for the device milestone: launched from Node (Live frontmost), `[NSApp activate]` may be refused, so the window is
  shown but Live keeps keyboard focus (a Space press could start Live's transport). Check whether the window gets key
  focus; if not, consider an .app bundle launched with `open -n ... --args`.

## Realign status for the status line

ok results carry `realign.reason`; use it, not `diagnostics`:

| `reason` | `applied` | Meaning |
|---|---|---|
| `"applied"` | true | Melodyne's timing shift after an edit was corrected (`message` says so) |
| `"nothing-to-do"` | false | the render already lines up with the source (typically: no edit) |
| `"no-confident-match"` | false | no part of the render matched a moved copy of the source (also a silent region); left as rendered |
| `"inconsistent-shifts"` | false | no consistent timing shift: the only shifted matches were short and isolated (chance matches or brief local moves; typical of pitch edits over the whole clip), or the shift choice was unstable; left as rendered (Melodyne's own timing) |
| `"not-requested"` | false | `realign` false, or a VocAlign job (realign is a Melodyne feature) |

`message` is empty unless the reason is `applied`. Error and cancelled results have no `reason`; a result without it
(an older host) means "unknown".

## ARA API violations

Window mode logs ARA API validation failures (host or plug-in) to stderr / `host.log` and the unified log
(`ARA API violation #N ... (continuing)`) and goes on, so a plug-in quirk does not lose the user's edit. Headless they
abort and the crash fallback writes `result.json` with status error (exit 134).
