// SPDX-License-Identifier: GPL-3.0-or-later
// Theme framework T1 (D336), headless probe: the flag theme-components is off by default and then nothing changes;
// packs without a components block apply the same base stylesheet with the flag on and off; a pack using every
// variant loads with no stylesheet errors and reports its parts; a pack with an unknown variant is refused; the flag
// switches live; High performance stays flat; the specimen page (Settings > Appearance > "Preview all components")
// opens with every section, and its picture is taken at 100, 125 and 150 % scale.
// UJWALAM_THEME_EVIDENCE=<dir> keeps the specimen pictures there. Skipped when the shell is not built.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFakeBots, createFakeHost } from '../services/studio-ui/backends.mjs';
import { createFlags } from '../services/flags/index.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';
import { EXE, qtDir } from '../app/studio/tools/build.mjs';
import { writeViaRename } from '../tools/soak/stage.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(REPO, 'ui');
const QT = qtDir();
const skip = !existsSync(EXE) || !QT ? 'studio shell not built (npm run build:studio)' : false;
const EVIDENCE = process.env.UJWALAM_THEME_EVIDENCE ? path.resolve(process.env.UJWALAM_THEME_EVIDENCE) : null;
const NO_ERRORS = /Could not parse|Unknown property|stylesheet/i;
const SECTIONS = ['BUTTONS', 'TRANSPORT', 'INPUTS', 'TABS AND SELECTION', 'SLIDERS AND PROGRESS', 'CHIPS', 'CARDS AND LISTS', 'FEEDBACK', 'HEADINGS AND TEXT'];

// A test pack that uses one variant of every component, the v2 depth parts, caps, the type scale, the blueprint
// pattern and the frame (built on an existing pack; generic names only).
function allVariantsPack() {
  const base = JSON.parse(readFileSync(path.join(REPO, 'data', 'themes', 'teal-grid.json'), 'utf8'));
  return {
    ...base, id: 'all-variants', name: 'All Variants',
    typography: { ...base.typography, captionCaps: true, tabCaps: true, headingCaps: true, scale: { h1: 16, h2: 12, subtitle: 9, button: 10 } },
    background: { kind: 'pattern', pattern: 'blueprint', patternColor: '#5fd9e3', patternOpacity: 0.06, patternSpacing: 24, frame: { ticks: true, opacity: 0.35 } },
    depth: {
      ...base.depth,
      card: { shadow: { blur: 16, offsetX: 0, offsetY: 4, color: '#000000', opacity: 0.4 }, highlight: { blur: 10, offsetX: -3, offsetY: -3, color: '#ffffff', opacity: 0.08 }, inset: { blur: 6, offsetX: 1, offsetY: 2, color: '#000000', opacity: 0.4, when: 'always' } },
      primaryButton: { shadow: { blur: 8, offsetX: 0, offsetY: 2, color: '#000000', opacity: 0.4 }, rim: { from: 'accentHi', to: '#7a5a20', width: 2, innerGlow: { color: 'accent', opacity: 0.5, width: 1 } } },
    },
    components: {
      button: { shape: 'pill', style: 'metal', secondary: 'tinted', caps: true }, tabs: 'underline', input: 'inset', focus: 'ring', switch: 'bezel',
      slider: { track: 'inset', handle: 'sphere', valueBubble: true }, sectionHeader: 'bracket', card: 'framed', list: 'plates', chip: 'bracket', density: 'airy',
    },
  };
}

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pngSize = (f) => { const b = readFileSync(f); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };

