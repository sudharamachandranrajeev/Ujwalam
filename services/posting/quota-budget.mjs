// SPDX-License-Identifier: GPL-3.0-or-later
// D375 daily YouTube budget (Codex reviews 2026-11-13). Two persisted counters in <data>/posting/quota-day.json:
//   uploads: upload attempts in the current UTC day (every upload start or resume counts), checked against the rules'
//            maxUploadsPerDay; the approvals cap (planAuto) uses the same UTC day.
//   units:   quota units used in the current Pacific day (Google resets the quota at midnight Pacific time): an upload
//            attempt counts insert + thumbnail units (quota.json), every API read (schedule reads, status checks for the
//            delete) 1 unit.
// Admission: an upload may start only while units + one upload <= quotaUnitsPerDay - readReserveUnits (the same sum as
// the "uploads a day fit" number, so a fit of 0 never uploads); reads may use the whole quota.
// Every check and its charge happen in ONE step under an exclusive lock file (<file>.lock, created with 'wx'), so the
// chain and the studio server never lose a charge or both pass the same last slot. A lock older than LOCK_STALE_MS is
// taken over (its holder died); a lock that stays busy for LOCK_WAIT_MS blocks (fail closed).
// Reads are reserved BEFORE they are sent: meter() reserves 1 unit per request; reserveScan() reserves a whole schedule
// read up front and gives back what it did not use.
// Fail closed: a bad quota file, an unreadable or invalid user schedule file, and a counter file that is not exactly
// the expected shape (both counters, a YYYY-MM-DD day, a whole n >= 0) block uploads and reads. Only a valid counter
// from another day starts again at 0; a missing counter file is the first day.
//   loadQuota(dataDir, file?) -> { quotaUnitsPerDay, perUploadUnits, readReserveUnits, uploadsPerDayFit, userSet }
//   createQuotaBudget({ dataDir, nowMs?, quota? }) -> { state(), uploadBlock(maxPerDay), reserveUpload(maxPerDay),
//     readBlock(units), reserveRead(units), refundRead(units), reserveScan(units, fetchImpl), meter(fetchImpl),
//     chargeUpload(), chargeRead(units) }
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_PER_DAY } from './auto-post.mjs';
import { checkUserSchedule, userScheduleFile } from './schedule.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_QUOTA = path.join(REPO, 'data', 'posting', 'quota.json');
export const QUOTA_DAY_NAME = 'quota-day.json';
export const LOCK_STALE_MS = 30 * 1000;
export const LOCK_WAIT_MS = 3 * 1000;
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

export class QuotaError extends Error {
  constructor(code, message) { super(message ?? code); this.name = 'QuotaError'; this.code = code; }
}

/** The user's own quota (schedule settings file): absent = none (shipped value); unreadable or invalid = throws. */
function userQuota(dataDir) {
  if (typeof dataDir !== 'string') return {};
  let raw;
  try { raw = readFileSync(userScheduleFile(dataDir), 'utf8'); } catch (e) {
    if (e?.code === 'ENOENT') return {};
    throw new QuotaError('quota-unreadable', 'your schedule settings file could not be read');
  }
  let j;
  try { j = JSON.parse(raw); } catch { throw new QuotaError('quota-unreadable', 'your schedule settings file is not valid JSON'); }
  if (!isPlain(j)) throw new QuotaError('quota-unreadable', 'your schedule settings file is not an object');
  const c = checkUserSchedule(j);
  if (c.problems.length) throw new QuotaError('quota-unreadable', `your schedule settings are not valid: ${c.problems.map((p) => p.text).join('; ')}`);
  return c.values;
}

/**
 * The quota numbers (data/posting/quota.json, quotaUnitsPerDay from the user's schedule settings when set) and how many
 * uploads a day fit: floor((quota - read reserve) / (insert + thumbnail)). 0 when not even one fits: then nothing
 * uploads until the quota is raised. Throws when the data file or an existing user settings file is bad.
 */
