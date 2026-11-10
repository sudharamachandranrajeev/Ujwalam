// SPDX-License-Identifier: GPL-3.0-or-later
// P3 E4b (user decisions 2026-10-28): (1) chat-triggered actions run in DRY-RUN: the gate decides, the audit records what
// would have run, nothing executes; chatMode "on" is refused at load; (2) was the E4b two-step on-air confirmation;
// D331 (user decision 2026-11-10) replaced it with ONE approval click (section 2). The file name is kept for history.
// All text, ids and names are invented. Temp dirs and injected clocks only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  buildCatalogue, createActionGate, actionHash, CatalogueError, DENY_SET, CHAT_MODES, CHAT_ON_BLOCKER, DEFAULT_TTL_MS,
} from '../services/event-core/livelock/index.mjs';
import { createEventCore } from '../services/event-core/index.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const doc = () => JSON.parse(readFileSync(path.join(repo, 'data', 'actions', 'catalogue.json'), 'utf8'));
const dirs = [];
test.after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'evdry-')); dirs.push(d); return d; };
const tick = () => new Promise((r) => setImmediate(r));
const PSEUDO = '0123456789abcdef0123456789abcdef';
const EVID = 'e000000000001-00000000-aaaaaaaa';
const CHAT_TEXT = 'zzz invented viewer words 987';
const CHAT_NAME = 'InventedViewerName';
const CHAT_PLATFORM_USER = 'platform-user-invented-4242';

// effect.fire (on-air write) and marker.drop (write) are opened for chat in DRY-RUN; everything else stays as committed.
const opened = (mode = 'dry-run') => {
  const d = doc();
  for (const a of d.actions) if (a.id === 'effect.fire' || a.id === 'marker.drop') { a.chatAllowed = true; a.chatMode = mode; }
  return d;
};

function mk(extra = {}) {
  let t = 1000;
  const calls = [];
  const audit = [];
  const gate = createActionGate({
    catalogue: buildCatalogue(opened()),
    executor: { execute: (a) => { calls.push(a); return 'ok'; } },
    onDecision: (r) => audit.push(r),
    now: () => t, wall: () => Date.UTC(2026, 9, 28, 12, 0, 0) + t,
    liveStaleMs: 10_000_000, // the live state stays as set while the injected clock moves
    ...extra,
  });
  return { gate, calls, audit, advance: (ms) => { t += ms; }, clock: () => t };
}

// ================================================================================================================
// 1. Dry-run
// ================================================================================================================

test('catalogue: chatMode is off | dry-run in the schema ("on" is not, E4b finding 9); committed file has dry-run only on non-deny actions', () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const schema = JSON.parse(readFileSync(path.join(repo, 'data', 'actions', 'catalogue.schema.json'), 'utf8'));
  const validate = ajv.compile(schema);
  assert.equal(validate(doc()), true, JSON.stringify(validate.errors));
  assert.deepEqual(schema.properties.actions.items.properties.chatMode.enum, ['off', 'dry-run']);
  const on = doc();
  on.actions.find((a) => a.id === 'effect.fire').chatMode = 'on';
  assert.equal(validate(on), false, 'the schema alone refuses chatMode "on"');
  // The loader still knows "on" so that it can refuse it with the blocker text (defence in depth).
  assert.deepEqual([...CHAT_MODES], ['off', 'dry-run', 'on']);
  const bad = doc();
  bad.actions[0].chatMode = 'maybe';
  assert.equal(validate(bad), false);
  const cat = buildCatalogue(doc());
  for (const e of cat.values()) {
    assert.ok(['off', 'dry-run'].includes(e.chatMode), e.id);
    assert.equal(e.chatAllowed, false, `${e.id}: committed chatAllowed stays false (owner default)`);
  }
  for (const id of DENY_SET) assert.equal(cat.get(id).chatMode, 'off', id);
  assert.equal(buildCatalogue({ version: 1, actions: [...doc().actions.map((a) => { const { chatMode, ...rest } = a; return rest; })] }).get('effect.fire').chatMode, 'off', 'omitted means off');
});

