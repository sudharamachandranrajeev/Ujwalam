// SPDX-License-Identifier: GPL-2.0-or-later
// Private test stream options of the launcher (services/studio-ui/launch.mjs): --sinks (plan selection),
// --twitch-bandwidth-test (host flag, fail-closed check), --test-stream-minutes / --test-sink-minutes (live-test
// guard). Pure parts directly; the launcher end to end with the fake host (no libobs, no keychain, no network, no
// platform): the fake host simulates sinks going live as if started from the control page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planFile, realSinkIds } from '../app/host/lib/outputs-plan.mjs';
import { ALPHA_LIVE_PLAN, bandwidthTestProblems, hostLaunchSpec, liveTestOptions, liveTestPlanProblems, main as launchMain } from '../services/studio-ui/launch.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(REPO, 'tests', 'fixtures');
const tmp = (p) => mkdtempSync(path.join(os.tmpdir(), `ujw-livetest-${p}-`));
const CFG = { runtime: 'C:/rt', dataDir: 'C:/hd', recordings: 'C:/hd/rec', overlayRoot: REPO, overlayScript: path.join(REPO, 'app', 'host', 'overlay', 'child.mjs') };

test('plan selection: --sinks keeps the chosen real sinks and the recording; an unused rung is not created', () => {
  const all = planFile(ALPHA_LIVE_PLAN, { allowLive: true });
  assert.deepEqual(realSinkIds(all.config, all.wrapper.targets), ['youtube-h', 'youtube-v', 'twitch', 'kick']);
  assert.deepEqual(all.params.sinks.map((s) => s.id), ['youtube-h', 'youtube-v', 'twitch', 'kick', 'record']);
  const three = planFile(ALPHA_LIVE_PLAN, { allowLive: true, select: ['youtube-h', 'youtube-v', 'twitch'] });
  assert.deepEqual(three.params.sinks.map((s) => s.id), ['youtube-h', 'youtube-v', 'twitch', 'record']);
  assert.deepEqual(three.params.rungs.map((r) => r.id), ['yt-h', 'reencode-tk', 'vert']);
  const yt = planFile(ALPHA_LIVE_PLAN, { allowLive: true, select: ['youtube-h', 'youtube-v'] });
  assert.deepEqual(yt.params.rungs.map((r) => r.id), ['yt-h', 'vert'], 'no Twitch/Kick re-encode rung without its sinks');
  assert.throws(() => planFile(ALPHA_LIVE_PLAN, { allowLive: true, select: ['record'] }), /"record" is not a real sink/);
  assert.throws(() => planFile(ALPHA_LIVE_PLAN, { allowLive: true, select: ['facebook'] }), /not a real sink .*youtube-h, youtube-v, twitch, kick/);
  assert.throws(() => planFile(ALPHA_LIVE_PLAN, { allowLive: true, select: [] }), /at least one/);
  assert.throws(() => planFile(ALPHA_LIVE_PLAN, { allowLive: true, select: ['twitch', 'twitch'] }), /twice/);
  assert.throws(() => planFile(ALPHA_LIVE_PLAN, { select: ['twitch'] }), /refused: plan with allowLive/, 'selection never bypasses the live gate');
});

test('options: all four need --alpha --live; values are checked; the budget file is loaded only for the guard', () => {
  assert.deepEqual(liveTestOptions({}).problems, []);
  assert.match(liveTestOptions({ alpha: true, sinks: 'twitch' }).problems[0], /need --alpha --live/);
  assert.match(liveTestOptions({ live: true, 'twitch-bandwidth-test': true }).problems[0], /need --alpha --live/);
  const L = { alpha: true, live: true };
  assert.deepEqual(liveTestOptions({ ...L, sinks: 'youtube-h,youtube-v,twitch' }).select, ['youtube-h', 'youtube-v', 'twitch']);
  assert.match(liveTestOptions({ ...L, sinks: true }).problems[0], /--sinks needs/);
  assert.match(liveTestOptions({ ...L, sinks: 'You Tube' }).problems[0], /--sinks needs/);
  assert.match(liveTestOptions({ ...L, 'twitch-bandwidth-test': 'yes' }).problems[0], /takes no value/);
  assert.match(liveTestOptions({ ...L, 'test-stream-minutes': '0' }).problems[0], /needs minutes/);
  assert.match(liveTestOptions({ ...L, 'test-sink-minutes': 'kick=2' }).problems[0], /needs --test-stream-minutes/);
  const ok = liveTestOptions({ ...L, 'test-stream-minutes': '15', 'test-sink-minutes': 'kick=2', 'twitch-bandwidth-test': true });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.minutes, 15);
  assert.deepEqual(ok.sinkMinutes, { kick: 2 });
  assert.equal(ok.bandwidthTest, true);
  assert.equal(ok.budget.cumulativePct, 1.0);
  const d = tmp('budget');
  const bf = path.join(d, 'b.json');
  writeFileSync(bf, '{}');
  assert.match(liveTestOptions({ ...L, 'test-stream-minutes': '15' }, { budgetFile: bf }).problems[0], /live-test budget/);
});