describe('Qt studio theme components (D336, headless probe)', { skip }, () => {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const tmp = (p) => { const d = mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
  let packsDir = null;
  const packs = () => {
    if (packsDir) return packsDir;
    packsDir = tmp('ujw-qtc-packs-');
    writeFileSync(path.join(packsDir, 'all-variants.json'), JSON.stringify(allVariantsPack()));
    writeFileSync(path.join(packsDir, 'bad-variant.json'), JSON.stringify({ ...allVariantsPack(), id: 'bad-variant', name: 'Bad Variant', components: { tabs: 'wavy' } }));
    writeFileSync(path.join(packsDir, 'bad-key.json'), JSON.stringify({ ...allVariantsPack(), id: 'bad-key', name: 'Bad Key', components: { sparkle: 'on' } }));
    return packsDir;
  };
  async function probe({ ms = 4500, actions = '', flagOn = false, env = {}, shot = null, during = null } = {}) {
    const dataDir = tmp('ujw-qtc-');
    if (flagOn) writeFileSync(path.join(dataDir, 'flags.local.json'), JSON.stringify({ flags: { 'theme-components': true } }));
    const flags = createFlags({ dataDir });
    const fake = createFakeHost({});
    const host = { describe: () => fake.describe(), call: (m, p) => fake.call(m, p) };
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const key = 'c'.repeat(40);
    const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: key, dataDir, flags, bots: createFakeBots(), limits: { statusPollMs: 50 } });
    const { port } = await srv.listen();
    try {
      const run = runShell({ UJWALAM_UI_URL: `http://127.0.0.1:${port}/`, UJWALAM_UI_LAUNCH_KEY: key, UJWALAM_STUDIO_PROBE_MS: String(ms), UJWALAM_STUDIO_PROBE_ACTIONS: actions, ...(shot ? { UJWALAM_STUDIO_PROBE_SHOT: shot } : {}), ...env });
      if (during) await during();
      const r = await run;
      assert.equal(r.code, 0, r.err);
      const m = /^studio probe: (.+)$/m.exec(r.out);
      assert.ok(m, `no probe line: ${r.out} ${r.err}`);
      return { ...JSON.parse(m[1]), err: r.err };
    } finally { srv.close(); }
  }

  test('flag off (the default): no components, no fragments, no specimen button', async () => {
    const p = await probe({ ms: 7000, actions: 'settings-open,settings-page:3,settings-specimen', env: { UJWALAM_THEMES_DIR: packs(), UJWALAM_THEME: 'all-variants' } });
    assert.equal(p.theme.id, 'all-variants');
    assert.equal(p.theme.componentsOn, false);
    assert.deepEqual(p.theme.components, {}, 'a v2 pack falls back to its v1 look');
    assert.equal(p.theme.fragmentLength, 0);
    assert.equal(p.theme.density, 1);
    assert.deepEqual(p.theme.caps, { button: false, tab: false, heading: false });
    assert.equal(p.theme.pattern, 'grid', 'blueprint shows as the v1 grid');
    assert.equal(p.theme.frame, false);
    assert.deepEqual(p.actions.map((a) => [a.action, a.done]), [['settings-open', true], ['settings-page:3', true], ['settings-specimen', false]]);
    assert.equal(p.specimen.open, false);
    assert.doesNotMatch(p.err, NO_ERRORS, p.err);
  });

  for (const id of ['violet-night', 'copper-graphite']) {
    test(`${id} (no components block): the same base stylesheet with the flag on and off`, async () => {
      const off = await probe({ env: { UJWALAM_THEME: id } });
      const on = await probe({ flagOn: true, env: { UJWALAM_THEME: id } });
      assert.equal(on.theme.componentsOn, true);
      assert.equal(off.theme.componentsOn, false);
      assert.ok(off.theme.baseStyleHash && off.theme.baseStyleHash === on.theme.baseStyleHash, `${off.theme.baseStyleHash} vs ${on.theme.baseStyleHash}`);
      assert.deepEqual(on.theme.components, {});
      assert.equal(on.theme.density, 1);
      assert.deepEqual(on.theme.caps, { button: false, tab: false, heading: false });
      assert.equal(on.theme.depthWidgets, off.theme.depthWidgets);
      // With the flag on only rules for widgets that exist on the specimen page are added (error input, value bubble).
      assert.ok(on.theme.fragmentLength > 0 && on.theme.fragmentLength < 400, String(on.theme.fragmentLength));
      assert.doesNotMatch(on.err, NO_ERRORS, on.err);
    });
  }

  // Codex review of T1: v2 typography, backdrop and depth fields apply only with a components block in the same pack.
  test('flag on, a pack with v2 type, frame and depth fields but no components block keeps its v1 look', async () => {
    const dir = tmp('ujw-qtc-nocomp-');
    const { components, ...noComp } = allVariantsPack();
    writeFileSync(path.join(dir, 'no-comp.json'), JSON.stringify({ ...noComp, id: 'no-comp', name: 'No Components' }));
    const off = await probe({ env: { UJWALAM_THEMES_DIR: dir, UJWALAM_THEME: 'no-comp' } });
    const on = await probe({ flagOn: true, env: { UJWALAM_THEMES_DIR: dir, UJWALAM_THEME: 'no-comp' } });
    assert.equal(on.theme.componentsOn, true);
    assert.deepEqual(on.theme.caps, { button: false, tab: false, heading: false });
    assert.equal(on.theme.frame, false);
    assert.equal(on.theme.pattern, 'grid', 'blueprint shows as the v1 grid');
    assert.equal(on.theme.baseStyleHash, off.theme.baseStyleHash);
    assert.ok(on.theme.fragmentLength < 400, 'no type scale rules');
    assert.equal(on.theme.depthWidgets, off.theme.depthWidgets);
    assert.equal(on.theme.depthV2Classes, 0, 'no highlight, inset or rim');
  });

  test('flag off after live reload refused an edit: the accepted pack is parsed again, all v2 parts go', async () => {
    const dir = tmp('ujw-qtc-reload-');
    const file = path.join(dir, 'reload-comp.json');
    const pack = { ...allVariantsPack(), id: 'reload-comp', name: 'Reload Components' };
    writeViaRename(file, `${JSON.stringify(pack, null, 2)}
`);
    // actions every 700 ms from 2.5 s: the refused edit lands at 3 s, the flag goes off at 6 s
    const p = await probe({
      ms: 8000, flagOn: true, actions: 'wait,wait,wait,wait,wait,flag-off:theme-components', env: { UJWALAM_THEMES_DIR: dir, UJWALAM_THEME: 'reload-comp' },
      during: async () => { await sleep(3000); writeViaRename(file, `${JSON.stringify({ ...pack, components: { tabs: 'wavy' } }, null, 2)}
`); },
    });
    assert.equal(p.actions.at(-1).done, true, JSON.stringify(p.actions));
    assert.equal(p.theme.rejects, 1, 'the edit was refused');
    assert.equal(p.theme.id, 'reload-comp');
    assert.equal(p.theme.componentsOn, false);
    assert.deepEqual(p.theme.components, {});
    assert.equal(p.theme.fragmentLength, 0, 'the component stylesheet is gone');
    assert.equal(p.theme.density, 1);
    assert.equal(p.theme.frame, false);
    assert.equal(p.theme.pattern, 'grid');
    assert.equal(p.theme.depthV2Classes, 0);
  });

  test('a pack using every variant: parts reported, no stylesheet errors, the specimen shows every section', async () => {
    const p = await probe({ ms: 9000, flagOn: true, actions: 'settings-open,settings-page:3,settings-specimen', env: { UJWALAM_THEMES_DIR: packs(), UJWALAM_THEME: 'all-variants' } });
    assert.ok(p.actions.every((a) => a.done), JSON.stringify(p.actions));
    assert.equal(p.theme.componentsOn, true);
    assert.ok(Object.keys(p.theme.components).length >= 14, JSON.stringify(p.theme.components));
    assert.equal(p.theme.density, 1.25);
    assert.deepEqual(p.theme.caps, { button: true, tab: true, heading: true });
    assert.equal(p.theme.pattern, 'blueprint');
    assert.equal(p.theme.frame, true);
    assert.ok(p.theme.depthV2Classes >= 2, String(p.theme.depthV2Classes));
    assert.ok(p.theme.fragmentLength > 1000, String(p.theme.fragmentLength));
    assert.doesNotMatch(p.err, NO_ERRORS, p.err);
    assert.equal(p.specimen.open, true);
    assert.deepEqual(p.specimen.sections, SECTIONS);
    assert.ok(p.specimen.widgets > 60, String(p.specimen.widgets));
    assert.equal(p.specimen.bubbleShown, true, 'a pinned slider shows its value bubble');
    assert.match(p.specimen.chips.busy, /^\[ .+ \]$/, 'bracket chips');
    assert.equal(p.specimen.tabCaps, true);
  });

  test('unknown variants or keys are refused: the pack is not listed and cannot be used', async () => {
    const p = await probe({ flagOn: true, env: { UJWALAM_THEMES_DIR: packs(), UJWALAM_THEME: 'bad-variant' } });
    assert.ok(p.theme.available.includes('all-variants'));
    assert.ok(!p.theme.available.includes('bad-variant') && !p.theme.available.includes('bad-key'), JSON.stringify(p.theme.available));
    assert.equal(p.theme.id, 'violet-night');
  });

  test('the flag switches live (control page): components appear and the specimen button works', async () => {
    const p = await probe({ ms: 9000, actions: 'flag-on:theme-components,settings-open,settings-page:3,settings-specimen', env: { UJWALAM_THEMES_DIR: packs(), UJWALAM_THEME: 'all-variants' } });
    assert.ok(p.actions.every((a) => a.done), JSON.stringify(p.actions));
    assert.equal(p.theme.componentsOn, true);
    assert.equal(p.theme.density, 1.25);
    assert.equal(p.specimen.open, true);
  });

  test('the components probe action turns the parts off and on again', async () => {
    const p = await probe({ ms: 7000, flagOn: true, actions: 'components:off,components:on,components:bogus', env: { UJWALAM_THEMES_DIR: packs(), UJWALAM_THEME: 'all-variants' } });
    assert.deepEqual(p.actions.map((a) => a.done), [true, true, false]);
    assert.equal(p.theme.componentsOn, true);
    assert.equal(p.theme.density, 1.25);
  });

  test('High performance: a pack using every variant is drawn flat (no gradients, no depth effects)', async () => {
    const p = await probe({ ms: 9000, flagOn: true, actions: 'settings-open,settings-page:3,settings-specimen', env: { UJWALAM_THEMES_DIR: packs(), UJWALAM_THEME: 'all-variants', UJWALAM_EFFECTS: 'performance', UJWALAM_STUDIO_PROBE_SHOW: '1' } });
    assert.equal(p.theme.performance, true);
    assert.equal(p.theme.gradientsInStyle, false);
    assert.equal(p.theme.depthWidgets, 0);
    assert.equal(p.specimen.depthWidgets, 0);
    assert.doesNotMatch(p.err, NO_ERRORS, p.err);
  });

  for (const scale of ['1', '1.25', '1.5']) {
    test(`specimen picture at ${Number(scale) * 100} % (copper-graphite)`, async () => {
      const dir = EVIDENCE ?? tmp('ujw-qtc-shot-');
      mkdirSync(dir, { recursive: true });
      const shot = path.join(dir, `specimen-copper-graphite-${Number(scale) * 100}.png`);
      const p = await probe({ ms: 9000, flagOn: true, actions: 'settings-open,settings-page:3,settings-specimen', shot, env: { UJWALAM_THEME: 'copper-graphite', QT_SCALE_FACTOR: scale } });
      assert.ok(p.actions.every((a) => a.done), JSON.stringify(p.actions));
      assert.equal(p.specimenShot, true);
      const file = shot.replace(/\.png$/, '-specimen.png');
      assert.ok(existsSync(file), file);
      const [w, h] = pngSize(file);
      assert.deepEqual([w, h], p.specimenShotPixels);
      const [lw, lh] = p.specimenShotSize;
      assert.ok(Math.abs(w - lw * Number(scale)) <= 2 && Math.abs(h - lh * Number(scale)) <= 2, `${w}x${h} vs ${lw}x${lh} at ${scale}`);
      assert.doesNotMatch(p.err, NO_ERRORS, p.err);
    });
  }
});
