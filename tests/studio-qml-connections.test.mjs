// SPDX-License-Identifier: GPL-3.0-or-later
// Settings > Connections in the QML studio (plan Q3, slice 6): the QML twin of the widget connections::Page and its tests
// (studio-qt-connect-button.test.mjs: the state with at most the last 4 of a key, Edit output > Connect opens the flow for
// that one output; studio-ui-connect*.test.mjs through the page: paste stored on the click, bad values and a live output
// refused with plain words, YouTube and Twitch sign-in, disconnect, the Twitch client ID), plus the page's own rules: the
// key field is a password field, empty after OK or Cancel and after Settings closes, never in the probe tree; no typed
// key, server address or client ID in the probe line, the shell's output, a server log line or a file of the data folder;
// no sideways scrolling; plain words; every write acts on its own click (D332), so a typed key is no unsaved Settings
// change, while a flag switch on the page asks Save changes / Discard / Cancel. Probe actions: settings-open,
// settings-page:Connections, stream-output-edit, stream-output-connect (as the widget) and the page's conn-* actions.
// Headless probe (UJWALAM_HEADLESS=1, offscreen, never on a screen) against a real UI server and the fake host, an
// in-memory credential store (never the real Credential Manager) and loopback platform mocks (no network). Skipped when
// the shell is not built.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFakeBots, createFakeHost } from '../services/studio-ui/backends.mjs';
import { createFlags } from '../services/flags/index.mjs';
import { CLIENT_ID_TARGET, CLIENT_SECRET_TARGET } from '../services/posting/oauth.mjs';
import { TARGETS, createMemoryStores } from '../services/platform-connect/index.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';
import { createProjectSync } from '../services/studio-ui/project-sync.mjs';
import { createProject, saveProject } from '../services/project/index.mjs';
import { SECRETS, googleBrowser, startPlatformMock } from './helpers/platform-mocks.mjs';
import { EXE, qtDir } from '../app/studio/tools/build.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const PACKAGED = process.env.UJWALAM_STUDIO_TEST_EXE ? path.resolve(process.env.UJWALAM_STUDIO_TEST_EXE) : null;
const SHELL_EXE = PACKAGED ?? EXE;
const QT = PACKAGED ? null : qtDir();
const skip = !existsSync(SHELL_EXE) || (!PACKAGED && !QT) ? 'studio shell not built (npm run build:studio)' : false;
const TWITCH_KEY = 'live_123456789_MockTwitchStreamKeyZZ9'; // lint-allow: secret (a made-up test marker, not a credential)
const PASTE_KEY = 'sk_us-west-2_MockQmlPasteKeyQQ8abcdef'; // lint-allow: secret (a made-up test marker, not a credential)
const PASTE_SERVER = 'rtmps://qq8-mock-ingest.example.net:443/app';
const CLIENT_ID = 'mockqmlclientid000000000000qq8';
const MOCK_TWITCH_CLIENT = 'mocktwitchclientid0000000000zz'; // the client ID the Twitch mock accepts
const TYPED = [TWITCH_KEY, PASTE_KEY, PASTE_SERVER, CLIENT_ID, ...Object.values(SECRETS)];

