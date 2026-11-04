// SPDX-License-Identifier: GPL-3.0-or-later
// services/event-core model: schema/validator agreement, ids, mono, caps, control characters, pseudonyms, key file.
// Temp dirs only. ajv is a dev dependency and is used here, never at runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  CAPS, KINDS, KIND_FIELDS, ROLES, buildEvent, createIdGenerator, derivePseudoId, cpLen,
} from '../services/event-core/model.mjs';
import { validateEvent } from '../services/event-core/validate.mjs';
import { loadKey, resolveDataDir, KEY_FILE } from '../services/event-core/config.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schema = JSON.parse(readFileSync(path.join(repo, 'services/event-core/schema/event.schema.json'), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false });
const schemaOk = ajv.compile(schema);

const dirs = [];
test.after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'evcore-')); dirs.push(d); return d; };

const KEY = Buffer.alloc(32, 7);
const mkCtx = (extra = {}) => ({ key: KEY, nextId: createIdGenerator(), ...extra });

// One valid loose input per kind (all synthetic).
const INPUTS = {
  'chat.message': { text: 'hello', emotes: [{ id: '25', name: 'Kappa' }] },
  'alert.follow': {},
  'alert.sub': { tier: '1000', message: 'hi' },
  'alert.resub': { tier: 'prime', months: 7 },
  'alert.giftsub': { tier: '2000', count: 5 },
  'alert.raid': { viewers: 42 },
  'alert.bits': { amount: 100, message: 'cheer' },
  'alert.superchat': { amount: 4.99, currency: 'USD', message: 'wow' },
  'alert.membership': { tier: 'Level 1', months: 2 },
  'alert.redemption': { reward: 'Hydrate', cost: 500 },
  'system.connected': { target: 'streamerbot' },
  'system.disconnected': { target: 'streamerbot', reason: 'closed' },
  'system.livestate': { live: true },
  'system.panic': { reason: 'test' },
  'system.refused': { action: 'scene.switch', reason: 'audit-unavailable' },
};
function input(kind, extra = {}) {
  const sys = kind.startsWith('system.');
  return {
    kind, platform: sys ? 'local' : 'twitch', source: 'mock', platformMessageId: 'm-1',
    ...(sys ? {} : { user: { platformUserId: 'u-1', displayName: 'Alice', roles: ['viewer'] } }),
    ...INPUTS[kind], ...extra,
  };
}
const plain = (ev) => JSON.parse(JSON.stringify(ev)); // thaw
const both = (ev) => ({ hand: validateEvent(ev).ok, schema: schemaOk(ev) });

test('INPUTS covers every kind', () => {
  assert.deepEqual(Object.keys(INPUTS).sort(), [...KINDS].sort());
  assert.equal(KINDS.length, 15);
});

test('schema and validator both accept a built event of every kind', () => {
  for (const kind of KINDS) {
    const ev = plain(buildEvent(mkCtx(), input(kind)));
    const r = both(ev);
    assert.deepEqual(r, { hand: true, schema: true }, `${kind}: ${JSON.stringify(validateEvent(ev).errors)} ${JSON.stringify(schemaOk.errors)}`);
  }
});

