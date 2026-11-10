// SPDX-License-Identifier: GPL-3.0-or-later
// Game pack validator (P2b W0; capture-plan match criteria W1).
// Usage: node tools/game-validate.mjs [gamesRoot] [repoRoot]
//   gamesRoot  default "data/games"; holds the *.schema.json files and one folder per game pack
//   repoRoot   default cwd; evidence paths resolve against it
// Each pack folder (data/games/<id>/) must hold game.json, detectors.json, events.json, screens.json and
// capture-plan.json and match-reels.json. Every file is checked against its schema, then the cross-file references are checked.
// The local/ folder (gitignored) is never read. Exit code 1 on any error; each error is printed with its file.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

export const PACK_FILES = {
  game: ['game.json', 'game.schema.json'],
  detectors: ['detectors.json', 'detector-pack.schema.json'],
  events: ['events.json', 'events.schema.json'],
  screens: ['screens.json', 'screens.schema.json'],
  capturePlan: ['capture-plan.json', 'capture-plan.schema.json'],
  matchReels: ['match-reels.json', 'match-reels.schema.json'],
};

// Screen kinds on which no detector runs (also enforced by screens.schema.json).
const EXCLUDED_KINDS = new Set(['menu', 'overlay', 'signal_loss']);
// Screen kinds that show other players' names and badges next to the profile name: only name-free context
// detectors (role context, nameRequired false) may run there (2026-11-10: C2 reads the mode header on summary).
const NAME_FREE_KINDS = new Set(['summary']);

function readJson(file, errors, rel) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    errors.push({ file: rel, message: `cannot parse JSON: ${e.message}` });
    return undefined;
  }
}

function dupes(list) {
  const seen = new Set();
  const out = new Set();
  for (const x of list) (seen.has(x) ? out : seen).add(x);
  return [...out];
}

