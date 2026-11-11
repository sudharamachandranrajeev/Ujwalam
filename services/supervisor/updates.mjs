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
//                written to <dataDir>/live/host-update.json, so closing the app with a staged host update still tries
//                it at the next start (takeStartupHost, a trial with fallback).
//                services (event core, studio UI server): WAITING for one click (D332: one click, no typed phrase, no
//                "are you sure"). The click swaps it at once (LU3 swaps keep the stream). Nothing applies a service on
//                its own: not the poll, not the stop (AGENTS: a system request waits for one click). Closing drops it.
// A newer update of the same part replaces the waiting one; an update not newer than the running or waiting release
// of its part is refused. One update runs at a time.
//
// Integrity (Codex review of D343): a release folder must carry release.json with version, n and the hash of each part
// it updates (LU1, parts.mjs), and the host its hostExeSha256. The part's files are hashed, copied into
// <dataDir>/live/releases/ (the staged folder can change after the check; the copy is ours) and hashed again; right
// before the copy runs it is hashed once more.
//
// host-update.json (v2): { pending, good, rejected[] }. pending: the host release to try next (staged, or being
// applied). good: the last host release that started and loaded the project. rejected: releases that failed; never
// tried again. The next start tries pending, then good, then the installed host (launcher), and records the outcome.
//
// <dataDir>/live/updates.json mirrors versions per part, the waiting items and the last results for the control page
// (readUpdatesStatus). It is never read back for a decision. No paths, keys or names in it: versions and plain words.

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { folderFiles, partOf, partsProblem } from './parts.mjs';

export const UPDATE_MSG = 'ujwalam-update';
export const LIVE_DIR = 'live';
export const UPDATES_FILE = 'updates.json';
export const HOST_STAGE_FILE = 'host-update.json';
export const RELEASES_DIR = 'releases';
export const RECENT_KEPT = 8;
const REJECTED_KEPT = 20;
const BUSY = new Set(['starting', 'live', 'reconnecting', 'retrying', 'stopping']);
const SESSION_RE = /^[0-9a-f]{16,64}$/;
const HEX64 = /^[0-9a-f]{64}$/;

// What the control page lists, in this order. overlay-server follows the host; the studio window and data follow the
// running release until LU4 / LU2 report their own.
export const PARTS = Object.freeze(['host', 'overlay-server', 'event-core', 'studio-ui', 'studio-window', 'data']);
export const PART_LABELS = Object.freeze({
  host: 'Video engine (host)', 'overlay-server': 'Overlay server', 'event-core': 'Event core', 'studio-ui': 'Control page server',
  'studio-window': 'Studio window', data: 'Data (presets, themes, rules)',
});
const SERVICE_ENTRY = Object.freeze({ 'event-core': ['services', 'event-core', 'cli.mjs'], 'studio-ui': ['services', 'studio-ui', 'cli.mjs'] });
// The release parts an update runs from (copied and checked): the host part for the host; a service also reads the
// data and the overlay pages of its release.
const HOST_PARTS = Object.freeze(['host']);
const SERVICE_PARTS = Object.freeze(['services', 'data', 'overlay']);

/** Pure: true when any stream or record sink is starting, live, reconnecting, retrying or stopping, or the answer is
 *  not a usable outputs.status (fail safe: an unreadable status never lets the host restart). */
export function outputsBusy(status) {
  if (!status || !Array.isArray(status.sinks)) return true;
  return status.sinks.some((s) => (s?.kind === 'stream' || s?.kind === 'record') && BUSY.has(s.state));
}

/** release.json of a release folder: { version, n, hostExeSha256, parts } or null (lenient: display and own release). */
export function readRelease(root) {
  if (typeof root !== 'string') return null;
  try {
    const j = JSON.parse(readFileSync(path.join(root, 'release.json'), 'utf8'));
    if (typeof j?.version !== 'string' || !/^[0-9A-Za-z.+-]{1,40}$/.test(j.version)) return null;
    return { version: j.version, n: Number.isInteger(j.n) ? j.n : null, hostExeSha256: typeof j.hostExeSha256 === 'string' ? j.hostExeSha256 : null, parts: j.parts && typeof j.parts === 'object' ? j.parts : null };
  } catch { return null; }
}

