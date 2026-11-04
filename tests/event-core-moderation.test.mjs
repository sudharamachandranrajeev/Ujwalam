// SPDX-License-Identifier: GPL-3.0-or-later
// services/event-core/moderation: verdicts, reply guard, self-echo, routing, platform data, bus stage.
// All text is invented. Temp dirs only. ajv is used here as a dev dependency, never at runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { createModeration } from '../services/event-core/moderation/index.mjs';
import { createEchoTracker } from '../services/event-core/moderation/echo.mjs';
import { loadReplyLimits } from '../services/event-core/moderation/platforms.mjs';
import { loadBlocklistJson } from '../services/event-core/moderation/blocklist.mjs';
import { createEventCore } from '../services/event-core/index.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirs = [];
test.after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'evmod-')); dirs.push(d); return d; };
const tick = () => new Promise((r) => setImmediate(r));

const BL = {
  policy: { echoWindowSec: 120, replyMaxChars: 120 },
  dropMessage: ['\\bf+u+c+k+', '\\bscam\\b', 'https?://'],
  dropUser: ['TestBot'],
  rejectReply: ['https?://', '\\bclick\\b'],
};
const LIMITS = {
  twitch: { replyMaxChars: 500, unverified: false },
  youtube: { replyMaxChars: 200, unverified: true },
  kick: { replyMaxChars: 500, unverified: false },
  local: { replyMaxChars: null, unverified: false },
};
const mk = (extra = {}) => createModeration({ blocklist: BL, limits: LIMITS, ...extra });
const chat = (text, over = {}) => ({
  kind: 'chat.message', platform: 'twitch', platformMessageId: 'm1',
  user: { displayName: 'ViewerOne', ...over.user }, text, ...over.rest,
});
const alertSub = (message, name = 'ViewerOne') => ({
  kind: 'alert.sub', platform: 'twitch', user: { displayName: name }, tier: '1000', message,
});

test('moderate: clean chat passes with a cleaned name', () => {
  const v = mk().moderate(chat('nice play'));
  assert.deepEqual(v, { action: 'pass', reasons: [], cleanName: 'ViewerOne' });
});

test('moderate: blocklist drops chat, with the reason and the matched pattern index', () => {
  const v = mk().moderate(chat('this is a SCAM'));
  assert.equal(v.action, 'drop');
  assert.deepEqual(v.reasons, ['blocked']);
  assert.deepEqual(v.matched, [1]);
});

test('moderate: legacy evasions are caught (case, repeats, zero-width, bidi)', () => {
  const m = mk();
  for (const t of ['FUCK', 'fuuuuck', 'f​uck', '‮fuck', 'f⁦u⁩ck']) {
    assert.equal(m.moderate(chat(t)).action, 'drop', JSON.stringify(t));
  }
});

test('moderate: separators and look-alikes are NOT caught (legacy parity; gap listed as a proposal)', () => {
  const m = mk();
  for (const t of ['f u c k', 'f.u.c.k', 'f­uck']) assert.equal(m.moderate(chat(t)).action, 'pass', JSON.stringify(t));
});

test('moderate: dropUser matches display name, case-insensitive; reason is bot', () => {
  const v = mk().moderate(chat('hello', { user: { displayName: 'TESTBOT' } }));
  assert.equal(v.action, 'drop');
  assert.equal(v.reasons[0], 'bot');
});

test('moderate: unusable display name drops chat as bad-name; reasons keep legacy order', () => {
  const m = mk();
  assert.deepEqual(m.moderate(chat('hello', { user: { displayName: '!!!' } })).reasons, ['bad-name']);
  const v = m.moderate(chat('scam', { user: { displayName: '!!!' } }));
  assert.deepEqual(v.reasons, ['blocked', 'bad-name']);
});

test('moderate: alerts are flagged, never dropped', () => {
  const m = mk();
  assert.equal(m.moderate(alertSub('thanks')).action, 'pass');
  const v = m.moderate(alertSub('go to https://example.invalid'));
  assert.equal(v.action, 'flag');
  assert.deepEqual(v.reasons, ['blocked']);
  assert.equal(m.moderate(alertSub('thanks', '!!!')).action, 'flag');
  // alerts without text, and system events, pass
  assert.equal(m.moderate({ kind: 'alert.follow', platform: 'twitch', user: { displayName: 'ViewerOne' } }).action, 'pass');
  assert.equal(m.moderate({ kind: 'system.connected', platform: 'twitch', target: 'x' }).action, 'pass');
});

