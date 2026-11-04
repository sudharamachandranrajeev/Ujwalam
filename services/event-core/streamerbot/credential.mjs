// SPDX-License-Identifier: GPL-3.0-or-later
// Windows Credential Manager password provider (P3 E2). Node stdlib only, no installs.
//
// Method: Windows PowerShell 5.1 (powershell.exe, present on every Windows 10/11) compiles a tiny P/Invoke
// wrapper over advapi32 CredReadW / CredWriteW / CredDeleteW with Add-Type and stores a GENERIC credential.
// Why not the alternatives:
//   - `cmdkey` can create and delete credentials but cannot print the secret, so it cannot be a provider.
//   - WinRT PasswordVault works only in Windows PowerShell (not pwsh 7) and stores in a per-app vault that
//     is not shown in the Credential Manager UI.
//   - A DPAPI-protected file would be our own secret store; Credential Manager is the user's own, visible
//     and revocable store (Control Panel > Credential Manager > Windows Credentials).
// The secret never appears on a command line: it goes to PowerShell through stdin, the target name through
// an environment variable, and a read prints the secret on stdout only to this process.
// The secret is stored UTF-16LE, which is what cmdkey and the Credential Manager UI use.
// Review E8-16: between Node and PowerShell the secret travels as base64 of its UTF-8 bytes in both directions, so
// the console code page (OEM 437/850, 65001, ...) can never change a non-ASCII password. Base64 is ASCII-only.
// Review E8-09: powershell.exe is started by absolute path from a validated %SystemRoot% (config.mjs systemTool),
// never by bare name, so a directory early in PATH cannot shadow it. The stored format is unchanged.

import { spawn } from 'node:child_process';
import { systemTool } from '../config.mjs';

export const DEFAULT_TARGET = 'Ujwalam/streamerbot';
const TARGET_RE = /^Ujwalam[A-Za-z0-9 _./-]{0,100}$/;

const CS = `
using System; using System.Runtime.InteropServices; using System.Text;
public static class UjwCred {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct CRED { public uint Flags; public uint Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public uint BlobSize; public IntPtr Blob;
    public uint Persist; public uint AttrCount; public IntPtr Attrs; public string Alias; public string User; }
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CredReadW(string t, uint ty, uint f, out IntPtr p);
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CredWriteW(ref CRED c, uint f);
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CredDeleteW(string t, uint ty, uint f);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr p);
  public static int Get(string t, out string secret) {
    secret = null; IntPtr p;
    if (!CredReadW(t, 1, 0, out p)) return Marshal.GetLastWin32Error();
    try { var c = (CRED)Marshal.PtrToStructure(p, typeof(CRED));
      secret = Marshal.PtrToStringUni(c.Blob, (int)c.BlobSize / 2); return 0; } finally { CredFree(p); }
  }
  public static int Set(string t, string secret) {
    byte[] b = Encoding.Unicode.GetBytes(secret); IntPtr m = Marshal.AllocHGlobal(b.Length);
    try { Marshal.Copy(b, 0, m, b.Length);
      var c = new CRED(); c.Type = 1; c.TargetName = t; c.BlobSize = (uint)b.Length; c.Blob = m; c.Persist = 2; c.User = "ujwalam";
      return CredWriteW(ref c, 0) ? 0 : Marshal.GetLastWin32Error(); } finally { Marshal.FreeHGlobal(m); }
  }
  public static int Del(string t) { return CredDeleteW(t, 1, 0) ? 0 : Marshal.GetLastWin32Error(); }
}`;

