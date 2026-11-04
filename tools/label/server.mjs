#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// A6 labelling page server (P2b). Node stdlib only, no dependencies.
//
// - Binds to 127.0.0.1 only (no host option). Host and Origin headers are checked; a Referer, when
//   present, must be this page. A request whose Sec-Fetch-Site is present and not same-origin or
//   none (another website) is refused, except the static page files.
// - Per-launch token: crypto.randomBytes(32), hex. The CLI prints the page URL with it
//   (http://127.0.0.1:PORT/?t=TOKEN). Every API, media, frame and thumb route checks it in constant
//   time: the X-Label-Token header, or the tok query parameter on the routes an element src uses
//   (media, frame, thumb). The static page files load without it and carry no data. This token is
//   only for this tool; it is not the app's local JSON-RPC API token.
// - Streams the per-session proxy and the original clips read-only, with HTTP Range.
//   The client sends ids only (session id, segment index); paths come from the cache manifest.
// - Writes only into an allowlist of folders, each checked by real path at startup and before every
//   write: drafts (data/games/<game>/local/labels-draft/, with the pass-2 file and the lock file),
//   draft backups (labels-draft/backups/), notes (data/games/<game>/local/label-notes/) and labels
//   (data/labels/). None may be inside the cache or the corpus, or contain them (junctions
//   included). Drafts and notes inside the repository must be gitignored. Otherwise no start.
// - A draft or pass-2 file that exists but cannot be read is never "empty": the routes that need it
//   answer 500 and nothing is written.
// - One writer per session: a lock file (launch id, tab id, heartbeat). Only the lock owner may save,
//   open pass 2, export or add a note (423 otherwise). A lock is stale when its launch's process is
//   gone, or when it has had no heartbeat for 5 min (a hidden tab's timers can be throttled to about
//   once a minute, so a live tab must not look stale). A stale lock is taken over only when the page
//   asks with takeover:true after the user confirms. Claiming a released or stale lock goes through an
//   exclusive claim file and is verified by reading the lock back.
// - PUT draft carries the integer revision the client last saw; any other revision is 409 (no merge).
//   It also refuses a draft that would empty a non-empty labels or events list unless allowEmpty:true,
//   and refuses unknown fields, free text and invalid times (422 with a JSON pointer). Every save
//   keeps a backup (never overwritten; revisions are never reused, even after the draft goes
//   missing); the last 20 per session are kept. A label without createdAt gets the save time here,
//   so export never has to make one up (a made-up time would change the previewed document).
// - Export: export-preview returns the sha256 of the exact file text it would write (and of the file
//   that is there now). Export needs both hashes and answers 409 when either differs.
// - Blind protocol: GET suggestions is refused until the labeller has confirmed opening pass 2
//   (POST open-pass2). The pass-2 record is its own file, written only by open-pass2 and by the
//   "highlights edited after suggestions" detection on save; no draft PUT can change it.
// - Notes (free text) go only to the gitignored notes file, never into a draft or a label file.
// - ffmpeg frames: at most 2 processes and 50 waiting jobs (503 above that); a closed request drops
//   its queued job or kills its running ffmpeg.
//
// Usage: node tools/label/server.mjs [--port 8765] [--cache DIR] [--corpus DIR] [--labels DIR] [--drafts DIR] [--notes DIR] [--suggestions DIR]
//   --cache and --corpus default to paths.analysis_cache / paths.clips_corpus in data/profile.local.json.
import http from 'node:http';
import { appendFileSync, constants as fsConstants, copyFileSync, createReadStream, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSchema, loadPackSummary, loadTagIds, buildLabelFile, validateLabelFile, checkDraft, diffLabelFiles } from './labels-export.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const SESSION_RE = /^s-[0-9A-Za-z-]+$/;
const GAME_RE = /^[a-z][a-z0-9_]*$/;
const TAB_RE = /^[0-9a-f]{16,64}$/;
const NOTE_REF_RE = /^(l|e|sg)-\d{4,}$/; // a window, event or suggestion id from the draft
const PROXY_NAME = 'proxy-540x960-30p.mp4';
const MAX_BODY = 8 * 1024 * 1024;
const MAX_FFMPEG = 2;
const FFMPEG_QUEUE_MAX = 50;
// A lock whose owner process is alive is stale only after this long without a heartbeat. The page
// beats every 10 s, and at once when it becomes visible; a hidden tab can be throttled to about one
// timer per minute (Chrome, after about 5 min hidden). A lock whose owner process is gone is stale at once.
const LOCK_STALE_MS = 5 * 60 * 1000;
const CLAIM_STALE_MS = 10000; // a claim file left by a crashed claimant is cleared after this
const BACKUPS_KEEP = 20;
const NOTE_MAX = 2000;
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/label-core.js': ['label-core.js', 'text/javascript; charset=utf-8'],
  '/label.js': ['label.js', 'text/javascript; charset=utf-8'],
  '/label.css': ['label.css', 'text/css; charset=utf-8'],
};

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const realOrNull = (p) => { try { return realpathSync(p); } catch { return null; } };
const inside = (child, root) => {
  const c = path.normalize(child).toLowerCase();
  const r = path.normalize(root).toLowerCase();
  return c === r || c.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
};
const same = (a, b) => path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const sha256 = (s) => createHash('sha256').update(s).digest();
const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

// Real path of p, or of its nearest existing ancestor plus the rest (p need not exist yet).
function realLoose(p) {
  const abs = path.resolve(p);
  const rest = [];
  let cur = abs;
  for (;;) {
    try { return path.join(realpathSync.native(cur), ...rest.reverse()); } catch { /* go up */ }
    const up = path.dirname(cur);
    if (up === cur) return abs;
    rest.push(path.basename(cur));
    cur = up;
  }
}

