// SPDX-License-Identifier: GPL-3.0-or-later
// services/event-core/livelock: attacks from the 2026-10-28 security review (E4 findings 1, 2, 4, 6, 7, 8, 10,
// 11, 12). Each test is the attack itself. All nine failed against the gate before the review fixes (see
// docs/evidence/2026-10-28-p3-e4-livelock.md, "Review fixes"). Tests for findings 5, 9, 15, 16, 17 and 18
// were added after the fixes. All text is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCatalogue, createActionGate } from '../services/event-core/livelock/index.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const doc = () => JSON.parse(readFileSync(path.join(repo, 'data', 'actions', 'catalogue.json'), 'utf8'));
// A catalogue where the owner has turned chat on for scene.switch (the committed default is all false).
const chatOn = (...ids) => { const d = doc(); for (const a of d.actions) if (ids.includes(a.id)) { a.chatAllowed = true; a.chatMode = 'dry-run'; } return d; };
const PSEUDO = '0123456789abcdef0123456789abcdef';

// The approval click for a rule / remote / system write (D332: one click, no phrase, no second step).
const finish = (gate, r, source = 'ui') => gate.confirm(r.confirm.confirmId, undefined, r.confirm.actionHash, { source });
// An untainted automatic rule (a hotkey): its writes always wait for a ui/api click.
const RULE = Object.freeze({ source: 'rule', provenance: { kind: 'hotkey' } });

function mk(d = doc(), extra = {}) {
  let t = 1000;
  const calls = [];
  const gate = createActionGate({
    catalogue: buildCatalogue(d), executor: { execute: (a) => { calls.push(a.id); return 'ok'; } }, now: () => t, ...extra,
  });
  return { gate, calls, advance: (ms) => { t += ms; } };
}

test('review 1: a getter that changes the action id between checks cannot smuggle stream.start past the gate', () => {
  const { gate, calls } = mk(chatOn('scene.switch'));
  let n = 0;
  const action = { source: 'chat', actor: PSEUDO, params: {} };
  Object.defineProperty(action, 'id', { enumerable: true, get: () => (n++ === 0 ? 'stream.start' : 'scene.switch') });
  const r = gate.request(action);
  assert.equal(r.verdict, 'refuse');
  assert.deepEqual(calls, []);
  // Same trick on source: ui first, chat afterwards.
  let m = 0;
  const a2 = { id: 'scene.switch', actor: PSEUDO, params: {} };
  Object.defineProperty(a2, 'source', { enumerable: true, get: () => (m++ === 0 ? 'chat' : 'ui') });
  assert.equal(gate.request(a2).verdict, 'refuse');
  assert.deepEqual(calls, []);
});

test('review 2: mutating the catalogue the gate exposes cannot make stream.start a chat read', () => {
  const { gate, calls } = mk();
  try { gate.catalogue?.set?.('stream.start', { id: 'stream.start', class: 'read', chatAllowed: true, target: 'stream' }); } catch { /* frozen */ }
  try { gate.catalogue?.get?.('stream.start') && Object.assign(gate.catalogue.get('stream.start'), { class: 'read' }); } catch { /* frozen */ }
  const r = gate.request({ id: 'stream.start', params: {}, source: 'chat', actor: PSEUDO });
  assert.equal(r.verdict, 'refuse');
  assert.deepEqual(calls, []);
});

test('review 4: data cannot chat-allow new ids in a deny category', () => {
  const add = [
    ['stream.restart', 'stream'], ['record.pause', 'record'], ['settings.reset', 'settings'], ['device.add', 'device'],
    ['scene.remove', 'scene'], ['mic.main.toggle', 'audio'], ['output.rung.add', 'output'], ['layer.purge', 'layer'],
  ];
  for (const [id, target] of add) {
    const d = doc();
    d.actions.push({ id, class: 'on-air-write', chatAllowed: true, target, description: 'x' });
    assert.throws(() => buildCatalogue(d), /deny/, id);
  }
});

