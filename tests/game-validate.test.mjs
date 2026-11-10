// SPDX-License-Identifier: GPL-3.0-or-later
// P2b W0: game pack validator (tools/game-validate.mjs): the CODM pack passes; broken cross-file references fail.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateGames } from '../tools/game-validate.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const games = path.join(repo, 'data', 'games');
const tool = path.join(repo, 'tools', 'game-validate.mjs');

// Temp games root: real schemas + the CODM pack files (never the gitignored local/ folder).
function build() {
  const dir = mkdtempSync(path.join(tmpdir(), 'ujw-games-'));
  for (const f of readdirSync(games)) {
    const src = path.join(games, f);
    if (statSync(src).isDirectory()) {
      cpSync(src, path.join(dir, f), { recursive: true, filter: (s) => !s.split(path.sep).includes('local') });
    } else cpSync(src, path.join(dir, f));
  }
  return dir;
}
const edit = (dir, file, fn) => {
  const f = path.join(dir, 'codm', file);
  const doc = JSON.parse(readFileSync(f, 'utf8'));
  fn(doc);
  writeFileSync(f, JSON.stringify(doc, null, 2) + '\n');
};
const det = (doc, id) => doc.detectors.find((d) => d.id === id);
const scr = (doc, id) => doc.screens.find((s) => s.id === id);
const messages = (dir) => validateGames(dir, repo).errors.map((e) => `${e.file}: ${e.message}`);

function expectError(t, file, fn, pattern) {
  const dir = build();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  edit(dir, file, fn);
  const msgs = messages(dir);
  assert.ok(msgs.some((m) => pattern.test(m)), `expected ${pattern} in:\n${msgs.join('\n')}`);
}

test('game-validate: committed packs are valid', () => {
  const { errors, packs } = validateGames(games, repo);
  assert.deepEqual(errors, []);
  assert.deepEqual(packs, [{ id: 'codm', version: '0.6.0' }]);
});

test('game-validate: a copy of the pack (without local/) is valid', (t) => {
  const dir = build();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(messages(dir), []);
});

test('game-validate: detector gate names a missing screen', (t) =>
  expectError(t, 'detectors.json', (d) => det(d, 'M5').screens.push('nowhere'), /M5: screen "nowhere" does not exist/));

test('game-validate: gate and screen must list each other', (t) => {
  expectError(t, 'detectors.json', (d) => { det(d, 'M5').screens = ['br_gameplay']; }, /br_gameplay: does not list detector M5/);
  expectError(t, 'screens.json', (d) => scr(d, 'mp_gameplay').detectors.push('B2'), /B2: screens gate lacks "mp_gameplay"/);
  expectError(t, 'screens.json', (d) => scr(d, 'mp_gameplay').detectors.push('Z9'), /mp_gameplay: detector "Z9" does not exist/);
});

test('game-validate: gate on a screen of another mode', (t) =>
  expectError(t, 'detectors.json', (d) => det(d, 'B1').screens.push('mp_gameplay'), /B1: screen "mp_gameplay" shares no mode/));

test('game-validate: suppression and end-screen rules need real detectors', (t) => {
  expectError(t, 'detectors.json', (d) => d.suppressionRules[0].suppress.push('Q7'), /suppression rule .*: detector "Q7" does not exist/);
  expectError(t, 'detectors.json', (d) => { d.suppressionRules[0].while = 'Q8'; }, /suppression rule .*: detector "Q8" does not exist/);
  expectError(t, 'detectors.json', (d) => d.endScreenRule.detectors.push('Q9'), /endScreenRule .*: detector "Q9" does not exist/);
  expectError(t, 'detectors.json', (d) => d.endScreenRule.detectors.push('M3'), /endScreenRule .*: M3 must have nameRequired true/);
});

test('game-validate: M3 catalogue must resolve in events.json', (t) => {
  expectError(t, 'detectors.json', (d) => { det(d, 'M3').catalogue = 'awards'; }, /M3: catalogue "awards" does not exist/);
  expectError(t, 'events.json', (d) => { d.catalogues[0].id = 'awards'; }, /catalogue "awards" is not used by any detector/);
  expectError(t, 'events.json', (d) => d.catalogues[0].events.push({ ...d.catalogues[0].events[0] }), /duplicate event "Double Kill"/);
});

test('game-validate: match reel rules (D315) are checked', (t) => {
  expectError(t, 'match-reels.json', (d) => { d.rules[0].when.result = 'WIN'; }, /won-top3: result "WIN" is not a pattern of W1/);
  expectError(t, 'match-reels.json', (d) => d.rules.push({ ...d.rules[0] }), /duplicate rule id "won-top3"/);
  expectError(t, 'match-reels.json', (d) => { d.rules[2].when.killsAbove = -1; }, /match-reels\.json: schema/);
  expectError(t, 'match-reels.json', (d) => { d.rules[0].when.place = 3; }, /match-reels\.json: schema/);
  expectError(t, 'match-reels.json', (d) => { d.game = 'other'; }, /game "other" does not match/);
});

