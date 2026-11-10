// SPDX-License-Identifier: GPL-3.0-or-later
// F7 auto-post-approved-rules (opt-in; review-first stays the default). Node stdlib only.
//   loadRules(file)                  -> { autoUpload, rules } (validated; any problem throws AutoPostError)
//   planAuto({ posts, rules, autoUpload, log, now }) -> [{ id, ruleId, action: 'approve'|'upload'|'skip', reason }]  (pure)
//   runAuto({ store, rules, outputsStatus, upload, logFile, now }) -> { refused, done: [...] }
// Safety: private only (uploadVideo hardcodes it); refuses everything while any output is active/starting or the output
// state cannot be read (fail closed); a post is auto-approved/auto-uploaded at most once; per-rule max per UTC day;
// only posts that AUTO approved are ever auto-uploaded (a post you approved by hand stays yours to upload);
// every auto action is appended to <dataDir>/posting/auto-log.json with its reason (ids and rule ids only, no text).
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const AUTO_FLAG = 'auto-post';
export const DEFAULT_RULES = path.join(REPO, 'data', 'posting', 'auto-post-rules.json');
export const RULES_NAME = 'auto-post-rules.json';
export const AUTO_LOG_NAME = 'auto-log.json';
export const UPLOAD_TARGET = 'youtube-shorts';
/** Targets the auto chain may upload (private YouTube). youtube-video is for finished videos that are not Shorts (D301). */
export const UPLOAD_TARGETS = Object.freeze(['youtube-shorts', 'youtube-video']);
export const RULE_KINDS = Object.freeze(['short', 'montage', 'won-reel']);
export const MAX_PER_DAY = 10;
const ID = /^[a-z][a-z0-9-]{0,31}$/;
const ACTIVE = new Set(['starting', 'live', 'retrying', 'active', 'running']);

export class AutoPostError extends Error {
  constructor(code, message) { super(message ?? code); this.name = 'AutoPostError'; this.code = code; }
}
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function validateRules(j) {
  if (!isPlain(j) || !Array.isArray(j.rules)) throw new AutoPostError('bad-rules', 'rules file: missing rules list');
  if (j.autoUpload !== undefined && typeof j.autoUpload !== 'boolean') throw new AutoPostError('bad-rules', 'rules file: autoUpload must be true or false');
  const seen = new Set();
  const rules = j.rules.map((r, i) => {
    if (!isPlain(r) || !ID.test(String(r.id)) || seen.has(r.id)) throw new AutoPostError('bad-rules', `rule ${i}: bad or duplicate id`);
    seen.add(r.id);
    if (!ID.test(String(r.target))) throw new AutoPostError('bad-rules', `rule ${r.id}: bad target`);
    if (!Number.isFinite(r.minScore)) throw new AutoPostError('bad-rules', `rule ${r.id}: minScore must be a number`);
    if (!Number.isInteger(r.maxPerDay) || r.maxPerDay < 1 || r.maxPerDay > MAX_PER_DAY) throw new AutoPostError('bad-rules', `rule ${r.id}: maxPerDay must be an integer 1..${MAX_PER_DAY}`);
    if (r.layouts !== undefined && !(Array.isArray(r.layouts) && r.layouts.every((l) => typeof l === 'string'))) throw new AutoPostError('bad-rules', `rule ${r.id}: layouts must be a list of names`);
    if (r.kinds !== undefined && !(Array.isArray(r.kinds) && r.kinds.length && r.kinds.every((k) => RULE_KINDS.includes(k)))) throw new AutoPostError('bad-rules', `rule ${r.id}: kinds must be a non-empty list of ${RULE_KINDS.join(', ')}`);
    return { id: r.id, target: r.target, minScore: r.minScore, layouts: r.layouts ?? null, kinds: r.kinds ?? ['short'], maxPerDay: r.maxPerDay };
  });
  return { autoUpload: j.autoUpload === true, rules };
}

