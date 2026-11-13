// SPDX-License-Identifier: GPL-3.0-or-later
// RP5 / AN2 self-learning within limits (D364, D373; flag self-learning, off by default). Node stdlib only.
//
// Settings and limits: data/clip/learning-mix.json (committed, never hardcoded here).
// State and log (local app data, never committed):
//   <dataDir>/learning/mix.json        the mix in effect: { version, applied, shares: { <dim>: { <arm>: share } }, changedAt }
//   <dataDir>/learning/mix-log.jsonl   one line per change or undo, with the numbers behind it (append only)
// This module is the only writer of both files. The montage planner (services/clip/learning_mix.py) and the auto-post
// rules (services/posting/auto-post.mjs) read the mix only while the flag is on AND applied is true; before the first
// change (cold start) or after undoing it, applied is false and behaviour is exactly today's.
//
//   loadConfig(file?)                         -> validated settings
//   linkVideos({ rows, posts, cfg, hourOf? }) -> [{ videoId, kind, choices: { <dim>: arm }, at, views, viewedPct }]
//   rewards(videos, cfg)                      -> [{ ...video, reward }]   (pure; formula in the settings file)
//   thompson(videos, dim, cfg, rng)           -> { <arm>: { n, meanReward, alpha, beta, winProb } }
//   limitShares(cur, target, limits)          -> shares inside the floor and the weekly step (pure)
//   step({ dataDir, cfg?, rows?, posts?, now?, seed? }) -> { changed, reason, entry? }  at most once per periodDays
//   undo({ dataDir, now? })                   -> { undone, entry?, reason? }
//   view({ dataDir, cfg?, rows?, posts?, now? }) -> current mix, cold-start reason, log (for the Growth window)
//   weeklyReport(view)                        -> plain-English text

import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MIX_FLAG = 'self-learning';
export const DEFAULT_CONFIG = path.join(REPO, 'data', 'clip', 'learning-mix.json');
export const MIX_DIR = 'learning';
export const MIX_FILE = 'mix.json';
export const LOG_FILE = 'mix-log.jsonl';
const DAY = 86_400_000;
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const r4 = (x) => Math.round(x * 10_000) / 10_000;

export class MixError extends Error {
  constructor(code, message) { super(message ?? code); this.name = 'MixError'; this.code = code; }
}

// ---------------------------------------------------------------- settings

export function loadConfig(file = DEFAULT_CONFIG) {
  let j;
  try { j = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new MixError('bad-config', 'learning-mix.json could not be read'); }
  return validateConfig(j);
}

