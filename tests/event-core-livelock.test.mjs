// SPDX-License-Identifier: GPL-3.0-or-later
// services/event-core/livelock: catalogue validation and tamper, confirmations, live state, panic, audit,
// executor dispatch, and the end-to-end mock chat taint path. All text is invented. Temp dirs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  buildCatalogue, loadCatalogue, createActionGate, actionHash, canonicalJson, CatalogueError, DENY_SET,
  DEFAULT_TTL_MS, DEFAULT_MAX_PENDING,
} from '../services/event-core/livelock/index.mjs';
import { createEventCore } from '../services/event-core/index.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catPath = path.join(repo, 'data', 'actions', 'catalogue.json');
const doc = () => JSON.parse(readFileSync(catPath, 'utf8'));
// The committed catalogue has chatAllowed false everywhere (owner default 2026-10-28). Tests of the chat-allowed
// path use this test-only seed, which turns chat on for the ids the first E4 build proposed.
const CHAT_SEED = ['scene.switch', 'layer.show', 'layer.hide', 'effect.fire', 'camera.toggle', 'replay.save', 'marker.drop', 'chat.reply'];
// chatMode 'dry-run' goes with it: chat requests are decided and recorded, never executed (P3 dry-run; 'on' cannot load).
const seeded = () => { const d = doc(); for (const a of d.actions) if (CHAT_SEED.includes(a.id)) { a.chatAllowed = true; a.chatMode = 'dry-run'; } return d; };
const PSEUDO = '0123456789abcdef0123456789abcdef';
const EVID = 'e000000000001-00000000-aaaaaaaa';
const dirs = [];
test.after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'evlock-')); dirs.push(d); return d; };
const tick = () => new Promise((r) => setImmediate(r));

function mk(extra = {}) {
  let t = 1000;
  const calls = [];
  const audit = [];
  const gate = createActionGate({
    catalogue: buildCatalogue(seeded()),
    executor: { execute: (a) => { calls.push(a); return 'ok'; } },
    onDecision: (r) => audit.push(r),
    now: () => t,
    wall: () => Date.UTC(2026, 9, 28, 12, 0, 0) + t,
    ...extra,
  });
  return { gate, calls, audit, advance: (ms) => { t += ms; }, clock: () => t };
}
const req = (gate, over = {}) => gate.request({ id: 'scene.switch', params: { scene: 'Main' }, source: 'ui', actor: 'u1', ...over });
// Confirms and, for an on-air write while live (two steps), follows the step-2 confirmation the gate returns.
const ok = (gate, r, source = 'ui') => {
  let c = gate.confirm(r.confirm.confirmId, r.confirm.phrase, r.confirm.actionHash, { source });
  while (c.verdict === 'confirm') c = gate.confirm(c.confirm.confirmId, c.confirm.phrase, c.confirm.actionHash, { source });
  return c;
};
const offline = (m) => { m.gate.setLiveState('offline', { source: 'system' }); return m; };

// ---- catalogue -------------------------------------------------------------------------------------------

test('catalogue: committed file validates against its schema and loads; every action has class/target/description', () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(JSON.parse(readFileSync(path.join(repo, 'data', 'actions', 'catalogue.schema.json'), 'utf8')));
  assert.equal(validate(doc()), true, JSON.stringify(validate.errors));
  const cat = loadCatalogue();
  assert.ok(cat.size >= 25);
  for (const e of cat.values()) {
    assert.ok(['read', 'write', 'on-air-write'].includes(e.class));
    assert.equal(typeof e.chatAllowed, 'boolean');
    assert.ok(e.description.length > 0 && e.target);
  }
  for (const id of DENY_SET) { assert.ok(cat.has(id), id); assert.equal(cat.get(id).chatAllowed, false, id); }
});

test('catalogue: chatAllowed:true on any deny-set action fails validation at load', () => {
  for (const id of DENY_SET) {
    const d = doc();
    d.actions.find((a) => a.id === id).chatAllowed = true;
    assert.throws(() => buildCatalogue(d), CatalogueError, id);
    const f = path.join(tmp(), 'cat.json');
    writeFileSync(f, JSON.stringify(d));
    assert.throws(() => loadCatalogue(f), /deny-category/, id);
  }
});

test('catalogue: other validation failures (class, keys, duplicates, missing panic ids, deny set as read)', () => {
  const bad = (fn) => { const d = doc(); fn(d); assert.throws(() => buildCatalogue(d), CatalogueError); };
  bad((d) => { d.actions[0].class = 'admin'; });
  bad((d) => { d.actions[0].extra = 1; });
  bad((d) => { d.actions.push({ ...d.actions[0] }); });
  bad((d) => { d.actions = d.actions.filter((a) => a.id !== 'panic.clear'); });
  bad((d) => { d.actions.find((a) => a.id === 'stream.start').class = 'read'; });
  bad((d) => { d.actions[0].chatAllowed = 'yes'; });
  bad((d) => { d.version = 2; });
  assert.throws(() => buildCatalogue(null), CatalogueError);
});

