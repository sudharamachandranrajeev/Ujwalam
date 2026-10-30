// SPDX-License-Identifier: GPL-2.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const list = (d) => readdirSync(d).filter((f) => f.endsWith('.json')).sort().map((f) => path.join(d, f));

const ajv = new Ajv2020({ allErrors: true, strict: true });
const configSchema = ajv.compile(readJson(path.join(repo, 'services', 'outputs', 'schema', 'output-config.schema.json')));
const platformSchema = ajv.compile(readJson(path.join(repo, 'data', 'platforms', 'platform.schema.json')));

const platformFiles = list(path.join(repo, 'data', 'platforms')).filter((f) => !f.endsWith('platform.schema.json'));
const presetFiles = list(path.join(repo, 'data', 'outputs', 'presets'));
const META = new Set(['id', 'name', 'notes']);

test('platform files exist for youtube, twitch, kick, local', () => {
  assert.deepEqual(platformFiles.map((f) => path.basename(f)), ['kick.json', 'local.json', 'twitch.json', 'youtube.json']);
});

for (const f of platformFiles) {
  const name = path.basename(f);

  test(`platform ${name} matches schema`, () => {
    assert.ok(platformSchema(readJson(f)), JSON.stringify(platformSchema.errors));
  });

  test(`platform ${name}: every value has {source, checked} or unverified:true with a note`, () => {
    const bad = [];
    const walk = (o, p) => {
      if (!o || typeof o !== 'object' || Array.isArray(o)) return;
      if ('value' in o) {
        const sourced = typeof o.source === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.checked ?? '');
        if (!sourced && o.unverified !== true) bad.push(p);
        if (o.unverified === true && !o.note) bad.push(`${p} (no note)`);
        return;
      }
      for (const [k, v] of Object.entries(o)) walk(v, `${p}.${k}`);
    };
    for (const [k, v] of Object.entries(readJson(f))) if (!META.has(k)) walk(v, k);
    assert.deepEqual(bad, []);
  });

  test(`platform ${name}: sources are official https URLs or "ujwalam"`, () => {
    const srcs = [];
    JSON.stringify(readJson(f), (k, v) => { if (k === 'source') srcs.push(v); return v; });
    for (const s of srcs) {
      assert.ok(s === 'ujwalam' || s === 'user-reference-2026-10-27' || s === 'legacy-observed' || /^https:\/\/(support\.google\.com|blog\.twitch\.tv|dev\.twitch\.tv|help\.twitch\.tv|help\.kick\.com|docs\.kick\.com)\//.test(s), s);
    }
  });
}

for (const f of presetFiles) {
  test(`preset ${path.basename(f)} matches output-config schema`, () => {
    assert.ok(configSchema(readJson(f)), JSON.stringify(configSchema.errors));
  });
}

test('three built-in presets exist', () => {
  assert.deepEqual(presetFiles.map((f) => path.basename(f)), ['youtube-1080p60.json', 'youtube-1440p60.json', 'youtube-2160p60.json']);
});

for (const n of ['output-graph-example.json', 'meld-migrated-multi.json']) {
  test(`fixture ${n} matches schema`, () => {
    assert.ok(configSchema(readJson(path.join(repo, 'tests', 'fixtures', 'outputs', n))), JSON.stringify(configSchema.errors));
  });
}

test('schema: pending migration may omit values; migrated may not', () => {
  const ok = { canvases: [{ id: 'H', w: 1, h: 1, fps: 60 }], encoders: [{ id: 'a', canvas: 'H', migration: { from: 'x', status: 'pending' } }], sinks: [] };
  assert.ok(configSchema(ok), JSON.stringify(configSchema.errors));
  const bad = structuredClone(ok);
  bad.encoders[0].migration.status = 'migrated';
  assert.equal(configSchema(bad), false);
});

test('schema: rejects unknown codec and bad proto', () => {
  const c = readJson(presetFiles[0]);
  const a = structuredClone(c);
  a.encoders[0].codec = 'vp9';
  assert.equal(configSchema(a), false);
  const b = structuredClone(c);
  b.sinks[0].proto = 'http';
  assert.equal(configSchema(b), false);
});

test('presets and platform files contain no stream keys or ingest URLs', () => {
  for (const f of [...presetFiles, ...platformFiles]) {
    const t = readFileSync(f, 'utf8');
    assert.ok(!/(rtmps?|srt):\/\//i.test(t), f);
    assert.ok(!/stream[_-]?key"\s*:/i.test(t), f);
  }
});

test('platform schema: severity is required; unverified values must be warnings', () => {
  const j = readJson(platformFiles[0]);
  const noSev = structuredClone(j);
  delete noSev.maxFps.severity;
  assert.equal(platformSchema(noSev), false);
  const unvErr = structuredClone(j);
  unvErr.portrait = { value: true, severity: 'error', unverified: true, note: 'x' };
  assert.equal(platformSchema(unvErr), false);
  const ok = structuredClone(j);
  ok.portrait = { value: true, severity: 'warning', unverified: true, note: 'x' };
  assert.ok(platformSchema(ok), JSON.stringify(platformSchema.errors));
});

test('every platform value carries a severity; unverified ones are warnings; errors carry a justification', () => {
  const bad = [];
  const w = (o, p) => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return;
    if ('value' in o) {
      if (!['error', 'warning'].includes(o.severity)) bad.push(p);
      if (o.unverified && o.severity !== 'warning') bad.push(p + ' (unverified must be warning)');
      if (o.severity === 'error' && !p.startsWith('local.') && !/Severity error because:/.test(o.note ?? '')) bad.push(p + ' (no justification note)');
      return;
    }
    for (const [k, v] of Object.entries(o)) w(v, p + '.' + k);
  };
  for (const f of platformFiles) {
    for (const [k, v] of Object.entries(readJson(f))) if (!META.has(k)) w(v, path.basename(f, '.json') + '.' + k);
  }
  assert.deepEqual(bad, []);
});

test('fixture platform testplat matches platform schema', () => {
  assert.ok(platformSchema(readJson(path.join(repo, 'tests', 'fixtures', 'outputs', 'platforms', 'testplat.json'))), JSON.stringify(platformSchema.errors));
});
