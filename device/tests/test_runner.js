// Tests for device/src/runner.js (the Node for Max side) under plain node with a stubbed max-api.
// Run: node device/tests/test_runner.js [--skip-real]
//  - fake hosts (small node/sh scripts in a temp dir) cover result-before-exit, exit without result, SIGTERM ladders,
//    signal crashes, partial result.json, late result.json, spawn failures, busy/job-exists/no-host, findplugins
//  - the real BridgeHost (headless Melodyne job, --find-plugins) unless --skip-real
// Every file the runner writes goes to a temp HOME (injected as `home`); the user's real
// ~/Library/Application Support/ARABridge is not touched. The spawned hosts keep the real HOME in their environment
// (Melodyne's licence and the user VST3 folder resolve from it); the real host reads settings from a temp
// ARABRIDGE_SETTINGS file.
// The fake node hosts run through a /bin/sh shim that execs "$FAKE_NODE" (default: the node running this test), so
// the suite also works with a node binary whose path contains spaces (Live's Node for Max 22.18.0):
//   "/Applications/Ableton Live 12 Suite.app/.../Node for Max/source/bin/osx/node/node" device/tests/test_runner.js
'use strict';
const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const SKIP_REAL = process.argv.includes('--skip-real');
const REPO = path.resolve(__dirname, '..', '..');
const RUNNER_PATH = path.join(REPO, 'device', 'src', 'runner.js');
const REAL_HOST = path.join(REPO, 'third_party', 'ARA_SDK', 'ARA_Examples', 'build', 'bin', 'Release', 'BridgeHost');

process.env.FAKE_NODE = process.env.FAKE_NODE || process.execPath;
process.env.ARABRIDGE_RUNNER_NO_AUTOSTART = '1';      // requiring runner.js must not register anything by itself
const runnerMod = require(RUNNER_PATH);
const core = require(path.join(REPO, 'device', 'src', 'core.js'));
const { createRunner } = runnerMod;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arabridge-runner-test-'));
const spawnedPids = new Set();

const FAST = { pollMs: 25, parseRetryMs: 400, exitGraceMs: 150, sigtermRepeatMs: 200, sigkillMs: 200,
  releaseAfterResultMs: 600, findPluginsTimeoutMs: 5000 };

// ------------------------------------------------------------------------------------------ helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, ms, what) {
  const t0 = Date.now();
  for (;;) {
    const v = pred();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timeout (' + ms + ' ms) waiting for ' + what);
    await sleep(15);
  }
}

function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return false; } }

function makeFixture(extra) {
  extra = extra || {};
  const dir = fs.mkdtempSync(path.join(TMP, 'fx-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const out = [];
  const maxApi = {
    addHandler: (n, f) => { maxApi.handlers[n] = f; },
    handlers: {},
    outlet: (...a) => {
      out.push({ t: Date.now(), args: a, sel: a[0], data: a.length > 1 ? JSON.parse(decodeURIComponent(a[1])) : undefined });
      return extra.rejectOutlet ? Promise.reject(new Error('outlet rejected (tests the catch)')) : undefined;
    },
    post: () => (extra.rejectOutlet ? Promise.reject(new Error('post rejected')) : undefined),
  };
  const runner = createRunner(Object.assign({ maxApi, home, env: Object.assign({}, process.env), delays: Object.assign({}, FAST, extra.delays) },
    extra.opts || {}));
  runner.register();
  const fx = {
    dir, home, out, maxApi, runner,
    all: (sel) => out.filter((o) => o.sel === sel),
    jobDir: (id) => path.join(runner.paths.jobsDir, id),
    send(name, payload) { maxApi.handlers[name](payload === undefined ? undefined : encodeURIComponent(JSON.stringify(payload))); },
    launch(job, mode, hostPath) { fx.send('launch', { job, mode, hostPath }); },
    async waitSel(sel, n, ms) { await waitFor(() => fx.all(sel).length >= (n || 1), ms || 8000, '"' + sel + '" outlet #' + (n || 1)); return fx.all(sel)[(n || 1) - 1]; },
    async ready(st) { await waitFor(() => fs.existsSync(path.join(st.jobDir, 'ready')), 10000, 'fake host ready marker'); },
    async started() { const s = await fx.waitSel('started'); spawnedPids.add(s.data.pid); return s.data; },
  };
  return fx;
}

function fakeHost(name, body) {
  const p = path.join(TMP, name);
  const impl = p + '.impl.js';
  const head = '\'use strict\';\n' +
    'const fs = require(\'fs\'); const path = require(\'path\');\n' +
    'const jobIdx = process.argv.indexOf(\'--job\'); const dir = jobIdx >= 0 ? process.argv[jobIdx + 1] : null;\n' +
    'function writeResult(o) { const f = path.join(dir, \'result.json\'); fs.writeFileSync(f + \'.tmp\', JSON.stringify(o)); fs.renameSync(f + \'.tmp\', f); }\n' +
    'if (dir) fs.writeFileSync(path.join(dir, \'argv.json\'), JSON.stringify({ argv: process.argv.slice(2), pid: process.pid, foo: process.env.ARABRIDGE_TEST_FOO || null, stdinClosed: (() => { try { return fs.fstatSync(0).isFile() === false; } catch (e) { return true; } })() }));\n';
  // `ready` is written after the body ran: handlers (SIGTERM etc.) are installed by then
  fs.writeFileSync(impl, head + body + '\nif (dir) fs.writeFileSync(path.join(dir, \'ready\'), \'1\');\n');
  fs.writeFileSync(p, '#!/bin/sh\nexec "$FAKE_NODE" \'' + impl + '\' "$@"\n');
  fs.chmodSync(p, 0o755);
  return p;
}

function shHost(name, script) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, '#!/bin/sh\n' + script + '\n');
  fs.chmodSync(p, 0o755);
  return p;
}

const OK_RESULT = '{ version: 1, id: "x", status: "ok", message: "", frames: 10, sampleRate: 44100 }';

let idCounter = 0;
function jobFor(plugin, clipSec) {
  idCounter++;
  const id = '20261023-1015' + String(idCounter).padStart(2, '0') + '-ab' + String(idCounter).padStart(2, '0');
  const sec = clipSec || 2;
  if (plugin === 'vocalign') {
    return core.buildJob({ id, plugin: 'vocalign', tempo: 120, clips: [
      { role: 'guide', path: '/tmp/g.wav', startSec: 0, endSec: sec, startBeats: 0, name: 'g' },
      { role: 'dub', path: '/tmp/d.wav', startSec: 0, endSec: sec, startBeats: 0, name: 'd' }] }).job;
  }
  return core.buildJob({ id, plugin: 'melodyne', tempo: 120, trackIndex: 1,
    clips: [{ role: 'source', path: '/tmp/s.wav', startSec: 1, endSec: 1 + sec, startBeats: 4, name: 'Vox' }] }).job;
}

function readJson(f) { return JSON.parse(fs.readFileSync(f, 'utf8')); }

// ------------------------------------------------------------------------------------------ tests

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('autostart under a stubbed max-api: six handlers, ping -> pong, nothing written', async () => {
  const handlers = {};
  const calls = [];
  const stub = { addHandler: (n, f) => { handlers[n] = f; }, outlet: (...a) => { calls.push(a); }, post: () => {} };
  const before = { ue: process.listeners('uncaughtException').slice(), ur: process.listeners('unhandledRejection').slice() };
  const origLoad = Module._load;
  Module._load = function (req) { if (req === 'max-api') return stub; return origLoad.apply(this, arguments); };
  delete process.env.ARABRIDGE_RUNNER_NO_AUTOSTART;
  delete require.cache[RUNNER_PATH];
  try {
    require(RUNNER_PATH);
  } finally {
    Module._load = origLoad;
    process.env.ARABRIDGE_RUNNER_NO_AUTOSTART = '1';
    delete require.cache[RUNNER_PATH];
    process.listeners('uncaughtException').filter((l) => !before.ue.includes(l)).forEach((l) => process.removeListener('uncaughtException', l));
    process.listeners('unhandledRejection').filter((l) => !before.ur.includes(l)).forEach((l) => process.removeListener('unhandledRejection', l));
  }
  assert.deepStrictEqual(Object.keys(handlers).sort(), ['cancel', 'copyresult', 'findplugins', 'launch', 'ping', 'status']);
  handlers.ping();
  assert.deepStrictEqual(calls, [['pong']]);
  handlers.status();
  assert.strictEqual(calls[1][0], 'status');
  assert.deepStrictEqual(JSON.parse(decodeURIComponent(calls[1][1])), { state: 'idle' });
  // and without the stub (plain node) requiring the module registers nothing and does not throw
  require(RUNNER_PATH);
});