// -> null when safe, else a reason. Writable folders must not be inside the cache or the corpus and
// must not contain them (real paths). The `ignored` folders (drafts, notes) inside the repository must
// be gitignored; one outside the repository cannot be committed from it, so git is not asked.
export function checkRoots({ repo, writable, ignored, readOnly }) {
  const W = writable.map(realLoose);
  const R = readOnly.map(realLoose);
  for (const w of W) {
    for (const r of R) {
      if (inside(w, r)) return 'a writable folder (labels, drafts, backups or notes) is inside the cache or the corpus';
      if (inside(r, w)) return 'the cache or the corpus is inside a writable folder (labels, drafts, backups or notes)';
    }
  }
  const realRepo = realLoose(repo);
  for (const d of ignored) {
    const rd = realLoose(d);
    if (!inside(rd, realRepo)) continue;
    const g = spawnSync('git', ['-C', realRepo, 'check-ignore', '-q', rd], { stdio: 'ignore', windowsHide: true });
    if (g.status !== 0) return 'a drafts or notes folder is inside the repository and not gitignored';
  }
  return null;
}

// Puts src at dst and never replaces dst (EEXIST when it exists): a hard link, or on a file system
// without hard links (exFAT, FAT32, some SMB shares: EPERM, ENOTSUP, EXDEV) an exclusive copy
// (review round 4, R6). link is injectable for tests.
const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS']);
export function placeExclusive(src, dst, link = linkSync) {
  try { link(src, dst); } catch (e) {
    if (!LINK_UNSUPPORTED.has(e.code)) throw e;
    copyFileSync(src, dst, fsConstants.COPYFILE_EXCL);
  }
}

// Claims a lock that is free-but-present, released or stale (review M8). Two launches may try at once,
// so the claim is an exclusive create of <lock>.claim; only its creator re-checks that the lock may
// still be claimed, writes it, and reads it back (launchId and tab must be its own).
// -> true when this claimant now holds the lock. write(file, text) is the caller's checked writer;
// write.assert(file) checks a path before the claim file is created.
// A claim file older than 10 s (its claimant crashed) is broken without ever deleting a live claim
// (review round 4, R2): it is moved to a unique name first and checked there. When the moved file is
// not the one judged stale (another claimant broke it and made a fresh claim in between), it is put
// back (never over a newer one) and this claimant gives up. Last, a winner checks that its own claim
// file is still in place, so a claim moved away by a slow breaker never yields two writers.
// hooks (tests): beforeBreak(), afterClaim(), afterWrite() run at those points, to interleave a
// second claimant.
export function claimLock(lockFile, rec, { write, canClaim = () => true, hooks = {}, link = linkSync }) {
  const claim = `${lockFile}.claim`;
  const mine = JSON.stringify({ launchId: rec.launchId, tab: rec.tab, at: Date.now(), n: randomBytes(8).toString('hex') });
  const create = () => { if (write.assert) write.assert(claim); writeFileSync(claim, mine, { flag: 'wx' }); };
  try { create(); } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let seen, age;
    try { seen = readFileSync(claim, 'utf8'); age = Date.now() - statSync(claim).mtimeMs; } catch { return false; } // gone: another claimant is on it
    if (!(age >= CLAIM_STALE_MS)) return false;
    if (hooks.beforeBreak) hooks.beforeBreak();
    const moved = `${claim}.${process.pid}.${randomBytes(6).toString('hex')}.stale`;
    if (write.assert) write.assert(moved);
    try { renameSync(claim, moved); } catch (e2) { if (e2.code === 'ENOENT') return false; throw e2; }
    let got = null;
    try { got = readFileSync(moved, 'utf8'); } catch { /* unreadable: treat as not the stale one */ }
    if (got !== seen) {
      try { placeExclusive(moved, claim, link); } catch { /* a newer claim is there; its owner's last check decides */ }
      try { unlinkSync(moved); } catch { /* gone */ }
      return false;
    }
    unlinkSync(moved);
    try { create(); } catch (e2) { if (e2.code === 'EEXIST') return false; throw e2; }
  }
  try {
    if (hooks.afterClaim) hooks.afterClaim();
    if (!canClaim()) return false;
    write(lockFile, JSON.stringify(rec));
    if (hooks.afterWrite) hooks.afterWrite();
    let back;
    try { back = JSON.parse(readFileSync(lockFile, 'utf8')); } catch { return false; }
    if (back.launchId !== rec.launchId || back.tab !== rec.tab) return false;
    let still = null;
    try { still = readFileSync(claim, 'utf8'); } catch { /* moved away */ }
    return still === mine;
  } finally {
    try { if (readFileSync(claim, 'utf8') === mine) unlinkSync(claim); } catch { /* gone */ }
  }
}

