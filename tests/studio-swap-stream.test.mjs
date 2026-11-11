// SPDX-License-Identifier: GPL-3.0-or-later
// LU4 "Done when" (D346): the studio window is swapped 20 times during a loopback stream with no dropped frame, and the
// previews are back within 3 s each time; a studio build that crashes at start is rolled back. Runs
// tools/soak/studio-swap-soak.mjs (headless: the real host and the real studio with UJWALAM_STUDIO_HIDDEN=1, loopback
// RTMP listeners only). Heavy (an NVENC stream for a few minutes), so it runs only on request:
//   npm run test:studio-swap        (sets UJWALAM_STUDIO_SWAP_STREAM=1)
// Without that, or when the host, the studio or ffmpeg is missing, it is skipped. The parse checks always run.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseStudioSwapArgs } from '../tools/soak/studio-swap-soak.mjs';
import { EXE as STUDIO_EXE, qtDir } from '../app/studio/tools/build.mjs';
import { resolveConfig } from '../app/host/lib/config.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('parseStudioSwapArgs: defaults, values, refusals', () => {
  assert.deepEqual(parseStudioSwapArgs([]), { swaps: 20, workDir: null, wait: false });
  assert.deepEqual(parseStudioSwapArgs(['--swaps', '3', '--work-dir', 'W', '--wait']), { swaps: 3, workDir: 'W', wait: true });
  assert.throws(() => parseStudioSwapArgs(['--swaps', '0']), /1\.\.200/);
  assert.throws(() => parseStudioSwapArgs(['--live']), /unknown argument/);
});

const why = () => {
  if (process.env.UJWALAM_STUDIO_SWAP_STREAM !== '1') return 'heavy: runs with npm run test:studio-swap (UJWALAM_STUDIO_SWAP_STREAM=1)';
  if (!existsSync(STUDIO_EXE) || !qtDir()) return 'studio not built (npm run build:studio)';
  if (!existsSync(resolveConfig().exe)) return 'host not built (npm run build:host)';
  if (spawnSync(process.env.FFMPEG || 'ffmpeg', ['-version'], { windowsHide: true }).status !== 0) return 'ffmpeg not found';
  return false;
};

test('studio swapped 20 times during a loopback stream: 0 dropped frames, previews back within 3 s, crashing build rolled back', { skip: why(), timeout: 900_000 }, async () => {
  const child = spawn(process.execPath, [path.join(REPO, 'tools', 'soak', 'studio-swap-soak.mjs'), '--swaps', '20'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, UJWALAM_HEADLESS: '1' } });
  let out = '';
  child.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
  child.stderr.on('data', (d) => { out += d; });
  const code = await new Promise((r) => child.once('exit', r));
  const file = /result: (.*studio-swap-soak\.json)/.exec(out)?.[1];
  const r = file ? JSON.parse(readFileSync(file.trim(), 'utf8')) : null;
  assert.ok(r, out.slice(-3000));
  assert.deepEqual(r.checks.filter((x) => !x.pass), [], JSON.stringify(r.checks.filter((x) => !x.pass)));
  assert.equal(r.rounds.length, 20);
  assert.equal(code, 0);
});
