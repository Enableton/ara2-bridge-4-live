// Tests for device/src/core.js (pure ES5 logic of the ARA Bridge device).
// Plain node, no framework: node device/tests/test_core.js   (exit code 1 on any failure)
// Fixtures in device/tests/fixtures/ are the raw LiveAPI values measured in Live 12.4.6 (probe round 2).
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const cp = require('child_process');

const CORE_PATH = path.join(__dirname, '..', 'src', 'core.js');
const core = require(CORE_PATH);

// ----------------------------------------------------------------------------------------------- harness
let assertions = 0;
let currentFailures = 0;
function fail(msg) { currentFailures++; throw new Error(msg); }
function ok(cond, msg) { assertions++; if (!cond) fail('expected true: ' + msg); }
function eq(actual, expected, msg) {
  assertions++;
  if (actual !== expected) fail((msg || 'eq') + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}
function deq(actual, expected, msg) {
  assertions++;
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) fail((msg || 'deq') + ':\n  expected ' + b + '\n  got      ' + a);
}
function near(actual, expected, tol, msg) {
  assertions++;
  if (typeof actual !== 'number' || !(Math.abs(actual - expected) <= tol)) {
    fail((msg || 'near') + ': expected ' + expected + ' +- ' + tol + ', got ' + actual);
  }
}
function match(str, re, msg) {
  assertions++;
  if (typeof str !== 'string' || !re.test(str)) fail((msg || 'match') + ': ' + JSON.stringify(str) + ' !~ ' + re);
}
function noThrow(fn, msg) {
  assertions++;
  try { return fn(); } catch (e) { fail((msg || 'noThrow') + ': threw ' + (e && e.message)); }
  return undefined;
}
function throws(fn, msg) {
  assertions++;
  let threw = false;
  try { fn(); } catch (e) { threw = true; }
  if (!threw) fail((msg || 'throws') + ': expected an exception');
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const clone = (o) => JSON.parse(JSON.stringify(o));
function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name + '.json'), 'utf8'));
}
const FX1 = fixture('clip-trimmed-unwarped');
const FX2 = fixture('clip-warped-trimmed');
const FX3 = fixture('clip-unwarped-untouched');
const TEMPO = 131.55548095703125;

// A fixture with some raw clip values replaced.
function clipWith(fx, over) {
  const c = clone(fx.clip);
  Object.keys(over).forEach((k) => { c[k] = over[k]; });
  return c;
}
const songOf = (fx) => fx.song;
const trackOf = (fx) => fx.track;
function validate(fx, over, opts, trackOver, songOver) {
  const track = clone(fx.track);
  if (trackOver) Object.keys(trackOver).forEach((k) => { track[k] = trackOver[k]; });
  return core.validateClip(clipWith(fx, over || {}), track, songOver || fx.song, opts);
}
function refused(res, code, re, msg) {
  ok(res && res.ok === false, (msg || code) + ': must be refused');
  eq(res.code, code, (msg || code) + ' code');
  match(res.reason, re || /./, (msg || code) + ' reason');
  ok(res.reason.length > 0 && res.reason.length <= 120, (msg || code) + ' reason is a short message');
}

// ----------------------------------------------------------------------------------------------- normalizeClip
test('normalizeClip: real raw LiveAPI arrays become numbers/strings', () => {
  const c = core.normalizeClip(FX1.clip);
  eq(c.id, 13); eq(c.track_index, 0);
  eq(c.name, 'render_1');
  eq(c.warping, 0); eq(c.looping, 0); eq(c.is_audio_clip, 1); eq(c.is_arrangement_clip, 1);
  near(c.loop_start, 1.824325358807279, 1e-12);
  near(c.loop_end, 16.418928229265475, 1e-12);
  eq(c.start_time, 32); eq(c.length, 32);
  eq(c.gain_display_string, '0.00 dB');
  eq(c.sample_length, 882000); eq(c.sample_rate, 44100);
});

test('normalizeClip: "7.105427357601002e-15" strings are ~0 numbers', () => {
  const c = core.normalizeClip(FX3.clip);
  eq(typeof c.start_marker, 'number');
  ok(c.start_marker > 0 && c.start_marker < 1e-12, 'start_marker ~ 0');
  ok(c.loop_start < 1e-12, 'loop_start ~ 0');
});

test('normalizeClip: strings, booleans, one-element arrays, junk', () => {
  const c = core.normalizeClip({ length: '32', start_time: ' 8.5 ', warping: false, looping: true, gain: [0.4],
    pitch_coarse: 'abc', pitch_fine: '', loop_start: [], loop_end: [1, 2], sample_rate: NaN, sample_length: Infinity,
    muted: { a: 1 }, id: [[7]], track_index: undefined, end_time: '1e3', start_marker: '.5', end_marker: '5.',
    is_audio_clip: 'true' });
  eq(c.length, 32); eq(c.start_time, 8.5); eq(c.warping, 0); eq(c.looping, 1); eq(c.gain, 0.4);
  eq(c.pitch_coarse, null); eq(c.pitch_fine, null); eq(c.loop_start, null); eq(c.loop_end, null);
  eq(c.sample_rate, null); eq(c.sample_length, null); eq(c.muted, null); eq(c.id, 7); eq(c.track_index, null);
  eq(c.end_time, 1000); eq(c.start_marker, 0.5); eq(c.end_marker, 5); eq(c.is_audio_clip, 1);
});

test('normalizeClip: names and paths (strings, arrays, numbers, umlauts, emoji)', () => {
  eq(core.normalizeClip({ name: ['Stimme \u00e4\u00f6\u00fc'] }).name, 'Stimme \u00e4\u00f6\u00fc');
  eq(core.normalizeClip({ name: '\ud83c\udfa4 take' }).name, '\ud83c\udfa4 take');
  eq(core.normalizeClip({ name: 808 }).name, '808');
  eq(core.normalizeClip({ name: true }).name, null);
  eq(core.normalizeClip({ name: '' }).name, '');
  eq(core.normalizeClip({ file_path: ['/a b/c.wav'] }).file_path, '/a b/c.wav');
});

test('normalizeClip: never throws, always returns every key', () => {
  const bad = [null, undefined, 5, 'x', [], [1], true, function () {}];
  bad.forEach((b) => {
    const c = noThrow(() => core.normalizeClip(b), 'input ' + String(b));
    eq(c.warping, null); eq(c.name, null); eq(Object.keys(c).length, 23);
  });
  const evil = {};
  Object.defineProperty(evil, 'warping', { get() { throw new Error('boom'); }, enumerable: true });
  const c = noThrow(() => core.normalizeClip(evil), 'throwing getter');
  eq(c.warping, null);
});

test('normalizeClip: idempotent', () => {
  const once = core.normalizeClip(FX1.clip);
  deq(core.normalizeClip(once), once);
});

test('normalizeTrack: frozen flag and name', () => {
  const t = core.normalizeTrack(FX1.track);
  eq(t.is_frozen, 0); eq(t.name, '1-render_1'); eq(t.has_audio_input, 1);
  eq(core.normalizeTrack({ is_frozen: [1] }).is_frozen, 1);
  eq(core.normalizeTrack(null).is_frozen, null);
});

// ----------------------------------------------------------------------------------------------- clipRegion
test('clipRegion: trimmed unwarped clip (fixture 1)', () => {
  const r = core.clipRegion(FX1.clip, FX1.song.tempo);
  ok(r.ok, 'ok');
  const g = r.region;
  near(g.startSec, 1.824325358807279, 1e-9);
  near(g.endSec, 16.418928229265475, 1e-9);
  near(g.durationSec, 14.594602870458196, 1e-9);
  eq(g.startBeats, 32); eq(g.lengthBeats, 32); eq(g.endBeats, 64);
  eq(g.name, 'render_1'); eq(g.sampleRate, 44100); eq(g.trackIndex, 0); eq(g.clipId, 13);
  eq(g.gain, 0.4000000059604645); eq(g.gainIsUnity, true);
  ok(/^\/.*render_1\.wav$/.test(g.path), 'absolute path');
  near(g.tempo, TEMPO, 1e-9);
});

test('clipRegion: untouched unwarped clip with 7.1e-15 markers (fixture 3)', () => {
  const r = core.clipRegion(FX3.clip, FX3.song.tempo);
  ok(r.ok, 'ok');
  ok(r.region.startSec >= 0 && r.region.startSec < 1e-12, 'start ~ 0');
  eq(r.region.endSec, 20);
  near(r.region.durationSec, 20, 1e-9);
  eq(r.region.startBeats, 128);
  near(r.region.lengthBeats, 43.85182707917082, 1e-12);
});

test('clipRegion: warped clip (fixture 2) is refused', () => {
  refused(core.clipRegion(FX2.clip, FX2.song.tempo), 'warped', /warp/i);
});

test('clipRegion: end_marker is never read', () => {
  const base = core.clipRegion(FX1.clip, TEMPO);
  [999999, null, 'abc', -5, [], [1, 2]].forEach((v) => {
    const r = core.clipRegion(clipWith(FX1, { end_marker: v }), TEMPO);
    ok(r.ok, 'ok with end_marker ' + JSON.stringify(v));
    deq(r.region, base.region, 'region unchanged by end_marker ' + JSON.stringify(v));
  });
});

test('clipRegion: start_marker cross-check (2 ms)', () => {
  ok(core.clipRegion(clipWith(FX1, { start_marker: [1.824325358807279 + 0.0015] }), TEMPO).ok, '1.5 ms apart is fine');
  refused(core.clipRegion(clipWith(FX1, { start_marker: [1.824325358807279 + 0.0025] }), TEMPO), 'region', /start marker/i, '2.5 ms apart');
  refused(core.clipRegion(clipWith(FX1, { start_marker: [4] }), TEMPO), 'region', /start marker/i, 'warped-looking marker');
  ok(core.clipRegion(clipWith(FX1, { start_marker: null }), TEMPO).ok, 'unreadable start_marker is skipped');
  ok(core.clipRegion(clipWith(FX1, { start_marker: 'n/a' }), TEMPO).ok, 'non-numeric start_marker is skipped');
});

