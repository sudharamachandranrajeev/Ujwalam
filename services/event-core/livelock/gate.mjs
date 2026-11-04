// SPDX-License-Identifier: GPL-3.0-or-later
// Live-lock and action gate (P3 E4). Node stdlib only.
//
// request(action) is SYNCHRONOUS and does no I/O, network, disk scan or await. The only work is one plain-data
// snapshot of the request, map lookups, one JSON canonicalisation, and (confirm issue only) one SHA-256 and one
// randomBytes call. See docs/evidence/2026-10-28-p3-e4-livelock.md for the full rule table. Short form:
//
//   snapshot: own data properties only; getter, Proxy, odd prototype -> refuse 'bad-shape'; any throw -> 'internal-error'
//   unknown action / bad params                        -> refuse
//   panic on, and request is chat-tainted or rule      -> refuse 'panic'
//   chat-tainted: deny category                        -> refuse 'chat-forbidden' (whatever the class)
//   chat-tainted: chatAllowed false                    -> refuse 'chat-not-allowed' (reads too)
//   chat-tainted: chatMode 'off' (default)             -> refuse 'chat-off'
//   chat-tainted: chatMode 'dry-run'                   -> verdict 'dry-run': the audit records what would have run
//                                                         (action, rule, pseudo id, class, target); NOTHING executes.
//                                                         chatMode 'on' cannot be loaded in P3 (livelock/catalogue.mjs).
//   panic.set  (ui|api|system)                         -> allow, engages panic;  other sources refuse
//   panic.clear (ui|api)                               -> confirm with the live phrase rule; other sources refuse
//   class read                                         -> allow
//   write                                              -> confirm: 'yes' offline, 'yes, on air' live or unknown
//   on-air-write, offline                              -> confirm: 'yes'
//   on-air-write, live or unknown                      -> TWO confirmations in order: 'yes' (step 1), then, from the
//                                                         step-2 confirmation that step 1 returns, 'yes, on air'. Each
//                                                         is single use, hash-bound to action + params + live epoch,
//                                                         expires after stepTtlMs (default 30 s), and must come from the
//                                                         same untainted ui/api source.
//
// Sources: ui, api, chat, rule, remote, system. 'remote' (P15 LAN remote) is treated like 'api' for requests
// and may NOT confirm or panic until P15 decides. 'system' requests like 'api'; it may panic and set live
// state but may not confirm.
//
// Transport binding: gate.forSource(source) returns a handle whose source is fixed; the request object cannot
// override it. The E6 API layer must use one handle per authenticated transport and never take `source` from a
// request body. Bare gate.request() reads action.source and is for in-process callers only.
//
// Live state: 'offline' | 'live' | 'unknown'; unknown counts as live. Set only by system or api (untainted).
// Every change bumps liveEpoch; a confirmation is refused if the epoch or the effective state differs from the
// request. If no update arrives within liveStaleMs (default 15 s), the effective state is 'unknown'.
//
// Confirmations live in memory only. A restart drops them by design, as does panic.
//
// Idempotency (E7 follow-up): every allowed or confirmed dispatch gets act.idempotencyKey when it has an origin (see
// idempotencyKeyFor and livelock/idempotency.mjs): a caller key (request field idempotencyKey), else the nearest
// provenance event, mapped through opts.originOf(eventId) to the platform message id hash when the core knows it.
// A malformed caller key is refused 'bad-idempotency-key'. The executor wrapper skips a key it has already run.
// The act also carries liveState and liveEpoch; with an audit attached, a write that cannot be audited durably in time is
// refused by the wrapper ('audit-unavailable'), never run unaudited.
// Re-check (E4b review fix 2026-10-29): dispatch passes a guard as execute(act, guard). Right before the inner executor
// runs, the wrapper asks guard.revalidate(): 'panic' if panic was engaged since dispatch (or is on for a tainted or rule
// action), 'live-state-changed' if the live epoch or the effective live state differs from the dispatch. Either refuses
// the write. A skipped dispatch (the wrapper already ran or is running the key) answers { ok: false, error: 'skipped',
// skipped: <state> }, never ok: true.