/** Where the user's own rules live: <dataDir>/posting/auto-post-rules.json (survives app updates). */
export function userRulesFile(dataDir) { return path.join(dataDir, 'posting', RULES_NAME); }

/** The rules file to read: an explicit file wins; else the user's file in the data dir when it exists; else the shipped
 *  template (empty rules). A user file that exists is always the one used, so a bad one fails closed in loadRules. */
export function rulesFileFor(dataDir, explicit) {
  if (typeof explicit === 'string' && explicit) return explicit;
  if (typeof dataDir === 'string' && dataDir) { const u = userRulesFile(dataDir); if (existsSync(u)) return u; }
  return DEFAULT_RULES;
}

/** Copy the shipped template to the user path unless a file is already there. -> { path, created }. Never overwrites. */
export function initUserRules(dataDir) {
  const dest = userRulesFile(dataDir);
  if (existsSync(dest)) return { path: dest, created: false };
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(DEFAULT_RULES, dest, constants.COPYFILE_EXCL);
  return { path: dest, created: true };
}

export function loadRules(file = DEFAULT_RULES) {
  let j;
  try { j = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new AutoPostError('bad-rules', 'rules file: missing or not valid JSON'); }
  return validateRules(j);
}

// ---------------------------------------------------------------- log (the auto ledger)