test('catalogue: chatMode "on" is refused at load for every action, naming the blocker; so are bad values and dry-run on a deny-category action', () => {
  for (const a of doc().actions) {
    const d = doc();
    d.actions.find((x) => x.id === a.id).chatMode = 'on';
    assert.throws(() => buildCatalogue(d), (e) => e instanceof CatalogueError && e.message.includes(CHAT_ON_BLOCKER) && e.message.includes(a.id), a.id);
  }
  assert.equal(CHAT_ON_BLOCKER, 'lost-action gap must be closed first');
  const d = opened('on');
  assert.throws(() => createActionGate({ catalogue: d }), /lost-action gap must be closed first/);
  assert.throws(() => createActionGate({ catalogue: new Map(d.actions.map((a) => [a.id, a])) }), /lost-action gap must be closed first/);
  assert.throws(() => createEventCore({ key: Buffer.alloc(32, 1), actions: { catalogue: d } }), /lost-action gap must be closed first/);
  for (const v of ['ON', true, 1, null, '']) {
    const x = doc(); x.actions[0].chatMode = v;
    assert.throws(() => buildCatalogue(x), CatalogueError, String(v));
  }
  for (const id of DENY_SET) { // dry-run never widens what chat may do
    const x = doc(); x.actions.find((a) => a.id === id).chatMode = 'dry-run';
    assert.throws(() => buildCatalogue(x), /must be "off" for a deny-category/, id);
  }
});

test('dry-run: a chat request is decided and recorded, nothing executes, the answer carries no dispatch and no confirm', () => {
  const { gate, calls, audit } = mk();
  const r = gate.request({ id: 'effect.fire', params: { text: CHAT_TEXT }, source: 'chat', actor: PSEUDO, ruleId: 'burst-rule', provenance: { kind: 'chat.message', eventId: EVID } });
  assert.deepEqual([r.verdict, r.reason, r.dispatch, r.confirm], ['dry-run', 'chat-dry-run', undefined, undefined]);
  assert.deepEqual(calls, []);
  assert.equal(gate.state().pending, 0);
  assert.equal(gate.state().dryRuns, 1);
  assert.equal(audit.length, 1);
  const a = audit[0];
  assert.deepEqual(
    [a.type, a.actionId, a.rule, a.actor, a.verdict, a.reason, a.dryRun, a.wouldDecision, a.wouldReason, a.wouldSteps, a.wouldClass, a.wouldTarget],
    // E4b review finding 5: the would-be result is what the non-chat rules give (D331: one approval click)
    ['request', 'effect.fire', 'burst-rule', PSEUDO, 'dry-run', 'chat-dry-run', true, 'confirm', 'confirmation-required', 1, 'on-air-write', 'effect'],
  );
  assert.match(a.ts, /^2026-10-28T12:00:\d\d\.\d{3}Z$/);
  assert.equal(JSON.stringify(audit).includes(CHAT_TEXT), false);
  assert.equal('params' in a, false);
});

test('dry-run: the existing chat rules still apply first; dry-run is only reached by an allowed, non-forbidden, non-panic request', () => {
  const { gate, calls, audit } = mk();
  const chat = (id, extra = {}) => gate.request({ id, params: {}, source: 'chat', actor: PSEUDO, ...extra });
  for (const id of DENY_SET) assert.deepEqual([id, chat(id).verdict, chat(id).reason], [id, 'refuse', 'chat-forbidden']);
  assert.equal(chat('stream.start').dispatch, undefined);
  assert.equal(chat('scene.create').reason, 'chat-not-allowed'); // chatAllowed false
  assert.equal(chat('state.read').reason, 'chat-not-allowed');
  assert.equal(chat('no.such.action').reason, 'unknown-action');
  // chatAllowed true but chatMode off: refused, not recorded as a dry run
  const off = createActionGate({ catalogue: buildCatalogue(opened('off')), executor: { execute: () => 'x' }, onDecision: (r) => audit.push(r) });
  const n = audit.length;
  assert.deepEqual([off.request({ id: 'effect.fire', params: {}, source: 'chat', actor: PSEUDO }).reason], ['chat-off']);
  assert.equal(audit.slice(n).every((r) => r.verdict === 'refuse' && r.dryRun === undefined), true);
  // panic wins over dry-run
  gate.panic({ source: 'ui' });
  assert.deepEqual([chat('effect.fire').verdict, chat('effect.fire').reason], ['refuse', 'panic']);
  assert.equal(audit.filter((r) => r.dryRun).length, 0);
  assert.deepEqual(calls, []);
  // taint through a rule chain counts as chat too: dry-run, never an executed rule action
  const g2 = mk();
  const viaRule = g2.gate.request({ id: 'effect.fire', params: {}, source: 'rule', actor: PSEUDO, provenance: { kind: 'rule', parent: { kind: 'chat.message', eventId: EVID } } });
  assert.deepEqual([viaRule.verdict, viaRule.reason], ['dry-run', 'chat-dry-run']);
  assert.deepEqual(g2.calls, []);
  // an untainted rule (hotkey) is not chat: it still needs a confirmation and is not a dry run
  assert.equal(g2.gate.request({ id: 'effect.fire', params: {}, source: 'rule', actor: 'timer', provenance: { kind: 'hotkey' } }).verdict, 'confirm');
});

