// SPDX-License-Identifier: GPL-3.0-or-later
// P16a export-only posting. Node stdlib only. NOTHING here uploads, signs in or touches the network.
//
//   packageRun({ runDir, ledgerFile, profile, ffmpeg?, ... }) -> { packaged, skipped }
//     Input: a clip run folder from services/clip/clipper.py (candidates.json, report.json, clips/<id>/<layout>.mp4).
//     For each clip x target it offers only a variant whose report.json says PASS for that target and writes
//       <runDir>/posts/<clipId>/<target>/{<layout>.mp4 (byte copy, never re-encoded), cover.jpg, captions.ass?, post.json}
//     Text comes from data/posting/templates.json; {handles.x}/{links.x} resolve from the local profile, {date}/{n}
//     from the run. Chat text, viewer names, marker notes and candidate reasons are never read into post text.
//     Limits come from data/posting/limits.json (checked against official pages, D186; per field with its
//     counting unit). Over a limit = flagged, never truncated.
//     privacy is fixed "private"; status starts "draft".
//   Ledger (<dataDir>/posting/ledger.json): one entry per video SHA-256 + target. A video is never packaged twice for
//     the same target, even after reject. Later upload steps reuse this ledger (not built here).
//   packageUploads({ dataDir, ledgerFile, ... }) (D301): packages every finished video in <dataDir>/clips/uploads.json
//     (kinds short | montage | won-reel) that is not posted or packaged yet; target by length/aspect from limits.json.
//   createPostStore({ ledgerFile }) -> list/get/edit/setStatus/media for the studio UI server.
//
// Why Node (not Python next to the clipper): the studio-ui server edits and approves packages and owns the ledger
// semantics, the profile placeholder resolver (services/project/scene-preset.mjs) is Node, and one implementation
// avoids two writers in two languages. The clipper's PASS/FAIL report is the only coupling (a JSON file).

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as FS, copyFileSync, createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveString } from '../project/scene-preset.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const POSTING_FLAG = 'posting';
export const DEFAULT_TEMPLATES = path.join(REPO, 'data', 'posting', 'templates.json');
export const DEFAULT_LIMITS = path.join(REPO, 'data', 'posting', 'limits.json');
export const DEFAULT_TARGETS = path.join(REPO, 'data', 'clip', 'targets.json');
export const LEDGER_NAME = 'ledger.json';
export const STATUSES = Object.freeze(['draft', 'approved', 'rejected']);
export const TARGET_ID = /^[a-z][a-z0-9-]{0,31}$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const SHA = /^[0-9a-f]{64}$/;
const POST_ID = /^[0-9a-f]{16}\.[a-z][a-z0-9-]{0,31}$/;
const UNRESOLVED = /\{[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+\}/g;
export const EDIT_LIMITS = Object.freeze({ title: 300, description: 8000, tags: 30, tagChars: 60, hashtags: 60, hashtagChars: 80 });
const MEDIA = Object.freeze({ video: { ext: '.mp4', type: 'video/mp4' }, cover: { ext: '.jpg', type: 'image/jpeg' } });

export class PostingError extends Error {
  constructor(code, message) { super(message ?? code); this.name = 'PostingError'; this.code = code; }
}

const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isRealFile = (p) => { try { const s = lstatSync(p); return s.isFile() && !s.isSymbolicLink(); } catch { return false; } };
const isRealDir = (p) => { try { const s = lstatSync(p); return s.isDirectory() && !s.isSymbolicLink(); } catch { return false; } };

function writeJsonAtomic(file, obj) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw e;
  }
}

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file).on('error', reject).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex')));
  });
}

// ---------------------------------------------------------------- data files

export function loadTemplates(file = DEFAULT_TEMPLATES) {
  const j = readJson(file);
  if (!isPlain(j) || !isPlain(j.targets) || !Array.isArray(j.layoutPreference)) throw new PostingError('bad-templates', 'posting: bad templates file');
  for (const [id, t] of Object.entries(j.targets)) {
    if (!TARGET_ID.test(id) || typeof t.title !== 'string' || typeof t.description !== 'string' || !Array.isArray(t.tags) || !Array.isArray(t.hashtags)) throw new PostingError('bad-templates', `posting: bad template ${id}`);
  }
  return j;
}

