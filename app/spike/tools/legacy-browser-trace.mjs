// SPDX-License-Identifier: GPL-2.0-or-later
// Runs an overlay page in a headless Chrome/Chromium that is already installed, and records what
// the page draws, so a legacy overlay can be compared with the same page inside libobs.
// Node built-ins only (global WebSocket + fetch, Node 22+). Nothing is installed.
//
//   node legacy-browser-trace.mjs --chrome PATH --url URL --seconds 45 --profile DIR --out trace.json
//        [--frames-dir DIR [--shots 4]] [--size 1920x1080] [--port 9333]
//
// --profile must be a throwaway directory (the user's own browser profile is never used).
// Recorded, with performance.now() and wall-clock times:
//   wsIn    every Streamer.bot event the page receives, with the page's fired/dropped counters after it
//   frames  every canvas clearRect (one per animation frame while an effect runs): stroke count,
//           max globalAlpha, strokeStyle colours, the bounding box of the stroked paths, and how
//           many path points lie within 220 / 600 px of the nearest canvas edge
//   shots   up to --shots screenshots (640 px wide, black page background), one per effect,
//           saved to --frames-dir
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : d; };
const CHROME = arg('chrome');
const URL_ = arg('url');
const SECONDS = Number(arg('seconds', 30));
const PROFILE = arg('profile');
const OUT = arg('out', 'trace.json');
const FRAMES = arg('frames-dir', '');
const PORT = Number(arg('port', 9333));
const [VW, VH] = arg('size', '1920x1080').split('x').map(Number);
if (!CHROME || !URL_ || !PROFILE) { console.error('need --chrome --url --profile'); process.exit(1); }

const INSTRUMENT = `(() => {
  const T = window.__trace = { t0wall: Date.now(), t0perf: performance.now(), wsIn: [], frames: [] };
  const P = CanvasRenderingContext2D.prototype;
  const o = { begin: P.beginPath, move: P.moveTo, line: P.lineTo, stroke: P.stroke, clear: P.clearRect };
  let cur = null, bb = null, pts = null;
  // bbox of the current path, and its points' distance to the nearest canvas edge (<=220 / <=600 px)
  const ext = (ctx, x, y) => { if (!bb) bb = [Infinity, Infinity, -Infinity, -Infinity];
    if (x < bb[0]) bb[0] = x; if (y < bb[1]) bb[1] = y; if (x > bb[2]) bb[2] = x; if (y > bb[3]) bb[3] = y;
    if (!pts) pts = { n: 0, p220: 0, p600: 0 };
    const e = Math.max(0, Math.min(x, y, ctx.canvas.width - x, ctx.canvas.height - y));
    pts.n++; if (e <= 220) pts.p220++; if (e <= 600) pts.p600++; };
  P.beginPath = function () { bb = null; pts = null; return o.begin.apply(this, arguments); };
  P.moveTo = function (x, y) { ext(this, x, y); return o.move.apply(this, arguments); };
  P.lineTo = function (x, y) { ext(this, x, y); return o.line.apply(this, arguments); };
  P.clearRect = function () {
    cur = { t: performance.now(), strokes: 0, maxAlpha: 0, colors: {}, bb: null, pts: 0, p220: 0, p600: 0, cw: this.canvas.width, ch: this.canvas.height };
    T.frames.push(cur);
    return o.clear.apply(this, arguments);
  };
  P.stroke = function () {
    if (cur) {
      if (cur.strokes === 0) { const prev = T.frames[T.frames.length - 2]; if (!prev || prev.strokes === 0) T.effStart = cur.t; }
      cur.strokes++;
      // each run is stroked twice (glow, then core): count its points once, on the glow pass
      if (pts && cur.strokes % 2 === 1) { cur.pts += pts.n; cur.p220 += pts.p220; cur.p600 += pts.p600; }
      if (this.globalAlpha > cur.maxAlpha) cur.maxAlpha = this.globalAlpha;
      const c = String(this.strokeStyle); cur.colors[c] = (cur.colors[c] || 0) + 1;
      if (bb) cur.bb = cur.bb ? [Math.min(cur.bb[0], bb[0]), Math.min(cur.bb[1], bb[1]), Math.max(cur.bb[2], bb[2]), Math.max(cur.bb[3], bb[3])] : bb.slice();
    }
    return o.stroke.apply(this, arguments);
  };
  const OWS = window.WebSocket;
  function WS(url, p) {
    const ws = p === undefined ? new OWS(url) : new OWS(url, p);
    ws.addEventListener('message', (e) => {
      let m; try { m = JSON.parse(e.data); } catch (_) { return; }
      if (!m.event) return;
      const rec = { t: performance.now(), wall: Date.now(), id: m.data && m.data.messageId };
      T.wsIn.push(rec);
      setTimeout(() => { const S = window.RPCharge && window.RPCharge.state; if (S) { rec.fired = S.fired; rec.dropped = S.dropped; rec.last = S.last; } }, 0);
    });
    return ws;
  }
  WS.prototype = OWS.prototype;
  WS.CONNECTING = 0; WS.OPEN = 1; WS.CLOSING = 2; WS.CLOSED = 3;
  window.WebSocket = WS;
})();`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, `--window-size=${VW},${VH}`,
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync',
  '--disable-extensions', '--disable-component-update', '--disable-default-apps', '--mute-audio', '--hide-scrollbars',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  'about:blank'
], { stdio: 'ignore' });

