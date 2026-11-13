// SPDX-License-Identifier: GPL-3.0-or-later
// D376: the Soft theme and ClearType text in the Qt studio shell. Soft is a pack built only from components
// (componentsAlways): with the flag theme-components off it still draws its soft surfaces (soft.cpp painters, no
// QGraphicsEffect), lists first in Appearance, and keeps text hinting "full". Switching to another pack takes all of
// it away again. The pack validates against the schema and passes the contrast rules. ClearType: the hidden native
// probe (UJWALAM_STUDIO_HIDDEN=1: real Windows font engine, nothing on the screen) renders the studio font with colour
// fringes when Windows has ClearType on; the offscreen test platform renders greyscale (why offscreen pictures are no
// evidence of how text looks). Skipped when the shell is not built. Never shows a window.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { createFakeBots, createFakeHost } from '../services/studio-ui/backends.mjs';
import { createFlags } from '../services/flags/index.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';
import { failures } from '../services/studio-ui/theme-contrast.mjs';
import { EXE, qtDir } from '../app/studio/tools/build.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(REPO, 'ui');
const QT = qtDir();
const skip = !existsSync(EXE) || !QT ? 'studio shell not built (npm run build:studio)' : false;
const read = (f) => JSON.parse(readFileSync(path.join(REPO, 'data', 'themes', f), 'utf8'));

// Windows font smoothing as the user set it (HKCU\Control Panel\Desktop, what SPI_GETFONTSMOOTHING and
// SPI_GETFONTSMOOTHINGTYPE read): smoothing on (FontSmoothing "2") and of the ClearType kind (FontSmoothingType 2).
// Either missing or different: the native test skips.
function clearTypeOn() {
  if (process.platform !== 'win32') return false;
  const value = (name) => {
    try {
      return execFileSync('reg', ['query', 'HKCU\\Control Panel\\Desktop', '/v', name], { windowsHide: true, encoding: 'utf8' });
    } catch { return ''; }
  };
  return /FontSmoothing\s+REG_SZ\s+2\s*$/m.test(value('FontSmoothing')) && /FontSmoothingType\s+REG_DWORD\s+0x2\b/.test(value('FontSmoothingType'));
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

describe('Soft theme pack (D376)', () => {
  test('validates against the schema and passes the contrast rules', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const validate = ajv.compile(read('theme.schema.json'));
    const soft = read('soft.json');
    assert.ok(validate(soft), JSON.stringify(validate.errors));
    assert.deepEqual(failures(soft), []);
  });
  test('its soft variants need the surface block: without it the contrast check fails them', () => {
    const { surface, ...noSurface } = read('soft.json');
    assert.ok(surface);
    assert.ok(failures(noSurface).some((f) => f.includes('without a surface block')), failures(noSurface).join('\n'));
  });
  test('typography: an installed system font first, hinting full, no Microsoft font file bundled', () => {
    const soft = read('soft.json');
    assert.equal(soft.typography.family, 'Segoe UI');
    assert.equal(soft.typography.hinting, 'full');
    assert.ok(!existsSync(path.join(REPO, 'data', 'fonts', 'segoeui.ttf')));
  });
});

