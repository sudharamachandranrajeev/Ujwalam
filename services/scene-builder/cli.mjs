// SPDX-License-Identifier: GPL-3.0-or-later
// Scene builder command line (SB1 + SB2, D339; SB3, D341; SB4, D345). Besides readReference() in read.mjs and buildPackage() in
// build.mjs, the entry point for the studio's later scene builder UI and SB4 (restyle the studio).
//
//   node services/scene-builder/cli.mjs read <image-or-video> [--frames N] [--long-side PX] [--data-dir DIR]
//   node services/scene-builder/cli.mjs build <image-or-video> --project FILE [--bind ROLE=ID]... [--theme ID]
//        [--out PACKAGE.json] [--apply] [--json] [--frames N] [--long-side PX] [--data-dir DIR]
//   node services/scene-builder/cli.mjs import <PACKAGE.json> --project FILE [--apply] [--json] [--data-dir DIR]
//   node services/scene-builder/cli.mjs theme <image-or-video> [--name N] [--themes-dir DIR] [--apply] [--json]
//        [--frames N] [--long-side PX] [--data-dir DIR]
//
// read prints the typed read (data/schemas/reference-read.schema.json) as JSON on stdout. It writes nothing.
// build reads the reference, builds a scene package (data/schemas/scene-package.schema.json) for that project and
// prints the dry-run diff: the one new namespaced scene (H + V), each layer, what it links to in the project, every
// placeholder and why, and the existing-state hash. Nothing is written unless --apply is given; --out saves the
// package (it never overwrites a file). import applies (or dry-runs) a saved package the same way.
// --bind ROLE=ID picks the project layer or device for game, camera, chat or alerts when the rules cannot tell.
// --theme ID passes ?theme=ID to the overlays (brand theme tokens); without it the brand's current theme is used.
// --apply adds the scene to the project file; existing scenes, layers, devices and settings are never changed. It needs
// the studio closed: it is refused while the host or event core of the project's data folder runs (host.json /
// api.json with a live pid), and it never overwrites a file that changed since it was read (compare-and-swap; see
// services/project/scene-package.mjs applyScenePackageFile). The studio shows the new scene at its next start.
// theme (SB4, D345) reads the reference and makes a studio theme pack (data/themes format, schema v2 with components)
// from it: palette roles to colour tokens, the style read to component variants, colours pushed until the pack passes
// the T1 contrast check. It prints where every colour came from, every push and the variants with why. Dry run by
// default; --apply saves <id>.json in the user themes folder (UJWALAM_THEMES_DIR, else %APPDATA%Ujwalam Studio	hemes;
// --themes-dir picks another), never over an existing file and never with a built-in theme's id. --name sets the
// theme's name (the id follows it). A pack that cannot pass the contrast check is never written (exit 1).
// SB5 iterate (D347). None of these writes the project; to use a result, import the saved package (above).
//   node services/scene-builder/cli.mjs export <scene-id-or-name> --project FILE [--out PACKAGE.json] [--json]
//   node services/scene-builder/cli.mjs edit <PACKAGE.json> --project FILE --out PACKAGE.json [--json]
//        [--move C:KEY=X,Y] [--resize C:KEY=W,H] [--place C:KEY=X,Y,W,H] [--swap C:KEYA,KEYB]...
//   node services/scene-builder/cli.mjs variants <PACKAGE.json> --project FILE [--count N] [--seed TEXT] [--out-dir DIR] [--json]
// export saves a scene of the project (for example a built scene the user then adjusted in the studio) as a scene
// package; layers it cannot carry are listed with the reason. edit applies moves, resizes and slot swaps to a package
// (C is h or v, numbers are fractions of the canvas) and saves a new package. variants makes up to 8 similar packages
// (seeded: the same seed gives the same variants); it saves them as <id>.json in --out-dir, never over a file, and
// without --out-dir only lists them. --project gives the canvas sizes and is only read.
// Behind the feature flag `scene-builder` (off by default): with the flag off it says so and exits 2. --data-dir
// picks the folder whose flags.local.json is read (the usual CLI order otherwise).
// Exit codes: 0 done, 1 bad arguments or the work failed, 2 the flag is off.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCliDataDir } from '../event-core/config.mjs';
import { createFlags } from '../flags/index.mjs';
import { applyScenePackageFile, diffText, packageProblems } from '../project/scene-package.mjs';
import { loadProject } from '../project/index.mjs';
import { buildPackage } from './build.mjs';
import { packageFromScene } from './export.mjs';
import { editPackage, similarVariants } from './iterate.mjs';
import { readReference } from './read.mjs';
import { reportText, themeFromRead, userThemesDir, writeProblems, writeThemePack } from './theme.mjs';