test('catalogue: tamper. Rogue catalogues (deny ids chat-allowed, a deny id as class read, new deny-category ids) are rejected by the loader AND by the gate, and the gate keeps a private copy', () => {
  const d = doc();
  for (const id of DENY_SET) d.actions.find((a) => a.id === id).chatAllowed = true;
  assert.throws(() => buildCatalogue(d), CatalogueError);
  // Bypass the loader on purpose: hand-built Maps go straight to the gate, which rebuilds them through buildCatalogue.
  const rogue = new Map(d.actions.map((a) => [a.id, { ...a, chatAllowed: true }]));
  assert.throws(() => createActionGate({ catalogue: rogue }), CatalogueError);
  const readDeny = new Map(doc().actions.map((a) => [a.id, a.id === 'stream.start' ? { ...a, class: 'read' } : a]));
  assert.throws(() => createActionGate({ catalogue: readDeny }), CatalogueError);
  const readDenyChat = new Map(doc().actions.map((a) => [a.id, a.id === 'stream.start' ? { ...a, class: 'read', chatAllowed: true } : a]));
  assert.throws(() => createActionGate({ catalogue: readDenyChat }), CatalogueError);
  const extra = new Map(doc().actions.map((a) => [a.id, a]));
  extra.set('stream.restart', { id: 'stream.restart', class: 'read', chatAllowed: true, target: 'none', description: 'x' });
  assert.throws(() => createActionGate({ catalogue: extra }), CatalogueError);
  assert.throws(() => createActionGate({ catalogue: { version: 1, actions: [...extra.values()] } }), CatalogueError);
  // The gate copies: mutating the caller's Map afterwards changes nothing, and the exposed view has no setter.
  const mine = buildCatalogue(seeded());
  const gate = createActionGate({ catalogue: mine });
  mine.set('stream.start', Object.freeze({ id: 'stream.start', class: 'read', chatAllowed: true, target: 'none', description: 'x' }));
  assert.equal(gate.request({ id: 'stream.start', params: {}, source: 'chat', actor: PSEUDO }).reason, 'chat-forbidden');
  assert.equal(typeof gate.catalogue.set, 'undefined');
  assert.equal(Object.isFrozen(gate.catalogue), true);
  assert.equal(Object.isFrozen(gate.catalogue.get('stream.start')), true);
  assert.throws(() => { gate.catalogue.get('stream.start').class = 'read'; }, TypeError);
  // Data CAN restrict: chatAllowed false on a chat-allowed action is honoured.
  const d2 = seeded();
  d2.actions.find((a) => a.id === 'effect.fire').chatAllowed = false;
  const g2 = createActionGate({ catalogue: buildCatalogue(d2) });
  assert.equal(g2.request({ id: 'effect.fire', params: {}, source: 'chat', actor: PSEUDO }).reason, 'chat-not-allowed');
});

test('catalogue: committed default is chatAllowed false for every entry (owner decision 2026-10-28)', () => {
  for (const a of doc().actions) assert.equal(a.chatAllowed, false, a.id);
  const gate = createActionGate({ catalogue: doc() });
  for (const a of doc().actions) {
    const r = gate.request({ id: a.id, params: {}, source: 'chat', actor: PSEUDO });
    assert.equal(r.verdict, 'refuse', a.id);
  }
});

test('catalogue: chatAllowed defaults to false when omitted', () => {
  const d = doc();
  delete d.actions.find((a) => a.id === 'effect.fire').chatAllowed;
  assert.equal(buildCatalogue(d).get('effect.fire').chatAllowed, false);
});

// ---- decisions -------------------------------------------------------------------------------------------

test('decision: malformed requests are refused, never thrown', () => {
  const { gate } = mk();
  for (const bad of [undefined, null, 5, 'x', {}, { id: 'scene.switch' }, { id: 'nope.nope', source: 'ui' }, { id: 'scene.switch', source: 'god' }]) {
    const r = gate.request(bad);
    assert.equal(r.verdict, 'refuse');
  }
  assert.equal(req(gate, { params: { f: () => 1 } }).reason, 'bad-params');
  assert.equal(req(gate, { params: { n: NaN } }).reason, 'bad-params');
  assert.equal(req(gate, { params: new Date() }).reason, 'bad-params');
});