/** Strict release metadata for an update: version, n >= 1, a hash for each part it updates (and the host exe hash). */
function releaseProblem(rel, parts, { host = false } = {}) {
  if (!rel) return 'the update folder has no readable release.json';
  if (!Number.isInteger(rel.n) || rel.n < 1) return 'its release.json has no release number (n)';
  if (host && !HEX64.test(rel.hostExeSha256 ?? '')) return 'its release.json has no host exe hash';
  for (const p of parts) if (!HEX64.test(rel.parts?.[p]?.sha256 ?? '') || !Number.isInteger(rel.parts?.[p]?.files)) return `its release.json has no ${p} hash`;
  return null;
}

const sha256File = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');

/**
 * Where a release folder's host lives (the package layout, tools/package/run-installed.mjs): bin/ujwalam-host.exe, the
 * OBS runtime in obs/, the overlay server child in app/host/overlay/child.mjs. A stand-in script host (tests, dev:
 * the running host is a .mjs) is replaced only by bin/ujwalam-host.mjs. -> { exe, runtime, overlayScript, version, n,
 * sha256, files } or { problem }. release.json must carry the exe hash and the host part hash; the exe must match.
 */
export function hostEntry(root, { script = false, runtime = null } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) return { problem: 'the update folder must be an absolute path' };
  const rel = readRelease(root);
  const bad = releaseProblem(rel, HOST_PARTS, { host: true });
  if (bad) return { problem: bad };
  const exe = path.join(root, 'bin', script ? 'ujwalam-host.mjs' : 'ujwalam-host.exe');
  if (!existsSync(exe)) return { problem: `the update has no ${script ? 'stand-in host script' : 'host exe'} (bin/${path.basename(exe)})` };
  if (sha256File(exe) !== rel.hostExeSha256) return { problem: 'the host exe does not match the hash in its release.json' };
  const obs = path.join(root, 'obs');
  let rt = runtime;
  try { if (statSync(obs).isDirectory()) rt = obs; } catch { /* keep */ }
  if (!script && rt !== obs) return { problem: 'the update has no OBS runtime folder (obs/)' };
  const ov = path.join(root, 'app', 'host', 'overlay', 'child.mjs');
  return { root, exe, runtime: rt, overlayScript: existsSync(ov) ? ov : null, version: rel.version, n: rel.n, parts: rel.parts, sha256: rel.parts.host.sha256, files: rel.parts.host.files };
}

/** Pure: the host argv with --runtime and --overlay-script pointing at the new release (other arguments unchanged). */
export function hostArgsFor(argv, { runtime, overlayScript }) {
  const out = [...argv];
  const set = (k, v) => { const i = out.indexOf(k); if (i >= 0 && i + 1 < out.length && typeof v === 'string' && v) out[i + 1] = v; };
  set('--runtime', runtime);
  set('--overlay-script', overlayScript);
  return out;
}

/** Right before a host copy runs (and at start): its exe and its whole host part still match. -> problem or null. */
export function hostEntryProblem(entry, { script = false, runtime = null } = {}) {
  const e = hostEntry(entry?.root, { script, runtime });
  if (e.problem) return e.problem;
  if (e.sha256 !== entry.sha256 || e.n !== entry.n) return 'the staged host is not the one that was checked';
  return partsProblem(entry.root, HOST_PARTS, { host: { sha256: entry.sha256, files: entry.files } });
}

const liveFile = (dataDir, name) => path.join(dataDir, LIVE_DIR, name);
const releasesDir = (dataDir) => path.join(dataDir, LIVE_DIR, RELEASES_DIR);

/**
 * Copies the given parts of a checked release folder (plus its release.json) into <dataDir>/live/releases/<kind>-<n>-
 * <hash>, then checks the copy against release.json again; the update runs from the copy only. An existing copy with
 * the same name is checked and reused. -> { dir } or { problem }.
 */
