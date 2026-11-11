// SPDX-License-Identifier: GPL-3.0-or-later
// clips.reelLengths in <dataDir>/settings.json (CL1, D350): the longest and shortest reel of each type. Same rules as
// services/clip/reel_length.py (tests/py/test_reel_length.py); defaults and the 60 s bound are data/clip/reel-length.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reelDefaults, reelLengthInfo, reelLengthProblems, readSettings, settingsProblems, writeSettings } from '../services/studio-ui/user-settings.mjs';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'ujw-reel-'));
const withDir = (fn) => { const d = tmp(); try { return fn(d); } finally { rmSync(d, { recursive: true, force: true }); } };

test('defaults come from data/clip/reel-length.json: 60 s maximum, the current minimums', () => {
  const d = reelDefaults();
  assert.equal(d.limitMaxSec, 60);
  assert.deepEqual(d.types.map((t) => t.id), ['montage', 'match-reel', 'impact-play', 'short', 'live-clip']);
  assert.ok(d.types.every((t) => t.maxSec === 60));
  assert.deepEqual(d.types.map((t) => t.minSec), [20, 0, 10, 10, 20]);
});

test('checks: both numbers, minimum <= maximum, maximum 5 to 60 s, known types only', () => {
  assert.deepEqual(settingsProblems({ clips: { reelLengths: { montage: { minSec: 10, maxSec: 45 } } } }), []);
  assert.deepEqual(settingsProblems({ clips: { reelLengths: { montage: { minSec: 0, maxSec: 60 } } } }), []);
  assert.deepEqual(reelLengthProblems({ montage: { minSec: 50, maxSec: 40 } }), ['montage: the minimum cannot be longer than the maximum']);
  assert.deepEqual(reelLengthProblems({ montage: { minSec: 0, maxSec: 61 } }), ['montage: the maximum cannot be above 60 s']);
  assert.deepEqual(reelLengthProblems({ montage: { minSec: 0, maxSec: 4 } }), ['montage: the maximum cannot be below 5 s']);
  assert.deepEqual(reelLengthProblems({ montage: { minSec: 10, maxSec: 30.4 } }), ['montage: lengths are whole seconds']);
  assert.deepEqual(reelLengthProblems({ montage: { minSec: 10.5, maxSec: 30 } }), ['montage: lengths are whole seconds']);
  assert.deepEqual(reelLengthProblems({ montage: { minSec: -1, maxSec: 30 } }), ['montage: the minimum cannot be below 0 s']);
  assert.deepEqual(reelLengthProblems({ reel: { minSec: 1, maxSec: 30 } }), ['unknown reel type reel']);
  assert.deepEqual(reelLengthProblems({ montage: { minSec: 1 } }), ['clips.reelLengths.montage needs minSec and maxSec']);
  assert.deepEqual(reelLengthProblems({ montage: { minSec: '1', maxSec: 30 } }), ['clips.reelLengths.montage lengths must be numbers']);
  assert.deepEqual(reelLengthProblems([1]), ['clips.reelLengths must be an object']);
  assert.ok(settingsProblems({ clips: { reelLengths: { montage: { minSec: 50, maxSec: 40 } } } }).length > 0);
});

test('nothing stored until the user changes a type; a write merges type by type', () => withDir((d) => {
  assert.equal('reelLengths' in readSettings(d).clips, false);
  writeSettings(d, { clips: { reelLengths: { montage: { minSec: 10, maxSec: 30 } } } });
  writeSettings(d, { clips: { reelLengths: { 'match-reel': { minSec: 0, maxSec: 45 } } } });
  writeSettings(d, { clips: { live: 'off' } });
  assert.deepEqual(readSettings(d).clips.reelLengths, { montage: { minSec: 10, maxSec: 30 }, 'match-reel': { minSec: 0, maxSec: 45 } });
  const file = JSON.parse(readFileSync(path.join(d, 'settings.json'), 'utf8'));
  assert.deepEqual(file.clips.reelLengths.montage, { minSec: 10, maxSec: 30 }, 'stored where the clipper reads it');
}));

test('a type set back to its default is not stored; the key goes when none is left', () => withDir((d) => {
  writeSettings(d, { clips: { reelLengths: { montage: { minSec: 10, maxSec: 30 } } } });
  writeSettings(d, { clips: { reelLengths: { montage: { minSec: 20, maxSec: 60 } } } });
  assert.equal('reelLengths' in readSettings(d).clips, false);
  assert.equal('reelLengths' in JSON.parse(readFileSync(path.join(d, 'settings.json'), 'utf8')).clips, false);
}));

test('a bad stored value is ignored, the good one stays', () => withDir((d) => {
  writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ clips: { reelLengths: { montage: { minSec: 10, maxSec: 30 }, 'match-reel': { minSec: 50, maxSec: 40 }, short: { minSec: 1, maxSec: 99 } } } }));
  assert.deepEqual(readSettings(d).clips.reelLengths, { montage: { minSec: 10, maxSec: 30 } });
}));

test('the page info lists every type with the user value and the default', () => withDir((d) => {
  writeSettings(d, { clips: { reelLengths: { montage: { minSec: 10, maxSec: 30 } } } });
  const info = reelLengthInfo(d);
  assert.equal(info.limitMaxSec, 60);
  const m = info.types.find((t) => t.id === 'montage');
  assert.deepEqual([m.minSec, m.maxSec, m.defaultMinSec, m.defaultMaxSec], [10, 30, 20, 60]);
  const s = info.types.find((t) => t.id === 'short');
  assert.deepEqual([s.minSec, s.maxSec], [10, 60]);
}));
