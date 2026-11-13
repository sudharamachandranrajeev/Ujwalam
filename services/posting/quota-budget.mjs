// SPDX-License-Identifier: GPL-3.0-or-later
// D375 daily YouTube budget (Codex reviews 2026-11-13). Counters in the SQLite file <data>/posting/quota-day.sqlite
// (node:sqlite, stdlib), one row per (kind, day):
//   uploads: upload attempts in a UTC day (every upload start or resume counts), checked against the rules'
//            maxUploadsPerDay; the approvals cap (planAuto) uses the same UTC day.
//   units:   quota units used in a Pacific day (Google resets the quota at midnight Pacific time): an upload attempt
//            counts insert + thumbnail units (quota.json), every API read (schedule reads, status checks for the
//            delete) 1 unit.
// Admission: an upload may start only while units + one upload <= quotaUnitsPerDay - readReserveUnits (the same sum as
// the "uploads a day fit" number, so a fit of 0 never uploads); reads may use the whole quota.
// Every check and its charge run in ONE transaction (BEGIN IMMEDIATE ... COMMIT, busy timeout BUSY_WAIT_MS), so the
// chain and the studio server never lose a charge or both pass the same last slot. SQLite's file lock is held by the OS
// and released when the holding process ends in any way (no stale lock file to take over). Every exception path rolls
// back and closes the connection. Busy past BUSY_WAIT_MS blocks ('quota-busy', fail closed).
// Reads are reserved BEFORE they are sent: meter() reserves 1 unit per request; reserveScan() reserves a whole schedule
// read up front on its Pacific day and gives back what it did not use TO THAT DAY; a request sent after midnight Pacific
// reserves 1 unit on the new day first.
// Fail closed: a bad quota file, an unreadable or invalid user schedule file, a database that cannot be opened, and any
// counter row that breaks the shape (CHECK constraints in the table, and the same check on every read) block uploads
// and reads. The old counter file quota-day.json (bb4b11c) is read once when the database is new: a valid one carries
// today's counts over; an invalid or unreadable one blocks until it is fixed or removed. It is left in place.
//   loadQuota(dataDir, file?) -> { quotaUnitsPerDay, perUploadUnits, readReserveUnits, uploadsPerDayFit, userSet }
//   createQuotaBudget({ dataDir, nowMs?, quota?, busyWaitMs? }) -> { state(), uploadBlock(maxPerDay),
//     reserveUpload(maxPerDay), readBlock(units), reserveRead(units), refundRead(units, day), reserveScan(units, fetchImpl),
//     meter(fetchImpl), chargeUpload(), chargeRead(units) }
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { MAX_PER_DAY } from './auto-post.mjs';
import { checkUserSchedule, userScheduleFile } from './schedule.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_QUOTA = path.join(REPO, 'data', 'posting', 'quota.json');
export const QUOTA_DAY_NAME = 'quota-day.sqlite';
export const LEGACY_DAY_NAME = 'quota-day.json';
export const BUSY_WAIT_MS = 3 * 1000;
/** Rows older than this many days are dropped (only today's rows count; a few days are kept for diagnosis). */
const KEEP_DAYS = 8;
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
const KINDS = new Set(['uploads', 'units']);
const validCounter = (c) => isPlain(c) && typeof c.day === 'string' && DAY_RE.test(c.day) && Number.isSafeInteger(c.n) && c.n >= 0;

/** Parses the OLD counter file's text (quota-day.json). Throws QuotaError('quota-unreadable') unless it is exactly the
 *  expected shape; a valid counter from another day counts 0. */