test('review 6: offline -> live -> offline between request and confirm is refused', () => {
  const { gate, calls } = mk();
  gate.setLiveState('offline', { source: 'system' });
  const r = gate.request({ id: 'scene.switch', params: {}, ...RULE, actor: 'u1' });
  gate.setLiveState('live', { source: 'system' });
  gate.setLiveState('offline', { source: 'system' });
  const c = finish(gate, r);
  assert.deepEqual([c.verdict, c.reason], ['refuse', 'live-state-changed']);
  assert.deepEqual(calls, []);
});

test('review 7: 40 requests from hotkey rules, remote, system or api cannot evict a pending approval', () => {
  for (const flood of [
    { source: 'rule', provenance: { kind: 'hotkey' } }, { source: 'rule', provenance: { kind: 'schedule' } },
    { source: 'remote' }, { source: 'system' }, { source: 'api' },
  ]) {
    const { gate, calls } = mk();
    const mine = gate.request({ id: 'layer.create', params: { s: 'mine' }, source: 'system', actor: 'u1' });
    for (let i = 0; i < 40; i++) gate.request({ id: 'scene.switch', params: { i }, actor: 'x', ...flood });
    const c = finish(gate, mine);
    assert.equal(c.verdict, 'allow', flood.source);
    // An api flood runs its own writes (the user's surface, D332); nothing else ran besides the approved one.
    assert.deepEqual(calls.filter((id) => id !== 'scene.switch'), ['layer.create']);
    assert.equal(calls.filter((id) => id === 'scene.switch').length, flood.source === 'api' ? 40 : 0);
  }
});

test('review 8 (D332): clearing panic while live is one ui/api click; chat, rule, remote and system cannot clear it', () => {
  const { gate } = mk();
  gate.setLiveState('live', { source: 'system' });
  gate.panic({ source: 'ui' });
  for (const over of [{ source: 'chat' }, RULE, { source: 'remote' }, { source: 'system' }, { source: 'ui', provenance: { kind: 'chat.message' } }]) {
    assert.equal(gate.request({ id: 'panic.clear', params: {}, actor: PSEUDO, ...over }).verdict, 'refuse', over.source);
    assert.equal(gate.state().panic, true);
  }
  assert.equal(gate.state().pending, 0);
  assert.deepEqual(gate.request({ id: 'panic.clear', params: {}, source: 'ui', actor: 'u1' }), { verdict: 'allow', reason: 'panic-cleared' });
  assert.equal(gate.state().panic, false);
});

test('review 10: ttlMs and maxPending must be finite positive integers', () => {
  const catalogue = buildCatalogue(doc());
  for (const bad of [NaN, Infinity, -1, 0, 1.5, '60', null]) {
    assert.throws(() => createActionGate({ catalogue, ttlMs: bad }), TypeError, `ttlMs ${bad}`);
    assert.throws(() => createActionGate({ catalogue, maxPending: bad }), TypeError, `maxPending ${bad}`);
  }
});

test('review 11: a read with chatAllowed false is refused to chat', () => {
  const { gate, calls } = mk(); // state.read is chatAllowed false
  const r = gate.request({ id: 'state.read', params: {}, source: 'chat', actor: PSEUDO });
  assert.equal(r.verdict, 'refuse');
  const r2 = gate.request({ id: 'health.read', params: {}, source: 'rule', actor: PSEUDO, provenance: { kind: 'chat.message' } });
  assert.equal(r2.verdict, 'refuse');
  assert.deepEqual(calls, []);
});

test('review 12: panic() with chat provenance is refused, as setLiveState is', () => {
  const { gate } = mk();
  for (const source of ['ui', 'api', 'system']) {
    const r = gate.panic({ source, provenance: { kind: 'chat.message' } });
    assert.equal(r.ok, false, source);
  }
  assert.equal(gate.state().panic, false);
});