export function loadQuota(dataDir, file = DEFAULT_QUOTA) {
  const j = readJson(file);
  const n = (k) => { const v = j?.[k]; if (!Number.isFinite(v) || v < 0) throw new QuotaError('quota-unreadable', `quota setting ${k} is not valid`); return v; };
  const user = userQuota(dataDir);
  const quota = user.quotaUnitsPerDay ?? n('quotaUnitsPerDay');
  const perUpload = n('insertUnits') + n('thumbnailUnits');
  const reserve = n('readReserveUnits');
  const fit = Math.max(0, perUpload > 0 ? Math.floor((quota - reserve) / perUpload) : MAX_PER_DAY);
  return { quotaUnitsPerDay: quota, perUploadUnits: perUpload, readReserveUnits: reserve, uploadsPerDayFit: Math.min(fit, MAX_PER_DAY), userSet: user.quotaUnitsPerDay !== undefined };
}

export const utcDay = (t) => new Date(t).toISOString().slice(0, 10);
/** YYYY-MM-DD in Pacific time (the YouTube quota day); UTC if the runtime has no time zone data. */
export function pacificDay(t) {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}`;
  } catch { return utcDay(t); }
}

/** A YouTube Data API read (GET on /youtube/v3/, not an upload URL): 1 quota unit. */
export const isApiRead = (url, init) => {
  const u = String(url);
  return /^https:\/\/www\.googleapis\.com\/youtube\/v3\//.test(u) && String(init?.method ?? 'GET').toUpperCase() === 'GET';
};

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const validCounter = (c) => isPlain(c) && typeof c.day === 'string' && DAY_RE.test(c.day) && Number.isSafeInteger(c.n) && c.n >= 0;

/** Parses a counter file's text. Throws QuotaError('quota-unreadable') unless it is exactly the expected shape. */
export function parseCounters(raw, { utc, pacific }) {
  let j;
  try { j = JSON.parse(raw); } catch { throw new QuotaError('quota-unreadable', 'the quota counter file is not valid JSON'); }
  if (!isPlain(j) || !validCounter(j.uploads) || !validCounter(j.units)) throw new QuotaError('quota-unreadable', 'the quota counter file is not valid');
  return { uploads: { day: utc, n: j.uploads.day === utc ? j.uploads.n : 0 }, units: { day: pacific, n: j.units.day === pacific ? j.units.n : 0 } };
}

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const BUSY = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY']);

export function createQuotaBudget({ dataDir, nowMs = () => Date.now(), quota = null, lockWaitMs = LOCK_WAIT_MS, lockStaleMs = LOCK_STALE_MS }) {
  const file = path.join(dataDir, 'posting', QUOTA_DAY_NAME);
  const lockFile = `${file}.lock`;
  const getQuota = quota ?? (() => loadQuota(dataDir));

  /** Today's counters. Throws QuotaError when the file exists but is not a valid counter file (fail closed). */
  function state() {
    const t = nowMs(); const days = { utc: utcDay(t), pacific: pacificDay(t) };
    let raw;
    for (let n = 0; raw === undefined; n++) {
      try { raw = readFileSync(file, 'utf8'); } catch (e) {
        if (e?.code === 'ENOENT') return { uploads: { day: days.utc, n: 0 }, units: { day: days.pacific, n: 0 } };
        // Windows: the file is being replaced this moment (EPERM/EBUSY); read again briefly.
        if (!BUSY.has(e?.code) || n >= 100) throw new QuotaError('quota-unreadable', 'the quota counter file could not be read');
        pause(5);
      }
    }
    return parseCounters(raw, days);
  }

  /** Runs fn() holding the lock file (real wall clock for the lock times, never the test clock). */
  function locked(fn) {
    mkdirSync(path.dirname(file), { recursive: true });
    const until = Date.now() + lockWaitMs;
    for (;;) {
      let fd = null;
      // EPERM/EACCES/EBUSY on Windows: the previous lock is still being deleted (delete pending) or briefly open in
      // another process; that is "busy", not an error.
      try { fd = openSync(lockFile, 'wx'); } catch (e) { if (!BUSY.has(e?.code)) throw new QuotaError('quota-unreadable', 'the quota lock could not be made'); }
      if (fd !== null) {
        try { writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`); } finally { closeSync(fd); }
        try { return fn(); } finally { try { unlinkSync(lockFile); } catch { /* already taken over as stale */ } }
      }
      // Busy: take over a stale lock (its holder died). It is renamed away first, so only one taker wins; a lock that
      // turns out fresh after the rename is put back.
      try {
        if (Date.now() - statSync(lockFile).mtimeMs > lockStaleMs) {
          const aside = `${lockFile}.${process.pid}.${Date.now()}.stale`;
          renameSync(lockFile, aside);
          if (Date.now() - statSync(aside).mtimeMs > lockStaleMs) unlinkSync(aside); else renameSync(aside, lockFile);
          continue;
        }
      } catch { /* the lock went away meanwhile: try again */ }
      if (Date.now() >= until) throw new QuotaError('quota-busy', 'the quota counter stayed locked');
      pause(5);
    }
  }
  function write(s) {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(s)}\n`);
    // A reader without the lock (uploadBlock/readBlock) may have the file open for a moment: Windows then refuses the
    // replace (EPERM); it is tried again briefly (still under the lock).
    for (let n = 0; ; n++) {
      try { renameSync(tmp, file); return; } catch (e) { if (!BUSY.has(e?.code) || n >= 200) throw e; pause(5); }
    }
  }
  /** One locked step: read, decide, write. decide(s, q) -> reason (nothing written) | null (s is written). */
  const step = (decide) => {
    try {
      return locked(() => {
        const q = getQuota(); const s = state();
        const why = decide(s, q);
        if (!why) write(s);
        return why;
      });
    } catch (e) { return e instanceof QuotaError && e.code === 'quota-busy' ? 'quota-busy' : 'quota-unreadable'; }
  };
  const uploadWhy = (s, q, maxPerDay) => {
    if (Number.isInteger(maxPerDay) && s.uploads.n >= maxPerDay) return 'daily-cap-reached';
    if (s.units.n + q.perUploadUnits > q.quotaUnitsPerDay - q.readReserveUnits) return 'quota-day-used';
    return null;
  };
  const readWhy = (s, q, units) => (s.units.n + units > q.quotaUnitsPerDay ? 'quota-day-used' : null);
  const peek = (fn) => { try { return fn(getQuota(), state()); } catch { return 'quota-unreadable'; } };
  const refuse = (why) => { throw Object.assign(new Error(why), { code: why }); };

  const budget = {
    file,
    state,
    /** Read-only check: null (an upload could start now) or why not. Nothing is charged. */
    uploadBlock: (maxPerDay = null) => peek((q, s) => uploadWhy(s, q, maxPerDay)),
    /** Check and charge one upload attempt in one locked step: null (charged, go) or why not (nothing charged). */
    reserveUpload: (maxPerDay = null) => step((s, q) => uploadWhy(s, q, maxPerDay) ?? (s.uploads.n += 1, s.units.n += q.perUploadUnits, null)),
    /** Read-only check for `units` of reads. */
    readBlock: (units = 1) => peek((q, s) => readWhy(s, q, units)),
    /** Check and charge `units` of reads in one locked step: null (charged) or why not (nothing charged). */
    reserveRead: (units = 1) => step((s, q) => readWhy(s, q, units) ?? (s.units.n += units, null)),
    /** Gives back reserved read units that were not used (never below 0). */
    refundRead: (units) => (units > 0 ? step((s) => { s.units.n = Math.max(0, s.units.n - units); return null; }) : null),
    /** fetch that reserves 1 unit before each Data API read is sent; refused (rejects, nothing sent) over budget. */
    meter: (fetchImpl) => async (url, init) => {
      if (isApiRead(url, init)) { const why = budget.reserveRead(1); if (why) refuse(why); }
      return fetchImpl(url, init);
    },
    /** Reserves `units` up front for one multi-call read. -> { fetch, done() }: fetch spends the reservation (refuses
     *  past it, nothing sent); done() gives back what was not used. Throws (code = reason) when it does not fit. */
    reserveScan(units, fetchImpl) {
      const why = budget.reserveRead(units);
      if (why) refuse(why);
      let left = units; let closed = false;
      return {
        fetch: async (url, init) => {
          if (isApiRead(url, init)) { if (closed || left <= 0) refuse('quota-day-used'); left -= 1; }
          return fetchImpl(url, init);
        },
        done() { if (!closed) { closed = true; budget.refundRead(left); } },
      };
    },
    /** Unconditional charges (tests and repairs); locked. Throw on an unreadable counter. */
    chargeUpload() { const why = step((s, q) => { s.uploads.n += 1; s.units.n += q.perUploadUnits; return null; }); if (why) refuse(why); },
    chargeRead(units = 1) { const why = step((s) => { s.units.n += units; return null; }); if (why) refuse(why); },
  };
  return budget;
}
