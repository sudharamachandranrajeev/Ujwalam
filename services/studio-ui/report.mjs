// SPDX-License-Identifier: GPL-2.0-or-later
// "Report" button support (flag `report-button`, D199). Builds a prefilled GitHub "new issue" URL. Nothing is sent:
// no GitHub API, no token, no network from Ujwalam. The page opens the URL in the user's browser and the user reviews
// and submits it there.
//   - The repo URL is private (it names the account): profile `links.issues_url`, validated strictly below.
//   - Every text in the body passes tools/diag/redact.mjs (the diagnostics redactor, not a second one).
//   - The body holds counts, states and versions only: no keys, ingest URLs, chat text, viewer names, paths.
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRedactor } from '../../tools/diag/redact.mjs';
import { outputsSafe } from '../../tools/diag/bundle.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REPORT_FLAG = 'report-button';
export const MAX_URL = 6000;
export const MAX_TITLE = 120;
export const MAX_NOTE = 1500;
export const SET_MESSAGE = 'Report: set links.issues_url in the profile';
export const TRUNCATED_NOTE = '[truncated to fit the link: attach the diag bundle (Ujwalam.cmd diag, or npm run diag)]';

// https://github.com/<owner>/<repo>, nothing else: https only, no credentials, port, query, fragment, extra path or
// trailing slash. Owner: 1-39 letters, digits, single hyphens inside. Repo: 1-100 of letters, digits, . _ -
const ISSUES_URL = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})\/([A-Za-z0-9._-]{1,100})$/;

/** -> { ok: true, url } | { ok: false, reason: 'unset' | 'placeholder' | 'invalid' } */
export function parseIssuesUrl(v) {
  if (v === undefined || v === null || v === '') return { ok: false, reason: 'unset' };
  if (typeof v !== 'string') return { ok: false, reason: 'invalid' };
  if (/^<.*>$/s.test(v.trim())) return { ok: false, reason: 'placeholder' };
  const m = ISSUES_URL.exec(v);
  if (!m || m[2] === '.' || m[2] === '..' || m[2].endsWith('.git')) return { ok: false, reason: 'invalid' };
  return { ok: true, url: v };
}

const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

/** Version string: release.json (installed build), else data/release/alpha.json (<base>-<channel>.<current>). */
export function readVersion({ releaseFile, repo = REPO } = {}) {
  const rel = readJson(releaseFile ?? path.join(repo, 'release.json'));
  if (rel && typeof rel.version === 'string') return rel.version;
  const a = readJson(path.join(repo, 'data', 'release', 'alpha.json'));
  return a ? `${a.base}-${a.channel}.${a.current}` : 'unknown';
}

const clip = (s, n) => String(s ?? '').replace(/\r\n?/g, '\n').slice(0, n);
const stripLoneSurrogate = (s) => (/[\uD800-\uDBFF]$/.test(s) ? s.slice(0, -1) : s);

/**
 * Pure builder. in: { issuesUrl, title, note, version, osText, flags: [{id,on}], host: {...counts}, outputs, crashes,
 *   redact(text), maxUrl }.
 * -> { url, truncated, length }
 */
export function buildReport(i) {
  const red = i.redact ?? ((t) => t);
  const maxUrl = i.maxUrl ?? MAX_URL;
  const title = red(clip(i.title, MAX_TITLE).replace(/\s+/g, ' ').trim()) || 'Report from the control page';
  const note = red(clip(i.note, MAX_NOTE).trim());
  const on = (i.flags ?? []).filter((f) => f.on).map((f) => f.id);
  const off = (i.flags ?? []).filter((f) => !f.on).length;
  const sinks = i.outputs?.sinks ?? [];
  const byState = {};
  for (const s of sinks) byState[s.state ?? 'unknown'] = (byState[s.state ?? 'unknown'] ?? 0) + 1;
  const h = i.host ?? {};
  const diag = [
    `- host: ${h.available ? 'answering' : 'not answering'}${h.live !== undefined ? `, live ${h.live ? 'yes' : 'no'}` : ''}${h.recording !== undefined ? `, recording ${h.recording ? 'yes' : 'no'}` : ''}`,
    ...(Number.isFinite(h.totalFrames) ? [`- frames: ${h.droppedFrames ?? 0} dropped of ${h.totalFrames}${Number.isFinite(h.fps) ? `, ${h.fps} fps` : ''}`] : []),
    `- outputs: ${sinks.length} sink(s)${sinks.length ? ` (${Object.entries(byState).map(([k, v]) => `${v} ${k}`).join(', ')})` : ''}`,
    `- host crash log entries: ${Number.isFinite(i.crashes) ? i.crashes : 'unknown'}`,
  ];
  const head = [
    '### What happened',
    note || '(describe what you saw)',
    '',
    '### Build',
    `- Ujwalam: ${clip(i.version, 60)}`,
    `- OS: ${clip(i.osText, 80)}`,
    `- Feature flags on: ${on.length ? on.join(', ') : 'none'} (${off} off)`,
    '',
    '### Diagnostics summary (counts and states only)',
    ...diag,
  ].join('\n');
  // The redactor sees the whole body once more: a seeded term typed in the note or found in a state string cannot pass.
  const body = red(head);
  const base = `${i.issuesUrl}/issues/new?title=${encodeURIComponent(title)}&body=`;
  const full = base + encodeURIComponent(body);
  if (full.length <= maxUrl) return { url: full, truncated: false, length: full.length };
  const suffix = `\n\n${TRUNCATED_NOTE}`;
  let lo = 0; let hi = body.length;
  const fits = (n) => (base + encodeURIComponent(stripLoneSurrogate(body.slice(0, n)) + suffix)).length <= maxUrl;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (fits(mid)) lo = mid; else hi = mid - 1; }
  const url = base + encodeURIComponent(stripLoneSurrogate(body.slice(0, lo)) + suffix);
  return { url, truncated: true, length: url.length };
}

/** opts: { profileFile, releaseFile, home?, userName?, osText? } -> { build({title,note,flags,host,outputs,crashes}) } */
export function createReporter(opts = {}) {
  const home = opts.home ?? os.homedir();
  const userName = opts.userName ?? os.userInfo().username;
  return {
    /** Reads the profile on each call (the user may fix it without a restart). -> { configured:false, reason, message } | { configured:true, ...buildReport } */
    build(ctx) {
      const profile = opts.profileFile && existsSync(opts.profileFile) ? readJson(opts.profileFile) : null;
      const parsed = parseIssuesUrl(profile?.links?.issues_url);
      if (!parsed.ok) return { configured: false, reason: parsed.reason, message: parsed.reason === 'invalid' ? 'Report: links.issues_url must be https://github.com/<owner>/<repo>' : SET_MESSAGE };
      const redact = makeRedactor({ home, userName, profile });
      const r = buildReport({
        issuesUrl: parsed.url, redact, title: ctx.title, note: ctx.note, flags: ctx.flags, host: ctx.host, crashes: ctx.crashes,
        outputs: ctx.outputs ? outputsSafe(ctx.outputs) : null,
        version: readVersion({ releaseFile: opts.releaseFile }), osText: opts.osText ?? `${os.type()} ${os.release()} ${process.arch}`,
      });
      return { configured: true, ...r };
    },
  };
}
