// SPDX-License-Identifier: GPL-3.0-or-later
// Server-Sent Events client for the event-core API (P3 E6). Node stdlib only.
//
// One client = one bus subscription whose handler is SYNCHRONOUS: it only pushes the event onto this client's own
// bounded queue and tries to write. A slow reader therefore never makes the bus wait or grow. When the queue is full
// the OLDEST queued event is dropped and counted; before the next event is written the client gets an SSE comment
// ": dropped N events (slow client)". If the socket stays blocked for stallMs the connection is destroyed.
//
// RAW TEXT PATH. Chat and alert events are sent whole, including chat text and display names, to authenticated local
// clients (api role). This is the ONE intended path for raw text out of the event core: the app UI needs it.
// Everything else (core.status, the audit, logs) is text-free.

const jsonOf = new WeakMap(); // event object -> serialised JSON, shared by all clients
// The bus keeps its own per-subscriber queue; the handler drains it synchronously, so it only fills inside one
// synchronous burst of publishes. 10 000 events is far above a chat burst; any drop there is still counted at the next heartbeat.
const BUS_LIMIT = 10_000;
const oneLine = (s) => String(s).replace(/[\r\n]/g, ' ');

function frame(ev) {
  let j = jsonOf.get(ev);
  if (j === undefined) { j = JSON.stringify(ev); jsonOf.set(ev, j); }
  return `id: ${oneLine(ev.id)}\nevent: ${oneLine(ev.kind)}\ndata: ${j}\n\n`;
}

/** opts: { res, bus, name, prefixes, queueMax, heartbeatMs, stallMs, timers?: { setInterval, clearInterval, setTimeout, clearTimeout } }
 *  res needs write(string) -> boolean, once('drain', fn), destroy(). Returns { close(), stats() }. */
export function createSseClient(opts) {
  const { res, bus, name, prefixes, queueMax, heartbeatMs, stallMs } = opts;
  const timers = opts.timers ?? { setInterval, clearInterval, setTimeout, clearTimeout };
  const q = [];
  let dropped = 0; // dropped since the last announcement
  const totals = { dropped: 0, sent: 0, stalled: false };
  let busDroppedSeen = 0;
  let blocked = false;
  let closed = false;
  let stallTimer = null;

  const unsubscribe = bus.subscribe({
    name, kinds: prefixes, limit: BUS_LIMIT,
    handler: (ev) => { push(ev); }, // synchronous on purpose
  });

  function write(s) {
    if (closed) return false;
    let ok;
    try { ok = res.write(s); } catch { close(); return false; }
    if (!ok) {
      blocked = true;
      stallTimer = timers.setTimeout(() => { totals.stalled = true; try { res.destroy(); } finally { close(); } }, stallMs);
      stallTimer.unref?.();
      res.once('drain', onDrain);
    }
    return ok;
  }
  function onDrain() {
    if (closed) return;
    blocked = false;
    if (stallTimer) { timers.clearTimeout(stallTimer); stallTimer = null; }
    pump();
  }
  function pump() {
    if (blocked || closed) return;
    if (dropped) {
      const n = dropped;
      dropped = 0;
      if (!write(`: dropped ${n} events (slow client)\n\n`)) return;
    }
    while (q.length && !closed) {
      const ev = q.shift();
      totals.sent++;
      if (!write(frame(ev))) return;
    }
  }
  function push(ev) {
    if (closed) return;
    if (q.length >= queueMax) { q.shift(); dropped++; totals.dropped++; }
    q.push(ev);
    pump();
  }

  const hb = timers.setInterval(() => {
    if (closed) return;
    // The bus has its own per-subscriber queue; fold its drops (only possible in an extreme synchronous burst) into the count.
    const bd = bus.stats().subscribers[name]?.dropped ?? 0;
    if (bd > busDroppedSeen) { dropped += bd - busDroppedSeen; totals.dropped += bd - busDroppedSeen; busDroppedSeen = bd; }
    if (blocked) return;
    if (dropped) pump(); else write(': hb\n\n');
  }, heartbeatMs);
  hb.unref?.();

  function close() {
    if (closed) return;
    closed = true;
    unsubscribe();
    timers.clearInterval(hb);
    if (stallTimer) timers.clearTimeout(stallTimer);
    q.length = 0;
  }

  /** LU3 hand-off (D337): waits until every event the bus has queued for this client is written and the socket has
   *  taken it, then ends the response cleanly (never a destroy, so nothing written is lost) and resolves true. After
   *  timeoutMs it destroys the connection and resolves false. Call it only once no new events are being published. */
  function finish(timeoutMs = 5000) {
    const t0 = Date.now();
    return new Promise((resolve) => {
      const tick = () => {
        if (closed) { resolve(false); return; }
        const busQueued = bus.stats().subscribers[name]?.queued ?? 0;
        if (!blocked && busQueued === 0 && q.length === 0 && dropped === 0) {
          close();
          try { res.end(() => resolve(true)); } catch { resolve(false); }
          return;
        }
        if (!blocked) pump();
        if (Date.now() - t0 > timeoutMs) { close(); try { res.destroy(); } catch { /* gone */ } resolve(false); return; }
        const t = timers.setTimeout(tick, 5);
        t.unref?.();
      };
      tick();
    });
  }

  return { close, finish, stats: () => ({ ...totals, queued: q.length, blocked, closed }) };
}

/** Parse ?kinds=a.,b → prefix list, or null when invalid. Each prefix: lower-case dotted word, 1..32 chars, at most 8. */
export function parseKinds(value) {
  if (value == null || value === '') return [];
  const parts = value.split(',');
  if (parts.length > 8) return null;
  for (const p of parts) if (!/^[a-z][a-z0-9.]{0,31}$/.test(p)) return null;
  return parts;
}
