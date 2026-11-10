// SPDX-License-Identifier: GPL-3.0-or-later
// Platform sign-in (D327, PC1-PC3): services/platform-connect. Loopback mocks of Google OAuth, the YouTube Live Streaming
// API and Twitch (tests/helpers/platform-mocks.mjs); an in-memory credential store instead of Windows Credential Manager.
// No test touches a real platform or the real Credential Manager.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, describe, test } from 'node:test';
import { CLIENT_ID_TARGET, CLIENT_SECRET_TARGET } from '../services/posting/oauth.mjs';
import { TARGETS, createConnect, createMemoryStores, keyProblem, outputsFromPlan, serverProblem } from '../services/platform-connect/index.mjs';
import { planTargets } from '../services/studio-ui/readiness.mjs';
import { SECRETS, googleBrowser, startPlatformMock } from './helpers/platform-mocks.mjs';

const tmp = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-pc-')); tmp.push(d); return d; };
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });
const mocks = [];
afterEach(async () => { for (const m of mocks.splice(0)) await m.close(); });

const OUTPUTS = outputsFromPlan(planTargets()); // the committed live plan: youtube-h, youtube-v, twitch, kick
const TWITCH_CLIENT = 'mocktwitchclientid0000000000zz';

async function setup({ live = {}, stores = {}, mockOpts, browser, fetchWrap, now, gate, storeWrap } = {}) {
  const mock = await startPlatformMock(mockOpts);
  mocks.push(mock);
  const mem = createMemoryStores({ [CLIENT_ID_TARGET]: 'mock-google-client.apps.example', [CLIENT_SECRET_TARGET]: SECRETS.googleClientSecret, ...stores });
  const dataDir = mk();
  const liveState = { ...live };
  const c = createConnect({
    dataDir, outputs: OUTPUTS, storeFor: storeWrap ? (t) => storeWrap(t, mem.storeFor(t)) : mem.storeFor, endpoints: mock.endpoints, sleep: async () => {},
    ...(fetchWrap ? { fetchImpl: (url, init) => fetchWrap(String(url), init, globalThis.fetch) } : {}), ...(now ? { now } : {}), ...(gate ? { gate } : {}),
    browserOpen: browser ? browser(mock) : googleBrowser(mock),
    outputLive: async (id) => { if (liveState[id] === 'error') throw new Error('x'); return liveState[id] ? 'live' : 'idle'; },
  });
  return { c, mock, mem, dataDir, liveState };
}
async function settle(c) { const j = c._job(); if (j?.done) await j.done.catch(() => {}); return c.currentJob(); }
function allFiles(dir) { return readdirSync(dir).flatMap((n) => { const p = path.join(dir, n); return statSync(p).isDirectory() ? allFiles(p) : [p]; }); }
function assertNoSecret(text, where) { for (const [name, v] of Object.entries(SECRETS)) assert.ok(!String(text).includes(v), `${name} leaked into ${where}`); }

