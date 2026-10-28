// Tests for device/src/bridge.js (Max [js] side) through the BUILT file device/build/bridge.js (core.js + bridge.js),
// run in a node vm without `module` (as in Max: the ARACore global path).
// Run: node device/tests/test_bridge.js [--skip-real]       (runs python3 device/build.py first; exit 1 on failure)
//
// The fake Max environment reproduces what Live 12.4.6 did in the probes (device/probe/out):
//  - LiveAPI: ids as ["id", N], get returns arrays, empty id lists read [""], numbers optionally as strings
//    ("7.105427357601002e-15"), names optionally split into atoms; TakeLane children via arrangement_clips (`clips`
//    returns a count); canonical_parent of a lane clip is the TakeLane.
//  - create_audio_clip makes a WARPED looping 32-beat clip; warping 0 restores the true length (looping 0).
//  - create_audio_clip on a main lane REPLACES what it lands on ([pos, pos+32)); duplicate_clip_to_arrangement keeps
//    the source's properties and also removes what it overlaps (a buggy plan loses a clip and the tests see it).
//  - delete_clip / delete_track / create_audio_track / create_take_lane; there is NO call that deletes a take lane
//    (none exists in Live's LOM: checked against Live 12.4.6's binary and _MxDCore).
//  - delayed visibility: new objects show up in id lists, and deleted ones leave them, after 0..2 settle ticks.
//  - fault injection per call (nth occurrence): throw, noop, throwAfter (acts, then throws), wrongLength,
//    breakLists (acts, then the track's clip list cannot be read).
//  - Task with a controllable clock, File (existence and size from the real file system), outlets, post.
// A fake runner implements the runner contract (status/findplugins/launch/cancel/copyresult -> host* messages).
// The integration test at the end uses the REAL runner (createRunner) and the REAL BridgeHost --autorender.
'use strict';
const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const SKIP_REAL = process.argv.includes('--skip-real');
const DEVICE = path.resolve(__dirname, '..');
const REPO = path.resolve(DEVICE, '..');
const BUILT = path.join(DEVICE, 'build', 'bridge.js');
const REAL_HOST = path.join(REPO, 'third_party', 'ARA_SDK', 'ARA_Examples', 'build', 'bin', 'Release', 'BridgeHost');
const core = require(path.join(DEVICE, 'src', 'core.js'));
const SETTLE = 300;

const b = cp.spawnSync('python3', [path.join(DEVICE, 'build.py')], { encoding: 'utf8' });
if (b.status !== 0) { console.log('build.py failed:\n' + b.stdout + b.stderr); process.exit(1); }
const BUILT_SRC = fs.readFileSync(BUILT, 'utf8');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arabridge-bridge-test-'));
const enc = (o) => encodeURIComponent(JSON.stringify(o));
const dec = (s) => JSON.parse(decodeURIComponent(s));
const clone = (o) => JSON.parse(JSON.stringify(o));

// ------------------------------------------------------------------------------------------ WAV files
function writeWav(file, frames, rate, opts) {
  opts = opts || {};
  const ch = opts.channels || 1;
  const bytes = frames * ch * 4;
  const buf = Buffer.alloc(44 + (opts.truncate ? 0 : bytes));
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + bytes, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(3, 20); buf.writeUInt16LE(ch, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * ch * 4, 28); buf.writeUInt16LE(ch * 4, 32); buf.writeUInt16LE(32, 34); buf.write('data', 36); buf.writeUInt32LE(bytes, 40);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
}
function wavInfo(file) {
  try {
    const buf = fs.readFileSync(file);
    if (buf.toString('ascii', 0, 4) !== 'RIFF') return null;
    let off = 12, ch = 1, rate = 44100, bits = 16, frames = null;
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4); const size = buf.readUInt32LE(off + 4);
      if (id === 'fmt ') { ch = buf.readUInt16LE(off + 10); rate = buf.readUInt32LE(off + 12); bits = buf.readUInt16LE(off + 22); }
      if (id === 'data') { frames = Math.floor(size / (ch * bits / 8)); break; }
      off += 8 + size + (size & 1);
    }
    return frames === null ? null : { frames, rate };
  } catch (e) { return null; }
}

// ------------------------------------------------------------------------------------------ clock + Task
function makeClock() {
  const clock = { now: 0, tasks: new Set() };
  clock.run = (limit) => {
    const horizon = clock.now + (limit === undefined ? 5000 : limit);
    let n = 0;
    for (;;) {
      let best = null;
      clock.tasks.forEach((t) => { if (t.due <= horizon && (!best || t.due < best.due)) best = t; });
      if (!best) return n;
      clock.tasks.delete(best);
      if (best.due > clock.now) clock.now = best.due;
      n++;
      if (n > 20000) throw new Error('task loop did not terminate');
      best.fn.call(best.obj);
    }
  };
  clock.advance = (ms) => { const h = clock.now + ms; const n = clock.run(ms); if (clock.now < h) clock.now = h; return n; };
  return clock;
}

// ------------------------------------------------------------------------------------------ fake Live
function makeLive(opts) {
  opts = opts || {};
  const clock = opts.clock || makeClock();
  let nextId = 100;
  let setup = true;
  const objs = {};
  const calls = [];
  const counts = {};
  const faults = opts.faults || [];
  const song = { id: 1, type: 'Song', tempo: opts.tempo || 120, tracks: [], view: { detail_clip: 0 }, visibleAt: -1, goneAt: null,
    is_playing: 0, timeBase: { t: 0, at: 0 } };
  const songTime = () => (song.is_playing ? song.timeBase.t + (clock.now - song.timeBase.at) / 1000 * song.tempo / 60 : song.timeBase.t);
  objs[1] = song;
  const broken = new Set();
  const delayTicks = () => (setup ? 0 : (typeof opts.delayTicks === 'function' ? opts.delayTicks() : (opts.delayTicks || 0)));
  function add(o) {
    o.id = nextId++; o.visibleAt = setup ? -1 : clock.now + delayTicks() * SETTLE; o.goneAt = null; objs[o.id] = o; return o;
  }
  const exists = (o) => !!o && o.goneAt === null;
  const resolvable = (o) => !!o && (o.goneAt === null || o.goneAt > clock.now);
  const visible = (o) => !!o && o.visibleAt <= clock.now && (o.goneAt === null || o.goneAt > clock.now);
  function gone(o) { o.goneAt = clock.now + delayTicks() * SETTLE; (o.clips || []).forEach((c) => gone(objs[c])); (o.lanes || []).forEach((l) => gone(objs[l])); }
  const ids = (list) => { const r = []; list.forEach((i) => { if (visible(objs[i])) r.push('id', i); }); return r.length ? r : ['']; };

  function addTrack(name, props, index) {
    const t = add({ type: 'Track', name: name || 'Audio', props: Object.assign({ is_frozen: 0, can_be_frozen: 1, mute: 0, has_audio_input: 1, has_midi_input: 0 }, props || {}), clips: [], lanes: [] });
    if (index === undefined) song.tracks.push(t.id); else song.tracks.splice(index, 0, t.id);
    return t;
  }
  function addLane(track) {
    const l = add({ type: 'TakeLane', parent: track.id, name: 'Take ' + (track.lanes.length + 1), clips: [] });
    track.lanes.push(l.id);
    return l;
  }
  function fileInfo(file) {
    return (opts.files && opts.files[file]) || wavInfo(file) || { frames: 441000, rate: 44100 };
  }
  // An unwarped arrangement clip as the user has it: spec {start, loopStart, loopEnd, file, name, gain, ...}
  function addClip(container, spec) {
    const fi = spec.frames ? { frames: spec.frames, rate: spec.rate || 44100 } : fileInfo(spec.file);
    const sec = spec.loopEnd - spec.loopStart;
    const length = sec * song.tempo / 60;
    const c = add({ type: 'Clip', parent: container.id, props: Object.assign({
      name: spec.name === undefined ? 'Vocal take' : spec.name, file_path: spec.file, is_audio_clip: 1, is_arrangement_clip: 1,
      start_marker: spec.loopStart, end_marker: 32, start_time: spec.start, end_time: spec.start + length, length,
      warping: 0, warp_mode: 0, gain: spec.gain === undefined ? 0.4000000059604645 : spec.gain, gain_display_string: '0.00 dB',
      pitch_coarse: 0, pitch_fine: 0, looping: 0, loop_start: spec.loopStart, loop_end: spec.loopEnd,
      sample_length: fi.frames, sample_rate: fi.rate, muted: 0 }, spec.props || {}) });
    container.clips.push(c.id);
    return c;
  }
  const liveClips = (container) => container.clips.map((i) => objs[i]).filter(exists);
  function overlapRemove(container, from, to, except) {
    liveClips(container).forEach((c) => {
      if (c.id === except) return;
      const ov = Math.min(to, c.props.end_time) - Math.max(from, c.props.start_time);
      if (ov > 1e-9) { gone(c); calls.push({ fn: 'REPLACED', on: c.id }); }
    });
  }
  function fault(key) {
    counts[key] = (counts[key] || 0) + 1;
    const f = faults.find((x) => x.fn === key && (x.nth === undefined || x.nth === counts[key]));
    return f ? f.mode : null;
  }
  function pathOf(o) {
    if (o.type === 'Song') return 'live_set';
    if (o.type === 'Track') return 'live_set tracks ' + song.tracks.filter((i) => exists(objs[i])).indexOf(o.id);
    if (o.type === 'TakeLane') { const t = objs[o.parent]; return pathOf(t) + ' take_lanes ' + t.lanes.indexOf(o.id); }
    if (o.type === 'Clip') { const p = objs[o.parent]; return pathOf(p) + ' arrangement_clips ' + p.clips.indexOf(o.id); }
    return '';
  }
  function numOut(v) {
    if (typeof v !== 'number') return v;
    if (opts.stringNumbers === 'all') return String(v);
    if (opts.stringNumbers && v !== 0 && Math.abs(v) < 1e-6) return String(v);
    return v;
  }
  function textOut(v) {
    if (opts.splitText && typeof v === 'string' && v.indexOf(' ') >= 0) {
      return v.split(' ').map((w) => (/^\d+$/.test(w) ? Number(w) : w));
    }
    return [v];
  }

  function LiveAPI(cb, p) {
    p = String(p);
    if (live.ctorHook) live.ctorHook(p);
    let o = null;
    const m = /^id (\d+)$/.exec(p);
    if (m) o = objs[Number(m[1])];
    else if (p === 'live_set') o = song;
    else if (p === 'live_set view detail_clip') o = objs[song.view.detail_clip];
    if (!resolvable(o)) o = null;
    this._o = o;
    this.id = o ? String(o.id) : '0';
    this.type = o ? o.type : 'unknown';
    this.path = o ? '"' + pathOf(o) + '"' : '""';
  }
  LiveAPI.prototype.get = function (prop) {
    const o = this._o;
    if (!o || !resolvable(o)) return [];
    if (opts.getHook) opts.getHook(o, prop);
    if (o.type === 'Song') {
      if (prop === 'tracks') return ids(song.tracks);
      if (prop === 'tempo') return [numOut(song.tempo)];
      if (prop === 'is_playing') return [song.is_playing];
      if (prop === 'current_song_time') return [numOut(songTime())];
    }
    if (o.type === 'Track') {
      if (prop === 'arrangement_clips') { if (broken.has(o.id)) throw new Error('arrangement_clips: unreadable'); return ids(o.clips); }
      if (prop === 'take_lanes') return ids(o.lanes);
      if (prop === 'canonical_parent') return ['id', 1];
      if (prop === 'name') return textOut(o.name);
      if (prop in o.props) return [numOut(o.props[prop])];
    }
    if (o.type === 'TakeLane') {
      if (prop === 'arrangement_clips') return ids(o.clips);
      if (prop === 'clips') return 0;
      if (prop === 'name') return textOut(o.name);
      if (prop === 'canonical_parent') return ['id', o.parent];
    }
    if (o.type === 'Clip') {
      if (opts.readHook) { const v = opts.readHook(o, prop); if (v !== undefined) return [v]; }
      if (prop === 'canonical_parent') return ['id', o.parent];
      if (prop === 'name' || prop === 'file_path' || prop === 'gain_display_string') return textOut(o.props[prop]);
      if (prop in o.props) return [numOut(o.props[prop])];
    }
    throw new Error('get: no property ' + prop + ' on ' + o.type);
  };
  LiveAPI.prototype.set = function (prop, value) {
    const o = this._o;
    calls.push({ on: o && o.id, type: o && o.type, fn: 'set ' + prop, args: [value] });
    if (!o || !exists(o)) return;
    const mode = fault('set ' + prop);
    if (mode === 'throw') throw new Error('fault: set ' + prop);
    if (mode === 'noop') return;
    if (o.type === 'Song') {
      if (prop === 'current_song_time') song.timeBase = { t: Number(value), at: clock.now };
      else song[prop] = Number(value);
      return;
    }
    if (o.type === 'Track') { if (prop === 'name') o.name = String(value); else o.props[prop] = Number(value); return; }
    const p = o.props;
    if (prop === 'warping') {
      if (Number(value) === 0 && p.warping === 1 && o.createdWarped) {
        const fi = { frames: p.sample_length, rate: p.sample_rate };
        const sec = fi.frames / fi.rate;
        p.warping = 0; p.looping = mode === 'keepLooping' ? 1 : 0; p.loop_start = 0; p.loop_end = sec; p.start_marker = 0;
        p.length = sec * song.tempo / 60 + (mode === 'wrongLength' ? 1 : 0);
        p.end_time = p.start_time + p.length;
        o.createdWarped = false;
      } else p.warping = Number(value);
      return;
    }
    if (prop === 'name') { p.name = String(value); return; }
    p[prop] = Number(value);
  };
  LiveAPI.prototype.call = function (fn) {
    const args = Array.prototype.slice.call(arguments, 1);
    const o = this._o;
    calls.push({ on: o && o.id, type: o && o.type, fn, args });
    if (!o || !exists(o)) return undefined;
    const mode = fault(fn);
    if (mode === 'throw') throw new Error('fault: ' + fn);
    if (mode === 'noop') return undefined;
    let ret;
    if (o.type === 'Song' && fn === 'create_audio_track') {
      const n = song.tracks.filter((i) => exists(objs[i])).length;
      const idx = Math.max(0, Math.min(n, Number(args[0])));
      const live = song.tracks.filter((i) => exists(objs[i]));
      const at = idx < live.length ? song.tracks.indexOf(live[idx]) : song.tracks.length;
      const t = addTrack((idx + 1) + '-Audio', {}, at);
      ret = ['id', t.id];
    } else if (o.type === 'Song' && fn === 'delete_track') {
      const live = song.tracks.filter((i) => exists(objs[i]));
      const t = objs[live[Number(args[0])]];
      if (t) gone(t);
      ret = undefined;
    } else if (o.type === 'Song' && (fn === 'continue_playing' || fn === 'start_playing')) {
      song.timeBase = { t: songTime(), at: clock.now };
      song.is_playing = 1;
      ret = undefined;
    } else if (o.type === 'Song' && fn === 'stop_playing') {
      song.timeBase = { t: songTime(), at: clock.now };
      song.is_playing = 0;
      ret = undefined;
    } else if (o.type === 'Track' && fn === 'create_take_lane') {
      ret = ['id', addLane(o).id];
    } else if ((o.type === 'Track' || o.type === 'TakeLane') && fn === 'create_audio_clip') {
      const file = String(args[0]); const pos = Number(args[1]) + (mode === 'noReturnWrongPos' ? 1 : 0);
      if (!fs.existsSync(file)) return undefined;
      overlapRemove(o, pos, pos + 32);
      const fi = fileInfo(file);
      const c = add({ type: 'Clip', parent: o.id, createdWarped: true, props: {
        name: path.basename(file).replace(/\.[^.]+$/, ''), file_path: file, is_audio_clip: 1, is_arrangement_clip: 1,
        start_marker: 0, end_marker: 32, start_time: pos, end_time: pos + 32, length: 32, warping: 1, warp_mode: 0,
        gain: 0.4000000059604645, gain_display_string: '0.00 dB', pitch_coarse: 0, pitch_fine: 0, looping: 1, loop_start: 0,
        loop_end: 32, sample_length: fi.frames, sample_rate: fi.rate, muted: 0 } });
      o.clips.push(c.id);
      ret = (mode === 'noReturn' || mode === 'noReturnWrongPos') ? undefined : ['id', c.id];
    } else if (o.type === 'Track' && fn === 'duplicate_clip_to_arrangement') {
      if (args[0] !== 'id' || args.length !== 3) return undefined;   // the measured form: "id", N, position
      const src = objs[Number(args[1])];
      if (!exists(src) || src.type !== 'Clip') return undefined;
      const pos = Number(args[2]);
      const p = clone(src.props);
      p.start_time = pos; p.end_time = pos + p.length;
      if (mode === 'wrongLength') { p.length += 1; p.end_time += 1; }
      overlapRemove(o, pos, p.end_time);
      if (mode === 'removeOther') { const other = liveClips(o).find((x) => x.id !== src.id); if (other) { gone(other); calls.push({ fn: 'REMOVED_OTHER', on: other.id }); } }
      const c = add({ type: 'Clip', parent: o.id, createdWarped: !!src.createdWarped, props: p });
      o.clips.push(c.id);
      ret = ['id', c.id];
    } else if (o.type === 'Track' && fn === 'delete_clip') {
      if (args[0] !== 'id') return undefined;
      const id = Number(args[1]);
      let c = o.clips.indexOf(id) >= 0 ? objs[id] : null;
      if (!c && opts.trackDeletesLaneClips !== false) o.lanes.forEach((l) => { if (objs[l].clips.indexOf(id) >= 0) c = objs[id]; });
      if (exists(c)) gone(c);
      ret = ['id', 0];
    } else {
      throw new Error('call: ' + fn + ' is not a function of ' + o.type);
    }
    if (mode === 'throwAfter') throw new Error('fault (after acting): ' + fn);
    if (mode === 'breakLists') { broken.add(o.id); throw new Error('fault (after acting, lists broken): ' + fn); }
    return ret;
  };

  function clipSnap(c) {
    const p = c.props;
    const r = (v) => (typeof v === 'number' ? Math.round(v * 1e9) / 1e9 : v);
    return { name: p.name, file_path: p.file_path, start_time: r(p.start_time), end_time: r(p.end_time), length: r(p.length),
      warping: p.warping, looping: p.looping, loop_start: r(p.loop_start), loop_end: r(p.loop_end), gain: r(p.gain) };
  }
  const byStart = (a, b2) => a.start_time - b2.start_time;
  function snapshot() {
    return song.tracks.map((i) => objs[i]).filter(exists).map((t) => ({
      name: t.name, mute: t.props.mute,
      clips: liveClips(t).map(clipSnap).sort(byStart),
      lanes: t.lanes.map((l) => objs[l]).filter(exists).map((l) => ({ name: l.name, clips: liveClips(l).map(clipSnap).sort(byStart) }))
    }));
  }
  function allClips() {
    const out = [];
    song.tracks.map((i) => objs[i]).filter(exists).forEach((t) => {
      liveClips(t).forEach((c) => out.push({ track: t, clip: c }));
      t.lanes.map((l) => objs[l]).filter(exists).forEach((l) => liveClips(l).forEach((c) => out.push({ track: t, lane: l, clip: c })));
    });
    return out;
  }
  const live = { ctorHook: null, LiveAPI, clock, song, objs, calls, addTrack, addLane, addClip, snapshot, allClips, clipSnap, liveClips, exists,
    tracks: () => song.tracks.map((i) => objs[i]).filter(exists), select: (c) => { song.view.detail_clip = c ? c.id : 0; },
    endSetup: () => { setup = false; } };
  return live;
}

