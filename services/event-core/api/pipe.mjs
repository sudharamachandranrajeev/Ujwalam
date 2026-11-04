// SPDX-License-Identifier: GPL-3.0-or-later
// System-role local channel for event-core (review E8-03 follow-up, user decision 2026-10-29). Node stdlib only.
//
// Why: the JSON-RPC API listens on one loopback TCP port that any local process can flood. On Windows the accept
// queue is capped at about 232 connections whatever the backlog is (measured), so a flood can make a single connect
// fail with ECONNREFUSED. Panic must not depend only on that port. This module opens a SEPARATE listener for the
// system role (the supervisor): a Windows named pipe with an owner-only DACL. A TCP flood never touches it.
//
// Name:   \\.\pipe\ujwalam-core-system-<32 hex>, random per launch. libuv creates the first instance with
//         FILE_FLAG_FIRST_PIPE_INSTANCE, so a name that another process already holds makes listen() fail
//         (no squatting). The name is published only in <dataDir>/system.json (owner-only), never in api.json.
// ACL:    libuv gives a pipe the default DACL, which lets Everyone and Anonymous read (measured:
//         D:(A;;FR;;;WD)(A;;FR;;;AN)(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<user>)). Node cannot set another one, so after
//         listen() Windows PowerShell 5.1 opens one client handle with ChangePermissions and sets a protected DACL with
//         one entry: the current user, full control. The security descriptor is shared by every instance of the name
//         (measured: a fresh connection sees the new DACL). The result is read back and must be exactly
//         D:P(A;;0x1f019f;;;<current user SID>); otherwise the pipe is closed and listen() rejects (fail closed).
//         Connections accepted before the DACL is verified are closed without being read.
// Auth:   the system token. The api token is refused. No other credential is accepted.
// Methods: PIPE_METHODS only (actions.panic, core.status), same params schemas and gate handle as the HTTP API.
//
// Wire protocol (UTF-8, one JSON object per line, '\n' terminated, at most maxLineBytes per line):
//   client -> {"auth":"<64 hex system token>"}
//   server -> {"ok":true}                              or {"error":"unauthorized"} and the pipe is closed
//   client -> {"jsonrpc":"2.0","id":1,"method":"actions.panic","params":{"reason":"hotkey"}}
//   server -> {"jsonrpc":"2.0","id":1,"result":{"ok":true,"reason":"panic-engaged"}}
// A client may send the auth line and the first request in one write. Requests on one connection are answered in
// order. Errors: JSON-RPC error objects; nothing in a reply carries a stack or an internal message.
// Limits: an unauthenticated connection is closed after preAuthMs; at most maxPending unauthenticated connections
// (the oldest is closed when a new one arrives); at most maxAuthed authenticated ones (more get {"error":"busy"});
// an authenticated connection with no traffic for idleMs is closed.

import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import net from 'node:net';
import { currentUserSid, protectPath, systemTool } from '../config.mjs';
import { METHODS, RpcError, E, validateParams } from './methods.mjs';

export const PIPE_PREFIX = 'ujwalam-core-system-';
export const PIPE_NAME_RE = /^ujwalam-core-system-[0-9a-f]{32}$/;
export const PIPE_METHODS = Object.freeze(['actions.panic', 'core.status']);
export const PIPE_LIMITS = Object.freeze({
  maxLineBytes: 8_192,
  preAuthMs: 1_000,
  idleMs: 60_000,
  maxPending: 16,
  maxAuthed: 8,
  protectTimeoutMs: 20_000, // PowerShell start-up under load can take several seconds
});

/** A new random pipe name (the part after \\.\pipe\). */
export const newPipeName = () => `${PIPE_PREFIX}${randomBytes(16).toString('hex')}`;
/** Full Windows path for a pipe name. */
export const pipePath = (name) => {
  if (!PIPE_NAME_RE.test(name)) throw new TypeError('bad pipe name');
  return `\\\\.\\pipe\\${name}`;
};

const TOKEN_HEX = /^[0-9a-f]{64}$/;
const digest = (s) => createHash('sha256').update(s, 'utf8').digest();
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

