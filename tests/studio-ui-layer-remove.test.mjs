// SPDX-License-Identifier: GPL-3.0-or-later
// Control page Remove layer (D330, Codex review): no scene-edit flag needed, acts on the click (D332), greyed and refused while live.
// ui/js/app.js runs in a vm with a stub DOM and a stub Api (as tests/studio-ui-nudge.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../ui/js/app.js', import.meta.url), 'utf8');
const HTML = readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');
const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle(n = 20) { for (let i = 0; i < n; i++) await tick(); }

function harness({ live = false, answer = true } = {}) {
  const els = new Map();
  const mk = (id) => ({
    id, hidden: id === 'confirm', value: '', textContent: '', className: '', disabled: false, title: '', style: {}, children: [], handlers: {},
    addEventListener(t, h) { (this.handlers[t] ??= []).push(h); }, appendChild(c) { this.children.push(c); }, removeChild() {}, setAttribute() {}, focus() {},
    checkValidity: () => true, classList: { add() {}, remove() {}, toggle() {} },
    get firstChild() { return this.children[0] ?? null; },
  });
  const document = {
    hidden: false,
    getElementById: (id) => { if (!els.has(id)) els.set(id, mk(id)); return els.get(id); },
    addEventListener() {},
  };
  const Dom = { el: (tag, attrs = {}, kids = []) => ({ ...mk(tag), ...attrs, children: kids }), clear: (e) => { e.children = []; }, setText: (e, t) => { e.textContent = String(t); } };
  const calls = [], asked = [];
  let statusCb = null;
  const Api = {
    session: async () => ({}),
    status: async () => ({ host: { live } }),
    edits: async () => ({ edits: [] }),
    flags: async () => ({ flags: [{ id: 'scene-edit', on: false }, { id: 'preview-edit', on: true }] }),
    structure: async () => ({ available: false }),
    events: (onStatus) => { statusCb = onStatus; },
    cancel: async () => {},
    structureEdit: async (body) => { calls.push(['structure', body]); if (live) { const e = new Error('live-locked'); throw e; } return { saved: true }; },
    host: async (method, params) => {
      calls.push([method, params]);
      if (method === 'scenes.list') return { result: { scenes: [{ id: 'S1', name: 'Main', canvases: ['h'], active: true }] } };
      if (method === 'layers.list') return { result: { layers: [{ id: 'L1', name: 'Cam', visible: true, placement: { x: 0, y: 0, width: 10, height: 10 } }] } };
      if (method === 'mixer.list') return { result: { sources: [] } };
      return { result: {} };
    },
  };
  const window = { confirm: (q) => { asked.push(q); return answer; } };
  const ctx = { document, Dom, Api, window, setInterval: () => 0, clearInterval() {}, setTimeout, clearTimeout, console, Promise };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const select = async () => {
    statusCb({ host: { live, previewEdit: { seq: 1 } } });
    statusCb({ host: { live, previewEdit: { seq: 2, scene: 'S1', canvas: 'h', layer: 'L1' } } });
    await settle();
  };
  const click = async (id) => { (els.get(id)?.handlers.click ?? []).forEach((h) => h({ preventDefault() {} })); await settle(); };
  const removes = () => JSON.parse(JSON.stringify(calls.filter((c) => c[0] === 'structure' && c[1].op === 'layer.remove').map((c) => c[1])));
  return { els, asked, select, click, removes };
}

test('the Remove layer button sits outside the scene-edit form (shown without the flag)', () => {
  const form = HTML.slice(HTML.indexOf('id="layer-edit"'), HTML.indexOf('</div>', HTML.indexOf('id="layer-edit"')));
  assert.ok(!form.includes('btn-layer-remove'), 'not inside #layer-edit (hidden while scene-edit is off)');
  assert.match(HTML, /<div id="layer-actions" class="struct-edit">\s*<button id="btn-layer-remove"/);
});

test('scene-edit off: Remove acts on the click (D332): no "are you sure", one layer.remove', async () => {
  // The stub would answer "Cancel" if asked; the click must not ask at all.
  const h = harness({ answer: false });
  await settle(); await h.select();
  assert.equal(h.els.get('btn-layer-remove').disabled, false);
  await h.click('btn-layer-remove');
  assert.equal(h.asked.length, 0, 'no question');
  assert.deepEqual(h.removes(), [{ op: 'layer.remove', scene: 'S1', layer: 'L1' }]);
});

test('live: the button is greyed with "Not while live" and a click sends nothing', async () => {
  const h = harness({ live: true });
  await settle(); await h.select();
  assert.deepEqual([h.els.get('btn-layer-remove').disabled, h.els.get('btn-layer-remove').title], [true, 'Not while live']);
  await h.click('btn-layer-remove');
  assert.deepEqual([h.asked.length, h.removes().length], [0, 0]);
  assert.equal(h.els.get('struct-note').textContent, 'Not while live.');
});
