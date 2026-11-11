// SPDX-License-Identifier: GPL-3.0-or-later
// Live updates: host staging and the one-click gate (LU5, LU7; D343). Node stdlib only.
//
// The launcher (services/studio-ui/launch.mjs) owns one update queue (createUpdates). Updates arrive only over the
// launcher's IPC channel from the process that started it ({ t: 'ujwalam-swap', id, service, root }, serveSwaps; LU6's
// live install will use it). A click on the control page or in the studio reaches it over the UI server's IPC channel
// ({ t: UPDATE_MSG, id, op: 'apply', item }, serveUpdates). Nothing else can trigger an update: the event core (chat,
// rules, the LAN remote) has no channel to the launcher, and agents have none either (AGENTS: chat and rules never write
// on their own).
//
// "Busy" (the D334 rule, widened to recordings): a FRESH outputs.status shows a stream or record sink starting, live,
// reconnecting, retrying or stopping. An answer that cannot be read counts as busy (fail safe). No host: not busy.
//
//   not busy  -> every update is applied at once (the request is the user's own install action).
//   busy      -> host (and the overlay server, a child of the host): STAGED. Never applied while busy, not even on a
//                click; applied by the queue's poll as soon as a fresh status shows everything stopped. The stage is
//                written to <dataDir>/live/host-update.json, so closing the app with a staged host update still applies
//                it at the next start (takeStartupHost).
//                services (event core, studio UI server): WAITING for one click (D332: one click, no typed phrase, no
//                "are you sure"). The click swaps it at once (LU3 swaps keep the stream); if nobody clicks, it is
//                applied at the stop like the host.
// A newer update of the same part replaces the waiting one. One update runs at a time.
//
// <dataDir>/live/updates.json mirrors versions per part, the waiting items and the last results for the control page
// (readUpdatesStatus). It is never read back for a decision. No paths, keys or names in it: versions and plain words.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const UPDATE_MSG = 'ujwalam-update';
export const LIVE_DIR = 'live';
export const UPDATES_FILE = 'updates.json';
export const HOST_STAGE_FILE = 'host-update.json';
export const RECENT_KEPT = 8;
const BUSY = new Set(['starting', 'live', 'reconnecting', 'retrying', 'stopping']);
const SESSION_RE = /^[0-9a-f]{16,64}$/;

// What the control page lists, in this order. overlay-server follows the host; the studio window and data follow the
// running release until LU4 / LU2 report their own.
export const PARTS = Object.freeze(['host', 'overlay-server', 'event-core', 'studio-ui', 'studio-window', 'data']);
export const PART_LABELS = Object.freeze({
  host: 'Video engine (host)', 'overlay-server': 'Overlay server', 'event-core': 'Event core', 'studio-ui': 'Control page server',
  'studio-window': 'Studio window', data: 'Data (presets, themes, rules)',
});
const SERVICE_ENTRY = Object.freeze({ 'event-core': ['services', 'event-core', 'cli.mjs'], 'studio-ui': ['services', 'studio-ui', 'cli.mjs'] });

/** Pure: true when any stream or record sink is starting, live, reconnecting, retrying or stopping, or the answer is
 *  not a usable outputs.status (fail safe: an unreadable status never lets the host restart). */
export function outputsBusy(status) {
  if (!status || !Array.isArray(status.sinks)) return true;
  return status.sinks.some((s) => (s?.kind === 'stream' || s?.kind === 'record') && BUSY.has(s.state));
}

/** release.json of a release folder: { version, n, hostExeSha256, parts } or null. */
export function readRelease(root) {
  if (typeof root !== 'string') return null;
  try {
    const j = JSON.parse(readFileSync(path.join(root, 'release.json'), 'utf8'));
    if (typeof j?.version !== 'string' || !/^[0-9A-Za-z.+-]{1,40}$/.test(j.version)) return null;
    return { version: j.version, n: Number.isInteger(j.n) ? j.n : null, hostExeSha256: typeof j.hostExeSha256 === 'string' ? j.hostExeSha256 : null, parts: j.parts && typeof j.parts === 'object' ? j.parts : null };
  } catch { return null; }
}

const sha256File = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');