test('review 5: a broken wall clock, monotonic clock or random source refuses with internal-error and is audited; nothing runs', () => {
  for (const [name, extra] of [
    ['NaN wall', { wall: () => NaN }],
    ['throwing now', { now: () => { throw new Error('clock'); } }],
    ['NaN now', { now: () => NaN }],
    ['throwing random', { random: () => { throw new Error('rng'); } }],
  ]) {
    const calls = [];
    const audit = [];
    const gate = createActionGate({
      catalogue: chatOn('effect.fire'), executor: { execute: (a) => { calls.push(a.id); } }, onDecision: (r) => audit.push(r), ...extra,
    });
    // D332: a ui write no longer draws a confirmId (no randomness), so the rule write is the one that needs the random
    // source; a ui write still hits the broken clocks through its audit row.
    for (const action of [
      { id: 'scene.switch', params: {}, ...RULE, actor: 'u1' },
      ...(name === 'throwing random' ? [] : [{ id: 'scene.switch', params: {}, source: 'ui', actor: 'u1' }, { id: 'effect.fire', params: {}, source: 'chat', actor: PSEUDO }, { id: 'state.read', params: {}, source: 'ui', actor: 'u1' }]),
    ]) {
      const r = gate.request(action);
      assert.deepEqual([r.verdict, r.reason], ['refuse', 'internal-error'], `${name} ${action.id}`);
    }
    assert.deepEqual(calls, [], name);
    assert.ok(audit.some((a) => a.reason === 'internal-error'), `${name}: audited`);
    if (name !== 'throwing random') {
      assert.equal(gate.setLiveState('offline', { source: 'system' }).reason, 'internal-error', name);
      assert.equal(gate.confirm('f'.repeat(32), 'yes', 'x', { source: 'ui' }).reason, 'internal-error', name);
    }
  }
  // A Proxy as ctx or provenance is refused, never thrown.
  const { gate } = mk();
  assert.equal(gate.setLiveState('offline', new Proxy({ source: 'system' }, {})).ok, false);
  assert.equal(gate.confirm('f'.repeat(32), 'yes', 'x', new Proxy({ source: 'ui' }, { get: () => { throw new Error('x'); } })).verdict, 'refuse');
  assert.equal(gate.panic(new Proxy({ source: 'ui' }, {})).ok, false);
  assert.equal(gate.setLiveState('offline', { source: 'system', provenance: new Proxy({ kind: 'system.livestate' }, {}) }).ok, false);
  assert.equal(gate.state().panic, false);
});

test('review 9: privileged sources may set unknown; the bus gets no livestate event for it', () => {
  const emitted = [];
  const gate = createActionGate({ catalogue: buildCatalogue(doc()), emit: (k, f) => emitted.push([k, f]) });
  assert.equal(gate.setLiveState('live', { source: 'system' }).ok, true);
  assert.equal(gate.setLiveState('unknown', { source: 'chat' }).ok, false);
  assert.equal(gate.setLiveState('unknown', { source: 'system' }).reason, 'changed');
  assert.equal(gate.state().liveState, 'unknown');
  assert.equal(gate.state().effectiveLive, true);
  assert.deepEqual(emitted, [['system.livestate', { live: true }]]);
  for (const bad of [NaN, Infinity, 0, -5, 1.5]) assert.throws(() => createActionGate({ catalogue: doc(), liveStaleMs: bad }), TypeError);
});

test('review 15: audit gets only E1-pattern kinds, event ids and actors; anything else is "invalid"', () => {
  const audit = [];
  const gate = createActionGate({ catalogue: doc(), onDecision: (r) => audit.push(r) });
  const TXT = 'hello chat words';
  gate.request({ id: 'scene.switch', params: {}, source: 'rule', actor: TXT, provenance: { kind: TXT, eventId: TXT, parent: { kind: 'chat.message', eventId: 'e000000000001-00000000-aaaaaaaa' } } });
  gate.request({ id: 'scene.switch', params: {}, source: 'ui', actor: 'Has Spaces' });
  assert.equal(JSON.stringify(audit).includes('hello'), false);
  assert.deepEqual(audit[0].provenance, { tainted: true, kinds: ['invalid', 'chat.message'], eventIds: ['invalid', 'e000000000001-00000000-aaaaaaaa'] });
  assert.equal(audit[0].actor, 'invalid');
  assert.equal(audit[1].actor, 'invalid');
});

