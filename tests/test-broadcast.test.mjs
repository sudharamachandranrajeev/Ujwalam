// SPDX-License-Identifier: GPL-3.0-or-later
// BM3 (D196): test-broadcast banner. Page logic (run in a vm, no browser, no window), params vs registry, scene layers,
// flag gate, static mount. Nothing here opens a window or starts a child process.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createProject, validateProject } from '../services/project/index.mjs';
import { loadScenePreset } from '../services/project/scene-preset.mjs';
import { createStaticServer } from '../services/overlay-server/static.mjs';
import { OVERLAY_FLAGS, OWN_OVERLAYS_DIR, overlayFlagState } from '../services/overlay-server/index.mjs';
import { createFlags, loadDefinitions } from '../services/flags/index.mjs';
import { validateRegistry } from '../tools/registry-validate.mjs';

const PAGE_DIR = path.join(OWN_OVERLAYS_DIR, 'ujwalam-test-broadcast');
const bannerSrc = readFileSync(path.join(PAGE_DIR, 'banner.js'), 'utf8');
const html = readFileSync(path.join(PAGE_DIR, 'index.html'), 'utf8');
const fn = JSON.parse(readFileSync('registry/functions/timed-banner.json', 'utf8'));
const preset = JSON.parse(readFileSync('registry/presets/test-broadcast.json', 'utf8'));
const presetH = JSON.parse(readFileSync('registry/presets/scene-default-h.json', 'utf8'));
const presetV = JSON.parse(readFileSync('registry/presets/scene-default-v.json', 'utf8'));
const profile = JSON.parse(readFileSync('tests/fixtures/project/profile.fixture.json', 'utf8'));

function loadBanner() {
  const ctx = { URLSearchParams, encodeURIComponent, isFinite, Number, Math, String };
  vm.createContext(ctx);
  vm.runInContext(bannerSrc, ctx);
  return ctx.TestBroadcast;
}
const TB = loadBanner();

test('registry validates (function timed-banner + preset test-broadcast)', () => {
  assert.deepEqual(validateRegistry('registry', process.cwd()), []);
  assert.equal(preset.function, 'timed-banner');
  assert.deepEqual(preset.canvases, ['H', 'V']);
  assert.equal(preset.tags.flashes, 'none');
  assert.equal(fn.flashesPerSec, 0);
});

test('page ranges equal the function safeRanges; entrance < 600 ms, exit < 400 ms', () => {
  for (const k of ['interval', 'hold', 'enter', 'exit']) {
    assert.deepEqual([TB.RANGES[k].min, TB.RANGES[k].max], fn.params.safeRanges[k], k);
    assert.equal(TB.RANGES[k].def, fn.params.defaults[k], `${k} default`);
    assert.equal(fn.params.schema.properties[k].minimum, fn.params.safeRanges[k][0]);
    assert.equal(fn.params.schema.properties[k].maximum, fn.params.safeRanges[k][1]);
  }
  assert.ok(fn.params.safeRanges.enter[1] < 600);
  assert.ok(fn.params.safeRanges.exit[1] < 400);
  assert.ok(preset.params.enter < 600 && preset.params.exit < 400);
  assert.equal(preset.params.interval, 900);
  assert.equal(preset.params.hold, 18);
});

test('preset params sit inside the schema and the safe ranges', () => {
  const p = preset.params;
  for (const k of Object.keys(fn.params.safeRanges)) {
    assert.ok(Number.isInteger(p[k]) && p[k] >= fn.params.safeRanges[k][0] && p[k] <= fn.params.safeRanges[k][1], k);
  }
  assert.ok(p.text.length >= 1 && p.text.length <= fn.params.schema.properties.text.maxLength);
  assert.ok(p.label.length <= fn.params.schema.properties.label.maxLength);
  for (const k of Object.keys(p)) assert.ok(k in fn.params.schema.properties, `unknown param ${k}`);
});

