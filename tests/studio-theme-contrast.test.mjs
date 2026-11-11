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

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'themes');
const read = (f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
const schema = read('theme.schema.json');
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
const packs = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'theme.schema.json').map((f) => read(f));

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const toHex = (c) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
const lum = (h) => {
  const c = hex(h).map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
// a + (b - a) * t per channel, rounded (theme.cpp mixc()); Math.round and std::lround agree for these positive values
const mix = (a, b, t) => { const x = hex(a), y = hex(b); return toHex(x.map((v, i) => Math.round(v + (y[i] - v) * t))); };

// theme.cpp derived()
function derived(p) {
  const c = p.colors;
  const well = mix(c.field, '#000000', p.dark ? 0.28 : 0.06);
  return {
    tint: mix(c.field, c.accent, 0.18), focusTint: mix(c.field, c.accent, 0.10), well, wellShade: mix(well, '#000000', 0.35),
    accentDim: mix(c.border, c.accent, 0.45), metalHi: mix(c.field, c.text, 0.10), metalLo: mix(c.field, '#000000', 0.25),
    accentTop: mix(c.accent, '#ffffff', 0.12), accentBot: mix(c.accent, '#000000', 0.12), sphereHi: mix(c.accent, '#ffffff', 0.5),
  };
}

// Surfaces a control sits on: the window, panels and cards (both ends of their gradients when the pack has one).
function surfaces(p) {
  const c = p.colors, g = p.gradients ?? {};
  const s = new Set([c.bg, c.panel]);
  for (const k of ['window', 'panel']) if (g[k]) { s.add(g[k].from); s.add(g[k].to); }
  return [...s];
}
// A fill token as painted: its colour, or both gradient ends (theme.cpp accentFill / controlFill / panelFill).
const fill = (p, token) => {
  const g = { accent: 'accent', field: 'control', panel: 'panel' }[token];
  const gr = g && p.gradients?.[g];
  return gr ? [p.colors[token], gr.from, gr.to] : [p.colors[token]];
};

// A pair: [state, what, ink, faces, min]. ink and faces are hex colours (faces a list); min 4.5 text, 3 controls.
const TEXT = 4.5, CTRL = 3;
function basePairs(p) {
  const c = p.colors, on = surfaces(p);
  return [
    ['normal', 'text on surfaces and fields', c.text, [...on, ...fill(p, 'field'), c.field], TEXT],
    ['normal', 'muted captions, group titles, tab labels', c.muted, [...on, c.field], TEXT],
    ['normal', 'primary button label', c.onAccent, fill(p, 'accent'), TEXT],
    ['normal', 'danger button label (transparent face)', c.danger, on, TEXT],
    ['normal', 'error and warning text', c.danger, [...on, c.field], TEXT],
    ['hover', 'hovered tab label', c.text, [c.field], TEXT],
    ['hover', 'hovered list row', c.text, [c.field], TEXT],
    ['pressed', 'pressed button label', c.text, [c.border], TEXT],
    ['checked', 'checked button, selected tab, list and menu selection', c.onAccent, [c.accent], TEXT],
    ['checked', 'checked danger button', c.onAccent, [c.danger], CTRL], // short bold label or icon (large text rule)
    ['checked', 'check box mark area against its field', c.accent, [c.field], CTRL],
    ['normal', 'slider handle against the window', c.text, on, CTRL],
    ['normal', 'slider value part against the window', c.accent, on, CTRL],
    ['normal', 'progress chunk against its field', c.accent, [c.field], CTRL],
    ['focus', 'button focus border against its face and the window', c.accentHi, [...fill(p, 'field'), ...on], CTRL],
    ['focus', 'field focus border against the field and the window', c.accent, [c.field, ...on], CTRL],
    ['error', 'field error border against the field', c.danger, [c.field], CTRL],
    ['normal', 'danger border against the window', c.danger, on, CTRL],
  ];
}

// The variant fragments (theme.cpp componentQss) and the painted Switch: the pairs each variant adds.
const VARIANTS = {
  'button.shape': { rounded: () => [], pill: () => [], sharp: () => [] },
  'button.style': {
    solid: (p) => [['normal', 'solid button label', p.colors.text, [p.colors.field], TEXT]],
    soft: (p, x) => [['normal', 'soft button label', p.colors.text, [x.tint], TEXT], ['normal', 'soft primary label', p.colors.onAccent, [p.colors.accent], TEXT]],
    metal: (p, x) => [['normal', 'metal button label', p.colors.text, [x.metalHi, p.colors.field, x.metalLo], TEXT], ['normal', 'metal primary label', p.colors.onAccent, [x.accentTop, x.accentBot], TEXT]],
    bezel: (p) => [['normal', 'bezel primary rim against the window', p.colors.accentHi, surfaces(p), CTRL]],
    neumorph: (p) => [['normal', 'neumorph button label', p.colors.text, [p.colors.bg], TEXT]],
  },
  'button.secondary': {
    outline: (p, x) => [['normal', 'outline button label', p.colors.accentHi, surfaces(p), TEXT], ['hover', 'outline button label', p.colors.accentHi, [x.tint], TEXT], ['normal', 'outline button edge', p.colors.accent, surfaces(p), CTRL]],
    tinted: (p, x) => [['normal', 'tinted button label', p.colors.accentHi, [x.tint], TEXT]],
    ghost: (p, x) => [['normal', 'ghost button label', p.colors.accentHi, surfaces(p), TEXT], ['hover', 'ghost button label', p.colors.accentHi, [x.tint], TEXT]],
  },
  tabs: {
    pill: () => [],
    underline: (p) => [['normal', 'underline tab label', p.colors.muted, surfaces(p), TEXT], ['hover', 'underline tab label', p.colors.text, surfaces(p), TEXT],
      ['checked', 'selected underline tab label', p.colors.accentHi, surfaces(p), TEXT], ['checked', 'selected tab underline', p.colors.accent, surfaces(p), CTRL]],
    segmented: (p) => [['normal', 'segment label', p.colors.muted, [p.colors.field], TEXT]],
    boxed: (p, x) => [['normal', 'boxed tab label', p.colors.muted, surfaces(p), TEXT], ['checked', 'selected boxed tab label', p.colors.accentHi, [x.tint], TEXT], ['checked', 'selected boxed tab edge', p.colors.accent, surfaces(p), CTRL]],
  },
  input: {
    outline: () => [],
    filled: (p) => [['normal', 'filled field text', p.colors.text, [p.colors.field], TEXT], ['normal', 'filled field underline', p.colors.muted, [p.colors.field], CTRL]],
    inset: (p, x) => [['normal', 'inset field text', p.colors.text, [x.well], TEXT]],
    underline: (p) => [['normal', 'underline field text', p.colors.text, surfaces(p), TEXT], ['normal', 'underline field line', p.colors.muted, surfaces(p), CTRL]],
  },
  focus: {
    border: (p) => [['focus', 'focus border', p.colors.accent, [p.colors.field], CTRL]],
    ring: (p) => [['focus', 'focus ring', p.colors.accent, [p.colors.field, ...surfaces(p)], CTRL]],
    glow: (p, x) => [['focus', 'glow focus text', p.colors.text, [x.focusTint], TEXT], ['focus', 'glow focus edge', p.colors.accentHi, [x.focusTint, ...surfaces(p)], CTRL]],
  },
  switch: {
    // painted (switch_widget.cpp paintVariant): ink is onAccent on the "on" track, text on the "off" track
    plain: (p) => [['checked', 'switch knob on', p.colors.onAccent, [p.colors.accent], CTRL], ['normal', 'switch knob off', p.colors.text, [p.colors.border], CTRL],
      ['checked', 'switch track on against the window', p.colors.accent, surfaces(p), CTRL]],
    labelled: (p) => [['checked', 'switch ON label', p.colors.onAccent, [p.colors.accent], TEXT], ['normal', 'switch OFF label', p.colors.text, [p.colors.border], TEXT],
      ['checked', 'switch track on against the window', p.colors.accent, surfaces(p), CTRL]],
    bezel: (p) => [['checked', 'switch ON label', p.colors.onAccent, [p.colors.accent], TEXT], ['normal', 'switch OFF label', p.colors.text, [p.colors.border], TEXT],
      ['checked', 'switch track on against the window', p.colors.accent, surfaces(p), CTRL]],
  },
  'slider.track': {
    thin: (p) => [['normal', 'slider value part', p.colors.accent, surfaces(p), CTRL]],
    thick: (p) => [['normal', 'slider value part', p.colors.accent, surfaces(p), CTRL]],
    inset: (p, x) => [['normal', 'slider value part in the well', p.colors.accent, [x.well, ...surfaces(p)], CTRL]],
  },
  'slider.handle': {
    round: (p) => [['normal', 'slider handle', p.colors.text, surfaces(p), CTRL]],
    bar: (p) => [['normal', 'slider handle', p.colors.text, surfaces(p), CTRL]],
    sphere: (p, x) => [['normal', 'sphere handle', p.colors.accent, surfaces(p), CTRL], ['normal', 'sphere handle light side', x.sphereHi, surfaces(p), CTRL]],
  },
  'slider.valueBubble': { true: (p) => [['pressed', 'value bubble', p.colors.bg, [p.colors.text], TEXT]], false: () => [] },
  'button.caps': { true: () => [], false: () => [] },
  sectionHeader: {
    plain: () => [],
    rule: (p) => [['normal', 'group title', p.colors.text, surfaces(p), TEXT]],
    caps: (p) => [['normal', 'group title and heading', p.colors.text, surfaces(p), TEXT]],
    bracket: (p) => [['normal', 'bracket title', p.colors.accentHi, [p.colors.bg, ...surfaces(p)], TEXT], ['normal', 'bracket heading', p.colors.accentHi, surfaces(p), TEXT]],
  },
  card: {
    flat: (p) => [['normal', 'text on a flat card', p.colors.text, [p.colors.panel], TEXT]],
    raised: () => [],
    neumorph: (p) => [['normal', 'text on a neumorph card', p.colors.text, [p.colors.bg], TEXT]],
    framed: (p) => [['normal', 'text in a framed card', p.colors.text, surfaces(p), TEXT]],
  },
  list: { plain: () => [], plates: (p) => [['normal', 'list plate text', p.colors.text, [p.colors.field], TEXT]] },
  chip: { pill: () => [], bracket: (p) => [['normal', 'bracket chip text', p.colors.text, surfaces(p), TEXT], ['normal', 'quiet bracket chip text', p.colors.muted, surfaces(p), TEXT]] },
  density: { compact: () => [], normal: () => [], airy: () => [] },
};

// The pack's chosen variants as flat keys ("button.style": "metal", "slider.valueBubble": "true").
function chosen(p) {
  const out = {};
  for (const [k, v] of Object.entries(p.components ?? {}))
    if (v && typeof v === 'object') for (const [k2, v2] of Object.entries(v)) out[`${k}.${k2}`] = String(v2);
    else out[k] = String(v);
  return out;
}

function failures(p) {
  const x = derived(p);
  const pairs = [...basePairs(p)];
  for (const [k, v] of Object.entries(chosen(p))) pairs.push(...VARIANTS[k][v](p, x));
  const bad = [];
  for (const [state, what, ink, faces, min] of pairs)
    for (const face of faces) {
      const r = contrast(ink, face);
      if (r < min) bad.push(`${p.id} ${state}: ${what} ${ink} on ${face} = ${r.toFixed(2)} (needs ${min})`);
    }
  return bad;
}

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

// Gaps in the shipped v1 looks, found by this test (2026-11-11). T1 must not change how existing packs look, so they
// are listed here and stay until the pack is redesigned (T2-T6). The list is exact: a new gap fails, and so does a
// fixed one (remove it here).
const KNOWN_BASE_GAPS = [
  'tactical normal: error and warning text #ee6a50 on #2d3224 = 4.28 (needs 4.5)', // task row warning on the field colour
];

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