export function loadLimits(file = DEFAULT_LIMITS) {
  const j = readJson(file);
  if (!isPlain(j) || !isPlain(j.targets)) throw new PostingError('bad-limits', 'posting: bad limits file');
  for (const [id, t] of Object.entries(j.targets)) {
    if (!isPlain(t) || !isPlain(t.fields)) throw new PostingError('bad-limits', `posting: limits for ${id.slice(0, 32)} have no fields`);
    for (const f of Object.values(t.fields)) {
      if (!isPlain(f) || (f.unit !== undefined && f.unit !== 'youtube-tags' && !Object.hasOwn(UNITS, f.unit)))
        throw new PostingError('bad-limits', `posting: bad field unit in limits for ${id.slice(0, 32)}`);
    }
  }
  return j;
}

// ---------------------------------------------------------------- text

/** Profile copy without angle-bracket template values (data/profile.example.json), so they count as unresolved. */
export function cleanProfile(p) {
  if (typeof p === 'string') return /^<.*>$/.test(p) ? undefined : p;
  if (Array.isArray(p)) return p.map(cleanProfile).filter((x) => x !== undefined);
  if (isPlain(p)) {
    const o = {};
    for (const [k, v] of Object.entries(p)) { const c = cleanProfile(v); if (c !== undefined) o[k] = c; }
    return o;
  }
  return p;
}

/** Fills {date} and {n}, then profile placeholders. Unresolved ones stay literal and are returned in `missing`. */
export function renderText(tpl, { profile, n, date }, missing) {
  const s = tpl.replace(/\{(date|n)\}/g, (_m, k) => String(k === 'n' ? n : date));
  return resolveString(s, profile ?? {}, missing, false);
}

export const unresolvedKeys = (...texts) => [...new Set(texts.flatMap((t) => [...String(t).matchAll(UNRESOLVED)].map((m) => m[0].slice(1, -1))))].sort();
const len = (s) => Array.from(String(s)).length;

/** Length of s in a platform unit (data/posting/limits.json). */
export const UNITS = Object.freeze({
  chars: (s) => Array.from(String(s)).length,
  utf16: (s) => String(s).length,
  'utf8-bytes': (s) => Buffer.byteLength(String(s), 'utf8'),
});
/** YouTube snippet.tags: tag characters + a comma between tags + 2 quotes per tag that contains a space. */
export const youtubeTagsLength = (tags) =>
  tags.reduce((n, t) => n + UNITS.chars(t) + (/\s/.test(t) ? 2 : 0), 0) + Math.max(0, tags.length - 1);

/**
 * The text a platform field receives, built from post.json parts: text parts and the hashtags (joined by spaces)
 * are separated by a blank line; tags are joined by commas. Uploaders must send exactly this (D186). Pure.
 */
export function composeField(post, from) {
  const part = (k) => (Array.isArray(post[k]) ? post[k].join(k === 'tags' ? ',' : ' ') : String(post[k] ?? '')).trim();
  return from.map(part).filter(Boolean).join('\n\n');
}

const countMatches = (s, re) => [...String(s).matchAll(re)].length;
const HASHTAG = /(?:^|\s)#[^\s#]+/gu;
const MENTION = /(?:^|\s)@[^\s@]+/gu;

/** Checks the composed platform fields against the target's limits. A field without max is not length-checked. Pure. */
export function checkLimits(post, limits) {
  const L = limits?.targets?.[post.target];
  if (!L || !isPlain(L.fields)) return { status: 'unknown-target', ok: false, checks: [] };
  const checks = [];
  for (const [field, f] of Object.entries(L.fields)) {
    const from = Array.isArray(f.from) ? f.from : [field];
    if (Number.isInteger(f.max)) {
      const value = f.unit === 'youtube-tags' ? youtubeTagsLength(post.tags ?? []) : (UNITS[f.unit] ?? UNITS.chars)(composeField(post, from));
      checks.push({ field, value, max: f.max, unit: f.unit ?? 'chars', ok: value <= f.max });
    }
    const text = composeField(post, from);
    if (typeof f.forbid === 'string' && f.forbid) {
      const value = Array.from(text).filter((ch) => f.forbid.includes(ch)).length;
      checks.push({ field, value, max: 0, unit: `forbidden ${f.forbid}`, ok: value === 0 });
    }
    if (Number.isInteger(f.hashtagMax)) { const value = countMatches(text, HASHTAG); checks.push({ field, value, max: f.hashtagMax, unit: 'hashtags', ok: value <= f.hashtagMax }); }
    if (Number.isInteger(f.mentionMax)) { const value = countMatches(text, MENTION); checks.push({ field, value, max: f.mentionMax, unit: 'mentions', ok: value <= f.mentionMax }); }
  }
  return { status: L.status ?? 'unverified', source: L.source ?? null, checked: L.checked ?? null, ok: checks.every((c) => c.ok), checks };
}

