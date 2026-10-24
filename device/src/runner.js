// ARA Bridge device - Node for Max side. Creates job folders, launches and supervises BridgeHost, reports back.
//
// Runs inside Max's node.script (Node 22, CommonJS): `const maxApi = require('max-api')`. The logic lives in
// createRunner({...}) so tests can run it under plain node with a stub; the module starts itself at load time only
// when `max-api` can be required (and ARABRIDGE_RUNNER_NO_AUTOSTART is not '1').
//
// Messages in (handlers, each argument one Max symbol; payloads are encodeURIComponent(JSON.stringify(obj))):
//   launch <payload>   payload = {job, mode: 'window'|'headless', hostPath?}   job = the job.json object (core.buildJob)
//   cancel             SIGTERM ladder: SIGTERM, +3 s SIGTERM, +3 s SIGKILL
//   status             reply with the current state
//   findplugins        runs `<host> --find-plugins` and relays its JSON
//   copyresult <p>     copy a finished result.wav to the results folder (classic js cannot copy binary files)
//   ping               replies `pong`
// Messages out (maxApi.outlet(selector, payload): the selector is the first atom, the payload ONE symbol):
//   started <p>  {jobId, jobDir, pid, mode, hostPath, startedAt}
//   done <p>     {jobDir, jobId, resultJson (object|null), resultParseError?, exitCode, signal, running, hostLogTail,
//                 startedAt, finishedAt, spawnError?}      exactly once per job
//   plugins <p>  the parsed output of --find-plugins
//   status <p>   {state: 'idle'|'running'|'cancelling'|'backstop', step?, jobId?, jobDir?, pid?, mode?, startedAt?,
//                 resultReported?, last?}
//   error <p>    {code, message, jobId?}   codes: busy, no-host, job-exists, bad-payload, bad-job, io-error,
//                spawn-failed, findplugins-failed, copy-failed, copy-exists, internal
//   copied <p>   {ok: true, jobId, to, bytes}              (answer to copyresult)
//   pong
//   Every payload is kept below ~30000 encoded characters (Max symbols are limited to 32767 bytes); see fit().
//   `done`.resultJson is slimmed: no `diagnostics`, `realign.shifts` replaced by `realign.shiftCount`.
//   copyresult <p>  {jobId, from?, to}  copies <jobs>/<jobId>/result.wav to <ARABridge>/results/<name>.wav (never
//                   overwrites; `from` is derived from jobId, a given `from` must match); error codes copy-failed,
//                   copy-exists.
//
// Files: ~/Library/Application Support/ARABridge/{settings.json, bin/BridgeHost, jobs/<id>/{job.json, host.log, ...}}.
// Nothing here throws into Max: every handler is wrapped, every outlet/post promise rejection is swallowed.
'use strict';

const nodeFs = require('fs');
const nodePath = require('path');
const nodeOs = require('os');
const nodeCp = require('child_process');

const JOB_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
const LOG_TAIL_BYTES = 2000;
const MAX_ENCODED = 30000;   // Max symbols are limited to 32767 bytes; stay clear of it

const DEFAULT_DELAYS = {
  pollMs: 250,                 // result.json poll
  parseRetryMs: 1000,          // how long an unparsable result.json is retried before giving up on it
  exitGraceMs: 500,            // wait for a late result.json after the process exited without one
  sigtermRepeatMs: 3000,       // cancel ladder: first SIGTERM -> second SIGTERM
  sigkillMs: 3000,             // cancel ladder: second SIGTERM -> SIGKILL
  releaseAfterResultMs: 20000, // result reported but the host still alive: stop supervising after this
  findPluginsTimeoutMs: 30000,
  backstopMs: null,            // headless backstop override (ms); null = contract formula
};

function errStr(e) { return e && e.message ? String(e.message) : String(e); }

function encode(obj) { return encodeURIComponent(JSON.stringify(obj)); }

function decode(arg) {
  if (typeof arg !== 'string' || arg === '') throw new Error('payload is missing');
  return JSON.parse(decodeURIComponent(arg));
}

function isObj(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }

// result.json as sent to Max: no diagnostics (logs only), realign.shifts reduced to a count. Everything core.js
// reads (status, message, resultPath, frames, sampleRate, sourceStartFrame, realign.applied/reason) is kept.
function slimResult(r) {
  if (!isObj(r)) return r;
  const o = Object.assign({}, r);
  delete o.diagnostics;
  if (isObj(o.realign)) {
    const rl = Object.assign({}, o.realign);
    if (Array.isArray(rl.shifts)) rl.shiftCount = rl.shifts.length;
    delete rl.shifts;
    o.realign = rl;
  }
  return o;
}

function cutStr(s, n) { return typeof s === 'string' && s.length > n ? s.slice(0, n) + '...' : s; }

function deepCut(v, n) {
  if (typeof v === 'string') return cutStr(v, n);
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => deepCut(x, n));
  if (isObj(v)) { const o = {}; Object.keys(v).forEach((k) => { o[k] = deepCut(v[k], n); }); return o; }
  return v;
}

// Encodes obj for one Max symbol, shrinking it until the encoded length is <= max: first the host.log tail,
// then message texts, then every long string and array, finally a minimal stub.
function fit(obj, max) {
  max = max || MAX_ENCODED;
  let enc = encode(obj);
  if (enc.length <= max) return enc;
  const o = JSON.parse(JSON.stringify(obj));
  const mark = () => { o.truncated = true; enc = encode(o); return enc.length <= max; };
  if (typeof o.hostLogTail === 'string') { o.hostLogTail = o.hostLogTail.slice(-500); if (mark()) return enc; o.hostLogTail = ''; if (mark()) return enc; }
  if (typeof o.message === 'string') o.message = cutStr(o.message, 300);
  if (isObj(o.resultJson) && typeof o.resultJson.message === 'string') o.resultJson.message = cutStr(o.resultJson.message, 300);
  if (mark()) return enc;
  const d = deepCut(o, 300);
  d.truncated = true;
  enc = encode(d);
  if (enc.length <= max) return enc;
  const stub = { truncated: true };
  ['code', 'jobId', 'jobDir', 'state', 'step'].forEach((k) => { if (typeof o[k] === 'string') stub[k] = cutStr(o[k], 300); });
  return encode(stub);
}

// Headless budget of the host contract: T = 300 s + 4 s x (sum of clip lengths); grace = min(15, max(1, T/4));
// the device backstop is T + grace + 40 s, then SIGKILL.
function headlessBudget(job) {
  let total = 0;
  const clips = job && Array.isArray(job.clips) ? job.clips : [];
  for (const c of clips) {
    if (c && typeof c.startSec === 'number' && typeof c.endSec === 'number' && c.endSec > c.startSec) total += c.endSec - c.startSec;
  }
  const T = 300 + 4 * total;
  const grace = Math.min(15, Math.max(1, T / 4));
  return { totalSec: total, T, grace, backstopMs: Math.round((T + grace + 40) * 1000) };
}

