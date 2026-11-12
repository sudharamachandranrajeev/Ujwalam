// SPDX-License-Identifier: GPL-3.0-or-later
// Scene builder SB4 (D345): a studio theme from a reference. On SB2's synthetic fixtures (tests/helpers/sb-fixtures.mjs)
// the palette roles land on the right tokens, every colour says where it came from (no invented colour), the style read
// picks the component variants, and every generated pack is schema-valid (v2) and passes the T1 contrast check
// (services/studio-ui/theme-contrast.mjs, the same check as the shipped packs). A read that fails contrast is pushed
// until it passes and the pushes are reported. The writer never overwrites and never uses a built-in id; the CLI is a
// dry run by default and sits behind the scene-builder flag. A headless Qt probe shows a generated pack loading with
// the flag theme-components on (no stylesheet errors) and falling back to the base look with it off.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { deltaE, hexLab, hueGap } from '../services/scene-builder/colour.mjs';
import { main as cli } from '../services/scene-builder/cli.mjs';
import { readReference } from '../services/scene-builder/read.mjs';
import { builtinIds, canonicalDir, slug, themeFromRead, userThemesDir, writeProblems, writeThemePack } from '../services/scene-builder/theme.mjs';
import { contrast, failures } from '../services/studio-ui/theme-contrast.mjs';
import { createFakeBots, createFakeHost } from '../services/studio-ui/backends.mjs';
import { createFlags } from '../services/flags/index.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';
import { EXE, qtDir } from '../app/studio/tools/build.mjs';
import { layoutH, layoutV, paletteBlocks, stylePanels, writePng } from './helpers/sb-fixtures.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schema = JSON.parse(readFileSync(path.join(REPO, 'data', 'themes', 'theme.schema.json'), 'utf8'));
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
const valid = (p) => assert.ok(validate(p), JSON.stringify(validate.errors?.slice(0, 3)));
const dir = mkdtempSync(path.join(os.tmpdir(), 'ujw-sb4-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const reads = {};
const readOf = async (name, canvas) => (reads[name] ??= await readReference(writePng(canvas, dir, name)));
const FIXTURES = {
  palette: () => paletteBlocks().canvas,
  layoutH: () => layoutH().canvas,
  layoutV: () => layoutV().canvas,
  glow: () => stylePanels({ glow: true }).canvas,
  shadowLight: () => stylePanels({ shadow: true, light: true }).canvas,
  square: () => stylePanels({ radius: 0 }).canvas,
  small: () => stylePanels({ radius: 3 }).canvas,
};
const tokens = (p) => Object.keys(p.colors);
const READ_ROLES = ['background', 'surface', 'text', 'accent', 'accentAlt'];

describe('SB4 colour mapping (palette roles to tokens, provenance, no invented colour)', () => {
  test('palette blocks: roles land on bg, panel, text and accent; derived tokens say how', async () => {
    const r = await readOf('palette', FIXTURES.palette());
    const { pack, report } = themeFromRead(r);
    const c = Object.fromEntries(report.colours.map((x) => [x.token, x]));
    assert.equal(pack.colors.bg, r.palette.roles.background.hex);
    assert.equal(pack.colors.panel, r.palette.roles.surface.hex);
    assert.equal(pack.colors.text, r.palette.roles.text.hex, 'the read text already clears 4.5:1 on bg, panel and field');
    assert.deepEqual([c.bg.how, c.panel.how, c.text.how], ['extracted', 'extracted', 'extracted']);
    assert.equal(pack.dark, true);
    // the accent keeps the read accent's hue and chroma (only the lightness moves for contrast)
    const a = hexLab(pack.colors.accent), ra = hexLab(r.palette.roles.accent.hex);
    const hue = (l) => (Math.atan2(l[2], l[1]) * 180) / Math.PI;
    assert.ok(hueGap(hue(a), hue(ra)) <= 6, `${pack.colors.accent} vs ${r.palette.roles.accent.hex}`);
    assert.equal(c.accent.from, 'accent');
    for (const x of report.colours) {
      assert.ok(['extracted', 'derived'].includes(x.how) && x.why.length > 10, JSON.stringify(x));
      if (x.how === 'derived') assert.ok(x.from, `${x.token} names what it was derived from`);
    }
    assert.deepEqual(report.colours.map((x) => x.token), tokens(pack));
  });

  test('every token comes from a read colour or a named derivation of one (never a free colour)', async () => {
    for (const [name, make] of Object.entries(FIXTURES)) {
      const r = await readOf(name, make());
      const { report } = themeFromRead(r);
      const readHex = new Set([...READ_ROLES.map((k) => r.palette.roles[k]?.hex).filter(Boolean), ...r.palette.clusters.map((k) => k.hex)]);
      for (const x of report.colours) {
        if (x.how === 'extracted') assert.ok(readHex.has(x.hex), `${name} ${x.token} ${x.hex} says extracted but is not a read colour`);
        else assert.match(x.from, /^(background|surface|text|accent|cluster|muted|text \+ background|surface \+ text|muted \+ background)$/, `${name} ${x.token}`);
      }
      // danger and ok without a red or green in the picture use the semantic hue and say so
      for (const t of ['danger', 'ok']) {
        const x = report.colours.find((y) => y.token === t);
        if (x.from !== 'cluster') assert.match(x.why, /convention/, `${name} ${t}: ${x.why}`);
      }
    }
  });

  test('a light reference gives a light pack; a neutral one uses its text colour as the accent', async () => {
    const r = await readOf('shadowLight', FIXTURES.shadowLight());
    const { pack, report } = themeFromRead(r);
    assert.equal(pack.dark, false);
    if (!r.palette.roles.accent) assert.match(report.colours.find((x) => x.token === 'accent').why, /neutral|most chromatic/);
  });
});

describe('SB4 variant choice from the style read', () => {
  test('square corners: sharp buttons, boxed tabs, filled inputs, bracket chips and headers, framed cards', async () => {
    const { pack } = themeFromRead(await readOf('square', FIXTURES.square()));
    const c = pack.components;
    assert.deepEqual([c.button.shape, c.tabs, c.input, c.chip, c.sectionHeader, c.card, c.slider.handle], ['sharp', 'boxed', 'filled', 'bracket', 'bracket', 'framed', 'bar']);
    assert.deepEqual(pack.geometry.radius, { small: 0, medium: 0, large: 2 });
  });
  test('round corners: rounded buttons; the studio radius follows the read radius', async () => {
    for (const [name, minR] of [['small', 1], ['glow', 12]]) {
      const r = await readOf(name, FIXTURES[name]());
      const { pack } = themeFromRead(r);
      assert.equal(pack.components.button.shape, 'rounded', name);
      assert.ok(pack.geometry.radius.medium >= minR && pack.geometry.radius.medium === Math.min(16, Math.max(2, Math.round(r.style.cornerRadius.px1080 / 2))), `${name} ${JSON.stringify(pack.geometry.radius)}`);
    }
  });
  test('glow: focus glow, a bezel primary, outlined plain buttons, glow on the primary button in the read colour', async () => {
    const r = await readOf('glow', FIXTURES.glow());
    assert.equal(r.style.glow.used, true);
    const { pack } = themeFromRead(r);
    assert.deepEqual([pack.components.focus, pack.components.button.style, pack.components.button.secondary], ['glow', 'bezel', 'outline']);
    assert.equal(pack.depth.primaryButton.glow.color, r.style.glow.colour);
    assert.equal(pack.depth.card.shadow, undefined, 'no shadow read: none drawn');
  });
  test('drop shadow: raised cards with a shadow below, solid buttons, a focus ring; no glow anywhere', async () => {
    const r = await readOf('shadowLight', FIXTURES.shadowLight());
    assert.equal(r.style.shadow.used, true);
    const { pack } = themeFromRead(r);
    assert.deepEqual([pack.components.card, pack.components.button.style, pack.components.focus], ['raised', 'solid', 'ring']);
    assert.ok(pack.depth.card.shadow.offsetY > 0 && pack.depth.card.shadow.opacity >= 0.3);
    assert.ok(Object.values(pack.depth).every((d) => !d.glow), 'no glow read: none drawn');
  });
  test('plain panels: flat cards, soft buttons, a focus border, no depth effects', async () => {
    const { pack } = themeFromRead(await readOf('small', FIXTURES.small()));
    assert.deepEqual([pack.components.card, pack.components.button.style, pack.components.focus], ['flat', 'soft', 'border']);
    assert.ok(Object.values(pack.depth).every((d) => !d.glow && !d.shadow));
  });
  test('a corner radius read below the confidence floor keeps the base shape (key left out)', async () => {
    const r = structuredClone(await readOf('palette', FIXTURES.palette()));
    r.style.cornerRadius = { px1080: 30, class: 'large', corners: 2, confidence: 0.3 };
    const { pack, report } = themeFromRead(r);
    assert.equal(pack.components.button?.shape, undefined);
    assert.equal(pack.components.tabs, undefined);
    assert.ok(report.variants.some((v) => v.key === 'button.shape' && v.value === null && /below/.test(v.why)));
  });
});

describe('SB4 contrast: every generated pack passes the T1 check (text 4.5:1, controls and focus 3:1, every state)', () => {
  test('all synthetic fixtures: schema v2 valid, no failures', async () => {
    for (const [name, make] of Object.entries(FIXTURES)) {
      const r = await readOf(name, make());
      const { pack, report } = themeFromRead(r);
      valid(pack);
      assert.deepEqual(failures(pack), [], name);
      assert.deepEqual(report.contrast.failures, [], name);
      assert.ok(report.contrast.worstText >= 4.5 && report.contrast.worstControl >= 3, `${name} ${JSON.stringify(report.contrast)}`);
      // a full design, not just colours: style, plain buttons, focus, card, switch, slider, list and density always;
      // shape, tabs, input, chip, header and handle too when the corner radius was read
      const n = Object.keys(pack.components).length + Object.keys(pack.components.button ?? {}).length + Object.keys(pack.components.slider ?? {}).length - 2;
      assert.ok(n >= (r.style.cornerRadius.confidence >= 0.5 ? 14 : 8), `${name}: ${JSON.stringify(pack.components)}`);
    }
  });
  test('a read that fails as read is pushed until it passes, and each push is reported', async () => {
    const r = structuredClone(await readOf('palette', FIXTURES.palette()));
    // grey text barely off a grey background, a dull accent close to both
    r.palette.roles.background = { hex: '#808080', how: 'extracted', why: 'test' };
    r.palette.roles.surface = { hex: '#8a8a8a', how: 'extracted', why: 'test' };
    r.palette.roles.text = { hex: '#9a9a9a', how: 'extracted', why: 'test' };
    r.palette.roles.accent = { hex: '#8f7f8a', how: 'extracted', why: 'test' };
    const { pack, report } = themeFromRead(r);
    valid(pack);
    assert.deepEqual(failures(pack), []);
    const moved = report.colours.filter((x) => x.how === 'derived' && /moved|pushed/.test(x.why)).map((x) => x.token);
    assert.ok(moved.includes('text') && moved.includes('accent'), moved.join(','));
    assert.ok(contrast(pack.colors.text, pack.colors.bg) >= 4.5);
  });
  test('a red accent: danger is never the accent cluster itself, and a near-accent danger is called out', async () => {
    const r = structuredClone(await readOf('palette', FIXTURES.palette()));
    const { pack, report } = themeFromRead(r); // its accent #ff3366 is red-ish (hue about 13)
    assert.ok(deltaE(hexLab(pack.colors.danger), hexLab(r.palette.roles.accent.hex)) >= 0.08 || report.notes.some((n) => /close to the accent/.test(n)), `${pack.colors.danger} ${pack.colors.accent}`);
    assert.notEqual(pack.colors.danger, pack.colors.accent);
  });
});

describe('SB4 writing: user themes folder only, never over a file or a built-in id', () => {
  test('ids, folders and refusals', async () => {
    assert.equal(slug('My Neon  Look!'), 'my-neon-look');
    assert.equal(slug('x'.repeat(60)).length, 40);
    assert.equal(userThemesDir({ UJWALAM_THEMES_DIR: dir }), path.resolve(dir));
    const roaming = path.join(dir, 'Roaming');
    assert.equal(userThemesDir({ APPDATA: roaming }), path.join(roaming, 'Ujwalam Studio', 'themes'));
    assert.throws(() => userThemesDir({}), /APPDATA/);
    const { pack } = themeFromRead(await readOf('glow', FIXTURES.glow()), { name: 'Sb4 Test' });
    assert.equal(pack.id, 'sb4-test');
    const out = mkdtempSync(path.join(dir, 'themes-'));
    for (const id of builtinIds()) assert.match(writeProblems({ ...pack, id }, out).join(), /built-in/, id);
    assert.match(writeProblems(pack, path.join(REPO, 'data', 'themes')).join(), /built-in themes folder/);
    const file = writeThemePack(pack, out);
    assert.equal(file, path.join(out, 'sb4-test.json'));
    assert.deepEqual(readdirSync(out), ['sb4-test.json'], 'no temp file left');
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), pack);
    const before = readFileSync(file, 'utf8');
    assert.throws(() => writeThemePack({ ...pack, name: 'Other' }, out), /already exists/);
    assert.equal(readFileSync(file, 'utf8'), before, 'never overwritten');
  });
  test('a fresh install: the themes folder (and its parents) is created on write', async () => {
    const { pack } = themeFromRead(await readOf('glow', FIXTURES.glow()), { name: 'Fresh' });
    const fresh = path.join(dir, 'fresh-appdata', 'Ujwalam Studio', 'themes');
    assert.equal(existsSync(fresh), false);
    assert.deepEqual(writeProblems(pack, fresh), []);
    const file = writeThemePack(pack, fresh);
    assert.deepEqual(readdirSync(fresh), ['fresh.json'], 'no temp file left');
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), pack);
  });
  test('a junction to the built-in folder (or to its parent) is refused before anything is created or written', async () => {
    const { pack } = themeFromRead(await readOf('glow', FIXTURES.glow()), { name: 'Via Junction' });
    const builtin = path.join(REPO, 'data', 'themes');
    const before = readdirSync(builtin).sort();
    const j1 = path.join(dir, 'junction-themes'), j2 = path.join(dir, 'junction-data');
    symlinkSync(builtin, j1, 'junction');
    symlinkSync(path.join(REPO, 'data'), j2, 'junction');
    try {
      for (const target of [j1, path.join(j2, 'themes'), path.join(j1, '.', ''), j1.toUpperCase()]) {
        assert.match(writeProblems(pack, target).join(), /built-in themes folder/, target);
        assert.throws(() => writeThemePack(pack, target), /built-in themes folder/, target);
      }
      assert.deepEqual(readdirSync(builtin).sort(), before, 'nothing written into data/themes');
      // a new folder under the junction that does not exist yet: canonical ancestor + the rest, still checked
      assert.equal(canonicalDir(path.join(j2, 'themes', 'x', 'y')), canonicalDir(path.join(builtin, 'x', 'y')));
    } finally { rmSync(j1); rmSync(j2); }
  });
});