describe('validation', () => {
  test('the live plan gives four outputs with the target names the host reads', () => {
    assert.deepEqual(OUTPUTS.map((o) => [o.id, o.platform, o.keyRef, o.serverRef ?? null, o.signIn]), [
      ['youtube-h', 'youtube', 'Ujwalam/stream/youtube-h', null, 'youtube'],
      ['youtube-v', 'youtube', 'Ujwalam/stream/youtube-v', null, 'youtube'],
      ['twitch', 'twitch', 'Ujwalam/stream/twitch', 'Ujwalam/stream/twitch-server', 'twitch'],
      ['kick', 'kick', 'Ujwalam/stream/kick', 'Ujwalam/stream/kick-server', null],
    ]);
    assert.deepEqual(OUTPUTS.find((o) => o.id === 'kick').schemes, ['rtmps']);
  });
  test('outputsFromPlan drops bad ids and refs', () => {
    assert.equal(outputsFromPlan([{ id: 'x', keyRef: 'Ujwalam/streamerbot' }, { id: 'Bad Id', keyRef: 'Ujwalam/stream/a' }, { id: 'y', keyRef: 'Ujwalam/stream/y', serverRef: 'Ujwalam/stream/y' }]).length, 0);
  });
  test('keys: printable ASCII as the host takes them; Twitch never with a "?" part; an address is not a key', () => {
    assert.equal(keyProblem(SECRETS.ytKeyH, 'youtube'), null);
    assert.equal(keyProblem('', 'kick'), 'key-missing');
    assert.equal(keyProblem('a b', 'kick'), 'key-bad-characters');
    assert.equal(keyProblem('ключ', 'kick'), 'key-bad-characters');
    assert.equal(keyProblem('x'.repeat(1024), 'kick'), 'key-too-long');
    assert.equal(keyProblem(`${SECRETS.twitchKey}?bandwidthtest=true`, 'twitch'), 'key-has-query');
    assert.equal(keyProblem('rtmps://x.example/app', 'kick'), 'key-looks-like-address');
  });
  test('server addresses mirror the host check (scheme, no IP, no query, no userinfo)', () => {
    assert.equal(serverProblem(SECRETS.kickServer, ['rtmps']), null);
    assert.equal(serverProblem('rtmp://zz9.example.net/app', ['rtmps']), 'server-wrong-scheme');
    assert.equal(serverProblem('rtmps://127.0.0.1/app', ['rtmps']), 'server-bad-address');
    assert.equal(serverProblem('rtmps://zz9.example.net/app?k=1', ['rtmps']), 'server-bad-address');
    assert.equal(serverProblem('rtmps://u:p@zz9.example.net/app', ['rtmps']), 'server-bad-address');
    assert.equal(serverProblem('rtmps://zz9.example.net:70000/app', ['rtmps']), 'server-bad-port');
    assert.equal(serverProblem('https://zz9.example.net/app', ['rtmps']), 'server-bad-address');
  });
});

describe('paste and disconnect (PC1 paste, PC2 storage, PC3)', () => {
  test('a pasted Kick key and server go to the host target names; status shows presence, scheme and last 4 only', async () => {
    const { c, mem, dataDir } = await setup();
    assert.equal((await c.status()).outputs.find((o) => o.id === 'kick').state, 'missing');
    await c.paste('kick', { key: SECRETS.kickKey, server: SECRETS.kickServer });
    assert.equal(mem.map.get('Ujwalam/stream/kick'), SECRETS.kickKey);
    assert.equal(mem.map.get('Ujwalam/stream/kick-server'), SECRETS.kickServer);
    const k = (await c.status()).outputs.find((o) => o.id === 'kick');
    assert.equal(k.state, 'connected');
    assert.deepEqual(k.key, { present: true, last4: SECRETS.kickKey.slice(-4) });
    assert.deepEqual(k.server, { present: true, scheme: 'rtmps', schemes: ['rtmps'] });
    const s = JSON.stringify(await c.status());
    assertNoSecret(s, 'status');
    assert.ok(!s.includes('zz9-mock-ingest'), 'the account-specific server host is never returned');
    for (const f of allFiles(dataDir)) assertNoSecret(readFileSync(f, 'utf8'), f);
    assert.deepEqual(JSON.parse(readFileSync(path.join(dataDir, 'connections.json'), 'utf8')).outputs.kick.source, 'pasted');
  });
  test('a bad paste writes nothing; a server for a YouTube output is refused', async () => {
    const { c, mem } = await setup();
    await assert.rejects(c.paste('kick', { key: 'a b' }), { code: 'key-bad-characters' });
    await assert.rejects(c.paste('youtube-h', { key: SECRETS.ytKeyH, server: 'rtmps://a.example.com/x' }), { code: 'server-not-used' });
    await assert.rejects(c.paste('nope', { key: 'k' }), { code: 'unknown-output' });
    assert.equal(mem.calls.filter(([op]) => op === 'set').length, 0);
  });
  test('a live output is refused; an unreadable live state is refused (fail closed); other outputs still work', async () => {
    const { c, mem } = await setup({ live: { 'youtube-h': true, twitch: 'error' } });
    await assert.rejects(c.paste('youtube-h', { key: SECRETS.ytKeyH }), { code: 'output-live' });
    await assert.rejects(c.paste('twitch', { key: SECRETS.twitchKey }), { code: 'live-unknown' });
    await assert.rejects(c.disconnect('youtube-h'), { code: 'output-live' });
    await assert.rejects(c.startSignIn('youtube', 'youtube-h'), { code: 'output-live' });
    assert.equal(mem.calls.filter(([op]) => op !== 'get').length, 0);
    await c.paste('youtube-v', { key: SECRETS.ytKeyNew });
    assert.equal(mem.map.get('Ujwalam/stream/youtube-v'), SECRETS.ytKeyNew);
  });
  test('disconnect deletes the key and server; status says missing', async () => {
    const { c, mem } = await setup({ stores: { 'Ujwalam/stream/kick': SECRETS.kickKey, 'Ujwalam/stream/kick-server': SECRETS.kickServer } });
    const r = await c.disconnect('kick');
    assert.deepEqual(r.removed, { key: true, server: true, token: false, revoke: 'not-needed' });
    assert.ok(!mem.map.has('Ujwalam/stream/kick') && !mem.map.has('Ujwalam/stream/kick-server'));
    assert.equal((await c.status({ fresh: true })).outputs.find((o) => o.id === 'kick').state, 'missing');
  });
});

