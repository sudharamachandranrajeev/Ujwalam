// SPDX-License-Identifier: GPL-3.0-or-later
// Parent pipe (D234): a host started like the studio launcher starts it (stdin pipe + UJWALAM_PARENT_PIPE=1) shuts
// down cleanly by itself when that pipe closes, as it does when the launcher is hard-killed. Headless, no devices,
// no outputs. The "kept running while live" branch needs a live stream and is not covered here.
//   node --test app/host/tests/host-parent-pipe.test.mjs   (needs the built host and the OBS runtime)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { launchHost, stopHost } from '../lib/launch.mjs';
import { REPO_ROOT } from '../lib/config.mjs';

const OUT = path.join(REPO_ROOT, 'out', 'host', 'tests');

test('pipe closed: the host stops by itself (clean exit, discovery removed)', async () => {
  mkdirSync(OUT, { recursive: true });
  const dataDir = mkdtempSync(path.join(OUT, 'ppipe-'));
  const h = await launchHost({ dataDir, extraArgs: ['--headless'], env: { UJWALAM_HEADLESS: '1' }, parentPipe: true });
  try {
    // The host arms the pipe right after it reports ready, so the line can land just after launchHost returns (full CI
    // 2026-11-08, under load: the log ended at "rpc clips role"). Wait for it; closing the pipe earlier is still seen.
    for (let t0 = Date.now(); !/parent pipe: on/.test(h.log.join('')) && Date.now() - t0 < 10000;) await new Promise((r) => setTimeout(r, 50));
    assert.match(h.log.join(''), /parent pipe: on/);
    h.child.stdin.destroy(); // what Windows does to the pipe when the launcher dies
    const code = await Promise.race([h.exit, new Promise((r) => setTimeout(() => r('timeout'), 20000))]);
    assert.equal(code, 0, 'clean exit');
    assert.match(h.log.join(''), /shutdown \(launcher gone\)/);
    assert.equal(existsSync(path.join(dataDir, 'host.json')), false, 'discovery file removed');
  } finally {
    if (h.child.exitCode === null) await stopHost(h);
  }
});

test('without the marker the pipe is ignored', async () => {
  const h = await launchHost({ dataDir: mkdtempSync(path.join(OUT, 'ppipe-')), extraArgs: ['--headless'], env: { UJWALAM_HEADLESS: '1' } });
  assert.doesNotMatch(h.log.join(''), /parent pipe: on/);
  const r = await stopHost(h);
  assert.equal(r.code, 0);
});
