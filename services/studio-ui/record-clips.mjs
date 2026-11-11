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
// (services/clip/clip_names.py). A whole-recording run also makes kill montages when the V recording exists, and so
// does a review run of a recorded stream (D322 proposed: H and V recordings both there); a review run deletes the live clipper's replay saves it used (host-named intermediates) once every clip rendered.
// Visible state (LC1, D333 proposed): status.json carries liveClipper (is the live clipper process running, why not,
// restarts, moments kept so far while it watches), and the task panel shows it as task "live-clipper" while a stream or
// recording is watched. A finished job whose reels (kill montages + match reels) were not made says why in its task
// note ("Reels not made: <reason>"), from the job itself or the run's render.json montage status.
// LL4 (D342, flag learning-train, off by default): when a stream's clip job ends, a game pack check (type 'train',
// services/clip/pack_tune.py propose) is queued last. It goes through this same queue, so it is one job at a time,
// hidden, below-normal, never started while a stream is live and stopped when one starts; it loads no model. It only
// writes a candidate for the user to approve; it never changes the pack.

import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PARENT_PIPE_ENV } from '../common/parent-pipe.mjs';
import { killChildTree } from '../common/kill-tree.mjs';
import { clipsFolder, readSettings, writeSettings } from './user-settings.mjs';
import { writeTaskFile } from './tasks.mjs';

const ACTIVE = new Set(['starting', 'live', 'reconnecting', 'retrying']);
/** The tray's "Stop all" while live or recording (D311 proposed): <dataDir>/clips/<this>, written by the UI server. */
export const STOP_TASKS_FILE = 'stop-tasks.json';

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

/** Moments the live clipper kept since an ISO time: rows of the newest session's saves.jsonl with at >= since. */
export function countSaves(dataDir, since, { newest = newestSaves } = {}) {
  const dir = newest(dataDir);
  if (!dir) return 0;
  try {
    return readFileSync(path.join(dir, 'saves.jsonl'), 'utf8').split(/\r?\n/).reduce((n, l) => {
      if (!l.trim()) return n;
      try { const r = JSON.parse(l); return typeof r?.at === 'string' && (!since || r.at >= since) ? n + 1 : n; } catch { return n; }
    }, 0);
  } catch { return 0; }
}

/** The task panel row of the live clipper (id "live-clipper"), or null when there is nothing to show.
 *  lc: { state: 'running' | 'restarting' | 'gave-up' | 'not-started', reason, restarts, maxRestarts } from the launcher;
 *  watching: a stream or recording runs and the clipper is asked to act; since: when that began (ms);
 *  ended: it was watching on the previous tick and is not now (the finished row, once). */
export function liveClipperTask({ lc, watching, ended = false, saves = 0, since = null, now }) {
  const base = { id: 'live-clipper', kind: 'live-clips', startedAt: since ?? now, updatedAt: now };
  const kept = `${saves} moment${saves === 1 ? '' : 's'} kept`;
  if (watching) {
    if (lc?.state === 'running') {
      const re = lc.restarts ? `; restarted ${lc.restarts} time${lc.restarts === 1 ? '' : 's'}` : '';
      return { ...base, title: 'Live clips: watching the game', state: 'running', measured: false, activeAt: since ?? now, note: `${kept} so far${re}` };
    }
    if (lc?.state === 'restarting') {
      return { ...base, title: 'Live clips: restarting the live clipper', state: 'running', measured: false, activeAt: since ?? now, note: `${kept} so far; ${String(lc.reason ?? 'it stopped; restarting').slice(0, 120)} (restart ${lc.restarts ?? 0} of ${lc.maxRestarts ?? '?'})` };
    }
    return { ...base, title: 'Live clips are not being made', state: 'failed', note: String(lc?.reason ?? 'the live clipper is not running').slice(0, 160) };
  }
  if (ended) return { ...base, title: `Live clips: ${kept}`, state: 'done', note: saves ? 'They become clips after the stream' : 'No moment was found' };
  return null;
}

/** Why the reels (kill montages + match reels) of a finished job were not made, or null when they were (or the job
 *  made them with nothing to show). readJson(file) -> object (throws when missing). */