test('plan checks: the bandwidth test needs a twitch sink; sink limits must name configured sinks', () => {
  const p = planFile(ALPHA_LIVE_PLAN, { allowLive: true, select: ['youtube-h', 'youtube-v'] }).params.sinks;
  assert.match(liveTestPlanProblems({ bandwidthTest: true, sinkMinutes: {} }, p)[0], /no twitch sink/);
  assert.match(liveTestPlanProblems({ bandwidthTest: false, sinkMinutes: { kick: 2 } }, p)[0], /"kick" is not a configured sink/);
  const q = planFile(ALPHA_LIVE_PLAN, { allowLive: true }).params.sinks;
  assert.deepEqual(liveTestPlanProblems({ bandwidthTest: true, sinkMinutes: { kick: 2 } }, q), []);
});

test('bandwidth test check fails closed: host flag off, a twitch sink without it, or no twitch sink', () => {
  const tw = { id: 'twitch', kind: 'stream', platform: 'twitch', bandwidthTest: true };
  assert.deepEqual(bandwidthTestProblems({ twitchBandwidthTest: true, sinks: [tw, { id: 'youtube-h', kind: 'stream', platform: 'youtube', bandwidthTest: false }] }), []);
  assert.match(bandwidthTestProblems({ sinks: [tw] })[0], /old host build/);
  assert.match(bandwidthTestProblems({ twitchBandwidthTest: true, sinks: [{ ...tw, bandwidthTest: false }] })[0], /not in bandwidth-test mode/);
  assert.match(bandwidthTestProblems({ twitchBandwidthTest: true, sinks: [] })[0], /no twitch sink/);
  assert.ok(bandwidthTestProblems(null).length >= 2);
});

test('host argv: --twitch-bandwidth-test only with --alpha --live', () => {
  const spec = (args, alpha = true) => hostLaunchSpec({ hostCfg: CFG, hostDiscovery: 'x', args, alpha, corePort: 1, coreApiToken: 'a'.repeat(64) }).argv;
  assert.ok(spec({ live: true, 'twitch-bandwidth-test': true }).includes('--twitch-bandwidth-test'));
  assert.ok(!spec({ 'twitch-bandwidth-test': true }).includes('--twitch-bandwidth-test'));
  assert.ok(!spec({ live: true, 'twitch-bandwidth-test': true }, false).includes('--twitch-bandwidth-test'));
  assert.ok(!spec({ live: true }).includes('--twitch-bandwidth-test'));
});

test('launcher refuses the options without --alpha --live before anything is written', async () => {
  const d = tmp('flags');
  const logs = [];
  const orig = console.log;
  console.log = (s) => logs.push(String(s));
  try {
    assert.equal(await launchMain(['--data-dir', d, '--alpha', '--sinks', 'twitch']), 2);
    assert.equal(await launchMain(['--data-dir', d, '--alpha', '--live', '--test-stream-minutes', 'x']), 2);
  } finally { console.log = orig; }
  assert.match(logs.join('\n'), /need --alpha --live/);
  assert.match(logs.join('\n'), /--test-stream-minutes needs minutes/);
  assert.deepEqual(readdirSync(d), []);
});

// ---- end to end with the fake host ------------------------------------------------------------------------

function runLauncher(extra, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(REPO, 'services', 'studio-ui', 'launch.mjs'), '--alpha', '--mock', '--no-open', ...extra], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    const t = setTimeout(() => { child.kill(); reject(new Error(`launcher timed out:\n${out}`)); }, 150_000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => { clearTimeout(t); resolve({ code, out }); });
  });
}

