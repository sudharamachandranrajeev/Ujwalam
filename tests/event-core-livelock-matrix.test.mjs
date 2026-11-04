// SPDX-License-Identifier: GPL-3.0-or-later
// services/event-core/livelock: invariant matrix. Every catalogue action x every source scenario x every live
// state x panic on/off x two catalogue variants, plus hostile inputs, catalogue mutations, an epoch flip, cap
// abuse by each source, panic.clear while live and a stale live state.
//
// The assertions are written from the OWNER'S RULES (P3 E4 task, 2026-10-28), not from the gate's branch order:
//  R1 never from chat, whatever the data says: stream, record, outputs, deletion, settings, devices, main mic mute;
//  R2 a rule triggered by chat or an alert, through any chain, counts as chat; unknown/malformed provenance fails safe;
//  R3 writes need "yes" offline and "yes, on air" while live; unknown live state counts as live; an ON-AIR write
//     while live needs two confirmations in order, "yes" then "yes, on air" (user decision 2026-10-28, E4b);
//  R9 chat-triggered actions never execute in P3 (dry-run: decided and recorded only; chatMode "on" cannot load);
//  R4 confirmations are single use, bound, expire, accepted only from ui or api, refused if live state changed;
//  R5 chat is never offered a confirmation;
//  R6 live state is set only by privileged sources;
//  R7 panic stops chat-tainted and rule-sourced actions and clears pending confirmations; clearing needs a confirmation;
//  R8 data may only restrict, never widen.
// The categories in R1 and the taint of each scenario are restated here. No gate, catalogue or provenance
// helper is used to compute what is expected; only the catalogue DATA is read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCatalogue, createActionGate } from '../services/event-core/livelock/index.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const doc = () => JSON.parse(readFileSync(path.join(repo, 'data', 'actions', 'catalogue.json'), 'utf8'));
const PSEUDO = '0123456789abcdef0123456789abcdef';
const EVID = 'e000000000001-00000000-aaaaaaaa';

// R1, restated from the owner's words. Categories by first segment or target, main mic, destructive verbs, and
// the two panic ids (chat must not engage or clear panic).
const R1_AREAS = ['stream', 'record', 'recording', 'output', 'outputs', 'settings', 'setting', 'device', 'devices'];
const R1_VERBS = ['delete', 'remove', 'destroy', 'erase', 'purge', 'wipe', 'reset', 'clear'];
function neverFromChat(id, target) {
  const seg = id.split('.');
  if (id === 'panic.set' || id === 'panic.clear') return true;
  if (R1_AREAS.includes(seg[0]) || R1_AREAS.includes(target)) return true;
  if (seg.includes('mic') && seg.includes('main')) return true;
  return seg.some((s) => R1_VERBS.includes(s));
}

