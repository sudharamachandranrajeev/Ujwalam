// SPDX-License-Identifier: GPL-3.0-or-later
// Supervisor slots for swappable services (LU3, D337). Node stdlib only.
//
// A slot owns one service: its current process, the root (install folder) it runs from, and swap(root), which runs
// the state machine of swap.mjs with steps for that service. The caller (services/studio-ui/launch.mjs, the soak and
// the tests) gives the slot a spawn function, so this file never decides argv, environment or tokens.
//
//   createEventCoreSlot: side-by-side through a front (front.mjs). New core in standby (--standby), health-checked
//     over its own API (core.status with the system token: standby, Streamer.bot connected when the old one is), then
//     inside the front's switch: old `swap:handoff`, new `swap:activate {idFloor, live, remotePort}`; streams carried,
//     held requests sent to the new one; old `swap:exit`. A new core that fails before the hand-over is stopped and
//     the old one never notices (kept-old). One that fails during it: the old core is activated again (restored-old).
//   createUiSlot: side-by-side through a front. New studio-ui server started, health-checked (HTTP answers), login
//     sessions copied over IPC inside the front's switch (prepare), its event streams opened, the old one's cut, old
//     process stopped. The go-live authority stays in the launcher (stream-recovery.mjs) and carries over by itself.
//   createWorkerSlot: stop-start (two clip workers would save every clip twice; the face link is one per host; VRAM).
//     The old worker stops (its exit is planned, not a crash), the new one starts and must stay up healthMs; if not,
//     the old version starts again.
//   createStudioSlot (LU4, D346): stop-start for the Qt studio window. Two windows never run at once (no second tray
//     icon, no second set of previews). The old window gets "swap-close" on its control pipe (exit 75, no quit lock:
//     the launcher keeps the host and every output), a new one-time login key goes to the UI server (rearm), the new
//     exe starts, logs in and must print "studio attach: ready" and re-embed every preview the old one had; if not,
//     the old version is started again.
//
// Every slot reports an exit nobody asked for through onUnexpectedExit(child, code), so the launcher can treat it like
// before (end the session, or its own restart rules).

import { randomBytes } from 'node:crypto';
import http from 'node:http';
import readline from 'node:readline';
import { killChildTree } from '../common/kill-tree.mjs';
import { HandoverRefused, runSwap, throwIfAborted } from './swap.mjs';

const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

/** Line reader on a child's stdout: every line goes to onLine; waitFor(re, ms) resolves the first match from now on. */
export function lineReader(child, onLine = () => {}) {
  const waiters = new Set();
  let exited = false;
  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (l) => {
    onLine(l);
    for (const w of [...waiters]) { const m = w.re.exec(l); if (m) { waiters.delete(w); clearTimeout(w.t); w.resolve(m); } }
  });
  child.once('exit', (code) => {
    exited = true;
    for (const w of [...waiters]) { waiters.delete(w); clearTimeout(w.t); w.reject(new Error(`the process exited (${code}) before "${w.what}"`)); }
  });
  return {
    waitFor(re, ms, what = String(re)) {
      if (exited) return Promise.reject(new Error(`the process has exited before "${what}"`));
      return new Promise((resolve, reject) => {
        const w = { re, resolve, reject, what, t: setTimeout(() => { waiters.delete(w); reject(new Error(`no "${what}" within ${ms} ms`)); }, ms) };
        w.t.unref?.();
        waiters.add(w);
      });
    },
  };
}

