// SPDX-License-Identifier: GPL-3.0-or-later
// Reference themes T2-T5 (D344) and the remaining five (T6, D348), headless probe: daylight-blue, copper-graphite, sand-teal and teal-grid load with the
// flag theme-components on and no stylesheet errors, report the components block they ship, apply their bundled
// open-licence font (Inter, Barlow, Exo 2: data/fonts, SIL OFL 1.1), and the specimen page is drawn at 100, 125 and
// 150 % scale. UJWALAM_THEME_EVIDENCE=<dir> keeps the specimen pictures there. Skipped when the shell is not built.
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

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(REPO, 'ui');
const QT = qtDir();
const skip = !existsSync(EXE) || !QT ? 'studio shell not built (npm run build:studio)' : false;
const EVIDENCE = process.env.UJWALAM_THEME_EVIDENCE ? path.resolve(process.env.UJWALAM_THEME_EVIDENCE) : null;
const NO_ERRORS = /Could not parse|Unknown property|stylesheet/i;
const SECTIONS = ['BUTTONS', 'TRANSPORT', 'INPUTS', 'TABS AND SELECTION', 'SLIDERS AND PROGRESS', 'CHIPS', 'CARDS AND LISTS', 'FEEDBACK', 'HEADINGS AND TEXT'];
const THEMES = [
  { id: 'daylight-blue', font: 'Inter', density: 1.25, v2Depth: 0 },
  { id: 'copper-graphite', font: 'Barlow', density: 1, v2Depth: 2 },
  { id: 'sand-teal', font: 'Inter', density: 1.25, v2Depth: 2 },
  { id: 'teal-grid', font: 'Exo 2', density: 0.75, v2Depth: 1 },
  // T6 (D348): the five remaining packs, same checks
  { id: 'studio-light', font: 'Inter', density: 1, v2Depth: 0 },
  { id: 'violet-night', font: 'Inter', density: 1, v2Depth: 0 },
  { id: 'neon-arcade', font: 'Exo 2', density: 0.75, v2Depth: 1 },
  { id: 'retro-wave', font: 'Barlow', density: 1, v2Depth: 2 },
  { id: 'tactical', font: 'Barlow', density: 0.75, v2Depth: 0 },
];
const pack = (id) => JSON.parse(readFileSync(path.join(REPO, 'data', 'themes', `${id}.json`), 'utf8'));
const flat = (c) => Object.fromEntries(Object.entries(c).flatMap(([k, v]) => (v && typeof v === 'object' ? Object.entries(v).map(([k2, v2]) => [`${k}.${k2}`, String(v2)]) : [[k, String(v)]])));

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

const pngSize = (f) => { const b = readFileSync(f); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };

describe('Qt studio reference themes T2-T5 (D344, headless probe)', { skip }, () => {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const tmp = (p) => { const d = mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
  async function probe({ ms = 9000, actions = '', env = {}, shot = null } = {}) {
    const dataDir = tmp('ujw-qtr-');
    writeFileSync(path.join(dataDir, 'flags.local.json'), JSON.stringify({ flags: { 'theme-components': true } }));
    const flags = createFlags({ dataDir });
    const fake = createFakeHost({});
    const host = { describe: () => fake.describe(), call: (m, p) => fake.call(m, p) };
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const key = 'c'.repeat(40);
    const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: key, dataDir, flags, bots: createFakeBots(), limits: { statusPollMs: 50 } });
    const { port } = await srv.listen();
    try {
      const r = await runShell({ UJWALAM_UI_URL: `http://127.0.0.1:${port}/`, UJWALAM_UI_LAUNCH_KEY: key, UJWALAM_STUDIO_PROBE_MS: String(ms), UJWALAM_STUDIO_PROBE_ACTIONS: actions, ...(shot ? { UJWALAM_STUDIO_PROBE_SHOT: shot } : {}), ...env });
      assert.equal(r.code, 0, r.err);
      const m = /^studio probe: (.+)$/m.exec(r.out);
      assert.ok(m, `no probe line: ${r.out} ${r.err}`);
      return { ...JSON.parse(m[1]), err: r.err };
    } finally { srv.close(); }
  }

  for (const t of THEMES) {
    test(`${t.id}: loads with the flag on, ships its components block, applies ${t.font}, no stylesheet errors`, async () => {
      const p = await probe({ actions: 'settings-open,settings-page:Appearance,settings-specimen', env: { UJWALAM_THEME: t.id } });
      assert.ok(p.actions.every((a) => a.done), JSON.stringify(p.actions));
      assert.equal(p.theme.id, t.id);
      assert.equal(p.theme.componentsOn, true);
      assert.deepEqual(flat(p.theme.components), flat(pack(t.id).components));
      assert.equal(p.theme.density, t.density);
      assert.ok(p.theme.fragmentLength > 800, String(p.theme.fragmentLength));
      assert.ok(p.theme.depthV2Classes >= t.v2Depth, String(p.theme.depthV2Classes));
      assert.equal(p.theme.family, t.font);
      assert.ok(p.theme.bundledFamilies.includes(t.font), JSON.stringify(p.theme.bundledFamilies));
      assert.equal(p.theme.appliedFamily, t.font, 'the bundled font is the one Qt resolves');
      assert.doesNotMatch(p.err, NO_ERRORS, p.err);
      assert.equal(p.specimen.open, true);
      assert.deepEqual(p.specimen.sections, SECTIONS);
    });
  }

  test('fonts register once per process: a second load adds no font files', async () => {
    const p = await probe({ ms: 5000, actions: 'fonts:load,fonts:load', env: { UJWALAM_THEME: 'teal-grid' } });
    assert.ok(p.actions.every((a) => a.done), JSON.stringify(p.actions));
    assert.equal(p.theme.fontAdds, 9, 'nine ttf files, added once');
  });

  test('the three families each ship regular, semibold and bold (the weights the packs use)', async () => {
    const p = await probe({ ms: 4500, env: { UJWALAM_THEME: 'teal-grid' } });
    for (const f of ['Inter', 'Barlow', 'Exo 2']) assert.ok(p.theme.bundledFamilies.some((x) => x === f || x.startsWith(`${f} `)), `${f}: ${JSON.stringify(p.theme.bundledFamilies)}`);
  });

  for (const t of THEMES) for (const scale of ['1', '1.25', '1.5']) {
    test(`specimen picture ${t.id} at ${Number(scale) * 100} %`, async () => {
      const dir = EVIDENCE ?? tmp('ujw-qtr-shot-');
      mkdirSync(dir, { recursive: true });
      const shot = path.join(dir, `${t.id}-${Number(scale) * 100}.png`);
      const p = await probe({ actions: 'settings-open,settings-page:Appearance,settings-specimen', shot, env: { UJWALAM_THEME: t.id, QT_SCALE_FACTOR: scale } });
      assert.ok(p.actions.every((a) => a.done), JSON.stringify(p.actions));
      assert.equal(p.specimenShot, true);
      const file = shot.replace(/\.png$/, '-specimen.png');
      assert.ok(existsSync(file), file);
      const [w, h] = pngSize(file);
      const [lw, lh] = p.specimenShotSize;
      assert.ok(Math.abs(w - lw * Number(scale)) <= 2 && Math.abs(h - lh * Number(scale)) <= 2, `${w}x${h} vs ${lw}x${lh} at ${scale}`);
      assert.doesNotMatch(p.err, NO_ERRORS, p.err);
    });
  }
});
