// SPDX-License-Identifier: GPL-3.0-or-later
// Pre-stream readiness (D299 proposed, flag `readiness`) and End all streams. Headless: fakes for the host, the
// credential store, the process list, disk, bots and the CI stamp; no device, no real credential, no network beyond
// 127.0.0.1, nothing ever goes live.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFakeHost } from '../services/studio-ui/backends.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';
import { createFlags } from '../services/flags/index.mjs';
import {
  ITEMS, OVERRIDE_LOG, OVERRIDE_PHRASE, createReadiness, readinessDeadlineMs, credentialFacts, loadReadinessConfig, logOverride, planTargets,
  readinessSummary, runReadiness, schemeOf,
} from '../services/studio-ui/readiness.mjs';

process.env.UJWALAM_HEADLESS = '1';
const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const REPO = path.resolve(UI, '..');
const KEY = 'k'.repeat(48);
const GB = 1024 ** 3;
const SECRET_URL = 'rtmp://secret-ingest-zz9.example/app'; // must never appear in any result
const SECRET_KEY = 'live_sk_should_never_show_zz9';
const dirs = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-ready-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const CONFIG = loadReadinessConfig();
const LIVE_SINKS = [
  { id: 'youtube-h', kind: 'stream', platform: 'youtube', transport: 'rtmps', target: 'live', keyRef: 'Ujwalam/stream/youtube-h', keyPresent: true, state: 'idle' },
  { id: 'youtube-v', kind: 'stream', platform: 'youtube', transport: 'rtmps', target: 'live', keyRef: 'Ujwalam/stream/youtube-v', keyPresent: true, state: 'idle' },
  { id: 'twitch', kind: 'stream', platform: 'twitch', transport: 'rtmps', target: 'live', keyRef: 'Ujwalam/stream/twitch', keyPresent: true, urlRef: 'Ujwalam/stream/twitch-server', urlPresent: true, bandwidthTest: false, state: 'idle' },
  { id: 'kick', kind: 'stream', platform: 'kick', transport: 'rtmps', target: 'live', keyRef: 'Ujwalam/stream/kick', keyPresent: true, urlRef: 'Ujwalam/stream/kick-server', urlPresent: true, state: 'idle' },
  { id: 'record', kind: 'record', platform: 'local', state: 'idle' },
];
const store = (values) => (ref) => ({ get: async () => (Object.hasOwn(values, ref) ? values[ref] : null) });
const GOOD_STORE = { 'Ujwalam/stream/twitch-server': 'rtmps://ingest.example/app', 'Ujwalam/stream/kick-server': 'rtmps://kick.example/app' };

// audio: the audio.status answer (default one working source); null = a host without the method.
const OK_AUDIO = { sources: [{ id: 'audio:mic', name: 'Mic', state: 'ok' }] };
function fakeHost({ kind = 'host', sinks = LIVE_SINKS, info = {}, audio = OK_AUDIO, methods = {} } = {}) {
  return {
    calls: [],
    describe: () => ({ kind }),
    async call(m, p) {
      this.calls.push(m);
      if (Object.hasOwn(methods, m)) return methods[m](p);
      if (m === 'host.status') return { live: false };
      if (m === 'outputs.status') return { configured: sinks.length > 0, sinks };
      if (m === 'host.info') return { adapter: 'NVIDIA GeForce RTX 4050 Laptop GPU', gpuPreference: { set: true, gpuPreference: 2 }, recordingsDir: 'C:\\rec', ...info };
      if (m === 'mixer.list') return { sources: [{ id: 'a', name: 'Mic', muted: false, mixers: 1 }] };
      if (m === 'audio.status') {
        if (audio === null) throw Object.assign(new Error('Method not found'), { code: 'RPC_-32601' });
        return audio;
      }
      throw Object.assign(new Error('Method not found'), { code: 'RPC_-32601' });
    },
  };
}
function deps(over = {}) {
  return {
    host: fakeHost(over.hostOpts),
    core: { describe: () => ({ available: true }), call: async () => ({ streamerbot: { state: 'connected' } }) },
    config: over.config ?? CONFIG,
    flagOn: (id) => id === 'live-clips',
    store: store(over.store ?? GOOD_STORE),
    listProcesses: async () => over.procs ?? ['explorer.exe', 'node.exe'],
    diskFree: async () => over.free ?? 200 * GB,
    tcp: async () => over.tcp ?? true,
    botPorts: { streamerbot: 8093, speakerbot: 8083 },
    ciPass: async () => (over.ci === undefined ? { at: new Date(Date.now() - 3_600_000).toISOString() } : over.ci),
    clipTools: () => over.clip ?? { py: 'python.exe', script: 'clipper.py', reason: null },
    planTargets: planTargets(),
    dataDir: null,
    ...(over.audioCheck ? { audioCheck: over.audioCheck } : {}),
  };
}
const byId = (r, id) => r.items.find((i) => i.id === id);

