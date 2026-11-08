// SPDX-License-Identifier: GPL-3.0-or-later
// ui.theme and ui.effects in <dataDir>/settings.json (D293): checked, saved, read back, merged with ui.motion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSettings, settingsProblems, writeSettings } from '../services/studio-ui/user-settings.mjs';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'ujw-theme-'));
const withDir = (fn) => { const d = tmp(); try { return fn(d); } finally { rmSync(d, { recursive: true, force: true }); } };

test('theme and effects checks: a theme id (any, custom ones too) and full|reduced, nothing else', () => {
  assert.deepEqual(settingsProblems({ ui: { theme: 'neon-arcade', effects: 'reduced', motion: 'off' } }), []);
  assert.deepEqual(settingsProblems({ ui: { theme: 'my-own-2' } }), []);
  for (const bad of ['', 'Neon Arcade', '../x', 'a--b', '-a', 'a'.repeat(41), 5, null]) {
    assert.equal(settingsProblems({ ui: { theme: bad } }).length, 1, String(bad));
  }
  for (const bad of ['low', 'FULL', true, null]) assert.equal(settingsProblems({ ui: { effects: bad } }).length, 1, String(bad));
  assert.equal(settingsProblems({ ui: { colour: 'red' } }).length, 1, 'unknown ui keys are still refused');
});

test('defaults: no theme or effects keys until the user chooses', () => withDir((d) => {
  assert.equal(readSettings(d).ui, undefined);
  writeSettings(d, { ui: { motion: 'on' } });
  assert.deepEqual(readSettings(d).ui, { motion: 'on' });
}));

test('saved and read back; a later change keeps the other ui keys', () => withDir((d) => {
  writeSettings(d, { ui: { theme: 'tactical' } });
  assert.deepEqual(readSettings(d).ui, { theme: 'tactical' });
  writeSettings(d, { ui: { effects: 'reduced' } });
  writeSettings(d, { ui: { motion: 'off' } });
  assert.deepEqual(readSettings(d).ui, { motion: 'off', theme: 'tactical', effects: 'reduced' });
  assert.equal(JSON.parse(readFileSync(path.join(d, 'settings.json'), 'utf8')).ui.theme, 'tactical');
  assert.equal(readSettings(d).clips.recording, 'ask', 'clip settings are untouched');
}));

test('a hand-edited bad value is ignored on read, the rest stays', () => withDir((d) => {
  writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ ui: { theme: 'Bad Name', effects: 'wild', motion: 'on' } }));
  assert.deepEqual(readSettings(d).ui, { motion: 'on' });
}));
