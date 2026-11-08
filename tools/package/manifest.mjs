// SPDX-License-Identifier: GPL-3.0-or-later
// What goes into the Alpha 0 zip (D133), and the checks that keep everything else out.
//
//   repoFiles(repo)                 -> [rel]   repo files the installed app needs at run time (allowlisted dirs and
//                                              files; no tests, fixtures, docs, Python, *.local.*)
//   importProblems(repo, rels)      -> [msg]   every relative import of a packaged .mjs resolves to a packaged file;
//                                              bare specifiers other than node:* are refused (no node_modules ships)
//   disabledModules(repo)           -> [name]  the host's always-disabled libobs modules, read from
//                                              app/host/src/obs_runtime.cpp (one source of truth)
//   selectObsRuntime(runtime, opts) -> { files: [{ src, dest, why }], modules, systemDlls, skipped }
//     Exactly the runtime files the host can load: the import closure (normal + delay-load tables, tools/package/pe.mjs)
//     of the host exe, its helper exes, the d3d11 graphics module and every libobs module it does not disable, plus
//     the CEF data files when obs-browser ships (en-US locale only), data/libobs and data/obs-plugins/<shipped module>.
//     Never: .pdb, the Qt frontend (obs64.exe), Qt plugin folders, disabled modules, data/obs-studio, scripting.
//     The Qt studio shell does not use the runtime's Qt (OBS's own Qt build, no offscreen plugin): it ships
//     self-contained in studio/ with the Qt 6.8.3 kit it was built with (STUDIO_FILES, D277).
//   allowProblems(paths) / forbiddenProblems(paths, { fontNames }) -> [msg]   (package-relative paths, '/' separators)
//   fontNamesFromLicenceDoc(text)   -> ['Corbel', 'Consolas', ...]   bold names on "fonts" lines of docs/licence-headers.md
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { peInfo } from './pe.mjs';

export const HELPER_EXES = Object.freeze(['obs-ffmpeg-mux.exe', 'obs-nvenc-test.exe', 'obs-amf-test.exe', 'obs-qsv-test.exe']);

// Repo -> package (same relative paths, so the code's own REPO-relative lookups keep working in the install dir).
export const REPO_DIRS = Object.freeze([
  'app/host/lib', 'app/host/overlay',
  'services/bots', 'services/common', 'services/event-core', 'services/flags', 'services/outputs', 'services/overlay-server', 'services/posting', 'services/project', 'services/studio-ui',
  'ui', 'registry', 'tools/diag',
]);
export const REPO_FILES = Object.freeze([
  'LICENSE',
  'app/host/projects/test-card.project.json',
  'data/flags.json',
  'data/guide/tour.json', 'data/guide/hints.json', // tips and tours in the studio window (D294 proposed)
  // F6 live markers (services/event-core/live-markers.mjs): shared ranking rules + live-only values
  'data/clip/ranking.json', 'data/clip/live-markers.json',
  'data/actions/catalogue.json', 'data/actions/catalogue.schema.json',
  'data/effects/guards.json', 'data/effects/flash-measurements.json',
  'data/moderation/blocklist.json', 'data/moderation/blocklist.schema.json',
  'data/overlays/feed-scopes.json',
  'data/outputs/alpha-live.json', 'data/outputs/alpha-practice.json', 'data/outputs/guard/live-test-budget.json',
  'data/posting/templates.json', 'data/posting/limits.json',
  'data/schemas/project.schema.json',
  'data/profile.example.json', 'data/profile.schema.json',
  'data/release/alpha.json',
  'tools/package/run-installed.mjs', 'tools/package/zip.mjs',
  // Qt shell exe path (services/studio-ui/launch.mjs imports EXE and qtDir)
  'app/studio/tools/build.mjs',
  // --mock (event core without Streamer.bot): imported by services/event-core/api/service.mjs
  'tools/mock/mock-streamerbot.mjs', 'tools/mock/mock-chat.mjs',
]);
export const REPO_GLOB_DIRS = Object.freeze([['data/platforms', /\.json$/], ['data/outputs/presets', /\.json$/]]);

const SKIP_IN_DIRS = [/\.test\.m?js$/i, /(^|\/)(tests?|fixtures|__pycache__|node_modules)\//i, /\.py$/i, /\.md$/i, /\.local\./i, /(^|\/)\./];

const posix = (p) => p.split(path.sep).join('/');

function walk(dir, base = dir, out = []) {
  for (const n of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, n.name);
    if (n.isSymbolicLink()) continue; // links never ship
    if (n.isDirectory()) walk(p, base, out);
    else if (n.isFile()) out.push(posix(path.relative(base, p)));
  }
  return out;
}

