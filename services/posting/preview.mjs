// SPDX-License-Identifier: GPL-3.0-or-later
// Auto-post rules dry-run preview. READ-ONLY: reads uploads.json, the ledger, the auto log, rules, templates and limits;
// writes nothing, makes no network request, never touches a credential. Answers "what WOULD these rules queue?" so the
// user can approve the rules before any run. The queue decision itself is planAuto() (single source of truth).
//   previewRules({ dataDir, rules, templates?, limits?, profile?, log?, outputsStatus?, flagOn?, now?, hash? })
//     -> { mode, blocked, queued: [...], skipped: [...] }
// queued item:  { id, source: 'package'|'uploads', kind, target, ruleId, actions: ['approve','upload'?], title, description, tags, hashtags, score, held }
// skipped item: { id, source, kind, target, reason, detail?, title?, description? }
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { UPLOAD_TARGETS, describeMode, liveBlock, planAuto } from './auto-post.mjs';
import {
  CANVAS_TAIL, LEDGER_NAME, NAME_DATE, UPLOAD_KINDS, checkLimits, cleanProfile, createLedger, createPostStore, loadLimits,
  loadTemplates, pickYoutubeTarget, renderText, sha256File, unresolvedKeys,
} from './index.mjs';
import { isRetry, loadScheduleConfig, planQueueSlots, savedChannelLast, savedChannelTimes, toIso } from './schedule.mjs';

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isFile = (f) => { try { return statSync(f).isFile(); } catch { return false; } };
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

/** Renders one finished video's post text exactly as packageUploads() would (same templates, same renderer). Pure. */
export function renderUploadPost({ templates, target, kind, profile, n, date }) {
  const base = templates.targets[target];
  const tpl = isPlain(base.kinds?.[kind]) ? { ...base, ...base.kinds[kind] } : base;
  const missing = new Set();
  const ctx = { profile: cleanProfile(profile ?? {}), n, date };
  const post = {
    title: renderText(tpl.title, ctx, missing),
    description: renderText(tpl.description, ctx, missing),
    tags: tpl.tags.map((t) => renderText(t, ctx, missing)),
    hashtags: tpl.hashtags.map((t) => renderText(t, ctx, missing)),
    target,
  };
  return { ...post, unresolved: unresolvedKeys(post.title, post.description, ...post.tags, ...post.hashtags) };
}

/** Why a draft matched no rule: the answer comes from the rule that got furthest (kind, then layout, then score). */
function whyNoRule(p, rules) {
  const forTarget = rules.filter((r) => r.target === p.target);
  if (!forTarget.length) return { reason: 'no-rule-for-target', detail: `no rule targets ${p.target}` };
  const kind = p.kind ?? 'short';
  let best = null;
  for (const r of forTarget) {
    let stage = 0; let miss = { reason: 'kind-not-in-rule', detail: `rule ${r.id} covers ${(r.kinds ?? ['short']).join('+')}, this is ${kind}` };
    if ((r.kinds ?? ['short']).includes(kind)) {
      stage = 1; miss = { reason: 'layout-not-in-rule', detail: `rule ${r.id} layouts ${(r.layouts ?? []).join('+')}, this is ${p.layout}` };
      if (!r.layouts || r.layouts.includes(p.layout)) {
        stage = 2; miss = kind === 'short' && Number.isFinite(p.score) && p.score < r.minScore
          ? { reason: 'below-min-score', detail: `score ${p.score} < ${r.minScore} (rule ${r.id})` }
          : { reason: 'not-selected', detail: `rule ${r.id}` };
      }
    }
    if (!best || stage > best.stage) best = { stage, ...miss };
  }
  return { reason: best.reason, detail: best.detail };
}