// Hand-picked invalid cases per kind, each as a mutation of a valid event.
function invalidCases() {
  const out = [];
  const add = (name, ev) => out.push([name, ev]);
  for (const kind of KINDS) {
    const base = plain(buildEvent(mkCtx(), input(kind)));
    const m = (name, fn) => { const e = plain(base); fn(e); add(`${kind}: ${name}`, e); };
    m('wrong version', (e) => { e.v = 2; });
    m('bad id', (e) => { e.id = 'x1'; });
    m('bad platform', (e) => { e.platform = 'discord'; });
    m('bad source', (e) => { e.source = 'raw'; });
    m('missing platformMessageId', (e) => { delete e.platformMessageId; });
    m('empty platformMessageId', (e) => { e.platformMessageId = ''; });
    m('bad receivedAt', (e) => { e.receivedAt = '2026-10-28 10:00:00'; });
    m('calendar month 13', (e) => { e.receivedAt = '2026-13-01T00:00:00.000Z'; });
    m('negative mono', (e) => { e.mono = -1; });
    m('string mono', (e) => { e.mono = '1'; });
    m('raw payload field', (e) => { e.raw = { a: 1 }; });
    m('missing kind-less id', (e) => { delete e.id; });
    if (!kind.startsWith('system.')) {
      m('missing user', (e) => { delete e.user; });
      m('user not object', (e) => { e.user = 'a'; });
      m('bad pseudoId', (e) => { e.user.pseudoId = 'abc'; });
      m('upper-case pseudoId', (e) => { e.user.pseudoId = e.user.pseudoId.toUpperCase(); });
      m('missing platformUserId key', (e) => { delete e.user.platformUserId; });
      m('empty displayName', (e) => { e.user.displayName = ''; });
      m('long displayName', (e) => { e.user.displayName = 'a'.repeat(CAPS.displayName + 1); });
      m('control char in displayName', (e) => { e.user.displayName = 'a\u0007b'; });
      m('no roles', (e) => { e.user.roles = []; });
      m('unknown role', (e) => { e.user.roles = ['admin']; });
      m('duplicate role', (e) => { e.user.roles = ['viewer', 'viewer']; });
      m('extra user field', (e) => { e.user.email = 'x'; });
    } else {
      m('system event with user', (e) => { e.user = { pseudoId: 'a'.repeat(32), platformUserId: null, displayName: 'x', roles: ['viewer'] }; });
    }
    for (const [name, spec] of Object.entries(KIND_FIELDS[kind])) {
      if (spec.req) m(`missing ${name}`, (e) => { delete e[name]; });
      if (spec.t === 'str') {
        m(`${name} not string`, (e) => { e[name] = 5; });
        if (spec.max) m(`${name} too long`, (e) => { e[name] = 'a'.repeat(spec.max + 1); });
        if (spec.min) m(`${name} empty`, (e) => { e[name] = ''; });
        m(`${name} control char`, (e) => { e[name] = 'a\nb'; });
        m(`${name} null`, (e) => { e[name] = null; });
      }
      if (spec.t === 'int') {
        m(`${name} float`, (e) => { e[name] = 1.5; });
        m(`${name} below min`, (e) => { e[name] = spec.min - 1; });
        m(`${name} above max`, (e) => { e[name] = spec.max + 1; });
      }
      if (spec.t === 'num') {
        m(`${name} zero`, (e) => { e[name] = 0; });
        m(`${name} string`, (e) => { e[name] = '5'; });
      }
      if (spec.t === 'enum') m(`${name} bad value`, (e) => { e[name] = 'gold'; });
      if (spec.t === 'bool') m(`${name} not bool`, (e) => { e[name] = 'yes'; });
    }
    m('unknown kind-specific field', (e) => { e.bogus = 1; });
  }
  const chat = plain(buildEvent(mkCtx(), input('chat.message')));
  const c = (name, fn) => { const e = plain(chat); fn(e); add(`chat.message: ${name}`, e); };
  c('too many emotes', (e) => { e.emotes = Array.from({ length: CAPS.emotes + 1 }, (_, i) => ({ id: String(i), name: 'n' })); });
  c('emote missing name', (e) => { e.emotes = [{ id: '1' }]; });
  c('emote extra field', (e) => { e.emotes = [{ id: '1', name: 'n', url: 'x' }]; });
  c('emote not object', (e) => { e.emotes = ['x']; });
  c('emotes not array', (e) => { e.emotes = 'x'; });
  c('C1 control in text', (e) => { e.text = 'a\u0085b'; });
  c('DEL in text', (e) => { e.text = 'a\u007fb'; });
  c('kind unknown', (e) => { e.kind = 'chat.whisper'; });
  c('kind missing', (e) => { delete e.kind; });
  const sc = plain(buildEvent(mkCtx(), input('alert.superchat')));
  for (const cur of ['usd', 'US', 'USDD', '']) add(`superchat currency ${JSON.stringify(cur)}`, { ...sc, currency: cur });
  add('superchat amount NaN-like string', { ...sc, amount: 'NaN' });
  add('superchat amount huge', { ...sc, amount: 1e10 });
  return out;
}

test('schema and validator agree on every hand-made invalid case (and both reject it)', () => {
  const cases = invalidCases();
  assert.ok(cases.length > 250, `cases: ${cases.length}`);
  for (const [name, ev] of cases) {
    const r = both(ev);
    assert.deepEqual(r, { hand: false, schema: false }, `${name} -> ${JSON.stringify(r)}`);
  }
  for (const bad of [null, [], 'x', 5, undefined]) {
    assert.deepEqual(both(bad), { hand: false, schema: false });
  }
});

