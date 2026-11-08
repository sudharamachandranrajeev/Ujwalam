// SPDX-License-Identifier: GPL-3.0-or-later
// Clips from a finished recording (D283, flag `clip-pipeline`, off by default). The launcher reads outputs.status every
// few seconds; when the record sinks stop, the H (and V) files of that recording are queued for the post-stream
// clipper (services/clip/clipper.py run --detect). One run at a time, never while a stream is live (6 GB VRAM: while
// live only the live-AI sidecar stays loaded, AGENTS.md); a stream that starts stops the run and it is queued again.
// The state goes to <dataDir>/clips/status.json for the UI server (counts and file names only).

import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CLIP_FLAG = 'clip-pipeline';
const ACTIVE = new Set(['starting', 'live', 'reconnecting', 'retrying']);

const canvasOf = (status, rungId) => (Array.isArray(status?.rungs) ? status.rungs : []).find((r) => r.id === rungId)?.canvas ?? null;
const recordSinks = (status) => (Array.isArray(status?.sinks) ? status.sinks : []).filter((s) => s.kind === 'record' && typeof s.id === 'string');

/** Recordings that ended between two outputs.status answers: { h, v } file paths (v may be null), or null. */
export function finishedRecording(prev, cur) {
  const was = recordSinks(prev).filter((s) => ACTIVE.has(s.state));
  if (!was.length) return null;
  const now = new Map(recordSinks(cur).map((s) => [s.id, s]));
  if (was.some((s) => ACTIVE.has(now.get(s.id)?.state))) return null; // still recording (all sinks stop together)
  const files = { h: null, v: null };
  for (const s of was) {
    const p = now.get(s.id)?.path ?? s.path;
    const c = String(canvasOf(cur, s.rung) ?? canvasOf(prev, s.rung) ?? '').toUpperCase();
    if (typeof p === 'string' && p && (c === 'H' || c === 'V') && !files[c.toLowerCase()]) files[c.toLowerCase()] = p;
  }
  return files.h ? files : null;
}

export const isLive = (status) => (Array.isArray(status?.sinks) ? status.sinks : []).some((s) => s.kind === 'stream' && ACTIVE.has(s.state));

/** Python and argv for one clip run, or { spec: null, reason }. clipRoot holds services/clip and the venv. */
export function clipRunSpec({ clipRoot, dataDir, h, v = null, exists = existsSync }) {
  if (!clipRoot) return { spec: null, reason: 'no clip folder set (clipRoot)' };
  const py = ['.venv-gpu', '.venv'].map((x) => path.join(clipRoot, x, 'Scripts', 'python.exe')).find((p) => exists(p));
  if (!py) return { spec: null, reason: `no Python venv in ${clipRoot}` };
  const script = path.join(clipRoot, 'services', 'clip', 'clipper.py');
  if (!exists(script)) return { spec: null, reason: `no clipper in ${clipRoot}` };
  const out = path.join(dataDir, 'clips', path.basename(h).replace(/\.[^.]+$/, ''));
  const argv = ['-I', script, '--data-dir', dataDir, 'run', '--detect', '--threads', '4', '--encoder', 'h264_nvenc', '--recording', h];
  if (v) argv.push('--v-recording', v);
  const db = path.join(dataDir, 'event-core.db');
  if (exists(db)) argv.push('--chat-db', db);
  argv.push('--out', out);
  return { spec: { exe: py, argv, out }, reason: null };
}

/** Number of rendered clip files in a run's out folder (out/clips/<id>/*.mp4). */
export function countClips(out) {
  try {
    return readdirSync(path.join(out, 'clips'), { withFileTypes: true }).filter((d) => d.isDirectory())
      .reduce((n, d) => n + readdirSync(path.join(out, 'clips', d.name)).filter((f) => f.endsWith('.mp4')).length, 0);
  } catch { return 0; }
}