export function repoFiles(repo) {
  const out = new Set();
  for (const d of REPO_DIRS) {
    const abs = path.join(repo, d);
    if (!existsSync(abs)) throw new Error(`package: missing repo dir ${d}`);
    for (const r of walk(abs)) {
      const rel = `${d}/${r}`;
      if (SKIP_IN_DIRS.some((re) => re.test(rel))) continue;
      out.add(rel);
    }
  }
  for (const f of REPO_FILES) {
    if (!existsSync(path.join(repo, f))) throw new Error(`package: missing repo file ${f}`);
    out.add(f);
  }
  for (const [d, re] of REPO_GLOB_DIRS) {
    for (const r of walk(path.join(repo, d))) if (re.test(r) && !SKIP_IN_DIRS.some((x) => x.test(r))) out.add(`${d}/${r}`);
  }
  return [...out].sort();
}

const IMPORT_RE = /(?:^|[\s;])(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|(?:^|[\s;(=])import\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]([^'"]+)['"]/gm;

export function importProblems(repo, rels) {
  const set = new Set(rels);
  const problems = [];
  for (const rel of rels) {
    if (!/\.m?js$/.test(rel) || rel.startsWith('ui/')) continue; // ui/ holds plain browser scripts
    const text = readFileSync(path.join(repo, rel), 'utf8');
    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (spec.startsWith('node:')) continue;
      if (!spec.startsWith('.')) { problems.push(`${rel}: bare import "${spec}" (no node_modules ships)`); continue; }
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
      if (!set.has(target)) problems.push(`${rel}: import "${spec}" -> ${target} is not in the package`);
    }
  }
  return problems;
}

export function disabledModules(repo) {
  const src = readFileSync(path.join(repo, 'app', 'host', 'src', 'obs_runtime.cpp'), 'utf8');
  const m = /disabled_for\([^)]*\)\s*\{\s*std::vector<std::string>\s+d\s*=\s*\{([^}]*)\}/.exec(src);
  if (!m) throw new Error('package: cannot read the always-disabled module list from obs_runtime.cpp');
  const names = [...m[1].matchAll(/"([a-z0-9-]+)"/g)].map((x) => x[1]);
  if (names.length < 5) throw new Error('package: disabled module list looks wrong');
  return names;
}

export function selectObsRuntime(runtime, { hostExe, disabled, cefLocales = ['en-US'] }) {
  const bin = path.join(runtime, 'bin', '64bit');
  const plug = path.join(runtime, 'obs-plugins', '64bit');
  if (!existsSync(path.join(bin, 'obs.dll'))) throw new Error('package: obs.dll not found under <runtime>/bin/64bit');
  const pool = new Map(); // lower-case basename -> { abs, dest }
  for (const [dir, destDir] of [[bin, 'obs/bin/64bit'], [plug, 'obs/obs-plugins/64bit']]) {
    for (const n of readdirSync(dir)) {
      if (!/\.(dll|exe)$/i.test(n) || !statSync(path.join(dir, n)).isFile()) continue;
      pool.set(n.toLowerCase(), { abs: path.join(dir, n), dest: `${destDir}/${n}`, name: n });
    }
  }
  const info = new Map();
  const pe = (abs) => { if (!info.has(abs)) info.set(abs, peInfo(readFileSync(abs))); return info.get(abs); };

  const modules = [];
  for (const n of readdirSync(plug)) {
    if (!/\.dll$/i.test(n)) continue;
    if (pe(path.join(plug, n)).exports.includes('obs_module_load')) modules.push(n.replace(/\.dll$/i, ''));
  }
  const dis = new Set(disabled);
  const shipped = modules.filter((m) => !dis.has(m)).sort();
  const browser = shipped.includes('obs-browser');

  const files = new Map(); // dest -> { src, dest, why }
  const add = (src, dest, why) => { if (!files.has(dest)) files.set(dest, { src, dest, why }); };
  const queue = [];
  const systemDlls = new Set();
  const enqueue = (key, why) => {
    const e = pool.get(key.toLowerCase());
    if (!e) { systemDlls.add(key.toLowerCase()); return; }
    if (files.has(e.dest)) return;
    add(e.abs, e.dest, why);
    queue.push(e.abs);
  };
  // Roots
  queue.push(hostExe);
  for (const h of HELPER_EXES) {
    const abs = path.join(bin, h);
    if (!existsSync(abs)) throw new Error(`package: helper ${h} missing from the runtime`);
    add(abs, `bin/${h}`, 'helper exe (next to the host exe)');
    queue.push(abs);
  }
  enqueue('libobs-d3d11.dll', 'graphics module (loaded by name)');
  // libobs LoadLibrary()s libobs-winrt at startup (no import entry); without it the host logs "LoadLibrary failed".
  enqueue('libobs-winrt.dll', 'loaded by name by libobs (WinRT helpers)');
  for (const m of shipped) enqueue(`${m}.dll`, 'libobs module');
  if (browser) {
    for (const n of ['obs-browser-page.exe', 'libEGL.dll', 'libGLESv2.dll']) enqueue(n, 'CEF (obs-browser)');
  }
  while (queue.length) {
    const abs = queue.shift();
    const i = pe(abs);
    for (const d of [...i.imports, ...i.delayImports]) {
      const e = pool.get(d.toLowerCase());
      const why = `import of ${path.basename(abs)}`;
      if (e && /^obs-plugins/.test(path.relative(runtime, e.abs)) && modules.includes(e.name.replace(/\.dll$/i, '')) && dis.has(e.name.replace(/\.dll$/i, ''))) {
        throw new Error(`package: ${path.basename(abs)} imports the disabled module ${e.name}`);
      }
      enqueue(d, why);
    }
  }
  if (browser) {
    for (const n of readdirSync(plug)) {
      const abs = path.join(plug, n);
      if (statSync(abs).isFile() && /\.(pak|dat|bin)$/i.test(n)) add(abs, `obs/obs-plugins/64bit/${n}`, 'CEF data (obs-browser)');
    }
    for (const l of cefLocales) {
      const abs = path.join(plug, 'locales', `${l}.pak`);
      if (!existsSync(abs)) throw new Error(`package: CEF locale ${l}.pak missing`);
      add(abs, `obs/obs-plugins/64bit/locales/${l}.pak`, 'CEF locale');
    }
  }
  const dataRoot = path.join(runtime, 'data');
  // Not from data/: .pdb files, and the virtual camera DirectShow filter (it needs an admin registration by the OBS
  // frontend; the host never uses it).
  const dataSkip = (r) => /\.pdb$/i.test(r) || /(^|\/)obs-virtualcam-module/i.test(r);
  for (const r of walk(path.join(dataRoot, 'libobs'))) if (!dataSkip(r)) add(path.join(dataRoot, 'libobs', r), `obs/data/libobs/${r}`, 'libobs data (effects)');
  for (const m of shipped) {
    const d = path.join(dataRoot, 'obs-plugins', m);
    if (existsSync(d)) for (const r of walk(d)) if (!dataSkip(r)) add(path.join(d, r), `obs/data/obs-plugins/${m}/${r}`, `data of ${m}`);
  }
  // Everything else in the runtime is skipped; summarised for the evidence.
  const taken = new Set([...files.values()].map((f) => path.resolve(f.src).toLowerCase()));
  const skipped = { files: 0, bytes: 0, byReason: {}, notImported: [] };
  const reason = (rel) => {
    if (/\.pdb$/i.test(rel)) return 'debug symbols (.pdb)';
    const base = path.posix.basename(rel).replace(/\.dll$/i, '');
    if (rel.startsWith('obs-plugins/') && dis.has(base)) return 'disabled module';
    if (rel.startsWith('data/obs-plugins/') && dis.has(rel.split('/')[2])) return 'data of a disabled module';
    if (/^obs-plugins\/64bit\/locales\//.test(rel)) return 'CEF locale other than en-US';
    if (/^bin\/64bit\/(platforms|imageformats|styles|iconengines)\//.test(rel)) return 'Qt plugin folder (no Qt UI in the host)';
    if (/^data\/(obs-studio|obs-scripting)\//.test(rel)) return 'OBS frontend / scripting data';
    if (/obs-virtualcam-module/i.test(rel)) return 'virtual camera filter (not used)';
    return 'not imported by anything the host loads';
  };
  for (const rel of walk(runtime)) {
    if (taken.has(path.resolve(runtime, rel).toLowerCase())) continue;
    const r = reason(rel);
    skipped.files++;
    skipped.bytes += statSync(path.join(runtime, rel)).size;
    skipped.byReason[r] = (skipped.byReason[r] ?? 0) + 1;
    if (r === 'not imported by anything the host loads') skipped.notImported.push(rel);
  }
  return { files: [...files.values()].sort((a, b) => a.dest.localeCompare(b.dest)), modules: { all: modules.sort(), shipped, disabled: [...dis].sort() }, systemDlls: [...systemDlls].sort(), skipped };
}

export const TOP_FILES = Object.freeze(['Install-Ujwalam.ps1', 'Ujwalam.cmd', 'README.txt', 'HOW-TO.md', 'CHANGELOG-alpha.md', 'SHA256SUMS.txt', 'release.json', 'package.json', 'LICENSE']);

/** Every packaged path must match the allowlist (package-relative, '/' separators). */
export function allowProblems(paths) {
  const exact = new Set([...TOP_FILES, ...REPO_FILES]);
  const dirPrefixes = REPO_DIRS.map((d) => `${d}/`);
  const ok = (p) => exact.has(p)
    || dirPrefixes.some((d) => p.startsWith(d))
    || REPO_GLOB_DIRS.some(([d, re]) => p.startsWith(`${d}/`) && re.test(p))
    || /^notices\/[A-Za-z0-9._-]+$/.test(p)
    || new RegExp(`^bin/(ujwalam-host\\.exe|${HELPER_EXES.map((h) => h.replace(/[.-]/g, '\\$&')).join('|')})$`).test(p)
    || /^obs\/bin\/64bit\/[^/]+\.(dll|exe)$/i.test(p)
    || /^studio\/(ujwalam-studio\.exe|Qt6(Core|Gui|Widgets|Network)\.dll|platforms\/q(windows|offscreen)\.dll)$/.test(p)
    || /^obs\/obs-plugins\/64bit\/([^/]+\.(dll|exe|pak|dat|bin)|locales\/[A-Za-z-]+\.pak)$/i.test(p)
    || /^obs\/data\/(libobs|obs-plugins)\/[^]+$/.test(p);
  return paths.filter((p) => !ok(p)).map((p) => `not on the allowlist: ${p}`);
}

const FONT_EXT = /\.(ttf|otf|ttc|woff2?|fon|eot)$/i;
const FORBIDDEN = [
  [/(^|\/)legacy(\/|$)/i, 'legacy/ (private reference, never distributed)'],
  [/\.local\./i, '*.local.* (local-only file)'],
  [/(^|\/)profile\.local/i, 'local profile'],
  [/(^|\/)docs\//i, 'docs/ (only notices and README ship)'],
  [/(^|\/)evidence\/private(\/|$)/i, 'docs/evidence/private'],
  [/(^|\/)feedback\//i, 'feedback/ (live feedback captures)'],
  [/(^|\/)out\//i, 'out/ (build output; only the built host exe (bin/) and studio exe (studio/) ship)'],
  [/(^|\/)(recordings|replay|markers|logs|projects\/_old)\//i, 'user data folder'],
  [/(^|\/)(\.git|\.claude|\.venv|node_modules|secrets|session file)(\/|$)/i, 'repo-internal or secret folder'],
  [/(^|\/)(\.env[^/]*|\.agent-lock|host\.local\.json|flags\.local\.json|host-config\.json|outputs-params\.json|system\.json|host\.json)$/i, 'local state or secret file'],
  [/\.(mkv|mp4|mov|flv|ts|webm|wav|m4a|mp3|log|pdb|pem|key|pfx|p12|sqlite|db)$/i, 'media, log, symbols, key or database file'],
  [/(^|\/)data\/(labels|datasets|games)(\/|$)/i, 'labels, datasets or game packs'],
  [FONT_EXT, 'font file (none ship; Microsoft fonts are never redistributable)'],
];

export function forbiddenProblems(paths, { fontNames = [] } = {}) {
  const out = [];
  const fontRes = fontNames.map((n) => new RegExp(`(^|/)${n.toLowerCase().slice(0, 6)}[^/]*$`, 'i'));
  for (const p of paths) {
    for (const [re, why] of FORBIDDEN) if (re.test(p)) out.push(`forbidden (${why}): ${p}`);
    if (fontRes.some((re) => re.test(p)) && (FONT_EXT.test(p) || !/\.(m?js|json|css|html|txt)$/i.test(p))) out.push(`forbidden (Microsoft font named in docs/licence-headers.md): ${p}`);
  }
  return out;
}

export function fontNamesFromLicenceDoc(text) {
  const names = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (!/font/i.test(line)) continue;
    if (!/never|not redistributable|microsoft/i.test(line)) continue;
    for (const m of line.matchAll(/\*\*([A-Z][A-Za-z]+)\*\*/g)) names.add(m[1]);
  }
  return [...names];
}