test('parseParams: round trip of the preset, clamping, no text means nothing is shown', () => {
  const search = '?' + TB.buildQuery(preset.params) + '&streamerbot=1&sbPort=5';
  assert.deepEqual({ ...TB.parseParams(search), flag: TB.parseFlag(search) }, preset.params);
  assert.equal(TB.parseFlag('?flag=Bad Id'), '');
  assert.equal(TB.parseFlag('?text=x'), '');
  const wild = TB.parseParams('?text=x&interval=1&hold=9999&enter=5000&exit=0');
  assert.equal(wild.interval, 60);
  assert.equal(wild.hold, 60);
  assert.equal(wild.enter, 550);
  assert.equal(wild.exit, 100);
  const junk = TB.parseParams('?text=x&interval=abc&hold=');
  assert.equal(junk.interval, 900);
  assert.equal(junk.hold, 18);
  assert.equal(TB.parseParams('?label=only'), null);
  assert.equal(TB.parseParams(''), null);
  assert.equal(TB.parseParams('?text=' + 'a'.repeat(500)).text.length, 200);
});

test('schedule: first showing at load, then every interval', () => {
  assert.deepEqual(Array.from(TB.schedule({ interval: 900 }, 3 * 900 * 1000)), [0, 900000, 1800000, 2700000]);
});

// A tiny fake DOM with manual timers: checks show, hold, hide and the repeat, and that text goes in as text.
function fakeEnv() {
  const classes = new Set();
  const styleProps = {};
  const mk = () => ({ textContent: '', style: { setProperty: (k, v) => { styleProps[k] = v; } }, clientHeight: 100, scrollHeight: 50 });
  const els = { banner: { ...mk(), classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) } }, label: mk(), text: mk() };
  const doc = { getElementById: (id) => els[id] ?? null };
  let now = 0;
  const timers = [];
  const win = {
    innerHeight: 100,
    setTimeout: (f, ms) => { const t = { at: now + ms, f, on: true }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.on = false; },
  };
  const advance = (ms) => {
    const end = now + ms;
    for (;;) {
      const next = timers.filter((t) => t.on && t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      next.on = false; now = next.at; next.f();
    }
    now = end;
  };
  return { doc, win, els, classes, styleProps, advance };
}

test('run: nothing until on; then visible, hidden after hold, back every interval; text set as plain text', () => {
  const e = fakeEnv();
  const p = TB.parseParams('?' + TB.buildQuery({ ...preset.params, text: '<img src=x onerror=1> hi' }));
  const h = TB.run(p, e.doc, e.win);
  assert.ok(!e.classes.has('is-on'), 'off until the gate says on');
  e.advance(3600000); assert.ok(!e.classes.has('is-on'));
  h.setOn(true);
  assert.ok(e.classes.has('is-on'));
  assert.equal(e.els.text.textContent, '<img src=x onerror=1> hi');
  assert.equal(e.els.label.textContent, 'Test broadcast');
  assert.equal(e.styleProps['--enter'], '450ms');
  assert.equal(e.styleProps['--exit'], '300ms');
  e.advance(17999); assert.ok(e.classes.has('is-on'));
  e.advance(2); assert.ok(!e.classes.has('is-on') && e.classes.has('is-leaving'));
  e.advance(900000 - 18001 - 1); assert.ok(!e.classes.has('is-on'));
  e.advance(2); assert.ok(e.classes.has('is-on') && !e.classes.has('is-leaving'));
  h.stop();
  e.advance(3600000); // stopped: no timer left that flips state again
  assert.ok(e.classes.has('is-on'));
});

test('run: switching off hides at once and schedules nothing; on again shows at once', () => {
  const e = fakeEnv();
  const h = TB.run(TB.parseParams('?' + TB.buildQuery(preset.params)), e.doc, e.win);
  h.setOn(true); e.advance(5000);
  h.setOn(false);
  assert.ok(!e.classes.has('is-on') && e.classes.has('is-leaving'));
  e.advance(4 * 900000); assert.ok(!e.classes.has('is-on'), 'no showing while off');
  h.setOn(false); assert.equal(h.isOn(), false);
  h.setOn(true); assert.ok(e.classes.has('is-on') && !e.classes.has('is-leaving'));
  h.setOn(true); // repeated "on" from the poll does not restart the cycle
  e.advance(18001); assert.ok(!e.classes.has('is-on'));
  h.stop();
});

