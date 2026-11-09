// SPDX-License-Identifier: GPL-3.0-or-later
// Clips from recordings and streams (D283, D284). The launcher feeds outputs.status every few seconds. What happens
// follows the user's settings (user-settings.mjs, Settings > Clips in the studio window), separately for a plain
// recording and for a live stream (a recording during which a stream ran counts as live):
//   ask   - when it stops, the studio asks "make clips from it?" (status.asks; the answer comes back as
//           <dataDir>/clips/answer.json, written by the UI server)
//   after - when it stops, the whole recording is searched and the best moments are edited into clips
//           (clipper.py run --detect)
//   while - while it runs, the live clipper watches the game and keeps the best moments (replay saves); when it stops
//           those moments are edited into clips (clipper.py live-review --since --until)
//   off   - nothing
// One run at a time, hidden, below-normal priority, never while a stream is live (6 GB VRAM: while live only the
// live-AI sidecar stays loaded): a stream that starts stops the run and it runs again after. A run cut short by
// closing Ujwalam runs again at the next start. State for the UI server: <dataDir>/clips/status.json.
// Output layout (user 2026-11-08, D298 proposed): each run works in <dataDir>/clips/runs/<name> (analysis files, logs,
// render/report JSON, working videos); only finished, validated videos are published to the clips folder from the
// settings (default <dataDir>/clips) as <YYYY-MM-DD>/<game>_<kind>_<stamp>_<label>_<nn>_<canvas>.mp4
// (services/clip/clip_names.py). A whole-recording run also makes kill montages when the V recording exists; a
// review run deletes the live clipper's replay saves it used (host-named intermediates) once every clip rendered.

import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PARENT_PIPE_ENV } from '../common/parent-pipe.mjs';
import { killChildTree } from '../common/kill-tree.mjs';
import { clipsFolder, readSettings, writeSettings } from './user-settings.mjs';
import { writeTaskFile } from './tasks.mjs';

const ACTIVE = new Set(['starting', 'live', 'reconnecting', 'retrying']);

const canvasOf = (status, rungId) => (Array.isArray(status?.rungs) ? status.rungs : []).find((r) => r.id === rungId)?.canvas ?? null;
const sinksOf = (status, kind) => (Array.isArray(status?.sinks) ? status.sinks : []).filter((s) => s.kind === kind && typeof s.id === 'string');
export const isRecording = (status) => sinksOf(status, 'record').some((s) => ACTIVE.has(s.state));
export const isLive = (status) => sinksOf(status, 'stream').some((s) => ACTIVE.has(s.state));

/** Recordings that ended between two outputs.status answers: { h, v } file paths (v may be null), or null. */
export function finishedRecording(prev, cur) {
  const was = sinksOf(prev, 'record').filter((s) => ACTIVE.has(s.state));
  if (!was.length) return null;
  const now = new Map(sinksOf(cur, 'record').map((s) => [s.id, s]));
  if (was.some((s) => ACTIVE.has(now.get(s.id)?.state))) return null; // still recording (all sinks stop together)
  const files = { h: null, v: null };
  for (const s of was) {
    const p = now.get(s.id)?.path ?? s.path;
    const c = String(canvasOf(cur, s.rung) ?? canvasOf(prev, s.rung) ?? '').toUpperCase();
    if (typeof p === 'string' && p && (c === 'H' || c === 'V') && !files[c.toLowerCase()]) files[c.toLowerCase()] = p;
  }
  return files.h ? files : null;
}

// What to do when the clip maker cannot run. The Alpha zip ships no Python (D283), so an installed copy needs a folder
// that has services/clip and its venv (a checkout): the updater writes it to ujwalam.json as clipRoot. No install.
export const CLIP_MAKER_FIX = 'To make clips, point Ujwalam at a folder that has the clip maker and its Python: Install-Ujwalam.ps1 -SettingsOnly -ClipMaker <folder>';

/**
 * Python + clipper in clipRoot, or the plain reason clips cannot be made: { py, script, reason, fix, missing }.
 * missing: null (ready) | 'root' (no clip root set) | 'python' (no .venv-gpu / .venv python.exe) | 'script' (no clipper.py).
 */