test('schema and validator agree on boundary values that are valid', () => {
  const ok = (name, ev) => assert.deepEqual(both(ev), { hand: true, schema: true }, name);
  const chat = plain(buildEvent(mkCtx(), input('chat.message')));
  ok('text at cap', { ...chat, text: 'a'.repeat(CAPS.text) });
  ok('text at cap in astral code points', { ...chat, text: '\u{1F600}'.repeat(CAPS.text) });
  ok('no emotes key', (() => { const e = plain(chat); delete e.emotes; return e; })());
  ok('empty emotes', { ...chat, emotes: [] });
  ok('all roles', { ...chat, user: { ...chat.user, roles: [...ROLES] } });
  ok('null platformMessageId', { ...chat, platformMessageId: null });
  ok('null platformUserId', { ...chat, user: { ...chat.user, platformUserId: null } });
  ok('mono 0', { ...chat, mono: 0 });
  const raid = plain(buildEvent(mkCtx(), input('alert.raid')));
  ok('raid 0 viewers', { ...raid, viewers: 0 });
  const sc = plain(buildEvent(mkCtx(), input('alert.superchat')));
  ok('superchat fractional amount', { ...sc, amount: 0.01 });
  const mem = plain(buildEvent(mkCtx(), input('alert.membership')));
  const bare = plain(mem); delete bare.tier; delete bare.months;
  ok('membership with no optional fields', bare);
  const text = { ...chat, text: 'a'.repeat(CAPS.text + 1) };
  assert.deepEqual(both(text), { hand: false, schema: false });
  assert.equal(cpLen('\u{1F600}'.repeat(3)), 3);
});

test('random mutations: schema and validator always agree', () => {
  let seed = 12345;
  const rnd = (n) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const junk = [null, 0, -1, 1.5, '', 'x', 'a\u0001', 'a'.repeat(600), [], {}, true, 1e12, ['viewer'], { id: 'a', name: 'b' }];
  let valid = 0;
  let invalid = 0;
  for (let i = 0; i < 4000; i++) {
    const kind = KINDS[rnd(KINDS.length)];
    const ev = plain(buildEvent(mkCtx(), input(kind)));
    const keys = Object.keys(ev);
    const pick = rnd(6);
    if (pick === 0) delete ev[keys[rnd(keys.length)]];
    else if (pick === 1) ev[keys[rnd(keys.length)]] = junk[rnd(junk.length)];
    else if (pick === 4) ev.mono = rnd(1000); // stays valid
    else if (pick === 5) { delete ev.message; delete ev.emotes; delete ev.reason; } // optional fields: stays valid
    else if (pick === 2 && ev.user) ev.user[Object.keys(ev.user)[rnd(4)]] = junk[rnd(junk.length)];
    else ev[`k${rnd(3)}`] = junk[rnd(junk.length)];
    const r = both(ev);
    assert.equal(r.hand, r.schema, `${JSON.stringify(ev)} -> ${JSON.stringify(r)} ${JSON.stringify(validateEvent(ev).errors)} ${JSON.stringify(schemaOk.errors)}`);
    if (r.hand) valid++; else invalid++;
  }
  assert.ok(valid > 0 && invalid > 1000, `valid ${valid} invalid ${invalid}`);
});

test('built events are frozen and drop unknown input keys (no raw payload)', () => {
  const ev = buildEvent(mkCtx(), { ...input('chat.message'), raw: { secret: 1 }, payload: 'x', user: { platformUserId: 'u', displayName: 'A', token: 'z' } });
  assert.ok(Object.isFrozen(ev) && Object.isFrozen(ev.user));
  assert.equal('raw' in ev, false);
  assert.equal('payload' in ev, false);
  assert.equal('token' in ev.user, false);
  assert.equal(validateEvent(ev).ok, true);
  assert.throws(() => { 'use strict'; ev.text = 'x'; }, TypeError);
});

test('roles default to viewer and are stored in canonical order without duplicates', () => {
  const none = buildEvent(mkCtx(), { ...input('chat.message'), user: { platformUserId: 'u', displayName: 'A' } });
  assert.deepEqual(none.user.roles, ['viewer']);
  const mixed = buildEvent(mkCtx(), { ...input('chat.message'), user: { platformUserId: 'u', displayName: 'A', roles: ['viewer', 'moderator', 'viewer', 'broadcaster'] } });
  assert.deepEqual(mixed.user.roles, ['broadcaster', 'moderator', 'viewer']);
  const bad = buildEvent(mkCtx(), { ...input('chat.message'), user: { platformUserId: 'u', displayName: 'A', roles: ['moderator', 'admin'] } });
  assert.equal(validateEvent(bad).ok, false);
});

