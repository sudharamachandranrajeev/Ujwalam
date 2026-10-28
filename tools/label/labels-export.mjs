// SPDX-License-Identifier: GPL-2.0-or-later
// A6: build and validate a label file (data/labels/<sessionId>.json) from a labelling draft, check a
// draft before it is saved, and diff two label files. Stdlib only: the label server and the pre-commit
// hook (tools/git-hooks/private-scan.mjs) both use this file, so a commit needs no dev dependency.
// Label file checks: data/labels.schema.json (schema-lite.mjs), windowEndSec > windowStartSec, unique
// ids, times inside the session, the session id is in data/sessions.json, every reasonTag is an id in
// data/label-tags.json, and every event's detectorId and medal exist in the session's game pack.
// Error strings carry paths and keywords only, never values from the draft.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { validate } from './schema-lite.mjs';

const readJson = (...p) => JSON.parse(readFileSync(path.join(...p), 'utf8'));

export function loadSchema(repo) {
  return readJson(repo, 'data', 'labels.schema.json');
}

// Session ids from data/sessions.json (the committed session list).
export function loadSessionIds(file) {
  const d = JSON.parse(readFileSync(file, 'utf8'));
  return (Array.isArray(d.sessions) ? d.sessions : []).map((s) => s && s.id).filter((id) => typeof id === 'string');
}

// -> { gameId, detectors: Map(id -> {id, name, catalogue|null}), medals: Map(detectorId -> Set(medal text)),
//      entries: [{detectorId, name, medal?}] }
export function loadPackSummary(repo, gameId) {
  if (!/^[a-z][a-z0-9_]*$/.test(gameId)) throw new Error('bad game id');
  const dir = path.join(repo, 'data', 'games', gameId);
  const det = readJson(dir, 'detectors.json');
  const ev = readJson(dir, 'events.json');
  const cats = new Map(ev.catalogues.map((c) => [c.id, c.events]));
  const detectors = new Map();
  const medals = new Map();
  const entries = [];
  for (const d of det.detectors) {
    if (d.id === 'NAME') continue;
    detectors.set(d.id, { id: d.id, name: d.name, catalogue: d.catalogue || null });
    if (d.catalogue) {
      const list = cats.get(d.catalogue) || [];
      medals.set(d.id, new Set(list.map((m) => m.text)));
      for (const m of list) entries.push({ detectorId: d.id, name: `${d.name}: ${m.text}`, medal: m.text, medalClass: m.class });
    } else {
      entries.push({ detectorId: d.id, name: d.name });
    }
  }
  return { gameId, packVersion: det.version, detectors, medals, entries };
}

// Reason tag ids from data/label-tags.json (every id in its tag list, keep and reject alike).
export function loadTagIds(file) {
  const t = JSON.parse(readFileSync(file, 'utf8'));
  return new Set((Array.isArray(t.tags) ? t.tags : []).map((x) => x && x.id).filter((id) => typeof id === 'string'));
}

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
// Rounds finite numbers to 3 decimals. Any other value (missing, string, null) is kept as it is,
// so the validator refuses it instead of the export silently writing 0.
const round3 = (x) => (isNum(x) ? Math.round(x * 1000) / 1000 : x);
const dropUndefined = (o) => { for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]; return o; };
const objects = (a) => (Array.isArray(a) ? a : []).map((x) => (isObj(x) ? x : {}));
const timeKey = (x) => (isNum(x) ? x : Infinity);
// Stable sort by the given time fields; items with a missing time go last, in draft order.
function byTime(list, ...keys) {
  return list.map((x, i) => [x, i]).sort((a, b) => {
    for (const k of keys) { const d = timeKey(a[0][k]) - timeKey(b[0][k]); if (d) return d; }
    return a[1] - b[1];
  }).map((p) => p[0]);
}
const seq = (prefix, i) => `${prefix}-${String(i + 1).padStart(4, '0')}`;
const END_SLACK_SEC = 0.5;