test('review 16: __proto__, constructor or prototype keys anywhere in params, or params over 8 KB, are refused', () => {
  const { gate } = mk();
  for (const params of [
    JSON.parse('{"__proto__":{"a":1}}'), { a: JSON.parse('{"__proto__":1}') }, { constructor: 1 }, { a: [{ prototype: 1 }] },
    { s: 'x'.repeat(8200) },
  ]) {
    assert.equal(gate.request({ id: 'scene.switch', params, source: 'ui', actor: 'u1' }).reason, 'bad-params');
  }
  assert.equal(gate.request({ id: 'scene.switch', params: { s: 'x'.repeat(8000) }, ...RULE, actor: 'u1' }).verdict, 'confirm');
  assert.equal(gate.request({ id: 'scene.switch', params: { s: 'x'.repeat(8000) }, source: 'ui', actor: 'u1' }).reason, 'ui-direct');
});

test('review 17: after 256 used ids, the oldest used id reports unknown-confirm instead of replayed (still refused)', () => {
  const { gate, calls } = mk(doc(), { maxPending: 300 });
  const first = gate.request({ id: 'scene.switch', params: { n: -1 }, ...RULE, actor: 'u1' });
  const okc = (r) => finish(gate, r);
  assert.equal(okc(first).verdict, 'allow');
  assert.equal(okc(first).reason, 'replayed');
  for (let i = 0; i < 256; i++) okc(gate.request({ id: 'scene.switch', params: { n: i }, ...RULE, actor: 'u1' }));
  assert.deepEqual([okc(first).verdict, okc(first).reason], ['refuse', 'unknown-confirm']);
  assert.equal(calls.length, 257);
});

test('review 18: forSource fixes the source; a request body cannot override it', () => {
  const { gate, calls } = mk(chatOn('effect.fire'));
  assert.throws(() => gate.forSource('god'), TypeError);
  const chat = gate.forSource('chat');
  assert.equal(Object.isFrozen(chat), true);
  // A chat transport claiming to be ui still counts as chat.
  const r = chat.request({ id: 'scene.switch', params: {}, source: 'ui', actor: PSEUDO });
  assert.deepEqual([r.verdict, r.reason], ['refuse', 'chat-not-allowed']);
  assert.equal(chat.request({ id: 'stream.start', params: {}, source: 'ui', actor: PSEUDO }).reason, 'chat-forbidden');
  assert.equal(chat.request({ id: 'effect.fire', params: {}, source: 'ui', actor: PSEUDO }).verdict, 'dry-run'); // chat: decided and recorded, not run
  assert.equal(chat.setLiveState('offline', { source: 'system' }).ok, false);
  assert.equal(chat.panic({ source: 'system' }).ok, false);
  const ui = gate.forSource('ui');
  const rule = gate.forSource('rule');
  // A rule transport claiming to be ui still counts as a rule: its write waits for a click.
  const pend = rule.request({ id: 'scene.switch', params: {}, source: 'ui', actor: 'u1', provenance: { kind: 'hotkey' } });
  assert.equal(pend.verdict, 'confirm');
  assert.deepEqual(calls, []);
  assert.equal(chat.confirm(pend.confirm.confirmId, undefined, pend.confirm.actionHash).reason, 'source-not-permitted');
  const remote = gate.forSource('remote');
  assert.equal(remote.confirm(pend.confirm.confirmId, undefined, pend.confirm.actionHash).reason, 'source-not-permitted');
  assert.equal(rule.confirm(pend.confirm.confirmId, undefined, pend.confirm.actionHash).reason, 'source-not-permitted');
  assert.equal(finish(ui, pend).verdict, 'allow');
  assert.deepEqual(calls, ['scene.switch']);
  // The ui transport's own write runs on its click (D332).
  assert.equal(ui.request({ id: 'layer.create', params: {}, source: 'rule', actor: 'u1' }).reason, 'ui-direct');
  assert.deepEqual(calls, ['scene.switch', 'layer.create']);
});
