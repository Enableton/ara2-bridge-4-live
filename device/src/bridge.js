// ARA Bridge device - Max classic [js] side: reads the selected Arrangement clip through LiveAPI, hands a job to the
// Node runner (node.script runner.js), and places the result back into Live by executing core.planPlacement's ops.
//
// ES5 ONLY (Max's classic js engine): no let/const/arrow functions/template literals/classes/spread/Object.assign/
// Array.includes/find/startsWith/... (device/build.py and device/tests/test_bridge.js scan the built file).
// This file is not loaded on its own: device/build.py concatenates src/core.js + src/bridge.js into build/bridge.js
// (Max's js has no module loader). core.js sets the global ARACore in Max; under node with a `module` object the
// build's top-level `core` variable is used instead.
//
// Every top-level FUNCTION of a Max js file is an inlet message, so the logic lives inside one closure (ARABridge)
// and only the message handlers below are global. Nothing throws into Max: each handler is wrapped and shows the
// error text on the status outlet.
//
// ------------------------------------------------------------------------------------------------------------------
// INLET 0 (the only inlet), messages:
//   sendMelodyne                       read the detail clip, validate, launch a Melodyne job (window mode)
//   setGuide                           VocAlign: validate the detail clip as the guide and remember its region; at
//                                      sendVocAlign and again before placement the guide must still be the same clip at
//                                      the same place (position, trim, file) on its track's main lane
//   sendVocAlign                       VocAlign: validate the detail clip as the dub, launch the two-clip job
//   cancel                             cancel the running host (refused once the host is done)
//   settings <key> <value> [...]       any number of pairs: placement <takeLane|newTrack|replace|0|1|2>,
//                                      realign <0|1>     e.g. "settings placement newTrack realign 0"
//   placement <takeLane|newTrack|replace|0|1|2>   same as "settings placement ..." (live.menu index or symbol)
//   realign <0|1>                      same as "settings realign ..." (live.toggle; Melodyne only)
//   hostStarted|hostDone|hostStatus|hostError|hostPlugins|hostCopied <payload>
//                                      node.script's started/done/status/error/plugins/copied, through
//                                      [route started done status error plugins copied pong] and [prepend host...].
//                                      The payload (urlencoded JSON) is the LAST argument; a leading 'symbol' is skipped.
//   hostPong                           node.script's pong. Unused: the device never sends ping (liveness uses status);
//                                      kept so a pong is harmless (it counts as "the runner is there")
//   nodeLifecycle <event ...>          node.script's lifecycle outlet (terminated, restarted, ...): a job that has not
//                                      reached placement is given up (the device becomes idle), liveness is re-checked
//   ready                              from live.thisdevice (through deferlow): LiveAPI is usable now
//   refreshPlugins                     ask the runner for BridgeHost --find-plugins again
//   uiRefresh                          from the HTML page (jweb) once it has loaded and bound its handlers: re-emits the
//                                      last status line (outlet 0) and the whole UI state (outlet 2: setting ... busy
//                                      cancel host plugins guide). Needed because Live restores the settings and js says
//                                      its first status lines before the page exists.
//   loadbang                           (Max calls it) resets the UI outlets
//   notifydeleted                      (Max calls it when the object is deleted) stops every Task; later messages are
//                                      ignored. Deleted while placing a replace result: the original is on the muted
//                                      backup track (posted to the Max window)
//   A leading 'symbol' atom is skipped for settings/placement/realign too.
// OUTLETS:
//   0  status text: ONE symbol for a comment/textedit (the patch puts [prepend set] in front)
//   1  to node.script: launch <urlencoded {job, mode}> | cancel | findplugins | status
//                      | copyresult <urlencoded {jobId, from, to}>
//   2  UI state: busy <0|1> | cancel <0|1> (a job can be cancelled) | plugins <melodyne 0|1> <vocalign 0|1>
//      | host <0|1> | guide <0|1> | setting <placement 0-2|skip|preview|sync> <value> (only on uiRefresh).
//      Goes to the HTML page ONLY, never to a live.* object (greying live.* objects made a button fire by itself);
//      busy changes are logged in device.log ('ui busy 0|1').
//
// SEND DEBOUNCE. sendMelodyne/sendVocAlign within 1500 ms of the end of a job or of the previous accepted Send are
// ignored ("Ignored a repeated Send click." followed by the previous status line).
// DIAGNOSTICS. ~/Library/Application Support/ARABridge/device.log (rotated to device.log.1 above ~200 KB) gets one line
// per inlet message (name and a payload summary), per launch, retry and finish, and per busy change of the UI.
//
// LIVENESS. On ready the device sends `status` every 2 s until any host* message arrives, then `findplugins`.
// Sends are refused until then. A launch without started/error within 10 s, a cancel without done within 15 s and
// a copyresult without copied/error within 30 s give the device back (or place the job's file, for the copy).
//
// FLOW. Send: read live_set view detail_clip, its track (canonical_parent; a TakeLane parent is walked up to its
// Track), live_set tempo; core.validateClip with the device state (busy, no host, plug-in not found); refuse clips that
// are not on the track's main lane; core.buildJob; outlet `launch` (never a hostPath). The runner answers started
// (status line), status (cancelling), error (with this job's id: the job is over, no done follows) and exactly one
// done. On done: core.interpretResult (resultJson null = crashed); for ok the result file must exist with at least
// 44 + frames x 4 bytes; the runner copies it into <support>/results (see RESULT FILE); then the source track is found
// again by its LOM id (indices move), tempo and the main-lane clips are re-read, core.planPlacement builds the ops and
// the sequencer below executes them.
// VocAlign jobs ask for output 'guide': the host's result.wav starts at the guide clip's arrangement position, so the
// result clip goes to the guide's start (placeAtBeats = the guide region's startBeats, in every placement mode, on the
// dub's track; replace removes the dub). Only a result with placeAt 'guide' is placed there: a host that does not
// know the key (an older BridgeHost) returns a result that starts at the dub, which is placed at the dub as before
// and the status line asks for a host update.
//
// SEQUENCER. One op per Task tick. Mutating calls are followed by re-reads every SETTLE_MS (300 ms) until the change
// is visible (at most CONFIRM_TRIES reads); new objects are identified by diffing the target's id list (the returned
// id is preferred when it is listed) and remembered under the op's `produces` name; ids, never paths, are kept
// across steps. A vanished id on a target list is a failure. verify ops re-read Live (VERIFY_TRIES reads).
// Guards: create_audio_clip is never run on the source track's main lane; set/delete ops only act on objects this
// sequence produced, except the plan's single destructive delete of the source clip; a produced track is only deleted
// when every clip on it (main lane and lanes) was produced by this sequence.
// ROLLBACK (core.js contract). Failure before the destructive op: delete the produced objects in reverse (a clip on
// a produced track goes with its track; Live's LOM has no call that deletes a take lane, so an empty lane stays and
// the status says so). Failure at or after it: run rollbackAfter. A failed destructive delete is decided only after a
// full settle: the source still listed -> "before" rule; gone -> rollbackAfter; unreadable -> delete nothing and show
// onRestoreFailure.message. If the restore or its verify fails, rollbackAfter stops: nothing in onRestoreFailure.keep
// (nothing at all) is deleted and onRestoreFailure.message is shown.
//
// RESULT FILE. The runner copies <job>/result.wav to <support>/results/<jobid>.wav (core.uniqueName; exclusive create,
// a copy-exists error moves on to the next name). If the copy fails the clip uses result.json's resultPath exactly as
// given (the runner never deletes job folders) and the status line says so.
//
// Load-time overrides (tests only, like the probe's): ARABRIDGE_LAUNCH_MODE ('window' default, 'headless'),
// ARABRIDGE_SETTLE_MS. js functions are never named error or status (Max js reserves/confuses them).
// ------------------------------------------------------------------------------------------------------------------

autowatch = 0;
inlets = 1;
outlets = 3;

