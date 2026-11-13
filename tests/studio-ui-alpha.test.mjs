// SPDX-License-Identifier: GPL-3.0-or-later
// Alpha 0 shell: device role matching, the alpha project build and its never-modify rule, the launcher's host flag
// wiring (fake host, no libobs, no devices, mock Streamer.bot), host log rotation, the day-2 host config (hotkeys,
// replay, feedback folder, event-core system file and token) and the --live plan (fake host: nothing is contacted).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { loadDevicePresets, matchRoles, overrideProblems } from '../services/project/device-roles.mjs';
import { validateProject } from '../services/project/index.mjs';
import { alphaBases, alphaFile, buildAlphaProject, prepareAlphaProject } from '../services/studio-ui/alpha.mjs';
import { ALPHA_LIVE_PLAN, alphaHostConfig, loadAudioHealth, clipperExited, clipsEnv, LIVE_CLIPPER_MAX_RESTARTS, coreEnv, faceControlLine, faceEnv, faceSpec, liveClipsSpec, releaseVersion, shellChoice, shellExitRecord, shellRelaunchAllowed, shellSpawnSpec, studioShellPaths, startCommandLine, DEFAULT_FEEDBACK_DIR, headlessLoginScript, hostLaunchSpec, hotkeyOverrides, main as launchMain, openHostLog, writeHostConfig } from '../services/studio-ui/launch.mjs';
import { closeSync } from 'node:fs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRESETS = path.join(REPO, 'registry', 'presets');
const FIX = path.join(REPO, 'tests', 'fixtures');
const LIST = JSON.parse(readFileSync(path.join(FIX, 'project', 'devices-list.fixture.json'), 'utf8'));
const PROFILE = JSON.parse(readFileSync(path.join(FIX, 'project', 'profile.fixture.json'), 'utf8'));
const devicePresets = loadDevicePresets(PRESETS);
const tmp = (p) => mkdtempSync(path.join(os.tmpdir(), `ujw-alpha-${p}-`));
const listWith = (devices) => ({ ...LIST, devices });
const byName = (n) => LIST.devices.find((d) => d.name === n && d.kind !== 'dshow-audio');

// A presets dir with the Default H preset and, optionally, a V preset made from it (canvas v) for the merge tests.
function presetsDir({ v = false } = {}) {
  const d = tmp('presets');
  copyFileSync(path.join(PRESETS, 'scene-default-h.json'), path.join(d, 'scene-default-h.json'));
  if (v) {
    const p = JSON.parse(readFileSync(path.join(PRESETS, 'scene-default-h.json'), 'utf8'));
    p.id = 'scene-default-v-fixture'; p.params.canvas = 'v'; p.params.sceneName = 'Default V';
    writeFileSync(path.join(d, 'scene-default-v.json'), JSON.stringify(p));
  }
  return d;
}

// ---- role matching

test('event-core env: the host markers token only, never the full host or host system token', () => {
  const coreTokens = { api: 'a'.repeat(64), system: 'b'.repeat(64) };
  const base = { PATH: 'x', UJWALAM_HOST_TOKEN: 'c'.repeat(64), ujwalam_host_system_token: 'd'.repeat(64), UJWALAM_HOST_CLIPS_TOKEN: 'f'.repeat(64) };
  const env = coreEnv({ coreTokens, hostMarkersToken: 'e'.repeat(64), base });
  assert.equal('UJWALAM_HOST_CLIPS_TOKEN' in env, false, 'the event core never gets the clips token');
  assert.equal(env.UJWALAM_HOST_MARKERS_TOKEN, 'e'.repeat(64));
  assert.equal(env.UJWALAM_EVENT_CORE_API_TOKEN, coreTokens.api);
  assert.equal(env.UJWALAM_EVENT_CORE_SYSTEM_TOKEN, coreTokens.system);
  assert.equal(env.PATH, 'x');
  assert.ok(!Object.keys(env).some((k) => /^ujwalam_host_(system_)?token$/i.test(k)), Object.keys(env).join(','));
  assert.ok(!Object.values(env).includes('c'.repeat(64)) && !Object.values(env).includes('d'.repeat(64)));
  assert.equal(base.UJWALAM_HOST_TOKEN, 'c'.repeat(64), 'the base environment is not changed');
});

test('live clipper env: the host clips token and discovery file only, every other token or key removed', () => {
  const base = { PATH: 'x', UJWALAM_HOST_TOKEN: 'c'.repeat(64), ujwalam_host_system_token: 'd'.repeat(64), UJWALAM_HOST_MARKERS_TOKEN: 'e'.repeat(64),
    UJWALAM_EVENT_CORE_API_TOKEN: 'a'.repeat(64), UJWALAM_EVENT_CORE_SYSTEM_TOKEN: 'b'.repeat(64), UJWALAM_UI_LAUNCH_KEY: 'k', UJWALAM_HEADLESS: '1' };
  const env = clipsEnv({ hostClipsToken: 'f'.repeat(64), hostDiscovery: 'C:/data/host.json', base });
  assert.equal(env.UJWALAM_HOST_CLIPS_TOKEN, 'f'.repeat(64));
  assert.equal(env.UJWALAM_HOST_DISCOVERY, 'C:/data/host.json');
  assert.equal(env.PATH, 'x');
  assert.equal(env.UJWALAM_HEADLESS, '1', 'non-secret variables pass');
  assert.deepEqual(Object.keys(env).filter((k) => /^UJWALAM_.*(TOKEN|KEY)/i.test(k)), ['UJWALAM_HOST_CLIPS_TOKEN']);
  for (const v of ['a', 'b', 'c', 'd', 'e']) assert.ok(!Object.values(env).includes(v.repeat(64)), v);
  assert.equal(base.UJWALAM_HOST_TOKEN, 'c'.repeat(64), 'the base environment is not changed');
});

test('face worker env: an allowlist only; no token, key, discovery path or Python variable (D295 review)', () => {
  const base = { Path: 'x', SystemRoot: 'C:/Windows', TEMP: 't', UJWALAM_HEADLESS: '1', UJWALAM_HOST_TOKEN: 'c'.repeat(64),
    ujwalam_host_system_token: 'd'.repeat(64), UJWALAM_FACE_LINK_KEY: 'e'.repeat(64), UJWALAM_HOST_DISCOVERY: 'C:/data/host.json',
    UJWALAM_UI_LAUNCH_KEY: 'k', PYTHONPATH: 'C:/evil', HTTPS_PROXY: 'http://p', MY_SECRET: 's', UJWALAM_DATA_DIR: 'C:/d' };
  const env = faceEnv({ base });
  assert.deepEqual(Object.keys(env).sort(), ['Path', 'SystemRoot', 'TEMP', 'UJWALAM_HEADLESS']);
  assert.equal(base.UJWALAM_HOST_TOKEN, 'c'.repeat(64), 'the base environment is not changed');
});

test('face control line: host pid + 64-hex key, one JSON line; bad input refused', () => {
  const key = 'ab'.repeat(32);
  assert.equal(faceControlLine({ key, hostPid: 1234 }), `{"key":"${key}","hostPid":1234}\n`);
  for (const bad of [{ key: 'AB'.repeat(32), hostPid: 1 }, { key: 'ab', hostPid: 1 }, { key, hostPid: 0 }, { key, hostPid: '5' }]) {
    assert.throws(() => faceControlLine(bad), /bad key or pid/);
  }
});