function createRunner(opts) {
  opts = opts || {};
  const maxApi = opts.maxApi;
  const fs = opts.fs || nodeFs;
  const spawn = opts.spawn || nodeCp.spawn;
  const env = opts.env || process.env;
  const now = opts.now || (() => Date.now());
  const home = opts.home || nodeOs.homedir();
  const kill = opts.kill || ((pid, sig) => process.kill(pid, sig));
  const delays = Object.assign({}, DEFAULT_DELAYS, opts.delays || {});

  const supportDir = nodePath.join(home, 'Library', 'Application Support', 'ARABridge');
  const jobsDir = nodePath.join(supportDir, 'jobs');
  const settingsFile = nodePath.join(supportDir, 'settings.json');
  const installedHost = nodePath.join(supportDir, 'bin', 'BridgeHost');

  const timers = new Set();   // every timer/interval of the runner (dispose clears them)
  // Busy rule: busy = a launched job whose result has not been reported yet. Once `done` was sent the job is DONE
  // (`job` becomes null, a new launch is accepted at once); its host may still be winding down and stays in
  // `supervised` (silently: its exit sends nothing) until it exits or releaseAfterResultMs have passed.
  let job = null;             // the current job (result not reported yet)
  let last = null;            // the most recent job that finished or was released (pid stays on record)
  let jobSeq = 0;
  const supervised = new Set();   // every job whose process the runner still watches (dispose detaches them all)

  // ------------------------------------------------------------------ outlet / post

  function swallow(p) { if (p && typeof p.catch === 'function') p.catch(() => {}); }
  function iso() { return new Date(now()).toISOString(); }

  function log(msg) {
    try { swallow(maxApi.post('ARABridge runner: ' + msg)); } catch (e) { /* ignore */ }
  }

  function send(selector, obj) {
    try {
      swallow(obj === undefined ? maxApi.outlet(selector) : maxApi.outlet(selector, fit(obj)));
    } catch (e) { log('outlet ' + selector + ' failed: ' + errStr(e)); }
  }

  function sendError(code, message, extra) {
    log('error ' + code + ': ' + message);
    send('error', Object.assign({ code, message }, extra || {}));
  }

  function timeout(fn, ms) {
    const t = setTimeout(() => { timers.delete(t); try { fn(); } catch (e) { log('timer failed: ' + errStr(e)); } }, ms);
    timers.add(t);
    return t;
  }
  function clearT(t) { if (t) { clearTimeout(t); timers.delete(t); } }

  // ------------------------------------------------------------------ host binary

  function isExecutableFile(p) {
    try {
      if (!fs.statSync(p).isFile()) return false;
      fs.accessSync(p, fs.constants.X_OK);
      return true;
    } catch (e) { return false; }
  }

  function expandHome(p) { return p.startsWith('~/') ? nodePath.join(home, p.slice(2)) : p; }

  // Order: payload override (tests), settings.json hostPath (if executable), installed copy.
  function resolveHost(override) {
    if (override !== undefined && override !== null) {
      if (typeof override === 'string' && override !== '' && isExecutableFile(override)) return override;
      return null;
    }
    try {
      const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      if (isObj(s) && typeof s.hostPath === 'string' && s.hostPath !== '') {
        const p = expandHome(s.hostPath);
        if (isExecutableFile(p)) return p;
        log('settings.json hostPath is not an executable file, ignored: ' + p);
      }
    } catch (e) { /* no settings file, or unreadable: fall through */ }
    return isExecutableFile(installedHost) ? installedHost : null;
  }

  function noHost(override) {
    const what = override ? 'The BridgeHost binary "' + override + '" is not an executable file.'
      : 'BridgeHost is not installed (looked for ' + installedHost + ' and a hostPath in ' + settingsFile + ').';
    return { code: 'no-host', message: what + ' Run tools/install_host.sh from the ARA Bridge repository, then try again.' };
  }

  // ------------------------------------------------------------------ host.log tail

  function readLogTail(file) {
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const size = fs.fstatSync(fd).size;
        const len = Math.min(size, LOG_TAIL_BYTES);
        const buf = Buffer.alloc(len);
        let off = 0;
        while (off < len) {
          const n = fs.readSync(fd, buf, off, len - off, size - len + off);
          if (n <= 0) break;
          off += n;
        }
        let from = 0;
        if (size > len) while (from < off && (buf[from] & 0xC0) === 0x80) from++;   // start at a UTF-8 character boundary
        return buf.subarray(from, off).toString('utf8');
      } finally { fs.closeSync(fd); }
    } catch (e) { return ''; }
  }

  // ------------------------------------------------------------------ job supervision

  function describe(j) {
    return { jobId: j.jobId, jobDir: j.jobDir, pid: j.pid, mode: j.mode, startedAt: j.startedAt,
      resultReported: j.reported, alive: !j.exited };
  }

  function killPid(j, sig) {
    try { kill(j.pid, sig); return true; } catch (e) { log('kill ' + sig + ' ' + j.pid + ': ' + errStr(e)); return false; }
  }

  // The final SIGKILL of the cancel ladder goes to the whole process group (the host is its own group leader), so
  // helpers it started die with it; it falls back to the pid alone.
  function killGroup(j) {
    try { kill(-j.pid, 'SIGKILL'); return true; } catch (e) { log('kill group ' + j.pid + ': ' + errStr(e)); }
    return killPid(j, 'SIGKILL');
  }

  // `last` is the newest job that finished or was released; an older job winding down later does not replace it.
  function setLast(j) { if (!last || j.seq >= last.seq) last = j; }

  function clearLadder(j) { clearT(j.ladder1); clearT(j.ladder2); j.ladder1 = j.ladder2 = null; }

  function release(j, why) {
    if (j.released) return;
    j.released = true;
    clearT(j.poll); clearT(j.parseWindow); clearT(j.graceTimer); clearT(j.releaseTimer);
    if (j.pollIv) { clearInterval(j.pollIv); timers.delete(j.pollIv); j.pollIv = null; }
    if (!j.exited) { try { j.child.unref(); } catch (e) { /* ignore */ } }
    log('job ' + j.jobId + ' released (' + why + '), pid ' + j.pid + (j.exited ? ' exited' : ' still running'));
    supervised.delete(j);
    if (job === j) job = null;
    setLast(j);
  }

  function report(j, resultJson, parseError) {
    if (j.reported) return;
    j.reported = true;
    if (j.pollIv) { clearInterval(j.pollIv); timers.delete(j.pollIv); j.pollIv = null; }
    clearT(j.parseWindow); clearT(j.graceTimer);
    const done = {
      jobDir: j.jobDir,
      jobId: j.jobId,
      resultJson: resultJson === undefined ? null : slimResult(resultJson),
      exitCode: j.exitCode,
      signal: j.signal,
      running: !j.exited,
      hostLogTail: readLogTail(nodePath.join(j.jobDir, 'host.log')),
      startedAt: j.startedAt,
      finishedAt: iso(),
    };
    if (parseError) done.resultParseError = parseError;
    if (j.spawnError) done.spawnError = j.spawnError;
    log('job ' + j.jobId + ' done: result=' + (done.resultJson ? done.resultJson.status : 'none') +
      ' running=' + done.running + ' exit=' + done.exitCode + ' signal=' + done.signal);
    send('done', done);
    if (job === j) job = null;      // done: the runner is free again, whatever the old process does from here
    setLast(j);
    if (j.exited) release(j, 'result reported, process exited');
    else j.releaseTimer = timeout(() => release(j, 'result reported, host still running after ' + delays.releaseAfterResultMs + ' ms'),
      delays.releaseAfterResultMs);
  }

  // One look at the job folder; called by the poll, by the exit grace timer and by the parse window timer.
  function check(j) {
    if (j.reported) return;
    const file = nodePath.join(j.jobDir, 'result.json');
    let text = null;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { text = null; }
    if (text !== null) {
      let value;
      let err = null;
      try { value = JSON.parse(text); if (!isObj(value)) err = 'result.json is not a JSON object'; } catch (e) { err = errStr(e); }
      if (!err) { report(j, value); return; }
      // Exists but does not parse: a write may be in progress. Retry until the window ends.
      if (j.parseOver) { report(j, null, err); return; }
      if (!j.parseWindow) j.parseWindow = timeout(() => { j.parseOver = true; j.parseWindow = null; check(j); }, delays.parseRetryMs);
      return;
    }
    if (j.exited && j.graceOver) report(j, null);
  }

  function onExit(j, code, signal) {
    if (j.exited) return;
    j.exited = true;
    j.exitCode = code === undefined ? null : code;
    j.signal = signal === undefined ? null : signal;
    clearLadder(j);
    clearT(j.backstop); j.backstop = null;
    log('job ' + j.jobId + ' host exited: code=' + j.exitCode + ' signal=' + j.signal);
    if (j.reported) { release(j, 'process exited'); return; }
    // Wait for a late result.json, then report whatever there is.
    j.graceTimer = timeout(() => { j.graceOver = true; j.graceTimer = null; check(j); }, delays.exitGraceMs);
  }

  function startSupervision(j) {
    j.onExitL = (code, signal) => { try { onExit(j, code, signal); } catch (e) { log('exit handler: ' + errStr(e)); } };
    j.onErrorL = (e) => {
      try {
        if (j.pid === undefined || j.pid === null) {       // spawn itself failed: no process, no 'exit' event
          // Reported through the one `done` message (spawnError set, no exit code), not as a second terminal message.
          j.spawnError = errStr(e);
          log('spawn failed: ' + j.spawnError);
          onExit(j, null, null);
        } else log('child error: ' + errStr(e));
      } catch (e2) { log('error handler: ' + errStr(e2)); }
    };
    j.child.on('exit', j.onExitL);
    j.child.on('error', j.onErrorL);
    j.pollIv = setInterval(() => { try { check(j); } catch (e) { log('poll failed: ' + errStr(e)); } }, delays.pollMs);
    timers.add(j.pollIv);
    if (j.mode === 'headless') {
      const ms = typeof delays.backstopMs === 'number' ? delays.backstopMs : headlessBudget(j.jobObj).backstopMs;
      j.backstop = timeout(() => {
        j.backstop = null;
        if (j.exited) return;
        log('headless backstop reached after ' + ms + ' ms: SIGKILL');
        send('status', Object.assign({ state: 'backstop', step: 'sigkill' }, describe(j)));
        killPid(j, 'SIGKILL');
      }, ms);
    }
  }

  // ------------------------------------------------------------------ handlers

  function onLaunch(arg) {
    let p;
    try { p = decode(arg); } catch (e) { sendError('bad-payload', 'launch: cannot read the payload: ' + errStr(e)); return; }
    if (!isObj(p) || !isObj(p.job)) { sendError('bad-payload', 'launch: the payload needs a job object'); return; }
    const mode = p.mode === undefined || p.mode === null ? 'window' : p.mode;
    if (mode !== 'window' && mode !== 'headless') { sendError('bad-payload', 'launch: mode must be "window" or "headless"'); return; }
    const jobObj = p.job;
    const jobId = jobObj.id;
    if (typeof jobId !== 'string' || !JOB_ID_RE.test(jobId)) {
      sendError('bad-job', 'launch: the job id must be 1-100 characters of letters, digits, "_", "-" or "." (no leading dot)');
      return;
    }
    if (job) {
      sendError('busy', 'A job is already running (' + job.jobId + '). Finish or cancel it first.', { jobId });
      return;
    }
    const override = p.hostPath === undefined || p.hostPath === null ? null : p.hostPath;
    const host = resolveHost(override);
    if (!host) { const n = noHost(override); sendError(n.code, n.message, { jobId }); return; }

    const jobDir = nodePath.join(jobsDir, jobId);
    try {
      fs.mkdirSync(jobsDir, { recursive: true });
    } catch (e) { sendError('io-error', 'Cannot create the jobs folder ' + jobsDir + ': ' + errStr(e), { jobId }); return; }
    try {
      fs.mkdirSync(jobDir);                       // not recursive: fails when the folder exists
    } catch (e) {
      if (e && e.code === 'EEXIST') sendError('job-exists', 'The job folder already exists: ' + jobDir, { jobId });
      else sendError('io-error', 'Cannot create the job folder ' + jobDir + ': ' + errStr(e), { jobId });
      return;
    }
    try {
      const tmp = nodePath.join(jobDir, 'job.json.tmp');
      fs.writeFileSync(tmp, JSON.stringify(jobObj, null, 2));
      fs.renameSync(tmp, nodePath.join(jobDir, 'job.json'));
    } catch (e) { sendError('io-error', 'Cannot write job.json: ' + errStr(e), { jobId }); return; }

    const args = ['--job', jobDir];
    if (mode === 'headless') args.push('--autorender');
    let child;
    let logFd = null;
    try {
      logFd = fs.openSync(nodePath.join(jobDir, 'host.log'), 'a');
      child = spawn(host, args, { detached: true, stdio: ['ignore', logFd, logFd], env });
    } catch (e) {
      sendError('spawn-failed', 'BridgeHost could not be started: ' + errStr(e), { jobId });
      return;
    } finally {
      if (logFd !== null) { try { fs.closeSync(logFd); } catch (e) { /* ignore */ } }
    }

    const j = {
      seq: ++jobSeq, jobId, jobDir, jobObj, mode, hostPath: host, child, pid: child.pid, startedAt: iso(),
      exited: false, exitCode: null, signal: null, reported: false, released: false,
      graceOver: false, parseOver: false, cancelling: false,
    };
    job = j;
    supervised.add(j);
    log('launched ' + host + ' ' + args.join(' ') + ' pid ' + j.pid);
    startSupervision(j);
    send('started', { jobId, jobDir, pid: j.pid === undefined ? null : j.pid, mode, hostPath: host, startedAt: j.startedAt });
  }

  function onCancel() {
    const j = job;
    if (!j || j.exited) { send('status', { state: 'idle' }); return; }
    if (j.cancelling) { send('status', Object.assign({ state: 'cancelling', step: j.cancelStep }, describe(j))); return; }
    j.cancelling = true;
    const step = (name, sig) => {
      j.cancelStep = name;
      log('cancel ' + j.jobId + ': ' + name);
      send('status', Object.assign({ state: 'cancelling', step: name }, describe(j)));
      if (sig === 'SIGKILL') killGroup(j); else killPid(j, sig);
    };
    step('sigterm', 'SIGTERM');
    j.ladder1 = timeout(() => {
      j.ladder1 = null;
      if (j.exited) return;
      step('sigterm2', 'SIGTERM');
      j.ladder2 = timeout(() => {
        j.ladder2 = null;
        if (j.exited) return;
        step('sigkill', 'SIGKILL');
      }, delays.sigkillMs);
    }, delays.sigtermRepeatMs);
  }

  function onStatus() {
    const o = job ? Object.assign({ state: job.cancelling ? 'cancelling' : 'running' }, describe(job)) : { state: 'idle' };
    if (job && job.cancelling) o.step = job.cancelStep;
    if (last) o.last = describe(last);
    send('status', o);
  }

  function onFindPlugins() {
    const host = resolveHost(null);
    if (!host) { const n = noHost(null); sendError(n.code, n.message); return; }
    let out = '';
    let errOut = '';
    let finished = false;
    let child;
    let killer = null;
    const finish = (fn) => { if (finished) return; finished = true; clearT(killer); fn(); };
    try {
      child = spawn(host, ['--find-plugins'], { stdio: ['ignore', 'pipe', 'pipe'], env });
    } catch (e) { sendError('spawn-failed', 'BridgeHost could not be started: ' + errStr(e)); return; }
    child.stdout.on('data', (c) => { if (out.length < 65536) out += c.toString('utf8'); });
    child.stderr.on('data', (c) => { if (errOut.length < 8192) errOut += c.toString('utf8'); });
    child.on('error', (e) => finish(() => sendError('spawn-failed', 'BridgeHost could not be started: ' + errStr(e))));
    child.on('close', (code, signal) => finish(() => {
      if (code !== 0) {
        sendError('findplugins-failed', 'BridgeHost --find-plugins ' + (signal ? 'was stopped by ' + signal : 'exited with code ' + code) +
          (errOut.trim() ? ': ' + errOut.trim().split('\n').pop() : ''));
        return;
      }
      let parsed;
      try { parsed = JSON.parse(out.trim().split('\n').pop()); } catch (e) { parsed = null; }
      if (!isObj(parsed)) { sendError('findplugins-failed', 'BridgeHost --find-plugins printed no JSON object'); return; }
      send('plugins', parsed);
    }));
    killer = timeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* ignore */ } }, delays.findPluginsTimeoutMs);
  }

  function onPing() { send('pong'); }

  const resultsDir = nodePath.join(supportDir, 'results');
  let copySeq = 0;

  function onCopyResult(arg) {
    let p;
    try { p = decode(arg); } catch (e) { sendError('bad-payload', 'copyresult: cannot read the payload: ' + errStr(e)); return; }
    if (!isObj(p)) { sendError('bad-payload', 'copyresult: the payload must be an object'); return; }
    const jobId = p.jobId;
    if (typeof jobId !== 'string' || !JOB_ID_RE.test(jobId)) { sendError('copy-failed', 'copyresult: invalid job id'); return; }
    const fail = (message, code) => sendError(code || 'copy-failed', message, { jobId });
    const from = nodePath.join(jobsDir, jobId, 'result.wav');
    if (p.from !== undefined && p.from !== null) {
      let ok = typeof p.from === 'string' && p.from === from;
      if (!ok && typeof p.from === 'string' && nodePath.isAbsolute(p.from)) {   // the host reports realpaths (/private/var/...)
        try { ok = fs.realpathSync(p.from) === fs.realpathSync(from); } catch (e) { ok = false; }
      }
      if (!ok) { fail('copyresult: "from" is not the result.wav of job ' + jobId); return; }
    }
    const to = p.to;
    if (typeof to !== 'string' || to === '' || to.indexOf('\0') >= 0 || !nodePath.isAbsolute(to) ||
        nodePath.dirname(nodePath.resolve(to)) !== resultsDir || nodePath.resolve(to) !== to ||
        !/\.wav$/i.test(to) || nodePath.basename(to).length <= 4) {
      fail('copyresult: the target must be <name>.wav directly inside ' + resultsDir);
      return;
    }
    let part = null;
    try {
      const st = fs.lstatSync(from);
      if (!st.isFile()) { fail('copyresult: ' + from + ' is not a regular file'); return; }
      fs.mkdirSync(resultsDir, { recursive: true });
      if (fs.existsSync(to)) { fail('The result file already exists: ' + to, 'copy-exists'); return; }
      // Copy to a private part file, fsync and verify, then publish with link() (fails if `to` exists, never overwrites).
      part = to + '.' + process.pid + '-' + (++copySeq) + '.part';
      fs.copyFileSync(from, part, fs.constants.COPYFILE_EXCL);
      const fd = fs.openSync(part, 'r+');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      const bytes = fs.statSync(part).size;
      if (bytes !== st.size) throw new Error('size mismatch after copy: ' + bytes + ' of ' + st.size + ' bytes');
      try {
        fs.linkSync(part, to);
      } catch (e) {
        if (e && e.code === 'EEXIST') { fail('The result file already exists: ' + to, 'copy-exists'); return; }
        throw e;
      }
      log('copied ' + from + ' -> ' + to + ' (' + bytes + ' bytes)');
      send('copied', { ok: true, jobId, to, bytes });
    } catch (e) {
      fail('Cannot copy the result: ' + errStr(e));
    } finally {
      if (part) { try { fs.unlinkSync(part); } catch (e) { /* not there */ } }
    }
  }

  const handlers = { launch: onLaunch, cancel: onCancel, status: onStatus, findplugins: onFindPlugins, ping: onPing,
    copyresult: onCopyResult };

  // Every handler is wrapped: nothing may throw into Max, and a returned promise is caught as well.
  function wrap(name, fn) {
    return function () {
      try {
        const r = fn.apply(null, arguments);
        if (r && typeof r.catch === 'function') r.catch((e) => sendError('internal', name + ': ' + errStr(e)));
      } catch (e) {
        try { sendError('internal', name + ': ' + errStr(e)); } catch (e2) { /* ignore */ }
      }
    };
  }

  const wrapped = {};
  Object.keys(handlers).forEach((n) => { wrapped[n] = wrap(n, handlers[n]); });

  function register() { Object.keys(wrapped).forEach((n) => maxApi.addHandler(n, wrapped[n])); }

  // Stops the runner's own timers and watchers. Running hosts are NOT touched (they are detached and keep going).
  function dispose() {
    timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
    timers.clear();
    supervised.forEach((j) => {
      try {
        if (j.onExitL) j.child.removeListener('exit', j.onExitL);
        if (j.onErrorL) { j.child.removeListener('error', j.onErrorL); j.child.on('error', () => {}); }   // never an unhandled 'error'
        if (!j.exited) j.child.unref();
      } catch (e) { /* ignore */ }
    });
    supervised.clear();
  }

  return {
    handlers: wrapped, register, dispose,
    resolveHost, headlessBudget,
    paths: { supportDir, jobsDir, settingsFile, installedHost, resultsDir },
    isBusy: () => job !== null,
  };
}

// ---------------------------------------------------------------------------------------------- Max start

function start(maxApi) {
  process.on('uncaughtException', (e) => { try { maxApi.post('ARABridge runner: uncaughtException: ' + (e && e.stack || e)); } catch (e2) { /* ignore */ } });
  process.on('unhandledRejection', (e) => { try { maxApi.post('ARABridge runner: unhandledRejection: ' + (e && e.stack || e)); } catch (e2) { /* ignore */ } });
  const runner = createRunner({ maxApi });
  runner.register();
  try { maxApi.post('ARABridge runner started (node ' + process.version + ', pid ' + process.pid + ')'); } catch (e) { /* ignore */ }
  return runner;
}

module.exports = { createRunner, headlessBudget, slimResult, fit, start, JOB_ID_RE, DEFAULT_DELAYS, MAX_ENCODED };

let maxApiAtLoad = null;
try { maxApiAtLoad = require('max-api'); } catch (e) { maxApiAtLoad = null; }
if (maxApiAtLoad && process.env.ARABRIDGE_RUNNER_NO_AUTOSTART !== '1') start(maxApiAtLoad);
