#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Starts ujwalam-host for a manual session (the test card by default) and keeps it running until Ctrl+C.
//   node app/host/tools/launch.mjs [--project <file.json>] [--base <name>=<dir> ...] [--preview h,v|h|v|none]
//                                  [--outputs <plan.json>] [--overlay]
// --overlay starts the host with --allow-browser and the overlay server child (overlay root from config), so
// project overlay layers load; fire one with: node app/host/tools/hostctl.mjs effect.fire '{"name":"gg"}'
// --project takes the host test format (passed to the host at start) or a project v1 file, which is migrated and
// validated with services/project first and then sent with project.load; --base sets its pathRef bases
// (data, media, overlays, profile). Layers that cannot be built (devices, browser) are skipped and listed.
// --outputs takes an O1 plan file (app/host/outputs/*.json): it is validated against data/platforms and configured,
// but nothing is started. Devices stay off. The host generates its token into the owner-only discovery file
// (printed nowhere), so while it runs: node app/host/tools/hostctl.mjs <method> [params-json]
import path from 'node:path';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { launchHost, stopHost } from '../lib/launch.mjs';
import { planFile } from '../lib/outputs-plan.mjs';
import { loadFileIntoHost } from '../lib/project.mjs';
import { HOST_DIR, resolveConfig } from '../lib/config.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const project = path.resolve(arg('--project', path.join(HOST_DIR, 'projects', 'test-card.project.json')));
const preview = arg('--preview', 'h,v');
const isTestFormat = JSON.parse(readFileSync(project, 'utf8')).format === 'ujwalam-host-test';
const bases = {};
argv.forEach((a, i) => {
  if (a !== '--base') return;
  const m = /^([a-z]+)=(.+)$/.exec(argv[i + 1] ?? '');
  if (!m) throw new Error('--base takes <name>=<dir>');
  bases[m[1]] = path.resolve(m[2]);
});
const cfg = resolveConfig();

let outputs;
if (arg('--outputs')) {
  const { params, report } = planFile(path.resolve(arg('--outputs')));
  for (const w of report.warnings) console.log(`plan warning: ${w.code}: ${w.message}`);
  mkdirSync(cfg.dataDir, { recursive: true });
  outputs = path.join(cfg.dataDir, 'outputs-params.json');
  writeFileSync(outputs, JSON.stringify(params, null, 2));
}

const h = await launchHost({ cfg, project: isTestFormat ? project : undefined, preview: preview === 'none' ? undefined : preview, outputs, stdio: 'inherit', tokenByEnv: false, overlay: argv.includes('--overlay') });
if (!isTestFormat) {
  try {
    const r = await loadFileIntoHost(h.client, project, { bases, skipUnavailable: true });
    console.log(`project v1 loaded: ${JSON.stringify(r.built)}; not built: ${r.unavailable.length}; warnings: ${r.warnings.length}`);
    for (const u of r.unavailable) console.log(`  not built: ${u.layer ?? u.audio}: ${u.code}: ${u.reason}`);
  } catch (e) {
    console.error(`project v1 refused: ${e.message}`);
    for (const x of e.errors ?? []) console.error(`  ${x.path}: ${x.message}`);
    await stopHost(h);
    process.exit(2);
  }
}
console.log(`ujwalam-host ready: pid ${h.child.pid}, 127.0.0.1:${h.discoveryJson.port}, discovery ${h.discovery}`);
console.log('Ctrl+C to stop (outputs stop, previews close, host exits).');
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  const r = await stopHost(h);
  console.log(`host exited ${r.code}${r.timedOut ? ' (timed out, killed)' : ''}`);
  process.exit(r.code === 0 ? 0 : 1);
};
process.on('SIGINT', stop);
h.exit.then((code) => { if (!stopping) { console.log(`host exited on its own: ${code}`); process.exit(code ?? 1); } });
