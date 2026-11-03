// SPDX-License-Identifier: GPL-2.0-or-later
// Alpha 0 shell: device role matching, the alpha project build and its never-modify rule, the launcher's host flag
// wiring (fake host, no libobs, no devices, mock Streamer.bot), host log rotation.
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
import { hostLaunchSpec, openHostLog } from '../services/studio-ui/launch.mjs';
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

test('roles: registry presets bind game capture, facecam and mic from an anonymised devices.list', () => {
  assert.equal(devicePresets.length, 4, 'four device presets carry match data');
  const r = matchRoles({ list: LIST, presets: devicePresets });
  assert.deepEqual(r.unavailable, []);
  assert.equal(r.bound['game-capture'].entry, byName('Live Gamer Ultra 2.1-Video'));
  assert.equal(r.bound['game-capture'].preset, 'device-live-gamer-ultra-21');
  assert.equal(r.bound['game-capture'].projectKind, 'capture-card');
  assert.equal(r.bound.facecam.entry, byName('Insta360 Link 2C'), 'the Insta360 Virtual Camera is not taken');
  assert.equal(r.bound.facecam.projectKind, 'camera');
  assert.equal(r.bound.mic.entry.kind, 'audio-input', 'the WASAPI endpoint, not the DirectShow audio entry');
  assert.equal(r.bound.mic.projectKind, 'microphone');
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
  assert.equal(r.unavailable.length, 3);
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
  assert.deepEqual(project.devices.map((d) => d.kind).sort(), ['camera', 'capture-card', 'microphone']);
  const layers = project.scenes[0].layers;
  const caps = layers.filter((l) => l.type === 'capture');
  const dups = layers.filter((l) => l.type === 'duplicate');
  assert.equal(caps.length, 2, 'one capture layer per device');
  assert.equal(dups.length, 2, 'the V copies are duplicates');
  for (const d of dups) {
    assert.ok(caps.some((c) => c.id === d.source.layer));
    assert.deepEqual(Object.keys(d.placements), ['v']);
  }
  for (const c of caps) assert.deepEqual(Object.keys(c.placements), ['h']);
  assert.equal(report.duplicated, 2);
  assert.deepEqual(report.unbound, []);
  assert.deepEqual(project.audio.sources.map((s) => [s.id, s.monitoring, s.tracks[0]]), [['aud-mic', 'off', 'track1'], ['aud-game', 'off', 'track1']]);
});

test('alpha build: a missing profile placeholder fails by key name before anything is saved', () => {
  const dataDir = tmp('missing');
  const build = async () => buildAlphaProject({ presetsDir: presetsDir(), profile: {} }).project;
  return assert.rejects(prepareAlphaProject({ dataDir, build }), /profile is missing placeholder key\(s\): brand\.character/)
    .then(() => assert.equal(existsSync(alphaFile(dataDir)), false));
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
  assert.deepEqual(alphaBases({ profile: {}, overlayRoot: ov }), { profile: ov });
  assert.deepEqual(alphaBases({ profile: { paths: { profile_assets: pa } }, overlayRoot: ov }), { profile: pa });
  assert.deepEqual(alphaBases({ profile: {}, overlayRoot: path.join(ov, 'missing') }), {});
});

// ---- launcher wiring

const CFG = { runtime: 'C:/rt', dataDir: 'C:/hd', recordings: 'C:/hd/rec', overlayRoot: REPO, overlayScript: path.join(REPO, 'app', 'host', 'overlay', 'child.mjs') };
const TOKEN = 'a'.repeat(64);

test('launch spec: studio mode keeps the test card and adds nothing', () => {
  const s = hostLaunchSpec({ hostCfg: CFG, hostDiscovery: 'C:/d/host.json', args: {}, alpha: false, corePort: 1234, coreApiToken: TOKEN });
  assert.ok(s.argv.includes('--project'));
  for (const f of ['--preview', '--allow-browser', '--overlay-root', '--overlay-events-url', '--allow-devices']) assert.ok(!s.argv.includes(f), f);
  assert.deepEqual(s.env, {});
});

test('launch spec: alpha mode wires previews, browser layers, overlay child and the event feed; token by env only', () => {
  const s = hostLaunchSpec({ hostCfg: CFG, hostDiscovery: 'C:/d/host.json', args: { 'allow-devices': true }, alpha: true, corePort: 1234, coreApiToken: TOKEN });
  const after = (f) => s.argv[s.argv.indexOf(f) + 1];
  assert.match(after('--project'), /test-card\.project\.json$/, 'the test card gives the V canvas the start-up preview needs');
  assert.equal(after('--preview'), 'h,v');
  assert.ok(s.argv.includes('--allow-browser'));
  assert.ok(s.argv.includes('--allow-devices'));
  assert.equal(after('--overlay-root'), REPO);
  assert.match(after('--overlay-script'), /app[\\/]host[\\/]overlay[\\/]child\.mjs$/);
  assert.equal(after('--node'), process.execPath);
  assert.equal(after('--overlay-events-url'), 'http://127.0.0.1:1234/events');
  assert.deepEqual(s.env, { UJWALAM_EVENT_CORE_API_TOKEN: TOKEN });
  assert.ok(!s.argv.some((a) => a.includes(TOKEN)));
  const noRoot = hostLaunchSpec({ hostCfg: { ...CFG, overlayRoot: path.join(REPO, 'no-such-dir') }, hostDiscovery: 'x', args: {}, alpha: true, corePort: 1234, coreApiToken: TOKEN });
  assert.ok(!noRoot.argv.includes('--allow-browser'));
  assert.deepEqual(noRoot.env, {});
  assert.match(noRoot.notes[0], /overlay root not found/);
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
    const child = spawn(process.execPath, [path.join(REPO, 'services', 'studio-ui', 'launch.mjs'), '--alpha', '--mock', '--no-open', '--stop-on-stdin', ...extra], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    const t = setTimeout(() => { child.kill(); reject(new Error(`launcher timed out:\n${out}`)); }, 90_000);
    // Stop after the overlay feed line (UJWALAM_ALPHA_STATS_MS makes it come right after the UI line).
    child.stdout.on('data', (d) => { out += d; if (/\[studio\] overlay feed /.test(out)) child.stdin.end(); });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => { clearTimeout(t); resolve({ code, out }); });
  });
}

