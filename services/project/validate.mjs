// SPDX-License-Identifier: GPL-3.0-or-later
// Hand-written runtime validator for project v1 (v1 F1/F2). Node stdlib only, no ajv at runtime.
// Must agree with data/schemas/project.schema.json on structure; tests/project-schema.test.mjs runs both on the
// same cases. On top of structure it checks cross-references and path safety, which JSON Schema cannot.
// validateProject(doc) -> { ok, errors: [{ path, message }] }. Reports every problem it finds; never throws.

export const PROJECT_VERSION = 1;
export const ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
export const REF_RE = /^[a-z][a-z0-9_.-]{0,63}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
const IMPORTER_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const CANVAS_IDS = ['h', 'v'];
const DEVICE_KINDS = ['capture-card', 'camera', 'microphone', 'audio-output'];
const LAYER_TYPES = ['capture', 'browser', 'image', 'media', 'text', 'color', 'duplicate'];
const MONITORING = ['off', 'monitor-only', 'monitor-and-output'];
const PATH_BASES = ['data', 'media', 'overlays', 'profile'];
// D291 layer effects: key -> [min, max] or [min, max, 'int'], 'color' (#RRGGBB), 'file' (pathRef), 'bool', or
// [[allowed values]]. All keys are required. Same ranges as app/host/src/model.cpp and data/schemas/project.schema.json.
const BLEND = ['blendAdd', 'blendSubtract', 'blendMultiply', 'blendScreen', 'blendLighten', 'blendDarken'];
const FX291 = {
  sharpen: { amount: [0, 1] },
  vignette: { amount: [0, 1], size: [0, 1], softness: [0, 1], color: 'color' },
  grain: { amount: [0, 1], size: [1, 10] },
  pixelate: { size: [2, 200] },
  posterize: { levels: [2, 32, 'int'] },
  lut: { file: 'file', amount: [0, 1] },
  mirror: {},
  flip: {},
  circleMask: { feather: [0, 25], borderWidth: [0, 25], borderColor: 'color' },
  roundMask: { radius: [0, 50], feather: [0, 25], borderWidth: [0, 25], borderColor: 'color' },
  opacity: { opacity: [0, 1] },
  ...Object.fromEntries(BLEND.map((b) => [b, { opacity: [0, 1] }])),
  gradientMask: { angle: [-360, 360], start: [0, 1], end: [0, 1] },
  imageMask: { file: 'file', channel: [['luma', 'alpha']], invert: 'bool', feather: [0, 100] },
};

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// A relative path under a named base. No drive letters, no UNC, no leading slash, no "..", no control chars.
export function relPathProblem(rel) {
  if (typeof rel !== 'string' || rel.length < 1 || rel.length > 260) return 'must be a string of 1 to 260 characters';
  if (/[\u0000-\u001f]/.test(rel)) return 'contains a control character';
  if (/^[A-Za-z]:/.test(rel) || rel.startsWith('/') || rel.startsWith('\\')) return 'must be relative, not absolute';
  if (rel.split(/[\\/]/).some((seg) => seg === '..')) return 'must not contain ".."';
  return null;
}

// Corner pin (D259/D260): one projective map draws a convex quad only. p = [x0, y0, ...] in the order top-left,
// top-right, bottom-right, bottom-left; every corner turns the same way by a cross product of at least 1e-6 (the
// host's rule, model.cpp).
export function convexQuad(p) {
  let turn = 0;
  for (let i = 0; i < 4; i++) {
    const a = 2 * i, b = 2 * ((i + 1) % 4), c = 2 * ((i + 2) % 4);
    const cr = (p[b] - p[a]) * (p[c + 1] - p[b + 1]) - (p[b + 1] - p[a + 1]) * (p[c] - p[b]);
    const s = cr > 1e-6 ? 1 : cr < -1e-6 ? -1 : 0;
    if (s === 0 || (turn && s !== turn)) return false;
    turn = s;
  }
  return true;
}