function cleanList(v, maxItems, maxChars, hash) {
  if (!Array.isArray(v) || v.length > maxItems) return null;
  const out = [];
  for (const x of v) {
    if (typeof x !== 'string') return null;
    let s = x.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    if (hash) s = s.replace(/\s+/g, '');
    if (hash && s && !s.startsWith('#')) s = `#${s}`;
    if (!s || s === '#') continue;
    if (len(s) > maxChars) return null;
    out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------- ledger

export function createLedger(file) {
  const read = () => {
    const j = readJson(file);
    return isPlain(j) && isPlain(j.entries) ? j : { version: 1, entries: {} };
  };
  const key = (sha, target) => `${sha}:${target}`;
  return {
    file,
    get: (sha, target) => read().entries[key(sha, target)] ?? null,
    list: () => Object.values(read().entries),
    /** Fresh read, change one entry, atomic write. Refuses a duplicate key. */
    put(entry) {
      const j = read();
      const k = key(entry.sha256, entry.target);
      if (Object.hasOwn(j.entries, k)) throw new PostingError('duplicate', 'ledger: already packaged for this target');
      j.entries[k] = entry;
      writeJsonAtomic(file, j);
    },
    setStatus(sha, target, status, at) {
      const j = read();
      const e = j.entries[key(sha, target)];
      if (!e) throw new PostingError('unknown-post', 'ledger: unknown entry');
      e.status = status; e.updatedAt = at;
      writeJsonAtomic(file, j);
    },
    /** Adds plain string fields (e.g. videoId) to one entry. Fresh read, atomic write. */
    annotate(sha, target, fields) {
      const j = read();
      const e = j.entries[key(sha, target)];
      if (!e) throw new PostingError('unknown-post', 'ledger: unknown entry');
      for (const [k, v] of Object.entries(fields)) if (k === 'videoId' && typeof v === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(v)) e[k] = v;
      writeJsonAtomic(file, j);
    },
  };
}

// ---------------------------------------------------------------- tools

export function findFfmpeg(explicit) {
  if (explicit) {
    if (isRealFile(explicit)) return path.resolve(explicit);
    throw new PostingError('no-ffmpeg', 'ffmpeg not found at the given path');
  }
  const names = process.platform === 'win32' ? ['ffmpeg.exe'] : ['ffmpeg'];
  for (const dir of String(process.env.PATH ?? '').split(path.delimiter)) {
    for (const n of names) if (dir && isRealFile(path.join(dir, n))) return path.join(dir, n);
  }
  throw new PostingError('no-ffmpeg', 'ffmpeg not found on PATH (pass --ffmpeg)');
}

/** Extracts one JPEG frame at `atSec`. CPU only, one thread, below-normal priority. Resolves true on success. */
export function extractCover(ffmpeg, video, atSec, out) {
  return new Promise((resolve) => {
    const args = ['-v', 'error', '-nostdin', '-y', '-threads', '1', '-ss', atSec.toFixed(3), '-i', video, '-frames:v', '1', '-q:v', '2', out];
    let p;
    try { p = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true }); } catch { return resolve(false); }
    try { os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort */ }
    const t = setTimeout(() => p.kill(), 60_000);
    p.on('error', () => { clearTimeout(t); resolve(false); });
    p.on('close', (code) => { clearTimeout(t); resolve(code === 0 && isRealFile(out)); });
  });
}

// ---------------------------------------------------------------- packager

/** opts: { runDir, ledgerFile, profile?, ffmpeg?, templates?, limits?, targets?: [id], now? }
 *  -> { packaged: [{ clipId, target, dir, layout }], skipped: [{ clipId, target, reason }] } */