export function reelsNotMade(job, out, { readJson = (f) => JSON.parse(readFileSync(f, 'utf8')), exists = existsSync } = {}) {
  const has = (p) => typeof p === 'string' && p !== '';
  if (job?.type === 'review') {
    if (!has(job.h)) return 'the stream was not recorded';
    if (!has(job.v)) return 'there is no portrait (V) recording of this stream';
    if (!exists(job.h)) return 'the stream recording is missing';
    if (!exists(job.v)) return 'the portrait (V) recording is missing';
    let m = null;
    try { m = readJson(path.join(out, 'render.json'))?.montage ?? null; } catch { m = null; }
    if (!m || typeof m !== 'object') return 'the reel step left no result; see the log';
    return m.status === 'made' ? null : String(m.reason ?? m.status ?? 'unknown').slice(0, 120);
  }
  if (!has(job?.v)) return 'there is no portrait (V) recording';
  // A whole-recording run (clipper.py run --montage) writes montage/render.json, report.json and published.json when
  // the montage step ran; none of them = it stopped early (its reason is only in the log).
  for (const n of ['render.json', 'report.json', 'published.json']) { try { readJson(path.join(out, 'montage', n)); return null; } catch { /* next */ } }
  return 'the reel step did not finish; see the log';
}

/** Python and argv for one job, or { spec: null, reason }. job: { type: 'full'|'review', h?, v?, since?, until?, name }.
 *  out = the run folder in app data (workRoot); outRoot = the clips folder that gets the finished videos only. */
export function clipRunSpec({ clipRoot, dataDir, job, outRoot = clipsFolder(dataDir), workRoot = path.join(dataDir, 'clips', 'runs'), saves = undefined, exists = existsSync, project = null }) {
  const t = clipTools({ clipRoot, exists });
  if (!t.py) return { spec: null, reason: t.reason };
  const out = path.join(workRoot, job.name);
  if (job.type === 'train') {
    // LL4 (D342): the game pack check reads the local learning store and writes a candidate; no video, no model.
    const tune = path.join(clipRoot, 'services', 'clip', 'pack_tune.py');
    if (!exists(tune)) return { spec: null, reason: 'the game pack check is not in the clip maker folder' };
    return { spec: { exe: t.py, argv: ['-I', tune, '--data-dir', dataDir, 'propose', '--report', path.join(out, TRAIN_REPORT)], out, folder: null }, reason: null };
  }
  const argv = ['-I', t.script, '--data-dir', dataDir];
  // The recording is the H canvas, not clean game footage: the project's game layer tells the detectors where the game
  // is (D235). Without it they scan the full frame and the end-screen boxes (top 3, mode) fall in the wrong place.
  const proj = typeof project === 'string' && project && exists(project) ? ['--project', project] : [];
  if (job.type === 'review') {
    const s = saves === undefined ? newestSaves(dataDir) : saves;
    if (!s) return { spec: null, reason: 'no moments were found while it ran' };
    argv.push('live-review', '--saves', s);
    if (job.since) argv.push('--since', job.since);
    if (job.until) argv.push('--until', job.until);
    // Match gate on the "while" path (D304 proposed): the stream's own H recording, when there is one, gives the
    // matches (detect + segment in live-review); saves in skipped matches are dropped. Without it every save is kept.
    if (typeof job.h === 'string' && job.h && exists(job.h)) {
      argv.push('--recording', job.h, '--threads', '4', ...proj);
      // D322 proposed: the kill montages and match reels of the stream's recording, cut from its V recording, after
      // the short clips. --drop-used-saves still deletes only the live clipper's replay saves, never the recordings.
      if (typeof job.v === 'string' && job.v && exists(job.v)) argv.push('--v-recording', job.v, '--montage');
    }
    argv.push('--encoder', 'h264_nvenc', '--publish', outRoot, '--drop-used-saves', '--out', out);
  } else {
    if (!job.h) return { spec: null, reason: 'there is no recording to make clips from' };
    argv.push('run', '--detect', '--threads', '4', '--encoder', 'h264_nvenc', '--recording', job.h, ...proj);
    if (job.v) argv.push('--v-recording', job.v, '--montage');
    const db = path.join(dataDir, 'event-core.db');
    if (exists(db)) argv.push('--chat-db', db);
    argv.push('--publish', outRoot, '--out', out);
  }
  return { spec: { exe: t.py, argv, out, folder: outRoot }, reason: null };
}

