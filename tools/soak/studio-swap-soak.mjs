// SPDX-License-Identifier: GPL-3.0-or-later
// LU4 studio window swap under a loopback stream (D346). Node stdlib + repo modules.
//
//   node tools/soak/studio-swap-soak.mjs [--swaps 20] [--work-dir DIR] [--wait]
//
// What runs: the headless alpha stack (stack.mjs, swap: true) streaming to its loopback RTMP listeners, and the real
// Qt studio (UJWALAM_HEADLESS=1 + UJWALAM_STUDIO_HIDDEN=1: the window is laid out but never on screen) behind the
// launcher's studio slot (services/supervisor/slots.mjs createStudioSlot, spawned with launch.mjs spawnStudio). The
// host embeds its H and V previews into the studio's hidden preview slots. Each round swaps the studio to the other of
// two staged builds (copies of the built exe): the old window closes with "swap-close", a new one-time key goes to
// the UI server, the new exe logs in and the previews are embedded again. Then a build that crashes at start is
// swapped in: it must be rolled back (restored-old) and the previews must come back.
// Pass: every swap 'swapped'; each time both previews back within 3 s of the old window's exit (and open in the host's
// preview.list); never two studio windows at once; the rollback restored-old with the previews back; 0 dropped,
// render-lagged and encode-skipped frames on the host; 0 dropped frames on every sink; every required stream live at
// every sample; no unplanned exit of the host, the core or the UI server. Loopback only (the stack refuses real targets).

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { busyProcesses, missingRequiredStreams, REQUIRED_STREAMS } from './live-soak.mjs';
import { preflight, REPO, setBelow, startStack } from './stack.mjs';
import { createStudioSlot } from '../../services/supervisor/slots.mjs';
import { spawnStudio } from '../../services/studio-ui/launch.mjs';
import { EXE as STUDIO_EXE, qtDir } from '../../app/studio/tools/build.mjs';
import { track } from '../proc-registry.mjs';

