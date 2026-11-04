// SPDX-License-Identifier: GPL-3.0-or-later
// node:test reporter that prints one line when each test STARTS, so a hang shows the test that never finished.
// Used only by the cloud probe workflow (.github/workflows/ci.yml); the laptop CI does not use it.
//   node --test --test-reporter=./tools/test-start-reporter.mjs --test-reporter-destination=stdout <file>
export default async function* startReporter(source) {
  for await (const ev of source) {
    if (ev.type === 'test:start') yield `start: ${'  '.repeat(ev.data.nesting)}${ev.data.name}\n`;
  }
}
