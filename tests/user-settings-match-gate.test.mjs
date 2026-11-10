// SPDX-License-Identifier: GPL-3.0-or-later
// clips.matchGate in <dataDir>/settings.json (D286 proposed): which matches become clips. Same rules as the Python
// side (services/clip/clip_common.match_gate_settings, tests/py/test_clip_match_gate.py).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS, matchGateProblems, readSettings, settingsProblems, writeSettings } from '../services/studio-ui/user-settings.mjs';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'ujw-gate-'));

test('matchGate defaults: top 3 on, kills rule off', () => {
  assert.deepEqual(DEFAULTS.clips.matchGate, { top3: true, minKills: null });
  const d = tmp();
  try { assert.deepEqual(readSettings(d).clips.matchGate, { top3: true, minKills: null }); } finally { rmSync(d, { recursive: true, force: true }); }
});

test('matchGate checks: top3 boolean, minKills null or a whole number 1-200, nothing else', () => {
  assert.deepEqual(settingsProblems({ clips: { matchGate: { top3: false, minKills: 12 } } }), []);
  assert.deepEqual(settingsProblems({ clips: { matchGate: { minKills: null } } }), []);
  assert.deepEqual(settingsProblems({ clips: { matchGate: { minKills: 1 } } }), []);
  assert.deepEqual(settingsProblems({ clips: { matchGate: { minKills: 200 } } }), []);
  assert.deepEqual(matchGateProblems({ top3: 'yes' }), ['clips.matchGate.top3 must be true or false']);
  for (const bad of [0, 201, 2.5, '10', true, -1]) {
    assert.deepEqual(matchGateProblems({ minKills: bad }), ['clips.matchGate.minKills must be null or a whole number 1-200'], String(bad));
  }
  assert.deepEqual(matchGateProblems({ maxDeaths: 3 }), ['unknown match gate setting maxDeaths']);
  assert.deepEqual(matchGateProblems(null), ['clips.matchGate must be an object']);
  assert.deepEqual(matchGateProblems([1]), ['clips.matchGate must be an object']);
});

test('matchGate write merges part by part and keeps the other clip settings', () => {
  const d = tmp();
  try {
    writeSettings(d, { clips: { recording: 'after' } });
    writeSettings(d, { clips: { matchGate: { minKills: 15 } } });
    assert.deepEqual(readSettings(d).clips, { recording: 'after', live: 'ask', recordLive: true, matchGate: { top3: true, minKills: 15 } });
    writeSettings(d, { clips: { matchGate: { top3: false } } });
    assert.deepEqual(readSettings(d).clips.matchGate, { top3: false, minKills: 15 });
    writeSettings(d, { clips: { live: 'off' } });
    assert.deepEqual(readSettings(d).clips.matchGate, { top3: false, minKills: 15 }, 'a later clip change keeps the gate');
    const file = JSON.parse(readFileSync(path.join(d, 'settings.json'), 'utf8'));
    assert.deepEqual(file.clips.matchGate, { top3: false, minKills: 15 }, 'stored as clips.matchGate (what the clipper reads)');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('matchGate read: a bad part falls back to its default, the good part stays', () => {
  const d = tmp();
  try {
    writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ clips: { matchGate: { top3: false, minKills: 999 } } }));
    assert.deepEqual(readSettings(d).clips.matchGate, { top3: false, minKills: null });
    writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ clips: { matchGate: 'on' } }));
    assert.deepEqual(readSettings(d).clips.matchGate, { top3: true, minKills: null });
  } finally { rmSync(d, { recursive: true, force: true }); }
});
