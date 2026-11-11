// SPDX-License-Identifier: GPL-3.0-or-later
// IG1 (D351, flag instagram-live): Instagram Live as an output. Plan (V canvas, rung reuse only when the validator says
// it fits, else one added GPU-scaled rung; audio once), flag default off, the --live plan file, the key per broadcast
// (paste both, fresh / live / used), Settings > Connections rows (last 4 characters only) and the readiness failure.
// In-memory credential stores only: no test touches Credential Manager, a key file or a real platform. The values here
// are throwaway test strings, never a real key or URL.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadPlatforms, validate } from '../services/outputs/validate.mjs';
import { addInstagram, connectRow, createUseWatcher, keyFreshness, loadAddon, noteKeySaved, readKeyState, rungProblems, writeInstagramPlan, INSTAGRAM_FLAG } from '../services/outputs/instagram.mjs';
import { planFile } from '../app/host/lib/outputs-plan.mjs';
import { loadDefinitions } from '../services/flags/index.mjs';
import { ALPHA_LIVE_PLAN, livePlanFile } from '../services/studio-ui/launch.mjs';
import { createConnect, createMemoryStores, outputsFromPlan } from '../services/platform-connect/index.mjs';
import { loadReadinessConfig, planTargets, runReadiness } from '../services/studio-ui/readiness.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLATFORMS = loadPlatforms(path.join(REPO, 'data', 'platforms'));
const ADDON = loadAddon();
const readJson = (p) => JSON.parse(readFileSync(path.join(REPO, p), 'utf8'));
const tmp = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-ig1-')); tmp.push(d); return d; };
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });
const TEST_KEY = 'ujwtest-ig-0123456789abcdef?s_test=1'; // throwaway; the "?" part is allowed for Instagram (UNVERIFIED)
const TEST_URL = 'rtmps://ingest.test.example:443/rtmp/';
const allFiles = (dir) => readdirSync(dir).flatMap((n) => { const p = path.join(dir, n); return statSync(p).isDirectory() ? allFiles(p) : [p]; });

describe('platform limits (data/platforms/instagram.json)', () => {
  test('loads with the research values; the unconfirmed ones are UNVERIFIED', () => {
    const p = PLATFORMS.instagram;
    assert.ok(p, 'instagram is in the registry');
    assert.equal(Math.max(p.maxWidth.value, p.maxHeight.value), 1280);
    assert.equal(Math.min(p.maxWidth.value, p.maxHeight.value), 720);
    assert.equal(p.maxFps.value, 30);
    assert.deepEqual([p.videoBitrateKbps.min.value, p.videoBitrateKbps.max.value], [2250, 6000]);
    assert.equal(p.audioBitrateKbps.max.value, 256);
    assert.equal(p.audioSampleRateHz.recommended.value, 44100);
    assert.equal(p.ingest.value.perBroadcast, true);
    for (const k of ['protocols', 'maxDurationSec', 'videoCodecs', 'audioCodecs']) assert.equal(p[k].unverified, true, k);
    assert.equal(p.keyframeIntervalSec.max.unverified, true);
    for (const k of ['maxWidth', 'maxFps', 'portrait']) assert.match(p[k].checked, /^2026-11-11$/);
  });
});