/** One JSON-RPC call on an event-core API port (node:http, never fetch: the core refuses Sec-Fetch headers). */
export function coreRpc(port, token, method, params = {}, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/rpc', agent: false, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
      let t = ''; res.setEncoding('utf8'); res.on('data', (d) => { t += d; });
      res.on('end', () => { try { const j = JSON.parse(t); if (j.error) reject(new Error(`rpc ${method}: ${j.error.message ?? j.error.code}`)); else resolve(j.result); } catch { reject(new Error(`rpc ${method}: HTTP ${res.statusCode}`)); } });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

function httpStatus(port, path = '/', timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, agent: false, headers: { host: `127.0.0.1:${port}` } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

/** Stops a child: a polite line first (when given), then the whole process tree after graceMs. Resolves its exit code. */
async function stopChild(child, { line = null, graceMs = 5000 } = {}) {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  const exited = new Promise((r) => child.once('exit', (c) => r(c)));
  if (line && child.stdin?.writable) { try { child.stdin.write(`${line}\n`); } catch { /* gone */ } }
  else killChildTree(child);
  const first = await Promise.race([exited, sleep(graceMs).then(() => undefined)]);
  if (first !== undefined) return first;
  killChildTree(child);
  return Promise.race([exited, sleep(5000).then(() => null)]);
}

// Common slot plumbing: current process, planned exits, the swap lock and history.
function slotBase({ name, onUnexpectedExit, onSpawn, onGone, log }) {
  const planned = new WeakSet();
  const st = { name, current: null, root: null, busy: false, swaps: [], log: log ?? (() => {}) };
  st.track = (child) => {
    onSpawn?.(child);
    child.once('exit', (code, signal) => {
      onGone?.(child);
      if (planned.has(child)) return;
      if (child === st.current?.child) onUnexpectedExit?.(child, code, signal);
    });
  };
  st.plan = (child) => { if (child) planned.add(child); };
  st.isPlanned = (child) => planned.has(child);
  st.unplan = (child) => { if (child) planned.delete(child); };
  st.run = async (root, mode, steps, timeouts) => {
    if (st.busy) return { result: 'refused', reason: 'another swap is running; one at a time' };
    st.busy = true;
    try {
      const r = await runSwap({ mode, steps, timeouts, onState: (s, a) => st.log(`[swap ${name}] ${s}${a ? ` -> ${a}` : ''}`) });
      st.swaps.push({ at: new Date().toISOString(), root, result: r.result, ms: r.ms });
      if (st.swaps.length > 100) st.swaps.shift();
      st.log(`[swap ${name}] ${r.result} in ${r.ms} ms${r.result === 'swapped' ? '' : ` (${r.history.filter((h) => !h.ok).map((h) => `${h.action}: ${h.error}`).join('; ')})`}`);
      return r;
    } finally { st.busy = false; st.afterRun?.(); }
  };
  return st;
}

const PORT_RE = /api on 127\.0\.0\.1:(\d+)/;
const SWAP_RE = /^\[swap\] (handed-off|active|failed) ?(.*)$/;

/**
 * opts: { front, root, spawn(root, { standby }) -> ChildProcess (stdin and stdout pipes; argv/env are the caller's,
 * --swap-control and --public-port included), systemToken, onLine?(line), onUnexpectedExit?, onSpawn?, onGone?, log?,
 * timeouts? }. start() -> port; swap(root) -> runSwap result.
 */
export function createEventCoreSlot(opts) {
  const st = slotBase({ ...opts, name: 'event-core' });
  const { front, systemToken } = opts;

  function launch(root, standby) {
    const child = opts.spawn(root, { standby });
    const lines = lineReader(child, (l) => opts.onLine?.(l, child));
    st.track(child);
    return { child, lines, root, port: null };
  }
  async function control(p, line, want, ms = 15_000) {
    const answer = p.lines.waitFor(SWAP_RE, ms, line.split(' ')[0]);
    p.child.stdin.write(`${line}\n`);
    const m = await answer;
    if (m[1] !== want) throw new Error(`${line.split(' ')[0]}: ${m[2] || m[1]}`);
    try { return m[2] ? JSON.parse(m[2]) : {}; } catch { return {}; }
  }
  async function sbState(port) {
    try { return (await coreRpc(port, systemToken, 'core.status')).streamerbot?.state ?? null; } catch { return null; }
  }

  return {
    async start() {
      st.root = opts.root;
      const p = launch(opts.root, false);
      p.port = Number((await p.lines.waitFor(PORT_RE, 20_000, 'api on'))[1]);
      st.current = p;
      front.setBackend(p.port);
      return p.port;
    },
    child: () => st.current?.child ?? null,
    root: () => st.root,
    busy: () => st.busy,
    history: () => [...st.swaps],
    async swap(root) {
      const old = st.current;
      if (!old) return { result: 'refused', reason: 'not started' };
      let neu = null;
      let handed = null;
      const r = await st.run(root, 'side-by-side', {
        spawnNew: async () => {
          neu = launch(root, true);
          neu.port = Number((await neu.lines.waitFor(PORT_RE, 20_000, 'api on'))[1]);
          return { port: neu.port };
        },
        check: async ({ signal } = {}) => {
          // Healthy = the API answers in standby and, when the old core is connected to Streamer.bot, so is the new one
          // (it must already be receiving before the old one stops). A candidate whose buffer overflowed is never healthy.
          const want = await sbState(old.port);
          for (;;) {
            throwIfAborted(signal);
            if (neu.child.exitCode !== null) throw new Error(`the new core exited (${neu.child.exitCode})`);
            let s = null;
            try { s = await coreRpc(neu.port, systemToken, 'core.status'); } catch { /* not yet */ }
            if (s?.swap?.overflow > 0) throw new Error(`the new core's standby buffer overflowed (${s.swap.overflow})`);
            if (s?.swap?.state === 'standby' && (want !== 'connected' || s.streamerbot?.state === 'connected')) return { streamerbot: s.streamerbot?.state ?? null };
            await sleep(100);
          }
        },
        // Cancellation (Codex review P1): checked before each change; a cancelled hand-over leaves the front on the old
        // port and the runner restores only after this step has settled.
        handover: async ({ signal } = {}) => front.switchTo(neu.port, {
          signal,
          handover: async () => {
            throwIfAborted(signal);
            // Last look before the old core changes (Codex review P2): an overflowed candidate is refused (kept-old).
            let cand = null;
            try { cand = await coreRpc(neu.port, systemToken, 'core.status'); } catch (e) { throw new HandoverRefused(`the new core does not answer (${e?.message ?? e})`); }
            if (cand?.swap?.state !== 'standby' || cand.swap.overflow > 0) throw new HandoverRefused(`the new core is not a usable standby (${cand?.swap?.state ?? 'unknown'}, overflow ${cand?.swap?.overflow ?? '?'})`);
            throwIfAborted(signal);
            handed = await control(old, 'swap:handoff', 'handed-off');
            throwIfAborted(signal);
            const act = await control(neu, `swap:activate ${JSON.stringify({ idFloor: handed.lastId ?? undefined, live: handed.live ?? undefined, remotePort: handed.remotePort ?? undefined })}`, 'active');
            // Never silent: an old stream cut at its hand-off deadline, or a stream too slow to take the replay, can lose
            // events (that client is told by sse.mjs; the log says it here).
            const ss = handed.streams;
            if (ss && ss.clean < ss.streams) st.log(`[swap event-core] warn: ${ss.streams - ss.clean} of ${ss.streams} event stream(s) of the old core did not end cleanly; their unsent events are lost`);
            if (act?.slowClient) st.log('[swap event-core] warn: a slow event stream did not keep up with the replay; its dropped events are counted and announced to it');
            return act;
          },
        }),
        stopOld: async () => { st.plan(old.child); st.current = neu; st.root = root; return stopChild(old.child, { line: 'swap:exit' }); },
        stopNew: async () => { st.plan(neu?.child); return neu ? stopChild(neu.child, { line: 'swap:exit', graceMs: 2000 }) : null; },
        restoreOld: async () => {
          if (neu) { st.plan(neu.child); await stopChild(neu.child, { line: 'swap:exit', graceMs: 2000 }); }
          // The old core may never have handed off (the hand-over was cancelled before it, or its answer was lost): ask it.
          let oldState = null;
          if (old.child.exitCode === null) { try { oldState = (await coreRpc(old.port, systemToken, 'core.status')).swap?.state ?? null; } catch { oldState = null; } }
          let again = oldState === 'active' || (old.child.exitCode === null && handed !== null && oldState === 'handed-off');
          if (again && oldState !== 'active') {
            try { await control(old, `swap:activate ${JSON.stringify({ idFloor: handed.lastId ?? undefined, live: handed.live ?? undefined, remotePort: handed.remotePort ?? undefined })}`, 'active'); } catch { again = false; }
          }
          if (!again) {
            // The old process is gone, or stuck half handed over: start the old version again, like after a crash.
            if (old.child.exitCode === null) { st.plan(old.child); await stopChild(old.child, { line: 'swap:exit', graceMs: 2000 }); }
            const p = launch(st.root, false);
            p.port = Number((await p.lines.waitFor(PORT_RE, 20_000, 'api on'))[1]);
            st.current = p;
          }
          front.setBackend(st.current.port);
          return { port: st.current.port };
        },
      }, opts.timeouts);
      return r;
    },
    async stop() {
      const c = st.current?.child;
      if (c) { st.plan(c); await stopChild(c, { line: 'swap:exit' }); }
    },
  };
}

/** IPC request to a studio-ui server child (cli.mjs SWAP_MSG). */
function ask(child, msg, ms = 5000) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    const onMsg = (m) => { if (m?.t === 'ujwalam-swap' && m.id === id) { clearTimeout(t); child.off('message', onMsg); resolve(m); } };
    const t = setTimeout(() => { child.off('message', onMsg); reject(new Error(`${msg.op}: no answer`)); }, ms);
    t.unref?.();
    child.on('message', onMsg);
    try { child.send({ t: 'ujwalam-swap', id, ...msg }); } catch (e) { clearTimeout(t); child.off('message', onMsg); reject(e); }
  });
}