const FACE_PY = process.env.UJWALAM_FACE_PYTHON || path.join(REPO, '.venv-gpu', 'Scripts', 'python.exe');
test('face worker: takes the key on stdin, never from env; exits when the launcher pipe closes', { skip: !existsSync(FACE_PY) && `no ${FACE_PY}` }, async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-face-'));
  const spec = faceSpec({ dataDir, exists: () => true });
  const child = spawn(FACE_PY, spec.spec.argv, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...faceEnv(), UJWALAM_PARENT_PIPE: '1' } });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  child.stdin.write(faceControlLine({ key: 'cd'.repeat(32), hostPid: 4242 }));
  await new Promise((res) => setTimeout(res, 1500));
  child.stdin.end();
  const code = await new Promise((res) => { child.once('exit', res); setTimeout(() => res('timeout'), 15000); });
  if (code === 'timeout') child.kill();
  assert.equal(code, 0, err);
  assert.match(err, /started; acts only while flag face-ai is on/);
  assert.doesNotMatch(err, /no link key/, 'the control line arrived');
  assert.doesNotMatch(err, /cd{8}/, 'the key is never logged');
  rmSync(dataDir, { recursive: true, force: true });
});

test('roles: registry presets bind game capture, facecam and mic from an anonymised devices.list', () => {
  assert.equal(devicePresets.length, 5, 'five device presets carry match data');
  const r = matchRoles({ list: LIST, presets: devicePresets });
  assert.deepEqual(r.unavailable, []);
  assert.equal(r.bound['game-capture'].entry, byName('Live Gamer Ultra 2.1-Video'));
  assert.equal(r.bound['game-capture'].preset, 'device-live-gamer-ultra-21');
  assert.equal(r.bound['game-capture'].projectKind, 'capture-card');
  assert.equal(r.bound.facecam.entry, byName('Insta360 Link 2C'), 'the Insta360 Virtual Camera is not taken');
  assert.equal(r.bound.facecam.projectKind, 'camera');
  assert.equal(r.bound.mic.entry.kind, 'audio-input', 'the WASAPI endpoint, not the DirectShow audio entry');
  assert.equal(r.bound.mic.projectKind, 'microphone');
  assert.equal(r.bound['game-audio'].entry.name, 'HDMI/Line In (Live Gamer Ultra 2.1-Audio)', 'the HDMI input, not the "Not To Use" endpoint');
  assert.equal(r.bound['game-audio'].projectKind, 'microphone');
});

test('roles: missing and ambiguous devices stay unbound with a reason, never guessed', () => {
  const noCard = listWith(LIST.devices.filter((d) => !d.name.startsWith('Live Gamer')));
  let r = matchRoles({ list: noCard, presets: devicePresets });
  assert.equal(r.bound['game-capture'], undefined);
  assert.match(r.unavailable.find((u) => u.role === 'game-capture').reason, /no connected device matches/);
  const twoCams = listWith([...LIST.devices, { ...byName('Insta360 Link 2C'), path: 'fixture-other-path', obsId: 'x' }]);
  r = matchRoles({ list: twoCams, presets: devicePresets });
  assert.equal(r.bound.facecam, undefined);
  assert.match(r.unavailable.find((u) => u.role === 'facecam').reason, /2 connected devices match "facecam"; set devices.roles.facecam/);
  r = matchRoles({ list: { devices: [] }, presets: devicePresets });
  assert.deepEqual(Object.keys(r.bound), []);
  assert.equal(r.unavailable.length, 4);
});

test('roles: profile overrides by path or name; placeholders count as unset; one device per role', () => {
  const virt = byName('Insta360 Virtual Camera');
  let r = matchRoles({ list: LIST, presets: devicePresets, overrides: { facecam: { path: virt.path.toUpperCase() } } });
  assert.equal(r.bound.facecam.entry, virt, 'path match is case-insensitive');
  assert.equal(r.bound.facecam.by, 'override-path');
  r = matchRoles({ list: LIST, presets: devicePresets, overrides: { facecam: { name: 'Integrated Camera' } } });
  assert.equal(r.bound.facecam.entry, byName('Integrated Camera'));
  r = matchRoles({ list: LIST, presets: devicePresets, overrides: { facecam: { name: 'No Such Camera' } } });
  assert.match(r.unavailable.find((u) => u.role === 'facecam').reason, /override .* matches no connected device/);
  r = matchRoles({ list: LIST, presets: devicePresets, overrides: { facecam: { path: '<facecam-device-path>' } } });
  assert.equal(r.bound.facecam.by, 'preset', 'a placeholder override falls back to the presets');
  r = matchRoles({ list: LIST, presets: devicePresets, overrides: { facecam: { name: 'Live Gamer Ultra 2.1-Video' } } });
  assert.match(r.unavailable.find((u) => u.role === 'facecam').reason, /already bound to "game-capture"/);
  assert.deepEqual(overrideProblems({ facecam: { path: 'a' }, mic: { name: 'b' } }), []);
  assert.equal(overrideProblems({ cam: { path: 'a' } }).length, 1);
  assert.equal(overrideProblems({ facecam: { path: 'a', name: 'b' } }).length, 1);
  assert.equal(overrideProblems({ facecam: 'a' }).length, 1);
});

test('profile schema: devices.roles is optional and strict', () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const v = ajv.compile(JSON.parse(readFileSync(path.join(REPO, 'data', 'profile.schema.json'), 'utf8')));
  const ex = JSON.parse(readFileSync(path.join(REPO, 'data', 'profile.example.json'), 'utf8'));
  assert.ok(v(ex), JSON.stringify(v.errors));
  const p = structuredClone(ex);
  delete p.devices; assert.ok(v(p));
  p.devices = { roles: { mic: { path: 'x', name: 'y' } } }; assert.equal(v(p), false);
  p.devices = { roles: { webcam: { path: 'x' } } }; assert.equal(v(p), false);
  p.devices = { roles: { mic: { id: 'x' } } }; assert.equal(v(p), false);
  p.devices = { monitoringOutput: { name: 'Out 1' } }; assert.ok(v(p), JSON.stringify(v.errors));
  p.devices = { monitoringOutput: { name: '' } }; assert.equal(v(p), false);
  p.devices = { monitoringOutput: { path: 'x' } }; assert.equal(v(p), false);
});

// ---- alpha project

test('alpha build without devices: H scene from the preset, placeholders, V missing is a warning', () => {
  const { project, report } = buildAlphaProject({ presetsDir: presetsDir(), profile: PROFILE });
  assert.ok(validateProject(project).ok);
  assert.equal(project.scenes.length, 1, 'the empty "Scene 1" is dropped');
  assert.equal(project.activeScene, project.scenes[0].id);
  assert.equal(project.scenes[0].name, 'Default H');
  assert.deepEqual(project.origin, { importer: 'alpha', id: 'no-devices' });
  assert.deepEqual(project.devices, []);
  assert.deepEqual(report.unbound.sort(), ['h:facecam', 'h:game-capture']);
  assert.match(report.warnings.join('\n'), /scene-default-v\.json not found/);
  assert.equal(project.scenes[0].layers.filter((l) => l.type === 'capture').length, 0);
  assert.deepEqual(project.audio.sources, []);
});