test('dry-run: a resend of the same request records one row; the second answer is dry-run-duplicate with no row and no execution', () => {
  const origin = new Map();
  const { gate, calls, audit } = mk({ originOf: (id) => origin.get(id) });
  const send = (eventId) => gate.request({ id: 'effect.fire', params: { fx: 'burst' }, source: 'rule', actor: PSEUDO, provenance: { kind: 'rule', parent: { kind: 'chat.message', eventId } } });
  // the provenance event ids must match the E1 pattern for originOf to see them
  const ids = ['e000000000001-00000000-aaaaaaaa', 'e000000000002-00000000-bbbbbbbb', 'e000000000003-00000000-cccccccc'];
  origin.set(ids[0], 'a'.repeat(64)); origin.set(ids[1], 'a'.repeat(64)); origin.set(ids[2], 'b'.repeat(64));
  assert.equal(send(ids[0]).reason, 'chat-dry-run');
  assert.equal(send(ids[1]).reason, 'dry-run-duplicate'); // same platform message, new internal event id (a resend)
  assert.equal(send(ids[2]).reason, 'chat-dry-run'); // a different message
  assert.equal(audit.filter((r) => r.dryRun).length, 2);
  assert.deepEqual([gate.state().dryRuns, gate.state().dryDuplicates], [2, 1]);
  assert.deepEqual(calls, []);
});

// ---- with the real core and audit database ----------------------------------------------------------------------

function mkCore(dataDir, extra = {}) {
  const ran = [];
  const core = createEventCore({
    key: Buffer.alloc(32, 8), moderation: false, dedupe: { windowMs: 1 }, // windowMs 1: a resend gets past the dedupe on purpose
    audit: { dataDir, purgeOnStart: false },
    actions: { catalogue: opened(), executor: { execute: (a) => { ran.push(a.id); return 'ran'; } }, ...extra },
  });
  const results = [];
  core.bus.subscribe({
    name: 'dry-rule', kinds: ['chat.'],
    handler: (ev) => results.push(core.actions.request({
      id: 'effect.fire', params: { fx: 'burst' }, source: 'rule', actor: ev.user.pseudoId, ruleId: 'burst-rule',
      provenance: { kind: 'rule', eventId: 'rule-1', parent: { kind: ev.kind, eventId: ev.id } },
    })),
  });
  const next = async (n) => { for (let i = 0; i < 1000 && results.length < n; i++) await tick(); return results[n - 1]; };
  return { core, ran, results, next };
}
const chatIn = (core, id) => core.ingest({
  kind: 'chat.message', platform: 'twitch', source: 'mock', platformMessageId: id,
  user: { platformUserId: CHAT_PLATFORM_USER, displayName: CHAT_NAME }, text: CHAT_TEXT,
});
const auditRows = async (core) => { await core.audit.flush(); const p = await core.audit.exportPage({ limit: 500 }); return p.rows ?? p; };

