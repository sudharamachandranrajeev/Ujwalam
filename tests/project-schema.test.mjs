// SPDX-License-Identifier: GPL-3.0-or-later
// Project model: JSON Schema (ajv, dev dependency) and the hand-written validator agree on structure;
// the validator also rejects bad cross-references and unsafe paths.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { validateProject, createProject, relPathProblem, newId } from '../services/project/index.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(repo, ...p), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: true });
const schemaCheck = ajv.compile(readJson('data', 'schemas', 'project.schema.json'));
const sample = () => readJson('tests', 'fixtures', 'project', 'sample.project.json');
const dupLayer = (id, target) => ({ id, type: 'duplicate', name: 'Mirror', source: { layer: target }, placements: { h: { visible: true, x: 0, y: 0, width: 100, height: 100 } } });

// Each case: [name, mutate(doc), structuralAgreement] ; structural=true means the schema must also reject it.
const BAD = [
  ['unknown top-level key', (d) => { d.extra = 1; }, true],
  ['wrong version', (d) => { d.version = 2; }, true],
  ['bad project id', (d) => { d.id = 'Bad Id'; }, true],
  ['no canvases', (d) => { d.canvases = []; }, true],
  ['canvas id not h or v', (d) => { d.canvases[0].id = 'x'; }, true],
  ['fps zero', (d) => { d.canvases[0].fps = 0; }, true],
  // D327 TR1: easing is an id, mirror is a boolean and for the portrait canvas only (the last one is validator-only)
  ['transition easing not an id', (d) => { d.canvases[0].transition = { type: 'fade', durationMs: 500, easing: 'In Out' }; }, true],
  ['transition mirror not a boolean', (d) => { d.canvases.find((c) => c.id === 'v').transition = { type: 'cut', durationMs: 0, mirror: 'yes' }; }, true],
  ['transition mirror on the main canvas', (d) => { d.canvases.find((c) => c.id === 'h').transition = { type: 'cut', durationMs: 0, mirror: true }; }, false],
  ['width as string', (d) => { d.canvases[0].width = '1920'; }, true],
  ['device kind unknown', (d) => { d.devices[0].kind = 'toaster'; }, true],
  ['device match empty', (d) => { d.devices[0].match = {}; }, true],
  ['layer type unknown', (d) => { d.scenes[0].layers[0].type = 'hologram'; }, true],
  ['capture without device', (d) => { d.scenes[0].layers[0].source = {}; }, true],
  ['capture source extra key', (d) => { d.scenes[0].layers[0].source.foo = 1; }, true],
  ['color not hex', (d) => { d.scenes[0].layers[3].source.color = 'red'; }, true],
  ['placement missing width', (d) => { delete d.scenes[0].layers[0].placements.h.width; }, true],
  ['placement opacity above 1', (d) => { d.scenes[0].layers[1].placements.h.opacity = 2; }, true],
  ['placements empty', (d) => { d.scenes[0].layers[0].placements = {}; }, true],
  ['placement for canvas z', (d) => { d.scenes[0].layers[0].placements.z = d.scenes[0].layers[0].placements.h; }, true],
  ['audio monitoring unknown', (d) => { d.audio.sources[0].monitoring = 'loud'; }, true],
  ['audio volume above range', (d) => { d.audio.sources[0].volumeDb = 40; }, true],
  ['more than 256 audio sources', (d) => { d.audio.sources = Array.from({ length: 257 }, (_, i) => ({ ...d.audio.sources[0], id: `aud-${i}` })); }, true],
  ['seven tracks', (d) => { d.audio.tracks = Array.from({ length: 7 }, (_, i) => ({ id: `t${i}`, name: 'T' })); }, true],
  ['output type unknown', (d) => { d.outputs[0].type = 'encoder'; }, true],
  ['output carries encoder settings', (d) => { d.outputs[0].bitrate = 6000; }, true],
  ['pathRef base unknown', (d) => { d.overlays[0].file.base = 'root'; }, true],
  ['browser url not http', (d) => { d.scenes[0].layers[2].source = { url: 'file:///x', width: 10, height: 10 }; }, true],
  ['overlay query with leading question mark', (d) => { d.scenes[0].layers[2].source.query = '?a=b'; }, true],
  ['overlay query empty', (d) => { d.scenes[0].layers[2].source.query = ''; }, true],
  ['device directShowId empty', (d) => { d.devices[0].match.directShowId = ''; }, true],
  ['duplicate without layer', (d) => { d.scenes[1].layers.push({ ...dupLayer('layer-d1', 'layer-cam'), source: {} }); }, true],
  ['duplicate source has extra key', (d) => { d.scenes[1].layers.push({ ...dupLayer('layer-d1', 'layer-cam'), source: { layer: 'layer-cam', device: 'dev-cam' } }); }, true],
  ['effects not an array', (d) => { d.scenes[0].layers[3].effects = { type: 'blur', strength: 5 }; }, true],
  ['effect type unknown', (d) => { d.scenes[0].layers[3].effects = [{ type: 'glow', strength: 5 }]; }, true],
  ['blur without strength', (d) => { d.scenes[0].layers[3].effects = [{ type: 'blur' }]; }, true],
  ['blur strength 0', (d) => { d.scenes[0].layers[3].effects = [{ type: 'blur', strength: 0 }]; }, true],
  ['blur strength above 100', (d) => { d.scenes[0].layers[3].effects = [{ type: 'blur', strength: 101 }]; }, true],
  ['blur with a radius key', (d) => { d.scenes[0].layers[3].effects = [{ type: 'blur', strength: 5, radius: 4 }]; }, true],
  ['rounded radius negative', (d) => { d.scenes[0].layers[3].effects = [{ type: 'rounded', radius: -1 }]; }, true],
  ['rounded radius above 500', (d) => { d.scenes[0].layers[3].effects = [{ type: 'rounded', radius: 501 }]; }, true],
  ['seven effects', (d) => { d.scenes[0].layers[3].effects = Array.from({ length: 7 }, () => ({ type: 'rounded', radius: 4 })); }, true],
  ['shadow distance above 200', (d) => { d.scenes[0].layers[3].effects = [{ type: 'shadow', color: '#000000', opacity: 0.5, size: 10, distance: 201, angle: 45 }]; }, true],
  ['glow without spread', (d) => { d.scenes[0].layers[3].effects = [{ type: 'glow', color: '#00ffff', opacity: 1, size: 10 }]; }, true],
  ['glow with an angle', (d) => { d.scenes[0].layers[3].effects = [{ type: 'glow', color: '#00ffff', opacity: 1, size: 10, spread: 0.1, angle: 3 }]; }, true],
  ['color brightness above 1', (d) => { d.scenes[0].layers[3].effects = [{ type: 'color', brightness: 1.5, contrast: 0, saturation: 0, hue: 0 }]; }, true],
  ['color without hue', (d) => { d.scenes[0].layers[3].effects = [{ type: 'color', brightness: 0, contrast: 0, saturation: 0 }]; }, true],
  ['toner tone not #RRGGBB', (d) => { d.scenes[0].layers[3].effects = [{ type: 'toner', shadows: '#000', darktones: '#000000', midtones: '#000000', brights: '#000000', highlights: '#000000', amount: 1 }]; }, true],
  ['cornerPin bow-tie (validator only)', (d) => { d.scenes[0].layers[3].effects = [{ type: 'cornerPin', topLeftX: 0, topLeftY: 0, topRightX: 1, topRightY: 0, bottomRightX: 0, bottomRightY: 1, bottomLeftX: 1, bottomLeftY: 1 }]; }, false],
  ['cornerPin dented quad (validator only)', (d) => { d.scenes[0].layers[3].effects = [{ type: 'cornerPin', topLeftX: 0, topLeftY: 0, topRightX: 1, topRightY: 0, bottomRightX: 0.5, bottomRightY: 0.5, bottomLeftX: 0, bottomLeftY: 1 }]; }, false],
  ['blinds width below 1', (d) => { d.scenes[0].layers[3].effects = [{ type: 'blinds', completion: 0.5, angle: 90, width: 0.5, feather: 0 }]; }, true],
  ['blinds without feather', (d) => { d.scenes[0].layers[3].effects = [{ type: 'blinds', completion: 0.5, angle: 90, width: 10 }]; }, true],
  ['cornerPin corner above 1', (d) => { d.scenes[0].layers[3].effects = [{ type: 'cornerPin', topLeftX: 0, topLeftY: 0, topRightX: 1, topRightY: 0, bottomRightX: 1, bottomRightY: 1, bottomLeftX: 0, bottomLeftY: 1.2 }]; }, true],
  ['cornerPin without bottomLeftY', (d) => { d.scenes[0].layers[3].effects = [{ type: 'cornerPin', topLeftX: 0, topLeftY: 0, topRightX: 1, topRightY: 0, bottomRightX: 1, bottomRightY: 1, bottomLeftX: 0 }]; }, true],
  ['toner amount above 1', (d) => { d.scenes[0].layers[3].effects = [{ type: 'toner', shadows: '#000000', darktones: '#000000', midtones: '#000000', brights: '#000000', highlights: '#ffffff', amount: 2 }]; }, true],
  ['effect not an object', (d) => { d.scenes[0].layers[3].effects = ['blur']; }, true],
  // D291 filters, camera and compositing
  ['sharpen above 1', (d) => { d.scenes[0].layers[3].effects = [{ type: 'sharpen', amount: 1.5 }]; }, true],
  ['vignette without colour', (d) => { d.scenes[0].layers[3].effects = [{ type: 'vignette', amount: 0.5, size: 0.4, softness: 0.5 }]; }, true],
  ['grain size 0', (d) => { d.scenes[0].layers[3].effects = [{ type: 'grain', amount: 0.2, size: 0 }]; }, true],
  ['pixelate cell 1', (d) => { d.scenes[0].layers[3].effects = [{ type: 'pixelate', size: 1 }]; }, true],
  ['posterize 2.5 levels', (d) => { d.scenes[0].layers[3].effects = [{ type: 'posterize', levels: 2.5 }]; }, true],
  ['lut without file', (d) => { d.scenes[0].layers[3].effects = [{ type: 'lut', amount: 1 }]; }, true],
  ['mirror with a setting', (d) => { d.scenes[0].layers[3].effects = [{ type: 'mirror', horizontal: true }]; }, true],
  ['roundMask radius above 50', (d) => { d.scenes[0].layers[3].effects = [{ type: 'roundMask', radius: 60, feather: 0, borderWidth: 0, borderColor: '#ffffff' }]; }, true],
  ['circleMask border colour name', (d) => { d.scenes[0].layers[3].effects = [{ type: 'circleMask', feather: 0, borderWidth: 2, borderColor: 'white' }]; }, true],
  ['blend mode overlay (not available)', (d) => { d.scenes[0].layers[3].effects = [{ type: 'blendOverlay', opacity: 1 }]; }, true],
  ['opacity above 1', (d) => { d.scenes[0].layers[3].effects = [{ type: 'opacity', opacity: 2 }]; }, true],
  ['gradientMask without end', (d) => { d.scenes[0].layers[3].effects = [{ type: 'gradientMask', angle: 0, start: 0.5 }]; }, true],
  ['imageMask channel red', (d) => { d.scenes[0].layers[3].effects = [{ type: 'imageMask', file: { base: 'media', rel: 'm.png' }, channel: 'red', invert: false, feather: 0 }]; }, true],
  ['imageMask invert as 1', (d) => { d.scenes[0].layers[3].effects = [{ type: 'imageMask', file: { base: 'media', rel: 'm.png' }, channel: 'luma', invert: 1, feather: 0 }]; }, true],
  ['two blend effects', (d) => { d.scenes[0].layers[3].effects = [{ type: 'blendMultiply', opacity: 1 }, { type: 'blendScreen', opacity: 1 }]; }, false],
  ['lut file not .cube or .png', (d) => { d.scenes[0].layers[3].effects = [{ type: 'lut', file: { base: 'media', rel: 'grade.jpg' }, amount: 1 }]; }, false],
  ['imageMask file outside its base', (d) => { d.scenes[0].layers[3].effects = [{ type: 'imageMask', file: { base: 'media', rel: '../m.png' }, channel: 'luma', invert: false, feather: 0 }]; }, false],
  // face AI (D295 proposed)
  ['personMask mode cutout', (d) => { d.scenes[0].layers[3].effects = [{ type: 'personMask', mode: 'cutout', threshold: 0.5, feather: 0.1, smoothing: 0.3 }]; }, true],
  ['personMask smoothing 1', (d) => { d.scenes[0].layers[3].effects = [{ type: 'personMask', threshold: 0.5, feather: 0.1, smoothing: 1 }]; }, true],
  ['personMask without threshold', (d) => { d.scenes[0].layers[3].effects = [{ type: 'personMask', feather: 0.1, smoothing: 0.3 }]; }, true],
  ['autoFrame zoom 5', (d) => { d.scenes[0].layers[3].effects = [{ type: 'autoFrame', zoom: 5, smoothing: 0.5, deadzone: 0.1 }]; }, true],
  ['faceSticker anchor chin', (d) => { d.scenes[0].layers[3].effects = [{ type: 'faceSticker', file: { base: 'media', rel: 's.png' }, anchor: 'chin', scale: 1, offsetX: 0, offsetY: 0 }]; }, true],
  ['faceSticker without file', (d) => { d.scenes[0].layers[3].effects = [{ type: 'faceSticker', anchor: 'eyes', scale: 1, offsetX: 0, offsetY: 0 }]; }, true],
  // semantic only
  ['duplicate of a missing layer', (d) => { d.scenes[1].layers.push(dupLayer('layer-d1', 'layer-nope')); }, false],
  ['duplicate of itself (cycle)', (d) => { d.scenes[1].layers.push(dupLayer('layer-d1', 'layer-d1')); }, false],
  ['duplicate of a duplicate', (d) => { d.scenes[1].layers.push(dupLayer('layer-d1', 'layer-cam'), dupLayer('layer-d2', 'layer-d1')); }, false],
  ['duplicate cycle of two', (d) => { d.scenes[1].layers.push(dupLayer('layer-d1', 'layer-d2'), dupLayer('layer-d2', 'layer-d1')); }, false],
  ['query without overlay', (d) => { d.scenes[0].layers[2].source = { url: 'https://example.invalid/', query: 'a=b', width: 10, height: 10 }; }, false],
  ['duplicate scene id', (d) => { d.scenes[1].id = d.scenes[0].id; }, false],
  ['duplicate layer id across scenes', (d) => { d.scenes[1].layers.push({ ...d.scenes[0].layers[3] }); }, false],
  ['capture of unknown device', (d) => { d.scenes[0].layers[0].source.device = 'dev-nope'; }, false],
  ['browser of unknown overlay', (d) => { d.scenes[0].layers[2].source.overlay = 'ov-nope'; }, false],
  ['browser with overlay and url', (d) => { d.scenes[0].layers[2].source.url = 'https://example.invalid/'; }, false],
  ['activeScene unknown', (d) => { d.activeScene = 'scene-nope'; }, false],
  ['audio source unknown device', (d) => { d.audio.sources[0].device = 'dev-nope'; }, false],
  ['audio source unknown track', (d) => { d.audio.sources[0].tracks = ['track9']; }, false],
  ['audio source with device and layer', (d) => { d.audio.sources[0].layer = 'layer-game'; }, false],
  ['audio source with neither', (d) => { delete d.audio.sources[0].device; }, false],
  ['placement on undefined canvas', (d) => { d.canvases = [d.canvases[0]]; d.outputs = []; }, false],
  ['output on undefined canvas', (d) => { d.canvases = [d.canvases[0]]; d.scenes.forEach((s) => s.layers.forEach((l) => { delete l.placements.v; })); d.outputs[1].canvas = 'v'; }, false],
  ['absolute path in a file ref', (d) => { d.overlays[0].file.rel = 'C:\\somewhere\\x.html'; }, false],
  ['rooted path in a file ref', (d) => { d.overlays[0].file.rel = '/etc/x'; }, false],
  ['parent traversal in a file ref', (d) => { d.scenes[0].layers[4].source.file.rel = '../outside.png'; }, false],
  ['duplicate audio track id', (d) => { d.audio.tracks[1].id = 'track1'; }, false],
];