// op: get | set | del. Exit codes: 0 ok, 1168 not found (Win32 ERROR_NOT_FOUND), other = Win32 error.
const PS = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${CS}
'@
$t = $env:UJW_CRED_TARGET
switch ($env:UJW_CRED_OP) {
  'get' { $s = $null; $rc = [UjwCred]::Get($t, [ref]$s); if ($rc -eq 0) { [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s))) }; exit $rc }
  'set' { $s = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())); exit ([UjwCred]::Set($t, $s)) }
  'del' { exit ([UjwCred]::Del($t)) }
  default { exit 99 }
}`;
const ENCODED = Buffer.from(PS, 'utf16le').toString('base64');
const TIMEOUT_MS = 30000;

// Environment of the PowerShell child (E4b review finding 10): only what Windows PowerShell 5.1 and Add-Type need to start
// and compile (system root and drive, PATH and PATHEXT, temp folders, the user profile folders, processor architecture)
// plus the two UJW_CRED_ variables. Nothing else from this process: no API tokens, no other app settings. PSModulePath is
// left out on purpose (a PowerShell 7 parent's value can break module loading in 5.1; 5.1 builds its own default).
export const CHILD_ENV_KEYS = Object.freeze([
  'SystemRoot', 'windir', 'SystemDrive', 'Path', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'PROCESSOR_ARCHITECTURE',
]);
/** The complete environment for the credential child. base defaults to process.env (case-insensitive on Windows). */
export function credentialChildEnv(op, target, base = process.env) {
  const env = {};
  for (const k of CHILD_ENV_KEYS) {
    let v = base[k];
    if (v === undefined) { // a plain object (tests) is case-sensitive; process.env on Windows is not
      const hit = Object.keys(base).find((x) => x.toLowerCase() === k.toLowerCase());
      if (hit !== undefined) v = base[hit];
    }
    if (typeof v === 'string' && v !== '') env[k] = v;
  }
  env.UJW_CRED_OP = op;
  env.UJW_CRED_TARGET = target;
  return env;
}

// Asynchronous (P3 E7 follow-up, user decision 2026-10-28): the PowerShell child runs through child_process.spawn and
// the event loop is never blocked while it starts (300+ ms) and reads. No shell: the executable and its three fixed
// arguments go straight to CreateProcess. The secret is written to the child's stdin and read from its stdout only;
// stderr is drained and dropped; error messages carry codes, never output.
function run(op, target, stdin) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') { reject(new Error('credential-unsupported-platform')); return; }
    if (!TARGET_RE.test(target)) { reject(new Error('credential-bad-target: name must start with "Ujwalam"')); return; }
    let exe;
    try { exe = systemTool('WindowsPowerShell', 'v1.0', 'powershell.exe'); } catch { reject(new Error('credential-spawn-failed: no-system-powershell')); return; }
    let child;
    try {
      child = spawn(exe, ['-NoProfile', '-NonInteractive', '-EncodedCommand', ENCODED], {
        env: credentialChildEnv(op, target),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      });
    } catch (e) { reject(new Error(`credential-spawn-failed: ${e?.code ?? 'error'}`)); return; }
    const out = [];
    let settled = false;
    let timedOut = false;
    const finish = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); fn(v); };
    const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch { /* exiting */ } }, TIMEOUT_MS);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', () => { /* drained, never kept: it must not reach a log or an error */ });
    child.on('error', (e) => finish(reject, new Error(`credential-spawn-failed: ${e?.code ?? 'error'}`)));
    child.on('close', (code) => {
      if (timedOut) { finish(reject, new Error('credential-spawn-failed: ETIMEDOUT')); return; }
      finish(resolve, { code, out: Buffer.concat(out).toString('latin1') }); // base64 (ASCII) when code is 0
    });
    child.stdin.on('error', () => { /* the child exited before reading stdin; its exit code reports the result */ });
    child.stdin.end(stdin == null ? '' : Buffer.from(stdin, 'utf8').toString('base64'), 'latin1');
  });
}

/** Credential Manager store for one target name. Names must start with "Ujwalam". Every method returns a promise. */
export function createCredentialStore(target = DEFAULT_TARGET) {
  return {
    target,
    /** Resolves the secret, or null when the credential does not exist. */
    async get() {
      const r = await run('get', target);
      if (r.code === 0) {
        const b64 = r.out.trim();
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b64)) throw new Error('credential-read-failed: bad-output');
        return Buffer.from(b64, 'base64').toString('utf8');
      }
      if (r.code === 1168) return null;
      throw new Error(`credential-read-failed: win32 ${r.code}`);
    },
    async set(secret) {
      if (typeof secret !== 'string' || secret === '') throw new Error('credential-empty-secret');
      const r = await run('set', target, secret);
      if (r.code !== 0) throw new Error(`credential-write-failed: win32 ${r.code}`);
    },
    /** Resolves true if something was deleted, false if it did not exist. */
    async delete() {
      const r = await run('del', target);
      if (r.code === 0) return true;
      if (r.code === 1168) return false;
      throw new Error(`credential-delete-failed: win32 ${r.code}`);
    },
  };
}

/**
 * Password provider for the connector: async () => string | null, plus invalidate().
 *
 * Caching (decision recorded in docs/evidence/2026-10-28-p3-e7-priority-failclosed-tracer.md): a non-empty secret is
 * kept in memory for the provider's lifetime (one connector), so a reconnect after a network drop or a Streamer.bot
 * restart does not start PowerShell again. The connector calls invalidate() on every auth failure, so the next start()
 * reads the store again (a changed password is picked up then). null (not stored) and read errors are never cached.
 * Concurrent calls share one read. The secret was already in this process's memory during each handshake; caching
 * extends that to the connector's lifetime, in the same user's process only. It is never logged or written anywhere.
 * opts.cache false turns the cache off (every call reads). opts.store is a test seam ({ get(): Promise }).
 */
export function credentialProvider(target = DEFAULT_TARGET, opts = {}) {
  const store = opts.store ?? createCredentialStore(target);
  const cache = opts.cache !== false;
  let cached = null;
  let inflight = null;
  let generation = 0;
  const provider = async () => {
    if (cache && cached !== null) return cached;
    if (inflight) return inflight;
    const gen = generation;
    inflight = (async () => {
      try {
        const v = await store.get();
        if (cache && gen === generation && typeof v === 'string' && v !== '') cached = v;
        return v;
      } finally { inflight = null; }
    })();
    return inflight;
  };
  provider.invalidate = () => { cached = null; generation++; };
  provider.cached = () => cached !== null; // true/false only, never the value
  return provider;
}