/** The queue and the child. deps: { flagOn(), log(line), spawn?, now? }. feed(status) is called with each outputs.status. */
export function createRecordClips({ clipRoot, dataDir, flagOn, log, spawnFn = spawn, now = Date.now }) {
  const queue = [];
  let prev = null; let child = null; let current = null; let last = null; let stopped = false;
  const statusFile = path.join(dataDir, 'clips', 'status.json');
  // A run cut short by closing Ujwalam (or queued then) is queued again at the next start, while its files exist.
  try {
    const old = JSON.parse(readFileSync(statusFile, 'utf8'));
    last = old.last ?? null;
    for (const j of [old.running, ...(old.queued ?? [])]) {
      if (j && typeof j.h === 'string' && existsSync(j.h)) queue.push({ h: j.h, v: typeof j.v === 'string' && existsSync(j.v) ? j.v : null });
    }
    if (queue.length) log(`clips: ${queue.length} recording(s) from the last session queued again`);
  } catch { /* no status yet */ }
  const write = () => {
    const s = { at: new Date(now()).toISOString(), on: flagOn(), state: current ? 'running' : queue.length ? 'queued' : 'idle',
      running: current ? { h: current.h, v: current.v } : null, queued: queue.filter((q) => q !== current).map((q) => ({ h: q.h, v: q.v })), last };
    try {
      mkdirSync(path.dirname(statusFile), { recursive: true });
      writeFileSync(`${statusFile}.tmp`, JSON.stringify(s, null, 2));
      renameSync(`${statusFile}.tmp`, statusFile);
    } catch { /* best effort: the status file only feeds the UI */ }
  };
  const start = (live) => {
    if (child || stopped || live || !queue.length || !flagOn()) return;
    const job = queue[0];
    const { spec, reason } = clipRunSpec({ clipRoot, dataDir, h: job.h, v: job.v });
    if (!spec) { queue.shift(); last = { recording: path.basename(job.h), result: 'not-run', reason }; log(`clips: not made for ${path.basename(job.h)}: ${reason}`); write(); return; }
    mkdirSync(spec.out, { recursive: true });
    const logFile = path.join(path.dirname(spec.out), `run-${path.basename(spec.out)}.log`);
    const fd = openSync(logFile, 'a');
    current = job;
    child = spawnFn(spec.exe, spec.argv, { stdio: ['ignore', fd, fd], windowsHide: true, cwd: clipRoot });
    closeSync(fd);
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* a fake child has no pid */ }
    log(`clips: making clips from ${path.basename(job.h)} (log ${logFile})`);
    write();
    child.once('exit', (code) => {
      if (stopped) return; // Ujwalam closing: the status keeps this run, so the next start queues it again
      const done = current; child = null; current = null;
      if (done?.stoppedForLive) { log(`clips: run for ${path.basename(done.h)} stopped for the stream; it runs again after`); write(); return; }
      queue.shift();
      const n = code === 0 ? countClips(spec.out) : 0;
      last = { recording: path.basename(done.h), result: code === 0 ? 'done' : 'failed', code, clips: n, out: spec.out };
      log(code === 0 ? `clips: ${n} clip file(s) made from ${path.basename(done.h)} in ${spec.out}` : `clips: run for ${path.basename(done.h)} failed (exit ${code}); see ${logFile}`);
      write();
      start(false);
    });
  };
  return {
    feed(status) {
      const live = isLive(status);
      const f = finishedRecording(prev, status);
      prev = status;
      if (f && flagOn()) { queue.push(f); log(`clips: recording ${path.basename(f.h)} finished; queued for clips`); write(); }
      if (live && child && current && !current.stoppedForLive) { current.stoppedForLive = true; child.kill(); }
      if (!live && !child) { if (queue[0]) delete queue[0].stoppedForLive; start(false); }
    },
    stop() { stopped = true; if (child) child.kill(); },
    state: () => ({ running: current?.h ?? null, queued: queue.map((q) => q.h), last }),
  };
}