test('clipRegion: duration vs length*60/tempo consistency (2 ms)', () => {
  const dur = 16.418928229265475 - 1.824325358807279;
  const lenFor = (delta) => (dur + delta) * TEMPO / 60;
  ok(core.clipRegion(clipWith(FX1, { length: [lenFor(0.0019)] }), TEMPO).ok, '1.9 ms off passes');
  ok(core.clipRegion(clipWith(FX1, { length: [lenFor(-0.0019)] }), TEMPO).ok, '-1.9 ms off passes');
  refused(core.clipRegion(clipWith(FX1, { length: [lenFor(0.0021)] }), TEMPO), 'tempo', /tempo/i, '2.1 ms off');
  refused(core.clipRegion(clipWith(FX1, { length: [lenFor(-0.0021)] }), TEMPO), 'tempo', /tempo/i, '-2.1 ms off');
  refused(core.clipRegion(FX1.clip, 120), 'tempo', /tempo changes/i, 'another song tempo');
});

test('clipRegion: end past the end of the file is refused, not clamped', () => {
  const fileSec = 882000 / 44100;   // 20 s
  const endSec = 16.418928229265475;
  const withFile = (sec) => clipWith(FX1, { sample_length: [Math.round(sec * 44100)] });
  ok(core.clipRegion(withFile(endSec + 0.01), TEMPO).ok, 'end well inside the file');
  ok(core.clipRegion(withFile(endSec - 0.0005), TEMPO).ok, 'end 0.5 ms past the file end is within the 1 ms slack');
  const r = core.clipRegion(withFile(endSec - 0.003), TEMPO);
  refused(r, 'region', /past the end/i, 'end 3 ms past the file end');
  ok(fileSec === 20, 'sanity');
  refused(core.clipRegion(clipWith(FX1, { sample_length: null }), TEMPO), 'region', /length/i, 'unknown file length');
  refused(core.clipRegion(clipWith(FX1, { sample_rate: 0 }), TEMPO), 'region', /length/i, 'zero sample rate');
});

test('clipRegion: path rules', () => {
  refused(core.clipRegion(clipWith(FX1, { file_path: ['relative/x.wav'] }), TEMPO), 'relative-path', /absolute/i);
  refused(core.clipRegion(clipWith(FX1, { file_path: [''] }), TEMPO), 'no-file', /audio file/i);
  refused(core.clipRegion(clipWith(FX1, { file_path: null }), TEMPO), 'no-file', /audio file/i);
  refused(core.clipRegion(clipWith(FX1, { file_path: ['/'] }), TEMPO), 'relative-path', /absolute/i, 'bare slash is not a file');
});

test('clipRegion: tempo input is validated', () => {
  [0, -120, NaN, null, undefined, 'abc', []].forEach((t) => {
    refused(core.clipRegion(FX1.clip, t), 'tempo', /tempo/i, 'tempo ' + String(t));
  });
  ok(core.clipRegion(FX1.clip, [String(TEMPO)]).ok, 'tempo as one-element string array');
});

test('clipRegion: loop_start/loop_end edge cases', () => {
  const r = core.clipRegion(clipWith(FX3, { start_marker: [-1e-9], loop_start: [-1e-9] }), TEMPO);
  ok(r.ok, 'tiny negative start (noise) is accepted'); eq(r.region.startSec, 0);
  refused(core.clipRegion(clipWith(FX3, { start_marker: [-0.5], loop_start: [-0.5] }), TEMPO), 'region', /before the beginning/i);
  refused(core.clipRegion(clipWith(FX1, { loop_end: [1.824325358807279], start_marker: null }), TEMPO), 'region', /empty/i);
  refused(core.clipRegion(clipWith(FX1, { loop_end: null }), TEMPO), 'region', /loop/i);
  refused(core.clipRegion(clipWith(FX1, { start_time: null }), TEMPO), 'region', /position|length/i);
  refused(core.clipRegion(clipWith(FX1, { length: [0] }), TEMPO), 'region', /position|length/i);
});

test('clipRegion: gainIsUnity and non-default gain', () => {
  eq(core.clipRegion(clipWith(FX1, { gain_display_string: null, gain: [0.4000005] }), TEMPO).region.gainIsUnity, true, 'raw within 1e-6');
  eq(core.clipRegion(clipWith(FX1, { gain_display_string: null, gain: [0.40001] }), TEMPO).region.gainIsUnity, false, 'raw 1e-5 off');
  const r = core.clipRegion(clipWith(FX1, { gain_display_string: ['-3.00 dB'], gain: [0.28] }), TEMPO);
  ok(r.ok, 'gain is not a refusal'); eq(r.region.gainIsUnity, false); eq(r.region.gain, 0.28);
  eq(core.clipRegion(clipWith(FX1, { gain: null, gain_display_string: null }), TEMPO).region.gain, null, 'unreadable gain');
});

test('clipRegion: trackIndex only when known', () => {
  eq(core.clipRegion(clipWith(FX1, { track_index: null }), TEMPO).region.trackIndex, null);
  eq(core.clipRegion(clipWith(FX1, { track_index: 3 }), TEMPO).region.trackIndex, 3);
  eq(core.clipRegion(clipWith(FX1, { track_index: -1 }), TEMPO).region.trackIndex, null);
});

test('clipRegion: unusual names survive (umlauts, emoji, empty)', () => {
  eq(core.clipRegion(clipWith(FX1, { name: ['\u00dcberg\u00e4nge \ud83c\udfa4'] }), TEMPO).region.name, '\u00dcberg\u00e4nge \ud83c\udfa4');
  eq(core.clipRegion(clipWith(FX1, { name: [''] }), TEMPO).region.name, '');
  eq(core.clipRegion(clipWith(FX1, { name: null }), TEMPO).region.name, '');
});

// ----------------------------------------------------------------------------------------------- validateClip
test('validateClip: fixtures 1 and 3 pass, 2 is refused as warped', () => {
  const a = core.validateClip(FX1.clip, FX1.track, FX1.song);
  ok(a.ok, 'trimmed unwarped'); eq(a.region.startBeats, 32);
  const c = core.validateClip(FX3.clip, FX3.track, FX3.song);
  ok(c.ok, 'untouched unwarped'); eq(c.region.endSec, 20);
  refused(core.validateClip(FX2.clip, FX2.track, FX2.song), 'warped', /warp/i);
});

test('validateClip: nothing selected', () => {
  [null, undefined, {}, [], 'x', clipWith(FX1, { id: 0 })].forEach((c, i) => {
    refused(core.validateClip(c, FX1.track, FX1.song), 'no-clip', /Select an Arrangement audio clip/, 'no clip #' + i);
  });
});

test('validateClip: MIDI clip and Session clip', () => {
  refused(validate(FX1, { is_audio_clip: [0] }), 'midi', /Select an Arrangement audio clip/);
  refused(validate(FX1, { is_arrangement_clip: [0] }), 'session', /Select an Arrangement audio clip/);
  refused(validate(FX1, { is_audio_clip: null }), 'unsupported', /not supported/i);
  refused(validate(FX1, { is_arrangement_clip: null }), 'unsupported', /not supported/i);
});

test('validateClip: frozen track', () => {
  refused(validate(FX1, {}, null, { is_frozen: [1] }), 'frozen', /frozen/i);
  ok(validate(FX1, {}, null, { is_frozen: [0] }).ok, 'not frozen passes');
  ok(core.validateClip(FX1.clip, null, FX1.song).ok, 'missing track info does not block');
});

test('validateClip: warped, looping, transposed', () => {
  refused(validate(FX1, { warping: [1] }), 'warped', /warp/i);
  refused(validate(FX1, { looping: [1] }), 'looping', /loop/i);
  refused(validate(FX1, { pitch_coarse: [2] }), 'transposed', /transpos/i, 'coarse +2');
  refused(validate(FX1, { pitch_coarse: [-12] }), 'transposed', /transpos/i, 'coarse -12');
  refused(validate(FX1, { pitch_fine: [5] }), 'transposed', /transpos/i, 'fine 5');
  refused(validate(FX1, { pitch_fine: [1e-9] }), 'transposed', /transpos/i, 'fine has tolerance 0');
  refused(validate(FX1, { pitch_fine: ['-0.5'] }), 'transposed', /transpos/i, 'fine as string');
  ok(validate(FX1, { pitch_coarse: ['0'], pitch_fine: [0] }).ok, 'zero as string is zero');
});

test('validateClip: unreadable state falls back to the generic refusal', () => {
  refused(validate(FX1, { warping: null }), 'unsupported', /not supported/i, 'warping');
  refused(validate(FX1, { looping: null }), 'unsupported', /not supported/i, 'looping');
  refused(validate(FX1, { pitch_coarse: null }), 'unsupported', /not supported/i, 'pitch_coarse');
  refused(validate(FX1, { pitch_fine: 'abc' }), 'unsupported', /not supported/i, 'pitch_fine');
});

test('validateClip: missing file, relative path, offline file', () => {
  refused(validate(FX1, { file_path: [''] }), 'no-file', /audio file/i);
  refused(validate(FX1, { file_path: ['rel.wav'] }), 'relative-path', /absolute/i);
  refused(validate(FX1, {}, { fileExists: () => false }), 'offline', /missing|offline/i);
  ok(validate(FX1, {}, { fileExists: () => true }).ok, 'file exists');
  ok(validate(FX1, {}, { fileExists: () => { throw new Error('File API broke'); } }).ok, 'a failing predicate does not block');
  let asked = null;
  validate(FX1, {}, { fileExists: (p) => { asked = p; return true; } });
  eq(asked, FX1.clip.file_path[0], 'predicate gets the clip path');
});

test('validateClip: tempo problems', () => {
  refused(validate(FX1, {}, null, null, { tempo: [0] }), 'tempo', /tempo/i);
  refused(core.validateClip(FX1.clip, FX1.track, null), 'tempo', /tempo/i, 'no song info');
  refused(validate(FX1, {}, null, null, { tempo: [100] }), 'tempo', /tempo changes/i);
});

test('validateClip: gain is not a refusal', () => {
  const r = validate(FX1, { gain: [0.7], gain_display_string: ['3.5 dB'] });
  ok(r.ok, 'ok'); eq(r.region.gainIsUnity, false); eq(r.region.gain, 0.7);
});

test('validateClip: device-state refusals (busy, host missing, plug-in missing) come first', () => {
  refused(validate(FX1, {}, { busy: true }), 'busy', /already running/i);
  refused(validate(FX1, {}, { hostMissing: true }), 'no-host', /install_host/);
  refused(validate(FX1, {}, { pluginFound: false, plugin: 'melodyne' }), 'no-plugin', /Melodyne was not found/);
  refused(validate(FX1, {}, { pluginFound: false, plugin: 'vocalign' }), 'no-plugin', /VocAlign was not found/);
  refused(validate(FX1, {}, { pluginFound: false }), 'no-plugin', /plug-in was not found/);
  refused(core.validateClip(null, null, null, { busy: true }), 'busy', /already running/i, 'busy beats no-clip');
  refused(validate(FX1, {}, { busy: true, hostMissing: true, pluginFound: false }), 'busy', /./, 'busy first');
  ok(validate(FX1, {}, { busy: false, hostMissing: false, pluginFound: true, plugin: 'melodyne' }).ok, 'flags off or true: fine');
  ok(validate(FX1, {}, { pluginFound: undefined }).ok, 'unknown plug-in state does not block');
});