const CHAT = { kind: 'chat.message', eventId: EVID };
const CLEAN = { kind: 'system.livestate' };
const deep = (n, root) => { let p = root; for (let i = 0; i < n; i++) p = { kind: 'rule', parent: p }; return p; };
// tainted is stated by hand from R2: chat or alert anywhere in the chain, or anything we cannot read, is chat.
const SCENARIOS = [
  { name: 'ui', source: 'ui', tainted: false },
  { name: 'api', source: 'api', tainted: false },
  { name: 'remote', source: 'remote', tainted: false },
  { name: 'system', source: 'system', tainted: false },
  { name: 'chat', source: 'chat', tainted: true },
  { name: 'rule<-system', source: 'rule', prov: { kind: 'rule', parent: CLEAN }, tainted: false },
  { name: 'rule<-hotkey', source: 'rule', prov: { kind: 'hotkey' }, tainted: false },
  { name: 'rule<-schedule', source: 'rule', prov: { kind: 'schedule' }, tainted: false },
  { name: 'rule<-chat', source: 'rule', prov: CHAT, tainted: true },
  { name: 'rule<-alert', source: 'rule', prov: { kind: 'alert.sub' }, tainted: true },
  { name: 'rule<-rule<-chat', source: 'rule', prov: deep(2, CHAT), tainted: true },
  { name: 'rule<-rule<-rule<-alert', source: 'rule', prov: deep(3, { kind: 'alert.raid' }), tainted: true },
  { name: 'rule<-system<-chat', source: 'rule', prov: { kind: 'rule', parent: { kind: 'system.connected', parent: CHAT } }, tainted: true },
  { name: 'rule no provenance', source: 'rule', prov: undefined, tainted: true },
  { name: 'rule<-unknown kind', source: 'rule', prov: { kind: 'webhook.thing' }, tainted: true },
  { name: 'rule<-17 deep', source: 'rule', prov: deep(17, { kind: 'hotkey' }), tainted: true },
  { name: 'ui carrying chat', source: 'ui', prov: CHAT, tainted: true },
  { name: 'api carrying alert', source: 'api', prov: { kind: 'alert.bits' }, tainted: true },
  { name: 'system carrying malformed', source: 'system', prov: 'chat', tainted: true },
];
const LIVES = ['offline', 'live', 'unknown'];
const phraseFor = (live, cls) => (live === 'offline' ? 'yes' : cls === 'on-air-write' ? 'yes' : 'yes, on air'); // R3 (step 1 for an on-air write while live)
const WRITE = new Set(['write', 'on-air-write']);

// Variant B: every action the owner's R1 does not forbid is chat-allowed, to exercise the chat path (R8 says
// data may restrict; this is the most the data can open).
function variants() {
  const a = doc();
  const b = doc();
  for (const e of b.actions) { e.chatAllowed = !neverFromChat(e.id, e.target); e.chatMode = e.chatAllowed ? 'dry-run' : 'off'; }
  return [['committed', a], ['max-open', b]];
}

function checkCase(entry, sc, live, panicOn, gate, calls) {
  const before = gate.state();
  let r;
  assert.doesNotThrow(() => { r = gate.request({ id: entry.id, params: { n: 1 }, source: sc.source, actor: PSEUDO, provenance: sc.prov }); });
  const out = [];
  const bad = (m) => out.push(m);
  if (!['allow', 'confirm', 'refuse', 'dry-run'].includes(r.verdict) || typeof r.reason !== 'string') bad('verdict shape');
  // R1 + R2
  if (sc.tainted && neverFromChat(entry.id, entry.target) && r.verdict !== 'refuse') bad('R1: never-from-chat id not refused');
  // R5
  if (sc.tainted && r.verdict === 'confirm') bad('R5: chat offered a confirmation');
  // R8: a tainted allow needs explicit data permission
  if (sc.tainted && r.verdict === 'allow' && entry.chatAllowed !== true) bad('R8: tainted allow without chatAllowed');
  // R9: a chat-tainted request never executes: no allow, no dispatch; dry-run only where the data opened it and it is not a deny id
  if (sc.tainted && r.verdict === 'allow') bad('R9: tainted request allowed');
  if (r.verdict === 'dry-run' && (!sc.tainted || entry.chatAllowed !== true || entry.chatMode !== 'dry-run' || neverFromChat(entry.id, entry.target))) bad('R9: dry-run not permitted by data/rules');
  if (r.verdict === 'dry-run' && r.dispatch !== undefined) bad('R9: dry-run carries a dispatch');
  // R7
  if (panicOn && (sc.tainted || sc.source === 'rule') && r.verdict !== 'refuse') bad('R7: panic did not stop chat/rule');
  // R3: an untainted write is never run without a confirmation; the phrase follows live state
  if (!sc.tainted && WRITE.has(entry.class) && entry.id !== 'panic.set' && r.verdict === 'allow') bad('R3: write ran unconfirmed');
  if (r.verdict === 'confirm' && r.confirm?.phrase !== phraseFor(live, entry.class)) bad(`R3: phrase ${r.confirm?.phrase} for ${live}`);
  // R7: clearing panic is never immediate, only ui/api, only while in panic
  if (entry.id === 'panic.clear') {
    if (r.verdict === 'allow') bad('R7: panic cleared without confirmation');
    if (r.verdict === 'confirm' && (!['ui', 'api'].includes(sc.source) || !panicOn)) bad('R7: panic.clear confirm to wrong source');
    if (gate.state().panic !== before.panic) bad('R7: panic state changed by a request');
  }
  // panic.set takes effect only from ui, api or system, untainted
  if (entry.id === 'panic.set') {
    const may = !sc.tainted && ['ui', 'api', 'system'].includes(sc.source);
    if (!may && gate.state().panic !== before.panic) bad('panic engaged by a source that may not');
    if (r.verdict === 'allow' && !may) bad('panic.set allowed to a source that may not');
  }
  // Executor: runs exactly once for an allowed non-panic action, never otherwise, and runs what was asked.
  const expectRun = r.verdict === 'allow' && !entry.id.startsWith('panic.');
  if (calls.length !== (expectRun ? 1 : 0)) bad(`executor calls ${calls.length}`);
  if (calls.length === 1 && calls[0].id !== entry.id) bad('executor ran a different id');
  if (calls.length === 1 && sc.tainted && neverFromChat(calls[0].id, calls[0].target)) bad('R1: executor ran a forbidden id for chat');
  // Untainted reads are free (outside panic for rules).
  if (!sc.tainted && entry.class === 'read' && !(panicOn && sc.source === 'rule') && r.verdict !== 'allow') bad('read refused');
  return out;
}