test('sample fixture is valid for the schema and the validator', () => {
  const d = sample();
  assert.equal(schemaCheck(d), true, JSON.stringify(schemaCheck.errors));
  const r = validateProject(d);
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
});

test('D327 TR1: a fade with an easing curve and a mirrored portrait transition are accepted', () => {
  const d = sample();
  d.canvases.find((c) => c.id === 'h').transition = { type: 'fade', durationMs: 700, easing: 'in-out-cubic' };
  d.canvases.find((c) => c.id === 'v').transition = { type: 'cut', durationMs: 0, mirror: true };
  assert.equal(schemaCheck(d), true, JSON.stringify(schemaCheck.errors));
  assert.deepEqual(validateProject(d).errors, []);
});

test('overlay query and device directShowId are accepted', () => {
  const d = sample();
  d.scenes[0].layers[2].source.query = 'canvas=horizontal&theme=demo';
  d.devices[0].match.directShowId = '<dshow-id-1>';
  assert.equal(schemaCheck(d), true, JSON.stringify(schemaCheck.errors));
  assert.equal(validateProject(d).ok, true);
});

test('a duplicate of a real layer, also in another scene, is valid (schema and validator)', () => {
  const d = sample();
  d.scenes[1].layers.push(dupLayer('layer-d1', 'layer-cam'));
  d.scenes[0].layers.push({ ...dupLayer('layer-d2', 'layer-cam'), placements: { v: { visible: true, x: 0, y: 0, width: 10, height: 10 } } });
  assert.equal(schemaCheck(d), true, JSON.stringify(schemaCheck.errors));
  assert.deepEqual(validateProject(d).errors, []);
});