test('validateClip: VocAlign guide rules', () => {
  const guide = core.clipRegion(FX1.clip, TEMPO).region;
  const dubOpts = (g) => ({ plugin: 'vocalign', role: 'dub', guide: g });
  refused(validate(FX3, {}, dubOpts(null)), 'no-guide', /guide first/i, 'null guide');
  refused(validate(FX3, {}, dubOpts(undefined)), 'no-guide', /guide first/i, 'undefined guide');
  refused(validate(FX3, {}, dubOpts({})), 'no-guide', /guide first/i, 'empty guide');
  ok(validate(FX3, {}, dubOpts(guide)).ok, 'guide and dub with equal rates');
  refused(validate(FX3, {}, dubOpts({ startSec: 0, endSec: 1, sampleRate: 48000, tempo: TEMPO })), 'rate-mismatch', /sample rate/i);
  ok(validate(FX3, {}, dubOpts({ startSec: 0, endSec: 1, tempo: TEMPO })).ok, 'unknown guide rate is not a mismatch');
  refused(validate(FX3, {}, dubOpts(Object.assign({}, guide, { tempo: 120 }))), 'guide-tempo', /tempo/i);
  ok(validate(FX3, {}, { plugin: 'vocalign', role: 'guide' }).ok, 'the guide itself needs no guide');
  ok(validate(FX3, {}, { plugin: 'melodyne', role: 'source' }).ok, 'melodyne needs no guide');
  refused(validate(FX2, {}, dubOpts(guide)), 'warped', /warp/i, 'dub validation still applies');
});

// ----------------------------------------------------------------------------------------------- buildJob
function melSpec(over) {
  const reg = core.clipRegion(FX1.clip, TEMPO).region;
  const spec = { id: 'job-1', plugin: 'melodyne', placement: 'takeLane', realign: true, tempo: TEMPO, trackIndex: 0,
    createdAt: '2026-10-23T08:00:00.000Z',
    clips: [{ role: 'source', path: reg.path, startSec: reg.startSec, endSec: reg.endSec, startBeats: reg.startBeats,
      name: reg.name, sampleRate: reg.sampleRate }] };
  return Object.assign(spec, over || {});
}
function vocSpec(over) {
  const g = core.clipRegion(FX1.clip, TEMPO).region;
  const d = core.clipRegion(FX3.clip, TEMPO).region;
  const mk = (role, r) => ({ role, path: r.path, startSec: r.startSec, endSec: r.endSec, startBeats: r.startBeats, name: r.name, sampleRate: r.sampleRate });
  return Object.assign({ id: 'job-2', plugin: 'vocalign', placement: 'newTrack', tempo: TEMPO, trackIndex: 0,
    clips: [mk('guide', g), mk('dub', d)] }, over || {});
}
function jobBad(spec, re, msg) {
  const r = core.buildJob(spec);
  ok(r && r.ok === false, (msg || 'bad job') + ': must be rejected');
  match(r.reason, re || /./, (msg || 'bad job') + ' reason');
  eq(r.job, undefined, (msg || 'bad job') + ' has no job');
}

test('buildJob: Melodyne job matches the host contract', () => {
  const r = core.buildJob(melSpec());
  ok(r.ok, 'ok');
  const j = r.job;
  eq(j.version, 1); eq(j.id, 'job-1'); eq(j.plugin, 'melodyne'); eq(j.placement, 'takeLane');
  eq(j.realign, true); eq(j.createdAt, '2026-10-23T08:00:00.000Z');
  eq(j.clips.length, 1); eq(j.clips[0].role, 'source');
  near(j.clips[0].startSec, 1.824325358807279, 1e-9); near(j.clips[0].endSec, 16.418928229265475, 1e-9);
  eq(j.clips[0].startBeats, 32); eq(j.clips[0].name, 'render_1'); eq(j.clips[0].sampleRate, 44100);
  eq(j.song.tempo, TEMPO); eq(j.live.trackIndex, 0);
  ok(j.clips[0].path.charAt(0) === '/', 'absolute path');
  deq(JSON.parse(JSON.stringify(j)), j, 'survives JSON');
});

test('buildJob: preview is a Melodyne option, off unless true', () => {
  eq(core.buildJob(melSpec()).job.preview, undefined, 'absent by default');
  eq(core.buildJob(melSpec({ preview: false })).job.preview, undefined, 'false is not written');
  eq(core.buildJob(melSpec({ preview: true })).job.preview, true);
  eq(core.buildJob(melSpec({ preview: 1 })).job.preview, true, 'live.toggle sends 1');
  eq(core.buildJob(melSpec({ preview: null })).job.preview, undefined);
  eq(core.buildJob(vocSpec({ preview: true })).job.preview, undefined, 'VocAlign has no preview');
  jobBad(melSpec({ preview: 'yes' }), /preview must be true or false/);
});

