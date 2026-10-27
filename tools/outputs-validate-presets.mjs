// SPDX-License-Identifier: GPL-2.0-or-later
// Runs the output validator over every built-in preset.
// Usage: node tools/outputs-validate-presets.mjs [presetsDir] [platformsDir]
// Exit code 1 if any preset has errors.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { validate, loadPlatforms, formatReport } from '../services/outputs/validate.mjs';

const [presetsDir = 'data/outputs/presets', platDir = 'data/platforms'] = process.argv.slice(2);
const platforms = loadPlatforms(platDir);
let failed = 0;
for (const f of readdirSync(presetsDir).filter((n) => n.endsWith('.json')).sort()) {
  const cfg = JSON.parse(readFileSync(path.join(presetsDir, f), 'utf8'));
  const res = validate(cfg, platforms);
  console.log(`== ${f}${res.errors.length ? ' (ERRORS)' : ''}`);
  console.log(formatReport(res));
  if (res.errors.length) failed++;
}
process.exit(failed ? 1 : 0);
