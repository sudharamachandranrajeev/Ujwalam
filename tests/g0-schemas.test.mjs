// SPDX-License-Identifier: GPL-3.0-or-later
// P2a A4 (G0): profile, detector pack, detection record and label schemas.
// P2b W0: the CODM pack is split into game.json, detectors.json, events.json, screens.json, capture-plan.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (...p) => JSON.parse(readFileSync(path.join(repo, ...p), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: true });
const compile = (...p) => ajv.compile(readJson(...p));
const vProfile = compile('data', 'profile.schema.json');
const vPack = compile('data', 'games', 'detector-pack.schema.json');
const vGame = compile('data', 'games', 'game.schema.json');
const vEvents = compile('data', 'games', 'events.schema.json');
const vScreens = compile('data', 'games', 'screens.schema.json');
const vPlan = compile('data', 'games', 'capture-plan.schema.json');
const vDet = compile('data', 'games', 'detection.schema.json');
const vLabels = compile('data', 'labels.schema.json');
const clone = (o) => structuredClone(o);
const ok = (v, d) => assert.ok(v(d), JSON.stringify(v.errors));
const bad = (v, d, msg) => assert.equal(v(d), false, msg);

const example = readJson('data', 'profile.example.json');
const pack = readJson('data', 'games', 'codm', 'detectors.json');
const game = readJson('data', 'games', 'codm', 'game.json');
const events = readJson('data', 'games', 'codm', 'events.json');
const screens = readJson('data', 'games', 'codm', 'screens.json');
const plan = readJson('data', 'games', 'codm', 'capture-plan.json');
const medalsOf = (ev) => ev.catalogues.find((c) => c.id === 'medals').events;
const A5C = 'docs/evidence/2026-10-27-p2a-a5c-mp-capture-3.md';
const det = readJson('tests', 'fixtures', 'g0', 'detection.example.json');
const labels = readJson('tests', 'fixtures', 'g0', 'labels.example.json');
const sessionIds = readJson('data', 'sessions.json').sessions.map((s) => s.id);
const find = (p, id) => p.detectors.find((d) => d.id === id);
const byId = (id) => find(pack, id);

// ---- profile ----
test('profile: example validates', () => ok(vProfile, example));

test('profile: local profile validates (skips if absent; contents never printed)', (t) => {
  const f = path.join(repo, 'data', 'profile.local.json');
  if (!existsSync(f)) return t.skip('data/profile.local.json absent');
  const local = JSON.parse(readFileSync(f, 'utf8'));
  const valid = vProfile(local);
  assert.ok(valid, 'local profile invalid at: ' + (vProfile.errors || []).map((e) => e.instancePath + ' ' + e.keyword).join('; '));
  for (const id of Object.keys(local.games)) assert.ok(existsSync(path.join(repo, 'data', 'games', id, 'detectors.json')), 'no pack for game ' + id);
});

test('profile: missing ign, unknown key, bad game id, bad mode rejected', () => {
  let p = clone(example); delete p.games.codm.ign; bad(vProfile, p, 'ign');
  p = clone(example); p.games.codm.password = 'x'; bad(vProfile, p, 'extra key');
  p = clone(example); p.games.CODM = p.games.codm; delete p.games.codm; bad(vProfile, p, 'game id case');
  p = clone(example); p.games.codm.default_mode = 'solo'; bad(vProfile, p, 'mode');
  p = clone(example); delete p.streamer; bad(vProfile, p, 'streamer');
});

// ---- detector pack ----
test('pack: CODM pack files validate (game, detectors, events, screens, capture plan)', () => {
  ok(vGame, game); ok(vPack, pack); ok(vEvents, events); ok(vScreens, screens); ok(vPlan, plan);
  assert.equal(pack.version, '0.5.0');
  for (const doc of [pack, events, screens, plan]) assert.equal(doc.game, game.id);
});

