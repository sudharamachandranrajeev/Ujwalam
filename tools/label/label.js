// SPDX-License-Identifier: GPL-3.0-or-later
// A6 labelling page. Plain script, no CDN, safe DOM only: every node is built with createElement and textContent.
//
// Two passes in a fixed order.
//   Pass 1 (highlights, blind): video + filmstrip only. This file never requests suggestions, the pack
//          or any detector data until the user confirms opening pass 2; the server also refuses
//          GET suggestions before that confirmation.
//   Pass 2 (events): suggestions from an offline file (tools/label/suggestions.py). The page only
//          shows and edits them.
(function () {
  'use strict';

  var LEAD_SEC = 3;
  var FRAME = 1 / 30;
  var IDLE_MS = 60000;
  var SPEEDS = [1, 2, 4, 8];
  var AUTOSAVE_MS = 5000;

  var HEARTBEAT_MS = 10000;
  var KEEPALIVE_MAX = 60000; // bytes; fetch keepalive bodies are capped at about 64 KiB in flight
  var NOTE_MAX = 2000;

  var CHANGED_ELSEWHERE = 'draft changed elsewhere, reload';
  var core = window.LabelCore; // tools/label/label-core.js (no DOM; unit-tested)
  var saver = core.createSaver(); // one save at a time; edit counter for "dirty"
  // Per-launch token from the page URL (printed by the server). Sent as a header on every fetch and
  // as ?tok= only on element src URLs (video, img). Never stored.
  var TOKEN = core.readToken(location.search);
  var TAB = core.tabId(crypto.getRandomValues(new Uint8Array(16))); // this tab, for the session lock
  var highlightGuard = core.createRepeatGuard(1000, 0.05); // "add highlight" repeat within 1 s at the same playhead

  var S = {
    sessions: [], id: null, manifest: null, tags: [], pack: null, suggestions: null,
    draft: null, pass: 1, sel: null, pendIn: null, pendOut: null, undo: [],
    view: { start: 0, span: 600 }, lastInput: Date.now(), shuttle: 0, shuttleTimer: null,
    modal: null, hasSuggestionsFile: true,
    lockHeld: false, readOnly: false, readOnlyWhy: '', savedCounts: { labels: 0, events: 0 }, allowEmpty: false, notes: [], exporting: false
  };

  // ---------------------------------------------------------------- DOM helpers
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, props) {
    var n = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        if (k === 'text') n.textContent = props[k];
        else if (k === 'class') n.className = props[k];
        else if (k === 'on') Object.keys(props.on).forEach(function (ev) { n.addEventListener(ev, props.on[ev]); });
        else if (k in n) n[k] = props[k];
        else n.setAttribute(k, props[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c == null) continue;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return n;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  var video = $('video');

  function fmt(t) {
    if (!isFinite(t)) return '-';
    var h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return h + ':' + String(m).padStart(2, '0') + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
  }
  function parseTime(text) {
    var s = String(text).trim();
    if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
    var m = /^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(s);
    if (!m) return null;
    return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }
  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'on';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = ''; }, 2200);
  }

  // ---------------------------------------------------------------- API
  function authHeaders() { return { 'X-Label-Token': TOKEN || '', 'X-Label-Tab': TAB }; }
  // Element src URLs cannot send a header, so these carry the token as ?tok=.
  function srcUrl(u) { return u + (u.indexOf('?') >= 0 ? '&' : '?') + 'tok=' + encodeURIComponent(TOKEN || ''); }
  function api(method, url, body, extra) {
    var init = { method: method, headers: authHeaders() };
    if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    if (extra) Object.assign(init, extra);
    return fetch(url, init).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.error || ('http ' + r.status)); e.status = r.status; e.body = j; throw e; }
        return j;
      });
    });
  }
  var base = function () { return '/api/session/' + encodeURIComponent(S.id); };

  // ---------------------------------------------------------------- draft
  function touch() { saver.edit(); $('saveState').textContent = 'unsaved'; }
  function snapshot() { return JSON.stringify({ labels: S.draft.labels, events: S.draft.events }); }
  // Read-only tabs (another tab or launch holds the session lock) cannot edit.
  function canEdit() {
    if (S.readOnly) { toast('Read-only: ' + S.readOnlyWhy); return false; }
    return true;
  }
  function pushUndo() {
    if (!canEdit()) return false;
    S.undo.push(snapshot()); if (S.undo.length > 200) S.undo.shift();
    return true;
  }
  function counts() { return { labels: S.draft.labels.length, events: S.draft.events.length }; }
  // A change that empties the windows or the events list needs a confirm; the save then carries
  // allowEmpty:true (the server refuses an emptying save without it).
  function confirmIfEmptying(next, apply, what) {
    var em = core.wouldEmpty(counts(), next);
    if (!em.length) { apply(false); return; }
    openModal('confirm', {
      title: what + ' the last ' + (em.indexOf('labels') >= 0 ? 'window' : 'event') + '?',
      lines: ['This leaves the ' + em.join(' and ') + ' list empty.', 'Enter = yes, Esc = keep it.'],
      yes: function () { apply(true); }
    });
  }
  function undo() {
    if (!canEdit()) return;
    if (!S.undo.length) { toast('Nothing to undo'); return; }
    var o = JSON.parse(S.undo[S.undo.length - 1]);
    confirmIfEmptying(o, function (allowEmpty) {
      S.undo.pop();
      S.draft.labels = o.labels; S.draft.events = o.events;
      if (allowEmpty) S.allowEmpty = true;
      S.sel = null; touch(); renderAll(); toast('Undone');
    }, 'Undo and remove');
  }
  function nextId(prefix, list) {
    var max = 0;
    list.forEach(function (x) { var m = /^[a-z]-(\d+)$/.exec(x.id); if (m) max = Math.max(max, Number(m[1])); });
    return prefix + '-' + String(max + 1).padStart(4, '0');
  }
  // Saves go through one queue (label-core.js). The promise rejects when the save fails, so callers
  // (export, open pass 2, session switch) stop instead of acting on stale data. The draft sends the
  // integer revision it last saw; the server answers 409 draft-changed when another tab saved since,
  // and then nothing more is saved until the page is reloaded. An emptying save is never sent
  // unless the user confirmed it (allowEmpty).
  // The PUT body for the open draft, or throws when it would empty a list without the user's confirm.
  function draftBody(draft) {
    var allowEmpty = S.allowEmpty;
    var em = core.wouldEmpty(S.savedCounts, draft);
    if (em.length && !allowEmpty) throw new Error('not saved: it would empty the ' + em.join(' and ') + ' list (delete the last item again and confirm)');
    var body = Object.assign({}, draft);
    if (allowEmpty) body.allowEmpty = true;
    return JSON.stringify(body);
  }
  function save(quiet) {
    if (!S.id || !S.draft) return Promise.resolve(null); // nothing loaded, nothing to save
    var id = S.id, draft = S.draft;
    return saver.save(function () {
      var allowEmpty = S.allowEmpty;
      var sent = draftBody(draft);
      var headers = authHeaders(); headers['Content-Type'] = 'application/json';
      return fetch('/api/session/' + encodeURIComponent(id) + '/draft', { method: 'PUT', headers: headers, body: sent, keepalive: sent.length < KEEPALIVE_MAX })
        .then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (j) {
            if (r.status === 409 && j.error === 'draft-changed') { saver.block(CHANGED_ELSEWHERE, 'changed'); renderBanner(); throw new Error(CHANGED_ELSEWHERE); }
            if (r.status === 423) { setReadOnly('this tab no longer holds the session lock'); throw new Error('not saved: read-only'); }
            if (!r.ok) throw new Error('save failed (' + (j.error || ('http ' + r.status)) + (j.at ? ' at ' + j.at : '') + ')');
            return j;
          });
        })
        .then(function (d) {
          draft.pass2 = d.pass2; draft.revision = d.revision; draft.savedAt = d.savedAt;
          if (core.sameSession(id, S.id)) {
            S.savedCounts = { labels: d.labels.length, events: d.events.length };
            if (allowEmpty) S.allowEmpty = false;
          }
          return d;
        });
    }).then(function (d) {
      if (core.sameSession(id, S.id)) {
        if (d) $('saveState').textContent = saver.dirty() ? 'unsaved' : 'saved ' + new Date().toLocaleTimeString();
        renderBanner();
        if (!quiet) toast('Saved');
      }
      return d;
    }, function (e) {
      if (core.sameSession(id, S.id)) {
        $('saveState').textContent = 'SAVE FAILED: ' + e.message;
        if (e.message === CHANGED_ELSEWHERE) toast('The draft changed elsewhere (another tab?). Reload the page.');
      }
      throw e;
    });
  }
  var ignore = function () { /* already shown in the save state */ };
  // Autosave pauses while an export is being confirmed, so the stored draft cannot change under the
  // confirmed preview (the server also refuses an export whose document hash differs).
  var canAutosave = function () { return S.draft && saver.dirty() && !saver.blocked() && !S.exporting; };
  setInterval(function () { if (canAutosave()) save(true).catch(ignore); }, AUTOSAVE_MS);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { if (canAutosave()) save(true).catch(ignore); return; }
    heartbeat(); // a hidden tab's timers may have been throttled; refresh the lock as soon as it is visible
  });

  // ---------------------------------------------------------------- session lock (one writer per session)
  function lockUrl(id, what) { return '/api/session/' + encodeURIComponent(id) + '/' + what; }
  function setReadOnly(why) {
    S.readOnly = true; S.readOnlyWhy = why; S.lockHeld = false;
    saver.block('read-only: ' + why, 'read-only');
    $('saveState').textContent = 'READ-ONLY';
    renderBanner();
  }
  // Applies a POST lock reply (core.lockReply decides and blocks or unblocks the saver). A stale lock
  // (its launch is gone, or no heartbeat for 5 min) is taken over only after the user confirms; a lock
  // being released (for example the old page after F5) is retried shortly, and when the retry gets the
  // lock the draft is reloaded (which also lifts the read-only block on autosave).
  function applyLock(id, r, tries) {
    if (!core.sameSession(id, S.id)) return;
    var a = core.lockReply(saver, r, tries, 3);
    // The lock came on a retry: the previous tab's final save may have landed after this tab read the
    // draft. Reload it (as after a take-over), so the first autosave is not refused as draft-changed.
    if (a.action === 'writer' && a.reload) { openSession(id); return; }
    S.lockHeld = !a.readOnly; S.readOnly = a.readOnly; S.readOnlyWhy = a.why;
    $('saveState').textContent = a.readOnly ? 'READ-ONLY' : (saver.blocked() ? 'AUTOSAVE OFF' : '');
    renderBanner();
    if (a.action === 'retry') {
      setTimeout(function () { api('POST', lockUrl(id, 'lock'), {}).then(function (x) { applyLock(id, x, (tries || 0) + 1); }, ignore); }, a.retryMs);
      return;
    }
    if (a.action === 'stale') {
      openModal('confirm', {
        title: 'Take over this session?',
        lines: ['Another tab or launch had this session open and stopped answering (its launch has closed, or no heartbeat for 5 min).',
          'Take over only if that tab is really gone. Enter = take over (the page reloads the draft), Esc = stay read-only.'],
        yes: function () {
          api('POST', lockUrl(id, 'lock'), { takeover: true }).then(function (x) {
            if (x.writer && core.sameSession(id, S.id)) openSession(id); // reload the draft as the new writer
            else applyLock(id, x, 3);
          }).catch(function (e) { toast('Take over failed: ' + e.message); });
        }
      });
      return;
    }
  }
  function heartbeat() {
    if (!S.id || !S.lockHeld) return;
    var id = S.id;
    api('POST', lockUrl(id, 'lock'), {}).then(function (r) {
      if (core.sameSession(id, S.id) && !r.writer) setReadOnly('the session lock was taken over');
    }, ignore);
  }
  setInterval(heartbeat, HEARTBEAT_MS);
  // Tab close (review M5). beforeunload asks when anything is unsaved or saving is off. At pagehide the
  // final save is sent directly (not through the save queue, which would not run after unload) with
  // fetch keepalive, when it fits the browser's keepalive limit; then the lock is released. The server
  // keeps a released lock usable by this tab for a short grace time, so the final save still lands; a
  // new tab gets the session after it. sendBeacon is not used: it cannot send the token header, and a
  // token-in-body route that accepts a cross-site-postable content type would weaken the API checks;
  // in Chromium it also shares the same ~64 KiB quota, so it would not carry a larger draft either.
  window.addEventListener('beforeunload', function (e) {
    if (!S.draft || (S.readOnly && !saver.dirty())) return; // a read-only tab with no edits has nothing to lose
    if (core.unloadPlan(saver, 0, KEEPALIVE_MAX).prompt) { e.preventDefault(); e.returnValue = ''; }
  });
  window.addEventListener('pagehide', function () {
    if (!S.id || !S.lockHeld) return;
    var headers = authHeaders(); headers['Content-Type'] = 'application/json';
    if (S.draft) {
      var body = null;
      try { body = draftBody(S.draft); } catch (e) { body = null; }
      if (body && core.unloadPlan(saver, body.length, KEEPALIVE_MAX).send) {
        fetch('/api/session/' + encodeURIComponent(S.id) + '/draft', { method: 'PUT', headers: headers, body: body, keepalive: true }).catch(ignore);
      }
    }
    fetch(lockUrl(S.id, 'unlock'), { method: 'POST', headers: headers, body: '{}', keepalive: true }).catch(ignore);
  });

  // ---------------------------------------------------------------- active-time log
  ['keydown', 'mousedown', 'wheel', 'touchstart'].forEach(function (ev) {
    document.addEventListener(ev, function () { S.lastInput = Date.now(); }, true);
  });
  var lastMove = 0;
  document.addEventListener('mousemove', function () { var n = Date.now(); if (n - lastMove > 1000) { lastMove = n; S.lastInput = n; } }, true);
  setInterval(function () {
    if (!S.draft || document.hidden || S.readOnly) return;
    var active = !video.paused || S.shuttle !== 0 || Date.now() - S.lastInput <= IDLE_MS;
    if (!active) return;
    var k = S.pass === 1 ? 'highlightPassSec' : 'eventPassSec';
    S.draft.timing[k] = Math.round((S.draft.timing[k] + 1) * 10) / 10;
    saver.edit();
    renderTiming();
  }, 1000);
  function renderTiming() {
    var t = S.draft ? S.draft.timing : { highlightPassSec: 0, eventPassSec: 0 };
    var f = function (x) { return Math.floor(x / 60) + ' min'; };
    $('timing').textContent = 'active: pass 1 ' + f(t.highlightPassSec) + ', pass 2 ' + f(t.eventPassSec);
  }

  // ---------------------------------------------------------------- session load
  function loadSessionList() {
    if (!TOKEN) {
      var body = $('sideBody'); clear(body);
      body.appendChild(el('div', { class: 'err', text: 'This page needs the launch token. Open the exact URL the label server printed (it ends with ?t=...).' }));
      return Promise.resolve();
    }
    return Promise.all([api('GET', '/api/sessions'), api('GET', '/api/tags')]).then(function (r) {
      S.sessions = r[0].sessions;
      S.tags = r[1].tags;
      var sel = $('sessionSelect');
      clear(sel);
      S.sessions.forEach(function (s) {
        sel.appendChild(el('option', { value: s.id, text: s.id + '  (' + fmt(s.durationSec).split('.')[0] + (s.exported ? ', exported' : '') + ')' }));
      });
      if (!S.sessions.length) { toast('No session with a cache found'); return; }
      return openSession(S.sessions[0].id);
    });
  }
  function openSession(id) {
    // The previous session's lock is released (its draft was saved before the switch).
    if (S.id && S.lockHeld && S.id !== id) api('POST', lockUrl(S.id, 'unlock'), {}).catch(ignore);
    S.id = id; $('sessionSelect').value = id;
    S.suggestions = null; S.pack = null; S.undo = []; S.sel = null; S.pendIn = S.pendOut = null;
    S.draft = null; S.manifest = null; S.pass = 1;
    S.lockHeld = false; S.readOnly = false; S.readOnlyWhy = ''; S.allowEmpty = false; S.notes = []; S.exporting = false;
    saver.reset();
    var sb = '/api/session/' + encodeURIComponent(id);
    return Promise.all([api('GET', sb + '/manifest'), api('GET', sb + '/draft'), api('POST', sb + '/lock', {}), api('GET', sb + '/notes').catch(function () { return { notes: [] }; })]).then(function (r) {
      if (!core.sameSession(id, S.id)) return; // the user opened another session meanwhile
      S.manifest = r[0];
      S.draft = r[1];
      S.draft.timing = S.draft.timing || { highlightPassSec: 0, eventPassSec: 0 };
      S.draft.labels = S.draft.labels || [];
      S.draft.events = S.draft.events || [];
      S.savedCounts = counts();
      S.notes = r[3].notes || [];
      $('saveState').textContent = '';
      applyLock(id, r[2]);
      video.src = srcUrl('/media/proxy/' + encodeURIComponent(id));
      S.view = { start: 0, span: Math.min(600, S.manifest.durationSec) };
      // Pass 2 data (pack, suggestions) is never loaded here: it is fetched only when pass 2 is entered.
      S.pass = 1;
      if (S.draft.ui && typeof S.draft.ui.t === 'number') video.addEventListener('loadedmetadata', function f() { video.removeEventListener('loadedmetadata', f); seek(S.draft.ui.t); });
      renderAll();
    }, function (e) {
      if (!core.sameSession(id, S.id)) return;
      // The draft could not be read (for example a corrupt draft file: the server answers 500).
      // Autosave stays off for this session so the file on disk is never overwritten.
      saver.block('the draft could not be loaded (' + e.message + '); nothing is saved for this session. Fix the draft file, then reload.', 'draft-load');
      S.draft = null; S.manifest = null;
      video.removeAttribute('src'); video.load();
      ['film', 'trackWin', 'trackSug', 'overview'].forEach(function (n) { clear($(n)); });
      $('saveState').textContent = 'DRAFT NOT LOADED, autosave off';
      var body = $('sideBody'); clear(body);
      body.appendChild(el('div', { class: 'err', text: 'The draft for this session could not be loaded (' + e.message + '). Autosave is off for this session, so the draft file is not touched. Fix or move the draft file, then reload the page.' }));
      toast('Draft load failed: ' + e.message);
    });
  }
  // Only called after the user confirmed opening pass 2 (or the draft already records it).
  // Resolves true when the data was applied, false when another session was opened meanwhile.
  function loadPass2Data(id) {
    var sb = '/api/session/' + encodeURIComponent(id);
    return Promise.all([
      api('GET', sb + '/pack'),
      api('GET', sb + '/suggestions').catch(function (e) { if (e.status === 404) return null; throw e; })
    ]).then(function (r) {
      if (!core.sameSession(id, S.id)) return false;
      S.pack = r[0];
      S.suggestions = (r[1] && r[1].suggestions) || [];
      S.hasSuggestionsFile = Boolean(r[1]);
      S.suggestions.sort(function (a, b) { return a.timeSec - b.timeSec; });
      return true;
    });
  }

  // ---------------------------------------------------------------- playback
  function dur() { return S.manifest ? S.manifest.durationSec : 0; }
  function seek(t) { video.currentTime = Math.max(0, Math.min(dur(), t)); renderPlayhead(); }
  function stopShuttle() { S.shuttle = 0; clearInterval(S.shuttleTimer); S.shuttleTimer = null; video.playbackRate = 1; renderRate(); }
  function shuttle(dir) {
    var cur = S.shuttle;
    var idx = cur !== 0 && Math.sign(cur) === dir ? Math.min(SPEEDS.length - 1, SPEEDS.indexOf(Math.abs(cur)) + 1) : 0;
    var speed = SPEEDS[idx];
    clearInterval(S.shuttleTimer); S.shuttleTimer = null;
    S.shuttle = dir * speed;
    if (dir > 0) { video.playbackRate = speed; video.play(); }
    else {
      video.pause();
      S.shuttleTimer = setInterval(function () { seek(video.currentTime - speed * 0.1); if (video.currentTime <= 0) stopShuttle(); }, 100);
    }
    renderRate();
  }
  function renderRate() { $('rate').textContent = S.shuttle === 0 ? (video.paused ? 'paused' : '1x') : (S.shuttle > 0 ? '>> ' : '<< ') + Math.abs(S.shuttle) + 'x'; }
  function togglePlay() { stopShuttle(); if (video.paused) video.play(); else video.pause(); renderRate(); }
  video.addEventListener('play', renderRate);
  video.addEventListener('pause', renderRate);
  video.addEventListener('timeupdate', function () { if (S.draft) { S.draft.ui = S.draft.ui || {}; S.draft.ui.t = Math.round(video.currentTime * 10) / 10; } });
  (function tick() { renderPlayhead(); requestAnimationFrame(tick); })();

  // ---------------------------------------------------------------- pass 1 data
  function addWindow(a, b, label) {
    a = Math.max(0, a); b = Math.min(dur(), b);
    if (!(b > a)) { toast('End must be after start'); return null; }
    if (!pushUndo()) return null;
    var w = { id: nextId('l', S.draft.labels), windowStartSec: Math.round(a * 1000) / 1000, windowEndSec: Math.round(b * 1000) / 1000, label: label, reasonTags: [], createdAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z') };
    S.draft.labels.push(w);
    S.draft.labels.sort(function (x, y) { return x.windowStartSec - y.windowStartSec; });
    S.sel = { kind: 'label', id: w.id };
    touch(); renderAll();
    return w;
  }
  function selLabel() { return S.sel && S.sel.kind === 'label' ? S.draft.labels.find(function (l) { return l.id === S.sel.id; }) : null; }
  function markWindow(label) {
    if (S.pendIn != null && S.pendOut != null && S.pendOut > S.pendIn) {
      var w = addWindow(S.pendIn, S.pendOut, label);
      if (w) { S.pendIn = S.pendOut = null; renderAll(); }
      return;
    }
    var l = selLabel();
    if (!l) { toast('Set I and O first, or select a window'); return; }
    if (!pushUndo()) return;
    l.label = label; if (label === 'reject') delete l.rating;
    touch(); renderAll();
  }
  function setRating(n) {
    var l = selLabel();
    if (!l) { toast('Select a window first'); return; }
    if (l.label !== 'keep') { toast('Rating is only for keep windows'); return; }
    if (!pushUndo()) return;
    l.rating = n; touch(); renderAll();
  }
  // "H": a window at the playhead. A repeat within 1 s at the same playhead is ignored.
  function addHighlight() {
    var t = video.currentTime;
    if (!highlightGuard.accept(t, Date.now())) { toast('Ignored: same highlight again within 1 s'); return; }
    addWindow(t - 10, t + 5, 'keep');
  }
  function deleteSelected() {
    if (!S.sel || !canEdit()) return;
    var sel = S.sel, labels = S.draft.labels, events = S.draft.events;
    if (sel.kind === 'label') labels = labels.filter(function (l) { return l.id !== sel.id; });
    else if (sel.kind === 'ev') events = events.filter(function (e) { return e.id !== sel.id; });
    else if (sel.kind === 'sug') events = events.filter(function (e) { return e.suggestionId !== sel.id; });
    // Deleting the last window or event asks first; only then may the save empty that list.
    confirmIfEmptying({ labels: labels, events: events }, function (allowEmpty) {
      if (!pushUndo()) return;
      S.draft.labels = labels; S.draft.events = events;
      if (allowEmpty) S.allowEmpty = true;
      S.sel = null; touch(); renderAll();
    }, 'Delete');
  }

  // ---------------------------------------------------------------- pass 2 data
  function decisionFor(sugId) { return S.draft.events.find(function (e) { return e.suggestionId === sugId; }) || null; }
  function items() {
    var out = [];
    (S.suggestions || []).forEach(function (s) {
      var d = decisionFor(s.id);
      out.push({ kind: 'sug', id: s.id, t: d ? d.timeSec : s.timeSec, sug: s, ev: d });
    });
    S.draft.events.forEach(function (e) { if (!e.suggestionId) out.push({ kind: 'ev', id: e.id, t: e.timeSec, ev: e }); });
    out.sort(function (a, b) { return a.t - b.t; });
    return out;
  }
  function selItem() { return items().find(function (i) { return S.sel && i.kind === S.sel.kind && i.id === S.sel.id; }) || null; }
  function decide(verdict) {
    var it = selItem();
    if (!it) { toast('Select a suggestion (N / P)'); return; }
    if (it.kind !== 'sug') { toast('Added events have no verdict to change'); return; }
    if (!pushUndo()) return;
    var s = it.sug;
    if (it.ev) it.ev.verdict = verdict;
    else {
      var e = { id: nextId('e', S.draft.events), suggestionId: s.id, detectorId: s.detectorId, timeSec: s.timeSec, suggestedTimeSec: s.timeSec, verdict: verdict };
      if (s.medal) e.medal = s.medal;
      S.draft.events.push(e);
    }
    touch(); renderAll();
  }
  function moveToPlayhead() {
    var it = selItem();
    if (!it) { toast('Select an item first'); return; }
    if (!pushUndo()) return;
    var t = Math.round(video.currentTime * 1000) / 1000;
    if (it.ev) { it.ev.timeSec = t; if (it.kind === 'sug' && it.ev.verdict === 'reject') it.ev.verdict = 'accept'; }
    else {
      var s = it.sug;
      var e = { id: nextId('e', S.draft.events), suggestionId: s.id, detectorId: s.detectorId, timeSec: t, suggestedTimeSec: s.timeSec, verdict: 'accept' };
      if (s.medal) e.medal = s.medal;
      S.draft.events.push(e);
    }
    touch(); renderAll();
  }
  function stepItem(dir) {
    var list = items();
    if (!list.length) { toast('No suggestions'); return; }
    var cur = list.findIndex(function (i) { return S.sel && i.kind === S.sel.kind && i.id === S.sel.id; });
    var idx;
    if (cur < 0) {
      var t = video.currentTime;
      idx = dir > 0 ? list.findIndex(function (i) { return i.t > t + LEAD_SEC + 0.5; }) : -1;
      if (dir < 0) { for (var k = list.length - 1; k >= 0; k--) if (list[k].t < t + LEAD_SEC - 0.5) { idx = k; break; } }
      if (idx < 0) idx = dir > 0 ? list.length - 1 : 0;
    } else idx = Math.max(0, Math.min(list.length - 1, cur + dir));
    S.sel = { kind: list[idx].kind, id: list[idx].id };
    seek(list[idx].t - LEAD_SEC);
    renderAll();
  }
  function stepWindow(dir) {
    var list = S.draft.labels;
    if (!list.length) return;
    var cur = S.sel && S.sel.kind === 'label' ? list.findIndex(function (l) { return l.id === S.sel.id; }) : -1;
    var idx = cur < 0 ? (dir > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, cur + dir));
    S.sel = { kind: 'label', id: list[idx].id };
    seek(list[idx].windowStartSec);
    renderAll();
  }
  function addEvent(entry) {
    if (!pushUndo()) return;
    var e = { id: nextId('e', S.draft.events), detectorId: entry.detectorId, timeSec: Math.round(video.currentTime * 1000) / 1000, verdict: 'added' };
    if (entry.medal) e.medal = entry.medal;
    S.draft.events.push(e);
    S.sel = { kind: 'ev', id: e.id };
    touch(); renderAll();
  }

  // ---------------------------------------------------------------- pass switching
  function switchPass() {
    if (!S.draft) return;
    if (S.pass === 2) { gotoPass(1); return; }
    var openId = S.id;
    if (S.draft.pass2 && S.draft.pass2.openedAt) {
      (S.suggestions ? Promise.resolve(true) : loadPass2Data(openId)).then(function (ok) { if (ok && core.sameSession(openId, S.id)) gotoPass(2); }).catch(function (e) { toast('Pass 2 data failed: ' + e.message); });
      return;
    }
    openModal('confirm', {
      title: 'Open pass 2?',
      lines: [
        'Pass 2 shows detector suggestions. Pass 1 is blind: finish all highlight windows first.',
        'You can go back to pass 1 later, but the draft will record that highlights were edited after suggestions were seen.',
        'Enter = open pass 2, Esc = stay in pass 1.'
      ],
      yes: function () {
        // The session is fixed at confirm time; a result that arrives after a session switch is ignored.
        var id = S.id, draft = S.draft;
        if (!id || !draft) return;
        save(true).then(function () {
          // Queued behind any save, so pass 2 opens on the highlights just saved.
          return saver.queue(function () {
            return api('POST', '/api/session/' + encodeURIComponent(id) + '/open-pass2', { confirm: true }).then(function (d) {
              draft.pass2 = d.pass2;
              return d;
            });
          });
        }).then(function () {
          if (!core.sameSession(id, S.id)) return false;
          renderBanner();
          return loadPass2Data(id);
        }).then(function (ok) { if (ok && core.sameSession(id, S.id)) gotoPass(2); })
          .catch(function (e) { toast('Could not open pass 2: ' + e.message); });
      }
    });
  }
  function gotoPass(p) { S.pass = p; S.sel = null; renderAll(); }

  // ---------------------------------------------------------------- modals
  // closeModal(true) = the user cancelled (Esc, No, click outside): the dialog's no() runs, if any.
  function closeModal(cancelled) {
    var no = cancelled && S.modal && S.modal.cfg && S.modal.cfg.no;
    S.modal = null; clear($('modalRoot'));
    if (no) no();
  }
  function openModal(type, cfg) {
    closeModal();
    S.modal = { type: type, cfg: cfg, digits: '' };
    var dlg = el('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true' });
    var scrim = el('div', { class: 'scrim' }, dlg);
    scrim.addEventListener('mousedown', function (e) { if (e.target === scrim) closeModal(true); });
    S.modal.dlg = dlg;
    if (type === 'confirm') {
      dlg.appendChild(el('h3', { text: cfg.title }));
      cfg.lines.forEach(function (l) { dlg.appendChild(el('div', { text: l })); });
      dlg.appendChild(el('div', { class: 'row' },
        el('button', { type: 'button', text: 'Yes (Enter)', on: { click: function () { var y = cfg.yes; closeModal(); y(); } } }),
        el('button', { type: 'button', text: 'No (Esc)', on: { click: function () { closeModal(true); } } })));
    } else if (type === 'help') {
      dlg.appendChild(el('h3', { text: 'Keyboard shortcuts' }));
      var tbl = el('table');
      HELP.forEach(function (r) { tbl.appendChild(el('tr', null, el('td', null, el('kbd', { text: r[0] })), el('td', { text: r[1] }))); });
      dlg.appendChild(tbl);
      dlg.appendChild(el('div', { class: 'muted', text: 'Esc closes. Shortcuts are off while typing in a field.' }));
    } else if (type === 'pick') {
      dlg.appendChild(el('h3', { text: cfg.title }));
      dlg.appendChild(el('div', { class: 'muted', text: 'Type the number, then Enter. Esc cancels.' }));
      var grid = el('div', { class: 'pick' });
      S.modal.rows = cfg.options.map(function (o, i) {
        var num = el('span', { text: String(i + 1) });
        var txt = el('span', { text: o.label });
        grid.appendChild(num); grid.appendChild(txt);
        return [num, txt];
      });
      dlg.appendChild(grid);
      S.modal.typed = el('div', { class: 'muted', text: 'number: ' });
      dlg.appendChild(S.modal.typed);
    } else if (type === 'goto') {
      dlg.appendChild(el('h3', { text: 'Go to time' }));
      var input = el('input', { type: 'text', placeholder: 'h:mm:ss or seconds', 'aria-label': 'Time' });
      input.addEventListener('keydown', function (e) {
        e.stopPropagation();
        if (e.key === 'Enter') { var t = parseTime(input.value); if (t == null) { toast('Use h:mm:ss or seconds'); return; } closeModal(); seek(t); }
        else if (e.key === 'Escape') closeModal();
      });
      dlg.appendChild(input);
      setTimeout(function () { input.focus(); }, 0);
    } else if (type === 'frame') {
      dlg.appendChild(el('h3', { text: 'Original frame at ' + fmt(cfg.t) }));
      var img = el('img', { id: 'fullFrame', alt: 'Original frame' });
      var msg = el('div', { class: 'muted', text: 'loading...' });
      img.addEventListener('load', function () { msg.textContent = 'Esc or F closes'; });
      img.addEventListener('error', function () { msg.textContent = 'Frame not available (clip missing or ffmpeg failed)'; });
      img.src = srcUrl(base() + '/frame?t=' + encodeURIComponent(cfg.t.toFixed(3)));
      dlg.appendChild(img); dlg.appendChild(msg);
    } else if (type === 'note') {
      // Free text goes only to the local notes file (server: data/games/<game>/local/label-notes/),
      // never into the draft or the label file.
      dlg.appendChild(el('h3', { text: 'Note for ' + cfg.ref + ' (local only, never exported)' }));
      cfg.existing.forEach(function (n) { dlg.appendChild(el('div', { class: 'muted', text: n.t + '  ' + n.text })); });
      var ta = el('textarea', { rows: 4, maxLength: NOTE_MAX, 'aria-label': 'Note' });
      var submit = function () {
        var text = ta.value.trim();
        if (!text) { closeModal(); return; }
        closeModal(); cfg.done(text);
      };
      ta.addEventListener('keydown', function (e) {
        e.stopPropagation();
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
        else if (e.key === 'Escape') closeModal();
      });
      dlg.appendChild(ta);
      dlg.appendChild(el('div', { class: 'muted', text: 'Ctrl+Enter saves the note, Esc cancels.' }));
      dlg.appendChild(el('button', { type: 'button', text: 'Save note', on: { click: submit } }));
      setTimeout(function () { ta.focus(); }, 0);
    } else if (type === 'errors') {
      dlg.appendChild(el('h3', { text: cfg.title }));
      cfg.lines.forEach(function (l) { dlg.appendChild(el('div', { class: 'err', text: l })); });
      dlg.appendChild(el('button', { type: 'button', text: 'Close (Esc)', on: { click: closeModal } }));
    }
    $('modalRoot').appendChild(scrim);
  }
  function modalKey(e) {
    var m = S.modal;
    if (e.key === 'Escape') { e.preventDefault(); closeModal(true); return; }
    if (m.type === 'confirm') { if (e.key === 'Enter') { e.preventDefault(); var y = m.cfg.yes; closeModal(); y(); } return; }
    if (m.type === 'frame' && (e.code === 'KeyF')) { closeModal(); return; }
    if (m.type === 'pick') {
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        m.digits += e.key;
        var n = Number(m.digits);
        m.typed.textContent = 'number: ' + m.digits;
        m.rows.forEach(function (r, i) { var on = i + 1 === n; r[0].className = on ? 'on' : ''; r[1].className = on ? 'on' : ''; });
        // Auto-commit when no longer number could still match.
        if (n >= 1 && n * 10 > m.cfg.options.length) commitPick();
      } else if (e.key === 'Enter') { e.preventDefault(); commitPick(); }
      else if (e.key === 'Backspace') { m.digits = m.digits.slice(0, -1); m.typed.textContent = 'number: ' + m.digits; }
    }
  }
  function commitPick() {
    var m = S.modal, n = Number(m.digits);
    if (!(n >= 1 && n <= m.cfg.options.length)) { toast('No such number'); m.digits = ''; m.typed.textContent = 'number: '; return; }
    var pick = m.cfg.options[n - 1], done = m.cfg.done;
    closeModal(); done(pick);
  }

  var HELP = [
    ['Space', 'Play / pause'], ['J K L', 'Shuttle back / stop / forward (each press: 1x 2x 4x 8x)'],
    ['Left Right', '-1 s / +1 s (Shift: 5 s)'], [', .', 'One frame back / forward (30 fps proxy)'],
    ['I  O', 'Window in / out at the playhead'], ['Alt+I  Alt+O', 'Set start / end of the selected window'],
    ['H', 'Highlight window at the playhead (-10 s / +5 s)'], ['1-5', 'Rating of the selected keep window'],
    ['Shift+K  Shift+X', 'Mark the window keep / reject (uses I-O, else the selected window)'],
    ['T', 'Tag picker (type the number, Enter)'], ['N  P', 'Next / previous suggestion (pass 2) or window (pass 1)'],
    ['A  R', 'Accept / reject the selected suggestion (pass 2)'], ['E', 'Move the selected suggestion to the playhead'],
    ['M', 'Add a missed event (pick the type by number)'], ['Delete', 'Delete the selected window or added event'],
    ['F', 'Original frame at full quality'], ['U  Ctrl+Z', 'Undo'], ['Ctrl+S', 'Save now (autosave also runs)'],
    ['Shift+N', 'Note on the selected item (local notes file only, never exported)'],
    ['G', 'Go to time'], ['Tab', 'Switch pass (asks before opening pass 2)'], ['?', 'This help']
  ];

  // ---------------------------------------------------------------- keys
  document.addEventListener('keydown', function (e) {
    var tg = e.target;
    if (tg && (tg.tagName === 'INPUT' || tg.tagName === 'TEXTAREA' || tg.tagName === 'SELECT' || tg.isContentEditable)) {
      return;
    }
    // Enter or Space on a focused button (outside a modal) would repeat that button's action
    // (a second export, a second highlight): ignore the key and drop the focus.
    if (core.isButtonActivationKey(tg, Boolean(S.modal), e.key)) { e.preventDefault(); tg.blur(); return; }
    if (S.modal) { modalKey(e); return; }
    if (!S.draft) return;
    var c = e.code, k = e.key, sh = e.shiftKey, ctrl = e.ctrlKey || e.metaKey, alt = e.altKey;
    var handled = true;
    if (ctrl && c === 'KeyS') saveNow();
    else if (ctrl && c === 'KeyZ') undo();
    else if (ctrl) handled = false;
    else if (k === '?') openModal('help', {});
    else if (c === 'Space') togglePlay();
    else if (c === 'KeyJ') shuttle(-1);
    else if (c === 'KeyL') shuttle(1);
    else if (c === 'KeyK' && sh) markWindow('keep');
    else if (c === 'KeyX' && sh) markWindow('reject');
    else if (c === 'KeyK') { stopShuttle(); video.pause(); renderRate(); }
    else if (c === 'ArrowLeft') { stopShuttle(); seek(video.currentTime - (sh ? 5 : 1)); }
    else if (c === 'ArrowRight') { stopShuttle(); seek(video.currentTime + (sh ? 5 : 1)); }
    else if (k === ',') { video.pause(); seek(video.currentTime - FRAME); }
    else if (k === '.') { video.pause(); seek(video.currentTime + FRAME); }
    else if (c === 'KeyI' && alt) { var l1 = selLabel(); if (l1 && video.currentTime < l1.windowEndSec && pushUndo()) { l1.windowStartSec = Math.round(video.currentTime * 1000) / 1000; touch(); renderAll(); } }
    else if (c === 'KeyO' && alt) { var l2 = selLabel(); if (l2 && video.currentTime > l2.windowStartSec && pushUndo()) { l2.windowEndSec = Math.round(video.currentTime * 1000) / 1000; touch(); renderAll(); } }
    else if (c === 'KeyI') { S.pendIn = video.currentTime; renderAll(); }
    else if (c === 'KeyO') { S.pendOut = video.currentTime; renderAll(); }
    else if (c === 'KeyH') addHighlight();
    else if (/^[1-5]$/.test(k) && !sh) setRating(Number(k));
    else if (c === 'KeyT') openTagPicker();
    else if (c === 'KeyN' && sh) openNote();
    else if (c === 'KeyN') { if (S.pass === 2) stepItem(1); else stepWindow(1); }
    else if (c === 'KeyP') { if (S.pass === 2) stepItem(-1); else stepWindow(-1); }
    else if (c === 'KeyA' && S.pass === 2) decide('accept');
    else if (c === 'KeyR' && S.pass === 2) decide('reject');
    else if (c === 'KeyE' && S.pass === 2) moveToPlayhead();
    else if (c === 'KeyM' && S.pass === 2) openEventPicker();
    else if (k === 'Delete') deleteSelected();
    else if (c === 'KeyF') { video.pause(); openModal('frame', { t: video.currentTime }); }
    else if (c === 'KeyG') openModal('goto', {});
    else if (k === 'Tab') switchPass();
    else handled = false;
    if (handled) e.preventDefault();
  });
  // Some browsers activate a focused button on Space keyup.
  document.addEventListener('keyup', function (e) { if (core.isButtonActivationKey(e.target, Boolean(S.modal), e.key)) e.preventDefault(); });
  // A clicked button does not keep the focus, so a later Enter or Space cannot repeat it.
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('button') : null;
    if (b) b.blur();
  });
  function saveNow() { save(false).catch(function (e) { toast('Save failed: ' + e.message); }); }
  function openTagPicker() {
    var l = selLabel();
    if (!l) { toast('Select a window first'); return; }
    openModal('pick', {
      title: 'Reason tag for ' + fmt(l.windowStartSec) + ' (toggles)',
      options: S.tags.map(function (t) { return { label: t.name + '  [' + t.id + ']' + (l.reasonTags.indexOf(t.id) >= 0 ? '  (on)' : ''), id: t.id }; }),
      done: function (p) {
        if (!pushUndo()) return;
        var i = l.reasonTags.indexOf(p.id);
        if (i >= 0) l.reasonTags.splice(i, 1); else l.reasonTags.push(p.id);
        touch(); renderAll();
      }
    });
  }
  // The draft-local reference of the selected item: a window id, an event id or a suggestion id.
  function noteRef() { return S.sel ? S.sel.id : null; }
  function notesFor(ref) { return S.notes.filter(function (n) { return n.ref === ref; }); }
  function openNote() {
    var ref = noteRef();
    if (!ref) { toast('Select a window or an event first'); return; }
    if (!canEdit()) return;
    var id = S.id;
    openModal('note', {
      ref: ref, existing: notesFor(ref),
      done: function (text) {
        api('POST', '/api/session/' + encodeURIComponent(id) + '/note', { ref: ref, text: text }).then(function (rec) {
          if (core.sameSession(id, S.id)) { S.notes.push(rec); renderSide(); }
          toast('Note saved (local only)');
        }).catch(function (e) { toast('Note not saved: ' + e.message); });
      }
    });
  }
  function openEventPicker() {
    if (!S.pack) return;
    openModal('pick', {
      title: 'Missed event at ' + fmt(video.currentTime),
      options: S.pack.entries.map(function (en) { return { label: en.detectorId + '  ' + en.name, entry: en }; }),
      done: function (p) { addEvent(p.entry); }
    });
  }

  // ---------------------------------------------------------------- render
  function renderAll() { renderBanner(); renderTabs(); renderSide(); renderTimeline(); renderTiming(); renderRate(); renderPending(); }
  function renderTabs() {
    $('tab1').setAttribute('aria-current', String(S.pass === 1));
    $('tab2').setAttribute('aria-current', String(S.pass === 2));
    $('trackSug').hidden = S.pass !== 2;
  }
  function renderBanner() {
    var b = $('banner');
    var p2 = S.draft && S.draft.pass2;
    if (S.readOnly) { b.hidden = false; b.textContent = 'Read-only: ' + S.readOnlyWhy + '. Nothing is saved from this tab.'; }
    else if (saver.blocked()) { b.hidden = false; b.textContent = 'AUTOSAVE IS OFF: ' + saver.blocked() + '. Nothing is saved until this is fixed.'; }
    else if (p2 && p2.highlightsEditedAfter) { b.hidden = false; b.textContent = 'Highlights were edited after suggestions were seen. This is recorded in the draft and the export.'; }
    else if (p2 && p2.openedAt && S.pass === 1) { b.hidden = false; b.textContent = 'Pass 2 was already opened for this session. Any highlight change now is recorded as edited after suggestions.'; }
    else b.hidden = true;
  }
  function renderPending() {
    $('pendingInfo').textContent = (S.pendIn != null || S.pendOut != null) ? 'in ' + (S.pendIn != null ? fmt(S.pendIn) : '-') + '  out ' + (S.pendOut != null ? fmt(S.pendOut) : '-') : '';
  }
  function stars(n) { return n ? '*'.repeat(n) : 'no rating'; }
  function renderSide() {
    var body = $('sideBody');
    clear(body);
    if (!S.draft) return;
    if (S.pass === 1) {
      body.appendChild(el('h2', { text: 'Pass 1: highlight windows (blind)' }));
      body.appendChild(el('div', { class: 'muted', text: 'Watch and mark. No detector, chat or audio signals are loaded in this pass. Lobby/menu skip is not offered: no mode data exists in the cache.' }));
      body.appendChild(el('div', { class: 'row' },
        el('button', { type: 'button', text: 'H highlight', on: { click: addHighlight } }),
        el('button', { type: 'button', text: 'Keep (Shift+K)', on: { click: function () { markWindow('keep'); } } }),
        el('button', { type: 'button', text: 'Reject (Shift+X)', on: { click: function () { markWindow('reject'); } } }),
        el('button', { type: 'button', text: 'Tags (T)', on: { click: openTagPicker } }),
        el('button', { type: 'button', text: 'Note (Shift+N)', on: { click: openNote } })));
      var n = S.draft.labels.length;
      body.appendChild(el('div', { text: n + ' window(s): ' + S.draft.labels.filter(function (l) { return l.label === 'keep'; }).length + ' keep, ' + S.draft.labels.filter(function (l) { return l.label === 'reject'; }).length + ' reject' }));
      S.draft.labels.forEach(function (l) {
        var it = el('div', { class: 'item', role: 'option', 'aria-selected': String(Boolean(S.sel && S.sel.kind === 'label' && S.sel.id === l.id)) },
          el('span', { class: 'time', text: fmt(l.windowStartSec) }),
          el('span', { class: 'v-' + l.label, text: l.label + (l.label === 'keep' ? ' ' + stars(l.rating) : '') + '  ' + (l.windowEndSec - l.windowStartSec).toFixed(1) + ' s' }),
          el('span', { class: 'muted', text: l.id }));
        var sub = el('div', { class: 'sub' });
        l.reasonTags.forEach(function (t) { sub.appendChild(el('span', { class: 'tag', text: t })); });
        if (!l.reasonTags.length) sub.textContent = 'no tags';
        var nn = notesFor(l.id).length;
        if (nn) sub.appendChild(el('span', { class: 'muted', text: '  ' + nn + ' note(s)' }));
        it.appendChild(sub);
        it.addEventListener('click', function () { S.sel = { kind: 'label', id: l.id }; seek(l.windowStartSec); renderAll(); });
        body.appendChild(it);
      });
    } else {
      body.appendChild(el('h2', { text: 'Pass 2: events' }));
      if (!S.hasSuggestionsFile) body.appendChild(el('div', { class: 'err', text: 'No suggestions file for this session yet. Add missed events with M, or run tools/label/suggestions.py.' }));
      var list = items();
      var done = list.filter(function (i) { return i.ev; }).length;
      body.appendChild(el('div', { text: list.length + ' item(s), ' + done + ' decided' }));
      body.appendChild(el('div', { class: 'row' },
        el('button', { type: 'button', text: 'Accept (A)', on: { click: function () { decide('accept'); } } }),
        el('button', { type: 'button', text: 'Reject (R)', on: { click: function () { decide('reject'); } } }),
        el('button', { type: 'button', text: 'To playhead (E)', on: { click: moveToPlayhead } }),
        el('button', { type: 'button', text: 'Add missed (M)', on: { click: openEventPicker } }),
        el('button', { type: 'button', text: 'Note (Shift+N)', on: { click: openNote } })));
      list.forEach(function (i) {
        var verdict = i.ev ? i.ev.verdict : 'none';
        var name = i.kind === 'sug' ? i.sug.detectorId + (i.sug.medal ? ' ' + i.sug.medal : '') : i.ev.detectorId + (i.ev.medal ? ' ' + i.ev.medal : '');
        var conf = i.kind === 'sug' && i.sug.confidence != null ? '  conf ' + i.sug.confidence.toFixed(2) : '';
        var row = el('div', { class: 'item' + (i.kind === 'sug' && i.sug.suppressed ? ' suppressed' : ''), role: 'option', 'aria-selected': String(Boolean(S.sel && S.sel.kind === i.kind && S.sel.id === i.id)) },
          el('span', { class: 'time', text: fmt(i.t) }),
          el('span', { text: name + conf }),
          el('span', { class: 'v-' + verdict, text: verdict === 'none' ? 'pending' : verdict }));
        var notes = [];
        if (i.kind === 'sug') {
          var s = i.sug;
          if (s.suppressed) notes.push('suppressed by rule ' + s.suppressed.rule + ' (still shown)');
          if (s.endScreen) notes.push('end screen ' + (s.endScreen.named ? 'named' : 'no name') + (s.endScreen.named ? (s.endScreen.counts ? ', counts once for this match' : ', also named, does not count again') : '') + ' [match group ' + s.endScreen.group + ']');
          if (s.ocrText) notes.push('ocr (local): ' + s.ocrText);
        }
        var nNotes = notesFor(i.id).length + (i.ev && i.ev.id !== i.id ? notesFor(i.ev.id).length : 0);
        if (nNotes) notes.push(nNotes + ' note(s)');
        if (notes.length) row.appendChild(el('div', { class: 'sub', text: notes.join(' | ') }));
        row.addEventListener('click', function () { S.sel = { kind: i.kind, id: i.id }; seek(i.t - LEAD_SEC); renderAll(); });
        body.appendChild(row);
      });
    }
  }

  // ---------------------------------------------------------------- timeline
  var thumbTimer = null;
  function clampView() {
    var d = dur();
    S.view.span = Math.max(20, Math.min(d, S.view.span));
    S.view.start = Math.max(0, Math.min(d - S.view.span, S.view.start));
  }
  function pct(t, v) { return ((t - v.start) / v.span * 100); }
  function renderTimeline() {
    if (!S.manifest) return;
    clampView();
    var d = dur(), v = S.view;
    $('viewInfo').textContent = 'view ' + fmt(v.start).split('.')[0] + ' - ' + fmt(v.start + v.span).split('.')[0] + '  (wheel zooms, click seeks)';
    // overview
    var ov = $('overview'); clear(ov);
    var whole = { start: 0, span: d };
    S.draft.labels.forEach(function (l) {
      ov.appendChild(markNode('tick ' + l.label, whole, l.windowStartSec, l.windowEndSec, true));
    });
    if (S.pass === 2) items().forEach(function (i) { ov.appendChild(markNode('tick sug', whole, i.t, i.t, true)); });
    var vp = el('div', { class: 'vp' }); vp.style.left = pct(v.start, whole) + '%'; vp.style.width = (v.span / d * 100) + '%';
    ov.appendChild(vp);
    ov.appendChild(el('div', { class: 'ohead', id: 'ohead' }));
    // window track
    var tw = $('trackWin'); clear(tw);
    S.draft.labels.forEach(function (l) {
      if (l.windowEndSec < v.start || l.windowStartSec > v.start + v.span) return;
      tw.appendChild(markNode('mark ' + l.label + (S.sel && S.sel.kind === 'label' && S.sel.id === l.id ? ' sel' : ''), v, l.windowStartSec, l.windowEndSec));
    });
    if (S.pendIn != null || S.pendOut != null) {
      var a = S.pendIn != null ? S.pendIn : S.pendOut, b = S.pendOut != null ? S.pendOut : S.pendIn;
      tw.appendChild(markNode('mark pending', v, Math.min(a, b), Math.max(a, b)));
    }
    // suggestion track
    var ts = $('trackSug'); clear(ts);
    if (S.pass === 2) {
      items().forEach(function (i) {
        if (i.t < v.start || i.t > v.start + v.span) return;
        var verdict = i.ev ? i.ev.verdict : 'none';
        var cls = 'mark ' + (i.kind === 'sug' && i.sug.suppressed && !i.ev ? 'suppressed' : verdict) + (S.sel && S.sel.kind === i.kind && S.sel.id === i.id ? ' sel' : '');
        ts.appendChild(markNode(cls, v, i.t, i.t));
      });
    }
    scheduleThumbs();
  }
  function markNode(cls, v, a, b, ov) {
    var n = el('div', { class: cls });
    var left = Math.max(0, pct(a, v)), right = Math.min(100, pct(b, v));
    n.style.left = left + '%';
    n.style.width = Math.max(0, right - left) + '%';
    if (ov && a === b) n.style.width = '';
    return n;
  }
  function scheduleThumbs() { clearTimeout(thumbTimer); thumbTimer = setTimeout(drawThumbs, 250); }
  function drawThumbs() {
    var film = $('film'); clear(film);
    if (!S.id) return;
    var N = 12, v = S.view;
    for (var i = 0; i < N; i++) {
      var t = v.start + (i + 0.5) * v.span / N;
      film.appendChild(el('img', { alt: '', loading: 'lazy', src: srcUrl(base() + '/thumb?t=' + encodeURIComponent(t.toFixed(1))) }));
    }
  }
  function renderPlayhead() {
    if (!S.manifest) return;
    var t = video.currentTime || 0, v = S.view;
    var ph = $('playhead');
    var x = pct(t, v);
    ph.style.display = x < 0 || x > 100 ? 'none' : '';
    ph.style.left = x + '%';
    var oh = $('ohead'); if (oh) oh.style.left = (t / dur() * 100) + '%';
    $('clock').textContent = fmt(t);
    // keep the playhead in view while playing
    if (!video.paused && (x > 95 || x < 0) && !dragging) { S.view.start = t - v.span * 0.1; renderTimeline(); }
  }
  var dragging = false;
  function seekFromDetail(ev) {
    var r = $('detail').getBoundingClientRect();
    seek(S.view.start + Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * S.view.span);
  }
  $('detail').addEventListener('mousedown', function (e) { dragging = true; seekFromDetail(e); });
  window.addEventListener('mousemove', function (e) { if (dragging) seekFromDetail(e); });
  window.addEventListener('mouseup', function () { dragging = false; });
  $('detail').addEventListener('wheel', function (e) {
    e.preventDefault();
    var r = $('detail').getBoundingClientRect();
    var f = (e.clientX - r.left) / r.width;
    var anchor = S.view.start + f * S.view.span;
    S.view.span *= e.deltaY > 0 ? 1.25 : 0.8;
    clampView();
    S.view.start = anchor - f * S.view.span;
    renderTimeline();
  }, { passive: false });
  $('overview').addEventListener('mousedown', function (e) {
    var r = $('overview').getBoundingClientRect();
    var t = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * dur();
    S.view.start = t - S.view.span / 2; seek(t); renderTimeline();
  });
  $('zoomIn').addEventListener('click', function () { var c = video.currentTime; S.view.span *= 0.5; clampView(); S.view.start = c - S.view.span / 2; renderTimeline(); });
  $('zoomOut').addEventListener('click', function () { var c = video.currentTime; S.view.span *= 2; clampView(); S.view.start = c - S.view.span / 2; renderTimeline(); });

  // ---------------------------------------------------------------- header buttons
  $('tab1').addEventListener('click', function () { if (S.pass !== 1) switchPass(); });
  $('tab2').addEventListener('click', function () { if (S.pass !== 2) switchPass(); });
  $('btnSave').addEventListener('click', saveNow);
  $('btnHelp').addEventListener('click', function () { openModal('help', {}); });
  $('sessionSelect').addEventListener('change', function (e) {
    var id = e.target.value, from = S.id; e.target.blur();
    // Switch only after the current draft is saved; on a failed save stay on this session.
    // A read-only tab has nothing of its own to save.
    (S.readOnly ? Promise.resolve(null) : save(true)).then(function () { return openSession(id); }, function (err) {
      $('sessionSelect').value = from;
      toast('Not switching: the draft was not saved (' + err.message + ')');
    });
  });
  $('btnExport').addEventListener('click', function () { doExport(S.id); });
  // Export always asks first. The server's export-preview builds and validates the label file
  // without writing and returns the sha256 of that exact file text (and of the file there now). The
  // dialog shows the diff when a file exists; the export sends both hashes, so the server writes only
  // what was confirmed. When either changed (409 changed-since-preview), the dialog is shown again
  // with the new diff. Autosave is paused (S.exporting) from the save before the preview until the
  // dialog closes.
  function exportFailed(e) {
    S.exporting = false;
    if (e.status === 422) openModal('errors', { title: 'Export refused: labels are invalid', lines: (e.body && e.body.errors) || ['unknown'] });
    else toast('Export failed: ' + e.message);
  }
  function doExport(id) {
    if (!S.draft || !core.sameSession(id, S.id)) { toast(saver.blocked() || 'No draft loaded'); return; }
    if (!canEdit()) return;
    var sb = '/api/session/' + encodeURIComponent(id);
    save(true).then(function () {
      S.exporting = true;
      return api('POST', sb + '/export-preview', {});
    }).then(function (p) { confirmExport(id, sb, p, false); }).catch(exportFailed);
  }
  function confirmExport(id, sb, p, again) {
      if (!core.sameSession(id, S.id)) { S.exporting = false; return; }
      var lines;
      if (!p.exists) lines = ['Write ' + p.labels + ' window(s) and ' + p.events + ' event(s) to the labels folder?'];
      else if (p.existingUnreadable) lines = ['A label file exists but cannot be read; it would be replaced by ' + p.labels + ' window(s) and ' + p.events + ' event(s).'];
      else {
        var d = core.diffLines(p.diff, 40);
        lines = ['A label file already exists. Changes (renumbered ids, session times):'].concat(d.length ? d : ['no differences']);
      }
      if (again) lines.unshift('The draft or the label file changed since the last preview. This is the new preview.');
      lines.push('Enter = ' + (p.exists ? 'overwrite' : 'export') + ', Esc = cancel.');
      openModal('confirm', {
        title: (p.exists ? 'Overwrite ' : 'Export ') + p.file + '?', lines: lines,
        no: function () { S.exporting = false; },
        yes: function () {
          api('POST', sb + '/export', { overwrite: p.exists, sha256: p.sha256, existingSha256: p.existingSha256 }).then(function (r) {
            S.exporting = false;
            toast('Exported ' + r.file + ': ' + r.labels + ' windows, ' + r.events + ' events');
          }).catch(function (e) {
            if (e.status === 409 && e.body && e.body.preview) confirmExport(id, sb, e.body.preview, true); // show the diff again
            else exportFailed(e);
          });
        }
      });
  }

  loadSessionList().catch(function (e) { toast('Load failed: ' + e.message); });
})();