test('moderate: a bot name on an alert is not a bot drop (alerts are not chat)', () => {
  assert.equal(mk().moderate(alertSub('hi', 'TestBot')).action, 'pass');
});

test('moderate: counts are kept', () => {
  const m = mk();
  m.moderate(chat('ok')); m.moderate(chat('scam')); m.moderate(alertSub('scam'));
  const s = m.stats();
  assert.equal(s.pass, 1); assert.equal(s.drop, 1); assert.equal(s.flag, 1);
});

// ---- guardReply ---------------------------------------------------------------------------------
test('guardReply: ok text is returned unchanged', () => {
  assert.deepEqual(mk().guardReply({ platform: 'twitch', text: 'Thanks for coming!' }), { ok: true, text: 'Thanks for coming!', reasons: [] });
});

test('guardReply: each legacy check refuses with one reason, in legacy order', () => {
  const g = (text) => mk().guardReply({ platform: 'twitch', text });
  assert.deepEqual(g('').reasons, ['empty']);
  assert.deepEqual(g('   ').reasons, ['empty']);
  assert.deepEqual(g(undefined).reasons, ['empty']);
  assert.deepEqual(g('x'.repeat(121)).reasons, ['too-long']);
  assert.equal(g('x'.repeat(120)).ok, true);
  assert.deepEqual(g('a\nb').reasons, ['newline']);
  assert.deepEqual(g('a\u0001b').reasons, ['control-char']);
  assert.deepEqual(g('a\tb').reasons, ['control-char']);
  assert.deepEqual(g('please CLICK here').reasons, ['blocklist']);
  assert.deepEqual(g('see https://example.invalid').reasons, ['blocklist']);
  assert.deepEqual(g(`${'x'.repeat(121)}\n`).reasons, ['too-long']); // first failure wins
});

test('guardReply: refuses, never truncates', () => {
  const r = mk().guardReply({ platform: 'twitch', text: 'y'.repeat(300) });
  assert.equal(r.ok, false);
  assert.equal('text' in r, false);
});

test('guardReply: control check is stateless (the legacy /g regex quirk is not ported)', () => {
  const m = mk();
  assert.equal(m.guardReply({ platform: 'twitch', text: 'a\u0001b' }).ok, false);
  assert.equal(m.guardReply({ platform: 'twitch', text: '\u0001ab' }).ok, false);
  assert.equal(m.guardReply({ platform: 'twitch', text: '\u0001ab' }).ok, false);
});

test('guardReply: platform limit comes from data, counted in code points; unknown platform is refused', () => {
  const m = createModeration({ blocklist: { ...BL, policy: { echoWindowSec: 120, replyMaxChars: 1000 } }, limits: { ...LIMITS, twitch: { replyMaxChars: 10 } } });
  assert.equal(m.guardReply({ platform: 'twitch', text: 'x'.repeat(10) }).ok, true);
  assert.deepEqual(m.guardReply({ platform: 'twitch', text: 'x'.repeat(11) }).reasons, ['platform-limit']);
  // 10 emoji = 10 code points, 20 UTF-16 units: inside the platform limit
  assert.equal(m.guardReply({ platform: 'twitch', text: '😀'.repeat(10) }).ok, true);
  assert.deepEqual(m.guardReply({ platform: 'nowhere', text: 'hi' }).reasons, ['unknown-platform']);
  assert.equal(m.guardReply({ platform: 'local', text: 'hi' }).ok, true); // null limit = none
});

// ---- self-echo ----------------------------------------------------------------------------------
test('self-echo: window is strict (< 120 s), measured from the reply, as legacy', () => {
  let t = 1_000_000;
  const m = mk({ now: () => t });
  m.recordReply({ platform: 'twitch', text: 'Hello ViewerOne, welcome in.' });
  const at = (ms) => m.moderate(chat('Hello ViewerOne, welcome in.'), 1_000_000 + ms);
  assert.deepEqual(at(0).reasons, ['self-echo']);
  assert.deepEqual(at(119_999).reasons, ['self-echo']);
  assert.equal(at(120_000).action, 'pass');
  assert.equal(at(500_000).action, 'pass');
});