import { createHash, randomBytes } from 'node:crypto';
import { types } from 'node:util';
import { DENY_SET, PANIC_CLEAR, PANIC_SET, buildCatalogue, isChatDenied } from './catalogue.mjs';
import { BadShape, SOURCES, cleanActor, copyProvenance, isPlainObject, own, summariseCopy, taintOfCopy } from './provenance.mjs';
import { SKIPPED_STATES } from './idempotency.mjs';

export const DEFAULT_TTL_MS = 60_000;
export const DEFAULT_STEP_TTL_MS = 30_000; // each step of a two-step (on-air) confirmation
export const DEFAULT_MAX_PENDING = 16; // per requesting source
export const DEFAULT_LIVE_STALE_MS = 15_000;
export const MAX_PARAMS_BYTES = 8192;
export const PHRASE_OFFLINE = 'yes';
export const PHRASE_LIVE = 'yes, on air';
export const CONFIRM_SOURCES = Object.freeze(['ui', 'api']);
export const PANIC_SOURCES = Object.freeze(['ui', 'api', 'system']);
export const LIVE_STATE_SOURCES = Object.freeze(['system', 'api']);
export const LIVE_STATES = Object.freeze(['offline', 'live', 'unknown']);
const USED_CAP = 256;
const DRY_KEYS_CAP = 4096;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const BAD = (what) => new BadShape(what);
/** Caller-supplied idempotency key (API clients, rules): 8 to 128 characters, no spaces. */
export const CLIENT_KEY_RE = /^[A-Za-z0-9._:~-]{8,128}$/;
/** Rule label on a request (audit rule_id): lowercase word, digits, dash, dot, underscore. */
const RULE_RE = /^[a-z][a-z0-9._-]{0,47}$/;
const ORIGIN_RE = /^[0-9a-f]{64}$/;
/** The idempotent wrapper's skip answer: exactly { skipped: <state> } (livelock/idempotency.mjs). */
/** Returns the skipped state or null. Never runs a getter and never throws. */
const skippedState = (r) => {
  try {
    if (!isPlainObject(r) || Object.keys(r).length !== 1) return null;
    const v = own(r, 'skipped');
    return SKIPPED_STATES.includes(v) ? v : null;
  } catch { return null; }
};

/** Canonical JSON: sorted keys, JSON-plain values only (own data properties, plain prototypes, no Proxy, no
 *  __proto__/constructor/prototype keys, depth <= 12). Never runs a getter. Throws on anything else. */
export function canonicalJson(v, depth = 0) {
  if (depth > 12) throw new TypeError('too deep');
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw new TypeError('non-finite'); return JSON.stringify(v); }
  if (typeof v !== 'object' || types.isProxy(v)) throw new TypeError('not plain JSON');
  if (Array.isArray(v)) {
    if (Object.getPrototypeOf(v) !== Array.prototype) throw new TypeError('not plain JSON');
    const out = [];
    for (let i = 0; i < v.length; i++) {
      const d = Object.getOwnPropertyDescriptor(v, i);
      if (!d || !('value' in d)) throw new TypeError('not plain JSON');
      out.push(canonicalJson(d.value, depth + 1));
    }
    return `[${out.join(',')}]`;
  }
  if (!isPlainObject(v)) throw new TypeError('not plain JSON');
  const parts = [];
  for (const k of Object.keys(v).sort()) {
    if (FORBIDDEN_KEYS.has(k)) throw new TypeError('forbidden key');
    const d = Object.getOwnPropertyDescriptor(v, k);
    if (!('value' in d)) throw new TypeError('not plain JSON');
    parts.push(`${JSON.stringify(k)}:${canonicalJson(d.value, depth + 1)}`);
  }
  return `{${parts.join(',')}}`;
}

/** step, epoch and prev (the step-1 hash) are only set for a two-step (on-air while live) confirmation, so the hash of
 *  every other confirmation is unchanged. */
export function actionHash({ id, params, source, actor, phrase, step, epoch, prev }) {
  const o = { id, params, source, actor, phrase };
  if (step !== undefined) { o.step = step; o.epoch = epoch; if (prev !== undefined) o.prev = prev; }
  return createHash('sha256').update(canonicalJson(o)).digest('hex');
}

