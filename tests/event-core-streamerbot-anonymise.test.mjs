// SPDX-License-Identifier: GPL-3.0-or-later
// P3 E2: alert fixture anonymiser. No input string may survive unless it is allowlisted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { anonymise, createFixtureRecorder } from '../services/event-core/streamerbot/anonymise.mjs';

const dirs = [];
test.after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'evan-')); dirs.push(d); return d; };

/** Every string leaf and every key in a value. */
function strings(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); strings(x, out); }
  return out;
}

const SAMPLE = {
  event: { source: 'Twitch', type: 'Sub' },
  data: {
    user: { id: '12345678', login: 'secretlogin', name: 'SecretName', displayName: 'Sécret Näme', badges: [{ name: 'subscriber', version: '12' }] },
    messageId: 'abc-def-0001', text: 'my secret message with https://evil.example/x', systemMessage: 'SecretName subscribed',
    subTier: '2000', isPrime: false, durationMonths: 14, bits: 100, amount: 5.5, currencyCode: 'EUR', viewers: 9, isTest: true,
    recipient: { userName: 'RecipientNm', id: 99 }, reward: { title: 'Secret Reward', cost: 500, id: 'guid-1' },
    createdAt: '2026-10-28T10:00:00Z', userInput: 'typed secret',
    SecretMapKey: { nested: 'value' }, secretlogin: 'keyed by a name', tier: 'Secret Level Name',
  },
};

test('anonymise: no input string survives except allowlisted values', () => {
  const out = anonymise(SAMPLE);
  const kept = new Set(strings(out));
  const ALLOWED_STRINGS = new Set(['2000', 'EUR', 'Twitch', 'Sub']);
  // structural keys the allowlist knows may remain as keys
  const KEYS = new Set(['event', 'source', 'type', 'data', 'user', 'id', 'login', 'name', 'displayName', 'badges', 'version',
    'messageId', 'text', 'systemMessage', 'subTier', 'isPrime', 'durationMonths', 'bits', 'amount', 'currencyCode', 'viewers',
    'isTest', 'recipient', 'userName', 'reward', 'title', 'cost', 'createdAt', 'userInput', 'tier']);
  for (const s of kept) {
    const ok = ALLOWED_STRINGS.has(s) || KEYS.has(s) || /^<(id|num|deep|other)>$/.test(s) || /^<str:\d+>$/.test(s) || /^<key:\d+>#\d+$/.test(s);
    assert.ok(ok, `unexpected survivor: ${s}`);
  }
  const text = JSON.stringify(out);
  for (const secret of ['12345678', 'secretlogin', 'SecretName', 'Sécret', 'abc-def-0001', 'secret message', 'evil.example', 'RecipientNm',
    'Secret Reward', 'guid-1', '2026-10-28', 'typed secret', 'SecretMapKey', 'keyed by a name', 'Secret Level Name', 'subscribed']) {
    assert.ok(!text.includes(secret), `leaked ${secret}`);
  }
});

test('anonymise: allowlisted values kept, others shaped', () => {
  const out = anonymise(SAMPLE);
  assert.deepEqual(out.event, { source: 'Twitch', type: 'Sub' });
  assert.equal(out.data.subTier, '2000');
  assert.equal(out.data.currencyCode, 'EUR');
  assert.equal(out.data.durationMonths, 14);
  assert.equal(out.data.bits, 100);
  assert.equal(out.data.amount, 5.5);
  assert.equal(out.data.isPrime, false);
  assert.equal(out.data.isTest, true);
  assert.equal(out.data.user.id, '<id>');
  assert.equal(out.data.user.login, '<id>');
  assert.equal(out.data.recipient.id, '<id>');
  assert.equal(out.data.recipient.userName, '<id>');
  assert.equal(out.data.messageId, '<id>');
  assert.equal(out.data.text, `<str:${[...SAMPLE.data.text].length}>`);
  assert.equal(out.data.user.name, `<str:${[...'SecretName'].length}>`);
  assert.equal(out.data.tier, `<str:${[...'Secret Level Name'].length}>`);  // free-text tier fails the enum pattern
  assert.ok(Object.values(out.data.user.badges[0]).includes('<str:2>'));   // unknown key `version`: key and value both shaped
  assert.ok(!Object.keys(out.data.user.badges[0]).includes('version'));
  assert.equal(out.data.reward.cost, 500);
});

test('anonymise: an allowlisted key does not save a value that fails its pattern', () => {
  const out = anonymise({ data: { subTier: 'SomeName', currencyCode: 'secret', bits: 'text' } });
  assert.equal(out.data.subTier, '<str:8>');
  assert.equal(out.data.currencyCode, '<str:6>');
  assert.equal(out.data.bits, '<str:4>');
});