const UI_PORT_RE = /listening on http:\/\/127\.0\.0\.1:(\d+)\//;

/** opts: { front, root, spawn(root) -> ChildProcess (stdout pipe, ipc channel), onLine?, onUnexpectedExit?, onSpawn?, onGone?, log?, timeouts? }. */
export function createUiSlot(opts) {
  const st = slotBase({ ...opts, name: 'studio-ui' });
  const { front } = opts;
  const queued = []; // control lines that arrived during a swap
  const send = (line) => { try { st.current?.child.stdin?.write(`${line}\n`); return true; } catch { return false; } };
  st.afterRun = () => { while (queued.length) send(queued.shift()); };
  function launch(root) {
    const child = opts.spawn(root);
    const lines = lineReader(child, (l) => opts.onLine?.(l, child));
    st.track(child);
    return { child, lines, root, port: null };
  }
  return {
    async start() {
      st.root = opts.root;
      const p = launch(opts.root);
      p.port = Number((await p.lines.waitFor(UI_PORT_RE, 20_000, 'listening on'))[1]);
      st.current = p;
      front.setBackend(p.port);
      return p.port;
    },
    child: () => st.current?.child ?? null,
    root: () => st.root,
    busy: () => st.busy,
    history: () => [...st.swaps],
    /** A control line for the current UI server (the launcher's `rearm <key>`). During a swap it waits and goes to
     *  whichever process serves when the swap ends, so a new key never lands on a process that already exported its
     *  login state (Codex review P2). */
    control(line) {
      if (st.busy) { queued.push(line); return true; }
      return send(line);
    },
    async swap(root) {
      const old = st.current;
      if (!old) return { result: 'refused', reason: 'not started' };
      let neu = null;
      return st.run(root, 'side-by-side', {
        spawnNew: async () => {
          neu = launch(root);
          neu.port = Number((await neu.lines.waitFor(UI_PORT_RE, 20_000, 'listening on'))[1]);
          return { port: neu.port };
        },
        check: async ({ signal } = {}) => {
          for (;;) {
            throwIfAborted(signal);
            if (neu.child.exitCode !== null) throw new Error(`the new UI server exited (${neu.child.exitCode})`);
            try { const s = await httpStatus(neu.port, '/'); if (s < 500) return { http: s }; } catch { /* not yet */ }
            await sleep(100);
          }
        },
        handover: async ({ signal } = {}) => {
          try {
            return await front.switchTo(neu.port, {
              signal,
              endOld: 'cut',
              // Requests are held while this runs, so no login can happen between the copy and the switch.
              prepare: async () => {
                // The one-time login key's state moves with them (Codex review P2): the new process starts with key
                // login off, so a key used on the old one is never accepted again.
                const ex = await ask(old.child, { op: 'export-sessions' });
                const im = await ask(neu.child, { op: 'import-sessions', sessions: ex.sessions ?? [], login: ex.login });
                if (im.imported !== (ex.sessions ?? []).length) throw new Error(`sessions: ${im.imported} of ${(ex.sessions ?? []).length} taken`);
                if (im.login !== true) throw new Error('the login key state was not taken');
              },
            });
          } catch (e) {
            // Nothing on the old server changes during a UI hand-over: any failure leaves it serving.
            throw e instanceof HandoverRefused ? e : new HandoverRefused(e?.message ?? String(e));
          }
        },
        stopOld: async () => { st.plan(old.child); st.current = neu; st.root = root; return stopChild(old.child); },
        stopNew: async () => { if (!neu) return null; st.plan(neu.child); return stopChild(neu.child, { graceMs: 2000 }); },
        restoreOld: async () => { front.setBackend(old.port); return { port: old.port }; },
      }, opts.timeouts);
    },
    async stop() { const c = st.current?.child; if (c) { st.plan(c); await stopChild(c, { graceMs: 3000 }); } },
  };
}