test('headlessBudget follows the contract', async () => {
  const b = runnerMod.headlessBudget({ clips: [{ startSec: 0, endSec: 5 }, { startSec: 2, endSec: 7 }] });
  assert.strictEqual(b.T, 340);
  assert.strictEqual(b.grace, 15);
  assert.strictEqual(b.backstopMs, 395000);
  assert.strictEqual(runnerMod.headlessBudget({}).backstopMs, (300 + 15 + 40) * 1000);
});

test('no-host: error with install hint, no job folder created', async () => {
  const fx = makeFixture();
  const job = jobFor('melodyne');
  fx.launch(job, 'headless');
  const e = fx.all('error')[0];
  assert.ok(e, 'error outlet');
  assert.strictEqual(e.data.code, 'no-host');
  assert.ok(/tools\/install_host\.sh/.test(e.data.message), e.data.message);
  assert.ok(!fs.existsSync(fx.runner.paths.jobsDir), 'nothing created before the host is found');
  assert.strictEqual(fx.runner.isBusy(), false);
  // a payload override that is not executable is no-host as well, and names the path
  fx.launch(job, 'headless', path.join(TMP, 'does-not-exist'));
  assert.strictEqual(fx.all('error')[1].data.code, 'no-host');
  assert.ok(fx.all('error')[1].data.message.includes('does-not-exist'));
  fx.send('findplugins');
  assert.strictEqual(fx.all('error')[2].data.code, 'no-host');
});

test('host resolution: settings hostPath, then the installed copy', async () => {
  const fx = makeFixture();
  const { supportDir, settingsFile, installedHost } = fx.runner.paths;
  fs.mkdirSync(path.join(supportDir, 'bin'), { recursive: true });
  assert.strictEqual(fx.runner.resolveHost(null), null);
  fs.copyFileSync(shHost('h-installed.sh', 'exit 0'), installedHost);
  fs.chmodSync(installedHost, 0o755);
  assert.strictEqual(fx.runner.resolveHost(null), installedHost);
  const other = shHost('h-settings.sh', 'exit 0');
  fs.writeFileSync(settingsFile, JSON.stringify({ hostPath: other }));
  assert.strictEqual(fx.runner.resolveHost(null), other, 'settings hostPath wins');
  fs.writeFileSync(settingsFile, JSON.stringify({ hostPath: '~/nowhere/BridgeHost' }));
  assert.strictEqual(fx.runner.resolveHost(null), installedHost, 'not executable: fall back');
  fs.writeFileSync(settingsFile, JSON.stringify({ hostPath: '~/custom/BridgeHost' }));
  fs.mkdirSync(path.join(fx.home, 'custom'));
  fs.copyFileSync(other, path.join(fx.home, 'custom', 'BridgeHost'));
  fs.chmodSync(path.join(fx.home, 'custom', 'BridgeHost'), 0o755);
  assert.strictEqual(fx.runner.resolveHost(null), path.join(fx.home, 'custom', 'BridgeHost'), '~/ expands to the injected home');
  fs.writeFileSync(settingsFile, '{ not json');
  assert.strictEqual(fx.runner.resolveHost(null), installedHost, 'broken settings.json ignored');
  assert.strictEqual(fx.runner.resolveHost(fx.dir), null, 'a directory is not a host');
  // launch without a payload override uses the resolved host
  fs.writeFileSync(settingsFile, JSON.stringify({ hostPath: other }));
  const job = jobFor('melodyne');
  fx.launch(job, 'headless');
  const s = await fx.started();
  assert.strictEqual(s.hostPath, other);
  await fx.waitSel('done');
});

test('window mode: result.json before exit, host lingers, one done, busy until exit', async () => {
  process.env.ARABRIDGE_TEST_FOO = 'bar';
  const host = fakeHost('h-linger.js', 'console.log("hello from host"); console.error("warn on stderr");\n' +
    'setTimeout(() => { writeResult(' + OK_RESULT + '); }, 150);\nsetTimeout(() => process.exit(0), 1400);');
  const fx = makeFixture();
  const job = jobFor('melodyne');
  fx.launch(job, 'window', host);
  const st = await fx.started();
  assert.strictEqual(st.mode, 'window');
  assert.strictEqual(st.jobId, job.id);
  assert.strictEqual(fs.realpathSync(st.jobDir), fs.realpathSync(path.join(fx.home, 'Library', 'Application Support', 'ARABridge', 'jobs', job.id)));
  assert.ok(Number.isInteger(st.pid) && st.pid > 0);
  assert.strictEqual(fx.all('started')[0].args.length, 2, 'selector + ONE symbol');
  assert.ok(!/\s/.test(fx.all('started')[0].args[1]), 'payload has no whitespace');
  // job.json: written whole, equal to the job object, no temp file left
  await fx.ready(st);
  assert.deepStrictEqual(readJson(path.join(st.jobDir, 'job.json')), job);
  assert.ok(!fs.existsSync(path.join(st.jobDir, 'job.json.tmp')));
  const argv = readJson(path.join(st.jobDir, 'argv.json'));
  assert.deepStrictEqual(argv.argv, ['--job', st.jobDir], 'window mode args');
  assert.strictEqual(argv.foo, 'bar', 'env passes through');
  assert.strictEqual(argv.pid, st.pid);
  // own process group (detached)
  const pgid = Number(cp.execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(st.pid)]).toString().trim());
  assert.strictEqual(pgid, st.pid, 'host is its own process group leader');
  const d = (await fx.waitSel('done')).data;
  assert.strictEqual(d.resultJson.status, 'ok');
  assert.strictEqual(d.running, true);
  assert.strictEqual(d.exitCode, null);
  assert.strictEqual(d.signal, null);
  assert.strictEqual(d.jobId, job.id);
  assert.strictEqual(d.jobDir, st.jobDir);
  assert.ok(/hello from host/.test(d.hostLogTail) && /warn on stderr/.test(d.hostLogTail), 'stdout and stderr both in host.log: ' + JSON.stringify(d.hostLogTail));
  assert.ok(d.startedAt <= d.finishedAt && /^\d{4}-\d\d-\d\dT/.test(d.startedAt));
  // the job is done once its result was reported: not busy although the host still winds down
  assert.strictEqual(fx.runner.isBusy(), false);
  fx.send('status');
  assert.strictEqual(fx.all('status').pop().data.state, 'idle');
  assert.strictEqual(fx.all('status').pop().data.last.alive, true);
  // the late exit sends nothing
  await waitFor(() => !alive(st.pid), 5000, 'host exit');
  await sleep(FAST.releaseAfterResultMs + 300);
  assert.strictEqual(fx.all('error').length, 0);
  assert.strictEqual(fx.all('done').length, 1, 'exactly one done');
  assert.strictEqual(fx.all('started').length, 1);
  fx.send('status');
  const s = fx.all('status').pop().data;
  assert.strictEqual(s.state, 'idle');
  assert.strictEqual(s.last.jobId, job.id);
  assert.strictEqual(s.last.alive, false);
  // and a new job can start
  fx.launch(jobFor('melodyne'), 'window', host);
  await fx.started();
  await fx.waitSel('done', 2);
  delete process.env.ARABRIDGE_TEST_FOO;
});

