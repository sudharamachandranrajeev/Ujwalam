// SPDX-License-Identifier: GPL-3.0-or-later
// LU6 live install (D349): Install-Ujwalam.ps1, run while Ujwalam runs or is live, installs the new version next to the
// running one and hands it to the running launcher's update queue (services/supervisor/updates.mjs) through this
// channel, instead of refusing or overwriting the running install. Node stdlib only.
//
// Transport: a Windows named pipe with a random name (\\.\pipe\ujwalam-install-<32 hex>), new at each launcher start,
// and a 64-hex token. Both are written owner-only to <dataDir>/live/install-channel.json (the same protection as
// api.json), so only the user who runs Ujwalam can find and use it; the name cannot be squatted in advance. No TCP port.
// The file is removed when the launcher stops.
//
// Protocol: one request line, one reply line (UTF-8 JSON, at most 16 KB in):
//   -> { t: 'ujwalam-install', token, root }      root: the new version's installed folder (absolute)
//   <- { t: 'ujwalam-install', ok, version, results: [{ service, label, result, text }], skipped: [{ service, label, text }] }
// The launcher asks its own swap handler (serveSwaps, the same checks as the parent's IPC requests) once per part the
// new release changes, in the order event core, control page server, studio window, host. Each request goes through
// the update queue unchanged: release.json with n and the LU1 part hashes, a checked private copy, nothing live ->
// applied at once (the user's own install action), live -> a service waits for one click (Apply now) and the host is
// staged for the stop (LU5). The channel never applies anything itself and never skips the click.
// Chat, rules, the LAN remote and the event core have no way to this channel: there is no port, and no code path in
// them reads install-channel.json or opens a pipe. A same-user program that can read the file can also run the
// installer itself, which is the trust line D343 already draws (the data folder belongs to the user).

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { writeSecretFileAtomic } from '../event-core/api/discovery.mjs';
import { PART_LABELS, readRelease } from './updates.mjs';

export const INSTALL_MSG = 'ujwalam-install';
export const INSTALL_CHANNEL_FILE = 'install-channel.json';
const MAX_IN = 16 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;
const SERVICE_PARTS = ['services', 'data', 'overlay'];

/** The swap request names, the queue part each one updates and its label. */
const ORDER = Object.freeze([
  { service: 'event-core', part: 'event-core' },
  { service: 'studio-ui', part: 'studio-ui' },
  { service: 'studio', part: 'studio-window' },
  { service: 'host', part: 'host' },
]);
const labelOf = (part) => PART_LABELS[part] ?? part;
const hashOf = (parts, p) => (HEX64.test(parts?.[p]?.sha256 ?? '') ? parts[p].sha256 : null);

/**
 * Pure: which swap requests a new release needs. running: the queue's runningParts() (per queue part the LU1 hashes it
 * runs from, null when unknown: a dev checkout). parts: the new release.json `parts`. has(service): the launcher runs
 * that service in a slot (the studio window may be a browser page instead). An unknown running hash counts as changed.
 * -> { plan: [{ service, part }], skipped: [{ service, part, why }] }
 */
export function installPlan({ running = {}, parts, has = () => true }) {
  const plan = [];
  const skipped = [];
  for (const o of ORDER) {
    if (o.part === 'event-core' || o.part === 'studio-ui') {
      const cur = running[o.part];
      const same = SERVICE_PARTS.every((p) => hashOf(cur, p) && hashOf(cur, p) === hashOf(parts, p));
      if (same) skipped.push({ ...o, why: 'unchanged' });
      else plan.push(o);
      continue;
    }
    const name = o.part === 'host' ? 'host' : 'studio-window';
    const want = hashOf(parts, name);
    if (!want || !(parts[name].files > 0)) { skipped.push({ ...o, why: 'not in this release' }); continue; }
    if (running[o.part] && running[o.part] === want) { skipped.push({ ...o, why: 'unchanged' }); continue; }
    if (!has(o.service)) { skipped.push({ ...o, why: 'not running' }); continue; }
    plan.push(o);
  }
  return { plan, skipped };
}

/** Pure: one plain sentence for a swap reply, for the installer's output. */
export function resultText(part, r) {
  const l = labelOf(part);
  const why = typeof r?.reason === 'string' && r.reason ? `: ${r.reason.slice(0, 200)}` : '';
  switch (r?.result) {
    case 'swapped': case 'applied': return `${l}: updated now, without stopping anything.`;
    case 'waiting': return `${l}: ready. Something is live, so it waits for one click on Apply now (control page, Versions and updates).`;
    case 'staged': return `${l}: staged. It is applied when every stream and recording has stopped (the host owns the encoders).`;
    case 'unchanged': return `${l}: unchanged.`;
    case 'kept-old': return `${l}: the new version failed its check; the running one was kept${why}.`;
    case 'restored-old': return `${l}: the new version failed; the previous one runs again${why}.`;
    case 'refused': return `${l}: not updated now${why}. The new version runs from the next start.`;
    default: return `${l}: not updated now (${r?.result ?? 'no answer'}${why}). The new version runs from the next start.`;
  }
}