test('watchFlag: polls flags.json; on only for an exact true; a failed or odd answer reads as off', async () => {
  const answers = [];
  const seen = [];
  const win = {
    fetch: (url, o) => { seen.push([url, o.cache]); const a = answers.shift(); return a instanceof Error ? Promise.reject(a) : Promise.resolve(a); },
    setInterval: () => 1,
  };
  const ctl = { v: null, setOn(x) { this.v = x; } };
  const tick = () => new Promise((r) => setImmediate(r));
  const ok = (j) => ({ ok: true, json: () => Promise.resolve(j) });
  for (const [answer, want] of [[ok({ 'test-broadcast': true }), true], [ok({ 'test-broadcast': 'true' }), false], [ok({}), false],
    [ok(null), false], [{ ok: false }, false], [new Error('down'), false], [ok({ 'test-broadcast': true, other: false }), true]]) {
    answers.push(answer);
    TB.watchFlag('test-broadcast', ctl, win, 5000);
    await tick(); await tick();
    assert.equal(ctl.v, want, JSON.stringify(answer));
  }
  assert.deepEqual(seen[0], ['/_ujwalam/flags.json', 'no-store']);
});

test('page source rules: plain script, no CDN, no innerHTML, tokens only, no flash, no hardcoded text', () => {
  const all = `${html}\n${bannerSrc}`;
  assert.doesNotMatch(all, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
  assert.doesNotMatch(all, /https?:\/\//);
  assert.doesNotMatch(all, /type="module"/);
  assert.doesNotMatch(html, /#[0-9a-fA-F]{3,8}\b|rgba?\(/, 'colours come from tokens');
  assert.doesNotMatch(all, /@keyframes|animation:/, 'transitions only: opacity and a short slide');
  assert.doesNotMatch(all, /streaming software|Tell us in chat/i, 'the announcement text is data, not in the page');
  assert.match(html, /\.\.\/\.\.\/brand\/tokens\.css/);
  assert.match(html, /var\(--enter, 450ms\)/);
  assert.match(html, /var\(--exit, 300ms\)/);
});

test('scene layers: both presets carry the layer, same overlay, query from the preset params (with the flag), top of the stack', () => {
  const want = TB.buildQuery(preset.params);
  for (const [P, name] of [[presetH, 'H'], [presetV, 'V']]) {
    const l = P.params.layers.find((x) => x.key === 'test-broadcast');
    assert.ok(l, `${name} has the layer`);
    assert.equal(l.overlay, 'ujwalam-test-broadcast/index.html');
    assert.equal(l.query, want, `${name} query follows the preset params`);
    assert.match(l.query, /(^|&)flag=test-broadcast(&|$)/);
    assert.equal(l.visible, undefined, 'always in the scene: the page gates itself live');
    assert.equal(l.z, Math.max(...P.params.layers.map((x) => x.z)));
    assert.ok(l.rect.x + l.rect.w <= 1 && l.rect.y + l.rect.h <= 1);
  }
});

test('V safe area: 5 percent side margins, 8 percent top, nothing in the lower 20 percent, clear of the game box', () => {
  const l = presetV.params.layers.find((x) => x.key === 'test-broadcast');
  const game = presetV.params.layers.find((x) => x.key === 'game');
  assert.ok(l.rect.x >= 0.05 && l.rect.x + l.rect.w <= 0.95);
  assert.ok(l.rect.y >= 0.08);
  assert.ok(l.rect.y + l.rect.h <= 0.8);
  assert.ok(l.rect.y + l.rect.h <= game.rect.y, 'ends above the game capture');
});

test('flag: defined, off by default, an overlay flag; the built layer is a visible browser layer on H and V', () => {
  const def = loadDefinitions().find((d) => d.id === 'test-broadcast');
  assert.ok(def);
  assert.equal(def.default, false);
  assert.ok(OVERLAY_FLAGS.includes('test-broadcast'));
  const build = (P) => {
    const r = loadScenePreset(createProject({ name: 'T' }), P, { profile });
    assert.equal(validateProject(r.project).ok, true);
    const ly = r.project.scenes.at(-1).layers.find((x) => x.name === 'Test broadcast');
    return { ly, r };
  };
  for (const [P, cv] of [[presetH, 'h'], [presetV, 'v']]) {
    const on = build(P);
    assert.equal(on.ly.placements[cv].visible, true);
    assert.equal(on.ly.type, 'browser');
    const ov = on.r.project.overlays.find((o) => o.id === on.ly.source.overlay);
    assert.deepEqual(ov.file, { base: 'overlays', rel: 'ujwalam-test-broadcast/index.html' });
    assert.equal(on.ly.source.query, TB.buildQuery(preset.params));
  }
});

// ---- the mount ----
function get(port, p) {
  return new Promise((ok, fail) => {
    http.get({ host: '127.0.0.1', port, path: p, headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', fail);
  });
}

test('mount: own page under /overlays/ujwalam-test-broadcast/ beside a legacy-style root; legacy still served; only ujwalam-* taken; no escape', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'test-broadcast-'));
  const root = path.join(tmp, 'root');
  mkdirSync(path.join(root, 'overlays', 'demo'), { recursive: true });
  mkdirSync(path.join(root, 'overlays', 'ujwalam-test-broadcast'), { recursive: true });
  mkdirSync(path.join(root, 'brand'), { recursive: true });
  writeFileSync(path.join(root, 'overlays', 'demo', 'index.html'), '<title>demo</title>');
  writeFileSync(path.join(root, 'overlays', 'ujwalam-test-broadcast', 'index.html'), '<title>SHADOWED</title>');
  writeFileSync(path.join(root, 'brand', 'tokens.css'), ':root{--ink:#fff}');
  mkdirSync(path.join(tmp, 'own', 'other'), { recursive: true });
  writeFileSync(path.join(tmp, 'own', 'other', 'index.html'), '<title>not prefixed</title>');
  const s = createStaticServer({ root, port: 0, ownOverlays: OWN_OVERLAYS_DIR });
  const odd = createStaticServer({ root, port: 0, ownOverlays: path.join(tmp, 'own') });
  const port = await s.listen();
  const port2 = await odd.listen();
  try {
    const page = await get(port, '/overlays/ujwalam-test-broadcast/index.html?text=hi');
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /text\/html/);
    assert.match(page.body, /<title>Test broadcast<\/title>/, 'the repo page wins for ujwalam-* names');
    assert.match(page.headers['content-security-policy'], /connect-src 'self'/);
    const js = await get(port, '/overlays/ujwalam-test-broadcast/banner.js');
    assert.equal(js.status, 200);
    assert.match(js.headers['content-type'], /javascript/);
    assert.equal((await get(port, '/overlays/ujwalam-test-broadcast/')).status, 200);
    assert.equal((await get(port, '/overlays/demo/index.html')).status, 200, 'legacy-style pages still served');
    assert.equal((await get(port, '/brand/tokens.css')).status, 200, 'tokens resolve through ../../brand');
    assert.equal((await get(port, '/overlays/ujwalam-test-broadcast/../../brand/tokens.css')).status, 400);
    assert.equal((await get(port, '/overlays/ujwalam-test-broadcast/%2e%2e/banner.js')).status, 400);
    assert.equal((await get(port, '/overlays/ujwalam-nope/index.html')).status, 404);
    assert.equal((await get(port2, '/overlays/other/index.html')).status, 404, 'a folder not named ujwalam-* is never taken from the own dir');
  } finally {
    await s.close();
    await odd.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('flags.json: overlay flags only, a control-page flip is seen on the next request, failures read as off', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'test-broadcast-flags-'));
  const root = path.join(tmp, 'root');
  mkdirSync(path.join(root, 'overlays'), { recursive: true });
  const flags = createFlags({ dataDir: path.join(tmp, 'data') });
  const s = createStaticServer({ root, port: 0, flagsJson: () => overlayFlagState(flags) });
  const bad = createStaticServer({ root, port: 0, flagsJson: () => { throw new Error('boom'); } });
  const none = createStaticServer({ root, port: 0 });
  const [port, port2, port3] = [await s.listen(), await bad.listen(), await none.listen()];
  try {
    const read = async (p) => { const r = await get(p, '/_ujwalam/flags.json'); return { ...r, json: r.status === 200 ? JSON.parse(r.body) : null }; };
    let r = await read(port);
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /application\/json/);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.deepEqual(r.json, { 'test-broadcast': false }, 'off by default; no other flag is listed');
    flags.set('test-broadcast', true);
    flags.set('bot-manager', true);
    r = await read(port);
    assert.deepEqual(r.json, { 'test-broadcast': true }, 'seen without a restart; bot-manager never reaches a page');
    flags.set('test-broadcast', false);
    assert.deepEqual((await read(port)).json, { 'test-broadcast': false });
    assert.deepEqual((await read(port2)).json, {}, 'a failed read is an empty state (all off)');
    assert.equal((await get(port3, '/_ujwalam/flags.json')).status, 404, 'no flags source: no route');
    assert.deepEqual(overlayFlagState(undefined), { 'test-broadcast': false });
    assert.deepEqual(overlayFlagState({ isOn: () => { throw new Error('x'); } }), { 'test-broadcast': false });
  } finally {
    await s.close(); await bad.close(); await none.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