/** Idempotency key of one action, or null when it has no origin. base: { id, source, actor, prov } from the gate's
 *  snapshot (prov.eventIds nearest first); clientKey: a validated caller key; originOf(eventId) -> platform message id
 *  hash (64 hex) or undefined. SHA-256 hex of canonical JSON { v: 1, origin, id, source, actor, params }. */
export function idempotencyKeyFor({ id, source, actor, prov }, params, clientKey, originOf) {
  let origin = null;
  if (clientKey) origin = `ck:${source}:${clientKey}`;
  else {
    // The nearest event that came from a platform wins (rule hops carry their own ids); else the nearest event id.
    const ids = (prov?.eventIds ?? []).filter((x) => typeof x === 'string' && x !== 'invalid');
    for (const ev of ids) {
      let o;
      try { o = originOf?.(ev); } catch { o = undefined; }
      if (typeof o === 'string' && ORIGIN_RE.test(o)) { origin = `pm:${o}`; break; }
    }
    if (!origin && ids.length) origin = `ev:${ids[0]}`;
  }
  if (!origin) return null;
  return createHash('sha256').update(canonicalJson({ v: 1, origin, id, source, actor, params })).digest('hex');
}

const posInt = (name, v, dflt) => {
  const x = v === undefined ? dflt : v; // only an absent value takes the default; null is an error
  if (!Number.isSafeInteger(x) || x <= 0) throw new TypeError(`${name} must be a finite positive integer`);
  return x;
};

/** opts: { catalogue: parsed catalogue JSON or a Map from buildCatalogue (either way it is rebuilt and
 *  validated through buildCatalogue, and the gate keeps a private frozen copy), executor?: { execute(action) },
 *  onDecision?(rec), emit?(kind, fields), now?: () => ms (monotonic, expiry), wall?: () => ms (audit stamps),
 *  ttlMs?, stepTtlMs? (each on-air step, default 30 s), maxPending? (per requesting source), liveStaleMs?, random?, originOf?(eventId) }. Throws on a bad catalogue or limit. */