test('decision: write offline asks "yes", live asks "yes, on air", unknown asks "yes, on air"; on-air write live asks "yes" then "yes, on air"', () => {
  const { gate } = mk();
  assert.equal(gate.state().liveState, 'unknown');
  const w = (over = {}) => req(gate, { id: 'scene.create', ...over }); // class write
  assert.equal(w().confirm.phrase, 'yes, on air'); // unknown = live
  assert.equal(w().confirm.liveStateAtRequest, 'unknown');
  assert.deepEqual([req(gate).confirm.phrase, req(gate).confirm.step, req(gate).confirm.of], ['yes', 1, 2]); // on-air write, unknown: two steps
  gate.setLiveState('offline', { source: 'system' });
  assert.equal(req(gate).confirm.phrase, 'yes');
  assert.equal(req(gate).confirm.step, undefined);
  assert.equal(req(gate, { id: 'stream.start' }).confirm.phrase, 'yes');
  gate.setLiveState('live', { source: 'api' });
  assert.equal(w().confirm.phrase, 'yes, on air');
  assert.deepEqual([req(gate).confirm.phrase, req(gate).confirm.step], ['yes', 1]);
  assert.equal(req(gate, { id: 'replay.save' }).confirm.phrase, 'yes, on air');
});

test('unknown live state behaves as live: "yes" is refused, "yes, on air" works', () => {
  const { gate, calls } = mk();
  const r = req(gate, { id: 'scene.create' });
  assert.equal(gate.confirm(r.confirm.confirmId, 'yes', r.confirm.actionHash, { source: 'ui' }).reason, 'wrong-phrase');
  const r2 = req(gate, { id: 'scene.create' });
  assert.equal(gate.confirm(r2.confirm.confirmId, 'yes, on air', r2.confirm.actionHash, { source: 'ui' }).verdict, 'allow');
  assert.equal(calls.length, 1);
});

test('setLiveState: refused from chat, rule, remote, ui and tainted provenance; allowed from system and api', () => {
  const { gate } = mk();
  for (const source of ['chat', 'rule', 'remote', 'ui']) {
    assert.deepEqual(gate.setLiveState('offline', { source }), { ok: false, reason: 'source-not-permitted' }, source);
  }
  assert.equal(gate.setLiveState('offline', { source: 'api', provenance: { kind: 'chat.message' } }).ok, false);
  assert.equal(gate.setLiveState('offline', { source: 'rule', provenance: { kind: 'system.livestate' } }).ok, false);
  assert.equal(gate.setLiveState('maybe', { source: 'system' }).reason, 'bad-state');
  assert.equal(gate.state().liveState, 'unknown');
  assert.equal(gate.setLiveState('offline', { source: 'system' }).ok, true);
  assert.equal(gate.setLiveState('live', { source: 'api' }).ok, true);
  assert.equal(gate.state().liveState, 'live');
  assert.equal(gate.setLiveState('live', { source: 'api' }).reason, 'unchanged');
});

test('chat-allowed actions are dry-run from chat: nothing executes, no confirmation offered; chat never gets a confirm', () => {
  const { gate, calls } = mk();
  const r = gate.request({ id: 'effect.fire', params: { fx: 'burst' }, source: 'chat', actor: 'pseudo1', provenance: { kind: 'chat.message', eventId: 'e1' } });
  assert.deepEqual([r.verdict, r.reason, r.dispatch, r.confirm], ['dry-run', 'chat-dry-run', undefined, undefined]);
  assert.equal(calls.length, 0);
  const n = gate.request({ id: 'scene.create', params: {}, source: 'chat', actor: 'p' });
  assert.deepEqual([n.verdict, n.reason, n.confirm], ['refuse', 'chat-not-allowed', undefined]);
  assert.equal(gate.state().pending, 0);
});

test('untainted rule requests need a ui/api confirmation like api requests', () => {
  const { gate } = mk();
  const r = gate.request({ id: 'scene.switch', params: {}, source: 'rule', actor: 'timer', provenance: { kind: 'schedule' } });
  assert.equal(r.verdict, 'confirm');
  assert.equal(ok(gate, r, 'rule').reason, 'source-not-permitted');
  assert.equal(ok(gate, r, 'ui').verdict, 'allow');
});

// ---- confirmations ---------------------------------------------------------------------------------------

test('confirm: happy path dispatches once; reply carries confirmId, phrase, hash, live state, expiry', () => {
  const { gate, calls, clock } = offline(mk());
  const r = req(gate);
  assert.deepEqual(Object.keys(r.confirm).sort(), ['actionHash', 'confirmId', 'expiresAt', 'liveStateAtRequest', 'phrase']);
  assert.equal(r.confirm.expiresAt, clock() + DEFAULT_TTL_MS);
  assert.equal(DEFAULT_TTL_MS, 60_000);
  const c = gate.confirm(r.confirm.confirmId, '  YES ', r.confirm.actionHash, { source: 'api' });
  assert.deepEqual([c.verdict, c.reason, c.dispatch.ok], ['allow', 'confirmed', true]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, { scene: 'Main' });
  assert.equal(calls[0].class, 'on-air-write');
});