test('matrix: every action x source x live state x panic x catalogue variant holds the owner rules', () => {
  let cases = 0;
  const failures = [];
  for (const [vname, d] of variants()) {
    for (const entry of d.actions) {
      for (const sc of SCENARIOS) {
        for (const live of LIVES) {
          for (const panicOn of [false, true]) {
            const calls = [];
            const gate = createActionGate({ catalogue: buildCatalogue(d), executor: { execute: (a) => { calls.push(a); return 'done'; } } });
            if (live !== 'unknown') assert.equal(gate.setLiveState(live, { source: 'system' }).ok, true);
            if (panicOn) assert.equal(gate.panic({ source: 'system' }).ok, true);
            cases++;
            for (const m of checkCase(entry, sc, live, panicOn, gate, calls)) failures.push(`${vname} / ${entry.id} / ${sc.name} / ${live} / panic=${panicOn}: ${m}`);
          }
        }
      }
    }
  }
  assert.deepEqual(failures.slice(0, 8), []);
  const n = doc().actions.length;
  assert.equal(cases, 2 * n * SCENARIOS.length * LIVES.length * 2);
  console.log(`matrix cases: ${cases} (2 catalogues x ${n} actions x ${SCENARIOS.length} sources x ${LIVES.length} live states x 2 panic)`);
});