export const FLAG = 'scene-builder';
const USAGE = [
  'usage: cli.mjs read <image-or-video> [--frames N] [--long-side PX] [--data-dir DIR]',
  '       cli.mjs build <image-or-video> --project FILE [--bind ROLE=ID]... [--theme ID] [--out PACKAGE.json] [--apply] [--json]',
  '       cli.mjs import <PACKAGE.json> --project FILE [--apply] [--json]',
  '       cli.mjs theme <image-or-video> [--name N] [--themes-dir DIR] [--apply] [--json]',
  '       cli.mjs export <scene-id-or-name> --project FILE [--out PACKAGE.json] [--json]',
  '       cli.mjs edit <PACKAGE.json> --project FILE --out PACKAGE.json [--move C:KEY=X,Y] [--resize C:KEY=W,H] [--place C:KEY=X,Y,W,H] [--swap C:A,B]',
  '       cli.mjs variants <PACKAGE.json> --project FILE [--count N] [--seed TEXT] [--out-dir DIR] [--json]',
].join('\n');
const VALUE = new Set(['--frames', '--long-side', '--data-dir', '--project', '--theme', '--out', '--name', '--themes-dir', '--count', '--seed', '--out-dir']);
const EDIT_FLAGS = new Set(['--move', '--resize', '--place', '--swap']);
const SWITCH = new Set(['--apply', '--json']);
const BIND_ROLES = new Set(['game', 'camera', 'chat', 'alerts']);

const NUM = '(-?\\d*\\.?\\d+)';
const KEY = '[a-z][a-z0-9-]*';
const EDIT_RE = {
  move: new RegExp(`^([hv]):(${KEY})=${NUM},${NUM}$`),
  resize: new RegExp(`^([hv]):(${KEY})=${NUM},${NUM}$`),
  place: new RegExp(`^([hv]):(${KEY})=${NUM},${NUM},${NUM},${NUM}$`),
  swap: new RegExp(`^([hv]):(${KEY}),(${KEY})$`),
};
const EDIT_FORM = { move: 'C:KEY=X,Y', resize: 'C:KEY=W,H', place: 'C:KEY=X,Y,W,H', swap: 'C:KEYA,KEYB' };
function parseEdit(op, v) {
  const m = EDIT_RE[op].exec(v);
  if (!m) throw new Error(`--${op} needs ${EDIT_FORM[op]} (C is h or v; numbers are fractions of the canvas)`);
  if (op === 'swap') return { op, canvas: m[1], a: m[2], b: m[3] };
  const n = m.slice(3).map(Number);
  if (op === 'move') return { op, canvas: m[1], key: m[2], x: n[0], y: n[1] };
  if (op === 'resize') return { op, canvas: m[1], key: m[2], w: n[0], h: n[1] };
  return { op, canvas: m[1], key: m[2], x: n[0], y: n[1], w: n[2], h: n[3] };
}

export function parseArgs(argv) {
  const out = { _: [], bind: {}, edits: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (EDIT_FLAGS.has(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      out.edits.push(parseEdit(a.slice(2), v));
    } else if (VALUE.has(a) || a === '--bind') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      if (a === '--bind') {
        const m = /^([a-z]+)=([a-z][a-z0-9_-]{0,63})$/.exec(v);
        if (!m || !BIND_ROLES.has(m[1])) throw new Error('--bind needs ROLE=ID with ROLE one of game, camera, chat, alerts');
        out.bind[m[1]] = m[2];
      } else out[a.slice(2)] = v;
    } else if (SWITCH.has(a)) out[a.slice(2)] = true;
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else out._.push(a);
  }
  return out;
}