/**
 * Stop-start slot for a worker. opts: { name, spawn(spec) -> ChildProcess, healthMs (the new one must stay up this
 * long; default 5000), onUnexpectedExit?, onSpawn?, onGone?, log? }. start(spec); swap(spec) -> runSwap result.
 * The spec is the caller's (exe, argv, root); the slot only keeps it to start the old version again.
 */
export function createWorkerSlot(opts) {
  const st = slotBase(opts);
  const healthMs = opts.healthMs ?? 5000;
  const launch = (spec) => { const child = opts.spawn(spec); st.track(child); return { child, spec }; };
  return {
    start(spec) { st.current = launch(spec); st.root = spec; return st.current.child; },
    child: () => st.current?.child ?? null,
    spec: () => st.root,
    busy: () => st.busy,
    history: () => [...st.swaps],
    async swap(spec) {
      const old = st.current;
      if (!old) return { result: 'refused', reason: 'not started' };
      let neu = null;
      return st.run(spec, 'stop-start', {
        stopOld: async () => { st.plan(old.child); return stopChild(old.child, { graceMs: 3000 }); },
        // On probation until healthy: an exit in the check window is the swap's failure, not a crash for the launcher.
        spawnNew: async () => { neu = launch(spec); st.plan(neu.child); st.current = neu; if (!neu.child.pid) throw new Error('not started'); return { pid: neu.child.pid }; },
        check: async () => {
          const exited = new Promise((r) => { if (neu.child.exitCode !== null) r(neu.child.exitCode); else neu.child.once('exit', (c) => r(c)); });
          const c = await Promise.race([exited, sleep(healthMs).then(() => 'up')]);
          if (c !== 'up') throw new Error(`the new worker exited (${c}) within ${healthMs} ms`);
          st.unplan(neu.child);
          st.root = spec;
          return { upMs: healthMs };
        },
        stopNew: async () => { if (!neu) return null; st.plan(neu.child); return stopChild(neu.child, { graceMs: 2000 }); },
        restoreOld: async () => {
          if (neu) st.plan(neu.child);
          st.current = launch(old.spec);
          st.root = old.spec;
          return { pid: st.current.child.pid };
        },
      }, { check: healthMs + 5000 });
    },
    async stop() { const c = st.current?.child; if (c) { st.plan(c); await stopChild(c, { graceMs: 3000 }); } },
  };
}