// Cross-file checks on one loaded pack. `rel(name)` gives the display path of a pack file.
export function checkPack(id, p, rel, repoRoot) {
  const errors = [];
  const err = (name, message) => errors.push({ file: rel(name), message });
  const { game, detectors, events, screens, capturePlan, matchReels } = p;

  // game id everywhere
  if (game.id !== id) err('game.json', `id "${game.id}" does not match the folder "${id}"`);
  for (const [k, name] of [['detectors', 'detectors.json'], ['events', 'events.json'], ['screens', 'screens.json'], ['capturePlan', 'capture-plan.json'], ['matchReels', 'match-reels.json']]) {
    if (p[k].game !== game.id) err(name, `game "${p[k].game}" does not match game.json id "${game.id}"`);
  }

  // modes
  const modes = new Set(game.modes);
  const tagOnly = new Set(game.taggingOnlyModes);
  for (const m of tagOnly) if (!modes.has(m)) err('game.json', `taggingOnlyModes "${m}" is not in modes`);
  const liveModes = new Set(game.modes.filter((m) => !tagOnly.has(m)));
  if (!liveModes.size) err('game.json', 'no mode is left for detectors (every mode is tag-only)');

  // ids
  const detById = new Map(detectors.detectors.map((d) => [d.id, d]));
  const scrById = new Map(screens.screens.map((s) => [s.id, s]));
  const catById = new Map(events.catalogues.map((c) => [c.id, c]));
  for (const x of dupes(detectors.detectors.map((d) => d.id))) err('detectors.json', `duplicate detector id "${x}"`);
  for (const x of dupes(screens.screens.map((s) => s.id))) err('screens.json', `duplicate screen id "${x}"`);
  for (const x of dupes(events.catalogues.map((c) => c.id))) err('events.json', `duplicate catalogue id "${x}"`);
  for (const c of events.catalogues) {
    for (const x of dupes(c.events.map((e) => e.text))) err('events.json', `catalogue "${c.id}": duplicate event "${x}"`);
  }
  for (const x of dupes(screens.pairingRules.map((r) => r.id))) err('screens.json', `duplicate pairing rule id "${x}"`);
  for (const x of dupes(capturePlan.items.map((i) => i.id))) err('capture-plan.json', `duplicate item id "${x}"`);
  const needDet = (name, where, did) => {
    if (!detById.has(did)) { err(name, `${where}: detector "${did}" does not exist`); return false; }
    return true;
  };

  // detectors: modes, ROI modes, screen gate, catalogue, reference dataset
  const usedCatalogues = new Set();
  for (const d of detectors.detectors) {
    for (const m of d.modes) {
      if (!modes.has(m)) err('detectors.json', `${d.id}: mode "${m}" is not in game.json modes`);
      if (tagOnly.has(m)) err('detectors.json', `${d.id}: mode "${m}" is tag-only`);
      if (!d.rois.some((r) => !r.mode || r.mode === m)) err('detectors.json', `${d.id}: no ROI for mode "${m}"`);
    }
    for (const r of d.rois) {
      if (r.mode && !d.modes.includes(r.mode)) err('detectors.json', `${d.id}/${r.id}: ROI mode "${r.mode}" is not a detector mode`);
      if (!(r.x0 < r.x1 && r.y0 < r.y1)) err('detectors.json', `${d.id}/${r.id}: ROI corners out of order`);
    }
    for (const x of dupes(d.rois.map((r) => r.id))) err('detectors.json', `${d.id}: duplicate ROI id "${x}"`);
    for (const sid of d.screens) {
      const s = scrById.get(sid);
      if (!s) { err('detectors.json', `${d.id}: screen "${sid}" does not exist in screens.json`); continue; }
      if (!s.detectors.includes(d.id)) err('screens.json', `${sid}: does not list detector ${d.id}, but ${d.id} gates on it`);
      if (s.modes.length && !s.modes.some((m) => d.modes.includes(m))) err('detectors.json', `${d.id}: screen "${sid}" shares no mode with the detector`);
    }
    if (d.catalogue !== undefined) {
      usedCatalogues.add(d.catalogue);
      if (!catById.has(d.catalogue)) err('detectors.json', `${d.id}: catalogue "${d.catalogue}" does not exist in events.json`);
    }
    if (d.referenceDataset) {
      const want = `data/games/${game.id}/local/`;
      if (!d.referenceDataset.path.startsWith(want)) err('detectors.json', `${d.id}: referenceDataset.path must be under ${want}`);
    }
  }
  for (const c of events.catalogues) if (!usedCatalogues.has(c.id)) err('events.json', `catalogue "${c.id}" is not used by any detector`);

  // screens: detectors exist and gate back, modes, tag-only, evidence
  for (const s of screens.screens) {
    for (const m of s.modes) if (!modes.has(m)) err('screens.json', `${s.id}: mode "${m}" is not in game.json modes`);
    if (s.detectors.length) {
      for (const m of s.modes) if (tagOnly.has(m)) err('screens.json', `${s.id}: runs detectors but lists tag-only mode "${m}"`);
      if (EXCLUDED_KINDS.has(s.kind)) err('screens.json', `${s.id}: kind "${s.kind}" must not run detectors`);
    }
    for (const did of s.detectors) {
      if (!needDet('screens.json', s.id, did)) continue;
      if (!detById.get(did).screens.includes(s.id)) err('detectors.json', `${did}: screens gate lacks "${s.id}", but the screen lists ${did}`);
      const d = detById.get(did);
      if (NAME_FREE_KINDS.has(s.kind) && (d.role !== 'context' || d.nameRequired)) err('screens.json', `${s.id}: kind "${s.kind}" runs only name-free context detectors (role context, nameRequired false), not ${did}`);
    }
    for (const c of s.cues) if (c.roi && !(c.roi.x0 < c.roi.x1 && c.roi.y0 < c.roi.y1)) err('screens.json', `${s.id}: cue ROI corners out of order`);
  }

  // pairing rules
  for (const r of screens.pairingRules) {
    if (!needDet('screens.json', `pairing rule ${r.id}`, r.detector)) continue;
    for (const sid of r.screens) {
      const s = scrById.get(sid);
      if (!s) err('screens.json', `pairing rule ${r.id}: screen "${sid}" does not exist`);
      else if (!s.detectors.includes(r.detector)) err('screens.json', `pairing rule ${r.id}: screen "${sid}" does not run ${r.detector}`);
    }
  }

  // suppression and end-screen rules
  for (const rule of detectors.suppressionRules) {
    const ids = [rule.while, ...rule.suppress];
    if (!ids.every((did) => needDet('detectors.json', `suppression rule ${rule.id}`, did))) continue;
    const whileScreens = new Set(detById.get(rule.while).screens);
    for (const did of rule.suppress) {
      if (!detById.get(did).screens.some((s) => whileScreens.has(s))) err('detectors.json', `suppression rule ${rule.id}: ${did} never shares a screen with ${rule.while}`);
    }
  }
  const esr = detectors.endScreenRule;
  if (esr) {
    for (const did of esr.detectors) {
      if (!needDet('detectors.json', `endScreenRule ${esr.id}`, did)) continue;
      const d = detById.get(did);
      if (!d.nameRequired) err('detectors.json', `endScreenRule ${esr.id}: ${did} must have nameRequired true`);
      for (const sid of d.screens) {
        const s = scrById.get(sid);
        if (s && s.kind !== 'end_screen') err('detectors.json', `endScreenRule ${esr.id}: ${did} gates on "${sid}", which is not an end screen`);
      }
    }
  }

  // capture plan
  for (const i of capturePlan.items) {
    if (!modes.has(i.mode)) err('capture-plan.json', `${i.id}: mode "${i.mode}" is not in game.json modes`);
    if (tagOnly.has(i.mode)) err('capture-plan.json', `${i.id}: mode "${i.mode}" is tag-only`);
    if (i.detector === null) {
      if (i.match.confirm !== 'manual') err('capture-plan.json', `${i.id}: no detector, so match.confirm must be "manual"`);
      if (i.match.when) err('capture-plan.json', `${i.id}: no detector, so match.when must be absent`);
      continue;
    }
    if (!needDet('capture-plan.json', i.id, i.detector)) continue;
    const d = detById.get(i.detector);
    if (!d.modes.includes(i.mode)) err('capture-plan.json', `${i.id}: detector ${i.detector} does not run in mode "${i.mode}"`);
    if (i.medal !== undefined) {
      const cat = catById.get(d.catalogue);
      if (!cat) err('capture-plan.json', `${i.id}: detector ${i.detector} has no event catalogue`);
      else if (!cat.events.some((e) => e.text === i.medal)) err('capture-plan.json', `${i.id}: medal "${i.medal}" is not in catalogue "${cat.id}"`);
    }
    checkMatch(i, d);
  }

  // capture-plan match criteria (W1 coverage tracker). Criteria may only use existing detector,
  // screen and medal definitions; "auto" needs every position it relies on to be measured (verified).
  function checkMatch(i, d) {
    const where = `${i.id}: match`;
    const auto = i.match.confirm === 'auto';
    const roiById = new Map(d.rois.map((r) => [r.id, r]));
    for (const [n, c] of (i.match.when || []).entries()) {
      const at = `${where}.when[${n}]`;
      if (c.detector !== i.detector) { err('capture-plan.json', `${at}: detector "${c.detector}" is not the item detector ${i.detector}`); continue; }
      let measured = false;
      if (c.medal !== undefined) {
        const cat = catById.get(d.catalogue);
        if (!cat || !cat.events.some((e) => e.text === c.medal)) err('capture-plan.json', `${at}: medal "${c.medal}" is not in the catalogue of ${d.id}`);
        if (i.medal !== undefined && c.medal !== i.medal) err('capture-plan.json', `${at}: medal "${c.medal}" differs from the item medal "${i.medal}"`);
      }
      if (c.pattern !== undefined && !(d.patterns || []).includes(c.pattern)) err('capture-plan.json', `${at}: pattern "${c.pattern}" is not a pattern of ${d.id}`);
      for (const rid of c.rois || []) {
        const r = roiById.get(rid);
        if (!r) { err('capture-plan.json', `${at}: ROI "${rid}" does not exist in ${d.id}`); continue; }
        if (r.mode && r.mode !== i.mode) err('capture-plan.json', `${at}: ROI ${d.id}/${rid} is for mode "${r.mode}", the item is "${i.mode}"`);
        if (auto && r.status !== 'verified') err('capture-plan.json', `${at}: confirm "auto" needs verified ROIs; ${d.id}/${rid} is ${r.status} (use manual)`);
        measured = true;
      }
      if ((c.nameInRoi !== undefined || c.nameMatched !== undefined) && !d.nameRequired) err('capture-plan.json', `${at}: name criteria need a detector with nameRequired (${d.id})`);
      if (c.nameMatched !== undefined && auto) {
        for (const r of d.rois) if (r.status !== 'verified') err('capture-plan.json', `${at}: confirm "auto" with nameMatched needs every ${d.id} ROI verified; ${d.id}/${r.id} is ${r.status} (use manual)`);
      }
      if (c.screen !== undefined) {
        const s = scrById.get(c.screen);
        if (!s) err('capture-plan.json', `${at}: screen "${c.screen}" does not exist`);
        else {
          if (!s.detectors.includes(d.id)) err('capture-plan.json', `${at}: screen "${c.screen}" does not run ${d.id}`);
          if (s.modes.length && !s.modes.includes(i.mode)) err('capture-plan.json', `${at}: screen "${c.screen}" is not a "${i.mode}" screen`);
          const cues = s.cues.filter((q) => q.roi);
          if (!cues.length) err('capture-plan.json', `${at}: screen "${c.screen}" has no cue with a ROI`);
          if (auto) for (const q of cues) if (q.status !== 'verified') err('capture-plan.json', `${at}: confirm "auto" needs verified cue ROIs; screen "${c.screen}" has an unverified cue (use manual)`);
          if (cues.length) measured = true;
        }
      }
      for (const m of c.frameModes || []) {
        if (!modes.has(m)) err('capture-plan.json', `${at}: frame mode "${m}" is not in game.json modes`);
        else if (tagOnly.has(m)) err('capture-plan.json', `${at}: frame mode "${m}" is tag-only`);
        else if (!d.modes.includes(m)) err('capture-plan.json', `${at}: ${d.id} does not run in frame mode "${m}"`);
      }
      if (auto && !measured) err('capture-plan.json', `${at}: confirm "auto" needs a measured position (rois or screen); use manual`);
    }
  }

  // match reel rules (D315): unique ids; a result must be a pattern of the match-result detector W1
  for (const x of dupes(matchReels.rules.map((r) => r.id))) err('match-reels.json', `duplicate rule id "${x}"`);
  const w1 = detectors.detectors.find((d) => d.id === 'W1');
  for (const r of matchReels.rules) {
    if (r.when.result === undefined) continue;
    if (!w1) err('match-reels.json', `${r.id}: result needs the match-result detector W1`);
    else if (!(w1.patterns || []).includes(r.when.result)) err('match-reels.json', `${r.id}: result "${r.when.result}" is not a pattern of W1`);
  }
  // D326: qualifying-rounds pieces need a round condition; the impact-play reel names pack detectors
  for (const r of matchReels.rules) {
    if (r.pieces === 'qualifying-rounds' && r.when.roundKillsAtLeast === undefined) err('match-reels.json', `${r.id}: pieces "qualifying-rounds" needs when.roundKillsAtLeast`);
  }
  const ip = matchReels.impactPlay;
  if (ip) {
    for (const k of ['detector', 'resultsDetector']) {
      if (ip[k] !== undefined && !detectors.detectors.some((d) => d.id === ip[k])) err('match-reels.json', `impactPlay.${k} "${ip[k]}" is not a detector of this pack`);
    }
    if (ip.minSec > ip.maxSec) err('match-reels.json', 'impactPlay: minSec is above maxSec');
  }

  // evidence paths exist
  const evidence = [
    ...events.catalogues.flatMap((c) => c.events.flatMap((e) => (e.evidence || []).map((x) => ['events.json', x]))),
    ...screens.screens.flatMap((s) => (s.evidence || []).map((x) => ['screens.json', x])),
    ...screens.pairingRules.flatMap((r) => (r.evidence || []).map((x) => ['screens.json', x])),
  ];
  for (const [name, x] of evidence) if (!existsSync(path.join(repoRoot, x))) err(name, `evidence file not found: ${x}`);
  return errors;
}