describe('plan: the instagram sink on the V canvas', () => {
  const preset = readJson('data/outputs/presets/youtube-1080p60.json');

  test('the V stream rung (1080x1920@60, 7500 kbps) does not fit, so one 720x1280@30 rung is added from the V canvas', () => {
    assert.ok(rungProblems(preset, 'vert', { platforms: PLATFORMS }).some((m) => /7500 kbps above instagram max 6000/.test(m)));
    const r = addInstagram(preset, { platforms: PLATFORMS });
    assert.equal(r.reused, false);
    assert.match(r.why.vert, /6000/);
    const rung = r.config.encoders.find((e) => e.id === r.rung);
    assert.deepEqual([rung.canvas, rung.w, rung.h, rung.fps, rung.codec, rung.rc, rung.gop_sec], ['V', 720, 1280, 30, 'h264', 'cbr', 2]);
    assert.equal(rung.encoder, preset.encoders.find((e) => e.id === 'vert').encoder, 'the encoder kind of the plan\'s own V rung');
    assert.equal(r.config.encoders.length, preset.encoders.length + 1, 'exactly one rung added');
    const sink = r.config.sinks.find((s) => s.id === 'instagram');
    assert.deepEqual([sink.platform, sink.encoder], ['instagram', r.rung]);
    const res = validate(r.config, PLATFORMS);
    assert.deepEqual(res.errors, []);
    assert.equal(res.rungs.find((x) => x.id === r.rung).sinks.join(), 'instagram');
    const blocking = res.warnings.filter((w) => w.sink === 'instagram' && !['UNVERIFIED_LIMIT', 'NOT_RECOMMENDED'].includes(w.code));
    assert.deepEqual(blocking, []);
    assert.ok(res.warnings.some((w) => w.sink === 'instagram' && w.field === 'audioSampleRateHz'), '48 kHz shared audio vs 44.1 kHz recommended is reported');
    assert.equal(preset.encoders.length, 3, 'the preset itself is not changed');
  });

  test('a V rung that fits every Instagram limit is reused (no new encoder)', () => {
    const cfg = structuredClone(preset);
    cfg.encoders.push({ id: 'v-small', canvas: 'V', w: 720, h: 1280, fps: 30, codec: 'h264', bitrate: 3500, rc: 'cbr', gop_sec: 2, encoder: 'nvenc' });
    const r = addInstagram(cfg, { platforms: PLATFORMS });
    assert.equal(r.reused, true);
    assert.equal(r.rung, 'v-small');
    assert.equal(r.config.encoders.length, cfg.encoders.length);
  });

  test('an identical rung is deduplicated by the validator; the rung fps divides the V canvas fps', () => {
    const cfg = structuredClone(preset);
    cfg.canvases.find((c) => c.id === 'V').fps = 50;
    const r = addInstagram(cfg, { platforms: PLATFORMS });
    assert.equal(r.config.encoders.find((e) => e.id === r.rung).fps, 25);
    assert.deepEqual(validate(r.config, PLATFORMS).errors, []);
    const twice = structuredClone(addInstagram(preset, { platforms: PLATFORMS }).config);
    twice.encoders.push({ ...twice.encoders.find((e) => e.id === 'ig-v'), id: 'ig-copy' });
    assert.ok(validate(twice, PLATFORMS).info.some((i) => i.code === 'RUNG_DEDUP' && i.mergedFrom.includes('ig-copy')));
  });

  test('a plan without a V canvas or with an instagram sink already is refused', () => {
    assert.throws(() => addInstagram({ ...preset, canvases: preset.canvases.filter((c) => c.id !== 'V') }, { platforms: PLATFORMS }), /no V canvas/);
    assert.throws(() => addInstagram(addInstagram(preset, { platforms: PLATFORMS }).config, { platforms: PLATFORMS }), /already has a sink/);
  });

  test('the --live plan file: alpha-live plus the instagram sink, target names only, audio once', () => {
    const d = mk();
    const w = writeInstagramPlan(d, ALPHA_LIVE_PLAN);
    assert.equal(path.dirname(w.file), path.join(d, 'outputs'));
    const text = readFileSync(w.file, 'utf8');
    assert.ok(!/rtmps?:\/\//.test(text), 'no URL in the plan');
    const j = JSON.parse(text);
    assert.deepEqual(j.targets.instagram, ADDON.target);
    assert.match(j.targets.instagram.keyRef, /^Ujwalam\/stream\/instagram$/);
    assert.equal(j.targets.instagram.serverRef, 'Ujwalam/stream/instagram-server');
    // validation only (allowLive: nothing starts, nothing is read from Credential Manager)
    const p = planFile(w.file, { allowLive: true });
    const ig = p.params.sinks.find((s) => s.id === 'instagram');
    assert.equal(ig.rung, 'ig-v');
    assert.deepEqual(ig.target, { transport: 'auto', urlRef: ADDON.target.serverRef, keyRef: ADDON.target.keyRef });
    assert.ok(p.unresolved.includes('instagram'), 'auto stays unresolved without the stored scheme');
    const rung = p.params.rungs.find((r) => r.id === 'ig-v');
    assert.deepEqual([rung.canvas, rung.w, rung.h, rung.fps, rung.bitrate, rung.gopSec], ['V', 720, 1280, 30, ADDON.rung.bitrate, 2]);
    assert.equal(p.params.rungs.length, 4, 'yt-h, reencode-tk, vert and ig-v: four encoders, no more');
    assert.equal(typeof p.params.audio.bitrate, 'number', 'one audio encoder for every sink');
    assert.ok(!('key' in ig.target) && !('url' in ig.target));
    const withScheme = planFile(w.file, { allowLive: true, schemes: { [ADDON.target.serverRef]: { present: true, scheme: 'rtmps' }, 'Ujwalam/stream/twitch-server': { present: true, scheme: 'rtmps' }, 'Ujwalam/stream/kick-server': { present: true, scheme: 'rtmps' } } });
    assert.equal(withScheme.params.sinks.find((s) => s.id === 'instagram').target.transport, 'rtmps');
    assert.equal(withScheme.params.sinks.find((s) => s.id === 'instagram').proto, 'rtmps');
    assert.throws(() => planFile(w.file, {}), /refused/, 'a real target still needs allowLive');
    const sel = planFile(w.file, { allowLive: true, select: ['youtube-h'] });
    assert.ok(!sel.params.rungs.some((r) => r.id === 'ig-v'), '--sinks without instagram: its rung is not created');
  });
});

describe('flag instagram-live', () => {
  test('is defined and off by default', () => {
    const f = loadDefinitions().find((x) => x.id === INSTAGRAM_FLAG);
    assert.ok(f);
    assert.equal(f.default, false);
  });
  test('livePlanFile: off = the plan in effect unchanged; on = the generated instagram plan', () => {
    const d = mk();
    assert.equal(livePlanFile({ dataDir: d, streamSettingsOn: false }), ALPHA_LIVE_PLAN);
    assert.equal(livePlanFile({ dataDir: d, streamSettingsOn: false, instagramOn: false }), ALPHA_LIVE_PLAN);
    const f = livePlanFile({ dataDir: d, streamSettingsOn: false, instagramOn: true });
    assert.equal(f, path.join(d, 'outputs', ADDON.planName));
    assert.ok(planTargets(f).some((t) => t.id === 'instagram' && t.transport === 'auto' && t.schemes.join() === 'rtmp,rtmps'));
  });
});

describe('key per broadcast (no secrets on disk)', () => {
  test('pasted -> fresh; seen live -> live; ended -> used; a retry is not an end', () => {
    const d = mk();
    let t = Date.parse('2026-11-11T10:00:00Z');
    const now = () => t;
    assert.equal(keyFreshness(d).state, 'not-pasted');
    noteKeySaved(d, { now });
    assert.deepEqual([keyFreshness(d).fresh, keyFreshness(d).state], [true, 'fresh']);
    const w = createUseWatcher({ dataDir: d, now });
    t += 1000; assert.equal(w.observe({ sinks: [{ id: 'instagram', kind: 'stream', state: 'starting' }] }), null);
    t += 1000; assert.equal(w.observe({ sinks: [{ id: 'instagram', kind: 'stream', state: 'live' }] }), 'live');
    assert.equal(keyFreshness(d).state, 'live');
    assert.equal(keyFreshness(d).fresh, true, 'still this broadcast\'s key while on air');
    t += 1000; assert.equal(w.observe({ sinks: [{ id: 'instagram', kind: 'stream', state: 'retrying' }] }), null);
    t += 1000; assert.equal(w.observe(null), null, 'unreadable status decides nothing');
    t += 1000; assert.equal(w.observe({ sinks: [{ id: 'instagram', kind: 'stream', state: 'stopped' }] }), 'used');
    assert.deepEqual([keyFreshness(d).fresh, keyFreshness(d).state], [false, 'used']);
    t += 1000; assert.equal(w.observe({ sinks: [] }), null, 'used once');
    t += 1000; noteKeySaved(d, { now });
    assert.equal(keyFreshness(d).state, 'fresh', 'a new paste is fresh again');
    const text = readFileSync(path.join(d, 'outputs', ADDON.keyStateName), 'utf8');
    assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ['liveAt', 'savedAt', 'usedAt', 'version']);
  });
  test('a crash mid-broadcast: the next studio start marks the key used (sink gone)', () => {
    const d = mk();
    let t = Date.parse('2026-11-11T11:00:00Z');
    noteKeySaved(d, { now: () => t });
    t += 1000; createUseWatcher({ dataDir: d, now: () => t }).observe({ sinks: [{ id: 'instagram', kind: 'stream', state: 'live' }] });
    t += 1000; assert.equal(createUseWatcher({ dataDir: d, now: () => t }).observe({ sinks: [] }), 'used');
    assert.equal(readKeyState(d).usedAt, new Date(t).toISOString());
  });
  test('a sink that never went live does not use the key', () => {
    const d = mk();
    noteKeySaved(d);
    const w = createUseWatcher({ dataDir: d });
    assert.equal(w.observe({ sinks: [{ id: 'instagram', kind: 'stream', state: 'failed' }] }), null);
    assert.equal(keyFreshness(d).fresh, true);
  });
});