test('id: unique, fixed length, sorted by creation order under a burst', () => {
  const next = createIdGenerator();
  const ids = Array.from({ length: 100_000 }, () => next());
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((s) => s.length === 31));
  const sorted = [...ids].sort();
  assert.deepEqual(sorted, ids);
});

test('id: stays ordered when the wall clock steps back; two generators differ', () => {
  const walls = [1000, 1000, 1000, 900, 900, 2000];
  let i = 0;
  const next = createIdGenerator({ wall: () => walls[i++] });
  const ids = walls.map(() => next());
  assert.deepEqual([...ids].sort(), ids);
  assert.equal(new Set(ids).size, ids.length);
  const a = createIdGenerator({ wall: () => 5 })();
  const b = createIdGenerator({ wall: () => 5 })();
  assert.notEqual(a, b); // same ms, same counter, different nonce
});

test('mono: non-decreasing across a burst, ms from process start', () => {
  const ctx = mkCtx();
  const monos = Array.from({ length: 20_000 }, () => buildEvent(ctx, input('alert.follow')).mono);
  for (let i = 1; i < monos.length; i++) assert.ok(monos[i] >= monos[i - 1], `at ${i}`);
  assert.ok(monos[0] >= 0 && monos[0] < 60_000 * 60, 'ms since process start, not an epoch value');
  assert.equal(buildEvent(mkCtx({ mono: () => 12.5 }), input('alert.follow')).mono, 12.5);
});

test('receivedAt comes from the wall clock as ISO time', () => {
  const ev = buildEvent(mkCtx({ wall: () => Date.UTC(2026, 9, 28, 12, 0, 0, 5) }), input('alert.follow'));
  assert.equal(ev.receivedAt, '2026-10-28T12:00:00.005Z');
});

test('length caps: strings are truncated to the cap in code points', () => {
  const ctx = mkCtx();
  const long = buildEvent(ctx, input('chat.message', { text: 'a'.repeat(CAPS.text + 50) }));
  assert.equal(cpLen(long.text), CAPS.text);
  const emoji = buildEvent(ctx, input('chat.message', { text: '\u{1F600}'.repeat(CAPS.text + 5) }));
  assert.equal(cpLen(emoji.text), CAPS.text);
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(emoji.text), 'no split surrogate pair');
  const name = buildEvent(ctx, { ...input('chat.message'), user: { platformUserId: 'u', displayName: 'n'.repeat(500) } });
  assert.equal(cpLen(name.user.displayName), CAPS.displayName);
  const id = buildEvent(ctx, { ...input('chat.message'), platformMessageId: 'i'.repeat(500) });
  assert.equal(cpLen(id.platformMessageId), CAPS.platformMessageId);
  const emotes = buildEvent(ctx, input('chat.message', { emotes: Array.from({ length: 80 }, (_, i) => ({ id: String(i), name: 'n' })) }));
  assert.equal(emotes.emotes.length, CAPS.emotes);
  for (const e of [long, emoji, name, id, emotes]) assert.equal(validateEvent(e).ok, true);
});

test('control characters become spaces at construction and are rejected by the validator', () => {
  const ctx = mkCtx();
  const ev = buildEvent(ctx, {
    ...input('chat.message', { text: 'a\u0000b\nc\td\u007fe\u0085f‮g' }),
    user: { platformUserId: 'u\u0001', displayName: 'Al\rice\u009f' },
    platformMessageId: 'm\u0002-1',
  });
  assert.equal(ev.text, 'a b c d e f‮g'); // C0, DEL and C1 become one space each, runs collapse; bidi marks are E3's job
  assert.equal(ev.user.displayName, 'Al ice');
  assert.equal(ev.user.platformUserId, 'u');
  assert.equal(ev.platformMessageId, 'm -1');
  assert.equal(validateEvent(ev).ok, true);
  const forged = { ...plain(ev), text: 'x\u0000y' };
  assert.equal(validateEvent(forged).ok, false);
  const onlyControls = buildEvent(ctx, input('chat.message', { text: '\n\n' }));
  assert.equal(validateEvent(onlyControls).ok, false, 'empty after replacing and trimming');
});

