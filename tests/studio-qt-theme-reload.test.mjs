// SPDX-License-Identifier: GPL-3.0-or-later
// LU2 (D324): the Qt studio reloads the theme pack in use when its file changes on disk. Headless probe: a valid
// change applies without a restart (accent colour), a broken file keeps the last good look and is reported (studio
// log warning, probe rejects / lastReject), a later valid version applies again. Skipped when the shell is not built.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
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
const QT = qtDir();
const skip = !existsSync(EXE) || !QT ? 'studio shell not built (npm run build:studio)' : false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('Qt studio: theme pack hot-reload (headless probe)', { skip }, () => {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  test('valid change applies live; broken file keeps the last good look and is reported; a fix applies again', async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-qtr-')); dirs.push(dataDir);
    const themes = mkdtempSync(path.join(os.tmpdir(), 'ujw-qtr-themes-')); dirs.push(themes);
    const logDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-qtr-log-')); dirs.push(logDir);
    const pack = JSON.parse(readFileSync(path.join(REPO, 'data', 'themes', 'violet-night.json'), 'utf8'));
    const file = path.join(themes, 'lu-reload.json');
    const write = (accent) => { const p = structuredClone(pack); p.id = 'lu-reload'; p.name = 'Reload test'; p.colors.accent = accent; const t = `${JSON.stringify(p, null, 2)}\n`; writeViaRename(file, t); return t; };
    write('#112233');

    const flags = createFlags({ dataDir });
    const fake = createFakeHost({});
    const host = { describe: () => fake.describe(), call: (m, p) => fake.call(m, p) };
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const key = 't'.repeat(40);
    const srv = createStudioServer({ uiRoot: path.join(REPO, 'ui'), core, host, launchKey: key, dataDir, flags, bots: createFakeBots(), limits: { statusPollMs: 50 }, watchData: false });
    const { port } = await srv.listen();
    try {
      const child = spawn(EXE, [], {
        windowsHide: true,
        env: { ...process.env, PATH: `${path.join(QT, 'bin')}${path.delimiter}${process.env.PATH}`, UJWALAM_HEADLESS: '1', QT_QPA_FONTDIR: path.join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts'),
          UJWALAM_UI_URL: `http://127.0.0.1:${port}/`, UJWALAM_UI_LAUNCH_KEY: key, UJWALAM_STUDIO_PROBE_MS: '9000', UJWALAM_THEMES_DIR: themes, UJWALAM_THEME: 'lu-reload', UJWALAM_STUDIO_LOG_DIR: logDir },
      });
      let out = '', err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      const closed = new Promise((r) => { const t = setTimeout(() => child.kill(), 30_000); child.on('close', (code) => { clearTimeout(t); r(code); }); });
      await sleep(3000);
      write('#445566');                                  // valid: applies
      await sleep(1500);
      const good = readFileSync(file, 'utf8');
      writeViaRename(file, good.slice(0, Math.floor(good.length / 2))); // broken: kept out
      await sleep(1500);
      write('#778899');                                  // valid again
      const code = await closed;
      assert.equal(code, 0, err);
      const m = /^studio probe: (.+)$/m.exec(out);
      assert.ok(m, `no probe line: ${out} ${err}`);
      const p = JSON.parse(m[1]);
      assert.equal(p.theme.id, 'lu-reload');
      assert.equal(p.theme.accent, '#778899');
      assert.equal(p.theme.reloads, 2);
      assert.equal(p.theme.rejects, 1);
      assert.match(p.theme.lastReject, /JSON/i);
      // A GUI-subsystem Qt app sends warnings to the debugger, not stderr; the studio log file is the record.
      const log = readdirSync(logDir).filter((f) => /^studio-.*\.log$/.test(f)).map((f) => readFileSync(path.join(logDir, f), 'utf8')).join('');
      assert.match(log, /warn\w*: theme: lu-reload\.json not applied, the last good look stays/);
    } finally { srv.close(); }
  });
});
