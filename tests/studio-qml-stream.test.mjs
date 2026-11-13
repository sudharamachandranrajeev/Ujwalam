// SPDX-License-Identifier: GPL-3.0-or-later
// Settings > Stream in the QML studio (plan Q3, slice 2): the QML twins of the widget StreamPage tests
// (studio-qt-d327.test.mjs: seed and platform limit, Edit output bitrate D377, a valid change saves;
// studio-qt-connect-button.test.mjs: Connect in the Edit output window), plus the portrait output resolution box (D378).
// Same probe actions as the widget (settings-open, settings-page:Stream, stream-kbps, stream-output-edit ...). Headless
// probe (UJWALAM_HEADLESS=1, offscreen, never on a screen) against a real UI server and the fake host; the setup lands in
// the test's own data folder. Skipped when the shell is not built.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFakeBots, createFakeHost } from '../services/studio-ui/backends.mjs';
import { createFlags } from '../services/flags/index.mjs';
import { createMemoryStores } from '../services/platform-connect/index.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';
import { createProjectSync } from '../services/studio-ui/project-sync.mjs';
import { createProject, saveProject } from '../services/project/index.mjs';
import { EXE, qtDir } from '../app/studio/tools/build.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const PACKAGED = process.env.UJWALAM_STUDIO_TEST_EXE ? path.resolve(process.env.UJWALAM_STUDIO_TEST_EXE) : null;
const SHELL_EXE = PACKAGED ?? EXE;
const QT = PACKAGED ? null : qtDir();
const skip = !existsSync(SHELL_EXE) || (!PACKAGED && !QT) ? 'studio shell not built (npm run build:studio)' : false;
const TWITCH_KEY = 'live_123456789_MockTwitchStreamKeyZZ9'; // lint-allow: secret (a made-up test marker, not a credential)

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