/**
 * Where a release folder's host lives (the package layout, tools/package/run-installed.mjs): bin/ujwalam-host.exe, the
 * OBS runtime in obs/, the overlay server child in app/host/overlay/child.mjs. A stand-in script host (tests, dev:
 * the running host is a .mjs) is replaced only by bin/ujwalam-host.mjs. -> { exe, runtime, overlayScript, version, n }
 * or { problem }. When release.json names hostExeSha256, the exe must match it.
 */
export function hostEntry(root, { script = false, runtime = null } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) return { problem: 'the update folder must be an absolute path' };
  const rel = readRelease(root);
  if (!rel) return { problem: 'the update folder has no readable release.json' };
  const exe = path.join(root, 'bin', script ? 'ujwalam-host.mjs' : 'ujwalam-host.exe');
  if (!existsSync(exe)) return { problem: `the update has no ${script ? 'stand-in host script' : 'host exe'} (bin/${path.basename(exe)})` };
  if (rel.hostExeSha256 && sha256File(exe) !== rel.hostExeSha256) return { problem: 'the host exe does not match the hash in its release.json' };
  const obs = path.join(root, 'obs');
  let rt = runtime;
  try { if (statSync(obs).isDirectory()) rt = obs; } catch { /* keep */ }
  if (!script && rt !== obs) return { problem: 'the update has no OBS runtime folder (obs/)' };
  const ov = path.join(root, 'app', 'host', 'overlay', 'child.mjs');
  return { root, exe, runtime: rt, overlayScript: existsSync(ov) ? ov : null, version: rel.version, n: rel.n, parts: rel.parts };
}

/** Pure: the host argv with --runtime and --overlay-script pointing at the new release (other arguments unchanged). */
export function hostArgsFor(argv, { runtime, overlayScript }) {
  const out = [...argv];
  const set = (k, v) => { const i = out.indexOf(k); if (i >= 0 && i + 1 < out.length && typeof v === 'string' && v) out[i + 1] = v; };
  set('--runtime', runtime);
  set('--overlay-script', overlayScript);
  return out;
}

/** A service update's folder must hold that service's entry file. -> problem text or null. */
export function serviceRootProblem(service, root) {
  const entry = SERVICE_ENTRY[service];
  if (!entry) return null;
  if (typeof root !== 'string' || !path.isAbsolute(root) || !existsSync(path.join(root, ...entry))) return 'root must be an absolute folder that holds the service entry file';
  return null;
}

function writeAtomic(file, obj) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  // Windows refuses the rename (EPERM/EBUSY) while another process (the UI server) has the file open for a read; a
  // short retry keeps the mirror from going stale.
  for (let i = 0; ; i += 1) {
    try { renameSync(tmp, file); return; } catch (e) {
      if (i >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(e?.code)) { try { rmSync(tmp, { force: true }); } catch { /* temp file */ } throw e; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}
const liveFile = (dataDir, name) => path.join(dataDir, LIVE_DIR, name);

/**
 * Launcher start: the host release to start from, staged or applied by an earlier session (host-update.json), or null.
 * Used while its release is newer than the running one (own.n; a dev checkout without release.json counts as 0), so an
 * update applied at a stop is not undone by the next start, and a closed app with a staged host update starts with it.
 * The file is removed once the running release has caught up (the installer made the new version current) or the
 * folder is no longer usable (the reason is returned for the log).
 */
export function takeStartupHost({ dataDir, own = null, script = false, runtime = null }) {
  const f = liveFile(dataDir, HOST_STAGE_FILE);
  let j;
  try { j = JSON.parse(readFileSync(f, 'utf8')); } catch { return { entry: null }; }
  const drop = (why) => { try { rmSync(f, { force: true }); } catch { /* next start tries again */ } return { entry: null, dropped: why }; };
  if (!j || typeof j.root !== 'string') return drop('unreadable');
  const e = hostEntry(j.root, { script, runtime });
  if (e.problem) return drop(e.problem);
  const ownN = Number.isInteger(own?.n) ? own.n : 0;
  if (!Number.isInteger(e.n) || e.n <= ownN) return drop('the running release already has it');
  return { entry: { ...e, root: j.root }, state: j.state === 'applied' ? 'applied' : 'staged' };
}

/** UI server: this launcher session's update state for the page (plain words and versions only), or null. */
export function readUpdatesStatus(dataDir, session) {
  if (typeof dataDir !== 'string' || typeof session !== 'string' || !SESSION_RE.test(session)) return null;
  try {
    const j = JSON.parse(readFileSync(liveFile(dataDir, UPDATES_FILE), 'utf8'));
    if (j?.session !== session) return null;
    const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);
    const arr = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);
    return {
      accepting: j.accepting === true,
      parts: arr(j.parts, PARTS.length).map((p) => ({ part: str(p.part, 24), label: str(p.label, 60), version: str(p.version, 40), follows: str(p.follows, 24) })),
      waiting: arr(j.waiting, 10).map((w) => ({ id: str(w.id, 24), part: str(w.part, 24), version: str(w.version, 40), click: w.click === true, text: str(w.text, 300), at: str(w.at, 40) })),
      recent: arr(j.recent, RECENT_KEPT).map((r) => ({ part: str(r.part, 24), version: str(r.version, 40), result: str(r.result, 16), text: str(r.text, 300), at: str(r.at, 40) })),
      at: str(j.at, 40),
    };
  } catch { return null; }
}