function setup(name) {
  const root = tmp(name);
  const dataDir = path.join(root, 'core');
  const rec = path.join(root, 'record.json');
  const profile = path.join(root, 'profile.json');
  writeFileSync(profile, readFileSync(path.join(FIX, 'project', 'profile.fixture.json')));
  const hostData = path.join(root, 'host');
  const env = {
    UJWALAM_OBS_RUNTIME: root, UJWALAM_HOST_DATA: hostData, UJWALAM_OVERLAY_ROOT: path.join(root, 'no-overlays'),
    UJWALAM_FAKE_HOST_RECORD: rec, UJWALAM_ALPHA_STATS_MS: '60000', UJWALAM_FAKE_HOST_STREAM_AFTER_MS: '3000',
  };
  const args = ['--data-dir', dataDir, '--host-exe', path.join(FIX, 'studio-ui', 'fake-host.mjs'), '--profile', profile, '--feedback-dir', path.join(root, 'feedback'), '--live'];
  const calls = () => readFileSync(`${rec}.calls.jsonl`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const report = () => {
    const logs = path.join(dataDir, 'logs');
    const f = readdirSync(logs).find((n) => /^live-test-.*\.json$/.test(n));
    return f ? { json: JSON.parse(readFileSync(path.join(logs, f), 'utf8')), text: readFileSync(path.join(logs, f.replace(/\.json$/, '.txt')), 'utf8') } : null;
  };
  return { root, dataDir, hostData, rec, env, args, calls, report };
}

test('launcher end to end: --sinks + --twitch-bandwidth-test + guard; sink limit, then a normal stop of everything (exit 0)', { timeout: 180_000 }, async () => {
  const s = setup('ok');
  const r = await runLauncher([...s.args, '--sinks', 'youtube-h,twitch', '--twitch-bandwidth-test', '--test-stream-minutes', '0.25', '--test-sink-minutes', 'twitch=0.1'], s.env);
  assert.equal(r.code, 0, r.out);
  const host = JSON.parse(readFileSync(s.rec, 'utf8'));
  assert.ok(host.argv.includes('--allow-live') && host.argv.includes('--twitch-bandwidth-test'));
  const params = JSON.parse(readFileSync(path.join(s.hostData, 'outputs-params.json'), 'utf8'));
  assert.deepEqual(params.sinks.map((x) => x.id), ['youtube-h', 'twitch', 'record']);
  assert.ok(!host.calls.some((m) => /(^|\.)start$/.test(m) && m !== 'record.start'), 'the launcher and guard never start an output');
  assert.ok(!host.calls.includes('record.start'));
  const stops = s.calls().filter((x) => x.method === 'outputs.stop').map((x) => x.params);
  assert.deepEqual(stops, [{ sinks: ['twitch'] }, {}], 'twitch at its limit, then everything');
  assert.match(r.out, /sink twitch: twitch live, keyPresent no, urlPresent no, TWITCH BANDWIDTH TEST \(not broadcast\)/);
  assert.match(r.out, /twitch bandwidth test: ON for every twitch sink/);
  assert.match(r.out, /\[guard\] ARMED/);
  assert.match(r.out, /\[guard\] END: time-limit/);
  const rep = s.report();
  assert.ok(rep, 'report written');
  assert.equal(rep.json.end.reason, 'time-limit');
  assert.deepEqual(rep.json.sinks.map((x) => [x.id, x.stoppedBy, x.finalState]), [['youtube-h', 'guard-time-limit', 'stopped'], ['twitch', 'guard-sink-limit', 'stopped'], ['record', 'guard-time-limit', 'stopped']]);
  assert.equal(rep.json.sinks.find((x) => x.id === 'twitch').bandwidthTest, true);
  assert.ok(rep.json.sinks.every((x) => x.kbpsAvg > 5000 && x.kbpsAvg < 7000), JSON.stringify(rep.json.sinks));
  assert.ok(rep.json.sinks.every((x) => x.encoderSkipped === 0 && x.renderLagged === 0 && x.networkDropped === 0), 'host-wide counters count from the first sample');
  assert.deepEqual(rep.json.notes, ['twitch: Twitch bandwidth-test mode (received by Twitch, not broadcast)']);
  const all = JSON.stringify(rep.json) + rep.text + r.out;
  for (const bad of ['Ujwalam/stream/', 'rtmps://', 'rtmp://', 'bandwidthtest=true']) assert.ok(!(JSON.stringify(rep.json) + rep.text).includes(bad), `report carries ${bad}`);
  assert.ok(!/[0-9a-f]{64}/.test(all), 'no token-shaped value printed');
});

test('launcher end to end: dropped frames past the budget stop everything (exit 4) with a report', { timeout: 180_000 }, async () => {
  const s = setup('drop');
  // 2 % network + 2 % encoder-skipped: each under the 3 % window budget, together over it.
  const r = await runLauncher([...s.args, '--sinks', 'youtube-h', '--test-stream-minutes', '5'], { ...s.env, UJWALAM_FAKE_HOST_DROP_PCT: '2', UJWALAM_FAKE_HOST_SKIP_PCT: '2' });
  assert.equal(r.code, 4, r.out);
  assert.match(r.out, /\[guard\] ABORT: dropped-window \(sink youtube-h\)/);
  const stops = s.calls().filter((x) => x.method === 'outputs.stop').map((x) => x.params);
  assert.deepEqual(stops, [{}]);
  const rep = s.report();
  assert.equal(rep.json.end.code, 4);
  assert.match(rep.text, /STOPPED BY THE GUARD/);
  assert.ok(existsSync(path.join(s.dataDir, 'logs')));
});