export async function packageRun(opts) {
  const runDir = path.resolve(opts.runDir);
  const now = opts.now ?? (() => new Date());
  const templates = opts.templates ?? loadTemplates();
  const limits = opts.limits ?? loadLimits();
  const cands = readJson(path.join(runDir, 'candidates.json'));
  const report = readJson(path.join(runDir, 'report.json'));
  if (!isPlain(cands) || !Array.isArray(cands.candidates)) throw new PostingError('no-candidates', 'run folder has no usable candidates.json');
  if (!isPlain(report) || !Array.isArray(report.results)) throw new PostingError('no-report', 'run folder has no usable report.json (run clipper validate first)');
  const known = Object.keys(templates.targets);
  // A template marked uploadsOnly (youtube-video) is for finished videos from uploads.json, not for clip variants.
  const targets = opts.targets ?? known.filter((t) => templates.targets[t].uploadsOnly !== true);
  for (const t of targets) if (!known.includes(t) || !limits.targets?.[t]) throw new PostingError('unknown-target', `no template or limits for target ${String(t).slice(0, 32)}`);
  const profile = cleanProfile(opts.profile ?? {});
  const date = typeof cands.recordStartUtc === 'string' && /^\d{4}-\d{2}-\d{2}/.test(cands.recordStartUtc) ? cands.recordStartUtc.slice(0, 10) : 'unknown-date';
  const ledger = createLedger(opts.ledgerFile);
  const pref = (l) => { const i = templates.layoutPreference.indexOf(l); return i < 0 ? 99 : i; };
  const runName = path.basename(runDir);
  const packaged = []; const skipped = [];
  let ffmpeg = null;

  for (let idx = 0; idx < cands.candidates.length; idx++) {
    const c = cands.candidates[idx];
    if (!isPlain(c) || !SAFE_NAME.test(String(c.id))) continue;
    const n = Number.isInteger(c.rank) ? c.rank : idx + 1;
    for (const target of targets) {
      const rows = report.results
        .filter((r) => r.id === c.id && r.file && SAFE_NAME.test(String(r.file)) && SAFE_NAME.test(String(r.layout)) && r.targets?.[target]?.ok === true && r.ok !== false)
        .sort((a, b) => pref(a.layout) - pref(b.layout));
      const row = rows.find((r) => isRealFile(path.join(runDir, 'clips', c.id, r.file)));
      if (!row) { skipped.push({ clipId: c.id, target, reason: 'no-pass-variant' }); continue; }
      const src = path.join(runDir, 'clips', c.id, row.file);
      const sha = await sha256File(src);
      if (ledger.get(sha, target)) { skipped.push({ clipId: c.id, target, reason: 'already-packaged' }); continue; }
      const dir = path.join(runDir, 'posts', c.id, target);
      if (existsSync(dir)) { skipped.push({ clipId: c.id, target, reason: 'folder-exists' }); continue; }
      ffmpeg ??= findFfmpeg(opts.ffmpeg);
      mkdirSync(dir, { recursive: true });
      const videoName = `${row.layout}.mp4`;
      const dst = path.join(dir, videoName);
      copyFileSync(src, dst, FS.COPYFILE_EXCL);
      if (await sha256File(dst) !== sha) throw new PostingError('copy-mismatch', 'copied video differs from the source');
      const tpl = templates.targets[target];
      const missing = new Set();
      const ctx = { profile, n, date };
      const post = {
        title: renderText(tpl.title, ctx, missing),
        description: renderText(tpl.description, ctx, missing),
        tags: tpl.tags.map((t) => renderText(t, ctx, missing)),
        hashtags: tpl.hashtags.map((t) => renderText(t, ctx, missing)),
        target,
      };
      const dur = Number(row.facts?.duration);
      const peak = Number.isFinite(Number(c.anchor)) && Number.isFinite(Number(c.start)) ? Number(c.anchor) - Number(c.start) : 0;
      const at = Math.min(Math.max(peak, 0), Number.isFinite(dur) && dur > 0.4 ? dur - 0.2 : Math.max(peak, 0));
      const coverOk = await extractCover(ffmpeg, dst, at, path.join(dir, 'cover.jpg'));
      let captions = null;
      const capSrc = path.join(runDir, 'clips', c.id, 'captions.ass');
      if (isRealFile(capSrc)) { copyFileSync(capSrc, path.join(dir, 'captions.ass'), FS.COPYFILE_EXCL); captions = 'captions.ass'; }
      const stamp = now().toISOString();
      const full = {
        version: 1,
        ...post,
        privacy: 'private',
        status: 'draft',
        source: { run: runName, clipId: c.id, layout: row.layout, startSec: c.start, endSec: c.end, score: Number.isFinite(c.score) ? c.score : null, sha256: sha },
        video: { file: videoName, bytes: statSync(dst).size },
        cover: coverOk ? { file: 'cover.jpg', atSec: Number(at.toFixed(3)) } : null,
        captions,
        limits: checkLimits(post, limits),
        unresolved: unresolvedKeys(post.title, post.description, ...post.tags, ...post.hashtags),
        createdAt: stamp,
        updatedAt: stamp,
      };
      writeJsonAtomic(path.join(dir, 'post.json'), full);
      ledger.put({ sha256: sha, target, status: 'draft', dir, clipId: c.id, createdAt: stamp, updatedAt: stamp });
      packaged.push({ clipId: c.id, target, dir, layout: row.layout, cover: coverOk, limitsOk: full.limits.ok, unresolved: full.unresolved });
    }
  }
  return { packaged, skipped };
}