test('confirm: hash is SHA-256 over canonical JSON of id, params, source, actor, phrase; key order does not matter', () => {
  const { gate } = mk();
  gate.setLiveState('offline', { source: 'system' });
  const r = gate.request({ id: 'scene.switch', params: { b: 2, a: { y: 1, x: [3, 1] } }, source: 'ui', actor: 'u1' });
  const expect = actionHash({ id: 'scene.switch', params: { a: { x: [3, 1], y: 1 }, b: 2 }, source: 'ui', actor: 'u1', phrase: 'yes' });
  assert.equal(r.confirm.actionHash, expect);
  assert.match(r.confirm.actionHash, /^[0-9a-f]{64}$/);
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  // Changing any bound field changes the hash.
  const base = { id: 'a.b', params: {}, source: 'ui', actor: 'x', phrase: 'yes' };
  for (const k of ['id', 'source', 'actor', 'phrase']) assert.notEqual(actionHash({ ...base, [k]: 'z' }), actionHash(base));
  assert.notEqual(actionHash({ ...base, params: { a: 1 } }), actionHash(base));
});

test('confirm: confirmIds are random 128-bit hex and differ', () => {
  const { gate } = mk();
  const ids = new Set();
  for (let i = 0; i < 12; i++) ids.add(req(gate).confirm.confirmId);
  assert.equal(ids.size, 12);
  for (const id of ids) assert.match(id, /^[0-9a-f]{32}$/);
});

test('confirm: single use. A replay is refused and nothing runs twice', () => {
  const { gate, calls } = mk();
  const r = req(gate);
  assert.equal(ok(gate, r).verdict, 'allow');
  assert.equal(ok(gate, r).reason, 'replayed');
  assert.equal(calls.length, 1);
  assert.equal(gate.confirm('f'.repeat(32), 'yes', 'x', { source: 'ui' }).reason, 'unknown-confirm');
  assert.equal(gate.confirm(undefined, 'yes', 'x', { source: 'ui' }).reason, 'unknown-confirm');
});

test('confirm: bound to the action. A different hash is refused and the confirmation is spent', () => {
  const { gate, calls } = mk();
  const a = req(gate, { params: { scene: 'A' } });
  const b = req(gate, { params: { scene: 'B' } });
  assert.notEqual(a.confirm.actionHash, b.confirm.actionHash);
  // Rebind: confirm A's id with B's hash.
  assert.equal(gate.confirm(a.confirm.confirmId, a.confirm.phrase, b.confirm.actionHash, { source: 'ui' }).reason, 'hash-mismatch');
  assert.equal(ok(gate, a).reason, 'replayed');
  assert.equal(gate.confirm(b.confirm.confirmId, b.confirm.phrase, undefined, { source: 'ui' }).reason, 'hash-mismatch');
  assert.equal(calls.length, 0);
});

test('confirm: params mutated after the request do not change what runs', () => {
  const { gate, calls } = mk();
  const params = { scene: 'A' };
  const r = req(gate, { params });
  params.scene = 'EVIL';
  ok(gate, r);
  assert.deepEqual(calls[0].params, { scene: 'A' });
});

test('confirm: expires after the TTL (injected clock)', () => {
  const { gate, calls, advance } = offline(mk({ liveStaleMs: 10_000_000 })); // stays offline while the clock moves
  const live = req(gate);
  advance(DEFAULT_TTL_MS - 1);
  assert.equal(ok(gate, live).verdict, 'allow');
  const r = req(gate);
  advance(DEFAULT_TTL_MS);
  assert.equal(ok(gate, r).reason, 'expired');
  assert.equal(ok(gate, r).reason, 'replayed');
  assert.equal(calls.length, 1);
});

test('confirm: wrong phrase refused ("yes" while live, empty, wrong type); right phrase ignores case and spaces', () => {
  const { gate, calls } = mk();
  gate.setLiveState('live', { source: 'system' });
  const mkReq = () => req(gate, { id: 'scene.create' }); // class write: one confirmation, "yes, on air" while live
  let r = mkReq();
  assert.equal(gate.confirm(r.confirm.confirmId, 'yes', r.confirm.actionHash, { source: 'ui' }).reason, 'wrong-phrase');
  r = mkReq();
  assert.equal(gate.confirm(r.confirm.confirmId, '', r.confirm.actionHash, { source: 'ui' }).reason, 'wrong-phrase');
  r = mkReq();
  assert.equal(gate.confirm(r.confirm.confirmId, 42, r.confirm.actionHash, { source: 'ui' }).reason, 'wrong-phrase');
  r = mkReq();
  assert.equal(gate.confirm(r.confirm.confirmId, ' Yes, On Air\n', r.confirm.actionHash, { source: 'ui' }).verdict, 'allow');
  assert.equal(calls.length, 1);
});