test('buildJob: createdAt defaults to an ISO timestamp; unknown input keys are dropped', () => {
  const spec = melSpec({ createdAt: undefined, extra: 1 });
  spec.clips[0].junk = 'x';
  const j = core.buildJob(spec).job;
  match(j.createdAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  eq(j.extra, undefined); eq(j.clips[0].junk, undefined);
  eq(Object.keys(j).sort().join(','), 'clips,createdAt,id,live,placement,plugin,realign,song,version');
});

test('buildJob: defaults and optional parts', () => {
  const j = core.buildJob(melSpec({ placement: undefined, realign: undefined, tempo: undefined, trackIndex: undefined })).job;
  eq(j.placement, 'takeLane'); eq(j.realign, true); eq(j.song, undefined); eq(j.live, undefined);
  const k = core.buildJob(melSpec({ realign: false, placement: 'replace' })).job;
  eq(k.realign, false); eq(k.placement, 'replace');
  eq(core.buildJob(melSpec({ realign: 1 })).job.realign, true, 'live.toggle 1');
  eq(core.buildJob(melSpec({ realign: 0 })).job.realign, false, 'live.toggle 0');
  eq(typeof core.buildJob(melSpec({ realign: 1 })).job.realign, 'boolean', 'real boolean');
  const m = melSpec(); delete m.clips[0].startBeats; delete m.clips[0].sampleRate;
  const n = core.buildJob(m).job;
  eq(n.clips[0].startBeats, undefined, 'startBeats optional for Melodyne'); eq(n.clips[0].sampleRate, undefined);
});

test('buildJob: names pass through unchanged; bad names default to the role', () => {
  const name = '\u00dcberg\u00e4nge \ud83c\udfa4 "take" 2';
  eq(core.buildJob(melSpec({ clips: [Object.assign({}, melSpec().clips[0], { name })] })).job.clips[0].name, name);
  [undefined, null, '', '   ', 5, {}, [], true].forEach((n) => {
    eq(core.buildJob(melSpec({ clips: [Object.assign({}, melSpec().clips[0], { name: n })] })).job.clips[0].name, 'source',
      'name ' + JSON.stringify(n));
  });
});

test('buildJob: control characters stripped from names, NUL in paths rejected, names capped at 200', () => {
  const mk = (over) => melSpec({ clips: [Object.assign({}, melSpec().clips[0], over)] });
  eq(core.buildJob(mk({ name: 'a\u0000b\nc\u007fd' })).job.clips[0].name, 'abcd');
  eq(core.buildJob(mk({ name: '\u0000\u0001' })).job.clips[0].name, 'source', 'only control characters: role');
  jobBad(mk({ path: '/a/b\u0000.wav' }), /absolute/, 'NUL in path');
  const long = new Array(300).join('x');
  eq(core.buildJob(mk({ name: long })).job.clips[0].name.length, 200);
  const emoji = new Array(150).join('\ud83c\udfa4');   // 298 units
  const n = core.buildJob(mk({ name: emoji })).job.clips[0].name;
  ok(n.length <= 200, 'emoji name length'); ok(!/[\ud800-\udbff]$/.test(n), 'no lone high surrogate'); eq(n.length, 200);
  eq(core.buildJob(mk({ name: '\u00dcberg\u00e4nge \ud83c\udfa4' })).job.clips[0].name, '\u00dcberg\u00e4nge \ud83c\udfa4');
});

test('buildJob: rejects non-finite numbers and bad ranges', () => {
  const withClip = (over) => melSpec({ clips: [Object.assign({}, melSpec().clips[0], over)] });
  jobBad(withClip({ startSec: NaN }), /start/);
  jobBad(withClip({ endSec: Infinity }), /end/);
  jobBad(withClip({ startSec: '1' }), /start/, 'string seconds');
  jobBad(withClip({ startSec: undefined }), /start/);
  jobBad(withClip({ startSec: -1 }), /start/);
  jobBad(withClip({ endSec: 86401 }), /end/);
  jobBad(withClip({ startSec: 5, endSec: 5 }), /after its start/, 'endSec == startSec');
  jobBad(withClip({ startSec: 5, endSec: 4 }), /after its start/, 'endSec < startSec');
  jobBad(withClip({ startBeats: NaN }), /position/);
  jobBad(withClip({ startBeats: -2 }), /position/);
  jobBad(withClip({ sampleRate: 0 }), /sample rate/);
  jobBad(melSpec({ tempo: NaN }), /tempo/);
  jobBad(melSpec({ tempo: 0 }), /tempo/);
  jobBad(melSpec({ tempo: 2e4 }), /tempo/);
  jobBad(melSpec({ trackIndex: -1 }), /track/);
  jobBad(melSpec({ trackIndex: 1.5 }), /track/);
  jobBad(melSpec({ trackIndex: NaN }), /track/);
});

test('buildJob: rejects relative paths and bad structure', () => {
  const withClip = (over) => melSpec({ clips: [Object.assign({}, melSpec().clips[0], over)] });
  jobBad(withClip({ path: 'x/y.wav' }), /absolute/);
  jobBad(withClip({ path: '' }), /absolute/);
  jobBad(withClip({ path: 5 }), /absolute/);
  jobBad(withClip({ role: 'guide' }), /roles/, 'Melodyne takes a source');
  jobBad(melSpec({ clips: [] }), /exactly one/);
  jobBad(melSpec({ clips: [melSpec().clips[0], melSpec().clips[0]] }), /exactly one/);
  jobBad(melSpec({ clips: null }), /clips/);
  jobBad(melSpec({ clips: [null] }), /not an object/);
  jobBad(melSpec({ plugin: 'autotune' }), /plug-in/);
  jobBad(melSpec({ placement: 'inPlace' }), /placement/);
  jobBad(melSpec({ placement: '' }), /placement/);
  jobBad(melSpec({ realign: 'yes' }), /realign/);
  jobBad(melSpec({ realign: 2 }), /realign/);
  jobBad(null, /./); jobBad(undefined, /./); jobBad('x', /./);
});

test('buildJob: job ids must be safe folder names', () => {
  ['', 'a/b', '../x', '.hidden', 'a b', 5, null, undefined, new Array(102).join('a'), 'a\u0000b', 'ü'].forEach((id) => {
    jobBad(melSpec({ id }), /id/, 'id ' + JSON.stringify(id));
  });
  ['20261023-101500-ab12', 'job_1.2', 'A-b_c'].forEach((id) => ok(core.buildJob(melSpec({ id })).ok, 'id ' + id));
});

test('buildJob: VocAlign needs guide, dub, startBeats and tempo', () => {
  const r = core.buildJob(vocSpec());
  ok(r.ok, 'ok');
  const j = r.job;
  eq(j.plugin, 'vocalign'); eq(j.realign, false, 'realign is a Melodyne feature'); eq(j.song.tempo, TEMPO);
  eq(j.clips[0].role, 'guide'); eq(j.clips[1].role, 'dub');
  eq(j.clips[0].startBeats, 32); eq(j.clips[1].startBeats, 128);
  eq(core.buildJob(vocSpec({ realign: true })).job.realign, false, 'forced off for VocAlign');
  jobBad(vocSpec({ tempo: undefined }), /tempo/);
  jobBad(vocSpec({ clips: [vocSpec().clips[0]] }), /exactly one guide and one dub/);
  jobBad(vocSpec({ clips: [vocSpec().clips[0], vocSpec().clips[0]] }), /roles/, 'two guides');
  jobBad(vocSpec({ clips: [vocSpec().clips[1], vocSpec().clips[0]].map((c) => Object.assign({}, c, { role: 'source' })) }), /roles/);
  const noBeats = vocSpec(); delete noBeats.clips[1].startBeats;
  jobBad(noBeats, /start position in beats/);
  const diffRate = vocSpec(); diffRate.clips[1].sampleRate = 48000;
  jobBad(diffRate, /same sample rate/);
  const orderSwap = vocSpec({ clips: [vocSpec().clips[1], vocSpec().clips[0]] });
  ok(core.buildJob(orderSwap).ok, 'dub first is fine');
});

test('buildJob: does not modify its input', () => {
  const spec = melSpec();
  const before = JSON.stringify(spec);
  core.buildJob(spec);
  eq(JSON.stringify(spec), before);
});

// ----------------------------------------------------------------------------------------------- interpretResult
const OKR = (over) => Object.assign({ version: 1, id: 'job-1', status: 'ok', message: '', diagnostics: 'ignored',
  resultPath: '/private/tmp/job-1/result.wav', sourceStartFrame: 80454, frames: 643663, sampleRate: 44100,
  realign: { applied: true, reason: 'applied', shifts: [] } }, over || {});

test('interpretResult: ok with each realign reason', () => {
  const a = core.interpretResult(OKR({ message: 'Timing shift corrected (3 segments)' }), { exitCode: 0 });
  eq(a.kind, 'ok'); eq(a.statusLine, 'Done. Melodyne\'s timing shift was corrected.');
  eq(a.resultPath, '/private/tmp/job-1/result.wav'); eq(a.frames, 643663); eq(a.sampleRate, 44100); eq(a.sourceStartFrame, 80454);
  eq(a.realign.applied, true); eq(a.realign.reason, 'applied');
  eq(core.interpretResult(OKR({ realign: { applied: false, reason: 'nothing-to-do' } }), { exitCode: 0 }).statusLine,
    'Done. No timing shift to correct.');
  eq(core.interpretResult(OKR({ realign: { applied: false, reason: 'no-confident-match' } }), { exitCode: 0 }).statusLine,
    'Done. Timing shift could not be measured; result kept as rendered.');
  const inc = core.interpretResult(OKR({ realign: { applied: false, reason: 'inconsistent-shifts' } }), { exitCode: 0 });
  eq(inc.kind, 'ok'); eq(inc.statusLine, 'Done. No consistent timing shift found; result keeps Melodyne\'s own timing.');
  eq(inc.realign.applied, false); eq(inc.realign.reason, 'inconsistent-shifts');
  ok(inc.statusLine.length <= 120, 'inconsistent-shifts line length');
  eq(core.interpretResult(OKR({ realign: { applied: false, reason: 'not-requested' } }), { exitCode: 0 }).statusLine, 'Done.');
  eq(core.interpretResult(OKR({ realign: undefined }), { exitCode: 0 }).statusLine, 'Done.', 'older host: no reason');
  eq(core.interpretResult(OKR({ realign: undefined, message: 'note' }), { exitCode: 0 }).statusLine, 'Done. note');
});

test('interpretResult: the result file wins over a bad exit (crash while tearing down)', () => {
  const r = core.interpretResult(OKR(), { exitCode: 134, signal: null });
  eq(r.kind, 'ok');
  eq(core.interpretResult(OKR(), { exitCode: null, signal: 'SIGSEGV' }).kind, 'ok');
  eq(core.interpretResult(OKR(), undefined).kind, 'ok');
});

test('interpretResult: ok without a usable result file is an error', () => {
  const bad = [{ resultPath: '' }, { resultPath: null }, { resultPath: undefined }, { resultPath: 'rel/result.wav' },
    { frames: 0 }, { frames: -5 }, { frames: null }, { frames: 'abc' }, { frames: 10.5 }, { frames: NaN },
    { sampleRate: 0 }, { sampleRate: null }, { sampleRate: -44100 }];
  bad.forEach((over) => {
    const r = core.interpretResult(OKR(over), { exitCode: 0 });
    eq(r.kind, 'error', JSON.stringify(over));
    match(r.statusLine, /host reported ok without a result file/);
    eq(r.resultPath, null);
  });
  eq(core.interpretResult(OKR({ frames: '643663', sampleRate: '44100' }), { exitCode: 0 }).kind, 'ok', 'numeric strings are fine');
});

test('interpretResult: cancelled and error', () => {
  const c = core.interpretResult({ status: 'cancelled', message: '' }, { exitCode: 1 });
  eq(c.kind, 'cancelled'); match(c.statusLine, /Cancelled.*Nothing was changed/);
  const c2 = core.interpretResult({ status: 'cancelled', message: 'Cancelled by the user.' }, { exitCode: 1 });
  eq(c2.kind, 'cancelled'); match(c2.statusLine, /Cancelled by the user\./);
  const e = core.interpretResult({ status: 'error', message: 'Melodyne is not installed.' }, { exitCode: 3 });
  eq(e.kind, 'error'); eq(e.statusLine, 'Failed: Melodyne is not installed.'); eq(e.resultPath, null); eq(e.frames, null);
  const e2 = core.interpretResult({ status: 'error' }, { exitCode: 5 });
  eq(e2.kind, 'error'); match(e2.statusLine, /Failed/);
});

test('interpretResult: status line is one line, at most 120 characters, keeps the start of the message', () => {
  const long = 'The plug-in reported a problem while rendering: ' + new Array(400).join('x');
  const r = core.interpretResult({ status: 'error', message: long }, { exitCode: 5 });
  ok(r.statusLine.length <= 120, 'length ' + r.statusLine.length);
  match(r.statusLine, /^Failed: The plug-in reported a problem while rendering: x+\.\.\.$/);
  const nl = core.interpretResult({ status: 'error', message: 'line1\nline2\r\n\ttab\u0000 end' }, {});
  eq(nl.statusLine, 'Failed: line1 line2 tab end');
  // an emoji that straddles the cut must not be split
  const emoji = new Array(30).join('\ud83c\udfa4');
  const em = core.interpretResult({ status: 'error', message: emoji }, {});
  ok(em.statusLine.length <= 120, 'emoji line length');
  ok(!/[\ud800-\udbff]\.\.\.$/.test(em.statusLine), 'no lone high surrogate before the dots');
  ok(core.interpretResult(OKR({ realign: undefined, message: long }), {}).statusLine.length <= 120, 'ok line too');
});

test('interpretResult: no result.json means the host crashed', () => {
  const a = core.interpretResult(null, { exitCode: 134, signal: null });
  eq(a.kind, 'crashed'); match(a.statusLine, /without a result.*exit code 134/);
  const b = core.interpretResult(undefined, { exitCode: null, signal: 'SIGKILL' });
  eq(b.kind, 'crashed'); match(b.statusLine, /signal SIGKILL/);
  const c = core.interpretResult(null, { exitCode: 0 });
  eq(c.kind, 'crashed'); match(c.statusLine, /exit code 0/);
  const d = core.interpretResult(null);
  eq(d.kind, 'crashed'); match(d.statusLine, /without a result\./);
  eq(core.interpretResult(null, 'junk').kind, 'crashed');
  eq(a.resultPath, null);
});

test('interpretResult: malformed result.json never throws', () => {
  ['text', 42, true, [], [1, 2]].forEach((v) => {
    const r = noThrow(() => core.interpretResult(v, {}), 'input ' + JSON.stringify(v));
    eq(r.kind, 'error');
    match(r.statusLine, /could not be read/);
  });
  const u = core.interpretResult({ status: 'weird', message: 'hm' }, {});
  eq(u.kind, 'error'); match(u.statusLine, /unknown status.*hm/);
  eq(core.interpretResult({}, {}).kind, 'error', 'no status');
  eq(core.interpretResult({ status: 'ok', realign: 'x', resultPath: '/a', frames: 1, sampleRate: 1 }, {}).kind, 'ok', 'junk realign tolerated');
  const odd = core.interpretResult(OKR({ sourceStartFrame: 'abc' }), {});
  eq(odd.kind, 'ok'); eq(odd.sourceStartFrame, null);
});

// ----------------------------------------------------------------------------------------------- planPlacement
const REG = core.clipRegion(FX1.clip, TEMPO).region;   // start 32 beats, length 32 beats, 14.5946 s
const RES = { frames: 643663, sampleRate: 44100 };
function planSpec(mode, over) {
  return Object.assign({ mode, region: REG, result: RES, tempo: TEMPO, trackIndex: 0, sourceClipId: 13,
    resultFile: '/Users/x/Library/Application Support/ARABridge/results/job-1.wav', pluginLabel: 'Melodyne',
    existingClips: [{ id: 13, start_time: 32, end_time: 64 }] }, over || {});
}
const kinds = (ops) => ops.map((o) => o.op + (o.property ? ':' + o.property : '') + '@' + o.target);
function planBad(spec, re, msg) {
  const p = core.planPlacement(spec);
  ok(p && p.ok === false, (msg || 'plan') + ': must be refused');
  match(p.reason, re || /./, (msg || 'plan') + ' reason');
  eq(p.ops, undefined, (msg || 'plan') + ' has no ops');
}

test('planPlacement takeLane: ordered ops', () => {
  const p = core.planPlacement(planSpec('takeLane'));
  ok(p.ok, 'ok');
  deq(kinds(p.ops), ['create_take_lane@track', 'create_audio_clip@lane', 'set:warping@newClip', 'set:name@newClip',
    'set:gain@newClip', 'verify@newClip']);
  deq(p.ops[1].args, [planSpec().resultFile, 32]);
  eq(p.ops[2].value, 0); eq(p.ops[3].value, 'render_1 (Melodyne)'); eq(p.ops[4].value, 0.4000000059604645);
  const v = p.ops[5].verify;
  eq(v.warping, 0); eq(v.looping, 0, 'a fresh clip reads looping 1 until Warp is off'); eq(v.startBeats, 32); near(v.lengthSec, 643663 / 44100, 1e-12); eq(v.lengthTolSec, 0.002); eq(v.tempo, TEMPO);
  eq(p.ops[0].produces, 'lane'); eq(p.ops[1].produces, 'newClip');
  deq(JSON.parse(JSON.stringify(p.ops)), p.ops, 'plain JSON objects');
});

test('planPlacement preview: first preview makes a named track below the source, later ones replace the clip', () => {
  const first = core.planPlacement(planSpec('preview', { trackIndex: 3, pluginLabel: 'preview', existingClips: undefined, sourceClipId: undefined }));
  ok(first.ok, 'ok: ' + first.reason);
  deq(kinds(first.ops), ['create_audio_track@song', 'set:name@previewTrack', 'create_audio_clip@previewTrack', 'set:warping@newClip',
    'set:name@newClip', 'set:gain@newClip', 'verify@newClip']);
  deq(first.ops[0].args, [4]); eq(first.ops[0].produces, 'previewTrack');
  eq(first.ops[1].value, 'Preview: render_1');
  deq(first.ops[2].args, [planSpec().resultFile, 32]);
  eq(first.ops[4].value, 'render_1 (preview)');
  eq(first.rollbackAfter.length, 0, 'nothing destructive');

  const next = core.planPlacement(planSpec('preview', { trackIndex: 3, pluginLabel: 'preview', hasPreviewTrack: true }));
  ok(next.ok, 'ok: ' + next.reason);
  deq(kinds(next.ops), ['delete_clip@previewTrack', 'create_audio_clip@previewTrack', 'set:warping@newClip', 'set:name@newClip',
    'set:gain@newClip', 'verify@newClip']);
  deq(next.ops[0].args, [{ ref: 'previewClip' }]);
  ok(!next.ops.some((o) => o.destructive), 'the delete is not the destructive step');
  for (const o of next.ops) ok(o.target !== 'track', 'nothing is created or changed on the user\'s track: ' + o.op);
  for (const o of first.ops) ok(o.target !== 'track', 'nothing is created or changed on the user\'s track: ' + o.op);
  // the user's placement list is unchanged: 'preview' is not a choice
  planBad(planSpec('previews'), /unknown placement/);
  eq(core.buildJob(melSpec({ placement: 'preview' })).ok, false, 'preview is no placement for a job');
});

test('planPlacement newTrack: track at trackIndex+1, clip at region.startBeats', () => {
  const p = core.planPlacement(planSpec('newTrack', { trackIndex: 3, pluginLabel: 'VocAlign' }));
  ok(p.ok, 'ok');
  deq(kinds(p.ops), ['create_audio_track@song', 'create_audio_clip@newTrack', 'set:warping@newClip', 'set:name@newClip',
    'set:gain@newClip', 'verify@newClip']);
  deq(p.ops[0].args, [4]); eq(p.ops[0].produces, 'newTrack');
  deq(p.ops[1].args, [planSpec().resultFile, 32]);
  eq(p.ops[3].value, 'render_1 (VocAlign)');
});

test('planPlacement replace: backup, scratch track, destructive step last-but-verified', () => {
  const p = core.planPlacement(planSpec('replace'));
  ok(p.ok, 'ok');
  const K = kinds(p.ops);
  deq(K, ['create_audio_track@song', 'duplicate_clip_to_arrangement@backupTrack', 'verify@backupClip', 'set:mute@backupTrack',
    'create_audio_track@song', 'create_audio_clip@scratchTrack', 'set:warping@newClip', 'set:name@newClip', 'set:gain@newClip',
    'verify@newClip', 'delete_clip@track', 'duplicate_clip_to_arrangement@track', 'set:warping@finalClip', 'set:name@finalClip',
    'set:gain@finalClip', 'verify@finalClip', 'delete_track@song']);
  deq(p.ops[0].args, [1], 'backup track right below the source');
  deq(p.ops[4].args, [2], 'scratch track below the backup track');
  deq(p.ops[1].args, [{ ref: 'sourceClip', id: 13 }, 32]);
  eq(p.ops[2].verify.exists, true); eq(p.ops[2].verify.startBeats, 32); eq(p.ops[2].verify.lengthBeats, 32);
  eq(p.ops[3].value, 1);
  deq(p.ops[5].args, [planSpec().resultFile, 32]);
  deq(p.ops[10].args, [{ ref: 'sourceClip', id: 13 }]);
  deq(p.ops[11].args, [{ ref: 'newClip' }, 32]);
  eq(p.ops[11].produces, 'finalClip');
  deq(p.ops[16].args, [{ ref: 'scratchTrack' }]);
  eq(p.ops[16].optional, true, 'removing the scratch track after the verified result is optional');
  deq(p.ops.filter((o) => o.optional).length, 1, 'only that op is optional');
  ok(!p.rollbackAfter.some((o) => o.optional), 'rollback ops are never optional');
  eq(p.ops[15].verify.looping, 0); near(p.ops[15].verify.lengthSec, 643663 / 44100, 1e-12);
  eq(p.ops[13].value, 'render_1 (Melodyne)');
  const idx = (name) => K.indexOf(name);
  ok(idx('verify@backupClip') < idx('delete_clip@track'), 'backup verified before delete');
  ok(idx('set:mute@backupTrack') < idx('delete_clip@track'), 'backup muted before delete');
  ok(idx('verify@newClip') < idx('delete_clip@track'), 'result verified on the scratch track before the original is deleted');
  ok(K.indexOf('create_audio_clip@scratchTrack') < idx('delete_clip@track'), 'result created before delete');
  eq(K.filter((k) => /^create_audio_clip/.test(k)).length, 1, 'exactly one create_audio_clip');
  ok(!K.some((k) => k === 'create_audio_clip@track'), 'nothing is created on the main lane');
});

test('planPlacement replace: destructive step and rollbackAfter contract', () => {
  const p = core.planPlacement(planSpec('replace'));
  const destructive = p.ops.filter((o) => o.destructive === true);
  eq(destructive.length, 1, 'exactly one destructive op');
  eq(destructive[0].op, 'delete_clip'); eq(destructive[0].target, 'track');
  deq(p.ops.filter((o) => o.op === 'delete_clip').map((o) => o.destructive), [true], 'every delete_clip is marked');
  const r = p.rollbackAfter;
  deq(kinds(r), ['delete_clip@track', 'duplicate_clip_to_arrangement@track', 'verify@restoredClip', 'delete_track@song', 'delete_track@song']);
  eq(r[0].ifProduced, 'finalClip'); deq(r[0].args, [{ ref: 'finalClip' }]);
  deq(r[1].args, [{ ref: 'backupClip' }, 32]); eq(r[1].produces, 'restoredClip');
  eq(r[2].verify.exists, true); eq(r[2].verify.startBeats, 32); eq(r[2].verify.lengthBeats, 32); eq(r[2].verify.warping, 0);
  eq(r[3].ifProduced, 'scratchTrack'); deq(r[3].args, [{ ref: 'scratchTrack' }]);
  deq(r[4].args, [{ ref: 'backupTrack' }]);
  const verifyAt = kinds(r).indexOf('verify@restoredClip');
  r.forEach((o, i) => {
    const touchesBackup = (o.args || []).some((a) => a && (a.ref === 'backupClip' || a.ref === 'backupTrack')) && /^delete_/.test(o.op);
    if (touchesBackup) ok(i > verifyAt, 'backup is deleted only after the restore verify (step ' + i + ')');
  });
  ok(verifyAt > kinds(r).indexOf('duplicate_clip_to_arrangement@track'), 'restore verified after it is made');
  ok(kinds(r).indexOf('delete_track@song') > verifyAt, 'nothing but the failed result is deleted before the restore verify');
  deq(p.onRestoreFailure.keep.slice(0, 2), ['backupTrack', 'backupClip']);
  match(p.onRestoreFailure.message, /original clip is on the muted backup track/);
  ['takeLane', 'newTrack'].forEach((mode) => {
    const q = core.planPlacement(planSpec(mode));
    deq(q.rollbackAfter, [], mode + ' has no destructive step');
    eq(q.onRestoreFailure, null);
    ok(!q.ops.some((o) => o.destructive || /^delete_/.test(o.op)), mode + ' deletes nothing');
  });
});

test('planPlacement: every op that creates something says what it produces', () => {
  ['takeLane', 'newTrack', 'replace'].forEach((mode) => {
    const p = core.planPlacement(planSpec(mode));
    p.ops.concat(p.rollbackAfter).forEach((o) => {
      if (/^create_|^duplicate_/.test(o.op)) ok(typeof o.produces === 'string' && o.produces !== '', mode + ': ' + o.op + ' produces');
      else ok(o.produces === undefined, mode + ': ' + o.op + ' produces nothing');
    });
    // every {ref} / target resolves to something an earlier op produced (or is the source/song/track)
    const made = { song: 1, track: 1, sourceClip: 1 };
    p.ops.forEach((o) => {
      ok(made[o.target], mode + ': target ' + o.target + ' exists before ' + o.op);
      (Array.isArray(o.args) ? o.args : []).forEach((a) => { if (a && a.ref) ok(made[a.ref], mode + ': ref ' + a.ref + ' exists'); });
      if (o.produces) made[o.produces] = 1;
    });
  });
});

test('planPlacement: every created clip is unwarped before anything else touches it', () => {
  ['takeLane', 'newTrack', 'replace'].forEach((mode) => {
    const ops = core.planPlacement(planSpec(mode)).ops;
    ops.forEach((o, i) => {
      if (o.op === 'create_audio_clip') {
        eq(ops[i + 1].property, 'warping', mode + ' unwarp follows create'); eq(ops[i + 1].value, 0);
        eq(ops[i + 2].property, 'name', mode + ' name after unwarp');
        eq(ops[i + 3].property, 'gain', mode + ' gain after name');
        eq(ops[i + 4].op, 'verify', mode + ' verify follows gain');
      }
    });
    eq(ops.filter((o) => o.op === 'create_audio_clip').length, 1, mode + ' creates exactly one clip');
  });
});

test('planPlacement: gain step only when the gain is known; name fallbacks', () => {
  const noGain = core.planPlacement(planSpec('takeLane', { region: Object.assign({}, REG, { gain: null }) }));
  ok(noGain.ok && noGain.ops.filter((o) => o.property === 'gain').length === 0, 'no gain op');
  eq(core.planPlacement(planSpec('takeLane', { region: Object.assign({}, REG, { name: '' }) })).ops[3].value, 'Clip (Melodyne)');
  eq(core.planPlacement(planSpec('takeLane', { region: Object.assign({}, REG, { name: '\u00dcberg\u00e4nge \ud83c\udfa4' }) })).ops[3].value,
    '\u00dcberg\u00e4nge \ud83c\udfa4 (Melodyne)');
  const g = core.planPlacement(planSpec('takeLane', { region: Object.assign({}, REG, { gain: 0.28 }) }));
  eq(g.ops[4].value, 0.28, 'gain is copied raw');
});

test('planPlacement replace safety: never lands on another clip', () => {
  // another clip contains the start
  planBad(planSpec('replace', { existingClips: [{ id: 13, start_time: 32, end_time: 64 }, { id: 99, start_time: 20, end_time: 40 }] }),
    /overwrite/, 'start inside another clip');
  planBad(planSpec('replace', { existingClips: [{ id: 13, start_time: 32, end_time: 64 }, { id: 99, start_time: 32, end_time: 33 }] }),
    /overwrite/, 'another clip starts at the same beat');
  // abutting neighbours are fine
  ok(core.planPlacement(planSpec('replace', { existingClips: [{ id: 5, start_time: 0, end_time: 32 }, { id: 13, start_time: 32, end_time: 64 },
    { id: 6, start_time: 64, end_time: 100 }] })).ok, 'abutting neighbours');
  // the result may not run into the next clip: 14.5946 s = 32.0009 beats at this tempo? use a longer result
  const longer = { frames: Math.round((14.5946 + 0.010) * 44100), sampleRate: 44100 };
  planBad(planSpec('replace', { result: longer, existingClips: [{ id: 13, start_time: 32, end_time: 64 }, { id: 6, start_time: 64, end_time: 90 }] }),
    /run into/, 'result 10 ms too long');
  const slightly = { frames: Math.round((14.5946 + 0.001) * 44100), sampleRate: 44100 };
  ok(core.planPlacement(planSpec('replace', { result: slightly, existingClips: [{ id: 13, start_time: 32, end_time: 64 }, { id: 6, start_time: 64, end_time: 90 }] })).ok,
    '1 ms of overhang is within tolerance');
  // ids as strings still identify the source
  ok(core.planPlacement(planSpec('replace', { sourceClipId: '13', existingClips: [{ id: 13, start_time: '32', end_time: '64' }] })).ok, 'string ids');
  // what we cannot verify, we refuse
  planBad(planSpec('replace', { existingClips: undefined }), /list of clips/, 'no clip list');
  planBad(planSpec('replace', { existingClips: [] }), /no longer on the track/, 'source missing from the list');
  planBad(planSpec('replace', { existingClips: [{ id: 13, start_time: 'x', end_time: 64 }] }), /could not be read/, 'malformed entry');
  planBad(planSpec('replace', { existingClips: [{ id: 13, start_time: 32, end_time: 64 }, { id: 7, start_time: 90, end_time: 80 }] }), /could not be read/, 'inverted interval');
  planBad(planSpec('replace', { existingClips: [{ id: 13, start_time: 32, end_time: 64 }, null] }), /could not be read/, 'null entry');
  planBad(planSpec('replace', { existingClips: [null] }), /no longer on the track/, 'only a null entry');
  planBad(planSpec('replace', { sourceClipId: undefined }), /source clip id/, 'no source id');
  planBad(planSpec('replace', { sourceClipId: '' }), /source clip id/, 'empty source id');
});

// A short source (8 beats) with a neighbour 4 beats after it: inside the 32 beats Live's temporary warped clip would cover.
const SHORT_REG = Object.assign({}, REG, { startBeats: 32, lengthBeats: 8, endBeats: 40 });
const SHORT_RES = { frames: Math.round(8 * 60 / TEMPO * 44100), sampleRate: 44100 };
const SHORT_EXISTING = [{ id: 13, start_time: 32, end_time: 40 }, { id: 21, start_time: 44, end_time: 60 }];

test('planPlacement R2: replace never creates on the main lane, so a neighbour within 32 beats is fine', () => {
  const p = core.planPlacement(planSpec('replace', { region: SHORT_REG, result: SHORT_RES, existingClips: SHORT_EXISTING }));
  ok(p.ok, 'replace accepted: creation happens on the scratch track');
  ok(!p.ops.some((o) => o.op === 'create_audio_clip' && o.target === 'track'), 'no main-lane create');
  eq(core.planPlacement(planSpec('replace', { region: SHORT_REG, result: SHORT_RES,
    existingClips: [{ id: 13, start_time: 32, end_time: 40 }, { id: 21, start_time: 40, end_time: 60 }] })).ok, true, 'abutting neighbour');
  eq(core.planPlacement(planSpec('replace', { region: SHORT_REG, result: SHORT_RES, tempo: TEMPO,
    existingClips: [{ id: 13, start_time: 32, end_time: 40 }, { id: 22, start_time: 39.9, end_time: 60 }] })).ok, false, 'real overlap is still refused');
});

test('checkPlanSafety: a hypothetical main-lane create is refused when anything lies within the warped 32 beats', () => {
  const info = (existing) => ({ startBeats: 32, resultBeats: 8, tempo: TEMPO, existingClips: existing });
  const create = (target) => [{ op: 'create_audio_clip', target, args: ['/x.wav', 32], produces: 'newClip' }];
  const del = { op: 'delete_clip', target: 'track', args: [{ ref: 'sourceClip', id: 13 }], destructive: true };
  const r = core.checkPlanSafety(create('track'), info(SHORT_EXISTING));
  ok(!r.ok, 'refused: source 32..40 is still there and the neighbour at 44 is inside 32 beats'); match(r.reason, /overwrite|run into/);
  ok(!core.checkPlanSafety([del].concat(create('track')), info(SHORT_EXISTING)).ok, 'even with the source deleted, the neighbour at 44 is inside 32..64');
  ok(core.checkPlanSafety([del].concat(create('track')), info([SHORT_EXISTING[0], { id: 30, start_time: 64, end_time: 70 }])).ok,
    'a neighbour beyond start+32 does not matter');
  ok(core.checkPlanSafety([del].concat(create('track')), info([SHORT_EXISTING[0]])).ok, 'deleting the source clears the way');
  ok(core.checkPlanSafety(create('scratchTrack'), info(SHORT_EXISTING)).ok, 'scratch track');
  ok(core.checkPlanSafety(create('lane'), info(SHORT_EXISTING)).ok, 'take lane');
  ok(core.checkPlanSafety(create('newTrack'), info(SHORT_EXISTING)).ok, 'new track');
  ok(!core.checkPlanSafety(create('track'), info([{ id: 1, start_time: 'x', end_time: 2 }])).ok, 'unreadable clip list is refused');
  ok(core.checkPlanSafety([], info(SHORT_EXISTING)).ok, 'empty plan');
  // TEMP_WARPED_BEATS = 32: the check uses max(32, result length)
  ok(!core.checkPlanSafety(create('track'), { startBeats: 0, resultBeats: 1, tempo: TEMPO,
    existingClips: [{ id: 2, start_time: 31.9, end_time: 40 }] }).ok, 'clip at 31.9 is inside 0..32');
  ok(core.checkPlanSafety(create('track'), { startBeats: 0, resultBeats: 1, tempo: TEMPO,
    existingClips: [{ id: 2, start_time: 32, end_time: 40 }] }).ok, 'clip at 32 is outside 0..32');
  ok(!core.checkPlanSafety(create('track'), { startBeats: 0, resultBeats: 100, tempo: TEMPO,
    existingClips: [{ id: 2, start_time: 90, end_time: 95 }] }).ok, 'a long result extends the zone');
});

test('planPlacement R3: a source that moved or was trimmed while the host was open is refused', () => {
  const stale = (over) => [Object.assign({ id: 13, start_time: 32, end_time: 64 }, over)];
  planBad(planSpec('replace', { existingClips: stale({ start_time: 40, end_time: 72 }) }), /changed while the host was open/, 'moved');
  planBad(planSpec('replace', { existingClips: stale({ end_time: 60 }) }), /changed while the host was open/, 'trimmed');
  planBad(planSpec('replace', { existingClips: stale({ start_time: 32.002 }) }), /changed while the host was open/, '2 ms of beats');
  ok(core.planPlacement(planSpec('replace', { existingClips: stale({ start_time: 32.0005, end_time: 64.0005 }) })).ok, 'within 0.001 beats');
  planBad(planSpec('takeLane', { existingClips: stale({ end_time: 50 }) }), /changed while the host was open/, 'also for take lane when the id is known');
  planBad(planSpec('newTrack', { existingClips: stale({ start_time: 33 }) }), /changed while the host was open/, 'also for new track');
  ok(core.planPlacement(planSpec('takeLane', { existingClips: [{ id: 99, start_time: 0, end_time: 5 }] })).ok, 'source not in the list: fine for a take lane');
  ok(core.planPlacement(planSpec('takeLane', { sourceClipId: undefined, existingClips: stale({ end_time: 50 }) })).ok, 'no source id: nothing to compare');
});

test('planPlacement: ids as numbers, strings and ["id", N]', () => {
  ['13', 13, ['id', 13], 'id 13'].forEach((sid) => {
    ['13', 13, ['id', 13], 'id 13'].forEach((eid) => {
      ok(core.planPlacement(planSpec('replace', { sourceClipId: sid, existingClips: [{ id: eid, start_time: 32, end_time: 64 }] })).ok,
        'source ' + JSON.stringify(sid) + ' vs list ' + JSON.stringify(eid));
    });
  });
  planBad(planSpec('replace', { sourceClipId: 14 }), /no longer on the track/, 'different id');
  planBad(planSpec('replace', { sourceClipId: ['id', 14] }), /no longer on the track/, 'different id form');
  // a neighbour whose id is written differently must not be mistaken for the source
  planBad(planSpec('replace', { existingClips: [{ id: ['id', 13], start_time: 32, end_time: 64 }, { id: ['id', 14], start_time: 30, end_time: 40 }] }),
    /overwrite/, 'neighbour 14 is not the source');
});

test('planPlacement: an existing (Melodyne)/(VocAlign) suffix is not doubled', () => {
  const nameOf = (name, label) => core.planPlacement(planSpec('takeLane', { region: Object.assign({}, REG, { name }), pluginLabel: label })).ops[3].value;
  eq(nameOf('render_1 (Melodyne)', 'Melodyne'), 'render_1 (Melodyne)');
  eq(nameOf('render_1 (VocAlign)', 'Melodyne'), 'render_1 (Melodyne)');
  eq(nameOf('render_1 (Melodyne) (VocAlign)', 'VocAlign'), 'render_1 (VocAlign)');
  eq(nameOf('Take (2) (Melodyne)', 'Melodyne'), 'Take (2) (Melodyne)');
  eq(nameOf('(Melodyne)', 'Melodyne'), 'Clip (Melodyne)');
  eq(nameOf('Vocal (live)', 'Melodyne'), 'Vocal (live) (Melodyne)');
});

test('planPlacement: start inside another clip has a 1e-9 beat tolerance at the end', () => {
  ok(core.planPlacement(planSpec('replace', { existingClips: [{ id: 5, start_time: 0, end_time: 32 + 1e-10 }, { id: 13, start_time: 32, end_time: 64 }] })).ok,
    'previous clip ends 1e-10 beats late: noise');
  planBad(planSpec('replace', { existingClips: [{ id: 5, start_time: 0, end_time: 32 + 1e-6 }, { id: 13, start_time: 32, end_time: 64 }] }),
    /overwrite|run into/, 'previous clip ends 1e-6 late');
});

test('planPlacement: take lane and new track do not need the main-lane rule', () => {
  const overlapping = [{ id: 13, start_time: 32, end_time: 64 }, { id: 99, start_time: 30, end_time: 50 }];
  ok(core.planPlacement(planSpec('takeLane', { existingClips: overlapping })).ok, 'a take lane overlays another lane');
  ok(core.planPlacement(planSpec('newTrack', { existingClips: overlapping })).ok, 'a new track is empty');
  ok(core.planPlacement(planSpec('takeLane', { existingClips: undefined, sourceClipId: undefined })).ok, 'no clip list needed');
});

test('planPlacement: invalid inputs are refused, nothing is planned', () => {
  planBad(null, /./); planBad(undefined, /./);
  planBad(planSpec('inPlace'), /placement/);
  planBad(planSpec(undefined), /placement/);
  planBad(planSpec('takeLane', { region: null }), /position/);
  planBad(planSpec('takeLane', { region: Object.assign({}, REG, { startBeats: NaN }) }), /position/);
  planBad(planSpec('takeLane', { region: Object.assign({}, REG, { startBeats: -1 }) }), /position/);
  planBad(planSpec('takeLane', { result: null }), /length/);
  planBad(planSpec('takeLane', { result: { frames: 0, sampleRate: 44100 } }), /length/);
  planBad(planSpec('takeLane', { result: { frames: 100, sampleRate: 0 } }), /length/);
  planBad(planSpec('takeLane', { result: { frames: 'x', sampleRate: 44100 } }), /length/);
  planBad(planSpec('takeLane', { tempo: 0 }), /tempo/);
  planBad(planSpec('takeLane', { tempo: NaN }), /tempo/);
  planBad(planSpec('takeLane', { trackIndex: -1 }), /track/);
  planBad(planSpec('takeLane', { trackIndex: 1.5 }), /track/);
  planBad(planSpec('takeLane', { trackIndex: undefined }), /track/);
  planBad(planSpec('takeLane', { resultFile: 'results/a.wav' }), /absolute/);
  planBad(planSpec('takeLane', { resultFile: undefined }), /absolute/);
  planBad(planSpec('takeLane', { pluginLabel: '' }), /plug-in/);
  planBad(planSpec('takeLane', { pluginLabel: undefined }), /plug-in/);
});

test('planPlacement: does not modify its inputs', () => {
  const spec = planSpec('replace');
  const before = JSON.stringify(spec);
  core.planPlacement(spec);
  eq(JSON.stringify(spec), before);
});

test('end to end with the real clips: validate -> job -> plan', () => {
  [FX1, FX3].forEach((fx) => {
    const song = fx.song;
    const v = core.validateClip(fx.clip, fx.track, song);
    ok(v.ok, 'valid');
    const job = core.buildJob({ id: 'e2e-' + fx.clip.id, plugin: 'melodyne', placement: 'replace', realign: true, tempo: v.region.tempo,
      trackIndex: v.region.trackIndex, clips: [Object.assign({ role: 'source' }, v.region)] });
    ok(job.ok, 'job'); eq(job.job.clips[0].endSec, v.region.endSec);
    const frames = Math.round(v.region.durationSec * v.region.sampleRate);
    const plan = core.planPlacement({ mode: 'replace', region: v.region, result: { frames, sampleRate: v.region.sampleRate },
      tempo: v.region.tempo, trackIndex: v.region.trackIndex, sourceClipId: v.region.clipId, resultFile: '/tmp/r.wav',
      pluginLabel: 'Melodyne', existingClips: [{ id: fx.clip.id, start_time: v.region.startBeats, end_time: v.region.endBeats }] });
    ok(plan.ok, 'plan');
    near(plan.ops.filter((o) => o.op === 'verify' && o.target === 'newClip')[0].verify.lengthSec, v.region.durationSec, 1e-4);
  });
});

// ----------------------------------------------------------------------------------------------- uniqueName
test('uniqueName: base.ext, base-2.ext, base-3.ext with the injected predicate', () => {
  const taken = {};
  const exists = (p) => !!taken[p];
  eq(core.uniqueName('/res', 'result', exists), '/res/result.wav');
  taken['/res/result.wav'] = true;
  eq(core.uniqueName('/res', 'result', exists), '/res/result-2.wav');
  taken['/res/result-2.wav'] = true;
  eq(core.uniqueName('/res', 'result', exists), '/res/result-3.wav');
  eq(core.uniqueName('/res/', 'other', exists), '/res/other.wav', 'trailing slash on dir');
  eq(core.uniqueName('/res///', 'other', exists), '/res/other.wav', 'several trailing slashes');
  eq(core.uniqueName('/res', 'result', exists, '.aif'), '/res/result.aif', 'ext with dot');
  eq(core.uniqueName('/res', 'result', exists, 'flac'), '/res/result.flac', 'ext without dot');
});

test('uniqueName: strips separators, control characters and leading dots; keeps umlauts and emoji', () => {
  const none = () => false;
  eq(core.uniqueName('/r', 'a/b\\c', none), '/r/abc.wav');
  eq(core.uniqueName('/r', '../../etc/passwd', none), '/r/etcpasswd.wav');
  eq(core.uniqueName('/r', 'x\u0000y\nz\t\u007f', none), '/r/xyz.wav');
  eq(core.uniqueName('/r', '.hidden', none), '/r/hidden.wav');
  eq(core.uniqueName('/r', '\u00dcberg\u00e4nge \ud83c\udfa4', none), '/r/\u00dcberg\u00e4nge \ud83c\udfa4.wav');
  ['', '   ', '/', '...', null, undefined, 5].forEach((b) => eq(core.uniqueName('/r', b, none), '/r/result.wav', 'base ' + JSON.stringify(b)));
});

test('uniqueName: at most 120 characters, no split emoji, suffix included', () => {
  const none = () => false;
  const long = new Array(300).join('a');
  const n = core.uniqueName('/r', long, none);
  eq(path.basename(n, '.wav').length, 120);
  const emoji = new Array(100).join('\ud83c\udfa4');
  const e = path.basename(core.uniqueName('/r', emoji, none), '.wav');
  ok(e.length <= 120, 'emoji base length'); ok(!/[\ud800-\udbff]$/.test(e), 'no lone high surrogate');
  const taken = {};
  taken[n] = true;
  const second = core.uniqueName('/r', long, (p) => !!taken[p]);
  eq(path.basename(second, '.wav').length, 120, 'suffix counted in the 120');
  ok(/-2\.wav$/.test(second), 'suffix -2');
});

test('uniqueName: a base that already has an audio extension keeps it', () => {
  const none = () => false;
  eq(core.uniqueName('/r', 'job-1.wav', none), '/r/job-1.wav');
  eq(core.uniqueName('/r', 'job-1.WAV', none), '/r/job-1.WAV');
  eq(core.uniqueName('/r', 'job-1.aiff', none), '/r/job-1.aiff');
  eq(core.uniqueName('/r', 'take 1.5', none), '/r/take 1.5.wav', 'a dot that is not an audio extension');
  eq(core.uniqueName('/r', '.wav', none), '/r/wav.wav', 'only an extension left');
  eq(core.uniqueName('/r', 'job-1.wav', (p) => p === '/r/job-1.wav'), '/r/job-1-2.wav');
  eq(core.uniqueName('/r', 'job-1.wav', none, 'flac'), '/r/job-1.wav.flac', 'explicit ext wins');
});

test('uniqueName: guards', () => {
  throws(() => core.uniqueName('/r', 'x'), 'missing predicate');
  throws(() => core.uniqueName('/r', 'x', 'nope'), 'predicate not a function');
  eq(core.uniqueName('/r', 'x', () => true), null, 'gives up after 9999 tries');
  eq(core.uniqueName('', 'x', () => false), './x.wav', 'empty dir');
});

// ----------------------------------------------------------------------------------------------- ES5 / packaging
// Removes comments and string literals in one pass so the scan sees code only.
function codeOnly(src) {
  return src.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, ' ');
}
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
function es5Violations(src) {
  const code = codeOnly(src);
  return ES6_PATTERNS.filter((p) => p[0].test(code)).map((p) => p[1]);
}