test('non-string field values are not coerced; the validator rejects them', () => {
  const ev = buildEvent(mkCtx(), input('chat.message', { text: { toString() { return 'x'; } } }));
  assert.equal(validateEvent(ev).ok, false);
});

test('pseudoId: stable per (platform, user); differs across platforms, users and keys', () => {
  const a = derivePseudoId(KEY, 'twitch', 'u-1');
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.equal(derivePseudoId(KEY, 'twitch', 'u-1'), a);
  assert.notEqual(derivePseudoId(KEY, 'youtube', 'u-1'), a);
  assert.notEqual(derivePseudoId(KEY, 'twitch', 'u-2'), a);
  assert.notEqual(derivePseudoId(Buffer.alloc(32, 8), 'twitch', 'u-1'), a);
  // Built events carry the same value, regardless of display name.
  const e1 = buildEvent(mkCtx(), { ...input('chat.message'), user: { platformUserId: 'u-1', displayName: 'First' } });
  const e2 = buildEvent(mkCtx(), { ...input('chat.message'), user: { platformUserId: 'u-1', displayName: 'Renamed' } });
  assert.equal(e1.user.pseudoId, a);
  assert.equal(e2.user.pseudoId, a);
  // No platform user id: stable per platform + lower-cased name, and distinct from an id-based one.
  const n1 = derivePseudoId(KEY, 'twitch', null, 'Alice');
  assert.equal(n1, derivePseudoId(KEY, 'twitch', null, 'ALICE'));
  assert.notEqual(n1, derivePseudoId(KEY, 'youtube', null, 'Alice'));
  assert.notEqual(n1, derivePseudoId(KEY, 'twitch', 'Alice'));
  assert.ok(!e1.user.pseudoId.includes('u-1'));
});

test('key file: created once with 32 bytes, then reused', () => {
  const dir = path.join(tmp(), 'nested', 'data');
  const first = loadKey(dir);
  assert.equal(first.created, true);
  assert.equal(first.key.length, 32);
  assert.ok(['mode-0600', 'acl', 'acl-failed'].includes(first.protection));
  const file = path.join(dir, KEY_FILE);
  assert.equal(statSync(file).size, 32);
  const second = loadKey(dir);
  assert.equal(second.created, false);
  assert.equal(second.protection, null);
  assert.ok(second.key.equals(first.key));
  assert.ok(readFileSync(file).equals(first.key));
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('key file of the wrong size is an error and is not replaced', () => {
  const dir = tmp();
  writeFileSync(path.join(dir, KEY_FILE), Buffer.alloc(5, 1));
  assert.throws(() => loadKey(dir), /must be 32 bytes/);
  assert.equal(statSync(path.join(dir, KEY_FILE)).size, 5);
});

test('resolveDataDir: option wins, then profile key, else error; placeholders ignored', () => {
  const d = tmp();
  const profile = path.join(d, 'profile.json');
  assert.equal(resolveDataDir({ dataDir: d, profilePath: profile }), path.resolve(d));
  assert.throws(() => resolveDataDir({ profilePath: profile }), /needs a data dir/); // no file
  writeFileSync(profile, JSON.stringify({ paths: { event_core_data: '<event-core-data>' } }));
  assert.throws(() => resolveDataDir({ profilePath: profile }), /needs a data dir/);
  writeFileSync(profile, JSON.stringify({ paths: {} }));
  assert.throws(() => resolveDataDir({ profilePath: profile }), /needs a data dir/);
  const target = path.join(d, 'ecd');
  writeFileSync(profile, JSON.stringify({ paths: { event_core_data: target } }));
  assert.equal(resolveDataDir({ profilePath: profile }), target);
  assert.equal(resolveDataDir({ dataDir: d, profilePath: profile }), path.resolve(d));
  assert.equal(existsSync(target), false, 'resolving never creates the dir');
});

test('schema caps match the model caps', () => {
  const s = JSON.stringify(schema);
  for (const n of [CAPS.text, CAPS.displayName, CAPS.platformUserId, CAPS.platformMessageId, CAPS.reward, CAPS.reason, CAPS.emotes]) {
    assert.ok(s.includes(`:${n}`) || s.includes(`: ${n}`), `schema mentions ${n}`);
  }
});
