#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Patched obs-nvenc.dll for the OBS 32.1.2 runtime (ADR docs/adr/2026-11-05-obs-nvenc-destroy-order.md, accepted
// 2026-11-06). Only this one plugin is rebuilt; the official obs.dll and every other runtime file stay 32.1.2.
//
//   node tools/obs-patch/build-obs-nvenc.mjs            fetch + verify + patch + build + verify (out/obs-patch/build)
//   node tools/obs-patch/build-obs-nvenc.mjs --install  the same, then put the DLL + PDB into the configured runtime
//                                                       (the originals are copied aside first, never deleted)
//   node tools/obs-patch/build-obs-nvenc.mjs --check    exit 0 only if the runtime holds the patched DLL (no build)
//   --runtime DIR   runtime dir (default: app/host/lib/config.mjs, i.e. UJWALAM_OBS_RUNTIME / host.local.json)
//   --record        write the built DLL/PDB SHA-256 and the DLL's codeSha256 into the manifest (first build, or a new
//                   toolchain). Without it, a build must match the recorded codeSha256 (see codeSha256 below).
//   --reconfigure   re-run CMake configure in the build dir
//
// Inputs are pinned in tools/obs-patch/obs-nvenc.manifest.json: the obs-studio tag + commit, the upstream fix commit
// and its parent, the committed diff (tools/obs-patch/patches/, SHA-256), the nv-codec-headers tag + commit
// (the version OBS 32.1.2 was compiled against: "NVENC version: 12.2 (compiled)" in the host log), and the SHA-256 of
// the official and the patched DLL. Downloads go into out/obs-src/ (gitignored) and are treated as untrusted data:
// only git and the compiler read them; nothing from them is executed. The CMake project is ours
// (tools/obs-patch/obs-nvenc/CMakeLists.txt). cmake, ninja, cl, dumpbin and lib come from the current developer
// prompt or from VS Build Tools' vcvars64.bat found through vswhere (nothing is installed).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig, REPO_ROOT } from '../../app/host/lib/config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MANIFEST_FILE = path.join(HERE, 'obs-nvenc.manifest.json');
const SRC_ROOT = path.join(REPO_ROOT, 'out', 'obs-src');
// UJWALAM_OBS_PATCH_BUILD: another build dir, e.g. a fresh one to check that the build reproduces the recorded SHA-256.
const BUILD_DIR = path.resolve(REPO_ROOT, process.env.UJWALAM_OBS_PATCH_BUILD || path.join('out', 'obs-patch', 'build'));
const PLUGIN_REL = ['obs-plugins', '64bit'];

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** SHA-256 of a PE64 image with the link-identity fields zeroed: COFF, export and debug-entry time stamps, the checksum, the
 *  CodeView GUID + age and the /Brepro hash. Those come from the PDB, which records the build dir and is not
 *  byte-deterministic, so two builds of the same sources differ only there. Equal codeSha256 = same code and data. */
export function codeSha256(buf) {
  const b = Buffer.from(buf);
  const pe = b.readUInt32LE(0x3c);
  if (b.readUInt32LE(pe) !== 0x4550) throw new Error('not a PE image');
  const opt = pe + 24;
  if (b.readUInt16LE(opt) !== 0x20b) throw new Error('not PE32+');
  b.writeUInt32LE(0, pe + 8); // COFF TimeDateStamp
  b.writeUInt32LE(0, opt + 64); // CheckSum
  const n = b.readUInt16LE(pe + 6);
  const secs = [];
  for (let i = 0; i < n; i++) {
    const s = opt + b.readUInt16LE(pe + 20) + i * 40;
    secs.push({ va: b.readUInt32LE(s + 12), vsize: b.readUInt32LE(s + 8), raw: b.readUInt32LE(s + 20) });
  }
  const off = (rva) => { const s = secs.find((x) => rva >= x.va && rva < x.va + x.vsize); return s ? s.raw + rva - s.va : -1; };
  const exp = off(b.readUInt32LE(opt + 112));
  if (exp >= 0) b.writeUInt32LE(0, exp + 4); // export directory TimeDateStamp
  const dbgRva = b.readUInt32LE(opt + 112 + 6 * 8);
  const dbgSize = b.readUInt32LE(opt + 112 + 6 * 8 + 4);
  const d0 = off(dbgRva);
  for (let e = d0; d0 >= 0 && e < d0 + dbgSize; e += 28) {
    b.writeUInt32LE(0, e + 4); // TimeDateStamp
    const type = b.readUInt32LE(e + 12), size = b.readUInt32LE(e + 16), raw = b.readUInt32LE(e + 24);
    if (type === 2 && b.toString('latin1', raw, raw + 4) === 'RSDS') b.fill(0, raw + 4, raw + 24); // GUID + age
    if (type === 16) b.fill(0, raw, raw + size); // REPRO hash
  }
  return createHash('sha256').update(b).digest('hex');
}
export const readManifest = () => JSON.parse(readFileSync(MANIFEST_FILE, 'utf8'));

