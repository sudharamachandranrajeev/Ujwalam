// SPDX-License-Identifier: GPL-3.0-or-later
// BM7 clash checker tests: fake listener lists and fake hotkey data. Headless; no network, no window.
process.env.UJWALAM_HEADLESS = '1';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  BOT_PORTS, classifyOwner, evaluateHotkeys, evaluatePorts, extractCombos, formatText, normalizeCombo, runChecks,
  scanTextForBotPorts, staticPortCheck, streamerbotHotkeys, ujwalamHotkeys,
} from '../tools/bot-clash-check.mjs';

test('classifyOwner uses the process name only', () => {
  assert.equal(classifyOwner('Streamer.bot'), 'streamerbot');
  assert.equal(classifyOwner('Speaker.bot.exe'), 'speakerbot');
  assert.equal(classifyOwner('node'), 'ujwalam');
  assert.equal(classifyOwner('chrome'), 'other');
  assert.equal(classifyOwner(null), 'unknown');
});

test('ports: free, ok, clash by other, clash by Ujwalam, unknown owner', () => {
  const rows = evaluatePorts([
    { proto: 'tcp', port: 8083, name: 'Speaker.bot' },
    { proto: 'tcp', port: 8093, name: 'chrome' },
    { proto: 'tcp', port: 7474, name: 'node' },
    { proto: 'tcp', port: 9652, name: null },
    { proto: 'udp', port: 4242, name: 'Streamer.bot' },
    { proto: 'tcp', port: 4242, name: 'chrome' }, // wrong protocol: not a clash
  ]);
  const by = Object.fromEntries(rows.map((r) => [`${r.port}/${r.proto}`, r]));
  assert.equal(by['8083/tcp'].state, 'ok');
  assert.equal(by['8093/tcp'].state, 'clash');
  assert.equal(by['8093/tcp'].owner, 'other');
  assert.equal(by['7474/tcp'].state, 'clash');
  assert.equal(by['9652/tcp'].state, 'clash');
  assert.equal(by['4242/udp'].state, 'ok');
  assert.equal(by['8059/tcp'].state, 'free');
  assert.equal(rows.length, BOT_PORTS.length);
});

test('static scan: binds are flagged, clients and guards are not', () => {
  assert.equal(scanTextForBotPorts('server.listen(8093, "127.0.0.1")').length, 1);
  assert.equal(scanTextForBotPorts('const port = 7474;').length, 1);
  assert.equal(scanTextForBotPorts("const DEFAULT = 'ws://127.0.0.1:8093/';").length, 0);
  assert.equal(scanTextForBotPorts('if (v === 8093) refuse();').length, 0);
  assert.equal(scanTextForBotPorts('// never bind 8083').length, 0);
  assert.equal(scanTextForBotPorts('const port = 18093;').length, 0);
});

test('static scan of the real repo finds no Ujwalam bind on a bot port', () => {
  const r = staticPortCheck();
  assert.ok(r.ok && r.scanned > 20);
  assert.deepEqual(r.hits, []);
});

test('combos normalise; junk is rejected', () => {
  assert.equal(normalizeCombo('Ctrl+Alt+Shift+M'), 'ctrl+alt+shift+m');
  assert.equal(normalizeCombo('alt + Control + m'), 'ctrl+alt+m');
  assert.equal(normalizeCombo('M'), null);
  assert.equal(normalizeCombo('Ctrl+Alt'), null);
  assert.equal(normalizeCombo(42), null);
});

test('Ujwalam hotkeys are read from host_config.h', () => {
  const u = ujwalamHotkeys();
  assert.equal(u.ok, true);
  assert.deepEqual(u.combos.map((c) => `${c.name}:${c.combo}`),
    ['panic:ctrl+alt+p', 'feedback:ctrl+alt+f', 'marker:ctrl+alt+shift+m']);
});

