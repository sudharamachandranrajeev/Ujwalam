// SPDX-License-Identifier: GPL-2.0-or-later
// Child process for the idempotency kill test (tests/idempotency-crash.test.mjs, P3 E7 follow-up). Node stdlib only.
//
//   node tools/idem-crash-child.mjs <dataDir> <execLog> kill <phase>   # pauses at <phase> and waits to be killed
//   node tools/idem-crash-child.mjs <dataDir> <execLog> resend         # restart: resend the same message, report, exit
//
// One invented chat message (fixed platformMessageId) goes through the real core: dedupe -> bus -> rule stub -> gate ->
// idempotent executor (audit worker persistence) -> executor. The executor appends one line to <execLog> per run with
// appendFileSync, so a kill cannot lose a run that happened. The dedupe window is 1 ms, so after the restart the
// dedupe does NOT catch the resend: only the idempotency layer stands between the resend and a second run.
// The phase hook is the test seam of livelock/idempotency.mjs (never set in the service). Prints:
//   READY | PHASE <name> | RESULT <json>   (one line each on stdout)

import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEventCore } from '../services/event-core/index.mjs';

const [dataDir, execLog, mode, target] = process.argv.slice(2);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cat = JSON.parse(readFileSync(path.join(repo, 'data', 'actions', 'catalogue.json'), 'utf8'));
const say = (line) => process.stdout.write(`${line}\n`);

const phaseHook = mode === 'kill'
  ? (phase) => {
    if (phase !== target) return undefined;
    setInterval(() => {}, 1000); // keep the process alive while it waits
    say(`PHASE ${phase}`);
    return new Promise(() => {}); // hold here; the parent kills the process (taskkill /F)
  }
  : undefined;

const core = createEventCore({
  key: Buffer.alloc(32, 11), moderation: false, dedupe: { windowMs: 1 },
  audit: { dataDir, purgeOnStart: false },
  actions: {
    catalogue: cat,
    executor: { execute: (act) => { appendFileSync(execLog, `${act.idempotencyKey ?? 'none'}\n`); return 'ran'; } },
    idempotency: { phaseHook },
  },
});
const results = [];
core.bus.subscribe({
  name: 'idem-crash-rule', kinds: ['chat.'],
  // P3 dry-run: a chat-triggered action never executes. The message triggers an untainted API request with a fixed client key
  // (the same key on the resend), confirmed in both on-air steps, so the live on-air-write path is still what is killed.
  handler: () => {
    let c = core.actions.request({ id: 'effect.fire', params: { fx: 'invented' }, source: 'api', actor: 'api', idempotencyKey: 'crash-test-key-0001' });
    for (let i = 0; i < 2 && c.verdict === 'confirm'; i++) c = core.actions.confirm(c.confirm.confirmId, c.confirm.phrase, c.confirm.actionHash, { source: 'api' });
    results.push(c);
  },
});
await core.ready;
core.actions.setLiveState('live', { source: 'system' });
say('READY');
core.ingest({ kind: 'chat.message', platform: 'twitch', source: 'mock', platformMessageId: 'idem-crash-msg-1', user: { platformUserId: 'u-crash', displayName: 'ViewerCrash' }, text: '!fx' });
for (let i = 0; i < 1000 && !results.length; i++) await new Promise((res) => setImmediate(res)); // bus delivers later
const r = results[0];
const dispatch = r?.dispatch ? await r.dispatch : null;
if (mode === 'kill') {
  say('RESULT {"unexpected":"no pause"}'); // the hook did not fire for this phase
} else {
  await core.audit.flush();
  const s = core.stats().idempotency;
  say(`RESULT ${JSON.stringify({ verdict: r?.verdict, dispatch, load: s.load, executed: s.executed, skippedCompleted: s.skippedCompleted, skippedAmbiguous: s.skippedAmbiguous, startDurable: s.startDurable })}`);
  await core.audit.close();
}