test('dry-run end to end: chat -> rule -> gate: nothing executes, no idempotency claim, one audit row with exactly the permitted fields', async () => {
  const { core, ran, next } = mkCore(tmp());
  await core.ready;
  core.actions.setLiveState('live', { source: 'system' });
  const expectedPseudo = core.pseudoId('twitch', CHAT_PLATFORM_USER);
  assert.equal(chatIn(core, 'dry-msg-1').status, 'published');
  const r = await next(1);
  assert.deepEqual([r.verdict, r.reason, r.dispatch], ['dry-run', 'chat-dry-run', undefined]);
  assert.deepEqual(ran, []);
  assert.equal(core.stats().idempotency.executed, 0);
  assert.equal(core.stats().idempotency.size, 0); // no key claimed, so nothing is "ambiguous" after a restart
  const rows = (await auditRows(core)).filter((x) => x.verdict === 'dry-run');
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.deepEqual(
    { type: row.type, subtype: row.subtype, action_id: row.action_id, rule_id: row.rule_id, pseudo_id: row.pseudo_id, source: row.source, verdict: row.verdict, reason: row.reason },
    { type: 'decision', subtype: 'request', action_id: 'effect.fire', rule_id: 'burst-rule', pseudo_id: expectedPseudo, source: 'rule', verdict: 'dry-run', reason: 'chat-dry-run' },
  );
  assert.match(row.ts, /^\d{4}-\d\d-\d\dT/);
  assert.match(row.event_id, /^e[0-9a-f]{12}-/);
  const detail = JSON.parse(row.detail);
  assert.deepEqual(
    { dryRun: detail.dryRun, wouldDecision: detail.wouldDecision, wouldReason: detail.wouldReason, wouldSteps: detail.wouldSteps, wouldClass: detail.wouldClass, wouldTarget: detail.wouldTarget, tainted: detail.tainted, liveState: detail.liveState },
    { dryRun: true, wouldDecision: 'confirm', wouldReason: 'confirmation-required', wouldSteps: 1, wouldClass: 'on-air-write', wouldTarget: 'effect', tainted: true, liveState: 'live' },
  );
  // No chat text, display name, platform user id or params anywhere in the row.
  const blob = JSON.stringify(row);
  for (const secret of [CHAT_TEXT, CHAT_NAME, CHAT_PLATFORM_USER, 'platform-user']) assert.equal(blob.includes(secret), false, secret);
  await core.audit.close();
});

test('dry-run end to end: a resend of the same platform message gives no second row and still nothing executes', async () => {
  const { core, ran, next } = mkCore(tmp());
  await core.ready;
  core.actions.setLiveState('live', { source: 'system' });
  chatIn(core, 'dry-msg-2');
  assert.equal((await next(1)).reason, 'chat-dry-run');
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(chatIn(core, 'dry-msg-2').status, 'published'); // the dedupe window is 1 ms: the resend got through
  assert.equal((await next(2)).reason, 'dry-run-duplicate');
  chatIn(core, 'dry-msg-3'); // a different message is a new dry run
  assert.equal((await next(3)).reason, 'chat-dry-run');
  assert.equal((await auditRows(core)).filter((x) => x.verdict === 'dry-run').length, 2);
  assert.deepEqual(ran, []);
  await core.audit.close();
});

test('dry-run rows survive the raw-chat purge; the hash chain still verifies and chat_raw is emptied', async () => {
  const dir = tmp();
  const { core, next } = mkCore(dir);
  await core.ready;
  chatIn(core, 'dry-msg-4');
  await next(1);
  await core.audit.flush();
  const before = (await auditRows(core)).filter((x) => x.verdict === 'dry-run');
  assert.equal(before.length, 1);
  const p = await core.audit.purge({ all: true, mode: 'api' }); // the strongest purge: every raw chat row, whatever its age
  assert.ok(p.purged >= 1, 'the raw chat text was purged');
  const after = (await auditRows(core)).filter((x) => x.verdict === 'dry-run');
  assert.equal(after.length, 1);
  assert.deepEqual(
    [after[0].action_id, after[0].rule_id, after[0].pseudo_id, after[0].reason, after[0].ts, after[0].hash],
    [before[0].action_id, before[0].rule_id, before[0].pseudo_id, before[0].reason, before[0].ts, before[0].hash],
  );
  const v = await core.audit.verify();
  assert.equal(v.ok, true, JSON.stringify(v));
  await core.audit.close();
  // And after a restart (the daily/startup purge path) the row is still there and the chain still verifies.
  const again = mkCore(dir);
  await again.core.ready;
  await again.core.audit.purge({ olderThanDays: 30, mode: 'startup' });
  assert.equal((await auditRows(again.core)).filter((x) => x.verdict === 'dry-run').length, 1);
  assert.equal((await again.core.audit.verify()).ok, true);
  await again.core.audit.close();
});