export function createAutoLog(file) {
  const read = () => { try { const j = JSON.parse(readFileSync(file, 'utf8')); return isPlain(j) && Array.isArray(j.entries) ? j : { version: 1, entries: [] }; } catch { return { version: 1, entries: [] }; } };
  return {
    file,
    list: () => read().entries,
    append(entry) {
      const j = read(); j.entries.push(entry);
      mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`; writeFileSync(tmp, JSON.stringify(j, null, 2)); renameSync(tmp, file);
    },
  };
}

// ---------------------------------------------------------------- fail-closed live check

/** -> null when safe, else a reason. Any sink (stream or not) active/starting blocks; unreadable state blocks. */
export async function liveBlock(outputsStatus) {
  let st;
  try { st = await outputsStatus(); } catch { return 'output-state-unreadable'; }
  if (!isPlain(st) || !Array.isArray(st.sinks)) return 'output-state-unreadable';
  if (st.sinks.some((s) => !isPlain(s) || s.active === true || ACTIVE.has(s.state))) return 'output-live';
  return null;
}

// ---------------------------------------------------------------- planning

const dayOf = (now) => new Date(now).toISOString().slice(0, 10);

/** Pure. posts = store.list() views. Returns what a run would do, highest score first, caps applied. */
export function planAuto({ posts, rules, autoUpload, log, now }) {
  const today = dayOf(now);
  const plan = [];
  const count = (ruleId, action) => log.filter((e) => e.ruleId === ruleId && e.action === action && String(e.at).slice(0, 10) === today).length;
  const autoApproved = new Set(log.filter((e) => e.action === 'approve').map((e) => e.id));
  const autoUploaded = new Set(log.filter((e) => e.action === 'upload' || e.action === 'upload-failed').map((e) => e.id));
  const used = new Map();
  const take = (ruleId, action, cap) => {
    const k = `${ruleId}:${action}`; const n = used.get(k) ?? count(ruleId, action);
    if (n >= cap) return false;
    used.set(k, n + 1); return true;
  };
  const claimed = new Set();
  const sorted = [...posts].sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
  for (const rule of rules) {
    const canUpload = autoUpload && UPLOAD_TARGETS.includes(rule.target);
    for (const p of sorted) {
      if (p.target !== rule.target || claimed.has(p.id)) continue;
      const kind = p.kind ?? 'short';
      if (!(rule.kinds ?? ['short']).includes(kind)) continue;
      if (rule.layouts && !rule.layouts.includes(p.layout)) continue;
      if (p.status === 'draft') {
        const skip = (reason) => plan.push({ id: p.id, ruleId: rule.id, action: 'skip', reason });
        if (autoApproved.has(p.id)) { skip('already-auto-approved'); continue; }
        // minScore ranks clips only; a montage or won reel has no clip score, so listing its kind in a rule is the opt-in.
        if (kind === 'short') {
          if (!Number.isFinite(p.score)) { skip('no-score'); continue; }
          if (p.score < rule.minScore) continue;
        }
        if (p.limits && p.limits.ok === false) { skip('over-limit'); continue; }
        if (p.unresolved && p.unresolved.length) { skip('unresolved-placeholders'); continue; }
        if (!take(rule.id, 'approve', rule.maxPerDay)) { skip('max-per-day'); continue; }
        claimed.add(p.id);
        plan.push({ id: p.id, ruleId: rule.id, action: 'approve', reason: `score ${p.score} >= ${rule.minScore}` });
        if (canUpload && take(rule.id, 'upload', rule.maxPerDay)) plan.push({ id: p.id, ruleId: rule.id, action: 'upload', reason: 'autoUpload on, private' });
      } else if (p.status === 'approved' && canUpload && autoApproved.has(p.id) && !autoUploaded.has(p.id)) {
        claimed.add(p.id);
        if (!take(rule.id, 'upload', rule.maxPerDay)) { plan.push({ id: p.id, ruleId: rule.id, action: 'skip', reason: 'max-per-day' }); continue; }
        plan.push({ id: p.id, ruleId: rule.id, action: 'upload', reason: 'auto-approved earlier, autoUpload on, private' });
      }
    }
  }
  return plan;
}

// ---------------------------------------------------------------- run

/**
 * opts: { store, rules: {autoUpload, rules}, outputsStatus, upload?(id) -> Promise, logFile, now? }
 * `upload` is injected (CLI passes uploadPost with real auth; tests pass a fake). Without it: approvals only.
 */
export async function runAuto(opts) {
  const nowFn = opts.now ?? (() => new Date());
  const log = createAutoLog(opts.logFile);
  const blocked = await liveBlock(opts.outputsStatus);
  if (blocked) return { refused: blocked, done: [] };
  const plan = planAuto({ posts: opts.store.list(), rules: opts.rules.rules, autoUpload: opts.rules.autoUpload && typeof opts.upload === 'function', log: log.list(), now: nowFn() });
  const done = []; let uploadsStopped = false;
  const record = (e) => { const entry = { at: nowFn().toISOString(), ...e }; log.append(entry); done.push(entry); };
  for (const step of plan) {
    if (step.action === 'skip') continue;
    if (step.action === 'approve') {
      const r = await opts.store.setStatus(step.id, 'approved');
      if (typeof r === 'string') { record({ id: step.id, ruleId: step.ruleId, action: 'approve-refused', reason: r }); continue; }
      record({ id: step.id, ruleId: step.ruleId, action: 'approve', reason: step.reason });
      continue;
    }
    if (step.action === 'upload') {
      if (uploadsStopped) continue;
      // re-check right before each upload: a stream may have started during a long run
      const again = await liveBlock(opts.outputsStatus);
      if (again) { record({ id: step.id, ruleId: step.ruleId, action: 'upload-refused', reason: again }); uploadsStopped = true; continue; }
      const cur = opts.store.get(step.id);
      if (!cur || cur.status !== 'approved') continue; // approval refused above, or changed
      // log the attempt BEFORE the call: a crash mid-upload can never lead to a second automatic attempt
      record({ id: step.id, ruleId: step.ruleId, action: 'upload', reason: step.reason });
      try { await opts.upload(step.id); } catch (e) {
        record({ id: step.id, ruleId: step.ruleId, action: 'upload-failed', reason: String(e?.code ?? 'error').slice(0, 40) });
        uploadsStopped = true; // one failure (sign-in, quota) ends uploads for this run
      }
    }
  }
  return { refused: null, done };
}

export const describeMode = ({ flagOn, rules }) => ({
  enabled: flagOn === true && rules.rules.length > 0,
  flagOn: flagOn === true,
  autoUpload: rules.autoUpload,
  ruleCount: rules.rules.length,
  privacy: 'private',
});