// ----------------------------------------------------------------------------------------------- output "guide"
test('buildJob: output is optional, "guide" for VocAlign only, written only when given', () => {
  const g = core.buildJob(vocSpec({ output: 'guide' }));
  ok(g.ok, 'ok'); eq(g.job.output, 'guide');
  eq(core.buildJob(vocSpec({ output: 'dub' })).job.output, 'dub');
  ok(!('output' in core.buildJob(vocSpec()).job), 'absent: no key (the host default is dub)');
  ok(!('output' in core.buildJob(vocSpec({ output: null })).job), 'null: no key');
  eq(core.buildJob(melSpec({ output: 'dub' })).job.output, 'dub', 'dub is fine for Melodyne');
  jobBad(melSpec({ output: 'guide' }), /VocAlign only/);
  jobBad(vocSpec({ output: 'Guide' }), /unknown output "Guide"/);
  jobBad(vocSpec({ output: '' }), /unknown output/);
  jobBad(vocSpec({ output: 1 }), /unknown output/);
});

test('validateClip: VocAlign dub that ends before the guide, or too far from it, is refused', () => {
  const guide = core.clipRegion(FX1.clip, TEMPO).region;          // beats 32..64
  const dub = core.clipRegion(FX3.clip, TEMPO).region;            // starts at beat 128
  const dubOpts = (g) => ({ plugin: 'vocalign', role: 'dub', guide: g });
  ok(validate(FX3, {}, dubOpts(guide)).ok, 'the dub after the guide is fine (silence first)');
  ok(validate(FX3, {}, dubOpts(Object.assign({}, guide, { startBeats: dub.endBeats - 0.01, endBeats: dub.endBeats + 10 }))).ok,
    'the dub reaches just past the guide start');
  refused(validate(FX3, {}, dubOpts(Object.assign({}, guide, { startBeats: dub.endBeats, endBeats: dub.endBeats + 10 }))),
    'dub-before-guide', /^The dub clip ends before the guide clip starts\. Move it so that it overlaps the guide\.$/, 'ends at the guide start');
  refused(validate(FX3, {}, dubOpts(Object.assign({}, guide, { startBeats: 5000, endBeats: 5032 }))), 'dub-before-guide', /ends before/);
  ok(validate(FX3, {}, dubOpts({ startSec: 0, endSec: 1, tempo: TEMPO })).ok, 'a guide without beats (older guide.json) is not checked');
  const len = FX3.clip.end_time - FX3.clip.start_time;
  const farBeats = 7200 * TEMPO / 60;    // 2 hours in beats
  refused(validate(FX3, { start_time: farBeats + 10, end_time: farBeats + 10 + len }, dubOpts(Object.assign({}, guide, { startBeats: 0, endBeats: 32 }))),
    'too-far', /too far apart/);
  ok(validate(FX3, { start_time: farBeats - 10 - len, end_time: farBeats - 10 }, dubOpts(Object.assign({}, guide, { startBeats: 0, endBeats: 32 }))).ok,
    'just under 2 hours');
});