test('layer effects: blurred duplicate and rounded layer are valid (schema and validator)', () => {
  const d = sample();
  d.scenes[1].layers.push({ ...dupLayer('layer-d1', 'layer-cam'), effects: [{ type: 'blur', strength: 40 }] });
  d.scenes[0].layers[3].effects = [{ type: 'rounded', radius: 24 }, { type: 'blur', strength: 1 }];
  d.scenes[0].layers[4].effects = [];
  assert.equal(schemaCheck(d), true, JSON.stringify(schemaCheck.errors));
  assert.deepEqual(validateProject(d).errors, []);
});

test('D291 filter, camera and compositing effects are valid (schema and validator)', () => {
  const d = sample();
  d.scenes[0].layers[3].effects = [
    { type: 'sharpen', amount: 0.2 }, { type: 'vignette', amount: 0.6, size: 0.35, softness: 0.6, color: '#000000' },
    { type: 'grain', amount: 0.15, size: 2 }, { type: 'pixelate', size: 16 }, { type: 'posterize', levels: 6 },
    { type: 'lut', file: { base: 'media', rel: 'luts/teal.cube' }, amount: 0.8 }];
  d.scenes[0].layers[4].effects = [
    { type: 'mirror' }, { type: 'flip' }, { type: 'circleMask', feather: 1, borderWidth: 3, borderColor: '#ffffff' },
    { type: 'roundMask', radius: 12, feather: 0, borderWidth: 0, borderColor: '#000000' },
    { type: 'blendMultiply', opacity: 0.8 }, { type: 'opacity', opacity: 0.5 }];
  d.scenes[1].layers.push({ ...dupLayer('layer-d1', 'layer-cam'), effects: [
    { type: 'gradientMask', angle: 90, start: 0.6, end: 1 },
    { type: 'imageMask', file: { base: 'media', rel: 'masks/heart.png' }, channel: 'luma', invert: true, feather: 4 },
    { type: 'lut', file: { base: 'media', rel: 'luts/warm.PNG' }, amount: 1 }] });
  assert.equal(schemaCheck(d), true, JSON.stringify(schemaCheck.errors));
  assert.deepEqual(validateProject(d).errors, []);
});