/** Returns the exit code. deps: { flagsOn?(dataDir) -> bool } for tests. */
export async function main(argv, out = (s) => process.stdout.write(`${s}\n`), err = (s) => console.error(s), deps = {}) {
  let args;
  try { args = parseArgs(argv); } catch (e) { err(`scene-builder: ${e.message}\n${USAGE}`); return 1; }
  const cmd = args._[0];
  const ITERATE = ['export', 'edit', 'variants'];
  if (!['read', 'build', 'import', 'theme', ...ITERATE].includes(cmd) || args._.length !== 2) { err(USAGE); return 1; }
  if (cmd !== 'theme' && (args.name !== undefined || args['themes-dir'] !== undefined)) { err(`scene-builder: --name and --themes-dir are for theme
${USAGE}`); return 1; }
  if (cmd === 'theme' && (args.project || args.out || args.theme || Object.keys(args.bind).length)) { err(`scene-builder: theme takes no project options
${USAGE}`); return 1; }
  if (cmd !== 'read' && cmd !== 'theme' && !args.project) { err(`scene-builder: ${cmd} needs --project FILE\n${USAGE}`); return 1; }
  if (cmd === 'read' && (args.project || args.apply || args.out || args.theme || args.json || Object.keys(args.bind).length)) { err(`scene-builder: read takes no project options\n${USAGE}`); return 1; }
  if (cmd === 'import' && (args.out || args.theme || args.frames || args['long-side'] || Object.keys(args.bind).length)) { err(`scene-builder: import takes the package as it is\n${USAGE}`); return 1; }
  if (ITERATE.includes(cmd) && (args.apply || args.theme || args.frames || args['long-side'] || args.name || Object.keys(args.bind).length)) { err(`scene-builder: ${cmd} never changes the project; import the saved package to use it\n${USAGE}`); return 1; }
  if (cmd !== 'edit' && args.edits.length) { err(`scene-builder: --move, --resize, --place and --swap are for edit\n${USAGE}`); return 1; }
  if (cmd !== 'variants' && (args.count !== undefined || args.seed !== undefined || args['out-dir'] !== undefined)) { err(`scene-builder: --count, --seed and --out-dir are for variants\n${USAGE}`); return 1; }
  if (cmd === 'edit' && (!args.out || !args.edits.length)) { err(`scene-builder: edit needs --out and at least one edit\n${USAGE}`); return 1; }
  if (cmd === 'variants' && args.out) { err(`scene-builder: variants saves into --out-dir\n${USAGE}`); return 1; }
  const num = (k, d) => (args[k] === undefined ? d : Number(args[k]));
  const frames = num('frames', 8), longSide = num('long-side', 960);
  if (!Number.isInteger(frames) || !Number.isInteger(longSide)) { err('scene-builder: --frames and --long-side must be whole numbers'); return 1; }
  if (args.out && existsSync(args.out)) { err('scene-builder: --out file already exists; choose a new name'); return 1; }
  let on;
  try {
    const dir = resolveCliDataDir({ dataDir: args['data-dir'] }).dir;
    on = deps.flagsOn ? deps.flagsOn(dir) : createFlags({ dataDir: dir }).isOn(FLAG);
  } catch (e) { err(`scene-builder: ${e.message}`); return 1; }
  if (!on) { err(`scene-builder: the ${FLAG} feature flag is off (switch it on in Settings > Advanced or the control page)`); return 2; }
  try {
    if (cmd === 'read') {
      out(JSON.stringify(await readReference(args._[1], { frames, longSide }), null, 2));
      return 0;
    }
    if (cmd === 'theme') return await themeCommand(args, { frames, longSide }, out, err, deps);
    if (ITERATE.includes(cmd)) return iterateCommand(cmd, args, out, deps);
    let pkg;
    if (cmd === 'build') {
      const read = await readReference(args._[1], { frames, longSide });
      const { project } = loadProject(args.project);
      pkg = buildPackage(read, project, { bind: args.bind, theme: args.theme ?? null });
      if (args.out) writeFileSync(args.out, `${JSON.stringify(pkg, null, 2)}\n`, { flag: 'wx' });
    } else {
      pkg = JSON.parse(readFileSync(args._[1], 'utf8'));
      const bad = packageProblems(pkg);
      if (bad.length) { err(`scene-builder: not a scene package: ${bad.join('; ')}`); return 1; }
    }
    const dryRun = !args.apply;
    const { diff } = applyScenePackageFile(args.project, pkg, { dryRun });
    out(args.json ? JSON.stringify({ dryRun, diff }, null, 2) : diffText(diff, { dryRun }));
    return 0;
  } catch (e) { err(`scene-builder: ${e.message}`); return 1; }
}