test('matrix R4: a confirmation completes only from ui or api, once, with the phrase for the live state', () => {
  for (const entry of doc().actions.filter((e) => WRITE.has(e.class) && !e.id.startsWith('panic.'))) {
    for (const live of LIVES) {
      for (const confirmer of ['ui', 'api', 'remote', 'chat', 'rule', 'system']) {
        const calls = [];
        const gate = createActionGate({ catalogue: doc(), executor: { execute: (a) => { calls.push(a.id); } } });
        if (live !== 'unknown') gate.setLiveState(live, { source: 'api' });
        const r = gate.request({ id: entry.id, params: {}, source: 'ui', actor: 'u1' });
        assert.equal(r.verdict, 'confirm');
        // The other phrase never works (R3).
        const wrong = r.confirm.phrase === 'yes' ? 'yes, on air' : 'yes';
        const twoStep = live !== 'offline' && entry.class === 'on-air-write';
        assert.equal(r.confirm.step, twoStep ? 1 : undefined, `${entry.id}/${live} step`);
        let c = gate.confirm(r.confirm.confirmId, r.confirm.phrase, r.confirm.actionHash, { source: confirmer });
        if (twoStep && (confirmer === 'ui' || confirmer === 'api')) {
          // Step 1 runs nothing and returns step 2; only 'yes, on air' from the same source finishes it.
          assert.deepEqual([c.verdict, c.reason, c.confirm.step, c.confirm.phrase], ['confirm', 'second-confirmation-required', 2, 'yes, on air'], `${entry.id}/${live}/${confirmer}`);
          assert.deepEqual(calls, []);
          const other = confirmer === 'ui' ? 'api' : 'ui';
          assert.equal(gate.confirm(c.confirm.confirmId, c.confirm.phrase, c.confirm.actionHash, { source: other }).reason, 'step-source-mismatch');
          assert.deepEqual(calls, []);
          // That attempt spent step 2; start over for the real run.
          const rr = gate.request({ id: entry.id, params: {}, source: 'ui', actor: 'u1' });
          const c1 = gate.confirm(rr.confirm.confirmId, rr.confirm.phrase, rr.confirm.actionHash, { source: confirmer });
          c = gate.confirm(c1.confirm.confirmId, c1.confirm.phrase, c1.confirm.actionHash, { source: confirmer });
        }
        if (confirmer === 'ui' || confirmer === 'api') {
          assert.equal(c.verdict, 'allow', `${entry.id}/${live}/${confirmer}`);
          assert.deepEqual(calls, [entry.id]);
          assert.equal(gate.confirm(r.confirm.confirmId, r.confirm.phrase, r.confirm.actionHash, { source: confirmer }).verdict, 'refuse');
          assert.deepEqual(calls, [entry.id]);
        } else {
          assert.equal(c.verdict, 'refuse');
          assert.deepEqual(calls, []);
        }
        const r2 = gate.request({ id: entry.id, params: {}, source: 'api', actor: 'u1' });
        const wrong2 = r2.confirm.phrase === 'yes' ? 'yes, on air' : 'yes';
        assert.equal(gate.confirm(r2.confirm.confirmId, wrong2, r2.confirm.actionHash, { source: 'ui' }).verdict, 'refuse');
      }
    }
  }
});

test('matrix R1/R8: catalogue mutations cannot widen chat access (deny id as read, new ids in each category, chatAllowed widening)', () => {
  // A deny id marked read, with and without chatAllowed.
  for (const id of ['stream.start', 'record.stop', 'output.change', 'settings.change', 'device.change', 'mic.main.mute', 'scene.delete']) {
    for (const chatAllowed of [false, true]) {
      const d = doc();
      Object.assign(d.actions.find((a) => a.id === id), { class: 'read', chatAllowed });
      let gate;
      try { gate = createActionGate({ catalogue: d }); } catch { continue; } // rejected at load: fine
      const r = gate.request({ id, params: {}, source: 'chat', actor: PSEUDO });
      assert.equal(r.verdict, 'refuse', `${id} read chatAllowed=${chatAllowed}`);
    }
  }
  // New ids in each R1 category, each class, chatAllowed true: the load must fail.
  const NEW = [
    ['stream.restart', 'stream'], ['stream.key.rotate', 'none'], ['record.pause', 'record'], ['recording.split', 'none'],
    ['output.rung.add', 'output'], ['outputs.reset', 'none'], ['settings.reset', 'settings'], ['setting.write', 'none'],
    ['device.add', 'device'], ['devices.rescan', 'none'], ['mic.main.toggle', 'audio'], ['audio.mic.main.mute', 'audio'],
    ['scene.remove', 'scene'], ['layer.purge', 'layer'], ['preset.erase', 'preset'], ['chat.clear', 'chat'],
    ['effect.wipe', 'effect'], ['camera.destroy', 'camera'], ['marker.reset', 'marker'], ['x.anything', 'stream'],
  ];
  for (const [id, target] of NEW) {
    assert.equal(neverFromChat(id, target), true, `test restatement covers ${id}`);
    for (const cls of ['read', 'write', 'on-air-write']) {
      const d = doc();
      d.actions.push({ id, class: cls, chatAllowed: true, target, description: 'x' });
      assert.throws(() => buildCatalogue(d), `${id} ${cls}`);
      assert.throws(() => createActionGate({ catalogue: d }), `${id} ${cls} via gate`);
      assert.throws(() => createActionGate({ catalogue: new Map(d.actions.map((a) => [a.id, a])) }), `${id} ${cls} via Map`);
      // Without chatAllowed it may load, but chat is still refused.
      const d2 = doc();
      d2.actions.push({ id, class: cls, target, description: 'x' });
      const g = createActionGate({ catalogue: d2 });
      assert.equal(g.request({ id, params: {}, source: 'chat', actor: PSEUDO }).verdict, 'refuse', id);
    }
  }
  // Widening every entry to chatAllowed true is rejected as a whole.
  const w = doc();
  for (const a of w.actions) a.chatAllowed = true;
  assert.throws(() => createActionGate({ catalogue: w }));
});