export function validateConfig(j) {
  const bad = (m) => { throw new MixError('bad-config', `learning-mix.json: ${m}`); };
  if (!isPlain(j) || !isPlain(j.limits) || !isPlain(j.coldStart) || !isPlain(j.reward) || !isPlain(j.bandit) || !Array.isArray(j.dimensions)) bad('missing sections');
  const { minShare, maxStepPoints, periodDays } = j.limits;
  if (!(num(minShare) !== null && minShare >= 0 && minShare < 0.5)) bad('limits.minShare must be 0..0.5');
  if (!(num(maxStepPoints) !== null && maxStepPoints > 0 && maxStepPoints <= 100)) bad('limits.maxStepPoints must be 1..100');
  if (!(num(periodDays) !== null && periodDays >= 1)) bad('limits.periodDays must be at least 1');
  if (!Number.isInteger(j.coldStart.minVideos) || j.coldStart.minVideos < 1) bad('coldStart.minVideos must be a whole number >= 1');
  if (!Number.isInteger(j.coldStart.minPerDimension) || j.coldStart.minPerDimension < 1) bad('coldStart.minPerDimension must be a whole number >= 1');
  const { wViewed, wViews, viewedPctCap } = j.reward;
  if (!(num(wViewed) !== null && num(wViews) !== null && wViewed >= 0 && wViews >= 0 && Math.abs(wViewed + wViews - 1) < 1e-9)) bad('reward weights must be >= 0 and add up to 1');
  if (!(num(viewedPctCap) !== null && viewedPctCap > 0)) bad('reward.viewedPctCap must be > 0');
  if (!(num(j.bandit.prior) !== null && j.bandit.prior > 0)) bad('bandit.prior must be > 0');
  if (!(Number.isInteger(j.bandit.draws) && j.bandit.draws >= 100 && j.bandit.draws <= 100_000)) bad('bandit.draws must be 100..100000');
  const seen = new Set();
  const dims = j.dimensions.map((d) => {
    if (!isPlain(d) || typeof d.id !== 'string' || seen.has(d.id) || !Array.isArray(d.arms) || d.arms.length < 2) bad('each dimension needs an id and at least two arms');
    seen.add(d.id);
    if (d.arms.length * minShare > 1) bad(`${d.id}: ${d.arms.length} arms x minShare is more than 100 %`);
    if (!isPlain(d.defaults) || d.arms.some((a) => num(d.defaults[a]) === null || d.defaults[a] < minShare - 1e-9)) bad(`${d.id}: every default share must be at least minShare`);
    if (Math.abs(d.arms.reduce((s, a) => s + d.defaults[a], 0) - 1) > 1e-6) bad(`${d.id}: default shares must add up to 1`);
    return { ...d, kinds: Array.isArray(d.kinds) ? d.kinds : null };
  });
  for (const id of ['kind', 'lengthBand', 'transition', 'title', 'music', 'hour']) if (!seen.has(id)) bad(`dimension ${id} missing`);
  return { ...j, dimensions: dims, byId: Object.fromEntries(dims.map((d) => [d.id, d])) };
}

export const defaultShares = (cfg) => Object.fromEntries(cfg.dimensions.map((d) => [d.id, { ...d.defaults }]));

// ---------------------------------------------------------------- linking posted videos to their choices

const ARM = /^[a-z][a-z0-9-]{0,31}$/;

/** A video's edit choices as arms, from post.json source.choices (written at publish time) + its length and kind. */
export function choicesOf(post, cfg) {
  const out = {};
  const kind = typeof post?.kind === 'string' ? post.kind : null;
  if (kind && cfg.byId.kind.arms.includes(kind)) out.kind = kind;
  const c = isPlain(post?.choices) ? post.choices : {};
  for (const id of ['transition', 'title', 'music']) {
    const d = cfg.byId[id];
    if (typeof c[id] === 'string' && ARM.test(c[id]) && d.arms.includes(c[id]) && (!d.kinds || d.kinds.includes(kind))) out[id] = c[id];
  }
  const lb = cfg.byId.lengthBand;
  const sec = num(c.seconds) ?? num(post?.endSec);
  if (sec !== null && (!lb.kinds || lb.kinds.includes(kind))) {
    const arm = lb.arms.find((a) => { const b = lb.bands[a]; return sec >= b.minSec && (b.maxSec === null || sec < b.maxSec); });
    if (arm) out.lengthBand = arm;
  }
  return out;
}

export const localHour = (iso) => new Date(iso).getHours();

/**
 * rows: services/analytics summary(store) rows ({ videoId, postId, kind, publicAt, at24h, at7d, ... }).
 * posts: services/posting createPostStore().list() views (id, kind, endSec, choices). Joined by post id.
 * Only videos with a checkpoint that carries statistics are returned (7 d preferred, else 24 h).
 */
export function linkVideos({ rows, posts, cfg, hourOf = localHour }) {
  const byPost = new Map((posts ?? []).map((p) => [p.id, p]));
  const out = [];
  for (const v of rows ?? []) {
    const cp = v.at7d?.analytics ? { name: 'at7d', s: v.at7d } : v.at24h?.analytics ? { name: 'at24h', s: v.at24h } : null;
    if (!cp) continue;
    const post = byPost.get(v.postId) ?? { kind: v.kind };
    const choices = choicesOf({ ...post, kind: post.kind ?? v.kind }, cfg);
    if (v.publicAt && !Number.isNaN(Date.parse(v.publicAt))) {
      const h = hourOf(v.publicAt);
      const hd = cfg.byId.hour;
      const arm = hd.arms.find((a) => h >= hd.hours[a][0] && h < hd.hours[a][1]);
      if (arm) choices.hour = arm;
    }
    const a = cp.s.analytics;
    out.push({
      videoId: v.videoId, platform: v.platform ?? 'youtube', checkpoint: cp.name, choices,
      views: num(a.views) ?? num(cp.s.data?.views), viewedPct: num(a.averageViewPercentage),
    });
  }
  return out;
}

