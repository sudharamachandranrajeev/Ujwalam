// SPDX-License-Identifier: GPL-3.0-or-later
// A6: small JSON Schema checker for the label server (stdlib only; ajv is a dev dependency and is not
// available at runtime). It supports exactly the keywords data/labels.schema.json uses: $ref (local),
// type, const, enum, pattern, minimum, maximum, exclusiveMinimum, maxLength, items, uniqueItems,
// required, properties, additionalProperties:false, if/then, and the boolean schema `false`.
// tests/label-server.test.mjs checks that it agrees with ajv on the label schema.
// Errors are "<json pointer> <keyword>" strings. They never contain the value that failed.
// Every key lookup is an own-property check (Object.hasOwn): a key named like an Object.prototype
// member (constructor, toString, __proto__, valueOf, hasOwnProperty) is an ordinary key here, so it is
// an additional property, never a declared one (review H2, 2026-10-28). JSON.parse makes "__proto__"
// an own data property, so Object.keys lists it.

function resolveRef(root, ref) {
  if (!ref.startsWith('#/')) throw new Error('only local $ref is supported');
  return ref.slice(2).split('/').reduce((n, k) => {
    if (n === null || typeof n !== 'object' || !Object.hasOwn(n, k)) throw new Error('unresolvable $ref');
    return n[k];
  }, root);
}

function check(schema, root, v, at, errs) {
  if (schema === true) return;
  if (schema === false) { errs.push(`${at || '/'} forbidden`); return; }
  if (Object.hasOwn(schema, '$ref')) { check(resolveRef(root, schema.$ref), root, v, at, errs); return; }
  const isObj = v !== null && typeof v === 'object' && !Array.isArray(v);
  const t = schema.type;
  const typeOk = t === undefined
    || (t === 'object' && isObj)
    || (t === 'array' && Array.isArray(v))
    || (t === 'string' && typeof v === 'string')
    || (t === 'number' && typeof v === 'number' && Number.isFinite(v))
    || (t === 'integer' && Number.isInteger(v))
    || (t === 'boolean' && typeof v === 'boolean');
  if (!typeOk) { errs.push(`${at || '/'} type`); return; }
  if (Object.hasOwn(schema, 'const') && v !== schema.const) errs.push(`${at || '/'} const`);
  if (schema.enum && !schema.enum.includes(v)) errs.push(`${at || '/'} enum`);
  if (typeof v === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(v)) errs.push(`${at || '/'} pattern`);
    if (schema.maxLength !== undefined && [...v].length > schema.maxLength) errs.push(`${at || '/'} maxLength`);
  }
  if (typeof v === 'number') {
    if (schema.minimum !== undefined && v < schema.minimum) errs.push(`${at || '/'} minimum`);
    if (schema.maximum !== undefined && v > schema.maximum) errs.push(`${at || '/'} maximum`);
    if (schema.exclusiveMinimum !== undefined && v <= schema.exclusiveMinimum) errs.push(`${at || '/'} exclusiveMinimum`);
  }
  if (Array.isArray(v)) {
    if (schema.uniqueItems && new Set(v.map((x) => JSON.stringify(x))).size !== v.length) errs.push(`${at || '/'} uniqueItems`);
    if (schema.items) v.forEach((x, i) => check(schema.items, root, x, `${at}/${i}`, errs));
  }
  if (isObj) {
    for (const k of schema.required || []) if (!Object.hasOwn(v, k)) errs.push(`${at || '/'} required`);
    const props = schema.properties || {};
    for (const k of Object.keys(v)) {
      if (Object.hasOwn(props, k)) check(props[k], root, v[k], `${at}/${k}`, errs);
      else if (schema.additionalProperties === false) errs.push(`${at || '/'} additionalProperties`);
    }
    if (schema.if) {
      const probe = [];
      check(schema.if, root, v, at, probe);
      if (!probe.length && schema.then) check(schema.then, root, v, at, errs);
    }
  }
}

export function validate(schema, value) {
  const errs = [];
  check(schema, schema, value, '', errs);
  return [...new Set(errs)];
}
