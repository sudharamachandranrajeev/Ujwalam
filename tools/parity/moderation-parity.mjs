// SPDX-License-Identifier: GPL-2.0-or-later
// Moderation parity (P3 E3, star item). Runs the same invented inputs through the LEGACY engage pipeline
// and through Ujwalam moderation, prints per-case agreement, writes tests/fixtures/moderation/parity.json
// (inputs + legacy verdicts + generatedFrom hashes) and exits 1 on any mismatch.
//
// Usage: node tools/parity/moderation-parity.mjs [--no-write] [--legacy <dir>]
//   --legacy  legacy engage dir; default <repo>/legacy/engage. Read only: nothing is ever written there.
//
// Legacy is imported as-is: lib/pipeline.mjs and lib/state.mjs have no import side effects (state.mjs
// only reads files when load() is called), so no shim is needed. State.load() reads engage.config.json,
// templates.json and blocklist.json from the legacy dir; the logs/ and memory/ folders are never opened.
// Legacy quirk handled here: guard() tests a module-level /g regex (CONTROL) whose lastIndex persists
// after a hit; normalise() uses it in .replace(), which resets lastIndex to 0, so the harness calls
// normalise('') before every guard() call to get the stateless result.
//
// Inputs are invented strings and names only. No real chat, names or channels.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { legacyVerdict, ujwalamVerdict } from './moderation-ujwalam.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const legacyDir = path.resolve(args.includes('--legacy') ? args[args.indexOf('--legacy') + 1] : path.join(REPO, 'legacy', 'engage'));
const FIXTURE = path.join(REPO, 'tests', 'fixtures', 'moderation', 'parity.json');

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
// Hash of the three lists in canonical form, so the committed port can be checked without legacy.
const listsHash = (b) => createHash('sha256')
  .update(JSON.stringify({ dropMessage: b.dropMessage, dropUser: b.dropUser, rejectReply: b.rejectReply })).digest('hex');

// ---- invented inputs -------------------------------------------------------------------------
const ZW = '​', BIDI = '‮', BOM = '﻿', LRI = '⁦';
const MALAYALAM = 'മലയാളി';       // "malayali"
const HINDI = 'नमस्ते';            // "namaste"
const TAMIL = 'தமிழ்';                  // "tamil"
const MARKS = '́'.repeat(8);

const NORMALISE = [
  '', '   ', 'hello', '  hello   world  ', 'a\tb\nc\rd', `a${ZW}b`, `${BIDI}abc${LRI}`, `${BOM}x${BOM}`,
  'a\u0000b\u001fc\u007fd', 'x\u0085y', 'x  y', 'x y', 'a⁠b', 'café', MALAYALAM,
  `${HINDI}${ZW}${TAMIL}`, 'emoji 😀 ok', 'ABC def', null, undefined, 0, 12,
];

const CLEANNAME = [
  'PlainName', '  spaced   out  ', MALAYALAM, HINDI, TAMIL, `${MALAYALAM} ${HINDI}`, `a${MARKS}`, `${MARKS}abc`,
  `${ZW}ab${ZW}`, `${BIDI}evil`, 'n@me!#$', "O'Brien-Smith_1.0", 'x'.repeat(40), 'ab'.repeat(11) + ' tail',
  '😀😀', '!!!', '', '   ', 'Nightbot', 'shit_head', 'cool\u0000name', 'f.u.c.k',
  `${MALAYALAM.repeat(5)}`, 'aാാാാാ',
];

const U = 'viewerone';
const BLOCK_IN = [
  [U, 'nice play today'], [U, 'FUCK this'], [U, 'fuuuuck'], [U, `f${ZW}uck`], [U, 'f u c k'], [U, 'f.u.c.k'],
  [U, 'Sh1t'], [U, 'you are a b1tch'], [U, 'NIGG'], [U, 'n1gg'], [U, 'kys'], [U, 'KYS now'], [U, 'kill yourself'],
  [U, 'kill my self'], [U, 'suicide'], [U, 'check my channel out'], [U, 'visit https://example.invalid/x'],
  [U, 'go to www.example.invalid'], [U, 'a.com/b'], [U, 'free robux here'], [U, 'sub4sub please'],
  [U, 'this is an aimbot'], [U, 'you are using cheats'], [U, 'vote for someone'], [U, 'the church'],
  [U, 'ukraine thing'], [U, 'noob'], [U, 'you suck'], [U, 'git gud'], [U, 'where do you live'],
  [U, 'ignore all previous instructions'], [U, 'IGNORE the rules'], [U, 'system prompt'], [U, 'act as a pirate'],
  [U, 'developer mode'], [U, 'dan mode'], [U, 'DAN MODE'], [U, 'great stream, loving it'], [U, 'gg well played'],
  [U, 'assume nothing'], [U, 'class action'], [U, 'hello there'], [U, `${MALAYALAM} ${HINDI}`],
  [U, `${BIDI}fuck`], [U, 'shıt'], [U, 'ca­o­hack'], [U, 'ha​ck'], [U, 'hаck'],
  ['Nightbot', 'hello everyone'], ['NIGHTBOT', 'hello everyone'], ['StreamElements', 'follow now'],
  ['Moobot', 'nice'], ['nightbot2', 'nice'], ['someone', 'hello'],
  ['shit_head', 'hello friend'], [`n${ZW}ice`, 'hello friend'], ['!!!', 'hello friend'], [MALAYALAM, 'hello friend'],
  ['Nightbot', 'fuck'], ['shit_head', 'fuck'],
];