const t0 = performance.now();
const log = (...a) => console.log(`[studio-swap-soak +${Math.round((performance.now() - t0) / 1000)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const PREVIEW_BACK_MS = 3000; // plan row LU4: previews back within 3 s

export function parseStudioSwapArgs(argv) {
  const a = { swaps: 20, workDir: null, wait: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--wait') a.wait = true;
    else if (k === '--swaps') { a.swaps = Number(argv[++i]); if (!Number.isInteger(a.swaps) || a.swaps < 1 || a.swaps > 200) throw new Error('--swaps takes 1..200'); }
    else if (k === '--work-dir') { a.workDir = argv[++i]; if (!a.workDir) throw new Error('--work-dir needs a folder'); }
    else throw new Error(`unknown argument ${k}`);
  }
  return a;
}

function stageStudio(dir, { crash = false } = {}) {
  mkdirSync(path.join(dir, 'studio'), { recursive: true });
  copyFileSync(STUDIO_EXE, path.join(dir, 'studio', 'ujwalam-studio.exe'));
  if (crash) writeFileSync(path.join(dir, 'studio', 'ujwalam-studio.test-crash'), 'av'); // headless test marker (main.cpp)
  return dir;
}

export async function main(argv = process.argv.slice(2)) {
  let a;
  try { a = parseStudioSwapArgs(argv); } catch (e) { console.log(`studio-swap-soak: ${e.message}`); return 2; }
  if (!existsSync(STUDIO_EXE) || !qtDir()) { log('the studio is not built (npm run build:studio)'); return 3; }
  setBelow(process.pid);
  let busy = busyProcesses();
  if (busy.length && a.wait) { log('waiting for other heavy jobs to finish'); while (busy.length) { await sleep(30_000); busy = busyProcesses(); } }
  if (busy.length) { log(`not starting: ${[...new Set(busy.map((b) => b.what))].join(', ')} running (use --wait)`); return 4; }

  const started = new Date();
  const workDir = path.resolve(a.workDir ?? path.join(os.tmpdir(), 'ujwalam-soak', `${started.toISOString().slice(0, 10)}-studio-swap-${started.getTime()}`));
  const runDir = path.join(workDir, 'run');
  const coreDir = path.join(runDir, 'core');
  const hostData = path.join(runDir, 'host');
  const recvDir = path.join(workDir, 'media', 'recv');
  const recordingsDir = path.join(workDir, 'media', 'recordings');
  const feedbackDir = path.join(workDir, 'media', 'feedback');
  const studioLogs = path.join(runDir, 'studio-logs');
  for (const d of [coreDir, hostData, recvDir, recordingsDir, feedbackDir, studioLogs]) mkdirSync(d, { recursive: true });
  const result = { startedAt: started.toISOString(), swaps: a.swaps, previewBackMs: PREVIEW_BACK_MS, checks: [], rounds: [], notes: [] };
  const check = (name, pass, detail) => { result.checks.push({ name, pass: !!pass, ...(detail === undefined ? {} : { detail }) }); log(pass ? 'PASS' : 'FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); };
  const finish = (code) => { writeFileSync(path.join(workDir, 'studio-swap-soak.json'), `${JSON.stringify(result, null, 2)}\n`); log(`result: ${path.join(workDir, 'studio-swap-soak.json')}`); return code; };
  if (!preflight({ log, check })) return finish(4);

  const stageA = stageStudio(path.join(workDir, 'studio-a'));
  const stageB = stageStudio(path.join(workDir, 'studio-b'));
  const crash = stageStudio(path.join(workDir, 'studio-crash'), { crash: true });

  const st = await startStack({ runDir, coreDir, hostData, recvDir, recordingsDir, feedbackDir, log, check, swap: true });
  if (!st) { result.notes.push('the stack did not start'); return finish(1); }
  const { c } = st;
  const unplanned = [];
  const studio = createStudioSlot({
    spawn: (root, key) => {
      const p = track(spawnStudio({ root, key, uiPort: st.uiPort, logsDir: studioLogs, env: { ...process.env, UJWALAM_HEADLESS: '1', UJWALAM_STUDIO_HIDDEN: '1' } }));
      p.once('spawn', () => setBelow(p.pid));
      p.once('exit', (code) => { if (!studio.isPlanned(p)) unplanned.push(code); });
      return p;
    },
    rearm: (key) => st.uiSlot.control(`rearm ${key}`),
    log: (l) => log(l),
  });
  let code = 1;
  try {
    check(`the plan has every required stream (${REQUIRED_STREAMS.join(', ')})`, missingRequiredStreams(st.params).length === 0);
    const key = (await import('node:crypto')).randomBytes(32).toString('hex');
    check('the UI server took the studio\'s one-time key', st.uiSlot.control(`rearm ${key}`));
    studio.start(stageA, key);
    for (let i = 0; i < 300 && studio.previews().length < 2; i++) await sleep(100);
    check('first studio window: previews H and V embedded in its hidden slots', ['h', 'v'].every((x) => studio.previews().includes(x)), studio.previews());
    const pl = await c.call('preview.list');
    check('host preview.list: H and V open (embedded)', ['H', 'V'].every((cv) => pl.previews?.some((p) => p.canvas?.toUpperCase() === cv && p.open === true && String(p.display ?? '').startsWith('embedded'))), pl.previews);

    const before = await c.call('host.status');
    check('stream start accepted', await c.call('stream.start').then(() => true, () => false));
    let allLive = false;
    for (let i = 0; i < 80 && !allLive; i++) { const o = await c.call('outputs.status').catch(() => null); allLive = !!o && REQUIRED_STREAMS.every((id) => o.sinks.find((s) => s.id === id)?.state === 'live'); if (!allLive) await sleep(250); }
    check('every required stream live within 20 s', allLive);
    const base = { dropped: before.droppedFrames ?? 0, lagged: before.render?.renderLagged ?? 0, skipped: before.render?.encodeSkipped ?? 0 };

    const frames = { worst: { dropped: 0, lagged: 0, skipped: 0 }, notLive: 0, samples: 0 };
    let watching = true;
    const watch = (async () => {
      while (watching) {
        try {
          const hs = await c.call('host.status');
          const now = { dropped: (hs.droppedFrames ?? 0) - base.dropped, lagged: (hs.render?.renderLagged ?? 0) - base.lagged, skipped: (hs.render?.encodeSkipped ?? 0) - base.skipped };
          for (const k of Object.keys(now)) frames.worst[k] = Math.max(frames.worst[k], now[k]);
          const o = await c.call('outputs.status');
          if (!REQUIRED_STREAMS.every((id) => o.sinks.find((s) => s.id === id)?.state === 'live')) frames.notLive++;
          frames.samples++;
        } catch { frames.notLive++; }
        await sleep(500);
      }
    })();
    await sleep(3000);

    const openInHost = async () => { const l = await c.call('preview.list').catch(() => ({})); return ['H', 'V'].filter((cv) => l.previews?.some((p) => p.canvas?.toUpperCase() === cv && p.open === true)); };
    for (let i = 0; i < a.swaps; i++) {
      const to = i % 2 === 0 ? stageB : stageA;
      const r = await studio.swap(to);
      const v = r.history?.find((h) => h.action === 'check-new' && h.ok)?.value ?? null;
      const host = await openInHost();
      result.rounds.push({ round: i + 1, result: r.result, ms: r.ms, readyMs: v?.readyMs ?? null, startMs: v?.startMs ?? null, previewGapMs: v?.previewGapMs ?? null, hostOpen: host, ...(r.result === 'swapped' ? {} : { failed: r.history?.filter((h) => !h.ok).map((h) => `${h.action}: ${h.error}`) }) });
      log(`round ${i + 1}: ${r.result} in ${r.ms} ms; previews back after ${JSON.stringify(v?.previewGapMs ?? null)} ms; host open ${host.join(',')}`);
      await sleep(1500);
    }
    const rb = await studio.swap(crash);
    for (let i = 0; i < 200 && studio.previews().length < 2; i++) await sleep(50);
    result.rollback = { result: rb.result, failed: rb.history?.filter((h) => !h.ok).map((h) => `${h.action}: ${h.error}`), previewsAfter: studio.previews(), hostOpen: await openInHost() };
    await sleep(3000);
    watching = false; await watch;
    const os2 = await c.call('outputs.status');
    result.frames = frames;
    result.sinks = os2.sinks.map((s) => ({ id: s.id, state: s.state, dropped: s.droppedFrames ?? 0, total: s.totalFrames ?? 0 }));
    result.maxConcurrentStudios = studio.maxConcurrent();
    const gaps = result.rounds.flatMap((r) => Object.values(r.previewGapMs ?? {}));
    result.previewGap = { max: gaps.length ? Math.max(...gaps) : null, min: gaps.length ? Math.min(...gaps) : null, mean: gaps.length ? Math.round(gaps.reduce((x, y) => x + y, 0) / gaps.length) : null };

    check(`studio: ${a.swaps} swaps, every one swapped`, result.rounds.every((r) => r.result === 'swapped'), result.rounds.filter((r) => r.result !== 'swapped'));
    check(`studio: both previews back within ${PREVIEW_BACK_MS} ms of the old window's exit, every time`, result.rounds.every((r) => r.previewGapMs && ['h', 'v'].every((x) => r.previewGapMs[x] <= PREVIEW_BACK_MS)), result.previewGap);
    check('host preview.list: H and V open after every swap', result.rounds.every((r) => r.hostOpen.length === 2), result.rounds.filter((r) => r.hostOpen.length !== 2).map((r) => r.round));
    check('never two studio windows at once (no second tray icon or preview set)', result.maxConcurrentStudios === 1, result.maxConcurrentStudios);
    check('a studio build that crashes at start is rolled back (restored-old), previews back', rb.result === 'restored-old' && result.rollback.previewsAfter.length === 2 && result.rollback.hostOpen.length === 2, result.rollback);
    check('0 dropped, 0 render-lagged, 0 encode-skipped frames on the host', frames.worst.dropped === 0 && frames.worst.lagged === 0 && frames.worst.skipped === 0, frames.worst);
    check('0 dropped frames on every sink', result.sinks.every((s) => s.dropped === 0), result.sinks);
    check('every required stream live at every sample', frames.notLive === 0 && frames.samples > 0, { notLiveSamples: frames.notLive, samples: frames.samples });
    check('no unplanned exit of the studio, the core, the UI server or the host', unplanned.length === 0 && st.coreExit === null && st.uiExit === null && st.hostExit === null, { studio: unplanned, core: st.coreExit, ui: st.uiExit, host: st.hostExit });
    check('stream stop accepted', await c.call('stream.stop').then(() => true, () => false));
    code = result.checks.every((x) => x.pass) ? 0 : 1;
  } catch (e) {
    result.notes.push(`error: ${String(e?.message ?? e).slice(0, 300)}`);
    log('error', e?.stack ?? e);
  } finally {
    await studio.stop().catch(() => {});
    await st.teardown();
  }
  log(code === 0 ? 'PASS' : 'FAIL', `${result.checks.filter((x) => x.pass).length}/${result.checks.length} checks`);
  return finish(code);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(REPO, 'tools', 'soak', 'studio-swap-soak.mjs')) {
  const code = await main();
  process.exit(code);
}