export function parseCounters(raw, { utc, pacific }) {
  let j;
  try { j = JSON.parse(raw); } catch { throw new QuotaError('quota-unreadable', 'the old quota counter file (quota-day.json) is not valid JSON'); }
  if (!isPlain(j) || !validCounter(j.uploads) || !validCounter(j.units)) throw new QuotaError('quota-unreadable', 'the old quota counter file (quota-day.json) is not valid');
  return { uploads: { day: utc, n: j.uploads.day === utc ? j.uploads.n : 0 }, units: { day: pacific, n: j.units.day === pacific ? j.units.n : 0 } };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS counter (
  kind TEXT NOT NULL CHECK (kind IN ('uploads', 'units')),
  day TEXT NOT NULL CHECK (length(day) = 10 AND day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  n INTEGER NOT NULL CHECK (n >= 0),
  PRIMARY KEY (kind, day)
) STRICT;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;`;

/** SQLite busy/locked (primary result codes 5 and 6, also inside extended codes). */
const isBusy = (e) => [5, 6].includes(Number(e?.errcode) & 0xff) || /database is locked|database table is locked/i.test(String(e?.message));
const asQuotaError = (e) => (e instanceof QuotaError ? e
  : isBusy(e) ? new QuotaError('quota-busy', 'the quota counter stayed locked')
  : new QuotaError('quota-unreadable', `the quota counter database could not be used: ${e?.message ?? e}`));

export function createQuotaBudget({ dataDir, nowMs = () => Date.now(), quota = null, busyWaitMs = BUSY_WAIT_MS }) {
  const file = path.join(dataDir, 'posting', QUOTA_DAY_NAME);
  const legacyFile = path.join(dataDir, 'posting', LEGACY_DAY_NAME);
  const getQuota = quota ?? (() => loadQuota(dataDir));

  /** Every counter row must have the table's shape (the CHECK constraints may be missing from a replaced file). */
  function checkRows(db) {
    for (const r of db.prepare('SELECT kind, day, n, typeof(n) AS t FROM counter').all()) {
      if (!KINDS.has(r.kind) || typeof r.day !== 'string' || !DAY_RE.test(r.day) || r.t !== 'integer' || !Number.isSafeInteger(r.n) || r.n < 0) {
        throw new QuotaError('quota-unreadable', 'the quota counter database has a row that is not valid');
      }
    }
  }
  const count = (db, kind, day) => db.prepare('SELECT n FROM counter WHERE kind = ? AND day = ?').get(kind, day)?.n ?? 0;
  const add = (db, kind, day, n) => {
    if (n > 0) db.prepare('INSERT INTO counter (kind, day, n) VALUES (?, ?, ?) ON CONFLICT (kind, day) DO UPDATE SET n = n + excluded.n').run(kind, day, n);
  };

  /** Once per database: carries a valid old quota-day.json over; an invalid or unreadable one throws (fail closed). */
  function migrateLegacy(db, days) {
    if (db.prepare("SELECT value FROM meta WHERE key = 'legacy-json'").get()) return;
    let raw = null;
    try { raw = readFileSync(legacyFile, 'utf8'); } catch (e) {
      if (e?.code !== 'ENOENT') throw new QuotaError('quota-unreadable', 'the old quota counter file (quota-day.json) could not be read');
    }
    if (raw !== null) {
      const old = parseCounters(raw, days);
      add(db, 'uploads', old.uploads.day, old.uploads.n);
      add(db, 'units', old.units.day, old.units.n);
    }
    db.prepare("INSERT INTO meta (key, value) VALUES ('legacy-json', ?)").run(raw === null ? 'none' : 'carried-over');
  }

  /**
   * Runs fn(db, days) inside BEGIN IMMEDIATE ... COMMIT on a fresh connection. Any throw (open, busy, schema, row check,
   * fn, commit) rolls back and closes, and comes out as a QuotaError ('quota-busy' or 'quota-unreadable').
   */
  function tx(fn) {
    let db = null;
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      db = new DatabaseSync(file, { timeout: busyWaitMs });
      db.exec('BEGIN IMMEDIATE');
      try {
        const t = nowMs(); const days = { utc: utcDay(t), pacific: pacificDay(t) };
        db.exec(SCHEMA);
        migrateLegacy(db, days);
        checkRows(db);
        db.prepare('DELETE FROM counter WHERE day < ?').run(utcDay(t - KEEP_DAYS * 86400000));
        const r = fn(db, days);
        db.exec('COMMIT');
        return r;
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* no transaction left (SQLite rolled it back itself) */ }
        throw e;
      }
    } catch (e) {
      throw asQuotaError(e);
    } finally {
      try { db?.close(); } catch { /* already closed */ }
    }
  }
  const snapshot = (db, d) => ({ uploads: { day: d.utc, n: count(db, 'uploads', d.utc) }, units: { day: d.pacific, n: count(db, 'units', d.pacific) } });

  /** Today's counters. Throws QuotaError when the database cannot be used or holds a row that is not valid. */
  const state = () => tx(snapshot);

  /** One transaction: getQuota, today's counters, decide(s, q) -> reason (nothing charged) | null (charge(db, d, q) runs). */
  const step = (decide, charge) => {
    try {
      return tx((db, d) => {
        const q = getQuota(); const s = snapshot(db, d);
        const why = decide(s, q);
        if (!why) charge(db, d, q);
        return why;
      });
    } catch (e) { return e.code === 'quota-busy' ? 'quota-busy' : 'quota-unreadable'; }
  };
  const uploadWhy = (s, q, maxPerDay) => {
    if (Number.isInteger(maxPerDay) && s.uploads.n >= maxPerDay) return 'daily-cap-reached';
    if (s.units.n + q.perUploadUnits > q.quotaUnitsPerDay - q.readReserveUnits) return 'quota-day-used';
    return null;
  };
  const readWhy = (s, q, units) => (s.units.n + units > q.quotaUnitsPerDay ? 'quota-day-used' : null);
  const peek = (decide) => step(decide, () => {});
  const refuse = (why) => { throw Object.assign(new Error(why), { code: why }); };
  const chargeUploadRow = (db, d, q) => { add(db, 'uploads', d.utc, 1); add(db, 'units', d.pacific, q.perUploadUnits); };
  /** Reserves `units` of reads on the current Pacific day. -> { why, day } (day = the day charged, null when refused). */
  const reserveReadOn = (units) => {
    let day = null;
    const why = step((s, q) => readWhy(s, q, units), (db, d) => { add(db, 'units', d.pacific, units); day = d.pacific; });
    return { why, day };
  };

  const budget = {
    file,
    state,
    /** Read-only check: null (an upload could start now) or why not. Nothing is charged. */
    uploadBlock: (maxPerDay = null) => peek((s, q) => uploadWhy(s, q, maxPerDay)),
    /** Check and charge one upload attempt in one transaction: null (charged, go) or why not (nothing charged). */
    reserveUpload: (maxPerDay = null) => step((s, q) => uploadWhy(s, q, maxPerDay), chargeUploadRow),
    /** Read-only check for `units` of reads. */
    readBlock: (units = 1) => peek((s, q) => readWhy(s, q, units)),
    /** Check and charge `units` of reads in one transaction: null (charged) or why not (nothing charged). */
    reserveRead: (units = 1) => reserveReadOn(units).why,
    /** Gives back `units` reserved on Pacific day `day` and not used: to that day only (never below 0). A missing or
     *  malformed day refunds nothing ('quota-unreadable'): an unbound refund could free units on the wrong day. */
    refundRead(units, day) {
      if (!(units > 0)) return null;
      if (typeof day !== 'string' || !DAY_RE.test(day)) return 'quota-unreadable';
      return step(() => null, (db) => {
        db.prepare("UPDATE counter SET n = max(0, n - ?) WHERE kind = 'units' AND day = ?").run(units, day);
      });
    },
    /** fetch that reserves 1 unit before each Data API read is sent; refused (rejects, nothing sent) over budget. */
    meter: (fetchImpl) => async (url, init) => {
      if (isApiRead(url, init)) { const why = budget.reserveRead(1); if (why) refuse(why); }
      return fetchImpl(url, init);
    },
    /** Reserves `units` up front on the current Pacific day for one multi-call read. -> { fetch, done() }: fetch spends
     *  the reservation (at most `units` reads; refuses past it, nothing sent). A read sent after midnight Pacific
     *  reserves 1 unit on the new day before it is sent. done() gives back the unused part to the reservation's day.
     *  Throws (code = reason) when it does not fit. */
    reserveScan(units, fetchImpl) {
      const r = reserveReadOn(units);
      if (r.why) refuse(r.why);
      const day = r.day;
      let calls = 0; let usedOnDay = 0; let closed = false;
      return {
        day,
        fetch: async (url, init) => {
          if (isApiRead(url, init)) {
            if (closed || calls >= units) refuse('quota-day-used');
            if (pacificDay(nowMs()) === day) usedOnDay += 1;
            else { const why = budget.reserveRead(1); if (why) refuse(why); }
            calls += 1;
          }
          return fetchImpl(url, init);
        },
        done() { if (!closed) { closed = true; budget.refundRead(units - usedOnDay, day); } },
      };
    },
    /** Unconditional charges (tests and repairs). Throw on an unusable counter database. */
    chargeUpload() { const why = step(() => null, chargeUploadRow); if (why) refuse(why); },
    chargeRead(units = 1) { const why = step(() => null, (db, d) => add(db, 'units', d.pacific, units)); if (why) refuse(why); },
  };
  return budget;
}
