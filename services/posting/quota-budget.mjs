// SPDX-License-Identifier: GPL-3.0-or-later
// D375 daily YouTube budget (Codex review 2026-11-13). Two persisted counters in <data>/posting/quota-day.json:
//   uploads: upload attempts in the current UTC day (every upload start or resume counts), checked against the rules'
//            maxUploadsPerDay; the approvals cap (planAuto) uses the same UTC day.
//   units:   quota units used in the current Pacific day (Google resets the quota at midnight Pacific time): an upload
//            attempt counts insert + thumbnail units (quota.json), every API read (schedule reads, status checks for the
//            delete) 1 unit. Checked against quotaUnitsPerDay (quota.json, or the user's own schedule settings).
// Fail closed: a bad quota file or an unreadable counter file blocks uploads and reads; a counter file from another day
// starts that counter at 0. Writes are atomic (tmp + rename). Two processes (chain and studio server) may both count:
// each write re-reads the file first, so at most one count can be lost in a race, never the file.
//   loadQuota(dataDir, file?)                      -> { quotaUnitsPerDay, perUploadUnits, readReserveUnits, uploadsPerDayFit, userSet }
//   createQuotaBudget({ dataDir, nowMs?, quota? }) -> { state(), uploadBlock(maxPerDay), chargeUpload(), readBlock(units),
//                                                        chargeRead(units), meter(fetchImpl) }
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_PER_DAY } from './auto-post.mjs';
import { checkUserSchedule, userScheduleFile } from './schedule.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_QUOTA = path.join(REPO, 'data', 'posting', 'quota.json');
export const QUOTA_DAY_NAME = 'quota-day.json';
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

/**
 * The quota numbers (data/posting/quota.json, quotaUnitsPerDay from the user's schedule settings when set) and how many
 * uploads a day fit: floor((quota - read reserve) / (insert + thumbnail)). 0 when not even one fits: then nothing
 * uploads until the quota is raised. Throws when the data file is bad.
 */
export function loadQuota(dataDir, file = DEFAULT_QUOTA) {
  const j = readJson(file);
  const n = (k) => { const v = j?.[k]; if (!Number.isFinite(v) || v < 0) throw new Error(`quota setting ${k} is not valid`); return v; };
  const own = typeof dataDir === 'string' ? readJson(userScheduleFile(dataDir)) : null;
  const user = isPlain(own) ? checkUserSchedule(own).values : {};
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

export function createQuotaBudget({ dataDir, nowMs = () => Date.now(), quota = null }) {
  const file = path.join(dataDir, 'posting', QUOTA_DAY_NAME);
  const getQuota = quota ?? (() => loadQuota(dataDir));
  const count = (c, day) => (isPlain(c) && c.day === day && Number.isInteger(c.n) && c.n >= 0 ? c.n : 0);
  /** Today's counters. Throws when the file exists but cannot be read as a counter file (fail closed). */
  function state() {
    const t = nowMs(); const u = utcDay(t); const p = pacificDay(t);
    let raw = null;
    try { raw = readFileSync(file, 'utf8'); } catch (e) { if (e?.code !== 'ENOENT') throw e; }
    const j = raw === null ? {} : JSON.parse(raw);
    if (!isPlain(j)) throw new Error('quota counter file is not valid');
    return { uploads: { day: u, n: count(j.uploads, u) }, units: { day: p, n: count(j.units, p) } };
  }
  function add(uploads, units) {
    const s = state();
    s.uploads.n += uploads; s.units.n += units;
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(s)}\n`);
    renameSync(tmp, file);
    return s;
  }
  const safe = (fn) => { try { return fn(); } catch { return 'quota-unreadable'; } };
  const budget = {
    file,
    state,
    /** null (an upload may start) or why not: 'daily-cap-reached' | 'quota-day-used' | 'quota-unreadable'. */
    uploadBlock: (maxPerDay = null) => safe(() => {
      const q = getQuota(); const s = state();
      if (Number.isInteger(maxPerDay) && s.uploads.n >= maxPerDay) return 'daily-cap-reached';
      if (s.units.n + q.perUploadUnits > q.quotaUnitsPerDay) return 'quota-day-used';
      return null;
    }),
    chargeUpload() { return add(1, getQuota().perUploadUnits); },
    /** null (reads of `units` fit today) or 'quota-day-used' | 'quota-unreadable'. */
    readBlock: (units = 1) => safe(() => (state().units.n + units > getQuota().quotaUnitsPerDay ? 'quota-day-used' : null)),
    chargeRead(units = 1) { return add(0, units); },
    /** fetch that counts every API read (1 unit) before it is sent; anything else passes through uncounted. */
    meter: (fetchImpl) => async (url, init) => {
      if (isApiRead(url, init)) budget.chargeRead(1);
      return fetchImpl(url, init);
    },
  };
  return budget;
}