export function startServer(opts = {}) {
  const repo = opts.repo ? path.resolve(opts.repo) : REPO;
  const cacheDir = opts.cacheDir ? path.resolve(opts.cacheDir) : null;
  const corpusDir = opts.corpusDir ? path.resolve(opts.corpusDir) : null;
  const labelsDir = path.resolve(opts.labelsDir || path.join(repo, 'data', 'labels'));
  const draftsRoot = opts.draftsRoot ? path.resolve(opts.draftsRoot) : null;
  const notesRoot = opts.notesRoot ? path.resolve(opts.notesRoot) : null;
  const suggestionsRoot = opts.suggestionsRoot ? path.resolve(opts.suggestionsRoot) : null;
  // opts.ffmpeg: a binary name, or [binary, ...leading args] (tests use a fake slow process).
  const ffmpegCmd = Array.isArray(opts.ffmpeg) ? opts.ffmpeg : [opts.ffmpeg || 'ffmpeg'];
  const ffmpegQueueMax = Number.isInteger(opts.ffmpegQueueMax) ? opts.ffmpegQueueMax : FFMPEG_QUEUE_MAX;
  const lockStaleMs = Number.isInteger(opts.lockStaleMs) ? opts.lockStaleMs : LOCK_STALE_MS;
  const linkFile = typeof opts.linkFile === 'function' ? opts.linkFile : linkSync; // tests inject a failing link
  const backupsKeep = BACKUPS_KEEP;
  const token = typeof opts.token === 'string' && /^[0-9a-f]{64}$/.test(opts.token) ? opts.token : randomBytes(32).toString('hex');
  const tokenHash = sha256(token);
  const launchId = randomBytes(16).toString('hex');
  const gamesFile = opts.sessionGamesFile || path.join(repo, 'data', 'session-games.json');
  const sessionGames = readJson(gamesFile).sessions || {};
  const schema = loadSchema(repo);
  const tagsFile = path.join(repo, 'data', 'label-tags.json');
  const packs = new Map();
  const manifests = new Map();

  // ---- folders: an allowlist, checked at startup and before every write ----
  const games = [...new Set(Object.values(sessionGames).filter((g) => typeof g === 'string' && GAME_RE.test(g)))];
  const localDir = (g, name) => path.join(repo, 'data', 'games', g, 'local', name);
  const draftsDir = (game) => draftsRoot || localDir(game, 'labels-draft');
  const notesDir = (game) => notesRoot || localDir(game, 'label-notes');
  const draftDirs = draftsRoot ? [draftsRoot] : games.map((g) => localDir(g, 'labels-draft'));
  const noteDirs = notesRoot ? [notesRoot] : games.map((g) => localDir(g, 'label-notes'));
  const backupDirs = draftDirs.map((d) => path.join(d, 'backups'));
  const readOnly = [cacheDir, corpusDir].filter(Boolean);
  const rootError = checkRoots({ repo, writable: [labelsDir, ...draftDirs, ...backupDirs, ...noteDirs], ignored: [...draftDirs, ...noteDirs], readOnly });
  if (rootError) return Promise.reject(Object.assign(new Error(rootError), { code: 'unsafe-folders' }));
  for (const d of [labelsDir, ...draftDirs, ...backupDirs, ...noteDirs]) mkdirSync(d, { recursive: true });
  // Files may be written directly in these folders; backups one level down (backups/<session>/).
  const flatDirs = [labelsDir, ...draftDirs, ...noteDirs].map(realLoose);
  const nestedDirs = backupDirs.map(realLoose);
  const realReadOnly = readOnly.map(realLoose);
  const httpError = (status, msg) => Object.assign(new Error(msg), { status });
  function assertWritable(file) {
    const real = realLoose(file);
    const parent = path.dirname(real);
    const ok = flatDirs.some((d) => same(parent, d)) || nestedDirs.some((d) => same(path.dirname(parent), d));
    if (!ok || realReadOnly.some((r) => inside(real, r) || inside(r, parent))) throw httpError(500, 'unsafe-write');
  }
  let tmpSeq = 0;
  // Checked before the folder is created (a junction in the path must not make mkdir write into the
  // cache) and again after.
  function writeAtomic(file, text) {
    assertWritable(file);
    mkdirSync(path.dirname(file), { recursive: true });
    assertWritable(file);
    const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
    try { writeFileSync(tmp, text); renameSync(tmp, file); }
    catch (e) { try { unlinkSync(tmp); } catch { /* none */ } throw e; }
  }

  const getPack = (game) => {
    if (!packs.has(game)) packs.set(game, loadPackSummary(repo, game));
    return packs.get(game);
  };
  const draftPath = (info) => path.join(draftsDir(info.game), `${info.id}.json`);
  const pass2Path = (info) => path.join(draftsDir(info.game), `${info.id}.pass2.json`);
  const lockPath = (info) => path.join(draftsDir(info.game), `${info.id}.lock`);
  const backupDir = (info) => path.join(draftsDir(info.game), 'backups', info.id);
  const notesPath = (info) => path.join(notesDir(info.game), `${info.id}.jsonl`);
  const labelPath = (info) => path.join(labelsDir, `${info.id}.json`);
  const suggestionsPath = (info) => path.join(suggestionsRoot || localDir(info.game, 'labels-suggestions'), `${info.id}.json`);

  // ---- sessions and manifests (ids only; paths come from here) ----
  function sessionInfo(id) {
    if (!SESSION_RE.test(id) || !Object.hasOwn(sessionGames, id) || !cacheDir) return null;
    const game = sessionGames[id];
    if (!GAME_RE.test(game)) return null;
    const dir = path.join(cacheDir, id);
    const mpath = path.join(dir, 'manifest.json');
    const proxy = path.join(dir, PROXY_NAME);
    if (!existsSync(mpath) || !existsSync(proxy)) return null;
    if (!manifests.has(id)) {
      const m = readJson(mpath);
      manifests.set(id, { durationSec: m.expectedDurationSec, clipCount: m.segments.length, segments: m.segments });
    }
    return { id, game, proxy, ...manifests.get(id) };
  }
  function clipPath(info, idx) {
    if (!Number.isInteger(idx) || idx < 0 || idx >= info.segments.length || !corpusDir) return null;
    const name = info.segments[idx].clip;
    if (typeof name !== 'string' || name !== path.basename(name) || /[\\/:]/.test(name)) return null;
    const p = path.join(corpusDir, name);
    const real = realOrNull(p);
    const root = realOrNull(corpusDir);
    if (!real || !root || !inside(real, root)) return null;
    return real;
  }

  // ---- responses ----
  const SEC_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  };
  function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    res.writeHead(status, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store', ...SEC_HEADERS, ...extra });
    res.end(buf);
  }
  const fail = (res, status, error, extra = {}) => send(res, status, { error, ...extra });

  // Over MAX_BODY -> 413. The 413 is sent first; the request is destroyed only after the response
  // has finished (see the server callback), so the client can read it.
  function readBody(req) {
    const tooLarge = () => Object.assign(new Error('too-large'), { status: 413 });
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY) return Promise.reject(tooLarge());
    return new Promise((resolve, reject) => {
      const chunks = [];
      let n = 0;
      let over = false;
      req.on('data', (c) => {
        if (over) return;
        n += c.length;
        if (n > MAX_BODY) { over = true; chunks.length = 0; reject(tooLarge()); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (over) return;
        try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
        catch { reject(Object.assign(new Error('bad-json'), { status: 400 })); }
      });
      req.on('error', reject);
    });
  }

  // ---- Range streaming (read-only) ----
  function streamFile(req, res, file, type) {
    let st;
    try { st = statSync(file); } catch { return fail(res, 404, 'not-found'); }
    const size = st.size;
    const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', ...SEC_HEADERS };
    // A zero-byte file is an empty 200 (no byte range of it can exist).
    if (size === 0) { res.writeHead(200, { ...base, 'Content-Length': 0 }); return res.end(); }
    const range = typeof req.headers.range === 'string' ? req.headers.range.trim() : '';
    let start = 0;
    let end = size - 1;
    let status = 200;
    // RFC 9110 14.2: a Range with another unit is ignored; a multi-range request is also answered
    // with the whole file (200) because multipart/byteranges is not implemented.
    if (range && /^bytes=/i.test(range) && !range.includes(',')) {
      const m = /^bytes=(\d*)-(\d*)$/i.exec(range);
      if (!m || (m[1] === '' && m[2] === '')) { res.writeHead(416, { ...base, 'Content-Range': `bytes */${size}` }); return res.end(); }
      if (m[1] === '') { start = Math.max(0, size - Number(m[2])); }
      else { start = Number(m[1]); if (m[2] !== '') end = Math.min(end, Number(m[2])); }
      if (start >= size || start > end) { res.writeHead(416, { ...base, 'Content-Range': `bytes */${size}` }); return res.end(); }
      status = 206;
    }
    const len = end - start + 1;
    const head = { ...base, 'Content-Length': len };
    if (status === 206) head['Content-Range'] = `bytes ${start}-${end}/${size}`;
    res.writeHead(status, head);
    if (req.method === 'HEAD') return res.end();
    const rs = createReadStream(file, { start, end });
    rs.on('error', () => res.destroy());
    res.on('close', () => rs.destroy());
    rs.pipe(res);
  }

  // ---- ffmpeg single frames (input read-only, output to the HTTP response only) ----
  // At most MAX_FFMPEG processes; at most ffmpegQueueMax jobs wait (503 above that). A request that
  // closes drops its queued job, or kills its running ffmpeg through the spawn signal.
  let active = 0;
  const waiting = [];
  function acquire(signal) {
    if (signal.aborted) return Promise.reject(httpError(499, 'client-gone'));
    if (active < MAX_FFMPEG) { active++; return Promise.resolve(); }
    if (waiting.length >= ffmpegQueueMax) return Promise.reject(httpError(503, 'busy'));
    return new Promise((ok, no) => {
      const drop = () => { const i = waiting.indexOf(job); if (i >= 0) waiting.splice(i, 1); no(httpError(499, 'client-gone')); };
      const job = { start: () => { signal.removeEventListener('abort', drop); ok(); } };
      signal.addEventListener('abort', drop, { once: true });
      waiting.push(job);
    });
  }
  // Hands the slot to the next waiting job, or frees it.
  const release = () => { const n = waiting.shift(); if (n) n.start(); else active--; };
  // Aborts when the client goes away before the response has been sent.
  const clientGone = (res) => {
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableFinished) ac.abort(); });
    return ac.signal;
  };
  function frameFailed(res, e, signal) {
    if (signal.aborted) return res.destroy(); // client gone: nothing to answer
    if (e && e.status === 503) return send(res, 503, { error: 'busy' }, undefined, { 'Retry-After': '1' });
    return fail(res, 502, 'ffmpeg-failed');
  }
  const thumbCache = new Map();
  async function frameJpeg(input, t, { width, quality }, signal) {
    const key = `${input}|${t.toFixed(2)}|${width}|${quality}`;
    if (thumbCache.has(key)) return thumbCache.get(key);
    await acquire(signal);
    try {
      const args = ['-v', 'error', '-nostdin', '-ss', t.toFixed(3), '-i', input, '-frames:v', '1'];
      if (width) args.push('-vf', `scale=${width}:-2`);
      args.push('-q:v', String(quality), '-f', 'image2pipe', '-c:v', 'mjpeg', '-');
      const buf = await new Promise((resolve, reject) => {
        const p = spawn(ffmpegCmd[0], [...ffmpegCmd.slice(1), ...args], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, signal });
        try { os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort */ }
        const out = [];
        const timer = setTimeout(() => p.kill(), 30000);
        p.stdout.on('data', (c) => out.push(c));
        p.on('error', reject);
        p.on('close', (code) => { clearTimeout(timer); const b = Buffer.concat(out); (code === 0 && b.length) ? resolve(b) : reject(new Error('ffmpeg')); });
      });
      if (width) { thumbCache.set(key, buf); if (thumbCache.size > 400) thumbCache.delete(thumbCache.keys().next().value); }
      return buf;
    } finally { release(); }
  }

  // ---- stored files: draft, pass-2 record, lock ----
  // Only a missing file means "none". Any other read or parse error (EBUSY, EPERM, EISDIR, corrupt
  // JSON) is a 500 for every route that needs the file, so it is never overwritten.
  function readStored(file, code) {
    let text;
    try { text = readFileSync(file, 'utf8'); }
    catch (e) { if (e && e.code === 'ENOENT') return null; throw httpError(500, code); }
    let d;
    try { d = JSON.parse(text); } catch { throw httpError(500, code); }
    if (!isObj(d)) throw httpError(500, code);
    return d;
  }
  const emptyDraft = (info) => ({ version: 1, sessionId: info.id, game: info.game, labels: [], events: [], timing: { highlightPassSec: 0, eventPassSec: 0 }, revision: 0 });
  function readDraft(info) {
    const d = readStored(draftPath(info), 'draft-unreadable');
    if (!d) return emptyDraft(info);
    if (!Number.isInteger(d.revision) || d.revision < 1) throw httpError(500, 'draft-unreadable');
    return d;
  }
  function readPass2(info) {
    const p = readStored(pass2Path(info), 'pass2-unreadable');
    if (p && typeof p.openedAt !== 'string') throw httpError(500, 'pass2-unreadable');
    return p;
  }
  const withPass2 = (d, p2) => ({ ...d, pass2: p2 || null });
  const highlightsHash = (labels) => createHash('sha256').update(JSON.stringify((Array.isArray(labels) ? labels : []).map((l) => [l.id, l.windowStartSec, l.windowEndSec, l.label, l.rating ?? null, [...(l.reasonTags || [])].sort()]))).digest('hex');
  const nowIso = () => new Date().toISOString();

  // Lock: { launchId, tab, pid, heartbeatAt, releasedAt? }. "mine" = this launch and this tab.
  // Release (page closed) marks the lock released instead of deleting it: for RELEASE_GRACE_MS the
  // owner's save still in flight is accepted and other tabs are told to retry; after that it is free.
  const RELEASE_GRACE_MS = 2000;
  const myLocks = new Set();
  function lockState(info, tab) {
    let lock;
    try { lock = readStored(lockPath(info), 'lock-unreadable'); } catch { return { state: 'stale', exists: true }; } // a broken lock file is stale
    if (!lock) return { state: 'free', exists: false };
    const mine = lock.launchId === launchId && lock.tab === tab;
    if (lock.releasedAt) {
      const since = Date.now() - Date.parse(lock.releasedAt);
      if (!(since < RELEASE_GRACE_MS)) return { state: 'free', exists: true };
      return { state: mine ? 'mine' : 'releasing', exists: true, releasing: true, retryMs: RELEASE_GRACE_MS - since + 50 };
    }
    if (mine) return { state: 'mine', exists: true };
    // The owner's process gone: stale at once. Alive: stale only after lockStaleMs without a heartbeat.
    const ownerAlive = lock.launchId === launchId || pidAlive(lock.pid);
    const beat = Date.parse(lock.heartbeatAt);
    const fresh = Number.isFinite(beat) && Date.now() - beat < lockStaleMs;
    return { state: ownerAlive && fresh ? 'held' : 'stale', exists: true };
  }
  const lockRecord = (tab, releasedAt) => ({ launchId, tab, pid: process.pid, heartbeatAt: nowIso(), ...(releasedAt ? { releasedAt } : {}) });
  // Refreshes (or releases) a lock this tab already holds.
  function writeLock(info, tab, { releasedAt } = {}) {
    writeAtomic(lockPath(info), JSON.stringify(lockRecord(tab, releasedAt)));
    myLocks.add(lockPath(info));
  }
  const checkedWrite = Object.assign((file, text) => writeAtomic(file, text), { assert: (file) => assertWritable(file) });
  // A present-but-free (released), or stale lock: claimed exclusively, then verified (claimLock).
  function claim(info, tab, want) {
    const ok = claimLock(lockPath(info), lockRecord(tab), { write: checkedWrite, canClaim: () => want.includes(lockState(info, tab).state), hooks: opts.lockHooks || {}, link: linkFile });
    if (ok) myLocks.add(lockPath(info));
    return ok;
  }
  const LOST_RETRY_MS = 500;
  function takeLock(info, tab, takeover) {
    const s = lockState(info, tab);
    if (s.state === 'free' && !s.exists) {
      try {
        assertWritable(lockPath(info));
        writeFileSync(lockPath(info), JSON.stringify(lockRecord(tab)), { flag: 'wx' }); // fails if another launch created it first
        myLocks.add(lockPath(info));
      } catch (e) { if (e.code === 'EEXIST') return { writer: false, stale: false, retryMs: LOST_RETRY_MS }; throw e; }
      return { writer: true };
    }
    if (s.state === 'mine' && !s.releasing) { writeLock(info, tab); return { writer: true }; }
    if (s.state === 'free') return claim(info, tab, ['free']) ? { writer: true } : { writer: false, stale: false, retryMs: LOST_RETRY_MS };
    if (s.state === 'stale' && takeover === true) return claim(info, tab, ['stale', 'free']) ? { writer: true, tookOver: true } : { writer: false, stale: false, retryMs: LOST_RETRY_MS };
    if (s.state === 'releasing' || s.state === 'mine') return { writer: false, stale: false, retryMs: s.retryMs };
    return { writer: false, stale: s.state === 'stale' };
  }
  // Writes need the lock. The owner's write also refreshes its heartbeat (not of a released lock).
  function requireWriter(info, tab) {
    const s = lockState(info, tab);
    if (s.state !== 'mine') throw httpError(423, 'not-lock-owner');
    if (!s.releasing) writeLock(info, tab);
  }
  function releaseLock(info, tab) {
    const s = lockState(info, tab);
    if (s.state !== 'mine' || s.releasing) return false;
    writeLock(info, tab, { releasedAt: nowIso() });
    return true;
  }

  // ---- drafts ----
  const BACKUP_RE = /^r(\d{8,})\.json$/;
  const backupNo = (n) => Number(BACKUP_RE.exec(n)[1]);
  function highestBackup(info) {
    let names;
    try { names = readdirSync(backupDir(info)); } catch (e) { if (e.code === 'ENOENT') return 0; throw httpError(500, 'backups-unreadable'); }
    return names.filter((n) => BACKUP_RE.test(n)).reduce((m, n) => Math.max(m, backupNo(n)), 0);
  }
  // A backup is never overwritten: a temp file, then a hard link to the final name, or an exclusive
  // copy where hard links are not supported (placeExclusive); either fails if the name exists.
  function writeBackup(info, d) {
    const dir = backupDir(info);
    const file = path.join(dir, `r${String(d.revision).padStart(8, '0')}.json`);
    assertWritable(file);
    mkdirSync(dir, { recursive: true });
    assertWritable(file);
    const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(d), { flag: 'wx' });
      try { placeExclusive(tmp, file, linkFile); } catch (e) { if (e.code === 'EEXIST') throw httpError(500, 'backup-exists'); throw e; }
    } finally { try { unlinkSync(tmp); } catch { /* none */ } }
    const names = readdirSync(dir).filter((n) => BACKUP_RE.test(n)).sort((a, b) => backupNo(a) - backupNo(b));
    for (const n of names.slice(0, Math.max(0, names.length - backupsKeep))) unlinkSync(path.join(dir, n));
  }
  function putDraft(info, body, tab) {
    if (!isObj(body)) return { status: 400, error: 'bad-draft' };
    if (body.sessionId !== info.id) return { status: 400, error: 'session-mismatch' };
    requireWriter(info, tab);
    const stored = readDraft(info);
    const p2 = readPass2(info);
    // R7: a label without createdAt gets the save time (whole seconds, as the page writes it).
    if (Array.isArray(body.labels)) {
      const at = nowIso().replace(/\.\d+Z$/, 'Z');
      for (const l of body.labels) if (isObj(l) && l.createdAt === undefined) l.createdAt = at;
    }
    const errors = checkDraft(body, { durationSec: info.durationSec, tagIds: loadTagIds(tagsFile), pack: getPack(info.game) });
    if (errors.length) return { status: 422, error: 'invalid-draft', at: errors[0], errors };
    // Optimistic concurrency: the client sends the revision it last saw (0 for a new draft). No merge.
    if (body.revision !== stored.revision) return { status: 409, error: 'draft-changed' };
    // Never replace a non-empty list with an empty one unless the user confirmed deleting the last item.
    for (const k of ['labels', 'events']) {
      if (stored[k].length > 0 && (body[k] || []).length === 0 && body.allowEmpty !== true) return { status: 409, error: 'would-empty-draft', at: `/${k}` };
    }
    const d = { version: 1, sessionId: info.id, game: info.game, labels: body.labels || [], events: body.events || [], timing: body.timing, ui: body.ui, revision: Math.max(stored.revision, highestBackup(info)) + 1, savedAt: nowIso() };
    // A draft that went missing is revision 0 for the client again, but its backups keep counting.
    writeBackup(info, d);
    // The pass-2 flag first: if the draft write then fails, the flag errs on the side of "edited".
    let pass2 = p2;
    if (p2 && !p2.highlightsEditedAfter && highlightsHash(d.labels) !== p2.labelsHash) {
      pass2 = { ...p2, highlightsEditedAfter: true, editedAt: d.savedAt };
      writeAtomic(pass2Path(info), JSON.stringify(pass2));
    }
    writeAtomic(draftPath(info), JSON.stringify(d));
    return { status: 200, draft: withPass2(d, pass2) };
  }

  // ---- export ----
  function prepareExport(info) {
    const d = readDraft(info);
    const p2 = readPass2(info);
    const tagIds = loadTagIds(tagsFile);
    const pack = getPack(info.game);
    const draftErrors = checkDraft(d, { durationSec: info.durationSec, tagIds, pack });
    if (draftErrors.length) return { error: 'invalid-draft', errors: draftErrors };
    const doc = buildLabelFile(d, info.id, p2);
    const errors = validateLabelFile(doc, { schema, pack, sessionIds: Object.keys(sessionGames), durationSec: info.durationSec, tagIds });
    if (errors.length) return { error: 'invalid-labels', errors };
    const out = labelPath(info);
    let existing = null;
    let existingUnreadable = false;
    try { existing = JSON.parse(readFileSync(out, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') existingUnreadable = true; }
    const text = JSON.stringify(doc, null, 2) + '\n';
    let existingSha256 = null;
    try { existingSha256 = createHash('sha256').update(readFileSync(out)).digest('hex'); } catch { /* none, or unreadable */ }
    return {
      doc, text, out, exists: existing !== null || existingUnreadable, existingUnreadable,
      diff: existing ? diffLabelFiles(existing, doc) : null,
      sha256: createHash('sha256').update(text).digest('hex'), existingSha256,
    };
  }
  const previewBody = (info, r) => ({ file: `${info.id}.json`, exists: r.exists, existingUnreadable: r.existingUnreadable, diff: r.diff, labels: r.doc.labels.length, events: (r.doc.events || []).length, sha256: r.sha256, existingSha256: r.existingSha256 });

  // ---- notes (free text, local only) ----
  function readNotes(info) {
    let text;
    try { text = readFileSync(notesPath(info), 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') return []; throw httpError(500, 'notes-unreadable'); }
    const out = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { const n = JSON.parse(line); if (isObj(n)) out.push(n); } catch { throw httpError(500, 'notes-unreadable'); }
    }
    return out;
  }

  // ---- request checks ----
  function tokenOk(given) {
    if (typeof given !== 'string' || given.length !== 64) return false;
    return timingSafeEqual(sha256(given), tokenHash);
  }

  // ---- router ----
  async function handle(req, res) {
    const addr = server.address();
    const host = String(req.headers.host || '').toLowerCase();
    const okHosts = [`127.0.0.1:${addr.port}`, `localhost:${addr.port}`];
    if (!okHosts.includes(host)) return fail(res, 403, 'bad-host');
    const origin = req.headers.origin;
    if (origin && !okHosts.some((h) => origin === `http://${h}`)) return fail(res, 403, 'bad-origin');
    const referer = req.headers.referer;
    if (referer && !okHosts.some((h) => referer.startsWith(`http://${h}/`))) return fail(res, 403, 'bad-referer');

    const url = new URL(req.url, `http://${okHosts[0]}`);
    let parts;
    try { parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); } catch { return fail(res, 400, 'bad-path'); }
    if (parts.some((p) => p.includes('\0') || p === '..' || /[\\/]/.test(p))) return fail(res, 400, 'bad-path');
    const method = req.method;
    // Another website can make the browser send GETs here without an Origin header (img, video, link).
    // Browsers mark those with Sec-Fetch-Site; only the page itself (same-origin) or a typed URL (none)
    // may use the API and media routes. Old clients without the header are still checked by Host.
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none' && !Object.hasOwn(STATIC, url.pathname)) {
      return fail(res, 403, 'cross-site');
    }

    if (Object.hasOwn(STATIC, url.pathname)) {
      if (method !== 'GET' && method !== 'HEAD') return fail(res, 405, 'method');
      const [file, type] = STATIC[url.pathname];
      return send(res, 200, readFileSync(path.join(HERE, file)), type);
    }

    // Everything else needs the launch token: the header, or ?tok= on the element-src routes.
    const srcRoute = parts[0] === 'media' || (parts[0] === 'api' && parts[1] === 'session' && (parts[3] === 'frame' || parts[3] === 'thumb') && parts.length === 4);
    const given = req.headers['x-label-token'] ?? (srcRoute ? url.searchParams.get('tok') : undefined);
    if (!tokenOk(given)) return fail(res, 401, 'bad-token');

    if (method !== 'GET' && method !== 'HEAD' && !String(req.headers['content-type'] || '').startsWith('application/json')) {
      return fail(res, 415, 'json-only');
    }
    const tab = String(req.headers['x-label-tab'] || '');

    // /api/tags
    if (parts[0] === 'api' && parts[1] === 'tags' && parts.length === 2 && method === 'GET') {
      return send(res, 200, readFileSync(tagsFile));
    }
    // /api/sessions
    if (parts[0] === 'api' && parts[1] === 'sessions' && parts.length === 2 && method === 'GET') {
      const list = [];
      for (const id of Object.keys(sessionGames)) {
        const info = sessionInfo(id);
        if (!info) continue;
        let d = null;
        let p2 = null;
        let draftError = false;
        try { d = readDraft(info); p2 = readPass2(info); } catch { draftError = true; }
        list.push({
          id, game: info.game, durationSec: info.durationSec, clipCount: info.clipCount, draftError,
          hasDraft: Boolean(d && d.revision > 0), pass2Opened: Boolean(p2 && p2.openedAt),
          exported: existsSync(labelPath(info)),
        });
      }
      return send(res, 200, { sessions: list });
    }
    // /api/session/:id/...
    if (parts[0] === 'api' && parts[1] === 'session' && parts.length >= 4) {
      const info = sessionInfo(parts[2]);
      if (!info) return fail(res, 404, 'unknown-session');
      const what = parts[3];
      const needTab = () => { if (!TAB_RE.test(tab)) throw httpError(400, 'bad-tab'); };
      if (what === 'manifest' && method === 'GET') {
        return send(res, 200, {
          sessionId: info.id, game: info.game, durationSec: info.durationSec, clipCount: info.clipCount,
          segments: info.segments.map((s, i) => ({ i, startSec: s.sessionStartSec, durationSec: s.durationSec, wallStartUtc: s.wallStartUtc })),
        });
      }
      if (what === 'pack' && method === 'GET') {
        const p = getPack(info.game);
        return send(res, 200, { game: p.gameId, packVersion: p.packVersion, entries: p.entries });
      }
      if (what === 'lock' && method === 'POST') {
        needTab();
        const body = await readBody(req);
        return send(res, 200, takeLock(info, tab, isObj(body) && body.takeover === true));
      }
      if (what === 'unlock' && method === 'POST') {
        needTab();
        await readBody(req);
        return send(res, 200, { released: releaseLock(info, tab) });
      }
      if (what === 'suggestions' && method === 'GET') {
        readDraft(info);
        const p2 = readPass2(info);
        if (!p2) return fail(res, 403, 'pass2-not-opened');
        const f = suggestionsPath(info);
        if (!existsSync(f)) return fail(res, 404, 'no-suggestions-file');
        return send(res, 200, readFileSync(f));
      }
      if (what === 'draft' && method === 'GET') return send(res, 200, withPass2(readDraft(info), readPass2(info)));
      if (what === 'draft' && method === 'PUT') {
        needTab();
        const r = putDraft(info, await readBody(req), tab);
        return r.error ? fail(res, r.status, r.error, r.at ? { at: r.at, errors: r.errors } : {}) : send(res, 200, r.draft);
      }
      if (what === 'open-pass2' && method === 'POST') {
        needTab();
        const body = await readBody(req);
        if (!isObj(body) || body.confirm !== true) return fail(res, 400, 'confirm-required');
        requireWriter(info, tab);
        const d = readDraft(info);
        let p2 = readPass2(info);
        if (!p2) {
          p2 = { openedAt: nowIso(), labelsHash: highlightsHash(d.labels), highlightsEditedAfter: false };
          writeAtomic(pass2Path(info), JSON.stringify(p2));
        }
        return send(res, 200, withPass2(d, p2));
      }
      if (what === 'export-preview' && method === 'POST') {
        await readBody(req);
        const r = prepareExport(info);
        if (r.error) return fail(res, 422, r.error, { errors: r.errors });
        return send(res, 200, previewBody(info, r));
      }
      if (what === 'export' && method === 'POST') {
        needTab();
        const body = await readBody(req);
        requireWriter(info, tab);
        const r = prepareExport(info);
        if (r.error) return fail(res, 422, r.error, { errors: r.errors });
        // The export writes exactly what the user confirmed: the document hash from export-preview, and
        // the hash of the file that was there then (null = none). Anything else is 409 with a fresh preview.
        const b = isObj(body) ? body : {};
        if (b.sha256 !== r.sha256 || (b.existingSha256 === undefined ? null : b.existingSha256) !== r.existingSha256) {
          return fail(res, 409, 'changed-since-preview', { preview: previewBody(info, r) });
        }
        if (r.exists && b.overwrite !== true) return fail(res, 409, 'exists', { hint: 'preview the diff, then send overwrite:true after the user confirms', preview: previewBody(info, r), diff: r.diff });
        writeAtomic(r.out, r.text);
        return send(res, 200, { ok: true, file: `${info.id}.json`, labels: r.doc.labels.length, events: (r.doc.events || []).length, timing: r.doc.timing });
      }
      if (what === 'notes' && method === 'GET') return send(res, 200, { notes: readNotes(info) });
      if (what === 'note' && method === 'POST') {
        needTab();
        const body = await readBody(req);
        if (!isObj(body) || typeof body.ref !== 'string' || !NOTE_REF_RE.test(body.ref)) return fail(res, 422, 'bad-note', { at: '/ref' });
        if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > NOTE_MAX) return fail(res, 422, 'bad-note', { at: '/text' });
        requireWriter(info, tab);
        readNotes(info); // an unreadable notes file is not appended to
        const f = notesPath(info);
        assertWritable(f);
        mkdirSync(path.dirname(f), { recursive: true });
        assertWritable(f);
        const rec = { t: nowIso(), ref: body.ref, text: body.text };
        appendFileSync(f, JSON.stringify(rec) + '\n');
        return send(res, 200, rec);
      }
      if (what === 'frame' && method === 'GET') {
        const t = Number(url.searchParams.get('t'));
        if (!Number.isFinite(t) || t < 0 || t > info.durationSec) return fail(res, 400, 'bad-time');
        const idx = info.segments.findIndex((s) => t >= s.sessionStartSec && t < s.sessionStartSec + s.durationSec);
        if (idx < 0) return fail(res, 404, 'no-clip-at-time');
        const file = clipPath(info, idx);
        if (!file) return fail(res, 404, 'clip-unavailable');
        const seg = info.segments[idx];
        const signal = clientGone(res);
        try {
          const jpg = await frameJpeg(file, seg.clipInSec + (t - seg.sessionStartSec), { quality: 2 }, signal);
          return send(res, 200, jpg, 'image/jpeg');
        } catch (e) { return frameFailed(res, e, signal); }
      }
      if (what === 'thumb' && method === 'GET') {
        const t = Number(url.searchParams.get('t'));
        if (!Number.isFinite(t) || t < 0 || t > info.durationSec) return fail(res, 400, 'bad-time');
        const signal = clientGone(res);
        try {
          const jpg = await frameJpeg(info.proxy, t, { width: 96, quality: 6 }, signal);
          return send(res, 200, jpg, 'image/jpeg');
        } catch (e) { return frameFailed(res, e, signal); }
      }
      return fail(res, 404, 'not-found');
    }
    // /media/proxy/:id   /media/clip/:id/:index
    if (parts[0] === 'media' && (method === 'GET' || method === 'HEAD')) {
      if (parts[1] === 'proxy' && parts.length === 3) {
        const info = sessionInfo(parts[2]);
        return info ? streamFile(req, res, info.proxy, 'video/mp4') : fail(res, 404, 'unknown-session');
      }
      if (parts[1] === 'clip' && parts.length === 4) {
        const info = sessionInfo(parts[2]);
        if (!info) return fail(res, 404, 'unknown-session');
        if (!/^\d{1,5}$/.test(parts[3])) return fail(res, 400, 'bad-index');
        const file = clipPath(info, Number(parts[3]));
        return file ? streamFile(req, res, file, 'video/mp4') : fail(res, 404, 'clip-unavailable');
      }
    }
    return fail(res, 404, 'not-found');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (res.headersSent) return res.destroy();
      if (e.status === 413) {
        // Answer first, then drop the unread body.
        send(res, 413, { error: 'too-large' }, undefined, { Connection: 'close' });
        res.once('finish', () => req.destroy());
        return;
      }
      fail(res, e.status || 500, e.status ? e.message : 'server-error');
    });
  });
  // On close, the locks this launch holds are released.
  const releaseAll = () => {
    for (const f of myLocks) {
      try { const l = JSON.parse(readFileSync(f, 'utf8')); if (l.launchId === launchId) unlinkSync(f); } catch { /* gone or not ours */ }
    }
    myLocks.clear();
  };
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server, port, token, launchId,
        url: `http://127.0.0.1:${port}/`,
        pageUrl: `http://127.0.0.1:${port}/?t=${token}`,
        stats: () => ({ ffmpegActive: active, ffmpegQueued: waiting.length }),
        releaseLocks: releaseAll,
        close: () => new Promise((r) => { releaseAll(); server.closeAllConnections?.(); server.close(() => r()); }),
      });
    });
  });
}