describe('Settings > Connections: the Instagram entry', () => {
  function setup() {
    const mem = createMemoryStores();
    const dataDir = mk();
    const outputs = outputsFromPlan([...planTargets(), connectRow()]);
    const c = createConnect({ dataDir, outputs, storeFor: mem.storeFor, outputLive: async () => 'idle', sleep: async () => {} });
    return { c, mem, dataDir };
  }
  test('the row: Instagram, V canvas, both rtmp and rtmps, per broadcast, no sign-in', () => {
    const o = outputsFromPlan([connectRow()])[0];
    assert.deepEqual([o.id, o.platform, o.label, o.keyRef, o.serverRef, o.schemes.join(), o.signIn, o.perBroadcast],
      ['instagram', 'instagram', 'Instagram', 'Ujwalam/stream/instagram', 'Ujwalam/stream/instagram-server', 'rtmp,rtmps', null, true]);
  });
  test('the URL and the key are pasted together; status shows the last 4 characters only; used after the broadcast', async () => {
    const { c, mem, dataDir } = setup();
    let st = (await c.status({ fresh: true })).outputs.find((o) => o.id === 'instagram');
    assert.equal(st.state, 'missing');
    assert.equal(c.checkPaste('instagram', { key: TEST_KEY }), 'per-broadcast-both');
    assert.equal(c.checkPaste('instagram', { server: TEST_URL }), 'per-broadcast-both');
    assert.equal(c.checkPaste('instagram', { key: TEST_KEY, server: TEST_URL }), null, 'a "?" part is allowed in an Instagram key');
    await assert.rejects(c.paste('instagram', { key: TEST_KEY }), (e) => e.code === 'per-broadcast-both');
    await c.paste('instagram', { key: TEST_KEY, server: TEST_URL });
    assert.equal(mem.map.get('Ujwalam/stream/instagram'), TEST_KEY);
    assert.equal(mem.map.get('Ujwalam/stream/instagram-server'), TEST_URL);
    st = (await c.status({ fresh: true })).outputs.find((o) => o.id === 'instagram');
    assert.equal(st.state, 'connected');
    assert.equal(st.key.last4, TEST_KEY.slice(-4));
    assert.equal(st.perBroadcast, true);
    const body = JSON.stringify(await c.status({ fresh: true }));
    assert.ok(!body.includes(TEST_KEY) && !body.includes(TEST_URL) && !body.includes('ingest.test.example'), 'no key or URL in status');
    const w = createUseWatcher({ dataDir });
    w.observe({ sinks: [{ id: 'instagram', kind: 'stream', state: 'live' }] });
    w.observe({ sinks: [{ id: 'instagram', kind: 'stream', state: 'stopped' }] });
    st = (await c.status({ fresh: true })).outputs.find((o) => o.id === 'instagram');
    assert.equal(st.state, 'used');
    assert.match(st.detail, /Paste the new server URL and stream key/);
    for (const f of allFiles(dataDir)) {
      const text = readFileSync(f, 'utf8');
      assert.ok(!text.includes(TEST_KEY) && !text.includes(TEST_KEY.slice(-4) + '"') && !text.includes('ingest.test.example'), `${path.basename(f)} holds no key, key part or URL`);
    }
  });
  test('the other outputs keep their rules (a Twitch key still refuses a "?" part)', () => {
    const { c } = setup();
    assert.equal(c.checkPaste('twitch', { key: 'abc?bandwidthtest=true' }), 'key-has-query');
    assert.equal(c.checkPaste('kick', { key: 'kick-test-key-zz' }), null, 'one field is still enough elsewhere');
  });
});