test('pack: ids unique; required detectors present; ROIs sane; status set', () => {
  const ids = pack.detectors.map((d) => d.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ['M1', 'M2', 'M3', 'M4', 'B1', 'M5', 'X1', 'B2', 'K1', 'N1', 'N2']) assert.ok(ids.includes(id), id);
  for (const d of pack.detectors) {
    for (const r of d.rois) {
      assert.ok(r.x0 < r.x1 && r.y0 < r.y1, d.id + '/' + r.id);
      if (r.mode) assert.ok(d.modes.includes(r.mode), d.id + '/' + r.id + ' mode');
      // G1 (2026-10-27) marks ROIs checked on corpus crops as verified; detectors stay unverified.
      assert.ok(['unverified', 'verified'].includes(r.status), d.id + '/' + r.id + ' status');
    }
    for (const m of d.modes) {
      assert.ok(game.modes.includes(m));
      assert.ok(d.rois.some((r) => !r.mode || r.mode === m), d.id + ' has no ROI for ' + m);
    }
  }
});

test('pack: M3 medal classes (user decisions 2026-10-27); weights/windows not invented', () => {
  assert.equal(byId('M3').catalogue, 'medals');
  assert.equal(byId('M3').medals, undefined, 'medals moved to events.json');
  const medals = medalsOf(events);
  const names = medals.map((m) => m.text);
  assert.equal(new Set(names).size, names.length, 'duplicate medal');
  const positive = ['Double Kill', 'Triple Kill', 'Fury Kill', 'Frenzy Kill', 'Merciless', 'Nuclear', 'Ultimate Terminator', 'Ultra Kill', 'Mega Kill', 'Super Kill', 'Ruthless', 'Relentless', 'Brutal'];
  const reference = ['Survivor', 'Kingslayer', 'Long Shot', 'Headshot', 'Major Assist', 'Minor Assist', 'UAV Assist', 'Hardpoint Kill', 'Trophy System Destroy', 'Revenge', 'Bloodthirsty', 'Saboteur', 'Berserker', 'Keep it Fresh'];
  assert.deepEqual(medals.filter((m) => m.class === 'positive').map((m) => m.text), positive);
  assert.deepEqual(medals.filter((m) => m.class === 'reference').map((m) => m.text), reference);
  assert.ok(!names.includes('Normal Kill') && !names.includes('First Blood'));
  for (const n of ['Relentless', 'Brutal']) assert.equal(medals.find((m) => m.text === n).status, 'unverified', n);
  for (const n of ['Nuclear', 'Ultimate Terminator']) assert.equal(medals.find((m) => m.text === n).status, 'listed_not_seen', n);
  // W0: seen live in A5c.
  for (const n of ['Mega Kill', 'Super Kill', 'Ultra Kill']) {
    const m = medals.find((x) => x.text === n);
    assert.equal(m.status, 'seen_g1', n);
    assert.deepEqual(m.evidence, [A5C], n);
  }
  // G1: on-screen spelling read on corpus crops is "Keep it Fresh".
  assert.equal(medals.find((m) => m.text === 'Keep it Fresh').status, 'seen_g1');
  for (const m of medals) {
    if (m.class === 'reference') { assert.equal(m.weight, 0, m.text); assert.equal(m.clipReason, false, m.text); }
    else { assert.equal(m.weight, null, m.text); assert.equal(m.clipReason, true, m.text); }
  }
  for (const d of pack.detectors) { assert.equal(d.weight, null); assert.equal(d.window.preSec, null); assert.equal(d.cooldownSec, null); }
  assert.equal(byId('M3').referenceDataset.path, 'data/games/codm/local/medals-reference');
  assert.equal(byId('M3').referenceDataset.gitignored, true);
});

test('pack: dmz is a tag-only mode with no detectors; version bumped', () => {
  assert.ok(game.modes.includes('dmz'));
  assert.deepEqual(game.taggingOnlyModes, ['dmz']);
  for (const d of pack.detectors) assert.ok(!d.modes.includes('dmz'), d.id);
  for (const s of screens.screens) if (s.detectors.length) assert.ok(!s.modes.includes('dmz'), s.id);
  assert.notEqual(pack.version, '0.1.0');
});

test('pack: K1 FINAL KILLCAM counts only with the streamer name as killer', () => {
  const k = byId('K1');
  assert.equal(k.role, 'positive');
  assert.deepEqual(k.modes, ['mp']);
  assert.equal(k.nameRequired, true);
  assert.equal(k.nameSide, 'killer');
  assert.equal(k.signalRule, 'name_only');
  assert.equal(k.logUnmatched, true);
  assert.ok(!byId('N1').patterns.some((p) => /final/i.test(p)));
});