// ================================================================================================================
// 2. One approval click (D331, user decision 2026-11-10; replaces the E4b two-step "yes" / "yes, on air")
// ================================================================================================================
// A write the user starts on their own surface (ui, api) runs on that click. A write an automatic source asks for
// (an untainted rule, remote, system) waits for ONE approval click from ui/api: no phrase, no second step. It stays
// single use, hash-bound to action + params + source + actor + live epoch, and expires after ttlMs (60 s).

const live = (m) => { m.gate.setLiveState('live', { source: 'system' }); return m; };
// An untainted automatic rule (a hotkey) asking for an on-air write.
const onAir = (gate, over = {}) => gate.request({ id: 'scene.switch', params: { scene: 'Main' }, source: 'rule', provenance: { kind: 'hotkey' }, actor: 'u1', ...over });
const send = (gate, c, over = {}, ctx = { source: 'ui' }) => gate.confirm(c.confirm.confirmId, over.phrase, 'hash' in over ? over.hash : c.confirm.actionHash, ctx);

test('approval: happy path. A rule\'s on-air write while live waits for one click; the click runs it once', () => {
  const { gate, calls, clock } = live(mk());
  const r = onAir(gate);
  assert.deepEqual([r.verdict, r.reason, r.confirm.phrase, r.confirm.step, r.confirm.of], ['confirm', 'confirmation-required', undefined, undefined, undefined]);
  assert.equal(r.confirm.liveStateAtRequest, 'live');
  assert.deepEqual(calls, []);
  assert.equal(gate.state().pending, 1);
  const fin = send(gate, r);
  assert.deepEqual([fin.verdict, fin.reason, fin.dispatch.ok], ['allow', 'confirmed', true]);
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0].id, calls[0].params, calls[0].liveState, calls[0].class], ['scene.switch', { scene: 'Main' }, 'live', 'on-air-write']);
  assert.equal(gate.state().pending, 0);
  assert.equal(clock(), 1000);
});

test('approval: the user\'s own ui/api write runs on the click in every live state, one executor call, nothing pending', () => {
  for (const state of ['offline', 'unknown', 'live']) {
    for (const source of ['ui', 'api']) {
      for (const id of ['scene.switch', 'scene.create']) {
        const m = mk();
        if (state !== 'unknown') m.gate.setLiveState(state, { source: 'system' });
        const r = m.gate.request({ id, params: {}, source, actor: 'u1' });
        assert.deepEqual([r.verdict, r.reason, r.confirm, r.dispatch.ok], ['allow', 'ui-direct', undefined, true], `${state} ${source} ${id}`);
        assert.deepEqual(m.calls.map((c) => c.id), [id]);
        assert.equal(m.gate.state().pending, 0);
      }
    }
  }
});

test('approval: every rule/remote/system write needs one click whatever the class or live state (unknown counts as live)', () => {
  const m = mk();
  assert.equal(m.gate.state().liveState, 'unknown');
  const u = onAir(m.gate);
  assert.deepEqual([u.verdict, u.confirm.step, u.confirm.liveStateAtRequest], ['confirm', undefined, 'unknown']);
  const w = m.gate.request({ id: 'scene.create', params: {}, source: 'system', actor: 'sys' });
  assert.deepEqual([w.verdict, w.confirm.step], ['confirm', undefined]);
  assert.equal(send(m.gate, w).verdict, 'allow');
  m.gate.setLiveState('offline', { source: 'system' });
  const o = m.gate.request({ id: 'scene.switch', params: {}, source: 'remote', actor: 'r1' });
  assert.equal(o.verdict, 'confirm');
  const done = send(m.gate, o, {}, { source: 'api' });
  assert.deepEqual([done.verdict, done.reason], ['allow', 'confirmed']);
  assert.deepEqual(m.calls.map((c) => c.id), ['scene.create', 'scene.switch']);
});

