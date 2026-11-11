// SPDX-License-Identifier: GPL-3.0-or-later
// Scene builder SB3 (D341): which of the project's own sources a slot links to. Read only: it never changes the
// project and never creates a device. Every answer says why; anything ambiguous is "missing" with the reason, so
// the slot becomes a placeholder in the diff instead of a guess.
//
//   findSources(project, { bind, rules }) -> { game, camera, chat, alerts }
//     game / camera: { layer, device, name, content: { width, height, crop }, why }   a real capture layer shows it
//                    { layer: null, device, name, content, why }                        only a device exists
//                    { missing: reason }
//     chat / alerts: { overlay: { id, rel }, query, layer, name, why } | { missing: reason }
//   bind (explicit choice, e.g. from the CLI --bind game=<id>): a layer id or a device id per role; it wins over the
//   rules, and an id that is not in the project is "missing", never replaced by a guess.

const DEVICE_ROLE = { game: 'game-capture', camera: 'facecam' }; // origin ids the alpha project gives its devices
const PRESET_KEY = { game: 'game', camera: 'facecam' }; // layer keys of the built-in presets (origin preset/<key>)
const KINDS = { game: ['capture-card', 'camera'], camera: ['camera'] }; // the Meld importer files every video device as 'camera'

const allLayers = (project) => project.scenes.flatMap((s) => s.layers.map((l) => ({ scene: s, layer: l })));

function content(project, layer, device, rules) {
  const f = device?.format;
  const width = f?.width ?? rules.sourceSize.width, height = f?.height ?? rules.sourceSize.height;
  let crop = null;
  if (layer) {
    const pl = layer.placements.h ?? layer.placements.v;
    if (pl?.crop) crop = { left: pl.crop.left ?? 0, top: pl.crop.top ?? 0, right: pl.crop.right ?? 0, bottom: pl.crop.bottom ?? 0 };
  }
  return { width, height, crop, sized: Boolean(f?.width && f?.height) };
}

function captureFor(project, role, bind, rules) {
  const layers = allLayers(project).map((x) => x.layer);
  const captureOf = (devId) => layers.find((l) => l.type === 'capture' && l.source?.device === devId) ?? null;
  const answer = (layer, device, why) => ({ layer: layer?.id ?? null, device: device.id, name: device.name, content: content(project, layer, device, rules), why });
  const want = bind[role];
  if (want !== undefined) {
    const l = layers.find((x) => x.id === want);
    if (l) {
      let real = l;
      const seen = new Set();
      while (real?.type === 'duplicate' && !seen.has(real.id)) { seen.add(real.id); real = layers.find((x) => x.id === real.source?.layer); }
      if (real?.type !== 'capture') return { missing: `--bind ${role}=${want}: that layer does not show a capture device` };
      const dev = project.devices.find((d) => d.id === real.source.device);
      if (!dev) return { missing: `--bind ${role}=${want}: its device is not in the project` };
      return answer(real, dev, `bound by the user (layer ${want})`);
    }
    const dev = project.devices.find((d) => d.id === want);
    if (!dev) return { missing: `--bind ${role}=${want}: no layer or device with that id in the project` };
    if (!KINDS[role].includes(dev.kind)) return { missing: `--bind ${role}=${want}: a ${dev.kind} device cannot be the ${role}` };
    return answer(captureOf(dev.id), dev, `bound by the user (device ${want})`);
  }
  // 1. a built-in preset's layer for this role (origin preset/<preset>/<key>) that shows a real device
  const byKey = layers.filter((l) => l.type === 'capture' && l.origin?.importer === 'preset' && l.origin.id.endsWith(`/${PRESET_KEY[role]}`));
  const keyDevs = [...new Set(byKey.map((l) => l.source.device))];
  if (keyDevs.length === 1) {
    const dev = project.devices.find((d) => d.id === keyDevs[0]);
    if (dev) return answer(byKey[0], dev, `the ${PRESET_KEY[role]} layer of a built-in scene`);
  }
  if (keyDevs.length > 1) return { missing: `${keyDevs.length} different devices sit in ${PRESET_KEY[role]} layers; choose one with --bind ${role}=<id>` };
  // 2. the device the alpha project bound to this role (origin role/<role>)
  const roleDevs = project.devices.filter((d) => d.origin?.id === `role/${DEVICE_ROLE[role]}`);
  if (roleDevs.length === 1) return answer(captureOf(roleDevs[0].id), roleDevs[0], `the device bound to the ${DEVICE_ROLE[role]} role`);
  // 3. the only device of the one kind that can only mean this role (a capture card is the game)
  if (role === 'game') {
    const cards = project.devices.filter((d) => d.kind === 'capture-card');
    if (cards.length === 1) return answer(captureOf(cards[0].id), cards[0], 'the only capture card in the project');
    if (cards.length > 1) return { missing: `${cards.length} capture cards; choose one with --bind game=<id>` };
  }
  const video = project.devices.filter((d) => KINDS[role].includes(d.kind));
  if (!video.length) return { missing: `no ${role === 'game' ? 'capture card or video' : 'camera'} device in the project` };
  return { missing: `${video.length} video device(s) and none is marked as the ${role}; choose one with --bind ${role}=<id>` };
}

function overlayFor(project, role, bind, rules) {
  const layers = allLayers(project).map((x) => x.layer).filter((l) => l.type === 'browser' && typeof l.source?.overlay === 'string');
  const ovOf = (l) => project.overlays.find((o) => o.id === l.source.overlay);
  const answer = (l, why) => {
    const o = ovOf(l);
    return { overlay: { id: o.id, rel: o.file.rel }, query: typeof l.source.query === 'string' ? l.source.query : '', layer: l.id, name: l.name, why };
  };
  const want = bind[role];
  if (want !== undefined) {
    const l = layers.find((x) => x.id === want);
    if (!l || !ovOf(l)) return { missing: `--bind ${role}=${want}: no overlay layer with that id in the project` };
    return answer(l, `bound by the user (layer ${want})`);
  }
  const hits = layers.filter((l) => {
    const o = ovOf(l);
    return o && o.file.base === 'overlays' && rules.overlays[role].some((p) => o.file.rel.startsWith(p));
  });
  if (!hits.length) return { missing: `no ${role} overlay layer (${rules.overlays[role].join(', ')}) in the project` };
  const pages = new Set(hits.map((l) => ovOf(l).id));
  if (pages.size > 1) return { missing: `${pages.size} different ${role} overlays; choose one with --bind ${role}=<layer id>` };
  // several layers of the same page: the settings (query) of the first one in scene order are carried over
  return answer(hits[0], hits.length > 1 ? `the ${role} overlay (settings of the first of ${hits.length} layers)` : `the ${role} overlay`);
}

export function findSources(project, { bind = {}, rules }) {
  return {
    game: captureFor(project, 'game', bind, rules),
    camera: captureFor(project, 'camera', bind, rules),
    chat: overlayFor(project, 'chat', bind, rules),
    alerts: overlayFor(project, 'alerts', bind, rules),
  };
}
