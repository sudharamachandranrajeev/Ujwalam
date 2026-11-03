// SPDX-License-Identifier: GPL-2.0-or-later
// Runs the output validator over every built-in preset, then plans every output plan file in data/outputs/*.json
// (app/host/lib/outputs-plan.mjs: targets, keyRef/serverRef names, ingest data, recording container and rung rules).
// Plans are checked with allowLive (validation only: nothing starts, no host, no keychain read).
// Usage: node tools/outputs-validate-presets.mjs [presetsDir] [platformsDir] [plansDir]
// Exit code 1 if any preset or plan has errors.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { validate, loadPlatforms, formatReport } from '../services/outputs/validate.mjs';
import { planFile } from '../app/host/lib/outputs-plan.mjs';

const [presetsDir = 'data/outputs/presets', platDir = 'data/platforms', plansDir = 'data/outputs'] = process.argv.slice(2);
const platforms = loadPlatforms(platDir);
let failed = 0;
for (const f of readdirSync(presetsDir).filter((n) => n.endsWith('.json')).sort()) {
  const cfg = JSON.parse(readFileSync(path.join(presetsDir, f), 'utf8'));
  const res = validate(cfg, platforms);
  console.log(`== ${f}${res.errors.length ? ' (ERRORS)' : ''}`);
  console.log(formatReport(res));
  if (res.errors.length) failed++;
}
const plans = existsSync(plansDir) ? readdirSync(plansDir).filter((n) => n.endsWith('.json')).sort() : [];
for (const f of plans) {
  try {
    const { params, live } = planFile(path.join(plansDir, f), { platformsDir: path.resolve(platDir), allowLive: true });
    console.log(`== plan ${f}`);
    for (const s of params.sinks) {
      const t = s.target;
      const where = t.url ? `url ${t.url}` : t.urlRef ? `urlRef ${t.urlRef}` : t.transport === 'file' ? `file ${t.name}` : `loopback ${t.transport}`;
      console.log(`  ${s.id} -> rung ${s.rung} (${s.platform} ${s.proto}) ${where}${t.keyRef ? ` keyRef ${t.keyRef}` : ''}`);
    }
    console.log(`  real targets (need --allow-live): ${live.length ? live.join(', ') : 'none'}`);
  } catch (e) {
    console.log(`== plan ${f} (ERRORS)`);
    console.log(`ERROR   ${e.message}`);
    failed++;
  }
}
process.exit(failed ? 1 : 0);
