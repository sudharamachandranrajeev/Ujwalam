// SPDX-License-Identifier: GPL-3.0-or-later
// Normal windows (D316, user 2026-11-09): the second-display / no-focus window rule is gone. Source checks only: the
// studio window and stand-alone previews are normal windows on the main display, embedded previews stay child
// windows, and headless still refuses every preview. No window is opened (the runtime refusal is in host-api.test.mjs;
// the console-window rule stays and is checked by the hidden-window lint).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(path.join(ROOT, p), 'utf8');
// The body of a C++ function from its signature line to the first line that is just "}" (top-level close).
function body(text, signature) {
  const at = text.indexOf(signature);
  assert.ok(at >= 0, `found: ${signature}`);
  const end = text.indexOf('\n}\n', at);
  return text.slice(at, end < 0 ? undefined : end);
}

test('host preview: no one-display refusal and no second-display pick (D316)', () => {
  const p = src('app/host/src/preview.cpp');
  assert.doesNotMatch(p, /"one display"\s*;|"no preview: "/);
  assert.doesNotMatch(p, /pick_display|internal_devices|"second display"|"laptop display"/);
  assert.doesNotMatch(p, /previews open only on a second display/);
  assert.match(p, /main_display\(\)/);
});

test('host preview: a stand-alone window is a normal window (no NOACTIVATE / TOOLWINDOW / SHOWNOACTIVATE)', () => {
  const p = src('app/host/src/preview.cpp');
  const open = body(p, 'json::Value Previews::open(const OpenArgs &a)');
  assert.doesNotMatch(open, /WS_EX_NOACTIVATE|WS_EX_TOOLWINDOW|SW_SHOWNOACTIVATE/);
  assert.match(open, /WS_OVERLAPPEDWINDOW/);
  assert.match(open, /SW_SHOWNORMAL/);
  const raise = body(p, 'void raise_window(HWND hwnd)');
  assert.doesNotMatch(raise, /SWP_NOACTIVATE|SW_SHOWNOACTIVATE/);
});

test('host preview: headless still refuses every preview; embedded previews stay child windows', () => {
  const p = src('app/host/src/preview.cpp');
  const open = body(p, 'json::Value Previews::open(const OpenArgs &a)');
  assert.match(open, /if \(headless_\)\s*throw rpc::Error\(rpc::CONFLICT, "headless/);
  assert.ok(open.indexOf('headless_') < open.indexOf('open_embedded'), 'headless is checked before the embedded path');
  const emb = body(p, 'json::Value Previews::open_embedded(const OpenArgs &a)');
  assert.match(emb, /WS_CHILD \| WS_CLIPSIBLINGS/);
  assert.match(p, /case WM_MOUSEACTIVATE:[^\n]*\n\s*if \(w && w->parent\)\s*return MA_NOACTIVATE;/);
});

test('host log line and launcher message name the main display, not a second display', () => {
  assert.match(src('app/host/src/main.cpp'), /"on \(normal windows, main display\)"/);
  const l = src('services/studio-ui/launch.mjs');
  assert.match(l, /w\.display \?\? 'main display'/);
  assert.doesNotMatch(l, /'second display'/);
});

test('studio window: shown and activated normally, no second-display move (D316 replaces D219)', () => {
  const m = src('app/studio/src/main.cpp');
  assert.doesNotMatch(m, /screens\.at\(1\)/);
  // The only WA_ShowWithoutActivating left is the headless offscreen probe (UJWALAM_STUDIO_PROBE_SHOW, tests).
  const uses = m.split('\n').filter((l) => l.includes('WA_ShowWithoutActivating'));
  assert.equal(uses.length, 1);
  const probe = m.indexOf('UJWALAM_STUDIO_PROBE_SHOW');
  assert.ok(probe >= 0 && m.indexOf('WA_ShowWithoutActivating') > probe, 'kept only inside the headless probe');
  assert.match(m, /win\.show\(\);[^\n]*\n\s*win\.raise\(\);\s*\n\s*win\.activateWindow\(\);/);
  const leave = body(src('app/studio/src/main_window.cpp'), 'void MainWindow::leaveTray()');
  assert.doesNotMatch(leave, /WA_ShowWithoutActivating/);
  assert.match(leave, /activateWindow\(\)/);
  assert.match(leave, /UJWALAM_HEADLESS/); // headless never shows it
});