function copyRelease(dataDir, root, rel, parts, kind) {
  if (typeof dataDir !== 'string') return { problem: 'no data folder for the update copy' };
  const bad = partsProblem(root, parts, rel.parts);
  if (bad) return { problem: bad };
  const dir = path.join(releasesDir(dataDir), `${kind}-${rel.n}-${rel.parts[parts[0]].sha256.slice(0, 16)}`);
  if (existsSync(dir)) {
    if (!partsProblem(dir, parts, rel.parts)) return { dir };
    rmSync(dir, { recursive: true, force: true });
  }
  const tmp = `${dir}.${process.pid}.tmp`;
  try {
    rmSync(tmp, { recursive: true, force: true });
    for (const f of folderFiles(root)) {
      if (f.rel !== 'release.json' && !parts.includes(partOf(f.rel))) continue;
      const to = path.join(tmp, ...f.rel.split('/'));
      mkdirSync(path.dirname(to), { recursive: true });
      cpSync(f.abs, to);
    }
    const again = partsProblem(tmp, parts, rel.parts);
    if (again) throw new Error(`${again} (changed while it was copied)`);
    renameSync(tmp, dir);
    return { dir };
  } catch (e) {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* temp folder */ }
    return { problem: `the update could not be copied (${String(e?.message ?? e).slice(0, 160)})` };
  }
}

/** A host update: strict checks on the offered folder, then a checked private copy. -> entry (of the copy) or { problem }. */
export function prepareHost(root, { dataDir, script = false, runtime = null } = {}) {
  const src = hostEntry(root, { script, runtime });
  if (src.problem) return src;
  const c = copyRelease(dataDir, root, readRelease(root), HOST_PARTS, 'host');
  if (c.problem) return c;
  const e = hostEntry(c.dir, { script, runtime });
  if (e.problem) return e;
  if (e.sha256 !== src.sha256) return { problem: 'the staged host is not the one that was checked' };
  return e;
}

/** A service update's folder must hold that service's entry file. -> problem text or null. */
export function serviceRootProblem(service, root) {
  const entry = SERVICE_ENTRY[service];
  if (!entry) return null;
  if (typeof root !== 'string' || !path.isAbsolute(root) || !existsSync(path.join(root, ...entry))) return 'root must be an absolute folder that holds the service entry file';
  return null;
}

/** A service update: entry file, strict release.json (services, data and overlay hashes), a checked private copy. */
export function prepareService(service, root, { dataDir } = {}) {
  const why = serviceRootProblem(service, root);
  if (why) return { problem: why };
  const rel = readRelease(root);
  const bad = releaseProblem(rel, SERVICE_PARTS);
  if (bad) return { problem: bad };
  const c = copyRelease(dataDir, root, rel, SERVICE_PARTS, 'services');
  if (c.problem) return c;
  return { root: c.dir, version: rel.version, n: rel.n, parts: rel.parts };
}