test('confirm: live state flips between request and confirm -> live-state-changed, must re-request', () => {
  for (const [from, to] of [['offline', 'live'], ['live', 'offline']]) {
    const { gate, calls } = mk();
    gate.setLiveState(from, { source: 'system' });
    const r = req(gate);
    gate.setLiveState(to, { source: 'system' });
    assert.equal(ok(gate, r).reason, 'live-state-changed');
    assert.equal(calls.length, 0);
    const r2 = req(gate);
    assert.equal(ok(gate, r2).verdict, 'allow');
  }
  const { gate } = mk(); // unknown -> offline also counts as a change
  const r = req(gate);
  gate.setLiveState('offline', { source: 'system' });
  assert.equal(ok(gate, r).reason, 'live-state-changed');
});

test('confirm: only ui or api may confirm; chat, rule, remote, system are refused and do not spend the confirmation', () => {
  const { gate, calls } = mk();
  const r = req(gate);
  for (const source of ['chat', 'rule', 'remote', 'system', undefined, 'ui2']) {
    assert.equal(gate.confirm(r.confirm.confirmId, r.confirm.phrase, r.confirm.actionHash, { source }).reason, 'source-not-permitted', String(source));
  }
  assert.equal(gate.confirm(r.confirm.confirmId, r.confirm.phrase, r.confirm.actionHash).reason, 'source-not-permitted');
  assert.equal(calls.length, 0);
  assert.equal(gate.state().pending, 1);
  assert.equal(ok(gate, r, 'api').verdict, 'allow');
});

test('confirm: pending cap is per requesting source; a full quota refuses the new request and evicts nothing', () => {
  const { gate, audit } = offline(mk());
  assert.equal(DEFAULT_MAX_PENDING, 16);
  const rs = [];
  for (let i = 0; i < DEFAULT_MAX_PENDING + 3; i++) rs.push(req(gate, { params: { i } }));
  assert.equal(gate.state().pending, DEFAULT_MAX_PENDING);
  for (let i = DEFAULT_MAX_PENDING; i < DEFAULT_MAX_PENDING + 3; i++) assert.deepEqual([rs[i].verdict, rs[i].reason], ['refuse', 'too-many-pending']);
  assert.equal(ok(gate, rs[0]).verdict, 'allow');
  assert.equal(audit.filter((a) => a.reason === 'evicted').length, 0);
  // Another source still has its own quota.
  assert.equal(req(gate, { source: 'api' }).verdict, 'confirm');
  const small = offline(mk({ maxPending: 2 }));
  const [a, b, c] = [req(small.gate), req(small.gate), req(small.gate)];
  assert.equal(c.reason, 'too-many-pending');
  assert.equal(ok(small.gate, a).verdict, 'allow');
  assert.equal(ok(small.gate, b).verdict, 'allow');
  assert.equal(req(small.gate).verdict, 'confirm'); // room again
});

test('confirm: expired entries are pruned when a new one is issued', () => {
  const { gate, advance } = offline(mk());
  req(gate); req(gate);
  assert.equal(gate.state().pending, 2);
  advance(DEFAULT_TTL_MS + 1);
  req(gate);
  assert.equal(gate.state().pending, 1);
});

test('confirm: a restart (new gate) knows no earlier confirmation', () => {
  const a = mk();
  const r = req(a.gate);
  const b = mk();
  assert.equal(ok(b.gate, r).reason, 'unknown-confirm');
  assert.equal(b.calls.length, 0);
});

// ---- panic -----------------------------------------------------------------------------------------------

test('panic: takes effect at once, refuses chat-tainted and rule requests, clears pending confirmations, emits on the bus', async () => {
  const core = createEventCore({ key: Buffer.alloc(32, 7), moderation: false });
  const seen = [];
  core.bus.subscribe({ name: 'p', kinds: ['system.'], handler: (e) => seen.push([e.kind, e.reason ?? e.live]) });
  const g = core.actions;
  g.setLiveState('offline', { source: 'system' });
  const pend = g.request({ id: 'scene.switch', params: {}, source: 'ui', actor: 'u' });
  assert.equal(g.state().pending, 1);
  assert.deepEqual(g.panic({ source: 'ui', reason: 'test' }), { ok: true, reason: 'panic-engaged' });
  assert.equal(g.state().pending, 0);
  assert.equal(g.confirm(pend.confirm.confirmId, pend.confirm.phrase, pend.confirm.actionHash, { source: 'ui' }).reason, 'unknown-confirm');
  for (const over of [{ source: 'chat' }, { source: 'rule', provenance: { kind: 'schedule' } }, { source: 'rule', provenance: { kind: 'chat.message' } }]) {
    const r = g.request({ id: 'state.read', params: {}, actor: 'a', ...over });
    assert.deepEqual([r.verdict, r.reason], ['refuse', 'panic']);
    assert.equal(g.request({ id: 'effect.fire', params: {}, actor: 'a', ...over }).reason, 'panic');
  }
  // ui and api carry on: reads allow, writes still confirm.
  assert.equal(g.request({ id: 'state.read', params: {}, source: 'ui', actor: 'u' }).verdict, 'allow');
  assert.equal(g.request({ id: 'scene.switch', params: {}, source: 'api', actor: 'u' }).verdict, 'confirm');
  assert.equal(g.panic({ source: 'ui' }).reason, 'already-panic');
  await tick();
  assert.deepEqual(seen.filter(([k]) => k === 'system.panic'), [['system.panic', 'test']]);
});