// Draft -> label file object (not yet validated). Only renumbered ids, times, verdicts, ratings, tag ids
// and the <user> placeholder. Ids are renumbered here (l-0001..., e-0001..., in time order), so no
// draft id text reaches data/labels/. pass2 is the server's pass-2 record (tools/label/server.mjs),
// not a draft field. Nothing else in the draft is copied.
export function buildLabelFile(draft, sessionId, pass2 = null) {
  const out = { version: 1, sessionId, labels: [] };
  byTime(objects(draft.labels), 'windowStartSec', 'windowEndSec').forEach((l, i) => {
    const o = dropUndefined({
      id: seq('l', i),
      windowStartSec: round3(l.windowStartSec),
      windowEndSec: round3(l.windowEndSec),
      label: l.label,
      reasonTags: Array.isArray(l.reasonTags) ? [...l.reasonTags] : [],
      labeller: '<user>',
      createdAt: l.createdAt, // required by checkDraft; never made up here (R7: it would change the previewed hash)
    });
    if (l.label === 'keep' && l.rating !== undefined && l.rating !== null) o.rating = l.rating;
    out.labels.push(o);
  });
  if (pass2 && pass2.openedAt) {
    out.events = byTime(objects(draft.events), 'timeSec').map((e, i) => {
      const o = dropUndefined({ id: seq('e', i), detectorId: e.detectorId, timeSec: round3(e.timeSec), verdict: e.verdict });
      if (e.medal) o.medal = e.medal;
      return o;
    });
    out.highlightsEditedAfterSuggestions = Boolean(pass2.highlightsEditedAfter);
  }
  if (draft.timing !== undefined) {
    const t = isObj(draft.timing) ? draft.timing : {};
    out.timing = dropUndefined({ highlightPassSec: round3(t.highlightPassSec), eventPassSec: round3(t.eventPassSec) });
  }
  return out;
}

// -> array of error strings; empty = valid. ctx: { schema, pack, sessionIds, durationSec, tagIds }.
// pack is needed when the file has events (fail closed without it); durationSec is optional.
export function validateLabelFile(doc, ctx) {
  const { schema, pack, sessionIds, durationSec, tagIds } = ctx;
  const errs = validate(schema, doc);
  if (errs.length) return errs;
  if (sessionIds && !sessionIds.includes(doc.sessionId)) errs.push('/sessionId unknown-session');
  const seen = new Set();
  doc.labels.forEach((l, i) => {
    if (tagIds) l.reasonTags.forEach((t, j) => { if (!tagIds.has(t)) errs.push(`/labels/${i}/reasonTags/${j} not-in-tags`); });
    if (!(l.windowEndSec > l.windowStartSec)) errs.push(`/labels/${i} end-not-after-start`);
    if (durationSec !== undefined && l.windowEndSec > durationSec + END_SLACK_SEC) errs.push(`/labels/${i} beyond-session-end`);
    if (seen.has(l.id)) errs.push(`/labels/${i} duplicate-id`);
    seen.add(l.id);
  });
  if ((doc.events || []).length && !pack) errs.push('/events no-game-pack-for-session');
  (doc.events || []).forEach((e, i) => {
    if (seen.has(e.id)) errs.push(`/events/${i} duplicate-id`);
    seen.add(e.id);
    if (durationSec !== undefined && e.timeSec > durationSec + END_SLACK_SEC) errs.push(`/events/${i} beyond-session-end`);
    if (!pack) return;
    const d = pack.detectors.get(e.detectorId);
    if (!d) { errs.push(`/events/${i}/detectorId not-in-pack`); return; }
    if (e.medal !== undefined) {
      const set = pack.medals.get(e.detectorId);
      if (!set) errs.push(`/events/${i}/medal detector-has-no-catalogue`);
      else if (!set.has(e.medal)) errs.push(`/events/${i}/medal not-in-pack`);
    }
  });
  return errs;
}