export function createActionGate(opts) {
  const src = opts.catalogue;
  if (!(src instanceof Map) && !(src && typeof src === 'object')) throw new TypeError('catalogue must be a catalogue document or a Map from buildCatalogue');
  const built = buildCatalogue(src instanceof Map ? { version: 1, actions: [...src.values()] } : src);
  const catalogue = new Map(); // private; never exposed
  for (const [id, e] of built) catalogue.set(id, Object.freeze({ ...e, chatDenied: isChatDenied(id, e.target) }));
  const now = opts.now ?? (() => performance.now());
  const wall = opts.wall ?? Date.now;
  const ttlMs = posInt('ttlMs', opts.ttlMs, DEFAULT_TTL_MS);
  const stepTtlMs = posInt('stepTtlMs', opts.stepTtlMs, DEFAULT_STEP_TTL_MS);
  const maxPending = posInt('maxPending', opts.maxPending, DEFAULT_MAX_PENDING);
  const liveStaleMs = posInt('liveStaleMs', opts.liveStaleMs, DEFAULT_LIVE_STALE_MS);
  const random = opts.random ?? randomBytes;

  let liveRaw = 'unknown';
  let liveAt = -Infinity; // mono time of the last accepted setLiveState
  let liveEpoch = 0; // bumped on every change of the raw state
  let panicOn = false;
  let panicGen = 0; // bumped on every engage; an in-flight dispatch from an older generation is refused (guard)
  const pending = new Map(); // confirmId -> record, insertion order = age
  const used = new Set();
  const dryKeys = new Set(); // idempotency keys already recorded as a dry run (memory only; the bus dedupe covers restarts)
  let dryRuns = 0;
  let dryDuplicates = 0;

  const clock = () => { const t = now(); if (!Number.isFinite(t)) throw new TypeError('clock'); return t; };
  const liveState = () => (liveRaw !== 'unknown' && clock() - liveAt > liveStaleMs ? 'unknown' : liveRaw);
  const isLive = (s) => s !== 'offline';
  const phraseFor = (s) => (isLive(s) ? PHRASE_LIVE : PHRASE_OFFLINE);
  const srcLabel = (v) => (SOURCES.includes(v) ? v : 'invalid');

  // Builds the record (throws on a broken clock: the caller turns that into a refusal); the hook cannot throw out.
  function audit(type, base, verdict, reason, extra) {
    if (!opts.onDecision) return;
    const ts = new Date(wall()).toISOString();
    const rec = {
      type, actionId: base.id, source: base.source, actor: base.actor, provenance: base.prov,
      ...(base.rule ? { rule: base.rule } : {}),
      verdict, reason, liveState: liveState(), panic: panicOn, ts, mono: clock(), ...extra,
    };
    try { opts.onDecision(Object.freeze(rec)); } catch { /* an audit hook must never break the gate */ }
  }
  // Last-resort audit for internal errors: never throws.
  function auditError(type, base) {
    if (!opts.onDecision) return;
    try {
      let ts = null;
      try { ts = new Date(wall()).toISOString(); } catch { /* broken wall clock */ }
      opts.onDecision(Object.freeze({
        type, actionId: base?.id ?? '', source: base?.source ?? 'invalid', actor: base?.actor ?? 'invalid',
        provenance: base?.prov ?? { tainted: true, kinds: [], eventIds: [] },
        verdict: 'refuse', reason: 'internal-error', liveState: 'unknown', panic: panicOn, ts,
      }));
    } catch { /* never */ }
  }

  function dispatch(rec) {
    const entry = catalogue.get(rec.id);
    // liveState and liveEpoch: the effective state and epoch at dispatch (a confirmed action is dispatched only if they
    // equal the ones at issue). The executor wrapper uses them for the fail-closed audit rule and, through the guard,
    // re-checks them against the CURRENT state right before the inner executor runs (E4b review findings 1 and 2).
    let ls = 'unknown'; // a broken clock counts as unknown, which counts as live (the strict side)
    try { ls = liveState(); } catch { /* keep unknown */ }
    const epoch = liveEpoch;
    const gen = panicGen;
    const act = Object.freeze({
      id: rec.id, params: rec.params, source: rec.source, actor: rec.actor,
      class: entry.class, target: entry.target, tainted: rec.prov.tainted, liveState: ls, liveEpoch: epoch,
      ...(rec.idem ? { idempotencyKey: rec.idem } : {}),
    });
    const currentState = () => { try { return liveState(); } catch { return 'unknown'; } };
    // The guard is the second argument of execute(); a raw executor ignores it. Synchronous, no I/O.
    const guard = Object.freeze({
      liveState: currentState,
      revalidate: () => {
        if (panicGen !== gen || (panicOn && (act.tainted || act.source === 'rule'))) return 'panic';
        if (liveEpoch !== epoch || currentState() !== ls) return 'live-state-changed';
        return null;
      },
    });
    if (!opts.executor || typeof opts.executor.execute !== 'function') return { ok: false, error: 'no-executor' };
    // A skipped dispatch (the wrapper already has the key) did not run now: ok false with the skipped state.
    const wrap = (result) => { const sk = skippedState(result); return sk ? { ok: false, error: 'skipped', skipped: sk } : { ok: true, result }; };
    try {
      const r = opts.executor.execute(act, guard);
      if (r && typeof r.then === 'function') {
        return r.then(wrap, (e) => ({ ok: false, error: String(e?.message ?? e).slice(0, 200) }));
      }
      return wrap(r);
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e).slice(0, 200) };
    }
  }

  function clearPending(reason) {
    const gone = [...pending.values()];
    pending.clear(); // clear first: a failing audit must not leave confirmations alive
    for (const p of gone) audit('confirm-refused', p, 'refuse', reason, { actionHash: p.hash });
  }

  function refuse(base, reason) {
    audit('request', base, 'refuse', reason);
    return { verdict: 'refuse', reason };
  }

  function issue(base, params, kind, idem = null) {
    const t = clock();
    for (const [id, p] of pending) {
      if (p.expiresAt <= t) { pending.delete(id); audit('confirm-refused', p, 'refuse', 'expired', { actionHash: p.hash }); }
    }
    // Per-source quota; a full quota refuses the NEW request, so no source can evict another's confirmation.
    let mine = 0;
    for (const p of pending.values()) if (p.source === base.source) mine++;
    if (mine >= maxPending) return refuse(base, 'too-many-pending');
    const state = liveState();
    // An on-air write while live (or unknown) needs two confirmations; step 1 is the offline phrase.
    const twoStep = kind === 'action' && isLive(state) && catalogue.get(base.id)?.class === 'on-air-write';
    const phrase = twoStep ? PHRASE_OFFLINE : phraseFor(state);
    const step = twoStep ? 1 : 0; // 0 = a single confirmation
    const hash = actionHash({ id: base.id, params, source: base.source, actor: base.actor, phrase, ...(twoStep ? { step: 1, epoch: liveEpoch } : {}) });
    const confirmId = random(16).toString('hex');
    const expiresAt = t + (twoStep ? stepTtlMs : ttlMs);
    audit('confirm-issued', base, 'confirm', 'confirmation-required', { actionHash: hash, ...(twoStep ? { step: 1 } : {}) });
    pending.set(confirmId, { ...base, params, phrase, hash, kind, liveAtIssue: state, epoch: liveEpoch, expiresAt, idem, step });
    return {
      verdict: 'confirm', reason: 'confirmation-required',
      confirm: { confirmId, phrase, actionHash: hash, liveStateAtRequest: state, expiresAt, ...(twoStep ? { step: 1, of: 2 } : {}) },
    };
  }

  /** One plain-data snapshot of the request. Decisions and dispatch use only this. */
  function snapshot(action, boundSource) {
    if (!isPlainObject(action)) throw BAD('request');
    const rawSource = boundSource ?? own(action, 'source');
    const source = SOURCES.includes(rawSource) ? rawSource : undefined;
    const rawId = own(action, 'id');
    const prov = copyProvenance(own(action, 'provenance'));
    const tainted = source === undefined ? true : taintOfCopy(source, prov);
    let params;
    let paramsOk = true;
    try {
      const json = canonicalJson(own(action, 'params') ?? {});
      if (json.length > MAX_PARAMS_BYTES) paramsOk = false; else params = JSON.parse(json);
    } catch (e) { if (e instanceof BadShape) throw e; paramsOk = false; }
    const rawRule = own(action, 'ruleId');
    const rule = typeof rawRule === 'string' && RULE_RE.test(rawRule) ? rawRule : undefined; // a rule label, never free text
    const ck = own(action, 'idempotencyKey');
    const clientKeyOk = ck === undefined || (typeof ck === 'string' && CLIENT_KEY_RE.test(ck));
    return {
      base: {
        id: typeof rawId === 'string' ? rawId.slice(0, 64) : '',
        source: source ?? 'invalid',
        actor: cleanActor(own(action, 'actor'), tainted),
        prov: summariseCopy(source ?? 'chat', prov),
        ...(rule ? { rule } : {}),
      },
      source, tainted, params, paramsOk, clientKeyOk, clientKey: clientKeyOk && ck !== undefined ? ck : null,
    };
  }

  // What the non-chat rules would answer for this action now (E4b review finding 5): 'allow' (read), 'confirm' with the
  // number of confirmations (1, or 2 for an on-air write while live or unknown), or 'refuse' with the reason. Chat can
  // never give a confirmation, so a 'confirm' would-be result is never satisfiable from chat.
  function wouldBe(id, entry) {
    if (id === PANIC_SET || id === PANIC_CLEAR) return { wouldDecision: 'refuse', wouldReason: 'source-not-permitted' };
    if (entry.class === 'read') return { wouldDecision: 'allow', wouldReason: 'read' };
    let st = 'unknown';
    try { st = liveState(); } catch { /* unknown counts as live */ }
    const steps = entry.class === 'on-air-write' && isLive(st) ? 2 : 1;
    return { wouldDecision: 'confirm', wouldReason: steps === 2 ? 'two-step-confirmation' : 'confirmation-required', wouldSteps: steps };
  }

  // Chat dry run: record what the gate would have decided and execute nothing. The executor is never called and no
  // idempotency claim is made. A repeat of the same key is not recorded again. The row has the action id, rule id,
  // pseudonymous actor, class, target and the would-be decision: no params, no chat text, no name, no platform user id.
  function dryRun(base, entry, idem) {
    if (idem) {
      if (dryKeys.has(idem)) { dryDuplicates++; return { verdict: 'dry-run', reason: 'dry-run-duplicate' }; }
      dryKeys.add(idem);
      if (dryKeys.size > DRY_KEYS_CAP) dryKeys.delete(dryKeys.values().next().value);
    }
    dryRuns++;
    audit('request', base, 'dry-run', 'chat-dry-run', { dryRun: true, ...wouldBe(base.id, entry), wouldClass: entry.class, wouldTarget: entry.target });
    return { verdict: 'dry-run', reason: 'chat-dry-run' };
  }

  function decide(action, boundSource) {
    let s;
    try { s = snapshot(action, boundSource); } catch (e) {
      if (!(e instanceof BadShape)) throw e;
      return refuse({ id: '', source: srcLabel(boundSource), actor: 'invalid', prov: summariseCopy('chat', undefined) }, 'bad-shape');
    }
    const { base, source, tainted, params } = s;
    const id = base.id;
    if (source === undefined) return refuse(base, 'bad-source');
    const entry = catalogue.get(id);
    if (!entry) return refuse(base, 'unknown-action');
    if (!s.paramsOk) return refuse(base, 'bad-params');
    if (!s.clientKeyOk) return refuse(base, 'bad-idempotency-key');
    const idem = idempotencyKeyFor(base, params, s.clientKey, opts.originOf);

    if (panicOn && (tainted || source === 'rule')) return refuse(base, 'panic');

    // Chat-tainted: an allowlist. Deny categories first, whatever the class.
    if (tainted) {
      if (entry.chatDenied || isChatDenied(id, entry.target) || DENY_SET.has(id)) return refuse(base, 'chat-forbidden');
      if (entry.chatAllowed !== true) return refuse(base, 'chat-not-allowed');
      if (entry.chatMode !== 'dry-run') return refuse(base, 'chat-off'); // 'on' cannot be loaded in P3
      return dryRun(base, entry, idem);
    }

    if (id === PANIC_SET) {
      if (!PANIC_SOURCES.includes(source)) return refuse(base, 'source-not-permitted');
      engage(source, 'request', base.prov);
      return { verdict: 'allow', reason: 'panic-engaged' };
    }
    if (id === PANIC_CLEAR) {
      if (!CONFIRM_SOURCES.includes(source)) return refuse(base, 'source-not-permitted');
      if (!panicOn) return refuse(base, 'not-in-panic');
      return issue(base, params, 'panic-clear', idem);
    }

    if (entry.class === 'read') {
      audit('request', base, 'allow', 'read');
      return { verdict: 'allow', reason: 'read', dispatch: dispatch({ ...base, params, idem }) };
    }

    // write / on-air-write from ui, api, remote, system or an untainted rule: confirmation by ui or api.
    return issue(base, params, 'action', idem);
  }

  function request(action, boundSource) {
    try { return decide(action, boundSource); } catch {
      auditError('request', { id: '', source: srcLabel(boundSource) });
      return { verdict: 'refuse', reason: 'internal-error' };
    }
  }

  function doConfirm(confirmId, phrase, hash, source, confirmTainted) {
    const p = typeof confirmId === 'string' ? pending.get(confirmId) : undefined;
    const base = p ?? { id: '', source: srcLabel(source), actor: '', prov: summariseCopy('chat', undefined) };
    const no = (reason, extra) => {
      audit('confirm-refused', base, 'refuse', reason, { confirmingSource: srcLabel(source), ...extra });
      return { verdict: 'refuse', reason };
    };
    if (!CONFIRM_SOURCES.includes(source)) return no('source-not-permitted'); // does not consume the pending item
    if (confirmTainted) return no('tainted-confirmation'); // chat can never confirm; does not consume the pending item
    if (!p) return no(typeof confirmId === 'string' && used.has(confirmId) ? 'replayed' : 'unknown-confirm');
    pending.delete(confirmId); // single use from here on, whatever the outcome
    used.add(confirmId);
    if (used.size > USED_CAP) used.delete(used.values().next().value); // older ids then report unknown-confirm
    if (clock() >= p.expiresAt) return no('expired', { actionHash: p.hash });
    if (p.epoch !== liveEpoch || p.liveAtIssue !== liveState()) return no('live-state-changed', { actionHash: p.hash });
    if (p.step === 2 && p.confirmer !== source) return no('step-source-mismatch', { actionHash: p.hash });
    if (typeof hash !== 'string' || hash !== p.hash) return no('hash-mismatch', { actionHash: p.hash });
    if (typeof phrase !== 'string' || phrase.trim().toLowerCase() !== p.phrase) return no('wrong-phrase', { actionHash: p.hash });
    if (p.kind === 'panic-clear') {
      audit('panic-clear', p, 'allow', 'panic-cleared', { actionHash: p.hash, confirmingSource: source });
      panicOn = false;
      opts.emit?.('system.panic', { reason: 'cleared' });
      return { verdict: 'allow', reason: 'panic-cleared' };
    }
    if (p.step === 1) return secondStep(confirmId, p, source);
    audit('confirm-accepted', p, 'allow', 'confirmed', { actionHash: p.hash, confirmingSource: source, ...(p.step === 2 ? { step: 2 } : {}) });
    return { verdict: 'allow', reason: 'confirmed', dispatch: dispatch(p) };
  }

  // Step 1 accepted: nothing runs. A new single-use confirmation for step 2 is issued, bound to the same action, params,
  // live epoch and confirming source, and to the step-1 hash. Step 1 is already spent. A refused step 1 never gets here,
  // so step 2 cannot exist without a valid, unexpired step 1.
  function secondStep(parentId, p, source) {
    const t = clock();
    const hash2 = actionHash({ id: p.id, params: p.params, source: p.source, actor: p.actor, phrase: PHRASE_LIVE, step: 2, epoch: p.epoch, prev: p.hash });
    const confirmId = random(16).toString('hex');
    const expiresAt = t + stepTtlMs;
    audit('confirm-accepted', p, 'confirm', 'step-1-accepted', { actionHash: p.hash, confirmingSource: source, step: 1 });
    audit('confirm-issued', p, 'confirm', 'second-confirmation-required', { actionHash: hash2, step: 2 });
    pending.set(confirmId, { ...p, phrase: PHRASE_LIVE, hash: hash2, step: 2, parentId, confirmer: source, expiresAt });
    return {
      verdict: 'confirm', reason: 'second-confirmation-required',
      confirm: { confirmId, phrase: PHRASE_LIVE, actionHash: hash2, liveStateAtRequest: p.liveAtIssue, expiresAt, step: 2, of: 2 },
    };
  }

  /** ctx: { source?, provenance? }. A provenance that is chat-tainted (or unreadable) refuses the confirmation. */
  function confirm(confirmId, phrase, hash, ctx = {}, boundSource) {
    let source;
    try {
      source = boundSource ?? (isPlainObject(ctx) ? own(ctx, 'source') : undefined);
      const prov = isPlainObject(ctx) ? copyProvenance(own(ctx, 'provenance')) : undefined;
      const tainted = source === 'chat' || (prov !== undefined && taintOfCopy(SOURCES.includes(source) ? source : 'chat', prov));
      return doConfirm(confirmId, phrase, hash, source, tainted);
    } catch {
      if (typeof confirmId === 'string') pending.delete(confirmId); // fail safe: an errored confirmation is spent
      auditError('confirm-refused', { id: '', source: srcLabel(source) });
      return { verdict: 'refuse', reason: 'internal-error' };
    }
  }

  function engage(source, reason, prov) {
    const was = panicOn;
    panicOn = true;
    panicGen++;
    clearPending('panic');
    audit('panic', { id: PANIC_SET, source, actor: '', prov }, 'allow', was ? 'already-panic' : 'panic-engaged');
    if (!was) opts.emit?.('system.panic', { reason: typeof reason === 'string' ? reason.slice(0, 200) : 'panic' });
    return was ? 'already-panic' : 'panic-engaged';
  }

  /** Read source, provenance and one more field from a ctx object without running getters. */
  function readCtx(ctx, boundSource, field) {
    const c = ctx === undefined ? {} : ctx;
    if (!isPlainObject(c)) throw BAD('ctx');
    const source = boundSource ?? own(c, 'source');
    const prov = copyProvenance(own(c, 'provenance'));
    return { source, prov, field: own(c, field), sum: summariseCopy(SOURCES.includes(source) ? source : 'chat', prov) };
  }

  function panic(ctx = {}, boundSource) {
    let base = { id: PANIC_SET, source: srcLabel(boundSource), actor: '', prov: summariseCopy('chat', undefined) };
    try {
      const c = readCtx(ctx, boundSource, 'reason');
      base = { ...base, source: srcLabel(c.source), prov: c.sum };
      if (!PANIC_SOURCES.includes(c.source) || c.sum.tainted) {
        audit('panic', base, 'refuse', 'source-not-permitted');
        return { ok: false, reason: 'source-not-permitted' };
      }
      return { ok: true, reason: engage(c.source, c.field, c.sum) };
    } catch {
      // A broken clock or hook while engaging: panic stays on if it got that far (fail safe).
      auditError('panic', base);
      return { ok: false, reason: 'internal-error' };
    }
  }

  function setLiveState(state, ctx = {}, boundSource) {
    let base = { id: 'live-state.set', source: srcLabel(boundSource), actor: '', prov: summariseCopy('chat', undefined) };
    try {
      const c = readCtx(ctx, boundSource, 'reason');
      base = { ...base, source: srcLabel(c.source), prov: c.sum };
      if (!LIVE_STATES.includes(state)) { audit('live-state', base, 'refuse', 'bad-state'); return { ok: false, reason: 'bad-state' }; }
      if (!LIVE_STATE_SOURCES.includes(c.source) || c.sum.tainted) {
        audit('live-state', base, 'refuse', 'source-not-permitted');
        return { ok: false, reason: 'source-not-permitted' };
      }
      const t = clock();
      const before = liveState();
      const changed = liveRaw !== state || before !== state; // a stale state refreshed counts as a change
      audit('live-state', base, 'allow', changed ? 'changed' : 'unchanged', { to: state });
      liveRaw = state;
      liveAt = t;
      if (changed) liveEpoch++;
      // system.livestate carries a boolean (E1 schema); 'unknown' has no event, the bus learns it from the
      // studio feed's own system.disconnected.
      if (changed && state !== 'unknown') opts.emit?.('system.livestate', { live: state === 'live' });
      return { ok: true, reason: changed ? 'changed' : 'unchanged' };
    } catch {
      auditError('live-state', base);
      return { ok: false, reason: 'internal-error' };
    }
  }

  function state() {
    let s = 'unknown';
    try { s = liveState(); } catch { /* broken clock counts as unknown */ }
    return { liveState: s, effectiveLive: isLive(s), liveEpoch, panic: panicOn, pending: pending.size, dryRuns, dryDuplicates };
  }

  // Read-only view of the private catalogue. Entries are frozen; there is no set or delete.
  const view = Object.freeze({
    get: (id) => catalogue.get(id),
    has: (id) => catalogue.has(id),
    ids: () => [...catalogue.keys()],
    get size() { return catalogue.size; },
  });

  /** A handle whose source is fixed by the transport. The request object's own `source` is ignored. */
  function forSource(source) {
    if (!SOURCES.includes(source)) throw new TypeError(`unknown source ${String(source).slice(0, 16)}`);
    return Object.freeze({
      source,
      request: (action) => request(action, source),
      confirm: (confirmId, phrase, hash, ctx) => confirm(confirmId, phrase, hash, ctx, source),
      panic: (ctx) => panic(ctx, source),
      setLiveState: (st, ctx) => setLiveState(st, ctx, source),
    });
  }

  return Object.freeze({
    request: (action) => request(action),
    confirm: (confirmId, phrase, hash, ctx) => confirm(confirmId, phrase, hash, ctx),
    panic: (ctx) => panic(ctx),
    setLiveState: (st, ctx) => setLiveState(st, ctx),
    forSource, state, catalogue: view,
  });
}