/**
 * The queue. Callbacks (the launcher's):
 *   outputs()             -> outputs.status of the running host (fresh), or null when there is no host. Throws when the
 *                            host does not answer (counts as busy).
 *   swapService(s, root)  -> { result, reason } (LU3 slot swap)
 *   applyHost(entry)      -> { result, reason } (planned host restart from entry; null when there is no host)
 *   hostInfo()            -> { script, runtime, root } of the running host (for hostEntry; root null = the checkout)
 * startupHost: takeStartupHost()'s answer when this start used a staged or applied host release.
 * own: { version, n } of the running release (null in a dev checkout).
 */
export function createUpdates({ dataDir, session, own = null, outputs = async () => null, swapService = null, applyHost = null,
  hostInfo = () => ({ script: false, runtime: null, root: null }), accepting = true, startupHost = null, log = () => {}, now = Date.now, pollMs = 2000 }) {
  const ownVersion = own?.version ?? 'dev';
  const versions = Object.fromEntries(PARTS.map((p) => [p, ownVersion]));
  if (startupHost?.entry?.version) { versions.host = startupHost.entry.version; versions['overlay-server'] = startupHost.entry.version; }
  // The host release the next start should use (host-update.json state 'applied'), restored when a newer one fails.
  let applied = startupHost?.entry ? { entry: startupHost.entry, root: startupHost.entry.root } : null;
  const waiting = []; // { id, part, root, entry?, version, click, at }
  const recent = [];
  let seq = 0;
  let chain = Promise.resolve();
  let running = 0;
  let timer = null;
  let closed = false;
  const iso = () => new Date(now()).toISOString();
  const label = (p) => PART_LABELS[p] ?? p;
  const text = (w) => (w.part === 'host'
    ? `${label('host')} update ${w.version} waits until every stream and recording has stopped (the host owns the encoders). The overlay server is updated with it.`
    : `${label(w.part)} update ${w.version} is ready: Apply now updates it while live without stopping the stream; otherwise it is applied when every stream and recording has stopped.`);
  const mirror = () => {
    if (typeof dataDir !== 'string' || typeof session !== 'string') return;
    try {
      writeAtomic(liveFile(dataDir, UPDATES_FILE), {
        v: 1, session, at: iso(), accepting,
        parts: PARTS.map((p) => ({ part: p, label: label(p), version: versions[p], ...(p === 'overlay-server' ? { follows: 'host' } : {}) })),
        waiting: waiting.map((w) => ({ id: w.id, part: w.part, version: w.version, click: w.click, text: text(w), at: w.at })),
        recent,
      });
    } catch { /* the page shows the last one */ }
  };
  const stageFile = (entry, root, state) => {
    if (typeof dataDir !== 'string') return;
    try { writeAtomic(liveFile(dataDir, HOST_STAGE_FILE), { v: 1, root, version: entry.version, n: entry.n, state, at: iso() }); } catch (e) { log(`WARNING: host update stage not saved (${e.message}); it is applied at the stop but not after a close`); }
  };
  const unstage = () => { if (typeof dataDir === 'string') { try { rmSync(liveFile(dataDir, HOST_STAGE_FILE), { force: true }); } catch { /* next start drops it */ } } };
  const note = (part, version, result, why = null) => {
    const ok = result === 'swapped' || result === 'applied';
    const t = ok ? `${label(part)} updated to ${version}.` : `${label(part)} update ${version} not applied (${result}${why ? `: ${String(why).slice(0, 160)}` : ''}).`;
    recent.unshift({ part, version, result, text: t, at: iso() });
    recent.splice(RECENT_KEPT);
    log(t);
  };
  const serial = (fn) => {
    const p = chain.then(async () => { running += 1; try { return await fn(); } finally { running -= 1; } });
    chain = p.then(() => undefined, () => undefined);
    return p;
  };
  async function busy() {
    let st;
    try { st = await outputs(); } catch { return true; }
    if (st === null || st === undefined) return false; // no host: nothing can be live
    return outputsBusy(st);
  }
  async function applyNow(w) {
    if (w.part === 'host') {
      if (!applyHost) return { result: 'refused', reason: 'no host is running' };
      const r = await applyHost(w.entry);
      // 'busy': a stream or recording started between the queue's check and the restart (the launcher checks again
      // right before it stops the host); the update goes back to waiting.
      if (r?.result === 'busy') return r;
      if (r?.result === 'swapped') {
        versions.host = w.version; versions['overlay-server'] = w.version;
        applied = { entry: w.entry, root: w.root };
        stageFile(w.entry, w.root, 'applied'); // kept, so the next start does not go back to the older host
      } else if (applied) stageFile(applied.entry, applied.root, 'applied');
      else unstage();
      note('host', w.version, r?.result ?? 'failed', r?.reason);
      return r ?? { result: 'failed' };
    }
    if (!swapService) return { result: 'refused', reason: 'service swaps are not set up' };
    const r = await swapService(w.part, w.root);
    if (r?.result === 'swapped') versions[w.part] = w.version;
    note(w.part, w.version, r?.result ?? 'failed', r?.reason ?? r?.failed?.join('; '));
    return r ?? { result: 'failed' };
  }
  const drop = (w) => { const i = waiting.indexOf(w); if (i >= 0) waiting.splice(i, 1); };
  function enqueue(w) {
    for (const old of waiting.filter((x) => x.part === w.part && x !== w)) { drop(old); note(w.part, old.version, 'replaced', `by ${w.version}`); }
    if (!waiting.includes(w)) waiting.push(w);
    if (w.part === 'host') { w.staged = true; stageFile(w.entry, w.root, 'staged'); }
    mirror();
    poll();
  }
  function poll() {
    if (timer || closed) return;
    timer = setInterval(() => { void tick(); }, pollMs);
    timer.unref?.();
  }
  async function tick() {
    if (closed || running || !waiting.length) { if (!waiting.length && timer) { clearInterval(timer); timer = null; } return; }
    await serial(async () => {
      // Services first (quick), then the host; a fresh status before each one.
      for (const w of [...waiting].sort((a, b) => (a.part === 'host') - (b.part === 'host'))) {
        if (closed || await busy()) break;
        drop(w);
        mirror();
        const r = await applyNow(w);
        if (r?.result === 'busy') { enqueue(w); break; }
        mirror();
      }
    });
    if (!waiting.length && timer) { clearInterval(timer); timer = null; }
  }

  return {
    /** An update request from the launcher's parent. -> { result, reason?, id? } */
    request({ service, root }) {
      return serial(async () => {
        if (closed) return { result: 'refused', reason: 'Ujwalam is closing' };
        if (!accepting) return { result: 'refused', reason: 'live updates are off (feature flag service-swap)' };
        const part = service === 'overlay-server' ? 'host' : service;
        let w;
        if (part === 'host') {
          if (!applyHost) return { result: 'refused', reason: 'no host is running' };
          const entry = hostEntry(root, hostInfo());
          if (entry.problem) return { result: 'refused', reason: entry.problem };
          const cur = readRelease(typeof hostInfo().root === 'string' ? hostInfo().root : null);
          if (cur?.parts?.host?.sha256 && entry.parts?.host?.sha256 === cur.parts.host.sha256) return { result: 'unchanged', reason: 'the update does not change the host' };
          w = { id: `u${++seq}`, part, root, entry, version: entry.version, click: false, at: iso() };
        } else {
          if (!Object.hasOwn(SERVICE_ENTRY, part)) return { result: 'refused', reason: 'unknown or not wired service' };
          const why = serviceRootProblem(part, root);
          if (why) return { result: 'refused', reason: why };
          w = { id: `u${++seq}`, part, root, version: readRelease(root)?.version ?? 'unversioned', click: true, at: iso() };
        }
        if (!(await busy())) {
          const r = await applyNow(w);
          if (r?.result !== 'busy') { mirror(); return r; }
        }
        enqueue(w);
        log(part === 'host' ? `host update ${w.version} staged: applied when every stream and recording has stopped` : `${part} update ${w.version} waits for one click (live)`);
        return { result: part === 'host' ? 'staged' : 'waiting', id: w.id, reason: text(w) };
      });
    },
    /** One click on the control page or in the studio. -> { result, reason? } */
    apply(id) {
      return serial(async () => {
        if (closed) return { result: 'refused', reason: 'Ujwalam is closing' };
        const w = waiting.find((x) => x.id === id);
        if (!w) return { result: 'refused', reason: 'no such update waiting (already applied or replaced)' };
        if (w.part === 'host' && await busy()) return { result: 'refused', reason: 'the host is updated only when every stream and recording has stopped' };
        drop(w);
        mirror();
        const r = await applyNow(w);
        if (r?.result === 'busy') { enqueue(w); return { result: 'refused', reason: 'the host is updated only when every stream and recording has stopped' }; }
        mirror();
        return r;
      });
    },
    tick,
    state: () => ({ versions: { ...versions }, waiting: waiting.map((w) => ({ id: w.id, part: w.part, version: w.version, click: w.click })), recent: [...recent] }),
    /** The app closes: a staged host update stays in host-update.json for the next start; services that wait are dropped. */
    close() {
      closed = true;
      if (timer) { clearInterval(timer); timer = null; }
      const lines = [];
      for (const w of waiting) {
        if (w.part === 'host') lines.push(`host update ${w.version} waits: it is applied at the next start`);
        else { lines.push(`${w.part} update ${w.version} not applied (Ujwalam closed)`); note(w.part, w.version, 'dropped', 'Ujwalam closed'); }
      }
      waiting.splice(0);
      mirror();
      return lines;
    },
    mirror,
    setVersion(part, version) { if (Object.hasOwn(versions, part) && typeof version === 'string') { versions[part] = version; mirror(); } },
  };
}