// ---------------------------------------------------------------- finished videos (uploads.json, D301)

export const UPLOAD_KINDS = Object.freeze(['short', 'montage', 'won-reel']);
const CANVAS_TAIL = /_(\d{2})_(v(?:-[a-z0-9-]+)?|h)\.[a-z0-9]+$/i;
const NAME_DATE = /_(\d{4})(\d{2})(\d{2})-\d{6}_/;

/** Target for one finished video, from data/posting/limits.json (never hardcoded): vertical and not longer than the
 *  Shorts limit -> the target that carries `video`; anything else -> `youtube-video`. */
export function pickYoutubeTarget({ seconds, vertical }, limits) {
  const shorts = limits.targets?.['youtube-shorts']?.video;
  const max = Number(shorts?.maxDurationSec);
  const isShort = !!shorts && vertical === true && Number.isFinite(Number(seconds)) && Number.isFinite(max) && Number(seconds) <= max;
  return isShort ? 'youtube-shorts' : 'youtube-video';
}

/** opts: { dataDir, ledgerFile, profile?, ffmpeg?, templates?, limits?, run?, now? }
 *  Packages every validated, published video in <dataDir>/clips/uploads.json that is not posted and not packaged yet
 *  (kinds short | montage | won-reel). Packages go to <dataDir>/posting/packages/<run>/<kind>-<sha16>/<target>/.
 *  -> { packaged: [{ file, kind, target, dir }], skipped: [{ file, reason }] } */