test('alpha build with bound roles and a V preset: one scene, V capture layers duplicate the H ones, audio on track 1', () => {
  const bindings = matchRoles({ list: LIST, presets: devicePresets });
  const { project, report } = buildAlphaProject({ presetsDir: presetsDir({ v: true }), profile: PROFILE, bindings, devicesListed: true });
  assert.ok(validateProject(project).ok, JSON.stringify(validateProject(project).errors));
  assert.equal(project.scenes.length, 1);
  assert.equal(project.scenes[0].name, 'Default');
  assert.equal(project.origin.id, 'devices-listed');
  assert.deepEqual(project.devices.map((d) => d.kind).sort(), ['camera', 'capture-card', 'microphone', 'microphone'], 'mic + the card audio input');
  const layers = project.scenes[0].layers;
  const caps = layers.filter((l) => l.type === 'capture');
  const isBackdrop = (l) => l.origin?.id?.endsWith('/game-backdrop');
  const dups = layers.filter((l) => l.type === 'duplicate' && !isBackdrop(l));
  assert.equal(caps.length, 2, 'one capture layer per device');
  assert.equal(dups.length, 2, 'the V copies are duplicates');
  for (const d of dups) {
    assert.ok(caps.some((c) => c.id === d.source.layer));
    assert.deepEqual(Object.keys(d.placements), ['v']);
  }
  // D331: one blurred backdrop per canvas, both showing the H game capture layer
  const bds = layers.filter(isBackdrop);
  assert.deepEqual(bds.map((l) => Object.keys(l.placements).join()).sort(), ['h', 'v']);
  for (const b of bds) assert.equal(b.source.layer, caps.find((c) => c.origin.id.endsWith('/game')).id);
  for (const c of caps) assert.deepEqual(Object.keys(c.placements), ['h']);
  assert.equal(report.duplicated, 2);
  assert.deepEqual(report.unbound, []);
  assert.deepEqual(project.audio.sources.map((s) => [s.id, s.monitoring, s.tracks[0]]), [['aud-mic', 'off', 'track1'], ['aud-game', 'monitor-and-output', 'track1']]);
  // Game = the card's audio input (no video: CUE in real time), not the capture layer's audio
  const game = project.audio.sources.find((s) => s.id === 'aud-game');
  assert.equal(game.layer, undefined);
  assert.equal(project.devices.find((d) => d.id === game.device).name, 'HDMI/Line In (Live Gamer Ultra 2.1-Audio)');
});

test('alpha build with the real presets (layer-effects on or off): the blurred backdrops duplicate the H game layer (never a duplicate of a duplicate) and sit under every layer of their canvas (D331)', () => {
  const d = tmp('presets-real');
  for (const f of ['scene-default-h.json', 'scene-default-v.json']) copyFileSync(path.join(PRESETS, f), path.join(d, f));
  const bindings = matchRoles({ list: LIST, presets: devicePresets });
  for (const flags of [{ 'layer-effects': true }, {}]) {
    const { project } = buildAlphaProject({ presetsDir: d, profile: PROFILE, bindings, devicesListed: true, flags });
    assert.ok(validateProject(project).ok, JSON.stringify(validateProject(project).errors));
    const layers = project.scenes[0].layers;
    const byId = new Map(layers.map((l) => [l.id, l]));
    for (const l of layers.filter((x) => x.type === 'duplicate')) assert.equal(byId.get(l.source.layer).type, 'capture', l.name);
    const bds = layers.filter((l) => l.effects?.some((e) => e.type === 'blur'));
    assert.equal(bds.length, 2, 'one backdrop per canvas');
    for (const [canvas, strength] of [['h', 71], ['v', 40]]) {
      const bd = bds.find((l) => l.placements[canvas]);
      assert.ok(byId.get(bd.source.layer).placements.h, 'points at the H game capture layer');
      assert.equal(bd.placements[canvas].visible, true);
      assert.deepEqual(bd.effects, [{ type: 'blur', strength }]);
      assert.equal(layers.find((l) => l.placements[canvas]), bd, `${canvas}: backdrop is the bottom layer of its canvas`);
    }
    assert.ok(!layers.some((l) => /\/background$/.test(l.origin?.id ?? '')), 'no browser background');
  }
});

test('alpha build without the card audio input: the capture layer audio is the Game channel (CUE late, still on)', () => {
  const list = listWith(LIST.devices.filter((d) => !d.name.includes('Live Gamer Ultra 2.1-Audio')));
  const { project } = buildAlphaProject({ presetsDir: presetsDir({ v: true }), profile: PROFILE, bindings: matchRoles({ list, presets: devicePresets }), devicesListed: true });
  const game = project.audio.sources.find((s) => s.id === 'aud-game');
  assert.ok(game.layer);
  assert.equal(game.monitoring, 'monitor-and-output');
});

test('alpha build: a missing profile placeholder fails by key name before anything is saved', () => {
  const dataDir = tmp('missing');
  const build = async () => buildAlphaProject({ presetsDir: presetsDir(), profile: {} }).project;
  return assert.rejects(prepareAlphaProject({ dataDir, build }), /profile is missing placeholder key\(s\): handles\.kick, handles\.twitch, handles\.youtube, links\.discord$/)
    .then(() => assert.equal(existsSync(alphaFile(dataDir)), false));
});

test('alpha build: brand asset files missing from the profile are placeholders and a warning, not a failure (D166)', () => {
  const noAssets = { ...PROFILE, brand: {} };
  const r = buildAlphaProject({ presetsDir: presetsDir(), profile: noAssets });
  assert.ok(r.report.warnings.some((w) => /brand\.character, brand\.wordmark: those layers are transparent placeholders/.test(w)));
});

test('alpha project: an existing file is loaded unchanged; --rebuild-alpha moves it to _old first', async () => {
  const dataDir = tmp('keep');
  const dir = presetsDir();
  const build = async () => buildAlphaProject({ presetsDir: dir, profile: PROFILE }).project;
  const a = await prepareAlphaProject({ dataDir, build });
  assert.equal(a.action, 'built');
  const edited = JSON.parse(readFileSync(a.file, 'utf8'));
  edited.name = 'Edited by the user';
  writeFileSync(a.file, JSON.stringify(edited, null, 2));
  const before = readFileSync(a.file);
  let built = 0;
  const b = await prepareAlphaProject({ dataDir, build: async () => { built++; return build(); } });
  assert.equal(b.action, 'loaded');
  assert.equal(built, 0, 'no build when the file exists');
  assert.deepEqual(readFileSync(a.file), before, 'byte for byte unchanged');
  // a failed rebuild leaves the file in place
  await assert.rejects(prepareAlphaProject({ dataDir, rebuild: true, build: async () => { throw new Error('boom'); } }), /boom/);
  assert.deepEqual(readFileSync(a.file), before);
  const c = await prepareAlphaProject({ dataDir, rebuild: true, build, now: new Date('2026-11-03T10:00:00Z') });
  assert.equal(c.action, 'rebuilt');
  assert.equal(path.basename(c.moved), 'alpha-2026-11-03T10-00-00-000Z.project.json');
  assert.deepEqual(readFileSync(c.moved), before, 'the old file is moved, not rewritten');
  assert.notEqual(JSON.parse(readFileSync(c.file, 'utf8')).name, 'Edited by the user');
});

test('alpha bases: profile assets dir from paths.profile_assets, else the overlay root', () => {
  const ov = tmp('ov');
  const pa = tmp('pa');
  assert.deepEqual(alphaBases({ profile: {}, overlayRoot: ov, assetsDefault: null }), { profile: ov });
  assert.deepEqual(alphaBases({ profile: { paths: { profile_assets: pa } }, overlayRoot: ov, assetsDefault: null }), { profile: pa });
  assert.deepEqual(alphaBases({ profile: {}, overlayRoot: path.join(ov, 'missing'), assetsDefault: null }), {});
});