test('launcher --alpha with a fake host: flags, token by env, project built then kept, devices only on rebuild', { timeout: 300_000 }, async () => {
  const root = tmp('e2e');
  const dataDir = path.join(root, 'core');
  const ov = path.join(root, 'overlays-root');
  mkdirSync(ov, { recursive: true });
  const rec = path.join(root, 'record.json');
  const profile = path.join(root, 'profile.json');
  writeFileSync(profile, JSON.stringify(PROFILE));
  const env = {
    UJWALAM_OBS_RUNTIME: root, UJWALAM_HOST_DATA: path.join(root, 'host'), UJWALAM_OVERLAY_ROOT: ov,
    UJWALAM_FAKE_HOST_RECORD: rec, UJWALAM_FAKE_HOST_DEVICES: path.join(FIX, 'project', 'devices-list.fixture.json'),
    UJWALAM_ALPHA_STATS_MS: '300',
  };
  const base = ['--data-dir', dataDir, '--host-exe', path.join(FIX, 'studio-ui', 'fake-host.mjs'), '--profile', profile];
  try {
    // 1. first run, no devices: builds alpha.project.json
    let r = await runLauncher(base, env);
    assert.equal(r.code, 0, r.out);
    let h = JSON.parse(readFileSync(rec, 'utf8'));
    const after = (f) => h.argv[h.argv.indexOf(f) + 1];
    assert.equal(after('--preview'), 'h,v');
    assert.ok(h.argv.includes('--allow-browser'));
    assert.equal(after('--overlay-root'), ov);
    assert.match(after('--overlay-events-url'), /^http:\/\/127\.0\.0\.1:\d+\/events$/);
    assert.ok(!h.argv.includes('--allow-devices'));
    assert.ok(!h.calls.includes('preview.open'), 'both previews were open from the start');
    assert.equal(h.eventTokenOk, true, 'the event-core token reached the host by environment');
    assert.equal(h.eventTokenInArgv, false);
    assert.equal(h.hostTokenInArgv, false);
    assert.ok(!h.calls.includes('devices.list'), 'no device listing without --allow-devices');
    assert.equal(h.load.skipUnavailable, true);
    assert.equal(h.load.captureLayers, 0);
    assert.ok(h.load.browserLayers > 0 && h.load.browserUrls === h.load.browserLayers && h.load.urlsOk, JSON.stringify(h.load));
    assert.deepEqual(h.load.bases, ['profile']);
    assert.match(r.out, /alpha project built/);
    assert.match(r.out, /overlay server: ready; event feed: on; child has the event token: yes; browser layers allowed/);
    assert.match(r.out, /overlay feed after 0 s: 3 overlay page\(s\) connected, 7 chat and 2 event frame\(s\) delivered, 0 effect\(s\)/);
    assert.ok(h.calls.includes('overlay.stats'));
    const file = alphaFile(dataDir);
    const first = readFileSync(file);
    const logs = readdirSync(path.join(dataDir, 'logs')).filter((n) => /^host-.*\.log$/.test(n));
    assert.equal(logs.length, 1);
    assert.match(readFileSync(path.join(dataDir, 'logs', logs[0]), 'utf8'), /fake host: rpc on 127\.0\.0\.1:/);

    // 2. --allow-devices: the existing project is loaded unchanged, with a warning; devices are not listed
    r = await runLauncher([...base, '--allow-devices'], env);
    assert.equal(r.code, 0, r.out);
    h = JSON.parse(readFileSync(rec, 'utf8'));
    assert.ok(h.argv.includes('--allow-devices'));
    assert.ok(!h.calls.includes('devices.list'));
    assert.deepEqual(readFileSync(file), first);
    assert.match(r.out, /built without devices and is loaded unchanged; add --rebuild-alpha/);

    // 3. --allow-devices --rebuild-alpha: old file to _old, roles bound from the fixture devices.list
    r = await runLauncher([...base, '--allow-devices', '--rebuild-alpha'], env);
    assert.equal(r.code, 0, r.out);
    h = JSON.parse(readFileSync(rec, 'utf8'));
    assert.ok(h.calls.includes('devices.list'));
    assert.equal(h.load.captureLayers, 2);
    assert.match(r.out, /alpha project rebuilt/);
    assert.match(r.out, /role game-capture: bound \(preset device-live-gamer-ultra-21\)/);
    assert.equal(readdirSync(path.join(dataDir, 'projects', '_old')).filter((n) => n.endsWith('.project.json')).length, 1);
    assert.ok(!/Live Gamer Ultra 2\.1-Video|fixture-1/.test(r.out), 'device names and paths are not printed');
    assert.equal(readdirSync(path.join(dataDir, 'logs')).filter((n) => /^host-.*\.log$/.test(n)).length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
});