describe('SB4 CLI: theme <reference> behind the scene-builder flag, dry run by default', () => {
  test('flag off: exit 2; dry run writes nothing; --apply writes once; a second --apply is refused', async () => {
    const data = mkdtempSync(path.join(dir, 'data-'));
    const themes = path.join(dir, 'cli-themes');
    mkdirSync(themes);
    const ref = writePng(FIXTURES.glow(), dir, 'cli ref');
    const outs = [], errs = [];
    const o = (s) => outs.push(s), e = (s) => errs.push(s);
    assert.equal(await cli(['theme', ref, '--themes-dir', themes, '--data-dir', data], o, e), 2);
    assert.match(errs.join('\n'), /scene-builder feature flag is off/);
    writeFileSync(path.join(data, 'flags.local.json'), JSON.stringify({ flags: { 'scene-builder': true } }));
    outs.length = 0;
    assert.equal(await cli(['theme', ref, '--name', 'Cli Look', '--themes-dir', themes, '--data-dir', data], o, e), 0);
    assert.match(outs.join('\n'), /Dry run: theme "Cli Look" \(id cli-look\)/);
    assert.match(outs.join('\n'), /Contrast \(T1 check, \d+ pairs\): pass/);
    assert.deepEqual(readdirSync(themes), [], 'a dry run writes nothing');
    outs.length = 0;
    assert.equal(await cli(['theme', ref, '--name', 'Cli Look', '--themes-dir', themes, '--data-dir', data, '--apply', '--json'], o, e), 0);
    const res = JSON.parse(outs[0]);
    assert.equal(res.dryRun, false);
    assert.deepEqual(readdirSync(themes), ['cli-look.json']);
    valid(JSON.parse(readFileSync(path.join(themes, 'cli-look.json'), 'utf8')));
    errs.length = 0;
    assert.equal(await cli(['theme', ref, '--name', 'Cli Look', '--themes-dir', themes, '--data-dir', data, '--apply'], () => {}, e), 1);
    assert.match(errs.join('\n'), /already exists/);
    assert.equal(await cli(['theme', ref, '--name', 'Violet Night', '--themes-dir', themes, '--data-dir', data, '--apply'], () => {}, e), 1, 'a built-in id is refused');
    assert.deepEqual(readdirSync(themes), ['cli-look.json']);
  });
  test('bad arguments exit 1', async () => {
    const q = () => {};
    const on = { flagsOn: () => true };
    assert.equal(await cli(['theme'], q, q, on), 1);
    assert.equal(await cli(['theme', 'a.png', '--project', 'p.json'], q, q, on), 1);
    assert.equal(await cli(['read', 'a.png', '--name', 'x'], q, q, on), 1);
    assert.equal(await cli(['build', 'a.png', '--project', 'p.json', '--themes-dir', 'x'], q, q, on), 1);
    assert.equal(await cli(['theme', 'a.png', '--name'], q, q, on), 1);
  });
});