// ------------------------------------------------------------------------------------------ Max sandbox
function makeSandbox(live, extra) {
  extra = extra || {};
  const outs = [[], [], []];
  const posts = [];
  const clock = live.clock;
  function Task(fn, obj) { this.fn = fn; this.obj = obj; this.due = null; }
  Task.prototype.schedule = function (ms) { this.due = clock.now + (ms || 0); clock.tasks.add(this); };
  Task.prototype.cancel = function () { clock.tasks.delete(this); };
  // Max's File: 'read' opens an existing file; 'write' opens or creates one (never truncates; the folder must exist).
  // position/eof are byte offsets (eof = the size; assigning eof truncates); writestring writes at position.
  function File(p, mode) {
    p = String(p);
    this._p = p; this._pos = 0; this.isopen = false;
    let st = null;
    try { st = fs.statSync(p); } catch (e) { st = null; }
    if (mode === 'read') this.isopen = !!st && st.isFile();
    else if (mode === 'write') {
      if (extra.fileWriteFails) return;
      try { if (!st) fs.writeFileSync(p, '', { flag: 'wx' }); this.isopen = fs.statSync(p).isFile(); } catch (e) { this.isopen = false; }
    }
  }
  Object.defineProperty(File.prototype, 'eof', {
    get: function () { try { return this.isopen ? fs.statSync(this._p).size : 0; } catch (e) { return 0; } },
    set: function (n) { if (this.isopen) fs.truncateSync(this._p, n); }
  });
  Object.defineProperty(File.prototype, 'position', {
    get: function () { return this._pos; }, set: function (n) { this._pos = n; }
  });
  File.prototype.writestring = function (str) {
    assert.ok(str.length <= 2000, 'writestring chunk too long');
    const b2 = Buffer.from(str, 'utf8');
    const fd = fs.openSync(this._p, 'r+');
    try { fs.writeSync(fd, b2, 0, b2.length, this._pos); } finally { fs.closeSync(fd); }
    this._pos += b2.length;
  };
  File.prototype.readstring = function (n) {
    const buf = Buffer.alloc(n);
    const fd = fs.openSync(this._p, 'r');
    let got;
    try { got = fs.readSync(fd, buf, 0, n, this._pos); } finally { fs.closeSync(fd); }
    this._pos += got;
    return buf.subarray(0, got).toString('utf8');
  };
  File.prototype.close = function () { this.isopen = false; };
  const sb = {
    LiveAPI: live.LiveAPI, Task, File,
    post: (s) => posts.push(String(s)),
    outlet: function (n) { outs[n].push(Array.prototype.slice.call(arguments, 1)); },
    messagename: '', max: { version: '915' }, jsarguments: ['bridge.js'],
    ARABRIDGE_LAUNCH_MODE: extra.launchMode,
    ARABRIDGE_NOW: () => clock.now,
    ARABRIDGE_SUPPORT_DIR: extra.supportDir
  };
  if (sb.ARABRIDGE_LAUNCH_MODE === undefined) delete sb.ARABRIDGE_LAUNCH_MODE;
  if (sb.ARABRIDGE_SUPPORT_DIR === undefined) delete sb.ARABRIDGE_SUPPORT_DIR;
  if (extra.jsarguments) sb.jsarguments = extra.jsarguments;
  if (extra.patcherPath) sb.patcher = { filepath: extra.patcherPath };
  if (extra.module) sb.module = { exports: {} };
  vm.createContext(sb);
  vm.runInContext(BUILT_SRC, sb, { filename: 'bridge.js' });
  sb.outs = outs;
  sb.posts = posts;
  return sb;
}

// ------------------------------------------------------------------------------------------ fake runner (contract)
function makeFakeRunner(fx, opts) {
  opts = opts || {};
  const r = { transports: [], launches: [], cancels: 0, statusReqs: 0, findplugins: 0, copies: [], cursor: 0, job: null,
    plugins: opts.plugins || { melodyne: { found: true, path: '/Library/Audio/Plug-Ins/VST3/Melodyne.vst3' }, vocalign: { found: true } },
    answerStatus: opts.answerStatus !== false, autoStart: opts.autoStart !== false, copyMode: opts.copyMode || 'ok',
    noHost: !!opts.noHost, symbol: !!opts.symbol };
  r.support = path.join(fx.home, 'Library', 'Application Support', 'ARABridge');
  r.send = (sel, obj) => { if (r.symbol) fx.sb[sel]('symbol', enc(obj)); else fx.sb[sel](enc(obj)); };
  r.flush = () => {
    let n = 0;
    while (r.cursor < fx.sb.outs[1].length) { const m = fx.sb.outs[1][r.cursor++]; n++; handle(m); }
    return n;
  };
  function handle(m) {
    const sel = m[0];
    if (sel === 'status') { r.statusReqs++; if (r.answerStatus) r.send('hostStatus', r.job ? { state: 'running', jobId: r.job.id } : { state: 'idle' }); return; }
    if (sel === 'findplugins') {
      r.findplugins++;
      if (r.noHost) r.send('hostError', { code: 'no-host', message: 'BridgeHost is not installed (looked for ...). Run tools/install_host.sh' });
      else r.send('hostPlugins', r.plugins);
      return;
    }
    if (sel === 'launch') {
      const d = dec(m[1]);
      r.launches.push(d);
      if (!r.autoStart) return;
      if (r.noHost) { r.send('hostError', { code: 'no-host', message: 'not installed', jobId: d.job.id }); return; }
      const jobDir = path.join(r.support, 'jobs', d.job.id);
      fs.mkdirSync(jobDir, { recursive: true });
      r.job = { id: d.job.id, jobDir, job: d.job };
      r.send('hostStarted', { jobId: d.job.id, jobDir, pid: null, mode: d.mode, startedAt: 'x' });
      return;
    }
    if (sel === 'cancel') { r.cancels++; r.send('hostStatus', r.job ? { state: 'cancelling', step: 'sigterm', jobId: r.job.id } : { state: 'idle' }); return; }
    if (sel === 'transport') { r.transports.push(dec(m[1])); return; }
    if (sel === 'copyresult') {
      const d = dec(m[1]);
      r.copies.push(d);
      const mode = typeof r.copyMode === 'function' ? r.copyMode(d, r.copies.length) : r.copyMode;
      if (mode === 'silent') return;
      if (mode === 'short') fs.mkdirSync(path.dirname(d.to), { recursive: true });
      if (mode === 'fail') { r.send('hostError', { code: 'copy-failed', jobId: d.jobId, message: 'disk full' }); return; }
      assert.strictEqual(path.dirname(d.to), path.join(r.support, 'results'), 'copy target is in the results folder');
      try {
        fs.mkdirSync(path.dirname(d.to), { recursive: true });
        if (mode === 'exists') fs.writeFileSync(d.to, 'someone else');
        fs.copyFileSync(d.from, d.to, fs.constants.COPYFILE_EXCL);
      } catch (e) {
        r.send('hostError', { code: e.code === 'EEXIST' ? 'copy-exists' : 'copy-failed', jobId: d.jobId, message: e.message });
        return;
      }
      r.send('hostCopied', { ok: true, jobId: d.jobId, to: d.to, bytes: mode === 'short' ? 100 : fs.statSync(d.to).size });
      return;
    }
    throw new Error('fake runner: unexpected message ' + sel);
  }
  // The host reports what the user did (Play, Stop, a click in the time ruler): events [{seq, kind, posSec}]
  r.syncEvents = (events) => { r.send('hostStatus', { state: 'transport', jobId: r.job.id, events, mode: 'window', alive: true }); };
  // The host publishes a Live preview: preview-<n>/result.wav (+ result.json), reported by the runner as a `status` message
  // with state "preview". o: {n, frames, resultJson (override), noWav}.
  r.previewN = 0;
  r.preview = (o) => {
    o = o || {};
    const j = r.job;
    assert.ok(j, 'a job is running');
    const n = o.n || ++r.previewN;
    const dir = path.join(j.jobDir, 'preview-' + n);
    const c = j.job.clips[0];
    const rate = c.sampleRate || 44100;
    const frames = o.frames || Math.round((c.endSec - c.startSec) * rate);
    if (!o.noWav) writeWav(path.join(dir, 'result.wav'), frames, rate);
    const rj = o.resultJson !== undefined ? o.resultJson : { version: 1, id: j.id, status: 'ok', message: '', resultPath: path.join(dir, 'result.wav'),
      sourceStartFrame: Math.round(c.startSec * rate), frames, sampleRate: rate, realign: { applied: false, reason: 'nothing-to-do', shiftCount: 0 } };
    r.send('hostStatus', { state: 'preview', n, previewDir: dir, resultJson: rj, jobId: j.id, mode: 'window', alive: true });
    return rj;
  };
  // The host finishes. o: {status, frames, sampleRate, message, realign, resultJson (override), noWav, truncate,
  // oldHost (ignore output "guide" like a BridgeHost without it)}. A job with output "guide" gets the host's window:
  // frames = max(guide, offset + dub), placeAt "guide", offsetFrames, droppedFrames (JobLayout.h).
  r.finish = (o) => {
    o = o || {};
    const j = r.job;
    assert.ok(j, 'a job is running');
    const resultPath = path.join(j.jobDir, 'result.wav');
    let rj;
    if (o.resultJson !== undefined) rj = o.resultJson;
    else {
      const status = o.status || 'ok';
      rj = { version: 1, id: j.id, status, message: o.message || '' };
      if (status === 'ok') {
        const c = j.job.clips[j.job.clips.length - 1];
        const rate = o.sampleRate || c.sampleRate || 44100;
        let frames = o.frames || Math.round((c.endSec - c.startSec) * rate);
        let placement = null;
        if (j.job.output === 'guide' && !o.oldHost) {
          const g = j.job.clips.filter((x) => x.role === 'guide')[0], d = j.job.clips.filter((x) => x.role === 'dub')[0];
          const first = Math.min(g.startBeats, d.startBeats), tempo = j.job.song.tempo;
          const at = (x) => Math.round((x.startBeats - first) * 60 / tempo * rate);
          const offset = at(d) - at(g);
          const gf = Math.round((g.endSec - g.startSec) * rate), df = Math.round((d.endSec - d.startSec) * rate);
          const dropped = Math.min(Math.max(-offset, 0), df);
          placement = { placeAt: 'guide', offsetFrames: Math.max(offset, 0), droppedFrames: dropped };
          if (!o.frames) frames = Math.max(gf, offset + df);
        }
        if (!o.noWav) writeWav(resultPath, frames, rate, { truncate: o.truncate });
        Object.assign(rj, { resultPath, sourceStartFrame: Math.round(c.startSec * rate), frames, sampleRate: rate,
          // as the host: realign is a Melodyne feature, a VocAlign result says not-requested
          realign: o.realign || { applied: false, reason: j.job.plugin === 'vocalign' ? 'not-requested' : 'nothing-to-do', shiftCount: 0 } }, placement || {});
      }
    }
    r.job = null;
    r.send('hostDone', Object.assign({ jobDir: j.jobDir, jobId: j.id, resultJson: rj, exitCode: o.exitCode === undefined ? 0 : o.exitCode,
      signal: o.signal || null, running: false, hostLogTail: '', startedAt: 'x', finishedAt: 'y' }, o.extra || {}));
    return rj;
  };
  return r;
}

// ------------------------------------------------------------------------------------------ fixture
let fxCounter = 0;
// A set: track 0 with the source clip (4 s of an 8 s file at beat 16 -> 8 beats at 120 bpm) and a neighbour at beat 40;
// track 1 empty. Options: live opts, tempo, clip spec overrides, neighbour false, runner opts.
function makeFixture(o) {
  o = o || {};
  const dir = path.join(TMP, 'fx-' + (++fxCounter));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const srcFile = path.join(dir, 'audio files', o.srcName || 'vocal take.wav');
  writeWav(srcFile, 10, 44100);
  const live = makeLive(Object.assign({ tempo: o.tempo || 120, files: { [srcFile]: { frames: 352800, rate: 44100 } } }, o.live || {}));
  const t0 = live.addTrack('1-Vocals', o.trackProps);
  const t1 = live.addTrack('2-Audio');
  const spec = Object.assign({ start: 16, loopStart: 2, loopEnd: 6, file: srcFile, name: 'Vocal take', gain: 0.5 }, o.clip || {});
  const clip = live.addClip(t0, spec);
  let neighbour = null;
  if (o.neighbour !== false) neighbour = live.addClip(t0, { start: o.neighbourStart || 40, loopStart: 0, loopEnd: 2, file: srcFile, name: 'Next' });
  live.select(clip);
  if (o.setup) o.setup(live, { t0, t1, clip, srcFile });
  live.endSetup();
  const fx = { dir, home, live, t0, t1, clip, neighbour, srcFile, initialTrackIds: live.song.tracks.slice() };
  // the ARA Bridge support folder exists (the host installer makes it); the device is told where it is unless a test
  // passes its own sandbox options (then it finds it from the first job folder)
  fx.support = path.join(home, 'Library', 'Application Support', 'ARABridge');
  fs.mkdirSync(fx.support, { recursive: true });
  fx.sb = makeSandbox(live, o.sandbox === undefined ? { supportDir: fx.support } : o.sandbox);
  fx.runner = makeFakeRunner(fx, o.runner);
  fx.initial = live.snapshot();
  fx.origSnap = live.clipSnap(clip);
  fx.status = () => { const s = fx.sb.outs[0]; return s.length ? String(s[s.length - 1][0]) : ''; };
  fx.statuses = () => fx.sb.outs[0].map((a) => String(a[0]));
  fx.ui = (sel) => fx.sb.outs[2].filter((a) => a[0] === sel).map((a) => a.slice(1));
  fx.lastUi = (sel) => { const u = fx.ui(sel); return u.length ? u[u.length - 1] : null; };
  fx.pump = (limit) => {
    for (let i = 0; i < 1000; i++) {
      const a = fx.runner.flush();
      const b2 = live.clock.run(limit === undefined ? 5000 : limit);
      if (!a && !b2) return;
    }
    throw new Error('pump did not settle');
  };
  fx.boot = () => { fx.sb.loadbang(); fx.sb.ready(); fx.pump(); };
  fx.mutations = () => live.calls.filter((c) => !/^set /.test(c.fn) || true).filter((c) => c.fn !== 'REPLACED');
  return fx;
}

// Melodyne through to the end. Returns {fx, launch, result}.
function runMelodyne(o) {
  o = o || {};
  const fx = makeFixture(o);
  fx.boot();
  if (o.placement) fx.sb.settings('placement', o.placement);
  fx.sb.sendMelodyne();
  fx.pump();
  const launch = fx.runner.launches[0];
  let result = null;
  if (launch && o.finish !== false) {
    result = fx.runner.finish(o.finishOpts);
    fx.pump(o.pumpLimit === undefined ? 5000 : o.pumpLimit);
  }
  return { fx, launch, result };
}

const near = (a, b2, tol, msg) => assert.ok(typeof a === 'number' && Math.abs(a - b2) <= tol, (msg || 'near') + ': ' + a + ' vs ' + b2);

// Invariants of every run: no create_audio_clip on a track that existed before; the user's clips other than the
// source are never touched.
function invariants(fx) {
  fx.live.calls.forEach((c) => {
    if (c.fn === 'create_audio_clip') assert.ok(fx.initialTrackIds.indexOf(c.on) < 0, 'create_audio_clip on an existing track main lane');
    if (c.fn === 'REPLACED') assert.fail('Live replaced a clip (id ' + c.on + ')');
  });
  if (fx.neighbour) assert.ok(fx.live.exists(fx.neighbour), 'the neighbour clip is untouched');
}
// The original clip's audio still exists somewhere (main lane or backup track).
function originalSurvives(fx) {
  const orig = fx.origSnap;
  const found = fx.live.allClips().some((e) => {
    const s = fx.live.clipSnap(e.clip);
    return s.file_path === orig.file_path && s.loop_start === orig.loop_start && s.loop_end === orig.loop_end &&
      Math.abs(s.length - orig.length) < 0.01 && s.warping === 0;
  });
  assert.ok(found, 'the original clip is never lost');
}
function resultClipOk(fx, c, startBeats, name, lengthSec) {
  const p = c.props;
  const len = lengthSec === undefined ? 4 : lengthSec;
  assert.strictEqual(p.warping, 0, 'unwarped');
  assert.strictEqual(p.looping, 0, 'not looping');
  near(p.start_time, startBeats, 1e-9, 'start');
  near(p.length * 60 / fx.live.song.tempo, len, 0.002, 'length ' + len + ' s');
  assert.strictEqual(p.name, name);
  near(p.gain, 0.5, 1e-9, 'gain copied');
  assert.ok(/ARABridge\/results\/[^/]+\.wav$/.test(p.file_path), 'clip uses the copied result: ' + p.file_path);
}