// ---- draft check (PUT draft) ----
// A draft holds ids, times, enums, tag ids and pack terms only. Unknown fields (free text such as a
// note, OCR text or anything else) are refused, and so are invalid times: non-finite, negative,
// beyond the session, or a window whose end is not after its start. Never coerced to 0.
// version, game, savedAt and pass2 are what GET draft returned; the client may send them back and the
// server ignores them (pass2 is the server's own file, see server.mjs). Everything else is refused.
const DRAFT_TOP = new Set(['sessionId', 'labels', 'events', 'timing', 'ui', 'revision', 'allowEmpty', 'version', 'game', 'savedAt', 'pass2']);
const LABEL_KEYS = new Set(['id', 'windowStartSec', 'windowEndSec', 'label', 'rating', 'reasonTags', 'createdAt']);
const EVENT_KEYS = new Set(['id', 'suggestionId', 'detectorId', 'timeSec', 'suggestedTimeSec', 'verdict', 'medal']);
const RE = {
  label: /^l-\d{4,}$/, event: /^e-\d{4,}$/, sug: /^sg-\d{4,}$/, det: /^[A-Z][A-Z0-9]*$/,
  tag: /^[a-z0-9]+(-[a-z0-9]+)*$/, medal: /^[A-Za-z][A-Za-z0-9 '-]{0,39}$/,
  iso: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/,
};

// -> array of "<json pointer> <problem>" strings; empty = the draft may be saved.
// ctx: { durationSec, tagIds, pack } (each optional).
export function checkDraft(b, ctx = {}) {
  const errs = [];
  if (!isObj(b)) return ['/ not-object'];
  const dur = ctx.durationSec;
  const time = (v, at, { required = true } = {}) => {
    if (v === undefined) { if (required) errs.push(`${at} required`); return false; }
    if (!isNum(v)) { errs.push(`${at} not-a-finite-number`); return false; }
    if (v < 0) { errs.push(`${at} negative`); return false; }
    if (dur !== undefined && v > dur + END_SLACK_SEC) { errs.push(`${at} beyond-session-end`); return false; }
    return true;
  };
  const str = (v, re, at) => { if (typeof v !== 'string' || !re.test(v)) errs.push(`${at} pattern`); };
  for (const k of Object.keys(b)) if (!DRAFT_TOP.has(k)) errs.push(`/${k} unknown-field`);
  for (const k of ['labels', 'events']) if (Object.hasOwn(b, k) && !Array.isArray(b[k])) errs.push(`/${k} not-array`);
  for (const k of ['timing', 'ui']) if (Object.hasOwn(b, k) && !isObj(b[k])) errs.push(`/${k} not-object`);
  if (Object.hasOwn(b, 'revision') && !(Number.isInteger(b.revision) && b.revision >= 0)) errs.push('/revision not-an-integer');
  if (Object.hasOwn(b, 'allowEmpty') && typeof b.allowEmpty !== 'boolean') errs.push('/allowEmpty not-boolean');
  if (errs.length) return errs;
  (b.labels || []).forEach((l, i) => {
    const at = `/labels/${i}`;
    if (!isObj(l)) { errs.push(`${at} not-object`); return; }
    for (const k of Object.keys(l)) if (!LABEL_KEYS.has(k)) errs.push(`${at}/${k} unknown-field`);
    str(l.id, RE.label, `${at}/id`);
    if (l.label !== 'keep' && l.label !== 'reject') errs.push(`${at}/label enum`);
    if (l.rating !== undefined && l.rating !== null && !(Number.isInteger(l.rating) && l.rating >= 1 && l.rating <= 5)) errs.push(`${at}/rating range`);
    if (l.createdAt === undefined) errs.push(`${at}/createdAt required`); // PUT draft fills it (server.mjs)
    else str(l.createdAt, RE.iso, `${at}/createdAt`);
    if (Object.hasOwn(l, 'reasonTags')) {
      if (!Array.isArray(l.reasonTags) || !l.reasonTags.every((t) => typeof t === 'string')) errs.push(`${at}/reasonTags not-string-array`);
      else l.reasonTags.forEach((t, j) => {
        if (!RE.tag.test(t)) errs.push(`${at}/reasonTags/${j} pattern`);
        else if (ctx.tagIds && !ctx.tagIds.has(t)) errs.push(`${at}/reasonTags/${j} not-in-tags`);
      });
    }
    const a = time(l.windowStartSec, `${at}/windowStartSec`);
    const z = time(l.windowEndSec, `${at}/windowEndSec`);
    if (a && z && !(l.windowEndSec > l.windowStartSec)) errs.push(`${at}/windowEndSec not-after-start`);
  });
  (b.events || []).forEach((e, i) => {
    const at = `/events/${i}`;
    if (!isObj(e)) { errs.push(`${at} not-object`); return; }
    for (const k of Object.keys(e)) if (!EVENT_KEYS.has(k)) errs.push(`${at}/${k} unknown-field`);
    str(e.id, RE.event, `${at}/id`);
    if (e.suggestionId !== undefined) str(e.suggestionId, RE.sug, `${at}/suggestionId`);
    str(e.detectorId, RE.det, `${at}/detectorId`);
    if (!['accept', 'reject', 'added'].includes(e.verdict)) errs.push(`${at}/verdict enum`);
    if (e.medal !== undefined) str(e.medal, RE.medal, `${at}/medal`);
    if (ctx.pack && typeof e.detectorId === 'string') {
      if (!ctx.pack.detectors.has(e.detectorId)) errs.push(`${at}/detectorId not-in-pack`);
      else if (e.medal !== undefined) {
        const set = ctx.pack.medals.get(e.detectorId);
        if (!set) errs.push(`${at}/medal detector-has-no-catalogue`);
        else if (!set.has(e.medal)) errs.push(`${at}/medal not-in-pack`);
      }
    }
    time(e.timeSec, `${at}/timeSec`);
    time(e.suggestedTimeSec, `${at}/suggestedTimeSec`, { required: false });
  });
  if (isObj(b.timing)) {
    for (const k of Object.keys(b.timing)) if (k !== 'highlightPassSec' && k !== 'eventPassSec') errs.push(`/timing/${k} unknown-field`);
    for (const k of ['highlightPassSec', 'eventPassSec']) {
      const v = b.timing[k];
      if (!isNum(v)) errs.push(`/timing/${k} not-a-finite-number`);
      else if (v < 0) errs.push(`/timing/${k} negative`);
    }
  }
  if (isObj(b.ui)) {
    for (const k of Object.keys(b.ui)) if (k !== 't') errs.push(`/ui/${k} unknown-field`);
    if (b.ui.t !== undefined && !(isNum(b.ui.t) && b.ui.t >= 0)) errs.push('/ui/t not-a-finite-number');
  }
  return errs;
}

// ---- diff for re-export ----
// -> { added, removed, changed }: lists of { kind: 'label'|'event', id, timeSec, wasId? }.
// Items are matched on what they are, not on their renumbered id (one inserted window would shift every
// later id): a label on (windowStartSec, windowEndSec), an event on (detectorId, timeSec) (review M6).
// A matched pair whose other fields differ is "changed" (id = new id, wasId = old id). A moved window is
// "removed" at its old time and "added" at its new one. Only ids and times are returned.
const DIFF_KINDS = [
  ['labels', 'label', (x) => JSON.stringify([x.windowStartSec, x.windowEndSec]), (x) => x.windowStartSec],
  ['events', 'event', (x) => JSON.stringify([x.detectorId, x.timeSec]), (x) => x.timeSec],
];
export function diffLabelFiles(oldDoc, newDoc) {
  const out = { added: [], removed: [], changed: [] };
  const list = (doc, key) => ((doc && Array.isArray(doc[key])) ? doc[key] : []).filter(isObj);
  const sameExceptId = (a, b) => JSON.stringify({ ...a, id: null }) === JSON.stringify({ ...b, id: null });
  for (const [key, kind, keyOf, timeOf] of DIFF_KINDS) {
    const pool = new Map(); // match key -> old items with it, in file order
    for (const x of list(oldDoc, key)) { const k = keyOf(x); if (!pool.has(k)) pool.set(k, []); pool.get(k).push(x); }
    for (const x of list(newDoc, key)) {
      const olds = pool.get(keyOf(x));
      if (!olds || !olds.length) { out.added.push({ kind, id: x.id, timeSec: timeOf(x) }); continue; }
      // Prefer an identical old item, so duplicates at one time pair up without false changes.
      const i = Math.max(0, olds.findIndex((o) => sameExceptId(o, x)));
      const [o] = olds.splice(i, 1);
      if (!sameExceptId(o, x)) out.changed.push({ kind, id: x.id, timeSec: timeOf(x), wasId: o.id });
    }
    for (const olds of pool.values()) for (const o of olds) out.removed.push({ kind, id: o.id, timeSec: timeOf(o) });
  }
  return out;
}