test('live preview: new preview-<n> folders are reported once as status "preview", newest first, partial ones wait', async () => {
  const host = fakeHost('h-preview.js',
    'const mk = (n, body) => { const d = path.join(dir, "preview-" + n); fs.mkdirSync(d); fs.writeFileSync(path.join(d, "result.wav"), "x");' +
    ' fs.writeFileSync(path.join(d, "result.json"), body); };\n' +
    'const good = (n) => JSON.stringify({ version: 1, id: "x", status: "ok", message: "", frames: 10, sampleRate: 44100, resultPath: path.join(dir, "preview-" + n, "result.wav"), diagnostics: "secret" });\n' +
    'setTimeout(() => mk(1, good(1)), 100);\n' +
    // 3 is partial first, 2 is complete: 2 is reported; later 3 becomes complete and is reported too
    'setTimeout(() => { mk(2, good(2)); mk(3, "{\\"vers"); }, 500);\n' +
    'setTimeout(() => { fs.writeFileSync(path.join(dir, "preview-3", "result.json"), good(3)); }, 900);\n' +
    // 4 and 5 appear between two polls: only 5 (the newest complete one) is reported
    'setTimeout(() => { mk(4, good(4)); mk(5, good(5)); }, 1300);\n' +
    'setTimeout(() => { writeResult(' + OK_RESULT + '); }, 1900);\nsetTimeout(() => process.exit(0), 2400);');
  const fx = makeFixture();
  const job = jobFor('melodyne');
  job.preview = true;
  fx.launch(job, 'window', host);
  const st = await fx.started();
  const previews = () => fx.all('status').filter((o) => o.data && o.data.state === 'preview');
  await waitFor(() => previews().length >= 1, 5000, 'preview 1');
  const first = previews()[0].data;
  assert.strictEqual(first.n, 1);
  assert.strictEqual(first.jobId, job.id);
  assert.strictEqual(first.previewDir, path.join(st.jobDir, 'preview-1'));
  assert.strictEqual(first.resultJson.status, 'ok');
  assert.strictEqual(first.resultJson.diagnostics, undefined, 'slimmed like the final result');
  assert.strictEqual(first.resultJson.resultPath, path.join(st.jobDir, 'preview-1', 'result.wav'));
  await waitFor(() => previews().length >= 3, 5000, 'preview 3');
  assert.strictEqual(previews()[1].data.n, 2, '3 was partial: the newest complete one');
  assert.strictEqual(previews()[2].data.n, 3, '3 once complete');
  const d = (await fx.waitSel('done')).data;
  assert.strictEqual(d.resultJson.status, 'ok');
  await sleep(300);
  assert.deepStrictEqual(previews().map((o) => o.data.n), [1, 2, 3, 5], 'each reported once; 4 skipped in favour of 5');
  assert.strictEqual(fx.all('done').length, 1);
});

test('live preview: nothing is reported without job.preview, and none after the result', async () => {
  const host = fakeHost('h-preview-off.js',
    'const d1 = path.join(dir, "preview-1"); fs.mkdirSync(d1);' +
    ' fs.writeFileSync(path.join(d1, "result.json"), JSON.stringify({ version: 1, id: "x", status: "ok", message: "", frames: 10, sampleRate: 44100 }));\n' +
    'setTimeout(() => { writeResult(' + OK_RESULT + '); }, 300);\n' +
    'setTimeout(() => { const d2 = path.join(dir, "preview-2"); fs.mkdirSync(d2); fs.writeFileSync(path.join(d2, "result.json"), JSON.stringify({ status: "ok" })); }, 700);\n' +
    'setTimeout(() => process.exit(0), 1200);');
  const fx = makeFixture();
  fx.launch(jobFor('melodyne'), 'window', host);            // no preview flag
  await fx.started();
  await fx.waitSel('done');
  await sleep(900);
  assert.strictEqual(fx.all('status').filter((o) => o.data && o.data.state === 'preview').length, 0);

  const fx2 = makeFixture();
  const job2 = jobFor('melodyne');
  job2.preview = true;
  fx2.launch(job2, 'window', host);
  await fx2.started();
  await fx2.waitSel('done');
  await sleep(900);
  const n = fx2.all('status').filter((o) => o.data && o.data.state === 'preview').map((o) => o.data.n);
  assert.deepStrictEqual(n, [1], 'preview-1 before the result; preview-2 after it is never reported');
});

test('headless mode adds --autorender; vocalign job passes through unchanged', async () => {
  const host = fakeHost('h-headless.js', 'writeResult(' + OK_RESULT + '); process.exit(0);');
  const fx = makeFixture();
  const job = jobFor('vocalign');
  fx.launch(job, 'headless', host);
  const st = await fx.started();
  const d = (await fx.waitSel('done')).data;
  assert.deepStrictEqual(readJson(path.join(st.jobDir, 'argv.json')).argv, ['--job', st.jobDir, '--autorender']);
  assert.strictEqual(d.resultJson.status, 'ok');
  assert.deepStrictEqual(readJson(path.join(st.jobDir, 'job.json')), job);
  await waitFor(() => !fx.runner.isBusy(), 3000, 'released');
  assert.strictEqual(fx.all('done').length, 1);
});

test('exit without result.json: done with null result after the grace wait, exit code and log tail', async () => {
  const host = fakeHost('h-noresult.js', 'console.log("rendering..."); console.error("fatal: plug-in refused"); setTimeout(() => process.exit(3), 100);');
  const fx = makeFixture();
  fx.launch(jobFor('melodyne'), 'window', host);
  await fx.started();
  const t0 = Date.now();
  const d = (await fx.waitSel('done')).data;
  assert.strictEqual(d.resultJson, null);
  assert.strictEqual(d.exitCode, 3);
  assert.strictEqual(d.signal, null);
  assert.strictEqual(d.running, false);
  assert.ok(/rendering/.test(d.hostLogTail) && /plug-in refused/.test(d.hostLogTail));
  assert.ok(Date.now() - t0 < 5000, 'reported after the exit grace');
  await waitFor(() => !fx.runner.isBusy(), 2000, 'released');
  await sleep(FAST.releaseAfterResultMs + 200);
  assert.strictEqual(fx.all('done').length, 1);
});

test('host.log tail is at most 2000 bytes', async () => {
  const host = fakeHost('h-biglog.js', 'for (let i = 0; i < 400; i++) console.log("line " + String(i).padStart(4, "0") + " xxxxxxxxxxxxxxxx"); process.exit(5);');
  const fx = makeFixture();
  fx.launch(jobFor('melodyne'), 'window', host);
  const d = (await fx.waitSel('done')).data;
  assert.ok(Buffer.byteLength(d.hostLogTail) <= 2000, String(Buffer.byteLength(d.hostLogTail)));
  assert.ok(d.hostLogTail.includes('line 0399'));
  assert.ok(!d.hostLogTail.includes('\ufffd'), 'no replacement character');
});

test('late result.json after the exit is picked up within the grace wait', async () => {
  const host = fakeHost('h-late.js', 'setTimeout(() => process.exit(0), 80);');
  const fx = makeFixture({ delays: { exitGraceMs: 1500 } });
  fx.launch(jobFor('melodyne'), 'window', host);
  const st = await fx.started();
  // wait until the runner has seen the exit; the grace wait is still running then
  await waitFor(() => { fx.send('status'); return fx.all('status').pop().data.alive === false; }, 8000, 'runner saw the exit');
  assert.strictEqual(fx.all('done').length, 0);
  fs.writeFileSync(path.join(st.jobDir, 'result.json'), JSON.stringify({ version: 1, status: 'ok', message: 'late' }));
  const d = (await fx.waitSel('done')).data;
  assert.strictEqual(d.resultJson.message, 'late');
  assert.strictEqual(d.running, false);
  assert.strictEqual(d.exitCode, 0);
});

test('partial result.json that is completed shortly after: parsed once complete', async () => {
  const host = fakeHost('h-partial.js',
    'const f = path.join(dir, "result.json");\n' +
    'fs.writeFileSync(f, \'{"version":1,"id":"x","status":"ok","mess\');\n' +      // truncated, written in place (not atomic)
    'setTimeout(() => { fs.writeFileSync(f, JSON.stringify({ version: 1, id: "x", status: "ok", message: "complete" })); }, 250);\n' +
    'setTimeout(() => process.exit(0), 700);');
  const fx = makeFixture({ delays: { parseRetryMs: 2500 } });
  fx.launch(jobFor('melodyne'), 'window', host);
  const d = (await fx.waitSel('done')).data;
  assert.strictEqual(d.resultJson && d.resultJson.message, 'complete');
  assert.strictEqual(d.resultParseError, undefined);
  await sleep(1200);
  assert.strictEqual(fx.all('done').length, 1);
});

test('result.json that never becomes valid: null result and resultParseError after the retry window', async () => {
  const host = fakeHost('h-garbage.js', 'fs.writeFileSync(path.join(dir, "result.json"), \'{"version":1,\'); setTimeout(() => process.exit(0), 3000);');
  const fx = makeFixture();
  const t0 = Date.now();
  fx.launch(jobFor('melodyne'), 'window', host);
  await fx.started();
  const d = (await fx.waitSel('done')).data;
  const dt = Date.now() - t0;
  assert.strictEqual(d.resultJson, null);
  assert.ok(typeof d.resultParseError === 'string' && d.resultParseError.length > 0);
  assert.ok(dt >= FAST.parseRetryMs - 50 && dt < FAST.parseRetryMs + 4000, 'retried for about the window: ' + dt);
  assert.strictEqual(d.running, true);
  await sleep(100);
  const st = fx.all('started')[0].data;
  try { process.kill(st.pid, 'SIGKILL'); } catch (e) { /* gone */ }
  await sleep(FAST.releaseAfterResultMs + 300);
  assert.strictEqual(fx.all('done').length, 1);
});