test('alpha bases: media = paths.stream_assets, else the default folder when it exists (D241)', () => {
  const ov = tmp('ov2');
  const sa = tmp('sa');
  const def = tmp('def');
  assert.deepEqual(alphaBases({ profile: { paths: { stream_assets: sa } }, overlayRoot: ov, assetsDefault: def }), { profile: ov, media: sa });
  assert.deepEqual(alphaBases({ profile: {}, overlayRoot: ov, assetsDefault: def }), { profile: ov, media: def });
  assert.deepEqual(alphaBases({ profile: { paths: { stream_assets: 'relative' } }, overlayRoot: ov, assetsDefault: path.join(def, 'missing') }), { profile: ov });
});

// ---- launcher wiring

// An overlay root holds overlays/ (overlayRootProblem); a root without it turns overlays off.
const OV_ROOT = mkdtempSync(path.join(os.tmpdir(), 'ujw-alpha-ov-'));
mkdirSync(path.join(OV_ROOT, 'overlays'), { recursive: true });
test.after(() => rmSync(OV_ROOT, { recursive: true, force: true }));
const CFG = { runtime: 'C:/rt', dataDir: 'C:/hd', recordings: 'C:/hd/rec', overlayRoot: OV_ROOT, overlayScript: path.join(REPO, 'app', 'host', 'overlay', 'child.mjs') };
const TOKEN = 'a'.repeat(64);
const SYS = 'b'.repeat(64);
const HCF = path.join(REPO, 'x', 'host-config.json');

test('launch spec: studio mode keeps the test card and adds nothing', () => {
  const s = hostLaunchSpec({ hostCfg: CFG, hostDiscovery: 'C:/d/host.json', args: { live: true }, alpha: false, corePort: 1234, coreApiToken: TOKEN, hostConfigFile: HCF, coreSystemToken: SYS });
  assert.ok(s.argv.includes('--project'));
  for (const f of ['--preview', '--allow-browser', '--overlay-root', '--overlay-events-url', '--allow-devices', '--host-config', '--allow-live']) assert.ok(!s.argv.includes(f), f);
  assert.deepEqual(s.env, {});
});

test('launch spec: headless (UJWALAM_HEADLESS=1) starts the alpha host without previews (D191)', () => {
  const s = hostLaunchSpec({ hostCfg: CFG, hostDiscovery: 'C:/d/host.json', args: {}, alpha: true, corePort: 1234, coreApiToken: TOKEN, hostConfigFile: HCF, coreSystemToken: SYS, headless: true });
  assert.ok(!s.argv.includes('--preview'));
  assert.ok(s.argv.includes('--allow-browser'), 'everything else is as in a normal start');
  assert.ok(s.notes.some((n) => /headless/.test(n)));
});

test('headless: only UJWALAM_BROWSER = this Node (a login script) gets the login URL, never a browser (D191, F2)', () => {
  assert.equal(headlessLoginScript({}), false);
  assert.equal(headlessLoginScript({ UJWALAM_BROWSER: 'C:/Program Files/Google/Chrome/Application/chrome.exe' }), false);
  assert.equal(headlessLoginScript({ UJWALAM_BROWSER: process.execPath }), true);
  assert.equal(headlessLoginScript({ UJWALAM_BROWSER: process.execPath.toUpperCase() }), true, 'Windows paths compare case-insensitively');
});

test('launch spec: alpha mode wires previews, browser layers, overlay child and the event feed; token by env only', () => {
  const s = hostLaunchSpec({ hostCfg: CFG, hostDiscovery: 'C:/d/host.json', args: { 'allow-devices': true }, alpha: true, corePort: 1234, coreApiToken: TOKEN, hostConfigFile: HCF, coreSystemToken: SYS, headless: false });
  const after = (f) => s.argv[s.argv.indexOf(f) + 1];
  assert.match(after('--project'), /test-card\.project\.json$/, 'the test card gives the V canvas the start-up preview needs');
  assert.equal(after('--preview'), 'h,v');
  const emb = hostLaunchSpec({ hostCfg: CFG, hostDiscovery: 'C:/d/host.json', args: {}, alpha: true, corePort: 1234, coreApiToken: TOKEN, hostConfigFile: HCF, coreSystemToken: SYS, headless: false, embedded: true });
  assert.ok(!emb.argv.includes('--preview'), 'Qt shell: previews inside its window, no separate preview windows (D280)');
  assert.ok(s.argv.includes('--allow-browser'));
  assert.ok(s.argv.includes('--allow-devices'));
  assert.equal(after('--overlay-root'), OV_ROOT);
  assert.match(after('--overlay-script'), /app[\\/]host[\\/]overlay[\\/]child\.mjs$/);
  assert.equal(after('--node'), process.execPath);
  assert.equal(after('--overlay-events-url'), 'http://127.0.0.1:1234/events');
  assert.equal(after('--host-config'), HCF);
  assert.ok(!s.argv.includes('--allow-live'), 'no real targets without --live');
  assert.deepEqual(s.env, { UJWALAM_EVENT_CORE_API_TOKEN: TOKEN, UJWALAM_EVENT_CORE_SYSTEM_TOKEN: SYS });
  assert.ok(!s.argv.some((a) => a.includes(TOKEN) || a.includes(SYS)));
  assert.deepEqual(s.notes, []);
  const noRoot = hostLaunchSpec({ hostCfg: { ...CFG, overlayRoot: path.join(REPO, 'no-such-dir') }, hostDiscovery: 'x', args: {}, alpha: true, corePort: 1234, coreApiToken: TOKEN, headless: false });
  assert.ok(!noRoot.argv.includes('--allow-browser'));
  assert.ok(!noRoot.argv.includes('--host-config'));
  assert.deepEqual(noRoot.env, {});
  assert.match(noRoot.notes[0], /overlay root not found/);
  assert.ok(noRoot.notes.some((n) => /no host config: hotkeys and the replay buffer stay off/.test(n)));
  assert.ok(noRoot.notes.some((n) => /no event-core system token/.test(n)));
  const bad = hostLaunchSpec({ hostCfg: CFG, hostDiscovery: 'x', args: {}, alpha: true, corePort: 1234, coreApiToken: TOKEN, hostConfigFile: 'relative.json', coreSystemToken: 'not-hex' });
  assert.ok(!bad.argv.includes('--host-config'), 'a relative host config path is not passed (the host wants absolute paths)');
  assert.ok(!Object.hasOwn(bad.env, 'UJWALAM_EVENT_CORE_SYSTEM_TOKEN'));
  const live = hostLaunchSpec({ hostCfg: CFG, hostDiscovery: 'x', args: { live: true }, alpha: true, corePort: 1234, coreApiToken: TOKEN, hostConfigFile: HCF, coreSystemToken: SYS });
  assert.ok(live.argv.includes('--allow-live'));
});

