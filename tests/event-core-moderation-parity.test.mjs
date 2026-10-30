// SPDX-License-Identifier: GPL-2.0-or-later
// Moderation parity against the committed fixture (generated from the legacy pipeline by
// tools/parity/moderation-parity.mjs). Needs no legacy/ folder. Inputs are invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ujwalamVerdict } from '../tools/parity/moderation-ujwalam.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(readFileSync(path.join(repo, 'tests/fixtures/moderation/parity.json'), 'utf8'));
const GROUPS = ['normalise', 'cleanName', 'blockIn', 'guard', 'echo', 'pathText', 'pathBlock', 'pathEcho'];

test('parity fixture: records its legacy source hash and covers every group', () => {
  assert.match(fixture.generatedFrom.sha256, /^[0-9a-f]{64}$/);
  assert.equal(fixture.generatedFrom.file, 'engage/lib/pipeline.mjs');
  for (const g of GROUPS) assert.ok(fixture.cases[g].length >= 5, g);
});

test('parity fixture: the committed blocklist lists equal the legacy lists it was generated from', () => {
  const b = JSON.parse(readFileSync(path.join(repo, 'data/moderation/blocklist.json'), 'utf8'));
  const h = createHash('sha256')
    .update(JSON.stringify({ dropMessage: b.dropMessage, dropUser: b.dropUser, rejectReply: b.rejectReply })).digest('hex');
  assert.equal(h, fixture.generatedFrom.blocklistListsSha256);
});

for (const g of GROUPS) {
  test(`parity: ${g} gives the legacy verdict on every fixture case`, () => {
    for (const c of fixture.cases[g]) {
      const input = c.input && c.input.$undefined ? undefined : c.input;
      assert.deepEqual(ujwalamVerdict(g, input), c.legacy, `${g} ${c.id} ${JSON.stringify(c.input)}`);
    }
  });
}