test('game-validate: capture-plan detectors, modes and medals must exist', (t) => {
  expectError(t, 'capture-plan.json', (d) => { d.items[0].detector = 'K9'; }, /final_killcam_ign: detector "K9" does not exist/);
  expectError(t, 'capture-plan.json', (d) => { d.items.find((i) => i.medal).medal = 'Giga Kill'; }, /medal "Giga Kill" is not in catalogue "medals"/);
  expectError(t, 'capture-plan.json', (d) => { d.items.find((i) => i.id === 'br_revival').mode = 'mp'; }, /br_revival: detector N2 does not run in mode "mp"/);
  expectError(t, 'capture-plan.json', (d) => { d.items[0].mode = 'dmz'; }, /final_killcam_ign: mode "dmz" is tag-only/);
});

test('game-validate: no tag-only mode in a detector or a screen gate', (t) => {
  expectError(t, 'screens.json', (d) => scr(d, 'br_gameplay').modes.push('dmz'), /br_gameplay: runs detectors but lists tag-only mode "dmz"/);
  expectError(t, 'detectors.json', (d) => det(d, 'M1').modes.push('dmz'), /detectors\.json: schema: .*modes/);
  expectError(t, 'game.json', (d) => { d.taggingOnlyModes = ['zombies']; }, /game\.json: schema/);
});

test('game-validate: game ids agree with the folder', (t) => {
  expectError(t, 'game.json', (d) => { d.id = 'other'; }, /id "other" does not match the folder "codm"/);
  expectError(t, 'screens.json', (d) => { d.game = 'other'; }, /screens\.json: game "other" does not match/);
});

test('game-validate: reference dataset must sit in this pack\'s local/ folder', (t) =>
  expectError(t, 'detectors.json', (d) => { det(d, 'M3').referenceDataset.path = 'data/games/other/local/medals-reference'; }, /referenceDataset\.path must be under data\/games\/codm\/local\//));

test('game-validate: pairing rule screens must run its detector; excluded screens run nothing', (t) => {
  expectError(t, 'screens.json', (d) => d.pairingRules[0].screens.push('impact_play'), /pairing rule .*: screen "impact_play" does not run M1/);
  expectError(t, 'screens.json', (d) => { d.pairingRules[0].frameLevelName = true; }, /screens\.json: schema/);
  expectError(t, 'screens.json', (d) => { scr(d, 'summary').detectors = ['M1']; }, /screens\.json: schema/);
});

test('game-validate: missing pack file and evidence file', (t) => {
  const dir = build();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  rmSync(path.join(dir, 'codm', 'screens.json'));
  assert.ok(messages(dir).some((m) => /screens\.json: missing pack file/.test(m)));
  expectError(t, 'events.json', (d) => { d.catalogues[0].events[0].evidence = ['docs/evidence/2026-01-01-no-such-file.md']; }, /evidence file not found/);
});

test('game-validate: CLI exit code 0 on the committed packs, 1 on a broken pack', (t) => {
  const good = spawnSync(process.execPath, [tool, games, repo], { encoding: 'utf8', windowsHide: true });
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /OK: 1 game pack\(s\) valid: codm 0\.6\.0/);
  const dir = build();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  edit(dir, 'detectors.json', (d) => { det(d, 'K1').screens = ['mp_top3']; });
  const broken = spawnSync(process.execPath, [tool, dir, repo], { encoding: 'utf8', windowsHide: true });
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /FAIL: \d+ error\(s\)/);
});

// ---- W1: capture-plan match criteria (coverage tracker) ------------------------------

const item = (doc, id) => doc.items.find((i) => i.id === id);

test('game-validate: every capture-plan item states how it is matched (schema)', (t) => {
  expectError(t, 'capture-plan.json', (d) => { delete item(d, 'medal_brutal').match; }, /capture-plan\.json: schema: .*match/);
  expectError(t, 'capture-plan.json', (d) => { delete item(d, 'br_win').match.reason; }, /capture-plan\.json: schema: .*reason/);
  expectError(t, 'capture-plan.json', (d) => { item(d, 'medal_brutal').match.reason = 'x'; }, /capture-plan\.json: schema/);
  expectError(t, 'capture-plan.json', (d) => { delete item(d, 'medal_brutal').match.when; }, /capture-plan\.json: schema: .*when/);
  expectError(t, 'capture-plan.json', (d) => { delete item(d, 'br_multikill_banner').match.when[0].rois; }, /capture-plan\.json: schema: .*rois/);
  expectError(t, 'capture-plan.json', (d) => { item(d, 'medal_brutal').match.when[0].colour = 'gold'; }, /capture-plan\.json: schema/);
  expectError(t, 'capture-plan.json', (d) => { d.version = 1; }, /capture-plan\.json: schema: \/version/);
});