function servicePrepProblem(w) {
  return serviceRootProblem(w.part, w.root) ?? partsProblem(w.root, SERVICE_PARTS, w.parts);
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

// ---- host-update.json (v2) ----
const recOf = (e) => ({ root: e.root, version: e.version, n: e.n, sha256: e.sha256, files: e.files });
const sameRel = (a, b) => !!a && !!b && a.n === b.n && a.sha256 === b.sha256;
const isRec = (r) => !!r && typeof r.root === 'string' && typeof r.version === 'string' && Number.isInteger(r.n) && HEX64.test(r.sha256 ?? '') && Number.isInteger(r.files);

/** -> { pending, good, rejected } (an older or unreadable file reads as empty). */
export function readHostStage(dataDir) {
  try {
    const j = JSON.parse(readFileSync(liveFile(dataDir, HOST_STAGE_FILE), 'utf8'));
    if (j?.v !== 2) return { pending: null, good: null, rejected: [] };
    return {
      pending: isRec(j.pending) ? j.pending : null,
      good: isRec(j.good) ? j.good : null,
      rejected: Array.isArray(j.rejected) ? j.rejected.filter((r) => Number.isInteger(r?.n) && HEX64.test(r?.sha256 ?? '')).slice(-REJECTED_KEPT) : [],
    };
  } catch { return { pending: null, good: null, rejected: [] }; }
}
function writeHostStage(dataDir, st, log = () => {}) {
  if (typeof dataDir !== 'string') return;
  const f = liveFile(dataDir, HOST_STAGE_FILE);
  try {
    if (!st.pending && !st.good && !st.rejected.length) rmSync(f, { force: true });
    else writeAtomic(f, { v: 2, pending: st.pending, good: st.good, rejected: st.rejected.slice(-REJECTED_KEPT), at: new Date().toISOString() });
  } catch (e) { log(`WARNING: host update record not saved (${e.message})`); }
}
/** The host release to try at the next start (staged, or about to be applied). */
export function stageHostPending(dataDir, entry, log) {
  const st = readHostStage(dataDir);
  writeHostStage(dataDir, { ...st, pending: recOf(entry) }, log);
}
/** entry started and loaded the project: it is the last known good host; pending is cleared when it was this one. */
export function acceptHost(dataDir, entry, log) {
  const st = readHostStage(dataDir);
  writeHostStage(dataDir, { ...st, good: recOf(entry), pending: sameRel(st.pending, entry) ? null : st.pending }, log);
}
/** entry failed (readiness, project load or check): never tried again; removed from pending and good. */
export function rejectHost(dataDir, entry, reason, log) {
  const st = readHostStage(dataDir);
  const rejected = [...st.rejected.filter((r) => !sameRel(r, entry)), { n: entry.n, sha256: entry.sha256, version: entry.version, reason: String(reason ?? '').slice(0, 160), at: new Date().toISOString() }];
  writeHostStage(dataDir, { pending: sameRel(st.pending, entry) ? null : st.pending, good: sameRel(st.good, entry) ? null : st.good, rejected }, log);
}

/**
 * Launcher start: the host releases to try, in order (pending, then good), each checked (exe and whole host part,
 * newer than the installed release (own.n; a dev checkout counts as 0), not rejected). Records that no longer qualify
 * are removed (reasons returned for the log); copies under live/releases that no record names are deleted. The
 * launcher tries each candidate as a trial (ready and project loaded), calls acceptHost / rejectHost, and falls back
 * to the installed host when none works.
 */
export function takeStartupHost({ dataDir, own = null, script = false, runtime = null }) {
  const st = readHostStage(dataDir);
  const ownN = Number.isInteger(own?.n) ? own.n : 0;
  const candidates = []; const dropped = [];
  for (const kind of ['pending', 'good']) {
    const r = st[kind];
    if (!r) continue;
    let why = null;
    if (st.rejected.some((x) => sameRel(x, r))) why = 'it failed before';
    else if (r.n <= ownN) why = 'the running release already has it';
    else if (candidates.some((c) => sameRel(c.entry, r))) continue;
    else why = hostEntryProblem(r, { script, runtime });
    if (why) { st[kind] = null; dropped.push(`${r.version}: ${why}`); continue; }
    candidates.push({ entry: { ...hostEntry(r.root, { script, runtime }), root: r.root }, kind });
  }
  if (dropped.length) writeHostStage(dataDir, st);
  // Copies no record names (services, replaced or rejected hosts) are not needed any more.
  try {
    const keep = new Set([st.pending?.root, st.good?.root].filter(Boolean).map((p) => path.resolve(p)));
    const dir = releasesDir(dataDir);
    if (existsSync(dir)) for (const d of readdirSync(dir)) { const abs = path.join(dir, d); if (!keep.has(path.resolve(abs))) rmSync(abs, { recursive: true, force: true }); }
  } catch { /* the next start tries again */ }
  return { candidates, dropped };
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
 * Maintenance lock on stream and recording starts (Codex review of D343, P1). Every start the UI server sends to the
 * host takes a lease first (over the authority channel, stream-recovery.mjs serveAuthority) and gives it back after the
 * host answered. hold() refuses new leases at once, then waits until no lease is out; only then does the launcher read
 * the last outputs.status and restart the host. end() lifts it after the replacement or the rollback. A lease whose
 * owner (a UI server process) goes away is given back.
 */
export function createStartGate() {
  let held = null; let seq = 0;
  const leases = new Map(); // id -> owner
  let idle = [];
  const flush = () => { if (!leases.size) { const w = idle; idle = []; for (const f of w) f(); } };
  return {
    lease(owner = null) {
      if (held) return { ok: false, reason: held };
      const id = ++seq; leases.set(id, owner);
      return { ok: true, lease: id };
    },
    release(id) { leases.delete(id); flush(); },
    releaseOwner(owner) { for (const [id, o] of leases) if (o === owner) leases.delete(id); flush(); },
    /** -> true when held with no start in flight; false (not held) when another hold is on or a start did not finish in ms. */
    async hold(reason, ms = 15_000) {
      if (held) return false;
      held = String(reason ?? 'maintenance').slice(0, 80);
      if (!leases.size) return true;
      let t;
      const ok = await new Promise((r) => { idle.push(() => r(true)); t = setTimeout(() => r(false), ms); t.unref?.(); });
      clearTimeout(t);
      if (!ok) held = null;
      return ok;
    },
    end() { held = null; },
    state: () => ({ held, inFlight: leases.size }),
  };
}

/**
 * The queue. Callbacks (the launcher's):
 *   outputs()             -> outputs.status of the running host (fresh), or null when there is no host. Throws when the
 *                            host does not answer (counts as busy).
 *   swapService(s, root)  -> { result, reason } (LU3 slot swap)
 *   applyHost(entry)      -> { result, reason } (planned host restart from entry; null when there is no host)
 *   hostInfo()            -> { script, runtime } of the running host (for hostEntry)
 * startupHost: { entry, kind } when this start runs a host release from host-update.json (after its trial).
 * own: { version, n, parts } of the installed release (null in a dev checkout).
 */
export function createUpdates({ dataDir, session, own = null, outputs = async () => null, swapService = null, applyHost = null,
  hostInfo = () => ({ script: false, runtime: null }), accepting = true, startupHost = null, log = () => {}, now = Date.now, pollMs = 2000 }) {
  const ownVersion = own?.version ?? 'dev';
  const ownN = Number.isInteger(own?.n) ? own.n : 0;
  const versions = Object.fromEntries(PARTS.map((p) => [p, ownVersion]));
  const nOf = Object.fromEntries(PARTS.map((p) => [p, ownN])); // the running release number of each part
  let hostSha = own?.parts?.host?.sha256 ?? null;
  if (startupHost?.entry?.version) {
    versions.host = startupHost.entry.version; versions['overlay-server'] = startupHost.entry.version;
    nOf.host = startupHost.entry.n; nOf['overlay-server'] = startupHost.entry.n;
    hostSha = startupHost.entry.sha256 ?? hostSha;
  }
  const waiting = []; // { id, part, root, entry?, parts?, version, n, click, at }
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
    : `${label(w.part)} update ${w.version} is ready: Apply now updates it while live without stopping the stream. It waits for your click.`);
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
      // Checked once more right before it runs: the copy is ours, but a check is cheap next to a broken host.
      const bad = hostEntryProblem(w.entry, hostInfo());
      if (bad) { rejectHost(dataDir, w.entry, bad, log); note('host', w.version, 'failed', bad); return { result: 'failed', reason: bad }; }
      stageHostPending(dataDir, w.entry, log); // a crash of the launcher during the restart still tries it next start
      const r = await applyHost(w.entry);
      // 'busy': a stream or recording started between the queue's check and the restart (the launcher checks again
      // right before it stops the host); the update goes back to waiting.
      if (r?.result === 'busy') return r;
      if (r?.result === 'swapped') {
        versions.host = w.version; versions['overlay-server'] = w.version;
        nOf.host = w.n; nOf['overlay-server'] = w.n; hostSha = w.entry.sha256;
        acceptHost(dataDir, w.entry, log);
      } else rejectHost(dataDir, w.entry, r?.reason ?? r?.result ?? 'failed', log);
      note('host', w.version, r?.result ?? 'failed', r?.reason);
      return r ?? { result: 'failed' };
    }
    if (!swapService) return { result: 'refused', reason: 'service swaps are not set up' };
    const bad = servicePrepProblem(w);
    if (bad) { note(w.part, w.version, 'failed', bad); return { result: 'failed', reason: bad }; }
    const r = await swapService(w.part, w.root);
    if (r?.result === 'swapped') { versions[w.part] = w.version; nOf[w.part] = w.n; }
    note(w.part, w.version, r?.result ?? 'failed', r?.reason ?? r?.failed?.join('; '));
    return r ?? { result: 'failed' };
  }
  const drop = (w) => { const i = waiting.indexOf(w); if (i >= 0) waiting.splice(i, 1); };
  /** Same-part waiting items are replaced by w (newer: checked by the caller), before w is applied or queued. */
  function supersede(w) {
    for (const old of waiting.filter((x) => x.part === w.part && x !== w)) { drop(old); note(w.part, old.version, 'replaced', `by ${w.version}`); }
  }
  function enqueue(w) {
    supersede(w);
    if (!waiting.includes(w)) waiting.push(w);
    if (w.part === 'host') stageHostPending(dataDir, w.entry, log);
    mirror();
    if (w.part === 'host') poll();
  }
  function poll() {
    if (timer || closed) return;
    timer = setInterval(() => { void tick(); }, pollMs);
    timer.unref?.();
  }
  const hostWaiting = () => waiting.filter((w) => w.part === 'host');
  async function tick() {
    // Only the host is applied by the poll (at the stop); a service waits for its click (AGENTS, D343).
    if (closed || running || !hostWaiting().length) { if (!hostWaiting().length && timer) { clearInterval(timer); timer = null; } return; }
    await serial(async () => {
      for (const w of hostWaiting()) {
        if (closed || await busy()) break;
        drop(w);
        mirror();
        const r = await applyNow(w);
        if (r?.result === 'busy') { enqueue(w); break; }
        mirror();
      }
    });
    if (!hostWaiting().length && timer) { clearInterval(timer); timer = null; }
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
          const src = hostEntry(root, hostInfo());
          if (src.problem) return { result: 'refused', reason: src.problem };
          if (hostSha && src.sha256 === hostSha) return { result: 'unchanged', reason: 'the update does not change the host' };
          if (src.n <= nOf.host) return { result: 'refused', reason: `release ${src.n} is not newer than the running host (${nOf.host})` };
          const entry = prepareHost(root, { dataDir, ...hostInfo() });
          if (entry.problem) return { result: 'refused', reason: entry.problem };
          w = { id: `u${++seq}`, part, root: entry.root, entry, version: entry.version, n: entry.n, click: false, at: iso() };
        } else {
          if (!Object.hasOwn(SERVICE_ENTRY, part)) return { result: 'refused', reason: 'unknown or not wired service' };
          const prep = prepareService(part, root, { dataDir });
          if (prep.problem) return { result: 'refused', reason: prep.problem };
          if (prep.n <= nOf[part]) return { result: 'refused', reason: `release ${prep.n} is not newer than the running ${label(part)} (${nOf[part]})` };
          w = { id: `u${++seq}`, part, root: prep.root, parts: prep.parts, version: prep.version, n: prep.n, click: true, at: iso() };
        }
        const newer = waiting.find((x) => x.part === part && x.n >= w.n);
        if (newer) return { result: 'refused', reason: `release ${newer.n} of the ${label(part)} already waits` };
        supersede(w); // an older waiting item never runs after this one
        if (!(await busy())) {
          mirror();
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
    /** The app closes: a staged host update stays in host-update.json (pending) for the next start; services that
     *  wait are dropped. */
    close() {
      closed = true;
      if (timer) { clearInterval(timer); timer = null; }
      const lines = [];
      for (const w of waiting) {
        if (w.part === 'host') lines.push(`host update ${w.version} waits: it is tried at the next start`);
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