test('approval: the phrase argument is ignored (an old client may still send one)', () => {
  for (const phrase of [undefined, 'yes', 'yes, on air', 'anything', '']) {
    const { gate, calls } = live(mk());
    assert.equal(send(gate, onAir(gate), { phrase }).verdict, 'allow', String(phrase));
    assert.equal(calls.length, 1);
  }
});

test('approval: expires after ttlMs (60 s); 1 ms short still works; a custom ttl is honoured, a bad one refused; stepTtlMs is ignored', () => {
  assert.equal(DEFAULT_TTL_MS, 60_000);
  const a = live(mk());
  const r = onAir(a.gate);
  assert.equal(r.confirm.expiresAt, a.clock() + 60_000);
  a.advance(59_999);
  assert.equal(send(a.gate, r).verdict, 'allow');
  const b = live(mk());
  const r1 = onAir(b.gate);
  b.advance(60_000);
  assert.equal(send(b.gate, r1).reason, 'expired');
  assert.equal(send(b.gate, r1).reason, 'replayed');
  assert.equal(b.gate.state().pending, 0);
  assert.deepEqual(b.calls, []);
  const d = live(mk({ ttlMs: 5_000 }));
  assert.equal(onAir(d.gate).confirm.expiresAt, d.clock() + 5_000);
  assert.throws(() => mk({ ttlMs: 0 }), TypeError);
  const e = live(mk({ stepTtlMs: 5_000 })); // the old two-step option: accepted and ignored
  assert.equal(onAir(e.gate).confirm.expiresAt, e.clock() + 60_000);
});

test('approval: no confirmation id can be guessed', () => {
  const { gate, calls } = live(mk());
  const r = onAir(gate);
  for (const guess of ['0'.repeat(32), r.confirm.confirmId.split('').reverse().join('')]) {
    assert.equal(gate.confirm(guess, undefined, r.confirm.actionHash, { source: 'ui' }).reason, 'unknown-confirm');
  }
  assert.deepEqual(calls, []);
  assert.equal(gate.state().pending, 1);
});

test('approval: replay. A confirmation cannot be used twice', () => {
  const { gate, calls } = live(mk());
  const r = onAir(gate);
  assert.equal(send(gate, r).verdict, 'allow');
  assert.equal(send(gate, r).reason, 'replayed');
  assert.equal(send(gate, r, {}, { source: 'api' }).reason, 'replayed');
  assert.equal(calls.length, 1);
});

test('approval: a wrong or missing hash is refused and spends the confirmation', () => {
  for (const [label, hash] of [['other hash', 'f'.repeat(64)], ['no hash', undefined]]) {
    const { gate, calls } = live(mk());
    const r = onAir(gate);
    const res = send(gate, r, { hash });
    assert.deepEqual([res.verdict, res.reason], ['refuse', 'hash-mismatch'], label);
    assert.equal(send(gate, r).reason, 'replayed', label);
    assert.deepEqual(calls, [], label);
  }
});

