#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
// Diagnostics bundle: one redacted zip to attach to a bug report. Works without the host, the UI server or any RPC:
// it reads files the launcher and the host already write; the RPC parts are used only when a host token is at hand.
//   node tools/diag/bundle.mjs --data-dir <event-core data dir> [--host-data DIR] [--profile FILE] [--release FILE]
//                              [--out FILE] [--markers N] [--logs N] [--rpc]
//   Installed builds: Ujwalam.cmd diag (tools/package/run-installed.mjs fills the paths).
// Contents (every text passes tools/diag/redact.mjs; nothing else is read):
//   manifest.json      what was collected, from where (paths redacted), the redaction rules
//   versions.json      Ujwalam release, Node, OS, host and libobs versions
//   gpu.txt            nvidia-smi query (name, driver, memory, utilisation, NVENC sessions) when present
//   host-info.json, host-status.json   from --rpc, else the launcher's <data-dir>/logs/host-snapshot.json
//   outputs.json       per sink: id, kind, platform, target, state, keyPresent/urlPresent, counters. Never a key, URL
//                      or file path
//   log-ring.txt       host.log.tail (1000 lines) with --rpc
//   logs/host-*.log    the newest N host logs (default 3, last 2 MiB of each)
//   host-crashes.jsonl launcher crash-recovery log
//   markers.jsonl      the newest N markers (default 50): v, at, source, hostMs, streamMs, recordMs only (no notes,
//                      no scene names)
// Never included: keys, tokens, chat text, profile values, project files, feedback captures, recordings.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, closeSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRedactor, RULES } from './redact.mjs';
import { writeZip } from '../package/zip.mjs';

export const SNAPSHOT_FILE = 'host-snapshot.json';
export const CRASH_LOG_FILE = 'host-crashes.jsonl';
const LOG_TAIL_BYTES = 2 * 1024 * 1024;
const SINK_FIELDS = ['id', 'kind', 'platform', 'target', 'state', 'keyPresent', 'urlPresent', 'container', 'attempts', 'retries', 'consecutiveFailures', 'lastCode', 'active', 'totalFrames', 'droppedFrames', 'bytes', 'liveForMs'];
const MARKER_FIELDS = ['v', 'at', 'source', 'hostMs', 'streamMs', 'recordMs'];

/** outputs.status -> presence flags and counters only (also used by the launcher's snapshot). */
export function outputsSafe(o) {
  const sinks = Array.isArray(o?.sinks) ? o.sinks : [];
  return {
    allowLive: o?.allowLive === true,
    sinks: sinks.map((s) => Object.fromEntries(SINK_FIELDS.filter((k) => Object.hasOwn(s, k)).map((k) => [k, s[k]]))),
  };
}

function tailFile(file, max) {
  const size = statSync(file).size;
  const len = Math.min(size, max);
  const fd = openSync(file, 'r');
  try {
    const b = Buffer.alloc(len);
    readSync(fd, b, 0, len, size - len);
    return (size > len ? `[... first ${size - len} bytes not included ...]\n` : '') + b.toString('utf8');
  } finally { closeSync(fd); }
}

const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