test('pack: end screens (MVP, Impact Play, FINAL KILLCAM) are each name-checked, count once per match', () => {
  const r = pack.endScreenRule;
  assert.ok(r);
  assert.deepEqual([...r.detectors].sort(), ['K1', 'M1', 'M2']);
  for (const id of r.detectors) {
    assert.ok(byId(id), id);
    assert.equal(byId(id).role, 'positive', id);
    assert.equal(byId(id).nameRequired, true, id);
  }
  assert.equal(r.nameCheck, 'each');
  assert.equal(r.matchScore, 'once');
  assert.equal(r.reasons, 'all_named');
  assert.equal(r.noneNamed, 'no_signal');
  assert.equal(r.screenRequired, false);
});

test('pack: schema rejects an end-screen rule that requires a screen or scores per screen', () => {
  for (const [k, v] of [['screenRequired', true], ['matchScore', 'per_screen'], ['noneNamed', 'negative'], ['detectors', []]]) {
    const p = clone(pack);
    p.endScreenRule[k] = v;
    bad(vPack, p, k);
  }
  const p = clone(pack);
  delete p.endScreenRule.nameCheck;
  bad(vPack, p, 'nameCheck required');
});

test('capture plan: G1 missing items listed against real detectors and medals; no DMZ', () => {
  assert.equal(plan.game, game.id);
  assert.equal(plan.dedicatedCaptureCheck, 'W3');
  const ids = plan.items.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ['final_killcam_ign', 'final_killcam_other', 'mp_final_scoreboard', 'br_revival', 'br_multikill_banner', 'br_win']) assert.ok(ids.includes(id), id);
  const medals = medalsOf(events).map((m) => m.text);
  for (const m of ['Relentless', 'Brutal', 'Nuclear', 'Ultimate Terminator']) assert.ok(plan.items.some((i) => i.medal === m), m);
  for (const i of plan.items) {
    assert.ok(game.modes.includes(i.mode) && !game.taggingOnlyModes.includes(i.mode), i.id);
    if (i.detector !== null) assert.ok(byId(i.detector).modes.includes(i.mode), i.id);
    if (i.medal) assert.ok(medals.includes(i.medal), i.id);
    assert.equal(i.status, 'missing', i.id);
  }
});

test('pack: name-match flags (player events need a name; own HUD does not)', () => {
  for (const id of ['M1', 'M2', 'M5', 'B1', 'X1', 'K1']) assert.equal(byId(id).nameRequired, true, id);
  for (const id of ['M3', 'M4', 'B2', 'N1', 'N2']) assert.equal(byId(id).nameRequired, false, id);
  assert.equal(byId('B1').nameSide, 'killer');
  assert.deepEqual(byId('B1').modes, ['br']);
  assert.deepEqual(byId('M5').modes, ['mp']);
});

test('pack: suppression hides M3/M4 while M2 is shown; negatives are N1/N2', () => {
  const r = pack.suppressionRules.find((x) => x.while === 'M2');
  assert.ok(r);
  assert.deepEqual([...r.suppress].sort(), ['M3', 'M4']);
  for (const rule of pack.suppressionRules) for (const id of [...rule.suppress, rule.while]) assert.ok(byId(id), id);
  assert.deepEqual(pack.detectors.filter((d) => d.role === 'negative').map((d) => d.id).sort(), ['N1', 'N2']);
});

test('pack: OCR engine is rapidocr; versions present', () => {
  assert.equal(game.ocr.engine, 'rapidocr');
  assert.match(pack.version, /^\d+\.\d+\.\d+$/);
  assert.match(pack.engineVersion, /^\d+\.\d+\.\d+$/);
});