/** Number of finished clips of a run: the videos published to the clips folder (out/published.json and
 *  out/montage/published.json); a run folder without them (older runs) counts out/clips/<id>/*.mp4. */
/** LL4 (D342): the game pack check's run report, in its run folder. */
export const TRAIN_REPORT = 'train.json';
/** The task note of a finished game pack check: what it proposed, or why it proposed nothing. */
export function trainNote(code, out, { readJson = (f) => JSON.parse(readFileSync(f, 'utf8')) } = {}) {
  if (code === 3) return 'Not run: the flag learning-train is off';
  if (code !== 0) return 'Something went wrong; see the log';
  let r = null; try { r = readJson(path.join(out, TRAIN_REPORT)); } catch { return 'Done; no report was written'; }
  if (r?.candidate?.version) return `Game pack ${String(r.candidate.version).slice(0, 20)} proposed (status unverified); it waits for your approval`;
  const why = (Array.isArray(r?.values) ? r.values : []).map((v) => v?.reason).find((x) => typeof x === 'string');
  return `No game pack change${why ? `: ${why.slice(0, 140)}` : ''}`;
}

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

export const PROGRESS_STAGES = Object.freeze(['detect', 'candidates', 'render', 'validate', 'review', 'gate', 'publish', 'montage', 'train']);
const PROGRESS_RE = /^ujwalam-progress\s+(\{.*\})\s*$/;
const STAGE_TITLE = { detect: 'Finding the best moments in', candidates: 'Choosing the best moments in', render: 'Editing clips from', validate: 'Checking the clips from', review: 'Reviewing the moments in', gate: 'Checking the match results of',
  publish: 'Saving the clips from', montage: 'Making the kill montage from', train: 'Checking the game pack against' };
// Task panel (2026-11-10): each stage in plain words, what its done/total counts (null = only a percent shown), and
// whether it reports progress while it works. publish and montage write one line when they start and none after
// (clipper.py), so their silence is not counted by the stall warning (measured: false; tasks.mjs stallOf).
const STAGE_TEXT = { detect: ['Reading the game screen', 'frame'], candidates: ['Choosing the best moments', null], gate: ['Sorting clips by match', 'match'],
  render: ['Making clip videos', 'clip'], validate: ['Checking the clip files', 'clip'], review: ['Making clip videos from live saves', 'clip'],
  publish: ['Copying the finished clips to your clips folder', null, false], montage: ['Making the kill montage', null, false],
  train: ['Testing a game pack update on held-out streams', null, false] };
/** The stages a job goes through, in order (clipper.py cmd_run: detect, candidates, gate, render, validate, publish,
 *  then the montage when the V recording exists; live-review: detect and gate over the stream's own recording when
 *  there is one, then review and publish, then the montage when the V recording exists too, D322 proposed). */