test('approval: cannot be rebound to another action or other params; the hash is bound to action, params, source, actor and epoch', () => {
  const { gate, calls } = live(mk());
  const a = onAir(gate, { params: { scene: 'A' } });
  const b = onAir(gate, { params: { scene: 'B' } });
  const other = onAir(gate, { id: 'layer.show', params: { scene: 'A' } });
  assert.equal(new Set([a.confirm.actionHash, b.confirm.actionHash, other.confirm.actionHash]).size, 3);
  assert.equal(send(gate, a, { hash: b.confirm.actionHash }).reason, 'hash-mismatch');
  assert.equal(send(gate, b, { hash: other.confirm.actionHash }).reason, 'hash-mismatch');
  assert.deepEqual(calls, []);
  assert.equal(send(gate, other).verdict, 'allow'); // the third is intact and runs exactly its own action
  assert.deepEqual(calls.map((c) => [c.id, c.params]), [['layer.show', { scene: 'A' }]]);
  // Params mutated after the request do not change what runs.
  const params = { scene: 'orig' };
  const m = onAir(gate, { params });
  params.scene = 'EVIL';
  send(gate, m);
  assert.deepEqual(calls[1].params, { scene: 'orig' });
  // The hash recipe: epoch, source and actor are part of it; a phrase is not any more.
  const base = { id: 'scene.switch', params: { scene: 'Main' }, source: 'rule', actor: 'u1', epoch: 7 };
  const h = actionHash(base);
  assert.notEqual(h, actionHash({ ...base, epoch: 8 }));
  assert.notEqual(h, actionHash({ ...base, source: 'ui' }));
  assert.notEqual(h, actionHash({ ...base, actor: 'u2' }));
  assert.equal(h, actionHash({ ...base, phrase: 'yes, on air', step: 2 }));
  // Epoch is in the issued hash: the same request after a live-state change has a different hash.
  const g = live(mk());
  const h1 = onAir(g.gate).confirm.actionHash;
  g.gate.setLiveState('offline', { source: 'system' });
  g.gate.setLiveState('live', { source: 'system' });
  assert.notEqual(onAir(g.gate).confirm.actionHash, h1);
});

test('approval: either ui or api may give the click (no same-source rule without a second step)', () => {
  for (const source of ['ui', 'api']) {
    const { gate, calls } = live(mk());
    assert.equal(send(gate, onAir(gate), {}, { source }).verdict, 'allow', source);
    assert.equal(calls.length, 1);
  }
});

test('approval: a live-state change between the request and the click invalidates it', () => {
  for (const flip of [['offline'], ['unknown'], ['offline', 'live'], ['live']]) { // 'live' again is a refresh, not a change
    const { gate, calls } = live(mk());
    const r = onAir(gate);
    for (const st of flip) gate.setLiveState(st, { source: 'api' });
    const res = send(gate, r);
    if (flip.length === 1 && flip[0] === 'live') assert.equal(res.verdict, 'allow', 'same state again is not a change');
    else { assert.deepEqual([res.verdict, res.reason], ['refuse', 'live-state-changed'], flip.join('>')); assert.deepEqual(calls, []); }
    assert.equal(send(gate, r).reason, 'replayed');
  }
  // a stale live state (no refresh within liveStaleMs) is 'unknown', which differs from the state at issue
  const st = live(mk({ liveStaleMs: 15_000 }));
  const sr = onAir(st.gate);
  st.advance(20_000);
  assert.equal(send(st.gate, sr).reason, 'live-state-changed');
  assert.deepEqual(st.calls, []);
});

test('approval: panic drops a pending confirmation', () => {
  const { gate, calls } = live(mk());
  const r = onAir(gate);
  gate.panic({ source: 'ui' });
  assert.equal(gate.state().pending, 0);
  assert.equal(send(gate, r).reason, 'unknown-confirm');
  assert.deepEqual(calls, []);
});