/** Launcher: answers a UI server process's update clicks on its IPC channel. */
export function serveUpdates(child, updates) {
  child.on('message', (m) => {
    if (m?.t !== UPDATE_MSG || !Number.isInteger(m.id)) return;
    const reply = (r) => { try { if (child.connected) child.send({ t: UPDATE_MSG, id: m.id, ...r }); } catch { /* the UI server times out */ } };
    if (m.op === 'apply' && typeof m.item === 'string' && /^u\d{1,9}$/.test(m.item)) {
      updates.apply(m.item).then((r) => reply({ result: r?.result ?? 'failed', reason: typeof r?.reason === 'string' ? r.reason.slice(0, 300) : undefined }), (e) => reply({ result: 'failed', reason: String(e?.message ?? e).slice(0, 200) }));
    } else reply({ result: 'refused', reason: 'bad request' });
  });
}

/** UI server: the launcher's update queue over this process's IPC channel, or null without one. */
export function updatesClient({ proc = process, timeoutMs = 120_000 } = {}) {
  if (typeof proc.send !== 'function' || proc.connected !== true) return null;
  let seq = 0;
  const waitingReplies = new Map();
  proc.on('message', (m) => {
    if (m?.t !== UPDATE_MSG || !waitingReplies.has(m.id)) return;
    const done = waitingReplies.get(m.id); waitingReplies.delete(m.id); done(m);
  });
  return {
    apply(item) {
      return new Promise((resolve) => {
        if (proc.connected !== true) { resolve({ result: 'failed', reason: 'launcher link closed' }); return; }
        const id = ++seq;
        const t = setTimeout(() => { waitingReplies.delete(id); resolve({ result: 'failed', reason: 'the launcher did not answer' }); }, timeoutMs);
        waitingReplies.set(id, (m) => { clearTimeout(t); resolve({ result: m.result, reason: m.reason }); });
        try { proc.send({ t: UPDATE_MSG, id, op: 'apply', item }); } catch (e) { clearTimeout(t); waitingReplies.delete(id); resolve({ result: 'failed', reason: String(e?.message ?? e).slice(0, 120) }); }
      });
    },
  };
}
