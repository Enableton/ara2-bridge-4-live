// ARA Bridge device - core logic. Pure functions, no I/O, no Live, no Max objects.
//
// ES5 ONLY: this file runs in Max's classic js object (and in node for the tests). No let/const/arrow functions/
// template literals/classes/spread/Object.assign/Array.includes/padStart/Number.isFinite etc. (device/tests/test_core.js
// scans for them). No 'use strict' at file level (build.py concatenates this file with bridge.js); the code is
// wrapped in a function with its own 'use strict'.
//
// Export: `module.exports = core` under node, otherwise the global ARACore.
//
// ------------------------------------------------------------------------------------------------------------
// SHAPES
//
// raw LOM values   Anything LiveAPI can hand back: numbers, numeric strings ("7.105427357601002e-15"), arrays
//                  of one element ([131.5]), booleans (as 0/1). Unparseable values become null. Nothing throws.
//
// clip (normalized, snake_case = LOM names; every key is always present, null when unreadable)
//   numbers: id, track_index, is_audio_clip, is_arrangement_clip, start_marker, end_marker, start_time,
//            end_time, length, warping, warp_mode, gain, pitch_coarse, pitch_fine, looping, loop_start,
//            loop_end, sample_length, sample_rate, muted
//   strings: name, file_path, gain_display_string
//   Units (measured, Live 12.4.6, unwarped audio clip): start_time/end_time/length are beats;
//   loop_start/loop_end/start_marker are seconds of the file. end_marker is stale and is never used.
//
// track (normalized)    {name, is_frozen, can_be_frozen, mute, has_audio_input, has_midi_input}  (numbers/strings)
// song                  {tempo}   (raw or number, beats per minute)
//
// normalizeClip(props) -> clip          normalizeTrack(props) -> track
//
// clipRegion(clip, tempo) -> {ok:true, region} | {ok:false, code, reason}
//   region = {startSec, endSec, durationSec, startBeats, lengthBeats, endBeats, name, path, gain, gainIsUnity,
//             sampleRate, tempo, clipId, trackIndex}           (clipId/trackIndex null when unknown)
//   startSec = loop_start, endSec = loop_end (seconds in the source file); startBeats = start_time.
//
// validateClip(clip, track, song, opts) -> {ok:true, region} | {ok:false, code, reason}
//   opts (all optional): {plugin:'melodyne'|'vocalign', role:'source'|'guide'|'dub', guide:<region>|null,
//   fileExists:function(path)->bool, busy:true (a job is already running for this device),
//   hostMissing:true (no BridgeHost binary), pluginFound:false (--find-plugins did not find the plug-in)}.
//   The three device-state flags are checked first. `reason` is a short English message for the status line,
//   `code` a stable identifier (busy, no-host, no-plugin, no-clip, midi, session, frozen, warped, looping,
//   transposed, no-file, relative-path, offline, tempo, region, unsupported, no-guide, rate-mismatch, guide-tempo,
//   dub-before-guide, too-far). dub-before-guide / too-far (VocAlign dub with a guide that has startBeats/endBeats): the
//   result starts at the guide, so a dub that ends at or before the guide's start, or a window [guide start,
//   max(guide end, dub end)) longer than 7200 s, cannot be placed (the host refuses them too).
//
// buildJob({id, plugin, placement, realign, output, clips, tempo, trackIndex, createdAt}) -> {ok:true, job} | {ok:false, reason}
//   clips = [{role, path, startSec, endSec, startBeats, name, sampleRate}]   (regions plus a role)
//   output (optional): 'dub' | 'guide' ('guide' for VocAlign only: the host's result.wav starts at the guide's
//   arrangement position); written to the job only when given (the host's default is 'dub').
//   job = the job.json object of the host contract (version 1).
//
// interpretResult(resultJson, exitInfo) -> {kind:'ok'|'cancelled'|'error'|'crashed', statusLine (<=120 chars),
//   message, resultPath, frames, sampleRate, sourceStartFrame, realign:{applied, reason}, placeAt, offsetFrames,
//   droppedFrames}
//   placeAt: 'guide' when result.wav starts at the guide (VocAlign output 'guide'), else 'dub' (also for a result
//   without the key: an older host, or output 'dub'); offsetFrames/droppedFrames: numbers >= 0, 0 when absent.
//   resultJson: parsed result.json, or null/undefined when the host left none; exitInfo: {exitCode, signal}.
//
// planPlacement({mode, region, result, tempo, trackIndex, sourceClipId, resultFile, pluginLabel, existingClips, placeAtBeats})
//   -> {ok:true, ops:[...], rollbackAfter:[...], onRestoreFailure:null|{keep:[...], message}} | {ok:false, reason}
//   mode: 'takeLane'|'newTrack'|'replace'; result: {frames, sampleRate}; resultFile: absolute path of the
//   copied result.wav; pluginLabel: 'Melodyne'|'VocAlign'; existingClips: the source track's main-lane clips
//   [{id, start_time, end_time}] (beats), needed for 'replace'. When sourceClipId and existingClips are given,
//   the source entry must still match region.startBeats/endBeats within 0.001 beats ("changed while the host
//   was open" otherwise: window mode has no time limit).
//   placeAtBeats (optional, number >= 0, default region.startBeats): where the result clip goes (VocAlign output
//   'guide': the guide clip's start). region stays the SOURCE clip (the dub): the stale check, the replace backup,
//   its verify and the restore use region.startBeats; create_audio_clip, the replace duplicate of the result, the
//   result verifies and checkPlanSafety use placeAtBeats.
//   Every op is a plain object {op, target, label, args | property+value | verify, produces?, destructive?, ifProduced?}:
//     op      create_take_lane | create_audio_track | create_audio_clip | duplicate_clip_to_arrangement
//             | set | delete_clip | delete_track | verify
//     target  which Live object the op acts on:
//               'song'         live_set (create_audio_track, delete_track)
//               'track'        the source track (trackIndex)
//               'lane'         the take lane made by an earlier op
//               'newTrack'     the new track of mode newTrack
//               'backupTrack'  replace: muted backup track at trackIndex+1
//               'scratchTrack' replace: empty track at trackIndex+2 where the result clip is built and verified
//               'newClip'      the result clip made by create_audio_clip (lane, newTrack or scratchTrack)
//               'backupClip'   replace: the duplicate of the source on the backup track
//               'finalClip'    replace: the result clip duplicated onto the source track
//               'restoredClip' replace rollback: the original restored from the backup
//     args    call arguments; {ref:'sourceClip', id:<sourceClipId>} is the source clip's id, {ref:'<name>'} any
//             object an earlier op 'produces'
//     produces  the name under which the executor remembers the object this op made (for later targets and for
//               rollback: delete what it produced, never anything else). Every create_*/duplicate op has one.
//     destructive  true on the single op that removes user data (replace: delete_clip of the source).
//     ifProduced   a rollback op that only runs if that object exists
//     optional     a cleanup op after the result is verified in place (replace: removing the scratch track); its failure
//                  is a warning for the status line, never a rollback (it would undo a verified result)
//     verify  an expectation the executor checks by re-reading Live; on failure it stops and rolls back:
//               {warping, looping, startBeats, startTolBeats, lengthSec, lengthTolSec, tempo}  for newClip/finalClip
//                 (startBeats = placeAtBeats)
//               {exists, warping, startBeats, startTolBeats, lengthBeats, lengthTolBeats}  for backupClip/restoredClip
//   Nothing is ever created on the user's main lane by create_audio_clip (Live first makes a warped looping 32-beat
//   clip there and replaces what it lands on); only lanes and fresh tracks receive it.
//   ROLLBACK. A failure BEFORE the destructive op: delete the objects produced so far, in reverse order.
//   A failure AT or AFTER the destructive op: run `rollbackAfter` in order (if the destructive delete itself failed,
//   first re-read the source: if it is still there, use the "before" rule). rollbackAfter restores the original from
//   the backup (duplicate backupClip onto the source track at region.startBeats), verifies it, and only then deletes
//   the scratch and backup tracks. If the restore or its verify fails the executor must NOT delete anything in
//   onRestoreFailure.keep and must show onRestoreFailure.message (the original is on the backup track).
//   Replace order: create backup track, duplicate source onto it, verify, mute, create scratch track, create result
//   clip on it, unwarp, name, gain, verify, [destructive: delete source], duplicate result onto the source track,
//   unwarp, name, gain, verify, delete scratch track (optional: a failure there leaves the scratch track and warns).
//
// checkPlanSafety(ops, {startBeats, resultBeats, tempo, existingClips}) -> {ok:true} | {ok:false, reason}
//   startBeats: where the result clip goes on the source track (planPlacement passes placeAtBeats).
//   Structural rule used by planPlacement; exported for tests.
//
// uniqueName(dir, base, exists, ext) -> full path   (ext defaults to 'wav', or the audio extension base already
// ends with; exists(path)->bool is injected; null after 9999 tries)
// ------------------------------------------------------------------------------------------------------------