test('matrix R2: hostile request objects never throw, never run a forbidden id and never offer chat a confirm', () => {
  const d = doc();
  for (const a of d.actions) { a.chatAllowed = !neverFromChat(a.id, a.target); a.chatMode = a.chatAllowed ? 'dry-run' : 'off'; } // most permissive legal data
  const flip = (k, first, then) => { let n = 0; const o = { id: 'scene.switch', source: 'chat', actor: PSEUDO, params: {} }; Object.defineProperty(o, k, { enumerable: true, get: () => (n++ === 0 ? first : then) }); return o; };
  const cyc = { kind: 'rule' }; cyc.parent = cyc;
  const throwing = { kind: 'rule' }; Object.defineProperty(throwing, 'parent', { enumerable: true, get: () => { throw new Error('x'); } });
  const revoc = Proxy.revocable({}, {}); revoc.revoke();
  const big = { s: 'x'.repeat(9000) };
  const HOSTILE = [
    ['getter id', flip('id', 'stream.start', 'scene.switch'), true],
    ['getter id reverse', flip('id', 'scene.switch', 'stream.start'), true],
    ['getter source', flip('source', 'chat', 'ui'), true],
    ['getter provenance', (() => { const o = { id: 'scene.switch', source: 'rule', actor: PSEUDO }; Object.defineProperty(o, 'provenance', { enumerable: true, get: () => ({ kind: 'hotkey' }) }); return o; })(), true],
    ['proxy action', new Proxy({ id: 'stream.start', source: 'ui', actor: 'u1' }, {}), false],
    ['revoked proxy action', revoc.proxy, false],
    ['proxy provenance', { id: 'stream.start', source: 'rule', actor: PSEUDO, provenance: new Proxy({ kind: 'hotkey' }, {}) }, true],
    ['throwing provenance', { id: 'stream.start', source: 'rule', actor: PSEUDO, provenance: throwing }, true],
    ['cycle provenance', { id: 'stream.start', source: 'rule', actor: PSEUDO, provenance: cyc }, true],
    ['depth 17 from hotkey', { id: 'stream.start', source: 'rule', actor: PSEUDO, provenance: deep(17, { kind: 'hotkey' }) }, true],
    ['array action', ['stream.start', 'ui'], false],
    ['array provenance', { id: 'stream.start', source: 'rule', actor: PSEUDO, provenance: [{ kind: 'hotkey' }] }, true],
    ['array params', { id: 'stream.start', source: 'chat', actor: PSEUDO, params: [1, 2] }, true],
    ['__proto__ params', { id: 'scene.switch', source: 'ui', actor: 'u1', params: JSON.parse('{"__proto__":{"x":1}}') }, false],
    ['constructor params', { id: 'scene.switch', source: 'ui', actor: 'u1', params: { a: { constructor: 1 } } }, false],
    ['prototype params', { id: 'scene.switch', source: 'ui', actor: 'u1', params: { b: [{ prototype: {} }] } }, false],
    ['params over 8 KB', { id: 'scene.switch', source: 'ui', actor: 'u1', params: big }, false],
    ['params getter', { id: 'scene.switch', source: 'ui', actor: 'u1', params: Object.defineProperty({}, 'x', { enumerable: true, get: () => 1 }) }, false],
    ['inherited source', Object.assign(Object.create({ source: 'ui' }), { id: 'stream.start', actor: 'u1' }), false],
    ['class instance', new (class A { constructor() { this.id = 'stream.start'; this.source = 'ui'; } })(), false],
  ];
  for (const [name, action, taintedOrBad] of HOSTILE) {
    for (const panicOn of [false, true]) {
      const calls = [];
      const gate = createActionGate({ catalogue: d, executor: { execute: (a) => { calls.push(a); } } });
      gate.setLiveState('offline', { source: 'system' });
      if (panicOn) gate.panic({ source: 'system' });
      let r;
      assert.doesNotThrow(() => { r = gate.request(action); }, name);
      assert.ok(['refuse', 'confirm', 'allow', 'dry-run'].includes(r.verdict), name);
      assert.equal(calls.some((a) => neverFromChat(a.id, a.target)), false, `${name}: forbidden id ran`);
      if (taintedOrBad) assert.notEqual(r.verdict, 'confirm', `${name}: confirm offered`);
      if (name.includes('params') || name.includes('proxy action') || name.includes('array action') || name.includes('inherited') || name.includes('class')) {
        assert.equal(r.verdict, 'refuse', `${name}: should refuse`);
      }
    }
  }
});