test('host config: day-2 keys only (hotkeys on, replay 60 s autostart, feedback folder, event-core system file); written owner-only', () => {
  const d = tmp('hcfg');
  const c = alphaHostConfig({ dataDir: d });
  assert.deepEqual(Object.keys(c).sort(), ['$comment', 'audio', 'audioHealth', 'eventCore', 'feedbackDir', 'hotkeys', 'replay']);
  assert.deepEqual(c.replay, { seconds: 60, autoStart: true });
  assert.deepEqual(c.hotkeys, { enabled: true });
  assert.deepEqual(c.audio, { lowLatency: true });
  // audio health watchdog (D297 proposed): the numbers come from data/audio/health.json, never from code
  const ah = JSON.parse(readFileSync(path.join(REPO, 'data', 'audio', 'health.json'), 'utf8'));
  assert.deepEqual(c.audioHealth, { enabled: ah.enabled, noDataMs: ah.noDataMs, checkIntervalMs: ah.checkIntervalMs, maxRecreates: ah.maxRecreates, maxParked: ah.maxParked, shutdownGuardMs: ah.shutdownGuardMs });
  assert.deepEqual(loadAudioHealth(), c.audioHealth);
  const bad = path.join(d, 'health-bad.json');
  writeFileSync(bad, JSON.stringify({ source: 'x', enabled: true, noDataMs: 5000 }));
  assert.throws(() => loadAudioHealth(bad), /checkIntervalMs is required/);
  assert.equal(c.feedbackDir, DEFAULT_FEEDBACK_DIR);
  assert.equal(DEFAULT_FEEDBACK_DIR, path.join(REPO, 'feedback'), 'repo-root feedback/ (gitignored), the UI form default');
  assert.equal(c.eventCore.systemFile, path.join(d, 'system.json'));
  assert.equal(alphaHostConfig({ dataDir: d, feedbackDir: path.join(d, 'fb') }).feedbackDir, path.join(d, 'fb'));
  assert.equal(c.monitoringDevice, undefined, 'no monitoring output: the Windows default');
  assert.equal(alphaHostConfig({ dataDir: d, monitoringOutput: 'Out 1' }).monitoringDevice, 'Out 1');
  for (const p of [c.feedbackDir, c.eventCore.systemFile]) assert.ok(path.isAbsolute(p));
  const f = writeHostConfig(d, c);
  assert.equal(f, path.join(d, 'host-config.json'));
  assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), c);
  assert.ok(!/[0-9a-f]{32}/.test(readFileSync(f, 'utf8')), 'no token-shaped value in the host config');
  writeHostConfig(d, { ...c, replay: { seconds: 30, autoStart: false } });
  assert.equal(JSON.parse(readFileSync(f, 'utf8')).replay.autoStart, false, 'rewritten at every start');
  assert.equal(readdirSync(d).filter((n) => n.endsWith('.tmp')).length, 0);
  rmSync(d, { recursive: true, force: true });
});

test('hotkey overrides: --hotkey-<name> COMBO or off; anything else refused', () => {
  assert.deepEqual(hotkeyOverrides({}), { overrides: {}, problems: [] });
  const ok = hotkeyOverrides({ 'hotkey-marker': 'Ctrl+Alt+Shift+M', 'hotkey-panic': 'off', 'hotkey-other': 'x' });
  assert.deepEqual(ok, { overrides: { marker: 'Ctrl+Alt+Shift+M', panic: null }, problems: [] });
  assert.deepEqual(alphaHostConfig({ dataDir: REPO, hotkeys: ok.overrides }).hotkeys, { enabled: true, marker: 'Ctrl+Alt+Shift+M', panic: null });
  for (const v of [true, '', 'Ctrl+Alt+', '../x', 'Ctrl Alt M', 'a+b+c+d+e+f', 'C'.repeat(41)]) {
    assert.equal(hotkeyOverrides({ 'hotkey-feedback': v }).problems.length, 1, JSON.stringify(v));
  }
});

test('launcher flags: --live is alpha only and excludes --outputs; the probe needs --no-open (nothing is started)', async () => {
  const d = tmp('flags');
  const logs = [];
  const orig = console.log;
  console.log = (s) => logs.push(String(s));
  try {
    assert.equal(await launchMain(['--data-dir', d, '--live']), 2);
    assert.equal(await launchMain(['--data-dir', d, '--alpha', '--live', '--outputs', 'x.json']), 2);
    assert.equal(await launchMain(['--data-dir', d, '--alpha', '--feedback-dir']), 2);
    process.env.UJWALAM_ALPHA_FEEDBACK_PROBE = '1';
    assert.equal(await launchMain(['--data-dir', d, '--alpha']), 2);
  } finally {
    delete process.env.UJWALAM_ALPHA_FEEDBACK_PROBE;
    console.log = orig;
  }
  assert.match(logs.join('\n'), /--live is for the alpha session only/);
  assert.match(logs.join('\n'), /do not also give --outputs/);
  assert.match(logs.join('\n'), /needs --alpha and --no-open/);
  assert.ok(existsSync(ALPHA_LIVE_PLAN));
  assert.deepEqual(readdirSync(d), [], 'refused before anything was written');
  rmSync(d, { recursive: true, force: true });
});

test('host logs: one file per run, the newest 10 are kept', () => {
  const d = tmp('logs');
  for (let i = 0; i < 12; i++) writeFileSync(path.join(d, `host-2026-11-0${i < 10 ? '1' : '2'}T00-00-${String(i).padStart(2, '0')}-000Z.log`), 'x');
  writeFileSync(path.join(d, 'other.log'), 'x');
  const { file, fd } = openHostLog(d, { now: new Date('2026-11-03T00:00:00Z') });
  closeSync(fd);
  const left = readdirSync(d).filter((n) => n.startsWith('host-')).sort();
  assert.equal(left.length, 10);
  assert.equal(left.at(-1), path.basename(file));
  assert.ok(existsSync(path.join(d, 'other.log')));
});

// End to end with the fake host: event core (--mock), the fake host, the UI server; stopped through stdin.
function runLauncher(extra, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(REPO, 'services', 'studio-ui', 'launch.mjs'), '--alpha', '--mock', '--no-open', '--stop-on-stdin', ...extra], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    const t = setTimeout(() => { child.kill(); reject(new Error(`launcher timed out:\n${out}`)); }, 90_000);
    // Stop after the overlay feed line (UJWALAM_ALPHA_STATS_MS makes it come right after the UI line) and, with the
    // feedback probe, after its line.
    const done = () => /\[studio\] overlay feed /.test(out) && (env.UJWALAM_ALPHA_FEEDBACK_PROBE !== '1' || /\[studio\] feedback probe/.test(out));
    child.stdout.on('data', (d) => { out += d; if (done()) child.stdin.end(); });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => { clearTimeout(t); resolve({ code, out }); });
  });
}

