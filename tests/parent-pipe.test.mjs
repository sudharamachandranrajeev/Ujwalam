// SPDX-License-Identifier: GPL-3.0-or-later
// Parent pipe (D234): a launcher child stops when the launcher's stdin pipe closes, even after a hard kill.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { watchParent } from '../services/common/parent-pipe.mjs';

test('without the env marker nothing is watched', () => {
  const s = new PassThrough();
  let n = 0;
  assert.equal(watchParent(() => { n++; }, { env: {}, stdin: s }), false);
  s.end();
  assert.equal(n, 0);
});

test('end of the pipe calls onGone once', async () => {
  const s = new PassThrough();
  let n = 0;
  assert.equal(watchParent(() => { n++; }, { env: { UJWALAM_PARENT_PIPE: '1' }, stdin: s }), true);
  s.write('ignored');
  s.end();
  await new Promise((r) => setTimeout(r, 20));
  s.destroy();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(n, 1);
});

test('a real child exits when its parent kills the pipe (no signal sent)', async () => {
  const mod = new URL('../services/common/parent-pipe.mjs', import.meta.url).href;
  const code = `import { watchParent } from ${JSON.stringify(mod)};
    watchParent(() => { console.log('gone'); process.exit(0); }); setInterval(() => {}, 1000);`;
  const c = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true, env: { ...process.env, UJWALAM_PARENT_PIPE: '1' } });
  let out = '';
  c.stdout.on('data', (d) => { out += d; });
  await new Promise((r) => setTimeout(r, 300));
  c.stdin.destroy(); // what the OS does to the pipe when the parent dies
  const exit = await new Promise((r) => c.once('exit', r));
  assert.equal(exit, 0);
  assert.match(out, /gone/);
});
