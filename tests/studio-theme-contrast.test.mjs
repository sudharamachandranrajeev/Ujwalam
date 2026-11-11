// SPDX-License-Identifier: GPL-3.0-or-later
// Theme framework contrast (D336, T1): for every pack in data/themes and every state a component has (normal, hover,
// pressed, checked or selected, focus, error), the colours the studio paints are checked: text >= 4.5:1 against what
// it sits on, control parts and focus indicators >= 3:1 against what they sit next to. Disabled text is exempt
// (WCAG 1.4.3), and borders that only decorate a filled control are not checked (the fill, the label and the state
// carry the meaning). The pairs come from the base stylesheet in app/studio/src/theme.cpp, the variant fragments
// (componentQss) for the variants a pack picks, and the painted Switch; derived() mirrors theme.cpp's derived():
// change both together. A table for every variant in the schema is required, so a new variant cannot skip the check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
// The pair tables, derived() and the check itself live in the shared module, so the scene builder's generated packs
// (SB4, D345) are checked by the same rules.
import { CTRL, contrast, failures, mix, VARIANTS } from '../services/studio-ui/theme-contrast.mjs';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'themes');
const read = (f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
const schema = read('theme.schema.json');
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
const packs = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'theme.schema.json').map((f) => read(f));

test('every variant in the schema has a contrast table (and only those)', () => {
  const comp = schema.properties.components.properties;
  const keys = [];
  for (const [k, s] of Object.entries(comp)) {
    if (s.type === 'object') for (const [k2, s2] of Object.entries(s.properties)) keys.push([`${k}.${k2}`, s2.enum ?? (s2.type === 'boolean' ? ['true', 'false'] : null)]);
    else keys.push([k, s.enum]);
  }
  assert.deepEqual(keys.map(([k]) => k).sort(), Object.keys(VARIANTS).sort());
  for (const [k, values] of keys) assert.deepEqual([...values].map(String).sort(), Object.keys(VARIANTS[k]).sort(), k);
});

// Gaps in the shipped looks. The list is exact: a new gap fails, and so does a fixed one (remove it here). Empty since
// T6 (D348): Tactical's warning text was the last one, fixed by a lighter danger colour.
const KNOWN_BASE_GAPS = [];

test('every pack, every state: text >= 4.5:1, controls and focus >= 3:1 (base look plus the variants it picks)', () => {
  const bad = packs.flatMap(failures);
  assert.deepEqual(bad, KNOWN_BASE_GAPS);
});

// The base Switch (no variant; switch_widget.cpp paintEvent) paints the knob and ON in the text colour on the accent
// track, which is below 3:1 in most packs. It is unchanged with the flag off (the v1 look); every switch variant paints
// onAccent on the "on" track instead, and this shows each of the three passes on every shipped pack.
test('base Switch gap: the ON side fails in the base look, every switch variant passes on every pack', () => {
  const base = packs.filter((p) => contrast(p.colors.text, p.colors.accent) < CTRL).map((p) => p.id);
  assert.ok(base.length > 0, 'the base gap is still there (update this test and D336 when it is fixed)');
  for (const p of packs)
    for (const v of Object.keys(VARIANTS.switch)) {
      const bad = failures({ ...p, components: { switch: v } }).filter((f) => f.includes('switch'));
      assert.deepEqual(bad, [], `${p.id} switch ${v}`);
    }
});

test('the check sees the variants: a pack whose variant breaks contrast fails it', () => {
  const p = structuredClone(read('violet-night.json'));
  assert.deepEqual(failures(p), []);
  p.components = { 'button': { secondary: 'ghost' } };
  p.colors.accentHi = p.colors.panel; // ghost label in the panel colour: unreadable
  assert.ok(failures(p).some((f) => f.includes('ghost button label')), failures(p).join('\n'));
});

test('derived colours match theme.cpp for a sample (mix rounding)', () => {
  assert.equal(mix('#000000', '#ffffff', 0.5), '#808080');
  assert.equal(mix('#242132', '#8650f0', 0.18), '#362954');
});

test('schema v2: a full components block validates; unknown variants and keys are refused', () => {
  const base = read('teal-grid.json');
  const ok = { ...base, components: { button: { shape: 'pill', style: 'metal', secondary: 'tinted', caps: true }, tabs: 'underline', input: 'inset', focus: 'ring', switch: 'bezel', slider: { track: 'inset', handle: 'sphere', valueBubble: true }, sectionHeader: 'bracket', card: 'framed', list: 'plates', chip: 'bracket', density: 'airy' } };
  assert.ok(validate(ok), JSON.stringify(validate.errors));
  for (const components of [{ tabs: 'wavy' }, { sparkle: 'on' }, { button: { style: 'glass' } }, { button: { size: 'xl' } }, { slider: { handle: 'cube' } }, { density: 'tight' }])
    assert.equal(validate({ ...base, components }), false, JSON.stringify(components));
  assert.ok(validate({ ...base, typography: { ...base.typography, buttonCaps: true, tabCaps: true, headingCaps: false, scale: { h1: 16, body: 10 } } }), JSON.stringify(validate.errors));
  assert.equal(validate({ ...base, typography: { ...base.typography, scale: { h1: 40 } } }), false, 'type scale stays in 6..28 pt');
  assert.ok(validate({ ...base, background: { kind: 'pattern', pattern: 'blueprint', patternColor: '#5fd9e3', patternOpacity: 0.06, patternSpacing: 24, frame: { ticks: true, opacity: 0.35 } } }), JSON.stringify(validate.errors));
  assert.ok(validate({ ...base, background: { kind: 'pattern', pattern: 'columns', patternColor: '#5fd9e3', patternOpacity: 0.06, patternSpacing: 24 } }), JSON.stringify(validate.errors));
  assert.equal(validate({ ...base, background: { ...base.background, frame: { ticks: true, opacity: 0.9 } } }), false, 'frame opacity <= 0.6');
  const depth = { ...base.depth, card: { highlight: { blur: 10, offsetX: -3, offsetY: -3, color: '#ffffff', opacity: 0.08 }, inset: { blur: 6, offsetX: 1, offsetY: 2, color: '#000000', opacity: 0.4, when: 'pressed' }, rim: { from: 'accentHi', to: '#7a5a20', width: 2, innerGlow: { color: 'accent', opacity: 0.5, width: 1 } } } };
  assert.ok(validate({ ...base, depth }), JSON.stringify(validate.errors));
  assert.equal(validate({ ...base, depth: { ...base.depth, card: { rim: { from: 'accent', to: 'accent', width: 9 } } } }), false, 'rim width 1..4');
});