export function clipTools({ clipRoot, exists = existsSync }) {
  const no = (missing, reason) => ({ py: null, script: null, reason, fix: CLIP_MAKER_FIX, missing });
  if (!clipRoot) return no('root', 'the clip maker is not set up on this PC');
  const py = ['.venv-gpu', '.venv'].map((x) => path.join(clipRoot, x, 'Scripts', 'python.exe')).find((p) => exists(p));
  const script = path.join(clipRoot, 'services', 'clip', 'clipper.py');
  // Python first: an installed copy has neither, and Python is the part the download cannot bring.
  if (!py) return no('python', `the clip maker's Python is missing (the Ujwalam download does not include Python; looked in ${clipRoot})`);
  if (!exists(script)) return no('script', `the clip maker is missing in ${clipRoot} (no services\\clip\\clipper.py)`);
  return { py, script, reason: null, fix: null, missing: null };
}

/** The live clipper's newest session folder (holds saves.jsonl), or null. */
export function newestSaves(dataDir) {
  const root = path.join(dataDir, 'live-clips');
  try {
    const d = readdirSync(root, { withFileTypes: true }).filter((x) => x.isDirectory() && existsSync(path.join(root, x.name, 'saves.jsonl')))
      .map((x) => path.join(root, x.name)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return d[0] ?? null;
  } catch { return null; }
}

/** Python and argv for one job, or { spec: null, reason }. job: { type: 'full'|'review', h?, v?, since?, until?, name }.
 *  out = the run folder in app data (workRoot); outRoot = the clips folder that gets the finished videos only. */
export function clipRunSpec({ clipRoot, dataDir, job, outRoot = clipsFolder(dataDir), workRoot = path.join(dataDir, 'clips', 'runs'), saves = undefined, exists = existsSync }) {
  const t = clipTools({ clipRoot, exists });
  if (!t.py) return { spec: null, reason: t.reason };
  const out = path.join(workRoot, job.name);
  const argv = ['-I', t.script, '--data-dir', dataDir];
  if (job.type === 'review') {
    const s = saves === undefined ? newestSaves(dataDir) : saves;
    if (!s) return { spec: null, reason: 'no moments were found while it ran' };
    argv.push('live-review', '--saves', s);
    if (job.since) argv.push('--since', job.since);
    if (job.until) argv.push('--until', job.until);
    // Match gate on the "while" path (D304 proposed): the stream's own H recording, when there is one, gives the
    // matches (detect + segment in live-review); saves in skipped matches are dropped. Without it every save is kept.
    if (typeof job.h === 'string' && job.h && exists(job.h)) argv.push('--recording', job.h, '--threads', '4');
    argv.push('--encoder', 'h264_nvenc', '--publish', outRoot, '--drop-used-saves', '--out', out);
  } else {
    if (!job.h) return { spec: null, reason: 'there is no recording to make clips from' };
    argv.push('run', '--detect', '--threads', '4', '--encoder', 'h264_nvenc', '--recording', job.h);
    if (job.v) argv.push('--v-recording', job.v, '--montage');
    const db = path.join(dataDir, 'event-core.db');
    if (exists(db)) argv.push('--chat-db', db);
    argv.push('--publish', outRoot, '--out', out);
  }
  return { spec: { exe: t.py, argv, out, folder: outRoot }, reason: null };
}

/** Number of finished clips of a run: the videos published to the clips folder (out/published.json and
 *  out/montage/published.json); a run folder without them (older runs) counts out/clips/<id>/*.mp4. */
export function countClips(out) {
  const pubs = [path.join(out, 'published.json'), path.join(out, 'montage', 'published.json')].filter((p) => existsSync(p));
  if (pubs.length) {
    return pubs.reduce((n, p) => { try { const j = JSON.parse(readFileSync(p, 'utf8')); return n + (Array.isArray(j.files) ? j.files.length : 0); } catch { return n; } }, 0);
  }
  try {
    return readdirSync(path.join(out, 'clips'), { withFileTypes: true }).filter((d) => d.isDirectory())
      .reduce((n, d) => n + readdirSync(path.join(out, 'clips', d.name)).filter((f) => f.endsWith('.mp4')).length, 0);
  } catch { return 0; }
}

export const PROGRESS_STAGES = Object.freeze(['detect', 'candidates', 'render', 'validate', 'review', 'gate']);
const PROGRESS_RE = /^ujwalam-progress\s+(\{.*\})\s*$/;
const STAGE_TITLE = { detect: 'Finding the best moments in', candidates: 'Choosing the best moments in', render: 'Editing clips', validate: 'Checking the clips from', review: 'Reviewing the moments in', gate: 'Checking the match results of' };

/** One clipper stderr line -> { stage, done, total, note } or null. Defensive: anything else is ignored, lengths capped. */
export function parseProgress(line) {
  if (typeof line !== 'string' || line.length > 2000) return null;
  const m = PROGRESS_RE.exec(line.trim());
  if (!m) return null;
  let j; try { j = JSON.parse(m[1]); } catch { return null; }
  if (!j || typeof j !== 'object' || !PROGRESS_STAGES.includes(j.stage)) return null;
  const n = (v) => (Number.isFinite(v) && v >= 0 && v <= 1e6 ? Math.floor(v) : null);
  const total = n(j.total) || null;
  let done = n(j.done); if (done !== null && total !== null && done > total) done = total;
  const note = typeof j.note === 'string' ? j.note.replace(/[\x00-\x1f]/g, ' ').replace(/[A-Za-z]:[\x5c/]\S*/g, '').trim().slice(0, 160) : null;
  return { stage: j.stage, done, total, note: note || null };
}

const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
const iso = (ms) => new Date(ms).toISOString();
const JOB_KEYS = ['type', 'kind', 'h', 'v', 'since', 'until', 'name', 'minutes'];
const pickJob = (j) => Object.fromEntries(JOB_KEYS.filter((k) => j[k] !== undefined).map((k) => [k, j[k]]));

/** The queue and the child. feed(status) is called with each outputs.status. */
export function createRecordClips({ clipRoot, dataDir, log, spawnFn = spawn, now = Date.now, postChain = null, killTreeFn = killChildTree }) {
  const stateDir = path.join(dataDir, 'clips');
  const statusFile = path.join(stateDir, 'status.json');
  const answerFile = path.join(stateDir, 'answer.json');
  const workerFile = path.join(stateDir, 'live-worker.json');
  const queue = []; let asks = [];
  let prev = null; let child = null; let current = null; let last = null; let stopped = false;
  let lastStatus = null; let progress = null; let liveNow = false; let recStart = null; let recSawLive = false; let liveStart = null; let liveHadRecording = false; let workerOn = null;

  // A run cut short by closing Ujwalam (or queued, or still to be answered) comes back at the next start.
  try {
    const old = JSON.parse(readFileSync(statusFile, 'utf8'));
    last = old.last ?? null;
    for (const j of [old.running, ...(old.queued ?? [])]) {
      if (j && (j.type === 'review' || (typeof j.h === 'string' && existsSync(j.h)))) queue.push(pickJob(j));
    }
    asks = (old.asks ?? []).filter((a) => a && typeof a.id === 'string' && typeof a.h === 'string' && existsSync(a.h));
    if (queue.length) log(`clips: ${queue.length} unfinished clip job(s) from the last session will run again`);
  } catch { /* no status yet */ }

  // Task bar (tasks.mjs): one task file per clip job, rewritten with every status write (that also keeps it fresh).
  const taskId = (j) => `clip-${String(j.name ?? 'run').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 70)}`;
  const taskFor = (j, p) => {
    const nm = j.name ?? 'the stream';
    const base = { id: taskId(j), kind: 'clips', startedAt: j.taskStart ?? now(), updatedAt: now() };
    if (j === current && !j.pausedForLive) {
      const st = p?.stage ?? 'detect';
      const title = st === 'render' && p?.total ? `Editing clips (${Math.min((p.done ?? 0) + 1, p.total)} of ${p.total})` : `${STAGE_TITLE[st]} ${nm}`;
      return { ...base, title, state: 'running', stage: st, done: p?.done ?? null, total: p?.total ?? null, note: p?.note ?? null };
    }
    return { ...base, title: `Clips from ${nm}`, state: 'waiting', stage: null, done: null, total: null,
      note: j === current ? 'Paused while the stream runs' : liveNow ? 'Waiting until the stream ends' : 'Waiting for its turn' };
  };
  const writeTasks = () => {
    for (const j of queue) { j.taskStart ??= now(); writeTaskFile(dataDir, taskFor(j, progress)); }
  };
  const finishTask = (j, ok, note) => writeTaskFile(dataDir, { id: taskId(j), kind: 'clips', title: ok ? `Clips ready from ${j.name}` : `Clips from ${j.name} did not finish`, state: ok ? 'done' : 'failed', note, startedAt: j.taskStart ?? now(), updatedAt: now() });

  const write = () => {
    writeTasks();
    const s = readSettings(dataDir);
    const t = clipTools({ clipRoot });
    const out = { at: iso(now()), state: current ? 'running' : queue.length ? 'queued' : 'idle', available: !!t.py, reason: t.reason, fix: t.fix, missing: t.missing,
      settings: s.clips, folder: clipsFolder(dataDir, s),
      running: current ? pickJob(current) : null, queued: queue.filter((q) => q !== current).map(pickJob), asks, last };
    try {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(`${statusFile}.tmp`, JSON.stringify(out, null, 2));
      renameSync(`${statusFile}.tmp`, statusFile);
    } catch { /* best effort: the status file only feeds the UI */ }
  };
  const setWorker = (on) => {
    // Rewritten every tick while on (the worker ignores a file older than 30 s, so a crashed launcher stops it).
    if (!on && workerOn === false) return;
    workerOn = on;
    try { mkdirSync(stateDir, { recursive: true }); writeFileSync(workerFile, JSON.stringify({ on, atMs: now() })); } catch { /* next tick */ }
    if (on !== workerOn) log(`clips: watching for moments ${on ? 'on' : 'off'}`);
  };
  const add = (job, why) => { queue.push(job); log(`clips: ${why}`); };
  const start = () => {
    if (child || stopped || !queue.length) return;
    const job = queue[0];
    const { spec, reason } = clipRunSpec({ clipRoot, dataDir, job });
    if (!spec) {
      queue.shift(); last = { name: job.name, kind: job.kind, result: 'not-made', reason, clips: 0 };
      finishTask(job, false, reason);
      log(`clips: none made for ${job.name}: ${reason}`); write(); start(); return;
    }
    mkdirSync(spec.out, { recursive: true });
    const logFile = path.join(stateDir, `run-${job.name}.log`);
    mkdirSync(stateDir, { recursive: true });
    const fd = openSync(logFile, 'a');
    current = job;
    progress = null;
    // stdin: the parent pipe (D234): when the launcher is gone (even hard-killed) the clipper ends itself and its ffmpeg
    // children (clip_common.end_tree_when_parent_gone), so nothing runs on unseen after Ujwalam closed (D310 proposed).
    child = spawnFn(spec.exe, spec.argv, { stdio: ['pipe', fd, 'pipe'], windowsHide: true, cwd: clipRoot, env: { ...process.env, [PARENT_PIPE_ENV]: '1' } });
    child.stdin?.on?.('error', () => {});
    closeSync(fd);
    // stderr: copied to the log and scanned for `ujwalam-progress {...}` lines (the task bar's progress).
    let pending = ''; let lastWrite = 0;
    child.stderr?.on?.('data', (chunk) => {
      try { appendFileSync(logFile, chunk); } catch { /* the log is a convenience */ }
      pending += String(chunk);
      let i;
      while ((i = pending.indexOf(String.fromCharCode(10))) >= 0) {
        const p = parseProgress(pending.slice(0, i)); pending = pending.slice(i + 1);
        if (p) progress = p;
      }
      if (pending.length > 4000) pending = '';
      if (progress && now() - lastWrite >= 0) { lastWrite = now(); writeTasks(); }
    });
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* a fake child has no pid */ }
    log(`clips: making clips from ${job.name} (log ${logFile})`);
    write();
    child.once('exit', (code) => {
      if (stopped) return; // Ujwalam closing: the status keeps this job, so the next start runs it again
      const done = current; child = null; current = null;
      if (done.pausedForLive) { delete done.pausedForLive; log(`clips: ${done.name} paused for the stream; it continues after`); write(); return; }
      queue.shift(); progress = null;
      const n = code === 0 ? countClips(spec.out) : 0;
      last = { name: done.name, kind: done.kind, result: code === 0 ? 'done' : 'failed', code, clips: n, out: spec.out, folder: spec.folder };
      log(code === 0 ? `clips: ${n} clip(s) made from ${done.name} in ${spec.folder}` : `clips: making clips from ${done.name} failed (exit ${code}); see ${logFile}`);
      finishTask(done, code === 0, code === 0 ? `${n} clip${n === 1 ? '' : 's'} made` : 'Something went wrong; see the log');
      // D300: package + auto-approve + private upload (flags posting + auto-post; each step fails closed while live).
      if (code === 0 && n > 0 && postChain) void Promise.resolve(postChain.afterRun(spec.out, lastStatus)).catch(() => {});
      write();
      start();
    });
  };
  const readAnswer = (s) => {
    let a = null;
    try { a = JSON.parse(readFileSync(answerFile, 'utf8')); } catch { return; }
    try { rmSync(answerFile, { force: true }); } catch { /* read again next tick */ }
    const ask = asks.find((x) => x.id === a?.id);
    if (!ask) return;
    asks = asks.filter((x) => x !== ask);
    if (a.make === true) add({ ...pickJob(ask) }, `making clips from ${ask.name} (you said yes)`);
    else log(`clips: not making clips from ${ask.name} (you said no)`);
    if (a.remember === true) {
      const mode = a.make === true ? 'after' : 'off';
      writeSettings(dataDir, { clips: { ...s.clips, [ask.kind]: mode } });
      log(`clips: from now on ${ask.kind === 'live' ? 'streams' : 'recordings'}: ${mode}`);
    }
    write();
  };

  return {
    feed(status) {
      const t = now(); const s = readSettings(dataDir);
      const live = isLive(status); const rec = isRecording(status);
      liveNow = live;
      if (rec && recStart === null) { recStart = t; recSawLive = false; }
      if (rec && live) recSawLive = true;
      if (live && liveStart === null) { liveStart = t; liveHadRecording = false; }
      if (live && rec) liveHadRecording = true;
      setWorker((live && s.clips.live === 'while') || (rec && !live && s.clips.recording === 'while'));

      const f = finishedRecording(prev, status);
      if (f) {
        const kind = recSawLive || live ? 'live' : 'recording';
        const mode = s.clips[kind];
        const name = path.basename(f.h).replace(/\.[^.]+$/, '');
        const minutes = recStart === null ? null : Math.round((t - recStart) / 60000);
        const job = { kind, h: f.h, v: f.v, since: recStart === null ? undefined : iso(recStart), until: iso(t), name, minutes };
        if (mode === 'after') add({ ...job, type: 'full' }, `${kind} ${name} finished; making clips`);
        else if (mode === 'while') add({ ...job, type: 'review' }, `${kind} ${name} finished; editing the moments found into clips`);
        else if (mode === 'ask') { asks.push({ ...job, type: 'full', id: `${name}-${t}` }); log(`clips: ${kind} ${name} finished; asking whether to make clips`); }
        recStart = null; recSawLive = false;
        write();
      }
      if (!live && liveStart !== null) {
        // A stream without a recording: only moments found while live can become clips.
        if (!liveHadRecording && !rec && s.clips.live === 'while') add({ type: 'review', kind: 'live', since: iso(liveStart), until: iso(t), name: `live-${stamp(liveStart)}` }, 'stream ended; editing the moments found into clips');
        liveStart = null;
      }
      prev = status; lastStatus = status;
      readAnswer(s);
      if (live && child && current && !current.pausedForLive) { current.pausedForLive = true; killTreeFn(child); } // the whole tree: ffmpeg must not encode while live
      if (!live) start();
      if (postChain) void Promise.resolve(postChain.tick(status)).catch(() => {}); // retries of queued uploads; the chain itself refuses while a stream is live
      write();
    },
    stop() { stopped = true; if (child) killTreeFn(child); try { writeFileSync(workerFile, JSON.stringify({ on: false, atMs: now() })); } catch { /* gone */ } },
    state: () => ({ running: current, queued: [...queue], asks: [...asks], last }),
    /** The running clip job's process (tests, and the launcher's stray check), or null. */
    child: () => child,
  };
}