function runShell(env) {
  return new Promise((resolve) => {
    const child = spawn(SHELL_EXE, [], {
      windowsHide: true,
      env: { ...process.env, ...(QT ? { PATH: `${path.join(QT, 'bin')}${path.delimiter}${process.env.PATH}` } : {}), UJWALAM_HEADLESS: '1', UJWALAM_STUDIO_QML: '1', ...env },
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => child.kill(), 40_000);
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}
function allFiles(dir) { return readdirSync(dir).flatMap((n) => { const p = path.join(dir, n); return statSync(p).isDirectory() ? allFiles(p) : [p]; }); }

describe('QML studio Settings > Connections (headless probe)', { skip }, () => {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  // stores: what the in-memory credential store holds at the start (the stored Twitch key by default).
  // signIn: loopback platform mocks and a fake browser for the sign-in flows ('youtube' | 'twitch').
  async function probe({ actions = [], ms = Math.max(9000, 4000 + actions.length * 700), flagsOn = ['platform-connect'], stores, liveSinks = [], signIn = null } = {}) {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-qmlcn-')); dirs.push(dataDir);
    const flags = createFlags({ dataDir });
    for (const id of flagsOn) flags.set(id, true);
    const file = path.join(dataDir, 'p.project.json');
    saveProject(file, createProject({ name: 'T', fps: 30 }));
    const fake = createFakeHost({ outputsReady: true });
    const live = liveSinks.length > 0;
    const host = {
      describe: () => fake.describe(),
      call: async (m, p) => {
        if (m === 'outputs.status') return { configured: true, sinks: liveSinks.map((id) => ({ id, kind: 'stream', state: 'live' })) };
        const r = await fake.call(m, p);
        return m === 'host.status' && live ? { ...r, live: true } : r;
      },
    };
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const mock = signIn ? await startPlatformMock() : null;
    const mem = createMemoryStores(stores ?? { 'Ujwalam/stream/twitch': TWITCH_KEY, 'Ujwalam/stream/twitch-server': 'rtmps://zz9-mock-ingest.example.net:443/app' });
    const connect = { storeFor: mem.storeFor, sleep: async () => {},
      ...(mock ? { endpoints: mock.endpoints, browserOpen: signIn === 'youtube' ? googleBrowser(mock) : async () => {} } : {}) };
    const key = 'c'.repeat(40);
    const logs = [];
    const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: key, dataDir, flags, bots: createFakeBots(), projectSync: createProjectSync({ file }),
      limits: { statusPollMs: 50 }, tcpAnswers: async () => false, botConfig: () => ({}), connect, log: (m) => logs.push(String(m)) });
    const { port } = await srv.listen();
    if (live) await new Promise((r) => setTimeout(r, 150));
    try {
      const r = await runShell({ UJWALAM_UI_URL: `http://127.0.0.1:${port}/`, UJWALAM_UI_LAUNCH_KEY: key, UJWALAM_STUDIO_PROBE_MS: String(ms),
        UJWALAM_STUDIO_PROBE_ACTIONS: actions.join(',') });
      assert.equal(r.code, 0, r.err);
      const m = /^studio probe: (.+)$/m.exec(r.out);
      assert.ok(m, `no probe line: ${r.out} ${r.err}`);
      assert.doesNotMatch(r.err, /\.qml:\d+.*(Error|TypeError|ReferenceError|Unable to assign|binding loop)/i, 'no QML errors');
      // Leak check: no stored or typed secret in the probe line, the shell's output, a server log line or a data file.
      for (const v of TYPED) {
        assert.ok(!m[1].includes(v), 'a secret reached the probe line');
        assert.ok(!r.out.includes(v) && !r.err.includes(v), 'a secret reached the shell output');
        assert.ok(!logs.some((l) => l.includes(v)), 'a secret reached a server log line');
        for (const f of allFiles(dataDir)) assert.ok(!readFileSync(f, 'utf8').includes(v), `a secret reached ${path.basename(f)}`);
      }
      const p = JSON.parse(m[1]);
      return { p, s: p.state, cn: p.state.settings?.connectionsPage, mem, flags };
    } finally { await srv.close(); if (mock) await mock.close(); }
  }
  const node = (p, name) => p.tree.find((n) => n.name === name);
  const done = (p) => p.actions.map((a) => [a.action, a.done]);
  const doneOf = (p, action) => Object.fromEntries(done(p))[action];
  const sets = (mem) => mem.calls.filter(([op]) => op === 'set' || op === 'delete');
  const PAGE_NAMES = /^conn[A-Z]/;
  const PAGE = 'settings-page:Connections';
  const open = ['settings-open', PAGE];
  // the state after a click shows on the next probe; a quiet action gives the page its turn (and the sign-in poll its second)
  const WAIT = [PAGE];

  // ---- twins of studio-qt-connect-button.test.mjs ----
  test('flag off: the page says which switch to turn on (plain words), shows no outputs and writes no credential', async () => {
    const r = await probe({ flagsOn: [], actions: [...open, 'conn-paste:kick', ...WAIT] });
    assert.equal(r.cn, null);
    assert.match(node(r.p, 'settingsLead:Connections').text, /^Switch on Platform sign-in below and click Save to connect platforms here\.$/);
    assert.doesNotMatch(node(r.p, 'settingsLead:Connections').text, /platform-connect/, 'plain words: no flag id');
    assert.equal(doneOf(r.p, 'conn-paste:kick'), false);
    assert.equal(node(r.p, 'connIntro')?.visible ?? false, false);
    assert.equal(sets(r.mem).length, 0, 'nothing written');
  });

  test('flag on: every output with its state (last 4 only), Sign in for YouTube and Twitch, Disconnect only when something is stored', async () => {
    const r = await probe({ actions: [...open, ...WAIT] });
    const cn = r.cn;
    assert.ok(cn, 'the page is on');
    assert.equal(cn.loaded, true);
    assert.equal(cn.only, '');
    assert.ok(cn.outputs.length >= 3, JSON.stringify(cn.outputs));
    const tw = cn.outputs.find((o) => o.id === 'twitch');
    assert.equal(tw.short, `Connected  (key ....${TWITCH_KEY.slice(-4)})`);
    assert.match(tw.status, /^Connected {2}\(key \.\.\.\.\w{4}\) - Key stored\.$/);
    assert.equal(tw.disconnect, true);
    assert.equal(tw.signIn, 'twitch');
    const kick = cn.outputs.find((o) => o.id === 'kick');
    assert.ok(kick, JSON.stringify(cn.outputs.map((o) => o.id)));
    assert.match(kick.status, /^Not connected - /);
    assert.equal(kick.disconnect, false);
    assert.equal(kick.signIn, '');
    assert.equal(node(r.p, 'connSignIn:kick').visible, false, 'Kick has no sign-in: Paste key only');
    assert.equal(node(r.p, 'connDisconnect:kick').enabled, false);
    assert.equal(node(r.p, 'connSignIn:twitch').text, 'Sign in with Twitch');
    const yt = cn.outputs.find((o) => o.signIn === 'youtube');
    assert.equal(node(r.p, `connSignIn:${yt.id}`).text, 'Sign in with YouTube');
    assert.equal(node(r.p, `connRow:${tw.id}`).text, 'Twitch');
    assert.equal(cn.paste, null, 'no paste box until Paste key is clicked');
    assert.equal(sets(r.mem).length, 0, 'reading writes nothing');
  });

  test('Edit output > Connect: the page shows only that output; Show all outputs brings the others back', async () => {
    const flagsOn = ['stream-settings', 'platform-connect'];
    const r = await probe({ flagsOn, actions: ['settings-open', 'settings-page:Stream', 'stream-output-edit:2', 'settings-page:Stream', 'stream-output-connect', ...WAIT] });
    assert.equal(doneOf(r.p, 'stream-output-connect'), true);
    assert.equal(r.s.settings.page, 'Connections');
    assert.equal(r.cn.only, 'twitch');
    assert.deepEqual(r.cn.rows, ['Twitch'], 'only that output');
    assert.equal(node(r.p, 'connShowAll').visible, true);
    const all = await probe({ flagsOn, actions: ['settings-open', 'settings-page:Stream', 'stream-output-edit:2', 'settings-page:Stream', 'stream-output-connect', ...WAIT, 'conn-all', ...WAIT] });
    assert.equal(doneOf(all.p, 'conn-all'), true);
    assert.equal(all.cn.only, '');
    assert.ok(all.cn.rows.length >= 3, JSON.stringify(all.cn.rows));
  });

  // ---- paste (twins of studio-ui-connect*.test.mjs, through the page) ----
  test('Paste key: a password field, its text never in the probe tree; OK stores key and address on the click and empties the field', async () => {
    const typed = await probe({ actions: [...open, ...WAIT, 'conn-paste:kick', `conn-key:${PASTE_KEY}`, `conn-server:${PASTE_SERVER}`, ...WAIT] });
    assert.ok(typed.p.actions.some((a) => a.action === 'conn-key:(hidden)' && a.done), JSON.stringify(typed.p.actions));
    assert.ok(typed.p.actions.some((a) => a.action === 'conn-server:(hidden)' && a.done));
    const pb = typed.cn.paste;
    assert.ok(pb, 'the paste box is open');
    assert.deepEqual([pb.output, pb.password, pb.keyEmpty, pb.server, pb.serverEmpty], ['kick', true, false, true, false]);
    assert.equal(node(typed.p, 'connPasteTitle').text, 'Paste stream key: Kick');
    assert.match(node(typed.p, 'connServerHint').text, /^This output takes rtmps?:\/\/.* \(from the platform's stream settings page\)\.$/);
    assert.ok(node(typed.p, 'connKeyBox')?.visible);
    assert.equal(node(typed.p, 'connKeyBox').text, undefined, 'the key box has no text of its own');
    assert.equal(sets(typed.mem).length, 0, 'typing stores nothing');
    assert.equal(typed.s.settings.dirty, false, 'a typed key is no unsaved Settings change');

    const r = await probe({ actions: [...open, ...WAIT, 'conn-paste:kick', `conn-key:${PASTE_KEY}`, `conn-server:${PASTE_SERVER}`, 'conn-paste-ok', ...WAIT, ...WAIT, 'conn-paste:kick', ...WAIT] });
    assert.equal(doneOf(r.p, 'conn-paste-ok'), true);
    assert.equal(r.mem.map.get('Ujwalam/stream/kick'), PASTE_KEY, 'stored on the click (D332), no phrase, no question');
    assert.equal(r.mem.map.get('Ujwalam/stream/kick-server'), PASTE_SERVER);
    assert.equal(r.cn.message, 'Done.');
    assert.equal(r.s.settings.unsavedOpen, false);
    const k = r.cn.outputs.find((o) => o.id === 'kick');
    assert.equal(k.short, `Connected  (key ....${PASTE_KEY.slice(-4)})`);
    assert.equal(k.disconnect, true);
    assert.deepEqual([r.cn.paste.password, r.cn.paste.keyEmpty, r.cn.paste.serverEmpty], [true, true, true], 'opened again: a fresh, empty password field');
  });

  test('Cancel in the paste box stores nothing and empties the field; OK with both fields empty says Nothing to store', async () => {
    const c = await probe({ actions: [...open, ...WAIT, 'conn-paste:kick', `conn-key:${PASTE_KEY}`, 'conn-paste-cancel', ...WAIT, 'conn-paste:kick', ...WAIT] });
    assert.equal(doneOf(c.p, 'conn-paste-cancel'), true);
    assert.equal(c.mem.map.has('Ujwalam/stream/kick'), false);
    assert.equal(c.cn.paste.keyEmpty, true);
    const n = await probe({ actions: [...open, ...WAIT, 'conn-paste:kick', 'conn-paste-ok', ...WAIT] });
    assert.equal(n.cn.message, 'Nothing to store.');
    assert.equal(n.cn.paste, null);
    assert.equal(sets(n.mem).length, 0);
  });

  test('a bad server address is refused with the plain reason; nothing stored', async () => {
    const r = await probe({ actions: [...open, ...WAIT, 'conn-paste:kick', `conn-key:${PASTE_KEY}`, 'conn-server:rtmp://qq8.example.net/app', 'conn-paste-ok', ...WAIT] });
    assert.match(r.cn.message, /^Not done: This output takes another scheme/);
    assert.equal(r.mem.map.has('Ujwalam/stream/kick'), false);
    assert.equal(r.cn.paste, null, 'the box closed and its fields were wiped');
  });

  test('live: the streaming output is refused at the click with plain words; another output is stored on the click', async () => {
    const r = await probe({ liveSinks: ['kick'], actions: [...open, ...WAIT, 'conn-paste:kick', `conn-key:${PASTE_KEY}`, `conn-server:${PASTE_SERVER}`, 'conn-paste-ok', ...WAIT] });
    assert.match(r.cn.message, /^Not done: /);
    assert.doesNotMatch(r.cn.message, /output-live|HTTP \d+/, 'the server sentence, not a code');
    assert.equal(r.mem.map.has('Ujwalam/stream/kick'), false);
    const v = await probe({ liveSinks: ['kick'], actions: [...open, ...WAIT, 'conn-paste:youtube-v', `conn-key:${PASTE_KEY}`, 'conn-paste-ok', ...WAIT] });
    assert.equal(v.cn.message, 'Done.');
    assert.equal(v.mem.map.get('Ujwalam/stream/youtube-v'), PASTE_KEY);
  });

  test('Disconnect acts on its click: the key and address are deleted; an output with nothing stored cannot be disconnected', async () => {
    const r = await probe({ actions: [...open, ...WAIT, 'conn-disconnect:twitch', ...WAIT, ...WAIT, 'conn-disconnect:kick'] });
    assert.equal(doneOf(r.p, 'conn-disconnect:twitch'), true);
    assert.equal(doneOf(r.p, 'conn-disconnect:kick'), false);
    assert.equal(r.mem.map.has('Ujwalam/stream/twitch'), false);
    assert.equal(r.mem.map.has('Ujwalam/stream/twitch-server'), false);
    assert.equal(r.cn.message, 'Done.');
    assert.match(r.cn.outputs.find((o) => o.id === 'twitch').short, /^Not connected$/);
    assert.equal(r.s.settings.unsavedOpen, false, 'no question');
  });

  // ---- sign-in set-up and sign-in (loopback mocks) ----
  test('Twitch client ID: Save stores it on the click and empties the box; Save with an empty box says what to do', async () => {
    const r = await probe({ actions: [...open, ...WAIT, `conn-twitch-client:${CLIENT_ID}`, 'conn-twitch-save', ...WAIT] });
    assert.ok(r.p.actions.some((a) => a.action === 'conn-twitch-client:(hidden)'), JSON.stringify(r.p.actions));
    assert.equal(r.mem.map.get(TARGETS.twitchClientId), CLIENT_ID);
    assert.equal(r.cn.twitchClientEmpty, true);
    assert.equal(r.cn.message, 'Done.');
    const e = await probe({ actions: [...open, ...WAIT, 'conn-twitch-save'] });
    assert.equal(e.cn.message, 'Paste the client ID first.');
    assert.equal(sets(e.mem).length, 0);
  });

  test('YouTube sign-in: the browser sign-in, then the stream key choice on the page; the choice stores the key', async () => {
    const stores = { [CLIENT_ID_TARGET]: 'mock-google-client.apps.example', [CLIENT_SECRET_TARGET]: SECRETS.googleClientSecret };
    const c = await probe({ stores, signIn: 'youtube', actions: [...open, ...WAIT, 'conn-sign-in:youtube-h', ...WAIT, ...WAIT, ...WAIT, ...WAIT], ms: 12000 });
    assert.equal(doneOf(c.p, 'conn-sign-in:youtube-h'), true);
    assert.equal(c.cn.job, 'Signed in to YouTube: choose which stream key to use.', c.cn.job);
    assert.match(c.cn.choices[0], /^Default stream key \(/);
    assert.equal(c.cn.choices.at(-1), 'Create a new stream key for this output');
    assert.equal(node(c.p, 'connChoiceBox').visible, true);
    assert.equal(c.mem.map.has('Ujwalam/stream/youtube-h'), false, 'nothing stored before the choice');
    const r = await probe({ stores, signIn: 'youtube', actions: [...open, ...WAIT, 'conn-sign-in:youtube-h', ...WAIT, ...WAIT, ...WAIT, ...WAIT, 'conn-choose:0', ...WAIT, ...WAIT], ms: 14000 });
    assert.equal(doneOf(r.p, 'conn-choose:0'), true);
    assert.equal(r.mem.map.get('Ujwalam/stream/youtube-h'), SECRETS.ytKeyH);
    assert.equal(r.cn.message, 'Done.');
    assert.equal(r.cn.job, 'Connected: the stream key is stored.');
    assert.deepEqual(r.cn.choices, []);
    assert.equal(r.cn.outputs.find((o) => o.id === 'youtube-h').state, 'connected');
    const x = await probe({ stores, signIn: 'youtube', actions: [...open, ...WAIT, 'conn-sign-in:youtube-h', ...WAIT, ...WAIT, ...WAIT, ...WAIT, 'conn-choose-cancel', ...WAIT], ms: 13000 });
    assert.equal(doneOf(x.p, 'conn-choose-cancel'), true);
    assert.equal(x.cn.message, 'Cancelled.');
    assert.equal(x.mem.map.has('Ujwalam/stream/youtube-h'), false);
  });

  test('Twitch sign-in (device code): the key is stored; the page says so', async () => {
    const r = await probe({ stores: { [TARGETS.twitchClientId]: MOCK_TWITCH_CLIENT }, signIn: 'twitch', actions: [...open, ...WAIT, 'conn-sign-in:twitch', ...WAIT, ...WAIT, ...WAIT, ...WAIT], ms: 12000 });
    assert.equal(doneOf(r.p, 'conn-sign-in:twitch'), true);
    assert.equal(r.mem.map.get('Ujwalam/stream/twitch'), SECRETS.twitchKey, r.cn.job);
    assert.equal(r.cn.job, 'Connected: the stream key is stored.', r.cn.job);
    assert.equal(r.cn.polling, false, 'the poll stops once the sign-in is done');
  });

  test('Check sign-ins asks the platforms and says the result in plain words', async () => {
    const r = await probe({ signIn: 'twitch', actions: [...open, ...WAIT, 'conn-check', ...WAIT] });
    assert.equal(doneOf(r.p, 'conn-check'), true);
    assert.match(r.cn.message, /^(Checked\.|Could not check: .+)$/);
  });

  // ---- the page's rules ----
  test('no sideways scrolling, plain words only (no decision numbers, no file names), every control inside the page', async () => {
    const r = await probe({ actions: [...open, ...WAIT, 'conn-paste:kick', ...WAIT] });
    const page = node(r.p, 'settingsPage:Connections');
    assert.ok(page && page.visible);
    const [px, , pw] = page.rect;
    const mine = r.p.tree.filter((x) => x.visible && x.rect && x.rect[2] > 0 && PAGE_NAMES.test(x.name));
    assert.ok(mine.length >= 15, `${mine.length} named controls on the page`);
    for (const n of mine) assert.ok(n.rect[0] >= px - 1 && n.rect[0] + n.rect[2] <= px + pw + 1, `${n.name} ends inside the page (${n.rect} vs ${page.rect})`);
    const words = r.p.tree.filter((x) => (PAGE_NAMES.test(x.name) || /^settings(Title|Lead|Note):Connections$/.test(x.name)) && typeof x.text === 'string').map((x) => x.text).join('\n');
    assert.match(words, /Windows Credential Manager itself and shows only their last 4 characters/);
    assert.match(words, /Check sign-ins/);
    assert.match(words, /Paste key\.\.\./);
    assert.doesNotMatch(words, /\bD\d{2,}\b|\bPC\d\b|[\\/][\w.-]+\.(json|mjs|cpp|md)\b|platform-connect/, 'no decision numbers, flag ids or file names in the words');
  });

  test('a typed key is no unsaved change: Cancel closes Settings at once, stores nothing, and the field is empty when Settings opens again', async () => {
    const r = await probe({ actions: [...open, ...WAIT, 'conn-paste:kick', `conn-key:${PASTE_KEY}`, `conn-twitch-client:${CLIENT_ID}`, 'settings-cancel', 'settings-open:Connections', ...WAIT] });
    assert.equal(doneOf(r.p, 'settings-cancel'), true);
    assert.equal(r.s.settings.unsavedOpen, false, 'nothing to ask');
    assert.equal(sets(r.mem).length, 0, 'nothing stored');
    assert.equal(r.s.flagsInSettings, true, 'opened again');
    assert.equal(r.cn.paste, null, 'the paste box is gone');
    assert.equal(r.cn.twitchClientEmpty, true);
  });

  test('a flag switched on the page is an unsaved change: Cancel asks Save changes / Discard / Cancel', async () => {
    const k = await probe({ actions: [...open, ...WAIT, 'settings-flag:platform-connect:off', 'settings-cancel'] });
    assert.deepEqual([k.s.settings.unsavedOpen, k.s.settings.dirty], [true, true]);
    const d = await probe({ actions: [...open, ...WAIT, 'settings-flag:platform-connect:off', 'settings-cancel', 'settings-unsaved:discard', ...WAIT] });
    assert.equal(d.s.flagsInSettings, false);
    assert.equal(d.flags.isOn('platform-connect'), true, 'Discard keeps the flag on');
    const s = await probe({ actions: [...open, ...WAIT, 'settings-flag:platform-connect:off', 'settings-cancel', 'settings-unsaved:save', ...WAIT, ...WAIT] });
    assert.equal(s.flags.isOn('platform-connect'), false, 'Save changes switches it off');
  });
});