// ---------------------------------------------------------------- reward

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** r = wViewed * min(pct, cap)/cap + wViews * views/(views + median views of the same platform and checkpoint). 0..1.
 *  A video missing a part scores that part as 0.5 (neutral), never a guessed number. */
export function rewards(videos, cfg) {
  const { wViewed, wViews, viewedPctCap } = cfg.reward;
  const med = new Map();
  for (const v of videos) {
    const k = `${v.platform}|${v.checkpoint}`;
    if (!med.has(k)) med.set(k, median(videos.filter((x) => `${x.platform}|${x.checkpoint}` === k && x.views !== null).map((x) => x.views)));
  }
  return videos.map((v) => {
    const pctPart = v.viewedPct === null ? 0.5 : Math.min(Math.max(v.viewedPct, 0), viewedPctCap) / viewedPctCap;
    const m = med.get(`${v.platform}|${v.checkpoint}`);
    let viewsPart = 0.5;
    if (v.views !== null && m !== null) viewsPart = m > 0 ? v.views / (v.views + m) : (v.views > 0 ? 1 : 0.5);
    return { ...v, reward: r4(wViewed * pctPart + wViews * viewsPart) };
  });
}

// ---------------------------------------------------------------- Thompson sampling (seeded)

export function seededRng(seed) {
  let a = typeof seed === 'number' ? seed >>> 0 : createHash('sha256').update(String(seed)).digest().readUInt32LE(0);
  return () => { // mulberry32
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(rng) {
  let u = 0; while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}
/** Marsaglia-Tsang gamma(shape >= 1 after boost). */
function gamma(shape, rng) {
  if (shape < 1) return gamma(shape + 1, rng) * rng() ** (1 / shape);
  const d = shape - 1 / 3; const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x; let v;
    do { x = normal(rng); v = 1 + c * x; } while (v <= 0);
    v = v * v * v; const u = rng();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
export const betaDraw = (a, b, rng) => { const x = gamma(a, rng); return x / (x + gamma(b, rng)); };

/** Posterior per arm of one dimension and P(arm has the best draw). videos carry `reward` and `choices`. */
export function thompson(videos, dim, cfg, rng) {
  const prior = cfg.bandit.prior;
  const stats = Object.fromEntries(dim.arms.map((a) => [a, { n: 0, sum: 0 }]));
  for (const v of videos) { const a = v.choices[dim.id]; if (a && stats[a]) { stats[a].n += 1; stats[a].sum += v.reward; } }
  const post = dim.arms.map((a) => ({ arm: a, alpha: prior + stats[a].sum, beta: prior + stats[a].n - stats[a].sum }));
  const wins = Object.fromEntries(dim.arms.map((a) => [a, 0]));
  for (let i = 0; i < cfg.bandit.draws; i++) {
    let best = null; let bv = -1;
    for (const p of post) { const x = betaDraw(p.alpha, p.beta, rng); if (x > bv) { bv = x; best = p.arm; } }
    wins[best] += 1;
  }
  return Object.fromEntries(post.map((p) => [p.arm, {
    n: stats[p.arm].n, meanReward: stats[p.arm].n ? r4(stats[p.arm].sum / stats[p.arm].n) : null,
    alpha: r4(p.alpha), beta: r4(p.beta), winProb: r4(wins[p.arm] / cfg.bandit.draws),
  }]));
}

// ---------------------------------------------------------------- limits

/**
 * The shares closest to `target` (same shift for every arm, clipped) that keep every arm >= minShare AND move no arm by
 * more than maxStepPoints from `cur`, adding up to 1. Pure. Both limits hold together or nothing changes: when they
 * cannot (e.g. an arm below the floor by more than one step), the result is null and the caller keeps `cur`.
 */
export function limitShares(cur, target, { minShare, maxStepPoints }) {
  const arms = Object.keys(cur);
  const step = maxStepPoints / 100;
  const top = 1 - minShare * (arms.length - 1);
  const lo = {}; const hi = {};
  for (const a of arms) {
    lo[a] = Math.max(minShare, cur[a] - step);
    hi[a] = Math.min(top, cur[a] + step);
    if (lo[a] > hi[a] + 1e-12) return null;
  }
  if (arms.reduce((s, a) => s + lo[a], 0) > 1 + 1e-9 || arms.reduce((s, a) => s + hi[a], 0) < 1 - 1e-9) return null;
  const at = (a, l) => Math.min(hi[a], Math.max(lo[a], (target[a] ?? 0) + l));
  const sumAt = (l) => arms.reduce((s, a) => s + at(a, l), 0);
  let a0 = -2; let b0 = 2;
  for (let i = 0; i < 200; i++) { const m = (a0 + b0) / 2; if (sumAt(m) < 1) a0 = m; else b0 = m; }
  const l = (a0 + b0) / 2;
  // 6 decimals, never outside an arm's bounds; the rounding residue goes to an arm with room for it
  const out = Object.fromEntries(arms.map((a) => [a, Math.min(hi[a], Math.max(lo[a], Math.round(at(a, l) * 1e6) / 1e6))]));
  const res = 1 - arms.reduce((s, a) => s + out[a], 0);
  if (Math.abs(res) > 1e-12) {
    const fit = arms.filter((a) => (res > 0 ? out[a] + res <= hi[a] + 1e-12 : out[a] + res >= lo[a] - 1e-12)).sort((x, y) => out[y] - out[x])[0];
    if (fit) out[fit] += res;
  }
  const ok = arms.every((a) => out[a] >= lo[a] - 1e-9 && out[a] <= hi[a] + 1e-9) && Math.abs(arms.reduce((s, a) => s + out[a], 0) - 1) < 1e-9;
  return ok ? out : null;
}

// ---------------------------------------------------------------- state and log files

const dirOf = (dataDir) => path.join(dataDir, MIX_DIR);
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

function writeJsonAtomic(file, obj) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try { writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8'); renameSync(tmp, file); } catch (e) { try { unlinkSync(tmp); } catch { /* best effort */ } throw e; }
}

function validShares(shares, cfg) {
  if (!isPlain(shares)) return false;
  return cfg.dimensions.every((d) => isPlain(shares[d.id]) && d.arms.every((a) => num(shares[d.id][a]) !== null && shares[d.id][a] >= 0)
    && Math.abs(d.arms.reduce((s, a) => s + shares[d.id][a], 0) - 1) < 1e-3);
}

/** The mix in effect. No file, or a bad one: today's defaults, applied false. */
export function readMix(dataDir, cfg) {
  const j = readJson(path.join(dirOf(dataDir), MIX_FILE));
  if (isPlain(j) && j.version === 1 && typeof j.applied === 'boolean' && validShares(j.shares, cfg)) {
    return { applied: j.applied, shares: j.shares, changedAt: j.changedAt ?? null, lastEntry: isPlain(j.lastEntry) ? j.lastEntry : null };
  }
  return { applied: false, shares: defaultShares(cfg), changedAt: null, lastEntry: null };
}

/** Only the tail of the log is read (show, cooldown and undo need the newest entries only). */
export const LOG_TAIL_BYTES = 64 * 1024;

function readLogFile(dataDir, tailBytes) {
  const file = path.join(dirOf(dataDir), LOG_FILE);
  let text = '';
  let fd = null;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - tailBytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1); // the first line may be cut by the window
  } catch { text = ''; } finally { if (fd !== null) closeSync(fd); }
  const lines = text.split('\n');
  lines.pop(); // '' after the last newline, or an incomplete record with no newline after it
  return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(isPlain);
}

const stateEntry = (dataDir) => {
  const e = readJson(path.join(dirOf(dataDir), MIX_FILE))?.lastEntry;
  return isPlain(e) && typeof e.id === 'string' ? e : null;
};

/** The newest complete log entries (at most LOG_TAIL_BYTES of the file). A record cut off by a failed append and a line
 *  cut by the tail window are dropped. The state file's last entry is added when the log missed it (a failed append
 *  after the state was written), so log and state always agree. */
export function readLog(dataDir, { tailBytes = LOG_TAIL_BYTES } = {}) {
  const log = readLogFile(dataDir, tailBytes);
  const last = stateEntry(dataDir);
  if (last && !log.some((e) => e.id === last.id)) log.push(last);
  return log;
}

function append(dataDir, entry) {
  const file = path.join(dirOf(dataDir), LOG_FILE);
  mkdirSync(path.dirname(file), { recursive: true });
  let lead = '';
  let fd = null;
  try { // a record cut off by an earlier failed append must not swallow this one
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    if (size > 0) { const b = Buffer.alloc(1); readSync(fd, b, 0, 1, size - 1); if (b[0] !== 0x0a) lead = '\n'; }
  } catch { lead = ''; } finally { if (fd !== null) closeSync(fd); }
  appendFileSync(file, `${lead}${JSON.stringify(entry)}\n`, 'utf8');
}

/** Appends the state file's last entry when the log file does not hold it (repair after a failed append). */
function repairLog(dataDir) {
  const last = stateEntry(dataDir);
  if (last && !readLogFile(dataDir, LOG_TAIL_BYTES).some((e) => e.id === last.id)) append(dataDir, last);
}

/** State first (atomic temp + rename), then the log line. The state carries the entry, so a failed append is repaired on
 *  the next step or undo (and read back meanwhile); a failed state write throws before anything is logged, so there is
 *  never a logged-but-unapplied change and a failed undo uses up no undo history. */
function commit(dataDir, m, entry) {
  writeJsonAtomic(path.join(dirOf(dataDir), MIX_FILE), { version: 1, applied: m.applied, shares: m.shares, changedAt: m.changedAt, lastEntry: entry });
  try { append(dataDir, entry); } catch { /* repaired from the state's lastEntry */ }
}

/** The kind shares the auto-post rules use: only while applied (cold start and undone-to-start give null). */
export function appliedKindShares(dataDir, cfg = loadConfig()) {
  const m = readMix(dataDir, cfg);
  return m.applied ? { ...m.shares.kind } : null;
}

// ---------------------------------------------------------------- reading the numbers

async function defaultInputs(dataDir) {
  const { openStore, summary, DB_NAME } = await import('../analytics/index.mjs');
  const { createPostStore, LEDGER_NAME } = await import('../posting/index.mjs');
  const dbFile = path.join(dataDir, DB_NAME);
  let rows = [];
  if (existsSync(dbFile)) { const store = openStore(dbFile); try { rows = summary(store); } finally { store.close(); } }
  let posts = [];
  try { posts = createPostStore({ ledgerFile: path.join(dataDir, 'posting', LEDGER_NAME), dataDir }).list(); } catch { posts = []; }
  return { rows, posts };
}

/** Rewards and posteriors without writing anything. -> { videos, cold, reason, numbers, targets } */
export function analyse({ rows, posts, cfg, seed = 1, hourOf }) {
  const videos = rewards(linkVideos({ rows, posts, cfg, hourOf }), cfg);
  const min = cfg.coldStart.minVideos;
  if (videos.length < min) {
    return { videos, cold: true, reason: `${videos.length} of ${min} posted videos have their 24 hour numbers; the mix stays at today's settings until ${min} do`, numbers: null, targets: null };
  }
  const rng = seededRng(seed);
  const numbers = {}; const targets = {}; const skipped = {};
  for (const d of cfg.dimensions) {
    const known = videos.filter((v) => v.choices[d.id]).length;
    numbers[d.id] = thompson(videos, d, cfg, rng);
    if (known < cfg.coldStart.minPerDimension) { skipped[d.id] = `${known} of ${cfg.coldStart.minPerDimension} videos with a known ${d.label.toLowerCase()}`; continue; }
    targets[d.id] = Object.fromEntries(d.arms.map((a) => [a, numbers[d.id][a].winProb]));
  }
  return { videos, cold: false, reason: null, numbers, targets, skipped };
}

const weekSeed = (now) => `mix-${Math.floor(now / (7 * DAY))}`;

/**
 * The weekly change. At most once per limits.periodDays (counted from the last change, undo does not reset it).
 * Cold start: nothing changes, nothing is written, the reason is returned. Otherwise the new shares (inside the limits)
 * are written, applied becomes true, and one log line holds the shares before and after and the numbers behind them.
 */
export async function step({ dataDir, cfg = loadConfig(), rows, posts, now = Date.now(), seed, hourOf } = {}) {
  const t = typeof now === 'function' ? now() : now;
  repairLog(dataDir);
  const log = readLog(dataDir);
  const last = [...log].reverse().find((e) => e.action === 'change');
  if (last && t - Date.parse(last.at) < cfg.limits.periodDays * DAY) {
    return { changed: false, reason: 'too-soon', nextAt: new Date(Date.parse(last.at) + cfg.limits.periodDays * DAY).toISOString() };
  }
  const inputs = rows && posts ? { rows, posts } : await defaultInputs(dataDir);
  const a = analyse({ ...inputs, cfg, seed: seed ?? weekSeed(t), hourOf });
  if (a.cold) return { changed: false, reason: 'cold-start', detail: a.reason, videos: a.videos.length };
  const cur = readMix(dataDir, cfg);
  const shares = {}; const kept = { ...(a.skipped ?? {}) };
  for (const d of cfg.dimensions) {
    const lim = a.targets[d.id] ? limitShares(cur.shares[d.id], a.targets[d.id], cfg.limits) : null;
    if (a.targets[d.id] && !lim) kept[d.id] = 'the floor and the weekly cap cannot both hold; kept as it was';
    shares[d.id] = lim ?? { ...cur.shares[d.id] };
  }
  const at = new Date(t).toISOString();
  const entry = {
    v: 1, id: `c-${at}`, at, action: 'change',
    from: { applied: cur.applied, shares: cur.shares, changedAt: cur.changedAt }, to: { applied: true, shares, changedAt: at },
    videos: a.videos.length, numbers: a.numbers, targets: a.targets, kept,
    formula: cfg.reward.formula, limits: { minShare: cfg.limits.minShare, maxStepPoints: cfg.limits.maxStepPoints, periodDays: cfg.limits.periodDays },
    configVersion: cfg.version,
  };
  commit(dataDir, { applied: true, shares, changedAt: at }, entry);
  return { changed: true, reason: 'changed', entry };
}

/** One call undoes the newest change still in effect: the mix goes back to what it was before that change. */
export function undo({ dataDir, cfg = loadConfig(), now = Date.now() } = {}) {
  repairLog(dataDir);
  const log = readLog(dataDir);
  const undone = new Set(log.filter((e) => e.action === 'undo').map((e) => e.undoes));
  const target = [...log].reverse().find((e) => e.action === 'change' && !undone.has(e.id));
  if (!target) return { undone: false, reason: 'nothing-to-undo' };
  const t = typeof now === 'function' ? now() : now;
  const at = new Date(t).toISOString();
  const cur = readMix(dataDir, cfg);
  // back to the mix before the change, with its own changedAt: the planner's seeded picks are the same as before it
  const back = {
    applied: target.from?.applied === true,
    shares: validShares(target.from?.shares, cfg) ? target.from.shares : defaultShares(cfg),
    changedAt: typeof target.from?.changedAt === 'string' ? target.from.changedAt : null,
  };
  const entry = { v: 1, id: `u-${at}-${target.id}`, at, action: 'undo', undoes: target.id, from: { applied: cur.applied, shares: cur.shares, changedAt: cur.changedAt }, to: back };
  commit(dataDir, back, entry);
  return { undone: true, entry };
}

/** What the Growth window shows: the mix in effect, why it is (not) applied, the latest numbers and the change log. */
export async function view({ dataDir, cfg = loadConfig(), rows, posts, now = Date.now(), hourOf } = {}) {
  const t = typeof now === 'function' ? now() : now;
  const mix = readMix(dataDir, cfg);
  const log = readLog(dataDir);
  const inputs = rows && posts ? { rows, posts } : await defaultInputs(dataDir);
  const a = analyse({ ...inputs, cfg, seed: weekSeed(t), hourOf });
  const undone = new Set(log.filter((e) => e.action === 'undo').map((e) => e.undoes));
  const lastChange = [...log].reverse().find((e) => e.action === 'change');
  return {
    applied: mix.applied, shares: mix.shares, changedAt: mix.changedAt,
    status: a.cold ? 'cold-start' : mix.applied ? 'learning' : 'waiting-for-weekly-change',
    reason: a.cold ? a.reason : null,
    videos: a.videos.length, minVideos: cfg.coldStart.minVideos,
    numbers: a.numbers, kept: a.skipped ?? null,
    nextChangeAt: lastChange ? new Date(Date.parse(lastChange.at) + cfg.limits.periodDays * DAY).toISOString() : null,
    canUndo: log.some((e) => e.action === 'change' && !undone.has(e.id)),
    limits: cfg.limits, formula: cfg.reward.formula,
    dimensions: cfg.dimensions.map((d) => ({ id: d.id, label: d.label, arms: d.arms, applies: d.applies })),
    log: log.slice(-20).map((e) => ({ id: e.id, at: e.at, action: e.action, undoes: e.undoes ?? null, from: e.from, to: e.to, videos: e.videos ?? null, numbers: e.numbers ?? null })),
  };
}

// ---------------------------------------------------------------- weekly report (plain English)

const pct = (x) => `${Math.round(x * 100)} %`;

export function weeklyReport(v, cfg = loadConfig()) {
  const lines = [];
  lines.push('Self-learning weekly report');
  if (v.status === 'cold-start') {
    lines.push(`Not enough results yet: ${v.reason}.`);
    lines.push('Nothing was changed. Reels and posts are made exactly as before.');
    return lines.join('\n');
  }
  lines.push(`Based on ${v.videos} posted video(s) with numbers. Score per video = ${cfg.reward.formula} (0 to 1).`);
  const last = [...(v.log ?? [])].reverse().find((e) => e.action === 'change' || e.action === 'undo');
  for (const d of cfg.dimensions) {
    const nb = v.numbers?.[d.id];
    const now = v.shares[d.id];
    const before = last?.action === 'change' ? last.from?.shares?.[d.id] : null;
    const parts = d.arms.map((a) => {
      const n = nb?.[a];
      const moved = before ? ` (was ${pct(before[a])})` : '';
      return `${a} ${pct(now[a])}${moved}${n ? `, ${n.n} video(s)${n.meanReward !== null ? `, average score ${n.meanReward.toFixed(2)}` : ''}` : ''}`;
    });
    lines.push(`${d.label}: ${parts.join('; ')}.${v.kept?.[d.id] ? ` Kept as it was: only ${v.kept[d.id]}.` : ''}${d.id === 'hour' ? ' (Shown only; the posting schedule is not changed.)' : ''}`);
  }
  if (last?.action === 'undo') lines.push(`The last change was undone on ${last.at.slice(0, 10)}.`);
  else if (last) lines.push(`Last change: ${last.at.slice(0, 10)}. It can be undone with one click (or: node services/learning/mix-cli.mjs undo).`);
  else lines.push('No change made yet; the first one comes with the next weekly check.');
  lines.push(`Limits: every choice keeps at least ${pct(cfg.limits.minShare)}, a share moves at most ${cfg.limits.maxStepPoints} points a week. Kill rules, detector weights, privacy and posting targets are never changed.`);
  if (!v.applied) lines.push('The mix is not in use now, so reels and posts are made as before.');
  return lines.join('\n');
}