export async function packageUploads(opts) {
  const templates = opts.templates ?? loadTemplates();
  const limits = opts.limits ?? loadLimits();
  const doc = readJson(path.join(opts.dataDir, 'clips', 'uploads.json'));
  const packaged = []; const skipped = [];
  if (!isPlain(doc) || !Array.isArray(doc.files)) return { packaged, skipped };
  const now = opts.now ?? (() => new Date());
  const profile = cleanProfile(opts.profile ?? {});
  const ledger = createLedger(opts.ledgerFile);
  let ffmpeg = null;
  for (const row of doc.files) {
    const file = isPlain(row) && typeof row.file === 'string' ? row.file : null;
    const skip = (reason) => skipped.push({ file: file ? path.basename(file) : '?', reason });
    if (!file || !UPLOAD_KINDS.includes(row.kind)) { skip('unknown-kind'); continue; }
    if (opts.run && row.run !== opts.run) continue;
    if (Array.isArray(row.posted) && row.posted.some((p) => p?.platform === 'youtube')) { skip('already-posted'); continue; }
    if (!path.isAbsolute(file) || !isRealFile(file)) { skip('file-missing'); continue; }
    const tail = CANVAS_TAIL.exec(path.basename(file));
    const vertical = tail ? tail[2].toLowerCase().startsWith('v') : false;
    const seconds = Number(row.seconds);
    const target = pickYoutubeTarget({ seconds, vertical }, limits);
    if (!templates.targets[target] || !limits.targets?.[target]) { skip('no-template'); continue; }
    const sha = await sha256File(file);
    if (ledger.get(sha, target)) { skip('already-packaged'); continue; }
    const runName = SAFE_NAME.test(String(row.run)) ? row.run : 'run';
    const dir = path.join(opts.dataDir, 'posting', 'packages', runName, `${row.kind}-${sha.slice(0, 16)}`, target);
    if (existsSync(dir)) { skip('folder-exists'); continue; }
    ffmpeg ??= findFfmpeg(opts.ffmpeg);
    mkdirSync(dir, { recursive: true });
    const videoName = `${row.kind}.mp4`;
    const dst = path.join(dir, videoName);
    copyFileSync(file, dst, FS.COPYFILE_EXCL);
    if (await sha256File(dst) !== sha) throw new PostingError('copy-mismatch', 'copied video differs from the source');
    const dm = NAME_DATE.exec(path.basename(file));
    const date = dm ? `${dm[1]}-${dm[2]}-${dm[3]}` : 'unknown-date';
    const n = tail ? Number(tail[1]) : 1;
    const base = templates.targets[target];
    const tpl = isPlain(base.kinds?.[row.kind]) ? { ...base, ...base.kinds[row.kind] } : base;
    const missing = new Set();
    const ctx = { profile, n, date };
    const post = {
      title: renderText(tpl.title, ctx, missing),
      description: renderText(tpl.description, ctx, missing),
      tags: tpl.tags.map((t) => renderText(t, ctx, missing)),
      hashtags: tpl.hashtags.map((t) => renderText(t, ctx, missing)),
      target,
    };
    const at = Number.isFinite(seconds) && seconds > 0.4 ? Math.min(2, seconds / 2) : 0;
    const coverOk = await extractCover(ffmpeg, dst, at, path.join(dir, 'cover.jpg'));
    const stamp = now().toISOString();
    const clipId = `${row.kind}-${sha.slice(0, 12)}`;
    const full = {
      version: 1,
      ...post,
      privacy: 'private',
      status: 'draft',
      source: { run: runName, clipId, kind: row.kind, layout: tail ? tail[2].toLowerCase() : 'unknown', startSec: 0, endSec: Number.isFinite(seconds) ? seconds : null, score: null, sha256: sha },
      video: { file: videoName, bytes: statSync(dst).size },
      cover: coverOk ? { file: 'cover.jpg', atSec: Number(at.toFixed(3)) } : null,
      captions: null,
      limits: checkLimits(post, limits),
      unresolved: unresolvedKeys(post.title, post.description, ...post.tags, ...post.hashtags),
      createdAt: stamp,
      updatedAt: stamp,
    };
    writeJsonAtomic(path.join(dir, 'post.json'), full);
    ledger.put({ sha256: sha, target, status: 'draft', dir, clipId, createdAt: stamp, updatedAt: stamp });
    packaged.push({ file: path.basename(file), kind: row.kind, target, dir, limitsOk: full.limits.ok, unresolved: full.unresolved });
  }
  return { packaged, skipped };
}

// ---------------------------------------------------------------- store (studio UI)

export const postId = (entry) => `${entry.sha256.slice(0, 16)}.${entry.target}`;

