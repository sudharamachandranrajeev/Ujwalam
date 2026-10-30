// SPDX-License-Identifier: GPL-2.0-or-later
// services/event-core/moderation text hygiene: normalise and cleanName (ported from legacy).
// All names are invented. Invisible characters are written as escapes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanName, normalise } from '../services/event-core/moderation/text.mjs';

const MALAYALAM = 'മലയാളി';
const HINDI = 'नमस्ते';
const TAMIL = 'தமிழ்';

test('normalise: zero-width and bidi characters are removed', () => {
  assert.equal(normalise('a​b‌‍‎‏c'), 'abc');
  assert.equal(normalise('‮abc‬'), 'abc');
  assert.equal(normalise('⁦x⁧y⁨z⁩'), 'xyz');
  assert.equal(normalise('﻿hello﻿'), 'hello');
});

test('normalise: C0 controls and DEL become spaces, whitespace collapses, ends trimmed', () => {
  assert.equal(normalise('a\u0000b\u001fc\u007fd'), 'a b c d');
  assert.equal(normalise('a\tb\nc\rd'), 'a b c d');
  assert.equal(normalise('   a    b   '), 'a b');
});

test('normalise: non-strings and empties give an empty string', () => {
  for (const v of [null, undefined, 0, '', '   ', false]) assert.equal(normalise(v), '');
  assert.equal(normalise(12), '12'); // legacy: String(12)
});

test('normalise: combining marks, scripts and emoji are kept', () => {
  assert.equal(normalise(MALAYALAM), MALAYALAM);
  assert.equal(normalise(`${HINDI} ${TAMIL}`), `${HINDI} ${TAMIL}`);
  assert.equal(normalise('ok 😀'), 'ok 😀');
});

test('normalise: C1 controls and the word joiner are NOT touched (legacy parity, listed as a gap)', () => {
  assert.equal(normalise('x\u0085y'), 'x\u0085y');
  assert.equal(normalise('a⁠b'), 'a⁠b');
});

test('cleanName: Malayalam, Hindi and Tamil names survive intact', () => {
  assert.equal(cleanName(MALAYALAM), MALAYALAM);
  assert.equal(cleanName(HINDI), HINDI);
  assert.equal(cleanName(TAMIL), TAMIL);
  assert.equal(cleanName(`${MALAYALAM} ${HINDI}`), `${MALAYALAM} ${HINDI}`);
});

test('cleanName: a mark run is capped at three, extra marks are cut', () => {
  assert.equal(cleanName(`a${'́'.repeat(8)}`), `a${'́'.repeat(3)}`);
  assert.equal(cleanName(`a${'́'.repeat(3)}`), `a${'́'.repeat(3)}`);
  assert.equal(cleanName(`a${'́'.repeat(2)}`), `a${'́'.repeat(2)}`);
  // Two separate runs are each capped.
  assert.equal(cleanName(`a${'́'.repeat(5)}b${'́'.repeat(5)}`), `a${'́'.repeat(3)}b${'́'.repeat(3)}`);
});

test('cleanName: leading marks are removed; a name of only marks is null', () => {
  assert.equal(cleanName(`${'́'.repeat(4)}abc`), 'abc');
  assert.equal(cleanName('́́́'), null);
});

test('cleanName: bidi override and zero-width are stripped', () => {
  assert.equal(cleanName('‮evil'), 'evil');
  assert.equal(cleanName('​a​b​'), 'ab');
  assert.equal(cleanName('⁦x⁩'), 'x');
});

test('cleanName: emoji and symbols are removed; emoji-only is null', () => {
  assert.equal(cleanName('cool 😀 name'), 'cool  name');
  assert.equal(cleanName('😀😀'), null);
  assert.equal(cleanName('n@me!#$'), 'nme');
  assert.equal(cleanName("O'Brien-Smith_1.0"), "O'Brien-Smith_1.0");
});

test('cleanName: control characters become spaces then collapse', () => {
  assert.equal(cleanName('a\u0000b'), 'a b');
  assert.equal(cleanName('a\nb'), 'a b');
});

test('cleanName: length cap is 22 UTF-16 units, then trimmed', () => {
  assert.equal(cleanName('x'.repeat(40)), 'x'.repeat(22));
  assert.equal(cleanName(`${'x'.repeat(21)} tail`), 'x'.repeat(21));
  assert.equal(cleanName('x'.repeat(22)).length, 22);
});

test('cleanName: empty, blank and non-string input is null', () => {
  for (const v of ['', '   ', null, undefined, '!!!']) assert.equal(cleanName(v), null);
});

test('cleanName: a name matching a drop pattern is null', () => {
  const rx = [/\bshit/i];
  assert.equal(cleanName('shit_head', rx), null);
  assert.equal(cleanName('fine_name', rx), 'fine_name');
});
