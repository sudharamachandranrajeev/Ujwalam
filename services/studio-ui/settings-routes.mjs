// SPDX-License-Identifier: GPL-3.0-or-later
// UI server routes for D327: Settings > Stream (OS1/OS2, flag stream-settings), the main-window Outputs panel (OS3,
// flag outputs-panel), Settings > Integrations (IN1, flag integrations) and Force complete transition (TR1, flag
// stream-settings). Kept out of server.mjs; server.mjs calls handle() for these routes. Every route answers 404
// <flag>-off while its flag is off.
//
//   GET  /ui/api/stream/setup             { setup, exists, options, summaries, problems }
//   POST /ui/api/stream/setup  {setup}    saved (used at the next live start) | 422 { problems } (platform limit shown)
//   POST /ui/api/stream/check  {setup}    { problems } (nothing saved)
//   GET  /ui/api/outputs/panel            { outputs: [{ id, name, platform, canvas, enabled, summary, state }], live, virtualCamera }
//   POST /ui/api/outputs/toggle {id, on}  offline: saves enabled (what Start stream starts); live: on the click (D332)
//                                         stream.start/stop { sinks: [id] } for that output only
//   GET  /ui/api/integrations             { value, bots: { <bot>: { address, port } }, remote: { running, address, port, lan } }
//   POST /ui/api/integrations  {value}    saved (used at the next start) | 422 { problems }
//   POST /ui/api/integrations/test {bot}  { bot, answered } (plain TCP connect to 127.0.0.1:<port>; nothing is sent)
//   POST /ui/api/integrations/remote-token  { token } only while the LAN listener runs (for the clipboard; never shown)
//   POST /ui/api/transitions/force {canvas}  host transitions.forceComplete (instant: it only ends a running transition)

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { BOTS, BOT_LABELS, tcpAnswers as realTcpAnswers } from '../bots/index.mjs';
import { lanAddresses } from '../common/lan-remote.mjs';
import { BOT_ADDRESS, readIntegrations, writeIntegrations } from './integrations.mjs';
import { outputSummary, readOptions, readSetup, setupProblems, STREAM_UPSCALE_FLAG, toPlan, writeSetup } from './stream-setup.mjs';

export const STREAM_SETTINGS_FLAG = 'stream-settings';
export const OUTPUTS_PANEL_FLAG = 'outputs-panel';
export const INTEGRATIONS_FLAG = 'integrations';
// Read when the panel asks: the host has no virtual camera output in this build (D327 OS3, reported UNVERIFIED).
export const VIRTUAL_CAMERA = Object.freeze({ available: false, reason: 'Not in this build: the libobs host has no virtual camera output yet.' });
const REMOTE_FILE = 'remote.json';
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/**
 * opts: { dataDir, flags, host, json, canvases?: () => ({ H, V } | undefined),
 *         botConfig?: () => object, tcpAnswers?, remoteToken?: string, log?,
 *         startGuard?: { closing(), credentialsUpdating?(), enter() -> release(), begin() -> token, still(token), pause(), stopAgain(sinks) } }
 */