test('extractCombos reads combos under hotkey-like keys only', () => {
  const j = { items: [{ name: 'Ctrl+Alt+P', token: 'Ctrl+Alt+Q', hotkey: 'Ctrl+Alt+P' }, { keys: ['Shift+F5'], chat: 'Ctrl+Alt+Z' }] };
  assert.deepEqual(extractCombos(j).sort(), ['ctrl+alt+p', 'shift+f5']);
});

test('hotkey clashes: against Streamer.bot and inside Ujwalam', () => {
  const u = [{ name: 'panic', combo: 'ctrl+alt+p' }, { name: 'marker', combo: 'ctrl+alt+shift+m' }];
  assert.deepEqual(evaluateHotkeys(u, ['ctrl+alt+p']), [{ combo: 'ctrl+alt+p', with: 'Streamer.bot', ujwalam: 'panic' }]);
  assert.deepEqual(evaluateHotkeys(u, []), []);
  assert.equal(evaluateHotkeys([...u, { name: 'dup', combo: 'ctrl+alt+p' }], []).length, 1);
});

test('streamerbotHotkeys: unset path = manual; fake file is read; bad file = manual', () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'bcc-'));
  try {
    const prof = path.join(d, 'p.json');
    writeFileSync(prof, JSON.stringify({ paths: { streamerbot_exe: '<streamerbot-exe>' } }));
    assert.equal(streamerbotHotkeys(prof).status, 'manual');
    writeFileSync(prof, JSON.stringify({ paths: { streamerbot_exe: path.join(d, 'sb', 'sb.exe') } }));
    assert.match(streamerbotHotkeys(prof).reason, /no hotkey definition file/);
    mkdirSync(path.join(d, 'sb', 'data'), { recursive: true });
    writeFileSync(path.join(d, 'sb', 'data', 'hotkeys.json'), JSON.stringify([{ hotkey: 'Ctrl+Alt+F' }]));
    assert.deepEqual(streamerbotHotkeys(prof), { status: 'checked', combos: ['ctrl+alt+f'], reason: null });
    writeFileSync(path.join(d, 'sb', 'data', 'hotkeys.json'), '{nope');
    assert.equal(streamerbotHotkeys(prof).status, 'manual');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

const okStatic = () => ({ ok: true, scanned: 3, hits: [] });
const okU = () => ({ ok: true, combos: [{ name: 'panic', combo: 'ctrl+alt+p' }] });

test('runChecks exit codes: 0 clean, 1 clash, 2 could not run, 1 wins', () => {
  const clean = runChecks({ listen: () => ({ ok: true, listeners: [] }), staticCheck: okStatic, uHot: okU, sHot: () => ({ status: 'manual', combos: [], reason: 'x' }) });
  assert.equal(clean.exit, 0);
  assert.match(clean.manual[0], /^Hotkeys: manual check/);
  const noList = runChecks({ listen: () => ({ ok: false, listeners: [], error: 'boom' }), staticCheck: okStatic, uHot: okU, sHot: () => ({ status: 'manual', reason: 'x' }) });
  assert.equal(noList.exit, 2);
  const clash = runChecks({ listen: () => ({ ok: true, listeners: [{ proto: 'tcp', port: 8083, name: 'chrome' }] }), staticCheck: okStatic, uHot: okU, sHot: () => ({ status: 'checked', combos: ['ctrl+alt+p'] }) });
  assert.equal(clash.exit, 1);
  assert.equal(clash.clashes.length, 2);
  const both = runChecks({ listen: () => ({ ok: false, error: 'x' }), staticCheck: okStatic, uHot: okU, sHot: () => ({ status: 'checked', combos: ['ctrl+alt+p'] }) });
  assert.equal(both.exit, 1);
});

test('text output has no command lines and states the exit', () => {
  const r = runChecks({ listen: () => ({ ok: true, listeners: [{ proto: 'tcp', port: 8093, name: 'Streamer.bot' }] }), staticCheck: okStatic, uHot: okU, sHot: () => ({ status: 'manual', reason: 'r' }) });
  const t = formatText(r);
  assert.match(t, /8093\s+tcp\s+streamerbot\s+ok\s+Streamer\.bot/);
  assert.match(t, /Exit 0/);
});