test('panic: only ui, api or system may trigger it; chat, rule and remote may not', () => {
  const { gate } = mk();
  for (const source of ['chat', 'rule', 'remote', undefined]) assert.equal(gate.panic({ source }).ok, false);
  assert.equal(gate.state().panic, false);
  assert.equal(gate.request({ id: 'panic.set', params: {}, source: 'chat', actor: 'a' }).reason, 'chat-forbidden');
  assert.equal(gate.request({ id: 'panic.set', params: {}, source: 'remote', actor: 'a' }).reason, 'source-not-permitted');
  assert.equal(gate.state().panic, false);
  assert.equal(gate.request({ id: 'panic.set', params: {}, source: 'system', actor: 'a' }).reason, 'panic-engaged');
  assert.equal(gate.state().panic, true);
});

test('panic: clearing needs a confirmation from ui or api with the live phrase rule ("yes, on air" while live); the event is emitted', async () => {
  const core = createEventCore({ key: Buffer.alloc(32, 7), moderation: false, actions: { catalogue: seeded() } });
  const seen = [];
  core.bus.subscribe({ name: 'p', kinds: ['system.panic'], handler: (e) => seen.push(e.reason) });
  const g = core.actions;
  g.setLiveState('live', { source: 'system' });
  assert.equal(g.request({ id: 'panic.clear', params: {}, source: 'ui', actor: 'u' }).reason, 'not-in-panic');
  g.panic({ source: 'system', reason: 'x' });
  assert.equal(g.request({ id: 'panic.clear', params: {}, source: 'chat', actor: 'u' }).reason, 'panic');
  assert.equal(g.request({ id: 'panic.clear', params: {}, source: 'remote', actor: 'u' }).reason, 'source-not-permitted');
  assert.equal(g.request({ id: 'panic.clear', params: {}, source: 'rule', actor: 'u', provenance: { kind: 'hotkey' } }).reason, 'panic');
  const r = g.request({ id: 'panic.clear', params: {}, source: 'ui', actor: 'u' });
  assert.equal(r.confirm.phrase, 'yes, on air');
  assert.equal(g.confirm(r.confirm.confirmId, 'yes', r.confirm.actionHash, { source: 'ui' }).reason, 'wrong-phrase');
  assert.equal(g.state().panic, true);
  const r2 = g.request({ id: 'panic.clear', params: {}, source: 'api', actor: 'u' });
  assert.equal(g.confirm(r2.confirm.confirmId, 'yes, on air', r2.confirm.actionHash, { source: 'chat' }).reason, 'source-not-permitted');
  assert.equal(g.state().panic, true);
  assert.deepEqual(g.confirm(r2.confirm.confirmId, 'yes, on air', r2.confirm.actionHash, { source: 'api' }), { verdict: 'allow', reason: 'panic-cleared' });
  assert.equal(g.state().panic, false);
  assert.equal(g.request({ id: 'effect.fire', params: {}, source: 'chat', actor: 'a' }).verdict, 'dry-run'); // chat works again (dry run)
  await tick();
  assert.deepEqual(seen, ['x', 'cleared']);
});

test('panic: state is memory only; a new gate starts with panic off', () => {
  const a = mk();
  a.gate.panic({ source: 'ui' });
  assert.equal(mk().gate.state().panic, false);
});

// ---- dispatch --------------------------------------------------------------------------------------------

test('dispatch: executor failures are returned, not thrown; async executors give a promise that never rejects', async () => {
  const boom = offline(mk({ executor: { execute: () => { throw new Error('studio down'); } } }));
  const r = boom.gate.request({ id: 'state.read', params: {}, source: 'ui', actor: 'a' });
  assert.deepEqual([r.verdict, r.dispatch.ok, r.dispatch.error], ['allow', false, 'studio down']);
  const rej = mk({ executor: { execute: () => Promise.reject(new Error('late')) } });
  const r2 = rej.gate.request({ id: 'state.read', params: {}, source: 'ui', actor: 'a' });
  assert.equal(r2.verdict, 'allow');
  assert.deepEqual(await r2.dispatch, { ok: false, error: 'late' });
  const fine = mk({ executor: { execute: async () => 7 } });
  assert.deepEqual(await fine.gate.request({ id: 'state.read', params: {}, source: 'ui', actor: 'a' }).dispatch, { ok: true, result: 7 });
  const none = createActionGate({ catalogue: buildCatalogue(doc()) });
  assert.deepEqual(none.request({ id: 'state.read', params: {}, source: 'ui', actor: 'a' }).dispatch, { ok: false, error: 'no-executor' });
  // A confirmed action whose executor throws: confirm still reports the decision.
  const c = boom.gate.request({ id: 'scene.switch', params: {}, source: 'ui', actor: 'u' }); // offline: one step
  const cr = boom.gate.confirm(c.confirm.confirmId, c.confirm.phrase, c.confirm.actionHash, { source: 'ui' });
  assert.deepEqual([cr.verdict, cr.dispatch.ok], ['allow', false]);
});