// Headless Qt probe (the pattern of tests/studio-qt-theme-components.test.mjs). Skipped when the shell is not built.
const QT = qtDir();
const skipQt = !existsSync(EXE) || !QT ? 'studio shell not built (npm run build:studio)' : false;
const NO_ERRORS = /Could not parse|Unknown property|stylesheet/i;

function runShell(env) {
  return new Promise((resolve) => {
    const child = spawn(EXE, [], {
      windowsHide: true,
      env: { ...process.env, PATH: `${path.join(QT, 'bin')}${path.delimiter}${process.env.PATH}`, UJWALAM_HEADLESS: '1', QT_QPA_FONTDIR: path.join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts'), ...env },
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => child.kill(), 40_000);
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

describe('SB4 generated pack in the studio (headless Qt probe)', { skip: skipQt }, () => {
  let themes, pack;
  before(async () => {
    themes = mkdtempSync(path.join(dir, 'qt-themes-'));
    ({ pack } = themeFromRead(await readOf('glow', FIXTURES.glow()), { name: 'Sb4 Probe' }));
    writeThemePack(pack, themes);
  });
  async function probe({ flagOn }) {
    const dataDir = mkdtempSync(path.join(dir, 'qt-data-'));
    if (flagOn) writeFileSync(path.join(dataDir, 'flags.local.json'), JSON.stringify({ flags: { 'theme-components': true } }));
    const fake = createFakeHost({});
    const host = { describe: () => fake.describe(), call: (m, p) => fake.call(m, p) };
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const key = 'd'.repeat(40);
    const srv = createStudioServer({ uiRoot: path.join(REPO, 'ui'), core, host, launchKey: key, dataDir, flags: createFlags({ dataDir }), bots: createFakeBots(), limits: { statusPollMs: 50 } });
    const { port } = await srv.listen();
    try {
      const r = await runShell({ UJWALAM_UI_URL: `http://127.0.0.1:${port}/`, UJWALAM_UI_LAUNCH_KEY: key, UJWALAM_STUDIO_PROBE_MS: '7000', UJWALAM_STUDIO_PROBE_ACTIONS: 'settings-open,settings-page:Appearance,settings-specimen', UJWALAM_THEMES_DIR: themes, UJWALAM_THEME: pack.id });
      assert.equal(r.code, 0, r.err);
      const m = /^studio probe: (.+)$/m.exec(r.out);
      assert.ok(m, `no probe line: ${r.out} ${r.err}`);
      return { ...JSON.parse(m[1]), err: r.err };
    } finally { srv.close(); }
  }
  test('flag theme-components on: the pack loads as a custom theme with its variants and no stylesheet errors', async () => {
    const p = await probe({ flagOn: true });
    assert.equal(p.theme.id, pack.id);
    assert.equal(p.theme.custom, true);
    assert.ok(p.theme.available.includes(pack.id));
    assert.equal(p.theme.componentsOn, true);
    assert.equal(p.theme.components.focus, 'glow');
    assert.ok(Object.keys(p.theme.components).length >= 9, JSON.stringify(p.theme.components));
    assert.ok(p.theme.fragmentLength > 0);
    assert.doesNotMatch(p.err, NO_ERRORS, p.err);
    assert.equal(p.specimen.open, true);
  });
  test('flag off: the same pack falls back to the base look (no components, no fragments), no errors', async () => {
    const p = await probe({ flagOn: false });
    assert.equal(p.theme.id, pack.id);
    assert.equal(p.theme.componentsOn, false);
    assert.deepEqual(p.theme.components, {});
    assert.equal(p.theme.fragmentLength, 0);
    assert.doesNotMatch(p.err, NO_ERRORS, p.err);
  });
});