export function jobStages(job) {
  if (job?.type === 'train') return ['train'];
  if (job?.type === 'review') {
    const h = typeof job.h === 'string' && job.h;
    if (!h) return ['review', 'publish'];
    return ['detect', 'gate', 'review', 'publish', ...(typeof job.v === 'string' && job.v ? ['montage'] : [])];
  }
  return ['detect', 'candidates', 'gate', 'render', 'validate', 'publish', ...(job?.v ? ['montage'] : [])];
}
/** { stageText, unit, measured } of a progress stage for a job (a review's gate sorts saves, counted as one step). */
export function stageWords(stage, job) {
  const [text, unit, measured = true] = STAGE_TEXT[stage] ?? [null, null];
  if (stage === 'gate' && job?.type === 'review') return { stageText: 'Sorting saves by match', unit: null, measured: true };
  return { stageText: text, unit, measured };
}

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
export function createRecordClips({ clipRoot, dataDir, project = null, log, spawnFn = spawn, now = Date.now, postChain = null, killTreeFn = killChildTree, liveClipper = null, trainFlag = () => false }) {
  const stateDir = path.join(dataDir, 'clips');
  const statusFile = path.join(stateDir, 'status.json');
  const answerFile = path.join(stateDir, 'answer.json');
  const workerFile = path.join(stateDir, 'live-worker.json');
  const stopFile = path.join(stateDir, STOP_TASKS_FILE);
  const createdAt = now();
  const queue = []; let asks = [];
  let prev = null; let child = null; let current = null; let last = null; let stopped = false;
  let halted = false; let lastStatus = null; let progress = null; let liveNow = false; let recStart = null; let recSawLive = false; let liveStart = null; let liveHadRecording = false; let workerOn = null;
  // Live clipper view (LC1): liveClipper() -> { state, reason, restarts, maxRestarts, flagOn } from the launcher.
  let watchSince = null; let watching = false; let watchEnded = false; let savesNow = 0;

  // A run cut short by closing Ujwalam (or queued, or still to be answered) comes back at the next start.
  try {
    const old = JSON.parse(readFileSync(statusFile, 'utf8'));
    last = old.last ?? null;
    for (const j of [old.running, ...(old.queued ?? [])]) {
      if (j && (j.type === 'review' || j.type === 'train' || (typeof j.h === 'string' && existsSync(j.h)))) queue.push(pickJob(j));
    }
    asks = (old.asks ?? []).filter((a) => a && typeof a.id === 'string' && typeof a.h === 'string' && existsSync(a.h));
    if (queue.length) log(`clips: ${queue.length} unfinished clip job(s) from the last session will run again`);
  } catch { /* no status yet */ }

  // Task bar (tasks.mjs): one task file per clip job, rewritten with every status write (that also keeps it fresh).
  const taskId = (j) => `clip-${String(j.name ?? 'run').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 70)}`;
  const taskFor = (j, p) => {
    const nm = j.type === 'train' ? 'your answers from the streams' : j.name ?? 'the stream';
    const base = { id: taskId(j), kind: 'clips', startedAt: j.taskStart ?? now(), updatedAt: now() };
    if (j === current && !j.pausedForLive) {
      const st = p?.stage ?? jobStages(j)[0];
      // No progress line yet: the stage is the first one expected, with no count (the panel says "Starting").
      const words = p ? stageWords(st, j) : { stageText: 'Starting', unit: null, measured: true };
      return { ...base, title: `${STAGE_TITLE[st]} ${nm}`, state: 'running', stage: st, done: p?.done ?? null, total: p?.total ?? null, note: p?.note ?? null,
        stages: jobStages(j), ...words, activeAt: j.activeAt ?? null, progressAt: j.progressAt ?? null };
    }
    return { ...base, title: j.type === 'train' ? 'Game pack check' : `Clips from ${nm}`, state: 'waiting', stage: null, done: null, total: null,
      note: j === current ? 'Paused while the stream runs' : liveNow ? 'Waiting until the stream ends' : 'Waiting for its turn' };
  };
  const writeTasks = () => {
    if (halted) return; // stopped by the user: the task files say so; the jobs run again at the next start
    for (const j of queue) { j.taskStart ??= now(); writeTaskFile(dataDir, taskFor(j, progress)); }
  };
  const lcState = () => { try { return typeof liveClipper === 'function' ? liveClipper() : null; } catch { return null; } };
  const writeLiveTask = (lc) => {
    const t = liveClipperTask({ lc, watching, ended: watchEnded, saves: savesNow, since: watchSince, now: now() });
    if (t) writeTaskFile(dataDir, t);
    watchEnded = false;
  };
  const finishTask = (j, ok, note) => writeTaskFile(dataDir, { id: taskId(j), kind: 'clips', title: j.type === 'train' ? (ok ? 'Game pack check done' : 'Game pack check did not finish') : ok ? `Clips ready from ${j.name}` : `Clips from ${j.name} did not finish`, state: ok ? 'done' : 'failed', note, startedAt: j.taskStart ?? now(), updatedAt: now() });
  const trainOn = () => { try { return trainFlag() === true; } catch { return false; } };

  const write = () => {
    writeTasks();
    const s = readSettings(dataDir);
    const t = clipTools({ clipRoot });
    const lc = lcState();
    if (!halted) writeLiveTask(lc);
    const liveClipperOut = lc ? { ...lc, watching, since: watchSince === null ? null : iso(watchSince), saves: savesNow } : null;
    const out = { liveClipper: liveClipperOut, at: iso(now()), state: current && !halted ? 'running' : queue.length ? 'queued' : 'idle', available: !!t.py, reason: t.reason, fix: t.fix, missing: t.missing,
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
    const { spec, reason } = clipRunSpec({ clipRoot, dataDir, job, project });
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
    job.activeAt = now(); job.progressAt = null; // the stall warning measures silence from here (tasks.mjs stallOf)
    // stdin: the parent pipe (D234): when the launcher is gone (even hard-killed) the clipper ends itself and its ffmpeg
    // children (clip_common.end_tree_when_parent_gone), so nothing runs on unseen after Ujwalam closed (D311 proposed).
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
        if (p) { progress = p; job.progressAt = now(); }
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
      if (done.type === 'train') {
        const note = trainNote(code, spec.out);
        log(`clips: game pack check ${code === 0 ? 'done' : `ended (exit ${code})`}: ${note}`);
        finishTask(done, code === 0, note);
        write(); start(); return;
      }
      const n = code === 0 ? countClips(spec.out) : 0;
      const reels = code === 0 ? reelsNotMade(done, spec.out) : null;
      last = { name: done.name, kind: done.kind, result: code === 0 ? 'done' : 'failed', code, clips: n, out: spec.out, folder: spec.folder, ...(reels ? { reelsNotMade: reels } : {}) };
      if (reels) log(`clips: reels not made from ${done.name}: ${reels}`);
      log(code === 0 ? `clips: ${n} clip(s) made from ${done.name} in ${spec.folder}` : `clips: making clips from ${done.name} failed (exit ${code}); see ${logFile}`);
      finishTask(done, code === 0, code === 0 ? `${n} clip${n === 1 ? '' : 's'} made${reels ? `. Reels not made: ${reels}` : ''}` : 'Something went wrong; see the log');
      // D300: package + auto-approve + private upload (flags posting + auto-post; each step fails closed while live).
      if (code === 0 && n > 0 && postChain) void Promise.resolve(postChain.afterRun(spec.out, lastStatus)).catch(() => {});
      // LL4 (D342): after a stream's clip job, the game pack check runs last (flag learning-train, off by default).
      if (done.kind === 'live' && trainOn() && !queue.some((q) => q.type === 'train')) add({ type: 'train', kind: 'train', name: `pack-check-${stamp(now())}` }, 'stream clips done; checking the game pack against the labels (runs last)');
      write();
      start();
    });
  };
  // Stop the tasks only (the tray's Stop all while a stream or recording runs, so the studio and host stay): the clip
  // job's whole tree ends now, the queue is kept for the next start (as when Ujwalam closes), each task says so, and
  // nothing new starts in this session. A request older than this launcher is a leftover and is dropped.
  const readStop = () => {
    let r = null;
    try { r = JSON.parse(readFileSync(stopFile, 'utf8')); } catch { return; }
    try { rmSync(stopFile, { force: true }); } catch { /* read again next tick */ }
    if (halted || !(Number(r?.atMs) >= createdAt)) return;
    halted = true; stopped = true;
    if (child) killTreeFn(child);
    for (const j of queue) finishTask(j, false, 'Stopped by you; it runs again at the next start');
    log(`clips: stopped by you (${queue.length} job(s) run again at the next start)`);
    postChain?.stopTasks?.();
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
      // The clipper acts while asked (setWorker) or while its flag is on; it is "watching" only during a stream or
      // recording (that is when moments can be kept).
      const nowWatching = (live || rec) && (workerOn === true || lcState()?.flagOn === true);
      if (nowWatching && !watching) { watchSince = t; savesNow = 0; }
      if (!nowWatching && watching) watchEnded = true;
      watching = nowWatching;
      if (watching || watchEnded) savesNow = countSaves(dataDir, iso(watchSince ?? t));

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
      readStop();
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