function lastMarkers(dir, n) {
  if (!dir || !existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  const out = [];
  for (const f of files) {
    const lines = readFileSync(f, 'utf8').split('\n').filter(Boolean).reverse();
    for (const l of lines) {
      let m; try { m = JSON.parse(l); } catch { continue; }
      out.push(Object.fromEntries(MARKER_FIELDS.filter((k) => Object.hasOwn(m, k)).map((k) => [k, m[k]])));
      if (out.length >= n) return out.reverse();
    }
  }
  return out.reverse();
}

function gpuText() {
  const root = process.env.SystemRoot;
  const exe = root ? path.join(root, 'System32', 'nvidia-smi.exe') : null;
  if (!exe || !existsSync(exe)) return 'nvidia-smi not found (no NVIDIA driver, or not in System32)\n';
  const q = 'name,driver_version,memory.total,memory.used,utilization.gpu,temperature.gpu,encoder.stats.sessionCount,encoder.stats.averageFps,encoder.stats.averageLatency';
  try {
    const out = execFileSync(exe, [`--query-gpu=${q}`, '--format=csv'], { encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return `nvidia-smi --query-gpu=${q}\n${out}`;
  } catch (e) {
    return `nvidia-smi failed: ${e.code ?? e.status ?? 'error'}\n`;
  }
}

async function rpcCall({ port, token, method, params = {} }) {
  const http = await import('node:http');
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/rpc', method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'content-length': Buffer.byteLength(body) } }, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => { try { const j = JSON.parse(Buffer.concat(c).toString('utf8')); if (j.error) reject(new Error(j.error.message)); else resolve(j.result); } catch (e) { reject(e); } });
    });
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

/** Collects the bundle entries (all redacted). Pure apart from file reads, nvidia-smi and the optional RPC. */
export async function collectDiag({
  dataDir, hostData, profile, release, markers = 50, logs = 3, rpc = false, home = os.homedir(), userName = os.userInfo().username,
  gpu = gpuText, now = new Date(),
}) {
  const prof = profile && existsSync(profile) ? readJson(profile) : null;
  const red = makeRedactor({ home, userName, profile: prof });
  const files = [];
  const sources = {};
  const add = (name, text) => files.push({ name, data: red(text) });
  const json = (v) => `${JSON.stringify(v, null, 2)}\n`;

  let info = null;
  let status = null;
  let outputs = null;
  let ring = null;
  if (rpc) {
    const disc = readJson(path.join(dataDir, 'host.json'));
    const token = process.env.UJWALAM_HOST_TOKEN || disc?.token;
    if (disc?.port && token) {
      try {
        info = await rpcCall({ port: disc.port, token, method: 'host.info' });
        status = await rpcCall({ port: disc.port, token, method: 'host.status' });
        outputs = await rpcCall({ port: disc.port, token, method: 'outputs.status' });
        ring = await rpcCall({ port: disc.port, token, method: 'log.tail', params: { lines: 1000 } });
        sources.rpc = 'host';
      } catch (e) { sources.rpc = `failed: ${e.message}`; }
    } else sources.rpc = 'no host token (the launcher passes it by environment only)';
  }
  const snap = readJson(path.join(dataDir, 'logs', SNAPSHOT_FILE));
  if (snap) sources.snapshot = snap.at ?? 'present';
  info ??= snap?.info ?? null;
  status ??= snap?.status ?? null;
  outputs ??= snap?.outputs ?? null;

  const rel = release && existsSync(release) ? readJson(release) : null;
  add('versions.json', json({
    ujwalam: rel ? { version: rel.version, commit: rel.commit, date: rel.date } : null,
    node: process.versions.node,
    os: { platform: process.platform, release: os.release(), arch: process.arch },
    host: info ? { version: info.version, obsVersion: info.obsVersion, adapter: info.adapter, gpuPreference: info.gpuPreference } : null,
  }));
  add('gpu.txt', `${gpu()}\nhost adapter: ${info?.adapter ?? '-'}\nhost encoders: ${(info?.encoders ?? []).join(', ') || '-'}\n`);
  if (info) add('host-info.json', json(info));
  if (status) add('host-status.json', json(status));
  if (outputs) add('outputs.json', json(outputsSafe(outputs)));
  if (ring) add('log-ring.txt', `${(ring.lines ?? []).join('\n')}\n`);

  const logsDir = path.join(dataDir, 'logs');
  const hostLogs = existsSync(logsDir) ? readdirSync(logsDir).filter((n) => /^host-.*\.log$/.test(n)).sort().slice(-logs) : [];
  for (const n of hostLogs) add(`logs/${n}`, tailFile(path.join(logsDir, n), LOG_TAIL_BYTES));
  sources.hostLogs = hostLogs.length;
  if (existsSync(path.join(logsDir, CRASH_LOG_FILE))) add(CRASH_LOG_FILE, tailFile(path.join(logsDir, CRASH_LOG_FILE), 256 * 1024));
  const mk = lastMarkers(hostData ? path.join(hostData, 'markers') : null, markers);
  sources.markers = mk.length;
  if (mk.length) add('markers.jsonl', `${mk.map((m) => JSON.stringify(m)).join('\n')}\n`);

  add('manifest.json', json({
    v: 1, createdAt: now.toISOString(), tool: 'tools/diag/bundle.mjs', dataDir, hostData: hostData ?? null,
    profileUsedForRedaction: prof ? true : false, sources, files: files.map((f) => f.name), redaction: RULES,
    never: ['keys', 'tokens', 'chat text', 'profile values', 'project files', 'feedback captures', 'recordings'],
  }));
  return files;
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const k = a.slice(2);
    if (k === 'rpc') o.rpc = true;
    else { o[k] = argv[++i]; if (o[k] === undefined) throw new Error(`${a} needs a value`); }
  }
  return o;
}

export async function main(argv = process.argv.slice(2)) {
  let a;
  try { a = parseArgs(argv); } catch (e) { console.log(`[diag] ${e.message}`); return 2; }
  if (!a['data-dir']) { console.log('[diag] --data-dir <event-core data dir> is required'); return 2; }
  const dataDir = path.resolve(a['data-dir']);
  const out = path.resolve(a.out ?? path.join(dataDir, 'diag',`ujwalam-diag-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`));
  const files = await collectDiag({
    dataDir, hostData: a['host-data'] ? path.resolve(a['host-data']) : null, profile: a.profile ? path.resolve(a.profile) : null,
    release: a.release ? path.resolve(a.release) : null, markers: Number(a.markers ?? 50), logs: Number(a.logs ?? 3), rpc: a.rpc === true,
  });
  mkdirSync(path.dirname(out), { recursive: true });
  const z = writeZip(out, files.map((f) => ({ name: f.name, data: f.data })), { mtime: new Date() });
  console.log(`[diag] wrote ${out} (${z.entries} files, ${z.bytes} bytes; redacted: home dir, profile terms, keys, tokens, URLs, chat fields)`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main());
