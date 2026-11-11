// SPDX-License-Identifier: GPL-3.0-or-later
// Scene builder SB1 + SB2 entry point (D339): read a local reference image or video into the typed result of
// data/schemas/reference-read.schema.json (palette, type feel, corner radius, glow, shadow, layout slots).
// Output is data only: nothing here touches a project, a scene or a file. SB3 (build scenes) and SB4 (restyle the
// studio) call readReference() or the CLI (cli.mjs) and decide what to do with the answer.
//
// Rules first. A local vision model can be added later through the typed hook `opts.model`:
//   { id: string, local: true, analyze(input) -> Promise<{ slots?: [slot], type?: { family? } }> }
//   input = { canvas, frames: [{ t, width, height, rgb }], rules: <the rules-only result> }
// The hook is refused unless the adapter says local: true (no paid or remote API, AGENTS.md). Its answer is checked
// against the same slot shape; a model slot replaces the rules slot of the same role (game, camera, chat, alerts)
// only when its confidence is higher, graphics are added, and every merged slot says source 'model'. A model that
// throws, times out or answers out of shape is ignored with a note: the rules result stands.

import { measure } from './analyse.mjs';
import { loadReference } from './frames.mjs';
import { detectSlots, ROLES, RULES_VERSION } from './layout.mjs';
import { paletteOf } from './palette.mjs';
import { styleOf } from './style.mjs';

export const SCHEMA_VERSION = 1;
export const MODEL_TIMEOUT_MS = 120000;
const FAMILIES = new Set(['sans', 'serif', 'mono', 'display', 'script']);
const unit = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

/** Problems with one slot (plain words; [] when it is well formed). */
export function slotProblems(s) {
  const p = [];
  if (!s || typeof s !== 'object') return ['slot must be an object'];
  if (!ROLES.includes(s.role)) p.push(`role must be one of ${ROLES.join(', ')}`);
  const b = s.box;
  if (!b || !['x', 'y', 'w', 'h'].every((k) => unit(b[k])) || b.x + b.w > 1.0001 || b.y + b.h > 1.0001) p.push('box must be { x, y, w, h } fractions inside the frame');
  if (!unit(s.confidence)) p.push('confidence must be 0..1');
  if (s.evidence !== undefined && (!Array.isArray(s.evidence) || s.evidence.some((e) => typeof e !== 'string'))) p.push('evidence must be a list of strings');
  return p;
}

async function withModel(result, frames, model) {
  if (!model) return result;
  if (model.local !== true || typeof model.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(model.id) || typeof model.analyze !== 'function') {
    result.notes.push('model hook refused: it must be a local adapter { id, local: true, analyze }');
    return result;
  }
  let answer;
  try {
    let timer;
    answer = await Promise.race([
      Promise.resolve(model.analyze({ canvas: result.canvas, frames, rules: structuredClone(result) })),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timed out')), MODEL_TIMEOUT_MS); }),
    ]).finally(() => clearTimeout(timer));
  } catch (e) {
    result.notes.push(`model ${model.id} failed (${String(e?.message ?? e).slice(0, 80)}); rules result kept`);
    return result;
  }
  const slots = Array.isArray(answer?.slots) ? answer.slots : [];
  const bad = slots.flatMap(slotProblems);
  const fam = answer?.type?.family;
  if (bad.length || (fam !== undefined && fam !== null && !FAMILIES.has(fam))) {
    result.notes.push(`model ${model.id} answer out of shape (${(bad[0] ?? 'type.family').slice(0, 80)}); rules result kept`);
    return result;
  }
  const clean = (s) => ({ role: s.role, box: { x: s.box.x, y: s.box.y, w: s.box.w, h: s.box.h }, confidence: s.confidence, evidence: (s.evidence ?? []).slice(0, 12).map((e) => e.slice(0, 120)), source: 'model' });
  for (const s of slots) {
    if (s.role === 'graphics') { result.slots.push(clean(s)); continue; }
    const at = result.slots.findIndex((r) => r.role === s.role);
    if (at < 0) result.slots.push(clean(s));
    else if (s.confidence > result.slots[at].confidence) result.slots[at] = clean(s);
  }
  if (fam) result.style.type.family = fam;
  result.detector.model = model.id;
  return result;
}

/** SB1 + SB2: a local reference file -> the typed read (see the header). opts: { frames, longSide, model }. */
export async function readReference(file, { frames = 8, longSide = 960, model = null } = {}) {
  const ref = await loadReference(file, { frames, longSide });
  return readFrames(ref, { model });
}

/** SB2 on frames already loaded (loadReference's answer). */
export async function readFrames(ref, { model = null } = {}) {
  const m = measure(ref.frames);
  const canvas = ref.width >= ref.height ? 'H' : 'V';
  const { slots, gamePx, panels } = detectSlots(m, canvas);
  const result = {
    schemaVersion: SCHEMA_VERSION,
    tool: 'scene-builder/reference-read',
    reference: {
      name: ref.name, kind: ref.kind, width: ref.width, height: ref.height, rotation: ref.rotation ?? 0, durationS: ref.durationS,
      frameTimesS: ref.frames.map((f) => f.t), analysisWidth: m.width, analysisHeight: m.height,
    },
    canvas,
    detector: { rulesVersion: RULES_VERSION, model: null },
    palette: paletteOf(ref.frames),
    style: styleOf(m, panels, gamePx),
    slots,
    notes: [],
  };
  if (!slots.some((s) => s.role === 'game')) result.notes.push('no game area found (no large textured rectangle)');
  return withModel(result, ref.frames, model);
}