const skipText = (s) => (s.why === 'unchanged' ? `${labelOf(s.part)}: unchanged.`
  : s.why === 'not running' ? `${labelOf(s.part)}: not running now; the new version is used at the next start.`
    : `${labelOf(s.part)}: not in this release.`);

function tokenOk(got, want) {
  if (typeof got !== 'string' || !HEX64.test(got)) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

/** Request checks before anything is asked. -> { rel } or { problem } */
export function installRequestProblem(m, token) {
  if (m?.t !== INSTALL_MSG) return { problem: 'bad request' };
  if (!tokenOk(m.token, token)) return { problem: 'not allowed' };
  if (typeof m.root !== 'string' || !path.isAbsolute(m.root)) return { problem: 'the new version folder must be an absolute path' };
  let dir = false;
  try { dir = statSync(m.root).isDirectory(); } catch { dir = false; }
  if (!dir) return { problem: 'the new version folder does not exist' };
  const rel = readRelease(m.root);
  if (!rel || !Number.isInteger(rel.n) || rel.n < 1 || !rel.parts) return { problem: 'the new version has no release.json with a release number and part hashes' };
  return { rel };
}

/**
 * The launcher's install channel. ask(service, root) -> Promise<swap reply> (serveSwaps through a local message channel).
 * running() -> the queue's runningParts(); has(service) -> the launcher runs it in a slot.
 * -> { file, pipe, close() } once listening.
 */
export async function createInstallChannel({ dataDir, ask, running = () => ({}), has = () => true, log = () => {}, pipeName = null }) {
  const pipe = pipeName ?? `ujwalam-install-${randomBytes(16).toString('hex')}`;
  const pipePath = `\\\\.\\pipe\\${pipe}`;
  const token = randomBytes(32).toString('hex');
  const file = path.join(dataDir, 'live', INSTALL_CHANNEL_FILE);
  let busy = false;
  const sockets = new Set();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => { /* the installer went away */ });
    let buf = '';
    let done = false;
    const reply = (o) => { if (done) return; done = true; try { sock.end(`${JSON.stringify({ t: INSTALL_MSG, ...o })}\n`); } catch { /* gone */ } };
    sock.setEncoding('utf8');
    sock.on('data', async (d) => {
      if (done) return;
      buf += d;
      if (buf.length > MAX_IN) { reply({ ok: false, reason: 'request too large' }); return; }
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      let m = null;
      try { m = JSON.parse(buf.slice(0, nl)); } catch { m = null; }
      buf = '';
      const chk = installRequestProblem(m, token);
      if (chk.problem) { reply({ ok: false, reason: chk.problem }); return; }
      if (busy) { reply({ ok: false, reason: 'another install is being handed over' }); return; }
      busy = true;
      try {
        const root = path.resolve(m.root);
        const { plan, skipped } = installPlan({ running: running(), parts: chk.rel.parts, has });
        log(`live install ${chk.rel.version}: ${plan.length ? plan.map((p) => p.service).join(', ') : 'nothing'} handed to the update queue`);
        const results = [];
        for (const p of plan) {
          let r;
          try { r = await ask(p.service, root); } catch (e) { r = { result: 'failed', reason: String(e?.message ?? e).slice(0, 160) }; }
          results.push({ service: p.service, label: labelOf(p.part), result: r?.result ?? 'failed', text: resultText(p.part, r) });
        }
        reply({ ok: true, version: chk.rel.version, results, skipped: skipped.map((s) => ({ service: s.service, label: labelOf(s.part), text: skipText(s) })) });
      } catch (e) {
        reply({ ok: false, reason: String(e?.message ?? e).slice(0, 160) });
      } finally { busy = false; }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipePath, () => { server.off('error', reject); resolve(); }); });
  server.on('error', (e) => log(`install channel: ${e.message}`));
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeSecretFileAtomic(file, `${JSON.stringify({ v: 1, pipe, token, pid: process.pid, at: new Date().toISOString() }, null, 2)}\n`);
  } catch (e) {
    server.close();
    throw new Error(`install channel file could not be written owner-only (${e.message})`);
  }
  return {
    file, pipe,
    close() {
      for (const s of sockets) s.destroy();
      server.close();
      // Only our own file: a newer launcher may have written its own.
      try { if (existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).pipe === pipe) rmSync(file, { force: true }); } catch { /* gone */ }
    },
  };
}