test('stops supervising 20 s (here 600 ms) after a result when the host lingers; pid stays on record', async () => {
  const host = fakeHost('h-linger-long.js', 'writeResult(' + OK_RESULT + '); setTimeout(() => process.exit(0), 3000);');
  const fx = makeFixture();
  fx.launch(jobFor('melodyne'), 'window', host);
  const st = await fx.started();
  await fx.waitSel('done');
  assert.strictEqual(fx.runner.isBusy(), false, 'done frees the runner at once');
  await sleep(FAST.releaseAfterResultMs + 300);   // supervision of the lingering host ends (pid stays on record)
  assert.ok(alive(st.pid), 'host still running');
  fx.send('status');
  const s = fx.all('status').pop().data;
  assert.strictEqual(s.state, 'idle');
  assert.strictEqual(s.last.pid, st.pid);
  assert.strictEqual(s.last.alive, true);
  await waitFor(() => !alive(st.pid), 5000, 'host exit');
  await sleep(200);
  assert.strictEqual(fx.all('done').length, 1, 'no second done after the late exit');
});

test('busy rule: a new launch is accepted right after the previous done, while its host still lives', async () => {
  const hostA = fakeHost('h-lingerA.js', 'setTimeout(() => writeResult(' + OK_RESULT + '), 100); setTimeout(() => process.exit(0), 2500);');
  const hostB = fakeHost('h-quickB.js', 'setTimeout(() => writeResult(' + OK_RESULT + '), 100); setTimeout(() => process.exit(0), 500);');
  const fx = makeFixture();
  const jobA = jobFor('melodyne'); const jobB = jobFor('melodyne');
  fx.launch(jobA, 'window', hostA);
  const a = await fx.started();
  await fx.waitSel('done', 1);
  assert.strictEqual(fx.all('done')[0].data.running, true);
  fx.launch(jobB, 'window', hostB);                         // immediately after A's done
  assert.strictEqual(fx.all('error').length, 0, JSON.stringify(fx.all('error')));
  const b = (await fx.waitSel('started', 2)).data;
  spawnedPids.add(b.pid);
  assert.strictEqual(b.jobId, jobB.id);
  const dB = (await fx.waitSel('done', 2)).data;
  assert.strictEqual(dB.jobId, jobB.id);
  assert.strictEqual(dB.resultJson.status, 'ok');
  assert.ok(alive(a.pid), 'A still lives while B ran to completion');
  assert.strictEqual(fx.runner.isBusy(), false);
  // A's late exit changes nothing
  await waitFor(() => !alive(a.pid), 8000, 'A exit');
  await sleep(FAST.releaseAfterResultMs + 400);
  assert.deepStrictEqual(fx.all('done').map((o) => o.data.jobId), [jobA.id, jobB.id], 'exactly one done per job');
  assert.strictEqual(fx.all('error').length, 0);
  fx.send('status');
  const s = fx.all('status').pop().data;
  assert.strictEqual(s.state, 'idle');
  assert.strictEqual(s.last.jobId, jobB.id, 'last stays the newest job');
});

test('busy rule: cancel while B runs kills only B; A\'s exit does not disturb B', async () => {
  const hostA = fakeHost('h-lingerA2.js', 'setTimeout(() => writeResult(' + OK_RESULT + '), 100); setTimeout(() => process.exit(0), 1800);');
  const hostB = fakeHost('h-hangB.js', 'process.on("SIGTERM", () => process.exit(6)); setInterval(() => {}, 1000);');
  const calls = [];
  const fx = makeFixture({ opts: { kill: (pid, sig) => { calls.push([pid, sig]); return process.kill(pid, sig); } } });
  const jobA = jobFor('melodyne'); const jobB = jobFor('melodyne');
  fx.launch(jobA, 'window', hostA);
  const a = await fx.started();
  await fx.waitSel('done', 1);
  fx.launch(jobB, 'window', hostB);
  const b = (await fx.waitSel('started', 2)).data;
  spawnedPids.add(b.pid);
  assert.strictEqual(fx.runner.isBusy(), true);
  // A exits while B runs: B stays running, nothing is sent
  await waitFor(() => !alive(a.pid), 8000, 'A exit');
  await sleep(300);
  assert.strictEqual(fx.runner.isBusy(), true);
  assert.strictEqual(fx.all('done').length, 1);
  fx.send('status');
  assert.strictEqual(fx.all('status').pop().data.state, 'running');
  assert.strictEqual(fx.all('status').pop().data.jobId, jobB.id);
  // a third launch is busy because B has no result yet
  fx.launch(jobFor('melodyne'), 'window', hostB);
  assert.strictEqual(fx.all('error').pop().data.code, 'busy');
  assert.ok(fx.all('error').pop().data.message.includes(jobB.id));
  await fx.ready(b);
  fx.send('cancel');
  const dB = (await fx.waitSel('done', 2)).data;
  assert.strictEqual(dB.jobId, jobB.id);
  assert.strictEqual(dB.exitCode, 6);
  assert.deepStrictEqual(calls, [[b.pid, 'SIGTERM']], 'only B was signalled');
});

test('busy rule: cancel while A lingers after its result and B runs signals only B', async () => {
  const hostA = fakeHost('h-lingerA3.js', 'setTimeout(() => writeResult(' + OK_RESULT + '), 100); setTimeout(() => process.exit(0), 6000);');
  const hostB = fakeHost('h-hangB2.js', 'process.on("SIGTERM", () => process.exit(6)); setInterval(() => {}, 1000);');
  const calls = [];
  const fx = makeFixture({ opts: { kill: (pid, sig) => { calls.push([pid, sig]); return process.kill(pid, sig); } } });
  fx.launch(jobFor('melodyne'), 'window', hostA);
  const a = await fx.started();
  await fx.waitSel('done', 1);
  fx.launch(jobFor('melodyne'), 'window', hostB);
  const b = (await fx.waitSel('started', 2)).data;
  spawnedPids.add(b.pid);
  await fx.ready(b);
  fx.send('cancel');
  await fx.waitSel('done', 2);
  assert.ok(alive(a.pid), 'A was not touched');
  assert.deepStrictEqual(calls, [[b.pid, 'SIGTERM']]);
  process.kill(a.pid, 'SIGKILL');
  await sleep(300);
  assert.strictEqual(fx.all('done').length, 2);
});

test('busy rule: while the previous job has no result, launch answers busy; a crash without result frees the runner', async () => {
  const hostA = fakeHost('h-crashA.js', 'setTimeout(() => process.exit(3), 600);');
  const fx = makeFixture();
  const jobA = jobFor('melodyne');
  fx.launch(jobA, 'window', hostA);
  await fx.started();
  fx.launch(jobFor('melodyne'), 'window', hostA);
  assert.strictEqual(fx.all('error').length, 1);
  assert.strictEqual(fx.all('error')[0].data.code, 'busy');
  const d = (await fx.waitSel('done')).data;
  assert.strictEqual(d.resultJson, null);
  assert.strictEqual(d.exitCode, 3);
  assert.strictEqual(fx.runner.isBusy(), false);
  fx.launch(jobFor('melodyne'), 'window', hostA);          // accepted at once
  assert.strictEqual(fx.all('error').length, 1);
  const b = (await fx.waitSel('started', 2)).data;
  spawnedPids.add(b.pid);
  await fx.waitSel('done', 2);
});

test('cancel with no running job: status idle', async () => {
  const fx = makeFixture();
  fx.send('cancel');
  assert.deepStrictEqual(fx.all('status')[0].data, { state: 'idle' });
});

test('cancel: SIGTERM stops a cooperative host (exit 6, no result)', async () => {
  const host = fakeHost('h-hang.js', 'process.on("SIGTERM", () => process.exit(6)); setInterval(() => {}, 1000);');
  const fx = makeFixture();
  fx.launch(jobFor('melodyne'), 'window', host);
  const st = await fx.started();
  await fx.ready(st);
  fx.send('status');
  assert.strictEqual(fx.all('status')[0].data.state, 'running');
  assert.strictEqual(fx.all('status')[0].data.pid, st.pid);
  fx.send('cancel');
  const steps = fx.all('status').slice(1).map((o) => o.data.step);
  assert.deepStrictEqual(steps, ['sigterm']);
  assert.strictEqual(fx.all('status')[1].data.state, 'cancelling');
  const d = (await fx.waitSel('done')).data;
  assert.strictEqual(d.resultJson, null);
  assert.strictEqual(d.exitCode, 6);
  assert.strictEqual(d.running, false);
  await sleep(FAST.sigtermRepeatMs + FAST.sigkillMs + 200);
  assert.deepStrictEqual(fx.all('status').slice(1).map((o) => o.data.step), ['sigterm'], 'ladder timers stop at exit');
  assert.strictEqual(fx.runner.isBusy(), false);
});