/** Which obs-nvenc.dll the runtime holds: 'patched', 'official', 'missing' or 'unknown' (+ its sha256). */
export function runtimeNvencState(runtime, manifest = readManifest()) {
  return nvencFileState(path.join(runtime, ...PLUGIN_REL, 'obs-nvenc.dll'), manifest);
}

/** The same check for any obs-nvenc.dll file (e.g. the staged copy in a package). */
export function nvencFileState(dll, manifest = readManifest()) {
  if (!existsSync(dll)) return { state: 'missing', dll };
  const sha = sha256(dll);
  if (manifest.patched?.dll?.sha256 && sha === manifest.patched.dll.sha256) return { state: 'patched', sha, dll };
  if (manifest.patched?.dll?.codeSha256 && codeSha256(readFileSync(dll)) === manifest.patched.dll.codeSha256) return { state: 'patched', sha, dll, rebuilt: true };
  if (sha === manifest.official.dll.sha256) return { state: 'official', sha, dll };
  return { state: 'unknown', sha, dll };
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
  if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
  if (r.status !== 0 && !opts.allowFail) throw new Error(`${cmd} ${args.join(' ')} -> exit ${r.status}\n${(r.stderr || '') + (r.stdout || '')}`.trim());
  return r;
}
const git = (cwd, ...args) => run('git', ['-c', 'advice.detachedHead=false', ...args], { cwd }).stdout.trim();