// Fixed PowerShell 5.1 script. The pipe name and the operation come from the environment, never from the command line.
// op 'protect': set the owner-only DACL and print the resulting SDDL. op 'read': print the SDDL only.
const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
$n = $env:UJWALAM_PIPE_NAME
$op = $env:UJWALAM_PIPE_OP
if ($n -notmatch '^ujwalam-core-system-[0-9a-f]{32}$') { exit 3 }
Add-Type -AssemblyName System.Core
$r = [System.IO.Pipes.PipeAccessRights]
$want = $r::ReadPermissions -bor $r::ReadData -bor $r::WriteData
if ($op -eq 'protect') { $want = $want -bor $r::ChangePermissions }
$c = New-Object System.IO.Pipes.NamedPipeClientStream('.', $n, $want, [System.IO.Pipes.PipeOptions]::None, [System.Security.Principal.TokenImpersonationLevel]::Identification, [System.IO.HandleInheritability]::None)
try {
  $c.Connect(5000)
  if ($op -eq 'protect') {
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $s = New-Object System.IO.Pipes.PipeSecurity
    $s.SetAccessRuleProtection($true, $false)
    $s.AddAccessRule((New-Object System.IO.Pipes.PipeAccessRule($sid, $r::FullControl, [System.Security.AccessControl.AccessControlType]::Allow)))
    $c.SetAccessControl($s)
  }
  [Console]::Out.Write($c.GetAccessControl().GetSecurityDescriptorSddlForm('Access'))
} finally { $c.Dispose() }
`;
const PS_ENCODED = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64');

/** Runs the fixed script for a pipe name. Resolves the SDDL string, or null on any failure. Never blocks the loop. */
export function pipeSddl(name, op = 'read', timeoutMs = PIPE_LIMITS.protectTimeoutMs) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' || !PIPE_NAME_RE.test(name) || !['read', 'protect'].includes(op)) { resolve(null); return; }
    let exe;
    try { exe = systemTool('WindowsPowerShell', 'v1.0', 'powershell.exe'); } catch { resolve(null); return; }
    let child;
    try {
      child = spawn(exe, ['-NoProfile', '-NonInteractive', '-EncodedCommand', PS_ENCODED], {
        env: { SystemRoot: process.env.SystemRoot, UJWALAM_PIPE_NAME: name, UJWALAM_PIPE_OP: op },
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false,
      });
    } catch { resolve(null); return; }
    const out = [];
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* exiting */ } finish(null); }, timeoutMs);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', () => { /* drained, never kept */ });
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code === 0 ? Buffer.concat(out).toString('latin1').trim() : null));
  });
}

/** True when an SDDL DACL is protected and has exactly one entry: full control for sid. */
export const isOwnerOnlySddl = (sddl, sid) => typeof sddl === 'string' && typeof sid === 'string' && sddl === `D:P(A;;0x1f019f;;;${sid})`;

/** Default protection: Windows owner-only DACL (verified), POSIX mode 0600 on the socket file. 'acl' | 'mode-0600' | 'acl-failed'. */
async function defaultProtect({ name, path: p }) {
  if (process.platform !== 'win32') return protectPath(p) === 'mode-0600' ? 'mode-0600' : 'acl-failed';
  const sid = currentUserSid();
  if (!sid) return 'acl-failed';
  const sddl = await pipeSddl(name, 'protect');
  return isOwnerOnlySddl(sddl, sid) ? 'acl' : 'acl-failed';
}

/** opts: { core, token (system, 64 hex), status?: () => object, name? (Windows; random when absent), path? (POSIX socket
 *  file, required off Windows), limits?, protect?: async ({ name, path }) => 'acl' | 'mode-0600' | 'acl-failed' } */
export function createSystemPipeServer(opts) {
  const core = opts.core;
  if (!TOKEN_HEX.test(opts.token ?? '')) throw new TypeError('system token must be 64 hex characters');
  const L = { ...PIPE_LIMITS, ...(opts.limits ?? {}) };
  const win = process.platform === 'win32';
  const name = win ? (opts.name ?? newPipeName()) : null;
  const where = win ? pipePath(name) : opts.path;
  if (typeof where !== 'string' || !where) throw new TypeError('a socket path is required off Windows');
  const dig = digest(opts.token);
  const handle = core.actions ? core.actions.forSource('system') : null;
  const status = opts.status ?? (() => ({ live: core.actions ? core.actions.state() : null }));
  const protect = opts.protect ?? defaultProtect;

  const stats = { connections: 0, authOk: 0, authFailed: 0, requests: 0, pendingEvicted: 0, pendingTimedOut: 0, busy: 0, earlyClosed: 0, oversize: 0 };
  const pending = new Set();
  const authed = new Set();
  const early = new Set();
  let ready = false;
  let protection = null;

  const server = net.createServer({ allowHalfOpen: false, pauseOnConnect: true }, (socket) => {
    stats.connections++;
    socket.on('error', () => {});
    if (!ready) { early.add(socket); socket.on('close', () => early.delete(socket)); return; } // not read before the ACL is verified
    serve(socket);
  });

  function writeLine(socket, obj) { if (!socket.destroyed) socket.write(`${JSON.stringify(obj)}\n`); }

  function serve(socket) {
    pending.add(socket);
    if (pending.size > L.maxPending) {
      const oldest = pending.values().next().value;
      pending.delete(oldest); stats.pendingEvicted++; oldest.destroy();
    }
    const pre = setTimeout(() => { if (pending.has(socket)) { stats.pendingTimedOut++; socket.destroy(); } }, L.preAuthMs);
    pre.unref?.();
    let buf = Buffer.alloc(0);
    let chain = Promise.resolve();
    let isAuthed = false;
    socket.on('close', () => { clearTimeout(pre); pending.delete(socket); authed.delete(socket); });
    socket.on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        const i = buf.indexOf(0x0a);
        if (i < 0) break;
        const line = buf.subarray(0, i);
        buf = buf.subarray(i + 1);
        if (line.length > L.maxLineBytes) { stats.oversize++; socket.destroy(); return; }
        chain = chain.then(() => onLine(socket, line)).catch(() => socket.destroy());
      }
      if (buf.length > L.maxLineBytes) { stats.oversize++; socket.destroy(); }
    });
    socket.resume();

    async function onLine(sock, line) {
      if (sock.destroyed || sock.writableEnded) return; // refused or closing: later lines are ignored
      let msg;
      try { msg = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)); } catch { msg = undefined; }
      if (!isAuthed) {
        const tok = isPlain(msg) && Object.keys(msg).length === 1 && typeof msg.auth === 'string' && TOKEN_HEX.test(msg.auth) ? msg.auth : '';
        const ok = timingSafeEqual(digest(tok), dig) && tok !== ''; // same digest work for any input
        if (!ok) { stats.authFailed++; writeLine(sock, { error: 'unauthorized' }); sock.end(); return; }
        if (authed.size >= L.maxAuthed) { stats.busy++; writeLine(sock, { error: 'busy' }); sock.end(); return; }
        isAuthed = true; stats.authOk++;
        pending.delete(sock); authed.add(sock); clearTimeout(pre);
        sock.setTimeout(L.idleMs, () => sock.destroy());
        writeLine(sock, { ok: true });
        return;
      }
      stats.requests++;
      writeLine(sock, await rpc(msg));
    }
  }

  async function rpc(msg) {
    const err = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
    if (!isPlain(msg)) return err(null, E.INVALID_REQUEST, 'invalid-request');
    const id = msg.id;
    if (!((typeof id === 'string' && id.length >= 1 && id.length <= 64) || Number.isSafeInteger(id))) return err(null, E.INVALID_REQUEST, 'id must be a string (1..64) or an integer');
    for (const k of Object.keys(msg)) if (!['jsonrpc', 'method', 'params', 'id'].includes(k)) return err(id, E.INVALID_REQUEST, 'unknown-field');
    if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return err(id, E.INVALID_REQUEST, 'invalid-request');
    if (!PIPE_METHODS.includes(msg.method)) return err(id, E.METHOD_NOT_FOUND, 'method-not-found');
    const m = METHODS[msg.method];
    if (!m.roles.includes('system')) return err(id, E.FORBIDDEN, 'forbidden');
    const params = msg.params === undefined ? {} : msg.params;
    const bad = validateParams(m.schema, params);
    if (bad) return err(id, E.INVALID_PARAMS, bad);
    try {
      return { jsonrpc: '2.0', id, result: await m.run({ core, handle, role: 'system', status }, params) };
    } catch (e) {
      if (e instanceof RpcError) return err(id, e.rpcCode, e.message);
      return err(id, E.INTERNAL, 'internal-error');
    }
  }

  let listening = null;
  return {
    name, path: where,
    stats: () => ({ ...stats, pending: pending.size, authenticated: authed.size, protection }),
    listen() {
      if (listening) return listening;
      listening = (async () => {
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(where, () => { server.off('error', reject); resolve(); });
        });
        let p;
        try { p = await protect({ name, path: where }); } catch { p = 'acl-failed'; }
        for (const s of early) { stats.earlyClosed++; s.destroy(); }
        early.clear();
        if (p !== 'acl' && p !== 'mode-0600') {
          await new Promise((r) => server.close(() => r()));
          throw Object.assign(new Error('system pipe could not be restricted to the current user (PIPE_ACL_FAILED)'), { code: 'PIPE_ACL_FAILED' });
        }
        protection = p;
        ready = true;
        return { path: where, protection };
      })();
      return listening;
    },
    async close() {
      ready = false;
      for (const s of [...pending, ...authed, ...early]) s.destroy();
      await new Promise((r) => { if (!server.listening) { r(); return; } server.close(() => r()); });
    },
  };
}