test('interpretResult: placeAt, offsetFrames and droppedFrames', () => {
  const g = core.interpretResult(OKR({ realign: { applied: false, reason: 'not-requested' }, placeAt: 'guide', offsetFrames: 22050, droppedFrames: 0 }), {});
  eq(g.kind, 'ok'); eq(g.placeAt, 'guide'); eq(g.offsetFrames, 22050); eq(g.droppedFrames, 0); eq(g.statusLine, 'Done.');
  const d = core.interpretResult(OKR({ realign: { applied: false, reason: 'not-requested' }, placeAt: 'guide', offsetFrames: 0, droppedFrames: 11025 }), {});
  eq(d.statusLine, 'Done. The first 0.25 s of the dub lay before the guide and were left out.');
  const old = core.interpretResult(OKR({ realign: { applied: false, reason: 'not-requested' } }), {});
  eq(old.placeAt, 'dub', 'no key (older host or output dub): the result starts at the dub'); eq(old.offsetFrames, 0); eq(old.droppedFrames, 0);
  const junk = core.interpretResult(OKR({ placeAt: 'track', offsetFrames: -3, droppedFrames: 'x' }), {});
  eq(junk.kind, 'ok'); eq(junk.placeAt, 'dub'); eq(junk.offsetFrames, 0); eq(junk.droppedFrames, 0);
  eq(core.interpretResult(OKR({ placeAt: 'dub', droppedFrames: 500 }), {}).statusLine, 'Done. Melodyne\'s timing shift was corrected.',
    'dropped frames only matter at the guide');
});