function vcvars() {
  const pf86 = process.env['ProgramFiles(x86)'];
  const vswhere = pf86 && path.join(pf86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (!vswhere || !existsSync(vswhere)) return null;
  const r = spawnSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8', windowsHide: true });
  const dir = r.stdout?.trim().split(/\r?\n/)[0];
  const bat = dir && path.join(dir, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
  return bat && existsSync(bat) ? bat : null;
}
const onPath = (exe) => spawnSync('where', [exe], { stdio: 'ignore', windowsHide: true }).status === 0;
/** Runs one line in cmd.exe inside the MSVC developer environment. */
function msvc(line, { capture = false } = {}) {
  let full = line;
  if (!(onPath('cmake') && onPath('cl') && onPath('ninja'))) {
    const bat = vcvars();
    if (!bat) throw new Error('cmake/ninja/cl not on PATH and VS Build Tools (vcvars64.bat) not found: nothing is installed by this script');
    full = `call "${bat}" >nul && ${line}`;
  }
  const r = spawnSync('cmd.exe', ['/d', '/s', '/c', `"${full}"`], { cwd: REPO_ROOT, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', windowsVerbatimArguments: true, windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`build step failed (exit ${r.status}): ${line}\n${capture ? (r.stderr || '') + (r.stdout || '').slice(-4000) : ''}`);
  return r.stdout ?? '';
}

/** Clones (or re-verifies) one pinned checkout. A dir that exists with the wrong commit is an error, never reused. */
function checkout(dir, { url, tag, commit, sparse }) {
  if (!existsSync(dir)) {
    mkdirSync(path.dirname(dir), { recursive: true });
    const args = ['clone', '--quiet', '--depth', '1', '--branch', tag];
    if (sparse) args.push('--filter=blob:none', '--sparse');
    run('git', ['-c', 'advice.detachedHead=false', ...args, url, dir], { cwd: path.dirname(dir) });
    if (sparse) git(dir, 'sparse-checkout', 'set', ...sparse);
  }
  const head = git(dir, 'rev-parse', 'HEAD');
  if (head !== commit) throw new Error(`${dir}: HEAD ${head}, expected ${commit} (${tag}); move the dir aside and re-run`);
  return head;
}

/** Working-tree changes against HEAD, re-hashing every file (--really-refresh ignores cached stat data, so a file
 *  edited with its size and mtime kept is still caught), plus untracked and ignored files. */
function treeChanges(dir) {
  run('git', ['update-index', '-q', '--really-refresh'], { cwd: dir, allowFail: true });
  return run('git', ['status', '--porcelain', '-z', '--ignored', '--untracked-files=all'], { cwd: dir }).stdout.split('\0').filter(Boolean);
}

function fetchAndPatch(m) {
  const obsDir = path.join(SRC_ROOT, 'obs-studio');
  const nvDir = path.join(SRC_ROOT, 'nv-codec-headers');
  checkout(obsDir, { url: m.obsSource.url, tag: m.obsSource.tag, commit: m.obsSource.commit, sparse: m.obsSource.sparse });
  checkout(nvDir, { url: m.nvCodecHeaders.url, tag: m.nvCodecHeaders.tag, commit: m.nvCodecHeaders.commit });
  // The headers are compiled into the DLL and into the offset probe that is run, so their files must be the pinned tree.
  const nvChanges = treeChanges(nvDir);
  if (nvChanges.length) throw new Error(`${nvDir}: working tree differs from ${m.nvCodecHeaders.commit}: ${nvChanges.join(', ')}; move the dir aside and re-run`);

  const patchFile = path.join(REPO_ROOT, ...m.patch.file.split('/'));
  const patchSha = sha256(patchFile);
  if (patchSha !== m.patch.sha256) throw new Error(`${m.patch.file}: sha256 ${patchSha}, manifest says ${m.patch.sha256}`);
  // The committed diff must be byte-identical to the upstream commit's diff (fetched by full hash).
  git(obsDir, 'fetch', '--quiet', '--depth', '2', 'origin', m.patch.upstreamCommit);
  const parent = git(obsDir, 'rev-parse', `${m.patch.upstreamCommit}^`);
  if (parent !== m.patch.upstreamParent) throw new Error(`upstream parent ${parent}, manifest says ${m.patch.upstreamParent}`);
  const upstream = run('git', ['diff', '--no-color', '--no-ext-diff', '--full-index', parent, m.patch.upstreamCommit, '--', ...m.patch.files], { cwd: obsDir }).stdout;
  if (createHash('sha256').update(upstream).digest('hex') !== patchSha) throw new Error('committed diff differs from the upstream commit diff');

  // A clean tree gets the patch; a tree an earlier run patched is accepted only if exactly this patch is applied
  // (checked below by the reverse-apply check and the changed-file list).
  if (treeChanges(obsDir).length === 0) {
    git(obsDir, 'apply', '--check', patchFile);
    git(obsDir, 'apply', patchFile);
  }
  // Re-hashed, untracked and ignored included: the only change in the tree is the one patched file.
  const after = treeChanges(obsDir).map((l) => l.slice(3)).sort();
  if (JSON.stringify(after) !== JSON.stringify([...m.patch.files].sort())) throw new Error(`unexpected tree changes after patching: ${after.join(', ')}`);
  run('git', ['apply', '--check', '--reverse', patchFile], { cwd: obsDir }); // proves exactly this patch is applied
  // Blob ids: the 32.1.2 file is the patch's pre-image, and the patched file is byte-for-byte upstream's post-image.
  const [file] = m.patch.files;
  const pre = git(obsDir, 'rev-parse', `HEAD:${file}`);
  const post = git(obsDir, 'hash-object', file);
  if (pre !== m.patch.preImageBlob || post !== m.patch.postImageBlob) throw new Error(`${file}: blob pre ${pre} post ${post}, manifest says ${m.patch.preImageBlob} / ${m.patch.postImageBlob}`);
  return { obsDir, nvDir, patchSha };
}

/** Verifies the built DLL: same imports and exports as the official one, and nvenc_destroy calls
 *  nvEncUnregisterResource before nvEncDestroyEncoder (offsets in NV_ENCODE_API_FUNCTION_LIST from the headers). */
function verifyBuilt(dll, official, nvDir) {
  const deps = (f) => [...msvc(`dumpbin /nologo /dependents "${f}"`, { capture: true }).matchAll(/^\s+(\S+\.dll)\s*$/gim)].map((x) => x[1].toLowerCase()).sort();
  const exps = (f) => [...msvc(`dumpbin /nologo /exports "${f}"`, { capture: true }).matchAll(/^\s+\d+\s+[0-9A-F]+\s+[0-9A-F]+\s+(\S+)/gm)].map((x) => x[1]).sort();
  const d1 = deps(dll), d0 = deps(official);
  if (JSON.stringify(d1) !== JSON.stringify(d0)) throw new Error(`imports differ from the official DLL: built [${d1}] official [${d0}]`);
  const e1 = exps(dll), e0 = exps(official);
  if (JSON.stringify(e1) !== JSON.stringify(e0)) throw new Error(`exports differ from the official DLL: built [${e1}] official [${e0}]`);

  // Struct offsets: a tiny probe compiled against the same headers (in the build dir, run from there).
  const probeC = path.join(BUILD_DIR, 'probe-offsets.c');
  writeFileSync(probeC, '#include <stdio.h>\n#include <stddef.h>\n#include <ffnvcodec/nvEncodeAPI.h>\nint main(void){printf("%zu %zu %zu %zu\\n", offsetof(NV_ENCODE_API_FUNCTION_LIST, nvEncEncodePicture), offsetof(NV_ENCODE_API_FUNCTION_LIST, nvEncUnregisterResource), offsetof(NV_ENCODE_API_FUNCTION_LIST, nvEncDestroyEncoder), sizeof(NV_ENCODE_API_FUNCTION_LIST));return 0;}\n');
  msvc(`cl /nologo /I"${path.join(nvDir, 'include')}" /Fo"${path.join(BUILD_DIR, 'probe-offsets.obj')}" /Fe"${path.join(BUILD_DIR, 'probe-offsets.exe')}" "${probeC}"`, { capture: true });
  const [encode, unreg, destroy, size] = run(path.join(BUILD_DIR, 'probe-offsets.exe'), []).stdout.trim().split(/\s+/).map(Number);

  // dumpbin prints the function labels (from the PDB next to the DLL) and the table slots as absolute addresses:
  // `call qword ptr [1800105E0h]`. In this source the first table call in nvenc_destroy is nv.nvEncEncodePicture (the
  // EOS flush), which gives the address of the global `nv` table; every other slot is then an offset into it.
  const order = (f) => {
    const asm = msvc(`dumpbin /nologo /disasm:nobytes "${f}"`, { capture: true });
    const start = asm.search(/^nvenc_destroy:\s*$/m);
    if (start < 0) throw new Error(`${f}: nvenc_destroy not found in disassembly (PDB next to the DLL?)`);
    const lines = asm.slice(start).split(/\r?\n/).slice(1);
    const end = lines.findIndex((l) => /^\S.*:\s*$/.test(l)); // next function label
    const body = lines.slice(0, end < 0 ? undefined : end).join('\n');
    const slots = [...body.matchAll(/call\s+qword ptr \[([0-9A-F]+)h\]/gi)].map((x) => parseInt(x[1], 16));
    if (!slots.length) throw new Error(`${f}: no table calls in nvenc_destroy`);
    const base = slots[0] - encode;
    const calls = slots.map((a) => a - base);
    if (calls.some((o) => o < 0 || o >= size || o % 8)) throw new Error(`${f}: a call in nvenc_destroy is not a table slot: ${calls}`);
    // Only the inlined form (as in the shipped DLL) is accepted: a direct call to d3d11_free_textures would hide the
    // unregister calls from this check, so it is reported instead of guessed.
    if (/call\s+\S*d3d11_free_textures/.test(body)) throw new Error(`${f}: d3d11_free_textures is not inlined (build config differs from the shipped DLL)`);
    const firstUnreg = calls.indexOf(unreg);
    const firstDestroy = calls.indexOf(destroy);
    return { calls, firstUnreg, firstDestroy, unregBeforeDestroy: firstUnreg >= 0 && firstDestroy >= 0 && firstUnreg < firstDestroy, lastUnregBeforeDestroy: firstDestroy >= 0 && calls.lastIndexOf(unreg) < firstDestroy };
  };
  const built = order(dll);
  const off = order(official);
  if (!built.unregBeforeDestroy || !built.lastUnregBeforeDestroy) throw new Error(`built nvenc_destroy: unregister/destroy order wrong ${JSON.stringify(built)}`);
  if (off.unregBeforeDestroy) throw new Error(`official nvenc_destroy already unregisters first? ${JSON.stringify(off)} (check the disassembly pattern)`);
  return { imports: d1, exports: e1, offsets: { nvEncUnregisterResource: unreg, nvEncDestroyEncoder: destroy }, built, official: off };
}

function build(m, runtime) {
  const { obsDir, nvDir, patchSha } = fetchAndPatch(m);
  mkdirSync(BUILD_DIR, { recursive: true });
  const rel = (p) => path.relative(REPO_ROOT, p);
  const configure = !existsSync(path.join(BUILD_DIR, 'build.ninja'));
  const steps = [];
  if (configure || process.argv.includes('--reconfigure')) {
    steps.push(`cmake -S "${rel(path.join(HERE, 'obs-nvenc'))}" -B "${rel(BUILD_DIR)}" -G Ninja -DCMAKE_BUILD_TYPE=Release -DOBS_SOURCE_DIR="${obsDir}" -DOBS_RUNTIME_DIR="${runtime}" -DNVCODEC_DIR="${nvDir}" -DPATCH_NOTE="${m.versionResourceNote}"`);
  }
  steps.push(`cmake --build "${rel(BUILD_DIR)}"`);
  msvc(steps.join(' && '));
  const dll = path.join(BUILD_DIR, 'obs-nvenc.dll');
  const pdb = path.join(BUILD_DIR, 'obs-nvenc.pdb');
  const official = path.join(officialDir(runtime), 'obs-nvenc.dll');
  const v = verifyBuilt(dll, official, nvDir);
  return { dll, pdb, dllSha: sha256(dll), codeSha: codeSha256(readFileSync(dll)), pdbSha: sha256(pdb), patchSha, verify: v };
}

/** Where the official files live: the backup copy if the runtime already holds the patched DLL. */
function officialDir(runtime) {
  const m = readManifest();
  const backup = path.join(runtime, '..', m.backupDir, ...PLUGIN_REL);
  if (existsSync(path.join(backup, 'obs-nvenc.dll')) && sha256(path.join(backup, 'obs-nvenc.dll')) === m.official.dll.sha256) return backup;
  const inRuntime = path.join(runtime, ...PLUGIN_REL);
  if (sha256(path.join(inRuntime, 'obs-nvenc.dll')) === m.official.dll.sha256) return inRuntime;
  throw new Error('official obs-nvenc.dll (sha256 in the manifest) not found in the runtime or its backup dir');
}

function install(m, runtime, b) {
  const plug = path.join(runtime, ...PLUGIN_REL);
  const backup = path.join(runtime, '..', m.backupDir, ...PLUGIN_REL);
  mkdirSync(backup, { recursive: true });
  for (const [name, want] of [['obs-nvenc.dll', m.official.dll.sha256], ['obs-nvenc.pdb', m.official.pdb.sha256]]) {
    const saved = path.join(backup, name);
    if (existsSync(saved)) {
      if (sha256(saved) !== want) throw new Error(`backup ${saved} exists with an unexpected sha256; not touching it`);
      continue;
    }
    const cur = path.join(plug, name);
    if (sha256(cur) !== want) throw new Error(`${cur} is not the official file and no backup exists; refusing to overwrite`);
    copyFileSync(cur, saved);
    if (sha256(saved) !== want) throw new Error(`backup copy of ${name} does not verify`);
    console.log(`[obs-patch] original ${name} copied aside to ${saved}`);
  }
  // Copy each new file beside its destination and verify it, then swap by rename (same volume). If any step
  // fails, the verified originals from the backup dir are put back, so the runtime is never left half-installed.
  const pairs = [['obs-nvenc.dll', b.dll, b.dllSha, m.official.dll.sha256], ['obs-nvenc.pdb', b.pdb, b.pdbSha, m.official.pdb.sha256]];
  const tmp = (name) => path.join(plug, `${name}.ujw-new`);
  try {
    for (const [name, src, sha] of pairs) {
      copyFileSync(src, tmp(name));
      if (sha256(tmp(name)) !== sha) throw new Error(`staged ${name} does not verify`);
    }
    for (const [name] of pairs) renameSync(tmp(name), path.join(plug, name));
    const st = runtimeNvencState(runtime, m);
    if (st.state !== 'patched') throw new Error(`after install the runtime DLL is '${st.state}'`);
  } catch (e) {
    for (const [name, , , officialSha] of pairs) {
      if (existsSync(tmp(name))) rmSync(tmp(name), { force: true });
      const dest = path.join(plug, name);
      const saved = path.join(backup, name);
      if (!existsSync(dest) || sha256(dest) !== officialSha) {
        copyFileSync(saved, dest);
        if (sha256(dest) !== officialSha) throw new Error(`install failed (${e.message}) and restoring ${name} did not verify; the original is in ${saved}`);
      }
    }
    throw new Error(`install failed, originals restored: ${e.message}`);
  }
  console.log(`[obs-patch] installed patched obs-nvenc.dll into ${plug}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const cfg = resolveConfig(opt('--runtime') ? { runtime: opt('--runtime') } : {});
  const runtime = cfg.runtime;
  if (!runtime || !existsSync(path.join(runtime, 'bin', '64bit', 'obs.dll'))) {
    console.error('OBS runtime not found (--runtime, UJWALAM_OBS_RUNTIME or app/host/host.local.json "obsRuntime")');
    process.exit(64);
  }
  const m = readManifest();
  const objs = sha256(path.join(runtime, 'bin', '64bit', 'obs.dll'));
  if (objs !== m.official.obsDll.sha256) {
    console.error(`runtime obs.dll sha256 ${objs} is not the pinned OBS ${m.obsSource.tag} obs.dll; this patch is for that runtime only`);
    process.exit(65);
  }
  if (argv.includes('--check')) {
    const st = runtimeNvencState(runtime, m);
    console.log(`[obs-patch] runtime obs-nvenc.dll: ${st.state}${st.sha ? ` (sha256 ${st.sha})` : ''}`);
    process.exit(st.state === 'patched' ? 0 : 1);
  }
  const b = build(m, runtime);
  console.log(`[obs-patch] built ${b.dll}\n  dll sha256 ${b.dllSha}\n  dll codeSha256 ${b.codeSha}\n  pdb sha256 ${b.pdbSha}`);
  console.log(`[obs-patch] imports ${b.verify.imports.join(', ')} | exports ${b.verify.exports.join(', ')}`);
  console.log(`[obs-patch] nvenc_destroy table calls (offsets) built: ${b.verify.built.calls.join(',')} | official: ${b.verify.official.calls.join(',')} (unregister=${b.verify.offsets.nvEncUnregisterResource}, destroy=${b.verify.offsets.nvEncDestroyEncoder})`);
  if (argv.includes('--record')) {
    m.patched = {
      dll: { sha256: b.dllSha, codeSha256: b.codeSha, bytes: statSync(b.dll).size },
      pdb: { sha256: b.pdbSha },
      toolchain: msvc('cl 2>&1 | findstr /c:"Version"', { capture: true }).trim(),
      recorded: new Date().toISOString().slice(0, 10),
    };
    writeFileSync(MANIFEST_FILE, `${JSON.stringify(m, null, 2)}\n`);
    console.log(`[obs-patch] manifest updated: ${path.relative(REPO_ROOT, MANIFEST_FILE)}`);
  } else if (m.patched?.dll?.codeSha256 !== b.codeSha) {
    console.error(`[obs-patch] built DLL codeSha256 ${b.codeSha} != manifest ${m.patched?.dll?.codeSha256 ?? '(none)'}: the code differs from the recorded build (other toolchain or inputs). Re-run with --record only after reviewing why.`);
    process.exit(1);
  } else if (m.patched.dll.sha256 !== b.dllSha) {
    console.log('[obs-patch] same code as the recorded build (codeSha256 matches); only the link identity (PDB GUID, time stamps) differs');
  }
  if (argv.includes('--install')) install(m, runtime, b);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`[obs-patch] ${e.message}`); process.exit(1); });
}
