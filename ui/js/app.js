// SPDX-License-Identifier: GPL-3.0-or-later
// Studio UI skeleton: scenes, layers, preview buttons, mixer placeholder, stream/record buttons, status bar.
// Plain script, safe DOM only (Dom.el / textContent). Every host call goes through the same-origin UI server.
(function () {
  'use strict';
  var el = Dom.el, clear = Dom.clear, setText = Dom.setText;
  var $ = function (id) { return document.getElementById(id); };

  var state = { canvas: 'h', scenes: [], activeScene: null, layers: [], selected: null, mixer: [], status: null, pending: null };

  // The host wraps lists ({scenes:[...]}, {layers:[...]}, {sources:[...]}); accept a bare array too.
  function unwrap(r, key) { return Array.isArray(r) ? r : ((r && Array.isArray(r[key])) ? r[key] : []); }
  function sceneCanvases(s) {
    var c = Array.isArray(s.canvases) ? s.canvases : (s.canvas ? [s.canvas] : []);
    return c.map(function (x) { return String(x).toLowerCase(); });
  }
  function activeSceneObj() { return state.scenes.filter(function (s) { return s.id === state.activeScene; })[0] || null; }
  // The host needs a canvas for layer calls when the scene is on both H and V.
  function layerArgs(extra) {
    var o = { scene: state.activeScene }, s = activeSceneObj();
    if (s && sceneCanvases(s).length > 1) o.canvas = state.canvas;
    Object.keys(extra || {}).forEach(function (k) { o[k] = extra[k]; });
    return o;
  }
  function renderTabs() {
    var s = activeSceneObj(), both = !!s && sceneCanvases(s).length > 1;
    $('canvas-tabs').hidden = !both;
    $('tab-h').className = 'btn btn-quiet' + (state.canvas === 'h' ? ' on' : '');
    $('tab-v').className = 'btn btn-quiet' + (state.canvas === 'v' ? ' on' : '');
  }
  function fmt(v, suffix) { return (typeof v === 'number' && isFinite(v)) ? (Math.round(v * 10) / 10) + (suffix || '') : '-'; }
  function showError(msg) { setText($('preview-note'), msg); }
  function guard(p) { return p.catch(function (e) { showError('Error: ' + (e && (e.detail || e.message) ? (e.detail || e.message) : 'failed')); }); } // detail: plain words when the server gives them ("Ujwalam is closing")

  // ---- undo / redo of layer edits (P5b, D238; the server keeps the history, refused while live) ----
  function renderEdits(st) {
    if (!st) return;
    var u = $('btn-undo'), r = $('btn-redo');
    u.disabled = !st.undo; r.disabled = !st.redo;
    u.title = st.nextUndo ? 'Undo: ' + st.nextUndo + ' (Ctrl+Z)' : 'Undo (Ctrl+Z)';
    r.title = st.nextRedo ? 'Redo: ' + st.nextRedo + ' (Ctrl+Y)' : 'Redo (Ctrl+Y)';
  }
  var EDIT_ERRORS = { 'live-locked': 'Undo is off while live.', 'nothing-to-undo': 'Nothing to undo.', 'nothing-to-redo': 'Nothing to redo.', 'edit-gone': 'That layer changed or is gone; the undo list was cleared.', 'host-unavailable': 'The studio host is not reachable.' };
  function undoRedo(undo) {
    (undo ? Api.undo() : Api.redo()).then(function (res) { renderEdits(res.edits); return loadLayers(); })
      .catch(function (e) { showError(EDIT_ERRORS[e && e.message] || ('Error: ' + (e && e.message ? e.message : 'failed'))); Api.edits().then(renderEdits).catch(function () {}); });
  }

  // ---- scene and layer structure edits (D240, flag scene-edit; saved into the project file, refused while live) ----
  var STRUCT_ERRORS = { 'live-locked': 'Not while live.', 'host-unavailable': 'The studio host is not reachable.', 'scene-active': 'That scene is the project start scene; pick another first.', 'last-scene': 'The last scene cannot be removed.', 'layer-copied': 'Another layer is a copy of it; remove the copy first.', 'layer-has-audio': 'Its audio is in the mixer; it cannot be removed here.', 'bad-name': 'Type a scene name.', 'bad-color': 'Colour must look like #RRGGBB.', 'bad-text': 'Type the text.', 'no-project-file': 'No project file is open.', 'scene-edit-off': 'Turn on the scene-edit flag first.', 'unknown-asset': 'That file is no longer in the stream assets folder.', 'at-edge': 'It is already at the edge on this canvas.' };
  var choices = null;
  function renderStructure(on) {
    $('scene-edit').hidden = !on; $('layer-edit').hidden = !on;
    if (on) loadChoices(); else choices = null;
  }
  function loadChoices() {
    return Api.structure().then(function (c) {
      choices = c && c.available ? c : null;
      if (!choices) { $('scene-edit').hidden = true; $('layer-edit').hidden = true; return; }
      var sp = $('scene-pick'); clear(sp);
      choices.scenes.forEach(function (x) { sp.appendChild(el('option', { value: x.id, text: x.name })); });
      renderPick();
    }).catch(function () { /* the form stays as it was */ });
  }
  function renderPick() {
    var kind = $('layer-kind').value, sel = $('layer-pick'), v = $('layer-value'); clear(sel);
    var items = !choices ? [] : kind === 'copy' ? choices.layers.map(function (l) { return { id: l.id, name: l.name + ' (' + l.sceneName + ')' }; })
      : kind === 'capture' ? choices.devices.map(function (d) { return { id: d.id, name: d.name + (d.connected === false ? ' (not connected)' : '') }; }) : kind === 'overlay' ? choices.overlays
      : (kind === 'image' || kind === 'media') ? (choices.assets || []).filter(function (a) { return a.kind === kind; }).map(function (a) { return { id: a.rel, name: a.rel }; }) : [];
    items.forEach(function (x) { sel.appendChild(el('option', { value: x.id, text: x.name })); });
    sel.hidden = !(kind === 'copy' || kind === 'capture' || kind === 'overlay' || kind === 'image' || kind === 'media');
    v.hidden = !(kind === 'color' || kind === 'text');
    v.placeholder = kind === 'color' ? '#RRGGBB' : 'Text';
  }
  function structureEdit(body) {
    setText($('struct-note'), '');
    return Api.structureEdit(body).then(function (r) {
      setText($('struct-note'), (r.waiting ? 'Layer added. ' + r.waiting + ' ' : '') + (r.saved ? 'Done and saved.' : 'Done, but the project file was not saved: it is live-only until the next save.'));
      return Promise.all([loadScenes(), loadChoices()]).then(function () { return true; });
    }).catch(function (e) { setText($('struct-note'), STRUCT_ERRORS[e && e.message] || ('Not done: ' + ((e && (e.detail || e.message)) || 'failed'))); return false; });
  }
  function addLayerClick() {
    var kind = $('layer-kind').value, body = { op: 'layer.add', scene: state.activeScene, kind: kind };
    if (!state.activeScene) { setText($('struct-note'), 'Pick a scene first.'); return; }
    if (kind === 'copy') body.of = $('layer-pick').value;
    else if (kind === 'capture') body.device = $('layer-pick').value;
    else if (kind === 'overlay') body.overlay = $('layer-pick').value;
    else if (kind === 'image' || kind === 'media') body.file = $('layer-pick').value;
    else if (kind === 'color') body.color = $('layer-value').value.trim();
    else body.text = $('layer-value').value;
    structureEdit(body);
  }
  // D330: removing a layer needs no flag (the server refuses it while live). D332: the click acts, no "are you sure".
  function removeLayerClick() {
    var l = selectedLayer();
    if (!l) { setText($('struct-note'), 'Select a layer first (click its name).'); return; }
    if (state.status && state.status.host && state.status.host.live) { setText($('struct-note'), STRUCT_ERRORS['live-locked']); return; }
    structureEdit({ op: 'layer.remove', scene: state.activeScene, layer: l.id }).then(function (ok) { if (ok) { state.selected = null; renderInspector(); } });
  }
  function removeSceneClick() {
    var sp = $('scene-pick'), opt = sp.options[sp.selectedIndex];
    if (!opt) return;
    structureEdit({ op: 'scene.remove', scene: opt.value });
  }

  // ---- transition per canvas (D242, flag transitions): saved into the project; the server applies it to the host ----
  var trChoices = null;
  var TR_ERRORS = { 'live-locked': 'Not while live.', 'unknown-asset': 'That video is no longer in the stream assets folder.', 'transitions-off': 'Turn on the transitions flag first.', 'no-project-file': 'No project file is open.' };
  function renderTransitionCard(on) {
    $('transition-edit').hidden = !on;
    if (!on) { trChoices = null; return; }
    Api.transitions().then(function (c) {
      trChoices = c && c.available ? c : null;
      if (!trChoices) { $('transition-edit').hidden = true; return; }
      var f = $('tr-file'); clear(f);
      trChoices.videos.forEach(function (v) { f.appendChild(el('option', { value: v, text: v })); });
      showTransition();
    }).catch(function () { /* stays as it was */ });
  }
  function showTransition() {
    if (!trChoices) return;
    var cv = $('tr-canvas').value, c = trChoices.canvases.filter(function (x) { return x.id === cv; })[0];
    var t = (c && c.transition) || { type: 'cut', durationMs: 0 };
    $('tr-type').value = t.type;
    $('tr-ms').value = String(t.durationMs || 0);
    $('tr-point').value = String(t.pointMs || 0);
    $('tr-audio').checked = t.audio !== false;
    if (t.file && t.file.rel) $('tr-file').value = t.file.rel;
    trFields();
  }
  function trFields() {
    var ty = $('tr-type').value;
    $('tr-ms').hidden = ty !== 'fade'; $('tr-file').hidden = ty !== 'stinger'; $('tr-point').hidden = ty !== 'stinger'; $('tr-audio-wrap').hidden = ty !== 'stinger';
  }
  function saveTransition() {
    var ty = $('tr-type').value, body = { canvas: $('tr-canvas').value, type: ty };
    if (ty === 'fade') body.durationMs = Math.round(Number($('tr-ms').value));
    if (ty === 'stinger') { body.file = $('tr-file').value; body.pointMs = Math.round(Number($('tr-point').value)); body.audio = $('tr-audio').checked; }
    Api.setTransition(body).then(function () { setText($('tr-note'), 'Saved; scene switches use it within a second.'); renderTransitionCard(true); })
      .catch(function (e) { setText($('tr-note'), TR_ERRORS[e && e.message] || ('Not saved: ' + ((e && (e.detail || e.message)) || 'failed'))); });
  }

  // ---- scenes and layers ----
  function renderScenes() {
    var ul = $('scene-list'); clear(ul);
    state.scenes.forEach(function (s) {
      var li = el('li', { class: 'row' + (s.id === state.activeScene ? ' active' : '') + (s.active ? ' live-scene' : ''), tabindex: 0, role: 'button', 'aria-pressed': s.id === state.activeScene ? 'true' : 'false' }, [el('span', { class: 'name', text: s.name }), el('span', { class: 'muted', text: sceneCanvases(s).join('/').toUpperCase() })]);
      var go = function () { state.activeScene = s.id; guard(Api.host('scenes.activate', { scene: s.id }).then(loadScenes)); };
      li.addEventListener('click', go);
      li.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
      ul.appendChild(li);
    });
  }
  // Host order is bottom first; the list shows the top layer first. up = toward the top = higher host index.
  function renderLayers() {
    var ul = $('layer-list'); clear(ul);
    var n = state.layers.length;
    for (var d = 0; d < n; d++) {
      (function (l, hi) {
        var vis = el('button', { class: 'icon-btn', type: 'button', text: l.visible ? 'Hide' : 'Show', 'aria-label': (l.visible ? 'Hide ' : 'Show ') + l.name, onclick: function () { guard(Api.host('layers.setVisible', layerArgs({ layer: l.id, visible: !l.visible })).then(loadLayers)); } });
        var up = el('button', { class: 'icon-btn', type: 'button', text: 'Up', 'aria-label': 'Move ' + l.name + ' up', disabled: hi === n - 1, onclick: function () { move(l, hi, hi + 1); } });
        var dn = el('button', { class: 'icon-btn', type: 'button', text: 'Dn', 'aria-label': 'Move ' + l.name + ' down', disabled: hi === 0, onclick: function () { move(l, hi, hi - 1); } });
        // A capture layer whose device is not connected (D329): "waiting for device", the host's sentence as the title.
        // "connecting": bound, no picture yet (the host retries by itself).
        var waiting = l.device && l.device.state === 'waiting', connecting = l.device && l.device.state === 'connecting';
        var name = el('span', { class: 'name', text: l.name + (waiting ? ' (waiting for device)' : connecting ? ' (connecting to device)' : ''), tabindex: '0', role: 'button', title: waiting ? (l.device.message || 'Waiting for its device.') : connecting ? (l.device.message || 'Connecting to its device.') : 'Edit in the inspector', 'aria-label': 'Edit ' + l.name + ' in the inspector' });
        var pick = function () { state.selected = l.id; renderLayers(); renderInspector(); };
        name.addEventListener('click', pick);
        name.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
        ul.appendChild(el('li', { class: 'row' + (l.visible ? '' : ' hidden-layer') + (state.selected === l.id ? ' selected' : '') }, [name, up, dn, vis]));
      })(state.layers[n - 1 - d], n - 1 - d);
    }
  }

  // ---- inspector (P5a, 2026-11-06): position, size, rotation and crop of the selected layer (host layers.setPlacement).
  // Only changed fields are sent. Layers without a project placement (host test format) are read-only here.
  var INSP_NUM = ['x', 'y', 'width', 'height', 'rotation'];
  var INSP_CROP = ['left', 'top', 'right', 'bottom'];
  function selectedLayer() { return state.layers.filter(function (l) { return l.id === state.selected; })[0] || null; }
  function renderInspector() {
    var l = selectedLayer(), p = l && l.placement;
    $('insp-empty').hidden = !!p;
    $('insp-form').hidden = !p;
    if (l && !p) setText($('insp-empty'), l.name + ' has no editable placement.');
    else if (!l) setText($('insp-empty'), 'Select a layer to edit its position, size and crop.');
    if (!p) return;
    setText($('insp-name'), l.name);
    setText($('insp-canvas'), (l.canvas || state.canvas).toUpperCase() + ' canvas' + (typeof l.width === 'number' && l.width ? ', source ' + l.width + 'x' + l.height : ''));
    INSP_NUM.forEach(function (k) { $('insp-' + k).value = typeof p[k] === 'number' ? String(Math.round(p[k] * 10) / 10) : (k === 'rotation' ? '0' : ''); });
    var c = p.crop || {};
    INSP_CROP.forEach(function (k) { $('insp-crop-' + k).value = String(typeof c[k] === 'number' ? c[k] : 0); });
    setText($('insp-note'), '');
  }
  function inspectorPatch() {
    var l = selectedLayer(), p = (l && l.placement) || {}, c = p.crop || {}, patch = {}, crop = {}, bad = null;
    INSP_NUM.forEach(function (k) {
      var v = Number($('insp-' + k).value), old = typeof p[k] === 'number' ? p[k] : 0;
      if (!isFinite(v) || $('insp-' + k).value === '' || !$('insp-' + k).checkValidity()) { bad = k; return; }
      if (Math.abs(v - old) > 1e-6) patch[k] = v;
    });
    INSP_CROP.forEach(function (k) {
      var v = Number($('insp-crop-' + k).value), old = typeof c[k] === 'number' ? c[k] : 0;
      if (!isFinite(v) || !$('insp-crop-' + k).checkValidity()) { bad = 'crop ' + k; return; }
      if (Math.abs(v - old) > 1e-6) crop[k] = v;
    });
    if (Object.keys(crop).length) patch.crop = crop;
    return { patch: patch, bad: bad };
  }
  function applyInspector(ev) {
    ev.preventDefault();
    var l = selectedLayer(); if (!l) return;
    var r = inspectorPatch();
    if (r.bad) { setText($('insp-note'), 'Check the value of ' + r.bad + '.'); return; }
    if (!Object.keys(r.patch).length) { setText($('insp-note'), 'Nothing changed.'); return; }
    guard(Api.host('layers.setPlacement', layerArgs({ layer: l.id, placement: r.patch })).then(function (res) {
      return loadLayers().then(function () { renderInspector(); setText($('insp-note'), 'Applied.'); });
    }));
  }
  // ---- arrow-key nudges (P5, D254, flag preview-edit): the selected layer moves 1 canvas px per press, 10 with Shift.
  // Presses made while a move is on its way add up and go as one layers.setPlacement (one undo step). Off while live:
  // undo is off while live (D238), so a held key could not be taken back; the inspector is the way to move a layer then.
  var NUDGE_KEYS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  var nudge = { dx: 0, dy: 0, busy: false };
  function nudgeStep(key, shift) { var d = NUDGE_KEYS[key]; if (!d) return null; var n = shift ? 10 : 1; return [d[0] * n, d[1] * n]; }
  function nudgeKey(e) {
    var t = e.target && e.target.tagName;
    if (!state.previewEdit || e.ctrlKey || e.metaKey || e.altKey || t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') return;
    if (!$('confirm').hidden) return;
    var step = nudgeStep(e.key, e.shiftKey), l = selectedLayer();
    if (!step || !l || !l.placement) return;
    e.preventDefault();
    if (state.status && state.status.host && state.status.host.live) { setText($('insp-note'), 'Live: arrow keys are off. Use the inspector.'); return; }
    nudge.dx += step[0]; nudge.dy += step[1];
    sendNudge();
  }
  function sendNudge() {
    if (nudge.busy || (!nudge.dx && !nudge.dy)) return;
    var l = selectedLayer(); if (!l || !l.placement) { nudge.dx = nudge.dy = 0; return; }
    var patch = {};
    if (nudge.dx) patch.x = Math.round(((l.placement.x || 0) + nudge.dx) * 100) / 100;
    if (nudge.dy) patch.y = Math.round(((l.placement.y || 0) + nudge.dy) * 100) / 100;
    nudge.dx = nudge.dy = 0; nudge.busy = true;
    Api.host('layers.setPlacement', layerArgs({ layer: l.id, placement: patch }))
      .then(function (res) {
        return loadLayers();
      })
      .catch(function (e) { showError('Error: ' + (e && e.message ? e.message : 'failed')); })
      .then(function () { nudge.busy = false; sendNudge(); });
  }
  // A move changes the project order (shared by H and V, saved) and the host follows it on every canvas (D243; no flag
  // since D330). While live, with no project file, or for a layer outside the project, it is the host's live-only move.
  function move(l, from, to) {
    Api.structureEdit({ op: 'layer.move', scene: state.activeScene, layer: l.id, canvas: state.canvas, direction: to > from ? 'up' : 'down' })
      .then(function () { setText($('struct-note'), 'Order saved.'); return loadLayers(); })
      .catch(function (e) {
        var code = e && e.message;
        if (code === 'live-locked' || code === 'unknown-layer' || code === 'not-on-canvas' || code === 'unknown-scene' || code === 'no-project-file') { hostMove(l, to); return; }
        setText($('struct-note'), STRUCT_ERRORS[code] || ('Not moved: ' + ((e && (e.detail || e.message)) || 'failed')));
      });
  }
  function hostMove(l, to) {
    guard(Api.host('layers.move', layerArgs({ layer: l.id, index: to })).then(function () { return loadLayers(); }));
  }
  function loadScenes() {
    return Api.host('scenes.list').then(function (r) {
      // The host lists a scene once per canvas it is on; show one row per scene id.
      var byId = {}, order = [];
      unwrap(r.result, 'scenes').forEach(function (x) {
        var e = byId[x.id];
        if (!e) { e = byId[x.id] = { id: x.id, name: x.name, canvases: [], active: false }; order.push(e); }
        sceneCanvases(x).forEach(function (c) { if (e.canvases.indexOf(c) < 0) e.canvases.push(c); });
        if (x.active) e.active = true;
      });
      state.scenes = order;
      var known = state.scenes.some(function (s) { return s.id === state.activeScene; });
      if (!known) {
        var a = state.scenes.filter(function (s) { return s.active; })[0];
        state.activeScene = a ? a.id : (state.scenes[0] && state.scenes[0].id) || null;
      }
      renderScenes(); renderTabs();
      return loadLayers();
    });
  }
  function loadLayers() {
    if (!state.activeScene) { state.layers = []; renderLayers(); return Promise.resolve(); }
    return Api.host('layers.list', layerArgs()).then(function (r) { state.layers = unwrap(r.result, 'layers'); renderLayers(); renderInspector(); });
  }

  // ---- mixer (volume/mute wired to the host API; meters polled from the host's mixer.list peakDb) ----
  var meterEls = {}; // mixer id -> meter bar element, so a meter poll updates widths without rebuilding the controls
  var meterBusy = false;
  function meterWidth(peakDb) { return Math.max(0, Math.min(100, (typeof peakDb === 'number' ? (peakDb + 60) / 60 * 100 : 0))) + '%'; }
  // Live meters (2026-11-06: the meter was read once at page load, so it never moved while speaking).
  // One request in flight at a time; skipped while the tab is hidden or there is no mixer to show.
  function pollMeters() {
    if (meterBusy || document.hidden || !state.mixer.length) return;
    meterBusy = true;
    Api.host('mixer.list').then(function (r) {
      unwrap(r.result, 'sources').forEach(function (m) { var bar = meterEls[m.id]; if (bar) bar.style.width = meterWidth(m.peakDb); });
    }, function () { /* a missed meter frame is harmless; the next poll retries */ }).then(function () { meterBusy = false; });
  }
  function renderMixer() {
    var box = $('mixer'); clear(box);
    meterEls = {};
    // Only what the stream hears (2026-11-06: a looping video layer showed up as a moving "Wordmark" row). A source
    // in no track (mixers 0) is not in the mix; it is named in a note below instead of a channel strip.
    var offMix = state.mixer.filter(function (m) { return m.mixers === 0; });
    state.mixer.filter(function (m) { return m.mixers !== 0; }).forEach(function (m) {
      var db = el('span', { class: 'db', text: fmt(m.volumeDb, ' dB') });
      var slider = el('input', { type: 'range', min: -60, max: 0, step: 1, value: Math.max(-60, Math.min(0, typeof m.volumeDb === 'number' ? m.volumeDb : 0)), 'aria-label': m.name + ' volume' });
      slider.addEventListener('input', function () { setText(db, slider.value + ' dB'); });
      slider.addEventListener('change', function () { guard(Api.host('mixer.setVolume', { id: m.id, db: Number(slider.value) })); });
      var mute = el('button', { class: 'icon-btn', type: 'button', text: m.muted ? 'Unmute' : 'Mute', onclick: function () { guard(Api.host('mixer.setMute', { id: m.id, muted: !m.muted }).then(loadMixer)); } });
      // CUE: hear this channel in the headphones (Meld's per-channel button), applied at once.
      var cue = el('button', { class: 'icon-btn cue' + (m.cue ? ' on' : ''), type: 'button', text: 'CUE', 'aria-pressed': m.cue ? 'true' : 'false', title: m.cueDelayed ? 'This channel has video: libobs delays its headphone sound to match the picture' : 'Hear this channel in the headphones', onclick: function () { guard(Api.host('mixer.setCue', { id: m.id, cue: !m.cue }).then(loadMixer)); } });
      var level = el('i'); level.style.width = meterWidth(m.peakDb); meterEls[m.id] = level;
      box.appendChild(el('div', { class: 'chan' }, [el('span', { text: m.name }), cue, mute, el('div', { class: 'meter' }, [level]), slider, db]));
    });
    if (offMix.length) box.appendChild(el('p', { class: 'muted mixer-note', text: 'Not in the stream mix (layer sound off): ' + offMix.map(function (m) { return m.name; }).join(', ') + '.' }));
    box.appendChild(el('p', { class: 'muted mixer-note', text: 'Meters show the host peak level.' }));
  }
  function loadMixer() { return Api.host('mixer.list').then(function (r) { state.mixer = unwrap(r.result, 'sources'); renderMixer(); }); }

  // ---- status ----
  function pill(node, text, cls) { setText(node, text); node.className = 'pill' + (cls ? ' ' + cls : ''); }
  function applyStatus(s) {
    state.status = s;
    var h = s.host || {}, c = s.core || {};
    pill($('st-live'), h.live ? 'LIVE' : 'Offline', h.live ? 'on' : '');
    pill($('st-rec'), h.recording ? 'Recording' : 'Not recording', h.recording ? 'on' : '');
    setText($('st-drop'), (typeof h.droppedFrames === 'number' && typeof h.totalFrames === 'number' && h.totalFrames > 0) ? h.droppedFrames + ' / ' + h.totalFrames : (typeof h.droppedFrames === 'number' ? h.droppedFrames : '-'));
    setText($('st-fps'), fmt(h.fps));
    setText($('st-cpu'), fmt(h.cpuPct, '%'));
    setText($('st-gpu'), fmt(h.gpuPct, '%'));
    // Audio readiness (D297 proposed): a device sound that delivers nothing ("Game audio missing"), before going live.
    var ah = h.audioHealth;
    var ap = $('st-audio');
    if (ap) {
      ap.hidden = !ah;
      if (ah) {
        pill(ap, ah.ok ? 'Audio: OK' : ah.warnings.join(', '), ah.ok ? 'ok' : 'warn');
        ap.title = (ah.sources || []).map(function (x) { return x.name + ': ' + (x.receiving === true ? 'receiving' : x.state) + (x.recreates ? ' (restarted ' + x.recreates + 'x)' : ''); }).join('; ');
      }
    }
    pill($('st-core'), c.available ? 'Event core: up' : 'Event core: down', c.available ? 'ok' : 'warn');
    pill($('st-host'), h.blockedOnHost ? 'BLOCKED-ON-HOST (fake)' : (h.available ? 'Host: up' : 'Host: down'), h.blockedOnHost ? 'blocked' : (h.available ? 'ok' : 'warn'));
    // Stream recovery after a host crash (D303 proposed, flag stream-recovery): the newest event of this session.
    var rv = s.recovery, rp = $('st-recovery');
    if (rp) {
      rp.hidden = !(rv && rv.text);
      if (rv && rv.text) { pill(rp, rv.text, rv.result === 'restarted' ? 'ok' : 'warn'); rp.title = rv.count > 1 ? rv.count + ' host crash(es) while live this session' : ''; }
    }
    renderUpdates(s.updates);
    // Clip maker missing (the Alpha zip ships no Python): plain words on the pill, the reason and the fix on hover.
    // Shown only when the launcher says clips cannot be made; nothing else changes.
    var cl = s.clips, cp = $('st-clips');
    if (cp) {
      var noClips = !!(cl && cl.available === false);
      cp.hidden = !noClips;
      if (noClips) {
        pill(cp, cl.missing === 'python' ? 'Clips: Python not found' : 'Clips: not set up', 'warn');
        cp.title = 'Clips can\'t be made on this PC yet: ' + (cl.reason || 'the clip maker is not set up') + '.' + (cl.fix ? ' ' + cl.fix : '');
      }
    }
    // Live test kit (D305 proposed, flag live-test-kit): the Streamer.bot test-action reminder and the feedback result.
    // Sound and recovery lines already have their own pills above.
    var tk = $('st-testkit');
    if (tk) {
      var kitLines = (Array.isArray(s.alerts) ? s.alerts : []).filter(function (a) { return a && (a.id === 'test-action' || a.id === 'feedback'); });
      tk.hidden = kitLines.length === 0;
      if (kitLines.length) pill(tk, kitLines.map(function (a) { return a.text; }).join(' | '), kitLines.some(function (a) { return a.level !== 'info'; }) ? 'warn' : 'ok');
    }
    var banner = $('banner');
    banner.hidden = !h.blockedOnHost;
    // A layer moved or resized with the mouse on a host preview (D230): select it and reload the list and inspector.
    var pe = h.previewEdit;
    if (pe && typeof pe.seq === 'number' && pe.seq !== state.previewSeq) {
      var first = state.previewSeq === undefined;
      state.previewSeq = pe.seq;
      if (!first && pe.scene === state.activeScene && pe.canvas === state.canvas) { state.selected = pe.layer; loadLayers().catch(function () {}); }
    }
    // A device was plugged in or out (D329): reload the layer list (waiting / connected) and the add-layer picker.
    var dv = h.devices;
    if (dv && typeof dv.seq === 'number' && dv.seq !== state.devicesSeq) {
      var firstDv = state.devicesSeq === undefined;
      state.devicesSeq = dv.seq;
      if (!firstDv) { loadLayers().catch(function () {}); if (choices) loadChoices(); }
    }
    // When the backend flips between the fake and the real host, the scene ids change: reload the lists.
    if (state.wasBlocked !== undefined && state.wasBlocked !== !!h.blockedOnHost) { state.activeScene = null; loadScenes().then(loadMixer).catch(function () {}); }
    state.wasBlocked = !!h.blockedOnHost;
    if (h.blockedOnHost) setText(banner, 'BLOCKED-ON-HOST: the libobs host is not connected. Everything on this page comes from a fake in-memory backend.');
    var ready = h.outputsReady || {};
    var sb = $('btn-stream'), rb = $('btn-record');
    sb.disabled = !ready.stream; rb.disabled = !ready.record;
    setText(sb, h.live ? 'Stop stream' : 'Start stream');
    $('btn-end-all').hidden = !h.live; // D299: stops every stream sink, the recording keeps running
    var rl = $('btn-layer-remove'); // D330: no flag, but never while live (the server refuses too)
    rl.disabled = !!h.live; rl.title = h.live ? 'Not while live' : 'Remove the selected layer';
    setText(rb, h.recording ? 'Stop recording' : 'Record');
    sb.title = ready.stream ? '' : 'Disabled until the stream output exists';
    rb.title = ready.record ? '' : 'Disabled until the record output exists';
  }

  // ---- results and the one-click approval (D332: no typed phrase; the server keeps the ids and hashes) ----
  // ---- Ready to go live? (D299, flag readiness): one row per check; reads only ----
  var READY_PILL = { pass: ['ok', 'ok'], warn: ['warn', 'warn'], fail: ['blocked', 'fail'] };
  function renderReady(ul, r) {
    clear(ul);
    ((r && r.items) || []).forEach(function (i) {
      var p = READY_PILL[i.status] || ['', i.status];
      ul.appendChild(el('li', { class: 'row' }, [el('span', { class: 'pill ' + p[0], text: p[1] }),
        el('span', { class: 'ready-text' }, [el('b', { text: i.title }), el('span', { text: i.message + (i.fix ? ' Fix: ' + i.fix : '') })])]));
    });
  }
  function readyLine(r) { return r.counts.pass + ' ok, ' + r.counts.warn + ' warning(s), ' + r.counts.fail + ' problem(s)' + (r.ok ? '. Nothing blocks going live.' : '. Fix the problems, or click Go live anyway (logged).'); }
  function loadReady() {
    setText($('ready-summary'), 'Checking...');
    $('btn-ready').disabled = true;
    return Api.readiness().then(function (r) { renderReady($('ready-list'), r); setText($('ready-summary'), readyLine(r)); })
      .catch(function (e) { setText($('ready-summary'), 'The check did not run: ' + (e && e.message ? e.message : 'error')); })
      .then(function () { $('btn-ready').disabled = false; });
  }
  function endAllText(x) {
    if (!x) return 'Done.';
    var left = (x.sinks || []).filter(function (s) { return s.state !== 'stopped' && s.state !== 'idle'; });
    return (x.allStopped ? 'All streams ended.' : 'Still closing: ' + left.map(function (s) { return s.id + ' (' + s.state + ')'; }).join(', ') + '.') + (x.recording ? ' The recording keeps running.' : '') + (x.recordingStopped ? ' The recording started with the stream stopped too.' : '');
  }

  // The pending window: a go-live whose readiness check failed (problems + "Go live anyway"), or an event-core write from
  // a rule that needs the user's approval ("Allow"). One click; Cancel drops it.
  function openConfirm(p) {
    state.pending = p;
    var cr = $('confirm-ready');
    if (p.readiness) {
      // Go-live readiness: the summary's first paragraph is the action, the list is the check.
      setText($('confirm-title'), 'Not live yet: the check found problems');
      setText($('confirm-summary'), String(p.summary).split('\n\n')[0] + '. ' + readyLine(p.readiness));
      renderReady(cr, p.readiness); cr.hidden = false;
      if (!$('readiness').hidden) { renderReady($('ready-list'), p.readiness); setText($('ready-summary'), readyLine(p.readiness)); }
      setText($('confirm-ok'), 'Go live anyway');
    } else { clear(cr); cr.hidden = true; setText($('confirm-title'), 'Approve this action'); setText($('confirm-summary'), p.summary); setText($('confirm-ok'), 'Allow'); }
    setText($('confirm-msg'), '');
    $('confirm').hidden = false;
    $('confirm-ok').focus();
  }
  function closeConfirm() { $('confirm').hidden = true; state.pending = null; }
  function submitConfirm() {
    var p = state.pending; if (!p) return;
    Api.confirm(p.pendingId).then(function (r) { closeConfirm(); showResult(r); })
      .catch(function (e) { closeConfirm(); showError('Not done: ' + (e.detail || e.message || 'error')); });
  }
  // What a write answered: done, a pending window (readiness problems / approval), or why it did not run.
  function showResult(r) {
    if (!r) return;
    if ((r.verdict === 'confirm' || r.verdict === 'readiness-failed') && r.pending) { openConfirm(r.pending); return; }
    if (r.verdict === 'allow' && r.endAll) setText($('preview-note'), endAllText(r.endAll));
      else if (r.verdict === 'allow' && r.override) setText($('preview-note'), 'Going live with the readiness override' + (r.overrideLogged ? ' (logged).' : ' (the log could not be written).'));
    else if (r.verdict === 'allow') { if (r.flags) renderFlags(r.flags); if (r.bots) renderBots(r.bots); setText($('preview-note'), r.warning ? 'Done. ' + r.warning : 'Done.'); if (r.forced) setText($('bot-note'), 'The bot did not close when asked and was force-closed; unsaved bot changes may be lost.'); loadScenes().then(loadMixer).catch(function () {}); } else if (r.verdict) setText($('preview-note'), 'Result: ' + r.verdict + (r.reason ? ' (' + r.reason + ')' : ''));
  }
  function cancelConfirm() { var p = state.pending; closeConfirm(); if (p) Api.cancel(p.pendingId).catch(function () {}); }

  function hostAction(method) {
    guard(Api.host(method).then(showResult));
  }

  // ---- Import Meld session: import (new project file) -> plan (dry run) -> Load click -> project.load ----
  var importState = { plan: null };
  function listCounts(obj) {
    var ul = $('import-counts'); clear(ul);
    Object.keys(obj || {}).forEach(function (k) { if (typeof obj[k] === 'number' || typeof obj[k] === 'boolean') ul.appendChild(el('li', { text: k + ': ' + obj[k] })); });
  }
  function runImport() {
    $('import').hidden = false; $('import-load').disabled = true; $('import-skip-row').hidden = true; clear($('import-counts'));
    setText($('import-text'), 'Importing and checking against the host...');
    Api.importMeld().then(function (r) {
      var imp = r.imported || {}, plan = r.plan;
      importState.plan = plan;
      var bits = ['Created a new project file (' + (imp.file || '') + ').'];
      if (imp.skipped) bits.push(imp.skipped + ' item(s) skipped by the importer.');
      if (r.planError) bits.push('Host check failed (' + r.planError + ').');
      setText($('import-text'), bits.join(' '));
      var all = {}; Object.keys(imp.counts || {}).forEach(function (k) { all['imported ' + k] = imp.counts[k]; });
      Object.keys(imp.skippedByKind || {}).forEach(function (k) { all['skipped ' + k] = imp.skippedByKind[k]; });
      Object.keys(plan || {}).forEach(function (k) { all['plan ' + k] = plan[k]; });
      listCounts(all);
      var unavailable = plan && typeof plan.unavailable === 'number' ? plan.unavailable : 0;
      $('import-skip-row').hidden = unavailable === 0;
      $('import-load').disabled = !plan;
    }).catch(function (e) {
      setText($('import-text'), e.status === 503 ? 'No Meld session file is configured (set UJWALAM_MELD_SESSION or paths.meld_session in the local profile).' : 'Import failed: ' + (e.message || 'error'));
    });
  }
  function loadImported() {
    var skip = !$('import-skip-row').hidden && $('import-skip').checked;
    guard(Api.projectLoad(skip).then(function (r) { $('import').hidden = true; showResult(r); }));
  }

  // ---- versions and waiting updates (LU5/LU7, D343): one click applies a waiting service update (D332) ----
  function renderUpdates(u) {
    var parts = $('upd-parts'), list = $('upd-list'), note = $('upd-note'), pillEl = $('st-updates');
    if (!parts || !list) return;
    clear(parts); clear(list);
    var waiting = (u && Array.isArray(u.waiting)) ? u.waiting : [];
    ((u && Array.isArray(u.parts)) ? u.parts : []).forEach(function (p) {
      parts.appendChild(el('li', { class: 'row' }, [el('span', { class: 'name', text: p.label || p.part }), el('span', { class: 'muted', text: (p.version || '-') + (p.follows ? ' (follows the host)' : '') })]));
    });
    waiting.forEach(function (w) {
      var kids = [el('span', { text: w.text || (w.part + ' ' + w.version) })];
      if (w.click) {
        kids.push(el('button', { class: 'btn', type: 'button', text: 'Apply now', 'aria-label': 'Apply the ' + w.part + ' update now', onclick: function () {
          setText(note, 'Updating ' + w.part + '...');
          guard(Api.updateApply(w.id).then(function (r) {
            setText(note, r && r.result === 'swapped' ? 'Updated.' : r && r.result === 'started' ? (r.reason || 'Updating...') : 'Not applied: ' + ((r && (r.reason || r.result)) || 'unknown'));
            if (r && r.updates) renderUpdates(r.updates);
          }, function (e) { setText(note, 'Not applied: ' + ((e && (e.detail || e.message)) || 'error')); }));
        } }));
      } else kids.push(el('span', { class: 'muted', text: 'Waiting for stop' }));
      list.appendChild(el('li', { class: 'row upd-row' }, kids));
    });
    if (pillEl) {
      pillEl.hidden = waiting.length === 0;
      if (waiting.length) { pill(pillEl, 'Updates waiting: ' + waiting.length, 'warn'); pillEl.title = waiting.map(function (w) { return w.text; }).join(' | '); }
    }
    if (!u) setText(note, 'Versions are shown when the studio is started by Ujwalam.');
    else if (!waiting.length) setText(note, u.recent && u.recent.length ? u.recent[0].text : (u.accepting ? 'No update waiting.' : 'Live updates are off (feature flag service-swap).'));
  }

  // ---- feature flags: ON and OFF apply on the click (D332) ----
  function renderFlags(list) {
    var ul = $('flag-list'); clear(ul);
    var postingOn = (list || []).some(function (f) { return f.id === 'posting' && f.on; });
    $('btn-posts').hidden = !postingOn;
    if (!postingOn) $('posts').hidden = true;
    var botsOn = (list || []).some(function (f) { return f.id === 'bot-manager' && f.on; });
    $('bots').hidden = !botsOn;
    if (botsOn) loadBots(); else clear($('bot-list'));
    renderStructure((list || []).some(function (f) { return f.id === 'scene-edit' && f.on; }));
    state.previewEdit = (list || []).some(function (f) { return f.id === 'preview-edit' && f.on; }); // arrow-key nudges (D254)
    renderTransitionCard((list || []).some(function (f) { return f.id === 'transitions' && f.on; }));
    var reportOn = (list || []).some(function (f) { return f.id === 'report-button' && f.on; });
    $('report').hidden = !reportOn;
    var readyOn = (list || []).some(function (f) { return f.id === 'readiness' && f.on; }); // D299
    $('readiness').hidden = !readyOn;
    if (!readyOn) { clear($('ready-list')); setText($('ready-summary'), ''); }
    (list || []).forEach(function (f) {
      var cb = el('input', { type: 'checkbox', id: 'flag-' + f.id, 'aria-label': f.id });
      cb.checked = !!f.on;
      cb.addEventListener('change', function () {
        var want = cb.checked;
        cb.checked = !want; // the box follows the server, not the click
        guard(Api.setFlag(f.id, want).then(function (r) {
          if (r.flags) renderFlags(r.flags);
        }));
      });
      ul.appendChild(el('li', { class: 'row flag-row', title: f.description }, [el('span', { class: 'name', text: f.id }), el('label', null, [cb])]));
    });
    if (!list || !list.length) setText($('flag-note'), 'No feature flags defined.');
    else setText($('flag-note'), 'A flag switches on or off when you tick it.');
  }
  function loadFlags() { return Api.flags().then(function (r) { renderFlags(r.flags); }); }

  // ---- Bots card (BM2, flag `bot-manager`): Streamer.bot and Speaker.bot; Start and Stop act on the click (D332) ----
  function yesNo(v) { return v ? 'yes' : 'no'; }
  function renderBots(rows) {
    var ul = $('bot-list'); clear(ul);
    (rows || []).forEach(function (b) {
      var facts = [el('div', { class: 'muted', text: 'installed: ' + yesNo(b.installed) + '  running: ' + yesNo(b.running) + '  port ' + (b.port || '-') + ' answering: ' + yesNo(b.portAnswering) + '  started by Ujwalam: ' + yesNo(b.startedByUs) })];
      if (b.error) facts.push(el('div', { class: 'warn-text', text: 'Check failed: ' + b.error }));
      if (b.wsError) facts.push(el('div', { class: 'warn-text', text: 'Port setting refused: ' + b.wsError }));
      var start = el('button', { class: 'btn btn-quiet', type: 'button', id: 'bot-start-' + b.bot, text: 'Start' });
      var stop = el('button', { class: 'btn btn-quiet', type: 'button', id: 'bot-stop-' + b.bot, text: 'Stop' });
      start.disabled = !b.installed || b.running || !!b.error;
      stop.disabled = !b.startedByUs; // a copy the user started is never stopped from here
      start.addEventListener('click', function () { guard(Api.botStart(b.bot).then(showResult)); });
      stop.addEventListener('click', function () { guard(Api.botStop(b.bot).then(showResult)); });
      ul.appendChild(el('li', { class: 'row' }, [el('span', { class: 'name', text: b.label || b.bot }), el('span', { class: 'muted', text: b.ok ? 'up' : (b.running ? 'running, port not answering' : (b.installed ? 'stopped' : 'not installed')) }), start, stop, facts[0]].concat(facts.slice(1))));
    });
    setText($('bot-note'), 'Stop only ends a bot that Ujwalam started; if it does not close in time it is force-closed, so save your bot changes first.');
  }
  function loadBots() { return Api.bots().then(function (r) { renderBots(r.bots); }).catch(function (e) { setText($('bot-note'), 'Bots: ' + (e.message || 'error')); }); }

  // ---- Report button (flag `report-button`, D199) ----
  // The server builds a prefilled GitHub new-issue link; the click opens it in the user's browser (a user-requested tab,
  // not a window the app opens on its own). A real link is also shown, in case the browser blocks the pop-up.
  function reportClick() {
    var out = $('report-note-out'); clear(out);
    setText(out, 'Building the report...');
    guard(Api.reportUrl($('report-title').value, $('report-note').value).then(function (r) {
      clear(out);
      if (!r.configured) { setText(out, r.message || 'Report: set links.issues_url in the profile'); return; }
      var u = null; try { u = new URL(String(r.url)); } catch (x) { u = null; }
      if (!u || u.protocol !== 'https:' || u.hostname !== 'github.com') { setText(out, 'Report: the link was refused'); return; }
      window.open(r.url, '_blank', 'noopener');
      out.appendChild(document.createTextNode((r.truncated ? 'Shortened to fit: attach the diag bundle. ' : '') + 'Review it in your browser, then submit. If no tab opened: '));
      out.appendChild(el('a', { href: r.url, target: '_blank', rel: 'noopener', text: 'open the issue page' }));
    }));
  }

  // ---- post-stream feedback form ----
  var fb = { moments: [], sel: null };
  function fmtStats(s) {
    return Object.keys(s || {}).map(function (k) { return k + '=' + s[k]; }).join(' ');
  }
  function renderFeedback() {
    var ul = $('fb-list'); clear(ul);
    fb.moments.forEach(function (m) {
      var tagText = m.note && m.note.tag ? m.note.tag + '/' + (m.note.severity || '-') : 'no note';
      var li = el('li', { class: 'row' + (m.id === fb.sel ? ' active' : ''), tabindex: 0, role: 'button', 'aria-pressed': m.id === fb.sel ? 'true' : 'false' }, [el('span', { class: 'name', text: m.id + (m.scene ? '  ' + m.scene : '') }), el('span', { class: 'muted', text: tagText })]);
      var pick = function () { fb.sel = m.id; renderFeedback(); fillForm(m); };
      li.addEventListener('click', pick);
      li.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
      ul.appendChild(li);
    });
    setText($('feedback-text'), fb.moments.length ? fb.moments.length + ' moment(s). Pick one to add a note.' : 'No feedback moments yet. Press the feedback hotkey while streaming.');
    $('fb-form').hidden = !fb.sel;
  }
  function fillForm(m) {
    setText($('fb-meta'), (m.timestamp !== null ? m.timestamp + '  ' : '') + (m.scene || '') + '  ' + fmtStats(m.stats));
    $('fb-note').value = (m.note && m.note.text) || '';
    $('fb-tag').value = (m.note && m.note.tag) || 'bug';
    $('fb-sev').value = (m.note && m.note.severity) || 'medium';
    $('fb-form').hidden = false;
  }
  function openFeedback() {
    $('feedback').hidden = false; fb.sel = null; $('fb-form').hidden = true;
    guard(Api.feedback().then(function (r) { fb.moments = r.moments || []; renderFeedback(); }));
  }
  function saveFeedback(e) {
    e.preventDefault();
    if (!fb.sel) return;
    Api.saveNote(fb.sel, $('fb-note').value, $('fb-tag').value, $('fb-sev').value).then(function (r) {
      fb.moments = r.moments || fb.moments; renderFeedback();
      setText($('feedback-text'), 'Saved.');
    }).catch(function (x) { setText($('feedback-text'), 'Save failed: ' + (x.message || 'error')); });
  }

  // ---- Posts view (P16a, flag `posting`): review packages; nothing is uploaded ----
  var ps = { posts: [], sel: null, queue: null };
  var QSTATE = { queued: 'waiting', uploading: 'uploading', done: 'uploaded', failed: 'failed' };
  function whenText(iso) { var t = Date.parse(iso || ''); return isNaN(t) ? '' : new Date(t).toLocaleString(); }
  function renderQueue() {
    var q = ps.queue;
    if (!q) { setText($('posts-queue'), ''); return; }
    var bits = ['Upload queue: ' + (q.queued || 0) + ' waiting, ' + (q.uploading || 0) + ' uploading, ' + (q.done || 0) + ' done, ' + (q.failed || 0) + ' failed'];
    if (q.nextAt) bits.push('next retry ' + whenText(q.nextAt));
    if (q.nextPublishAt) bits.push('next goes public ' + whenText(q.nextPublishAt) + (q.lastPublishAt && q.lastPublishAt !== q.nextPublishAt ? ', last scheduled ' + whenText(q.lastPublishAt) : ''));
    setText($('posts-queue'), bits.join('; ') + '.' + (q.message ? ' ' + q.message + '.' : ''));
  }
  function renderPostQueue(p) {
    var box = $('post-queue'); box.hidden = !p || !p.queueState;
    if (box.hidden) return;
    var bits = [QSTATE[p.queueState] || p.queueState];
    if (p.queueReasonText) bits.push(p.queueReasonText);
    if (p.queueState === 'queued' && p.queueNextAt) bits.push('next try ' + whenText(p.queueNextAt));
    if (p.queueAttempts) bits.push(p.queueAttempts + ' failed attempt(s)');
    if (p.queuePublishAt) bits.push((p.queueState === 'done' ? 'goes public ' : 'will go public ') + whenText(p.queuePublishAt));
    setText($('post-queue-info'), 'Auto-upload: ' + bits.join('. ') + '.');
    var l = $('post-queue-link'); clear(l);
    if (p.videoUrl) l.appendChild(el('a', { href: p.videoUrl, target: '_blank', rel: 'noopener noreferrer', text: 'Open the uploaded video (private)' }));
    var rb = $('post-queue-retry');
    rb.hidden = !(p.queueState === 'failed' || (p.queueState === 'queued' && p.queueReasonText));
  }
  function queueRetry() {
    var p = selPost(); if (!p) return;
    setText($('posts-text'), 'Queueing the upload again...');
    Api.postQueueRetry(p.id).then(function () { setText($('posts-text'), 'Queued again. It uploads at the next check if no stream is live.'); return Api.posts(); })
      .then(function (r) { ps.posts = r.posts || []; ps.queue = r.queue || null; ps.queue = r.queue || null; renderPosts(); var q = selPost(); if (q) fillPost(q); })
      .catch(function (x) { setText($('posts-text'), 'Not done: ' + (x.message === 'stream-live' ? 'a stream is live; try again after it ends.' : (x.message || 'error'))); });
  }
  function csv(s) { return String(s).split(',').map(function (x) { return x.trim(); }).filter(Boolean); }
  function selPost() { return ps.posts.filter(function (p) { return p.id === ps.sel; })[0] || null; }
  function replacePost(p) {
    ps.posts = ps.posts.map(function (x) { return x.id === p.id ? p : x; });
    renderPosts(); fillPost(p);
  }
  function renderPosts() {
    var ul = $('post-list'); clear(ul);
    ps.posts.forEach(function (p) {
      var flagged = (p.limits && p.limits.ok === false) || (p.unresolved && p.unresolved.length);
      var li = el('li', { class: 'row' + (p.id === ps.sel ? ' active' : ''), tabindex: 0, role: 'button', 'aria-pressed': p.id === ps.sel ? 'true' : 'false' }, [
        el('span', { class: 'name', text: p.clipId + '  ' + p.target }),
        el('span', { class: flagged || p.queueState === 'failed' ? 'warn-text' : 'muted', text: (p.kind && p.kind !== 'short' ? p.kind + ' / ' : '') + p.status + (flagged ? ' / check' : '') + (p.queueState ? ' / ' + (QSTATE[p.queueState] || p.queueState) : '') })]);
      var pick = function () { ps.sel = p.id; renderPosts(); fillPost(p); };
      li.addEventListener('click', pick);
      li.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
      ul.appendChild(li);
    });
    setText($('posts-text'), ps.posts.length ? ps.posts.length + ' package(s). Private drafts only; approving marks a package. Upload to YouTube is a separate button.' : 'No packages yet. Run: node services/posting/cli.mjs package --run <clip run folder>');
    $('post-form').hidden = !ps.sel;
    renderQueue();
  }
  function fillPost(p) {
    setText($('post-meta'), p.target + '  ' + p.layout + '  ' + p.startSec + '-' + p.endSec + ' s  privacy ' + p.privacy + '  status ' + p.status);
    var m = $('post-media'); clear(m);
    m.appendChild(el('video', { controls: true, preload: 'metadata', src: Api.postMediaUrl(p.id, 'video') }));
    if (p.hasCover) m.appendChild(el('img', { alt: 'Cover', src: Api.postMediaUrl(p.id, 'cover') }));
    $('post-title').value = p.title; $('post-desc').value = p.description;
    $('post-tags').value = p.tags.join(', '); $('post-hash').value = p.hashtags.join(', ');
    var lim = p.limits || { checks: [] }, bits = [];
    lim.checks.forEach(function (c) { bits.push(c.field + ' ' + c.value + '/' + c.max + (c.unit ? ' ' + c.unit : '') + (c.ok ? '' : ' OVER')); });
    if (p.unresolved && p.unresolved.length) bits.push('unresolved: ' + p.unresolved.join(', '));
    setText($('post-limits'), (bits.join('  ') || 'no limits checked') + (lim.status === 'unverified' ? '  (limits UNVERIFIED)' : ''));
    $('post-form').hidden = false;
    renderPostQueue(p);
    renderYt(p);
  }
  // YouTube private upload. Sign-in is CLI-only; the browser never sees a token.
  var yt = { signedIn: false, busy: false };
  function renderYt(p) {
    var box = $('post-yt'); box.hidden = !p || (p.target || '').indexOf('youtube') !== 0;
    if (box.hidden) return;
    var uploaded = p.status === 'uploaded';
    var info = uploaded ? 'Uploaded as private video ' + (p.videoId || '?') + '. Use Check status to see if YouTube finished processing.'
      : (yt.signedIn ? (p.status === 'approved' ? 'Approved. Ready to upload as private.' : 'Approve the package first.') : 'Not signed in. Run in a terminal: node services/posting/cli.mjs youtube signin');
    setText($('post-yt-info'), info);
    $('post-yt-upload').disabled = yt.busy || uploaded || !yt.signedIn || p.status !== 'approved';
    $('post-yt-check').disabled = yt.busy || !uploaded;
  }
  function ytMsg(x) {
    var m = { 'stream-active': 'A stream is live, or live state could not be confirmed. Upload refused.', 'not-approved': 'Approve the package first.', 'already-uploaded': 'Already uploaded.', 'upload-in-progress': 'Another upload is running.', 'youtube-not-signed-in': 'Not signed in. Run the signin command in a terminal.', 'youtube-no-client': 'No OAuth client set yet.', 'status-not-permitted': 'YouTube would not show the status with this sign-in. Check it in YouTube Studio.' };
    return m[x.message] || x.message || 'error';
  }
  function ytAction(kind) {
    var p = selPost(); if (!p || yt.busy) return;
    yt.busy = true; renderYt(p);
    var call = kind === 'upload' ? Api.ytUpload(p.id) : Api.ytCheck(p.id);
    setText($('posts-text'), kind === 'upload' ? 'Uploading... this can take a while. Keep this window open.' : 'Checking...');
    call.then(function (r) {
      if (kind === 'upload') { setText($('posts-text'), 'Uploaded as private video ' + r.videoId + (r.uploadStatus ? ' (' + r.uploadStatus + ')' : '') + '.'); }
      else setText($('posts-text'), 'Video ' + r.videoId + ': ' + (r.found ? 'upload ' + (r.uploadStatus || '?') + ', processing ' + (r.processingStatus || '?') + ', privacy ' + (r.privacyStatus || '?') + (r.failureReason ? ', failure ' + r.failureReason : '') : 'not found yet') + '.');
    }).catch(function (x) { setText($('posts-text'), 'Not done: ' + ytMsg(x)); })
      .then(function () { yt.busy = false; return Api.posts().then(function (r) { ps.posts = r.posts || []; ps.queue = r.queue || null; renderPosts(); var q = selPost(); if (q) fillPost(q); }); })
      .catch(function () { yt.busy = false; });
  }
  // Auto-post mode (F7, flag auto-post): read-only display of the mode and a dry-run list of what a run would do.
  function loadAuto() {
    var ul = $('posts-auto-plan'); clear(ul);
    Api.postsAuto().then(function (r) {
      var m = r.mode || {};
      setText($('posts-auto'), 'Auto-post: ' + (m.enabled ? 'ON' : 'off (review-first)') + ', ' + (m.ruleCount || 0) + ' rule(s), ' + (m.autoUpload ? 'approve and upload (private)' : 'approve only') + '. Runs only when you start it after a stream; switch it with the auto-post flag.');
      (r.plan || []).forEach(function (x) { ul.appendChild(el('li', { class: 'row' }, [el('span', { class: 'name', text: 'would ' + x.action + ' ' + x.id }), el('span', { class: 'muted', text: x.ruleId + ': ' + x.reason })])); });
    }).catch(function () { setText($('posts-auto'), ''); });
  }
  // Rules preview (read-only dry run): what the rules would queue, with the rendered text, and what is skipped and why.
  function loadPreview() {
    var ul = $('posts-preview'); clear(ul); setText($('posts-preview-sum'), 'Checking...');
    Api.postsAutoPreview().then(function (r) {
      if (r.error) { setText($('posts-preview-sum'), 'Preview unavailable.'); return; }
      var sch = r.schedule && r.schedule.on ? (r.schedule.error === 'schedule-read-incomplete' ? ' Scheduled posting is on, but the channel has more uploads than are checked (raise maxPages in data/posting/schedule.json): nothing would upload.' : r.schedule.error ? ' Scheduled posting is on, but its settings file is not valid: nothing would upload.' : ' Scheduled posting is on (every ' + r.schedule.intervalHours + ' h); the public times are estimates, set for real when a clip is queued.' + (r.schedule.retries ? ' ' + r.schedule.retries + ' queued clip(s) came within ' + r.schedule.minLeadHours + ' h of their time: they get a new time about ' + r.schedule.minLeadHours + ' h from now, and ' + r.schedule.rechained + ' queued clip(s) move to ' + r.schedule.intervalHours + ' h apart after it.' : '')) : '';
      setText($('posts-preview-sum'), 'Dry run: ' + r.queued.length + ' would be queued, ' + r.skipped.length + ' skipped. Nothing is written or sent.' + (r.blocked ? ' A stream looks live (' + r.blocked + '): a run would be refused.' : '') + sch);
      r.queued.forEach(function (q) { ul.appendChild(el('li', { class: 'row' }, [el('span', { class: 'name', text: 'would ' + q.actions.join(' + ') + ': ' + q.kind + ' to ' + q.target + ' | ' + q.title }), el('span', { class: 'muted', text: 'rule ' + q.ruleId + (q.score !== null ? ', score ' + q.score : '') + (q.publishAt ? ', goes public about ' + whenText(q.publishAt) : q.publishNote === 'beyond-cap' ? ', waits: its public time would be more than ' + r.schedule.maxAheadDays + ' days ahead' : '') })])); });
      r.skipped.forEach(function (s) { ul.appendChild(el('li', { class: 'row' }, [el('span', { class: 'name', text: 'skip ' + (s.kind || '?') + ' ' + (s.target || '-') + (s.title ? ' | ' + s.title : '') }), el('span', { class: 'muted', text: s.reason + (s.detail ? ' (' + s.detail + ')' : '') })])); });
    }).catch(function () { setText($('posts-preview-sum'), 'Preview unavailable.'); });
  }
  function openPosts() {
    $('posts').hidden = false; ps.sel = null; $('post-form').hidden = true;
    guard(Api.posts().then(function (r) { ps.posts = r.posts || []; ps.queue = r.queue || null; renderPosts(); }));
    loadAuto();
    Api.ytStatus().then(function (r) { yt.signedIn = r.signedIn === true; var p = selPost(); if (p) renderYt(p); }).catch(function () { yt.signedIn = false; });
  }
  function postAction(call) {
    var p = selPost(); if (!p) return;
    call(p).then(function (r) { replacePost(r.post); setText($('posts-text'), 'Saved.'); })
      .catch(function (x) { setText($('posts-text'), 'Not done: ' + (x.message || 'error')); });
  }
  function wireInspector() {
    $('insp-form').addEventListener('submit', applyInspector);
    $('insp-reset').addEventListener('click', renderInspector);
  }
  function wirePosts() {
    wireInspector();
    $('btn-posts').addEventListener('click', openPosts);
    $('posts-preview-btn').addEventListener('click', loadPreview);
    $('btn-report').addEventListener('click', reportClick);
    $('posts-close').addEventListener('click', function () { $('posts').hidden = true; clear($('post-media')); });
    $('post-form').addEventListener('submit', function (e) {
      e.preventDefault();
      postAction(function (p) { return Api.postEdit(p.id, { title: $('post-title').value, description: $('post-desc').value, tags: csv($('post-tags').value), hashtags: csv($('post-hash').value) }); });
    });
    $('post-approve').addEventListener('click', function () { postAction(function (p) { return Api.postStatus(p.id, 'approved'); }); });
    $('post-reject').addEventListener('click', function () { postAction(function (p) { return Api.postStatus(p.id, 'rejected'); }); });
    $('post-yt-upload').addEventListener('click', function () { ytAction('upload'); });
    $('post-yt-check').addEventListener('click', function () { ytAction('check'); });
    $('post-queue-retry').addEventListener('click', queueRetry);
    $('post-open').addEventListener('click', function () {
      var p = selPost(); if (!p) return;
      Api.postOpen(p.id).catch(function (x) { setText($('posts-text'), 'Could not open the folder: ' + (x.message || 'error')); });
    });
  }

  // ---- wiring ----
  function wire() {
    wirePosts();
    $('btn-feedback').addEventListener('click', openFeedback);
    $('feedback-close').addEventListener('click', function () { $('feedback').hidden = true; });
    $('fb-form').addEventListener('submit', saveFeedback);
    $('btn-stream').addEventListener('click', function () { hostAction(state.status && state.status.host.live ? 'stream.stop' : 'stream.start'); });
    $('btn-end-all').addEventListener('click', function () { guard(Api.endAll().then(showResult)); });
    $('btn-ready').addEventListener('click', function () { loadReady(); });
    $('btn-record').addEventListener('click', function () { hostAction(state.status && state.status.host.recording ? 'record.stop' : 'record.start'); });
    ['h', 'v'].forEach(function (c) {
      $('btn-open-' + c).addEventListener('click', function () { guard(Api.host('preview.open', { canvas: c }).then(function (r) { setText($('preview-note'), (r.result && r.result.note) || 'Preview ' + c.toUpperCase() + ' opened' + (r.result && r.result.display ? ' on the ' + r.result.display : '') + '.'); })); });
      $('btn-focus-' + c).addEventListener('click', function () { guard(Api.host('preview.focus', { canvas: c })); });
    });
    $('btn-import').addEventListener('click', runImport);
    $('import-close').addEventListener('click', function () { $('import').hidden = true; });
    $('import-load').addEventListener('click', loadImported);
    ['h', 'v'].forEach(function (c) { $('tab-' + c).addEventListener('click', function () { state.canvas = c; renderTabs(); loadLayers(); }); });
    $('confirm-ok').addEventListener('click', submitConfirm);
    $('confirm-cancel').addEventListener('click', cancelConfirm);
    $('btn-undo').addEventListener('click', function () { undoRedo(true); });
    $('btn-redo').addEventListener('click', function () { undoRedo(false); });
    $('btn-scene-add').addEventListener('click', function () { structureEdit({ op: 'scene.add', name: $('scene-name').value }).then(function (ok) { if (ok) $('scene-name').value = ''; }); });
    $('btn-scene-remove').addEventListener('click', removeSceneClick);
    $('layer-kind').addEventListener('change', renderPick);
    $('btn-layer-add').addEventListener('click', addLayerClick);
    $('btn-layer-remove').addEventListener('click', removeLayerClick);
    $('tr-canvas').addEventListener('change', showTransition);
    $('tr-type').addEventListener('change', trFields);
    $('btn-tr-save').addEventListener('click', saveTransition);
    document.addEventListener('keydown', nudgeKey);
    document.addEventListener('keydown', function (e) {
      var t = e.target && e.target.tagName;
      if (!(e.ctrlKey || e.metaKey) || e.altKey || t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') return; // text fields keep their own undo
      var k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undoRedo(true); } else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); undoRedo(false); }
    });
    $('confirm').addEventListener('keydown', function (e) { if (e.key === 'Escape') cancelConfirm(); });
  }

  function start() {
    wire();
    setInterval(function () { if (!$('bots').hidden) loadBots(); }, 15000); // each check lists processes: slow on purpose
    setInterval(pollMeters, 250); // the live-marker audio producer samples mixer.list at the same rate
    Api.session()
      .then(function () { return Promise.all([loadScenes(), loadMixer(), loadFlags(), Api.status().then(applyStatus), Api.edits().then(renderEdits)]); })
      .then(function () { Api.events(applyStatus, function (ok) { if (!ok) pill($('st-core'), 'Reconnecting...', 'warn'); }, function (d) { renderFlags(d.flags); }, renderEdits); })
      .catch(function (e) { showError(e.status === 401 ? 'Session missing. Start the studio with npm run studio.' : 'Start-up failed: ' + (e && e.message ? e.message : 'could not reach the studio server')); });
  }
  start();
})();
