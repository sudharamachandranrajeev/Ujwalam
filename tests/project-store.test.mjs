// SPDX-License-Identifier: GPL-2.0-or-later
// Project store: round trip, atomic save under a killed write, .bak recovery, migration, placeholder-only fixtures.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  loadProject, saveProject, parseProject, projectFile, cleanTemps, resolvePathRef, migrate, createProject,
  validateProject, ProjectError, PROJECT_VERSION,
} from '../services/project/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures', 'project');
const sampleFile = path.join(fixtures, 'sample.project.json');
const sample = () => JSON.parse(fs.readFileSync(sampleFile, 'utf8'));
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ujw-project-'));

test('round trip: save then load gives the same project, with a trailing newline and no .bak on first save', () => {
  const dir = tmpDir();
  try {
    const file = projectFile(dir, 'project-sample');
    saveProject(file, sample());
    assert.equal(fs.existsSync(`${file}.bak`), false);
    assert.ok(fs.readFileSync(file, 'utf8').endsWith('\n'));
    const r = loadProject(file);
    assert.deepEqual(r.project, sample());
    assert.deepEqual(r.migrated, []);
    assert.equal(r.recoveredFrom, null);
    assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ['project-sample.project.json']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('second save keeps exactly one .bak holding the previous version', () => {
  const dir = tmpDir();
  try {
    const file = projectFile(dir, 'project-sample');
    const a = sample();
    saveProject(file, a);
    const b = sample(); b.name = 'Second';
    saveProject(file, b);
    const c = sample(); c.name = 'Third';
    saveProject(file, c);
    assert.equal(loadProject(file).project.name, 'Third');
    assert.equal(parseProject(fs.readFileSync(`${file}.bak`, 'utf8')).project.name, 'Second');
    assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ['project-sample.project.json', 'project-sample.project.json.bak']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an invalid project is refused and nothing is written', () => {
  const dir = tmpDir();
  try {
    const file = projectFile(dir, 'project-sample');
    saveProject(file, sample());
    const before = fs.readFileSync(file, 'utf8');
    const bad = sample(); bad.scenes[0].layers[0].source.device = 'dev-nope';
    assert.throws(() => saveProject(file, bad), (e) => e instanceof ProjectError && e.errors.length > 0);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['project-sample.project.json']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

for (const point of ['afterTemp', 'afterBackup']) {
  test(`atomic save: a process killed at ${point} leaves the original intact and loadable`, () => {
    const dir = tmpDir();
    try {
      const file = projectFile(dir, 'project-sample');
      saveProject(file, sample());
      const original = fs.readFileSync(file, 'utf8');
      const next = sample(); next.name = 'Never committed';
      const src = path.join(dir, 'next.json');
      fs.writeFileSync(src, JSON.stringify(next));
      const r = spawnSync(process.execPath, [path.join(here, 'project-child-save.mjs'), file, src, point], { encoding: 'utf8' });
      assert.equal(r.status, 1, r.stderr);
      assert.equal(fs.readFileSync(file, 'utf8'), original, 'original changed');
      const leftovers = fs.readdirSync(path.dirname(file)).filter((n) => n.includes('.tmp-'));
      assert.equal(leftovers.length, 1, 'temp file should remain after a kill');
      assert.equal(loadProject(file).project.name, sample().name);
      assert.deepEqual(cleanTemps(file).length, 1);
      assert.equal(fs.readdirSync(path.dirname(file)).some((n) => n.includes('.tmp-')), false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

test('a missing or corrupt main file falls back to the valid .bak; both bad throws', () => {
  const dir = tmpDir();
  try {
    const file = projectFile(dir, 'project-sample');
    saveProject(file, sample());
    const b = sample(); b.name = 'Newer';
    saveProject(file, b);
    fs.writeFileSync(file, '{ truncated');
    const r = loadProject(file);
    assert.equal(r.recoveredFrom, 'bak');
    assert.equal(r.project.name, 'Sample project');
    fs.rmSync(file);
    assert.equal(loadProject(file).recoveredFrom, 'bak');
    fs.writeFileSync(`${file}.bak`, '{}');
    assert.throws(() => loadProject(file), ProjectError);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('migration v0 -> v1: per-canvas placements, H and V canvases, default track; input not mutated', () => {
  const v0 = JSON.parse(fs.readFileSync(path.join(fixtures, 'v0.project.json'), 'utf8'));
  const copy = structuredClone(v0);
  const { project, migrated } = parseProject(JSON.stringify(v0));
  assert.deepEqual(v0, copy);
  assert.deepEqual(migrated, [0]);
  assert.equal(project.version, PROJECT_VERSION);
  assert.deepEqual(project.canvases.map((c) => [c.id, c.width, c.height, c.fps]), [['h', 1920, 1080, 30], ['v', 1080, 1920, 30]]);
  const [a, b] = project.scenes[0].layers;
  assert.deepEqual(a.placements.h, { visible: false, x: 10, y: 20, width: 1280, height: 720 });
  assert.deepEqual(b.placements.h, { visible: true, x: 0, y: 0, width: 1920, height: 1080 });
  assert.equal(project.audio.tracks.length, 1);
  assert.equal(validateProject(project).ok, true);
});

test('migration hook: future, missing and unknown versions are refused; current passes through', () => {
  assert.throws(() => migrate({ version: PROJECT_VERSION + 1 }), RangeError);
  assert.throws(() => migrate({}), RangeError);
  assert.throws(() => migrate({ version: -1 }), RangeError);
  assert.throws(() => migrate([]), RangeError);
  const cur = createProject({ id: 'project-x' });
  const r = migrate(cur);
  assert.deepEqual(r.migrated, []);
  assert.equal(r.doc, cur);
  assert.throws(() => parseProject('not json'), ProjectError);
});

test('projectFile and resolvePathRef take their directories from the caller and refuse escapes', () => {
  assert.throws(() => projectFile('', 'project-a'), TypeError);
  assert.throws(() => projectFile('x', '../evil'), TypeError);
  const base = path.resolve(os.tmpdir(), 'ujw-bases');
  const p = resolvePathRef({ base: 'media', rel: 'a/b.png' }, { media: base });
  assert.equal(p, path.join(base, 'a', 'b.png'));
  assert.throws(() => resolvePathRef({ base: 'media', rel: '../x' }, { media: base }), ProjectError);
  assert.throws(() => resolvePathRef({ base: 'data', rel: 'x' }, { media: base }), ProjectError);
});

test('fixtures and sources hold placeholders only: no absolute paths, drive letters, user names or ids', () => {
  const files = [
    sampleFile,
    path.join(fixtures, 'v0.project.json'),
    path.join(here, '..', 'data', 'schemas', 'project.schema.json'),
    ...fs.readdirSync(path.join(here, '..', 'services', 'project')).map((n) => path.join(here, '..', 'services', 'project', n)),
  ];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(text, /\b[A-Za-z]:[\\/]/, `${f}: drive-letter path`);
    assert.doesNotMatch(text, /\\Users\\|\/Users\/|\/home\//i, `${f}: user path`);
    assert.ok(!text.includes(os.userInfo().username) || os.userInfo().username.length < 4, `${f}: machine user name`);
  }
  const doc = sample();
  for (const d of doc.devices) {
    assert.match(d.name, /^<[a-z0-9-]+>$/);
    assert.match(d.match.deviceId, /^<[a-z0-9-]+>$/);
  }
});
