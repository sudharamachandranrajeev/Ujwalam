// SPDX-License-Identifier: GPL-3.0-or-later
// clips.reelHooks in <dataDir>/settings.json (ED1, D352): "Open with the best moment" and the teaser length per reel
// type. Same rules as services/clip/reel_hook.py hooks_problems() (tests/py/test_reel_hook.py); defaults in
// data/clip/reel-hook.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hookDefaults, readSettings, reelHookInfo, reelHookProblems, settingsProblems, writeSettings } from '../services/studio-ui/user-settings.mjs';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'ujw-hook-'));
const withDir = (fn) => { const d = tmp(); try { return fn(d); } finally { rmSync(d, { recursive: true, force: true }); } };

test('defaults come from data/clip/reel-hook.json: four reel types, on, 2 s teaser, 1-3 s range, flag reel-hook', () => {
  const d = hookDefaults();
  assert.equal(d.flag, 'reel-hook');
  assert.deepEqual([d.teaserMin, d.teaserMax], [1, 3]);
  assert.deepEqual(d.types.map((t) => [t.id, t.strategy, t.on, t.teaserSec]),
    [['montage', 'reorder', true, 2], ['match-reel', 'teaser', true, 2], ['impact-play', 'teaser', true, 2], ['live-clip', 'teaser', true, 2]]);
});

test('checks: on is a boolean, teaser whole seconds 1 to 3, known types only', () => {
  assert.deepEqual(settingsProblems({ clips: { reelHooks: { montage: { on: false, teaserSec: 3 } } } }), []);
  assert.deepEqual(reelHookProblems({ montage: { on: true, teaserSec: 4 } }), ['montage: the teaser length must be 1 to 3 s']);
  assert.deepEqual(reelHookProblems({ montage: { on: true, teaserSec: 0 } }), ['montage: the teaser length must be 1 to 3 s']);
  assert.deepEqual(reelHookProblems({ montage: { on: true, teaserSec: 1.5 } }), ['montage: the teaser length is whole seconds']);
  assert.deepEqual(reelHookProblems({ montage: { on: 'yes', teaserSec: 2 } }), ['clips.reelHooks.montage.on must be true or false']);
  assert.deepEqual(reelHookProblems({ short: { on: true, teaserSec: 2 } }), ['unknown reel type short']);
  assert.deepEqual(reelHookProblems({ montage: { on: true } }), ['clips.reelHooks.montage needs on and teaserSec']);
  assert.deepEqual(reelHookProblems([1]), ['clips.reelHooks must be an object']);
});

test('nothing stored until changed; per-type merge; a value equal to the default is dropped', () => withDir((d) => {
  assert.equal('reelHooks' in readSettings(d).clips, false);
  writeSettings(d, { clips: { reelHooks: { 'match-reel': { on: false, teaserSec: 2 } } } });
  writeSettings(d, { clips: { reelHooks: { montage: { on: true, teaserSec: 3 } } } });
  const j = JSON.parse(readFileSync(path.join(d, 'settings.json'), 'utf8'));
  assert.deepEqual(j.clips.reelHooks, { 'match-reel': { on: false, teaserSec: 2 }, montage: { on: true, teaserSec: 3 } });
  writeSettings(d, { clips: { reelHooks: { 'match-reel': { on: true, teaserSec: 2 }, montage: { on: true, teaserSec: 2 } } } });
  assert.equal('reelHooks' in JSON.parse(readFileSync(path.join(d, 'settings.json'), 'utf8')).clips, false);
}));

test('reelHookInfo: the page rows with defaults and the user values; a bad stored value reads as the default', () => withDir((d) => {
  writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ clips: { reelHooks: { montage: { on: false, teaserSec: 1 }, 'live-clip': { on: true, teaserSec: 9 } } } }));
  const info = reelHookInfo(d);
  assert.deepEqual([info.teaserMin, info.teaserMax], [1, 3]);
  const by = Object.fromEntries(info.types.map((t) => [t.id, t]));
  assert.deepEqual([by.montage.on, by.montage.teaserSec, by.montage.defaultOn, by.montage.defaultTeaserSec], [false, 1, true, 2]);
  assert.deepEqual([by['live-clip'].on, by['live-clip'].teaserSec], [true, 2]);
}));