describe('YouTube sign-in (PC1)', () => {
  test('loopback + PKCE + state: picks an existing stream, stores only its key under youtube-h, keeps the refresh token in its own target', async () => {
    const { c, mock, mem, dataDir } = await setup();
    const j0 = await c.startSignIn('youtube', 'youtube-h');
    assert.equal(j0.platform, 'youtube');
    const j1 = await settle(c);
    assert.equal(j1.state, 'choose', JSON.stringify(j1));
    assert.deepEqual(j1.streams.map((s) => s.id), ['stream-h'], 'only RTMP streams are offered');
    assertNoSecret(JSON.stringify(j1), 'job');
    const tokenReq = mock.st.requests.find((r) => r.path === '/google/token' && r.form.grant_type === 'authorization_code');
    assert.ok(tokenReq.form.code_verifier, 'PKCE verifier sent');
    assert.match(tokenReq.form.redirect_uri, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const done = await c.choose(j1.id, 'stream-h');
    assert.equal(done.state, 'done');
    assert.equal(mem.map.get('Ujwalam/stream/youtube-h'), SECRETS.ytKeyH);
    assert.equal(mem.map.get(TARGETS.youtubeRefresh), SECRETS.googleRefresh);
    assert.ok(!mem.map.has('Ujwalam/posting/youtube-refresh'), 'the posting sign-in is never touched');
    const st = await c.status({ fresh: true });
    assert.equal(st.outputs.find((o) => o.id === 'youtube-h').state, 'connected');
    assert.equal(st.accounts.youtube.signedIn, true);
    assertNoSecret(JSON.stringify(st), 'status');
    for (const f of allFiles(dataDir)) assertNoSecret(readFileSync(f, 'utf8'), f);
  });
  test('the consent URL asks for the youtube scope with S256 PKCE, offline access and a state', async () => {
    let seen = null;
    const { c } = await setup({ browser: (mock) => { const g = googleBrowser(mock); return async (u) => { seen = new URL(u); return g(u); }; } });
    await c.startSignIn('youtube', 'youtube-v');
    await settle(c);
    assert.equal(seen.searchParams.get('scope'), 'https://www.googleapis.com/auth/youtube');
    assert.equal(seen.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(seen.searchParams.get('access_type'), 'offline');
    assert.ok(seen.searchParams.get('state').length >= 16);
  });
  test('"create new" makes a reusable stream for the output (V) and stores its key', async () => {
    const { c, mock, mem } = await setup();
    await c.startSignIn('youtube', 'youtube-v');
    const j = await settle(c);
    await c.choose(j.id, null);
    assert.equal(mem.map.get('Ujwalam/stream/youtube-v'), SECRETS.ytKeyNew);
    const ins = mock.st.requests.find((r) => r.method === 'POST' && r.path === '/yt/liveStreams');
    assert.deepEqual(ins.json.contentDetails, { isReusable: true });
    assert.equal(ins.json.snippet.title, 'Ujwalam YouTube V');
  });
  test('a wrong state in the redirect is ignored: the job fails, nothing is stored', async () => {
    const { c, mem } = await setup({ browser: (mock) => googleBrowser(mock, { state: 'forged-state-value' }) });
    await c.startSignIn('youtube', 'youtube-h');
    const j = await settle(c);
    assert.equal(j.state, 'failed');
    assert.equal(j.error, 'oauth-state-mismatch');
    assert.equal(mem.calls.filter(([op]) => op === 'set').length, 0);
  });
  test('the user unticks the live permission: scope-missing, no key stored', async () => {
    const { c, mem } = await setup({ mockOpts: { googleScope: 'https://www.googleapis.com/auth/youtube.upload' } });
    await c.startSignIn('youtube', 'youtube-h');
    const j = await settle(c);
    assert.equal(j.error, 'scope-missing');
    assert.ok(!mem.map.has('Ujwalam/stream/youtube-h'));
  });
  test('no Google client set: a plain error, no browser', async () => {
    const mock = await startPlatformMock(); mocks.push(mock);
    const mem = createMemoryStores();
    const opened = [];
    const c = createConnect({ dataDir: mk(), outputs: OUTPUTS, storeFor: mem.storeFor, endpoints: mock.endpoints, browserOpen: async (u) => opened.push(u), outputLive: async () => 'idle' });
    await c.startSignIn('youtube', 'youtube-h');
    const j = await settle(c);
    assert.equal(j.error, 'oauth-no-client');
    assert.match(j.message, /How to set up/);
    assert.equal(opened.length, 0);
  });
  test('the stream starts between sign-in and the pick: the write is refused', async () => {
    const { c, mem, liveState } = await setup();
    await c.startSignIn('youtube', 'youtube-h');
    const j = await settle(c);
    liveState['youtube-h'] = true;
    await assert.rejects(c.choose(j.id, 'stream-h'), { code: 'output-live' });
    assert.ok(!mem.map.has('Ujwalam/stream/youtube-h'));
  });
  test('an expired Google sign-in: status token-expired, the key stays; check marks it', async () => {
    const { c, mock, mem, dataDir } = await setup();
    await c.startSignIn('youtube', 'youtube-h');
    await c.choose((await settle(c)).id, 'stream-h');
    assert.equal((await c.checkTokens()).youtube, 'ok');
    mock.st.googleRefreshValid = false;
    // A new start of the studio (no access token in memory) with a revoked sign-in:
    const c2 = createConnect({ dataDir, outputs: OUTPUTS, storeFor: mem.storeFor, endpoints: mock.endpoints, outputLive: async () => 'idle' });
    assert.equal((await c2.checkTokens()).youtube, 'expired');
    const row = (await c2.status({ fresh: true })).outputs.find((o) => o.id === 'youtube-h');
    assert.equal(row.state, 'token-expired');
    assert.equal(row.key.present, true, 'the stored key stays');
    assert.equal(mem.map.get('Ujwalam/stream/youtube-h'), SECRETS.ytKeyH);
  });
});

describe('Twitch sign-in (PC1)', () => {
  const twitchStores = { [TARGETS.twitchClientId]: TWITCH_CLIENT };
  test('device flow: shows the code, polls, stores key and a default rtmps server; refresh token in its own target', async () => {
    const opened = [];
    const { c, mock, mem, dataDir } = await setup({ stores: twitchStores, browser: () => async (u) => opened.push(u) });
    await c.startSignIn('twitch', 'twitch');
    const j = await settle(c);
    assert.equal(j.state, 'done', JSON.stringify(j));
    assert.equal(opened.length, 1);
    assert.match(opened[0], /\/activate\?device-code=ABCDEFGH$/);
    assert.equal(mem.map.get('Ujwalam/stream/twitch'), SECRETS.twitchKey);
    assert.equal(mem.map.get('Ujwalam/stream/twitch-server'), 'rtmps://zz9.contribute.live-video.net/app');
    assert.equal(mem.map.get(TARGETS.twitchRefresh), SECRETS.twitchRefresh);
    const helix = mock.st.requests.find((r) => r.path === '/helix/streams/key');
    assert.equal(helix.clientId, TWITCH_CLIENT);
    assert.equal(mock.st.requests.filter((r) => r.path === '/twitch/token').length, 2, 'one pending poll, then the token');
    assertNoSecret(JSON.stringify(await c.status({ fresh: true })), 'status');
    for (const f of allFiles(dataDir)) assertNoSecret(readFileSync(f, 'utf8'), f);
  });
  test('a stored server address is kept (the user chose it)', async () => {
    const { c, mem } = await setup({ stores: { ...twitchStores, 'Ujwalam/stream/twitch-server': 'rtmp://mine.contribute.live-video.net/app' } });
    await c.startSignIn('twitch', 'twitch');
    await settle(c);
    assert.equal(mem.map.get('Ujwalam/stream/twitch-server'), 'rtmp://mine.contribute.live-video.net/app');
  });
  test('a stored sign-in is reused: refresh (the rotated refresh token is stored), no device code', async () => {
    const opened = [];
    const { c, mock, mem } = await setup({ stores: { ...twitchStores, [TARGETS.twitchRefresh]: SECRETS.twitchRefresh }, browser: () => async (u) => opened.push(u) });
    await c.startSignIn('twitch', 'twitch');
    assert.equal((await settle(c)).state, 'done');
    assert.equal(opened.length, 0);
    assert.equal(mock.st.requests.filter((r) => r.path === '/twitch/device').length, 0);
    assert.equal(mem.map.get(TARGETS.twitchRefresh), SECRETS.twitchRefresh2);
  });
  test('no client id: a plain error that says how; denied on Twitch: failed, nothing stored', async () => {
    const a = await setup();
    await a.c.startSignIn('twitch', 'twitch');
    assert.equal((await settle(a.c)).error, 'twitch-no-client');
    const b = await setup({ stores: twitchStores });
    b.mock.st.twitchDeny = true;
    await b.c.startSignIn('twitch', 'twitch');
    assert.equal((await settle(b.c)).error, 'twitch-denied');
    assert.ok(!b.mem.map.has('Ujwalam/stream/twitch'));
  });
  test('Kick has no sign-in (Streamer.bot stays the event path, D2): paste only', async () => {
    const { c } = await setup();
    await assert.rejects(c.startSignIn('twitch', 'kick'), { code: 'sign-in-not-offered' });
  });
  test('client id must look like one', async () => {
    const { c, mem } = await setup();
    await assert.rejects(c.setTwitchClientId('has spaces'), { code: 'bad-client-id' });
    await c.setTwitchClientId(TWITCH_CLIENT);
    assert.equal(mem.map.get(TARGETS.twitchClientId), TWITCH_CLIENT);
    assert.equal((await c.status({ fresh: true })).accounts.twitch.clientSet, true);
  });
  test('expired Twitch sign-in: check marks it, the output shows token-expired; disconnect deletes the token (nothing left to revoke)', async () => {
    const { c, mock, mem } = await setup({ stores: twitchStores });
    await c.startSignIn('twitch', 'twitch');
    await settle(c);
    mock.st.twitchRefreshValid = false;
    assert.equal((await c.checkTokens()).twitch, 'expired');
    const row = (await c.status({ fresh: true })).outputs.find((o) => o.id === 'twitch');
    assert.equal(row.state, 'token-expired');
    assert.deepEqual(await c.readinessWarnings(), [`Twitch: ${row.detail}`]);
    const r = await c.disconnect('twitch');
    assert.equal(r.removed.token, true);
    assert.ok(!mem.map.has(TARGETS.twitchRefresh) && !mem.map.has('Ujwalam/stream/twitch'));
    assert.equal(r.removed.revoke, 'not-needed', 'the refresh token is already invalid at Twitch');
    assert.equal(mock.st.requests.filter((x) => x.path === '/twitch/revoke').length, 0);
  });
  test('one sign-in at a time', async () => {
    const { c, mem } = await setup({ stores: twitchStores, mockOpts: { twitchPendingPolls: 3 }, browser: () => async () => {} });
    const j = await c.startSignIn('twitch', 'twitch');
    await assert.rejects(c.startSignIn('youtube', 'youtube-h'), { code: 'sign-in-busy' });
    c.cancelJob(j.id); // cancelled before the device code even came back
    await settle(c);
    assert.equal(c.currentJob().state, 'cancelled');
    assert.ok(!mem.map.has('Ujwalam/stream/twitch'), 'nothing is written after a cancel');
    assert.equal((await c.startSignIn('twitch', 'twitch')).state, 'starting', 'a new sign-in may start');
    assert.equal((await settle(c)).state, 'done');
  });
});

// Codex second review of D327 (2026-11-10): one regression test or more per finding.
describe('review fixes: writes as a unit, ended jobs, concurrency, Twitch token lock, revoke', () => {
  const twitchStores = { [TARGETS.twitchClientId]: TWITCH_CLIENT };
  const deferred = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };

  test('1. paste: the output starts between the server and the key write: the old pair comes back, refused', async () => {
    const old = { 'Ujwalam/stream/kick': 'sk_us-west-2_OldKickKeyZZ9abcdef', 'Ujwalam/stream/kick-server': 'rtmps://old-mock-ingest.example.net:443/app' };
    const box = {};
    const { c, mem, liveState } = await setup({
      stores: old,
      storeWrap: (t, s) => ({ ...s, set: async (v) => { await s.set(v); if (t === 'Ujwalam/stream/kick-server') box.live.kick = true; } }),
    });
    box.live = liveState;
    await assert.rejects(c.paste('kick', { key: SECRETS.kickKey, server: SECRETS.kickServer }), { code: 'output-live' });
    assert.equal(mem.map.get('Ujwalam/stream/kick'), old['Ujwalam/stream/kick']);
    assert.equal(mem.map.get('Ujwalam/stream/kick-server'), old['Ujwalam/stream/kick-server']);
  });
  test('1. the start gate: a start on its way refuses the write; the gate is held for the whole update', async () => {
    let starting = true; let held = 0; const seen = [];
    const gate = { enter() { if (starting) throw Object.assign(new Error('output-starting'), { code: 'output-starting' }); held += 1; return () => { held -= 1; }; } };
    const { c, mem } = await setup({ gate, storeWrap: (t, s) => ({ ...s, set: async (v) => { seen.push([t, held]); await s.set(v); } }) });
    await assert.rejects(c.paste('kick', { key: SECRETS.kickKey, server: SECRETS.kickServer }), { code: 'output-starting' });
    assert.ok(!mem.map.has('Ujwalam/stream/kick'));
    starting = false;
    await c.paste('kick', { key: SECRETS.kickKey, server: SECRETS.kickServer });
    assert.deepEqual(seen, [['Ujwalam/stream/kick-server', 1], ['Ujwalam/stream/kick', 1]]);
    assert.equal(held, 0, 'released after the update');
  });
  test('1. disconnect: the output starts during the delete: the key and server come back, refused', async () => {
    const box = {};
    const { c, mem, liveState } = await setup({
      stores: { 'Ujwalam/stream/kick': SECRETS.kickKey, 'Ujwalam/stream/kick-server': SECRETS.kickServer },
      storeWrap: (t, s) => ({ ...s, delete: async () => { const r = await s.delete(); if (t === 'Ujwalam/stream/kick') box.live.kick = true; return r; } }),
    });
    box.live = liveState;
    await assert.rejects(c.disconnect('kick'), { code: 'output-live' });
    assert.equal(mem.map.get('Ujwalam/stream/kick'), SECRETS.kickKey);
    assert.equal(mem.map.get('Ujwalam/stream/kick-server'), SECRETS.kickServer);
  });
  test('1. two pastes at once run one after the other (one lock for output writes)', async () => {
    let inside = 0; let most = 0;
    const { c } = await setup({ storeWrap: (t, s) => ({ ...s, set: async (v) => { inside += 1; most = Math.max(most, inside); await new Promise((r) => setTimeout(r, 5)); await s.set(v); inside -= 1; } }) });
    await Promise.all([c.paste('kick', { key: SECRETS.kickKey, server: SECRETS.kickServer }), c.paste('twitch', { key: SECRETS.twitchKey })]);
    assert.equal(most, 1);
  });

  test('2. choose() cancelled while YouTube answers: nothing stored, the job stays cancelled', async () => {
    const hold = deferred();
    const box = {};
    const { c, mem } = await setup({
      fetchWrap: async (url, init, f) => { if (url.includes('/yt/liveStreams') && url.includes('id=stream-h')) { box.c.cancelJob(box.c._job().id); await hold.p; } return f(url, init); },
    });
    box.c = c;
    await c.startSignIn('youtube', 'youtube-h');
    const j = await settle(c);
    const pending = c.choose(j.id, 'stream-h');
    hold.open();
    await assert.rejects(pending, { code: 'cancelled' });
    assert.ok(!mem.map.has('Ujwalam/stream/youtube-h'));
    assert.equal(c.currentJob().state, 'cancelled');
  });
  test('2. Twitch: the token answer arrives after a cancel: the refresh token is not stored', async () => {
    const box = {};
    const { c, mem } = await setup({
      stores: twitchStores,
      fetchWrap: async (url, init, f) => {
        const r = await f(url, init);
        if (url.endsWith('/twitch/token') && String(init.body).includes('device_code') && r.status === 200) box.c.cancelJob(box.c._job().id);
        return r;
      },
    });
    box.c = c;
    await c.startSignIn('twitch', 'twitch');
    assert.equal((await settle(c)).state, 'cancelled');
    assert.ok(!mem.map.has(TARGETS.twitchRefresh));
    assert.ok(!mem.map.has('Ujwalam/stream/twitch'));
  });
  test('2. Google: a cancel after consent stores no refresh token; a cancel before closes the loopback listener', async () => {
    const box = {};
    const { c, mem } = await setup({
      fetchWrap: async (url, init, f) => { const r = await f(url, init); if (url.endsWith('/google/token') && String(init.body).includes('authorization_code')) box.c.cancelJob(box.c._job().id); return r; },
    });
    box.c = c;
    await c.startSignIn('youtube', 'youtube-h');
    assert.equal((await settle(c)).state, 'cancelled');
    assert.ok(!mem.map.has(TARGETS.youtubeRefresh));
    let redirect = null;
    const b = await setup({ browser: () => async (u) => { redirect = new URL(u).searchParams.get('redirect_uri'); } });
    const j = await b.c.startSignIn('youtube', 'youtube-h');
    while (!redirect) await new Promise((r) => setTimeout(r, 5));
    b.c.cancelJob(j.id);
    await settle(b.c);
    await assert.rejects(fetch(redirect), 'the listener is closed at once, not after 3 minutes');
  });
  test('2. a job past its time limit is ended for good: choose() refuses and nothing is stored', async () => {
    let t = 1_000_000;
    const { c, mem } = await setup({ now: () => t });
    await c.startSignIn('youtube', 'youtube-h');
    const j = await settle(c);
    assert.equal(j.state, 'choose');
    t += 11 * 60_000;
    await assert.rejects(c.choose(j.id, 'stream-h'), { code: 'job-not-waiting' });
    assert.deepEqual([c.currentJob().state, c.currentJob().error], ['failed', 'timeout']);
    assert.ok(!mem.map.has('Ujwalam/stream/youtube-h'));
  });

  test('3. two sign-in requests at once: one starts, the other is refused', async () => {
    const { c } = await setup({ stores: twitchStores, browser: () => async () => {} });
    const r = await Promise.allSettled([c.startSignIn('twitch', 'twitch'), c.startSignIn('youtube', 'youtube-h')]);
    assert.deepEqual(r.map((x) => x.status).sort(), ['fulfilled', 'rejected']);
    assert.equal(r.find((x) => x.status === 'rejected').reason.code, 'sign-in-busy');
    c.cancelJob(c._job().id);
    await settle(c);
  });
  test('3. two choose() calls at once: one saves, one is refused; one new stream is created', async () => {
    const { c, mock } = await setup();
    await c.startSignIn('youtube', 'youtube-h');
    const j = await settle(c);
    const r = await Promise.allSettled([c.choose(j.id, null), c.choose(j.id, null)]);
    assert.deepEqual(r.map((x) => x.status).sort(), ['fulfilled', 'rejected']);
    assert.equal(r.find((x) => x.status === 'rejected').reason.code, 'job-not-waiting');
    assert.equal(mock.st.requests.filter((x) => x.path === '/yt/liveStreams' && x.method === 'POST').length, 1);
  });

  test('4. two Twitch refreshes at once share one exchange of the single-use refresh token', async () => {
    const { c, mock, mem } = await setup({ stores: { ...twitchStores, [TARGETS.twitchRefresh]: SECRETS.twitchRefresh }, mockOpts: { twitchSingleUse: true } });
    const [a, b] = await Promise.all([c.checkTokens(), c.checkTokens()]);
    assert.deepEqual([a.twitch, b.twitch], ['ok', 'ok']);
    assert.equal(mock.st.requests.filter((x) => x.path === '/twitch/token').length, 1);
    assert.equal(mem.map.get(TARGETS.twitchRefresh), SECRETS.twitchRefresh2);
  });
  test('4. a refresh on its way when the user disconnects: the token is not stored again afterwards', async () => {
    const hold = deferred();
    const box = { armed: false, held: false };
    const { c, mem } = await setup({
      stores: { ...twitchStores, [TARGETS.twitchRefresh]: SECRETS.twitchRefresh },
      // The held refresh goes on only after the sign-out deleted the token (the old race), or after 50 ms when the
      // sign-out rightly waits for the refresh (account lock).
      storeWrap: (t, s) => ({ ...s, delete: async () => { const r = await s.delete(); if (t === TARGETS.twitchRefresh) hold.open(); return r; } }),
      fetchWrap: async (url, init, f) => {
        const r = await f(url, init);
        if (box.armed && !box.held && url.endsWith('/twitch/token') && String(init.body).includes('grant_type=refresh_token')) { box.held = true; await hold.p; }
        return r;
      },
    });
    await c.startSignIn('twitch', 'twitch'); // a stored sign-in: refresh, then the key; the output comes from Twitch
    assert.equal((await settle(c)).state, 'done');
    box.armed = true;
    const check = c.checkTokens();
    while (!box.held) await new Promise((r) => setTimeout(r, 2));
    const disc = c.disconnect('twitch');
    setTimeout(hold.open, 50);
    await Promise.all([check, disc]);
    assert.ok(!mem.map.has(TARGETS.twitchRefresh), 'the sign-out wins');
  });

  test('5. sign-out revokes the access token (never the refresh token) and reports a failed revoke apart from the local delete', async () => {
    const { c, mock, mem } = await setup({ stores: twitchStores });
    await c.startSignIn('twitch', 'twitch');
    await settle(c);
    mock.st.revokeStatus = 503;
    const r = await c.disconnect('twitch');
    assert.deepEqual([r.removed.token, r.removed.revoke], [true, 'failed']);
    assert.deepEqual(mock.st.revoked, [SECRETS.twitchAccess]);
    assert.ok(!mem.map.has(TARGETS.twitchRefresh));
  });
});