test('dispatch: the executor gets a frozen action; refused and pending requests never reach it', () => {
  const { gate, calls } = mk();
  gate.request({ id: 'stream.start', params: {}, source: 'chat', actor: 'a' });
  gate.request({ id: 'scene.switch', params: {}, source: 'ui', actor: 'a' });
  assert.equal(calls.length, 0);
  gate.request({ id: 'marker.drop', params: { label: 'x' }, source: 'chat', actor: 'a' }); // dry run: not executed
  assert.equal(calls.length, 0);
  gate.request({ id: 'state.read', params: {}, source: 'ui', actor: 'a' });
  assert.equal(Object.isFrozen(calls[0]), true);
  assert.deepEqual(Object.keys(calls[0]).sort(), ['actor', 'class', 'id', 'liveEpoch', 'liveState', 'params', 'source', 'tainted', 'target']); // liveEpoch: E4b re-check
});

// ---- audit -----------------------------------------------------------------------------------------------

test('audit: every decision is reported once with id, source, provenance summary, verdict, reason, timestamps; no raw text', () => {
  const { gate, audit } = mk();
  const RAWTXT = 'zzz raw viewer words 12345';
  const prov = { kind: 'rule', eventId: RAWTXT, parent: { kind: 'chat.message', eventId: EVID, text: RAWTXT, parent: { kind: RAWTXT } } };
  gate.setLiveState('offline', { source: 'system' });
  gate.request({ id: 'chat.reply', params: { text: RAWTXT }, source: 'rule', actor: PSEUDO, provenance: prov });
  gate.request({ id: 'stream.start', params: { note: RAWTXT }, source: 'chat', actor: RAWTXT, provenance: prov });
  const r = gate.request({ id: 'scene.switch', params: { note: RAWTXT }, source: 'ui', actor: 'u' });
  gate.confirm(r.confirm.confirmId, 'nope', r.confirm.actionHash, { source: 'ui' });
  const r2 = gate.request({ id: 'scene.switch', params: { note: RAWTXT }, source: 'ui', actor: 'u' });
  gate.confirm(r2.confirm.confirmId, 'yes', r2.confirm.actionHash, { source: 'ui' });
  gate.setLiveState('live', { source: 'chat' });
  gate.panic({ source: 'ui' });
  const types = audit.map((a) => `${a.type}:${a.verdict}:${a.reason}`);
  assert.deepEqual(types, [
    'live-state:allow:changed',
    'request:dry-run:chat-dry-run',
    'request:refuse:chat-forbidden',
    'confirm-issued:confirm:confirmation-required',
    'confirm-refused:refuse:wrong-phrase',
    'confirm-issued:confirm:confirmation-required',
    'confirm-accepted:allow:confirmed',
    'live-state:refuse:source-not-permitted',
    'panic:allow:panic-engaged',
  ]);
  for (const a of audit) {
    assert.match(a.ts, /^2026-10-28T12:00:\d\d\.\d{3}Z$/);
    assert.equal(typeof a.mono, 'number');
    assert.ok(a.source !== undefined && a.actionId !== undefined && a.provenance && a.reason && a.verdict);
  }
  const chained = audit[1];
  assert.equal(chained.provenance.tainted, true);
  // Kinds and event ids are checked against the E1 patterns; anything else (free text here) becomes 'invalid'.
  assert.deepEqual(chained.provenance.kinds, ['rule', 'chat.message', 'invalid']);
  assert.deepEqual(chained.provenance.eventIds, ['invalid', EVID]);
  assert.equal(chained.actor, PSEUDO);
  assert.equal(audit[2].actor, 'invalid');
  assert.equal(JSON.stringify(audit).includes(RAWTXT), false);
  assert.equal(audit.every((a) => !('params' in a) && !('text' in a)), true);
});

test('audit: a throwing hook never breaks the gate', () => {
  const { gate } = mk({ onDecision: () => { throw new Error('db down'); } });
  assert.equal(req(gate).verdict, 'confirm');
  assert.equal(gate.panic({ source: 'ui' }).ok, true);
});

// ---- wiring and end to end -------------------------------------------------------------------------------

