// SPDX-License-Identifier: GPL-3.0-or-later
// JSON-RPC 2.0 method table for the event-core API (P3 E6). Node stdlib only.
//
// Each method declares the roles that may call it, a strict params schema (unknown fields are refused, positional
// params are refused) and a run function. The source of every gate call is fixed by the token's role (a gate handle
// per role); nothing in a request can set it. METHODS is the single source for the role table the tests enforce.

import { CLIENT_KEY_RE } from '../livelock/gate.mjs';

export class RpcError extends Error {
  constructor(code, message, http = 200) { super(message); this.rpcCode = code; this.http = http; }
}
export const E = Object.freeze({
  PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603,
  FORBIDDEN: -32001, UNAVAILABLE: -32004,
});

const ID_RE = /^[a-z][a-z0-9]*(\.[a-z0-9]+)+$/;
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const TEXT_RE = /^[\w .:,-]{0,200}$/;

/** Returns an error string or null. schema: { field: { type, required?, max?, min?, pattern?, values? } } */
export function validateParams(schema, p) {
  if (!isPlain(p)) return 'params must be an object';
  for (const k of Object.keys(p)) if (!Object.hasOwn(schema, k)) return `unknown field ${JSON.stringify(k.slice(0, 32))}`;
  for (const [k, d] of Object.entries(schema)) {
    const present = Object.hasOwn(p, k);
    if (!present) { if (d.required) return `missing field ${k}`; continue; }
    const v = p[k];
    switch (d.type) {
      case 'string':
        if (typeof v !== 'string' || v.length > (d.max ?? 200) || (d.pattern && !d.pattern.test(v))) return `bad field ${k}`;
        break;
      case 'int':
        if (!Number.isSafeInteger(v) || v < (d.min ?? 0) || v > (d.max ?? Number.MAX_SAFE_INTEGER)) return `bad field ${k}`;
        break;
      case 'num':
        if (typeof v !== 'number' || !Number.isFinite(v) || v < (d.min ?? 0) || v > (d.max ?? Number.MAX_SAFE_INTEGER)) return `bad field ${k}`;
        break;
      case 'bool':
        if (typeof v !== 'boolean') return `bad field ${k}`;
        break;
      case 'enum':
        if (!d.values.includes(v)) return `bad field ${k}`;
        break;
      case 'object':
        if (!isPlain(v)) return `bad field ${k}`;
        break;
      default: return 'internal schema error';
    }
  }
  return null;
}

// Result of a gate decision as plain JSON. dispatch (the executor's outcome, possibly a promise) is awaited.
function safe(v) {
  try {
    const s = JSON.stringify(v ?? null);
    return s.length <= 8192 ? JSON.parse(s) : { truncated: true };
  } catch { return null; }
}
async function outcome(r) {
  const out = { verdict: r.verdict, reason: r.reason };
  if (r.confirm) out.confirm = { ...r.confirm };
  if (r.dispatch !== undefined) out.dispatch = safe(await r.dispatch);
  return out;
}
function needGate(c) {
  if (!c.handle) throw new RpcError(E.UNAVAILABLE, 'actions-unavailable');
  return c.handle;
}
function needAudit(c) {
  if (!c.core.audit) throw new RpcError(E.UNAVAILABLE, 'audit-unavailable');
  return c.core.audit;
}

export const METHODS = Object.freeze({
  'core.status': {
    roles: ['api', 'system'], schema: {},
    run: (c) => c.status(),
  },
  'actions.request': {
    roles: ['api', 'system'],
    // idempotencyKey (optional, client-chosen, 8-128 of [A-Za-z0-9._:~-]): a retry with the same key, action and params
    // runs at most once, across a core restart too (livelock/idempotency.mjs). The JSON-RPC request id is NOT used: it
    // is per connection, often a counter that restarts with the client, and absent for notifications.
    schema: {
      id: { type: 'string', required: true, max: 64, pattern: ID_RE }, params: { type: 'object' },
      idempotencyKey: { type: 'string', max: 128, pattern: CLIENT_KEY_RE },
    },
    // synchronous gate call; only the executor's own outcome is awaited afterwards
    run: (c, p) => outcome(needGate(c).request({ id: p.id, params: p.params ?? {}, ...(p.idempotencyKey !== undefined ? { idempotencyKey: p.idempotencyKey } : {}) })),
  },
  'actions.confirm': {
    roles: ['api'],
    schema: {
      confirmId: { type: 'string', required: true, max: 64, pattern: /^[0-9a-f]{32}$/ },
      phrase: { type: 'string', required: true, max: 40 },
      actionHash: { type: 'string', required: true, max: 64, pattern: /^[0-9a-f]{64}$/ },
    },
    run: (c, p) => outcome(needGate(c).confirm(p.confirmId, p.phrase, p.actionHash)),
  },
  'actions.panic': {
    roles: ['api', 'system'],
    schema: { reason: { type: 'string', max: 200, pattern: TEXT_RE } },
    run: (c, p) => safe(needGate(c).panic({ reason: p.reason ?? 'api' })),
  },
  'live.set': {
    roles: ['system'],
    schema: { state: { type: 'enum', required: true, values: ['offline', 'live', 'unknown'] } },
    run: (c, p) => safe(needGate(c).setLiveState(p.state, { reason: 'system' })),
  },
  'audit.verify': {
    roles: ['api', 'system'], schema: {},
    run: async (c) => safe(await needAudit(c).verify()),
  },
  'audit.export': {
    roles: ['api'],
    schema: { afterId: { type: 'int', min: 0 }, limit: { type: 'int', min: 1, max: 500 } },
    run: async (c, p) => safe(await needAudit(c).exportPage({ afterId: p.afterId ?? 0, limit: p.limit ?? 100 })),
  },
  // Not a direct purge: a catalogue action 'chat.raw.purge' (class write, destructive verb, so chat can never reach
  // it). The gate answers with a confirmation; actions.confirm runs the executor.
  'audit.purge': {
    roles: ['api'],
    schema: { olderThanDays: { type: 'num', min: 0, max: 3650 }, all: { type: 'bool' } },
    run: (c, p) => {
      if (p.all === true && p.olderThanDays !== undefined) throw new RpcError(E.INVALID_PARAMS, 'use all or olderThanDays, not both');
      needAudit(c);
      const params = p.all === true ? { all: true } : (p.olderThanDays !== undefined ? { olderThanDays: p.olderThanDays } : {});
      return outcome(needGate(c).request({ id: 'chat.raw.purge', params }));
    },
  },
});

/** Role table as data: { method: [roles] }. */
export const roleTable = () => Object.fromEntries(Object.entries(METHODS).map(([k, m]) => [k, [...m.roles]]));
