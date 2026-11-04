// SPDX-License-Identifier: GPL-3.0-or-later
// Finds test mocks and soak helpers that are still running (P3 E7). Stdlib only. Read-only: it never stops anything.
//
//   node tools/stray-procs.mjs            list strays (exit 1 when there are any)
//
// A "stray" is a node process whose command line runs a script under tools/mock/ or tools/soak/, other than this process
// and its parent chain. Only the pid, start time, age and script name are reported (never the full command line, which
// could carry a data path).

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOT_LABELS, BOTS, createBots } from '../services/bots/index.mjs';
import { resolveDataDir } from '../services/event-core/config.mjs';

export const STRAY_SCRIPT = /tools[\\/](mock|soak)[\\/]([\w.-]+\.mjs)/;
// Other test-only children: the idempotency kill-test child, and listen-CLI children started by tests (they carry the
// test-only credential target in their arguments, which no real run uses).
export const TEST_CHILD = /tools[\\/]idem-crash-child\.mjs|Ujwalam-TEST-ONLY-absent/;
const labelOf = (cmd) => { const m = STRAY_SCRIPT.exec(cmd); if (m) return `tools/${m[1]}/${m[2]}`; return TEST_CHILD.test(cmd) ? 'test child' : null; };

/**
 * [{ pid, parentPid, startedAt (ISO or null), cmd }] for every node process. Windows: CIM; elsewhere: ps.
 * The caller is always a node process, so an empty list means the query failed: it is retried, then thrown, never
 * returned as "no strays" (a CI run under load once reported a running mock as absent, 2026-11-03).
 */
export function listNodeProcesses() {
  if (process.platform === 'win32') {
    let why = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; parentPid = $_.ParentProcessId; startedAt = $_.CreationDate.ToUniversalTime().ToString('o'); cmd = $_.CommandLine } } | ConvertTo-Json -Compress"],
      { encoding: 'utf8', timeout: 20000, windowsHide: true });
      if (r.status === 0 && r.stdout.trim()) {
        const v = JSON.parse(r.stdout);
        return (Array.isArray(v) ? v : [v]).map((p) => ({ pid: p.pid, parentPid: p.parentPid, startedAt: p.startedAt, cmd: p.cmd ?? '' }));
      }
      why = r.error ? r.error.code ?? r.error.message : `exit ${r.status}, ${String(r.stderr ?? '').trim().split(/\r?\n/)[0] ?? ''}`;
    }
    throw new Error(`process list failed 3 times (${why})`);
  }
  const r = spawnSync('ps', ['-eo', 'pid=,ppid=,lstart=,args='], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return [];
  return r.stdout.split('\n').map((l) => /^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.*)$/.exec(l)).filter(Boolean)
    .filter((m) => /\bnode\b/.test(m[4])).map((m) => ({ pid: Number(m[1]), parentPid: Number(m[2]), startedAt: new Date(m[3]).toISOString(), cmd: m[4] }));
}

/** Pure: which of `procs` are strays. `self` is the pid whose parent chain is exempt. */
export function findStrays(procs, { self = process.pid, now = Date.now() } = {}) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const exempt = new Set([self]);
  for (let p = byPid.get(self); p && p.parentPid && !exempt.has(p.parentPid); p = byPid.get(p.parentPid)) exempt.add(p.parentPid);
  return procs
    .filter((p) => !exempt.has(p.pid))
    .map((p) => ({ p, script: labelOf(p.cmd) }))
    .filter((x) => x.script)
    .map(({ p, script }) => ({ pid: p.pid, script, startedAt: p.startedAt, ageMin: p.startedAt ? Math.round((now - Date.parse(p.startedAt)) / 60000) : null }));
}

export function strayReport(strays) {
  if (!strays.length) return 'stray-mocks: none running';
  return [`stray-mocks: ${strays.length} test mock/soak process(es) still running`,
    ...strays.map((s) => `  pid ${s.pid}  ${s.script}  started ${s.startedAt ?? '?'}  (${s.ageMin ?? '?'} min)`),
    '  stop with: node -e "process.kill(<pid>)"   (mocks hold no data, so a plain stop is safe)'].join('\n');
}

export function scanStrays(opts) {
  return findStrays(listNodeProcesses(), opts);
}

/**
 * BM6: Streamer.bot / Speaker.bot that Ujwalam started (pid + start time in <dataDir>/bots/state.json) and that are still
 * running. REPORT ONLY: the stray-mocks CI step does not use it and no exit code depends on it, because a bot left
 * running after a studio stop is the user's call (the studio stop closes them when the `bot-manager` flag is on). A copy
 * the user started is never listed. Returns [] when the data dir or the profile paths are not set.
 */
export function scanBotStrays({ dataDir, bots } = {}) {
  try {
    const b = bots ?? createBots({ dataDir: dataDir ?? resolveDataDir() });
    return BOTS.filter((bot) => b.startedRecords()[bot]).map((bot) => ({ bot, ...b.detect(bot) }))
      .filter((d) => d.running && d.startedByUs).map((d) => ({ bot: d.bot, label: BOT_LABELS[d.bot], pid: d.pid }));
  } catch { return []; }
}

export function botStrayReport(list) {
  if (!list.length) return null;
  return [`bots: ${list.length} bot(s) started by Ujwalam still running (report only)`,
    ...list.map((x) => `  ${x.label}  pid ${x.pid}`),
    '  stop from the control page (Bots card) or by closing the studio with the bot-manager flag on'].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const s = scanStrays();
  console.log(strayReport(s));
  const bs = botStrayReport(scanBotStrays());
  if (bs) console.log(bs);
  process.exit(s.length ? 1 : 0);
}