test('face AI effects (D295 proposed) are valid (schema and validator)', () => {
  const d = sample();
  d.scenes[0].layers[3].effects = [
    { type: 'personMask', threshold: 0.5, feather: 0.1, smoothing: 0.3 },
    { type: 'autoFrame', zoom: 1.6, smoothing: 0.5, deadzone: 0.1 },
    { type: 'faceSticker', file: { base: 'media', rel: 'stickers/glasses.png' }, anchor: 'eyes', scale: 2.2, offsetX: 0, offsetY: 0 }];
  d.scenes[1].layers.push({ ...dupLayer('layer-d1', 'layer-cam'), effects: [
    { type: 'personMask', mode: 'blur', threshold: 0.5, feather: 0.2, smoothing: 0.5, strength: 30 },
    { type: 'personMask', mode: 'replace', threshold: 0.6, feather: 0.1, smoothing: 0, color: '#00b140', file: { base: 'media', rel: 'bg/room.png' } }] });
  assert.equal(schemaCheck(d), true, JSON.stringify(schemaCheck.errors));
  assert.deepEqual(validateProject(d).errors, []);
});

test('duplicate errors name the problem', () => {
  const d = sample();
  d.scenes[1].layers.push(dupLayer('layer-d1', 'layer-cam'), dupLayer('layer-d2', 'layer-d1'), dupLayer('layer-d3', 'layer-d3'), dupLayer('layer-d4', 'layer-nope'));
  const msgs = validateProject(d).errors.map((e) => e.message).join('\n');
  assert.match(msgs, /itself a duplicate/);
  assert.match(msgs, /duplicate cycle through "layer-d3"/);
  assert.match(msgs, /unknown layer "layer-nope"/);
});

