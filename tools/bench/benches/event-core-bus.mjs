// SPDX-License-Identifier: GPL-2.0-or-later
// Bench: event core in-process cost per event (P3 E1): construct + validate + dedupe + publish to 3 subscribers.
// SYNTHETIC input: generated chat and alert objects with made-up ids and names, no real chat. Timing covers
// the synchronous ingest call only; handler delivery (a microtask later) is awaited after the batch and not
// timed. This is the in-process part of PB-12 (ingest to dispatch); the full path is measured in E7.
import { createEventCore } from '../../../services/event-core/index.mjs';

export const id = 'event-core-bus';
export const budget = 'PB-12';
export const metrics = {
  p50_ms: { unit: 'ms', lowerIsBetter: true, minDelta: 0.005 },
  p95_ms: { unit: 'ms', lowerIsBetter: true, minDelta: 0.01 },
};

const BATCH = 5000;
// Mix: mostly chat, some alerts (synthetic).
const KIND_MIX = ['chat.message', 'chat.message', 'chat.message', 'chat.message', 'alert.follow', 'alert.bits', 'alert.sub', 'alert.raid'];
const EXTRA = {
  'chat.message': { text: 'synthetic message text for the bench' },
  'alert.follow': {},
  'alert.bits': { amount: 100 },
  'alert.sub': { tier: '1000' },
  'alert.raid': { viewers: 10 },
};

function percentile(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

export async function run() {
  const core = createEventCore({ key: Buffer.alloc(32, 1) }); // key given directly: no disk in the timed path
  let sink = 0;
  for (const name of ['a', 'b', 'c']) core.bus.subscribe({ name, limit: BATCH, handler: () => { sink++; } });
  const inputs = Array.from({ length: BATCH }, (_, i) => {
    const kind = KIND_MIX[i % KIND_MIX.length];
    return {
      kind, platform: 'twitch', source: 'mock', platformMessageId: `syn-${i}`,
      user: { platformUserId: `user-${i % 200}`, displayName: `Viewer${i % 200}`, roles: ['viewer'] },
      ...EXTRA[kind],
    };
  });
  const times = new Float64Array(BATCH);
  for (let i = 0; i < BATCH; i++) {
    const t0 = performance.now();
    const r = core.ingest(inputs[i]);
    times[i] = performance.now() - t0;
    if (r.status !== 'published') throw new Error(`bench event ${i} ${r.status}`);
  }
  await new Promise((r) => setImmediate(r)); // let the subscribers drain
  if (sink !== BATCH * 3) throw new Error(`delivered ${sink}, expected ${BATCH * 3}`);
  const sorted = Array.from(times).sort((a, b) => a - b);
  return { p50_ms: percentile(sorted, 0.5), p95_ms: percentile(sorted, 0.95) };
}
