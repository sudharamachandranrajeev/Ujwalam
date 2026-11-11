// SPDX-License-Identifier: GPL-3.0-or-later
// Headless guard for embedded previews (LU4, Codex review of D346), against a real host (libobs, headless, no devices,
// no outputs). A headless host embeds a preview only into a parent whose top-level window is hidden, and the preview's
// own window never gets WS_VISIBLE, so it stays unseen even if that parent is shown later (a child window is visible
// only with its own WS_VISIBLE set). preview.testParent (--test-hooks) makes a hidden top-level window to embed into
// (never shown: off every display, no WS_VISIBLE) and tries the three ways to show the child. No window is ever shown.
//   node --test app/host/tests/host-preview-headless.test.mjs   (needs the built host and the OBS runtime)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { launchHost, stopHost } from '../lib/launch.mjs';
import { REPO_ROOT } from '../lib/config.mjs';

const OUT = path.join(REPO_ROOT, 'out', 'host', 'tests');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let h;
let c;

before(async () => {
  mkdirSync(OUT, { recursive: true });
  h = await launchHost({ dataDir: mkdtempSync(path.join(OUT, 'pheadless-')), extraArgs: ['--test-hooks', '--headless'], env: { UJWALAM_HEADLESS: '1' } });
  c = h.client;
});

after(async () => {
  if (!h) return;
  const r = await stopHost(h);
  assert.equal(r.code, 0, 'host exits 0');
});

test('headless: a stand-alone preview is refused; an embedded one is never shown, whatever tries to show it', async () => {
  await assert.rejects(c.call('preview.open', { canvas: 'H' }), /headless/);
  const { parent } = await c.call('preview.testParent', { action: 'create' });
  assert.match(parent, /^\d+$/);
  const opened = await c.call('preview.open', { canvas: 'H', parent, x: 0, y: 0, width: 320, height: 180 });
  assert.equal(opened.open, true);
  assert.equal(opened.shown, false, 'the embedded preview window has no WS_VISIBLE of its own');
  assert.equal(opened.visible, false);
  // Something else showing the child on purpose (nothing in Ujwalam does): while the parent is hidden, Windows may set
  // WS_VISIBLE without a WM_WINDOWPOSCHANGING or WM_STYLECHANGING the window could refuse; the refresh timer (200 ms)
  // takes it away again. The value right after each call is printed, the one after the timer asserted.
  for (const action of ['show-child', 'setpos-child', 'style-child']) {
    const r = await c.call('preview.testParent', { action, canvas: 'H' });
    console.log(`# ${action}: shown right after = ${r.shown}`);
    await sleep(600);
    const now = (await c.call('preview.list')).previews.find((p) => p.canvas === 'H');
    assert.equal(now.open, true, `${action}: the preview stays embedded`);
    assert.equal(now.shown, false, `${action}: no WS_VISIBLE on the embedded preview after the refresh timer`);
  }
  await c.call('preview.close', { canvas: 'H' });
  await c.call('preview.testParent', { action: 'destroy' });
});

test('preview.testParent is a test hook: a host without --test-hooks refuses it', async () => {
  const plain = await launchHost({ dataDir: mkdtempSync(path.join(OUT, 'pheadless-plain-')), extraArgs: ['--headless'], env: { UJWALAM_HEADLESS: '1' } });
  try {
    await assert.rejects(plain.client.call('preview.testParent', { action: 'create' }), /test-hooks/);
  } finally {
    assert.equal((await stopHost(plain)).code, 0);
  }
});
