// SPDX-License-Identifier: GPL-2.0-or-later
// In-process publish/subscribe with a bounded queue per subscriber (P3 E1). Node stdlib only.
//
// Live path rule: publish() never awaits a subscriber. Each subscriber has its own queue (default 1000).
// When the queue is full the OLDEST queued event for that subscriber is dropped and counted; other
// subscribers are untouched. Handlers run one at a time per subscriber, in order, off the publisher's
// call stack (a microtask). A handler that throws or rejects is counted and the subscriber carries on.
// A handler that never settles stalls only its own subscriber (its queue then drops oldest).
// Filters: a list of kind prefixes matched with String.startsWith, so 'chat.' or 'alert.sub' work;
// 'alert' matches every alert kind. No filter (or an empty list) means every event.

export const DEFAULT_QUEUE_LIMIT = 1000;

export function createBus({ queueLimit = DEFAULT_QUEUE_LIMIT } = {}) {
  const subs = new Set();
  let published = 0;
  let seq = 0;

  function subscribe({ name, kinds, handler, limit = queueLimit }) {
    if (typeof handler !== 'function') throw new TypeError('handler must be a function');
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit must be an integer >= 1');
    if (name != null && [...subs].some((s) => s.name === name)) throw new Error(`duplicate subscriber name: ${name}`);
    const prefixes = kinds == null ? [] : [].concat(kinds);
    const sub = {
      name: name ?? `sub-${++seq}`, prefixes, handler, limit,
      queue: [], draining: false, active: true,
      delivered: 0, dropped: 0, errors: 0, matched: 0,
    };
    subs.add(sub);
    return () => { sub.active = false; sub.queue.length = 0; subs.delete(sub); };
  }

  async function drain(sub) {
    sub.draining = true;
    try {
      while (sub.active && sub.queue.length) {
        const ev = sub.queue.shift();
        try { await sub.handler(ev); sub.delivered++; } catch { sub.errors++; }
      }
    } finally { sub.draining = false; }
  }

  /** Enqueue for every matching subscriber and return. Returns the number of subscribers matched. */
  function publish(ev) {
    published++;
    let n = 0;
    for (const sub of subs) {
      if (sub.prefixes.length && !sub.prefixes.some((p) => ev.kind.startsWith(p))) continue;
      n++;
      sub.matched++;
      if (sub.queue.length >= sub.limit) { sub.queue.shift(); sub.dropped++; }
      sub.queue.push(ev);
      if (!sub.draining) queueMicrotask(() => { if (!sub.draining) drain(sub); });
    }
    return n;
  }

  function stats() {
    const subscribers = {};
    for (const s of subs) {
      subscribers[s.name] = { matched: s.matched, delivered: s.delivered, dropped: s.dropped, errors: s.errors, queued: s.queue.length };
    }
    return { published, subscribers };
  }

  return { subscribe, publish, stats };
}