export function createSettingsRoutes(opts) {
  const { flags, host, json } = opts;
  const dataDir = typeof opts.dataDir === 'string' ? opts.dataDir : null;
  const on = (id) => !!flags && flags.isOn(id);
  const tcp = opts.tcpAnswers ?? realTcpAnswers;
  const botConfig = () => { try { return opts.botConfig?.() ?? {}; } catch { return {}; } };
  let options = null;
  const opt = () => (options ??= readOptions());
  const canvases = () => { try { return opts.canvases?.(); } catch { return undefined; } };
  // Every setup check and plan sees the project's canvas sizes and whether a rung may be scaled up (D378).
  const planOpts = () => ({ options: opt(), canvases: canvases(), upscale: on(STREAM_UPSCALE_FLAG) });

  async function sinkStates() {
    try {
      const r = await host.call('outputs.status', {});
      return new Map((Array.isArray(r?.sinks) ? r.sinks : []).filter((s) => typeof s?.id === 'string').map((s) => [s.id, typeof s.state === 'string' ? s.state : 'unknown']));
    } catch { return null; }
  }
  async function hostLive() {
    try { const hs = await host.call('host.status', {}); return typeof hs?.live === 'boolean' ? hs.live : null; } catch { return null; }
  }
  const label = (o) => `${o.name}`;

  /** The sinks Start stream starts while a saved setup is in effect (flag stream-settings or outputs-panel on): the
   *  enabled outputs the host has. The launcher plan holds every output of the setup, disabled ones too (so one can be
   *  switched on live), so a switched-off output must be left out here whatever the panel flag says.
   *  null = all (both flags off or no setup); [] = none enabled (Start is refused). */
  async function startSinks() {
    if ((!on(STREAM_SETTINGS_FLAG) && !on(OUTPUTS_PANEL_FLAG)) || !dataDir) return null;
    const { exists, setup } = readSetup(dataDir);
    if (!exists) return null;
    const states = await sinkStates();
    const included = new Set(toPlan(setup, { ...planOpts(), recordName: null }).included);
    return setup.outputs.filter((o) => o.enabled && included.has(o.id) && (!states || states.has(o.id))).map((o) => o.id);
  }

  async function handle(method, route, body, res) {
    // ---- Stream settings ----
    if (route === '/ui/api/stream/setup' || route === '/ui/api/stream/check') {
      if (!on(STREAM_SETTINGS_FLAG)) return json(res, 404, { error: `${STREAM_SETTINGS_FLAG}-off` }), true;
      if (!dataDir) return json(res, 409, { error: 'no-data-dir' }), true;
      if (method === 'GET' && route === '/ui/api/stream/setup') {
        let r;
        try { r = readSetup(dataDir, { options: opt() }); } catch { return json(res, 409, { error: 'setup-unreadable' }), true; }
        return json(res, 200, { exists: r.exists, setup: r.setup, options: opt(), canvases: canvases() ?? null, upscale: on(STREAM_UPSCALE_FLAG),
          summaries: Object.fromEntries(r.setup.outputs.map((o) => [o.id, outputSummary(r.setup, o, opt())])),
          problems: setupProblems(r.setup, planOpts()) }), true;
      }
      if (method !== 'POST' || !isPlain(body) || Object.keys(body).some((k) => k !== 'setup')) return json(res, 400, { error: 'bad-params' }), true;
      if (route === '/ui/api/stream/check') return json(res, 200, { problems: setupProblems(body.setup, planOpts()) }), true;
      const w = writeSetup(dataDir, body.setup, planOpts());
      if (!w.ok) return json(res, 422, { error: 'refused', problems: w.problems }), true;
      return json(res, 200, { ok: true, setup: w.setup, appliesAt: 'next-start',
        summaries: Object.fromEntries(w.setup.outputs.map((o) => [o.id, outputSummary(w.setup, o, opt())])) }), true;
    }

    // ---- Outputs panel ----
    if (route === '/ui/api/outputs/panel' || route === '/ui/api/outputs/toggle') {
      if (!on(OUTPUTS_PANEL_FLAG)) return json(res, 404, { error: `${OUTPUTS_PANEL_FLAG}-off` }), true;
      if (!dataDir) return json(res, 409, { error: 'no-data-dir' }), true;
      let r;
      try { r = readSetup(dataDir, { options: opt() }); } catch { return json(res, 409, { error: 'setup-unreadable' }), true; }
      if (method === 'GET' && route === '/ui/api/outputs/panel') {
        const states = await sinkStates();
        const live = await hostLive();
        const included = new Set(toPlan(r.setup, { ...planOpts(), recordName: null }).included);
        return json(res, 200, { live: live === true, virtualCamera: VIRTUAL_CAMERA, canvasMode: r.setup.canvasMode,
          outputs: r.setup.outputs.map((o) => ({ id: o.id, name: o.name, platform: o.platform, canvas: o.canvas, enabled: o.enabled,
            summary: outputSummary(r.setup, o, opt()), inPlan: included.has(o.id), state: states?.get(o.id) ?? null })) }), true;
      }
      if (method !== 'POST' || !isPlain(body) || Object.keys(body).some((k) => k !== 'id' && k !== 'on') || typeof body.id !== 'string' || typeof body.on !== 'boolean') return json(res, 400, { error: 'bad-params' }), true;
      const o = r.setup.outputs.find((x) => x.id === body.id);
      if (!o) return json(res, 404, { error: 'unknown-output' }), true;
      const live = await hostLive();
      if (live === null) return json(res, 409, { error: 'host-unavailable' }), true;
      if (!live) {
        // Offline: the switch chooses what Start stream starts. Saved like any setup change.
        const next = { ...r.setup, outputs: r.setup.outputs.map((x) => (x.id === o.id ? { ...x, enabled: body.on } : x)) };
        const w = writeSetup(dataDir, next, planOpts());
        if (!w.ok) return json(res, 422, { error: 'refused', problems: w.problems }), true;
        return json(res, 200, { ok: true, id: o.id, enabled: body.on, live: false }), true;
      }
      // Live: only an output the host has (it was in the plan at go-live) can be switched; the click is the decision (D332).
      const states = await sinkStates();
      if (!states || !states.has(o.id)) return json(res, 409, { error: 'not-in-this-stream', detail: `${label(o)} was not part of this stream. It can be added at the next start.` }), true;
      const summary = body.on
        ? `Start ${label(o)} only. The other outputs keep running.`
        : `Stop ${label(o)} only. The other outputs keep running.`;
      return (await confirm({ kind: 'output', summary, outputId: o.id, on: body.on }, res)), true;
    }

    // ---- Integrations ----
    if (route.startsWith('/ui/api/integrations')) {
      if (!on(INTEGRATIONS_FLAG)) return json(res, 404, { error: `${INTEGRATIONS_FLAG}-off` }), true;
      if (!dataDir) return json(res, 409, { error: 'no-data-dir' }), true;
      if (method === 'GET' && route === '/ui/api/integrations') {
        const { value, exists, corrupt } = readIntegrations(dataDir, botConfig());
        return json(res, 200, { exists, corrupt: corrupt === true, value,
          bots: Object.fromEntries(BOTS.map((b) => [b, { label: BOT_LABELS[b], address: BOT_ADDRESS, port: value.bots[b].port }])),
          remote: { ...remoteRunning(), lan: lanAddresses().map((a) => a.address) } }), true;
      }
      if (method !== 'POST') return json(res, 405, { error: 'method-not-allowed' }), true;
      if (route === '/ui/api/integrations') {
        if (!isPlain(body) || Object.keys(body).some((k) => k !== 'value')) return json(res, 400, { error: 'bad-params' }), true;
        const w = writeIntegrations(dataDir, body.value);
        if (!w.ok) return json(res, 422, { error: 'refused', problems: w.problems }), true;
        return json(res, 200, { ok: true, value: w.value, appliesAt: 'next-start' }), true;
      }
      if (route === '/ui/api/integrations/test') {
        if (!isPlain(body) || Object.keys(body).some((k) => k !== 'bot' && k !== 'port') || !BOTS.includes(body.bot)) return json(res, 400, { error: 'bad-params' }), true;
        // The port being edited (not saved yet) may be tested; the address is always this PC.
        const port = body.port ?? readIntegrations(dataDir, botConfig()).value.bots[body.bot].port;
        if (!Number.isInteger(port) || port < 1024 || port > 65535) return json(res, 400, { error: 'bad-port' }), true;
        let answered = false;
        try { answered = await tcp(port, 1000); } catch { answered = false; }
        return json(res, 200, { bot: body.bot, address: BOT_ADDRESS, port, answered }), true;
      }
      if (route === '/ui/api/integrations/remote-token') {
        if (body && Object.keys(body).length) return json(res, 400, { error: 'bad-params' }), true;
        if (!remoteRunning().running || typeof opts.remoteToken !== 'string') return json(res, 409, { error: 'remote-off' }), true;
        return json(res, 200, { token: opts.remoteToken }), true;
      }
      return json(res, 404, { error: 'not-found' }), true;
    }

    // ---- Force complete transition ----
    if (route === '/ui/api/transitions/force') {
      if (!on(STREAM_SETTINGS_FLAG)) return json(res, 404, { error: `${STREAM_SETTINGS_FLAG}-off` }), true;
      if (method !== 'POST' || !isPlain(body) || Object.keys(body).some((k) => k !== 'canvas') || !['h', 'v'].includes(body.canvas)) return json(res, 400, { error: 'bad-params' }), true;
      try {
        const r = await host.call('transitions.forceComplete', { canvas: body.canvas.toUpperCase() });
        return json(res, 200, { ok: true, result: r ?? null }), true;
      } catch (e) { return json(res, 502, { error: 'host-error', detail: String(e?.code ?? e?.message ?? 'error').slice(0, 80) }), true; }
    }
    return false;
  }

  function remoteRunning() {
    if (!dataDir) return { running: false };
    const f = path.join(dataDir, REMOTE_FILE);
    if (!existsSync(f)) return { running: false };
    try {
      const r = JSON.parse(readFileSync(f, 'utf8'));
      return { running: true, address: String(r.address), port: Number(r.port) };
    } catch { return { running: false }; }
  }

  /** Runs a live switch of one output (kind 'output'). Re-checks live first: never a go-live from here.
   *  A switch-on goes through opts.startGuard (server.mjs: the same stop generation and go-live authority as Start
   *  stream): a Stop or End all clicked after this start began wins. Checked before the host call (the start is not
   *  sent) and after it (that output is stopped again at once). */
  async function confirm(p, res) {
    if (!on(OUTPUTS_PANEL_FLAG)) return json(res, 404, { error: `${OUTPUTS_PANEL_FLAG}-off` });
    const g = p.on ? opts.startGuard ?? null : null;
    if (g?.closing()) return json(res, 409, { error: 'closing', detail: 'Ujwalam is closing' });
    // A stream key / server update in progress (platform sign-in, D327 PC): never start an output in the middle of it.
    if (g?.credentialsUpdating?.()) return json(res, 409, { error: 'credentials-updating', detail: 'A stream key is being changed; switch it on again in a moment' });
    const release = g ? g.enter() : () => {};
    try {
      const token = g ? await g.begin() : null; // taken before the live check: any Stop from here on wins
      const live = await hostLive();
      if (live !== true) return json(res, 200, { verdict: 'refuse', reason: 'not-live', detail: 'The stream is not live any more; use Start stream.' });
      if (g) {
        await g.pause();
        if (!(await g.still(token))) return json(res, 200, { verdict: 'refuse', reason: 'stopped-meanwhile', detail: 'A Stop or End all came first; nothing was started.' });
      }
      const method = p.on ? 'stream.start' : 'stream.stop';
      try { await host.call(method, { sinks: [p.outputId] }); } catch (e) { return json(res, 502, { error: 'host-error', detail: String(e?.code ?? e?.message ?? 'error').slice(0, 80) }); }
      if (g && !(await g.still(token))) {
        // The Stop reached the host while this start was on its way: stop this output again so the newer Stop wins.
        if (!(await g.stopAgain([p.outputId]))) return json(res, 502, { error: 'host-error', detail: 'stop-again-failed' });
        return json(res, 200, { verdict: 'refuse', reason: 'stopped-meanwhile', stoppedAgain: true });
      }
    } finally { release(); }
    // Remember the choice for the next start too (best effort; the live switch already happened).
    try {
      const { exists, setup } = readSetup(dataDir);
      if (exists) writeSetup(dataDir, { ...setup, outputs: setup.outputs.map((x) => (x.id === p.outputId ? { ...x, enabled: p.on } : x)) }, planOpts());
    } catch { /* keep the live result */ }
    return json(res, 200, { verdict: 'allow', id: p.outputId, on: p.on });
  }

  return { handle, confirm, startSinks };
}