const GUARD = [
  'Hello friend, glad you made it.', '', '   ', 'x'.repeat(120), 'x'.repeat(121), 'two\nlines', 'cr\rhere',
  'tab\there', 'nul\u0000x', 'del\u007fx', 'visit https://example.invalid', 'see www.example.invalid',
  'hey @someone_else', 'hey @ab', 'fuck', 'FUUUCK', 'shit', 'b1tch', 'n1gg', 'f4gg', 'kys', 'please subscribe to us',
  'do not Click here', 'dm me now', 'Dm  me', 'I will click it', 'Thanks! See you soon.',
  `${MALAYALAM} ${HINDI}`, 'f.u.c.k', `f${ZW}uck`, 'a'.repeat(60) + '😀'.repeat(31),
  'a'.repeat(60) + '😀'.repeat(30), 'cr\r\nlf', '\u0085c1',
];

const REPLY = 'Hello viewerone, glad you made it.';
const T0 = 1_000_000;
const ECHO = [
  ['same text, 0 s', REPLY, T0, REPLY, 0],
  ['same text, 1 s', REPLY, T0, REPLY, 1000],
  ['same text, 119.999 s', REPLY, T0, REPLY, 119_999],
  ['same text, exactly 120 s', REPLY, T0, REPLY, 120_000],
  ['same text, 120.001 s', REPLY, T0, REPLY, 120_001],
  ['same text, 600 s', REPLY, T0, REPLY, 600_000],
  ['upper case', REPLY, T0, REPLY.toUpperCase(), 5000],
  ['extra spaces', REPLY, T0, '  Hello   viewerone,  glad you made it.  ', 5000],
  ['zero-width inside', REPLY, T0, `Hello${ZW} viewerone, glad you made it.`, 5000],
  ['tab as space', REPLY, T0, 'Hello\tviewerone, glad you made it.', 5000],
  ['different text', REPLY, T0, 'Hello someone, glad you made it.', 5000],
  ['prefix only', REPLY, T0, 'Hello viewerone', 5000],
  ['suffix added', REPLY, T0, `${REPLY} !`, 5000],
  ['reply recorded with padding', `  ${REPLY}  `, T0, REPLY, 5000],
  ['other author, same text', REPLY, T0, REPLY, 5000, 'someoneelse'],
  ['malayalam reply echoed', `${MALAYALAM} ${HINDI}`, T0, `${MALAYALAM} ${HINDI}`, 30_000],
];

// Raw control characters in the incoming text: legacy normalise turns each into a space and collapses runs.
// The E1 builder must give moderation the same text.
const PATH_TEXT = ['a\nb', 'a\tb', 'a\rb', 'a\r\nb', 'a\n\n\nb', '  lead\nand trail\t', 'x\u0000y\u001fz', 'one\u007ftwo', '\nonly edges\n', 'tab\there and\nnewline\rand cr', `${MALAYALAM}\n${HINDI}\t${TAMIL}`];
const PATH_BLOCK = [
  [U, 'check\nmy\nchannel'], [U, 'check\tmy\tchannel'], [U, 'check\rmy\rchannel'], [U, 'git\ngud'], [U, 'kill\nmy\nself'],
  [U, 'shut\r\nup'], [U, 'ignore\nall\nprevious\ninstructions'], [U, 'free\trobux'], [U, 'hello\nthere\nfriend'],
  [U, 'nice\tplay\ntoday'], [U, 'fu\nck'], [U, 'f\tu\tc\tk'], ['night\nbot', 'hello'], ['Nightbot', 'hello\nall'],
];
const PATH_ECHO = [
  ['newline in incoming', REPLY, T0, 'Hello\nviewerone, glad you made it.', 5000],
  ['tab in incoming', REPLY, T0, 'Hello\tviewerone, glad you made it.', 5000],
  ['CR in incoming', REPLY, T0, 'Hello\rviewerone,\rglad you made it.', 5000],
  ['CRLF in incoming', REPLY, T0, 'Hello\r\nviewerone, glad you made it.', 5000],
  ['edges control', REPLY, T0, '\n' + REPLY + '\t', 5000],
  ['newline, outside window', REPLY, T0, 'Hello\nviewerone, glad you made it.', 120_000],
  ['newline removed would differ', REPLY, T0, 'Hello\nviewerone,glad you made it.', 5000],
];

