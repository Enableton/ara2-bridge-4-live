#!/usr/bin/env node
// Checks of device/ui/ara2bridge_ui.html (the jweb interface) without Max or Live:  node device/tests/test_ui.js
//
// Static checks always run (no remote assets, one self-contained file, the Max message names the patch routes).
// The behavioural checks run the page in headless Chrome with a fake window.max (skipped, with a note, when Chrome
// is not installed): every control sends exactly ONE message of its own, a value coming from Max changes the page
// and is NEVER sent back, the page asks for a refresh exactly once after its handlers are bound.
'use strict';
const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PAGE = path.join(__dirname, '..', 'ui', 'ara2bridge_ui.html');
const SRC = fs.readFileSync(PAGE, 'utf8');
const results = [];
function test(name, fn) {
  try { fn(); results.push([true, name]); console.log('ok   ' + name); } catch (e) { results.push([false, name]); console.log('FAIL ' + name + '\n' + (e && e.stack || e)); }
}

test('page: self-contained, no remote URL (the SVG namespace is not a request), no external script/stylesheet/font', () => {
  const urls = (SRC.match(/https?:\/\/[^\s"'<>)]+/g) || []).filter((u) => u.indexOf('http://www.w3.org/2000/svg') !== 0);
  assert.deepStrictEqual(urls, []);
  assert.ok(!/<script[^>]+src=/i.test(SRC) && !/<link[^>]+href=/i.test(SRC) && !/@import|@font-face|url\(/.test(SRC));
  assert.ok(!/color-mix\(/.test(SRC), 'color-mix() may not exist in Live\'s jweb Chromium');
});

test('page: talks to Max with exactly the names the patch routes (make_amxd.py)', () => {
  const make = fs.readFileSync(path.join(__dirname, '..', 'make_amxd.py'), 'utf8');
  const actions = JSON.parse(make.match(/^ACTIONS = (\[.*\])$/m)[1].replace(/'/g, '"'));
  const pageActions = Array.from(SRC.matchAll(/data-action="(\w+)"/g)).map((m) => m[1]).concat(['refreshPlugins']);
  assert.deepStrictEqual(pageActions.slice().sort(), actions.slice().sort());
  ['ui_action', 'ui_set', 'ui_loaded', 'ui_state', 'ui_status'].forEach((n) => assert.ok(SRC.indexOf('"' + n + '"') >= 0, n));
});

function findChrome() {
  const c = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
  return c.find((p) => fs.existsSync(p)) || null;
}

// runs inside the page after its own script
const DRIVER = `
<script>
(function () {
  var R = { errors: [] };
  window.onerror = function (m) { R.errors.push(String(m)); };
  var log = window.__log;
  function take() { var l = log.slice(); log.length = 0; return l; }
  function click(el) { el.click(); }
  function $(s) { return document.querySelector(s); }
  R.afterLoad = take();
  R.handlers = Object.keys(window.__handlers).sort();

  // each button: one message of its own
  R.actions = {};
  ["sendMelodyne", "setGuide", "sendVocAlign", "cancel", "installHost"].forEach(function (a) { click($('[data-action="' + a + '"]')); R.actions[a] = take(); });
  click($("#refresh")); R.actions.refreshPlugins = take();

  // switches: toggle on, then off
  R.switches = {};
  ["skip", "preview", "sync"].forEach(function (k) {
    var b = $('.sw[data-key="' + k + '"]'); var before = b.getAttribute("aria-checked");
    click(b); var one = take(); click(b); var two = take();
    R.switches[k] = { before: before, one: one, two: two };
  });

  // placement: open the list, choose each item
  R.placement = [];
  [0, 1, 2].forEach(function (i) {
    click($("#ddTrigger")); click($('.dd-item[data-i="' + i + '"]'));
    R.placement.push({ sent: take(), label: $("#ddLabel").textContent, open: $("#dd").classList.contains("open") });
  });

  // inbound from Max: the page changes, nothing goes back out
  var H = window.__handlers;
  R.install = {};
  ["none", "missing", "update", "ok"].forEach(function (st) {
    H.ui_state("hostinstall", st);
    R.install[st] = { text: $("#installHost").textContent, shown: getComputedStyle($("#installHost")).display !== "none", sent: take() };
  });
  $("#aboutBtn").click(); R.aboutOpen = getComputedStyle($("#about")).display !== "none"; R.aboutVer = $("#aboutVer").textContent;
  $("#about").click(); R.aboutClosed = getComputedStyle($("#about")).display === "none";
  H.ui_state("setting", "placement", 1); H.ui_state("setting", "skip", 1); H.ui_state("setting", "preview", 0); H.ui_state("setting", "sync", 1);
  H.ui_state("busy", 1); H.ui_state("cancel", 1); H.ui_state("guide", 1); H.ui_state("host", 1); H.ui_state("plugins", 1, 0);
  H.ui_status("Placing the result...");
  R.inbound = {
    sent: take(), label: $("#ddLabel").textContent,
    sw: ["skip", "preview", "sync"].map(function (k) { return $('.sw[data-key="' + k + '"]').getAttribute("aria-checked"); }),
    busy: $("#device").classList.contains("busy"), cancelable: $("#device").classList.contains("cancelable"),
    guide: $("#guideState").textContent, guideDone: $("#stepGuide").classList.contains("done"),
    chips: [$("#chipMel").textContent, $("#chipVoc").textContent], status: $("#status").textContent
  };
  H.ui_state("busy", 0); H.ui_state("cancel", 0); H.ui_state("guide", 0); H.ui_state("host", 0);
  R.after = { sent: take(), busy: $("#device").classList.contains("busy"), cancelable: $("#device").classList.contains("cancelable"),
    chips: [$("#chipMel").textContent, $("#chipVoc").textContent], guide: $("#guideState").textContent };
  H.ui_status("a", "b");   // a status split into several atoms is re-joined
  R.joined = $("#status").textContent;
  var d = $("#device").getBoundingClientRect();
  R.size = [d.width, d.height]; R.inner = [window.innerWidth, window.innerHeight];
  R.scroll = [document.documentElement.scrollWidth - window.innerWidth, document.documentElement.scrollHeight - window.innerHeight];
  var r = document.createElement("pre"); r.id = "__result"; r.textContent = JSON.stringify(R); document.body.appendChild(r);
})();
</script>`;

const MOCK = `<script>
window.__log = []; window.__handlers = {};
window.max = { outlet: function () { window.__log.push(Array.prototype.slice.call(arguments)); },
               bindInlet: function (n, f) { window.__handlers[n] = f; } };
</script>`;

const chrome = findChrome();
if (!chrome) {
  console.log('skip behavioural checks: no Chrome/Chromium/Edge found');
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ara-ui-'));
  const file = path.join(dir, 'harness.html');
  fs.writeFileSync(file, SRC.replace('<head>', '<head>' + MOCK).replace('</body>', DRIVER + '</body>'));
  const r = cp.spawnSync(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--user-data-dir=' + path.join(dir, 'profile'),
    '--window-size=800,400', '--virtual-time-budget=3000', '--dump-dom', 'file://' + file], { encoding: 'utf8', timeout: 60000 });
  fs.rmSync(dir, { recursive: true, force: true });
  const m = /<pre id="__result">([\s\S]*?)<\/pre>/.exec(r.stdout || '');
  let R = null;
  if (m) R = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
  test('page in Chrome: ran without errors and produced a result', () => { assert.ok(R, 'no result; stderr: ' + (r.stderr || '').slice(0, 400)); assert.deepStrictEqual(R.errors, []); });
  if (R) {
    test('page: ui_loaded is sent exactly once, after ui_state and ui_status are bound', () => {
      assert.deepStrictEqual(R.afterLoad, [['ui_loaded']]);
      assert.deepStrictEqual(R.handlers, ['ui_state', 'ui_status']);
    });
    test('page: every action button sends exactly its own message', () => {
      assert.deepStrictEqual(R.actions, {
        sendMelodyne: [['ui_action', 'sendMelodyne']], setGuide: [['ui_action', 'setGuide']], sendVocAlign: [['ui_action', 'sendVocAlign']],
        cancel: [['ui_action', 'cancel']], installHost: [['ui_action', 'installHost']], refreshPlugins: [['ui_action', 'refreshPlugins']] });
    });
    test('page: each switch sends ui_set <name> 1, then 0', () => {
      ['skip', 'preview', 'sync'].forEach((k) => {
        assert.deepStrictEqual(R.switches[k].one, [['ui_set', k, R.switches[k].before === 'true' ? 0 : 1]], k);
        assert.deepStrictEqual(R.switches[k].two, [['ui_set', k, R.switches[k].before === 'true' ? 1 : 0]], k);
      });
    });
    test('page: the placement list sends ui_set placement <index>, closes, and shows the label', () => {
      assert.deepStrictEqual(R.placement.map((x) => x.sent), [[['ui_set', 'placement', 0]], [['ui_set', 'placement', 1]], [['ui_set', 'placement', 2]]]);
      assert.deepStrictEqual(R.placement.map((x) => x.label), ['Take lane', 'New track', 'Replace']);
      assert.ok(R.placement.every((x) => x.open === false));
    });
    test('page: values from Max change the page and are never sent back', () => {
      assert.deepStrictEqual(R.inbound.sent, [], 'echo to Max');
      assert.strictEqual(R.inbound.label, 'New track');
      assert.deepStrictEqual(R.inbound.sw, ['true', 'false', 'true']);
      assert.ok(R.inbound.busy && R.inbound.cancelable && R.inbound.guideDone);
      assert.strictEqual(R.inbound.guide, 'guide set ✓');
      assert.deepStrictEqual(R.inbound.chips.map((s) => s.replace(/\s+/g, ' ').trim()), ['Melodyne found', 'VocAlign not found']);
      assert.strictEqual(R.inbound.status, 'Placing the result...');
      assert.deepStrictEqual(R.after.sent, []);
      assert.ok(!R.after.busy && !R.after.cancelable);
      assert.deepStrictEqual(R.after.chips.map((s) => s.replace(/\s+/g, ' ').trim()), ['Melodyne no host', 'VocAlign no host']);
      assert.strictEqual(R.after.guide, 'no guide');
      assert.strictEqual(R.joined, 'a b');
    });
    test('page: the Install host / Update host button only shows for the states missing and update, and never echoes', () => {
      assert.deepStrictEqual(Object.keys(R.install).map((k) => [k, R.install[k].shown]), [['none', false], ['missing', true], ['update', true], ['ok', false]]);
      assert.strictEqual(R.install.missing.text, 'Install host');
      assert.strictEqual(R.install.update.text, 'Update host');
      Object.keys(R.install).forEach((k) => assert.deepStrictEqual(R.install[k].sent, [], k));
    });
    test('page: About opens, shows the version of the header, and closes on a click', () => {
      assert.ok(R.aboutOpen && R.aboutClosed);
      assert.ok(/^v\d+\.\d+\.\d+$/.test(R.aboutVer), R.aboutVer);
    });
    test('page: fills the whole jweb rectangle, nothing overflows it', () => {
      assert.deepStrictEqual(R.size, R.inner);
      assert.ok(R.scroll[0] <= 0 && R.scroll[1] <= 0, 'overflow ' + R.scroll);
    });
  }
}

const failed = results.filter((x) => !x[0]).length;
console.log(failed ? failed + ' FAILED' : 'all ' + results.length + ' passed');
process.exit(failed ? 1 : 0);
