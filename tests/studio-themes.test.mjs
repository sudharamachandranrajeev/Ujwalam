// SPDX-License-Identifier: GPL-3.0-or-later
// Studio theme packs (D293): data/themes/*.json against theme.schema.json, text contrast computed from the tokens,
// the effect rules (glow only on primary or active things, extrusion only on buttons and round controls), and the
// fonts (family names: Windows fonts or the bundled OFL families, D344; no Microsoft fonts that may not be redistributed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'themes');
const read = (f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(read('theme.schema.json'));
const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'theme.schema.json');
const themes = files.map((f) => ({ file: f, t: read(f) }));

const lum = (h) => {
  const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

test('at least five themes ship, Violet Night is the default look, ids match file names', () => {
  assert.ok(themes.length >= 5, `${themes.length} themes`);
  for (const id of ['violet-night', 'neon-arcade', 'studio-light', 'tactical', 'retro-wave']) assert.ok(files.includes(`${id}.json`), id);
  // 2026-11-10: four more from the user's reference sheets (described in words in the evidence, no images in the repo)
  for (const id of ['daylight-blue', 'copper-graphite', 'sand-teal', 'teal-grid']) assert.ok(files.includes(`${id}.json`), id);
  for (const { file, t } of themes) assert.equal(`${t.id}.json`, file);
  assert.equal(new Set(themes.map(({ t }) => t.name)).size, themes.length, 'names are unique');
});

test('every theme passes the schema', () => {
  for (const { file, t } of themes) assert.ok(validate(t), `${file}: ${JSON.stringify(validate.errors)}`);
});

test('the schema refuses a bad colour, an unknown key, a missing class and an unsafe glow', () => {
  const base = read('violet-night.json');
  const bad = (mut) => { const t = structuredClone(base); mut(t); return validate(t); };
  assert.equal(bad((t) => { t.colors.bg = 'red'; }), false);
  assert.equal(bad((t) => { t.extra = 1; }), false);
  assert.equal(bad((t) => { delete t.depth.menu; }), false);
  assert.equal(bad((t) => { t.depth.card.glow = { blur: 10, color: 'accent', opacity: 0.9, when: 'always' }; }), false, 'glow opacity is capped');
  assert.equal(bad((t) => { t.depth.card.extrusion = { depth: 9, color: '#000000' }; }), false);
  assert.equal(bad((t) => { t.id = 'Bad Id'; }), false);
  assert.equal(bad((t) => { t.motion.easing = 'bounce'; }), false);
});

test('body text keeps >= 4.5:1 on bg, panel and field; muted too; onAccent on accent; danger and accentHi on bg and panel', () => {
  for (const { file, t } of themes) {
    const c = t.colors;
    for (const surface of ['bg', 'panel', 'field']) {
      assert.ok(contrast(c.text, c[surface]) >= 4.5, `${file}: text on ${surface} ${contrast(c.text, c[surface]).toFixed(2)}`);
      assert.ok(contrast(c.muted, c[surface]) >= 4.5, `${file}: muted on ${surface} ${contrast(c.muted, c[surface]).toFixed(2)}`);
    }
    assert.ok(contrast(c.onAccent, c.accent) >= 4.5, `${file}: onAccent on accent ${contrast(c.onAccent, c.accent).toFixed(2)}`);
    assert.ok(contrast(c.onAccent, c.danger) >= 3, `${file}: onAccent on danger (large icon) ${contrast(c.onAccent, c.danger).toFixed(2)}`);
    for (const s of ['bg', 'panel']) {
      assert.ok(contrast(c.danger, c[s]) >= 4.5, `${file}: danger on ${s}`);
      assert.ok(contrast(c.accentHi, c[s]) >= 4.5, `${file}: accentHi on ${s}`);
    }
    const g = t.gradients?.accent;
    if (g) for (const end of [g.from, g.to]) assert.ok(contrast(c.onAccent, end) >= 4.5, `${file}: onAccent on the accent gradient end ${end}`);
    // Optional surface gradients (2026-11-10): body and muted text on both ends of a card fill, body text on a button fill.
    const p = t.gradients?.panel;
    if (p) for (const end of [p.from, p.to]) for (const ink of ['text', 'muted']) assert.ok(contrast(c[ink], end) >= 4.5, `${file}: ${ink} on the panel gradient end ${end}`);
    const b = t.gradients?.control;
    if (b) for (const end of [b.from, b.to]) assert.ok(contrast(c.text, end) >= 4.5, `${file}: text on the control gradient end ${end}`);
  }
});

test('light and dark flag matches the palette', () => {
  for (const { file, t } of themes) assert.equal(lum(t.colors.bg) < 0.2, t.dark, file);
});

test('effect rules: glow only where it marks primary or active things; extrusion only on buttons and round controls; none on plain buttons', () => {
  for (const { file, t } of themes) {
    for (const [cls, d] of Object.entries(t.depth)) {
      if (d.extrusion) assert.ok(['button', 'primaryButton', 'roundControl', 'card', 'toast', 'taskPanel'].includes(cls), `${file}: extrusion on ${cls}`);
      if (cls === 'button') assert.ok(!d.glow || d.glow.when === 'hover' || d.glow.when === 'focus', `${file}: plain button glow only on hover or focus`);
      if (d.glow?.when === 'always') assert.ok(['card', 'primaryButton', 'toast', 'menu', 'taskPanel'].includes(cls), `${file}: always-on glow on ${cls}`);
      if (cls === 'roundControl' && d.glow) assert.equal(d.glow.when, 'active', `${file}: round glow marks the live or recording state`);
    }
    const total = Object.values(t.depth).reduce((n, d) => n + (d.glow ? 1 : 0), 0);
    assert.ok(total <= 7);
  }
  assert.equal(themes.find(({ t }) => t.id === 'studio-light').t.depth.card.glow, undefined, 'Studio Light has no glow');
  const light = themes.find(({ t }) => t.id === 'studio-light').t;
  assert.ok(Object.values(light.depth).every((d) => !d.glow && !d.extrusion), 'Studio Light: soft shadows only');
  const tac = themes.find(({ t }) => t.id === 'tactical').t;
  assert.ok(tac.depth.roundControl.extrusion.depth >= 3 && tac.depth.primaryButton.extrusion.color2, 'Tactical: bevelled edges');
  for (const id of ['daylight-blue', 'copper-graphite', 'teal-grid']) { // 2026-11-10: no effect on plain buttons (many widgets)
    const d = themes.find(({ t }) => t.id === id).t.depth.button;
    assert.deepEqual(d, {}, `${id}: plain buttons carry no depth effect`);
  }
  // D344: the neumorphic Sand Teal is the one exception. Its plain buttons are plates drawn only by a light and a dark
  // shadow (the stylesheet cannot draw them), so without the effect they would be invisible. The cost is measured in
  // the headless probe (89 depth widgets against 27) and High performance drops every depth effect.
  const sand = themes.find(({ t }) => t.id === 'sand-teal').t.depth.button;
  assert.ok(sand.shadow && sand.highlight && !sand.glow && !sand.extrusion, 'sand-teal: plain buttons are neumorphic plates (shadow plus highlight only)');
  const neon = themes.find(({ t }) => t.id === 'neon-arcade').t;
  assert.ok(neon.geometry.radius.large <= 6 && neon.depth.primaryButton.glow.when === 'always', 'Neon: sharp and glowing');
});

test('themes differ in more than colour: type, geometry, depth, motion and background', () => {
  const sig = (t) => JSON.stringify([t.typography.family, t.geometry.radius, t.geometry.borderWidth, Object.keys(t.depth).map((k) => [!!t.depth[k].glow, !!t.depth[k].extrusion]), t.motion.easing, t.background.pattern]);
  assert.equal(new Set(themes.map(({ t }) => sig(t))).size, themes.length);
});

test('fonts: family names only (Windows or bundled OFL); no Corbel or Consolas (not redistributable); no font files in data/themes', () => {
  for (const { file, t } of themes) {
    for (const f of [t.typography.family, ...(t.typography.fallbacks ?? [])]) assert.doesNotMatch(f, /corbel|consolas/i, `${file}: ${f}`);
  }
  assert.deepEqual(readdirSync(dir).filter((f) => !f.endsWith('.json')), []);
});

// Round controls (setControl in main_window.cpp, QPushButton#round in theme.cpp): every icon needs >= 3:1 against its face,
// enabled and disabled. Disabled faces are the field colour (danger: transparent over the card = panel); the disabled icon
// is the muted token (icons::make third colour), not the faded alpha that vanished on light themes.
test('round control icons keep >= 3:1 against their face in every state, all themes', () => {
  for (const { file, t } of themes) {
    const c = t.colors;
    const g = t.gradients?.accent;
    const primaryFaces = g ? [g.from, g.to] : [c.accent];
    const check = (ink, face, what) => assert.ok(contrast(ink, face) >= 3, `${file}: ${what} ${ink} on ${face} ${contrast(ink, face).toFixed(2)}`);
    for (const f of primaryFaces) check(c.onAccent, f, 'primary enabled');
    check(c.onAccent, c.danger, 'primary or danger active');
    check(c.text, c.field, 'plain enabled');
    check(c.danger, c.panel, 'danger enabled (transparent over card)');
    check(c.danger, c.field, 'danger enabled over field');
    check(c.muted, c.field, 'disabled');
    check(c.muted, c.panel, 'disabled danger (transparent over card)');
  }
});

// The preview surface is dark in every theme (PreviewSlot in main_window.cpp), so its message uses fixed colours.
test('text on the preview surface keeps >= 4.5:1 (fixed light on fixed dark, same in every theme)', () => {
  const src = readFileSync(path.resolve(dir, '..', '..', 'app', 'studio', 'src', 'main_window.cpp'), 'utf8');
  const surface = /pal\.setColor\(QPalette::Window, QColor\((\d+), (\d+), (\d+)\)\)/.exec(src);
  const ink = /QLabel \{ color: (#[0-9a-f]{6}); background: transparent; \}/.exec(src);
  assert.ok(surface && ink, 'preview surface colour and message colour are set in PreviewSlot');
  const face = '#' + [1, 2, 3].map((i) => Number(surface[i]).toString(16).padStart(2, '0')).join('');
  assert.ok(contrast(ink[1], face) >= 4.5, `preview message ${ink[1]} on ${face} ${contrast(ink[1], face).toFixed(2)}`);
});