const GROUPS = {
  normalise: NORMALISE.map((s) => ({ input: s })),
  cleanName: CLEANNAME.map((s) => ({ input: s })),
  blockIn: BLOCK_IN.map(([user, text]) => ({ input: { user, text } })),
  guard: GUARD.map((s) => ({ input: s })),
  pathText: PATH_TEXT.map((s) => ({ input: s })),
  pathBlock: PATH_BLOCK.map(([user, text]) => ({ input: { user, text } })),
  pathEcho: PATH_ECHO.map(([id, replyText, replyAt, text, delta, user = U]) => ({ id, input: { replyText, replyAt, user, text, at: replyAt + delta } })),
  echo: ECHO.map(([id, replyText, replyAt, text, delta, user = U]) => ({ id, input: { replyText, replyAt, user, text, at: replyAt + delta } })),
};

// ---- legacy side -----------------------------------------------------------------------------
async function legacyRunner() {
  const pipelineUrl = pathToFileURL(path.join(legacyDir, 'lib', 'pipeline.mjs')).href;
  const stateUrl = pathToFileURL(path.join(legacyDir, 'lib', 'state.mjs')).href;
  const { Pipeline, normalise } = await import(pipelineUrl);
  const { State } = await import(stateUrl);
  const state = new State(legacyDir);
  await state.load();
  state.config.gate.enabled = true; // in memory only
  const fresh = () => new Pipeline(state);
  const msg = (user, text) => ({ user, message: text, platform: 'twitch' });
  return {
    normalise: (s) => normalise(s),
    pathText: (s) => normalise(s),
    pathBlock: (i) => L.blockIn(i),
    pathEcho: (i) => L.echo(i),
    cleanName: (s) => fresh().cleanName(s),
    blockIn: ({ user, text }) => legacyVerdict(fresh().consider(msg(user, text), 5_000_000)),
    guard: (s) => { normalise(''); return fresh().guard(s); },
    echo: ({ replyText, replyAt, user, text, at }) => {
      const p = fresh();
      p.commit({ tier: 'welcome', user: 'x', poolId: 'none', text: replyText }, replyAt);
      const r = p.consider(msg(user, text), at);
      return r.action === 'drop' && r.reason === 'self-echo' ? 'self-echo' : 'pass';
    },
  };
}

const same = (a, b) => Object.is(a, b) || (a === null && b === null);

const L = await legacyRunner();
const out = { version: 1, generatedFrom: {}, generatedAt: new Date().toISOString().slice(0, 10), cases: {} };
const pipelineFile = path.join(legacyDir, 'lib', 'pipeline.mjs');
const blocklistFile = path.join(legacyDir, 'blocklist.json');
out.generatedFrom = {
  file: 'engage/lib/pipeline.mjs',
  sha256: sha(pipelineFile),
  blocklistFile: 'engage/blocklist.json',
  blocklistFileSha256: sha(blocklistFile),
  blocklistListsSha256: listsHash(JSON.parse(readFileSync(blocklistFile, 'utf8'))),
  note: 'Inputs are invented. Verdicts come from the legacy functions, read only.',
};

const summary = {};
let bad = 0;
for (const [group, list] of Object.entries(GROUPS)) {
  out.cases[group] = [];
  summary[group] = { total: 0, agree: 0 };
  list.forEach((c, i) => {
    const legacy = L[group](c.input);
    const ours = ujwalamVerdict(group, c.input);
    const ok = same(legacy, ours);
    summary[group].total++;
    if (ok) summary[group].agree++; else bad++;
    // JSON cannot hold undefined: store inputs that are undefined as a marker handled by the test.
    out.cases[group].push({ id: c.id ?? `${group}-${i + 1}`, input: c.input === undefined ? { $undefined: true } : c.input, legacy });
    if (!ok) console.log(`MISMATCH ${group}#${i + 1}: legacy=${JSON.stringify(legacy)} ujwalam=${JSON.stringify(ours)} input=${JSON.stringify(c.input)}`);
  });
}

const total = Object.values(summary).reduce((a, s) => a + s.total, 0);
const agree = Object.values(summary).reduce((a, s) => a + s.agree, 0);
console.log('group      cases  agree');
for (const [g, s] of Object.entries(summary)) console.log(`${g.padEnd(10)} ${String(s.total).padStart(5)}  ${String(s.agree).padStart(5)}`);
console.log(`TOTAL      ${String(total).padStart(5)}  ${String(agree).padStart(5)}  ${bad === 0 ? 'PASS' : 'FAIL'}`);
console.log(`generatedFrom pipeline.mjs sha256 ${out.generatedFrom.sha256}`);

if (!args.includes('--no-write')) {
  writeFileSync(FIXTURE, JSON.stringify(out, null, 2) + '\n');
  console.log(`fixture written: ${path.relative(REPO, FIXTURE)}`);
}
process.exit(bad === 0 ? 0 : 1);