export async function previewRules(opts) {
  const rulesDoc = opts.rules;
  const templates = opts.templates ?? loadTemplates();
  const limits = opts.limits ?? loadLimits();
  const now = opts.now ? opts.now() : new Date();
  const hash = opts.hash ?? sha256File;
  const ledgerFile = path.join(opts.dataDir, 'posting', LEDGER_NAME);
  const store = createPostStore({ ledgerFile, limits });
  const ledger = createLedger(ledgerFile);
  const blocked = opts.outputsStatus ? await liveBlock(opts.outputsStatus) : null;
  const queued = []; const skipped = [];

  const virtual = [];
  const doc = readJson(path.join(opts.dataDir, 'clips', 'uploads.json'));
  const skipRow = (file, kind, reason) => skipped.push({ id: `upload:${file}`, source: 'uploads', kind, target: null, reason });
  if (isPlain(doc) && Array.isArray(doc.files)) {
    for (const row of doc.files) {
      const file = isPlain(row) && typeof row.file === 'string' ? row.file : null;
      const base = file ? path.basename(file) : '?';
      if (!file || !UPLOAD_KINDS.includes(row.kind)) { skipRow(base, null, 'unknown-kind'); continue; }
      if (Array.isArray(row.posted) && row.posted.some((p) => p?.platform === 'youtube')) { skipRow(base, row.kind, 'already-posted'); continue; }
      if (!path.isAbsolute(file) || !isFile(file)) { skipRow(base, row.kind, 'file-missing'); continue; }
      const tail = CANVAS_TAIL.exec(base);
      const vertical = tail ? tail[2].toLowerCase().startsWith('v') : false;
      const seconds = Number(row.seconds);
      const target = pickYoutubeTarget({ seconds, vertical }, limits);
      if (!templates.targets[target] || !limits.targets?.[target]) { skipRow(base, row.kind, 'no-template'); continue; }
      const sha = await hash(file);
      if (ledger.get(sha, target)) { skipRow(base, row.kind, 'already-packaged'); continue; }
      const dm = NAME_DATE.exec(base);
      const date = dm ? `${dm[1]}-${dm[2]}-${dm[3]}` : 'unknown-date';
      const n = tail ? Number(tail[1]) : 1;
      const r = renderUploadPost({ templates, target, kind: row.kind, profile: opts.profile, n, date });
      virtual.push({
        id: `upload:${base}`, target, kind: row.kind, layout: tail ? tail[2].toLowerCase() : 'unknown', score: null, status: 'draft',
        title: r.title, description: r.description, tags: r.tags, hashtags: r.hashtags, limits: checkLimits(r, limits), unresolved: r.unresolved,
        seconds: Number.isFinite(seconds) ? seconds : null, source: 'uploads',
      });
    }
  }

  const all = [...store.list().map((p) => ({ ...p, source: 'package' })), ...virtual];
  const plan = planAuto({ posts: all, rules: rulesDoc.rules, autoUpload: rulesDoc.autoUpload, log: opts.log ?? [], now });
  const byId = new Map(all.map((p) => [p.id, p]));
  const seen = new Set();
  const text = (p) => ({ title: p.title, description: [p.description, (p.hashtags ?? []).join(' ')].filter(Boolean).join('\n\n'), tags: p.tags ?? [], hashtags: p.hashtags ?? [] });
  const head = (p) => ({ id: p.id, source: p.source, kind: p.kind ?? 'short', target: p.target });
  for (const step of plan) {
    const p = byId.get(step.id);
    if (!p) continue;
    if (step.action === 'skip') {
      if (!seen.has(p.id)) { seen.add(p.id); skipped.push({ ...head(p), reason: step.reason, ruleId: step.ruleId, ...text(p) }); }
      continue;
    }
    let q = queued.find((x) => x.id === p.id);
    if (!q) {
      const at = skipped.findIndex((x) => x.id === p.id); if (at >= 0) skipped.splice(at, 1);
      q = { ...head(p), ruleId: step.ruleId, actions: [], score: p.score ?? null, seconds: p.seconds ?? null, held: blocked, ...text(p) };
      queued.push(q); seen.add(p.id);
    }
    q.actions.push(step.action);
  }
  for (const p of all) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    if (p.status === 'uploaded') skipped.push({ ...head(p), reason: 'already-posted', ...text(p) });
    else if (p.status !== 'draft') skipped.push({ ...head(p), reason: `status-${p.status}`, ...text(p) });
    else { const w = whyNoRule(p, rulesDoc.rules); skipped.push({ ...head(p), reason: w.reason, detail: w.detail, ...text(p) }); }
  }
  for (const q of queued) if (!UPLOAD_TARGETS.includes(q.target)) q.note = 'not a YouTube upload target: approval only';
  const schedule = opts.scheduleOn === true ? estimateSlots({ dataDir: opts.dataDir, queued, nowMs: now.getTime(), file: opts.scheduleFile }) : { on: false };
  return { mode: describeMode({ flagOn: opts.flagOn === true, rules: rulesDoc }), rulesFile: typeof opts.rulesFile === 'string' ? opts.rulesFile : null, blocked, queued, skipped, schedule, generatedAt: now.toISOString(), note: 'dry run: nothing written, nothing sent' };
}

/** post-schedule estimate (read-only, no network): the upload queue's own slots plus the channel schedule saved by the
 *  last real run. Sets q.publishAt (UTC ISO) on each item that would upload. The real slot is decided when the item
 *  is queued, after a fresh read of the channel, so it can be later than this estimate. */