test('pack: negative cases rejected', () => {
  let p = clone(game); p.ocr.engine = 'tesseract'; bad(vGame, p, 'engine');
  p = clone(pack); delete p.version; bad(vPack, p, 'version');
  p = clone(pack); p.game = { id: 'codm', name: 'x' }; bad(vPack, p, 'game object moved to game.json');
  p = clone(pack); p.modes = ['mp']; bad(vPack, p, 'modes moved to game.json');
  p = clone(pack); delete find(p, 'M1').screens; bad(vPack, p, 'screens gate required');
  p = clone(pack); find(p, 'M1').screens = []; bad(vPack, p, 'empty screens gate');
  p = clone(pack); p.detectors[0].rois[0].x1 = 1.5; bad(vPack, p, 'roi range');
  p = clone(pack); delete p.detectors[0].nameRequired; bad(vPack, p, 'nameRequired');
  p = clone(pack); delete find(p, 'B1').nameSide; bad(vPack, p, 'nameSide when required');
  p = clone(pack); find(p, 'N1').weight = 2; bad(vPack, p, 'negative with weight');
  p = clone(pack); delete find(p, 'M3').catalogue; bad(vPack, p, 'M3 catalogue');
  p = clone(pack); find(p, 'M3').medals = medalsOf(events); bad(vPack, p, 'inline medals no longer allowed');
  p = clone(pack); p.detectors[0].modes = ['solo']; bad(vPack, p, 'mode');
  p = clone(pack); p.detectors[0].surprise = 1; bad(vPack, p, 'extra key');
  p = clone(pack); p.detectors[0].id = 'm1'; bad(vPack, p, 'id case');
  let e = clone(events); medalsOf(e)[0].class = 'other'; bad(vEvents, e, 'medal class');
  e = clone(events); delete medalsOf(e)[0].class; bad(vEvents, e, 'medal class missing');
  e = clone(events); medalsOf(e).find((m) => m.class === 'reference').weight = 1; bad(vEvents, e, 'reference weight');
  e = clone(events); medalsOf(e).find((m) => m.class === 'reference').clipReason = true; bad(vEvents, e, 'reference clip reason');
  e = clone(events); { const m = medalsOf(e).find((x) => x.class === 'reference'); m.class = 'positive'; m.clipReason = true; m.weight = 2; } ok(vEvents, e);
  e = clone(events); medalsOf(e)[0].evidence = ['docs/evidence/private/x.md']; bad(vEvents, e, 'evidence must be a committed evidence file');
  p = clone(pack); find(p, 'M1').modes = ['mp', 'dmz']; bad(vPack, p, 'detector in dmz');
  p = clone(pack); find(p, 'K1').nameRequired = false; bad(vPack, p, 'name_only without nameRequired');
  p = clone(pack); find(p, 'M3').referenceDataset.gitignored = false; bad(vPack, p, 'dataset must be gitignored');
  p = clone(pack); find(p, 'M3').referenceDataset.path = 'data/datasets/codm-medals-reference'; bad(vPack, p, 'dataset outside the pack local/ folder');
});

test('private terms: committed G0 data holds none from the local profile (count only)', (t) => {
  const f = path.join(repo, 'data', 'profile.local.json');
  if (!existsSync(f)) return t.skip('no local profile');
  const terms = [];
  (function walk(v) { if (typeof v === 'string') terms.push(v); else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => { if (k !== 'version' && k !== '$comment') walk(x); }); })(JSON.parse(readFileSync(f, 'utf8')));
  const text = [pack, game, events, screens, plan, det, labels, example].map((x) => JSON.stringify(x)).join('\n').toLowerCase();
  const hits = terms.filter((s) => s.length >= 3 && !s.startsWith('<') && text.includes(s.toLowerCase())).length;
  assert.equal(hits, 0, 'private term found in committed G0 data');
});

// ---- detection record ----
test('detection: fixture validates; session exists in sessions.json', () => {
  ok(vDet, det);
  assert.ok(sessionIds.includes(det.sessionId));
});

test('detection: fixture matches a pack detector and ROI', () => {
  const d = byId(det.detectorId);
  const r = d.rois.find((x) => x.id === det.roiId);
  assert.ok(r && r.x0 === det.roi.x0 && r.y1 === det.roi.y1);
  assert.ok(d.modes.includes(det.mode));
  assert.equal(det.packVersion, pack.version);
});

test('detection: K1 records with and without the name, medal class, dmz tag', () => {
  const k1 = (matched) => ({ ...clone(det), detectorId: 'K1', mode: 'mp', roiId: 'label', roi: { x0: 0.45, y0: 0.055, x1: 0.56, y1: 0.093 },
    nameMatch: { required: true, matched, side: 'killer' }, signal: matched });
  ok(vDet, k1(true)); ok(vDet, k1(false));
  let d = clone(det); d.detectorId = 'M3'; d.medal = { text: 'Survivor', class: 'reference' }; d.nameMatch = { required: false, matched: null }; ok(vDet, d);
  d.medal.class = 'other'; bad(vDet, d, 'medal class');
  d = clone(det); d.mode = 'dmz'; ok(vDet, d);
});