// ------------------------------------------------------------------------------------------ tests
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---- build, ES5, packaging
function codeOnly(src) { return src.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, ' '); }
const ES6_PATTERNS = [
  [/\blet\b/, 'let'], [/\bconst\b/, 'const'], [/=>/, 'arrow function'], [/`/, 'template literal'], [/\bclass\b/, 'class'],
  [/\.\.\./, 'spread/rest'], [/\bObject\.assign\b/, 'Object.assign'], [/\.includes\s*\(/, '.includes('],
  [/\bpadStart\b|\bpadEnd\b/, 'padStart/padEnd'], [/\.startsWith\s*\(|\.endsWith\s*\(/, 'startsWith/endsWith'],
  [/\bNumber\.(isFinite|isInteger|isNaN|isSafeInteger|EPSILON)\b/, 'Number.is*'], [/\bArray\.from\b|\bArray\.of\b/, 'Array.from/of'],
  [/\.find\s*\(|\.findIndex\s*\(/, 'find/findIndex'], [/\.repeat\s*\(/, 'repeat'], [/\bObject\.(values|entries)\b/, 'Object.values/entries'],
  [/\bMath\.(trunc|sign|log2|log10|hypot|cbrt)\b/, 'Math.* (ES6)'], [/\bnew\s+(Map|Set|WeakMap|WeakSet)\b/, 'Map/Set'],
  [/\bPromise\b/, 'Promise'], [/\bSymbol\b/, 'Symbol'], [/\basync\b|\bawait\b|\byield\b/, 'async/await/yield'],
  [/function\s*\*/, 'generator'], [/\*\*/, '** operator'], [/\?\./, 'optional chaining'], [/\?\?/, 'nullish coalescing'],
  [/\bfor\s*\([^)]*\sof\s/, 'for...of'], [/\bimport\s|\bexport\s/, 'import/export'], [/\.at\s*\(/, '.at('],
  [/\bString\.raw\b|\.normalize\s*\(|\.codePointAt\s*\(|\bfromCodePoint\b/, 'ES6 string methods']
];
const es5Violations = (src) => ES6_PATTERNS.filter((p) => p[0].test(codeOnly(src))).map((p) => p[1]);

const MESSAGES = ['anything', 'bang', 'cancel', 'hostCopied', 'hostDone', 'hostError', 'hostPlugins', 'hostPong', 'hostStarted',
  'hostStatus', 'loadbang', 'nodeLifecycle', 'notifydeleted', 'placement', 'ready', 'realign', 'refreshPlugins', 'sendMelodyne', 'sendVocAlign',
  'setGuide', 'settings'];

test('built file: ES5 only, node --check, core first, the scanner works', () => {
  assert.deepStrictEqual(es5Violations(BUILT_SRC), []);
  ['let a = 1;', 'var f = (x) => x;', 'a.find(f);', 'x.startsWith("a")'].forEach((c) => assert.ok(es5Violations(c).length, c));
  const r = cp.spawnSync(process.execPath, ['--check', BUILT], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(BUILT_SRC.indexOf('var core = (function') < BUILT_SRC.indexOf('var ARABridge = (function'), 'core.js precedes bridge.js');
  assert.ok(!/\binclude\s*\(/.test(codeOnly(BUILT_SRC)), 'no Max include()');
});

test('built file: the only global functions are the documented inlet messages; ARACore global; works with a module object too', () => {
  const fx = makeFixture();
  const provided = ['LiveAPI', 'Task', 'File', 'post', 'outlet', 'ARABRIDGE_NOW'];
  const fns = Object.keys(fx.sb).filter((k) => typeof fx.sb[k] === 'function' && provided.indexOf(k) < 0).sort();
  assert.deepStrictEqual(fns, MESSAGES.slice().sort());
  assert.ok(MESSAGES.indexOf('error') < 0 && MESSAGES.indexOf('status') < 0, 'no js function named error or status');
  assert.ok(fx.sb.ARACore && typeof fx.sb.ARACore.planPlacement === 'function');
  assert.strictEqual(fx.sb.inlets, 1); assert.strictEqual(fx.sb.outlets, 3); assert.strictEqual(fx.sb.autowatch, 0);
  const fx2 = makeFixture({ sandbox: { module: true } });
  assert.strictEqual(typeof fx2.sb.ARACore, 'undefined', 'with a module object core.js exports instead');
  fx2.boot(); fx2.sb.sendMelodyne(); fx2.pump();
  assert.strictEqual(fx2.runner.launches.length, 1, 'bridge falls back to the core variable');
});

// ---- lifecycle
test('ready: status liveness probe every 2 s until a reply, then findplugins; plugins -> UI and ready line', () => {
  const fx = makeFixture({ runner: { answerStatus: false, plugins: { melodyne: { found: true }, vocalign: { found: false, problem: 'none' } } } });
  fx.sb.loadbang();
  assert.deepStrictEqual(fx.lastUi('busy'), [0]);
  fx.sb.ready();
  fx.live.clock.run(4100); fx.runner.flush();
  assert.strictEqual(fx.runner.statusReqs, 3, 'status at 0, 2, 4 s');
  assert.strictEqual(fx.runner.findplugins, 0);
  fx.runner.answerStatus = true;
  fx.live.clock.run(2100); fx.pump(0);
  assert.strictEqual(fx.runner.findplugins, 1);
  assert.strictEqual(fx.status(), 'Ready. Melodyne: found. VocAlign: not found.');
  assert.deepStrictEqual(fx.lastUi('plugins'), [1, 0]);
  assert.deepStrictEqual(fx.lastUi('host'), [1]);
  fx.pump(20000);
  assert.strictEqual(fx.runner.statusReqs, 4, 'no more probes once alive');
  assert.ok(fx.sb.outs[1].every((m) => m[0] !== 'ping'), 'ping/pong is not used for liveness');
});

test('ready: gives up after 15 probes with a message; sends are refused before ready and before the runner answers', () => {
  const fx = makeFixture({ runner: { answerStatus: false } });
  fx.sb.sendMelodyne();
  assert.strictEqual(fx.status(), 'The device is still starting. Try again in a moment.');
  fx.sb.ready();
  fx.pump(0);
  fx.sb.sendMelodyne();
  assert.ok(/Node script is not running yet/.test(fx.status()), fx.status());
  fx.pump(60000);
  assert.strictEqual(fx.runner.statusReqs, 15);
  assert.ok(/did not start\. Reload the device/.test(fx.status()));
  assert.strictEqual(fx.runner.launches.length, 0);
  assert.strictEqual(fx.live.calls.length, 0, 'nothing was called on Live');
});

// ---- placements
test('takeLane: launch payload equals core.buildJob; result copied; clip on a new lane, unwarped, named, gain; main lane untouched', () => {
  const { fx, launch } = runMelodyne({ placement: 'takeLane' });
  invariants(fx);
  assert.strictEqual(launch.mode, 'window');
  assert.strictEqual(launch.hostPath, undefined, 'never a hostPath from the UI');
  assert.deepStrictEqual(Object.keys(launch).sort(), ['job', 'mode']);
  assert.ok(/^\d{8}-\d{6}-[a-z0-9]{4}$/.test(launch.job.id), launch.job.id);
  const expected = core.buildJob({ id: launch.job.id, createdAt: launch.job.createdAt, plugin: 'melodyne', placement: 'takeLane', realign: true,
    tempo: 120, trackIndex: 0, clips: [{ role: 'source', path: fx.srcFile, startSec: 2, endSec: 6, startBeats: 16, name: 'Vocal take', sampleRate: 44100 }] });
  assert.deepStrictEqual(launch.job, expected.job);
  assert.strictEqual(fx.runner.copies.length, 1);
  const cpy = fx.runner.copies[0];
  assert.strictEqual(cpy.jobId, launch.job.id);
  assert.strictEqual(cpy.to, path.join(fx.runner.support, 'results', launch.job.id + '.wav'));
  assert.ok(fs.existsSync(cpy.to));
  const snap = fx.live.snapshot();
  assert.deepStrictEqual(snap[0].clips, fx.initial[0].clips, 'main lane unchanged');
  assert.strictEqual(fx.t0.lanes.length, 1);
  const lane = fx.live.objs[fx.t0.lanes[0]];
  const lc = fx.live.liveClips(lane);
  assert.strictEqual(lc.length, 1);
  resultClipOk(fx, lc[0], 16, 'Vocal take (Melodyne)');
  assert.strictEqual(lc[0].props.file_path, cpy.to);
  assert.strictEqual(fx.status(), 'Done. No timing shift to correct.');
  assert.deepStrictEqual(fx.lastUi('busy'), [0]);
  assert.deepStrictEqual(fx.ui('busy').map((x) => x[0]), [0, 1, 0]);
  assert.deepStrictEqual(fx.ui('cancel').map((x) => x[0]), [1, 0, 0], 'Cancel enabled while the host runs, disabled after done');
  assert.ok(fx.statuses().indexOf('Melodyne is open (timing correction: on, placement: take lane). Edit, then press Apply in its window. No sound? Choose your interface in the host window\'s Output menu.') >= 0);
  assert.strictEqual(fx.live.clock.tasks.size, 0, 'no task left behind');
});

test('newTrack: track at index+1 with the result clip; nothing else changed', () => {
  const { fx } = runMelodyne({ placement: 'newTrack' });
  invariants(fx);
  const tracks = fx.live.tracks();
  assert.strictEqual(tracks.length, 3);
  assert.strictEqual(tracks[0], fx.t0); assert.strictEqual(tracks[2], fx.t1);
  const c = fx.live.liveClips(tracks[1]);
  assert.strictEqual(c.length, 1);
  resultClipOk(fx, c[0], 16, 'Vocal take (Melodyne)');
  const snap = fx.live.snapshot();
  assert.deepStrictEqual([snap[0], snap[2]], [fx.initial[0], fx.initial[1]]);
});

test('replace: result on the main lane, original on a muted backup track, scratch track removed, neighbour kept', () => {
  const { fx } = runMelodyne({ placement: 'replace' });
  invariants(fx);
  originalSurvives(fx);
  const tracks = fx.live.tracks();
  assert.strictEqual(tracks.length, 3, 'backup track stays, scratch track removed');
  const main = fx.live.liveClips(fx.t0).sort((a, b2) => a.props.start_time - b2.props.start_time);
  assert.strictEqual(main.length, 2);
  assert.ok(!fx.live.exists(fx.clip), 'the source clip was replaced');
  resultClipOk(fx, main[0], 16, 'Vocal take (Melodyne)');
  assert.strictEqual(main[1], fx.neighbour);
  const backup = tracks[1];
  assert.strictEqual(backup.props.mute, 1, 'backup muted');
  const bc = fx.live.liveClips(backup);
  assert.strictEqual(bc.length, 1);
  assert.deepStrictEqual(Object.assign(fx.live.clipSnap(bc[0])), fx.initial[0].clips[0], 'backup is an exact copy of the original');
  assert.strictEqual(fx.status(), 'Done. No timing shift to correct. The original is on the muted backup track.');
  const destructive = fx.live.calls.filter((c) => c.fn === 'delete_clip');
  assert.strictEqual(destructive.length, 1);
  assert.deepStrictEqual(destructive[0].args, ['id', fx.clip.id]);
});

['takeLane', 'newTrack', 'replace'].forEach((mode) => {
  test(mode + ' with delayed visibility (2 settle ticks), string numbers and split names', () => {
    const { fx } = runMelodyne({ placement: mode, live: { delayTicks: 2, stringNumbers: 'all', splitText: true },
      clip: { name: '808 bass take' } });
    invariants(fx);
    assert.ok(/^Done\./.test(fx.status()), fx.status());
    const results = fx.live.allClips().filter((e) => e.clip.props.name === '808 bass take (Melodyne)');
    assert.strictEqual(results.length, 1, 'one result clip');
    if (mode === 'replace') originalSurvives(fx);
  });
});

test('measured clip a (fixture, 131.555 bpm, trimmed 1.82..16.42 s, path with a space) in replace mode', () => {
  const FX1 = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'clip-trimmed-unwarped.json'), 'utf8'));
  const c = FX1.clip;
  const { fx, launch } = runMelodyne({ placement: 'replace', tempo: FX1.song.tempo[0], neighbour: false,
    clip: { start: c.start_time[0], loopStart: c.loop_start[0], loopEnd: c.loop_end[0], gain: c.gain[0], name: 'render_1',
      frames: c.sample_length[0], rate: c.sample_rate[0] } });
  assert.strictEqual(launch.job.clips[0].startSec, c.loop_start[0]);
  assert.strictEqual(launch.job.clips[0].endSec, c.loop_end[0]);
  assert.strictEqual(launch.job.song.tempo, FX1.song.tempo[0]);
  assert.ok(/^Done\./.test(fx.status()), fx.status());
  originalSurvives(fx);
  const main = fx.live.liveClips(fx.t0);
  assert.strictEqual(main.length, 1);
  assert.strictEqual(main[0].props.name, 'render_1 (Melodyne)');
  near(main[0].props.start_time, 32, 1e-9);
  assert.ok(main[0].props.file_path.indexOf('Application Support') >= 0, 'the result path has a space');
});

// ---- refusals
function refusal(o, re, setup) {
  const fx = makeFixture(o);
  fx.boot();
  if (setup) setup(fx);
  fx.sb.sendMelodyne();
  fx.pump();
  assert.ok(re.test(fx.status()), 'status: ' + fx.status() + ' !~ ' + re);
  assert.strictEqual(fx.runner.launches.length, 0, 'nothing launched');
  assert.strictEqual(fx.live.calls.length, 0, 'nothing called on Live');
  assert.deepStrictEqual(fx.live.snapshot(), fx.initial);
  return fx;
}
test('refusals: no clip, MIDI, Session, warped, looping, transposed, frozen, offline, tempo mismatch, take lane', () => {
  refusal({ setup: (l) => l.select(null) }, /^Select an Arrangement audio clip\.$/);
  refusal({ clip: { props: { is_audio_clip: 0 } } }, /MIDI clips are not supported/);
  refusal({ clip: { props: { is_arrangement_clip: 0 } } }, /Session clips are not supported/);
  refusal({ clip: { props: { warping: 1 } } }, /^Warped clips are not supported yet/);
  refusal({ clip: { props: { looping: 1 } } }, /^Looping clips are not supported/);
  refusal({ clip: { props: { pitch_coarse: 2 } } }, /^Transposed clips are not supported/);
  refusal({ trackProps: { is_frozen: 1 } }, /^The track is frozen/);
  refusal({ clip: { file: '/nonexistent/where/vocal.wav' } }, /missing or offline/);
  refusal({ clip: { props: { length: 9 } } }, /^Tempo changes under the clip/);
  refusal({ setup: (l, x) => { const lane = l.addLane(x.t0); const lc = l.addClip(lane, { start: 0, loopStart: 0, loopEnd: 2, file: x.srcFile }); l.select(lc); } },
    /^This clip is on a take lane\. Select a clip on the track's main lane\.$/);
});

test('refusals: host missing (and plug-ins asked again), plug-in not found, busy', () => {
  const fx = refusal({ runner: { noHost: true } }, /^BridgeHost is not installed\. Run tools\/install_host\.sh, then try again\.$/);
  assert.strictEqual(fx.runner.findplugins, 2, 'findplugins sent again on the refusal');
  assert.deepStrictEqual(fx.lastUi('host'), [0]);
  refusal({ runner: { plugins: { melodyne: { found: false }, vocalign: { found: true } } } }, /^Melodyne was not found\. Check that its VST3 is installed\.$/);
  const { fx: f2 } = runMelodyne({ finish: false });
  f2.live.clock.advance(1600);   // past the Send debounce
  f2.sb.sendMelodyne(); f2.pump();
  assert.strictEqual(f2.status(), 'A job is already running for this device. Finish or cancel it first.');
  assert.strictEqual(f2.runner.launches.length, 1);
  f2.runner.finish(); f2.pump();
  assert.ok(/^Done\./.test(f2.status()));
  f2.live.clock.advance(1600);
  f2.sb.sendMelodyne(); f2.pump();
  assert.strictEqual(f2.runner.launches.length, 2, 'a new job after the first finished');
  assert.notStrictEqual(f2.runner.launches[0].job.id, f2.runner.launches[1].job.id);
});

// ---- runner messages
test('cancel while the host runs: cancel sent, cancelled result -> nothing changed, idle', () => {
  const { fx } = runMelodyne({ finish: false });
  fx.sb.cancel(); fx.pump();
  assert.strictEqual(fx.runner.cancels, 1);
  assert.strictEqual(fx.status(), 'Cancelling...');
  fx.runner.finish({ status: 'cancelled', exitCode: 6 }); fx.pump();
  assert.strictEqual(fx.status(), 'Cancelled. Nothing was changed.');
  assert.strictEqual(fx.live.calls.length, 0);
  assert.deepStrictEqual(fx.lastUi('busy'), [0]);
  assert.deepStrictEqual(fx.lastUi('cancel'), [0]);
  fx.sb.cancel();
  assert.strictEqual(fx.status(), 'Nothing to cancel.');
});

test('cancel before started is sent again once started arrives; cancel during placement is refused', () => {
  const fx = makeFixture({ runner: { autoStart: false } });
  fx.boot(); fx.sb.sendMelodyne(); fx.pump();
  fx.sb.cancel(); fx.pump();
  assert.strictEqual(fx.runner.cancels, 1);
  const d = fx.runner.launches[0];
  const jobDir = path.join(fx.runner.support, 'jobs', d.job.id);
  fs.mkdirSync(jobDir, { recursive: true });
  fx.runner.job = { id: d.job.id, jobDir, job: d.job };
  fx.sb.hostStarted(enc({ jobId: d.job.id, jobDir, pid: null }));
  fx.pump(0);
  assert.strictEqual(fx.runner.cancels, 2, 'cancel repeated after started');
  // a run that reaches placement: cancel is refused there
  const { fx: f2 } = runMelodyne({ finish: false, placement: 'replace' });
  f2.runner.finish(); f2.runner.flush(); f2.runner.flush();
  f2.live.clock.run(700);
  f2.sb.cancel();
  assert.strictEqual(f2.status(), 'The result is being placed. Cancel is not possible now.');
  assert.strictEqual(f2.runner.cancels, 0);
  f2.pump();
  assert.ok(/^Done\./.test(f2.status()), f2.status());
});

test('runner errors: launch error with this job id clears busy; unrelated errors do not; launch watchdog', () => {
  const fx = makeFixture({ runner: { autoStart: false } });
  fx.boot(); fx.sb.sendMelodyne(); fx.pump();
  const id = fx.runner.launches[0].job.id;
  fx.sb.hostError(enc({ code: 'findplugins-failed', message: 'x' }));
  assert.deepStrictEqual(fx.lastUi('busy'), [1], 'unrelated error leaves the job alone');
  fx.sb.hostError('symbol', enc({ code: 'spawn-failed', message: 'BridgeHost could not be started: EACCES', jobId: id }));
  assert.ok(/^Could not start the host: BridgeHost could not be started: EACCES$/.test(fx.status()), fx.status());
  assert.deepStrictEqual(fx.lastUi('busy'), [0]);
  // watchdog
  fx.live.clock.advance(1600);
  fx.sb.sendMelodyne(); fx.pump();
  assert.deepStrictEqual(fx.lastUi('busy'), [1]);
  fx.live.clock.run(10001);
  assert.strictEqual(fx.status(), 'The Node script did not answer. Reload the device and try again.');
  assert.deepStrictEqual(fx.lastUi('busy'), [0]);
});

test('done: other job ignored; crash (null result), error, spawnError, missing/short result file; garbage never throws', () => {
  const cases = [
    [{ resultJson: null, exitCode: null, signal: 'SIGKILL' }, /^The host ended without a result \(signal SIGKILL\)\.$/],
    [{ status: 'error', message: 'Melodyne could not be loaded', exitCode: 3 }, /^Failed: Melodyne could not be loaded$/],
    [{ resultJson: null, exitCode: null, extra: { spawnError: 'ENOENT', running: false } }, /^BridgeHost could not be started: ENOENT$/],
    [{ noWav: true }, /^Failed: the result file is missing\.$/],
    [{ truncate: true }, /^Failed: the result file is incomplete\.$/]
  ];
  cases.forEach(([opts, re]) => {
    const { fx } = runMelodyne({ finish: false });
    const id = fx.runner.launches[0].job.id;
    fx.sb.hostDone(enc({ jobId: 'other-job', jobDir: '/x', resultJson: null }));
    assert.deepStrictEqual(fx.lastUi('busy'), [1], 'a done of another job is ignored');
    fx.runner.finish(opts); fx.pump();
    assert.ok(re.test(fx.status()), fx.status() + ' !~ ' + re);
    assert.deepStrictEqual(fx.lastUi('busy'), [0]);
    assert.strictEqual(fx.live.calls.length, 0);
    fx.sb.hostDone(enc({ jobId: id, resultJson: null }));
    assert.ok(re.test(fx.status()), 'a second done changes nothing');
  });
  const fx = makeFixture();
  fx.boot();
  fx.sb.hostDone('%%%'); fx.sb.hostStarted(); fx.sb.hostError('symbol'); fx.sb.hostPlugins(enc([1, 2])); fx.sb.settings('placement');
  fx.sb.messagename = 'frobnicate'; fx.sb.anything();
  assert.strictEqual(fx.status(), 'Unknown message: frobnicate');
  fx.sb.messagename = 'hasOwnProperty'; fx.sb.anything();
  assert.strictEqual(fx.status(), 'Unknown message: hasOwnProperty');
});

test('settings: placement by name and index, realign, bad values; VocAlign never realigns', () => {
  const fx = makeFixture();
  fx.boot();
  fx.sb.settings('placement', 'replace', 'realign', 0);
  fx.sb.sendMelodyne(); fx.pump();
  assert.strictEqual(fx.runner.launches[0].job.placement, 'replace');
  assert.strictEqual(fx.runner.launches[0].job.realign, false);
  fx.runner.finish({ status: 'cancelled' }); fx.pump();
  fx.sb.placement(1); fx.sb.realign(1);
  fx.live.clock.advance(1600);
  fx.sb.sendMelodyne(); fx.pump();
  assert.strictEqual(fx.runner.launches[1].job.placement, 'newTrack');
  assert.strictEqual(fx.runner.launches[1].job.realign, true);
  fx.sb.placement('sideways');
  assert.ok(/^Unknown placement "sideways"/.test(fx.status()));
  fx.sb.realign(7);
  assert.strictEqual(fx.status(), 'realign must be 0 or 1.');
});

test('nodeLifecycle: terminated while the host runs -> idle with a message, liveness re-checked', () => {
  const { fx } = runMelodyne({ finish: false });
  const before = fx.runner.statusReqs;
  fx.sb.nodeLifecycle('terminated');
  assert.ok(/^The Node script stopped \(terminated\)/.test(fx.status()), fx.status());
  assert.deepStrictEqual(fx.lastUi('busy'), [0]);
  fx.pump();
  assert.ok(fx.runner.statusReqs > before, 'status probe again');
  fx.runner.job = null;
  fx.sb.sendMelodyne(); fx.pump();
  assert.strictEqual(fx.runner.launches.length, 2);
});

test('copy: copy-exists moves to the next name; copy-failed and silence fall back to the job file with a note', () => {
  let { fx } = runMelodyne({ runner: { copyMode: (d, n) => (n === 1 ? 'exists' : 'ok') } });
  assert.strictEqual(fx.runner.copies.length, 2);
  assert.ok(/-2\.wav$/.test(fx.runner.copies[1].to), fx.runner.copies[1].to);
  assert.strictEqual(fx.status(), 'Done. No timing shift to correct.');
  ({ fx } = runMelodyne({ runner: { copyMode: 'fail' } }));
  assert.ok(/^Done\. No timing shift to correct\. Note: the result stays in the job folder \(disk full\)\.$/.test(fx.status()), fx.status());
  const lc = fx.live.liveClips(fx.live.objs[fx.t0.lanes[0]]);
  assert.ok(/\/jobs\/[^/]+\/result\.wav$/.test(lc[0].props.file_path));
  ({ fx } = runMelodyne({ runner: { copyMode: 'silent' }, pumpLimit: 31000 }));
  assert.ok(/stays in the job folder \(the copy did not report back\)/.test(fx.status()), fx.status());
  ({ fx } = runMelodyne({ runner: { copyMode: 'short' } }));
  assert.strictEqual(fx.status(), 'Failed: the result file is incomplete.', 'a short copy means a short result.wav');
  assert.strictEqual(fx.live.calls.length, 0, 'nothing placed');
  assert.deepStrictEqual(fx.lastUi('busy'), [0]);
  // a long name with an emoji at the status cut is not split
  const long = 'x'.repeat(228) + '🎤🎤🎤🎤🎤';   // 'Guide set: ' + 228 = 239: the cut at 240 lands inside an emoji
  const { fx: f4 } = runMelodyne({ clip: { name: long }, finish: false });
  f4.sb.setGuide();
  const st = f4.status();
  assert.strictEqual(st.length, 239);
  assert.ok(!/[\uD800-\uDBFF]$/.test(st), 'no lone high surrogate at the end');
});

// ---- stale state at done
test('changed while the host was open: source moved, tempo changed, track deleted -> not placed, nothing changed', () => {
  const variants = [
    [(fx) => { fx.clip.props.start_time += 1; fx.clip.props.end_time += 1; }, /^Not placed: the source clip changed while the host was open; nothing was changed\.$/],
    [(fx) => { fx.live.song.tempo = 100; }, /^Not placed: the song tempo changed while the host was open\. Nothing was changed\.$/],
    [(fx) => { fx.t0.goneAt = 0; }, /^Not placed: the source track was deleted while the host was open\. Nothing was changed\.$/]
  ];
  ['takeLane', 'replace'].forEach((mode) => variants.forEach(([mutate, re]) => {
    const { fx } = runMelodyne({ placement: mode, finish: false });
    mutate(fx);
    const snap = fx.live.snapshot();
    fx.runner.finish(); fx.pump();
    assert.ok(re.test(fx.status()), mode + ': ' + fx.status());
    assert.deepStrictEqual(fx.live.snapshot(), snap);
    assert.strictEqual(fx.live.calls.length, 0);
    assert.deepStrictEqual(fx.lastUi('busy'), [0]);
  }));
});

test('replace refused when the longer result would run into the next clip (nothing changed)', () => {
  const { fx } = runMelodyne({ placement: 'replace', neighbourStart: 24.5, finishOpts: { frames: 44100 * 5 } });
  assert.ok(/^Not placed: the new clip would run into the next clip on the track; nothing was changed\.$/.test(fx.status()), fx.status());
  assert.strictEqual(fx.live.calls.length, 0);
  assert.deepStrictEqual(fx.live.snapshot(), fx.initial);
});

// ---- rollback
test('takeLane rollback: verify fails -> lane clip removed, empty lane left and reported; main lane untouched', () => {
  const { fx } = runMelodyne({ placement: 'takeLane', live: { faults: [{ fn: 'set warping', mode: 'wrongLength' }] } });
  invariants(fx);
  assert.strictEqual(fx.status(), 'Not placed: Checking the result clip failed (length 4.500 s, expected 4.000 s). The set is unchanged except for an empty take lane.');
  const snap = fx.live.snapshot();
  assert.deepStrictEqual(snap[0].clips, fx.initial[0].clips);
  assert.deepStrictEqual(snap[0].lanes, [{ name: 'Take 1', clips: [] }]);
  assert.deepStrictEqual(snap.slice(1), fx.initial.slice(1));
  const { fx: f2 } = runMelodyne({ placement: 'takeLane', live: { trackDeletesLaneClips: false, faults: [{ fn: 'set warping', mode: 'wrongLength' }] } });
  assert.ok(/\. An empty take lane was left\. Check the track: Removing the new clip failed \(the clip is still there\)\.$/.test(f2.status()), f2.status());
  assert.ok(!/Nothing was changed|unchanged/.test(f2.status()), 'no "nothing changed" claim with leftovers');
});

test('newTrack rollback: clip creation throws -> new track removed; track creation does nothing -> nothing to undo', () => {
  let { fx } = runMelodyne({ placement: 'newTrack', live: { faults: [{ fn: 'create_audio_clip', mode: 'throw' }] } });
  invariants(fx);
  assert.ok(/^Not placed: Placing the result clip failed \(fault: create_audio_clip\)\. Nothing was changed\.$/.test(fx.status()), fx.status());
  assert.deepStrictEqual(fx.live.snapshot(), fx.initial);
  ({ fx } = runMelodyne({ placement: 'newTrack', live: { faults: [{ fn: 'create_audio_track', mode: 'noop' }] } }));
  assert.ok(/^Not placed: Creating new track failed \(the new track did not appear\)\. Nothing was changed\.$/.test(fx.status()), fx.status());
  assert.deepStrictEqual(fx.live.snapshot(), fx.initial);
  ({ fx } = runMelodyne({ placement: 'newTrack', live: { faults: [{ fn: 'create_audio_clip', mode: 'throwAfter' }] } }));
  assert.deepStrictEqual(fx.live.snapshot(), fx.initial, 'a clip made despite the error is removed with its track');
});

// Replace failure table: [name, faults, expected status regex, expected end state: 'initial' | function]
const REPLACE_FAILURES = [
  ['backup copy never appears', [{ fn: 'duplicate_clip_to_arrangement', nth: 1, mode: 'noop' }], /^Not placed: Copying the original to the backup track failed \(the new clip did not appear\)\. Nothing was changed\.$/, 'initial'],
  ['backup copy has the wrong length', [{ fn: 'duplicate_clip_to_arrangement', nth: 1, mode: 'wrongLength' }], /^Not placed: Checking the backup copy failed \(length 9\.000 beats, expected 8\.000\)\. Nothing was changed\.$/, 'initial'],
  ['mute is not applied', [{ fn: 'set mute', mode: 'noop' }], /^Not placed: Muting the backup track failed \(mute reads 0\)\. Nothing was changed\.$/, 'initial'],
  ['scratch track creation throws', [{ fn: 'create_audio_track', nth: 2, mode: 'throw' }], /^Not placed: Creating scratch track failed \(fault: create_audio_track\)\. Nothing was changed\.$/, 'initial'],
  ['result clip creation throws', [{ fn: 'create_audio_clip', mode: 'throw' }], /^Not placed: Placing the result clip failed/, 'initial'],
  ['result length wrong after warping 0', [{ fn: 'set warping', nth: 1, mode: 'wrongLength' }], /^Not placed: Checking the result clip failed \(length 4\.500 s/, 'initial'],
  ['destructive delete does nothing', [{ fn: 'delete_clip', nth: 1, mode: 'noop' }], /^Not placed: Removing the original clip failed \(the clip is still there\)\. Nothing was changed\.$/, 'initial'],
  ['destructive delete throws before acting', [{ fn: 'delete_clip', nth: 1, mode: 'throw' }], /^Not placed: Removing the original clip failed \(fault: delete_clip\)\. Nothing was changed\.$/, 'initial'],
  ['destructive delete throws after acting, source leaves the list 2 ticks later', [{ fn: 'delete_clip', nth: 1, mode: 'throwAfter' }], /^Not placed: Removing the original clip failed \(Live reported an error: fault \(after acting\): delete_clip\)\. The original clip was restored\.$/, 'initial', { delayTicks: 2 }],
  ['final duplicate never appears', [{ fn: 'duplicate_clip_to_arrangement', nth: 2, mode: 'noop' }], /^Not placed: Moving the result onto the track failed \(the new clip did not appear\)\. The original clip was restored\.$/, 'initial'],
  ['final clip has the wrong length', [{ fn: 'duplicate_clip_to_arrangement', nth: 2, mode: 'wrongLength' }], /^Not placed: Checking the result clip failed \(length 4\.500 s, expected 4\.000 s\)\. The original clip was restored\.$/, 'initial'],
  ['restore fails', [{ fn: 'duplicate_clip_to_arrangement', nth: 2, mode: 'noop' }, { fn: 'duplicate_clip_to_arrangement', nth: 3, mode: 'noop' }], /^Something went wrong\. The original clip is on the muted backup track\. \(Restoring the original clip failed/, (fx, snap) => {
    assert.strictEqual(snap.length, 4, 'backup and scratch tracks kept');
    assert.strictEqual(snap[1].mute, 1);
    assert.deepStrictEqual(snap[1].clips, fx.initial[0].clips.slice(0, 1), 'the original is on the backup track');
  }],
  ['restored copy fails its verify', [{ fn: 'duplicate_clip_to_arrangement', nth: 2, mode: 'noop' }, { fn: 'duplicate_clip_to_arrangement', nth: 3, mode: 'wrongLength' }], /^Something went wrong\. The original clip is on the muted backup track\. \(Checking the restored original failed/, (fx, snap) => {
    assert.strictEqual(snap.length, 4);
    assert.deepStrictEqual(snap[1].clips, fx.initial[0].clips.slice(0, 1));
  }],
  ['destructive delete: the clip list becomes unreadable (cannot tell)', [{ fn: 'delete_clip', nth: 1, mode: 'breakLists' }], /^Something went wrong\. The original clip is on the muted backup track\. \(Removing the original clip failed .*could not tell whether the original is still on the track\)$/, (fx, snap) => {
    assert.strictEqual(snap.length, 4, 'nothing was deleted');
    assert.deepStrictEqual(snap[1].clips, fx.initial[0].clips.slice(0, 1));
  }]
];
REPLACE_FAILURES.forEach(([name, faults, re, end, liveExtra]) => {
  test('replace rollback: ' + name, () => {
    const { fx } = runMelodyne({ placement: 'replace', live: Object.assign({ faults }, liveExtra || {}) });
    invariants(fx);
    originalSurvives(fx);
    assert.ok(re.test(fx.status()), 'status: ' + fx.status());
    const snap = fx.live.snapshot();
    if (end === 'initial') assert.deepStrictEqual(snap, fx.initial, 'the set is back to its initial state');
    else end(fx, snap);
    assert.deepStrictEqual(fx.lastUi('busy'), [0]);
    assert.strictEqual(fx.live.clock.tasks.size, 0);
    // never a delete of something that was not made by the sequence, apart from the one destructive delete
    const deletes = fx.live.calls.filter((c) => c.fn === 'delete_clip');
    deletes.forEach((c, i) => { if (i > 0) assert.notStrictEqual(c.args[1], fx.clip.id, 'the source is deleted at most once'); });
    assert.ok(fx.live.calls.filter((c) => c.fn === 'delete_clip' && c.args[1] === fx.neighbour.id).length === 0);
  });
});

test('an exception inside a step is caught: rollback, status, never thrown into Max', () => {
  const { fx } = runMelodyne({ placement: 'newTrack', finish: false });
  let n = 0;
  // the 2nd LiveAPI by id after the new track appeared: the target of create_audio_clip, before the call
  fx.live.ctorHook = (p) => { if (/^id /.test(p) && fx.live.tracks().length === 3 && ++n === 2) throw new Error('boom'); };
  fx.runner.finish(); fx.pump();
  assert.ok(n >= 2, 'the hook fired');
  assert.ok(/^Not placed: .* failed \(internal error: boom\)\. Nothing was changed\.$/.test(fx.status()), fx.status());
  assert.deepStrictEqual(fx.live.snapshot(), fx.initial);
  assert.deepStrictEqual(fx.lastUi('busy'), [0]);
  // an exception while re-reading after a call (3rd: identifying the new clip) is retried: the clip is found
  const { fx: f3 } = runMelodyne({ placement: 'newTrack', finish: false });
  let m = 0;
  f3.live.ctorHook = (p) => { if (/^id /.test(p) && f3.live.tracks().length === 3 && ++m === 3) throw new Error('boom'); };
  f3.runner.finish(); f3.pump();
  assert.ok(/^Done\./.test(f3.status()), f3.status());
  // a getter that throws is only a failed read (verify retries, then succeeds here)
  let k = 0;
  const { fx: f2 } = runMelodyne({ placement: 'newTrack', live: { getHook: (o, prop) => { if (o.type === 'Clip' && prop === 'looping' && ++k === 2) throw new Error('boom'); } } });
  assert.ok(/^Done\./.test(f2.status()), f2.status());
});

// ---- VocAlign
function vocalignFixture(o) {
  o = o || {};
  const fx = makeFixture(Object.assign({ setup: (l, x) => {
    x.guide = l.addClip(x.t1, { start: 8, loopStart: 1, loopEnd: 5, file: x.srcFile, name: o.guideName || 'Lead guide' });
    if (o.setup) o.setup(l, x);
  } }, o.fx || {}));
  return fx;
}
test('VocAlign: guide memory, two-clip job (output guide) equals core.buildJob, the result starts at the guide (on the dub track)', () => {
  let guide;
  const fx = vocalignFixture({ setup: (l, x) => { guide = x.guide; } });
  fx.boot();
  fx.sb.sendVocAlign();
  assert.strictEqual(fx.status(), 'Set a guide first: select the guide clip and press Set guide.');
  fx.live.select(guide);
  fx.sb.setGuide();
  assert.strictEqual(fx.status(), 'Guide set: Lead guide (2-Audio). Now select the dub clip and press Send to VocAlign.');
  assert.deepStrictEqual(fx.lastUi('guide'), [1]);
  fx.sb.sendVocAlign();
  assert.strictEqual(fx.status(), 'The dub is the guide clip. Select a different clip for the dub.');
  fx.live.select(fx.clip);
  fx.sb.settings('placement', 'newTrack', 'realign', 1);
  fx.sb.sendVocAlign(); fx.pump();
  const launch = fx.runner.launches[0];
  const exp = core.buildJob({ id: launch.job.id, createdAt: launch.job.createdAt, plugin: 'vocalign', placement: 'newTrack', realign: false, output: 'guide', tempo: 120, trackIndex: 0,
    clips: [{ role: 'guide', path: fx.srcFile, startSec: 1, endSec: 5, startBeats: 8, name: 'Lead guide', sampleRate: 44100 },
      { role: 'dub', path: fx.srcFile, startSec: 2, endSec: 6, startBeats: 16, name: 'Vocal take', sampleRate: 44100 }] });
  assert.ok(exp.ok, exp.reason);
  assert.deepStrictEqual(launch.job, exp.job);
  assert.strictEqual(launch.job.output, 'guide');
  assert.strictEqual(fx.status(), 'VocAlign is open (placement: new track). Capture guide and dub, align, then press Apply. No sound? Choose your interface in the host window\'s Output menu.');
  // guide [8, 16) beats, dub [16, 24): the result window is [8, 24) = 8 s, the dub inside it from 4 s
  const rj = fx.runner.finish(); fx.pump();
  assert.strictEqual(rj.placeAt, 'guide'); assert.strictEqual(rj.offsetFrames, 176400); assert.strictEqual(rj.frames, 352800);
  assert.strictEqual(fx.status(), 'Done.');
  const tracks = fx.live.tracks();
  assert.strictEqual(tracks.length, 3);
  const c = fx.live.liveClips(tracks[1]);
  assert.strictEqual(c.length, 1);
  resultClipOk(fx, c[0], 8, 'Vocal take (VocAlign)', 8);
  assert.deepStrictEqual(fx.live.snapshot()[2], fx.initial[1], 'guide track untouched');
  // the guide survives a second send
  fx.live.clock.advance(1600);
  fx.sb.sendVocAlign(); fx.pump();
  assert.strictEqual(fx.runner.launches.length, 2);
  assert.deepStrictEqual(fx.runner.launches[1].job.clips[0], exp.job.clips[0]);
});

test('VocAlign refusals: plug-in missing, rate mismatch, tempo changed since the guide, guide file gone', () => {
  let fx = vocalignFixture({ fx: { runner: { plugins: { melodyne: { found: true }, vocalign: { found: false } } } } });
  fx.boot(); fx.sb.setGuide();
  assert.strictEqual(fx.status(), 'VocAlign was not found. Check that its VST3 is installed.');
  fx = vocalignFixture({ setup: (l, x) => { x.guide.props.sample_rate = 48000; x.guide.props.sample_length = 480000; x.guide.props.loop_end = 5; } });
  fx.boot();
  fx.live.select(fx.live.objs[fx.t1.clips[0]]); fx.sb.setGuide();
  fx.live.select(fx.clip); fx.sb.sendVocAlign();
  assert.strictEqual(fx.status(), 'Guide and dub must have the same sample rate (guide 48000 Hz, dub 44100 Hz).');
  fx = vocalignFixture();
  fx.boot();
  fx.live.select(fx.live.objs[fx.t1.clips[0]]); fx.sb.setGuide();
  fx.live.song.tempo = 100;
  [fx.clip].forEach((c) => { c.props.length = 4 * 100 / 60; c.props.end_time = c.props.start_time + c.props.length; });
  fx.live.select(fx.clip); fx.sb.sendVocAlign();
  assert.strictEqual(fx.status(), 'The song tempo changed since the guide was set. Set the guide again.');
  fx = vocalignFixture({ fx: { srcName: 'guide.wav' } });
  fx.boot();
  fx.live.select(fx.live.objs[fx.t1.clips[0]]); fx.sb.setGuide();
  const dubFile = path.join(fx.dir, 'dub.wav'); writeWav(dubFile, 10, 44100);
  fx.clip.props.file_path = dubFile;
  fs.unlinkSync(fx.srcFile);
  fx.live.select(fx.clip); fx.sb.sendVocAlign();
  assert.strictEqual(fx.status(), 'The guide clip\'s audio file is missing. Set the guide again.');
  assert.strictEqual(fx.runner.launches.length, 0);
});

test('unicode names: job, status and result clip keep them', () => {
  const name = 'Größe 🎤 take – ü';
  const { fx, launch } = runMelodyne({ placement: 'newTrack', clip: { name } });
  assert.strictEqual(launch.job.clips[0].name, name);
  assert.ok(/^Done\./.test(fx.status()));
  const c = fx.live.liveClips(fx.live.tracks()[1]);
  assert.strictEqual(c[0].props.name, name + ' (Melodyne)');
  const f2 = vocalignFixture({ guideName: 'Gúide ✓' });
  f2.boot(); f2.live.select(f2.live.objs[f2.t1.clips[0]]); f2.sb.setGuide();
  assert.strictEqual(f2.status(), 'Guide set: Gúide ✓ (2-Audio). Now select the dub clip and press Send to VocAlign.');
});

// ---- review follow-ups
test('replace: the final scratch-track removal failing after the verified result is a warning, the result stays', () => {
  const { fx } = runMelodyne({ placement: 'replace', live: { faults: [{ fn: 'delete_track', mode: 'noop' }] } });
  invariants(fx);
  originalSurvives(fx);
  assert.strictEqual(fx.status(), 'Done. No timing shift to correct. The original is on the muted backup track. Note: the temporary scratch track could not be removed; delete it by hand.');
  const tracks = fx.live.tracks();
  assert.strictEqual(tracks.length, 4, 'source, backup, scratch, other');
  const main = fx.live.liveClips(fx.t0).sort((a, b2) => a.props.start_time - b2.props.start_time);
  resultClipOk(fx, main[0], 16, 'Vocal take (Melodyne)');
  assert.strictEqual(tracks[1].props.mute, 1);
  assert.strictEqual(fx.live.calls.filter((c) => c.fn === 'duplicate_clip_to_arrangement').length, 2, 'no restore was run');
});

function guideRun(mutate, when) {
  const fx = vocalignFixture();
  fx.boot();
  const guide = fx.live.objs[fx.t1.clips[0]];
  fx.live.select(guide); fx.sb.setGuide();
  fx.live.select(fx.clip);
  if (when === 'before') mutate(fx, guide);
  fx.sb.sendVocAlign(); fx.pump();
  return { fx, guide };
}
test('VocAlign: the guide is re-checked at Send (moved, trimmed, deleted, other file, moved to a take lane)', () => {
  const mutations = [
    ['moved 8 -> 12', (fx, g) => { g.props.start_time += 4; g.props.end_time += 4; }],
    ['trimmed', (fx, g) => { g.props.loop_end -= 0.5; g.props.end_time -= 1; g.props.length -= 1; }],
    ['deleted (file still there)', (fx, g) => { g.goneAt = 0; }],
    ['other file', (fx, g) => { g.props.file_path = fx.srcFile.replace('vocal take', 'other'); }],
    ['moved to a take lane', (fx, g) => {
      const lane = fx.live.addLane(fx.t1);
      fx.t1.clips.splice(fx.t1.clips.indexOf(g.id), 1); lane.clips.push(g.id); g.parent = lane.id;
    }]
  ];
  mutations.forEach(([name, mutate]) => {
    const { fx } = guideRun(mutate, 'before');
    assert.strictEqual(fx.status(), 'The guide clip changed or was removed since Set guide. Set the guide again.', name);
    assert.strictEqual(fx.runner.launches.length, 0, name + ': nothing launched');
  });
  const { fx } = guideRun(() => {}, 'before');
  assert.strictEqual(fx.runner.launches.length, 1, 'an unchanged guide launches');
});

test('VocAlign: the guide moved while the host was open -> not placed, nothing changed', () => {
  const { fx, guide } = guideRun(() => {}, 'never');
  assert.strictEqual(fx.runner.launches.length, 1);
  guide.props.start_time = 12; guide.props.end_time = 20;
  const snap = fx.live.snapshot();
  fx.runner.finish(); fx.pump();
  assert.strictEqual(fx.status(), 'Not placed: the guide clip changed or was removed while the host was open. Nothing was changed.');
  assert.deepStrictEqual(fx.live.snapshot(), snap);
  assert.strictEqual(fx.live.calls.length, 0);
  assert.deepStrictEqual(fx.lastUi('busy'), [0]);
});

// VocAlign runs through to the result. o: {placement, guideStart, guideLoop: [s, e], dubStart, setup, finish}
function vocalignRun(o) {
  o = o || {};
  const fx = makeFixture({ clip: o.dubStart === undefined ? {} : { start: o.dubStart }, neighbour: o.neighbour, neighbourStart: o.neighbourStart,
    setup: (l, x) => {
      const loop = o.guideLoop || [1, 5];
      x.guide = l.addClip(x.t1, { start: o.guideStart === undefined ? 8 : o.guideStart, loopStart: loop[0], loopEnd: loop[1], file: x.srcFile, name: 'Lead guide' });
      if (o.setup) o.setup(l, x);
    } });
  fx.boot();
  fx.guideClip = fx.live.objs[fx.t1.clips[0]];
  fx.live.select(fx.guideClip); fx.sb.setGuide();
  fx.live.select(fx.clip);
  if (o.placement) fx.sb.settings('placement', o.placement);
  fx.sb.sendVocAlign(); fx.pump();
  if (o.finish !== false && fx.runner.launches.length) { fx.rj = fx.runner.finish(o.finishOpts); fx.pump(); }
  return fx;
}

test('VocAlign takeLane: the result clip starts at the guide (dub later and earlier than the guide), on a lane of the dub track', () => {
  // dub [16, 24) after the guide [8, 16): result [8, 24), 8 s
  let fx = vocalignRun({ placement: 'takeLane' });
  assert.strictEqual(fx.status(), 'Done.');
  assert.strictEqual(fx.t0.lanes.length, 1);
  let c = fx.live.liveClips(fx.live.objs[fx.t0.lanes[0]]);
  assert.strictEqual(c.length, 1);
  resultClipOk(fx, c[0], 8, 'Vocal take (VocAlign)', 8);
  assert.deepStrictEqual(fx.live.clipSnap(fx.clip), fx.origSnap, 'the dub is untouched');
  invariants(fx);
  // guide [20, 28) and dub [16, 24): the dub's first 2 s lie before the guide and are dropped; result [20, 28), 4 s
  fx = vocalignRun({ placement: 'takeLane', guideStart: 20 });
  assert.strictEqual(fx.rj.droppedFrames, 88200); assert.strictEqual(fx.rj.frames, 176400);
  assert.strictEqual(fx.status(), 'Done. The first 2.00 s of the dub lay before the guide and were left out.');
  c = fx.live.liveClips(fx.live.objs[fx.t0.lanes[0]]);
  resultClipOk(fx, c[0], 20, 'Vocal take (VocAlign)', 4);
  invariants(fx);
});

test('VocAlign newTrack: the result clip starts at the guide, on a new track below the dub track', () => {
  const fx = vocalignRun({ placement: 'newTrack', guideStart: 12, guideLoop: [1, 3] });   // guide [12, 16), dub [16, 24): result [12, 24), 6 s
  assert.strictEqual(fx.status(), 'Done.');
  const tracks = fx.live.tracks();
  assert.strictEqual(tracks.length, 3);
  const c = fx.live.liveClips(tracks[1]);
  assert.strictEqual(c.length, 1);
  resultClipOk(fx, c[0], 12, 'Vocal take (VocAlign)', 6);
  assert.deepStrictEqual(fx.live.snapshot()[2], fx.initial[1], 'guide track untouched');
  invariants(fx);
});

test('VocAlign replace: the dub is replaced by the result at the guide start; the original is on the backup track', () => {
  const fx = vocalignRun({ placement: 'replace', guideStart: 12 });     // guide [12, 20), dub [16, 24): result [12, 24)
  assert.ok(/^Done\. The original is on the muted backup track\.$/.test(fx.status()), fx.status());
  const main = fx.live.liveClips(fx.t0);
  assert.strictEqual(main.length, 2, 'result and the neighbour');
  resultClipOk(fx, main.filter((x) => x.props.name === 'Vocal take (VocAlign)')[0], 12, 'Vocal take (VocAlign)', 6);
  assert.ok(!fx.live.exists(fx.clip), 'the dub was replaced');
  originalSurvives(fx);
  invariants(fx);
});

test('VocAlign replace refused when the result at the guide start would land on another clip of the dub track', () => {
  // a user clip at [10, 14) on the dub track; the result would start at the guide (12), inside it
  const fx = vocalignRun({ placement: 'replace', guideStart: 12, setup: (l, x) => { x.blocker = l.addClip(x.t0, { start: 10, loopStart: 0, loopEnd: 2, file: x.srcFile, name: 'Blocker' }); } });
  assert.strictEqual(fx.status(), 'Not placed: the new clip would overwrite another clip on the track; nothing was changed.');
  assert.deepStrictEqual(fx.live.snapshot(), fx.initial);
  assert.strictEqual(fx.live.calls.length, 0);
  // the same with a clip inside the result window before the dub, [12.5, 14): run into
  const fy = vocalignRun({ placement: 'replace', guideStart: 12, setup: (l, x) => { l.addClip(x.t0, { start: 13, loopStart: 0, loopEnd: 1, file: x.srcFile, name: 'Blocker' }); } });
  assert.strictEqual(fy.status(), 'Not placed: the new clip would run into the next clip on the track; nothing was changed.');
  assert.deepStrictEqual(fy.live.snapshot(), fy.initial);
});

test('VocAlign: the dub moved while the host was open -> not placed at the guide, nothing changed', () => {
  const fx = vocalignRun({ placement: 'takeLane', finish: false });
  fx.clip.props.start_time += 2; fx.clip.props.end_time += 2;
  const snap = fx.live.snapshot();
  fx.runner.finish(); fx.pump();
  assert.strictEqual(fx.status(), 'Not placed: the source clip changed while the host was open; nothing was changed.');
  assert.deepStrictEqual(fx.live.snapshot(), snap);
  assert.strictEqual(fx.live.calls.length, 0);
});

test('VocAlign: a dub that ends before the guide starts is refused at Send', () => {
  const fx = vocalignRun({ guideStart: 30, guideLoop: [1, 3] });     // dub [16, 24), guide [30, 34)
  assert.strictEqual(fx.status(), 'The dub clip ends before the guide clip starts. Move it so that it overlaps the guide.');
  assert.strictEqual(fx.runner.launches.length, 0);
  const fy = vocalignRun({ guideStart: 24, guideLoop: [1, 3] });     // the dub ends exactly at the guide start
  assert.strictEqual(fy.runner.launches.length, 0);
  const fz = vocalignRun({ guideStart: 23.9, guideLoop: [1, 3] });   // reaches just past it: fine
  assert.strictEqual(fz.runner.launches.length, 1);
});

test('VocAlign with an older BridgeHost (no placeAt): placed at the dub as the result is laid out, with a note', () => {
  const fx = vocalignRun({ placement: 'takeLane', finishOpts: { oldHost: true } });
  assert.strictEqual(fx.rj.placeAt, undefined);
  assert.strictEqual(fx.status(), 'Done. Note: placed at the dub, not the guide: update BridgeHost (tools/install_host.sh).');
  const c = fx.live.liveClips(fx.live.objs[fx.t0.lanes[0]]);
  resultClipOk(fx, c[0], 16, 'Vocal take (VocAlign)', 4);
});

test('guards: a user clip dropped on the new/scratch track mid-sequence keeps that track; only our clip is removed', () => {
  ['newTrack', 'replace'].forEach((mode) => {
    let userClip = null;
    const holder = {};
    const { fx } = runMelodyne({ placement: mode, live: {
      faults: [{ fn: 'set warping', nth: 1, mode: 'wrongLength' }],
      readHook: (o, prop) => {
        // as soon as the result clip exists, the user drops a clip on the same track
        if (!userClip && prop === 'warping' && holder.fx && /ARABridge\/results\//.test(o.props.file_path)) {
          userClip = holder.fx.live.addClip(holder.fx.live.objs[o.parent], { start: 100, loopStart: 0, loopEnd: 1, file: holder.fx.srcFile, name: 'User drop' });
        }
        return undefined;
      } }, finish: false });
    holder.fx = fx;
    fx.runner.finish(); fx.pump();
    assert.ok(userClip, mode + ': the user clip was dropped');
    assert.ok(fx.live.exists(userClip), mode + ': the user clip is kept');
    const host = fx.live.objs[userClip.parent];
    assert.ok(fx.live.exists(host), mode + ': its track is kept');
    assert.deepStrictEqual(fx.live.liveClips(host).map((c) => c.props.name), ['User drop'], mode + ': our result clip on it was removed');
    assert.ok(/^Not placed: Checking the result clip failed .*\. Check the track: Removing the new track failed \(the track holds a clip ARA Bridge did not make; it was left in place\)\.$/.test(fx.status()), mode + ': ' + fx.status());
    assert.ok(!/Nothing was changed/.test(fx.status()));
    if (mode === 'replace') { originalSurvives(fx); assert.deepStrictEqual(fx.live.snapshot()[0], fx.initial[0], 'source untouched'); }
  });
});

test('guards: Live removing a foreign clip on the duplicate target is a failure; the original is restored', () => {
  const { fx } = runMelodyne({ placement: 'replace', live: { faults: [{ fn: 'duplicate_clip_to_arrangement', nth: 2, mode: 'removeOther' }] } });
  originalSurvives(fx);
  assert.strictEqual(fx.status(), 'Not placed: Moving the result onto the track failed (Live removed 1 clip(s) where the new clip landed). The original clip was restored.');
  const main = fx.live.liveClips(fx.t0);
  assert.strictEqual(main.length, 1, 'the neighbour was lost by Live (reported), the original is back');
  assert.deepStrictEqual(fx.live.clipSnap(main[0]), fx.origSnap);
});

test('verify: Warp reads 1 at verify time, or Warp off leaves Loop on -> rollback', () => {
  // Warp off was confirmed (the clip still had its file name then); once named, the clip reads Warp 1 again
  let { fx } = runMelodyne({ placement: 'newTrack', live: { readHook: (o, prop) => {
    if (prop === 'warping' && o.props.name === 'Vocal take (Melodyne)') return 1;
    return undefined;
  } } });
  assert.strictEqual(fx.status(), 'Not placed: Checking the result clip failed (Warp is 1). Nothing was changed.');
  assert.deepStrictEqual(fx.live.snapshot(), fx.initial);
  ({ fx } = runMelodyne({ placement: 'takeLane', live: { faults: [{ fn: 'set warping', mode: 'keepLooping' }] } }));
  assert.strictEqual(fx.status(), 'Not placed: Checking the result clip failed (Loop is 1). The set is unchanged except for an empty take lane.');
});

test('guards: plan ops outside the rules are refused by the executor (set/delete on user objects, main-lane create)', () => {
  const evil = [
    ['set on the source track', { op: 'set', target: 'track', label: 'Evil set', property: 'mute', value: 1 }, /Evil set failed \(refused: only objects made by ARA Bridge are changed\)/],
    ['create on the main lane', { op: 'create_audio_clip', target: 'track', label: 'Evil create', args: ['/x.wav', 0], produces: 'evil' }, /Evil create failed \(refused: clips are never created on the main lane of an existing track\)/],
    ['non-destructive delete of the source', { op: 'delete_clip', target: 'track', label: 'Evil delete', args: [{ ref: 'sourceClip', id: 0 }] }, /Evil delete failed \(refused: only clips made by ARA Bridge are removed\)/],
    ['delete of a user track', { op: 'delete_track', target: 'song', label: 'Evil track delete', args: [{ ref: 'track' }] }, /Evil track delete failed \(refused: only tracks made by ARA Bridge are removed\)/]
  ];
  evil.forEach(([name, op, re]) => {
    const { fx } = runMelodyne({ placement: 'newTrack', finish: false });
    const orig = fx.sb.ARACore.planPlacement;
    fx.sb.ARACore.planPlacement = function (spec) {
      const p = orig(spec);
      const o = JSON.parse(JSON.stringify(op));
      if (o.args && o.args[0] && o.args[0].ref === 'sourceClip') o.args[0].id = fx.clip.id;
      p.ops.splice(1, 0, o);
      return p;
    };
    fx.runner.finish(); fx.pump();
    assert.ok(re.test(fx.status()), name + ': ' + fx.status());
    assert.deepStrictEqual(fx.live.snapshot(), fx.initial, name + ': nothing changed');
    assert.strictEqual(fx.live.calls.filter((c) => c.on === fx.t0.id || c.on === fx.clip.id).length, 0, name + ': the user track and clip were never called');
  });
});

test('pick: a new clip without a returned id is adopted only at the requested position', () => {
  let { fx } = runMelodyne({ placement: 'newTrack', live: { faults: [{ fn: 'create_audio_clip', mode: 'noReturn' }] } });
  assert.ok(/^Done\./.test(fx.status()), fx.status());
  ({ fx } = runMelodyne({ placement: 'newTrack', live: { faults: [{ fn: 'create_audio_clip', mode: 'noReturnWrongPos' }] } }));
  assert.ok(/^Not placed: Placing the result clip failed \(the new clip did not appear\)\. Check the track: Removing the new track failed \(the track holds a clip ARA Bridge did not make; it was left in place\)\.$/.test(fx.status()), fx.status());
  const stray = fx.live.liveClips(fx.live.tracks()[1]);
  assert.strictEqual(stray.length, 1, 'the unidentified clip is left alone, never deleted');
  near(stray[0].props.start_time, 17, 1e-9);
});

test('notifydeleted: every Task stops, later messages are ignored, a replace in progress is noted', () => {
  const { fx } = runMelodyne({ placement: 'replace', finish: false });
  fx.runner.finish(); fx.runner.flush(); fx.runner.flush();
  fx.live.clock.run(1000);
  assert.ok(fx.live.clock.tasks.size > 0, 'placement in progress');
  const calls = fx.live.calls.length;
  fx.sb.notifydeleted();
  assert.strictEqual(fx.live.clock.tasks.size, 0, 'no Task left');
  assert.ok(fx.sb.posts.some((p) => /original clip is on the muted backup track/.test(p)));
  const outs = fx.sb.outs.map((o) => o.length);
  fx.sb.sendMelodyne(); fx.sb.ready(); fx.sb.hostStatus(enc({ state: 'idle' }));
  fx.live.clock.run(60000);
  assert.deepStrictEqual(fx.sb.outs.map((o) => o.length), outs, 'nothing is sent after deletion');
  assert.strictEqual(fx.live.calls.length, calls, 'no LiveAPI call after deletion');
});

test('ready again during a job keeps the status; a leading symbol is skipped for settings/placement/realign', () => {
  const { fx } = runMelodyne({ finish: false });
  const st = fx.status();
  fx.sb.ready(); fx.pump(0);
  assert.strictEqual(fx.status(), st);
  fx.runner.finish({ status: 'cancelled' }); fx.pump();
  fx.sb.placement('symbol', 'replace');
  fx.sb.realign('symbol', 0);
  fx.live.clock.advance(1600);
  fx.sb.sendMelodyne(); fx.pump();
  assert.strictEqual(fx.runner.launches[1].job.placement, 'replace');
  assert.strictEqual(fx.runner.launches[1].job.realign, false);
  fx.runner.finish({ status: 'cancelled' }); fx.pump();
  fx.sb.settings('symbol', 'placement', 'newTrack', 'realign', 1);
  fx.live.clock.advance(1600);
  fx.sb.sendMelodyne(); fx.pump();
  assert.strictEqual(fx.runner.launches[2].job.placement, 'newTrack');
  assert.strictEqual(fx.runner.launches[2].job.realign, true);
});

test('open status shows timing correction and placement; received settings are logged', () => {
  const fx = makeFixture();
  fx.boot();
  fx.sb.settings('placement', 2);
  fx.sb.settings('realign', 0);
  fx.sb.sendMelodyne(); fx.pump();
  assert.strictEqual(fx.status(), 'Melodyne is open (timing correction: off, placement: replace). Edit, then press Apply in its window. No sound? Choose your interface in the host window\'s Output menu.');
  assert.ok(fx.sb.posts.some((p) => /received settings placement 2/.test(p)), 'raw settings logged');
  assert.ok(fx.sb.posts.some((p) => /placement is now replace/.test(p)));
  assert.ok(fx.sb.posts.some((p) => /realign \(timing correction\) is now off/.test(p)));
  fx.runner.finish({ status: 'cancelled' }); fx.pump();
  fx.sb.placement(1); fx.sb.realign(1);
  fx.live.clock.advance(1600);
  fx.sb.sendMelodyne(); fx.pump();
  assert.strictEqual(fx.status(), 'Melodyne is open (timing correction: on, placement: new track). Edit, then press Apply in its window. No sound? Choose your interface in the host window\'s Output menu.');
});

test('launch: a runner busy within 3 s is retried once after 1.5 s; a second busy, a late busy and a cancel in between', () => {
  function setup() {
    const fx = makeFixture({ runner: { autoStart: false } });
    fx.boot(); fx.sb.sendMelodyne(); fx.pump(0);
    return fx;
  }
  const busy = (fx) => fx.sb.hostError(enc({ code: 'busy', message: 'A job is already running (old).', jobId: fx.runner.launches[0].job.id }));
  // retried, then started
  let fx = setup();
  fx.live.clock.advance(500);
  busy(fx);
  assert.deepStrictEqual(fx.lastUi('busy'), [1], 'not given up yet');
  fx.live.clock.advance(1400); fx.runner.flush();
  assert.strictEqual(fx.runner.launches.length, 1, 'not before 1.5 s');
  fx.live.clock.advance(200); fx.runner.flush();
  assert.strictEqual(fx.runner.launches.length, 2, 'launched again');
  assert.deepStrictEqual(fx.runner.launches[1], fx.runner.launches[0], 'the same launch payload');
  const d = fx.runner.launches[1];
  const jobDir = path.join(fx.runner.support, 'jobs', d.job.id);
  fs.mkdirSync(jobDir, { recursive: true });
  fx.runner.job = { id: d.job.id, jobDir, job: d.job };
  fx.sb.hostStarted(enc({ jobId: d.job.id, jobDir, pid: null }));
  assert.ok(/^Melodyne is open/.test(fx.status()), fx.status());
  fx.runner.finish(); fx.pump();
  assert.ok(/^Done\./.test(fx.status()), fx.status());
  // busy again after the retry -> the busy message
  fx = setup();
  busy(fx); fx.live.clock.advance(1600); fx.runner.flush();
  assert.strictEqual(fx.runner.launches.length, 2);
  busy(fx);
  assert.strictEqual(fx.status(), 'The host is still busy with an earlier job. Wait for it to finish.');
  assert.deepStrictEqual(fx.lastUi('busy'), [0]);
  fx.live.clock.advance(20000); fx.runner.flush();
  assert.strictEqual(fx.runner.launches.length, 2, 'no third launch');
  // busy later than 3 s after the launch -> no retry
  fx = setup();
  fx.live.clock.advance(3100);
  busy(fx);
  assert.strictEqual(fx.status(), 'The host is still busy with an earlier job. Wait for it to finish.');
  fx.live.clock.advance(5000); fx.runner.flush();
  assert.strictEqual(fx.runner.launches.length, 1);
  // cancel while waiting for the retry -> no second launch
  fx = setup();
  busy(fx); fx.sb.cancel(); fx.runner.flush();
  fx.live.clock.advance(1600); fx.runner.flush();
  assert.strictEqual(fx.runner.launches.length, 1);
  assert.strictEqual(fx.status(), 'Cancelled. Nothing was changed.');
  assert.deepStrictEqual(fx.lastUi('busy'), [0]);
  assert.strictEqual(fx.live.calls.length, 0);
});

// ---- no self-launch, Send debounce, device.log
test('no launch ever follows a finished job: every ending, then 60 s of clock (timers, retries, watchdogs)', () => {
  const launchesOut = (fx) => fx.sb.outs[1].filter((m) => m[0] === 'launch').length;
  const endings = [
    ['takeLane ok', { placement: 'takeLane' }],
    ['newTrack ok', { placement: 'newTrack' }],
    ['replace ok', { placement: 'replace' }],
    ['replace rolled back', { placement: 'replace', live: { faults: [{ fn: 'duplicate_clip_to_arrangement', nth: 2, mode: 'noop' }] } }],
    ['copy fallback', { runner: { copyMode: 'fail' } }],
    ['cancelled', { finishOpts: { status: 'cancelled', exitCode: 6 } }],
    ['crashed', { finishOpts: { resultJson: null, exitCode: null, signal: 'SIGKILL' } }],
    ['stale source', { finish: false }]
  ];
  endings.forEach(([name, o]) => {
    const { fx } = runMelodyne(o);
    if (name === 'stale source') { fx.clip.props.start_time += 1; fx.clip.props.end_time += 1; fx.runner.finish(); fx.pump(); }
    assert.deepStrictEqual(fx.lastUi('busy'), [0], name + ': idle');
    const n = launchesOut(fx);
    assert.strictEqual(n, 1, name);
    for (let t = 0; t < 60; t++) { fx.live.clock.advance(1000); fx.runner.flush(); }
    assert.strictEqual(launchesOut(fx), 1, name + ': no launch in the 60 s after the job ended');
    assert.strictEqual(fx.live.clock.tasks.size, 0, name + ': no timer left');
  });
  // busy retry, then started and done; and a busy retry whose job ended by an error before the retry fired
  const fx = makeFixture({ runner: { autoStart: false } });
  fx.boot(); fx.sb.sendMelodyne(); fx.pump(0);
  const id = fx.runner.launches[0].job.id;
  fx.sb.hostError(enc({ code: 'busy', message: 'old job', jobId: id }));
  fx.sb.hostError(enc({ code: 'spawn-failed', message: 'x', jobId: id }));
  assert.deepStrictEqual(fx.lastUi('busy'), [0]);
  for (let t = 0; t < 60; t++) { fx.live.clock.advance(1000); fx.runner.flush(); }
  assert.strictEqual(launchesOut(fx), 1, 'the scheduled retry of an ended job never fires');
  // VocAlign
  const v = vocalignFixture();
  v.boot(); v.live.select(v.live.objs[v.t1.clips[0]]); v.sb.setGuide(); v.live.select(v.clip);
  v.sb.sendVocAlign(); v.pump(); v.runner.finish(); v.pump();
  assert.ok(/^Done\./.test(v.status()));
  for (let t = 0; t < 60; t++) { v.live.clock.advance(1000); v.runner.flush(); }
  assert.strictEqual(launchesOut(v), 1, 'VocAlign: no second launch');
});

test('Send debounce: a Send within 1.5 s after a job ended or after the previous Send is ignored (status keeps the last line)', () => {
  const { fx } = runMelodyne({});
  assert.strictEqual(fx.status(), 'Done. No timing shift to correct.');
  fx.live.clock.advance(1000);
  fx.sb.sendMelodyne(); fx.pump(0);
  assert.strictEqual(fx.status(), 'Ignored a repeated Send click. Done. No timing shift to correct.');
  assert.strictEqual(fx.runner.launches.length, 1);
  fx.live.clock.advance(600);
  fx.sb.sendMelodyne(); fx.pump(0);
  assert.strictEqual(fx.runner.launches.length, 2, 'accepted 1.6 s after the end');
  fx.live.clock.advance(300);
  fx.sb.sendMelodyne();
  assert.strictEqual(fx.status(), 'Ignored a repeated Send click. Melodyne is open (timing correction: on, placement: take lane). Edit, then press Apply in its window. No sound? Choose your interface in the host window\'s Output menu.');
  fx.live.clock.advance(1300);
  fx.sb.sendMelodyne();
  assert.strictEqual(fx.status(), 'A job is already running for this device. Finish or cancel it first.', 'later: the busy refusal');
  assert.strictEqual(fx.runner.launches.length, 2);
  const log = fs.readFileSync(path.join(fx.runner.support, 'device.log'), 'utf8');
  assert.ok(/send ignored \(debounce: 1000 ms after the last finish/.test(log), 'debounce logged');
  // VocAlign is debounced too; setGuide is not
  const v = vocalignFixture();
  v.boot(); v.live.select(v.live.objs[v.t1.clips[0]]); v.sb.setGuide(); v.live.select(v.clip);
  v.sb.sendVocAlign(); v.pump(); v.runner.finish({ status: 'cancelled' }); v.pump();
  v.sb.sendVocAlign();
  assert.ok(/^Ignored a repeated Send click\./.test(v.status()));
  v.live.select(v.live.objs[v.t1.clips[0]]); v.sb.setGuide();
  assert.ok(/^Guide set: Lead guide /.test(v.status()), v.status());
});

test('device.log: one line per inlet message, launch, finish and busy change; buffered until the folder is known; rotation', () => {
  const { fx, launch } = runMelodyne({ placement: 'newTrack', sandbox: {} });   // folder learned from the job folder
  const id = launch.job.id;
  const file = path.join(fx.runner.support, 'device.log');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  lines.forEach((l) => assert.ok(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z \S+ /.test(l), 'timestamp and job id: ' + l));
  const has = (re, msg) => assert.ok(lines.some((l) => re.test(l)), msg + ' in device.log');
  has(/ - in ready /, 'ready, written before the folder was known (buffered)');
  has(/ - in sendMelodyne /, 'the Send click');
  has(new RegExp(' ' + id + ' launch ' + id + ' plugin=melodyne placement=newTrack realign=true clip=Vocal take'), 'launch');
  has(new RegExp(' in hostStarted jobId=' + id), 'started');
  has(new RegExp(' in hostDone jobId=' + id + ' result=ok exit=0'), 'done');
  has(new RegExp(' in hostCopied jobId=' + id + ' to=/'), 'copied');
  has(new RegExp(' ' + id + ' finish ' + id + ' \\(placing\\): Done\\.'), 'finish');
  has(/ ui busy 1$/, 'busy on'); has(/ ui busy 0$/, 'busy off');
  const iSend = lines.findIndex((l) => / in sendMelodyne /.test(l));
  const iLaunch = lines.findIndex((l) => / launch \S+ plugin=/.test(l));
  assert.ok(iSend >= 0 && iSend < iLaunch, 'the inlet message that triggered the launch comes right before it');
  // rotation above ~200 KB
  fs.writeFileSync(file, 'x'.repeat(210000) + '\n');
  fx.sb.refreshPlugins();
  assert.ok(fs.statSync(file + '.1').size >= 210000, 'old log moved to device.log.1');
  assert.ok(fs.statSync(file).size < 5000, 'device.log started again');
  // a folder that does not exist: nothing is written, nothing throws
  const f2 = makeFixture({ sandbox: { supportDir: path.join(TMP, 'no', 'such', 'folder') } });
  f2.boot(); f2.sb.sendMelodyne(); f2.pump(); f2.runner.finish(); f2.pump();
  assert.ok(/^Done\./.test(f2.status()), f2.status());
  assert.ok(!fs.existsSync(path.join(TMP, 'no')));
  // a File that cannot be opened for writing at all
  const f3 = makeFixture({ sandbox: { fileWriteFails: true } });
  f3.boot(); f3.sb.sendMelodyne(); f3.pump(); f3.runner.finish(); f3.pump();
  assert.ok(/^Done\./.test(f3.status()), f3.status());
});

// ---- the guide shared between device instances (guide.json)
// Device A sits on the guide track, device B on the dub track; both see the same Live set, clock and folder.
function twoDevices(o) {
  o = o || {};
  const a = vocalignFixture();
  const b = Object.assign({}, a);
  b.sb = makeSandbox(a.live, Object.assign({ supportDir: a.support }, o.sandboxB || {}));
  b.runner = makeFakeRunner(b, o.runnerB);
  b.status = () => { const st = b.sb.outs[0]; return st.length ? String(st[st.length - 1][0]) : ''; };
  b.pump = () => { for (let i = 0; i < 1000; i++) { const x = b.runner.flush() + a.runner.flush(); const y = a.live.clock.run(5000); if (!x && !y) return; } };
  a.boot();
  b.sb.loadbang(); b.sb.ready(); b.pump();
  a.guideClip = a.live.objs[a.t1.clips[0]];
  a.setGuideOn = (dev, clip) => { a.live.select(clip); dev.sb.setGuide(); };
  return { a, b };
}
const GUIDE_JOB_CLIP = (fx) => ({ role: 'guide', path: fx.srcFile, startSec: 1, endSec: 5, startBeats: 8, name: 'Lead guide', sampleRate: 44100 });

test('shared guide: A sets it (guide.json written), B sends to VocAlign with A\'s guide region and places its dub', () => {
  const { a, b } = twoDevices();
  a.setGuideOn(a, a.guideClip);
  assert.strictEqual(a.status(), 'Guide set: Lead guide (2-Audio). Now select the dub clip and press Send to VocAlign.');
  const g = JSON.parse(fs.readFileSync(path.join(a.support, 'guide.json'), 'utf8'));
  assert.strictEqual(g.format, 'arabridge-guide'); assert.strictEqual(g.version, 1);
  assert.strictEqual(g.clipId, a.guideClip.id); assert.strictEqual(g.trackId, a.t1.id); assert.strictEqual(g.trackName, '2-Audio');
  assert.ok(/^[a-z0-9]{8}$/.test(g.setId)); assert.strictEqual(typeof g.setAt, 'number');
  assert.strictEqual(g.region.startBeats, 8); assert.strictEqual(g.region.endBeats, 16); assert.strictEqual(g.region.startSec, 1);
  assert.strictEqual(g.region.endSec, 5); assert.strictEqual(g.region.path, a.srcFile); assert.strictEqual(g.region.sampleRate, 44100);
  assert.strictEqual(g.tempo, 120);
  a.live.select(a.clip);
  b.sb.sendVocAlign(); b.pump();
  assert.strictEqual(b.runner.launches.length, 1, 'B launched: ' + b.status());
  assert.strictEqual(a.runner.launches.length, 0);
  const job = b.runner.launches[0].job;
  assert.deepStrictEqual(job.clips[0], GUIDE_JOB_CLIP(a));
  assert.strictEqual(job.clips[1].startBeats, 16);
  b.runner.finish(); b.pump();
  assert.ok(/^Done\./.test(b.status()), b.status());
  assert.ok(a.live.allClips().some((e) => e.clip.props.name === 'Vocal take (VocAlign)'));
});

test('shared guide: moved, trimmed, deleted after A set it, tempo changed, same clip as the dub -> B refuses', () => {
  const cases = [
    ['moved', (a) => { a.guideClip.props.start_time += 4; a.guideClip.props.end_time += 4; }, /^The guide clip changed or was removed since Set guide\. Set the guide again\.$/],
    ['trimmed', (a) => { a.guideClip.props.loop_start += 0.01; a.guideClip.props.start_marker += 0.01; }, /^The guide clip changed or was removed since Set guide\. Set the guide again\.$/],
    ['deleted', (a) => { a.guideClip.goneAt = 0; }, /^The guide clip changed or was removed since Set guide\. Set the guide again\.$/],
    ['tempo changed', (a) => { a.live.song.tempo = 100; a.clip.props.length = 4 * 100 / 60; a.clip.props.end_time = 16 + a.clip.props.length; },
      /^The song tempo changed since the guide was set\. Set the guide again\.$/]
  ];
  cases.forEach(([name, mutate, re]) => {
    const { a, b } = twoDevices();
    a.setGuideOn(a, a.guideClip);
    mutate(a);
    a.live.select(a.clip);
    b.sb.sendVocAlign(); b.pump();
    assert.ok(re.test(b.status()), name + ': ' + b.status());
    assert.strictEqual(b.runner.launches.length, 0, name);
  });
  const { a, b } = twoDevices();
  a.setGuideOn(a, a.guideClip);
  b.sb.sendVocAlign(); b.pump();   // the guide clip is still selected
  assert.strictEqual(b.status(), 'The dub is the guide clip. Select a different clip for the dub.');
});

test('shared guide: a missing, corrupt or other-format guide.json is no guide', () => {
  const contents = [null, '{not json', JSON.stringify({ clipId: 5, region: {} }), JSON.stringify({ format: 'arabridge-guide', version: 2 }), ''];
  contents.forEach((text) => {
    const { a, b } = twoDevices();
    const file = path.join(a.support, 'guide.json');
    if (text !== null) fs.writeFileSync(file, text);
    a.live.select(a.clip);
    b.sb.sendVocAlign(); b.pump();
    assert.strictEqual(b.status(), 'Set a guide first: select the guide clip and press Set guide.', String(text));
    assert.strictEqual(b.runner.launches.length, 0);
    if (text !== null) assert.strictEqual(fs.readFileSync(file, 'utf8'), text, 'the file is never deleted or changed by a send');
  });
});

test('shared guide: the newest wins (file vs memory); a failed write keeps the in-memory guide working', () => {
  // B sets guide 1 (memory + file); later A sets guide 2 on another clip (file): B uses guide 2
  let { a, b } = twoDevices();
  const other = a.live.addClip(a.t1, { start: 20, loopStart: 0, loopEnd: 2, file: a.srcFile, name: 'Second guide' });
  a.setGuideOn(b, a.guideClip);
  a.live.clock.advance(1000);
  a.setGuideOn(a, other);
  a.live.select(a.clip);
  b.sb.sendVocAlign(); b.pump();
  assert.strictEqual(b.runner.launches[0].job.clips[0].name, 'Second guide', 'the newer guide from the file');
  // A sets guide 1 (file); later B cannot write the file and sets guide 2 in memory: B uses its own, newer guide
  ({ a, b } = twoDevices({ sandboxB: { fileWriteFails: true } }));
  const other2 = a.live.addClip(a.t1, { start: 20, loopStart: 0, loopEnd: 2, file: a.srcFile, name: 'B memory guide' });
  a.setGuideOn(a, a.guideClip);
  a.live.clock.advance(1000);
  a.setGuideOn(b, other2);
  assert.strictEqual(b.status(), 'Guide set: B memory guide (2-Audio). Now select the dub clip and press Send to VocAlign. (Only this device knows it: guide.json could not be written.)');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(a.support, 'guide.json'), 'utf8')).name, 'Lead guide', 'the file still holds A\'s guide');
  a.live.select(a.clip);
  b.sb.sendVocAlign(); b.pump();
  assert.strictEqual(b.runner.launches[0].job.clips[0].name, 'B memory guide', 'memory newer than the file');
  // and A (no memory of B's guide) uses the file's guide
  a.live.clock.advance(1600);
  a.sb.sendVocAlign(); a.pump();
  assert.strictEqual(a.runner.launches[0].job.clips[0].name, 'Lead guide');
});

test('guide.json and device.log are pure ASCII; a long umlaut/emoji name and path round-trip through 2000-byte chunks', () => {
  const longName = 'Größe Ü 🎤 '.repeat(260);   // > 2000 UTF-8 bytes
  const { a, b } = twoDevices();
  const dir = path.join(a.dir, 'Ünïcödé 🎧 folder');
  fs.mkdirSync(dir, { recursive: true });
  const uniFile = path.join(dir, 'Gesang – Strophe 1 🎤.wav');
  writeWav(uniFile, 10, 44100);
  const guide = a.live.addClip(a.t1, { start: 16, loopStart: 0, loopEnd: 2, file: uniFile, name: longName, frames: 441000 });
  a.setGuideOn(a, guide);
  assert.ok(/^Guide set: Größe Ü/.test(a.status()), a.status());
  const file = path.join(a.support, 'guide.json');
  const bytes = fs.readFileSync(file);
  assert.ok(bytes.length > 4000, 'longer than two read chunks: ' + bytes.length);
  assert.ok(bytes.every((x) => x < 0x7f), 'guide.json is pure ASCII');
  const g = JSON.parse(bytes.toString('ascii'));
  assert.strictEqual(g.region.name, longName);
  assert.strictEqual(g.region.path, uniFile);
  a.live.select(a.clip);
  b.sb.sendVocAlign(); b.pump();
  assert.strictEqual(b.runner.launches.length, 1, 'B read the guide back: ' + b.status());
  const gc = b.runner.launches[0].job.clips[0];
  assert.strictEqual(gc.path, uniFile, 'the unicode path survives the byte chunks');
  const expectedName = core.buildJob({ id: 'x1', plugin: 'vocalign', tempo: 120, clips: [
    { role: 'guide', path: uniFile, startSec: 0, endSec: 2, startBeats: 16, name: longName },
    { role: 'dub', path: uniFile, startSec: 0, endSec: 2, startBeats: 0, name: 'd' }] }).job.clips[0].name;
  assert.strictEqual(gc.name, expectedName);
  const log = fs.readFileSync(path.join(a.support, 'device.log'));
  assert.ok(log.every((x) => x < 0x7f || x === 0x0a), 'device.log is pure ASCII');
  assert.ok(/\\u00f6/.test(log.toString('ascii')), 'non-ASCII written as \\uXXXX');
});

// ---- integration: real runner + real BridgeHost --autorender, placement on the fake Live
// ---- Live preview (two Preview tracks A and B take turns; the source clip is muted while a preview exists)
function previewFixture(o) {
  o = o || {};
  const fx = makeFixture(o);
  fx.boot();
  if (o.placement) fx.sb.settings('placement', o.placement);
  if (o.preview !== false) fx.sb.settings('preview', 1);
  fx.sb.sendMelodyne();
  fx.pump();
  fx.launch = fx.runner.launches[0];
  return fx;
}
const previewTracksOf = (fx) => fx.live.tracks().filter((t) => fx.initialTrackIds.indexOf(t.id) < 0);
const srcMuted = (fx) => fx.clip.props.muted;
function previewClipOk(fx, track, n) {
  const c = fx.live.liveClips(track);
  assert.strictEqual(c.length, 1, 'one clip on the Preview track');
  const p = c[0].props;
  assert.strictEqual(p.warping, 0, 'unwarped');
  assert.strictEqual(p.looping, 0);
  near(p.start_time, 16, 1e-9, 'at the source clip\'s position');
  near(p.length * 60 / fx.live.song.tempo, 4, 0.002, 'as long as the source region');
  near(p.gain, 0.5, 1e-9, 'gain copied');
  assert.ok(p.file_path.endsWith('/preview-' + n + '/result.wav'), 'plays the host\'s preview file: ' + p.file_path);
}
// exactly one Preview track is audible; its clip is preview n
function audible(fx, n) {
  const pt = previewTracksOf(fx);
  const open = pt.filter((t) => t.props.mute === 0);
  assert.strictEqual(open.length, 1, 'one audible Preview track: ' + pt.map((t) => t.name + ' mute=' + t.props.mute).join(', '));
  previewClipOk(fx, open[0], n);
  pt.filter((t) => t !== open[0]).forEach((t) => { assert.strictEqual(t.props.mute, 1, t.name + ' is silent'); assert.strictEqual(fx.live.liveClips(t).length, 0, t.name + ' holds no clip'); });
  return open[0];
}

test('live preview: the job asks for it; A, then B, then A again: the new clip goes onto the silent track, then the tracks swap', () => {
  const fx = previewFixture();
  invariants(fx);
  assert.strictEqual(fx.launch.job.preview, true);
  assert.ok(/live preview: on/.test(fx.statuses().filter((x) => /Melodyne is open/.test(x))[0]), 'the open line says so');
  assert.strictEqual(srcMuted(fx), 0, 'nothing is muted before the first preview');
  fx.runner.preview();
  fx.pump();
  let tracks = fx.live.tracks();
  assert.strictEqual(tracks.length, 3);
  assert.strictEqual(tracks[0], fx.t0); assert.strictEqual(tracks[2], fx.t1);
  const a = tracks[1];
  assert.strictEqual(a.name, 'Preview A: Vocal take');
  assert.strictEqual(audible(fx, 1), a);
  assert.strictEqual(fx.live.liveClips(a)[0].props.name, 'Vocal take (preview)');
  assert.strictEqual(srcMuted(fx), 1, 'the original clip (not its track) is muted while a preview plays');
  assert.strictEqual(fx.t0.props.mute, 0, 'the user\'s track is not muted');
  assert.ok(/^Preview 1 is playing from the Preview track; the original clip is muted/.test(fx.status()), fx.status());
  assert.deepStrictEqual(fx.live.snapshot()[0].clips.map((c) => c.name), fx.initial[0].clips.map((c) => c.name), 'the user\'s clips are all still there');
  assert.strictEqual(fx.runner.copies.length, 0, 'previews are not copied');
  assert.deepStrictEqual(fx.lastUi('busy'), [1], 'the job is still busy: the window is open');

  fx.runner.preview();
  fx.pump();
  tracks = fx.live.tracks();
  assert.strictEqual(tracks.length, 4, 'track B was made');
  assert.deepStrictEqual(tracks.map((t) => t.name), ['1-Vocals', 'Preview A: Vocal take', 'Preview B: Vocal take', '2-Audio']);
  const b = audible(fx, 2);
  assert.strictEqual(b, tracks[2]);
  assert.strictEqual(a.props.mute, 1);

  fx.runner.preview();
  fx.pump();
  assert.strictEqual(fx.live.tracks().length, 4, 'no third track: A is used again');
  assert.strictEqual(audible(fx, 3), a, 'preview 3 plays from A again');
  assert.strictEqual(srcMuted(fx), 1);
  assert.strictEqual(fx.live.clock.tasks.size, 0);
  assert.deepStrictEqual(fx.live.snapshot()[3], fx.initial[1], 'the user\'s other track is untouched');
});

test('live preview: a swap never leaves two audible Preview tracks for long, and the old clip is removed after the swap', () => {
  const fx = previewFixture();
  fx.runner.preview(); fx.pump();
  fx.runner.preview(); fx.pump();
  const calls = fx.live.calls.filter((c) => c.fn === 'set mute' || c.fn === 'delete_clip').map((c) => c.fn + (c.args ? ' ' + c.args[0] : ''));
  const lastSets = fx.live.calls.filter((c) => c.fn === 'set mute').slice(-2).map((c) => c.args[0]);
  assert.deepStrictEqual(lastSets, [0, 1], 'the new track is unmuted, then the old one muted: ' + calls.join(' | '));
});

test('live preview: Apply restores the original clip, removes both Preview tracks, then places the result (all three placements)', () => {
  for (const placement of ['takeLane', 'newTrack', 'replace']) {
    const fx = previewFixture({ placement });
    fx.runner.preview(); fx.pump();
    fx.runner.preview(); fx.pump();
    assert.strictEqual(fx.live.tracks().length, 4);
    assert.strictEqual(srcMuted(fx), 1);
    fx.runner.finish();
    fx.pump();
    invariants(fx);
    assert.ok(/^Done\./.test(fx.status()), placement + ': ' + fx.status());
    assert.ok(!/Preview/.test(fx.live.tracks().map((t) => t.name).join('|')), placement + ': the Preview tracks are gone');
    const names = fx.live.allClips().map((e) => fx.live.clipSnap(e.clip).name);
    assert.ok(names.every((n) => !/preview/.test(n)), placement + ': no preview clip is left: ' + names.join(', '));
    const want = { takeLane: 2, newTrack: 3, replace: 3 }[placement];
    assert.strictEqual(fx.live.tracks().length, want, placement + ': track count');
    if (placement === 'replace') originalSurvives(fx);
    else assert.strictEqual(srcMuted(fx), 0, placement + ': the original clip is audible again');
    // in replace mode the original was unmuted BEFORE it was copied to the backup track: the backup clip is not muted
    if (placement === 'replace') fx.live.allClips().forEach((e) => assert.strictEqual(e.clip.props.muted, 0, 'no clip is left muted'));
    assert.deepStrictEqual(fx.lastUi('busy'), [0]);
    assert.strictEqual(fx.live.clock.tasks.size, 0);
  }
});

test('live preview: Cancel (or a failed job) removes the Preview tracks, unmutes the original and says what the job said', () => {
  let fx = previewFixture();
  fx.runner.preview(); fx.pump();
  fx.runner.preview(); fx.pump();
  assert.strictEqual(fx.live.tracks().length, 4);
  fx.runner.finish({ status: 'cancelled', message: 'closed without applying', resultJson: { version: 1, id: fx.runner.job.id, status: 'cancelled', message: 'closed without applying' } });
  fx.pump();
  assert.deepStrictEqual(fx.live.snapshot(), fx.initial, 'back to the initial set');
  assert.strictEqual(srcMuted(fx), 0, 'the original clip is audible again');
  assert.ok(/ancel/.test(fx.status()), fx.status());
  assert.deepStrictEqual(fx.lastUi('busy'), [0]);
  assert.strictEqual(fx.live.clock.tasks.size, 0);

  fx = previewFixture();
  fx.runner.preview(); fx.pump();
  fx.runner.finish({ status: 'error', message: 'the plug-in crashed', resultJson: { version: 1, id: fx.runner.job.id, status: 'error', message: 'the plug-in crashed' } });
  fx.pump();
  assert.deepStrictEqual(fx.live.snapshot(), fx.initial);
  assert.strictEqual(srcMuted(fx), 0);
  assert.ok(/the plug-in crashed/.test(fx.status()), fx.status());
});

test('live preview: a source clip the user had muted stays muted (the device only unmutes what it muted)', () => {
  const fx = previewFixture({ setup: (live, o) => { o.clip.props.muted = 1; } });
  fx.runner.preview(); fx.pump();
  assert.strictEqual(srcMuted(fx), 1);
  fx.runner.finish({ status: 'cancelled', resultJson: { version: 1, id: fx.runner.job.id, status: 'cancelled', message: 'x' } });
  fx.pump();
  assert.strictEqual(srcMuted(fx), 1, 'still muted: it was the user\'s mute');
});

test('live preview: the host ends while a preview is being placed -> the preview finishes, then the result is placed', () => {
  const fx = previewFixture({ placement: 'newTrack' });
  fx.runner.preview();      // the sequence starts at once ...
  fx.runner.finish();       // ... and Apply arrives before it ends
  fx.pump();
  invariants(fx);
  assert.ok(/^Done\./.test(fx.status()), fx.status());
  assert.ok(!/Preview/.test(fx.live.tracks().map((t) => t.name).join('|')));
  assert.strictEqual(fx.live.tracks().length, 3, 'preview tracks removed, result track added');
  assert.strictEqual(srcMuted(fx), 0);
  resultClipOk(fx, fx.live.liveClips(fx.live.tracks()[1])[0], 16, 'Vocal take (Melodyne)');
});

test('live preview: previews that arrive while one is placed collapse to the newest', () => {
  const fx = previewFixture();
  fx.runner.preview(); fx.runner.preview(); fx.runner.preview(); fx.runner.preview();
  fx.pump();
  audible(fx, 4);
  const created = fx.live.calls.filter((c) => c.fn === 'create_audio_clip').length;
  assert.ok(created <= 2, 'at most the first and the newest were placed, not all four: ' + created);
});

test('live preview: off by default, and a preview message without the toggle is ignored', () => {
  const fx = previewFixture({ preview: false });
  assert.strictEqual(fx.launch.job.preview, undefined);
  fx.runner.preview();
  fx.pump();
  assert.deepStrictEqual(fx.live.snapshot(), fx.initial, 'nothing placed');
  assert.strictEqual(srcMuted(fx), 0);
  fx.runner.finish();
  fx.pump();
  assert.ok(/^Done\./.test(fx.status()), fx.status());
});

test('live preview: unusable previews are ignored (error result, missing file, short file, other job)', () => {
  const fx = previewFixture();
  fx.runner.preview({ resultJson: { version: 1, id: 'x', status: 'error', message: 'no' } });
  fx.runner.preview({ noWav: true });
  fx.pump();
  const bad = fx.runner.preview({ n: 9 });
  fs.writeFileSync(bad.resultPath, Buffer.alloc(50));
  fx.pump();
  assert.strictEqual(fx.live.tracks().length, 2, 'no track was made for any of them');
  assert.strictEqual(srcMuted(fx), 0);
  fx.sb.hostStatus(enc({ state: 'preview', n: 11, jobId: 'another-job', resultJson: bad, previewDir: '/x' }));
  fx.pump();
  assert.strictEqual(fx.live.tracks().length, 2);
  fx.runner.preview({ n: 12 });
  fx.pump();
  audible(fx, 12);
});

test('live preview: a failing first preview rolls back and leaves the original audible; the next one works', () => {
  const fx = previewFixture({ live: { faults: [{ fn: 'create_audio_clip', nth: 1, mode: 'throw' }] } });
  fx.runner.preview();
  fx.pump();
  assert.deepStrictEqual(fx.live.snapshot(), fx.initial, 'the new Preview track was removed again');
  assert.strictEqual(srcMuted(fx), 0, 'the original is still audible');
  assert.ok(/^No preview: Placing the result clip failed/.test(fx.status()), fx.status());
  assert.deepStrictEqual(fx.lastUi('busy'), [1], 'the job goes on: the window is open');
  fx.runner.preview();
  fx.pump();
  audible(fx, 2);
});

test('live preview: a failing later preview never removes the audible one', () => {
  // the 2nd create_audio_clip (preview 2, on the new track B) fails: A keeps playing preview 1
  const fx = previewFixture({ live: { faults: [{ fn: 'create_audio_clip', nth: 2, mode: 'throw' }] } });
  fx.runner.preview(); fx.pump();
  fx.runner.preview(); fx.pump();
  assert.ok(/^No preview: Placing the result clip failed/.test(fx.status()), fx.status());
  assert.strictEqual(fx.live.tracks().length, 3, 'track B was removed again, A is untouched');
  audible(fx, 1);
  assert.strictEqual(srcMuted(fx), 1, 'the original stays muted while preview 1 plays');
  fx.runner.preview(); fx.pump();
  audible(fx, 3);
  fx.runner.finish(); fx.pump();
  assert.ok(/^Done\./.test(fx.status()), fx.status());
  assert.strictEqual(fx.live.tracks().length, 2);
  assert.strictEqual(srcMuted(fx), 0);
});

test('live preview: a Preview track deleted by the user is made again; the song tempo changed -> no preview', () => {
  const fx = previewFixture();
  fx.runner.preview(); fx.pump();
  const a = previewTracksOf(fx)[0];
  fx.live.song.tracks.splice(fx.live.song.tracks.indexOf(a.id), 1);
  fx.runner.preview(); fx.pump();
  assert.strictEqual(previewTracksOf(fx).length, 1, 'a new Preview A was made');
  audible(fx, 2);
  fx.live.song.tempo = 121;
  fx.runner.preview(); fx.pump();
  assert.ok(/^No preview: the song tempo changed\.$/.test(fx.status()), fx.status());
  fx.live.song.tempo = 120;
  fx.runner.finish(); fx.pump();
  assert.ok(/^Done\./.test(fx.status()), fx.status());
  assert.ok(!/Preview/.test(fx.live.tracks().map((t) => t.name).join('|')));
});

test('live preview: removing the Preview tracks fails at the end -> the result stays, a note says what to delete', () => {
  const fx = previewFixture({ live: { faults: [{ fn: 'delete_track', nth: 1, mode: 'noop' }] } });
  fx.runner.preview(); fx.pump();
  fx.runner.finish(); fx.pump();
  assert.ok(/^Done\./.test(fx.status()), fx.status());
  assert.ok(/Note: .*Preview track could not be removed; delete it by hand/.test(fx.status()), fx.status());
  assert.strictEqual(fx.t0.lanes.length, 1, 'the result went to a take lane');
  assert.strictEqual(srcMuted(fx), 0);
});

test('live preview: also with a Live that shows new objects late (the sequence re-reads often and long enough)', () => {
  for (const delayTicks of [1, 2]) {
    const fx = previewFixture({ live: { delayTicks } });
    fx.runner.preview(); fx.pump();
    audible(fx, 1);
    fx.runner.preview(); fx.pump();
    audible(fx, 2);
    fx.runner.preview(); fx.pump();
    audible(fx, 3);
    fx.runner.finish(); fx.pump();
    assert.ok(/^Done\./.test(fx.status()), fx.status());
    assert.strictEqual(fx.live.tracks().length, 2, 'the Preview tracks are gone');
    assert.strictEqual(srcMuted(fx), 0);
  }
});

test('live preview: a placement is fast: the sequence needs no waiting when Live answers at once', () => {
  const fx = previewFixture();
  fx.runner.preview();
  const t0 = fx.live.clock.now;
  fx.pump();
  assert.ok(fx.live.clock.now - t0 <= 200, 'the first preview was placed within 200 ms of fake time: ' + (fx.live.clock.now - t0));
  const t1 = fx.live.clock.now;
  fx.runner.preview();
  fx.pump();
  assert.ok(fx.live.clock.now - t1 <= 200, 'the second too: ' + (fx.live.clock.now - t1));
});

// ---- Transport sync
// The sync loop polls Live every 40 ms for as long as the job runs, so fx.pump() (which runs until nothing is left to do)
// cannot be used while it runs: step the clock instead.
function syncFixture(o) {
  o = o || {};
  const fx = makeFixture(o);
  fx.boot();
  if (o.sync !== false) fx.sb.settings('sync', 1);
  fx.sb.sendMelodyne();
  fx.runner.flush(); fx.live.clock.run(0); fx.runner.flush();   // the launch, `started`, and the loop's first tick
  fx.launch = fx.runner.launches[0];
  fx.step = (ms) => { fx.runner.flush(); fx.live.clock.advance(ms); fx.runner.flush(); };
  fx.song = fx.live.song;
  return fx;
}

test('transport sync: the job asks for it, the open line says so, Live\'s position is reported relative to the clip (beats -> seconds)', () => {
  const fx = syncFixture();
  assert.strictEqual(fx.launch.job.sync, true);
  assert.ok(/transport sync: on/.test(fx.statuses().filter((x) => /Melodyne is open/.test(x))[0]), fx.statuses().join(' | '));
  fx.step(200);
  const first = fx.runner.transports[0];
  assert.ok(first, 'a first report');
  assert.strictEqual(first.jobId, fx.launch.job.id);
  assert.strictEqual(first.playing, false);
  near(first.posSec, (0 - 16) * 60 / 120, 1e-9, 'stopped at beat 0; the clip starts at beat 16: -8 s');
  // Live moves its position while stopped: reported, once per change
  const n = fx.runner.transports.length;
  fx.song.timeBase = { t: 18, at: fx.live.clock.now };            // beat 18 = 1 s into the clip at 120 bpm
  fx.step(100);
  const moved = fx.runner.transports[fx.runner.transports.length - 1];
  near(moved.posSec, 1, 1e-9);
  assert.strictEqual(moved.playing, false);
  assert.ok(fx.runner.transports.length > n);
  const count = fx.runner.transports.length;
  fx.step(300);                                                    // nothing changes: no new report within the heartbeat
  assert.strictEqual(fx.runner.transports.length, count);
  fx.step(900);                                                    // ... but at least one per second
  assert.ok(fx.runner.transports.length > count, 'heartbeat');
  assert.deepStrictEqual(fx.runner.transports.map((t) => t.seq), fx.runner.transports.map((t, i) => i + 1), 'numbered 1, 2, 3 ...');
});

test('transport sync: a playing Live is reported about every 100 ms with a growing position; stopping is reported at once', () => {
  const fx = syncFixture();
  fx.step(100);
  fx.song.timeBase = { t: 16, at: fx.live.clock.now }; fx.song.is_playing = 1;       // Live starts playing at the clip start
  fx.runner.transports.length = 0;
  fx.step(1000);
  const reports = fx.runner.transports;
  assert.ok(reports.length >= 8 && reports.length <= 12, 'about every 100 ms: ' + reports.length);
  assert.ok(reports.every((t) => t.playing), 'all playing');
  for (let i = 1; i < reports.length; i++) assert.ok(reports[i].posSec > reports[i - 1].posSec, 'the position grows');
  near(reports[reports.length - 1].posSec, 1, 0.12, 'about 1 s into the clip after 1 s of playing');
  fx.song.timeBase = { t: songNow(fx), at: fx.live.clock.now }; fx.song.is_playing = 0;
  fx.runner.transports.length = 0;
  fx.step(50);
  assert.strictEqual(fx.runner.transports[0].playing, false, 'the stop is reported within a poll');
});
function songNow(fx) { return fx.song.timeBase.t + (fx.song.is_playing ? (fx.live.clock.now - fx.song.timeBase.at) / 1000 * fx.song.tempo / 60 : 0); }

test('transport sync: the host\'s start, seek and stop are applied to Live; a start Live ignores is corrected once', () => {
  const fx = syncFixture();
  fx.step(100);
  fx.runner.syncEvents([{ seq: 1, kind: 'seek', posSec: 2.5 }]);
  fx.step(60);
  near(songNow(fx), 16 + 2.5 * 2, 0.01, 'seek: 2.5 s into the clip = beat 21');
  assert.strictEqual(fx.song.is_playing, 0, 'a seek does not start Live');
  fx.runner.syncEvents([{ seq: 2, kind: 'start', posSec: 1 }]);
  fx.step(60);
  assert.strictEqual(fx.song.is_playing, 1, 'start: Live plays');
  near(songNow(fx), 18, 0.2, 'from 1 s into the clip = beat 18 (plus the 60 ms since)');
  fx.step(400);
  assert.strictEqual(fx.song.is_playing, 1);
  fx.runner.syncEvents([{ seq: 3, kind: 'stop', posSec: 3 }]);
  fx.step(60);
  assert.strictEqual(fx.song.is_playing, 0, 'stop');
  const reported = fx.runner.transports[fx.runner.transports.length - 1];
  assert.strictEqual(reported.playing, false, 'and reported back at once');
  // a start event before the clip (negative seconds) clamps at beat 0
  fx.runner.syncEvents([{ seq: 4, kind: 'seek', posSec: -100 }]);
  fx.step(60);
  near(songNow(fx), 0, 1e-9);
  // a Live that starts from somewhere else (its insert marker) is moved to the requested position once
  const fx2 = syncFixture();
  fx2.step(100);
  const realCall = fx2.live.song;
  fx2.runner.syncEvents([{ seq: 1, kind: 'start', posSec: 2 }]);
  fx2.step(20);
  fx2.song.timeBase = { t: 3, at: fx2.live.clock.now };            // Live "started from its marker" at beat 3
  fx2.step(400);
  near(songNow(fx2), 16 + 2 * 2 + 0.4 * 2, 0.5, 'corrected to the requested position (plus elapsed time)');
  assert.ok(fx2.live.calls.filter((c) => c.fn === 'set current_song_time').length >= 2, 'one correction');
  void realCall;
  // a start after which Live is not playing is started again
  const fx3 = syncFixture({ live: { faults: [{ fn: 'continue_playing', nth: 1, mode: 'noop' }] } });
  fx3.step(100);
  fx3.runner.syncEvents([{ seq: 1, kind: 'start', posSec: 1 }]);
  fx3.step(500);
  assert.strictEqual(fx3.song.is_playing, 1, 'the second try played');
});

test('transport sync: events for another job, a bad event and events after the job are ignored; the loop ends with the job', () => {
  const fx = syncFixture();
  fx.step(100);
  fx.sb.hostStatus(enc({ state: 'transport', jobId: 'other', events: [{ seq: 1, kind: 'start', posSec: 1 }] }));
  fx.runner.syncEvents([{ seq: 2, kind: 'jump', posSec: 1 }, { seq: 3, kind: 'start', posSec: 'x' }, null, 5]);
  fx.step(100);
  assert.strictEqual(fx.song.is_playing, 0);
  fx.runner.finish();
  fx.pump();                                                       // the loop stopped: pump settles again
  assert.ok(/^Done\./.test(fx.status()), fx.status());
  assert.strictEqual(fx.live.clock.tasks.size, 0, 'no task is left running');
  const before = fx.runner.transports.length;
  fx.live.clock.advance(3000);
  assert.strictEqual(fx.runner.transports.length, before, 'no reports after the job');
  fx.sb.hostStatus(enc({ state: 'transport', jobId: fx.launch.job.id, events: [{ seq: 9, kind: 'start', posSec: 1 }] }));
  assert.strictEqual(fx.song.is_playing, 0, 'an event after the job does not start Live');
});

test('transport sync: a changed song tempo pauses it with a note; off by default; VocAlign never syncs', () => {
  const fx = syncFixture();
  fx.step(100);
  const n = fx.runner.transports.length;
  fx.song.tempo = 130;
  fx.step(300);
  assert.ok(/^Transport sync is paused: the song tempo changed\.$/.test(fx.status()), fx.status());
  assert.strictEqual(fx.runner.transports.length, n, 'nothing is reported while the tempo differs');
  fx.song.tempo = 120;
  fx.step(100);
  assert.ok(fx.runner.transports.length > n, 'resumes when the tempo is back');
  fx.runner.finish();
  fx.pump();

  const off = syncFixture({ sync: false });
  assert.strictEqual(off.launch.job.sync, undefined);
  off.pump(500);
  assert.strictEqual(off.runner.transports.length, 0);
  off.runner.finish();
  off.pump();
});

test('integration: bridge -> real runner -> real BridgeHost (headless) -> placement on the fake Live model', async () => {
  if (SKIP_REAL) { console.log('   skipped (--skip-real)'); return; }
  if (!fs.existsSync(REAL_HOST)) { console.log('   skipped (BridgeHost not built at ' + REAL_HOST + ')'); return; }
  process.env.ARABRIDGE_RUNNER_NO_AUTOSTART = '1';
  const { createRunner } = require(path.join(DEVICE, 'src', 'runner.js'));
  const dir = path.join(TMP, 'real');
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  // a real 16-bit source: 4 s of tones, the clip uses 0.5..2.5 s at 120 bpm (4 beats) at beat 4
  const srcFile = path.join(dir, 'real source.wav');
  const sr = 44100, n = 4 * sr, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) { const t = i / sr; buf.writeInt16LE(Math.round(0.3 * Math.sin(2 * Math.PI * (200 * t + 30 * t * t)) * 32767), 44 + i * 2); }
  fs.writeFileSync(srcFile, buf);
  const settings = path.join(dir, 'host-settings.json');
  fs.writeFileSync(settings, '{}');
  const support = path.join(home, 'Library', 'Application Support', 'ARABridge');
  fs.mkdirSync(support, { recursive: true });
  fs.writeFileSync(path.join(support, 'settings.json'), JSON.stringify({ hostPath: REAL_HOST }));

  const live = makeLive({ tempo: 120 });
  const t0 = live.addTrack('1-Vocals');
  live.addTrack('2-Audio');
  const clip = live.addClip(t0, { start: 4, loopStart: 0.5, loopEnd: 2.5, file: srcFile, name: 'Real take' });
  live.select(clip);
  live.endSetup();
  const sb = makeSandbox(live, { launchMode: 'headless' });   // the host has no user to press Apply
  const inbox = [];
  const handlers = {};
  const maxApi = { addHandler: (nm, f) => { handlers[nm] = f; }, post: () => {}, outlet: (sel, payload) => { inbox.push([sel, payload]); } };
  const runner = createRunner({ maxApi, home, env: Object.assign({}, process.env, { ARABRIDGE_SETTINGS: settings }) });
  runner.register();
  const route = { started: 'hostStarted', done: 'hostDone', status: 'hostStatus', error: 'hostError', plugins: 'hostPlugins', copied: 'hostCopied', pong: 'hostPong' };
  let cursor = 0;
  function glue() {
    let moved = 0;
    while (cursor < sb.outs[1].length) {
      const m = sb.outs[1][cursor++]; moved++;
      assert.ok(handlers[m[0]], 'the runner handles ' + m[0]);
      handlers[m[0]].apply(null, m.slice(1));
    }
    while (inbox.length) {
      const [sel, payload] = inbox.shift(); moved++;
      if (payload === undefined) sb[route[sel]](); else sb[route[sel]](payload);
    }
    const horizon = live.clock.now + 50;          // the fake clock follows real time (about 2x)
    moved += live.clock.run(50);
    if (live.clock.now < horizon) live.clock.now = horizon;
    return moved;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function until(pred, ms, what) {
    const t0 = Date.now();
    while (!pred()) { glue(); if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + what + '; status: ' + sb.outs[0].map((a) => a[0]).join(' | ')); await sleep(25); }
  }
  sb.loadbang(); sb.ready();
  await until(() => /^Ready\./.test(String((sb.outs[0][sb.outs[0].length - 1] || [''])[0])), 30000, 'ready line');
  const ready = String(sb.outs[0][sb.outs[0].length - 1][0]);
  console.log('   ' + ready);
  if (!/Melodyne: found/.test(ready)) { console.log('   skipped the job (Melodyne not found)'); runner.dispose(); return; }
  sb.settings('placement', 'takeLane');
  sb.sendMelodyne();
  const t1 = Date.now();
  await until(() => sb.outs[2].filter((a) => a[0] === 'busy').slice(-1)[0][1] === 0, 300000, 'job and placement');
  for (let i = 0; i < 20; i++) { glue(); await sleep(10); }
  const status = String(sb.outs[0][sb.outs[0].length - 1][0]);
  console.log('   ' + ((Date.now() - t1) / 1000).toFixed(1) + ' s: ' + status);
  runner.dispose();
  assert.ok(/^Done\./.test(status), status);
  const lane = live.objs[t0.lanes[0]];
  const lc = live.liveClips(lane);
  assert.strictEqual(lc.length, 1);
  const p = lc[0].props;
  assert.strictEqual(p.warping, 0);
  assert.strictEqual(p.sample_length, 88200, 'the real result.wav is 2 s at 44.1 kHz');
  near(p.length, 4, 1e-6, 'length 4 beats');
  near(p.start_time, 4, 1e-9);
  assert.strictEqual(p.name, 'Real take (Melodyne)');
  assert.ok(p.file_path.indexOf(path.join(support, 'results')) === 0, p.file_path);
  assert.ok(fs.statSync(p.file_path).size >= 44 + 88200 * 4);
  const jobs = fs.readdirSync(runner.paths.jobsDir);
  assert.strictEqual(jobs.length, 1);
  const rj = JSON.parse(fs.readFileSync(path.join(runner.paths.jobsDir, jobs[0], 'result.json'), 'utf8'));
  assert.strictEqual(rj.status, 'ok');
  assert.ok(/ launch \S+ plugin=melodyne/.test(fs.readFileSync(path.join(support, 'device.log'), 'utf8')), 'device.log written');
});

// ------------------------------------------------------------------------------------------ run
(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    const t0 = Date.now();
    try { await fn(); console.log('ok   ' + name + '  (' + (Date.now() - t0) + ' ms)'); } catch (e) { failed++; console.log('FAIL ' + name + ': ' + (e && e.stack || e)); }
  }
  console.log(failed ? failed + ' of ' + tests.length + ' failed' : 'all ' + tests.length + ' passed');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
