// SPDX-License-Identifier: GPL-3.0-or-later
// Scene transitions, UI server side (D239): the host's per-canvas transition follows flag `transitions` (off by
// default = cut) and the project's canvases[].transition; a mismatch is set again on the next poll.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFlags } from '../services/flags/index.mjs';
import { createStudioServer, TRANSITIONS_FLAG } from '../services/studio-ui/server.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return; await sleep(10); }
  assert.fail(`timed out: ${what}`);
}

test('flag off: cut on both canvases; on: the project fades; a host that drifts is set again; off: cut again', async () => {
  const tr = { H: { type: 'cut', durationMs: 0, available: true }, V: { type: 'fade', durationMs: 500, available: true } };
  const calls = [];
  const host = {
    describe: () => ({ kind: 'host', available: true }),
    call: async (m, p) => {
      if (m === 'host.status') return { live: false, recording: false, transitions: structuredClone(tr) };
      if (m === 'transitions.set') { calls.push(p); tr[p.canvas] = { type: p.type, durationMs: p.durationMs, available: true }; return tr; }
      return {};
    },
  };
  const flags = createFlags({ dataDir: mkdtempSync(path.join(os.tmpdir(), 'ujw-tr-')) });
  const core = { describe: () => ({ available: false }), call: async () => { throw new Error('x'); } };
  const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: 'k'.repeat(48), flags, transitions: { h: { type: 'fade', durationMs: 2006 }, v: { type: 'fade', durationMs: 1000 } }, limits: { statusPollMs: 20 } });
  await srv.listen();
  try {
    await until(() => tr.V.type === 'cut', 'V set to cut while the flag is off');
    assert.deepEqual(calls, [{ canvas: 'V', type: 'cut', durationMs: 0 }], 'H already matched: not called');
    flags.set(TRANSITIONS_FLAG, true);
    await until(() => tr.H.durationMs === 2006 && tr.V.durationMs === 1000, 'project fades applied');
    tr.H = { type: 'cut', durationMs: 0, available: true }; // host restarted
    await until(() => tr.H.durationMs === 2006, 'set again after a host restart');
    flags.set(TRANSITIONS_FLAG, false);
    await until(() => tr.H.type === 'cut' && tr.V.type === 'cut', 'cut again when off');
  } finally { await srv.close(); }
});