var ARABridge = (function (maxThis) {
    'use strict';

    var C = (typeof ARACore !== 'undefined' && ARACore) ? ARACore : core;

    // ------------------------------------------------------------------------------------------ constants
    var SETTLE_MS = (typeof ARABRIDGE_SETTLE_MS !== 'undefined') ? ARABRIDGE_SETTLE_MS : 300;
    var LAUNCH_MODE = (typeof ARABRIDGE_LAUNCH_MODE !== 'undefined') ? ARABRIDGE_LAUNCH_MODE : 'window';
    var CONFIRM_TRIES = 5;          // re-reads after a mutating call before it counts as "did not take effect"
    var VERIFY_TRIES = 3;           // re-reads of a verify op before it fails
    var MAX_TICKS = 400;            // hard cap per placement sequence
    var FAST_MS = 40;               // preview and cleanup sequences re-read this often (Live usually answers at once); 6x the tries
    var LAUNCH_ACK_MS = 10000;      // no started/error after launch: the runner is not there
    var CANCEL_WATCH_MS = 15000;    // cancel sent, no done: give the device back
    var COPY_WATCH_MS = 30000;      // copyresult sent, no copied/error: place the job's result.wav
    var MAX_PAYLOAD = 30000;        // launch payload limit of the runner contract (encoded characters)
    var BUSY_RETRY_WINDOW_MS = 3000;  // a runner `busy` this soon after a launch is retried once...
    var BUSY_RETRY_DELAY_MS = 1500;   // ...after this delay
    var SEND_DEBOUNCE_MS = 1500;      // a Send this soon after a job ended or after the previous Send is ignored
    var MSG_IGNORED = 'Ignored a repeated Send click.';
    var HELLO_MS = 2000;            // `status` probe interval while node.script is starting
    var HELLO_TRIES = 15;
    var STATUS_MAX = 240;
    var PLACEMENTS = ['takeLane', 'newTrack', 'replace'];
    var CLIP_PROPS = ['name', 'file_path', 'is_audio_clip', 'is_arrangement_clip', 'start_marker', 'end_marker',
        'start_time', 'end_time', 'length', 'warping', 'warp_mode', 'gain', 'gain_display_string', 'pitch_coarse',
        'pitch_fine', 'looping', 'loop_start', 'loop_end', 'sample_length', 'sample_rate', 'muted'];
    var TEXT_PROPS = ['name', 'file_path', 'gain_display_string'];
    var TRACK_PROPS = ['name', 'is_frozen', 'can_be_frozen', 'mute', 'has_audio_input', 'has_midi_input'];
    var LABELS = { melodyne: 'Melodyne', vocalign: 'VocAlign' };

    // ------------------------------------------------------------------------------------------ state
    var S = {
        ready: false,             // live.thisdevice fired
        runnerAlive: false,       // any host* message arrived (the runner answered)
        helloTries: 0,
        hostMissing: null,        // true after an error no-host, false after a plugins reply
        plugins: { melodyne: null, vocalign: null },   // true/false from --find-plugins, null = unknown
        placement: 'takeLane',
        realign: true,
        preview: false,           // "Live preview" toggle (Melodyne): the next job asks the host for previews
        sync: false,              // "Sync transport" toggle (Melodyne): the next job follows Live's transport
        pv: null,                 // the preview track and clip in the Live set {trackId, clipId, n}, made by this device
        guide: null,              // {region, clipId, trackId, name}
        job: null,                // the one job of this device (busy while non-null)
        run: null,                // the placement sequence
        lastId: '',
        lastSendAt: null,         // now() of the last accepted Send (launch)
        lastFinishAt: null,       // now() of the last finishJob
        lastLine: '',             // the last status line other than the debounce note
        cancelable: false,        // last value sent as `ui cancel`
        retryFor: null,           // job id a busy retry is scheduled for
        announce: false           // the next plugins/no-host reply goes to the status line (startup, Refresh)
    };

    // ------------------------------------------------------------------------------------------ small helpers
    function isArr(v) { return Object.prototype.toString.call(v) === '[object Array]'; }
    function isObj(v) { return v !== null && typeof v === 'object' && !isArr(v); }
    function isStr(v) { return typeof v === 'string'; }
    function errText(e) { return (e && e.message) ? String(e.message) : String(e); }
    function indexOfVal(list, v) { if (!list) return -1; for (var i = 0; i < list.length; i++) if (list[i] === v) return i; return -1; }
    function has(list, v) { return indexOfVal(list, v) >= 0; }
    function diff(a, b) {   // elements of b that are not in a
        var out = [];
        if (!b) return out;
        for (var i = 0; i < b.length; i++) if (!has(a, b[i])) out.push(b[i]);
        return out;
    }
    function fmt(v, d) { return (typeof v === 'number' && isFinite(v)) ? v.toFixed(d === undefined ? 3 : d) : '?'; }
    function two(n) { return n < 10 ? '0' + n : String(n); }

    function log(s) { try { post('ARABridge: ' + s + '\n'); } catch (e) { /* ignore */ } }

    // One symbol for a comment: one line, capped, no backslashes or braces. Commas and semicolons stay: the text
    // leaves as ONE symbol atom (outlet does not re-parse it).
    function sanitize(s) {
        var t = String(s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[\\{}]/g, ' ')
            .replace(/\s+/g, ' ').replace(/^ | $/g, '');
        if (t.length <= STATUS_MAX) return t;
        var n = STATUS_MAX;
        var c = t.charCodeAt(n - 1);
        if (c >= 0xD800 && c <= 0xDBFF) n--;   // never split a surrogate pair (emoji in a clip name)
        return t.substring(0, n);
    }
    function say(s) {
        log('status: ' + s);
        if (String(s).indexOf(MSG_IGNORED) !== 0) S.lastLine = String(s);
        dlog('status ' + s);
        try { outlet(0, sanitize(s)); } catch (e) { /* ignore */ }
    }

    // ------------------------------------------------------------------------------------------ diagnostics log
    // One line per inlet message and per launch/finish event in <support>/device.log, so a Live run shows which
    // message started a job. <support> = ~/Library/Application Support/ARABridge: from the js file's path or the
    // patcher's (/Users/<name>/...), corrected by the first job folder the runner reports. Classic js cannot create
    // folders: if the folder is missing the lines wait in memory (at most LOG_BUFFER) until it exists. Over LOG_MAX
    // bytes the log is copied to device.log.1 and started again. Every failure is ignored.
    var LOG_MAX = 200000;
    var LOG_BUFFER = 200;
    var DL = { dir: null, guessed: false, pending: [], busy: false };

    function now() { return (typeof ARABRIDGE_NOW === 'function') ? ARABRIDGE_NOW() : new Date().getTime(); }
    function stamp() { try { return new Date().toISOString(); } catch (e) { return String(new Date()); } }

    function guessSupportDir() {
        if (typeof ARABRIDGE_SUPPORT_DIR !== 'undefined') return ARABRIDGE_SUPPORT_DIR;
        var paths = [];
        try { if (typeof jsarguments !== 'undefined' && jsarguments.length) paths.push(String(jsarguments[0])); } catch (e) { /* ignore */ }
        try { paths.push(String(maxThis.patcher.filepath)); } catch (e2) { /* ignore */ }
        for (var i = 0; i < paths.length; i++) {
            var m = /(?:^|:)(\/Users\/[^\/]+)\//.exec(paths[i]);
            if (m && m[1] !== '/Users/Shared') return m[1] + '/Library/Application Support/ARABridge';   // the package lives in /Users/Shared
        }
        return null;
    }
    function learnSupportDir(jobDir, id) {
        if (!isStr(jobDir)) return;
        var dir = jobDir.replace(/\/+$/, '');
        var tail = '/jobs/' + id;
        if (dir.length > tail.length && dir.substring(dir.length - tail.length) === tail) {
            var sup = dir.substring(0, dir.length - tail.length);
            if (sup !== DL.dir) { DL.dir = sup; dlog('log folder ' + sup); }
        }
    }
    // Files are written as pure ASCII (every char >= 0x7f as \\uXXXX): Max's readstring/writestring count bytes, so a
    // multi-byte character split at a 2000-byte chunk boundary cannot corrupt a path or a name.
    function ascii(text) {
        return String(text).replace(/[\u007f-\uffff]/g, function (c) {
            var h = c.charCodeAt(0).toString(16);
            while (h.length < 4) h = '0' + h;
            return '\\u' + h;
        });
    }
    function writeChunks(f, text) { for (var i = 0; i < text.length; i += 2000) f.writestring(text.substring(i, i + 2000)); }
    function readAll(f) {
        var out = '';
        f.position = 0;
        for (var n = 0; n < 1000 && f.position < f.eof; n++) {
            var part = f.readstring(2000);
            if (!part) break;
            out += part;
        }
        return out;
    }
    function rotate(path) {
        var r = new File(path, 'read');
        if (!r.isopen) return;
        var text = readAll(r);
        r.close();
        var old = new File(path + '.1', 'write', 'TEXT');
        if (old.isopen) { old.position = 0; old.eof = 0; writeChunks(old, text); old.close(); }
    }
    function dlog(text) {
        if (DL.busy) return;
        DL.busy = true;
        try {
            var line = ascii(stamp() + ' ' + (S.job ? S.job.id : '-') + ' ' + String(text).replace(/[\u0000-\u001f\u007f]/g, ' ').substring(0, 600)) + '\n';
            DL.pending.push(line);
            if (DL.pending.length > LOG_BUFFER) DL.pending.shift();
            if (!DL.dir && !DL.guessed) { DL.guessed = true; DL.dir = guessSupportDir(); }
            if (DL.dir) {
                var path = DL.dir + '/device.log';
                var f = new File(path, 'write', 'TEXT');
                if (f.isopen) {
                    if (f.eof > LOG_MAX) {
                        f.close();
                        rotate(path);
                        f = new File(path, 'write', 'TEXT');
                        if (f.isopen) { f.position = 0; f.eof = 0; }
                    }
                    if (f.isopen) {
                        f.position = f.eof;
                        writeChunks(f, DL.pending.join(''));
                        f.close();
                        DL.pending = [];
                    }
                }
            }
        } catch (e) { /* diagnostics only */ }
        DL.busy = false;
    }
    function summary(name, args) {
        if (/^host/.test(name) && name !== 'hostPong') {
            var list = noSymbol(args);
            var d = null;
            try { d = list.length ? decode(list[list.length - 1]) : null; } catch (e) { d = null; }
            if (!isObj(d)) return '(unreadable payload)';
            var parts = [];
            if (d.jobId !== undefined) parts.push('jobId=' + d.jobId);
            if (d.state !== undefined) parts.push('state=' + d.state);
            if (d.code !== undefined) parts.push('code=' + d.code);
            if (isObj(d.resultJson)) parts.push('result=' + d.resultJson.status);
            else if (name === 'hostDone') parts.push('result=none');
            if (d.exitCode !== undefined) parts.push('exit=' + d.exitCode);
            if (d.to !== undefined) parts.push('to=' + d.to);
            if (isStr(d.message)) parts.push('message=' + d.message.substring(0, 160));
            return parts.join(' ');
        }
        var a = [];
        for (var i = 0; i < args.length; i++) a.push(String(args[i]));
        return a.join(' ').substring(0, 200);
    }
    function ui() {
        var a = Array.prototype.slice.call(arguments);
        try {
            if (a.length === 2) outlet(2, a[0], a[1]);
            else if (a.length === 3) outlet(2, a[0], a[1], a[2]);
        } catch (e) { /* ignore */ }
    }
    function toRunner(selector, obj) {
        try {
            if (obj === undefined) outlet(1, selector);
            else outlet(1, selector, encodeURIComponent(JSON.stringify(obj)));
        } catch (e) { log('outlet to runner failed: ' + errText(e)); }
    }
    function decode(payload) { return JSON.parse(decodeURIComponent(String(payload))); }

    function newTask(fn) { return new Task(fn, maxThis); }
    function later(task, ms) { try { task.cancel(); } catch (e) { /* ignore */ } task.schedule(ms); }
    function stop(task) { try { task.cancel(); } catch (e) { /* ignore */ } }

    // ------------------------------------------------------------------------------------------ LiveAPI access
    function toPlain(v) {
        if (v === null || v === undefined) return null;
        if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
        if (typeof v.length === 'number') {
            var a = [];
            for (var i = 0; i < v.length; i++) a.push(toPlain(v[i]));
            return a;
        }
        try { return String(v); } catch (e) { return null; }
    }
    // A value from LiveAPI.get: [x] -> x. Text properties may come back as several atoms ("808 bass" -> [808, "bass"]):
    // joined with single spaces.
    function scalar(raw, text) {
        if (raw === null || raw === undefined) return null;
        if (!isArr(raw)) return raw;
        if (raw.length === 0) return null;
        if (raw.length === 1) return raw[0];
        if (!text) return raw;
        for (var i = 0; i < raw.length; i++) if (typeof raw[i] !== 'string' && typeof raw[i] !== 'number') return raw;
        return raw.join(' ');
    }
    function num(v) {
        v = scalar(v, false);
        if (typeof v === 'number') return isFinite(v) ? v : null;
        if (isStr(v) && /^\s*[+\-]?(\d+\.?\d*|\.\d+)([eE][+\-]?\d+)?\s*$/.test(v)) return parseFloat(v);
        return null;
    }
    function idsFrom(raw) {
        var out = [];
        if (!isArr(raw)) return null;
        for (var i = 0; i + 1 < raw.length; i++) {
            if (raw[i] === 'id') { var n = Number(raw[i + 1]); if (n > 0) out.push(n); i++; }
        }
        return out;
    }
    function newApi(p) { return new LiveAPI(null, p); }
    function apiById(id) { return newApi('id ' + id); }
    function apiId(a) { try { var n = Number(a.id); return n > 0 ? n : 0; } catch (e) { return 0; } }
    function apiType(a) { try { return String(a.type); } catch (e) { return ''; } }
    function getRaw(a, prop) { try { return toPlain(a.get(prop)); } catch (e) { return undefined; } }
    function getVal(a, prop, text) { var r = getRaw(a, prop); return r === undefined ? null : scalar(r, text); }
    function getNum(a, prop) { var r = getRaw(a, prop); return r === undefined ? null : num(r); }
    function getIds(a, prop) { var r = getRaw(a, prop); return r === undefined ? null : idsFrom(r); }
    function firstId(ret) { var ids = idsFrom(toPlain(ret)); return ids && ids.length ? ids[0] : 0; }

    // LiveAPI.call with a fixed arity (no apply on the native method), like the probe.
    function callN(a, fn, args) {
        try {
            var r;
            if (args.length === 0) r = a.call(fn);
            else if (args.length === 1) r = a.call(fn, args[0]);
            else if (args.length === 2) r = a.call(fn, args[0], args[1]);
            else if (args.length === 3) r = a.call(fn, args[0], args[1], args[2]);
            else throw new Error('too many arguments');
            return { ok: true, ret: toPlain(r) };
        } catch (e) {
            return { ok: false, error: errText(e) };
        }
    }
    function setProp(a, prop, value) {
        try { a.set(prop, value); return { ok: true }; } catch (e) { return { ok: false, error: errText(e) }; }
    }

    function fileStat(p) {
        try {
            var f = new File(p, 'read');
            var open = !!f.isopen;
            var size = null;
            // File.eof is the byte length of a file opened for reading. 0 or unreadable counts as "unknown" (the
            // runner's copied.bytes is the second check).
            if (open) { size = Number(f.eof); if (!(size > 0)) size = null; }
            try { f.close(); } catch (e0) { /* ignore */ }
            return { exists: open, size: size };
        } catch (e) { return { exists: false, size: null }; }
    }
    function fileExists(p) { return fileStat(p).exists; }

    // ------------------------------------------------------------------------------------------ reading the selection
    // -> {clipId, clip (raw props for core), track (raw), trackId, trackIndex, tempo, inLane, onMainLane}
    function readSelection() {
        var sel = { clipId: 0, clip: { id: 0 }, track: {}, trackId: 0, trackIndex: -1, tempo: null, inLane: false, onMainLane: false };
        var song = newApi('live_set');
        sel.tempo = getNum(song, 'tempo');
        var clip = newApi('live_set view detail_clip');
        sel.clipId = apiId(clip);
        if (!sel.clipId) return sel;
        var raw = { id: sel.clipId };
        for (var i = 0; i < CLIP_PROPS.length; i++) {
            var r = getRaw(clip, CLIP_PROPS[i]);
            raw[CLIP_PROPS[i]] = r === undefined ? null : scalar(r, has(TEXT_PROPS, CLIP_PROPS[i]));
        }
        sel.clip = raw;
        // The clip's track: canonical_parent is the Track for a main-lane clip; a take-lane clip's parent is the
        // TakeLane, whose parent is the Track.
        var pid = getIds(clip, 'canonical_parent');
        var parent = pid && pid.length ? apiById(pid[0]) : null;
        if (parent && apiType(parent) === 'TakeLane') {
            sel.inLane = true;
            var tp = getIds(parent, 'canonical_parent');
            parent = tp && tp.length ? apiById(tp[0]) : null;
        }
        if (parent && apiType(parent) === 'Track') {
            sel.trackId = apiId(parent);
            var tr = {};
            for (var k = 0; k < TRACK_PROPS.length; k++) {
                var tv = getRaw(parent, TRACK_PROPS[k]);
                tr[TRACK_PROPS[k]] = tv === undefined ? null : scalar(tv, TRACK_PROPS[k] === 'name');
            }
            sel.track = tr;
            sel.trackIndex = indexOfVal(getIds(song, 'tracks'), sel.trackId);
            sel.onMainLane = has(getIds(parent, 'arrangement_clips'), sel.clipId);
        }
        if (sel.trackIndex >= 0) raw.track_index = sel.trackIndex;
        return sel;
    }

    function isBusy() { return S.job !== null; }

    // Validation shared by the three buttons. -> {ok, sel, region} | {ok:false, reason}
    function check(plugin, role, extra) {
        if (!S.ready) return { ok: false, reason: 'The device is still starting. Try again in a moment.' };
        if (!S.runnerAlive) return { ok: false, reason: 'The device\'s Node script is not running yet. Try again in a moment.' };
        var sel = readSelection();
        var opts = { plugin: plugin, role: role, fileExists: fileExists, busy: role !== 'guide' && isBusy(),
            hostMissing: S.hostMissing === true, guide: extra && extra.guide ? extra.guide : null };
        if (S.plugins[plugin] === false) opts.pluginFound = false;
        var v = C.validateClip(sel.clip, sel.track, { tempo: sel.tempo }, opts);
        if (!v.ok) {
            if (v.code === 'no-host' || v.code === 'no-plugin') requestPlugins();
            return { ok: false, reason: v.reason, code: v.code };
        }
        if (sel.inLane || (sel.trackId && !sel.onMainLane)) {
            return { ok: false, reason: 'This clip is on a take lane. Select a clip on the track\'s main lane.' };
        }
        if (!sel.trackId || sel.trackIndex < 0) return { ok: false, reason: 'The clip\'s track could not be found.' };
        return { ok: true, sel: sel, region: v.region };
    }

    function jobClip(role, region) {
        return { role: role, path: region.path, startSec: region.startSec, endSec: region.endSec,
            startBeats: region.startBeats, name: region.name, sampleRate: region.sampleRate };
    }

    function newJobId() {
        var d = new Date();
        var stamp = d.getFullYear() + two(d.getMonth() + 1) + two(d.getDate()) + '-' + two(d.getHours()) +
            two(d.getMinutes()) + two(d.getSeconds());
        var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
        var id;
        do {
            var tail = '';
            for (var i = 0; i < 4; i++) tail += chars.charAt(Math.floor(Math.random() * chars.length));
            id = stamp + '-' + tail;
        } while (id === S.lastId);
        S.lastId = id;
        return id;
    }

    // ------------------------------------------------------------------------------------------ jobs
    var launchWatch = newTask(function () {
        try {
            if (S.job && S.job.phase === 'launching') {
                finishJob('The Node script did not answer. Reload the device and try again.');
            }
        } catch (e) { say('Error: ' + errText(e)); }
    });
    var cancelWatch = newTask(function () {
        try {
            if (S.job && S.job.phase !== 'placing') {
                finishJob('Cancel sent but the host did not report back. Check the job folder.');
            }
        } catch (e) { say('Error: ' + errText(e)); }
    });

    function setBusy(b) { dlog('ui busy ' + (b ? 1 : 0)); ui('busy', b ? 1 : 0); }
    function setCancelable(b) { S.cancelable = !!b; ui('cancel', b ? 1 : 0); }

    function launch(job, ctx) {
        var payload = { job: job, mode: LAUNCH_MODE };
        if (encodeURIComponent(JSON.stringify(payload)).length > MAX_PAYLOAD) {
            say('The job is too large to send (clip names or paths too long).');
            return;
        }
        S.job = ctx;
        ctx.id = job.id;
        S.lastSendAt = now();
        dlog('launch ' + job.id + ' plugin=' + job.plugin + ' placement=' + job.placement + ' realign=' + job.realign + (job.preview ? ' preview=1' : '') + (job.sync ? ' sync=1' : '') +
            (job.output ? ' output=' + job.output : '') +
            ' clip=' + job.clips[job.clips.length - 1].name);
        ctx.phase = 'launching';
        ctx.cancelRequested = false;
        ctx.payload = payload;
        ctx.realign = job.realign;
        ctx.busyRetried = false;
        ctx.busyWindowOpen = true;
        S.retryFor = null;
        setBusy(true);
        setCancelable(true);
        say('Starting ' + ctx.label + '...');
        toRunner('launch', payload);
        later(launchWatch, LAUNCH_ACK_MS);
        later(busyWindowTask, BUSY_RETRY_WINDOW_MS);
    }

    // Defensive: a runner that still counts an earlier, already reported job as running answers `error busy` to a
    // new launch. Within BUSY_RETRY_WINDOW_MS of the launch (and only once) the same launch is sent again after
    // BUSY_RETRY_DELAY_MS; only then is the busy message shown. The job id is reused: busy is refused before the
    // runner creates the job folder.
    var busyWindowTask = newTask(function () {
        try { if (S.job) S.job.busyWindowOpen = false; } catch (e) { say('Error: ' + errText(e)); }
    });
    var busyRetryTask = newTask(function () {
        try {
            var j = S.job;
            // only the job the retry was scheduled for, still launching (never a finished or a newer job)
            if (!j || j.phase !== 'launching' || j.id !== S.retryFor || !j.busyRetried) return;
            S.retryFor = null;
            if (j.cancelRequested) { finishJob('Cancelled. Nothing was changed.'); return; }
            log('launch ' + j.id + ' again after a busy answer');
            dlog('launch ' + j.id + ' again (busy retry)');
            toRunner('launch', j.payload);
            later(launchWatch, LAUNCH_ACK_MS);
        } catch (e) { say('Error: ' + errText(e)); }
    });

    var NO_SOUND = 'No sound? Choose your interface in the host window\'s Output menu.';
    var PLACEMENT_WORDS = { takeLane: 'take lane', newTrack: 'new track', replace: 'replace' };
    function openLine(j) {
        var place = 'placement: ' + (PLACEMENT_WORDS[j.placement] || String(j.placement));
        if (j.plugin === 'melodyne') {
            return 'Melodyne is open (timing correction: ' + (j.realign ? 'on' : 'off') + ', ' + place +
                (j.preview ? ', live preview: on' : '') + (j.sync ? ', transport sync: on' : '') + '). Edit, then press Apply in its window. ' +
                (j.sync ? 'Play, Stop and the position follow Live in both directions. ' : '') +
                (j.preview ? 'A Preview track appears below this track after each edit; mute this track to compare. ' : '') + NO_SOUND;
        }
        return 'VocAlign is open (' + place + '). Capture guide and dub, align, then press Apply. ' + NO_SOUND;
    }

    function finishJob(line) {
        restoreSource(S.job);
        if ((S.pv || (S.run && S.run.preview)) && S.job && !S.dead) { startPreviewCleanup(line); return; }
        dlog('finish ' + (S.job ? S.job.id + ' (' + S.job.phase + ')' : '-') + ': ' + (line || ''));
        S.lastFinishAt = now();
        S.retryFor = null;
        stop(launchWatch);
        stop(cancelWatch);
        stop(copyWatch);
        stop(busyWindowTask);
        stop(busyRetryTask);
        stop(syncTask);
        S.job = null;
        S.run = null;
        setBusy(false);
        setCancelable(false);
        if (line) say(line);
    }

    function sendMelodyne() {
        var c = check('melodyne', 'source');
        if (!c.ok) { say(c.reason); return; }
        var r = c.region;
        var b = C.buildJob({ id: newJobId(), plugin: 'melodyne', placement: S.placement, realign: S.realign, preview: S.preview, sync: S.sync,
            clips: [jobClip('source', r)], tempo: r.tempo, trackIndex: c.sel.trackIndex });
        if (!b.ok) { say('Could not build the job: ' + b.reason); return; }
        launch(b.job, { plugin: 'melodyne', label: 'Melodyne', region: r, clipId: c.sel.clipId, trackId: c.sel.trackId,
            tempo: r.tempo, placement: b.job.placement, preview: b.job.preview === true, sync: b.job.sync === true });
    }

    // What a clip is now: null when it is gone; onMainLane false when it is not on its track's main lane.
    function clipFacts(id) {
        var api = apiById(id);
        if (!apiId(api) || apiType(api) !== 'Clip') return null;
        var pid = getIds(api, 'canonical_parent');
        var parent = pid && pid.length ? apiById(pid[0]) : null;
        var onMain = !!(parent && apiType(parent) === 'Track' && has(getIds(parent, 'arrangement_clips'), id));
        return { onMainLane: onMain, start: getNum(api, 'start_time'), end: getNum(api, 'end_time'),
            loopStart: getNum(api, 'loop_start'), loopEnd: getNum(api, 'loop_end'), file: getVal(api, 'file_path', true) };
    }
    function closeTo(a, b, tol) { return a !== null && b !== null && Math.abs(a - b) <= tol; }
    // The guide is used by its remembered region: it must still be the same clip at the same place.
    function guideChanged(g) {
        var now = clipFacts(g.clipId);
        var was = g.facts;
        if (!now || !was || !now.onMainLane) return true;
        return !closeTo(now.start, was.start, 0.001) || !closeTo(now.end, was.end, 0.001) ||
            !closeTo(now.loopStart, was.loopStart, 0.002) || !closeTo(now.loopEnd, was.loopEnd, 0.002) || now.file !== was.file;
    }
    var MSG_GUIDE_CHANGED = 'The guide clip changed or was removed since Set guide. Set the guide again.';

    // ------------------------------------------------------------------------------------------ shared guide
    // Live shows only the selected track's devices, so the guide is usually set by the device on the guide track and
    // used by the device on the dub track. Set guide keeps it in memory AND writes <support>/guide.json (whole file
    // rewritten); Send to VocAlign reads guide.json and uses the newest of the two (setAt, then the in-memory one).
    // A missing, unreadable or other-format file counts as no guide. The re-check (guideChanged) applies to both.
    var GUIDE_FORMAT = 'arabridge-guide';
    function guidePath() {
        if (!DL.dir && !DL.guessed) { DL.guessed = true; DL.dir = guessSupportDir(); }
        return DL.dir ? DL.dir + '/guide.json' : null;
    }
    function newSetId() {
        var chars = 'abcdefghijklmnopqrstuvwxyz0123456789', t = '';
        for (var i = 0; i < 8; i++) t += chars.charAt(Math.floor(Math.random() * chars.length));
        return t;
    }
    function writeGuideFile(g) {
        try {
            var p = guidePath();
            if (!p) return false;
            var text = ascii(JSON.stringify(g));
            var f = new File(p, 'write', 'TEXT');
            if (!f.isopen) return false;
            f.position = 0;
            f.eof = 0;
            writeChunks(f, text);
            f.close();
            return true;
        } catch (e) { return false; }
    }
    function validGuide(g) {
        if (!isObj(g) || g.format !== GUIDE_FORMAT || g.version !== 1) return false;
        if (typeof g.setAt !== 'number' || !isStr(g.setId) || !(g.clipId > 0) || !isObj(g.region) || !isObj(g.facts)) return false;
        var r = g.region;
        return isStr(r.path) && typeof r.startSec === 'number' && typeof r.endSec === 'number' &&
            typeof r.startBeats === 'number' && typeof r.sampleRate === 'number' && typeof r.tempo === 'number';
    }
    function readGuideFile() {
        try {
            var p = guidePath();
            if (!p) return null;
            var f = new File(p, 'read');
            if (!f.isopen) return null;
            var text = readAll(f);
            f.close();
            var g = JSON.parse(text);
            return validGuide(g) ? g : null;
        } catch (e) { return null; }
    }
    // The guide to use now: the newest of memory and guide.json.
    function currentGuide() {
        var mem = S.guide, file = readGuideFile();
        if (!file) return mem;
        if (!mem) return file;
        if (file.setId === mem.setId) return mem;
        return file.setAt > mem.setAt ? file : mem;
    }

    function setGuide() {
        var c = check('vocalign', 'guide');
        if (!c.ok) { say(c.reason); return; }
        var facts = clipFacts(c.sel.clipId);
        if (!facts) { say('The guide clip could not be read. Select it again.'); return; }
        var trackName = c.sel.track && c.sel.track.name !== null && c.sel.track.name !== undefined ? String(c.sel.track.name) : '';
        var t = now();
        S.guide = { format: GUIDE_FORMAT, version: 1, setId: newSetId(), setAt: t, setAtIso: stamp(),
            region: c.region, clipId: c.sel.clipId, trackId: c.sel.trackId, trackName: trackName, name: c.region.name,
            tempo: c.region.tempo, facts: facts };
        var shared = writeGuideFile(S.guide);
        dlog('guide set ' + S.guide.setId + ' clip ' + c.sel.clipId + ' "' + c.region.name + '" on "' + trackName + '"' +
            (shared ? '' : ' (guide.json not written)'));
        if (!shared) log('guide.json could not be written: the guide is only known to this device');
        ui('guide', 1);
        say('Guide set: ' + (c.region.name || 'unnamed clip') + (trackName ? ' (' + trackName + ')' : '') +
            '. Now select the dub clip and press Send to VocAlign.' +
            (shared ? '' : ' (Only this device knows it: guide.json could not be written.)'));
    }

    function sendVocAlign() {
        var g = currentGuide();
        if (g && g !== S.guide) dlog('using the guide from guide.json ' + g.setId);
        var c = check('vocalign', 'dub', { guide: g ? g.region : null });
        if (!c.ok) { say(c.reason); return; }
        if (c.sel.clipId === g.clipId) { say('The dub is the guide clip. Select a different clip for the dub.'); return; }
        if (guideChanged(g)) { say(MSG_GUIDE_CHANGED); return; }
        if (!fileExists(g.region.path)) { say('The guide clip\'s audio file is missing. Set the guide again.'); return; }
        var r = c.region;
        var b = C.buildJob({ id: newJobId(), plugin: 'vocalign', placement: S.placement, realign: false, output: 'guide',
            clips: [jobClip('guide', g.region), jobClip('dub', r)], tempo: r.tempo, trackIndex: c.sel.trackIndex });
        if (!b.ok) { say('Could not build the job: ' + b.reason); return; }
        launch(b.job, { plugin: 'vocalign', label: 'VocAlign', region: r, clipId: c.sel.clipId, trackId: c.sel.trackId,
            tempo: r.tempo, placement: b.job.placement, guide: g });
    }

    function cancel() {
        var j = S.job;
        if (!j) { say('Nothing to cancel.'); return; }
        if (j.phase === 'placing' || j.phase === 'copying') { say('The result is being placed. Cancel is not possible now.'); return; }
        j.cancelRequested = true;
        toRunner('cancel');
        say('Cancelling...');
        later(cancelWatch, CANCEL_WATCH_MS);
    }

    // ------------------------------------------------------------------------------------------ runner messages
    // Liveness: `status` is sent until a hostStatus reply arrives (the runner answers status in every state).
    var helloTask = newTask(function () {
        try {
            if (S.runnerAlive) return;
            if (S.helloTries >= HELLO_TRIES) {
                say('The device\'s Node script did not start. Reload the device.');
                return;
            }
            S.helloTries++;
            toRunner('status');
            later(helloTask, HELLO_MS);
        } catch (e) { say('Error: ' + errText(e)); }
    });

    function startHello() { S.helloTries = 0; later(helloTask, 0); }

    function runnerAlive() {
        if (S.runnerAlive) return;
        S.runnerAlive = true;
        stop(helloTask);
        S.announce = true;
        toRunner('findplugins');
        if (!isBusy()) say('Checking the host and plug-ins...');
    }

    function requestPlugins() { if (S.runnerAlive) toRunner('findplugins'); }

    function pluginsLine() {
        function one(name, v) { return name + ': ' + (v === true ? 'found' : (v === false ? 'not found' : 'unknown')) + '.'; }
        return one('Melodyne', S.plugins.melodyne) + ' ' + one('VocAlign', S.plugins.vocalign);
    }

    // host* messages: the payload is the LAST argument (a leading literal 'symbol' from Max is skipped).
    // -> the decoded object, or null (logged) when there is none or it does not parse.
    function payloadOf(name, args) {
        var list = [];
        for (var i = 0; i < args.length; i++) list.push(args[i]);
        if (list.length && list[0] === 'symbol') list.shift();
        if (!list.length) return null;
        var last = list[list.length - 1];
        try {
            var d = decode(last);
            if (isObj(d)) return d;
        } catch (e) { /* fall through */ }
        log(name + ': unreadable payload ' + String(last).substring(0, 200));
        return null;
    }

    function onPlugins(d) {
        runnerAlive();
        S.hostMissing = false;
        S.plugins.melodyne = !!(isObj(d.melodyne) && d.melodyne.found === true);
        S.plugins.vocalign = !!(isObj(d.vocalign) && d.vocalign.found === true);
        ui('host', 1);
        ui('plugins', S.plugins.melodyne ? 1 : 0, S.plugins.vocalign ? 1 : 0);
        if (!isBusy() && S.announce) say('Ready. ' + pluginsLine());
        S.announce = false;
    }

    function onStarted(d) {
        runnerAlive();
        var j = S.job;
        if (!j || d.jobId !== j.id) { log('started for another job ' + d.jobId); return; }
        stop(launchWatch);
        j.phase = 'running';
        j.jobDir = isStr(d.jobDir) ? d.jobDir : null;
        learnSupportDir(j.jobDir, j.id);
        if (j.cancelRequested) { toRunner('cancel'); say('Cancelling...'); later(cancelWatch, CANCEL_WATCH_MS); return; }
        stop(busyWindowTask);
        stop(busyRetryTask);
        say(openLine(j));
        if (j.sync) { j.syncSeq = 0; j.syncSentAt = 0; j.syncLast = null; j.syncVerify = null; later(syncTask, 0); }
    }

    function onStatus(d) {
        runnerAlive();
        var j = S.job;
        if (!j || j.phase === 'placing' || j.phase === 'copying') return;
        if (d.state === 'preview') { onPreview(d); return; }
        if (d.state === 'transport') { onSyncEvents(d); return; }
        if (d.state === 'cancelling') say('Cancelling...');
        else if (d.state === 'backstop') say('The host took too long and is being stopped.');
        // state idle with a job of ours: a done may still follow (the host exited, the grace wait runs); the cancel
        // watch gives the device back if it never comes.
    }

    function onError(d) {
        runnerAlive();
        var j = S.job;
        if (d.code === 'no-host') { S.hostMissing = true; ui('host', 0); }
        if (j && j.phase === 'copying' && (d.code === 'copy-failed' || d.code === 'copy-exists') &&
            (d.jobId === undefined || d.jobId === null || d.jobId === j.id)) {
            onCopyFailed(j, d);
            return;
        }
        var ours = j && j.phase !== 'placing' && j.phase !== 'copying' && (d.jobId === j.id ||
            (j.phase === 'launching' && (d.jobId === undefined || d.jobId === null) &&
                (d.code === 'bad-payload' || d.code === 'internal')));
        if (ours) {
            if (d.code === 'no-host') finishJob('BridgeHost is not installed. Run tools/install_host.sh, then try again.');
            else if (d.code === 'busy' && j.phase === 'launching' && j.busyWindowOpen && !j.busyRetried) {
                j.busyRetried = true;
                S.retryFor = j.id;
                dlog('runner busy for the new job: retry scheduled');
                log('runner busy for the new job ' + j.id + ': retrying once in ' + BUSY_RETRY_DELAY_MS + ' ms');
                later(busyRetryTask, BUSY_RETRY_DELAY_MS);
            }
            else if (d.code === 'busy') finishJob('The host is still busy with an earlier job. Wait for it to finish.');
            else finishJob('Could not start the host: ' + String(d.message || d.code));
            return;
        }
        log('runner error ' + d.code + ': ' + d.message);
        if (!isBusy() && S.announce && (d.code === 'no-host' || d.code === 'findplugins-failed')) {
            S.announce = false;
            if (d.code === 'no-host') say('BridgeHost is not installed. Run tools/install_host.sh, then press Refresh.');
            else say('Could not check the plug-ins: ' + String(d.message || ''));
        }
    }

    function onDone(d) {
        runnerAlive();
        var j = S.job;
        if (!j || d.jobId !== j.id) { log('done for another job ' + d.jobId + ' (ignored)'); return; }
        if (j.phase === 'placing' || j.phase === 'copying') { log('second done ignored'); return; }
        if (S.run && S.run.preview) { j.doneWaiting = d; log('done while a preview is being placed: waiting for it'); return; }
        restoreSource(j);       // the original is audible again before anything is placed
        stop(launchWatch);
        stop(cancelWatch);
        setCancelable(false);
        if (isStr(d.jobDir)) { j.jobDir = d.jobDir; learnSupportDir(j.jobDir, j.id); }
        if (d.spawnError) { finishJob('BridgeHost could not be started: ' + d.spawnError); return; }
        var res = C.interpretResult(d.resultJson, { exitCode: d.exitCode, signal: d.signal });
        if (res.kind !== 'ok') { finishJob(res.statusLine); return; }
        var st = fileStat(res.resultPath);
        if (!st.exists) { finishJob('Failed: the result file is missing.'); return; }
        if (st.size !== null && st.size < 44 + res.frames * 4) { finishJob('Failed: the result file is incomplete.'); return; }
        j.result = res;
        j.resultFile = res.resultPath;
        startCopy(j);
    }

    // ------------------------------------------------------------------------------------------ result copy
    // The runner copies <job>/result.wav to <support>/results/<name>.wav (exclusive create): copyresult {jobId, from,
    // to} -> copied {ok, jobId, to, bytes} | error {code: copy-failed|copy-exists}. <support> is the job folder's
    // grandparent (<support>/jobs/<id>). If the copy cannot be made, the clip uses the job's result.wav (the runner
    // never deletes job folders) and the status line says so.
    var copyWatch = newTask(function () {
        try {
            var j = S.job;
            if (j && j.phase === 'copying') copyFallback(j, 'the copy did not report back');
        } catch (e) { say('Error: ' + errText(e)); }
    });

    function resultsDirOf(j) {
        var dir = isStr(j.jobDir) ? j.jobDir.replace(/\/+$/, '') : '';
        var tail = '/jobs/' + j.id;
        if (dir.length <= tail.length || dir.substring(dir.length - tail.length) !== tail) return null;
        return dir.substring(0, dir.length - tail.length) + '/results';
    }

    function startCopy(j) {
        j.phase = 'copying';
        if (!j.copyTaken) j.copyTaken = [];
        var dir = resultsDirOf(j);
        if (!dir) { copyFallback(j, 'the job folder is not in the ARA Bridge folder'); return; }
        var taken = j.copyTaken;
        var to = C.uniqueName(dir, j.id, function (p) { return has(taken, p) || fileExists(p); }, 'wav');
        if (!to) { copyFallback(j, 'no free file name in the results folder'); return; }
        j.copyTo = to;
        say('Copying the result...');
        toRunner('copyresult', { jobId: j.id, from: j.result.resultPath, to: to });
        later(copyWatch, COPY_WATCH_MS);
    }

    function onCopied(d) {
        runnerAlive();
        var j = S.job;
        if (!j || j.phase !== 'copying' || d.jobId !== j.id) { log('copied for another job ' + d.jobId + ' (ignored)'); return; }
        stop(copyWatch);
        if (d.ok !== true || !isStr(d.to) || d.to !== j.copyTo) { copyFallback(j, 'the copy reported a problem'); return; }
        // The runner verifies the copy against result.wav, so a short copy means result.wav itself is short.
        if (typeof d.bytes === 'number' && d.bytes < 44 + j.result.frames * 4) { finishJob('Failed: the result file is incomplete.'); return; }
        var st = fileStat(d.to);
        if (!st.exists) { copyFallback(j, 'the copied file cannot be found'); return; }
        if (st.size !== null && st.size < 44 + j.result.frames * 4) { finishJob('Failed: the result file is incomplete.'); return; }
        j.resultFile = d.to;
        beginPlacement(j);
    }

    function onCopyFailed(j, d) {
        stop(copyWatch);
        if (d.code === 'copy-exists' && j.copyTaken.length < 5) {
            j.copyTaken.push(j.copyTo);
            startCopy(j);
            return;
        }
        copyFallback(j, String(d.message || d.code));
    }

    function copyFallback(j, why) {
        stop(copyWatch);
        log('result not copied (' + why + '); using ' + j.result.resultPath);
        j.resultFile = j.result.resultPath;
        j.copyNote = 'the result stays in the job folder (' + why + ')';
        beginPlacement(j);
    }

    function beginPlacement(j) {
        j.phase = 'placing';
        say('Placing the result...');
        startPlacement(j, j.result);
    }

    // node.script's lifecycle outlet (terminated, restarted, ...): the runner and whatever it was doing are gone.
    function nodeLifecycle(args) {
        var what = args.length ? String(args[0]) : 'changed';
        log('node.script ' + what);
        S.runnerAlive = false;
        var j = S.job;
        if (j && j.phase === 'copying') {
            copyFallback(j, 'the Node script stopped');
        } else if (j && j.phase !== 'placing') {
            finishJob('The Node script stopped (' + what + '). A running host keeps its result in its job folder.');
        } else if (!j) {
            say('The Node script stopped (' + what + '). Waiting for it...');
        }
        if (S.ready) startHello();
    }

    // ------------------------------------------------------------------------------------------ placement
    function keptLine(j) { log('the result file is kept: ' + (j.resultFile || (j.result ? j.result.resultPath : '?'))); }

    function startPlacement(j, res) {
        var song = newApi('live_set');
        var trackIndex = indexOfVal(getIds(song, 'tracks'), j.trackId);
        if (trackIndex < 0) {
            keptLine(j);
            finishJob('Not placed: the source track was deleted while the host was open. Nothing was changed.');
            return;
        }
        var tempo = getNum(song, 'tempo');
        if (tempo === null || Math.abs(tempo - j.tempo) > 1e-6) {
            keptLine(j);
            finishJob('Not placed: the song tempo changed while the host was open. Nothing was changed.');
            return;
        }
        if (j.plugin === 'vocalign' && (!j.guide || guideChanged(j.guide))) {
            keptLine(j);
            finishJob('Not placed: the guide clip changed or was removed while the host was open. Nothing was changed.');
            return;
        }
        var track = apiById(j.trackId);
        var ids = getIds(track, 'arrangement_clips');
        if (ids === null) { keptLine(j); finishJob('Not placed: the clips on the track could not be read. Nothing was changed.'); return; }
        var existing = [];
        for (var i = 0; i < ids.length; i++) {
            var c = apiById(ids[i]);
            existing.push({ id: ids[i], start_time: getNum(c, 'start_time'), end_time: getNum(c, 'end_time') });
        }
        // VocAlign: the result starts at the guide when the host says so (placeAt); region stays the dub (stale checks)
        var placeAtBeats = null;
        if (j.plugin === 'vocalign' && res.placeAt === 'guide') {
            placeAtBeats = j.guide.region.startBeats;
        } else if (j.plugin === 'vocalign') {
            log('the host did not place the result at the guide (an older BridgeHost?); it goes to the dub\'s position');
            j.placeNote = 'placed at the dub, not the guide: update BridgeHost (tools/install_host.sh)';
        }
        dlog('place ' + j.id + ' mode=' + j.placement + ' at=' + (placeAtBeats !== null ? 'guide ' + fmt(placeAtBeats) : 'source ' + fmt(j.region.startBeats)) +
            ' frames=' + res.frames + (res.droppedFrames ? ' dropped=' + res.droppedFrames : ''));
        var plan = C.planPlacement({ mode: j.placement, region: j.region, result: { frames: res.frames, sampleRate: res.sampleRate },
            tempo: tempo, trackIndex: trackIndex, sourceClipId: j.clipId, resultFile: j.resultFile, pluginLabel: j.label,
            existingClips: existing, placeAtBeats: placeAtBeats });
        if (!plan.ok) { keptLine(j); finishJob('Not placed: ' + plan.reason + '.'); return; }
        var pv = S.pv;
        if (pv) {   // the Preview tracks go first; a failure to remove them is only a note
            plan.ops = removalOps(pv).concat(plan.ops);
        }
        S.run = {
            job: j, mode: j.placement, tempo: tempo, trackId: j.trackId, sourceClipId: j.clipId,
            ops: plan.ops, rollbackAfter: plan.rollbackAfter, onRestoreFailure: plan.onRestoreFailure,
            list: plan.ops, i: 0, phase: 'main', produced: {}, order: [], pending: null, ticks: 0,
            destructive: 'not-run', failure: null, warnings: [], leftovers: [], laneLeft: false
        };
        if (pv) { seedSlots(S.run, pv); S.pv = null; }
        later(seqTask, 0);
    }

    // ------------------------------------------------------------------------------------------ transport sync
    // Live is the master. While a sync job runs (the host window is open) this device reports Live's play state and
    // position to the host (through the runner) and applies what the host reports back (Play, Stop or a click in
    // Melodyne's time ruler) to Live. Positions are seconds from the start of the clip region (hostcore/SyncFollow.h).
    // Live's own Song.current_song_time / is_playing are polled every SYNC_MS (the Live API is not sample accurate: the host
    // follows with a silent playback, it does not need more); a playing Live is reported every SYNC_PLAY_MS so that the
    // host can correct drift, a stopped one when its position changes, and everything at least once a second.
    var SYNC_MS = (typeof ARABRIDGE_SYNC_MS !== 'undefined') ? ARABRIDGE_SYNC_MS : 40;
    var SYNC_PLAY_MS = 100;
    var SYNC_HEARTBEAT_MS = 1000;
    var SYNC_VERIFY_MS = 250;
    var syncTask = newTask(function () {
        try { syncTick(); } catch (e) { log('sync: ' + errText(e)); }
    });

    function syncTick() {
        var j = S.job;
        if (S.dead || !j || !j.sync || j.phase !== 'running') return;   // the loop ends with the job
        var song = newApi('live_set');
        var tempo = getNum(song, 'tempo');
        var playing = getNum(song, 'is_playing');
        var t = getNum(song, 'current_song_time');
        if (tempo !== null && Math.abs(tempo - j.tempo) > 1e-6) {
            if (!j.syncTempoNoted) { j.syncTempoNoted = true; j.syncLast = null; say('Transport sync is paused: the song tempo changed.'); }
        } else if (playing !== null && t !== null) {
            j.syncTempoNoted = false;
            var pos = (t - j.region.startBeats) * 60 / j.tempo;
            var isPlaying = playing === 1;
            var at = now();
            var last = j.syncLast;
            var due = !last || last.playing !== isPlaying || at - j.syncSentAt >= SYNC_HEARTBEAT_MS ||
                (isPlaying ? at - j.syncSentAt >= SYNC_PLAY_MS : abs(last.pos - pos) > 0.0005);
            if (due) {
                j.syncLast = { playing: isPlaying, pos: pos };
                j.syncSentAt = at;
                toRunner('transport', { jobId: j.id, seq: ++j.syncSeq, posSec: pos, playing: isPlaying });
            }
            checkSyncStart(j, song, isPlaying, t, at);
        }
        later(syncTask, SYNC_MS);
    }
    function abs(x) { return x < 0 ? -x : x; }

    // After a start requested by the host: Live has to be playing at about the requested position. Live's own start
    // semantics (play from the insert marker or from where it stopped) are not assumed: what is wrong is corrected once.
    function checkSyncStart(j, song, isPlaying, t, at) {
        var v = j.syncVerify;
        if (!v || at < v.at) return;
        j.syncVerify = null;
        var wantBeats = v.beats + (at - v.started) / 1000 * j.tempo / 60;
        if (!isPlaying) { callN(song, 'continue_playing', []); log('sync: Live was not playing after the start request; started again'); return; }
        if (abs(t - wantBeats) > 0.25 * j.tempo / 60) {
            setProp(song, 'current_song_time', wantBeats);
            log('sync: moved Live to the requested position (it was at ' + fmt(t) + ' beats, wanted ' + fmt(wantBeats) + ')');
        }
    }

    function onSyncEvents(d) {
        var j = S.job;
        if (!j || !j.sync || j.phase !== 'running' || d.jobId !== j.id || !isArr(d.events)) return;
        for (var i = 0; i < d.events.length; i++) {
            var e = d.events[i];
            if (isObj(e) && typeof e.posSec === 'number' && isFinite(e.posSec)) applySyncEvent(j, e);
        }
    }

    function applySyncEvent(j, e) {
        var song = newApi('live_set');
        var beats = j.region.startBeats + e.posSec * j.tempo / 60;
        if (beats < 0) beats = 0;
        if (e.kind === 'stop') {
            callN(song, 'stop_playing', []);
        } else if (e.kind === 'seek') {
            setProp(song, 'current_song_time', beats);
        } else if (e.kind === 'start') {
            setProp(song, 'current_song_time', beats);
            callN(song, 'continue_playing', []);
            j.syncVerify = { beats: beats, started: now(), at: now() + SYNC_VERIFY_MS };
        } else {
            return;
        }
        j.syncSentAt = 0;           // report Live's new state at once
        dlog('sync event ' + e.kind + ' at ' + fmt(e.posSec) + ' s -> ' + fmt(beats) + ' beats');
    }

    // ------------------------------------------------------------------------------------------ live preview
    // The host renders again after every edit and publishes preview-<n>/ in the job folder; the runner reports each as a
    // `status` message with state "preview". Each one goes onto a Preview track made by this device, right below the
    // source track: the first creates the track, later ones replace the clip on it. Live itself plays that clip, so it
    // is in sync with every other track. Nothing is ever created on, or removed from, the user's own tracks. The
    // track and clip are removed when the job ends (Apply: before the result is placed; Cancel and failures: by the
    // cleanup sequence in finishJob), and a failed preview rolls back like a placement. The sequences use the same
    // executor as the placement (run.preview / run.cleanup mark them).
    // Two Preview tracks A and B take turns (core.js, planPlacement mode 'preview'): S.pv = {slots: [A, B], active, n} with
    // slot = {trackId, clipId} or null, active = the audible slot (-1 none). While a preview exists the source CLIP (not
    // its track: other clips on it keep playing) is muted by this device and unmuted again before the result is placed
    // or when the job ends, whatever way it ends (restoreSource).
    function slotHasClip(s) {
        if (!s || !s.clipId) return false;
        var ids = clipList(apiById(s.trackId));
        return ids !== null && has(ids, s.clipId);
    }

    function removalOps(pv) {
        var ops = [], i;
        for (i = 0; i < 2; i++) {
            if (pv.slots[i] && pv.slots[i].clipId) {
                ops.push({ op: 'delete_clip', target: 's' + i + 't', label: 'Removing the preview', args: [{ ref: 's' + i + 'c' }],
                    optional: true, optionalNote: 'a preview clip could not be removed; delete the Preview tracks by hand' });
            }
        }
        for (i = 0; i < 2; i++) {
            if (pv.slots[i]) {
                ops.push({ op: 'delete_track', target: 'song', label: 'Removing the preview track', args: [{ ref: 's' + i + 't' }],
                    optional: true, optionalNote: 'a Preview track could not be removed; delete it by hand' });
            }
        }
        return ops;
    }

    function seedSlot(run, tname, cname, slot) {
        if (!slot) return;
        produce(run, tname, 'track', slot.trackId, null, 0).seeded = true;
        if (slot.clipId) produce(run, cname, 'clip', slot.clipId, tname, slot.trackId).seeded = true;
    }
    function seedSlots(run, pv) {
        seedSlot(run, 's0t', 's0c', pv.slots[0]);
        seedSlot(run, 's1t', 's1c', pv.slots[1]);
    }

    function muteSource(j) {
        if (!j || j.srcMuted) return;
        var c = apiById(j.clipId);
        var cur = getNum(c, 'muted');
        if (cur === null) { log('the source clip\'s mute state cannot be read'); return; }
        if (cur === 1) return;   // muted by the user already: left alone, and not unmuted later
        setProp(c, 'muted', 1);
        if (getNum(c, 'muted') === 1) { j.srcMuted = true; dlog('source clip muted'); }
        else log('the source clip could not be muted');
    }
    function restoreSource(j) {
        if (!j || !j.srcMuted) return;
        j.srcMuted = false;
        try {
            var c = apiById(j.clipId);
            if (getNum(c, 'muted') === 1) { setProp(c, 'muted', 0); dlog('source clip unmuted'); }
        } catch (e) { log('unmuting the source clip failed: ' + errText(e)); }
    }

    function newRun(j, extra) {
        var run = {
            job: j, mode: 'preview', tempo: j.tempo, trackId: j.trackId, sourceClipId: j.clipId,
            rollbackAfter: [], onRestoreFailure: null, i: 0, phase: 'main', produced: {}, order: [], pending: null, ticks: 0,
            destructive: 'not-run', failure: null, warnings: [], leftovers: [], laneLeft: false
        };
        for (var k in extra) if (extra.hasOwnProperty(k)) run[k] = extra[k];
        run.list = run.ops;
        return run;
    }

    function onPreview(d) {
        var j = S.job;
        if (!j || !j.preview || d.jobId !== j.id || j.phase !== 'running') return;
        var rj = d.resultJson;
        if (!isObj(rj) || rj.status !== 'ok' || !isStr(rj.resultPath) || !(rj.frames > 0) || !(rj.sampleRate > 0)) {
            log('preview ' + d.n + ' is not usable (ignored)');
            return;
        }
        var st = fileStat(rj.resultPath);
        if (!st.exists || (st.size !== null && st.size < 44 + rj.frames * 4)) { log('preview ' + d.n + ': the file is missing or incomplete (ignored)'); return; }
        j.pendingPreview = { n: d.n, res: rj, at: now() };
        if (!S.run) startPreview(j);   // else: when the running sequence ends (only the newest preview is kept)
    }

    function previewSkipped(j, why) {
        j.pendingPreview = null;
        say('No preview: ' + why + '.');
    }

    function startPreview(j) {
        var p = j.pendingPreview;
        j.pendingPreview = null;
        if (!p || S.run || j.phase !== 'running') return;
        var song = newApi('live_set');
        var tracks = getIds(song, 'tracks');
        var trackIndex = indexOfVal(tracks, j.trackId);
        if (trackIndex < 0) { previewSkipped(j, 'the source track was deleted'); return; }
        var tempo = getNum(song, 'tempo');
        if (tempo === null || Math.abs(tempo - j.tempo) > 1e-6) { previewSkipped(j, 'the song tempo changed'); return; }
        var slots = S.pv ? [S.pv.slots[0], S.pv.slots[1]] : [null, null];
        var active = S.pv ? S.pv.active : -1;
        for (var si = 0; si < 2; si++) {
            if (slots[si] && indexOfVal(tracks, slots[si].trackId) < 0) {
                log('the preview track ' + (si === 0 ? 'A' : 'B') + ' is gone');
                slots[si] = null;
                if (active === si) active = -1;
            }
        }
        var idleIdx = active === 0 ? 1 : 0;
        var idle = slots[idleIdx];
        var activeSlot = active >= 0 ? slots[active] : null;
        var idleHasClip = slotHasClip(idle);
        if (idle && idle.clipId && !idleHasClip) idle = slots[idleIdx] = { trackId: idle.trackId, clipId: null };
        var activeHasClip = slotHasClip(activeSlot);
        var plan = C.planPlacement({ mode: 'preview', region: j.region, result: { frames: p.res.frames, sampleRate: p.res.sampleRate },
            tempo: tempo, trackIndex: trackIndex, resultFile: p.res.resultPath, pluginLabel: 'preview',
            idle: { hasTrack: !!idle, hasClip: idleHasClip }, slotIndex: idleIdx, hasActive: !!activeSlot, activeHasClip: activeHasClip });
        if (!plan.ok) { previewSkipped(j, plan.reason); return; }
        dlog('preview ' + p.n + ' -> slot ' + (idleIdx === 0 ? 'A' : 'B') + (idle ? ' (track exists)' : ' (new track)') + ' frames=' + p.res.frames);
        S.run = newRun(j, { preview: true, previewN: p.n, previewAt: p.at, ops: plan.ops, idleIdx: idleIdx, activeIdx: activeSlot ? active : -1,
            slotsBefore: slots });
        seedSlot(S.run, 'idleTrack', 'idleClip', idle);
        seedSlot(S.run, 'activeTrack', 'activeClip', activeSlot);
        say('Updating the preview...');
        later(seqTask, 0);
    }

    function afterPreviewRun(j) {
        if (S.job !== j) return;
        if (j.doneWaiting) { var d = j.doneWaiting; j.doneWaiting = null; onDone(d); return; }
        if (j.pendingPreview) startPreview(j);
    }

    function endPreviewRun(run) {
        S.run = null;
        var j = run.job;
        var warn = run.warnings.length ? ' Note: ' + run.warnings.join('; ') + '.' : '';
        var slots = run.slotsBefore.slice();
        var it = run.produced.idleTrack, nc = run.produced.newClip;
        var at = run.produced.activeTrack, ac = run.produced.activeClip;
        if (run.phase === 'main') {
            if (it && !it.deleted && nc && !nc.deleted) {
                slots[run.idleIdx] = { trackId: it.id, clipId: nc.id };
                if (run.activeIdx >= 0) {
                    slots[run.activeIdx] = (at && !at.deleted) ? { trackId: at.id, clipId: (ac && !ac.deleted) ? ac.id : null } : null;
                }
                S.pv = { slots: slots, active: run.idleIdx, n: run.previewN };
                muteSource(j);
                dlog('preview ' + run.previewN + ' placed in ' + (now() - run.previewAt) + ' ms after the host published it');
                say('Preview ' + run.previewN + ' is playing from the Preview track; the original clip is muted until you apply or cancel.' + warn);
            } else {
                S.pv = run.activeIdx >= 0 ? { slots: slots, active: run.activeIdx, n: 0 } : null;
                if (!S.pv) restoreSource(j);
                say('The preview could not be placed.' + warn);
            }
        } else {
            // The rollback removed what this sequence made; the audible preview was never touched. What it had deleted
            // (the idle slot's old clip) is gone from the slot too.
            if (it && !it.seeded && it.deleted) slots[run.idleIdx] = null;
            else if (slots[run.idleIdx] && run.produced.idleClip && run.produced.idleClip.deleted) slots[run.idleIdx] = { trackId: slots[run.idleIdx].trackId, clipId: null };
            S.pv = (slots[0] || slots[1]) ? { slots: slots, active: run.activeIdx, n: 0 } : null;
            if (run.activeIdx < 0) { if (!S.pv) restoreSource(j); }
            var left = run.leftovers.length ? ' Check the track: ' + run.leftovers.join('; ') + '.' : '';
            say('No preview: ' + run.failure + '.' + left + warn);
        }
        afterPreviewRun(j);
    }

    // The job is ending (finishJob) while a preview exists: remove it first, then finish with the same line.
    function startPreviewCleanup(line) {
        var j = S.job;
        var ops = [];
        var pv = S.pv;
        var inflight = S.run;
        S.pv = null;
        j.phase = 'placing';            // no cancel, no second done, no watch fires while the cleanup runs
        stop(launchWatch);
        stop(cancelWatch);
        stop(copyWatch);
        var cleanup = newRun(j, { mode: 'cleanup', cleanup: true, line: line, ops: ops });
        if (pv) seedSlots(cleanup, pv);
        if (pv) ops = removalOps(pv);
        if (inflight && inflight.preview) {   // a preview sequence was cut short: what it made goes too
            for (var i = 0; i < inflight.order.length; i++) {
                var nm = inflight.order[i];
                var o = inflight.produced[nm];
                if (!o || o.deleted || isProducedId(cleanup, o.id)) continue;
                if (o.kind === 'track') produce(cleanup, 'x' + nm, 'track', o.id, null, 0);
                else if (o.kind === 'clip') produce(cleanup, 'x' + nm, 'clip', o.id, o.containerName ? 'x' + o.containerName : null, o.containerId);
            }
            for (var k in cleanup.produced) {
                if (!cleanup.produced.hasOwnProperty(k) || k.charAt(0) !== 'x') continue;
                var q = cleanup.produced[k];
                if (q.kind === 'clip') ops.push({ op: 'delete_clip', target: q.containerName, label: 'Removing the preview', args: [{ ref: k }],
                    optional: true, optionalNote: 'a preview clip could not be removed; delete the Preview tracks by hand' });
            }
            for (var k2 in cleanup.produced) {
                if (cleanup.produced.hasOwnProperty(k2) && k2.charAt(0) === 'x' && cleanup.produced[k2].kind === 'track') {
                    ops.push({ op: 'delete_track', target: 'song', label: 'Removing the preview track', args: [{ ref: k2 }],
                        optional: true, optionalNote: 'a Preview track could not be removed; delete it by hand' });
                }
            }
        }
        cleanup.ops = cleanup.list = ops;
        dlog('preview cleanup (' + ops.length + ' ops) before: ' + line);
        S.run = cleanup;
        say('Removing the preview...');
        later(seqTask, 0);
    }

    function endCleanup(run) {
        S.run = null;
        var note = run.warnings.length ? ' Note: ' + run.warnings.join('; ') + '.' : '';
        finishJob(run.line + note);
    }

    var seqTask = newTask(function () { tick(); });

    function tick() {
        var run = S.run;
        if (!run) return;
        try {
            if (++run.ticks > MAX_TICKS) { abortRun(run, 'the placement did not finish (internal step limit)'); return; }
            var gap = (run.preview || run.cleanup) ? FAST_MS : SETTLE_MS;
            if (run.pending) {
                var p = run.pending;
                p.tries++;
                var r;
                // A LiveAPI exception while re-reading is a failed read: the call has been made, so the object may
                // exist; keep re-reading (failing here would forget an object that rollback must remove).
                try { r = p.confirm(); } catch (ce) { log('re-read failed: ' + errText(ce)); r = null; }
                if (r === null) {
                    if (p.tries < p.maxTries) { later(seqTask, gap); return; }
                    try { r = p.exhausted(); } catch (xe) { r = { fail: 'internal error: ' + errText(xe), sourceGone: null }; }
                }
                run.pending = null;
                opDone(run, p.op, r);
                return;
            }
            if (run.i >= run.list.length) { endPhase(run); return; }
            var op = run.list[run.i];
            if (op.ifProduced && !alive(run, op.ifProduced)) { run.i++; later(seqTask, 0); return; }
            if (S.run === run) say(op.label + '...');
            var out = beginOp(run, op);
            if (out.pending) {
                run.pending = { op: op, confirm: out.pending.confirm, exhausted: out.pending.exhausted,
                    maxTries: (out.pending.maxTries || CONFIRM_TRIES) * (gap === FAST_MS ? 6 : 1), tries: 0 };
                if (gap === FAST_MS) {   // Live's calls are synchronous in practice: look once right away
                    var pp = run.pending;
                    pp.tries++;
                    var r0;
                    try { r0 = pp.confirm(); } catch (ce0) { r0 = null; }
                    if (r0 !== null) { run.pending = null; opDone(run, op, r0); return; }
                }
                later(seqTask, gap);
                return;
            }
            opDone(run, op, out);
        } catch (e) {
            log('exception in the placement: ' + (e && e.stack ? e.stack : e));
            run.pending = null;
            var cur = run.list[run.i] || { label: 'placement' };
            try { opDone(run, cur, { fail: 'internal error: ' + errText(e), sourceGone: null }); } catch (e2) {
                abortRun(run, 'internal error: ' + errText(e2));
            }
        }
    }

    // Give up without touching anything more (internal problems only).
    function abortRun(run, why) {
        S.run = null;
        if (run.cleanup) { finishJob(run.line + ' (removing the preview stopped: ' + why + '; delete the Preview track by hand)'); return; }
        if (run.preview) { S.pv = null; restoreSource(run.job); say('The preview stopped: ' + why + '. Check the Preview tracks.'); afterPreviewRun(run.job); return; }
        keptLine(run.job);
        var orf = run.onRestoreFailure;
        if (run.destructive !== 'not-run' && orf) finishJob(orf.message + ' (' + why + ')');
        else finishJob('Placement stopped: ' + why + '. Check the track.');
    }

    function alive(run, name) { var p = run.produced[name]; return !!(p && !p.deleted); }

    function opDone(run, op, r) {
        var failed = isObj(r) && r.fail !== undefined;
        if (isObj(r) && r.warn) run.warnings.push(r.warn);
        if (!failed) {
            if (op.destructive && run.phase === 'main') run.destructive = 'done';
            run.i++;
            later(seqTask, 0);
            return;
        }
        var why = op.label + ' failed (' + r.fail + ')';
        log(run.phase + ': ' + why);
        if (run.phase === 'main' && op.optional) {
            // cleanup after the verified result: a rollback would undo a good result
            run.warnings.push(op.optionalNote || (op.op === 'delete_track' ? 'the temporary scratch track could not be removed; delete it by hand' : why));
            run.i++;
            later(seqTask, 0);
            return;
        }
        if (run.phase === 'main') { startRollback(run, op, r, why); return; }
        if (run.phase === 'after' && (op.produces === 'restoredClip' || op.target === 'restoredClip')) {
            restoreFailed(run, why);
            return;
        }
        run.leftovers.push(why);
        run.i++;
        later(seqTask, 0);
    }

    function startRollback(run, op, r, why) {
        run.failure = why;
        var before = run.destructive === 'not-run' && !op.destructive;
        if (op.destructive) {
            if (r.sourceGone === false) before = true;
            else if (r.sourceGone === null || r.sourceGone === undefined) { restoreFailed(run, why + '; could not tell whether the original is still on the track'); return; }
            else run.destructive = 'done';
        }
        run.i = 0;
        if (before) {
            run.phase = 'before';
            run.list = rollbackBeforeOps(run);
        } else {
            run.phase = 'after';
            run.list = run.rollbackAfter;
        }
        log('rollback (' + run.phase + '): ' + run.list.length + ' ops');
        later(seqTask, SETTLE_MS);
    }

    function rollbackBeforeOps(run) {
        var out = [];
        for (var i = run.order.length - 1; i >= 0; i--) {
            var name = run.order[i];
            var p = run.produced[name];
            if (!p || p.deleted) continue;
            if (p.seeded && run.preview) continue;   // a failed preview never removes the audible one
            if (p.kind === 'clip') {
                // also on a produced track: if that track cannot be removed (say, the user dropped a clip on it), at
                // least our clip is gone
                out.push({ op: 'delete_clip', target: p.containerName || 'track', label: 'Removing the new clip', args: [{ ref: name }] });
            } else if (p.kind === 'track') {
                out.push({ op: 'delete_track', target: 'song', label: 'Removing the new track', args: [{ ref: name }] });
            } else if (p.kind === 'lane') {
                run.laneLeft = true;   // the LOM has no call that deletes a take lane
            }
        }
        return out;
    }

    function restoreFailed(run, why) {
        S.run = null;
        keptLine(run.job);
        var msg = run.onRestoreFailure ? run.onRestoreFailure.message : 'Something went wrong. Check the track.';
        finishJob(msg + ' (' + why + ')');
    }

    function endPhase(run) {
        if (run.cleanup) { endCleanup(run); return; }
        if (run.preview) { endPreviewRun(run); return; }
        S.run = null;
        var j = run.job;
        var notes = run.warnings.slice(0);
        if (j.copyNote) notes.push(j.copyNote);
        if (j.placeNote) notes.push(j.placeNote);
        var warn = notes.length ? ' Note: ' + notes.join('; ') + '.' : '';
        if (run.phase === 'main') {
            var line = j.result.statusLine;
            if (run.mode === 'replace') line += ' The original is on the muted backup track.';
            finishJob(line + warn);
            return;
        }
        keptLine(j);
        var left = run.leftovers.length ? ' Check the track: ' + run.leftovers.join('; ') + '.' : '';
        if (run.phase === 'before') {
            var what;
            if (left) what = (run.laneLeft ? ' An empty take lane was left.' : '') + left;
            else if (run.laneLeft) what = ' The set is unchanged except for an empty take lane.';
            else what = ' Nothing was changed.';
            finishJob('Not placed: ' + run.failure + '.' + what + warn);
        } else {
            finishJob('Not placed: ' + run.failure + '. The original clip was restored.' + left + warn);
        }
    }

    // ------------------------------------------------------------------------------------------ op execution
    // beginOp -> {fail, ...} | {} (done) | {pending: {confirm() -> null (wait) | result, exhausted() -> result}}

    function target(run, name) {
        if (name === 'song') return { name: name, kind: 'song', api: newApi('live_set'), id: 0 };
        if (name === 'track') return { name: name, kind: 'source', api: apiById(run.trackId), id: run.trackId };
        var p = run.produced[name];
        if (!p || p.deleted) return null;
        return { name: name, kind: p.kind, api: apiById(p.id), id: p.id, produced: p };
    }

    function argId(run, a) {
        if (!isObj(a)) return 0;
        if (a.ref === 'sourceClip') return Number(a.id) || 0;
        var p = run.produced[a.ref];
        return p && !p.deleted ? p.id : 0;
    }

    function produce(run, name, kind, id, containerName, containerId) {
        run.produced[name] = { kind: kind, id: id, containerName: containerName, containerId: containerId, deleted: false };
        run.order.push(name);
        return run.produced[name];
    }

    function producedName(run, id) {
        for (var k in run.produced) if (run.produced.hasOwnProperty(k) && run.produced[k].id === id) return k;
        return null;
    }
    function isProducedId(run, id) { return producedName(run, id) !== null; }

    // The clip list of a track (main lane) or a take lane.
    function clipList(api) { return getIds(api, 'arrangement_clips'); }

    // Choose the new object: the returned id if it is listed, otherwise the only new id, and then only if it looks like
    // what the call makes (expect(id) -> bool; a clip at the requested position with the requested file).
    function pick(retId, added, expect) {
        if (retId && has(added, retId)) return retId;
        if (!retId && added.length === 1 && (!expect || expect(added[0]))) return added[0];
        return 0;
    }

    function beginOp(run, op) {
        var fn = op.op;
        if (fn === 'create_take_lane') return opCreateLane(run, op);
        if (fn === 'create_audio_track') return opCreateTrack(run, op);
        if (fn === 'create_audio_clip' || fn === 'duplicate_clip_to_arrangement') return opPlaceClip(run, op);
        if (fn === 'set') return opSet(run, op);
        if (fn === 'delete_clip') return opDeleteClip(run, op);
        if (fn === 'delete_track') return opDeleteTrack(run, op);
        if (fn === 'verify') return opVerify(run, op);
        return { fail: 'unknown op ' + fn };
    }

    function opCreateLane(run, op) {
        var t = target(run, op.target);
        if (!t || t.kind !== 'source') return { fail: 'take lanes are only made on the source track' };
        var before = getIds(t.api, 'take_lanes');
        if (before === null) return { fail: 'the take lanes could not be read' };
        var r = callN(t.api, 'create_take_lane', []);
        var retId = r.ok ? firstId(r.ret) : 0;
        return { pending: {
            confirm: function () {
                var after = getIds(t.api, 'take_lanes');
                if (after === null) return null;
                var id = pick(retId, diff(before, after));
                if (!id) return null;
                produce(run, op.produces, 'lane', id, 'track', t.id);
                return r.ok ? {} : { fail: 'Live reported an error: ' + r.error };
            },
            exhausted: function () { return { fail: r.ok ? 'the new take lane did not appear' : r.error }; }
        } };
    }

    function opCreateTrack(run, op) {
        var song = newApi('live_set');
        var before = getIds(song, 'tracks');
        if (before === null) return { fail: 'the tracks could not be read' };
        var index = op.args[0];
        var r = callN(song, 'create_audio_track', [index]);
        var retId = r.ok ? firstId(r.ret) : 0;
        return { pending: {
            confirm: function () {
                var after = getIds(song, 'tracks');
                if (after === null) return null;
                var id = pick(retId, diff(before, after));
                if (!id || apiType(apiById(id)) !== 'Track') return null;
                produce(run, op.produces, 'track', id, null, 0);
                if (!r.ok) return { fail: 'Live reported an error: ' + r.error };
                var at = indexOfVal(after, id);
                return at === index ? {} : { warn: 'the new track is at position ' + (at + 1) + ', not ' + (index + 1) };
            },
            exhausted: function () { return { fail: r.ok ? 'the new track did not appear' : r.error }; }
        } };
    }

    // create_audio_clip (lane, new track, scratch track) and duplicate_clip_to_arrangement (backup track, source track)
    function opPlaceClip(run, op) {
        var dup = op.op === 'duplicate_clip_to_arrangement';
        var t = target(run, op.target);
        if (!t) return { fail: 'its target is missing' };
        if (!dup && (t.kind !== 'lane' && t.kind !== 'track')) {
            return { fail: 'refused: clips are never created on the main lane of an existing track' };
        }
        if (dup && t.kind !== 'track' && t.kind !== 'source') return { fail: 'clips are only duplicated onto tracks' };
        var before = clipList(t.api);
        if (before === null) return { fail: 'the clips on the target could not be read' };
        var r;
        if (dup) {
            var srcId = argId(run, op.args[0]);
            if (!srcId) return { fail: 'the clip to copy is missing' };
            r = callN(t.api, 'duplicate_clip_to_arrangement', ['id', srcId, op.args[1]]);
        } else {
            r = callN(t.api, 'create_audio_clip', [op.args[0], op.args[1]]);
        }
        var retId = r.ok ? firstId(r.ret) : 0;
        var lost = [];
        function expectClip(id) {
            var c = apiById(id);
            if (!closeTo(getNum(c, 'start_time'), op.args[1], 0.001)) return false;
            return dup || getVal(c, 'file_path', true) === op.args[0];
        }
        return { pending: {
            confirm: function () {
                var after = clipList(t.api);
                if (after === null) return null;
                var vanished = diff(after, before);
                for (var i = 0; i < vanished.length; i++) {
                    var mine = producedName(run, vanished[i]);
                    if (mine) run.produced[mine].deleted = true;   // one of ours was replaced (rollback restore)
                    else if (!has(lost, vanished[i])) lost.push(vanished[i]);
                }
                var id = pick(retId, diff(before, after), expectClip);
                if (!id) return null;
                if (apiType(apiById(id)) !== 'Clip') return null;
                produce(run, op.produces, 'clip', id, t.name, t.id);
                if (lost.length) return { fail: 'Live removed ' + lost.length + ' clip(s) where the new clip landed' };
                if (!r.ok) return { fail: 'Live reported an error: ' + r.error };
                return {};
            },
            exhausted: function () {
                if (lost.length) return { fail: 'Live removed ' + lost.length + ' clip(s) and no new clip appeared' };
                return { fail: r.ok ? 'the new clip did not appear' : r.error };
            }
        } };
    }

    var CRITICAL_PROPS = ['warping', 'mute'];

    function opSet(run, op) {
        var t = target(run, op.target);
        if (!t || !t.produced) return { fail: 'refused: only objects made by ARA Bridge are changed' };
        var r = setProp(t.api, op.property, op.value);
        var critical = has(CRITICAL_PROPS, op.property);
        function matches() {
            if (isStr(op.value)) return getVal(t.api, op.property, true) === op.value;
            var v = getNum(t.api, op.property);
            return v !== null && Math.abs(v - op.value) <= 1e-4;
        }
        return { pending: {
            confirm: function () { return matches() ? (r.ok || op.silent ? {} : { warn: op.property + ': Live reported ' + r.error }) : null; },
            exhausted: function () {
                var why = op.property + ' reads ' + String(getVal(t.api, op.property, true)) + (r.ok ? '' : ' (' + r.error + ')');
                if (op.silent) { log('optional ' + op.property + ' is not available: ' + why); return {}; }
                return critical ? { fail: why } : { warn: op.property + ' was not applied' };
            }
        } };
    }

    function opDeleteClip(run, op) {
        var a = op.args[0];
        var sourceDelete = !!(op.destructive && isObj(a) && a.ref === 'sourceClip');
        if (!sourceDelete && !(isObj(a) && run.produced[a.ref])) return { fail: 'refused: only clips made by ARA Bridge are removed' };
        if (sourceDelete && run.phase !== 'main') return { fail: 'refused: the source clip is only removed by the plan' };
        if (!sourceDelete && run.produced[a.ref].deleted) return {};
        var t = target(run, op.target);
        if (!t) return { fail: 'its track or lane is missing', sourceGone: false };
        var clipId = argId(run, a);
        // A take-lane clip is removed through the lane's track (Track.delete_clip); the lane is read to check.
        var callApi = t.kind === 'lane' ? apiById(t.produced.containerId) : t.api;
        var listApi = t.api;
        var before = clipList(listApi);
        if (before === null) return { fail: 'the clips could not be read', sourceGone: sourceDelete ? false : undefined };
        if (!has(before, clipId)) {
            if (sourceDelete) return { fail: 'the original clip is no longer on the track', sourceGone: false };
            run.produced[a.ref].deleted = true;
            return {};
        }
        var r = callN(callApi, 'delete_clip', ['id', clipId]);
        var lastRead = 'listed';
        return { pending: {
            confirm: function () {
                var now = clipList(listApi);
                if (now === null) { lastRead = 'unreadable'; return null; }
                if (has(now, clipId)) { lastRead = 'listed'; return null; }
                if (!sourceDelete) run.produced[a.ref].deleted = true;
                if (!r.ok) {
                    if (sourceDelete) return { fail: 'Live reported an error: ' + r.error, sourceGone: true };
                    return { warn: 'Live reported an error while removing a clip: ' + r.error };
                }
                return {};
            },
            exhausted: function () {
                return { fail: (r.ok ? 'the clip is still there' : r.error),
                    sourceGone: sourceDelete ? (lastRead === 'listed' ? false : null) : undefined };
            }
        } };
    }

    function opDeleteTrack(run, op) {
        var a = op.args[0];
        var p = isObj(a) ? run.produced[a.ref] : null;
        if (!p || p.kind !== 'track') return { fail: 'refused: only tracks made by ARA Bridge are removed' };
        if (p.deleted) return {};
        var song = newApi('live_set');
        var trackApi = apiById(p.id);
        // Only a track that holds nothing but clips of this sequence is removed.
        var clips = clipList(trackApi);
        var lanes = getIds(trackApi, 'take_lanes');
        if (clips === null) return { fail: 'its clips could not be read' };
        if (lanes) for (var l = 0; l < lanes.length; l++) {
            var lc = clipList(apiById(lanes[l]));
            if (lc) for (var m = 0; m < lc.length; m++) clips.push(lc[m]);
        }
        for (var i = 0; i < clips.length; i++) {
            if (!isProducedId(run, clips[i])) return { fail: 'the track holds a clip ARA Bridge did not make; it was left in place' };
        }
        var tracks = getIds(song, 'tracks');
        if (tracks === null) return { fail: 'the tracks could not be read' };
        var index = indexOfVal(tracks, p.id);
        if (index < 0) { p.deleted = true; return {}; }
        var r = callN(song, 'delete_track', [index]);
        return { pending: {
            confirm: function () {
                var now = getIds(song, 'tracks');
                if (now === null || has(now, p.id)) return null;
                p.deleted = true;
                return r.ok ? {} : { warn: 'Live reported an error while removing a track: ' + r.error };
            },
            exhausted: function () { return { fail: r.ok ? 'the track is still there' : r.error }; }
        } };
    }

    function opVerify(run, op) {
        var p = run.produced[op.target];
        if (!p || p.deleted) return { fail: 'the clip to check is missing' };
        var v = op.verify || {};
        var last = '';
        function checkOnce() {
            var api = apiById(p.id);
            if (!apiId(api) || apiType(api) !== 'Clip') { last = 'the clip is gone'; return false; }
            var cont = p.containerName ? target(run, p.containerName) : null;
            if (v.exists && cont && !has(clipList(cont.api), p.id)) { last = 'the clip is not listed on its track'; return false; }
            var warping = getNum(api, 'warping');
            var looping = getNum(api, 'looping');
            var start = getNum(api, 'start_time');
            var length = getNum(api, 'length');
            if (v.warping !== undefined && v.warping !== null && warping !== v.warping) { last = 'Warp is ' + warping; return false; }
            if (v.looping !== undefined && v.looping !== null && looping !== v.looping) { last = 'Loop is ' + looping; return false; }
            if (typeof v.startBeats === 'number') {
                var tolS = typeof v.startTolBeats === 'number' ? v.startTolBeats : 0.001;
                if (start === null || Math.abs(start - v.startBeats) > tolS) {
                    last = 'start ' + fmt(start) + ' beats, expected ' + fmt(v.startBeats); return false;
                }
            }
            if (typeof v.lengthSec === 'number') {
                var tempo = typeof v.tempo === 'number' ? v.tempo : run.tempo;
                var sec = length === null ? null : length * 60 / tempo;
                var tolSec = typeof v.lengthTolSec === 'number' ? v.lengthTolSec : 0.002;
                if (sec === null || Math.abs(sec - v.lengthSec) > tolSec) {
                    last = 'length ' + fmt(sec) + ' s, expected ' + fmt(v.lengthSec) + ' s'; return false;
                }
            }
            if (typeof v.lengthBeats === 'number') {
                var tolB = typeof v.lengthTolBeats === 'number' ? v.lengthTolBeats : 0.01;
                if (length === null || Math.abs(length - v.lengthBeats) > tolB) {
                    last = 'length ' + fmt(length) + ' beats, expected ' + fmt(v.lengthBeats); return false;
                }
            }
            return true;
        }
        if (checkOnce()) return {};
        return { pending: {
            maxTries: VERIFY_TRIES,
            confirm: function () { return checkOnce() ? {} : null; },
            exhausted: function () { return { fail: last }; }
        } };
    }

    // ------------------------------------------------------------------------------------------ settings
    function setPlacement(v) {
        var n = num(v);
        var mode = (n !== null && n >= 0 && n < PLACEMENTS.length && Math.floor(n) === n) ? PLACEMENTS[n] : String(v);
        if (!has(PLACEMENTS, mode)) { say('Unknown placement "' + String(v) + '" (takeLane, newTrack or replace).'); return; }
        S.placement = mode;
        log('placement is now ' + mode);
    }
    function setRealign(v) {
        var n = num(v);
        if (n !== 0 && n !== 1) { say('realign must be 0 or 1.'); return; }
        S.realign = n === 1;
        log('realign (timing correction) is now ' + (S.realign ? 'on' : 'off'));
    }
    function setSync(v) {
        var n = num(v);
        if (n !== 0 && n !== 1) { say('sync must be 0 or 1.'); return; }
        S.sync = n === 1;
        log('transport sync is now ' + (S.sync ? 'on' : 'off'));
    }
    function setPreview(v) {
        var n = num(v);
        if (n !== 0 && n !== 1) { say('preview must be 0 or 1.'); return; }
        S.preview = n === 1;
        log('live preview is now ' + (S.preview ? 'on' : 'off'));
    }
    function settings(args) {
        if (args.length % 2 !== 0) { say('settings needs key/value pairs (placement ..., realign ..., preview ..., sync ...).'); return; }
        for (var i = 0; i < args.length; i += 2) {
            if (args[i] === 'placement') setPlacement(args[i + 1]);
            else if (args[i] === 'realign') setRealign(args[i + 1]);
            else if (args[i] === 'preview') setPreview(args[i + 1]);
            else if (args[i] === 'sync') setSync(args[i + 1]);
            else say('Unknown setting "' + String(args[i]) + '".');
        }
    }

    // ------------------------------------------------------------------------------------------ device lifecycle
    function ready() {
        S.ready = true;
        if (!isBusy()) say('Starting...');
        if (!S.runnerAlive) startHello();
        else { S.announce = true; toRunner('findplugins'); }
    }
    function refreshPlugins() {
        if (!S.runnerAlive) { startHello(); return; }
        if (!isBusy()) say('Checking the host and plug-ins...');
        S.announce = true;
        toRunner('findplugins');
    }
    function loadbang() {
        setBusy(false);
        ui('guide', 0);
    }
    // The HTML page asks for everything it may have missed (see the header). Not through say(): no log line, no
    // change of S.lastLine; the settings are the ones js has been told (Live's saved values arrive at load).
    function uiRefresh() {
        ui('setting', 'placement', indexOfVal(PLACEMENTS, S.placement));
        ui('setting', 'skip', S.realign ? 0 : 1);
        ui('setting', 'preview', S.preview ? 1 : 0);
        ui('setting', 'sync', S.sync ? 1 : 0);
        if (S.hostMissing !== null) ui('host', S.hostMissing ? 0 : 1);
        if (S.plugins.melodyne !== null || S.plugins.vocalign !== null) {
            ui('plugins', S.plugins.melodyne ? 1 : 0, S.plugins.vocalign ? 1 : 0);
        }
        ui('guide', S.guide ? 1 : 0);
        ui('cancel', S.cancelable ? 1 : 0);
        ui('busy', isBusy() ? 1 : 0);
        if (S.lastLine) { try { outlet(0, sanitize(S.lastLine)); } catch (e) { /* ignore */ } }
    }

    // Every inlet message goes through here: nothing throws into Max.
    var handlers = {
        sendMelodyne: function () { if (!debounced()) sendMelodyne(); },
        setGuide: function () { setGuide(); },
        sendVocAlign: function () { if (!debounced()) sendVocAlign(); },
        cancel: function () { cancel(); },
        settings: function (args) { log('received settings ' + args.join(' ')); settings(noSymbol(args)); },
        placement: function (args) { log('received placement ' + args.join(' ')); setPlacement(noSymbol(args)[0]); },
        realign: function (args) { log('received realign ' + args.join(' ')); setRealign(noSymbol(args)[0]); },
        notifydeleted: function () { deleted(); },
        hostStarted: function (args) { var d = payloadOf('hostStarted', args); if (d) onStarted(d); },
        hostDone: function (args) { var d = payloadOf('hostDone', args); if (d) onDone(d); },
        hostStatus: function (args) { var d = payloadOf('hostStatus', args); if (d) onStatus(d); },
        hostError: function (args) { var d = payloadOf('hostError', args); if (d) onError(d); },
        hostPlugins: function (args) { var d = payloadOf('hostPlugins', args); if (d) onPlugins(d); },
        hostCopied: function (args) { var d = payloadOf('hostCopied', args); if (d) onCopied(d); },
        hostPong: function () { runnerAlive(); },
        nodeLifecycle: function (args) { nodeLifecycle(args); },
        ready: function () { ready(); },
        refreshPlugins: function () { refreshPlugins(); },
        loadbang: function () { loadbang(); },
        uiRefresh: function () { uiRefresh(); }
    };

    // A Send within SEND_DEBOUNCE_MS of the end of a job or of the previous accepted Send is ignored (a repeated click,
    // or anything in the patch that re-fires a button when it is enabled again).
    function debounced() {
        var t = now();
        var recent = (typeof S.lastFinishAt === 'number' && t - S.lastFinishAt < SEND_DEBOUNCE_MS) ||
            (typeof S.lastSendAt === 'number' && t - S.lastSendAt < SEND_DEBOUNCE_MS);
        if (!recent) return false;
        dlog('send ignored (debounce: ' + (typeof S.lastFinishAt === 'number' ? (t - S.lastFinishAt) + ' ms after the last finish, ' : '') +
            (typeof S.lastSendAt === 'number' ? (t - S.lastSendAt) + ' ms after the last send' : '') + ')');
        say(MSG_IGNORED + (S.lastLine ? ' ' + S.lastLine : ''));
        return true;
    }

    function noSymbol(args) { return args.length && args[0] === 'symbol' ? args.slice(1) : args; }

    // Max calls notifydeleted when the device (the js object) is deleted: stop every Task; nothing runs after this.
    function deleted() {
        dlog('notifydeleted' + (S.job ? ' during ' + S.job.phase : ''));
        S.dead = true;
        var tasks = [launchWatch, cancelWatch, copyWatch, helloTask, seqTask, busyWindowTask, busyRetryTask, syncTask];
        for (var i = 0; i < tasks.length; i++) stop(tasks[i]);
        var j = S.job;
        if (j && j.phase === 'placing' && j.placement === 'replace') {
            log('the device was deleted while placing a replace result: the original clip is on the muted backup track');
        } else if (j) {
            log('the device was deleted during a job (' + j.phase + '); its result stays in the job folder');
        }
        if (S.pv) log('the device was deleted while Preview tracks exist: delete them by hand');
        if (j) restoreSource(j);
        S.job = null;
        S.run = null;
    }

    function handle(name, args) {
        if (S.dead) return;
        try { dlog('in ' + name + ' ' + summary(name, Array.prototype.slice.call(args || []))); } catch (e0) { /* ignore */ }
        try {
            var fn = handlers.hasOwnProperty(name) ? handlers[name] : null;
            if (!fn) { say('Unknown message: ' + name); return; }
            fn(Array.prototype.slice.call(args || []));
        } catch (e) {
            log('exception in ' + name + ': ' + (e && e.stack ? e.stack : e));
            say('Error: ' + errText(e));
        }
    }

    return { handle: handle, state: S };
})(this);