test('launcher --alpha with a fake host: flags, tokens by env, host config, feedback probe, project built then kept, devices only on rebuild, --live plan', { timeout: 300_000 }, async () => {
  const root = tmp('e2e');
  const dataDir = path.join(root, 'core');
  const ov = path.join(root, 'overlays-root');
  mkdirSync(path.join(ov, 'overlays'), { recursive: true });
  const rec = path.join(root, 'record.json');
  const profile = path.join(root, 'profile.json');
  const assets = path.join(root, 'assets');
  mkdirSync(assets, { recursive: true });
  writeFileSync(profile, JSON.stringify({ ...PROFILE, paths: { ...PROFILE.paths, stream_assets: assets } }));
  const env = {
    UJWALAM_OBS_RUNTIME: root, UJWALAM_HOST_DATA: path.join(root, 'host'), UJWALAM_OVERLAY_ROOT: ov,
    UJWALAM_FAKE_HOST_RECORD: rec, UJWALAM_FAKE_HOST_DEVICES: path.join(FIX, 'project', 'devices-list.fixture.json'),
    UJWALAM_ALPHA_STATS_MS: '300',
    UJWALAM_HEADLESS: '0', // the fake host opens no window; this run checks the argv of a normal (non-headless) start
  };
  const fb = path.join(root, 'feedback');
  const base = ['--data-dir', dataDir, '--host-exe', path.join(FIX, 'studio-ui', 'fake-host.mjs'), '--profile', profile, '--feedback-dir', fb];
  try {
    // 1. first run, no devices: builds alpha.project.json; day-2 host config; one feedback probe through the UI server
    let r = await runLauncher(base, { ...env, UJWALAM_ALPHA_FEEDBACK_PROBE: '1', UJWALAM_ALPHA_FEEDBACK_PROBE_WAIT_MS: '0' });
    assert.equal(r.code, 0, r.out);
    let h = JSON.parse(readFileSync(rec, 'utf8'));
    const after = (f) => h.argv[h.argv.indexOf(f) + 1];
    assert.equal(after('--host-config'), path.join(dataDir, 'host-config.json'));
    assert.deepEqual(h.hostConfig.hotkeys, { enabled: true });
    assert.deepEqual(h.hostConfig.replay, { seconds: 60, autoStart: true });
    assert.equal(h.hostConfig.feedbackDir, fb);
    assert.equal(h.hostConfig.eventCore.systemFile, path.join(dataDir, 'system.json'));
    assert.equal(h.systemTokenOk, true, 'the event-core system token reached the host by environment');
    assert.equal(h.systemTokenInArgv, false);
    assert.equal(h.systemTokenIsApiToken, false);
    // D281: without --live and --outputs the alpha start gets the record-only plan (H + V .mkv), never a real target.
    assert.ok(!h.argv.includes('--allow-live'), 'no real targets without --live');
    assert.deepEqual(h.outputsParams.sinks.map((s) => [s.id, s.target.transport]), [['practice-h', 'file'], ['practice-v', 'file']]);
    assert.match(r.out, /\[studio\] record plan: data[\\/]outputs[\\/]alpha-practice\.json \(Record saves H and V \.mkv/);
    assert.match(r.out, /\[studio\] outputs: real targets off; 2 sink\(s\)/);
    assert.match(r.out, /\[studio\] hotkeys: on; panic Ctrl\+Alt\+P registered; feedback Ctrl\+Alt\+F registered; marker Ctrl\+Alt\+M registered/);
    assert.match(r.out, /\[studio\] replay buffer: on, 60 s; H running \(fallback rung\); V running \(fallback rung\)/);
    assert.match(r.out, /\[studio\] feedback probe: moment \d{4}-\d{2}-\d{2}\/\d{6} listed by the UI server \(1 moment\(s\), HTTP 200\); replay files: replay-H\.mkv, replay-V\.mkv; scene: H: scene-default, V: scene-default; at: \d{4}-/);
    assert.ok(h.calls.includes('feedback.capture') && h.calls.includes('feedback.status'));
    assert.ok(!/[0-9a-f]{64}/.test(r.out), 'no token-shaped value printed');
    assert.equal(after('--preview'), 'h,v');
    assert.ok(h.argv.includes('--allow-browser'));
    assert.equal(after('--overlay-root'), ov);
    assert.match(after('--overlay-events-url'), /^http:\/\/127\.0\.0\.1:\d+\/events$/);
    assert.ok(!h.argv.includes('--allow-devices'));
    assert.ok(!h.calls.includes('preview.open'), 'both previews were open from the start');
    assert.equal(h.eventTokenOk, true, 'the event-core token reached the host by environment');
    assert.equal(h.eventTokenInArgv, false);
    assert.equal(h.hostTokenInArgv, false);
    assert.equal(h.markersTokenOk, true, 'the host got the markers token (F6 live markers) by environment');
    assert.equal(h.markersTokenInArgv, false);
    assert.equal(h.markersTokenIsApiToken, false, 'the markers token is a separate token');
    assert.equal(h.clipsTokenOk, true, 'the host got the clips token (live clipper) by environment');
    assert.equal(h.clipsTokenInArgv, false);
    assert.equal(h.clipsTokenIsOtherToken, false, 'the clips token is a separate token');
    assert.ok(!h.calls.includes('devices.list'), 'no device listing without --allow-devices');
    assert.equal(h.load.skipUnavailable, true);
    assert.equal(h.load.captureLayers, 0);
    assert.ok(h.load.browserLayers > 0 && h.load.browserUrls === h.load.browserLayers && h.load.urlsOk, JSON.stringify(h.load));
    assert.deepEqual(h.load.bases, ['media', 'profile'], 'the stream assets folder from the profile is the media base');
    assert.match(r.out, /alpha project built/);
    assert.match(r.out, /overlay server: ready; event feed: on; child has the event token: yes; browser layers allowed/);
    assert.match(r.out, /overlay feed after 0 s: 3 overlay page\(s\) connected, 7 chat and 2 event frame\(s\) delivered, 0 effect\(s\)/);
    assert.ok(h.calls.includes('overlay.stats'));
    const file = alphaFile(dataDir);
    const first = readFileSync(file);
    const logs = readdirSync(path.join(dataDir, 'logs')).filter((n) => /^host-.*\.log$/.test(n));
    assert.equal(logs.length, 1);
    assert.match(readFileSync(path.join(dataDir, 'logs', logs[0]), 'utf8'), /fake host: rpc on 127\.0\.0\.1:/);

    // 2. --allow-devices on a project built without devices: rebuilt with devices, the old one kept in _old (D282)
    r = await runLauncher([...base, '--allow-devices'], env);
    assert.equal(r.code, 0, r.out);
    h = JSON.parse(readFileSync(rec, 'utf8'));
    assert.ok(h.argv.includes('--allow-devices'));
    assert.ok(h.calls.includes('devices.list'));
    assert.match(r.out, /built without devices: rebuilding it with devices/);
    assert.match(r.out, /alpha project rebuilt/);
    const olds = () => readdirSync(path.join(dataDir, 'projects', '_old')).filter((n) => n.endsWith('.project.json'));
    assert.equal(olds().length, 1);
    assert.deepEqual(readFileSync(path.join(dataDir, 'projects', '_old', olds()[0])), first, 'the no-devices project is kept, unchanged');
    // a project built with devices is loaded as it is on the next start with devices
    const withDevices = readFileSync(file);
    r = await runLauncher([...base, '--allow-devices'], env);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /alpha project loaded/);
    assert.deepEqual(readFileSync(file), withDevices);

    // 3. --allow-devices --rebuild-alpha: old file to _old, roles bound from the fixture devices.list
    r = await runLauncher([...base, '--allow-devices', '--rebuild-alpha'], env);
    assert.equal(r.code, 0, r.out);
    h = JSON.parse(readFileSync(rec, 'utf8'));
    assert.ok(h.calls.includes('devices.list'));
    assert.equal(h.load.captureLayers, 2);
    assert.match(r.out, /alpha project rebuilt/);
    assert.match(r.out, /role game-capture: bound \(preset device-live-gamer-ultra-21\)/);
    assert.equal(olds().length, 2);
    assert.ok(!/Live Gamer Ultra 2\.1-Video|fixture-1/.test(r.out), 'device names and paths are not printed');
    assert.equal(readdirSync(path.join(dataDir, 'logs')).filter((n) => /^host-.*\.log$/.test(n)).length, 4);

    // 4. --live: the alpha-live plan (Credential Manager target names only) and --allow-live; per sink presence
    //    printed, never a key or a per-account URL. The fake host contacts nothing.
    r = await runLauncher([...base, '--live'], env);
    assert.equal(r.code, 0, r.out);
    h = JSON.parse(readFileSync(rec, 'utf8'));
    assert.ok(h.argv.includes('--allow-live'));
    assert.equal(h.argv[h.argv.indexOf('--outputs') + 1], path.join(root, 'host', 'outputs-params.json'));
    assert.deepEqual(h.outputsParams.sinks.map((s) => s.id), ['youtube-h', 'youtube-v', 'twitch', 'kick', 'record', 'record-v']);
    for (const s of h.outputsParams.sinks) assert.ok(!Object.hasOwn(s.target, 'key'), `${s.id}: no key field`);
    // Twitch "auto" (D309 proposed): a stand-in (script) host reaches no platform, so no server address is read.
    assert.equal(h.outputsParams.sinks.find((s) => s.id === 'twitch').target.transport, 'auto');
    assert.match(r.out, /outputs: twitch transport "auto" not chosen \(stand-in host: no server address read\)/);
    assert.match(r.out, /LIVE plan: data[\\/]outputs[\\/]alpha-live\.json/);
    assert.match(r.out, /\[studio\] outputs: real targets ALLOWED \(--live\); 6 sink\(s\)/); // LC1: + record-v
    assert.match(r.out, /sink youtube-h: youtube live, keyPresent no, idle/);
    assert.match(r.out, /sink twitch: twitch live, keyPresent no, urlPresent no, idle/);
    assert.match(r.out, /sink kick: kick live, keyPresent no, urlPresent no, idle/);
    assert.match(r.out, /sink record: record mkv, idle/);
    assert.ok(!/rtmps?:\/\//.test(r.out), 'no ingest URL printed');
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('roles: the capture-card preset asks for 1920x1080@60 and the alpha project carries it (2026-11-06: card opened at 720p, layers stretched)', () => {
  const r = matchRoles({ list: LIST, presets: devicePresets });
  assert.deepEqual(r.bound['game-capture'].format, { width: 1920, height: 1080, fps: 60 });
  assert.equal(r.bound.facecam.format, null, 'no format in the preset: device default');
  const { project } = buildAlphaProject({ presetsDir: presetsDir({ v: true }), profile: PROFILE, bindings: r, devicesListed: true });
  const card = project.devices.find((d) => d.origin?.id === 'role/game-capture');
  assert.deepEqual(card.format, { width: 1920, height: 1080, fps: 60 });
  assert.equal('format' in project.devices.find((d) => d.origin?.id === 'role/facecam'), false);
  assert.equal(validateProject(project).ok, true);
});

test('open browser: cmd line is start "" "<url>" for a loopback URL; anything else is refused (2026-11-06: no browser opened)', () => {
  assert.equal(startCommandLine('http://127.0.0.1:5000/login?k=abc123'), '"start "" "http://127.0.0.1:5000/login?k=abc123""');
  for (const bad of ['http://127.0.0.1:5000/x&calc', 'http://127.0.0.1:5000/"x', 'https://example.com/', 'http://127.0.0.1:5000/%PATH%', null]) assert.equal(startCommandLine(bad), null, String(bad));
});

test('shell choice (D277): the Qt shell by default, --shell browser opts out, anything else refused', () => {
  assert.equal(shellChoice({}), 'qt');
  assert.equal(shellChoice({ shell: 'qt' }), 'qt');
  assert.equal(shellChoice({ shell: 'browser' }), 'browser');
  assert.equal(shellChoice({ shell: true }), null, '--shell with no value');
  assert.equal(shellChoice({ shell: 'web' }), null);
});

test('Qt shell spawn spec: URL and launch key by env only, every token/key variable stripped, Qt bin first on PATH', () => {
  const env = { Path: 'C:/x', UJWALAM_HOST_TOKEN: 'h', UJWALAM_EVENT_CORE_API_TOKEN: 'a', UJWALAM_HOST_MARKERS_TOKEN: 'm', UJWALAM_UI_LAUNCH_KEY: 'old', OTHER: '1' };
  const s = shellSpawnSpec({ uiPort: 5000, launchKey: 'K'.repeat(40), exe: 'C:/studio.exe', qtBin: path.join('C:/qt', 'bin'), env, exists: () => true });
  assert.equal(s.cmd, 'C:/studio.exe');
  assert.equal(s.env.UJWALAM_UI_URL, 'http://127.0.0.1:5000/');
  assert.equal(s.env.UJWALAM_UI_LAUNCH_KEY, 'K'.repeat(40));
  for (const k of ['UJWALAM_HOST_TOKEN', 'UJWALAM_EVENT_CORE_API_TOKEN', 'UJWALAM_HOST_MARKERS_TOKEN']) assert.equal(k in s.env, false, k);
  assert.equal(s.env.OTHER, '1');
  assert.ok(s.env.Path.startsWith(path.join('C:/qt', 'bin')));
  assert.equal('QT_QPA_PLATFORM_PLUGIN_PATH' in s.env, false, 'dev kit finds its own plugins');
  const p = shellSpawnSpec({ uiPort: 5000, launchKey: 'k', exe: 'C:/u/bin/s.exe', qtBin: 'C:/u/obs/bin/64bit', qtPlugins: 'C:/u/obs/bin/64bit/platforms', env: { PATH: 'C:/x' }, exists: () => true });
  assert.ok(p.env.PATH.startsWith(`C:/u/obs/bin/64bit${path.delimiter}`), 'packaged: OBS Qt folder itself, no /bin appended');
  assert.equal(p.env.QT_QPA_PLATFORM_PLUGIN_PATH, 'C:/u/obs/bin/64bit/platforms');
  assert.equal(shellSpawnSpec({ uiPort: 5000, launchKey: 'k', exe: 'C:/none.exe', exists: () => false }), null, 'not built');
  assert.equal(shellSpawnSpec({ uiPort: 0, launchKey: 'k', exe: 'C:/studio.exe', exists: () => true }), null, 'bad port');
});

test('Qt shell spawn spec: the log folder and the version for the studio log and crash report (2026-11-08 crash)', () => {
  const s = shellSpawnSpec({ uiPort: 5000, launchKey: 'K'.repeat(40), exe: 'C:/studio.exe', logsDir: 'C:/d/core/logs', version: '0.1.0-alpha.9', env: { PATH: 'C:/x', UJWALAM_STUDIO_LOG_DIR: 'old' }, exists: () => true });
  assert.equal(s.env.UJWALAM_STUDIO_LOG_DIR, 'C:/d/core/logs');
  assert.equal(s.env.UJWALAM_STUDIO_VERSION, '0.1.0-alpha.9');
  const n = shellSpawnSpec({ uiPort: 5000, launchKey: 'K'.repeat(40), exe: 'C:/studio.exe', env: { PATH: 'C:/x' }, exists: () => true });
  assert.equal('UJWALAM_STUDIO_LOG_DIR' in n.env, false, 'no folder: the studio writes nothing');
  assert.equal(releaseVersion(path.join(os.tmpdir(), 'no-such-release.json')), 'dev');
});

test('Qt shell spawn spec: the Qt Quick window only when asked (flag studio-qml, D355), never from the inherited env', () => {
  const base = { uiPort: 5000, launchKey: 'K'.repeat(40), exe: 'C:/studio.exe', exists: () => true };
  assert.equal(shellSpawnSpec({ ...base, qml: true, env: { PATH: 'C:/x' } }).env.UJWALAM_STUDIO_QML, '1');
  assert.equal('UJWALAM_STUDIO_QML' in shellSpawnSpec({ ...base, env: { PATH: 'C:/x', UJWALAM_STUDIO_QML: '1' } }).env, false, 'flag off');
});

test('Qt shell exit record: code as hex, crash flag, the crash report written since the start (studio-exits.jsonl)', () => {
  const startedAt = Date.parse('2026-11-08T18:54:00.000Z');
  const now = Date.parse('2026-11-08T19:20:35.000Z');
  const reports = ['studio-crash-2026-11-08T12-00-00-000Z-p1.txt', 'studio-crash-2026-11-08T19-20-34-900Z-p7.txt'];
  const r = shellExitRecord({ code: 3221225477, startedAt, now, reports });
  assert.deepEqual(r, { at: '2026-11-08T19:20:35.000Z', code: 3221225477, codeHex: '0xc0000005', signal: null, crash: true, upMs: now - startedAt, report: 'studio-crash-2026-11-08T19-20-34-900Z-p7.txt' });
  const ok = shellExitRecord({ code: 0, startedAt, now, reports: reports.slice(0, 1) });
  assert.deepEqual([ok.crash, ok.codeHex, ok.report], [false, '0x00000000', null], 'an older report is not this run\'s');
  assert.equal(shellExitRecord({ code: -1073741819, startedAt, now }).codeHex, '0xc0000005', 'a negative NTSTATUS reads the same');
  assert.deepEqual([shellExitRecord({ code: null, signal: 'SIGTERM', startedAt, now }).code, shellExitRecord({ code: null, signal: 'SIGTERM', startedAt, now }).crash], [null, true]);
});
test('Qt shell relaunch after a crash: at most 3 times in 10 min; older crashes do not count', () => {
  const t = 1_000_000_000;
  assert.equal(shellRelaunchAllowed([t], t), true);
  assert.equal(shellRelaunchAllowed([t - 3000, t - 2000, t], t), true, 'third crash: reopened');
  assert.equal(shellRelaunchAllowed([t - 3000, t - 2000, t - 1000, t], t), false, 'fourth crash in 10 min: not reopened');
  assert.equal(shellRelaunchAllowed([t - 11 * 60_000, t - 2000, t - 1000, t], t), true, 'one of them is older than 10 min');
});

test('UI server control line: only "rearm <64 hex>" is understood; the new key logs in once, the old one never again', async () => {
  const { controlLine } = await import('../services/studio-ui/cli.mjs');
  const k2 = 'b'.repeat(64);
  assert.deepEqual(controlLine(`rearm ${k2}\r`), { rearm: k2 });
  for (const bad of ['rearm short', `rearm ${'B'.repeat(64)}`, `rearm ${k2} x`, 'stop', '', `REARM ${k2}`]) assert.equal(controlLine(bad), null, bad);
  const { createStudioServer } = await import('../services/studio-ui/server.mjs');
  const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
  const host = { describe: () => ({ kind: 'fake', available: true }), call: async () => ({}) };
  const k1 = 'a'.repeat(64);
  const srv = createStudioServer({ uiRoot: path.resolve('ui'), core, host, launchKey: k1, limits: { statusPollMs: 60_000 } });
  const { port } = await srv.listen();
  const login = async (k) => (await fetch(`http://127.0.0.1:${port}/login?k=${k}`, { redirect: 'manual' })).status;
  try {
    assert.equal(await login(k1), 302, 'first window logs in');
    assert.equal(await login(k1), 401, 'single use');
    assert.equal(srv.rearmLaunchKey('short'), false);
    assert.equal(srv.rearmLaunchKey(k2), true);
    assert.equal(await login(k1), 401, 'the old key stays dead');
    assert.equal(await login(k2), 302, 'the reopened window logs in with the new key');
    assert.equal(await login(k2), 401, 'the new key is single use too');
  } finally { await srv.close(); }
});
test('Qt shell paths: dev build first, else the self-contained packaged exe in studio/ (D277)', () => {
  const root = path.join('C:', 'inst');
  const dev = path.join('C:', 'repo', 'out', 'studio', 'build', 'ujwalam-studio.exe');
  const pkg = path.join(root, 'studio', 'ujwalam-studio.exe');
  assert.deepEqual(studioShellPaths({ root, devExe: dev, devQtDir: 'C:/qt', exists: (f) => f === dev }), { exe: dev, qtBin: path.join('C:/qt', 'bin'), qtPlugins: null });
  assert.deepEqual(studioShellPaths({ root, devExe: dev, exists: (f) => f === pkg }),
    { exe: pkg, qtBin: null, qtPlugins: null });
  assert.equal(studioShellPaths({ root, devExe: dev, exists: () => false }), null);
});

test('live clipper spec: H game capture layer, GPU venv first, no spec for a placeholder game layer', () => {
  const scene = (game) => ({ scenes: [{ id: 'h', layers: [{ id: 'L1', type: 'color', origin: { id: 'scene-default-h/frame' } }, { id: 'L7', ...game, origin: { id: 'scene-default-h/game' } }] }] });
  const both = () => true;
  const r = liveClipsSpec({ project: scene({ type: 'capture' }), dataDir: 'D', repo: 'R', exists: both });
  assert.equal(r.spec.gpu, true);
  assert.deepEqual(r.spec.argv.slice(1), ['--layer', 'L7', '--data-dir', 'D']);
  const cpu = liveClipsSpec({ project: scene({ type: 'capture' }), dataDir: 'D', repo: 'R', exists: (p) => !p.includes('.venv-gpu') });
  assert.equal(cpu.spec.gpu, false);
  assert.equal(liveClipsSpec({ project: scene({ type: 'color' }), dataDir: 'D', repo: 'R', exists: both }).spec, null);
  assert.equal(liveClipsSpec({ project: { scenes: [] }, dataDir: 'D', repo: 'R', exists: both }).spec, null);
  assert.equal(liveClipsSpec({ project: scene({ type: 'capture' }), dataDir: 'D', repo: 'R', exists: () => false }).spec, null);
  // LC1: plain reasons for the task panel and readiness; a missing live_worker.py is caught before the spawn.
  assert.match(liveClipsSpec({ project: scene({ type: 'color' }), dataDir: 'D', repo: 'R', exists: both }).reason, /game layer has no capture device/);
  assert.match(liveClipsSpec({ project: { scenes: [] }, dataDir: 'D', repo: 'R', exists: both }).reason, /no game layer/);
  assert.match(liveClipsSpec({ project: scene({ type: 'capture' }), dataDir: 'D', repo: 'R', exists: () => false }).reason, /Python is missing/);
  const noWorker = liveClipsSpec({ project: scene({ type: 'capture' }), dataDir: 'D', repo: 'R', exists: (p) => !p.endsWith('live_worker.py') });
  assert.equal(noWorker.spec, null);
  assert.match(noWorker.reason, /live clipper is missing .*live_worker\.py/);
});

test('live clipper exit (Codex review of LC1): restarting while a restart is scheduled, the fifth included; gave-up only after the fifth restarted process stops', () => {
  let view = { state: 'running', reason: null, restarts: 0, maxRestarts: LIVE_CLIPPER_MAX_RESTARTS };
  for (let n = 1; n <= LIVE_CLIPPER_MAX_RESTARTS; n++) {
    const r = clipperExited(view, 1);
    assert.equal(r.restart, true, `exit ${n}: a restart is scheduled`);
    assert.deepEqual([r.view.state, r.view.restarts], ['restarting', n]);
    assert.equal(r.view.reason, 'it stopped (exit 1); restarting in 10 s');
    view = { ...r.view, state: 'running', reason: null }; // the restarted process runs
  }
  const last = clipperExited(view, 3);
  assert.equal(last.restart, false);
  assert.deepEqual([last.view.state, last.view.restarts], ['gave-up', 5]);
  assert.equal(last.view.reason, 'it stopped (exit 3) and was restarted 5 times; restart Ujwalam to try again');
});
