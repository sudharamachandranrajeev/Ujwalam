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
//   - a Stop / End all that arrives while record.start is on its way wins: the recording is stopped again at once;
//   - no start while Ujwalam is closing (closing lock); no confirmation of any kind (D332).
import { isLive, isRecording } from './record-clips.mjs';

/** How long after the start a stream that never showed as running counts as ended (the host failed to connect). */
export const RECORD_LIVE_GRACE_MS = 30_000;
export const RECORD_LIVE_TASK = 'Recording the stream for reels';

const why = (e) => String(e?.code ?? e?.message ?? 'error').slice(0, 60);

/** call(method, params) -> host answer; enabled() -> the setting; epoch() -> the server's stop epoch (Stop / End all
 *  bump it); closing() -> the closing lock is held; tasks: the server's task list; log(line); now() -> ms. */
export function createRecordLive({ call, enabled, epoch, closing = () => false, tasks = null, log = () => {}, now = Date.now }) {
  let auto = null; // { epoch, at, sawLive }: the recording this started, while it runs
  let stopping = null;

  function notRecorded(reason) {
    const warning = `The stream is live, but it is not being recorded (${reason}), so no reels will be made from it. Press Record to record it.`;
    tasks?.start({ title: RECORD_LIVE_TASK, kind: 'record' }).fail(`Not recorded: ${reason}. The stream is live; press Record to record it.`);
    log(`[studio-ui] record while live: not recorded (${reason}); the stream stays live`);
    return { started: false, warning };
  }

  /** Right after the host accepted a stream start. Never throws; { started, warning? }. */
  async function afterStreamStart() {
    let on = false;
    try { on = enabled() === true; } catch { on = false; }
    if (!on || closing()) return { started: false };
    let st;
    try { st = await call('outputs.status', {}); } catch (e) { return notRecorded(`the outputs could not be read: ${why(e)}`); }
    if (isRecording(st)) return { started: false, already: true }; // started by hand: never stopped by this
    if (!(Array.isArray(st?.sinks) && st.sinks.some((s) => s?.kind === 'record'))) return notRecorded('no recording is set up in the outputs');
    const e0 = epoch();
    try { await call('record.start', {}); } catch (e) { return notRecorded(`the recording did not start: ${why(e)}`); }
    auto = { epoch: e0, at: now(), sawLive: false };
    if (epoch() !== e0) { // a Stop / End all came in while record.start was on its way: it wins
      await streamEnded('the stream was stopped while the recording started');
      return { started: false };
    }
    tasks?.start({ title: RECORD_LIVE_TASK, kind: 'record' }).done('Started with the stream; it stops when the stream ends, then the reels are made.');
    log('[studio-ui] record while live: recording started with the stream');
    return { started: true };
  }

  /** The stream ended (Stop stream, End all, or seen as ended): stop the recording this started. true = stopped. */
  async function streamEnded(reason) {
    if (!auto) return false;
    if (stopping) return stopping;
    stopping = (async () => {
      try {
        await call('record.stop', {});
        auto = null;
        log(`[studio-ui] record while live: recording stopped (${reason})`);
        return true;
      } catch (e) {
        log(`[studio-ui] record while live: could not stop the recording (${why(e)}); tried again on the next status check`);
        return false;
      } finally { stopping = null; }
    })();
    return stopping;
  }

  /** A Record / Stop recording click: the recording is the user's from now on. */
  function handOff() { auto = null; }

  /** Each status poll while a recording this started runs: stops it once no stream sink runs any more. */
  async function observe(status) {
    if (!auto || !status) return false;
    if (isLive(status)) { auto.sawLive = true; return false; }
    if (!isRecording(status)) { auto = null; return false; } // it ended by itself (host restart, disk full)
    if (!auto.sawLive && now() - auto.at < RECORD_LIVE_GRACE_MS) return false; // the stream may still be starting
    return streamEnded('the stream ended');
  }

  return { afterStreamStart, streamEnded, handOff, observe, active: () => auto !== null };
}