describe('readiness config (data/live/readiness.json)', () => {
  test('the committed file loads and holds every threshold; no threshold is hardcoded in the module', () => {
    assert.ok(CONFIG.disk.failBelowGB > 0 && CONFIG.disk.warnBelowGB >= CONFIG.disk.failBelowGB);
    assert.ok(CONFIG.otherEncoders.some((a) => a.label === 'Meld Studio'));
    assert.equal(CONFIG.gpu.preference, 2);
    const raw = JSON.parse(readFileSync(path.join(REPO, 'data', 'live', 'readiness.json'), 'utf8'));
    for (const k of ['disk', 'otherEncoders', 'bots', 'loopback', 'gpu', 'audio', 'endAll']) assert.equal(typeof raw[k].source, 'string', `${k}.source`);
    const src = readFileSync(path.join(REPO, 'services', 'studio-ui', 'readiness.mjs'), 'utf8');
    for (const n of ['22', '44', 'meldstudio', 'obs64']) assert.ok(!new RegExp(`['"\\s]${n}['"\\s,;)]`).test(src), `module hardcodes ${n}`);
  });
  test('a malformed config is refused', () => {
    const f = path.join(mk(), 'r.json');
    const good = JSON.parse(readFileSync(path.join(REPO, 'data', 'live', 'readiness.json'), 'utf8'));
    writeFileSync(f, JSON.stringify({ ...good, disk: { ...good.disk, warnBelowGB: 1, failBelowGB: 5 } }));
    assert.throws(() => loadReadinessConfig(f), /warnBelowGB/);
    writeFileSync(f, JSON.stringify({ ...good, otherEncoders: { apps: [{ label: 'x', prefixes: ['y'], severity: 'maybe' }] } }));
    assert.throws(() => loadReadinessConfig(f), /severity/);
  });
});