describe('readiness: Instagram on with no fresh key fails', () => {
  const host = { describe: () => ({ kind: 'host' }), call: async (m) => (m === 'outputs.status' ? { sinks: [] } : m === 'host.status' ? { live: false } : {}) };
  const deps = (instagram) => ({
    host, config: loadReadinessConfig(), flagOn: () => false, store: (t) => createMemoryStores({ 'Ujwalam/stream/instagram': TEST_KEY }).storeFor(t),
    listProcesses: async () => [], diskFree: async () => 500 * 2 ** 30, tcp: async () => false, botPorts: {}, ciPass: async () => null,
    clipTools: () => ({ py: null, reason: 'test' }), findTool: () => null, liveWorkerExists: () => null, planTargets: [], dataDir: null,
    audioCheck: async () => ({ id: 'audio', status: 'pass', message: 'ok' }), instagram,
  });
  const cred = async (instagram) => (await runReadiness(deps(instagram))).items.find((i) => i.id === 'credentials');
  test('flag off (null): no Instagram item', async () => {
    const c = await cred(() => null);
    assert.notEqual(c.status, 'fail');
    assert.ok(!/Instagram/.test(c.message));
  });
  test('a used key fails with a plain fix', async () => {
    const d = mk();
    noteKeySaved(d, { now: () => 1000 });
    createUseWatcher({ dataDir: d, now: () => 2000 }).observe({ sinks: [{ id: 'instagram', state: 'live' }] });
    createUseWatcher({ dataDir: d, now: () => 3000 }).observe({ sinks: [] });
    const { freshnessText } = await import('../services/outputs/instagram.mjs');
    const f = keyFreshness(d);
    const c = await cred(() => ({ fresh: false, state: f.state, ...freshnessText(f) }));
    assert.equal(c.status, 'fail');
    assert.match(c.message, /used for a broadcast that ended/);
    assert.match(c.fix, /Live Producer/);
    assert.match(c.fix, /Settings > Connections > Instagram/);
  });
  test('never pasted through Ujwalam fails; a fresh key passes this part', async () => {
    const { freshnessText } = await import('../services/outputs/instagram.mjs');
    const c = await cred(() => ({ fresh: false, state: 'not-pasted', ...freshnessText({ state: 'not-pasted' }, { connectOn: false }) }));
    assert.equal(c.status, 'fail');
    assert.match(c.fix, /platform-connect/);
    const ok = await cred(() => ({ fresh: true, state: 'fresh' }));
    assert.notEqual(ok.status, 'fail');
  });
});

describe('no hardcoded Instagram limit in code', () => {
  test('services/outputs/instagram.mjs names no limit value', () => {
    const src = readFileSync(path.join(REPO, 'services', 'outputs', 'instagram.mjs'), 'utf8');
    for (const n of ['2250', '6000', '720', '1280', '44100', '256']) assert.ok(!new RegExp(`\\b${n}\\b`).test(src), `instagram.mjs hardcodes ${n}`);
  });
});
