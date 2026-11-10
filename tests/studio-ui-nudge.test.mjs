// SPDX-License-Identifier: GPL-3.0-or-later
// Arrow-key nudges on the control page (P5, D254): ui/js/app.js runs in a vm with a stub DOM and a stub Api.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../ui/js/app.js', import.meta.url), 'utf8');
const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle(n = 20) { for (let i = 0; i < n; i++) await tick(); }

function harness({ flagOn = true, live = false, verdict = null } = {}) {
  const els = new Map();
  const mk = (id) => ({
    id, hidden: id === 'confirm', value: '', textContent: '', className: '', disabled: false, title: '', style: {}, children: [],
    addEventListener() {}, appendChild(c) { this.children.push(c); }, removeChild() {}, setAttribute() {}, focus() {},
    checkValidity: () => true, classList: { add() {}, remove() {}, toggle() {} },
    get firstChild() { return this.children[0] ?? null; },
  });
  const docHandlers = [];
  const document = {
    hidden: false,
    getElementById: (id) => { if (!els.has(id)) els.set(id, mk(id)); return els.get(id); },
    addEventListener: (t, h) => { if (t === 'keydown') docHandlers.push(h); },
  };
  const Dom = { el: (tag, attrs = {}, kids = []) => ({ ...mk(tag), ...attrs, children: kids }), clear: (e) => { e.children = []; }, setText: (e, t) => { e.textContent = String(t); } };
  let layer = { id: 'L1', name: 'Cam', visible: true, placement: { x: 100, y: 50, width: 400, height: 300 } };
  const calls = [];
  let statusCb = null;
  const Api = {
    session: async () => ({}),
    status: async () => ({ host: { live } }),
    edits: async () => ({ edits: [] }),
    flags: async () => ({ flags: [{ id: 'preview-edit', on: flagOn }] }),
    events: (onStatus) => { statusCb = onStatus; },
    cancel: async (id) => { calls.push(['cancel', id]); },
    host: async (method, params) => {
      calls.push([method, params]);
      if (method === 'scenes.list') return { result: { scenes: [{ id: 'S1', name: 'Main', canvases: ['h'], active: true }] } };
      if (method === 'layers.list') return { result: { layers: [structuredClone(layer)] } };
      if (method === 'mixer.list') return { result: { sources: [] } };
      if (method === 'layers.setPlacement') {
        if (verdict) return { verdict, pending: { pendingId: 'p1' } };
        layer.placement = { ...layer.placement, ...params.placement };
        return { result: {} };
      }
      return { result: {} };
    },
  };
  const ctx = { document, Dom, Api, window: {}, setInterval: () => 0, clearInterval() {}, setTimeout, clearTimeout, console, Promise };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const key = (k, extra = {}) => { const e = { key: k, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, target: { tagName: 'BODY' }, prevented: false, preventDefault() { this.prevented = true; }, ...extra }; docHandlers.forEach((h) => h(e)); return e; };
  const select = async () => {
    statusCb({ host: { live, previewEdit: { seq: 1 } } });
    statusCb({ host: { live, previewEdit: { seq: 2, scene: 'S1', canvas: 'h', layer: 'L1' } } });
    await settle();
  };
  return { calls, key, select, els, place: () => layer.placement };
}

// JSON copy: objects made inside the vm are from another realm
const moves = (calls) => JSON.parse(JSON.stringify(calls.filter((c) => c[0] === 'layers.setPlacement').map((c) => c[1].placement)));

test('arrows move the selected layer 1 px, Shift 10 px; keys pressed while a move is on its way go as one call', async () => {
  const h = harness();
  await settle();
  await h.select();
  assert.ok(h.key('ArrowRight').prevented);
  await settle();
  h.key('ArrowDown', { shiftKey: true });
  await settle();
  assert.deepEqual(moves(h.calls), [{ x: 101 }, { y: 60 }]);
  // three presses at once: the first goes, the other two add up
  h.key('ArrowLeft'); h.key('ArrowLeft'); h.key('ArrowUp');
  await settle();
  assert.deepEqual(moves(h.calls).slice(2), [{ x: 100 }, { x: 99, y: 59 }]);
  assert.deepEqual([h.place().x, h.place().y], [99, 59]);
});

test('no nudge: flag off, no selection, typing in a field, with Ctrl, or other keys', async () => {
  const off = harness({ flagOn: false });
  await settle(); await off.select();
  assert.equal(off.key('ArrowRight').prevented, false);
  const h = harness();
  await settle();
  h.key('ArrowRight'); // nothing selected yet
  await h.select();
  h.key('ArrowRight', { target: { tagName: 'INPUT' } });
  h.key('ArrowRight', { ctrlKey: true });
  h.key('a');
  await settle();
  assert.deepEqual([moves(off.calls), moves(h.calls)], [[], []]);
});

test('live: arrow keys are off with a note; a press acts on the key with nothing left pending (D331)', async () => {
  const live = harness({ live: true });
  await settle(); await live.select();
  live.key('ArrowRight');
  await settle();
  assert.deepEqual(moves(live.calls), []);
  assert.match(live.els.get('insp-note').textContent, /Live: arrow keys are off/);
  const v = harness({ verdict: 'allow' });
  await settle(); await v.select();
  v.key('ArrowRight');
  await settle();
  assert.equal(moves(v.calls).length, 1, 'one move on the key press');
  assert.deepEqual(v.calls.filter((c) => c[0] === 'cancel' || c[0] === 'confirm'), [], 'no confirm step, nothing to cancel');
});