let target = null;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page'); } catch { /* not up yet */ }
}
if (!target) { console.error('chrome devtools not reachable'); chrome.kill(); process.exit(2); }
const versionInfo = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let nextId = 1;
const pending = new Map();
const shots = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Page.screencastFrame') {
    shots.push({ wall: Math.round(m.params.metadata.timestamp * 1000), data: m.params.data });
    ws.send(JSON.stringify({ id: nextId++, method: 'Page.screencastFrameAck', params: { sessionId: m.params.sessionId } }));
  }
};
const cdp = (method, params = {}) => new Promise((r) => { const id = nextId++; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });

await cdp('Page.enable');
await cdp('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 1, mobile: false });
await cdp('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 1 } });
await cdp('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT });
await cdp('Page.navigate', { url: URL_ });
console.log(JSON.stringify({ ev: 'tracing', browser: versionInfo.Browser, url: URL_, seconds: SECONDS }));
// Headless screencast sends no frames for this page, so --frames-dir takes up to --shots
// screenshots instead: polled every 40 ms, one per effect, once the effect is 60-200 ms old.
const SHOTS = FRAMES ? Number(arg('shots', 4)) : 0;
const endAt = Date.now() + SECONDS * 1000;
let lastShotEff = null;
while (Date.now() < endAt) {
  if (shots.length < SHOTS) {
    const r = await cdp('Runtime.evaluate', { expression: '(() => { const T = window.__trace; if (!T || T.effStart == null) return null; const f = T.frames[T.frames.length - 1]; return { eff: T.effStart, age: performance.now() - T.effStart, drawing: !!(f && f.strokes) }; })()', returnByValue: true });
    const v = r.result && r.result.result && r.result.result.value;
    if (v && v.drawing && v.eff !== lastShotEff && v.age >= 60 && v.age <= 200) {
      lastShotEff = v.eff;
      const s = await cdp('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: VW, height: VH, scale: 640 / VW } });
      shots.push({ wall: Date.now(), age: Math.round(v.age), data: s.result.data });
    }
  }
  await sleep(40);
}
const res = await cdp('Runtime.evaluate', { expression: 'JSON.stringify(window.__trace)', returnByValue: true });
const trace = JSON.parse(res.result.result.value);
trace.browser = versionInfo.Browser;
trace.url = URL_;
trace.shots = [];
if (FRAMES && shots.length) {
  mkdirSync(FRAMES, { recursive: true });
  shots.forEach((s, i) => { s.file = join(FRAMES, `legacy-shot-${i + 1}-age${s.age}ms.png`); writeFileSync(s.file, Buffer.from(s.data, 'base64')); });
  trace.shots = shots.map((s) => ({ wall: s.wall, age: s.age, file: s.file }));
}
writeFileSync(OUT, JSON.stringify(trace));
console.log(JSON.stringify({ ev: 'done', wsIn: trace.wsIn.length, frames: trace.frames.length, shots: shots.length, out: OUT }));
try { await cdp('Browser.close'); } catch { /* closing */ }
ws.close();
setTimeout(() => { try { chrome.kill(); } catch { /* gone */ } process.exit(0); }, 500);