test('approval: chat can never give the click (source and provenance), and a refused attempt does not spend it', () => {
  const { gate, calls, audit } = live(mk());
  const r = onAir(gate);
  assert.equal(send(gate, r, {}, { source: 'chat' }).reason, 'source-not-permitted');
  for (const src of ['chat', 'rule', 'remote', 'system']) assert.equal(gate.forSource(src).confirm(r.confirm.confirmId, undefined, r.confirm.actionHash).reason, 'source-not-permitted', src);
  const chatProv = { kind: 'chat.message', eventId: EVID };
  assert.equal(send(gate, r, {}, { source: 'ui', provenance: chatProv }).reason, 'tainted-confirmation');
  assert.equal(send(gate, r, {}, { source: 'api', provenance: { kind: 'rule', parent: chatProv } }).reason, 'tainted-confirmation');
  assert.equal(send(gate, r, {}, { source: 'ui', provenance: { kind: 'alert.sub' } }).reason, 'tainted-confirmation');
  assert.equal(send(gate, r, {}, { source: 'ui', provenance: { kind: 'webhook.unknown' } }).reason, 'tainted-confirmation'); // fail safe
  assert.equal(gate.forSource('ui').confirm(r.confirm.confirmId, undefined, r.confirm.actionHash, { provenance: chatProv }).reason, 'tainted-confirmation');
  assert.equal(gate.state().pending, 1); // none of those spent it
  assert.deepEqual(calls, []);
  // a clean provenance (a hotkey) on the click is fine
  assert.equal(send(gate, r, {}, { source: 'ui', provenance: { kind: 'hotkey' } }).verdict, 'allow');
  assert.equal(calls.length, 1);
  // every refusal is audited, none with free text
  assert.ok(audit.filter((a) => a.reason === 'tainted-confirmation').length >= 5);
  assert.equal(JSON.stringify(audit).includes('webhook'), false); // an unknown kind is reported as invalid, not echoed
  // a chat-sourced REQUEST for the same action is refused or dry-run, never offered a confirmation or run
  const chatReq = gate.request({ id: 'scene.switch', params: {}, source: 'chat', actor: PSEUDO });
  assert.equal(chatReq.confirm, undefined);
  assert.equal(chatReq.dispatch, undefined);
  // and a ui transport carrying chat provenance is tainted: never direct
  const tainted = gate.request({ id: 'scene.switch', params: {}, source: 'ui', actor: 'u1', provenance: chatProv });
  assert.notEqual(tainted.verdict, 'allow');
  assert.equal(calls.length, 1);
});

test('approval: the audit records the issue and the click with the hash and confirming source, in order', () => {
  const { gate, audit } = live(mk());
  const n = audit.length;
  send(gate, onAir(gate));
  const rows = audit.slice(n).map((a) => [a.type, a.verdict, a.reason, a.step, a.confirmingSource]);
  assert.deepEqual(rows, [
    ['confirm-issued', 'confirm', 'confirmation-required', undefined, undefined],
    ['confirm-accepted', 'allow', 'confirmed', undefined, 'ui'],
  ]);
  for (const a of audit.slice(n)) assert.match(a.actionHash, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(audit).includes('Main'), false); // params never reach the audit
});

test('approval: the pending quota still holds per source', () => {
  const { gate } = live(mk({ maxPending: 2 }));
  const a = onAir(gate, { params: { i: 1 } });
  const b = onAir(gate, { params: { i: 2 } });
  assert.equal(onAir(gate, { params: { i: 3 } }).reason, 'too-many-pending');
  assert.equal(send(gate, a).verdict, 'allow');
  assert.equal(gate.state().pending, 1);
  assert.equal(onAir(gate, { params: { i: 4 } }).verdict, 'confirm');
  assert.equal(b.verdict, 'confirm');
});

test('approval over the idempotent executor: a keyed on-air write runs once; the same client key again is skipped', async () => {
  const dir = tmp();
  const ran = [];
  const core = createEventCore({
    key: Buffer.alloc(32, 6), moderation: false, audit: { dataDir: dir, purgeOnStart: false },
    actions: { catalogue: doc(), executor: { execute: (a) => { ran.push(a.id); return 'ok'; } } },
  });
  await core.ready;
  core.actions.setLiveState('live', { source: 'system' });
  const direct = () => core.actions.request({ id: 'scene.switch', params: { scene: 'Main' }, source: 'api', actor: 'api', idempotencyKey: 'onestep-key-0001' }).dispatch;
  assert.deepEqual(await direct(), { ok: true, result: 'ok' });
  assert.deepEqual(await direct(), { ok: false, error: 'skipped', skipped: 'completed' }); // E4b review finding 8: not ok
  const approved = () => {
    const r = core.actions.request({ id: 'scene.switch', params: { scene: 'Main' }, source: 'rule', provenance: { kind: 'hotkey' }, actor: 'hk', idempotencyKey: 'onestep-key-0002' });
    return core.actions.confirm(r.confirm.confirmId, undefined, r.confirm.actionHash, { source: 'api' }).dispatch;
  };
  assert.deepEqual(await approved(), { ok: true, result: 'ok' });
  assert.deepEqual(await approved(), { ok: false, error: 'skipped', skipped: 'completed' });
  assert.deepEqual(ran, ['scene.switch', 'scene.switch']);
  await core.audit.close();
});