test('detection: suppressed record needs suppressedBy', () => {
  const d = clone(det); d.suppressed = true; bad(vDet, d, 'missing suppressedBy');
  d.suppressedBy = 'suppress_medals_in_replay'; d.detectorId = 'M3'; ok(vDet, d);
});

test('detection: name match required but null is rejected; not required may be null', () => {
  let d = clone(det); d.nameMatch.matched = null; bad(vDet, d, 'null while required');
  d = clone(det); d.nameMatch = { required: false, matched: null }; ok(vDet, d);
});

test('detection: negative cases rejected', () => {
  let d = clone(det); d.confidence = 1.2; bad(vDet, d, 'confidence');
  d = clone(det); d.cropPath = 'C:/Users/x/crop.png'; bad(vDet, d, 'absolute path'); // lint-allow: user-path
  d = clone(det); d.cropPath = 'docs/evidence/crop.png'; bad(vDet, d, 'committed folder');
  d = clone(det); d.cropPath = 'cache/../docs/a.png'; bad(vDet, d, 'dotdot');
  d = clone(det); d.cropPath = 'docs/evidence/private/g1/a.png'; ok(vDet, d);
  d = clone(det); d.sessionId = 'session1'; bad(vDet, d, 'session id');
  d = clone(det); d.timeSec = -1; bad(vDet, d, 'time');
  d = clone(det); d.mode = 'solo'; bad(vDet, d, 'mode');
  d = clone(det); delete d.ocrText; bad(vDet, d, 'ocrText');
  d = clone(det); d.extra = 1; bad(vDet, d, 'extra');
  d = clone(det); d.createdAt = '2026-10-27 12:00'; bad(vDet, d, 'timestamp');
});

// ---- labels ----
test('labels: fixture validates; session exists; windows ordered; ids unique', () => {
  ok(vLabels, labels);
  assert.ok(sessionIds.includes(labels.sessionId));
  for (const l of labels.labels) assert.ok(l.windowEndSec > l.windowStartSec, l.id);
  const ids = labels.labels.map((l) => l.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('labels: any file already in data/labels/ validates', () => {
  const dir = path.join(repo, 'data', 'labels');
  for (const f of existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith('.json')) : []) {
    const doc = readJson('data', 'labels', f);
    ok(vLabels, doc);
    assert.ok(sessionIds.includes(doc.sessionId), f);
    for (const l of doc.labels) assert.ok(l.windowEndSec > l.windowStartSec, f + ' ' + l.id);
  }
});

test('labels: negative cases rejected', () => {
  let l = clone(labels); l.labels[0].label = 'maybe'; bad(vLabels, l, 'label');
  l = clone(labels); l.labels[0].rating = 6; bad(vLabels, l, 'rating high');
  l = clone(labels); l.labels[0].rating = 0; bad(vLabels, l, 'rating low');
  l = clone(labels); l.labels[1].rating = 3; bad(vLabels, l, 'rating on reject');
  l = clone(labels); l.labels[0].reasonTags = ['Bad Tag']; bad(vLabels, l, 'tag');
  l = clone(labels); l.labels[0].reasonTags = ['a', 'a']; bad(vLabels, l, 'dup tags');
  l = clone(labels); delete l.labels[0].labeller; bad(vLabels, l, 'labeller');
  l = clone(labels); l.labels[0].labeller = 'jane'; bad(vLabels, l, 'real-looking labeller');
  l = clone(labels); l.labels[0].labeller = '<jane>'; bad(vLabels, l, 'labeller other than <user>');
  l = clone(labels); l.labels[1].note = 'free text note'; bad(vLabels, l, 'free-text note');
  l = clone(labels); l.labels[1].note = '<nothing-happens>'; bad(vLabels, l, 'note field removed (2026-10-28), placeholder too');
  l = clone(labels); l.$schema = 'anything'; bad(vLabels, l, 'no free-text $schema field');
  l = clone(labels); l.sessionId = 'nope'; bad(vLabels, l, 'session');
  l = clone(labels); l.labels[0].windowStartSec = -1; bad(vLabels, l, 'start');
  l = clone(labels); l.labels[0].windowEndSec = 0; bad(vLabels, l, 'end zero');
  l = clone(labels); l.labels[0].extra = 1; bad(vLabels, l, 'extra');
  l = clone(labels); l.version = 2; bad(vLabels, l, 'version');
});