test('self-echo: matches normalised, case-insensitive text; author is ignored (legacy)', () => {
  const m = mk();
  m.recordReply({ platform: 'twitch', text: 'Hello ViewerOne, welcome in.', at: 10 });
  const v = m.moderate(chat('  hello​ VIEWERONE,   welcome in. ', { user: { displayName: 'SomeoneElse' } }), 20);
  assert.deepEqual(v.reasons, ['self-echo']);
  assert.equal(m.moderate(chat('Hello ViewerOne, welcome in. extra'), 20).action, 'pass');
});

test('self-echo: global by default (legacy); platform scope is an opt-in non-parity variant', () => {
  const m = mk({ echoScope: 'platform' });
  m.recordReply({ platform: 'twitch', text: 'Same words here.', at: 10 });
  assert.equal(m.moderate(chat('Same words here.'), 20).action, 'drop');
  assert.equal(m.moderate({ ...chat('Same words here.'), platform: 'youtube' }, 20).action, 'pass');
  const g = mk();
  g.recordReply({ platform: 'twitch', text: 'Same words here.', at: 10 });
  assert.equal(g.moderate({ ...chat('Same words here.'), platform: 'youtube' }, 20).action, 'drop');
});

test('self-echo: tracker prunes old entries and is bounded', () => {
  const e = createEchoTracker({ windowMs: 1000 });
  e.record('twitch', 'one', 0);
  e.record('twitch', 'two', 5000);
  assert.equal(e.size(), 1);
  const b = createEchoTracker({ windowMs: 1e12 });
  for (let i = 0; i < 1500; i++) b.record('twitch', `m${i}`, i);
  assert.equal(b.size(), 1000);
});

// ---- reply routing ------------------------------------------------------------------------------
test('planReply: a reply targets the platform and message of the event it answers', () => {
  const m = mk();
  for (const platform of ['twitch', 'youtube', 'kick']) {
    const r = m.planReply({ ...chat('hi'), platform, platformMessageId: 'abc' }, 'Thanks!');
    assert.equal(r.ok, true);
    assert.equal(r.platform, platform);
    assert.equal(r.replyTo, 'abc');
  }
  const bad = m.planReply(chat('hi'), 'click here');
  assert.equal(bad.ok, false);
  assert.equal(bad.platform, 'twitch');
});

// ---- committed data -----------------------------------------------------------------------------
const readJson = (p) => JSON.parse(readFileSync(path.join(repo, p), 'utf8'));

test('data: committed blocklist validates against its schema and carries source and date', () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const ok = ajv.compile(readJson('data/moderation/blocklist.schema.json'));
  const b = readJson('data/moderation/blocklist.json');
  assert.equal(ok(b), true, JSON.stringify(ok.errors));
  assert.equal(b.source, 'legacy');
  assert.equal(b.policy.echoWindowSec, 120);
  assert.ok(b.dropMessage.length > 0 && b.rejectReply.length > 0);
  for (const p of [...b.dropMessage, ...b.rejectReply]) assert.doesNotThrow(() => new RegExp(p, 'i'));
});

test('data: the committed blocklist holds no local overlay and the overlay file is ignored by git', () => {
  const ign = readFileSync(path.join(repo, '.gitignore'), 'utf8');
  assert.match(ign, /^\*\.local\.\*$/m);
  const { overlay } = loadBlocklistJson({ localFile: null });
  assert.equal(overlay, false);
});

test('data: local overlay is appended to the committed lists', () => {
  const d = tmp();
  const local = path.join(d, 'blocklist.local.json');
  writeFileSync(local, JSON.stringify({ dropMessage: ['\\bzzqq\\b'], dropUser: ['someonebot'] }));
  const m = createModeration({ blocklistLocalFile: local, limits: LIMITS });
  assert.equal(m.stats().overlay, true);
  assert.equal(m.moderate(chat('zzqq')).action, 'drop');
  assert.equal(m.moderate(chat('hi', { user: { displayName: 'SomeoneBot' } })).action, 'drop');
  assert.equal(m.moderate(chat('fuck')).action, 'drop'); // committed terms still apply
});