/** opts: { ledgerFile, limits?, now? }. Reads and edits packages known to the ledger. */
export function createPostStore(opts) {
  const ledger = createLedger(opts.ledgerFile);
  const limitsFile = opts.limits ?? null;
  const now = opts.now ?? (() => new Date());
  const limits = () => limitsFile ?? loadLimits();

  function entries() {
    return ledger.list().filter((e) => isPlain(e) && SHA.test(String(e.sha256)) && TARGET_ID.test(String(e.target)) && typeof e.dir === 'string' && path.isAbsolute(e.dir));
  }
  function load(entry) {
    const file = path.join(entry.dir, 'post.json');
    if (!isRealDir(entry.dir) || !isRealFile(file)) return null;
    const p = readJson(file);
    if (!isPlain(p) || p.target !== entry.target || p.source?.sha256 !== entry.sha256) return null;
    return p;
  }
  const find = (id) => (typeof id === 'string' && POST_ID.test(id) ? entries().find((e) => postId(e) === id) ?? null : null);
  const view = (e, p) => ({
    id: postId(e), target: p.target, clipId: p.source.clipId, kind: typeof p.source.kind === 'string' ? p.source.kind : 'short', layout: p.source.layout, score: Number.isFinite(p.source.score) ? p.source.score : null, startSec: p.source.startSec, endSec: p.source.endSec,
    status: e.status, videoId: e.videoId ?? null, privacy: 'private', title: p.title, description: p.description, tags: p.tags, hashtags: p.hashtags,
    limits: p.limits, unresolved: p.unresolved ?? [], hasCover: !!p.cover, hasCaptions: !!p.captions, videoBytes: p.video?.bytes ?? null, updatedAt: p.updatedAt,
  });
  function save(e, p) {
    p.updatedAt = now().toISOString();
    writeJsonAtomic(path.join(e.dir, 'post.json'), p);
  }

  return {
    ledger,
    list() {
      const out = [];
      for (const e of entries()) { const p = load(e); if (p) out.push(view(e, { ...p, status: e.status })); }
      return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    },
    get(id) { const e = find(id); const p = e && load(e); return p ? view(e, p) : null; },
    /** fields: { title?, description?, tags?, hashtags? } -> view | error string. A changed package goes back to draft. */
    edit(id, fields) {
      const e = find(id); const p = e && load(e);
      if (!p) return 'unknown-post';
      if (e.status === 'uploaded') return 'already-uploaded';
      if (!isPlain(fields) || Object.keys(fields).some((k) => !['title', 'description', 'tags', 'hashtags'].includes(k))) return 'bad-params';
      const next = { title: p.title, description: p.description, tags: p.tags, hashtags: p.hashtags };
      if (fields.title !== undefined) {
        if (typeof fields.title !== 'string' || fields.title.length > EDIT_LIMITS.title) return 'bad-title';
        next.title = fields.title.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
      }
      if (fields.description !== undefined) {
        if (typeof fields.description !== 'string' || fields.description.length > EDIT_LIMITS.description) return 'bad-description';
        next.description = fields.description.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim();
      }
      if (fields.tags !== undefined) { const t = cleanList(fields.tags, EDIT_LIMITS.tags, EDIT_LIMITS.tagChars, false); if (!t) return 'bad-tags'; next.tags = t; }
      if (fields.hashtags !== undefined) { const t = cleanList(fields.hashtags, EDIT_LIMITS.hashtags, EDIT_LIMITS.hashtagChars, true); if (!t) return 'bad-hashtags'; next.hashtags = t; }
      Object.assign(p, next);
      p.limits = checkLimits({ ...next, target: p.target }, limits());
      p.unresolved = unresolvedKeys(next.title, next.description, ...next.tags, ...next.hashtags);
      p.status = 'draft';
      save(e, p);
      ledger.setStatus(e.sha256, e.target, 'draft', p.updatedAt);
      return view({ ...e, status: 'draft' }, p);
    },
    /** status: draft | approved | rejected. Approve needs text inside the limits, no unresolved placeholder, an intact video. */
    async setStatus(id, status) {
      if (!STATUSES.includes(status)) return 'bad-status';
      const e = find(id); const p = e && load(e);
      if (!p) return 'unknown-post';
      if (e.status === 'uploaded') return 'already-uploaded';
      if (status === 'approved') {
        if (!p.title) return 'empty-title';
        if (!checkLimits(p, limits()).ok) return 'over-limit';
        if (unresolvedKeys(p.title, p.description, ...p.tags, ...p.hashtags).length) return 'unresolved-placeholders';
        const vf = path.join(e.dir, p.video?.file ?? '');
        if (!SAFE_NAME.test(String(p.video?.file)) || !isRealFile(vf) || await sha256File(vf) !== e.sha256) return 'video-changed';
      }
      p.status = status;
      save(e, p);
      ledger.setStatus(e.sha256, e.target, status, p.updatedAt);
      return view({ ...e, status }, p);
    },
    /** -> { file, type, size } for kind video|cover, or null. Name comes from post.json, must be a plain file
     *  with the allowlisted extension, inside the package folder (real path), no link. */
    media(id, kind) {
      const e = find(id); const p = e && load(e);
      const m = Object.hasOwn(MEDIA, kind) ? MEDIA[kind] : null;
      if (!p || !m) return null;
      const name = kind === 'video' ? p.video?.file : p.cover?.file;
      if (typeof name !== 'string' || !SAFE_NAME.test(name) || path.extname(name).toLowerCase() !== m.ext) return null;
      const file = path.join(e.dir, name);
      if (!isRealFile(file)) return null;
      const dir = realpathSync(e.dir); const real = realpathSync(file);
      if (!real.startsWith(dir + path.sep)) return null;
      return { file: real, type: m.type, size: statSync(real).size };
    },
    /** Package folder for "open folder". */
    dir(id) { const e = find(id); return e && load(e) ? e.dir : null; },
  };
}