test('anonymise: type/source survive only as the recorder wrapper, not inside data', () => {
  const out = anonymise({ event: { source: 'Twitch', type: 'Raid' }, data: { type: 'SomeName', source: 'Other', event: { source: 'X', type: 'Y' } } });
  assert.equal(out.event.type, 'Raid');
  assert.equal(out.data.type, '<str:8>');
  assert.equal(out.data.source, '<str:5>');
  assert.equal(out.data.event.source, '<str:1>');
});

test('anonymise: randomised strings never survive (seeded fuzz)', () => {
  let a = 12345;
  const rnd = () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; };
  const word = () => Array.from({ length: 6 + Math.floor(rnd() * 10) }, () => String.fromCharCode(0x61 + Math.floor(rnd() * 26))).join('') + 'Q' + Math.floor(rnd() * 1e6);
  for (let i = 0; i < 300; i++) {
    const words = Array.from({ length: 12 }, word);
    const doc = {
      event: { source: 'Kick', type: 'Follow' },
      data: { user: { id: words[0], name: words[1], [words[2]]: words[3] }, text: words[4], [words[5]]: { [words[6]]: [words[7], { name: words[8] }] }, reward: { title: words[9] }, message: words[10], levelName: words[11] },
    };
    const text = JSON.stringify(anonymise(doc));
    for (const w of words) assert.ok(!text.includes(w), `leaked ${w}`);
  }
});

test('anonymise: shape limits (depth, array length), null and booleans kept, input not mutated', () => {
  const deep = { data: { a: { b: { c: { d: { e: { f: { g: { h: { i: { user: 'x' } } } } } } } } } } };
  assert.ok(JSON.stringify(anonymise(deep)).includes('<deep>'));
  const arr = anonymise({ data: { parts: Array.from({ length: 80 }, () => 'p') } });
  assert.equal(arr.data.parts.length, 50);
  assert.deepEqual(anonymise({ data: { isTest: false, broadcaster: null } }), { data: { isTest: false, broadcaster: null } });
  const before = JSON.stringify(SAMPLE); anonymise(SAMPLE);
  assert.equal(JSON.stringify(SAMPLE), before);
});

test('recorder: writes <dir>/fixtures/alerts/<kind>/<n>.json, numbering, cap, kind guard', async () => {
  const dir = tmp();
  const rec = createFixtureRecorder({ dir, maxPerKind: 2 });
  const env = { event: { source: 'Twitch', type: 'Follow' }, data: { user: { name: 'SomeName' } } };
  // asynchronous: record() returns a promise at once; calls made together are written in order
  const q1 = rec.record('alert.follow', env);
  const q2 = rec.record('alert.follow', env);
  const q3 = rec.record('alert.follow', env);
  assert.ok(q1 instanceof Promise);
  const [p1, p2, p3] = await Promise.all([q1, q2, q3]);
  assert.equal(path.relative(dir, p1).replaceAll('\\', '/'), 'fixtures/alerts/follow/1.json');
  assert.equal(path.basename(p2), '2.json');
  assert.equal(p3, null);                                                // cap
  assert.equal(await rec.record('alert.follow', env), null);           // still capped, no disk call
  assert.equal(await rec.record('chat.message', env), null);           // not an alert
  assert.equal(await rec.record('alert.../../x', env), null);          // no path tricks
  assert.deepEqual(readdirSync(path.join(dir, 'fixtures')), ['alerts']);
  assert.ok(!readFileSync(p1, 'utf8').includes('SomeName'));
  assert.deepEqual(rec.counts(), { follow: 2 });
  // numbering continues after a restart
  const rec2 = createFixtureRecorder({ dir, maxPerKind: 5 });
  assert.equal(path.basename(await rec2.record('alert.follow', env)), '3.json');
  assert.ok(existsSync(path.join(dir, 'fixtures', 'alerts', 'follow', '3.json')));
});

test('recorder: no synchronous fs call in the module (it runs on the live path)', () => {
  const src = readFileSync(fileURLToPath(new URL('../services/event-core/streamerbot/anonymise.mjs', import.meta.url)), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /\b[a-zA-Z]+Sync\b/);
});

test('recorder: refuses a directory inside the repository', () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  assert.throws(() => createFixtureRecorder({ dir: path.join(repo, 'docs') }), /fixture-dir-inside-repo/);
  assert.throws(() => createFixtureRecorder({ dir: repo }), /fixture-dir-inside-repo/);
});
