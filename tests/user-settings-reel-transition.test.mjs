// SPDX-License-Identifier: GPL-3.0-or-later
// clips.reelTransition in <dataDir>/settings.json (RP1): the join between the pieces of a reel, Cut or Cross fade with
// its length. Same rules as services/clip/reel_transition.py transition_problems() (tests/py/test_reel_transition.py);
// kinds in data/clip/transitions.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSettings, reelTransitionInfo, reelTransitionProblems, settingsProblems, transitionDefaults, writeSettings } from '../services/studio-ui/user-settings.mjs';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'ujw-trans-'));
const withDir = (fn) => { const d = tmp(); try { return fn(d); } finally { rmSync(d, { recursive: true, force: true }); } };

test('defaults come from data/clip/transitions.json: Cut and Cross fade 150-500 ms (250), flag reel-transitions', () => {
  const d = transitionDefaults();
  assert.equal(d.flag, 'reel-transitions');
  assert.equal(d.default, 'fade');
  assert.deepEqual(d.kinds.map((k) => [k.id, k.label, k.ms]), [['cut', 'Cut', null], ['fade', 'Cross fade', { min: 150, max: 500, default: 250 }]]);
});

test('checks: a known kind, the length inside its range, both keys', () => {
  assert.deepEqual(settingsProblems({ clips: { reelTransition: { kind: 'fade', ms: 300 } } }), []);
  assert.deepEqual(reelTransitionProblems({ kind: 'cut', ms: 0 }), []);
  assert.deepEqual(reelTransitionProblems({ kind: 'fade', ms: 100 }), ['clips.reelTransition.ms must be 150-500']);
  assert.deepEqual(reelTransitionProblems({ kind: 'fade', ms: '250' }), ['clips.reelTransition.ms must be 150-500']);
  assert.deepEqual(reelTransitionProblems({ kind: 'wipe', ms: 250 }), ['clips.reelTransition.kind must be one of cut, fade']);
  assert.deepEqual(reelTransitionProblems({ kind: 'fade' }), ['clips.reelTransition needs kind and ms']);
  assert.deepEqual(settingsProblems({ clips: { reelTransition: [1] } }), ['clips.reelTransition needs kind and ms']);
});

test('stored on save, read back; a bad stored value reads as the default', () => withDir((d) => {
  assert.equal('reelTransition' in readSettings(d).clips, false);
  assert.deepEqual(reelTransitionInfo(d).kind, 'fade');
  assert.equal(reelTransitionInfo(d).ms, 250);
  writeSettings(d, { clips: { reelTransition: { kind: 'cut', ms: 0 } } });
  assert.deepEqual(JSON.parse(readFileSync(path.join(d, 'settings.json'), 'utf8')).clips.reelTransition, { kind: 'cut', ms: 0 });
  assert.deepEqual([reelTransitionInfo(d).kind, reelTransitionInfo(d).ms], ['cut', 0]);
  writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ clips: { reelTransition: { kind: 'fade', ms: 9000 } } }));
  assert.equal('reelTransition' in readSettings(d).clips, false);
  assert.deepEqual([reelTransitionInfo(d).kind, reelTransitionInfo(d).ms], ['fade', 250]);
}));