var core = (function () {
    'use strict';

    // ------------------------------------------------------------------------------------------ constants
    var TOL_SEC = 0.002;          // marker cross-check, tempo consistency, result length verify
    var END_SLACK_SEC = 0.001;    // end may lie this far past the file end (the host cuts it there)
    var UNITY_GAIN = 0.4;         // raw clip gain of 0.00 dB
    var UNITY_TOL = 1e-6;
    var MAX_SEC = 86400;
    var MAX_BEATS = 1e7;
    var MAX_STATUS = 120;
    var MAX_NAME = 120;
    var MAX_CLIP_NAME = 200;
    var TEMP_WARPED_BEATS = 32;   // Live's create_audio_clip first makes a warped, looping clip of this many beats
    var BEAT_EPS = 1e-9;
    var PLUGINS = ['melodyne', 'vocalign'];
    var PLACEMENTS = ['takeLane', 'newTrack', 'replace'];
    var OUTPUTS = ['dub', 'guide'];
    var MAX_GUIDE_WINDOW_SEC = 7200;   // the host's limit for a result that starts at the guide
    var CLIP_NUM_FIELDS = ['id', 'track_index', 'is_audio_clip', 'is_arrangement_clip', 'start_marker', 'end_marker',
        'start_time', 'end_time', 'length', 'warping', 'warp_mode', 'gain', 'pitch_coarse', 'pitch_fine', 'looping',
        'loop_start', 'loop_end', 'sample_length', 'sample_rate', 'muted'];
    var CLIP_STR_FIELDS = ['name', 'file_path', 'gain_display_string'];
    var TRACK_NUM_FIELDS = ['is_frozen', 'can_be_frozen', 'mute', 'has_audio_input', 'has_midi_input'];
    var NUM_RE = /^[+\-]?(\d+\.?\d*|\.\d+)([eE][+\-]?\d+)?$/;
    var CONTROL_RE = /[\u0000-\u001f\u007f]/g;

    // ------------------------------------------------------------------------------------------ helpers
    function isArr(v) { return Object.prototype.toString.call(v) === '[object Array]'; }
    function isObj(v) { return v !== null && typeof v === 'object' && !isArr(v); }
    function isNum(v) { return typeof v === 'number' && isFinite(v); }
    function isStr(v) { return typeof v === 'string'; }
    function isAbs(p) { return isStr(p) && p.length > 1 && p.charAt(0) === '/'; }
    function abs(x) { return x < 0 ? -x : x; }
    function indexIn(list, v) { for (var i = 0; i < list.length; i++) if (list[i] === v) return i; return -1; }

    // Unwrap [x] (LiveAPI get returns arrays). Longer or empty arrays are ambiguous: null.
    function unwrap(v) {
        var depth = 0;
        while (isArr(v) && depth < 4) {
            if (v.length !== 1) return undefined;
            v = v[0];
            depth++;
        }
        return isArr(v) ? undefined : v;
    }

    function toNumber(v) {
        v = unwrap(v);
        if (typeof v === 'number') return isFinite(v) ? v : null;
        if (typeof v === 'boolean') return v ? 1 : 0;
        if (typeof v === 'string') {
            var s = v.replace(/^\s+|\s+$/g, '');
            if (NUM_RE.test(s)) {
                var n = parseFloat(s);
                return isFinite(n) ? n : null;
            }
            if (s === 'true') return 1;
            if (s === 'false') return 0;
        }
        return null;
    }

    function toStr(v) {
        v = unwrap(v);
        if (typeof v === 'string') return v;
        if (typeof v === 'number' && isFinite(v)) return String(v);   // Max can hand a name like "808" back as a number
        return null;
    }

    function fail(code, reason) { return { ok: false, code: code, reason: reason }; }

    // One line of plain text: control characters and runs of blanks become one space.
    function oneLine(s) {
        if (!isStr(s)) return '';
        return s.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').replace(/^ | $/g, '');
    }

    // Cut to at most n UTF-16 units without splitting a surrogate pair; adds "..." when it cut.
    function cut(s, n, ellipsis) {
        if (s.length <= n) return s;
        var keep = ellipsis ? n - 3 : n;
        if (keep < 0) keep = 0;
        var c = s.charCodeAt(keep - 1);
        if (keep > 0 && c >= 0xD800 && c <= 0xDBFF) keep--;
        return s.substring(0, keep) + (ellipsis ? '...' : '');
    }

    function two(n) { return n < 10 ? '0' + n : String(n); }
    function three(n) { return n < 10 ? '00' + n : (n < 100 ? '0' + n : String(n)); }
    function isoString(d) {
        return d.getUTCFullYear() + '-' + two(d.getUTCMonth() + 1) + '-' + two(d.getUTCDate()) + 'T' +
            two(d.getUTCHours()) + ':' + two(d.getUTCMinutes()) + ':' + two(d.getUTCSeconds()) + '.' +
            three(d.getUTCMilliseconds()) + 'Z';
    }

    // ------------------------------------------------------------------------------------------ normalize
    function pick(src, key) {
        try { return src[key]; } catch (e) { return undefined; }
    }

    function normalizeClip(props) {
        var src = isObj(props) ? props : {};
        var out = {};
        var i;
        for (i = 0; i < CLIP_NUM_FIELDS.length; i++) out[CLIP_NUM_FIELDS[i]] = toNumber(pick(src, CLIP_NUM_FIELDS[i]));
        for (i = 0; i < CLIP_STR_FIELDS.length; i++) out[CLIP_STR_FIELDS[i]] = toStr(pick(src, CLIP_STR_FIELDS[i]));
        return out;
    }

    function normalizeTrack(props) {
        var src = isObj(props) ? props : {};
        var out = { name: toStr(pick(src, 'name')) };
        for (var i = 0; i < TRACK_NUM_FIELDS.length; i++) out[TRACK_NUM_FIELDS[i]] = toNumber(pick(src, TRACK_NUM_FIELDS[i]));
        return out;
    }

    // ------------------------------------------------------------------------------------------ clipRegion
    var MSG_SELECT = 'Select an Arrangement audio clip';

    // The refusals that depend only on the clip's own state. Returns a failure or null.
    function basicRefusal(c) {
        if (c.id === 0 || (c.is_audio_clip === null && c.is_arrangement_clip === null && c.file_path === null &&
            c.length === null)) {
            return fail('no-clip', MSG_SELECT + '.');
        }
        if (c.is_audio_clip === null) return fail('unsupported', 'This clip is not supported: could not read its type.');
        if (c.is_audio_clip !== 1) return fail('midi', MSG_SELECT + ' (MIDI clips are not supported).');
        if (c.is_arrangement_clip === null) return fail('unsupported', 'This clip is not supported: could not tell Arrangement from Session.');
        if (c.is_arrangement_clip !== 1) return fail('session', MSG_SELECT + ' (Session clips are not supported).');
        return null;
    }

    function stateRefusal(c) {
        if (c.warping === null) return fail('unsupported', 'This clip is not supported: could not read its Warp setting.');
        if (c.warping !== 0) return fail('warped', 'Warped clips are not supported yet. Turn Warp off for this clip.');
        if (c.looping === null) return fail('unsupported', 'This clip is not supported: could not read its Loop setting.');
        if (c.looping !== 0) return fail('looping', 'Looping clips are not supported. Turn Loop off for this clip.');
        if (c.pitch_coarse === null || c.pitch_fine === null) {
            return fail('unsupported', 'This clip is not supported: could not read its transposition.');
        }
        if (c.pitch_coarse !== 0 || c.pitch_fine !== 0) {
            return fail('transposed', 'Transposed clips are not supported. Set Transpose and Detune to 0.');
        }
        return null;
    }

    function regionOf(c, tempo) {
        if (!isNum(tempo) || tempo <= 0) return fail('tempo', 'The song tempo could not be read.');
        if (!isStr(c.file_path) || c.file_path === '') {
            return fail('no-file', 'The clip has no audio file (missing or offline).');
        }
        if (!isAbs(c.file_path)) return fail('relative-path', 'The clip\'s audio file path is not absolute.');
        if (c.loop_start === null || c.loop_end === null) {
            return fail('region', 'The clip\'s region could not be read (loop start/end).');
        }
        if (c.start_marker !== null && abs(c.start_marker - c.loop_start) > TOL_SEC) {
            return fail('region', 'The clip\'s start marker and loop start differ; the clip is in an unsupported state.');
        }
        var startSec = c.loop_start;
        var endSec = c.loop_end;
        if (startSec < 0) {
            if (startSec < -1e-6) return fail('region', 'The clip starts before the beginning of its audio file.');
            startSec = 0;   // numerical noise around 0 only
        }
        var durationSec = endSec - startSec;
        if (!(durationSec > 0)) return fail('region', 'The clip\'s region is empty.');
        if (c.start_time === null || c.length === null || !(c.length > 0) || c.start_time < 0) {
            return fail('region', 'The clip\'s position or length could not be read.');
        }
        if (abs(durationSec - c.length * 60 / tempo) > TOL_SEC) {
            return fail('tempo', 'Tempo changes under the clip or the clip is in an unsupported state.');
        }
        if (!(c.sample_length > 0) || !(c.sample_rate > 0)) {
            return fail('region', 'The length of the clip\'s audio file could not be read.');
        }
        if (endSec > c.sample_length / c.sample_rate + END_SLACK_SEC) {
            return fail('region', 'The clip extends past the end of its audio file; the clip is in an unsupported state.');
        }
        var gainIsUnity = (c.gain_display_string !== null && oneLine(c.gain_display_string) === '0.00 dB') ||
            (c.gain !== null && abs(c.gain - UNITY_GAIN) <= UNITY_TOL);
        return {
            ok: true,
            region: {
                startSec: startSec,
                endSec: endSec,
                durationSec: durationSec,
                startBeats: c.start_time,
                lengthBeats: c.length,
                endBeats: c.start_time + c.length,
                name: c.name === null ? '' : c.name,
                path: c.file_path,
                gain: c.gain,
                gainIsUnity: gainIsUnity,
                sampleRate: c.sample_rate,
                tempo: tempo,
                clipId: c.id,
                trackIndex: (c.track_index !== null && c.track_index >= 0 && Math.floor(c.track_index) === c.track_index) ?
                    c.track_index : null
            }
        };
    }

    function clipRegion(clip, tempo) {
        var c = normalizeClip(clip);
        var bad = basicRefusal(c) || stateRefusal(c);
        if (bad) return bad;
        return regionOf(c, toNumber(tempo));
    }

    // ------------------------------------------------------------------------------------------ validateClip
    function validateClip(clip, track, song, opts) {
        opts = isObj(opts) ? opts : {};
        if (opts.busy === true) return fail('busy', 'A job is already running for this device. Finish or cancel it first.');
        if (opts.hostMissing === true) {
            return fail('no-host', 'BridgeHost is not installed. Run tools/install_host.sh, then try again.');
        }
        if (opts.pluginFound === false) {
            var pname = opts.plugin === 'melodyne' ? 'Melodyne' : (opts.plugin === 'vocalign' ? 'VocAlign' : 'The plug-in');
            return fail('no-plugin', pname + ' was not found. Check that its VST3 is installed.');
        }
        var c = normalizeClip(clip);
        var bad = basicRefusal(c);
        if (bad) return bad;
        var t = normalizeTrack(track);
        if (t.is_frozen === 1) return fail('frozen', 'The track is frozen. Unfreeze it first.');
        bad = stateRefusal(c);
        if (bad) return bad;
        if (isStr(c.file_path) && c.file_path !== '' && typeof opts.fileExists === 'function') {
            var exists = true;
            try { exists = opts.fileExists(c.file_path) !== false; } catch (e) { exists = true; }
            if (!exists) return fail('offline', 'The clip\'s audio file is missing or offline.');
        }
        var tempo = toNumber(isObj(song) ? song.tempo : null);
        var r = regionOf(c, tempo);
        if (!r.ok) return r;

        if (opts.plugin === 'vocalign' && opts.role === 'dub') {
            var g = opts.guide;
            if (!isObj(g) || !isNum(g.startSec) || !isNum(g.endSec)) {
                return fail('no-guide', 'Set a guide first: select the guide clip and press Set guide.');
            }
            if (isNum(g.sampleRate) && g.sampleRate > 0 && isNum(r.region.sampleRate) && r.region.sampleRate > 0 &&
                g.sampleRate !== r.region.sampleRate) {
                return fail('rate-mismatch', 'Guide and dub must have the same sample rate (guide ' + g.sampleRate +
                    ' Hz, dub ' + r.region.sampleRate + ' Hz).');
            }
            if (isNum(g.tempo) && abs(g.tempo - tempo) > 1e-6) {
                return fail('guide-tempo', 'The song tempo changed since the guide was set. Set the guide again.');
            }
            // the result starts at the guide: the dub must reach past the guide's start
            if (isNum(g.startBeats) && isNum(r.region.endBeats) && r.region.endBeats <= g.startBeats + BEAT_EPS) {
                return fail('dub-before-guide', 'The dub clip ends before the guide clip starts. Move it so that it overlaps the guide.');
            }
            if (isNum(g.startBeats) && isNum(g.endBeats) && isNum(r.region.endBeats) && tempo !== null &&
                (Math.max(g.endBeats, r.region.endBeats) - g.startBeats) * 60 / tempo > MAX_GUIDE_WINDOW_SEC) {
                return fail('too-far', 'Guide and dub are too far apart (the result would be longer than 2 hours).');
            }
        }
        return r;
    }

    // ------------------------------------------------------------------------------------------ buildJob
    function badJob(why) { return { ok: false, reason: why }; }

    function validSeconds(x) { return isNum(x) && x >= 0 && x <= MAX_SEC; }

    function buildJob(spec) {
        if (!isObj(spec)) return badJob('job specification is missing');
        var id = spec.id;
        if (!isStr(id) || !/^[A-Za-z0-9_][A-Za-z0-9._\-]{0,99}$/.test(id)) {
            return badJob('job id must be 1-100 characters of letters, digits, "_", "-" or "." (no leading dot)');
        }
        var plugin = spec.plugin;
        if (indexIn(PLUGINS, plugin) < 0) return badJob('unknown plug-in "' + oneLine(String(plugin)) + '"');
        var placement = (spec.placement === undefined || spec.placement === null) ? 'takeLane' : spec.placement;
        if (indexIn(PLACEMENTS, placement) < 0) return badJob('unknown placement "' + oneLine(String(placement)) + '"');
        var output = (spec.output === undefined || spec.output === null) ? null : spec.output;
        if (output !== null && indexIn(OUTPUTS, output) < 0) return badJob('unknown output "' + oneLine(String(output)) + '"');
        if (output === 'guide' && plugin !== 'vocalign') return badJob('output "guide" is for VocAlign only');

        var realign;
        if (plugin === 'vocalign') {
            realign = false;   // realignment is a Melodyne feature
        } else if (spec.realign === undefined || spec.realign === null) {
            realign = true;
        } else if (spec.realign === true || spec.realign === false) {
            realign = spec.realign;
        } else if (spec.realign === 1 || spec.realign === 0) {
            realign = spec.realign === 1;   // live.toggle sends 0/1
        } else {
            return badJob('realign must be true or false');
        }

        // Live preview (Melodyne only): the host renders again after every edit and the device plays it as a clip
        var preview = false;
        if (spec.preview !== undefined && spec.preview !== null) {
            if (spec.preview === true || spec.preview === 1) preview = true;
            else if (spec.preview === false || spec.preview === 0) preview = false;
            else return badJob('preview must be true or false');
        }
        if (plugin !== 'melodyne') preview = false;
        // Transport sync (Melodyne only): the host follows Live's transport and reports what the user does back
        var sync = false;
        if (spec.sync !== undefined && spec.sync !== null) {
            if (spec.sync === true || spec.sync === 1) sync = true;
            else if (spec.sync === false || spec.sync === 0) sync = false;
            else return badJob('sync must be true or false');
        }
        if (plugin !== 'melodyne') sync = false;

        var tempo = null;
        if (spec.tempo !== undefined && spec.tempo !== null) {
            if (!isNum(spec.tempo) || spec.tempo <= 0 || spec.tempo > 1e4) return badJob('tempo is not a valid number');
            tempo = spec.tempo;
        }
        var trackIndex = null;
        if (spec.trackIndex !== undefined && spec.trackIndex !== null) {
            if (!isNum(spec.trackIndex) || spec.trackIndex < 0 || Math.floor(spec.trackIndex) !== spec.trackIndex) {
                return badJob('track index is not a valid number');
            }
            trackIndex = spec.trackIndex;
        }
        if (!isArr(spec.clips)) return badJob('clips are missing');

        var roles = plugin === 'melodyne' ? ['source'] : ['guide', 'dub'];
        if (spec.clips.length !== roles.length) {
            return badJob(plugin === 'melodyne' ? 'Melodyne needs exactly one clip' : 'VocAlign needs exactly one guide and one dub');
        }
        if (plugin === 'vocalign' && tempo === null) return badJob('VocAlign needs the song tempo');

        var clips = [];
        var seen = [];
        for (var i = 0; i < spec.clips.length; i++) {
            var c = spec.clips[i];
            if (!isObj(c)) return badJob('clip ' + (i + 1) + ' is not an object');
            if (indexIn(roles, c.role) < 0 || indexIn(seen, c.role) >= 0) {
                return badJob('clip roles must be ' + roles.join(' and ') + (roles.length > 1 ? ', once each' : ''));
            }
            seen.push(c.role);
            if (!isAbs(c.path) || c.path.indexOf('\u0000') >= 0) return badJob('the ' + c.role + ' clip path must be absolute');
            if (!validSeconds(c.startSec)) return badJob('the ' + c.role + ' clip start is not a valid time');
            if (!validSeconds(c.endSec)) return badJob('the ' + c.role + ' clip end is not a valid time');
            if (!(c.endSec > c.startSec)) return badJob('the ' + c.role + ' clip end must be after its start');
            var out = { role: c.role, path: c.path, startSec: c.startSec, endSec: c.endSec };
            if (c.startBeats === undefined || c.startBeats === null) {
                if (plugin === 'vocalign') return badJob('the ' + c.role + ' clip needs its start position in beats');
            } else {
                if (!isNum(c.startBeats) || c.startBeats < 0 || c.startBeats > MAX_BEATS) {
                    return badJob('the ' + c.role + ' clip start position is not a valid number');
                }
                out.startBeats = c.startBeats;
            }
            var nm = isStr(c.name) ? cut(c.name.replace(CONTROL_RE, ''), MAX_CLIP_NAME, false) : '';
            out.name = nm.replace(/\s/g, '') !== '' ? nm : c.role;
            if (c.sampleRate !== undefined && c.sampleRate !== null) {
                if (!isNum(c.sampleRate) || c.sampleRate <= 0) return badJob('the ' + c.role + ' clip sample rate is not valid');
                out.sampleRate = c.sampleRate;
            }
            clips.push(out);
        }
        if (plugin === 'vocalign' && clips[0].sampleRate !== undefined && clips[1].sampleRate !== undefined &&
            clips[0].sampleRate !== clips[1].sampleRate) {
            return badJob('guide and dub must have the same sample rate');
        }

        var created = isStr(spec.createdAt) && spec.createdAt !== '' ? spec.createdAt : isoString(new Date());
        var job = { version: 1, id: id, plugin: plugin, createdAt: created, placement: placement, realign: realign, clips: clips };
        if (output !== null) job.output = output;
        if (preview) job.preview = true;
        if (sync) job.sync = true;
        if (tempo !== null) job.song = { tempo: tempo };
        if (trackIndex !== null) job.live = { trackIndex: trackIndex };
        return { ok: true, job: job };
    }

    // ------------------------------------------------------------------------------------------ interpretResult
    function exitText(exitInfo) {
        var e = isObj(exitInfo) ? exitInfo : {};
        if (isStr(e.signal) && e.signal !== '') return 'signal ' + oneLine(e.signal);
        var code = toNumber(e.exitCode);
        if (code !== null) return 'exit code ' + code;
        return '';
    }

    function interpretResult(resultJson, exitInfo) {
        var res = { kind: 'error', statusLine: '', message: '', resultPath: null, frames: null, sampleRate: null,
            sourceStartFrame: null, realign: { applied: false, reason: null }, placeAt: 'dub', offsetFrames: 0, droppedFrames: 0 };
        function done(kind, line) {
            res.kind = kind;
            res.statusLine = cut(oneLine(line), MAX_STATUS, true);
            return res;
        }

        if (resultJson === null || resultJson === undefined) {
            var why = exitText(exitInfo);
            return done('crashed', 'The host ended without a result' + (why ? ' (' + why + ').' : '.'));
        }
        if (!isObj(resultJson)) return done('error', 'The host\'s result.json could not be read.');

        var msg = oneLine(resultJson.message);
        res.message = msg;
        var status = resultJson.status;

        if (status === 'cancelled') return done('cancelled', msg ? 'Cancelled: ' + msg : 'Cancelled. Nothing was changed.');
        if (status === 'error') return done('error', msg ? 'Failed: ' + msg : 'Failed. The host reported an error without a message.');
        if (status !== 'ok') return done('error', 'The host returned an unknown status' + (msg ? ': ' + msg : '.'));

        var frames = toNumber(resultJson.frames);
        var rate = toNumber(resultJson.sampleRate);
        var rpath = resultJson.resultPath;
        if (!isAbs(rpath) || frames === null || !(frames > 0) || Math.floor(frames) !== frames || rate === null || !(rate > 0)) {
            return done('error', 'Failed: host reported ok without a result file.');
        }
        res.resultPath = rpath;
        res.frames = frames;
        res.sampleRate = rate;
        var start = toNumber(resultJson.sourceStartFrame);
        res.sourceStartFrame = (start !== null && start >= 0) ? start : null;
        res.placeAt = resultJson.placeAt === 'guide' ? 'guide' : 'dub';
        var off = toNumber(resultJson.offsetFrames), dropped = toNumber(resultJson.droppedFrames);
        res.offsetFrames = (off !== null && off >= 0) ? off : 0;
        res.droppedFrames = (dropped !== null && dropped >= 0) ? dropped : 0;

        var rl = isObj(resultJson.realign) ? resultJson.realign : {};
        var reason = isStr(rl.reason) ? rl.reason : null;
        var applied = rl.applied === true;
        res.realign = { applied: applied, reason: reason };
        if (applied || reason === 'applied') return done('ok', 'Done. Melodyne\'s timing shift was corrected.');
        if (reason === 'nothing-to-do') return done('ok', 'Done. No timing shift to correct.');
        if (reason === 'no-confident-match') return done('ok', 'Done. Timing shift could not be measured; result kept as rendered.');
        if (reason === 'inconsistent-shifts') return done('ok', 'Done. No consistent timing shift found; result keeps Melodyne\'s own timing.');
        if (res.placeAt === 'guide' && res.droppedFrames > 0) {
            return done('ok', 'Done. The first ' + (res.droppedFrames / rate).toFixed(2) +
                ' s of the dub lay before the guide and were left out.');
        }
        return done('ok', msg ? 'Done. ' + msg : 'Done.');
    }

    // ------------------------------------------------------------------------------------------ planPlacement
    function badPlan(why) { return { ok: false, reason: why }; }

    // Ids come as 13, "13", ["id", 13] or "id 13".
    function idKey(v) {
        if (isArr(v) && v.length === 2 && v[0] === 'id') v = v[1];
        if (isStr(v)) {
            var m = /^id\s+(\S+)$/.exec(v);
            if (m) v = m[1];
        }
        var n = toNumber(v);
        if (n !== null) return 'n' + n;
        return isStr(v) && v !== '' ? 's' + v : null;
    }
    function sameId(a, b) {
        var x = idKey(a), y = idKey(b);
        return x !== null && x === y;
    }

    function stripPluginSuffix(name) {
        var prev;
        do {
            prev = name;
            name = name.replace(/\s*\((Melodyne|VocAlign)\)\s*$/, '');
        } while (name !== prev);
        return name;
    }

    // Safety check on a finished op list. existing = [{id, start, end}] (beats) of the source track's main lane.
    // - create_audio_clip on the main lane ('track') makes a WARPED looping TEMP_WARPED_BEATS clip first (Live shrinks it
    //   only after warping 0) and replaces whatever it lands on: refused if anything overlaps
    //   [start, start + max(TEMP_WARPED_BEATS, resultBeats)). Lanes and new/scratch tracks are empty: always fine.
    // - duplicate_clip_to_arrangement on 'track' places an already unwarped clip: refused if it would start inside
    //   another clip, or run into the next one by more than 2 ms.
    // - clips deleted earlier in the same list (delete_clip on 'track') are out of the way.
    // info = {startBeats, resultBeats, tempo, existingClips}
    function checkPlanSafety(ops, info) {
        var existing = [];
        var list = isObj(info) && isArr(info.existingClips) ? info.existingClips : [];
        var i;
        for (i = 0; i < list.length; i++) {
            var s = isObj(list[i]) ? toNumber(list[i].start_time) : null;
            var e = isObj(list[i]) ? toNumber(list[i].end_time) : null;
            if (s === null || e === null || !(e > s)) return badPlan('a clip on the track could not be read; nothing was changed');
            existing.push({ id: list[i].id, start: s, end: e });
        }
        var start = info.startBeats, resultBeats = info.resultBeats;
        var tolBeats = TOL_SEC * info.tempo / 60;
        var deleted = [];
        for (var k = 0; k < ops.length; k++) {
            var op = ops[k];
            if (op.op === 'delete_clip' && op.target === 'track') deleted.push(op.args[0].id);
            var mainCreate = op.op === 'create_audio_clip' && op.target === 'track';
            var mainDup = op.op === 'duplicate_clip_to_arrangement' && op.target === 'track';
            if (!mainCreate && !mainDup) continue;
            var extent = mainCreate ? Math.max(TEMP_WARPED_BEATS, resultBeats) : resultBeats;
            for (var j = 0; j < existing.length; j++) {
                var ex = existing[j];
                var gone = false;
                for (var d = 0; d < deleted.length; d++) if (sameId(deleted[d], ex.id)) gone = true;
                if (gone) continue;
                if (start >= ex.start && start < ex.end - BEAT_EPS) {
                    return badPlan('the new clip would overwrite another clip on the track; nothing was changed');
                }
                var overlap = Math.min(start + extent, ex.end) - Math.max(start, ex.start);
                if (overlap > (mainCreate ? BEAT_EPS : tolBeats)) {
                    return badPlan('the new clip would run into the next clip on the track; nothing was changed');
                }
            }
        }
        return { ok: true };
    }

    function planPlacement(spec) {
        if (!isObj(spec)) return badPlan('placement request is missing');
        var mode = spec.mode;
        // 'preview' is not a placement the user can choose: one preview of the Live preview, on its own track
        if (mode !== 'preview' && indexIn(PLACEMENTS, mode) < 0) return badPlan('unknown placement "' + oneLine(String(mode)) + '"');
        var region = spec.region;
        if (!isObj(region) || !isNum(region.startBeats) || region.startBeats < 0) return badPlan('the source clip position is not known');
        var result = spec.result;
        var frames = isObj(result) ? result.frames : null;
        var rate = isObj(result) ? result.sampleRate : null;
        if (!isNum(frames) || frames <= 0 || !isNum(rate) || rate <= 0) return badPlan('the result has no usable length');
        var tempo = spec.tempo;
        if (!isNum(tempo) || tempo <= 0) return badPlan('the song tempo is not known');
        var trackIndex = spec.trackIndex;
        if (!isNum(trackIndex) || trackIndex < 0 || Math.floor(trackIndex) !== trackIndex) return badPlan('the source track is not known');
        if (!isAbs(spec.resultFile)) return badPlan('the result file path must be absolute');
        var label = spec.pluginLabel;
        if (!isStr(label) || oneLine(label) === '') return badPlan('the plug-in name is missing');
        var placeAt = (spec.placeAtBeats === undefined || spec.placeAtBeats === null) ? region.startBeats : spec.placeAtBeats;
        if (!isNum(placeAt) || placeAt < 0 || placeAt > MAX_BEATS) return badPlan('the result clip position is not known');

        var startBeats = region.startBeats;   // the source clip (stale check, replace backup and restore)
        var resultSec = frames / rate;
        var resultBeats = resultSec * tempo / 60;
        var baseName = isStr(region.name) ? stripPluginSuffix(oneLine(region.name)) : '';
        if (baseName === '') baseName = 'Clip';
        var newName = baseName + ' (' + oneLine(label) + ')';
        var hasSourceId = spec.sourceClipId !== undefined && spec.sourceClipId !== null && spec.sourceClipId !== '';
        var sourceRef = hasSourceId ? { ref: 'sourceClip', id: spec.sourceClipId } : null;

        if (mode === 'replace') {
            if (!hasSourceId) return badPlan('replace needs the source clip id');
            if (!isArr(spec.existingClips)) return badPlan('replace needs the list of clips on the track (to protect them)');
        }

        // Window mode has no time limit: the source may have been moved or trimmed while the host was open.
        if (hasSourceId && isArr(spec.existingClips)) {
            var regionEnd = isNum(region.endBeats) ? region.endBeats :
                (isNum(region.lengthBeats) ? startBeats + region.lengthBeats : null);
            for (var q = 0; q < spec.existingClips.length; q++) {
                var cand = spec.existingClips[q];
                if (!isObj(cand) || !sameId(cand.id, spec.sourceClipId)) continue;
                var cs = toNumber(cand.start_time), ce = toNumber(cand.end_time);
                if (cs === null || ce === null) return badPlan('a clip on the track could not be read; nothing was changed');
                if (abs(cs - startBeats) > 0.001 || (regionEnd !== null && abs(ce - regionEnd) > 0.001)) {
                    return badPlan('the source clip changed while the host was open; nothing was changed');
                }
            }
        }

        var ops = [];
        var rollbackAfter = [];
        var onRestoreFailure = null;
        var clipTarget;   // where the result clip is created: always an empty lane or an empty track
        var verifyNew = { warping: 0, looping: 0, startBeats: placeAt, startTolBeats: 0.001, lengthSec: resultSec,
            lengthTolSec: TOL_SEC, tempo: tempo };
        function tail(extra) {
            ops.push({ op: 'create_audio_clip', target: clipTarget, label: 'Placing the result clip',
                args: [spec.resultFile, placeAt], produces: 'newClip' });
            ops.push({ op: 'set', target: 'newClip', label: 'Turning Warp off', property: 'warping', value: 0 });
            ops.push({ op: 'set', target: 'newClip', label: 'Naming the clip', property: 'name', value: newName });
            if (isNum(region.gain)) {
                ops.push({ op: 'set', target: 'newClip', label: 'Copying the clip gain', property: 'gain', value: region.gain });
            }
            ops.push({ op: 'verify', target: 'newClip', label: 'Checking the result clip', verify: verifyNew });
        }

        if (mode === 'preview') {
            // First preview: a new track right below the source track. Later ones: the previous preview clip is removed
            // (seeded by the device as produced 'previewTrack' / 'previewClip') and the new one goes onto the same track.
            if (spec.hasPreviewTrack === true) {
                ops.push({ op: 'delete_clip', target: 'previewTrack', label: 'Removing the previous preview',
                    args: [{ ref: 'previewClip' }] });
            } else {
                ops.push({ op: 'create_audio_track', target: 'song', label: 'Creating the preview track',
                    args: [trackIndex + 1], produces: 'previewTrack' });
                ops.push({ op: 'set', target: 'previewTrack', label: 'Naming the preview track', property: 'name',
                    value: cut('Preview: ' + baseName, 60, false) });
            }
            clipTarget = 'previewTrack';
            tail();
        } else if (mode === 'takeLane') {
            ops.push({ op: 'create_take_lane', target: 'track', label: 'Creating take lane', args: [], produces: 'lane' });
            clipTarget = 'lane';
            tail();
        } else if (mode === 'newTrack') {
            ops.push({ op: 'create_audio_track', target: 'song', label: 'Creating new track', args: [trackIndex + 1], produces: 'newTrack' });
            clipTarget = 'newTrack';
            tail();
        } else {
            // Replace. Nothing is ever created on the user's main lane (Live first makes a warped 32-beat clip there and
            // replaces what it lands on). Order: backup track (+1), backup copy, verify, mute, scratch track (+2), build
            // and verify the result clip on the scratch track, THEN the one destructive step (delete the source), then
            // duplicate the verified result onto the source track, verify, and remove the scratch track.
            var backupVerify = { exists: true, warping: 0, startBeats: startBeats, startTolBeats: 0.001,
                lengthBeats: isNum(region.lengthBeats) ? region.lengthBeats : null, lengthTolBeats: 0.01 };
            ops.push({ op: 'create_audio_track', target: 'song', label: 'Creating backup track', args: [trackIndex + 1], produces: 'backupTrack' });
            ops.push({ op: 'duplicate_clip_to_arrangement', target: 'backupTrack', label: 'Copying the original to the backup track',
                args: [sourceRef, startBeats], produces: 'backupClip' });
            ops.push({ op: 'verify', target: 'backupClip', label: 'Checking the backup copy', verify: backupVerify });
            ops.push({ op: 'set', target: 'backupTrack', label: 'Muting the backup track', property: 'mute', value: 1 });
            ops.push({ op: 'create_audio_track', target: 'song', label: 'Creating scratch track', args: [trackIndex + 2], produces: 'scratchTrack' });
            clipTarget = 'scratchTrack';
            tail();
            ops.push({ op: 'delete_clip', target: 'track', label: 'Removing the original clip', args: [sourceRef], destructive: true });
            ops.push({ op: 'duplicate_clip_to_arrangement', target: 'track', label: 'Moving the result onto the track',
                args: [{ ref: 'newClip' }, placeAt], produces: 'finalClip' });
            ops.push({ op: 'set', target: 'finalClip', label: 'Turning Warp off', property: 'warping', value: 0 });
            ops.push({ op: 'set', target: 'finalClip', label: 'Naming the clip', property: 'name', value: newName });
            if (isNum(region.gain)) {
                ops.push({ op: 'set', target: 'finalClip', label: 'Copying the clip gain', property: 'gain', value: region.gain });
            }
            ops.push({ op: 'verify', target: 'finalClip', label: 'Checking the result clip', verify: verifyNew });
            ops.push({ op: 'delete_track', target: 'song', label: 'Removing the scratch track', args: [{ ref: 'scratchTrack' }],
                optional: true });

            // Rollback for a failure AT or AFTER the destructive step. The backup is the user's only copy of the
            // original then: it is deleted only after the restored original has been verified.
            rollbackAfter = [
                { op: 'delete_clip', target: 'track', label: 'Removing the failed result clip', args: [{ ref: 'finalClip' }], ifProduced: 'finalClip' },
                { op: 'duplicate_clip_to_arrangement', target: 'track', label: 'Restoring the original clip',
                    args: [{ ref: 'backupClip' }, startBeats], produces: 'restoredClip' },
                { op: 'verify', target: 'restoredClip', label: 'Checking the restored original', verify: backupVerify },
                { op: 'delete_track', target: 'song', label: 'Removing the scratch track', args: [{ ref: 'scratchTrack' }], ifProduced: 'scratchTrack' },
                { op: 'delete_track', target: 'song', label: 'Removing the backup track', args: [{ ref: 'backupTrack' }] }
            ];
            onRestoreFailure = { keep: ['backupTrack', 'backupClip', 'scratchTrack'],
                message: 'Something went wrong. The original clip is on the muted backup track.' };
        }

        if (mode === 'replace') {
            var found = false;
            for (var f = 0; f < spec.existingClips.length; f++) {
                if (isObj(spec.existingClips[f]) && sameId(spec.existingClips[f].id, spec.sourceClipId)) found = true;
            }
            if (!found) return badPlan('the source clip is no longer on the track; nothing was changed');
        }
        var safe = checkPlanSafety(ops, { existingClips: mode === 'replace' ? spec.existingClips : [],
            startBeats: placeAt, resultBeats: resultBeats, tempo: tempo });
        if (!safe.ok) return safe;
        return { ok: true, ops: ops, rollbackAfter: rollbackAfter, onRestoreFailure: onRestoreFailure };
    }

    // ------------------------------------------------------------------------------------------ uniqueName
    function uniqueName(dir, base, exists, ext) {
        if (typeof exists !== 'function') throw new Error('uniqueName needs an exists(path) function');
        var d = isStr(dir) && dir !== '' ? dir : '.';
        while (d.length > 1 && d.charAt(d.length - 1) === '/') d = d.substring(0, d.length - 1);
        var b = isStr(base) ? base : '';
        b = b.replace(/[\/\\]/g, '').replace(CONTROL_RE, '').replace(/^\.+/, '');
        var e = isStr(ext) && ext !== '' ? ext : '';
        if (e === '') {
            // no explicit ext: a base like "job-1.wav" keeps its audio extension instead of becoming job-1.wav.wav
            var m = /^(.+)\.(wav|aif|aiff|flac|caf|mp3|m4a)$/i.exec(b);
            if (m) { b = m[1]; e = m[2]; } else { e = 'wav'; }
        }
        if (e.charAt(0) === '.') e = e.substring(1);
        e = e.replace(/[\/\\\u0000-\u001f\u007f]/g, '');
        if (b.replace(/\s/g, '') === '') b = 'result';
        for (var n = 1; n < 10000; n++) {
            var suffix = n === 1 ? '' : '-' + n;
            var name = cut(b, MAX_NAME - suffix.length, false) + suffix;
            var full = d + '/' + name + '.' + e;
            if (!exists(full)) return full;
        }
        return null;
    }

    return {
        normalizeClip: normalizeClip,
        normalizeTrack: normalizeTrack,
        clipRegion: clipRegion,
        validateClip: validateClip,
        buildJob: buildJob,
        interpretResult: interpretResult,
        planPlacement: planPlacement,
        checkPlanSafety: checkPlanSafety,
        uniqueName: uniqueName
    };
})();

var ARACore;
if (typeof module !== 'undefined') { module.exports = core; } else { ARACore = core; }
