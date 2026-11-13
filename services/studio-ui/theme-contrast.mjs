// SPDX-License-Identifier: GPL-3.0-or-later
// Studio theme contrast check (D336, T1), shared by tests/studio-theme-contrast.test.mjs and the scene builder's
// theme from a reference (SB4, D345), so a generated pack is checked by exactly the rules the shipped packs are.
// For every state a component has (normal, hover, pressed, checked or selected, focus, error), the colours the studio
// paints are paired: text >= 4.5:1 against what it sits on, control parts and focus indicators >= 3:1 against what
// they sit next to. Disabled text is exempt (WCAG 1.4.3), and borders that only decorate a filled control are not
// checked (the fill, the label and the state carry the meaning). The pairs come from the base stylesheet in
// app/studio/src/theme.cpp, the variant fragments (componentQss) for the variants a pack picks, and the painted
// Switch; derived() mirrors theme.cpp's derived(): change both together.

export const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
export const toHex = (c) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
export const lum = (h) => {
  const c = hex(h).map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
export const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
// a + (b - a) * t per channel, rounded (theme.cpp mixc()); Math.round and std::lround agree for these positive values
export const mix = (a, b, t) => { const x = hex(a), y = hex(b); return toHex(x.map((v, i) => Math.round(v + (y[i] - v) * t))); };

// theme.cpp derived()
export function derived(p) {
  const c = p.colors;
  const well = mix(c.field, '#000000', p.dark ? 0.28 : 0.06);
  return {
    tint: mix(c.field, c.accent, 0.18), focusTint: mix(c.field, c.accent, 0.10), well, wellShade: mix(well, '#000000', 0.35),
    accentDim: mix(c.border, c.accent, 0.45), metalHi: mix(c.field, c.text, 0.10), metalLo: mix(c.field, '#000000', 0.25),
    accentTop: mix(c.accent, '#ffffff', 0.12), accentBot: mix(c.accent, '#000000', 0.12), sphereHi: mix(c.accent, '#ffffff', 0.5),
  };
}

// Surfaces a control sits on: the window, panels and cards (both ends of their gradients when the pack has one).
export function surfaces(p) {
  const c = p.colors, g = p.gradients ?? {};
  const s = new Set([c.bg, c.panel]);
  for (const k of ['window', 'panel']) if (g[k]) { s.add(g[k].from); s.add(g[k].to); }
  return [...s];
}
// A fill token as painted: its colour, or both gradient ends (theme.cpp accentFill / controlFill / panelFill).
export const fill = (p, token) => {
  const g = { accent: 'accent', field: 'control', panel: 'panel' }[token];
  const gr = g && p.gradients?.[g];
  return gr ? [p.colors[token], gr.from, gr.to] : [p.colors[token]];
};

// A pair: [state, what, ink, faces, min]. ink and faces are hex colours (faces a list); min 4.5 text, 3 controls.
export const TEXT = 4.5, CTRL = 3;
export function basePairs(p) {
  const c = p.colors, on = surfaces(p);
  return [
    ['normal', 'text on surfaces and fields', c.text, [...on, ...fill(p, 'field'), c.field], TEXT],
    ['normal', 'muted captions, group titles, tab labels', c.muted, [...on, c.field], TEXT],
    ['normal', 'primary button label', c.onAccent, fill(p, 'accent'), TEXT],
    ['normal', 'danger button label (transparent face)', c.danger, on, TEXT],
    ['normal', 'error and warning text', c.danger, [...on, c.field], TEXT],
    ['hover', 'hovered tab label', c.text, [c.field], TEXT],
    ['hover', 'hovered list row', c.text, [c.field], TEXT],
    ['pressed', 'pressed button label', c.text, [c.border], TEXT],
    ['checked', 'checked button, selected tab, list and menu selection', c.onAccent, [c.accent], TEXT],
    ['checked', 'checked danger button', c.onAccent, [c.danger], CTRL], // short bold label or icon (large text rule)
    ['checked', 'check box mark area against its field', c.accent, [c.field], CTRL],
    ['normal', 'slider handle against the window', c.text, on, CTRL],
    ['normal', 'slider value part against the window', c.accent, on, CTRL],
    ['normal', 'progress chunk against its field', c.accent, [c.field], CTRL],
    ['focus', 'button focus border against its face and the window', c.accentHi, [...fill(p, 'field'), ...on], CTRL],
    ['focus', 'field focus border against the field and the window', c.accent, [c.field, ...on], CTRL],
    ['error', 'field error border against the field', c.danger, [c.field], CTRL],
    ['normal', 'danger border against the window', c.danger, on, CTRL],
  ];
}

// The soft variants (D376) paint from the pack's surface block; without it they fail the check (the studio needs it).
const needsSurface = [['normal', 'soft variant without a surface block', '#000000', ['#000000'], TEXT]];
const sf = (p, fn) => (p.surface ? fn(p.surface) : needsSurface);

// The variant fragments (theme.cpp componentQss) and the painted Switch: the pairs each variant adds.
export const VARIANTS = {
  'button.shape': { rounded: () => [], pill: () => [], sharp: () => [] },
  'button.style': {
    solid: (p) => [['normal', 'solid button label', p.colors.text, [p.colors.field], TEXT]],
    soft: (p, x) => [['normal', 'soft button label', p.colors.text, [x.tint], TEXT], ['normal', 'soft primary label', p.colors.onAccent, [p.colors.accent], TEXT]],
    metal: (p, x) => [['normal', 'metal button label', p.colors.text, [x.metalHi, p.colors.field, x.metalLo], TEXT], ['normal', 'metal primary label', p.colors.onAccent, [x.accentTop, x.accentBot], TEXT]],
    bezel: (p) => [['normal', 'bezel primary rim against the window', p.colors.accentHi, surfaces(p), CTRL]],
    neumorph: (p) => [['normal', 'neumorph button label', p.colors.text, [p.colors.bg], TEXT]],
    raised: (p) => sf(p, (s) => [['normal', 'raised button label', p.colors.text, [s.faceTop, s.faceBottom], TEXT], ['hover', 'raised button label', p.colors.text, ['#ffffff', s.faceBottom], TEXT],
      ['pressed', 'pressed raised button label', p.colors.text, [s.wellTop, s.wellBottom], TEXT], ['checked', 'checked (warm) button label', s.glowInk, [s.warmTop, s.warmBottom], TEXT],
      ['normal', 'raised danger button label', p.colors.danger, [s.faceTop, s.faceBottom], TEXT]]),
  },
  'button.secondary': {
    outline: (p, x) => [['normal', 'outline button label', p.colors.accentHi, surfaces(p), TEXT], ['hover', 'outline button label', p.colors.accentHi, [x.tint], TEXT], ['normal', 'outline button edge', p.colors.accent, surfaces(p), CTRL]],
    tinted: (p, x) => [['normal', 'tinted button label', p.colors.accentHi, [x.tint], TEXT]],
    ghost: (p, x) => [['normal', 'ghost button label', p.colors.accentHi, surfaces(p), TEXT], ['hover', 'ghost button label', p.colors.accentHi, [x.tint], TEXT]],
  },
  tabs: {
    pill: () => [],
    underline: (p) => [['normal', 'underline tab label', p.colors.muted, surfaces(p), TEXT], ['hover', 'underline tab label', p.colors.text, surfaces(p), TEXT],
      ['checked', 'selected underline tab label', p.colors.accentHi, surfaces(p), TEXT], ['checked', 'selected tab underline', p.colors.accent, surfaces(p), CTRL]],
    segmented: (p) => [['normal', 'segment label', p.colors.muted, [p.colors.field], TEXT]],
    boxed: (p, x) => [['normal', 'boxed tab label', p.colors.muted, surfaces(p), TEXT], ['checked', 'selected boxed tab label', p.colors.accentHi, [x.tint], TEXT], ['checked', 'selected boxed tab edge', p.colors.accent, surfaces(p), CTRL]],
  },
  input: {
    outline: () => [],
    filled: (p) => [['normal', 'filled field text', p.colors.text, [p.colors.field], TEXT], ['normal', 'filled field underline', p.colors.muted, [p.colors.field], CTRL]],
    inset: (p, x) => [['normal', 'inset field text', p.colors.text, [x.well], TEXT]],
    underline: (p) => [['normal', 'underline field text', p.colors.text, surfaces(p), TEXT], ['normal', 'underline field line', p.colors.muted, surfaces(p), CTRL]],
    soft: (p) => sf(p, (s) => [['normal', 'soft well text', p.colors.text, [s.wellTop, s.wellBottom], TEXT], ['focus', 'soft well focus ring', p.colors.accent, [s.wellTop, s.wellBottom], CTRL]]),
  },
  focus: {
    border: (p) => [['focus', 'focus border', p.colors.accent, [p.colors.field], CTRL]],
    ring: (p) => [['focus', 'focus ring', p.colors.accent, [p.colors.field, ...surfaces(p)], CTRL]],
    glow: (p, x) => [['focus', 'glow focus text', p.colors.text, [x.focusTint], TEXT], ['focus', 'glow focus edge', p.colors.accentHi, [x.focusTint, ...surfaces(p)], CTRL]],
  },
  switch: {
    // painted (switch_widget.cpp paintVariant): ink is onAccent on the "on" track, text on the "off" track
    plain: (p) => [['checked', 'switch knob on', p.colors.onAccent, [p.colors.accent], CTRL], ['normal', 'switch knob off', p.colors.text, [p.colors.border], CTRL],
      ['checked', 'switch track on against the window', p.colors.accent, surfaces(p), CTRL]],
    labelled: (p) => [['checked', 'switch ON label', p.colors.onAccent, [p.colors.accent], TEXT], ['normal', 'switch OFF label', p.colors.text, [p.colors.border], TEXT],
      ['checked', 'switch track on against the window', p.colors.accent, surfaces(p), CTRL]],
    bezel: (p) => [['checked', 'switch ON label', p.colors.onAccent, [p.colors.accent], TEXT], ['normal', 'switch OFF label', p.colors.text, [p.colors.border], TEXT],
      ['checked', 'switch track on against the window', p.colors.accent, surfaces(p), CTRL]],
    // painted (switch_widget.cpp paintKnob): ON in glowInk on the warm track, OFF in muted on the well; the knob moves
    knob: (p) => sf(p, (s) => [['checked', 'switch ON label', s.glowInk, [s.warmTop, s.warmBottom], TEXT], ['normal', 'switch OFF label', p.colors.muted, [s.wellTop, s.wellBottom], TEXT],
      ['checked', 'warm track edge against the window', s.warmEdge, [s.wellTop], 1.4]]),
  },
  'slider.track': {
    thin: (p) => [['normal', 'slider value part', p.colors.accent, surfaces(p), CTRL]],
    thick: (p) => [['normal', 'slider value part', p.colors.accent, surfaces(p), CTRL]],
    inset: (p, x) => [['normal', 'slider value part in the well', p.colors.accent, [x.well, ...surfaces(p)], CTRL]],
  },
  'slider.handle': {
    round: (p) => [['normal', 'slider handle', p.colors.text, surfaces(p), CTRL]],
    bar: (p) => [['normal', 'slider handle', p.colors.text, surfaces(p), CTRL]],
    sphere: (p, x) => [['normal', 'sphere handle', p.colors.accent, surfaces(p), CTRL], ['normal', 'sphere handle light side', x.sphereHi, surfaces(p), CTRL]],
  },
  'slider.valueBubble': { true: (p) => [['pressed', 'value bubble', p.colors.bg, [p.colors.text], TEXT]], false: () => [] },
  'button.caps': { true: () => [], false: () => [] },
  sectionHeader: {
    plain: () => [],
    rule: (p) => [['normal', 'group title', p.colors.text, surfaces(p), TEXT]],
    caps: (p) => [['normal', 'group title and heading', p.colors.text, surfaces(p), TEXT]],
    bracket: (p) => [['normal', 'bracket title', p.colors.accentHi, [p.colors.bg, ...surfaces(p)], TEXT], ['normal', 'bracket heading', p.colors.accentHi, surfaces(p), TEXT]],
  },
  card: {
    flat: (p) => [['normal', 'text on a flat card', p.colors.text, [p.colors.panel], TEXT]],
    raised: () => [],
    neumorph: (p) => [['normal', 'text on a neumorph card', p.colors.text, [p.colors.bg], TEXT]],
    framed: (p) => [['normal', 'text in a framed card', p.colors.text, surfaces(p), TEXT]],
    soft: (p) => sf(p, (s) => [['normal', 'text on a soft plate', p.colors.text, [s.faceTop, s.faceBottom], TEXT], ['normal', 'muted text on a soft plate', p.colors.muted, [s.faceTop, s.faceBottom], TEXT],
      ['checked', 'muted text where a plate glows', p.colors.muted, [s.warmTop, s.warmBottom], TEXT], ['normal', 'error text on a soft plate', p.colors.danger, [s.faceTop, s.faceBottom], TEXT]]),
  },
  list: { plain: () => [], plates: (p) => [['normal', 'list plate text', p.colors.text, [p.colors.field], TEXT]] },
  chip: { pill: () => [], bracket: (p) => [['normal', 'bracket chip text', p.colors.text, surfaces(p), TEXT], ['normal', 'quiet bracket chip text', p.colors.muted, surfaces(p), TEXT]] },
  density: { compact: () => [], normal: () => [], airy: () => [] },
};

// The pack's chosen variants as flat keys ("button.style": "metal", "slider.valueBubble": "true").
export function chosen(p) {
  const out = {};
  for (const [k, v] of Object.entries(p.components ?? {}))
    if (v && typeof v === 'object') for (const [k2, v2] of Object.entries(v)) out[`${k}.${k2}`] = String(v2);
    else out[k] = String(v);
  return out;
}

/** Every pair the pack paints (base look plus the variants it picks): [state, what, ink, faces, min]. */
export function pairs(p) {
  const x = derived(p);
  const all = [...basePairs(p)];
  for (const [k, v] of Object.entries(chosen(p))) all.push(...VARIANTS[k][v](p, x));
  return all;
}

/** Each failing ink / face combination in plain words ([] when the pack passes). */
export function failures(p) {
  const bad = [];
  for (const [state, what, ink, faces, min] of pairs(p))
    for (const face of faces) {
      const r = contrast(ink, face);
      if (r < min) bad.push(`${p.id} ${state}: ${what} ${ink} on ${face} = ${r.toFixed(2)} (needs ${min})`);
    }
  return bad;
}