test('cancel ladder: host ignores the first SIGTERM -> second SIGTERM after the delay', async () => {
  const host = fakeHost('h-ignore1.js', 'let n = 0; process.on("SIGTERM", () => { n++; fs.appendFileSync(path.join(dir, "sig.log"), "T"); if (n >= 2) process.exit(6); }); setInterval(() => {}, 1000);');
  const fx = makeFixture();
  fx.launch(jobFor('melodyne'), 'window', host);
  const st = await fx.started();
  await fx.ready(st);
  fx.send('cancel');
  const n1 = fx.all('status').length;
  fx.send('cancel');     // a second cancel reports the current step but does not restart or double the ladder
  assert.strictEqual(fx.all('status').length, n1 + 1);
  assert.strictEqual(fx.all('status')[n1].data.state, 'cancelling');
  assert.strictEqual(fx.all('status')[n1].data.step, 'sigterm');
  const d = (await fx.waitSel('done')).data;
  const steps = fx.all('status').filter((o, i) => o.data.step && i !== n1);
  assert.deepStrictEqual(steps.map((o) => o.data.step), ['sigterm', 'sigterm2']);
  assert.ok(steps[1].t - steps[0].t >= FAST.sigtermRepeatMs - 20, 'second SIGTERM waited: ' + (steps[1].t - steps[0].t));
  assert.ok(steps[1].t - steps[0].t < FAST.sigtermRepeatMs + 3000);
  assert.strictEqual(fs.readFileSync(path.join(st.jobDir, 'sig.log'), 'utf8'), 'TT');
  assert.strictEqual(d.exitCode, 6);
  assert.strictEqual(d.signal, null);
});

test('cancel ladder: host ignores SIGTERM entirely -> SIGKILL after both delays', async () => {
  const host = fakeHost('h-ignoreall.js', 'process.on("SIGTERM", () => { fs.appendFileSync(path.join(dir, "sig.log"), "T"); }); setInterval(() => {}, 1000);');
  const fx = makeFixture();
  fx.launch(jobFor('melodyne'), 'window', host);
  const st = await fx.started();
  await fx.ready(st);
  fx.send('cancel');
  const d = (await fx.waitSel('done')).data;
  const steps = fx.all('status').filter((o) => o.data.step);
  assert.deepStrictEqual(steps.map((o) => o.data.step), ['sigterm', 'sigterm2', 'sigkill']);
  assert.ok(steps[2].t - steps[1].t >= FAST.sigkillMs - 20, 'SIGKILL waited: ' + (steps[2].t - steps[1].t));
  assert.ok(steps[2].t - steps[0].t >= FAST.sigtermRepeatMs + FAST.sigkillMs - 30);
  assert.strictEqual(d.signal, 'SIGKILL');
  assert.strictEqual(d.exitCode, null);
  assert.strictEqual(d.resultJson, null);
  assert.strictEqual(fs.readFileSync(path.join(st.jobDir, 'sig.log'), 'utf8'), 'TT');
  assert.ok(!alive(st.pid));
});

test('crash by signal: done with signal and null exit code', async () => {
  const host = shHost('h-crash.sh', 'echo about to crash\nkill -ABRT $$\nsleep 5');
  const fx = makeFixture();
  fx.launch(jobFor('melodyne'), 'headless', host);
  await fx.started();
  const d = (await fx.waitSel('done')).data;
  assert.strictEqual(d.signal, 'SIGABRT');
  assert.strictEqual(d.exitCode, null);
  assert.strictEqual(d.resultJson, null);
  assert.ok(/about to crash/.test(d.hostLogTail));
});

test('headless backstop: SIGKILL after the budget (override), status backstop', async () => {
  const host = fakeHost('h-hangs-headless.js', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);');
  const fx = makeFixture({ delays: { backstopMs: 400 } });
  fx.launch(jobFor('melodyne'), 'headless', host);
  const st = await fx.started();
  const t0 = Date.now();
  const d = (await fx.waitSel('done')).data;
  assert.strictEqual(d.signal, 'SIGKILL');
  assert.ok(Date.now() - t0 >= 300);
  const b = fx.all('status').find((o) => o.data.state === 'backstop');
  assert.ok(b && b.data.step === 'sigkill' && b.data.pid === st.pid);
});

test('window mode has no backstop', async () => {
  const host = fakeHost('h-hangs-window.js', 'setInterval(() => {}, 1000);');
  const fx = makeFixture({ delays: { backstopMs: 200 } });
  fx.launch(jobFor('melodyne'), 'window', host);
  const st = await fx.started();
  await sleep(700);
  assert.ok(alive(st.pid));
  assert.strictEqual(fx.all('done').length, 0);
  assert.strictEqual(fx.all('status').length, 0);
  await fx.ready(st);
  fx.send('cancel');
  await fx.waitSel('done');
});

test('host survives the runner (dispose stops the watchers only and detaches the listeners)', async () => {
  const host = fakeHost('h-survives.js', 'setTimeout(() => { writeResult(' + OK_RESULT + '); }, 300);\n' +
    'setTimeout(() => { fs.writeFileSync(path.join(dir, "finished"), "yes"); process.exit(0); }, 1000);');
  const children = [];
  const fx = makeFixture({ opts: { spawn: (...a) => { const c = cp.spawn(...a); children.push(c); return c; } } });
  fx.launch(jobFor('melodyne'), 'window', host);
  const st = await fx.started();
  assert.strictEqual(children[0].listenerCount('exit'), 1);
  assert.strictEqual(children[0].listenerCount('error'), 1);
  fx.runner.dispose();
  assert.strictEqual(children[0].listenerCount('exit'), 0, 'exit listener detached');
  assert.ok(children[0].listenerCount('error') >= 1, 'an error listener stays so an emit cannot throw');
  assert.doesNotThrow(() => children[0].emit('error', new Error('late error')));
  await sleep(300);
  assert.ok(alive(st.pid), 'host still running after dispose');
  await waitFor(() => fs.existsSync(path.join(st.jobDir, 'finished')), 8000, 'host finished by itself');
  await waitFor(() => !alive(st.pid), 4000, 'host exited');
  await sleep(300);
  assert.ok(fs.existsSync(path.join(st.jobDir, 'result.json')), 'the host wrote its result');
  assert.deepStrictEqual(fx.out.map((o) => o.sel), ['started'], 'a disposed runner reports nothing, although the result appeared and the host exited');
});

test('jobs folder that is a file: io-error, not job-exists', async () => {
  const host = fakeHost('h-unused4.js', 'process.exit(0);');
  const fx = makeFixture();
  fs.mkdirSync(fx.runner.paths.supportDir, { recursive: true });
  fs.writeFileSync(fx.runner.paths.jobsDir, 'i am a file');
  fx.launch(jobFor('melodyne'), 'window', host);
  assert.strictEqual(fx.all('error')[0].data.code, 'io-error');
  assert.ok(fx.all('error')[0].data.message.includes('jobs folder'));
  assert.strictEqual(fx.runner.isBusy(), false);
});

test('host.log tail starts at a UTF-8 character boundary', async () => {
  const host = fakeHost('h-utf8.js', 'process.stdout.write("\\u20ac".repeat(3000)); process.exit(4);');
  const fx = makeFixture();
  fx.launch(jobFor('melodyne'), 'window', host);
  const d = (await fx.waitSel('done')).data;
  assert.ok(!d.hostLogTail.includes('\ufffd'), 'no replacement character');
  assert.strictEqual(d.hostLogTail, '\u20ac'.repeat(666), 'a 3-byte character cut by the 2000-byte window is dropped whole');
});

test('final SIGKILL of the cancel ladder goes to the process group and takes helpers with it', async () => {
  const host = fakeHost('h-group.js', 'const c = require("child_process").spawn("/bin/sleep", ["60"], { stdio: "ignore" });\n' +
    'fs.writeFileSync(path.join(dir, "child.pid"), String(c.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);');
  const calls = [];
  const fx = makeFixture({ opts: { kill: (pid, sig) => { calls.push([pid, sig]); return process.kill(pid, sig); } } });
  fx.launch(jobFor('melodyne'), 'window', host);
  const st = await fx.started();
  const childPidFile = path.join(st.jobDir, 'child.pid');
  await waitFor(() => fs.existsSync(childPidFile) && fs.readFileSync(childPidFile, 'utf8') !== '', 8000, 'helper started');
  const helper = Number(fs.readFileSync(childPidFile, 'utf8'));
  assert.ok(alive(helper));
  await fx.ready(st);
  fx.send('cancel');
  const d = (await fx.waitSel('done')).data;
  assert.strictEqual(d.signal, 'SIGKILL');
  assert.deepStrictEqual(calls, [[st.pid, 'SIGTERM'], [st.pid, 'SIGTERM'], [-st.pid, 'SIGKILL']]);
  await waitFor(() => !alive(helper), 5000, 'helper killed with the group');
});