export function validateProject(doc) {
  const errors = [];
  const err = (path, message) => errors.push({ path, message });

  const str = (v, p, min, max) => {
    if (typeof v !== 'string' || v.length < min || v.length > max) { err(p, `must be a string of ${min} to ${max} characters`); return false; }
    return true;
  };
  const idOf = (v, p) => {
    if (typeof v !== 'string' || !ID_RE.test(v)) { err(p, 'must match ' + ID_RE); return false; }
    return true;
  };
  const num = (v, p, min, max, integer = false) => {
    if (!isNum(v) || (integer && !Number.isInteger(v)) || v < min || v > max) {
      err(p, `must be ${integer ? 'an integer' : 'a number'} from ${min} to ${max}`); return false;
    }
    return true;
  };
  const noExtra = (o, allowed, p) => {
    for (const k of Object.keys(o)) if (!allowed.includes(k)) err(`${p}.${k}`, 'unknown property');
  };
  const req = (o, keys, p) => {
    for (const k of keys) if (!(k in o)) err(`${p}.${k}`, 'required');
  };
  const originOk = (o, p) => {
    if (o === undefined) return;
    if (!isObj(o)) { err(p, 'must be an object'); return; }
    noExtra(o, ['importer', 'id'], p); req(o, ['importer', 'id'], p);
    if ('importer' in o && (typeof o.importer !== 'string' || !IMPORTER_RE.test(o.importer))) err(`${p}.importer`, 'invalid importer name');
    if ('id' in o) str(o.id, `${p}.id`, 1, 128);
  };
  const pathRefOk = (o, p) => {
    if (!isObj(o)) { err(p, 'must be an object'); return; }
    noExtra(o, ['base', 'rel'], p); req(o, ['base', 'rel'], p);
    if ('base' in o && !PATH_BASES.includes(o.base)) err(`${p}.base`, `must be one of ${PATH_BASES.join(', ')}`);
    if ('rel' in o) { const m = relPathProblem(o.rel); if (m) err(`${p}.rel`, m); }
  };
  const uniq = (list, p, label, seen) => {
    list.forEach((it, i) => {
      if (isObj(it) && typeof it.id === 'string') {
        if (seen.has(it.id)) err(`${p}[${i}].id`, `duplicate ${label} id "${it.id}"`);
        seen.add(it.id);
      }
    });
  };
  const arr = (v, p, max, min = 0) => {
    if (!Array.isArray(v)) { err(p, 'must be an array'); return false; }
    if (v.length > max) err(p, `at most ${max} items`);
    if (v.length < min) err(p, `at least ${min} item(s)`);
    return true;
  };

  if (!isObj(doc)) return { ok: false, errors: [{ path: '', message: 'project must be an object' }] };
  const TOP = ['version', 'id', 'name', 'activeScene', 'origin', 'canvases', 'devices', 'scenes', 'audio', 'outputs', 'overlays'];
  noExtra(doc, TOP, ''); req(doc, ['version', 'id', 'name', 'canvases', 'devices', 'scenes', 'audio', 'outputs', 'overlays'], '');
  if ('version' in doc && doc.version !== PROJECT_VERSION) err('.version', `must be ${PROJECT_VERSION}`);
  if ('id' in doc) idOf(doc.id, '.id');
  if ('name' in doc) str(doc.name, '.name', 1, 120);
  if ('activeScene' in doc) idOf(doc.activeScene, '.activeScene');
  originOk(doc.origin, '.origin');

  // canvases
  const canvasIds = new Set();
  if ('canvases' in doc && arr(doc.canvases, '.canvases', 2, 1)) {
    doc.canvases.forEach((c, i) => {
      const p = `.canvases[${i}]`;
      if (!isObj(c)) { err(p, 'must be an object'); return; }
      noExtra(c, ['id', 'width', 'height', 'fps', 'transition'], p); req(c, ['id', 'width', 'height', 'fps'], p);
      if ('id' in c) { if (!CANVAS_IDS.includes(c.id)) err(`${p}.id`, 'must be "h" or "v"'); else if (canvasIds.has(c.id)) err(`${p}.id`, `duplicate canvas "${c.id}"`); else canvasIds.add(c.id); }
      if ('width' in c) num(c.width, `${p}.width`, 16, 8192, true);
      if ('height' in c) num(c.height, `${p}.height`, 16, 8192, true);
      if ('fps' in c) num(c.fps, `${p}.fps`, 1, 240, true);
      // Scene transition of this canvas (D239): cut, or a fade of durationMs (Meld sceneTransition / verticalSceneTransition).
      // D242: stinger = a video (file) played over the switch; the scene changes pointMs into it.
      if ('transition' in c) {
        const t = c.transition; const tp = `${p}.transition`;
        if (!isObj(t)) err(tp, 'must be an object');
        else {
          noExtra(t, ['type', 'durationMs', 'file', 'pointMs', 'audio'], tp); req(t, ['type', 'durationMs'], tp);
          if ('type' in t && !['cut', 'fade', 'stinger'].includes(t.type)) err(`${tp}.type`, 'must be "cut", "fade" or "stinger"');
          if ('durationMs' in t) num(t.durationMs, `${tp}.durationMs`, 0, 10000, true);
          if (t.type === 'stinger') { req(t, ['file', 'pointMs'], tp); if ('file' in t) pathRefOk(t.file, `${tp}.file`); }
          else if ('file' in t || 'pointMs' in t || 'audio' in t) err(tp, 'file, pointMs and audio are for a stinger only');
          if ('audio' in t && typeof t.audio !== 'boolean') err(`${tp}.audio`, 'must be true or false'); // D244: the stinger's own sound
          if ('pointMs' in t) num(t.pointMs, `${tp}.pointMs`, 0, 10000, true);
        }
      }
    });
  }

  // devices
  const deviceIds = new Set();
  if ('devices' in doc && arr(doc.devices, '.devices', 64)) {
    uniq(doc.devices, '.devices', 'device', deviceIds);
    doc.devices.forEach((d, i) => {
      const p = `.devices[${i}]`;
      if (!isObj(d)) { err(p, 'must be an object'); return; }
      noExtra(d, ['id', 'kind', 'name', 'match', 'format', 'origin'], p); req(d, ['id', 'kind', 'name', 'match'], p);
      if ('id' in d) idOf(d.id, `${p}.id`);
      if ('kind' in d && !DEVICE_KINDS.includes(d.kind)) err(`${p}.kind`, `must be one of ${DEVICE_KINDS.join(', ')}`);
      if ('name' in d) str(d.name, `${p}.name`, 1, 120);
      if ('match' in d) {
        if (!isObj(d.match)) err(`${p}.match`, 'must be an object');
        else {
          noExtra(d.match, ['deviceId', 'directShowId', 'name'], `${p}.match`);
          if (Object.keys(d.match).length < 1) err(`${p}.match`, 'needs deviceId or name');
          if ('deviceId' in d.match) str(d.match.deviceId, `${p}.match.deviceId`, 1, 512);
          if ('directShowId' in d.match) str(d.match.directShowId, `${p}.match.directShowId`, 1, 512);
          if ('name' in d.match) str(d.match.name, `${p}.match.name`, 1, 256);
        }
      }
      if ('format' in d) {
        if (!isObj(d.format)) err(`${p}.format`, 'must be an object');
        else {
          noExtra(d.format, ['width', 'height', 'fps'], `${p}.format`);
          if ('width' in d.format) num(d.format.width, `${p}.format.width`, 16, 8192, true);
          if ('height' in d.format) num(d.format.height, `${p}.format.height`, 16, 8192, true);
          if ('fps' in d.format) num(d.format.fps, `${p}.format.fps`, 1, 240, true);
        }
      }
      originOk(d.origin, `${p}.origin`);
    });
  }

  // overlays
  const overlayIds = new Set();
  if ('overlays' in doc && arr(doc.overlays, '.overlays', 256)) {
    uniq(doc.overlays, '.overlays', 'overlay', overlayIds);
    doc.overlays.forEach((o, i) => {
      const p = `.overlays[${i}]`;
      if (!isObj(o)) { err(p, 'must be an object'); return; }
      noExtra(o, ['id', 'name', 'file'], p); req(o, ['id', 'name', 'file'], p);
      if ('id' in o) idOf(o.id, `${p}.id`);
      if ('name' in o) str(o.name, `${p}.name`, 1, 120);
      if ('file' in o) pathRefOk(o.file, `${p}.file`);
    });
  }

  // scenes and layers (layer ids are unique across the whole project)
  const sceneIds = new Set();
  const layerIds = new Set();
  const placementOk = (pl, p) => {
    if (!isObj(pl)) { err(p, 'must be an object'); return; }
    noExtra(pl, ['visible', 'x', 'y', 'width', 'height', 'rotation', 'opacity', 'crop'], p);
    req(pl, ['visible', 'x', 'y', 'width', 'height'], p);
    if ('visible' in pl && typeof pl.visible !== 'boolean') err(`${p}.visible`, 'must be a boolean');
    if ('x' in pl) num(pl.x, `${p}.x`, -16384, 16384);
    if ('y' in pl) num(pl.y, `${p}.y`, -16384, 16384);
    if ('width' in pl) num(pl.width, `${p}.width`, 0, 16384);
    if ('height' in pl) num(pl.height, `${p}.height`, 0, 16384);
    if ('rotation' in pl) num(pl.rotation, `${p}.rotation`, -360, 360);
    if ('opacity' in pl) num(pl.opacity, `${p}.opacity`, 0, 1);
    if ('crop' in pl) {
      if (!isObj(pl.crop)) err(`${p}.crop`, 'must be an object');
      else {
        noExtra(pl.crop, ['left', 'top', 'right', 'bottom'], `${p}.crop`);
        for (const k of Object.keys(pl.crop)) if (['left', 'top', 'right', 'bottom'].includes(k)) num(pl.crop[k], `${p}.crop.${k}`, 0, Number.MAX_VALUE);
      }
    }
  };
  // Per-layer visual effects (host filters, applied in list order): blur {strength 1..100}, rounded {radius 0..500},
  // chromaKey {color #RRGGBB, similarity 1..1000, smoothness 1..1000} (D246), shadow {color, opacity 0..1, size 0..200,
  // distance 0..200, angle -360..360} and glow {color, opacity 0..1, size 0..200, spread 0..1} in canvas px (D257).
  const effectsOk = (list, p) => {
    if (!arr(list, p, 6)) return;
    list.forEach((e, i) => {
      const ep = `${p}[${i}]`;
      if (!isObj(e)) { err(ep, 'must be an object'); return; }
      if (e.type === 'blur') {
        noExtra(e, ['type', 'strength'], ep); req(e, ['strength'], ep);
        if ('strength' in e) num(e.strength, `${ep}.strength`, 1, 100);
      } else if (e.type === 'rounded') {
        noExtra(e, ['type', 'radius'], ep); req(e, ['radius'], ep);
        if ('radius' in e) num(e.radius, `${ep}.radius`, 0, 500);
      } else if (e.type === 'chromaKey') {
        noExtra(e, ['type', 'color', 'similarity', 'smoothness'], ep); req(e, ['color', 'similarity', 'smoothness'], ep);
        if ('color' in e && (typeof e.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(e.color))) err(`${ep}.color`, 'must be #RRGGBB');
        for (const k of ['similarity', 'smoothness']) if (k in e) num(e[k], `${ep}.${k}`, 1, 1000, true);
      } else if (e.type === 'shadow' || e.type === 'glow') {
        const keys = e.type === 'shadow' ? ['color', 'opacity', 'size', 'distance', 'angle'] : ['color', 'opacity', 'size', 'spread'];
        noExtra(e, ['type', ...keys], ep); req(e, keys, ep);
        if ('color' in e && (typeof e.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(e.color))) err(`${ep}.color`, 'must be #RRGGBB');
        const range = { opacity: [0, 1], size: [0, 200], distance: [0, 200], angle: [-360, 360], spread: [0, 1] };
        for (const k of keys.slice(1)) if (k in e) num(e[k], `${ep}.${k}`, ...range[k]);
      } else if (e.type === 'color') { // D258: -1..1 (0 = unchanged), hue in degrees
        const keys = ['brightness', 'contrast', 'saturation', 'hue'];
        noExtra(e, ['type', ...keys], ep); req(e, keys, ep);
        for (const k of keys) if (k in e) num(e[k], `${ep}.${k}`, k === 'hue' ? -180 : -1, k === 'hue' ? 180 : 1);
      } else if (e.type === 'blinds') { // D262: hidden share of each slat, stacking angle, slat width % of the larger side, feather px
        const keys = ['completion', 'angle', 'width', 'feather'];
        const range = { completion: [0, 1], angle: [-360, 360], width: [1, 100], feather: [0, 100] };
        noExtra(e, ['type', ...keys], ep); req(e, keys, ep);
        for (const k of keys) if (k in e) num(e[k], `${ep}.${k}`, ...range[k]);
      } else if (e.type === 'cornerPin') { // D259: corners 0..1 of the layer frame, y down
        const keys = ['topLeftX', 'topLeftY', 'topRightX', 'topRightY', 'bottomRightX', 'bottomRightY', 'bottomLeftX', 'bottomLeftY'];
        noExtra(e, ['type', ...keys], ep); req(e, keys, ep);
        for (const k of keys) if (k in e) num(e[k], `${ep}.${k}`, 0, 1);
        if (keys.every((k) => isNum(e[k])) && !convexQuad(keys.map((k) => e[k]))) err(ep, 'corners must form a convex quad');
      } else if (e.type === 'toner') { // D258
        const tones = ['shadows', 'darktones', 'midtones', 'brights', 'highlights'];
        noExtra(e, ['type', ...tones, 'amount'], ep); req(e, [...tones, 'amount'], ep);
        for (const k of tones) if (k in e && (typeof e[k] !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(e[k]))) err(`${ep}.${k}`, 'must be #RRGGBB');
        if ('amount' in e) num(e.amount, `${ep}.amount`, 0, 1);
      } else if (FX291[e.type]) { // D291 filters, camera and compositing (same ranges as app/host/src/model.cpp)
        const spec = FX291[e.type];
        const keys = Object.keys(spec);
        noExtra(e, ['type', ...keys], ep); req(e, keys, ep);
        for (const k of keys) {
          if (!(k in e)) continue;
          const s = spec[k];
          if (s === 'color') { if (typeof e[k] !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(e[k])) err(`${ep}.${k}`, 'must be #RRGGBB'); }
          else if (s === 'file') pathRefOk(e[k], `${ep}.${k}`);
          else if (s === 'bool') { if (typeof e[k] !== 'boolean') err(`${ep}.${k}`, 'must be true or false'); }
          else if (Array.isArray(s[0])) { if (!s[0].includes(e[k])) err(`${ep}.${k}`, `must be one of ${s[0].join(', ')}`); }
          else num(e[k], `${ep}.${k}`, s[0], s[1], s[2] === 'int');
        }
        if (e.type === 'lut' && isObj(e.file) && typeof e.file.rel === 'string' && !/\.(cube|png)$/i.test(e.file.rel)) err(`${ep}.file`, 'lut file must be .cube or .png');
        if (BLEND.includes(e.type) && list.slice(0, i).some((x) => isObj(x) && BLEND.includes(x.type))) err(ep, 'at most one blend effect per layer');
      } else {
        err(`${ep}.type`, `must be one of blur, rounded, chromaKey, shadow, glow, color, toner, cornerPin, blinds, ${Object.keys(FX291).join(', ')}`);
      }
    });
  };
  // Layer index for duplicate checks: id -> { type, target }. Built before layers are walked so a duplicate may
  // point at a layer in a later scene.
  const layerIndex = new Map();
  if (Array.isArray(doc.scenes)) {
    for (const sc of doc.scenes) {
      if (!isObj(sc) || !Array.isArray(sc.layers)) continue;
      for (const l of sc.layers) {
        if (isObj(l) && typeof l.id === 'string' && !layerIndex.has(l.id)) {
          layerIndex.set(l.id, { type: l.type, target: isObj(l.source) && typeof l.source.layer === 'string' ? l.source.layer : null });
        }
      }
    }
  }
  const duplicateProblem = (ownId, targetId) => {
    if (!layerIndex.has(targetId)) return `unknown layer "${targetId}"`;
    const seen = new Set([ownId]);
    let cur = targetId;
    while (cur) {
      if (seen.has(cur)) return `duplicate cycle through "${cur}"`;
      seen.add(cur);
      const t = layerIndex.get(cur);
      if (!t || t.type !== 'duplicate') return null;
      cur = t.target;
    }
    return null;
  };
  const sourceOk = (type, s, p, ownId) => {
    if (!isObj(s)) { err(p, 'must be an object'); return; }
    const spec = {
      capture: [['device'], ['device']],
      browser: [['overlay', 'query', 'url', 'width', 'height'], ['width', 'height']],
      image: [['file'], ['file']],
      media: [['file', 'loop'], ['file']],
      text: [['text', 'font', 'size', 'color'], ['text']],
      color: [['color'], ['color']],
      duplicate: [['layer'], ['layer']],
    }[type];
    if (!spec) return;
    noExtra(s, spec[0], p); req(s, spec[1], p);
    if (type === 'duplicate' && 'layer' in s && idOf(s.layer, `${p}.layer`)) {
      const bad = duplicateProblem(ownId, s.layer);
      if (bad) err(`${p}.layer`, bad);
      else if (layerIndex.get(s.layer).type === 'duplicate') err(`${p}.layer`, `"${s.layer}" is itself a duplicate; a duplicate must point at a real layer`);
    }
    if (type === 'capture' && 'device' in s) {
      if (idOf(s.device, `${p}.device`) && !deviceIds.has(s.device)) err(`${p}.device`, `unknown device "${s.device}"`);
    }
    if (type === 'browser') {
      if ('overlay' in s && idOf(s.overlay, `${p}.overlay`) && !overlayIds.has(s.overlay)) err(`${p}.overlay`, `unknown overlay "${s.overlay}"`);
      if ('url' in s && (typeof s.url !== 'string' || !/^https?:\/\//.test(s.url) || s.url.length > 2048)) err(`${p}.url`, 'must be an http(s) URL');
      if (!('overlay' in s) && !('url' in s)) err(p, 'needs overlay or url');
      if ('query' in s) {
        if (typeof s.query !== 'string' || s.query.length < 1 || s.query.length > 1024 || s.query.startsWith('?') || /[ -]/.test(s.query)) err(`${p}.query`, 'must be a string of at most 1024 characters without a leading "?"');
        if (!('overlay' in s)) err(`${p}.query`, 'only allowed with overlay');
      }
      if ('overlay' in s && 'url' in s) err(p, 'overlay and url are exclusive');
      if ('width' in s) num(s.width, `${p}.width`, 1, 8192, true);
      if ('height' in s) num(s.height, `${p}.height`, 1, 8192, true);
    }
    if ((type === 'image' || type === 'media') && 'file' in s) pathRefOk(s.file, `${p}.file`);
    if (type === 'media' && 'loop' in s && typeof s.loop !== 'boolean') err(`${p}.loop`, 'must be a boolean');
    if (type === 'text') {
      if ('text' in s && (typeof s.text !== 'string' || s.text.length > 2000)) err(`${p}.text`, 'must be a string of at most 2000 characters');
      if ('font' in s && (typeof s.font !== 'string' || s.font.length > 120)) err(`${p}.font`, 'must be a string of at most 120 characters');
      if ('size' in s) num(s.size, `${p}.size`, 1, 2000);
      if ('color' in s && (typeof s.color !== 'string' || !COLOR_RE.test(s.color))) err(`${p}.color`, 'must be #rrggbb or #rrggbbaa');
    }
    if (type === 'color' && 'color' in s && (typeof s.color !== 'string' || !COLOR_RE.test(s.color))) err(`${p}.color`, 'must be #rrggbb or #rrggbbaa');
  };
  if ('scenes' in doc && arr(doc.scenes, '.scenes', 256)) {
    uniq(doc.scenes, '.scenes', 'scene', sceneIds);
    doc.scenes.forEach((sc, i) => {
      const p = `.scenes[${i}]`;
      if (!isObj(sc)) { err(p, 'must be an object'); return; }
      noExtra(sc, ['id', 'name', 'layers', 'origin'], p); req(sc, ['id', 'name', 'layers'], p);
      if ('id' in sc) idOf(sc.id, `${p}.id`);
      if ('name' in sc) str(sc.name, `${p}.name`, 1, 120);
      originOk(sc.origin, `${p}.origin`);
      if ('layers' in sc && arr(sc.layers, `${p}.layers`, 256)) {
        uniq(sc.layers, `${p}.layers`, 'layer', layerIds);
        sc.layers.forEach((l, j) => {
          const lp = `${p}.layers[${j}]`;
          if (!isObj(l)) { err(lp, 'must be an object'); return; }
          noExtra(l, ['id', 'type', 'name', 'visible', 'locked', 'source', 'placements', 'effects', 'origin'], lp);
          req(l, ['id', 'type', 'name', 'source', 'placements'], lp);
          if ('id' in l) idOf(l.id, `${lp}.id`);
          if ('name' in l) str(l.name, `${lp}.name`, 1, 120);
          if ('visible' in l && typeof l.visible !== 'boolean') err(`${lp}.visible`, 'must be a boolean');
          if ('locked' in l && typeof l.locked !== 'boolean') err(`${lp}.locked`, 'must be a boolean');
          originOk(l.origin, `${lp}.origin`);
          if ('effects' in l) effectsOk(l.effects, `${lp}.effects`);
          if ('type' in l) {
            if (!LAYER_TYPES.includes(l.type)) err(`${lp}.type`, `must be one of ${LAYER_TYPES.join(', ')}`);
            else if ('source' in l) sourceOk(l.type, l.source, `${lp}.source`, l.id);
          }
          if ('placements' in l) {
            if (!isObj(l.placements)) err(`${lp}.placements`, 'must be an object');
            else {
              noExtra(l.placements, CANVAS_IDS, `${lp}.placements`);
              if (Object.keys(l.placements).length < 1) err(`${lp}.placements`, 'needs at least one canvas');
              for (const c of Object.keys(l.placements)) {
                if (!CANVAS_IDS.includes(c)) continue;
                if (!canvasIds.has(c)) err(`${lp}.placements.${c}`, `canvas "${c}" is not defined`);
                placementOk(l.placements[c], `${lp}.placements.${c}`);
              }
            }
          }
        });
      }
    });
  }
  if ('activeScene' in doc && typeof doc.activeScene === 'string' && !sceneIds.has(doc.activeScene)) err('.activeScene', `unknown scene "${doc.activeScene}"`);

  // audio
  const trackIds = new Set();
  if ('audio' in doc) {
    const a = doc.audio;
    if (!isObj(a)) err('.audio', 'must be an object');
    else {
      noExtra(a, ['tracks', 'masterVolumeDb', 'sources'], '.audio'); req(a, ['tracks', 'sources'], '.audio');
      if ('masterVolumeDb' in a) num(a.masterVolumeDb, '.audio.masterVolumeDb', -100, 12);
      if ('tracks' in a && arr(a.tracks, '.audio.tracks', 6, 1)) {
        uniq(a.tracks, '.audio.tracks', 'track', trackIds);
        a.tracks.forEach((t, i) => {
          const p = `.audio.tracks[${i}]`;
          if (!isObj(t)) { err(p, 'must be an object'); return; }
          noExtra(t, ['id', 'name'], p); req(t, ['id', 'name'], p);
          if ('id' in t) idOf(t.id, `${p}.id`);
          if ('name' in t) str(t.name, `${p}.name`, 1, 120);
        });
      }
      if ('sources' in a && arr(a.sources, '.audio.sources', 256)) {
        uniq(a.sources, '.audio.sources', 'audio source', new Set());
        a.sources.forEach((s, i) => {
          const p = `.audio.sources[${i}]`;
          if (!isObj(s)) { err(p, 'must be an object'); return; }
          noExtra(s, ['id', 'name', 'device', 'layer', 'volumeDb', 'muted', 'monitoring', 'tracks', 'origin'], p);
          req(s, ['id', 'name', 'volumeDb', 'muted', 'monitoring', 'tracks'], p);
          if ('id' in s) idOf(s.id, `${p}.id`);
          if ('name' in s) str(s.name, `${p}.name`, 1, 120);
          if ('device' in s && idOf(s.device, `${p}.device`) && !deviceIds.has(s.device)) err(`${p}.device`, `unknown device "${s.device}"`);
          if ('layer' in s && idOf(s.layer, `${p}.layer`) && !layerIds.has(s.layer)) err(`${p}.layer`, `unknown layer "${s.layer}"`);
          if ('device' in s && 'layer' in s) err(p, 'device and layer are exclusive');
          if (!('device' in s) && !('layer' in s)) err(p, 'needs device or layer');
          if ('volumeDb' in s) num(s.volumeDb, `${p}.volumeDb`, -100, 12);
          if ('muted' in s && typeof s.muted !== 'boolean') err(`${p}.muted`, 'must be a boolean');
          if ('monitoring' in s && !MONITORING.includes(s.monitoring)) err(`${p}.monitoring`, `must be one of ${MONITORING.join(', ')}`);
          if ('tracks' in s && arr(s.tracks, `${p}.tracks`, 6)) {
            s.tracks.forEach((t, k) => {
              if (idOf(t, `${p}.tracks[${k}]`) && !trackIds.has(t)) err(`${p}.tracks[${k}]`, `unknown track "${t}"`);
            });
          }
          originOk(s.origin, `${p}.origin`);
        });
      }
    }
  }

  // outputs: references only
  if ('outputs' in doc && arr(doc.outputs, '.outputs', 64)) {
    uniq(doc.outputs, '.outputs', 'output', new Set());
    doc.outputs.forEach((o, i) => {
      const p = `.outputs[${i}]`;
      if (!isObj(o)) { err(p, 'must be an object'); return; }
      noExtra(o, ['id', 'type', 'ref', 'canvas'], p); req(o, ['id', 'type', 'ref', 'canvas'], p);
      if ('id' in o) idOf(o.id, `${p}.id`);
      if ('type' in o && !['rung', 'sink'].includes(o.type)) err(`${p}.type`, 'must be "rung" or "sink"');
      if ('ref' in o && (typeof o.ref !== 'string' || !REF_RE.test(o.ref))) err(`${p}.ref`, 'must match ' + REF_RE);
      if ('canvas' in o) { if (!CANVAS_IDS.includes(o.canvas)) err(`${p}.canvas`, 'must be "h" or "v"'); else if (!canvasIds.has(o.canvas)) err(`${p}.canvas`, `canvas "${o.canvas}" is not defined`); }
    });
  }

  return { ok: errors.length === 0, errors };
}