export const STUDIO_SWAP_EXIT = 75; // MainWindow::kSwapExitCode (app/studio/src/main_window.h)
const STUDIO_READY_RE = /^studio attach: ready/;
const STUDIO_PREVIEW_RE = /^studio attach: preview ([a-z]+) embedded/;

/**
 * Stop-start slot for the Qt studio window (LU4, D346). opts: { spawn(root, key) -> ChildProcess (stdin and stdout
 * pipes, UJWALAM_STUDIO_CONTROL=1; exe, env and window are the caller's), rearm(key) -> bool (hands the UI server a new
 * one-time login key; false when it could not), newKey?(), blocked?() -> reason | null, waits?: { close, ready,
 * previews, healthMs }, onLine?(line, child), onUserClose?(child), onSpawn?, onGone?, log? }.
 * Exits nobody planned are the caller's: it listens on the child and asks isPlanned(child) (a swap's exits are planned).
 * A user close during a swap (Codex review of D346): exit 0 is the user closing the window (75 is a requested swap,
 * anything else a crash). When the window on probation, or the old one before it took "swap-close", exits 0, the swap
 * starts nothing more (no restore) and onUserClose(child) tells the caller, which stops the session (D280).
 * start(root, key) -> child; swap(root) -> runSwap result, with the timings in the check step's value.
 */