describe('Qt studio: Soft theme and ClearType (D376)', { skip }, () => {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  async function probe({ env = {}, actions = [], ms = 6000 } = {}) {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-qtsoft-')); dirs.push(dataDir);
    const flags = createFlags({ dataDir });
    const fake = createFakeHost({});
    const host = { describe: () => fake.describe(), call: (m, p) => fake.call(m, p) };
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const key = 't'.repeat(40);
    const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: key, dataDir, flags, bots: createFakeBots(), limits: { statusPollMs: 50 } });
    const { port } = await srv.listen();
    try {
      const r = await runShell({ UJWALAM_UI_URL: `http://127.0.0.1:${port}/`, UJWALAM_UI_LAUNCH_KEY: key, UJWALAM_STUDIO_PROBE_MS: String(ms), UJWALAM_STUDIO_PROBE_ACTIONS: actions.join(','), ...env });
      assert.equal(r.code, 0, r.err);
      const m = /^studio probe: (.+)$/m.exec(r.out);
      assert.ok(m, `no probe line: ${r.out} ${r.err}`);
      return { ...JSON.parse(m[1]), err: r.err };
    } finally { await srv.close(); }
  }

  test('Soft loads with the components flag off: surfaces painted, no depth effects, hinting full, first in the list', async () => {
    const p = await probe({ env: { UJWALAM_THEME: 'soft' }, actions: ['settings-open', 'settings-page:Clips'], ms: 7000 });
    const t = p.theme;
    assert.equal(t.id, 'soft');
    assert.equal(t.componentsOn, false, 'the flag stays off');
    assert.equal(t.componentsAlways, true);
    assert.equal(t.surfaceOn, true);
    assert.ok(t.softWidgets > 20, `cards, rows and buttons get a painter: ${t.softWidgets}`);
    assert.ok(t.softCached > 0 && t.softCached < 40, `shadow pictures are cached per kind and radius: ${t.softCached}`);
    assert.equal(t.depthWidgets, 0, 'no QGraphicsEffect: text never goes through an offscreen picture');
    assert.deepEqual([t.components.card, t.components['button.style'], t.components.switch, t.components.input], ['soft', 'raised', 'knob', 'soft']);
    assert.equal(t.hinting, 'full');
    assert.equal(t.appliedHinting, 3, 'QFont::PreferFullHinting on the application font');
    assert.equal(t.appliedFamily, 'Segoe UI');
    assert.equal(t.available[0], 'soft');
    assert.equal(t.available[1], 'violet-night');
    assert.doesNotMatch(p.err, /Could not parse|Unknown property|stylesheet/i, p.err);
  });

  test('the default stays Violet Night, and switching away from Soft takes the soft look and hinting with it', async () => {
    const fresh = await probe();
    assert.equal(fresh.theme.id, 'violet-night');
    assert.equal(fresh.theme.surfaceOn, false);
    const p = await probe({ env: { UJWALAM_THEME: 'soft' }, actions: ['settings-open', 'settings-page:Clips', 'theme:violet-night'], ms: 7500 });
    assert.equal(p.actions.at(-1).done, true);
    assert.equal(p.theme.id, 'violet-night');
    assert.equal(p.theme.surfaceOn, false);
    assert.equal(p.theme.softWidgets, 0);
    assert.equal(p.theme.appliedHinting, 0, 'PreferDefaultHinting again');
    assert.deepEqual(p.theme.components, {}, 'Violet Night with the flag off: the base look');
    assert.equal(p.theme.baseStyleHash, fresh.theme.baseStyleHash);
    assert.equal(p.theme.fragmentLength, fresh.theme.fragmentLength, 'no soft rule left in the stylesheet');
    assert.ok(p.theme.depthWidgets > 0, 'Violet Night has its depth effects back');
  });

  test('effects modes: reduced and High performance keep the painters (flat faces), no gradient in the stylesheet in performance', async () => {
    const perf = await probe({ env: { UJWALAM_THEME: 'soft', UJWALAM_EFFECTS: 'performance' } });
    assert.equal(perf.theme.performance, true);
    assert.equal(perf.theme.gradientsInStyle, false);
    assert.ok(perf.theme.softWidgets > 0);
    assert.equal(perf.theme.softCached, 0, 'no shadow pictures in High performance');
    const back = await probe({ env: { UJWALAM_THEME: 'soft' }, actions: ['effects:reduced', 'effects:full'] });
    assert.ok(back.actions.every((a) => a.done));
    assert.equal(back.theme.gradientsInStyle, true);
  });

  test('a quick enter-press-release-leave never leaves a button hovered or pressed (fades end at the last target)', async () => {
    const p = await probe({ env: { UJWALAM_THEME: 'soft' }, actions: ['settings-open', 'settings-page:Clips', 'soft-flick:Cancel', 'soft-rest:Cancel'], ms: 7000 });
    const [flick, rest] = p.actions.slice(-2);
    assert.equal(flick.done, true, 'the button was found and its hover fades (motion on)');
    assert.equal(rest.done, true, 'hover and press back at 0');
  });

  test('probe actions run one after another: each starts after the previous returned, on a 700 ms beat', async () => {
    const p = await probe({ env: { UJWALAM_THEME: 'soft' }, actions: ['settings-open', 'settings-page:Clips', 'settings-page:Appearance'], ms: 6000 });
    assert.deepEqual(p.actions.map((a) => a.action), ['settings-open', 'settings-page:Clips', 'settings-page:Appearance']);
    for (let i = 1; i < p.actions.length; i++) {
      const [a, b] = [p.actions[i - 1], p.actions[i]];
      assert.ok(b.startMs >= a.endMs && b.startMs - a.startMs >= 695, JSON.stringify(p.actions));
    }
  });

  test('offscreen probe text is greyscale (no ClearType): pictures from it are no evidence of how text looks', async () => {
    const p = await probe({ env: { UJWALAM_THEME: 'soft' } });
    assert.equal(p.theme.platform, 'offscreen');
    assert.ok(p.theme.clearType.edgePixels > 100);
    assert.equal(p.theme.clearType.fringed, 0);
  });

  test('hidden native probe: the studio font renders with ClearType (Windows ClearType on)', { skip: clearTypeOn() ? false : 'Windows ClearType is off on this machine' }, async () => {
    for (const id of ['soft', 'violet-night']) {
      const p = await probe({ env: { UJWALAM_THEME: id, UJWALAM_STUDIO_HIDDEN: '1' } });
      assert.equal(p.theme.platform, 'windows');
      assert.ok(p.theme.clearType.share > 0.4, `${id}: subpixel fringes on text edges: ${JSON.stringify(p.theme.clearType)}`);
    }
  });
});