test('matrix R4: offline -> live -> offline (epoch flip) between request and confirm is refused; so is live -> unknown -> live', () => {
  for (const path of [['offline', 'live', 'offline'], ['live', 'unknown', 'live'], ['live', 'offline', 'live']]) {
    const calls = [];
    const gate = createActionGate({ catalogue: doc(), executor: { execute: (a) => { calls.push(a.id); } } });
    gate.setLiveState(path[0], { source: 'system' });
    const r = gate.request({ id: 'scene.switch', params: {}, source: 'ui', actor: 'u1' });
    gate.setLiveState(path[1], { source: 'system' });
    gate.setLiveState(path[2], { source: 'api' });
    assert.equal(gate.confirm(r.confirm.confirmId, r.confirm.phrase, r.confirm.actionHash, { source: 'ui' }).verdict, 'refuse', path.join('>'));
    assert.deepEqual(calls, []);
  }
});

test('matrix R4/E4b: epoch flip BETWEEN step 1 and step 2 refuses step 2; flips back do not revive it', () => {
  for (const flip of [['offline'], ['unknown'], ['offline', 'live'], ['unknown', 'live']]) {
    const calls = [];
    const gate = createActionGate({ catalogue: doc(), executor: { execute: (a) => { calls.push(a.id); } } });
    gate.setLiveState('live', { source: 'system' });
    const r = gate.request({ id: 'scene.switch', params: {}, source: 'ui', actor: 'u1' });
    const s2 = gate.confirm(r.confirm.confirmId, r.confirm.phrase, r.confirm.actionHash, { source: 'ui' });
    assert.equal(s2.verdict, 'confirm');
    for (const st of flip) gate.setLiveState(st, { source: 'system' });
    assert.equal(gate.confirm(s2.confirm.confirmId, s2.confirm.phrase, s2.confirm.actionHash, { source: 'ui' }).reason, 'live-state-changed', flip.join('>'));
    assert.deepEqual(calls, []);
  }
});