// ---------------------------------------------------------------------------------------------- inlet messages
function sendMelodyne() { ARABridge.handle('sendMelodyne', arguments); }
function setGuide() { ARABridge.handle('setGuide', arguments); }
function sendVocAlign() { ARABridge.handle('sendVocAlign', arguments); }
function cancel() { ARABridge.handle('cancel', arguments); }
function settings() { ARABridge.handle('settings', arguments); }
function placement() { ARABridge.handle('placement', arguments); }
function realign() { ARABridge.handle('realign', arguments); }
function hostStarted() { ARABridge.handle('hostStarted', arguments); }
function hostDone() { ARABridge.handle('hostDone', arguments); }
function hostStatus() { ARABridge.handle('hostStatus', arguments); }
function hostError() { ARABridge.handle('hostError', arguments); }
function hostPlugins() { ARABridge.handle('hostPlugins', arguments); }
function hostCopied() { ARABridge.handle('hostCopied', arguments); }
function hostPong() { ARABridge.handle('hostPong', arguments); }
function nodeLifecycle() { ARABridge.handle('nodeLifecycle', arguments); }
function ready() { ARABridge.handle('ready', arguments); }
function refreshPlugins() { ARABridge.handle('refreshPlugins', arguments); }
function loadbang() { ARABridge.handle('loadbang', arguments); }
function uiRefresh() { ARABridge.handle('uiRefresh', arguments); }
function notifydeleted() { ARABridge.handle('notifydeleted', arguments); }
function bang() { ARABridge.handle('bang', arguments); }
function anything() {
    var name = 'unknown';
    try { name = String(messagename); } catch (e) { /* ignore */ }
    ARABridge.handle(name, arguments);
}
