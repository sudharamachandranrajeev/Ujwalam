// SPDX-License-Identifier: GPL-3.0-or-later
// Feature flag module (D149): defaults, local state, atomic write, validation, subscribe, committed definitions.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { createFlags, DEFAULT_FLAGS_FILE, FLAG_PAGES, loadDefinitions, LOCAL_NAME } from '../services/flags/index.mjs';

const dirs = [];
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-flags-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe('committed definitions', () => {
  // New features ship off (AGENTS.md). The only exceptions are flags the user asked to have on, each with its decision.
  const ON_BY_DECISION = { 'preview-edit': 'D330', 'reel-thumbnail': 'D368' };
  test('data/flags.json is valid and every default is off, except the ones a decision turned on', () => {
    const defs = loadDefinitions(DEFAULT_FLAGS_FILE);
    assert.ok(defs.length >= 1);
    for (const d of defs) assert.equal(d.default, Object.hasOwn(ON_BY_DECISION, d.id), d.id);
    const log = readFileSync(path.join(path.dirname(DEFAULT_FLAGS_FILE), '..', 'docs', 'plan', '2026-10-29-v1-decisions.md'), 'utf8');
    for (const [id, dn] of Object.entries(ON_BY_DECISION)) {
      const at = log.indexOf(`## ${dn} `);
      assert.ok(at >= 0, `decision ${dn} is in the log`);
      const section = log.slice(at, log.indexOf('\n## ', at + 1) >>> 0);
      assert.ok(section.includes(`\`${id}\``) && /ON by default/.test(section), `${dn} turns ${id} on`);
    }
  });
  test('every flag has a plain label, a one-line summary and a Settings page', () => {
    const defs = loadDefinitions(DEFAULT_FLAGS_FILE);
    const labels = new Set();
    for (const d of defs) {
      assert.ok(d.label.length >= 3 && d.label.length <= 28, `${d.id} label length`);
      assert.ok(!labels.has(d.label.toLowerCase()), `${d.id} label is unique`);
      labels.add(d.label.toLowerCase());
      assert.ok(d.summary.length >= 10 && d.summary.length <= 90, `${d.id} summary length ${d.summary.length}`);
      assert.ok(!/D\d{2,3}|[A-Z]{2}\d|[a-z]+-[a-z-]+/.test(d.summary), `${d.id} summary has no decision numbers or ids`);
      assert.ok(FLAG_PAGES.includes(d.page), `${d.id} page ${d.page}`);
    }
  });
  test('rejects a missing label, summary or a bad page', () => {
    const d = tmp(); const f = path.join(d, 'defs.json');
    const ok = { id: 'ok', description: 'x', default: false, since: 's', label: 'Okay', page: 'clips', summary: 'Does a thing.' };
    writeFileSync(f, JSON.stringify({ flags: [ok] }));
    assert.equal(loadDefinitions(f)[0].page, 'clips');
    for (const bad of [{ label: '' }, { summary: undefined }, { page: 'nowhere' }, { page: undefined }]) {
      writeFileSync(f, JSON.stringify({ flags: [{ ...ok, ...bad }] }));
      assert.throws(() => loadDefinitions(f), /bad entry/);
    }
  });
  test('rejects duplicate ids and bad shapes', () => {
    const d = tmp(); const f = path.join(d, 'defs.json');
    writeFileSync(f, JSON.stringify({ flags: [{ id: 'a', description: 'x', default: false, since: 's', label: 'L', page: 'clips', summary: 'Does a thing.' }, { id: 'a', description: 'x', default: false, since: 's', label: 'L', page: 'clips', summary: 'Does a thing.' }] }));
    assert.throws(() => loadDefinitions(f), /duplicate/);
    writeFileSync(f, JSON.stringify({ flags: [{ id: 'Bad Id', description: 'x', default: false, since: 's', label: 'L', page: 'clips', summary: 'Does a thing.' }] }));
    assert.throws(() => loadDefinitions(f), /bad id/);
    writeFileSync(f, JSON.stringify({ flags: [{ id: 'ok', description: 'x', default: 'no', since: 's', label: 'L', page: 'clips', summary: 'Does a thing.' }] }));
    assert.throws(() => loadDefinitions(f), /bad entry/);
  });
});

describe('createFlags', () => {
  test('defaults off, set persists atomically to flags.local.json, no temp file left', () => {
    const d = tmp(); const f = createFlags({ dataDir: d });
    const id = f.ids()[0];
    assert.equal(f.isOn(id), false);
    f.set(id, true);
    assert.equal(f.isOn(id), true);
    assert.deepEqual(JSON.parse(readFileSync(path.join(d, LOCAL_NAME), 'utf8')), { flags: { [id]: true } });
    assert.deepEqual(readdirSync(d), [LOCAL_NAME]);
    f.set(id, false);
    assert.equal(createFlags({ dataDir: d }).isOn(id), false); // a second instance sees the file
  });
  test('another instance sees a flip without restart (mtime reload)', () => {
    const d = tmp(); const a = createFlags({ dataDir: d }); const b = createFlags({ dataDir: d });
    const id = a.ids()[0];
    assert.equal(b.isOn(id), false);
    a.set(id, true);
    assert.equal(b.isOn(id), true);
  });
  test('unknown id and non-boolean are refused; unknown flags in the local file are ignored', () => {
    const d = tmp(); const f = createFlags({ dataDir: d });
    assert.throws(() => f.set('nope', true), { code: 'UNKNOWN_FLAG' });
    assert.throws(() => f.set('__proto__', true), { code: 'UNKNOWN_FLAG' });
    assert.throws(() => f.set(f.ids()[0], 'yes'), { code: 'BAD_VALUE' });
    assert.equal(f.isOn('nope'), false);
    writeFileSync(path.join(d, LOCAL_NAME), JSON.stringify({ flags: { nope: true, [f.ids()[0]]: 'yes' } }));
    assert.equal(f.isOn('nope'), false);
    assert.equal(f.isOn(f.ids()[0]), false);
  });
  test('corrupt local file falls back to defaults', () => {
    const d = tmp(); writeFileSync(path.join(d, LOCAL_NAME), '{not json');
    assert.equal(createFlags({ dataDir: d }).isOn(createFlags({ dataDir: d }).ids()[0]), false);
  });
  test('subscribe fires on set; a throwing subscriber does not block; unsubscribe works', () => {
    const d = tmp(); const f = createFlags({ dataDir: d }); const seen = [];
    f.subscribe(() => { throw new Error('boom'); });
    const off = f.subscribe((e) => seen.push([e.id, e.on]));
    const id = f.ids()[0];
    f.set(id, true);
    off();
    f.set(id, false);
    assert.deepEqual(seen, [[id, true]]);
  });
});