export function createStudioSlot(opts) {
  const st = slotBase({ ...opts, name: 'studio' });
  const w = { close: 5000, ready: 20_000, previews: 10_000, healthMs: 1000, ...opts.waits };
  const newKey = opts.newKey ?? (() => randomBytes(32).toString('hex'));
  let alive = 0;
  let maxAlive = 0;
  let userClosed = null; // the child the user closed during the running swap
  function launch(root, key) {
    const child = opts.spawn(root, key);
    const p = { child, root, startedAt: Date.now(), readyAt: null, previews: new Map(), exitedAt: null, exitCode: undefined };
    alive++; maxAlive = Math.max(maxAlive, alive);
    let gone = false;
    const end = (code) => { if (gone) return; gone = true; alive--; p.exitedAt = Date.now(); p.exitCode = code; };
    child.once('exit', (code) => {
      end(code);
      // A planned exit with code 0 during a swap: the user closed that window (swap-close exits 75). Unplanned exits
      // are the caller's anyway.
      if (code === 0 && st.busy && st.isPlanned(child) && !userClosed) { userClosed = child; opts.onUserClose?.(child); }
    });
    child.once('error', () => { if (!child.pid) end(null); }); // never started: no exit event follows
    if (child.stdout) {
      lineReader(child, (l) => {
        if (STUDIO_READY_RE.test(l) && p.readyAt === null) p.readyAt = Date.now();
        const m = STUDIO_PREVIEW_RE.exec(l);
        if (m && !p.previews.has(m[1])) p.previews.set(m[1], Date.now());
        opts.onLine?.(l, child);
      });
    }
    st.track(child);
    return p;
  }
  // Polls p until done(p); fails when it exits, the time runs out or the swap gives up on this step.
  async function until(p, done, ms, what, signal) {
    const t0 = Date.now();
    for (;;) {
      throwIfAborted(signal);
      if (done(p)) return Date.now() - t0;
      if (p.exitedAt !== null) throw new Error(`the studio exited (${p.exitCode}) before ${what}`);
      if (Date.now() - t0 > ms) throw new Error(`no ${what} within ${ms} ms`);
      await sleep(20);
    }
  }
  return {
    start(root, key) { st.root = root; st.current = launch(root, key); return st.current.child; },
    child: () => st.current?.child ?? null,
    root: () => st.root,
    busy: () => st.busy,
    history: () => [...st.swaps],
    /** A swap's exits (swap-close, a new build on probation, a rolled-back build): the caller's exit handler skips them. */
    isPlanned: (child) => st.isPlanned(child),
    /** Most studio processes alive at the same time since start (1: the windows never overlapped). */
    maxConcurrent: () => maxAlive,
    /** Canvases whose preview the current window has embedded. */
    previews: () => [...(st.current?.previews.keys() ?? [])],
    async swap(root) {
      const old = st.current;
      if (!old) return { result: 'refused', reason: 'not started' };
      const why = opts.blocked?.();
      if (why) return { result: 'refused', reason: why };
      const want = [...old.previews.keys()]; // every preview the old window had must come back
      let neu = null;
      userClosed = null;
      const closed = (what) => new Error(`the user closed the ${what} window (exit 0): no restore, the session stops (D280)`);
      return st.run(root, 'stop-start', {
        stopOld: async () => {
          st.plan(old.child);
          const code = await stopChild(old.child, { line: 'swap-close', graceMs: w.close });
          if (userClosed || code === 0) throw closed('old'); // kept-old: nothing new starts
          return { code, clean: code === STUDIO_SWAP_EXIT };
        },
        spawnNew: async () => {
          if (userClosed) throw closed('old');
          const key = newKey();
          if (!opts.rearm(key)) throw new Error('the UI server did not take a new login key');
          neu = launch(root, key);
          st.plan(neu.child); // on probation until healthy: an exit now is the swap's failure, not a crash
          st.current = neu;
          if (!neu.child.pid) throw new Error('the studio did not start');
          return { pid: neu.child.pid };
        },
        check: async ({ signal } = {}) => {
          const readyMs = await until(neu, (p) => p.readyAt !== null, w.ready, '"studio attach: ready"', signal);
          await until(neu, (p) => want.every((c) => p.previews.has(c)), w.previews, `previews ${want.join(', ')} embedded`, signal);
          await sleep(w.healthMs);
          if (neu.exitedAt !== null) throw new Error(`the studio exited (${neu.exitCode}) after it attached`);
          st.unplan(neu.child);
          st.root = root;
          const gapFrom = old.exitedAt ?? neu.startedAt; // the old previews went with the old window
          const previewGapMs = Object.fromEntries(want.map((c) => [c, neu.previews.get(c) - gapFrom]));
          return { readyMs, startMs: neu.readyAt - neu.startedAt, previewGapMs, previews: want };
        },
        stopNew: async () => { if (!neu) return null; st.plan(neu.child); return stopChild(neu.child, { line: 'swap-close', graceMs: 2000 }); },
        restoreOld: async ({ signal } = {}) => {
          if (neu) st.plan(neu.child);
          if (userClosed) throw closed(userClosed === old.child ? 'old' : 'new'); // failed: the caller ends the session
          const key = newKey();
          if (!opts.rearm(key)) throw new Error('the UI server did not take a new login key');
          const back = launch(old.root, key);
          st.current = back;
          st.root = old.root;
          // The old version is known to work: its exit fails the restore, a slow start does not.
          try { await until(back, (p) => p.readyAt !== null, w.ready, '"studio attach: ready"', signal); } catch (e) { if (back.exitedAt !== null) throw e; }
          return { pid: back.child.pid, ready: back.readyAt !== null };
        },
      }, { stopOld: w.close + 7000, check: w.ready + w.previews + w.healthMs + 5000, restoreOld: w.ready + 5000 });
    },
    async stop() { const c = st.current?.child; if (c) { st.plan(c); await stopChild(c, { line: 'swap-close', graceMs: 3000 }); } },
  };
}
