// SPDX-License-Identifier: GPL-2.0-or-later
// Studio UI skeleton: scenes, layers, preview buttons, mixer placeholder, stream/record buttons, status bar.
// Plain script, safe DOM only (Dom.el / textContent). Every host call goes through the same-origin UI server.
(function () {
  'use strict';
  var el = Dom.el, clear = Dom.clear, setText = Dom.setText;
  var $ = function (id) { return document.getElementById(id); };

  var state = { canvas: 'h', scenes: [], activeScene: null, layers: [], mixer: [], status: null, pending: null };

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
  function guard(p) { return p.catch(function (e) { showError('Error: ' + (e && e.message ? e.message : 'failed')); }); }

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
        var up = el('button', { class: 'icon-btn', type: 'button', text: 'Up', 'aria-label': 'Move ' + l.name + ' up', disabled: hi === n - 1, onclick: function () { move(l, hi + 1); } });
        var dn = el('button', { class: 'icon-btn', type: 'button', text: 'Dn', 'aria-label': 'Move ' + l.name + ' down', disabled: hi === 0, onclick: function () { move(l, hi - 1); } });
        ul.appendChild(el('li', { class: 'row' + (l.visible ? '' : ' hidden-layer') }, [el('span', { class: 'name', text: l.name }), up, dn, vis]));
      })(state.layers[n - 1 - d], n - 1 - d);
    }
  }
  function move(l, to) { guard(Api.host('layers.move', layerArgs({ layer: l.id, index: to })).then(loadLayers)); }
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
    return Api.host('layers.list', layerArgs()).then(function (r) { state.layers = unwrap(r.result, 'layers'); renderLayers(); });
  }

  // ---- mixer placeholder (volume/mute wired to the host API; meters from the host when it provides them) ----
  function renderMixer() {
    var box = $('mixer'); clear(box);
    state.mixer.forEach(function (m) {
      var db = el('span', { class: 'db', text: fmt(m.volumeDb, ' dB') });
      var slider = el('input', { type: 'range', min: -60, max: 0, step: 1, value: Math.max(-60, Math.min(0, typeof m.volumeDb === 'number' ? m.volumeDb : 0)), 'aria-label': m.name + ' volume' });
      slider.addEventListener('input', function () { setText(db, slider.value + ' dB'); });
      slider.addEventListener('change', function () { guard(Api.host('mixer.setVolume', { id: m.id, db: Number(slider.value) })); });
      var mute = el('button', { class: 'icon-btn', type: 'button', text: m.muted ? 'Unmute' : 'Mute', onclick: function () { guard(Api.host('mixer.setMute', { id: m.id, muted: !m.muted }).then(loadMixer)); } });
      var level = el('i'); level.style.width = Math.max(0, Math.min(100, (typeof m.peakDb === 'number' ? (m.peakDb + 60) / 60 * 100 : 0))) + '%';
      box.appendChild(el('div', { class: 'chan' }, [el('span', { text: m.name }), mute, el('div', { class: 'meter' }, [level]), slider, db]));
    });
    box.appendChild(el('p', { class: 'muted mixer-note', text: 'Meters show the host peak level; per-source mixer ids are <scene>/<layer>.' }));
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
    pill($('st-core'), c.available ? 'Event core: up' : 'Event core: down', c.available ? 'ok' : 'warn');
    pill($('st-host'), h.blockedOnHost ? 'BLOCKED-ON-HOST (fake)' : (h.available ? 'Host: up' : 'Host: down'), h.blockedOnHost ? 'blocked' : (h.available ? 'ok' : 'warn'));
    var banner = $('banner');
    banner.hidden = !h.blockedOnHost;
    // When the backend flips between the fake and the real host, the scene ids change: reload the lists.
    if (state.wasBlocked !== undefined && state.wasBlocked !== !!h.blockedOnHost) { state.activeScene = null; loadScenes().then(loadMixer).catch(function () {}); }
    state.wasBlocked = !!h.blockedOnHost;
    if (h.blockedOnHost) setText(banner, 'BLOCKED-ON-HOST: the libobs host is not connected. Everything on this page comes from a fake in-memory backend.');
    var ready = h.outputsReady || {};
    var sb = $('btn-stream'), rb = $('btn-record');
    sb.disabled = !ready.stream; rb.disabled = !ready.record;
    setText(sb, h.live ? 'Stop stream' : 'Start stream');
    setText(rb, h.recording ? 'Stop recording' : 'Record');
    sb.title = ready.stream ? '' : 'Disabled until the stream output exists';
    rb.title = ready.record ? '' : 'Disabled until the record output exists';
  }

  // ---- confirmation (typed phrase; the server keeps the ids and hashes) ----
  function openConfirm(p) {
    state.pending = p;
    setText($('confirm-summary'), p.summary);
    setText($('confirm-phrase'), p.phrase);
    setText($('confirm-msg'), p.step ? 'Step ' + p.step + ' of ' + p.of : '');
    $('confirm-input').value = '';
    $('confirm').hidden = false;
    $('confirm-input').focus();
  }
  function closeConfirm() { $('confirm').hidden = true; state.pending = null; }
  function submitConfirm() {
    var p = state.pending; if (!p) return;
    Api.confirm(p.pendingId, $('confirm-input').value).then(function (r) {
      if (r.verdict === 'wrong-phrase') { setText($('confirm-msg'), 'That is not the phrase. Type it exactly.'); return; }
      closeConfirm();
      if (r.verdict === 'confirm' && r.pending) openConfirm(r.pending);
      else if (r.verdict === 'allow') { setText($('preview-note'), 'Done.'); loadScenes().then(loadMixer).catch(function () {}); } else setText($('preview-note'), r.verdict === 'allow' ? 'Done.' : 'Result: ' + r.verdict + (r.reason ? ' (' + r.reason + ')' : ''));
    }).catch(function (e) { closeConfirm(); showError('Confirmation failed: ' + (e.message || 'error')); });
  }
  function cancelConfirm() { var p = state.pending; closeConfirm(); if (p) Api.cancel(p.pendingId).catch(function () {}); }

  function hostAction(method) {
    guard(Api.host(method).then(function (r) { if (r.verdict === 'confirm') openConfirm(r.pending); }));
  }

  // ---- Import Meld session: import (new project file) -> plan (dry run) -> typed confirmation -> project.load ----
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
    guard(Api.projectLoad(skip).then(function (r) { $('import').hidden = true; if (r.verdict === 'confirm') openConfirm(r.pending); }));
  }

  // ---- wiring ----
  function wire() {
    $('btn-stream').addEventListener('click', function () { hostAction(state.status && state.status.host.live ? 'stream.stop' : 'stream.start'); });
    $('btn-record').addEventListener('click', function () { hostAction(state.status && state.status.host.recording ? 'record.stop' : 'record.start'); });
    ['h', 'v'].forEach(function (c) {
      $('btn-open-' + c).addEventListener('click', function () { guard(Api.host('preview.open', { canvas: c }).then(function (r) { setText($('preview-note'), (r.result && r.result.note) || 'Preview ' + c.toUpperCase() + ' opened.'); })); });
      $('btn-focus-' + c).addEventListener('click', function () { guard(Api.host('preview.focus', { canvas: c })); });
    });
    $('btn-import').addEventListener('click', runImport);
    $('import-close').addEventListener('click', function () { $('import').hidden = true; });
    $('import-load').addEventListener('click', loadImported);
    ['h', 'v'].forEach(function (c) { $('tab-' + c).addEventListener('click', function () { state.canvas = c; renderTabs(); loadLayers(); }); });
    $('confirm-ok').addEventListener('click', submitConfirm);
    $('confirm-cancel').addEventListener('click', cancelConfirm);
    $('confirm-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') submitConfirm(); if (e.key === 'Escape') cancelConfirm(); });
  }

  function start() {
    wire();
    Api.session()
      .then(function () { return Promise.all([loadScenes(), loadMixer(), Api.status().then(applyStatus)]); })
      .then(function () { Api.events(applyStatus, function (ok) { if (!ok) pill($('st-core'), 'Reconnecting...', 'warn'); }); })
      .catch(function (e) { showError(e.status === 401 ? 'Session missing. Start the studio with npm run studio.' : 'Start-up failed: ' + (e && e.message ? e.message : 'could not reach the studio server')); });
  }
  start();
})();
