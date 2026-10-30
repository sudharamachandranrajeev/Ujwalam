// SPDX-License-Identifier: GPL-2.0-or-later
// Child process for tests/project-store.test.mjs: saves a project and is killed (exit 1) at a chosen point.
// argv: <file> <project-json-file> <afterTemp|afterBackup>

import fs from 'node:fs';
import { saveProject } from '../services/project/index.mjs';

const [file, src, point] = process.argv.slice(2);
const doc = JSON.parse(fs.readFileSync(src, 'utf8'));
saveProject(file, doc, { hooks: { [point]: () => process.exit(1) } });
