// SPDX-License-Identifier: GPL-3.0-or-later
// Hand-written runtime validator for event v1 (P3 E1). Node stdlib only, no ajv at runtime.
// Must agree with schema/event.schema.json; tests/event-core-validate.test.mjs runs both on the same cases.
// validateEvent(ev) -> { ok, errors: [{ path, message }] }. Reports every problem it finds; never throws.

import {
  CAPS, CONTROL_RE, EVENT_VERSION, ID_RE, ISO_RE, KINDS, KIND_FIELDS, PLATFORMS, PSEUDO_RE, ROLES,
  SOURCES, cpLen, isSystemKind,
} from './model.mjs';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function checkStr(v, p, errs, { min = 0, max, re } = {}) {
  if (typeof v !== 'string') return errs.push({ path: p, message: 'must be a string' });
  const n = cpLen(v);
  if (n < min) errs.push({ path: p, message: `shorter than ${min}` });
  if (n > max) errs.push({ path: p, message: `longer than ${max}` });
  if (CONTROL_RE.test(v)) errs.push({ path: p, message: 'contains a control character' });
  if (re && !re.test(v)) errs.push({ path: p, message: 'does not match the required format' });
}

function checkNumber(v, p, errs, spec) {
  if (spec.t === 'int' ? !Number.isSafeInteger(v) : !(typeof v === 'number' && Number.isFinite(v))) {
    return errs.push({ path: p, message: spec.t === 'int' ? 'must be an integer' : 'must be a number' });
  }
  if (spec.min !== undefined && v < spec.min) errs.push({ path: p, message: `below ${spec.min}` });
  if (spec.exclusiveMin !== undefined && v <= spec.exclusiveMin) errs.push({ path: p, message: `not above ${spec.exclusiveMin}` });
  if (spec.max !== undefined && v > spec.max) errs.push({ path: p, message: `above ${spec.max}` });
}

function checkField(v, p, errs, spec) {
  switch (spec.t) {
    case 'str': return checkStr(v, p, errs, spec);
    case 'int': case 'num': return checkNumber(v, p, errs, spec);
    case 'bool': if (typeof v !== 'boolean') errs.push({ path: p, message: 'must be a boolean' }); return undefined;
    case 'enum': if (!spec.values.includes(v)) errs.push({ path: p, message: `must be one of ${spec.values.join(', ')}` }); return undefined;
    case 'emotes': {
      if (!Array.isArray(v)) return errs.push({ path: p, message: 'must be an array' });
      if (v.length > CAPS.emotes) errs.push({ path: p, message: `more than ${CAPS.emotes} items` });
      v.forEach((e, i) => {
        if (!isObj(e)) return errs.push({ path: `${p}[${i}]`, message: 'must be an object' });
        checkStr(e.id, `${p}[${i}].id`, errs, { min: 1, max: CAPS.emoteId });
        checkStr(e.name, `${p}[${i}].name`, errs, { min: 1, max: CAPS.emoteName });
        for (const k of Object.keys(e)) if (k !== 'id' && k !== 'name') errs.push({ path: `${p}[${i}].${k}`, message: 'unknown field' });
        return undefined;
      });
      return undefined;
    }
    default: throw new Error(`bad field spec ${spec.t}`);
  }
}

function checkUser(u, errs) {
  if (!isObj(u)) return errs.push({ path: 'user', message: 'must be an object' });
  checkStr(u.pseudoId, 'user.pseudoId', errs, { min: 32, max: 32, re: PSEUDO_RE });
  if (u.platformUserId !== null) checkStr(u.platformUserId, 'user.platformUserId', errs, { min: 1, max: CAPS.platformUserId });
  checkStr(u.displayName, 'user.displayName', errs, { min: 1, max: CAPS.displayName });
  if (!Array.isArray(u.roles)) errs.push({ path: 'user.roles', message: 'must be an array' });
  else {
    if (u.roles.length < 1) errs.push({ path: 'user.roles', message: 'needs at least one role' });
    if (new Set(u.roles).size !== u.roles.length) errs.push({ path: 'user.roles', message: 'roles must be unique' });
    u.roles.forEach((r, i) => { if (!ROLES.includes(r)) errs.push({ path: `user.roles[${i}]`, message: `must be one of ${ROLES.join(', ')}` }); });
  }
  for (const k of ['pseudoId', 'platformUserId', 'displayName', 'roles']) {
    if (!(k in u)) errs.push({ path: `user.${k}`, message: 'is required' });
  }
  for (const k of Object.keys(u)) {
    if (!['pseudoId', 'platformUserId', 'displayName', 'roles'].includes(k)) errs.push({ path: `user.${k}`, message: 'unknown field' });
  }
  return undefined;
}

const ENVELOPE = ['v', 'id', 'kind', 'platform', 'source', 'platformMessageId', 'receivedAt', 'mono'];

export function validateEvent(ev) {
  const errs = [];
  if (!isObj(ev)) return { ok: false, errors: [{ path: '', message: 'must be an object' }] };
  if (ev.v !== EVENT_VERSION) errs.push({ path: 'v', message: `must be ${EVENT_VERSION}` });
  checkStr(ev.id, 'id', errs, { min: 31, max: 31, re: ID_RE });
  if (!KINDS.includes(ev.kind)) {
    errs.push({ path: 'kind', message: 'unknown kind' });
    return { ok: false, errors: errs }; // fields cannot be judged without a kind
  }
  if (!PLATFORMS.includes(ev.platform)) errs.push({ path: 'platform', message: `must be one of ${PLATFORMS.join(', ')}` });
  if (!SOURCES.includes(ev.source)) errs.push({ path: 'source', message: `must be one of ${SOURCES.join(', ')}` });
  if (ev.platformMessageId !== null) checkStr(ev.platformMessageId, 'platformMessageId', errs, { min: 1, max: CAPS.platformMessageId });
  checkStr(ev.receivedAt, 'receivedAt', errs, { re: ISO_RE });
  if (!(typeof ev.mono === 'number' && Number.isFinite(ev.mono) && ev.mono >= 0)) errs.push({ path: 'mono', message: 'must be a number >= 0' });
  for (const k of ENVELOPE) if (!(k in ev)) errs.push({ path: k, message: 'is required' });

  const allowed = new Set(ENVELOPE);
  if (isSystemKind(ev.kind)) {
    // system events have no user
  } else {
    allowed.add('user');
    if (!('user' in ev)) errs.push({ path: 'user', message: 'is required' });
    else checkUser(ev.user, errs);
  }
  const fields = KIND_FIELDS[ev.kind];
  for (const [name, spec] of Object.entries(fields)) {
    allowed.add(name);
    if (!(name in ev)) { if (spec.req) errs.push({ path: name, message: 'is required' }); continue; }
    checkField(ev[name], name, errs, spec);
  }
  for (const k of Object.keys(ev)) if (!allowed.has(k)) errs.push({ path: k, message: 'unknown field' });
  return { ok: errs.length === 0, errors: errs };
}