export function validateGames(gamesRoot, repoRoot = process.cwd()) {
  const errors = [];
  const relRoot = (f) => path.relative(repoRoot, f).split(path.sep).join('/');
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validators = {};
  for (const [k, [, schemaFile]] of Object.entries(PACK_FILES)) {
    const f = path.join(gamesRoot, schemaFile);
    const schema = existsSync(f) ? readJson(f, errors, relRoot(f)) : undefined;
    if (!schema) { if (!existsSync(f)) errors.push({ file: relRoot(f), message: 'schema file missing' }); continue; }
    try { validators[k] = ajv.compile(schema); } catch (e) { errors.push({ file: relRoot(f), message: `schema does not compile: ${e.message}` }); }
  }
  if (errors.length) return { errors, packs: [] };
  const ids = readdirSync(gamesRoot).filter((x) => statSync(path.join(gamesRoot, x)).isDirectory()).sort();
  if (!ids.length) errors.push({ file: relRoot(gamesRoot), message: 'no game pack folder' });
  const packs = [];
  for (const id of ids) {
    const dir = path.join(gamesRoot, id);
    const rel = (name) => relRoot(path.join(dir, name));
    const p = {};
    let ok = true;
    for (const [k, [file]] of Object.entries(PACK_FILES)) {
      const f = path.join(dir, file);
      if (!existsSync(f)) { errors.push({ file: rel(file), message: 'missing pack file' }); ok = false; continue; }
      const doc = readJson(f, errors, rel(file));
      if (doc === undefined) { ok = false; continue; }
      if (!validators[k](doc)) {
        ok = false;
        for (const e of validators[k].errors) errors.push({ file: rel(file), message: `schema: ${e.instancePath || '/'} ${e.message}` });
      }
      p[k] = doc;
    }
    if (!ok) continue; // cross-file checks need schema-valid files
    const found = checkPack(id, p, rel, repoRoot);
    errors.push(...found);
    if (!found.length) packs.push({ id, version: p.detectors.version });
  }
  return { errors, packs };
}

// ---- CLI ------------------------------------------------------------------------

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const gamesRoot = path.resolve(process.argv[2] ?? path.join('data', 'games'));
  const repoRoot = path.resolve(process.argv[3] ?? process.cwd());
  if (!existsSync(gamesRoot) || !statSync(gamesRoot).isDirectory()) {
    console.error(`games root not found: ${gamesRoot}`);
    process.exit(1);
  }
  const { errors, packs } = validateGames(gamesRoot, repoRoot);
  if (errors.length) {
    for (const e of errors) console.error(`${e.file}: ${e.message}`);
    console.error(`FAIL: ${errors.length} error(s)`);
    process.exit(1);
  }
  console.log(`OK: ${packs.length} game pack(s) valid: ${packs.map((x) => `${x.id} ${x.version}`).join(', ')}`);
}