test('planPlacement placeAtBeats: takeLane and newTrack put the result there; the stale check still uses the source', () => {
  ['takeLane', 'newTrack'].forEach((mode) => {
    const p = core.planPlacement(planSpec(mode, { placeAtBeats: 20 }));
    ok(p.ok, mode);
    const create = p.ops.filter((o) => o.op === 'create_audio_clip');
    eq(create.length, 1); deq(create[0].args, [planSpec().resultFile, 20], mode + ' clip at the guide');
    eq(p.ops[p.ops.length - 1].verify.startBeats, 20, mode + ' verify at the guide');
    planBad(planSpec(mode, { placeAtBeats: 20, existingClips: [{ id: 13, start_time: 33, end_time: 65 }] }),
      /source clip changed while the host was open/, mode + ' source moved');
    deq(core.planPlacement(planSpec(mode, { placeAtBeats: null })).ops, core.planPlacement(planSpec(mode)).ops, mode + ' null = region start');
    deq(core.planPlacement(planSpec(mode, { placeAtBeats: 32 })).ops, core.planPlacement(planSpec(mode)).ops, mode + ' same as region start');
  });
  [-1, NaN, Infinity, '20', 2e7].forEach((v) => planBad(planSpec('takeLane', { placeAtBeats: v }), /result clip position is not known/, String(v)));
});

