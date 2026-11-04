// SPDX-License-Identifier: GPL-3.0-or-later
// data/sessions.json must match data/sessions.schema.json (P2a A2b).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate = ajv.compile(readJson(path.join(repo, 'data', 'sessions.schema.json')));
const doc = readJson(path.join(repo, 'data', 'sessions.json'));

test('data/sessions.json matches its schema', () => {
  assert.ok(validate(doc), JSON.stringify(validate.errors));
});

test('session ids are unique and every rule entry has times and a clip count', () => {
  const ids = doc.sessions.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const s of doc.sessions.filter((x) => x.source === 'rule')) {
    assert.ok(s.clipCount >= 1 && s.startUtc && s.endUtc, s.id);
  }
});

const clip = 'MeldStudio_Clip_Clipping_Output_2026-10-20_at_12.15.10pm.mp4';
const base = { version: 1, defaults: { gapThresholdSec: 120 } };

test('schema: a manual entry needs only id, source, firstClip, lastClip (note optional)', () => {
  const ok = { ...base, sessions: [{ id: 's-x', source: 'manual', firstClip: clip, lastClip: clip, note: 'split by hand' }] };
  assert.ok(validate(ok), JSON.stringify(validate.errors));
  const bad = { ...base, sessions: [{ id: 's-x', source: 'manual', firstClip: clip }] };
  assert.equal(validate(bad), false);
});

test('schema: a rule entry without clipCount or times is rejected', () => {
  const bad = { ...base, sessions: [{ id: 's-x', source: 'rule', firstClip: clip, lastClip: clip }] };
  assert.equal(validate(bad), false);
});

test('schema: unknown keys, bad source and non-positive threshold are rejected', () => {
  assert.equal(validate({ ...base, sessions: [{ id: 's-x', source: 'auto', firstClip: clip, lastClip: clip }] }), false);
  assert.equal(validate({ ...base, sessions: [{ id: 's-x', source: 'manual', firstClip: clip, lastClip: clip, viewer: 'x' }] }), false);
  assert.equal(validate({ version: 1, defaults: { gapThresholdSec: 0 }, sessions: [] }), false);
});
