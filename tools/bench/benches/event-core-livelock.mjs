// SPDX-License-Identifier: GPL-3.0-or-later
// Bench: live-lock gate decision cost (P3 E4). Per-decision p50/p95 of the synchronous request() call.
// SYNTHETIC input: made-up action params, actors and event ids, no real chat. The mix: read allow, chat refuse
// (deny category), chat refuse (not allowed; the committed catalogue is chatAllowed false everywhere since the
// 2026-10-28 review), ui write -> run at once (D331, the user's own click), and untainted rule -> confirm
// (SHA-256 + random id). Each source has its own pending quota (16); once full, new requests are refused, so most
// rule requests after the first 16 take the quota refusal. Confirm() (one approval click, D331) is timed
// separately in confirm_p50_ms. Part of PB-12.
import { createActionGate, loadCatalogue } from '../../../services/event-core/livelock/index.mjs';

export const id = 'event-core-livelock';
export const budget = 'PB-12';
export const metrics = {
  p50_ms: { unit: 'ms', lowerIsBetter: true, minDelta: 0.002 },
  p95_ms: { unit: 'ms', lowerIsBetter: true, minDelta: 0.005 },
  confirm_p50_ms: { unit: 'ms', lowerIsBetter: true, minDelta: 0.005 },
};

const BATCH = 6000;
const CHAT = { kind: 'chat.message', eventId: 'e000000000001-00000000-aaaaaaaa' };
const MIX = [
  { id: 'state.read', source: 'ui' },
  { id: 'effect.fire', source: 'rule', provenance: { kind: 'rule', parent: CHAT } },
  { id: 'stream.start', source: 'chat' },
  { id: 'scene.create', source: 'rule', provenance: CHAT },
  { id: 'scene.switch', source: 'ui' },
  { id: 'replay.save', source: 'rule', provenance: { kind: 'schedule' } },
];

function percentile(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

export async function run() {
  let sink = 0;
  const gate = createActionGate({ catalogue: loadCatalogue(), executor: { execute: () => { sink++; } } });
  gate.setLiveState('live', { source: 'system' });
  const inputs = Array.from({ length: BATCH }, (_, i) => ({
    ...MIX[i % MIX.length], params: { n: i, scene: `Scene${i % 20}` }, actor: `actor-${i % 50}`,
  }));
  const times = new Float64Array(BATCH);
  const confirms = [];
  for (let i = 0; i < BATCH; i++) {
    const t0 = performance.now();
    const r = gate.request(inputs[i]);
    times[i] = performance.now() - t0;
    if (r.verdict === 'confirm') confirms.push(r);
  }
  const ct = [];
  for (const r of confirms.slice(-12)) { // the newest 12 are still pending (cap 16)
    const t0 = performance.now();
    const c = gate.confirm(r.confirm.confirmId, undefined, r.confirm.actionHash, { source: 'ui' });
    ct.push(performance.now() - t0);
    if (c.verdict !== 'allow') throw new Error(`bench confirm ${c.reason}`);
  }
  if (sink < 1) throw new Error('executor never ran');
  const sorted = Array.from(times).sort((a, b) => a - b);
  ct.sort((a, b) => a - b);
  return { p50_ms: percentile(sorted, 0.5), p95_ms: percentile(sorted, 0.95), confirm_p50_ms: percentile(ct, 0.5) };
}