test('matrix R4: cap abuse by each source never evicts or blocks another source\'s confirmation', () => {
  const FLOODERS = [
    { source: 'ui' }, { source: 'api' }, { source: 'remote' }, { source: 'system' },
    { source: 'rule', provenance: { kind: 'hotkey' } }, { source: 'rule', provenance: { kind: 'schedule' } },
    { source: 'chat' }, { source: 'rule', provenance: CHAT },
  ];
  for (const flood of FLOODERS) {
    for (const victim of ['ui', 'api']) {
      if (victim === flood.source) continue;
      const calls = [];
      const gate = createActionGate({ catalogue: doc(), executor: { execute: (a) => { calls.push(a.id); } } });
      const mine = gate.request({ id: 'scene.create', params: {}, source: victim, actor: 'u1' });
      for (let i = 0; i < 100; i++) gate.request({ id: 'scene.switch', params: { i }, actor: PSEUDO, ...flood });
      const later = gate.request({ id: 'layer.create', params: {}, source: victim, actor: 'u1' });
      assert.equal(later.verdict, 'confirm', `${flood.source} blocked ${victim}`);
      assert.equal(gate.confirm(mine.confirm.confirmId, mine.confirm.phrase, mine.confirm.actionHash, { source: 'ui' }).verdict, 'allow', `${flood.source} evicted ${victim}`);
      assert.equal(gate.confirm(later.confirm.confirmId, later.confirm.phrase, later.confirm.actionHash, { source: 'api' }).verdict, 'allow');
      assert.deepEqual(calls, ['scene.create', 'layer.create']);
    }
  }
});

test('matrix R3/R7: panic.clear while live needs "yes, on air"; offline needs "yes"; unknown counts as live', () => {
  for (const live of LIVES) {
    const gate = createActionGate({ catalogue: doc() });
    if (live !== 'unknown') gate.setLiveState(live, { source: 'system' });
    gate.panic({ source: 'ui' });
    const r = gate.request({ id: 'panic.clear', params: {}, source: 'ui', actor: 'u1' });
    assert.equal(r.confirm.phrase, phraseFor(live), live);
    const wrong = phraseFor(live) === 'yes' ? 'yes, on air' : 'yes';
    assert.equal(gate.confirm(r.confirm.confirmId, wrong, r.confirm.actionHash, { source: 'ui' }).verdict, 'refuse');
    assert.equal(gate.state().panic, true);
    const r2 = gate.request({ id: 'panic.clear', params: {}, source: 'api', actor: 'u1' });
    assert.equal(gate.confirm(r2.confirm.confirmId, phraseFor(live), r2.confirm.actionHash, { source: 'api' }).verdict, 'allow');
    assert.equal(gate.state().panic, false);
  }
});

test('matrix R3/R6: a stale live state counts as unknown (live) until a privileged source refreshes it', () => {
  let t = 0;
  const gate = createActionGate({ catalogue: doc(), now: () => t, liveStaleMs: 15_000 });
  gate.setLiveState('offline', { source: 'system' });
  const fresh = gate.request({ id: 'scene.create', params: {}, source: 'ui', actor: 'u1' });
  assert.equal(fresh.confirm.phrase, 'yes');
  t += 15_001;
  assert.equal(gate.state().liveState, 'unknown');
  const stale = gate.request({ id: 'scene.create', params: {}, source: 'ui', actor: 'u1' });
  assert.equal(stale.confirm.phrase, 'yes, on air');
  // The "yes" issued while fresh is refused now (state changed under it).
  assert.equal(gate.confirm(fresh.confirm.confirmId, 'yes', fresh.confirm.actionHash, { source: 'ui' }).verdict, 'refuse');
  // Non-privileged sources cannot refresh it.
  for (const source of ['ui', 'chat', 'rule', 'remote']) assert.equal(gate.setLiveState('offline', { source }).ok, false);
  assert.equal(gate.state().liveState, 'unknown');
  assert.equal(gate.setLiveState('offline', { source: 'system' }).ok, true);
  assert.equal(gate.state().liveState, 'offline');
  // A privileged source can say unknown outright.
  assert.equal(gate.setLiveState('unknown', { source: 'api' }).ok, true);
  assert.equal(gate.request({ id: 'scene.create', params: {}, source: 'ui', actor: 'u1' }).confirm.phrase, 'yes, on air');
});
