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
      else if (r.verdict === 'allow') { if (r.flags) renderFlags(r.flags); if (r.bots) renderBots(r.bots); setText($('preview-note'), 'Done.'); if (r.forced) setText($('bot-note'), 'The bot did not close when asked and was force-closed; unsaved bot changes may be lost.'); loadScenes().then(loadMixer).catch(function () {}); } else setText($('preview-note'), r.verdict === 'allow' ? 'Done.' : 'Result: ' + r.verdict + (r.reason ? ' (' + r.reason + ')' : ''));
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

  // ---- feature flags: OFF applies at once; ON goes through the typed confirmation ----
  function renderFlags(list) {
    var ul = $('flag-list'); clear(ul);
    var postingOn = (list || []).some(function (f) { return f.id === 'posting' && f.on; });
    $('btn-posts').hidden = !postingOn;
    if (!postingOn) $('posts').hidden = true;
    var botsOn = (list || []).some(function (f) { return f.id === 'bot-manager' && f.on; });
    $('bots').hidden = !botsOn;
    if (botsOn) loadBots(); else clear($('bot-list'));
    var reportOn = (list || []).some(function (f) { return f.id === 'report-button' && f.on; });
    $('report').hidden = !reportOn;
    (list || []).forEach(function (f) {
      var cb = el('input', { type: 'checkbox', id: 'flag-' + f.id, 'aria-label': f.id });
      cb.checked = !!f.on;
      cb.addEventListener('change', function () {
        var want = cb.checked;
        cb.checked = !want; // the box follows the server, not the click
        guard(Api.setFlag(f.id, want).then(function (r) {
          if (r.verdict === 'confirm') openConfirm(r.pending);
          else if (r.flags) renderFlags(r.flags);
        }));
      });
      ul.appendChild(el('li', { class: 'row flag-row', title: f.description }, [el('span', { class: 'name', text: f.id }), el('label', null, [cb])]));
    });
    if (!list || !list.length) setText($('flag-note'), 'No feature flags defined.');
    else setText($('flag-note'), 'Turning a flag off is instant. Turning it on asks you to type yes.');
  }
  function loadFlags() { return Api.flags().then(function (r) { renderFlags(r.flags); }); }

  // ---- Bots card (BM2, flag `bot-manager`): Streamer.bot and Speaker.bot; Start and Stop are typed-confirmation writes ----
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
      start.addEventListener('click', function () { guard(Api.botStart(b.bot).then(function (r) { if (r.verdict === 'confirm') openConfirm(r.pending); })); });
      stop.addEventListener('click', function () { guard(Api.botStop(b.bot).then(function (r) { if (r.verdict === 'confirm') openConfirm(r.pending); })); });
      ul.appendChild(el('li', { class: 'row' }, [el('span', { class: 'name', text: b.label || b.bot }), el('span', { class: 'muted', text: b.ok ? 'up' : (b.running ? 'running, port not answering' : (b.installed ? 'stopped' : 'not installed')) }), start, stop, facts[0]].concat(facts.slice(1))));
    });
    setText($('bot-note'), 'Start and Stop ask you to type yes. Stop only ends a bot that Ujwalam started.');
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
  var ps = { posts: [], sel: null };
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
        el('span', { class: flagged ? 'warn-text' : 'muted', text: p.status + (flagged ? ' / check' : '') })]);
      var pick = function () { ps.sel = p.id; renderPosts(); fillPost(p); };
      li.addEventListener('click', pick);
      li.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
      ul.appendChild(li);
    });
    setText($('posts-text'), ps.posts.length ? ps.posts.length + ' package(s). Private drafts only; approving marks a package, nothing is uploaded.' : 'No packages yet. Run: node services/posting/cli.mjs package --run <clip run folder>');
    $('post-form').hidden = !ps.sel;
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
  }
  function openPosts() {
    $('posts').hidden = false; ps.sel = null; $('post-form').hidden = true;
    guard(Api.posts().then(function (r) { ps.posts = r.posts || []; renderPosts(); }));
  }
  function postAction(call) {
    var p = selPost(); if (!p) return;
    call(p).then(function (r) { replacePost(r.post); setText($('posts-text'), 'Saved.'); })
      .catch(function (x) { setText($('posts-text'), 'Not done: ' + (x.message || 'error')); });
  }
  function wirePosts() {
    $('btn-posts').addEventListener('click', openPosts);
    $('btn-report').addEventListener('click', reportClick);
    $('posts-close').addEventListener('click', function () { $('posts').hidden = true; clear($('post-media')); });
    $('post-form').addEventListener('submit', function (e) {
      e.preventDefault();
      postAction(function (p) { return Api.postEdit(p.id, { title: $('post-title').value, description: $('post-desc').value, tags: csv($('post-tags').value), hashtags: csv($('post-hash').value) }); });
    });
    $('post-approve').addEventListener('click', function () { postAction(function (p) { return Api.postStatus(p.id, 'approved'); }); });
    $('post-reject').addEventListener('click', function () { postAction(function (p) { return Api.postStatus(p.id, 'rejected'); }); });
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
    $('confirm-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') submitConfirm(); if (e.key === 'Escape') cancelConfirm(); });
  }

  function start() {
    wire();
    setInterval(function () { if (!$('bots').hidden) loadBots(); }, 15000); // each check lists processes: slow on purpose
    Api.session()
      .then(function () { return Promise.all([loadScenes(), loadMixer(), loadFlags(), Api.status().then(applyStatus)]); })
      .then(function () { Api.events(applyStatus, function (ok) { if (!ok) pill($('st-core'), 'Reconnecting...', 'warn'); }, function (d) { renderFlags(d.flags); }); })
      .catch(function (e) { showError(e.status === 401 ? 'Session missing. Start the studio with npm run studio.' : 'Start-up failed: ' + (e && e.message ? e.message : 'could not reach the studio server')); });
  }
  start();
})();