test('planPlacement placeAtBeats replace: backup and restore at the source, the result at placeAtBeats, safety at placeAtBeats', () => {
  const p = core.planPlacement(planSpec('replace', { placeAtBeats: 20 }));
  ok(p.ok, 'ok');
  deq(p.ops[1].args, [{ ref: 'sourceClip', id: 13 }, 32], 'backup copy of the source at its own start');
  eq(p.ops[2].verify.startBeats, 32, 'backup verified at the source start');
  deq(p.ops[5].args, [planSpec().resultFile, 20], 'result built on the scratch track at the guide');
  eq(p.ops[9].verify.startBeats, 20);
  deq(p.ops[11].args, [{ ref: 'newClip' }, 20], 'result moved onto the track at the guide');
  eq(p.ops[15].verify.startBeats, 20);
  deq(p.rollbackAfter[1].args, [{ ref: 'backupClip' }, 32], 'the original is restored at its own start');
  eq(p.rollbackAfter[2].verify.startBeats, 32);
  // the result [20, 52) with the source (13, [32, 64)) deleted first
  planBad(planSpec('replace', { placeAtBeats: 20, existingClips: [{ id: 13, start_time: 32, end_time: 64 }, { id: 7, start_time: 10, end_time: 25 }] }),
    /would overwrite another clip/, 'a clip under the guide start');
  planBad(planSpec('replace', { placeAtBeats: 20, existingClips: [{ id: 13, start_time: 32, end_time: 64 }, { id: 7, start_time: 50, end_time: 60 }] }),
    /run into the next clip/, 'a clip inside the moved result');
  ok(core.planPlacement(planSpec('replace', { placeAtBeats: 20, existingClips: [{ id: 7, start_time: 0, end_time: 20 }, { id: 13, start_time: 32, end_time: 64 },
    { id: 8, start_time: 52, end_time: 60 }] })).ok, 'neighbours that end at the guide and start at the result end are fine');
  planBad(planSpec('replace', { placeAtBeats: 20, existingClips: [{ id: 13, start_time: 32.5, end_time: 64.5 }] }), /changed while the host was open/);
});

test('ES5 scan finds nothing in core.js (and the scanner itself works)', () => {
  deq(es5Violations(fs.readFileSync(CORE_PATH, 'utf8')), [], 'core.js uses only ES5');
  const probes = ['let a = 1;', 'const b = 2;', 'var f = (x) => x;', 'var s = `t`;', 'class A {}', 'f(...xs);', 'Object.assign({}, a);',
    'a.includes(1);', 'x.padStart(2);', 'Number.isFinite(1);', 'a.find(f);', 'for (var k of xs) {}', 'a ** 2', 'a?.b', 'Math.trunc(1)'];
  probes.forEach((code) => ok(es5Violations(code).length > 0, 'scanner flags: ' + code));
  deq(es5Violations('var a = "let const => `x`"; // let const =>\n/* class */ var b = 1;'), [], 'comments and strings are ignored');
});

test('node --check passes and the file has no top-level use strict', () => {
  const r = cp.spawnSync(process.execPath, ['--check', CORE_PATH], { encoding: 'utf8' });
  eq(r.status, 0, 'node --check: ' + r.stderr);
  const src = fs.readFileSync(CORE_PATH, 'utf8');
  ok(!/^\s*['"]use strict['"]/m.test(src.split('var core = (function')[0].replace(/\/\/[^\n]*/g, '')), 'no file-level use strict (build concatenates files)');
});

test('without module the file attaches ARACore to the global object (as in Max js)', () => {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(CORE_PATH, 'utf8'), sandbox);
  ok(sandbox.ARACore && typeof sandbox.ARACore.uniqueName === 'function', 'ARACore global');
  deq(Object.keys(sandbox.ARACore).sort(), Object.keys(core).sort(), 'same API');
  ok(sandbox.ARACore.clipRegion(FX1.clip, TEMPO).ok, 'works inside a context with no module');
  eq(typeof sandbox.module, 'undefined');
});

test('exports exactly the planned functions', () => {
  deq(Object.keys(core).sort(), ['buildJob', 'checkPlanSafety', 'clipRegion', 'interpretResult', 'normalizeClip', 'normalizeTrack', 'planPlacement',
    'uniqueName', 'validateClip']);
});

// ----------------------------------------------------------------------------------------------- run
let failed = 0;
tests.forEach((t) => {
  const before = assertions;
  try {
    t.fn();
    console.log('ok   ' + t.name + ' (' + (assertions - before) + ' assertions)');
  } catch (e) {
    failed++;
    console.log('FAIL ' + t.name + ': ' + (e && e.message || e));
  }
});
console.log((failed ? failed + ' of ' + tests.length + ' tests FAILED' : 'all ' + tests.length + ' tests passed') +
  ', ' + assertions + ' assertions');
process.exit(failed ? 1 : 0);
