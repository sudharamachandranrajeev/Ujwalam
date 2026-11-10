// SPDX-License-Identifier: GPL-3.0-or-later
// Record while live (LC2, D334 proposed; Settings > Clips, settings.json clips.recordLive, default on). The reels (kill
// montages and match reels) are cut from the H and V recordings after a stream, and going live did not record, so a
// stream made no reels. With the setting on, the UI server starts the recording right after a stream start the host
// accepted (record.start, every record sink: H and, since LC1, V) and stops that recording when the stream ends:
// Stop stream, End all, or the host reporting no stream sink running any more. Stopping it lets the launcher see the
// finished recording (record-clips.mjs finishedRecording) and run the after-stream review + montage job.
// Rules:
//   - a recording that was already running (started by hand) is never touched; a Record or Stop recording click hands
//     the recording back to the user (it is not stopped by this any more);
//   - a failed record.start never fails or stops the stream: the answer carries a warning and the task panel a note;
//   - a Stop / End all that arrives while the start is on its way wins: nothing is started, or it is stopped again;
//   - the recording is stopped only when a fresh outputs.status shows no stream sink starting, live, reconnecting,
//     retrying or stopping (a Stop of one output, or an End all still closing, keeps it);
//   - no start while Ujwalam is closing (closing lock); no confirmation of any kind (D332).
// Codex review of LC2: start and stop run one at a time (serial), and the recording this owns is one object; a
// completion acts only if that object is still the owner and no Record / Stop click came in since (generation), so a
// late answer never takes over the user's recording or forgets a newer one.
import { isLive, isRecording } from './record-clips.mjs';

/** How long after the start a stream that never showed as running counts as ended (the host failed to connect). */
export const RECORD_LIVE_GRACE_MS = 30_000;
export const RECORD_LIVE_TASK = 'Recording the stream for reels';

const BUSY = new Set(['starting', 'live', 'reconnecting', 'retrying', 'stopping']);
/** Any stream sink still starting, running or closing. */
export const streamBusy = (st) => (Array.isArray(st?.sinks) ? st.sinks : []).some((s) => s?.kind === 'stream' && BUSY.has(s.state));
const why = (e) => String(e?.code ?? e?.message ?? 'error').slice(0, 60);

/** call(method, params) -> host answer; enabled() -> the setting; epoch() -> the server's stop epoch (Stop / End all
 *  bump it); closing() -> the closing lock is held; tasks: the server's task list; log(line); now() -> ms. */
export function createRecordLive({ call, enabled, epoch, closing = () => false, tasks = null, log = () => {}, now = Date.now }) {
  let auto = null; // { gen, at, sawLive }: the recording this started, while it runs (identity = ownership)
  let gen = 0; // bumped by every start attempt and every Record / Stop click
  let starting = 0; // automatic starts queued or on their way
  let chain = Promise.resolve();
  const serial = (fn) => { const p = chain.then(fn); chain = p.catch(() => {}); return p; };

  function notRecorded(reason) {
    const warning = `The stream is live, but it is not being recorded (${reason}), so no reels will be made from it. Press Record to record it.`;
    tasks?.start({ title: RECORD_LIVE_TASK, kind: 'record' }).fail(`Not recorded: ${reason}. The stream is live; press Record to record it.`);
    log(`[studio-ui] record while live: not recorded (${reason}); the stream stays live`);
    return { started: false, warning };
  }

  // Stops the recording `owner` stands for, if it is still the one this owns and a fresh status shows every stream
  // ended. Runs inside serial(). true = stopped.
  async function stopIfEnded(owner, reason) {
    if (!owner || auto !== owner) return false;
    let st;
    try { st = await call('outputs.status', {}); } catch { return false; } // unknown: the next status poll tries again
    if (auto !== owner || streamBusy(st)) return false;
    if (!isRecording(st)) { auto = null; return false; } // it ended by itself (host restart, disk full)
    try { await call('record.stop', {}); } catch (e) {
      log(`[studio-ui] record while live: could not stop the recording (${why(e)}); tried again on the next status check`);
      return false;
    }
    if (auto === owner) auto = null;
    log(`[studio-ui] record while live: recording stopped (${reason})`);
    return true;
  }

  /** Right after the host accepted a stream start. o.epoch: the click's stop epoch (taken before its own checks).
   *  Never throws; { started, warning? }. */
  async function afterStreamStart(o = {}) {
    const e0 = Number.isInteger(o.epoch) ? o.epoch : epoch(); // before any await: a Stop from here on wins (P2)
    let on = false;
    try { on = enabled() === true; } catch { on = false; }
    if (!on || closing() || epoch() !== e0) return { started: false };
    starting += 1;
    return serial(async () => {
      const g = ++gen;
      if (closing() || epoch() !== e0) return { started: false };
      let st;
      try { st = await call('outputs.status', {}); } catch (e) { return notRecorded(`the outputs could not be read: ${why(e)}`); }
      if (isRecording(st)) return { started: false, already: true }; // started by hand: never stopped by this
      if (!(Array.isArray(st?.sinks) && st.sinks.some((s) => s?.kind === 'record'))) return notRecorded('no recording is set up in the outputs');
      if (closing() || epoch() !== e0 || gen !== g) return { started: false }; // a Stop or a Record click meanwhile
      try { await call('record.start', {}); } catch (e) { return notRecorded(`the recording did not start: ${why(e)}`); }
      if (gen !== g) { // a Record / Stop click while record.start was on its way: the recording is the user's
        log('[studio-ui] record while live: a Record click came in while the recording started; it is yours');
        return { started: false, handedOff: true };
      }
      const mine = { gen: g, at: now(), sawLive: false };
      auto = mine;
      if (epoch() !== e0) { // a Stop / End all came in while record.start was on its way: it wins
        const stopped = await stopIfEnded(mine, 'the stream was stopped while the recording started');
        if (stopped || auto !== mine) return { started: false };
      }
      tasks?.start({ title: RECORD_LIVE_TASK, kind: 'record' }).done('Started with the stream; it stops when the stream ends, then the reels are made.');
      log('[studio-ui] record while live: recording started with the stream');
      return { started: true };
    }).finally(() => { starting -= 1; });
  }

  /** A Stop stream or End all went through (the caller bumped the stop epoch first): stop the recording this started
   *  once no stream runs. true = stopped. While an automatic start is queued or on its way, this does not wait for it
   *  (a slow record.start must never hold up Stop or End all): that start sees the new epoch and stops its own
   *  recording once a fresh status shows every stream ended; otherwise the status poll does. */
  function streamEnded(reason) {
    if (starting > 0) return Promise.resolve(false);
    return serial(() => stopIfEnded(auto, reason));
  }

  /** A Record / Stop recording click: the recording is the user's from now on. */
  function handOff() { gen += 1; auto = null; }

  /** A status poll. owner: owner() taken BEFORE the status was read (a newer recording is never judged by an older
   *  status). Stops the recording once no stream runs (after the grace period for a stream never seen running). */
  async function observe(status, owner) {
    if (!owner || auto !== owner || !status) return false;
    if (isLive(status)) { owner.sawLive = true; return false; }
    if (streamBusy(status)) return false; // still closing
    if (isRecording(status) && !owner.sawLive && now() - owner.at < RECORD_LIVE_GRACE_MS) return false; // may still be starting
    return serial(() => stopIfEnded(owner, 'the stream ended'));
  }

  return { afterStreamStart, streamEnded, handOff, observe, owner: () => auto, active: () => auto !== null };
}