// ---- CLI ----
function cli() {
  const argv = process.argv.slice(2);
  const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  let paths = {};
  try { paths = readJson(path.join(REPO, 'data', 'profile.local.json')).paths || {}; } catch { /* no profile */ }
  const cacheDir = flag('--cache') || process.env.UJWALAM_CACHE || paths.analysis_cache;
  const corpusDir = flag('--corpus') || process.env.UJWALAM_CORPUS || paths.clips_corpus;
  if (!cacheDir || !corpusDir) {
    process.stderr.write('label: need --cache and --corpus (or paths.analysis_cache and paths.clips_corpus in data/profile.local.json).\n');
    process.exit(2);
  }
  startServer({ cacheDir, corpusDir, labelsDir: flag('--labels'), draftsRoot: flag('--drafts'), notesRoot: flag('--notes'), suggestionsRoot: flag('--suggestions'), port: flag('--port') ? Number(flag('--port')) : 8765 })
    .then((s) => {
      process.stdout.write(`Labelling page: ${s.pageUrl}\n(127.0.0.1 only; the token in the URL is new for every launch; Ctrl+C to stop)\n`);
      const stop = () => { s.releaseLocks(); process.exit(0); };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    })
    .catch((e) => { process.stderr.write(`label: ${e.code === 'unsafe-folders' ? `refusing to start: ${e.message}` : (e.code || e.message)}\n`); process.exit(1); });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli();