test('spawn throws: error spawn-failed, not busy, job folder kept', async () => {
  const host = fakeHost('h-unused.js', 'process.exit(0);');
  const fx = makeFixture({ opts: { spawn: () => { throw new Error('EMFILE simulated'); } } });
  const job = jobFor('melodyne');
  fx.launch(job, 'window', host);
  assert.strictEqual(fx.all('error')[0].data.code, 'spawn-failed');
  assert.ok(/EMFILE simulated/.test(fx.all('error')[0].data.message));
  assert.strictEqual(fx.runner.isBusy(), false);
  assert.strictEqual(fx.all('started').length, 0);
});

test('spawn fails asynchronously (bad interpreter): one done with spawnError, busy cleared', async () => {
  const bad = path.join(TMP, 'h-bad-interp');
  fs.writeFileSync(bad, '#!/nonexistent/interpreter\n');
  fs.chmodSync(bad, 0o755);
  const fx = makeFixture();
  fx.launch(jobFor('melodyne'), 'window', bad);
  const d = (await fx.waitSel('done')).data;
  assert.strictEqual(d.resultJson, null);
  assert.strictEqual(d.exitCode, null);
  assert.ok(/ENOENT/.test(d.spawnError), String(d.spawnError));
  assert.strictEqual(d.running, false);
  assert.strictEqual(fx.all('error').length, 0, 'no second terminal message');
  await waitFor(() => !fx.runner.isBusy(), 2000, 'released');
  await sleep(200);
  assert.strictEqual(fx.all('done').length, 1);
});

test('job-exists: an existing folder is never reused', async () => {
  const host = fakeHost('h-unused2.js', 'process.exit(0);');
  const fx = makeFixture();
  const job = jobFor('melodyne');
  fs.mkdirSync(fx.jobDir(job.id), { recursive: true });
  fs.writeFileSync(path.join(fx.jobDir(job.id), 'keep.txt'), 'x');
  fx.launch(job, 'window', host);
  assert.strictEqual(fx.all('error')[0].data.code, 'job-exists');
  assert.deepStrictEqual(fs.readdirSync(fx.jobDir(job.id)), ['keep.txt']);
  assert.strictEqual(fx.runner.isBusy(), false);
  assert.strictEqual(fx.all('started').length, 0);
});

test('bad payloads: errors, nothing outside jobs/ is created', async () => {
  const host = fakeHost('h-unused3.js', 'process.exit(0);');
  const fx = makeFixture();
  const good = jobFor('melodyne');
  fx.maxApi.handlers.launch('%7Bnot-json');
  fx.maxApi.handlers.launch(undefined);
  fx.send('launch', { mode: 'window' });
  fx.send('launch', { job: good, mode: 'turbo' }, host);
  fx.launch(Object.assign({}, good, { id: '../escape' }), 'window', host);
  fx.launch(Object.assign({}, good, { id: 'a/b' }), 'window', host);
  fx.launch(Object.assign({}, good, { id: '.hidden' }), 'window', host);
  fx.launch(Object.assign({}, good, { id: 'a:b' }), 'window', host);
  fx.launch(Object.assign({}, good, { id: '' }), 'window', host);
  fx.launch(Object.assign({}, good, { id: 5 }), 'window', host);
  const codes = fx.all('error').map((o) => o.data.code);
  assert.deepStrictEqual(codes, ['bad-payload', 'bad-payload', 'bad-payload', 'bad-payload', 'bad-job', 'bad-job', 'bad-job', 'bad-job', 'bad-job', 'bad-job']);
  assert.ok(!fs.existsSync(fx.runner.paths.jobsDir) || fs.readdirSync(fx.runner.paths.jobsDir).length === 0);
  assert.deepStrictEqual(fs.readdirSync(fx.home), [], 'nothing created in the home');
});

test('handlers never throw, even with garbage and rejecting outlets', async () => {
  const fx = makeFixture({ rejectOutlet: true });
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    for (const name of ['launch', 'cancel', 'status', 'findplugins', 'ping']) {
      for (const arg of [undefined, null, 42, {}, '%E0%A4%A', 'plain', encodeURIComponent('null'), encodeURIComponent('[]'), encodeURIComponent('{"job":5}')]) {
        fx.maxApi.handlers[name](arg);
      }
    }
    await sleep(100);
  } finally { process.removeListener('unhandledRejection', onUnhandled); }
  assert.deepStrictEqual(unhandled, [], 'rejected outlet/post promises are swallowed');
  assert.ok(fx.all('pong').length === 9);
  // a throwing outlet is survived too
  const fx2 = makeFixture();
  fx2.maxApi.outlet = () => { throw new Error('Max is gone'); };
  fx2.maxApi.handlers.ping();
  fx2.maxApi.handlers.status();
});