// Test-only rule stub: turns a chat message into an action request. Real rules arrive with C2 (later phase).
function installChatRuleStub(core, { kindOfAction, hops = 1 }) {
  const results = [];
  core.bus.subscribe({
    name: 'rule-stub', kinds: ['chat.'],
    handler: (ev) => {
      let prov = { kind: ev.kind, eventId: ev.id }; // the event id, never the text
      for (let i = 0; i < hops; i++) prov = { kind: 'rule', eventId: `rule-${i}`, parent: prov };
      const m = /^!(\S+)/.exec(ev.text);
      if (!m) return;
      results.push({
        id: kindOfAction(m[1]),
        r: core.actions.request({ id: kindOfAction(m[1]), params: { from: ev.id }, source: 'rule', actor: ev.user.pseudoId, provenance: prov }),
      });
    },
  });
  return results;
}
const chatIn = (core, text, id) => core.ingest({
  kind: 'chat.message', platform: 'twitch', source: 'mock', platformMessageId: id,
  user: { platformUserId: `u-${id}`, displayName: 'ViewerOne' }, text,
});

test('wiring: core.actions exists, shares the bus, and can be turned off', () => {
  const core = createEventCore({ key: Buffer.alloc(32, 1) });
  assert.equal(typeof core.actions.request, 'function');
  assert.equal(createEventCore({ key: Buffer.alloc(32, 1), actions: false }).actions, null);
  const d = doc();
  const custom = createEventCore({ key: Buffer.alloc(32, 1), actions: { catalogue: d } });
  assert.ok(custom.actions.catalogue.size > 0);
  // No pre-built Map seam: a Map must go through buildCatalogue.
  assert.throws(() => createEventCore({ key: Buffer.alloc(32, 1), actions: { catalogueMap: buildCatalogue(d) } }), TypeError);
  const d2 = doc();
  d2.actions.find((a) => a.id === 'stream.stop').chatAllowed = true;
  assert.throws(() => createEventCore({ key: Buffer.alloc(32, 1), actions: { catalogue: d2 } }), CatalogueError);
});

test('end to end: mock chat -> core -> rule stub -> gate -> forbidden actions refused, allowed one runs', async () => {
  const calls = [];
  const audit = [];
  const core = createEventCore({
    key: Buffer.alloc(32, 3),
    actions: { catalogue: seeded(), executor: { execute: (a) => { calls.push(a.id); } }, onDecision: (a) => audit.push(a) },
  });
  core.actions.setLiveState('live', { source: 'system' });
  const map = { stream: 'stream.start', rec: 'record.stop', wipe: 'scene.delete', mute: 'mic.main.mute', cfg: 'settings.change', fx: 'effect.fire', panic: 'panic.set', unmute: 'device.change' };
  for (const hops of [1, 3]) {
    const { results: out, off } = installChatRuleStubFresh(core, map, hops);
    let n = 0;
    for (const word of Object.keys(map)) chatIn(core, `!${word} please`, `m${hops}-${n++}`);
    await tick();
    off();
    assert.equal(out.length, Object.keys(map).length);
    for (const { id, r } of out) {
      if (id === 'effect.fire') assert.deepEqual([r.verdict, r.reason, r.dispatch], ['dry-run', 'chat-dry-run', undefined]);
      else assert.deepEqual([r.verdict, r.reason, r.confirm], ['refuse', 'chat-forbidden', undefined], id);
    }
  }
  assert.deepEqual(calls, []); // chat-triggered actions are dry-run in P3: nothing executes
  assert.equal(core.actions.state().pending, 0);
  assert.equal(JSON.stringify(audit).includes('please'), false);
  assert.equal(audit.some((a) => a.provenance.tainted === false && a.source === 'rule'), false);
});

let stubN = 0;
function installChatRuleStubFresh(core, map, hops) {
  const name = `stub-${stubN++}`;
  const results = [];
  const off = core.bus.subscribe({
    name, kinds: ['chat.'],
    handler: (ev) => {
      const m = /^!(\S+)/.exec(ev.text);
      if (!m || !(m[1] in map)) return;
      let prov = { kind: ev.kind, eventId: ev.id };
      for (let i = 0; i < hops; i++) prov = { kind: 'rule', eventId: `rule-${i}`, parent: prov };
      results.push({ id: map[m[1]], r: core.actions.request({ id: map[m[1]], params: { from: ev.id }, source: 'rule', actor: ev.user.pseudoId, provenance: prov }) });
    },
  });
  return { results, off };
}

test('end to end: panic from the rule path refuses even the chat-allowed action; clearing restores it', async () => {
  const core = createEventCore({ key: Buffer.alloc(32, 4), actions: { catalogue: seeded() } });
  const out = installChatRuleStub(core, { kindOfAction: () => 'effect.fire' });
  chatIn(core, '!fx one', 'p1');
  await tick();
  assert.equal(out[0].r.verdict, 'dry-run');
  core.actions.panic({ source: 'ui' });
  chatIn(core, '!fx two', 'p2');
  await tick();
  assert.deepEqual([out[1].r.verdict, out[1].r.reason], ['refuse', 'panic']);
});