test('createProject gives a valid H+V project with distinct stable ids', () => {
  const a = createProject({ name: 'A' });
  const b = createProject({ name: 'B' });
  assert.equal(validateProject(a).ok, true);
  assert.equal(schemaCheck(a), true);
  assert.notEqual(a.id, b.id);
  assert.deepEqual(a.canvases.map((c) => [c.id, c.width, c.height]), [['h', 1920, 1080], ['v', 1080, 1920]]);
  assert.match(newId('layer'), /^layer-[0-9a-f]{8}$/);
  assert.throws(() => newId('9x'), TypeError);
});

for (const [name, mutate, structural] of BAD) {
  test(`rejects: ${name}`, () => {
    const d = sample();
    mutate(d);
    const r = validateProject(d);
    assert.equal(r.ok, false, `validator accepted: ${name}`);
    assert.ok(r.errors.length > 0 && r.errors.every((e) => typeof e.path === 'string' && e.message));
    if (structural) assert.equal(schemaCheck(d), false, `schema accepted: ${name}`);
  });
}

test('non-objects and arrays are rejected without throwing', () => {
  for (const v of [null, undefined, 1, 'x', [], true]) assert.equal(validateProject(v).ok, false);
});

test('relPathProblem accepts relative, refuses absolute and traversal', () => {
  assert.equal(relPathProblem('a/b.png'), null);
  assert.equal(relPathProblem('a\\b.png'), null);
  for (const bad of ['', 'C:/x', 'D:\\x', '/x', '\\\\host\\share', 'a/../b', '..\\b', 'a\u0000b']) {
    assert.notEqual(relPathProblem(bad), null, bad);
  }
});

test('a real Meld session size: 100 audio sources (one per video layer) are valid (D245)', () => {
  const d = sample();
  d.audio.sources = Array.from({ length: 100 }, (_, i) => ({ ...d.audio.sources[0], id: `aud-${i}` }));
  assert.equal(schemaCheck(d), true, JSON.stringify(schemaCheck.errors));
  assert.equal(validateProject(d).ok, true, JSON.stringify(validateProject(d).errors));
});