function summary(pkg) {
  const n = pkg.presets.map((p) => `${p.params.canvas.toUpperCase()} ${p.params.layers.length}`).join(', ');
  return `"${pkg.name}" (${pkg.id}; layers ${n})`;
}

// SB5 (D347): export, edit, variants. Never touches the project file; files are written only with --out / --out-dir.
function iterateCommand(cmd, args, out, deps) {
  const { project } = loadProject(args.project);
  const canvases = Object.fromEntries(project.canvases.map((c) => [c.id, { width: c.width, height: c.height }]));
  const save = (file, pkg) => writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`, { flag: 'wx' });
  const readPackage = () => {
    const pkg = JSON.parse(readFileSync(args._[1], 'utf8'));
    const bad = packageProblems(pkg);
    if (bad.length) throw new Error(`not a scene package: ${bad.join('; ')}`);
    return pkg;
  };
  const now = deps.now?.();
  if (cmd === 'export') {
    const { package: pkg, skipped } = packageFromScene(project, args._[1], { now });
    if (args.out) save(args.out, pkg);
    out(args.json ? JSON.stringify({ saved: args.out ?? null, package: pkg, skipped }, null, 2)
      : [`${args.out ? `Saved ${args.out}: ` : 'Not saved (no --out): '}${summary(pkg)}`, ...skipped.map((s) => `  - not carried: ${s.canvas.toUpperCase()} ${s.name}: ${s.reason}`)].join('\n'));
    return 0;
  }
  if (cmd === 'edit') {
    const r = editPackage(readPackage(), args.edits, { canvases, now });
    save(args.out, r.package);
    out(args.json ? JSON.stringify({ saved: args.out, changes: r.changes, warnings: r.warnings, package: r.package }, null, 2)
      : [`Saved ${args.out}: ${summary(r.package)}`, ...r.changes.map((c) => `  * ${c}`), ...r.warnings.map((w) => `  ! ${w}`)].join('\n'));
    return 0;
  }
  const dir = args['out-dir'];
  if (dir && !existsSync(dir)) throw new Error('--out-dir must be an existing folder');
  const list = similarVariants(readPackage(), { count: args.count === undefined ? 3 : Number(args.count), seed: args.seed ?? 'sb5', canvases, now });
  const files = list.map((v) => (dir ? path.join(dir, `${v.package.id}.json`) : null));
  if (dir) {
    for (const f of files) if (existsSync(f)) throw new Error(`${f} already exists; nothing was saved`);
    list.forEach((v, i) => save(files[i], v.package));
  }
  out(args.json ? JSON.stringify(list.map((v, i) => ({ file: files[i], kind: v.kind, distance: v.distance, package: v.package })), null, 2)
    : [`${list.length} similar variant(s)${dir ? ' saved' : ' (not saved: no --out-dir)'}`, ...list.map((v, i) => `  ${i + 1}. ${v.kind}, largest edge move ${v.distance}: ${files[i] ?? summary(v.package)}`)].join('\n'));
  return 0;
}

async function themeCommand(args, { frames, longSide }, out, err, deps) {
  const read = await readReference(args._[1], { frames, longSide });
  const { pack, report } = themeFromRead(read, { name: args.name ?? null });
  const dir = args['themes-dir'] ? path.resolve(args['themes-dir']) : userThemesDir(deps.env ?? process.env);
  const dryRun = !args.apply;
  const blocked = report.contrast.failures.length ? ['the pack does not pass the contrast check'] : [];
  const problems = [...blocked, ...writeProblems(pack, dir)];
  let file = null;
  if (!dryRun) {
    if (problems.length) { err(`scene-builder: not written: ${problems.join('; ')}`); out(args.json ? JSON.stringify({ dryRun, file, problems, pack, report }, null, 2) : reportText(pack, report, { file, dryRun: true })); return 1; }
    file = writeThemePack(pack, dir);
  }
  const target = file ?? path.join(dir, `${pack.id}.json`);
  out(args.json ? JSON.stringify({ dryRun, file: target, problems, pack, report }, null, 2) : `${reportText(pack, report, { file: target, dryRun })}${problems.length ? `
Would not be written: ${problems.join('; ')}` : ''}`);
  return blocked.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2)));