test('game-validate: match criteria use existing detectors, medals, patterns, ROIs and screens', (t) => {
  expectError(t, 'capture-plan.json', (d) => { item(d, 'medal_brutal').match.when[0].detector = 'M4'; }, /medal_brutal: match\.when\[0\]: detector "M4" is not the item detector M3/);
  expectError(t, 'capture-plan.json', (d) => { item(d, 'medal_brutal').match.when[0].medal = 'Giga Kill'; }, /medal "Giga Kill" is not in the catalogue of M3/);
  expectError(t, 'capture-plan.json', (d) => { item(d, 'medal_brutal').match.when[0].medal = 'Relentless'; }, /medal "Relentless" differs from the item medal "Brutal"/);
  expectError(t, 'capture-plan.json', (d) => { item(d, 'br_revival').match.when[0].pattern = 'Revive Me'; }, /pattern "Revive Me" is not a pattern of N2/);
  expectError(t, 'capture-plan.json', (d) => item(d, 'medal_brutal').match.when[0].rois.push('nowhere'), /ROI "nowhere" does not exist in M3/);
  expectError(t, 'capture-plan.json', (d) => { item(d, 'br_multikill_banner').match.when[0].rois = ['card_mp']; }, /ROI X1\/card_mp is for mode "mp", the item is "br"/);
  expectError(t, 'capture-plan.json', (d) => { item(d, 'mp_final_scoreboard').match.when[0].screen = 'nowhere'; }, /screen "nowhere" does not exist/);
  expectError(t, 'capture-plan.json', (d) => { item(d, 'mp_final_scoreboard').match.when[0].screen = 'impact_play'; }, /screen "impact_play" does not run M1/);
  expectError(t, 'capture-plan.json', (d) => { item(d, 'medal_brutal').match.when[0].frameModes = ['dmz']; }, /frame mode "dmz" is tag-only/);
  expectError(t, 'capture-plan.json', (d) => { item(d, 'medal_brutal').match.when[0].frameModes = ['br']; }, /M3 does not run in frame mode "br"/);
  expectError(t, 'capture-plan.json', (d) => { item(d, 'br_revival').match.when[0].nameMatched = true; }, /name criteria need a detector with nameRequired \(N2\)/);
});

test('game-validate: auto confirm only on measured (verified) positions', (t) => {
  // K1: the killer_name ROI is a guessed band, so the name check cannot be auto
  expectError(t, 'capture-plan.json', (d) => { const m = item(d, 'final_killcam_ign').match; m.confirm = 'auto'; delete m.reason; },
    /final_killcam_ign: match\.when\[0\]: confirm "auto" with nameMatched needs every K1 ROI verified; K1\/label is unverified/);
  expectError(t, 'capture-plan.json', (d) => { const m = item(d, 'final_killcam_ign').match; m.confirm = 'auto'; delete m.reason; m.when = [{ detector: 'K1', rois: ['killer_name'] }]; },
    /confirm "auto" needs verified ROIs; K1\/killer_name is unverified/);
  expectError(t, 'capture-plan.json', (d) => { const m = item(d, 'medal_brutal').match; delete m.when[0].rois; },
    /medal_brutal: match\.when\[0\]: confirm "auto" needs a measured position/);
  expectError(t, 'capture-plan.json', (d) => { const m = item(d, 'br_win').match; m.confirm = 'auto'; delete m.reason; m.when = [{ detector: 'M1' }]; },
    /br_win: no detector, so match\.confirm must be "manual"/);
  expectError(t, 'capture-plan.json', (d) => { item(d, 'br_win').match.when = [{ detector: 'M1' }]; },
    /br_win: no detector, so match\.when must be absent/);
  // a screen criterion can be auto only when the screen's cue ROIs are verified
  const dir = build();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  edit(dir, 'capture-plan.json', (d) => { const m = item(d, 'mp_final_scoreboard').match; m.confirm = 'auto'; delete m.reason; });
  assert.deepEqual(messages(dir), []); // mp_scoreboard cue is verified: allowed by the validator (the committed plan keeps it manual)
  edit(dir, 'screens.json', (d) => { scr(d, 'mp_scoreboard').cues[0].status = 'unverified'; });
  assert.ok(messages(dir).some((m) => /confirm "auto" needs verified cue ROIs; screen "mp_scoreboard" has an unverified cue/.test(m)), messages(dir).join(' | '));
});

test('game-validate: committed plan: manual items have reasons; auto items only use verified ROIs', () => {
  const plan = JSON.parse(readFileSync(path.join(games, 'codm', 'capture-plan.json'), 'utf8'));
  const confirm = Object.fromEntries(plan.items.map((i) => [i.id, i.match.confirm]));
  assert.deepEqual(confirm, {
    final_killcam_ign: 'manual', final_killcam_other: 'manual', mp_final_scoreboard: 'manual', br_revival: 'manual',
    br_multikill_banner: 'auto', br_win: 'manual',
    medal_relentless: 'auto', medal_brutal: 'auto', medal_nuclear: 'auto', medal_ultimate_terminator: 'auto',
  });
  assert.equal(plan.items.find((i) => i.id === 'br_win').match.when, undefined);
  for (const i of plan.items) assert.equal(i.status, 'missing', i.id); // runtime state never goes into this file
});