describe('QML studio Settings > Stream (headless probe)', { skip }, () => {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  async function probe({ actions = [], ms = Math.max(9000, 4000 + actions.length * 700), flagsOn = ['stream-settings'] } = {}) {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-qml-str-')); dirs.push(dataDir);
    const flags = createFlags({ dataDir });
    for (const id of flagsOn) flags.set(id, true);
    const file = path.join(dataDir, 'p.project.json');
    saveProject(file, createProject({ name: 'T', fps: 30 }));
    const fake = createFakeHost({ outputsReady: true });
    const host = { describe: () => fake.describe(), call: (m, p) => (m === 'outputs.status' ? { configured: true, sinks: [] } : fake.call(m, p)) };
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const mem = createMemoryStores({ 'Ujwalam/stream/twitch': TWITCH_KEY, 'Ujwalam/stream/twitch-server': 'rtmps://zz9-mock-ingest.example.net:443/app' });
    const key = 's'.repeat(40);
    const logs = [];
    const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: key, dataDir, flags, bots: createFakeBots(), projectSync: createProjectSync({ file }),
      limits: { statusPollMs: 50 }, tcpAnswers: async () => false, botConfig: () => ({}), connect: { storeFor: mem.storeFor, sleep: async () => {} }, log: (m) => logs.push(String(m)) });
    const { port } = await srv.listen();
    try {
      const r = await runShell({ UJWALAM_UI_URL: `http://127.0.0.1:${port}/`, UJWALAM_UI_LAUNCH_KEY: key, UJWALAM_STUDIO_PROBE_MS: String(ms),
        UJWALAM_STUDIO_PROBE_ACTIONS: actions.join(',') });
      assert.equal(r.code, 0, r.err);
      const m = /^studio probe: (.+)$/m.exec(r.out);
      assert.ok(m, `no probe line: ${r.out} ${r.err}`);
      assert.doesNotMatch(r.err, /\.qml:\d+.*(Error|TypeError|ReferenceError|Unable to assign|binding loop)/i, 'no QML errors');
      // Leak check (as the widget's connect test): the stored key is in no output of the shell, no log line and no file.
      assert.ok(!r.out.includes(TWITCH_KEY) && !r.err.includes(TWITCH_KEY), 'the key reached the shell output');
      assert.ok(!logs.some((l) => l.includes(TWITCH_KEY)), 'the key reached a server log line');
      for (const f of allFiles(dataDir)) assert.ok(!readFileSync(f, 'utf8').includes(TWITCH_KEY), `the key reached ${path.basename(f)}`);
      const p = JSON.parse(m[1]);
      const sf = path.join(dataDir, 'stream-setup.json');
      return { p, s: p.state, st: p.state.settings?.streamPage, dataDir, setup: existsSync(sf) ? JSON.parse(readFileSync(sf, 'utf8')) : null, out: r.out };
    } finally { await srv.close(); }
  }
  const node = (p, name) => p.tree.find((n) => n.name === name);
  const done = (p) => Object.fromEntries(p.actions.map((a) => [a.action, a.done]));
  const PAGE_NAMES = /^(stream(Mode|Resolution|PortraitOutput|Fps|Quality|Kbps|PortraitKbps|Hardware|Audio|Add|Edit|Delete|Problems|CanvasInfo|Output|NoOutputs)|outputRowText)/;
  const DIALOG_NAMES = /^output(Platform|Name|Canvas|OwnBitrate|Resolution|Bitrate|BitrateNote|Connect|ConnectStatus)$/;
  // The check after a change waits 250 ms on a QML timer, which runs slowly in the never-shown test window: a few quiet
  // actions give it time (the widget twin has a real QTimer). Real use is unaffected.
  const WAIT = ['settings-page:Stream', 'settings-page:Stream', 'settings-page:Stream'];
  const open = ['settings-open', 'settings-page:Stream'];

  // ---- twins of studio-qt-d327.test.mjs ----
  test('Settings > Stream: the seed is shown; a bitrate over a platform limit is refused with the limit; Edit opens its window', async () => {
    const r = await probe({ actions: [...open, 'stream-kbps:60000', ...WAIT, 'settings-save', 'stream-output-edit:0'] });
    const d = done(r.p);
    assert.equal(d['settings-page:Stream'], true);
    assert.ok(r.s.settings.sections.includes('Stream') && r.s.settings.sections.includes('Transitions') && r.s.settings.sections.includes('Chat & bots'));
    assert.equal(r.st.loaded, true);
    assert.ok(r.st.outputs.length >= 3, JSON.stringify(r.st.outputs));
    assert.match(r.st.problems, /50000/, 'the limit is shown on the page');
    assert.match(r.s.note, /Not saved: Settings > Stream has a value over a platform limit/, r.s.note);
    assert.equal(d['settings-save'], false, 'Save refused');
    assert.equal(r.s.flagsInSettings, true, 'Settings stayed open on the page');
    assert.equal(r.setup, null, 'the refused setup was not written');
    assert.ok(r.st.outputBitrate, 'the Edit output window was open');
    assert.equal(node(r.p, 'streamProblems').visible, true);
    assert.equal(node(r.p, 'streamKbps').value, 60000, 'the box shows the value');
  });

  test('Edit output: the Bitrate box shows what the output sends (the shared main bitrate unless it has its own), never a made-up 6000', async () => {
    // Seed: output 0 (YouTube main) shares the main canvas encoder; output 2 (Twitch) has its own re-encode bitrate.
    const a = await probe({ actions: [...open, 'stream-output-edit:0'] });
    const main = a.st.setup.video.bitrateKbps;
    assert.ok(a.st.setup.outputs[0].video === undefined, 'output 0 has no bitrate of its own in the seed');
    assert.notEqual(main, 6000, 'the seed main bitrate differs from the old default, so the check means something');
    assert.deepEqual({ ...a.st.outputBitrate, note: undefined }, { kbps: main, enabled: false, own: false, note: undefined });
    assert.match(a.st.outputBitrate.note, new RegExp(`main canvas stream: ${main} kbps`));
    // Ticking "Its own bitrate" starts from the shared value and makes the box editable.
    const b = await probe({ actions: [...open, 'stream-output-edit:0', ...WAIT, 'stream-output-own:1'] });
    assert.equal(done(b.p)['stream-output-own:1'], true, JSON.stringify(b.p.actions));
    assert.deepEqual({ ...b.st.outputBitrate, note: undefined }, { kbps: main, enabled: true, own: true, note: undefined });
    assert.match(b.st.outputBitrate.note, /its own encoder/);
    // An output with its own bitrate shows that one.
    const c = await probe({ actions: [...open, 'stream-output-edit:2'] });
    const own = c.st.setup.outputs[2].video?.bitrateKbps;
    assert.ok(own, JSON.stringify(c.st.setup.outputs[2]));
    assert.deepEqual({ ...c.st.outputBitrate, note: undefined }, { kbps: own, enabled: true, own: true, note: undefined });
    // The window's own boxes show the same (not only the probe's copy).
    assert.equal(node(c.p, 'outputBitrate').value, own);
    assert.equal(node(c.p, 'outputOwnBitrate').checked, true);
  });

  test('Settings > Stream: a valid change saves into the same stream-setup.json as the widget; Settings closes', async () => {
    const r = await probe({ actions: [...open, 'stream-kbps:12000', 'settings-save'] });
    assert.equal(r.setup.video.bitrateKbps, 12000);
    assert.equal(r.s.flagsInSettings, false, 'Settings closed');
    assert.match(r.s.note, /Settings saved\.|Stream settings saved; they apply the next time you go live\./);
  });

  test('Settings > Stream: with nothing changed, Save writes no stream setup', async () => {
    const r = await probe({ actions: [...open, 'settings-save'] });
    assert.equal(r.setup, null, 'an untouched page sends nothing (the setup file is only written by an edit)');
    assert.equal(r.s.settings, null);
  });

  // ---- the page's own rules (the widget's StreamPage) ----
  test('the page shows the setup: canvas mode, the boxes with their values, the outputs list; a change asks the server (250 ms) and shows the problems line', async () => {
    const r = await probe({ actions: [...open, 'stream-mode:multi', 'stream-pkbps:60000'] });
    assert.equal(r.st.setup.canvasMode, 'multi');
    assert.equal(node(r.p, 'streamMode:multi').checked, true);
    assert.equal(node(r.p, 'streamMode:main').checked, false);
    assert.equal(node(r.p, 'streamPortraitKbps').enabled, true, 'the portrait bitrate is for the portrait mode');
    assert.match(r.st.problems, /50000|limit/i, r.st.problems);
    assert.match(node(r.p, 'streamCanvasInfo').text, /^Canvas resolution: /);
    const m = await probe({ actions: [...open, 'stream-mode:main'] });
    assert.equal(node(m.p, 'streamPortraitKbps').enabled, false);
    for (const [name, key] of [['streamKbps', 'bitrateKbps'], ['streamPortraitKbps', 'portraitBitrateKbps']]) assert.equal(node(m.p, name).value, m.st.setup.video[key], name);
    for (const id of m.st.outputs) assert.ok(node(m.p, `streamOutput:${id}`), id);
    assert.equal(node(m.p, 'streamProblems').visible, m.st.problems !== '');
  });

  test('Add output, then Delete: the list changes as a draft; Save writes it; Delete asks nothing', async () => {
    const del = await probe({ actions: [...open, 'stream-output-delete-now:1', 'settings-save'], ms: 9000 });
    assert.equal(done(del.p)['stream-output-delete-now:1'], true);
    const base = await probe({ actions: [...open] });
    assert.equal(del.setup.outputs.length, base.st.outputs.length - 1);
    assert.ok(!del.setup.outputs.some((o) => o.id === base.st.outputs[1]));
    const draft = await probe({ actions: [...open, 'stream-output-delete-now:1'] });
    assert.equal(draft.st.outputs.length, base.st.outputs.length - 1);
    assert.equal(draft.s.settings.dirty, true);
    assert.equal(draft.setup, null, 'nothing written before Save');
    // a real click on Edit (no row picked: disabled), Add output opens the window with the first platform
    const add = await probe({ actions: [...open, 'click:streamAdd', ...WAIT] });
    assert.ok(add.st.outputBitrate, 'Add output opened the window');
    assert.equal(node(add.p, 'outputBox').opened, true);
    assert.equal(node(add.p, 'outputPlatform').enabled, true, 'a new output picks its platform');
    assert.equal(node(add.p, 'streamEdit').enabled, false, 'Edit needs a row');
  });

  test('Add output: OK adds a draft row with a new id; Cancel adds nothing', async () => {
    const ok = await probe({ actions: [...open, 'stream-output-add', ...WAIT, 'click:outputOk', ...WAIT, 'settings-save'] });
    const base = await probe({ actions: [...open] });
    assert.equal(ok.setup.outputs.length, base.st.outputs.length + 1);
    const added = ok.setup.outputs.at(-1);
    assert.equal(added.id, 'youtube', 'the first platform, and the first id of it that is free (the seed uses youtube-h and youtube-v)');
    assert.deepEqual([added.platform, added.canvas, added.enabled], ['youtube', 'H', true]);
    assert.equal(added.video, undefined, 'it shares the main canvas encoder');
    const no = await probe({ actions: [...open, 'stream-output-add', ...WAIT, 'click:outputCancel'] });
    assert.equal(no.st.outputs.length, base.st.outputs.length);
    assert.equal(no.s.settings.dirty, false);
  });

  test('Edit output: its own bitrate is saved on the output; clearing it takes the output back to the shared encoder', async () => {
    const own = await probe({ actions: [...open, 'stream-output-edit:0', ...WAIT, 'stream-output-own:1', 'click:outputOk', ...WAIT, 'settings-save'] });
    const main = own.setup.video.bitrateKbps;
    assert.deepEqual(own.setup.outputs[0].video, { output: own.setup.video.output, bitrateKbps: main });
    // Twitch gives its own bitrate up and shares the 1080p60 main canvas encoder: over Twitch's limit, so the page says so and Save is refused
    const clear = await probe({ actions: [...open, 'stream-output-edit:2', ...WAIT, 'stream-output-own:0', 'click:outputOk', ...WAIT, 'settings-save'] });
    assert.equal(clear.st.setup.outputs[2].video, undefined, 'the output is back on the shared encoder');
    assert.match(clear.st.problems, /twitch/i, clear.st.problems);
    assert.equal(clear.setup, null, 'nothing written');
  });

  // ---- D378: the portrait output resolution ----
  test('Portrait output resolution: lists the options, shows the saved one, and Save writes video.portraitOutput', async () => {
    const q = await probe({ actions: [...open] });
    assert.deepEqual(q.st.portraitOutput.choices, ['1080x1920', '1440x2560', '2160x3840']);
    assert.equal(q.st.portraitOutput.enabled, true);
    assert.equal(q.st.portraitOutput.value, q.st.setup.video.portraitOutput, 'the box shows the setup');
    const box = node(q.p, 'streamPortraitOutput');
    assert.ok(box, 'the combo is in the window');
    assert.match(box.text, /1080x1920|1440x2560|2160x3840/);
    const p = await probe({ actions: [...open, 'stream-portrait:1440x2560', ...WAIT, 'stream-output-edit:0'], ms: 9000 });
    assert.equal(done(p.p)['stream-portrait:1440x2560'], true);
    assert.equal(p.st.portraitOutput.value, '1440x2560');
    assert.equal(node(p.p, 'streamPortraitOutput').text, '1440x2560 (2K)');
    const s = await probe({ flagsOn: ['stream-settings', 'stream-upscale'], actions: [...open, 'stream-portrait:1440x2560', 'settings-save'] }); // above the canvas size needs the switch
    assert.equal(s.setup.video.portraitOutput, '1440x2560');
    const bad = await probe({ actions: [...open, 'stream-portrait:nope'] });
    assert.equal(done(bad.p)['stream-portrait:nope'], false);
  });

  // ---- twins of studio-qt-connect-button.test.mjs ----
  test('Connect, flag off: disabled with a tooltip saying how to turn it on; no status on the rows', async () => {
    const r = await probe({ actions: [...open, 'stream-output-edit:2'] });
    const b = r.st.connectButton;
    assert.ok(b, JSON.stringify(r.st));
    assert.equal(b.enabled, false);
    assert.match(b.tooltip, /Platform sign-in/, 'the flag is named by its plain label');
    assert.match(b.tooltip, /Settings > Connections/);
    assert.equal(r.st.connectOn, false);
    assert.deepEqual(r.st.rowStatus, []);
    assert.doesNotMatch(`${b.tooltip} ${b.status}`, /platform-connect/, 'plain words: no flag id');
  });

  test('Connect, flag on: enabled, shows the state (last 4 only); the click goes to Settings > Connections for sign-in', async () => {
    const r = await probe({ flagsOn: ['stream-settings', 'platform-connect'], actions: [...open, 'stream-output-edit:2'] });
    const sp = r.st;
    assert.equal(sp.outputs[2], 'twitch', JSON.stringify(sp.outputs));
    assert.equal(sp.connectOn, true);
    assert.equal(sp.connectButton.enabled, true);
    assert.match(sp.connectButton.tooltip, /Sign in to the platform, or paste/);
    assert.equal(sp.connectButton.status, `Connected  (key ....${TWITCH_KEY.slice(-4)})`);
    assert.ok(sp.rowStatus.length >= 3, JSON.stringify(sp.rowStatus));
    assert.ok(sp.rowStatus.some((t) => t.includes(`key ....${TWITCH_KEY.slice(-4)}`)), 'the output row shows the state');
    assert.ok(sp.rowStatus.some((t) => t.includes('Not connected')), 'an output without a key shows Not connected');
    const c = await probe({ flagsOn: ['stream-settings', 'platform-connect'], actions: [...open, 'stream-output-edit:2', ...WAIT, 'stream-output-connect'] });
    assert.equal(done(c.p)['stream-output-connect'], true);
    assert.equal(c.s.settings.page, 'Connections', 'the sign-in is on the Connections page (the flow window is not in this studio yet)');
    assert.equal(node(c.p, 'outputBox').opened, false, 'the Edit output window closed');
  });

  test('Connect, flag on: a new output that is not saved yet cannot be connected, and the tooltip says what to do', async () => {
    const r = await probe({ flagsOn: ['stream-settings', 'platform-connect'], actions: [...open, 'stream-output-add'] });
    const b = r.st.connectButton;
    assert.ok(b, JSON.stringify(r.st));
    assert.equal(b.enabled, false);
    assert.match(b.tooltip, /Save this output first/);
    assert.match(b.status, /Not connected/);
  });

  // ---- the window's rules ----
  test('flag stream-settings off: the page says which switch to turn on and shows no stream settings', async () => {
    const r = await probe({ flagsOn: [], actions: ['settings-open', 'settings-page:Stream'] });
    assert.match(node(r.p, 'settingsLead:Stream').text, /^Switch on Stream settings below and click Save to use these settings\.$/);
    assert.equal(r.s.settings.streamPage, null);
    assert.equal(node(r.p, 'streamKbps').visible, false);
    assert.equal(r.s.settings.dirty, false);
  });

  test('flag on: no sideways scrolling, plain words only (no decision numbers, no file paths), every control inside the page', async () => {
    const r = await probe({ flagsOn: ['stream-settings', 'stream-upscale'], actions: [...open, 'stream-output-edit:0'] });
    const page = node(r.p, 'settingsPage:Stream');
    assert.ok(page && page.visible);
    const [px, , pw] = page.rect;
    const mine = r.p.tree.filter((x) => x.visible && x.rect && x.rect[2] > 0 && PAGE_NAMES.test(x.name));
    assert.ok(mine.length > 15, `${mine.length} named controls on the page`);
    for (const n of mine) assert.ok(n.rect[0] >= px - 1 && n.rect[0] + n.rect[2] <= px + pw + 1, `${n.name} ends inside the page (${n.rect} vs ${page.rect})`);
    const words = r.p.tree.filter((x) => PAGE_NAMES.test(x.name) && typeof x.text === 'string').map((x) => x.text).join('\n');
    assert.doesNotMatch(words, /\bD\d{2,}\b|[\\/][\w.-]+\.(json|mjs|cpp|md)\b/, 'no decision numbers or file paths in the words');
    // the Edit output window fits its own width as well
    const box = node(r.p, 'outputPlatform'); // as wide as the Edit output window's content
    assert.ok(box && node(r.p, 'outputBox').opened);
    for (const n of r.p.tree.filter((x) => x.visible && x.rect && x.rect[2] > 0 && DIALOG_NAMES.test(x.name))) {
      assert.ok(n.rect[0] >= box.rect[0] - 1 && n.rect[0] + n.rect[2] <= box.rect[0] + box.rect[2] + 1, `${n.name} inside the Edit output window (${n.rect} vs ${box.rect})`);
    }
  });

  test('Cancel with a Stream change asks Save changes / Discard / Cancel; Discard saves nothing', async () => {
    const r = await probe({ actions: [...open, 'stream-kbps:12000', 'settings-cancel', 'settings-unsaved:discard'], ms: 9000 });
    assert.equal(done(r.p)['settings-cancel'], true);
    assert.equal(r.s.flagsInSettings, false);
    assert.equal(r.setup, null);
    const k = await probe({ actions: [...open, 'stream-kbps:12000', 'settings-cancel'] });
    assert.deepEqual([k.s.settings.unsavedOpen, k.s.settings.dirty], [true, true]);
  });
});
