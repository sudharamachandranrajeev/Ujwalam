// SPDX-License-Identifier: GPL-3.0-or-later
// D327 launch wiring (pure parts of launch.mjs): the --live plan from Settings > Stream (flag stream-settings), and the
// event core's Streamer.bot address and LAN listener from Settings > Integrations (flag integrations). No process starts.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { ALPHA_LIVE_PLAN, coreServeArgs, livePlanFile, planForStart } from '../services/studio-ui/launch.mjs';
import { botUrl, integrationsInEffect, writeIntegrations } from '../services/studio-ui/integrations.mjs';
import { seedSetup, writeSetup } from '../services/studio-ui/stream-setup.mjs';
import { planTargets } from '../services/studio-ui/readiness.mjs';

const dirs = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-d327-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

test('planForStart: a refused live plan never keeps the studio from opening (2026-11-13 Instagram server address missing)', async () => {
  const igRefused = new Error('sink "instagram": no server address is stored in Windows Credential Manager target Ujwalam/stream/instagram-server');
  const record = () => ({ file: 'record', planned: 'R' });
  // Instagram on, its address missing: the rest of the live plan, with the reason logged.
  let logs = [];
  const r = await planForStart({ live: true, instagramOn: true, recordPlan: record, log: (l) => logs.push(l),
    planOnce: async ({ instagramOn }) => { if (instagramOn) throw igRefused; return { file: 'live', planned: 'L' }; } });
  assert.deepEqual(r, { file: 'live', planned: 'L' });
  assert.match(logs[0], /instagram-server/);
  assert.match(logs[1], /Instagram Live left out/);
  // The live plan refused with or without Instagram: the record plan (the window still opens).
  logs = [];
  const r2 = await planForStart({ live: true, instagramOn: true, recordPlan: record, log: (l) => logs.push(l), planOnce: async () => { throw new Error('twitch: no key'); } });
  assert.deepEqual(r2, { file: 'record', planned: 'R' });
  assert.match(logs.at(-1), /opens without stream outputs/);
  // Instagram off: no second try, straight to the record plan.
  let tries = 0;
  const r3 = await planForStart({ live: true, instagramOn: false, recordPlan: record, log: () => {}, planOnce: async () => { tries++; throw new Error('x'); } });
  assert.equal(tries, 1);
  assert.equal(r3.file, 'record');
  // Not live (an explicit --outputs plan): a refusal still stops the start.
  await assert.rejects(planForStart({ live: false, instagramOn: false, recordPlan: record, log: () => {}, planOnce: async () => { throw new Error('bad plan'); } }), /bad plan/);
  // A good plan is used as it is.
  assert.deepEqual(await planForStart({ live: true, instagramOn: true, recordPlan: record, log: () => {}, planOnce: async () => ({ file: 'live', planned: 'L' }) }), { file: 'live', planned: 'L' });
});

test('livePlanFile: alpha-live.json with the flag off or no saved setup; the generated plan otherwise', () => {
  const d = mk();
  assert.equal(livePlanFile({ dataDir: d, streamSettingsOn: false }), ALPHA_LIVE_PLAN);
  assert.equal(livePlanFile({ dataDir: d, streamSettingsOn: true }), ALPHA_LIVE_PLAN, 'no setup saved yet');
  const seed = seedSetup();
  assert.ok(writeSetup(d, seed).ok);
  assert.equal(livePlanFile({ dataDir: d, streamSettingsOn: false }), ALPHA_LIVE_PLAN, 'flag off ignores the setup');
  const f = livePlanFile({ dataDir: d, streamSettingsOn: true });
  assert.equal(f, path.join(d, 'outputs', 'stream-setup-plan.json'));
  const j = JSON.parse(readFileSync(f, 'utf8'));
  assert.equal(j.targets.record.name, 'alpha.mkv');
  assert.equal(j.targets['record-v'].name, 'alpha-v.mkv', 'LC1: the V recording follows the H name');
  // Readiness reads the same plan: Credential Manager target names only, never a value.
  const t = planTargets(f);
  assert.ok(t.length >= 1);
  for (const x of t) assert.match(x.keyRef, /^Ujwalam\/stream\/[a-z0-9-]+$/);
  assert.ok(!/"key"\s*:|live_[0-9a-z]{6,}/i.test(readFileSync(f, 'utf8')), 'no key in the plan file');
});

test('livePlanFile: a setup over a platform limit stops the start with the problem', () => {
  const d = mk();
  const seed = seedSetup();
  // Written around the validator on purpose (a hand-edited file): the launcher must still refuse it.
  writeFileSync(path.join(d, 'stream-setup.json'), JSON.stringify({ ...seed, outputs: [{ id: 'kick', name: 'Kick', platform: 'kick', canvas: 'H', enabled: true }],
    video: { ...seed.video, bitrateKbps: 17000 } }));
  assert.throws(() => livePlanFile({ dataDir: d, streamSettingsOn: true }), /Settings > Stream has problems: .*8000/);
});

test('coreServeArgs: --lan (and --lan-address) only when remote is given; never a token in argv', () => {
  const d = mk();
  assert.ok(!coreServeArgs({ dataDir: d, sbWs: { ws: botUrl(8093) } }).argv.includes('--lan'));
  const a = coreServeArgs({ dataDir: d, sbWs: { ws: botUrl(8093) }, remote: { address: '192.168.1.20' } }).argv;
  assert.deepEqual(a.slice(a.indexOf('--lan'), a.indexOf('--lan') + 3), ['--lan', '--lan-address', '192.168.1.20']);
  assert.deepEqual(a.slice(-2), ['--url', 'ws://127.0.0.1:8093/']);
  const m = coreServeArgs({ dataDir: d, mock: true, remote: { address: null } }).argv;
  assert.ok(m.includes('--lan') && !m.includes('--lan-address') && m.includes('--mock'));
  assert.ok(a.every((x) => !/^[0-9a-f]{64}$/.test(x)));
});

test('integrationsInEffect: flag off = profile ports and remote off, whatever is stored; flag on = stored', () => {
  const d = mk();
  const bc = { streamerbot: { port: 8093 }, speakerbot: { port: 7580 } };
  assert.ok(writeIntegrations(d, { version: 1, bots: { streamerbot: { port: 9001 }, speakerbot: { port: 9002 } }, remote: { enabled: true, address: null } }).ok);
  const off = integrationsInEffect(d, bc, false);
  assert.equal(off.bots.streamerbot.port, 8093);
  assert.equal(off.remote.enabled, false);
  const on = integrationsInEffect(d, bc, true);
  assert.equal(on.bots.streamerbot.port, 9001);
  assert.equal(on.remote.enabled, true);
  writeFileSync(path.join(d, 'integrations.json'), '{ broken');
  assert.equal(integrationsInEffect(d, bc, true).remote.enabled, false, 'a corrupt file never turns remote on');
});