test('data: platform files carry replyMaxChars with a source and checked date, or are marked UNVERIFIED', () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const ok = ajv.compile(readJson('data/platforms/platform.schema.json'));
  const dir = path.join(repo, 'data', 'platforms');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json') && x !== 'platform.schema.json')) {
    const p = readJson(`data/platforms/${f}`);
    assert.equal(ok(p), true, `${f}: ${JSON.stringify(ok.errors)}`);
    const n = p.replyMaxChars;
    assert.ok(n, `${f}: replyMaxChars missing`);
    if (!n.unverified) {
      assert.match(n.checked, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(n.source);
    }
  }
  const lim = loadReplyLimits();
  assert.equal(lim.twitch.replyMaxChars, 500); assert.equal(lim.twitch.unverified, false);
  assert.equal(lim.kick.replyMaxChars, 500); assert.equal(lim.kick.unverified, false);
  assert.equal(lim.youtube.unverified, true);
  assert.equal(lim.local.replyMaxChars, null);
  assert.match(lim.twitch.source, /^https:\/\/dev\.twitch\.tv\//);
});

// ---- bus stage ----------------------------------------------------------------------------------
function core(extra = {}) {
  const verdicts = [];
  const c = createEventCore({
    key: Buffer.alloc(32, 9),
    moderation: { blocklistLocalFile: null },
    onVerdict: (event, verdict) => verdicts.push({ event, verdict }),
    ...extra,
  });
  const seen = [];
  c.bus.subscribe({ name: 'probe', handler: (e) => seen.push(e) });
  return { c, seen, verdicts };
}
const input = (text, over = {}) => ({
  kind: 'chat.message', platform: 'twitch', source: 'mock', platformMessageId: `m-${Math.random()}`,
  user: { platformUserId: 'u1', displayName: 'ViewerOne' }, text, ...over,
});

test('stage: clean chat reaches subscribers; blocked chat never does, and the verdict goes to onVerdict', async () => {
  const { c, seen, verdicts } = core();
  assert.equal(c.ingest(input('nice one')).status, 'published');
  const r = c.ingest(input('this is a scam'));
  assert.equal(r.status, 'dropped');
  assert.deepEqual(r.verdict.reasons, ['blocked']);
  await tick();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].text, 'nice one');
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].event.text, 'this is a scam'); // the audit hook sees the dropped event
  assert.equal(c.stats().moderated, 1);
  assert.equal(c.stats().published, 1);
});

test('stage: moderation runs after dedupe, so a duplicate is not counted twice', () => {
  const { c, verdicts } = core();
  const i = input('scam', { platformMessageId: 'same' });
  assert.equal(c.ingest(i).status, 'dropped');
  assert.equal(c.ingest(i).status, 'deduped'); // dedupe saw it first
  assert.equal(verdicts.length, 1);
});

test('stage: a flagged alert is published with the offending message removed', async () => {
  const { c, seen, verdicts } = core();
  const r = c.ingest({ kind: 'alert.sub', platform: 'twitch', source: 'mock', user: { platformUserId: 'u2', displayName: 'ViewerTwo' }, tier: '1000', message: 'visit https://example.invalid' });
  assert.equal(r.status, 'published');
  assert.deepEqual(r.verdict.reasons, ['blocked']);
  await tick();
  assert.equal(seen.length, 1);
  assert.equal('message' in seen[0], false);
  assert.equal(seen[0].tier, '1000');
  assert.ok(Object.isFrozen(seen[0]));
  assert.equal(verdicts[0].event.message, 'visit https://example.invalid');
});

test('stage: an unusable display name on an alert is replaced by "viewer"', async () => {
  const { c, seen } = core();
  c.ingest({ kind: 'alert.follow', platform: 'twitch', source: 'mock', user: { platformUserId: 'u3', displayName: '!!!' } });
  await tick();
  assert.equal(seen[0].user.displayName, 'viewer');
});

test('stage: a throwing onVerdict never breaks ingest', () => {
  const { c } = core({ onVerdict: () => { throw new Error('boom'); } });
  assert.equal(c.ingest(input('scam')).status, 'dropped');
  assert.equal(c.ingest(input('fine')).status, 'published');
});

test('stage: self-echo through the core, after recordReply', () => {
  const { c } = core();
  c.moderation.recordReply({ platform: 'twitch', text: 'Welcome in, ViewerOne!' });
  assert.deepEqual(c.ingest(input('welcome in, viewerone!')).verdict.reasons, ['self-echo']);
});

test('stage: moderation: false leaves the E1 behaviour', () => {
  const { c } = core({ moderation: false });
  assert.equal(c.ingest(input('scam')).status, 'published');
  assert.equal(c.moderation, null);
});

test('stage: system events pass untouched', () => {
  const { c } = core();
  assert.equal(c.ingest({ kind: 'system.connected', platform: 'local', source: 'system', target: 'streamerbot' }).status, 'published');
});