test('findplugins relays the host JSON; failures become findplugins-failed', async () => {
  const good = shHost('h-find.sh', 'echo "log line"\necho \'{"melodyne":{"found":true,"path":"/x"},"vocalign":{"found":false,"problem":"none"}}\'');
  const fx = makeFixture();
  const { supportDir, settingsFile } = fx.runner.paths;
  fs.mkdirSync(supportDir, { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({ hostPath: good }));
  fx.send('findplugins');
  const p = (await fx.waitSel('plugins')).data;
  assert.deepStrictEqual(p, { melodyne: { found: true, path: '/x' }, vocalign: { found: false, problem: 'none' } });
  const failing = shHost('h-find-fail.sh', 'echo "boom" >&2\nexit 2');
  fs.writeFileSync(settingsFile, JSON.stringify({ hostPath: failing }));
  fx.send('findplugins');
  let e = (await fx.waitSel('error')).data;
  assert.strictEqual(e.code, 'findplugins-failed');
  assert.ok(/code 2/.test(e.message) && /boom/.test(e.message), e.message);
  const garbage = shHost('h-find-garbage.sh', 'echo not json');
  fs.writeFileSync(settingsFile, JSON.stringify({ hostPath: garbage }));
  fx.send('findplugins');
  e = (await fx.waitSel('error', 2)).data;
  assert.strictEqual(e.code, 'findplugins-failed');
  const hang = fakeHost('h-find-hang.js', 'setInterval(() => {}, 1000);');
  fs.writeFileSync(settingsFile, JSON.stringify({ hostPath: hang }));
  fx.send('findplugins');
  e = (await fx.waitSel('error', 3, 10000)).data;
  assert.strictEqual(e.code, 'findplugins-failed');
  assert.ok(/SIGKILL/.test(e.message));
  assert.strictEqual(fx.runner.isBusy(), false, 'findplugins never blocks a job');
});

test('ping -> pong', async () => {
  const fx = makeFixture();
  fx.send('ping');
  assert.deepStrictEqual(fx.out[0].args, ['pong']);
});

// ------------------------------------------------------------------------------------------ payload size guard

function bigResult() {
  const shifts = [];
  for (let i = 0; i < 500; i++) shifts.push({ start: i * 1000, end: i * 1000 + 999, shift: 0.123456789 * i, correlation: 0.987654321 });
  return { version: 1, id: 'x', status: 'ok', message: 'M'.repeat(4096), diagnostics: 'D'.repeat(4096) + '\n' + JSON.stringify(shifts),
    resultPath: '/private/tmp/job/result.wav', sourceStartFrame: 22050, frames: 88200, sampleRate: 44100,
    realign: { applied: true, reason: 'applied', shifts } };
}

test('done payload: 500 shift segments + 4 KB message/diagnostics stay below the Max symbol limit; core fields survive', async () => {
  const r = bigResult();
  assert.ok(encodeURIComponent(JSON.stringify(r)).length > 32767, 'the raw result would not fit one symbol');
  const host = fakeHost('h-bigresult.js', 'writeResult(' + JSON.stringify(r) + '); setTimeout(() => process.exit(0), 200);');
  const fx = makeFixture();
  fx.launch(jobFor('melodyne'), 'window', host);
  const o = await fx.waitSel('done');
  assert.ok(o.args[1].length < 32767, 'encoded length ' + o.args[1].length);
  assert.ok(o.args[1].length < 30000);
  const rj = o.data.resultJson;
  assert.strictEqual(rj.status, 'ok');
  assert.strictEqual(rj.message, r.message);
  assert.strictEqual(rj.resultPath, r.resultPath);
  assert.strictEqual(rj.frames, 88200);
  assert.strictEqual(rj.sampleRate, 44100);
  assert.strictEqual(rj.sourceStartFrame, 22050);
  assert.strictEqual(rj.realign.applied, true);
  assert.strictEqual(rj.realign.reason, 'applied');
  assert.strictEqual(rj.realign.shiftCount, 500);
  assert.strictEqual(rj.realign.shifts, undefined);
  assert.strictEqual(rj.diagnostics, undefined);
  assert.strictEqual(o.data.truncated, undefined, 'no further shrinking was needed');
  const res = core.interpretResult(rj, { exitCode: 0, signal: null });
  assert.strictEqual(res.kind, 'ok');
  assert.strictEqual(res.frames, 88200);
  assert.strictEqual(res.resultPath, r.resultPath);
  assert.strictEqual(res.realign.applied, true);
});

test('done payload: worst case (4 KB message of 4-byte characters, 2 KB non-ASCII log) still fits', async () => {
  const r = bigResult();
  r.message = '\u{1F3A4}'.repeat(1024);
  const host = fakeHost('h-bigresult2.js', 'process.stdout.write("\\u00e4".repeat(1000)); writeResult(' + JSON.stringify(r) + '); setTimeout(() => process.exit(0), 200);');
  const fx = makeFixture();
  fx.launch(jobFor('melodyne'), 'window', host);
  const o = await fx.waitSel('done');
  assert.ok(o.args[1].length < 30000, 'encoded length ' + o.args[1].length);
  assert.strictEqual(o.data.resultJson.message, r.message);
});

test('fit(): shrinks hostLogTail, then messages, then everything; payload of any outlet stays small', async () => {
  const { fit, MAX_ENCODED } = runnerMod;
  const dec = (e) => JSON.parse(decodeURIComponent(e));
  const small = { code: 'busy', message: 'x' };
  assert.strictEqual(fit(small), encodeURIComponent(JSON.stringify(small)), 'small payloads are untouched');
  // a done whose log tail is the problem
  let e = fit({ jobId: 'a', resultJson: { status: 'ok', message: 'm' }, hostLogTail: '\u00e4'.repeat(9000) });
  assert.ok(e.length <= MAX_ENCODED); assert.strictEqual(dec(e).resultJson.message, 'm'); assert.strictEqual(dec(e).truncated, true);
  // a message that is the problem
  e = fit({ code: 'findplugins-failed', message: 'q'.repeat(90000) });
  assert.ok(e.length <= MAX_ENCODED); assert.strictEqual(dec(e).code, 'findplugins-failed'); assert.ok(dec(e).message.length < 400);
  // a result message AND a log that are the problem
  e = fit({ jobId: 'a', resultJson: { status: 'error', message: 'z'.repeat(60000), frames: 5 }, hostLogTail: 'l'.repeat(2000) });
  assert.ok(e.length <= MAX_ENCODED); assert.strictEqual(dec(e).resultJson.status, 'error'); assert.strictEqual(dec(e).resultJson.frames, 5);
  // many keys of moderate size: deep cut
  const o = { state: 'running', jobId: 'j' }; for (let i = 0; i < 400; i++) o['k' + i] = 'v'.repeat(100);
  e = fit(o);
  assert.ok(e.length <= MAX_ENCODED); assert.strictEqual(dec(e).state, 'running');
  // hopeless: a stub with the identifying fields
  const h = { state: 'running', jobId: 'j' }; for (let i = 0; i < 3000; i++) h['key' + i] = i;
  e = fit(h);
  assert.ok(e.length <= MAX_ENCODED); assert.deepStrictEqual(dec(e), { truncated: true, state: 'running', jobId: 'j' });
});

test('plugins outlet is guarded too', async () => {
  const fx = makeFixture();
  fs.mkdirSync(fx.runner.paths.supportDir, { recursive: true });
  const many = shHost('h-find-many.sh', 'printf \'{"melodyne":{"found":true,"path":"/m"},"vocalign":{"found":true,"path":"/v"},"extra":[%s"x"]}\\n\' "$(i=0; while [ $i -lt 4000 ]; do printf \'"item-%s",\' $i; i=$((i+1)); done)"');
  fs.writeFileSync(fx.runner.paths.settingsFile, JSON.stringify({ hostPath: many }));
  fx.send('findplugins');
  const o = await fx.waitSel('plugins', 1, 15000);
  assert.ok(o.args[1].length <= 30000, String(o.args[1].length));
  assert.strictEqual(o.data.melodyne.found, true);
  assert.strictEqual(o.data.vocalign.found, true);
  assert.strictEqual(o.data.truncated, true);
  assert.ok(o.data.extra.length <= 20);
});

// ------------------------------------------------------------------------------------------ copyresult

function copyFixture(extra) {
  const fx = makeFixture(extra);
  const jobId = '20261023-101500-cp01';
  const dir = fx.jobDir(jobId);
  fs.mkdirSync(dir, { recursive: true });
  const bytes = Buffer.alloc(300000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7 + 3) & 0xff;
  fs.writeFileSync(path.join(dir, 'result.wav'), bytes);
  fx.copy = { jobId, from: path.join(dir, 'result.wav'), bytes, resultsDir: fx.runner.paths.resultsDir };
  return fx;
}

test('copyresult: copies result.wav to the results folder (exclusive, fsynced, size verified)', async () => {
  const fx = copyFixture();
  const { jobId, from, bytes, resultsDir } = fx.copy;
  assert.strictEqual(resultsDir, path.join(fx.home, 'Library', 'Application Support', 'ARABridge', 'results'));
  const to = path.join(resultsDir, jobId + '.wav');
  fx.send('copyresult', { jobId, from, to });
  const o = fx.all('copied')[0];
  assert.ok(o, JSON.stringify(fx.out));
  assert.deepStrictEqual(o.data, { ok: true, jobId, to, bytes: 300000 });
  assert.strictEqual(o.args.length, 2);
  assert.ok(fs.readFileSync(to).equals(bytes));
  assert.deepStrictEqual(fs.readdirSync(resultsDir), [jobId + '.wav'], 'no part file left');
  // the realpath of from (the host reports realpaths) is accepted, and from may be omitted
  const to2 = path.join(resultsDir, 'second.WAV');
  fx.send('copyresult', { jobId, from: fs.realpathSync(from), to: to2 });
  assert.ok(fx.all('copied')[1], JSON.stringify(fx.all('error')));
  const to3 = path.join(resultsDir, 'third copy (Melodyne) \u00e4.wav');
  fx.send('copyresult', { jobId, to: to3 });
  assert.ok(fx.all('copied')[2], JSON.stringify(fx.all('error')));
  // an existing target is never overwritten
  fs.writeFileSync(to2, 'precious');
  fx.send('copyresult', { jobId, from, to: to2 });
  assert.strictEqual(fx.all('error').pop().data.code, 'copy-exists');
  assert.strictEqual(fs.readFileSync(to2, 'utf8'), 'precious');
  fx.send('copyresult', { jobId, from, to });
  assert.strictEqual(fx.all('error').pop().data.code, 'copy-exists');
  assert.strictEqual(fx.all('error').pop().data.jobId, jobId);
  assert.ok(fs.readdirSync(resultsDir).every((n) => !/\.part$/.test(n)));
});

test('copyresult: refuses other sources and targets outside results/ or not .wav', async () => {
  const fx = copyFixture();
  const { jobId, from, resultsDir } = fx.copy;
  const outside = path.join(fx.dir, 'outside.wav');
  fs.writeFileSync(path.join(fx.dir, 'secret.wav'), 'secret');
  const other = fx.jobDir('other-job'); fs.mkdirSync(other, { recursive: true }); fs.writeFileSync(path.join(other, 'result.wav'), 'o');
  const bad = [
    { jobId, from, to: outside },
    { jobId, from, to: '/tmp/abridge-copy-test.wav' },
    { jobId, from, to: resultsDir + '/../escape.wav' },
    { jobId, from, to: path.join(resultsDir, 'sub', 'x.wav') },
    { jobId, from, to: path.join(resultsDir, 'x.txt') },
    { jobId, from, to: path.join(resultsDir, 'x.wav.part') },
    { jobId, from, to: path.join(resultsDir, '.wav') },
    { jobId, from, to: resultsDir + '/' },
    { jobId, from, to: 'relative.wav' },
    { jobId, from, to: '' },
    { jobId, from, to: 5 },
    { jobId, from, to: path.join(resultsDir, 'a\0b.wav') },
    { jobId, from: path.join(fx.dir, 'secret.wav'), to: path.join(resultsDir, 'x.wav') },
    { jobId, from: path.join(other, 'result.wav'), to: path.join(resultsDir, 'x.wav') },
    { jobId, from: from + '/../result.json', to: path.join(resultsDir, 'x.wav') },
    { jobId: '../x', to: path.join(resultsDir, 'x.wav') },
    { jobId: 5, to: path.join(resultsDir, 'x.wav') },
    { jobId: 'no-such-job', to: path.join(resultsDir, 'x.wav') },
  ];
  for (const p of bad) {
    const n = fx.all('error').length;
    fx.send('copyresult', p);
    assert.strictEqual(fx.all('error').length, n + 1, 'refused: ' + JSON.stringify(p));
    assert.strictEqual(fx.all('error')[n].data.code, 'copy-failed', JSON.stringify(p) + ' -> ' + JSON.stringify(fx.all('error')[n].data));
  }
  assert.strictEqual(fx.all('copied').length, 0);
  assert.ok(!fs.existsSync(outside));
  assert.ok(!fs.existsSync(path.join(fx.dir, 'escape.wav')));
  assert.ok(!fs.existsSync(resultsDir) || fs.readdirSync(resultsDir).length === 0, 'nothing was written');
  fx.maxApi.handlers.copyresult('%7Bnope');
  fx.maxApi.handlers.copyresult(undefined);
  assert.strictEqual(fx.all('error').slice(-2).every((o) => o.data.code === 'bad-payload'), true);
  // a source that is a symlink is refused
  const linkJob = fx.jobDir('link-job'); fs.mkdirSync(linkJob, { recursive: true });
  fs.symlinkSync(path.join(fx.dir, 'secret.wav'), path.join(linkJob, 'result.wav'));
  fx.send('copyresult', { jobId: 'link-job', to: path.join(resultsDir, 'l.wav') });
  assert.strictEqual(fx.all('error').pop().data.code, 'copy-failed');
  assert.ok(!fs.existsSync(path.join(resultsDir, 'l.wav')));
});

test('copyresult works while another job is busy and does not disturb it', async () => {
  const host = fakeHost('h-busy-copy.js', 'setInterval(() => {}, 1000); process.on("SIGTERM", () => process.exit(6));');
  const fx = copyFixture();
  const { jobId, from, resultsDir } = fx.copy;
  fx.launch(jobFor('melodyne'), 'window', host);
  await fx.ready(await fx.started());
  assert.strictEqual(fx.runner.isBusy(), true);
  fx.send('copyresult', { jobId, from, to: path.join(resultsDir, 'busy.wav') });
  assert.strictEqual(fx.all('copied').length, 1);
  assert.strictEqual(fx.runner.isBusy(), true);
  fx.send('cancel');
  await fx.waitSel('done');
});

test('copyresult: a failing copy leaves no files and reports copy-failed', async () => {
  const failingFs = Object.create(fs);
  failingFs.copyFileSync = () => { throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); };
  const fx = copyFixture({ opts: { fs: failingFs } });
  const { jobId, resultsDir } = fx.copy;
  fx.send('copyresult', { jobId, to: path.join(resultsDir, 'nospace.wav') });
  const e = fx.all('error')[0].data;
  assert.strictEqual(e.code, 'copy-failed');
  assert.ok(/ENOSPC/.test(e.message));
  assert.deepStrictEqual(fs.readdirSync(resultsDir), []);
});

