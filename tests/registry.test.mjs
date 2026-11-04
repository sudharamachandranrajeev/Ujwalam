// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRegistry, satisfies } from '../tools/registry-validate.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(repo, 'tests', 'fixtures', 'registry');

// Build a temp registry: real schemas + fixtures/base + optional case overlay.
function build(caseName) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ujw-reg-'));
  cpSync(path.join(repo, 'registry', 'schema'), path.join(dir, 'schema'), { recursive: true });
  cpSync(path.join(fixtures, 'base'), dir, { recursive: true });
  if (caseName) cpSync(path.join(fixtures, 'cases', caseName), dir, { recursive: true });
  return dir;
}

function run(caseName) {
  const dir = build(caseName);
  try {
    return validateRegistry(dir, repo).map((e) => e.message);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('real registry passes', () => {
  const errors = validateRegistry(path.join(repo, 'registry'), repo);
  assert.deepEqual(errors, []);
});

test('base fixture passes', () => {
  assert.deepEqual(run(null), []);
});

const cases = [
  ['function-flash-over-limit', /flashesPerSec must be <= 3/],
  ['function-bad-canvas', /canvases/],
  ['preset-missing-function', /function "nope" does not exist/],
  ['preset-version-unsatisfied', /functionVersion "\^2\.0\.0" is not satisfied/],
  ['preset-bad-tag', /tag motion="wobble" is not in the tag vocabulary/],
  ['preset-canvas-not-in-function', /preset canvas "V" not in function canvases/],
  ['preset-legacy-missing', /legacySource "legacy\/does-not-exist\.txt" does not exist on disk/],
  ['preset-parity-without-source', /required property 'legacySource'/],
  ['pool-missing-preset', /pool preset "ghost" does not exist/],
  ['pool-zero-weight', /weight|> 0/],
  ['duplicate-preset-id', /duplicate preset id "px"/],
];
for (const [name, re] of cases) {
  test(`rejects: ${name}`, () => {
    const messages = run(name);
    assert.ok(messages.length > 0, 'expected errors');
    assert.ok(messages.some((m) => re.test(m)), `no message matched ${re}; got:\n${messages.join('\n')}`);
  });
}

test('semver ranges', () => {
  assert.ok(satisfies('1.2.3', '1.2.3'));
  assert.ok(!satisfies('1.2.4', '1.2.3'));
  assert.ok(satisfies('1.9.0', '^1.2.3'));
  assert.ok(!satisfies('2.0.0', '^1.2.3'));
  assert.ok(!satisfies('1.2.2', '^1.2.3'));
  assert.ok(satisfies('0.1.9', '^0.1.0'));
  assert.ok(!satisfies('0.2.0', '^0.1.0'));
  assert.ok(satisfies('1.2.9', '~1.2.3'));
  assert.ok(!satisfies('1.3.0', '~1.2.3'));
  assert.ok(satisfies('3.0.0', '>=1.2.3'));
  assert.ok(!satisfies('1.2.2', '>=1.2.3'));
});