function estimateSlots({ dataDir, queued, nowMs, file }) {
  let cfg;
  try { cfg = file ? loadScheduleConfig(file) : loadScheduleConfig(); } catch { return { on: true, error: 'schedule-config-bad' }; }
  const qdoc = readJson(path.join(dataDir, 'posting', 'upload-queue.json'));
  if (qdoc?.schedule?.truncated === true) return { on: true, error: 'schedule-read-incomplete' }; // same as the queue: no time is guessed
  const items = isPlain(qdoc?.items) ? Object.values(qdoc.items) : [];
  const channelLast = savedChannelLast(qdoc, nowMs);
  // Same plan as the queue (D310 + D314 retry and re-chain): the would-queue clips are appended after the queue's own items.
  const known = new Set(items.map((i) => i.id));
  const ups = queued.filter((q) => q.actions.includes('upload') && UPLOAD_TARGETS.includes(q.target) && !known.has(q.id));
  const virtual = ups.map((q) => ({ id: q.id, state: 'queued', publishAt: null, session: null }));
  const retries = items.filter((i) => isRetry(i, nowMs, cfg)).length;
  const plan = new Map(planQueueSlots({ items: [...items, ...virtual], channelLast, channelTimes: savedChannelTimes(qdoc, nowMs), nowMs, cfg }).map((p) => [p.id, p]));
  const rechained = [...plan.values()].filter((p) => known.has(p.id) && p.rechain).length;
  for (const q of ups) {
    const p = plan.get(q.id);
    if (p?.at) q.publishAt = toIso(p.at);
    else if (p) { q.publishAt = null; q.publishNote = 'beyond-cap'; }
  }
  return { on: true, intervalHours: cfg.intervalHours, minLeadHours: cfg.minLeadHours, maxAheadDays: cfg.maxAheadDays, retries, rechained, channelReadAt: typeof qdoc?.schedule?.readAt === 'string' ? qdoc.schedule.readAt : null, estimate: true };
}

/** Plain-text report for the CLI. */
export function formatPreview(r) {
  const L = [];
  L.push(`auto-post preview (dry run, nothing written or sent): ${r.mode.enabled ? 'on' : 'off'}, ${r.mode.ruleCount} rule(s), autoUpload ${r.mode.autoUpload}, privacy private`);
  if (r.rulesFile) L.push(`rules file: ${r.rulesFile}`);
  if (r.blocked) L.push(`LIVE CHECK: a run would be refused now (${r.blocked}); everything below would be held`);
  L.push(`would queue: ${r.queued.length}`);
  if (r.schedule?.on) {
    L.push(r.schedule.error === 'schedule-read-incomplete' ? 'scheduled posting: on, but the channel has more uploads than are checked (raise maxPages in data/posting/schedule.json); nothing would upload'
      : r.schedule.error ? 'scheduled posting: on, but the settings file data/posting/schedule.json is not valid (nothing would upload)'
      : `scheduled posting: on, every ${r.schedule.intervalHours} h; publish times below are estimates (UTC)${r.schedule.channelReadAt ? `, channel last read ${r.schedule.channelReadAt}` : ', channel not read yet'}; the real time is set when the clip is queued${r.schedule.retries ? `; ${r.schedule.retries} queued clip(s) came within ${r.schedule.minLeadHours} h of their time and would get a new time about ${r.schedule.minLeadHours} h from now, ${r.schedule.rechained} queued clip(s) re-timed ${r.schedule.intervalHours} h apart after it` : ''}`);
  }
  for (const q of r.queued) {
    L.push(`  [${q.actions.join('+')}] ${q.kind} -> ${q.target} (rule ${q.ruleId}${q.score !== null ? `, score ${q.score}` : ''}) ${q.id}${q.note ? ` | ${q.note}` : ''}`);
    if (q.publishAt) L.push(`      goes public: ${q.publishAt} (estimate)`);
    else if (q.publishNote === 'beyond-cap') L.push(`      waits: its public time would be more than ${r.schedule.maxAheadDays} days ahead (maxAheadDays)`);
    L.push(`      title: ${q.title}`);
    for (const line of String(q.description).split('\n')) L.push(`      | ${line}`);
  }
  L.push(`would skip: ${r.skipped.length}`);
  for (const s of r.skipped) L.push(`  ${s.kind ?? '?'} ${s.target ?? '-'} ${s.id}: ${s.reason}${s.detail ? ` (${s.detail})` : ''}`);
  return L.join('\n');
}