// ------------------------------------------------------------------------------------------ real BridgeHost

function writeWav(file, seconds, sr) {
  const n = Math.floor(seconds * sr);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const env = 0.6 + 0.4 * Math.sin(2 * Math.PI * 1.7 * t);
    const v = env * (0.3 * Math.sin(2 * Math.PI * (200 * t + 30 * t * t)) + 0.2 * Math.sin(2 * Math.PI * (400 * t + 60 * t * t)));
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), 44 + i * 2);
  }
  fs.writeFileSync(file, buf);
}

function realFixture() {
  const settings = path.join(TMP, 'real-settings.json');
  fs.writeFileSync(settings, '{}');
  const fx = makeFixture({ opts: { env: Object.assign({}, process.env, { ARABRIDGE_SETTINGS: settings }) } });
  return fx;
}

test('real BridgeHost: --find-plugins', async () => {
  if (SKIP_REAL) { console.log('   skipped (--skip-real)'); return; }
  assert.ok(fs.existsSync(REAL_HOST), 'BridgeHost built at ' + REAL_HOST);
  const fx = realFixture();
  fs.mkdirSync(fx.runner.paths.supportDir, { recursive: true });
  fs.writeFileSync(fx.runner.paths.settingsFile, JSON.stringify({ hostPath: REAL_HOST }));
  fx.send('findplugins');
  const p = (await fx.waitSel('plugins', 1, 30000)).data;
  assert.ok(p.melodyne && typeof p.melodyne.found === 'boolean', JSON.stringify(p));
  assert.ok(p.vocalign && typeof p.vocalign.found === 'boolean');
  console.log('   find-plugins: melodyne.found=' + p.melodyne.found + ' vocalign.found=' + p.vocalign.found);
});

test('real BridgeHost: headless Melodyne job from core.buildJob -> done with status ok', async () => {
  if (SKIP_REAL) { console.log('   skipped (--skip-real)'); return; }
  const fx = realFixture();
  const wav = path.join(TMP, 'real-source.wav');
  writeWav(wav, 4, 44100);
  const built = core.buildJob({ id: '20261023-101500-re01', plugin: 'melodyne', placement: 'takeLane', realign: true, tempo: 120, trackIndex: 0,
    clips: [{ role: 'source', path: wav, startSec: 0.5, endSec: 2.5, startBeats: 1, name: 'Test vox' }] });
  assert.ok(built.ok, built.reason);
  const t0 = Date.now();
  fx.launch(built.job, 'headless', REAL_HOST);
  const st = await fx.started();
  const d = (await fx.waitSel('done', 1, 300000)).data;
  console.log('   headless Melodyne took ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s, exit ' + d.exitCode + ', running ' + d.running);
  assert.ok(d.resultJson, 'result.json parsed; log tail: ' + d.hostLogTail);
  assert.strictEqual(d.resultJson.status, 'ok', JSON.stringify(d.resultJson).slice(0, 600));
  assert.strictEqual(d.resultJson.frames, 88200);
  assert.strictEqual(d.resultJson.sampleRate, 44100);
  assert.strictEqual(fs.realpathSync(d.resultJson.resultPath), fs.realpathSync(path.join(st.jobDir, 'result.wav')));
  assert.ok(fs.statSync(d.resultJson.resultPath).size > 88200 * 4);
  await waitFor(() => !fx.runner.isBusy(), 10000, 'host exit');
  await sleep(300);
  assert.strictEqual(fx.all('done').length, 1);
  assert.deepStrictEqual(readJson(path.join(st.jobDir, 'job.json')), built.job);
  assert.ok(!alive(st.pid), 'host exited');
  assert.ok(fs.existsSync(path.join(st.jobDir, 'host.log')));
});

test('real BridgeHost: a bad job (relative clip path) ends with an error result.json, exit 2', async () => {
  if (SKIP_REAL) { console.log('   skipped (--skip-real)'); return; }
  const fx = realFixture();
  const job = { version: 1, id: '20261023-101500-re02', plugin: 'melodyne', clips: [{ role: 'source', path: 'relative.wav', startSec: 0, endSec: 1 }] };
  fx.launch(job, 'headless', REAL_HOST);
  const d = (await fx.waitSel('done', 1, 60000)).data;
  assert.ok(d.resultJson, 'host publishes an error result');
  assert.strictEqual(d.resultJson.status, 'error');
  assert.ok(typeof d.resultJson.message === 'string' && d.resultJson.message.length > 0);
});

// ------------------------------------------------------------------------------------------ run

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    const t0 = Date.now();
    try { await fn(); console.log('ok   ' + name + '  (' + (Date.now() - t0) + ' ms)'); } catch (e) { failed++; console.log('FAIL ' + name + ': ' + (e && e.stack || e)); }
  }
  // no stray fake hosts
  spawnedPids.forEach((pid) => { try { process.kill(pid, 'SIGKILL'); } catch (e) { /* gone */ } });
  console.log('temp dir ' + TMP);
  console.log(failed ? failed + ' of ' + tests.length + ' failed' : 'all ' + tests.length + ' passed');
  process.exit(failed ? 1 : 0);
})();