describe('runReadiness', () => {
  test('all good: every item passes, ok, and items come in the fixed order', async () => {
    const r = await runReadiness(deps({ hostOpts: { audio: { sources: [{ id: 'mic', name: 'Mic', state: 'live' }] } } }));
    assert.deepEqual(r.items.map((i) => i.id), [...ITEMS]);
    assert.deepEqual(r.items.filter((i) => i.status !== 'pass').map((i) => `${i.id}: ${i.message}`), []);
    assert.equal(r.ok, true);
    assert.deepEqual(r.counts, { pass: ITEMS.length, warn: 0, fail: 0 });
  });

  test('twitch-server stored as rtmp:// while the plan sends rtmps://: credentials fail, only the scheme is reported', async () => {
    const r = await runReadiness(deps({ store: { ...GOOD_STORE, 'Ujwalam/stream/twitch-server': SECRET_URL } }));
    const c = byId(r, 'credentials');
    assert.equal(c.status, 'fail');
    assert.match(c.message, /Twitch: server address starts with rtmp:\/\/ but this output sends rtmps:\/\//);
    assert.equal(r.ok, false);
    assert.ok(!JSON.stringify(r).includes('secret-ingest'), 'the stored address leaked');
  });

  test('twitch "auto" (D309 proposed): not live, rtmp:// and rtmps:// pass, another scheme or none is a problem naming the allowed schemes', async () => {
    const sinks = LIVE_SINKS.map((s) => (s.kind === 'stream' ? { ...s, target: 'loopback', keyRef: undefined, urlRef: undefined } : s));
    const all = { 'Ujwalam/stream/youtube-h': SECRET_KEY, 'Ujwalam/stream/youtube-v': SECRET_KEY, 'Ujwalam/stream/twitch': SECRET_KEY, 'Ujwalam/stream/kick': SECRET_KEY, ...GOOD_STORE };
    for (const v of ['rtmp://secret-ingest-zz9.example/app', 'rtmps://secret-ingest-zz9.example/app']) {
      assert.equal(byId(await runReadiness(deps({ hostOpts: { sinks }, store: { ...all, 'Ujwalam/stream/twitch-server': v } })), 'credentials').status, 'pass', v);
    }
    for (const [v, starts] of [['https://secret-ingest-zz9.example/app', 'https://'], ['secret-ingest-zz9.example/app', 'no rtmp:// or rtmps://']]) {
      const c = byId(await runReadiness(deps({ hostOpts: { sinks }, store: { ...all, 'Ujwalam/stream/twitch-server': v } })), 'credentials');
      assert.equal(c.status, 'warn');
      assert.ok(c.message.includes(`Twitch (twitch): server address starts with ${starts}, but this output takes only rtmp:// or rtmps://`), c.message);
      assert.ok(!JSON.stringify(c).includes('secret-ingest'), 'the stored address leaked');
    }
  });

  test('twitch "auto" live: an address changed to the other allowed scheme after start says restart; another scheme says what Twitch takes', async () => {
    const c = byId(await runReadiness(deps({ store: { ...GOOD_STORE, 'Ujwalam/stream/twitch-server': SECRET_URL } })), 'credentials');
    assert.match(c.message, /Twitch: server address starts with rtmp:\/\/ but this output sends rtmps:\/\/\. The address was changed after the studio started; restart the studio with --live to use it/);
    const sinks = LIVE_SINKS.map((s) => (s.id === 'twitch' ? { ...s, transport: 'rtmp' } : s));
    assert.equal(byId(await runReadiness(deps({ hostOpts: { sinks }, store: { ...GOOD_STORE, 'Ujwalam/stream/twitch-server': SECRET_URL } })), 'credentials').status, 'pass', 'host chose rtmp from an rtmp:// address');
    const bad = byId(await runReadiness(deps({ store: { ...GOOD_STORE, 'Ujwalam/stream/twitch-server': 'srt://secret-ingest-zz9.example/app' } })), 'credentials');
    assert.equal(bad.status, 'fail');
    assert.match(bad.message, /starts with srt:\/\/ but this output sends rtmps:\/\/\. Twitch takes only rtmp:\/\/ or rtmps:\/\//);
    const kick = byId(await runReadiness(deps({ store: { ...GOOD_STORE, 'Ujwalam/stream/kick-server': 'rtmp://secret-ingest-zz9.example/app' } })), 'credentials');
    assert.match(kick.message, /Kick: server address starts with rtmp:\/\/ but this output sends rtmps:\/\/\. Set it again with rtmps:\/\//);
    for (const x of [c, bad, kick]) assert.ok(!JSON.stringify(x).includes('secret-ingest'), 'the stored address leaked');
  });

  test('planTargets: twitch is "auto" with the schemes data/platforms allows; kick names rtmps', () => {
    const t = Object.fromEntries(planTargets().map((x) => [x.id, x]));
    assert.equal(t.twitch.transport, 'auto');
    assert.deepEqual(t.twitch.schemes, ['rtmp', 'rtmps']);
    assert.equal(t.kick.transport, 'rtmps');
    assert.equal('schemes' in t.kick, false);
  });

  test('a missing key (host keyPresent false) fails; a missing server address fails; bandwidth test warns', async () => {
    const sinks = LIVE_SINKS.map((s) => (s.id === 'kick' ? { ...s, keyPresent: false } : s));
    assert.match(byId(await runReadiness(deps({ hostOpts: { sinks } })), 'credentials').message, /Kick: stream key not found/);
    const s2 = LIVE_SINKS.map((s) => (s.id === 'twitch' ? { ...s, urlPresent: false } : s));
    assert.equal(byId(await runReadiness(deps({ hostOpts: { sinks: s2 } })), 'credentials').status, 'fail');
    const s3 = LIVE_SINKS.map((s) => (s.id === 'twitch' ? { ...s, bandwidthTest: true } : s));
    const c3 = byId(await runReadiness(deps({ hostOpts: { sinks: s3 } })), 'credentials');
    assert.equal(c3.status, 'warn');
    assert.match(c3.message, /bandwidth test/);
  });

  test('not started with --live: host warns (loopback) and the live plan\'s keys are checked for presence directly', async () => {
    const sinks = LIVE_SINKS.map((s) => (s.kind === 'stream' ? { ...s, target: 'loopback', keyRef: undefined, urlRef: undefined } : s));
    const all = { 'Ujwalam/stream/youtube-h': SECRET_KEY, 'Ujwalam/stream/youtube-v': SECRET_KEY, 'Ujwalam/stream/twitch': SECRET_KEY, 'Ujwalam/stream/kick': SECRET_KEY, ...GOOD_STORE };
    const r = await runReadiness(deps({ hostOpts: { sinks }, store: all }));
    assert.equal(byId(r, 'host').status, 'warn');
    assert.match(byId(r, 'host').message, /--live/);
    assert.equal(byId(r, 'credentials').status, 'pass');
    // Twitch is "auto" (D309 proposed): an rtmp:// address is fine; Kick (rtmps only) with rtmp:// is not.
    const r2 = await runReadiness(deps({ hostOpts: { sinks }, store: { ...all, 'Ujwalam/stream/twitch': `${SECRET_KEY}?bandwidthtest=true`, 'Ujwalam/stream/twitch-server': SECRET_URL, 'Ujwalam/stream/kick-server': SECRET_URL } }));
    const c2 = byId(r2, 'credentials');
    assert.equal(c2.status, 'warn'); // never a fail without a live configuration
    assert.match(c2.message, /"\?" ending/);
    assert.match(c2.message, /Kick \(kick\): server address starts with rtmp:\/\/ but the plan sends rtmps:\/\//);
    assert.ok(!/Twitch \(twitch\): server address/.test(c2.message), 'twitch rtmp:// is accepted');
    const text = JSON.stringify(r2);
    for (const bad of [SECRET_KEY, 'secret-ingest', 'bandwidthtest=true']) assert.ok(!text.includes(bad), `leaked ${bad}`);
  });

  test('the stand-in host and a host with no stream outputs fail', async () => {
    assert.equal(byId(await runReadiness(deps({ hostOpts: { kind: 'fake' } })), 'host').status, 'fail');
    const r = await runReadiness(deps({ hostOpts: { sinks: [LIVE_SINKS[4]] } }));
    assert.equal(byId(r, 'host').status, 'fail');
    assert.match(byId(r, 'host').message, /No stream outputs/);
  });

  test('disk: below fail threshold fails, between warns, above passes (thresholds from the data file)', async () => {
    const at = async (gb) => byId(await runReadiness(deps({ free: gb * GB })), 'disk').status;
    assert.equal(await at(CONFIG.disk.failBelowGB - 1), 'fail');
    assert.equal(await at((CONFIG.disk.failBelowGB + CONFIG.disk.warnBelowGB) / 2), 'warn');
    assert.equal(await at(CONFIG.disk.warnBelowGB + 1), 'pass');
  });

  test('other streaming apps: Meld or OBS fail, Streamlabs warns, matched by image-name prefix', async () => {
    const meld = byId(await runReadiness(deps({ procs: ['meldstudio.exe'] })), 'encoders');
    assert.equal(meld.status, 'fail');
    assert.match(meld.message, /Meld Studio/);
    assert.equal(byId(await runReadiness(deps({ procs: ['obs64.exe'] })), 'encoders').status, 'fail');
    assert.equal(byId(await runReadiness(deps({ procs: ['streamlabs obs.exe'] })), 'encoders').status, 'warn');
  });

  test('bots: not answering only warns; Streamer.bot up but not connected warns', async () => {
    const r = await runReadiness(deps({ tcp: false }));
    assert.equal(byId(r, 'speakerbot').status, 'warn');
    assert.equal(byId(r, 'streamerbot').status, 'pass'); // the event core is connected
    const d = deps({ tcp: true });
    d.core = { describe: () => ({ available: true }), call: async () => ({ streamerbot: { state: 'waiting' } }) };
    assert.match(byId(await runReadiness(d), 'streamerbot').message, /not connected/);
    assert.equal((await runReadiness(deps({ tcp: false }))).ok, true, 'bots never block');
  });

  test('loopback: no CI stamp or an old one warns', async () => {
    assert.equal(byId(await runReadiness(deps({ ci: null })), 'loopback').status, 'warn');
    const old = new Date(Date.now() - (CONFIG.loopback.maxAgeDays + 1) * 86_400_000).toISOString();
    assert.equal(byId(await runReadiness(deps({ ci: { at: old } })), 'loopback').status, 'warn');
  });

  test('clips: no venv warns with the reason', async () => {
    const c = byId(await runReadiness(deps({ clip: { py: null, reason: 'the clip maker is missing in X' } })), 'clips');
    assert.equal(c.status, 'warn');
    assert.match(c.message, /missing/);
    // the zip ships no Python: the item carries the clip maker's plain reason and the fix
    const np = byId(await runReadiness(deps({ clip: { py: null, reason: "the clip maker's Python is missing (the Ujwalam download does not include Python; looked in X)", fix: 'To make clips, run Y' } })), 'clips');
    assert.equal(np.status, 'warn');
    assert.match(np.message, /^Clips cannot be made: the clip maker's Python is missing/);
    assert.equal(np.fix, 'To make clips, run Y');
  });

  test('audio: host up without the state call = unreadable (fail); a missing source fails; a muted mix source warns; pluggable', async () => {
    const u = byId(await runReadiness(deps({ hostOpts: { audio: null } })), 'audio');
    assert.equal(u.status, 'fail', 'audio state that cannot be read while the host is up blocks without the override');
    assert.equal(u.unknown, true);
    assert.match(u.message, /could not be read: the host cannot report it/);
    const f = byId(await runReadiness(deps({ hostOpts: { audio: { sources: [{ id: 'mic', name: 'Mic', state: 'missing' }] } } })), 'audio');
    assert.equal(f.status, 'fail');
    const m = byId(await runReadiness(deps({ hostOpts: { audio: { sources: [{ id: 'mic', name: 'Mic', state: 'live' }] }, methods: { 'mixer.list': () => ({ sources: [{ name: 'Game', muted: true, mixers: 1 }] }) } } })), 'audio');
    assert.equal(m.status, 'warn');
    assert.match(m.message, /Muted in the stream mix: Game/);
    const p = byId(await runReadiness(deps({ audioCheck: async () => ({ status: 'pass', message: 'plugged' }) })), 'audio');
    assert.deepEqual([p.status, p.message, p.title], ['pass', 'plugged', 'Audio sources']);
  });

  test('audio state unavailable while the host is up fails (hung, failing or throwing); host down stays a warning', async () => {
    const quick = { ...CONFIG, checkTimeoutMs: 100 };
    const hung = await runReadiness(deps({ config: quick, hostOpts: { methods: { 'audio.status': () => new Promise(() => {}) } } }));
    assert.deepEqual([byId(hung, 'audio').status, byId(hung, 'audio').unknown], ['fail', true]);
    assert.match(byId(hung, 'audio').message, /did not finish in time/);
    assert.equal(hung.ok, false);
    const err = byId(await runReadiness(deps({ hostOpts: { methods: { 'audio.status': () => { throw Object.assign(new Error('x'), { code: 'TIMEOUT' }); } } } })), 'audio');
    assert.equal(err.status, 'fail');
    assert.match(err.message, /the host did not answer/);
    const thrown = byId(await runReadiness(deps({ audioCheck: async () => { throw new Error('boom'); } })), 'audio');
    assert.equal(thrown.status, 'fail');
    // the host itself is down: the host item fails; audio says "unknown" (warn), it does not fail twice
    const down = await runReadiness(deps({ hostOpts: { methods: { 'host.status': () => { throw new Error('ECONNREFUSED'); } } } }));
    assert.equal(byId(down, 'host').status, 'fail');
    assert.equal(byId(down, 'audio').status, 'warn');
    // host.status answers audioHealth: no extra call
    const d = deps({ hostOpts: { audio: null, methods: { 'host.status': () => ({ live: false, audioHealth: { sources: [{ id: 'audio:game', name: 'Game', state: 'ok' }] } }) } } });
    assert.equal(byId(await runReadiness(d), 'audio').status, 'pass');
    assert.ok(!d.host.calls.includes('audio.status'));
  });

  test('the first host probes are bounded: a hung host.status / outputs.status / host.info answers within the timeout', async () => {
    const never = () => new Promise(() => {});
    const d = deps({ config: { ...CONFIG, checkTimeoutMs: 100 }, hostOpts: { methods: { 'host.status': never, 'outputs.status': never, 'host.info': never } } });
    d.core = { describe: () => ({ available: true }), call: never };
    const t0 = Date.now();
    const r = await runReadiness(d);
    assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
    assert.match(byId(r, 'host').message, /does not answer/);
    assert.equal(byId(r, 'host').status, 'fail');
  });

  test('GPU: not NVIDIA fails; NVIDIA without the Windows preference warns', async () => {
    assert.equal(byId(await runReadiness(deps({ hostOpts: { info: { adapter: 'Intel(R) UHD Graphics' } } })), 'gpu').status, 'fail');
    assert.equal(byId(await runReadiness(deps({ hostOpts: { info: { gpuPreference: { set: false, gpuPreference: null } } } })), 'gpu').status, 'warn');
  });

  test('a check that hangs or throws becomes a warning, never a crash', async () => {
    const d = deps({ config: { ...CONFIG, checkTimeoutMs: 100 } });
    d.listProcesses = () => new Promise(() => {});
    d.diskFree = async () => { throw new Error('boom'); };
    const r = await runReadiness(d);
    assert.match(byId(r, 'encoders').message, /did not finish/);
    assert.match(byId(r, 'disk').message, /could not run/);
  });
});

// Failure simulations (docs/evidence/2026-11-09-failure-sims-and-clipmaker-check.md). The real-host side (a dead source
// with the shipped watchdog numbers, readiness against it, the shutdown guard) is app/host/tests/host-audio-failsim.test.mjs.
describe('failure sims: disk thresholds and unreadable audio state', () => {
  const disk = async (bytes, over = {}) => byId(await runReadiness({ ...deps(over), diskFree: async () => bytes }), 'disk');

  test('disk: exact thresholds from data/live/readiness.json (fail below 22 GB, warn below 44 GB, 11 GB per hour)', async () => {
    assert.deepEqual(CONFIG.disk, { failBelowGB: 22, warnBelowGB: 44, gbPerHour: 11 }, 'thresholds changed: update the evidence doc');
    const { failBelowGB: F, warnBelowGB: W, gbPerHour: H } = CONFIG.disk;
    assert.equal((await disk(F * GB - 1)).status, 'fail', 'one byte under the fail line');
    assert.equal((await disk(F * GB)).status, 'warn', 'exactly the fail line is not a fail');
    assert.equal((await disk(W * GB - 1)).status, 'warn', 'one byte under the warn line');
    assert.equal((await disk(W * GB)).status, 'pass', 'exactly the warn line passes');
    assert.equal((await disk(0)).status, 'fail', 'a full disk');
    const f = await disk(10 * GB);
    assert.match(f.message, /^Only 10 GB free on C:\\ \(needs at least 22 GB\)\. Free space before going live\.$/);
    const w = await disk(33 * GB);
    assert.equal(w.message, `33 GB free on C:\\ (below 44 GB, about ${(33 / H).toFixed(1)} h of H+V recording).`);
    // the drive checked is the host's recordings folder, else the data folder; neither = warn, never pass
    let asked = null;
    const d = { ...deps({ hostOpts: { info: { recordingsDir: 'D:\\rec\\x' } } }), diskFree: async (dir) => { asked = dir; return 100 * GB; } };
    assert.match(byId(await runReadiness(d), 'disk').message, /on D:\\/);
    assert.equal(asked, 'D:\\rec\\x');
    const noDir = { ...deps({ hostOpts: { info: { recordingsDir: '' } } }), dataDir: null };
    const nd = byId(await runReadiness(noDir), 'disk');
    assert.deepEqual([nd.status, nd.message], ['warn', 'No recordings folder known to check.']);
    const dataOnly = { ...deps({ hostOpts: { info: { recordingsDir: null } } }), dataDir: 'E:\\ujw', diskFree: async (dir) => { asked = dir; return 100 * GB; } };
    assert.equal(byId(await runReadiness(dataOnly), 'disk').status, 'pass');
    assert.equal(asked, 'E:\\ujw');
    // a drive that cannot be read (removed, no permission) is a warning that says so, never a pass
    const gone = { ...deps(), diskFree: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } };
    assert.deepEqual([byId(await runReadiness(gone), 'disk').status, byId(await runReadiness(gone), 'disk').message], ['warn', 'The check could not run.']);
  });

  test('audio: an answer that cannot be read while the host is up fails (malformed, null, sources not a list)', async () => {
    for (const bad of [null, {}, { sources: 'x' }, { sources: null }, 42]) {
      const a = byId(await runReadiness(deps({ hostOpts: { methods: { 'audio.status': () => bad } } })), 'audio');
      assert.equal(a.status, 'fail', `audio.status answered ${JSON.stringify(bad)}: ${a.message}`);
      assert.equal(a.unknown, true);
      assert.match(a.message, /could not be read: the host's answer cannot be read/);
    }
    // host.status audioHealth that is malformed falls back to the method; both unreadable = fail
    const d = deps({ hostOpts: { audio: { nope: 1 }, methods: { 'host.status': () => ({ live: false, audioHealth: { sources: 'bad' } }) } } });
    assert.equal(byId(await runReadiness(d), 'audio').status, 'fail');
    assert.ok(d.host.calls.includes('audio.status'));
    // an empty list is a real answer (no device audio in the project): warn, not fail
    assert.equal(byId(await runReadiness(deps({ hostOpts: { audio: { sources: [] } } })), 'audio').status, 'warn');
  });

  test('audio: the host states each map as data/live/readiness.json says (missing fails; starting/unknown warn; inactive passes)', async () => {
    assert.deepEqual(CONFIG.audio.failStates, ['missing']);
    assert.deepEqual(CONFIG.audio.warnStates, ['starting', 'unknown']);
    const st = async (state) => byId(await runReadiness(deps({ hostOpts: { audio: { sources: [{ id: 'audio:game', name: 'Game', state }, { id: 'audio:mic', name: 'Mic', state: 'ok' }] } } })), 'audio');
    const m = await st('missing');
    assert.deepEqual([m.status, m.message], ['fail', 'Not working: Game (missing).']);
    assert.deepEqual([(await st('starting')).status, (await st('starting')).message], ['warn', 'Check: Game (starting).']);
    assert.equal((await st('unknown')).status, 'warn');
    assert.equal((await st('inactive')).status, 'pass');
    assert.equal((await st('ok')).message, '2 audio source(s) working.');
  });
});

describe('helpers', () => {
  test('credentialFacts returns facts only, schemeOf reads only the scheme', async () => {
    const f = await credentialFacts({ get: async () => SECRET_URL }, { scheme: true, query: true });
    assert.deepEqual(f, { present: true, scheme: 'rtmp', query: false });
    assert.deepEqual(await credentialFacts({ get: async () => null }, { scheme: true }), { present: false });
    assert.equal(schemeOf('RTMPS://x'), 'rtmps');
    assert.equal(schemeOf('ingest.example/app'), null);
  });
  test('summary names failures and the override phrase; the override log holds ids only', async () => {
    const r = await runReadiness(deps({ procs: ['meldstudio.exe'], tcp: false }));
    const s = readinessSummary(r);
    assert.match(s, /PROBLEM - Other streaming apps/);
    assert.ok(s.includes(OVERRIDE_PHRASE));
    const d = mk();
    assert.equal(logOverride(d, r, new Date('2026-11-08T10:00:00Z')), true);
    const line = JSON.parse(readFileSync(path.join(d, 'logs', OVERRIDE_LOG), 'utf8').trim());
    assert.deepEqual(line.failed, ['encoders']);
    assert.ok(line.warned.includes('speakerbot'));
    assert.deepEqual(Object.keys(line).sort(), ['at', 'checkedAt', 'failed', 'warned']);
  });
  test('createReadiness reuses a fresh result and shares one run', async () => {
    let n = 0; let t = 1000;
    const d = deps(); const orig = d.listProcesses; d.listProcesses = async () => { n++; return orig(); }; d.now = () => t;
    const rd = createReadiness(d);
    await Promise.all([rd.run(), rd.run()]);
    assert.equal(n, 1);
    t += 500; await rd.run({ maxAgeMs: 1000 }); assert.equal(n, 1);
    t += 5000; await rd.run({ maxAgeMs: 1000 }); assert.equal(n, 2);
  });
  test('createReadiness: a run past its deadline rejects and is dropped; the next call starts a new run', async () => {
    let n = 0;
    const d = deps({ config: { ...CONFIG, checkTimeoutMs: 100 } });
    d.listProcesses = () => { n++; return new Promise(() => {}); };
    d.deadlineMs = 30; // shorter than one check: the run cannot finish in time
    const rd = createReadiness(d);
    await assert.rejects(rd.run(), (e) => e.code === 'TIMEOUT');
    await assert.rejects(rd.run(), (e) => e.code === 'TIMEOUT');
    assert.equal(n, 2, 'the stuck run did not block the next one');
    assert.equal(rd.last(), null);
    assert.equal(readinessDeadlineMs({ checkTimeoutMs: 4000 }), 9000);
  });
});

// ---- server: GET /ui/api/readiness, go-live gate, End all streams ----
function raw(port, { method = 'GET', url = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${port}`, ...headers };
    if (body !== undefined) h['content-length'] = Buffer.byteLength(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, text, json: () => JSON.parse(text) }); });
    });
    req.on('error', reject);
    req.end(body);
  });
}
const servers = [];
after(async () => { for (const s of servers) await s.close(); });
async function session(port) {
  const r = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: `/login?k=${KEY}`, headers: { host: `127.0.0.1:${port}` } }, resolve));
  r.resume();
  const cookie = r.headers['set-cookie'][0].split(';')[0];
  const s = await raw(port, { url: '/ui/api/session', headers: { cookie } });
  return { cookie, csrf: s.json().csrf };
}
async function bootS(opts) {
  const dataDir = mk();
  if (opts.flagOn !== false) createFlags({ dataDir }).set('readiness', true);
  const fake = createFakeHost({ outputsReady: true });
  let live = opts.live === true; let seq = 0;
  const calls = [];
  const host = {
    describe: () => fake.describe(),
    async call(m, p) {
      calls.push([m, p]);
      if (m === 'outputs.status' && opts.outputsSeq) return opts.outputsSeq[Math.min(seq++, opts.outputsSeq.length - 1)];
      const r = await fake.call(m, p);
      if (m === 'stream.start') live = true;
      return m === 'host.status' ? { ...r, live } : r;
    },
  };
  const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
  let runs = 0;
  const readiness = { config: { ...CONFIG, goLiveMaxAgeMs: 0, endAll: { waitMs: 2000, pollMs: 20 } }, run: async () => { runs++; return opts.result; } };
  const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: KEY, dataDir, readiness, limits: { statusPollMs: 30 } });
  servers.push(srv);
  const { port } = await srv.listen();
  if (live) await new Promise((r) => setTimeout(r, 150)); // one status poll: the server knows it is live
  const a = await session(port);
  const get = (url) => raw(port, { url, headers: { cookie: a.cookie } });
  const post = (route, body) => raw(port, { method: 'POST', url: route, body: JSON.stringify(body), headers: { cookie: a.cookie, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'x-ujwalam-csrf': a.csrf } });
  return { port, dataDir, calls, runs: () => runs, get, post };
}
const mkResult = (items) => {
  const counts = { pass: 0, warn: 0, fail: 0 };
  for (const i of items) counts[i.status]++;
  return { at: '2026-11-08T10:00:00.000Z', ok: counts.fail === 0, counts, items: items.map((i) => ({ title: i.id, ...i })) };
};
const FAIL = mkResult([{ id: 'credentials', status: 'fail', message: 'Twitch: server address starts with rtmp://' }, { id: 'speakerbot', status: 'warn', message: 'no answer' }, { id: 'disk', status: 'pass', message: 'ok' }]);
const WARN = mkResult([{ id: 'speakerbot', status: 'warn', message: 'no answer' }, { id: 'disk', status: 'pass', message: 'ok' }]);

describe('server: readiness route and go-live gate', () => {
  test('flag off (the default): the route is 404 and Start stream asks only for "yes, on air"', async () => {
    const defs = JSON.parse(readFileSync(path.join(REPO, 'data', 'flags.json'), 'utf8')).flags;
    assert.equal(defs.find((f) => f.id === 'readiness').default, false);
    const c = await bootS({ flagOn: false, result: FAIL });
    assert.equal((await c.get('/ui/api/readiness')).status, 404);
    const r = (await c.post('/ui/api/host', { method: 'stream.start' })).json();
    assert.equal(r.pending.phrase, 'yes, on air');
    assert.equal(r.pending.readiness, undefined);
    assert.equal(c.runs(), 0);
  });

  test('GET /ui/api/readiness returns the items', async () => {
    const c = await bootS({ result: WARN });
    const r = (await c.get('/ui/api/readiness')).json();
    assert.equal(r.ok, true);
    assert.deepEqual(r.items.map((i) => i.id), ['speakerbot', 'disk']);
  });

  test('a failed item blocks: "yes, on air" is refused, the override phrase goes live and is logged (ids only)', async () => {
    const c = await bootS({ result: FAIL });
    const r = (await c.post('/ui/api/host', { method: 'stream.start' })).json();
    assert.equal(r.verdict, 'confirm');
    assert.equal(r.pending.phrase, OVERRIDE_PHRASE);
    assert.equal(r.pending.readiness.ok, false);
    assert.match(r.pending.summary, /^Start the stream\.\n\nReady to go live\?/);
    assert.match(r.pending.summary, /PROBLEM - credentials/);
    const w = (await c.post('/ui/api/confirm', { pendingId: r.pending.pendingId, text: 'yes, on air' })).json();
    assert.equal(w.verdict, 'wrong-phrase');
    assert.ok(!c.calls.some(([m]) => m === 'stream.start'), 'started without the override');
    const ok = (await c.post('/ui/api/confirm', { pendingId: r.pending.pendingId, text: OVERRIDE_PHRASE })).json();
    assert.deepEqual([ok.verdict, ok.override, ok.overrideLogged], ['allow', true, true]);
    assert.ok(c.calls.some(([m]) => m === 'stream.start'));
    const log = readFileSync(path.join(c.dataDir, 'logs', OVERRIDE_LOG), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(log.length, 1);
    assert.deepEqual(log[0].failed, ['credentials']);
    assert.ok(!JSON.stringify(log).includes('rtmp'), 'the log carries messages');
  });

  test('warnings only: "yes, on air" goes live, nothing is logged', async () => {
    const c = await bootS({ result: WARN });
    const r = (await c.post('/ui/api/host', { method: 'stream.start' })).json();
    assert.equal(r.pending.phrase, 'yes, on air');
    assert.match(r.pending.summary, /Warning - speakerbot/);
    const ok = (await c.post('/ui/api/confirm', { pendingId: r.pending.pendingId, text: 'yes, on air' })).json();
    assert.equal(ok.verdict, 'allow');
    assert.equal(ok.override, undefined);
    assert.equal(existsSync(path.join(c.dataDir, 'logs', OVERRIDE_LOG)), false);
  });

  test('a readiness check that cannot run refuses go-live (fail closed) and says how to bypass', async () => {
    const c = await bootS({ result: null });
    const r = await c.post('/ui/api/host', { method: 'stream.start' });
    assert.equal(r.status, 503);
    assert.match(r.json().detail, /readiness flag off/);
  });
});

describe('server: End all streams', () => {
  const st = (state, rec = 'live') => ({ configured: true, sinks: [
    { id: 'youtube-h', kind: 'stream', platform: 'youtube', state, keyRef: 'Ujwalam/stream/youtube-h' },
    { id: 'twitch', kind: 'stream', platform: 'twitch', state },
    { id: 'record', kind: 'record', platform: 'local', state: rec },
  ] });

  test('while live: typed "yes, on air", then stream.stop {} (all stream sinks), waits until stopped, recording untouched', async () => {
    const c = await bootS({ flagOn: false, live: true, result: WARN, outputsSeq: [st('stopping'), st('stopping'), st('stopped')] });
    const r = (await c.post('/ui/api/streams/end-all', {})).json();
    assert.equal(r.pending.phrase, 'yes, on air');
    assert.match(r.pending.summary, /recording keeps running/);
    const ok = (await c.post('/ui/api/confirm', { pendingId: r.pending.pendingId, text: 'yes, on air' })).json();
    assert.equal(ok.verdict, 'allow');
    assert.equal(ok.endAll.allStopped, true);
    assert.equal(ok.endAll.recording, true);
    assert.deepEqual(ok.endAll.sinks.map((s) => s.state), ['stopped', 'stopped']);
    assert.ok(!JSON.stringify(ok).includes('Ujwalam/stream'), 'a credential target name reached the page');
    const stops = c.calls.filter(([m]) => m === 'stream.stop');
    assert.deepEqual(stops, [['stream.stop', {}]]);
    assert.ok(!c.calls.some(([m]) => m === 'record.stop' || m === 'outputs.stop'), 'the recording was stopped');
  });

  test('a sink that does not stop in time is reported, not hidden; extra body fields are refused', async () => {
    const c = await bootS({ flagOn: false, live: true, result: WARN, outputsSeq: [st('stopping')] });
    assert.equal((await c.post('/ui/api/streams/end-all', { sinks: ['x'] })).status, 400);
    const r = (await c.post('/ui/api/streams/end-all', {})).json();
    const ok = (await c.post('/ui/api/confirm', { pendingId: r.pending.pendingId, text: 'yes, on air' })).json();
    assert.equal(ok.endAll.allStopped, false);
    assert.deepEqual(ok.endAll.sinks.map((s) => s.state), ['stopping', 'stopping']);
  });

  test('not live: plain "yes"; works without the readiness flag (no flag: it wires the existing stop path)', async () => {
    const c = await bootS({ flagOn: false, result: WARN, outputsSeq: [st('stopped', 'stopped')] });
    const r = (await c.post('/ui/api/streams/end-all', {})).json();
    assert.equal(r.pending.phrase, 'yes');
    const ok = (await c.post('/ui/api/confirm', { pendingId: r.pending.pendingId, text: 'yes' })).json();
    assert.deepEqual([ok.verdict, ok.endAll.allStopped, ok.endAll.recording], ['allow', true, false]);
  });
});
