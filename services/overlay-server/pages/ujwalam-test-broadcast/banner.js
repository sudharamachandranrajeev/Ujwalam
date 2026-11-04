// SPDX-License-Identifier: GPL-3.0-or-later
// Test-broadcast banner logic (BM3, D196). Plain script, no CDN, safe DOM (text is set with textContent only).
// Loaded by index.html as a global (TestBroadcast); tests run it in a vm context.
(function (root) {
  'use strict';

  // Safe ranges. Same numbers as registry/functions/timed-banner.json (a test keeps the two in step).
  var RANGES = {
    interval: { min: 60, max: 3600, def: 900 },  // seconds between showings
    hold: { min: 5, max: 60, def: 18 },          // seconds visible
    enter: { min: 100, max: 550, def: 450 },     // entrance ms (limit 600)
    exit: { min: 100, max: 350, def: 300 },      // exit ms (limit 400)
  };
  var TEXT_MAX = 200;
  var LABEL_MAX = 60;

  function clampNum(raw, r) {
    var n = raw === null || raw === '' || raw === undefined ? NaN : Number(raw);
    if (!isFinite(n)) return r.def;
    return Math.min(r.max, Math.max(r.min, n));
  }

  // search: location.search. Returns null when there is no text (nothing is shown).
  function parseParams(search) {
    var q = new URLSearchParams(search || '');
    var text = String(q.get('text') || '').trim().slice(0, TEXT_MAX);
    if (!text) return null;
    return {
      label: String(q.get('label') || '').trim().slice(0, LABEL_MAX),
      text: text,
      interval: clampNum(q.get('interval'), RANGES.interval),
      hold: clampNum(q.get('hold'), RANGES.hold),
      enter: clampNum(q.get('enter'), RANGES.enter),
      exit: clampNum(q.get('exit'), RANGES.exit),
    };
  }

  // The inverse: preset params -> layer query string (what the scene presets carry).
  function buildQuery(p) {
    var parts = [];
    ['label', 'text', 'interval', 'hold', 'enter', 'exit', 'flag'].forEach(function (k) {
      parts.push(k + '=' + encodeURIComponent(String(p[k])));
    });
    return parts.join('&');
  }

  // Showing times (ms from load) inside a span; the first is 0. Used by tests; the page uses timers.
  function schedule(p, spanMs) {
    var out = [];
    for (var t = 0; t <= spanMs; t += p.interval * 1000) out.push(t);
    return out;
  }

  // Shrinks the font until the text fits the box (height).
  function fit(doc, win, el) {
    var h = el.clientHeight || win.innerHeight || 100;
    var size = Math.max(10, Math.floor(h * 0.3));
    el.style.fontSize = size + 'px';
    var guard = 40;
    while (el.scrollHeight > el.clientHeight + 1 && size > 10 && guard-- > 0) {
      size = Math.floor(size * 0.92);
      el.style.fontSize = size + 'px';
    }
    var label = doc.getElementById('label');
    if (label) label.style.fontSize = Math.max(10, Math.floor(size * 0.62)) + 'px';
  }

  function run(p, doc, win) {
    var banner = doc.getElementById('banner');
    var label = doc.getElementById('label');
    var text = doc.getElementById('text');
    if (!banner || !text) return null;
    label.textContent = p.label;
    label.style.display = p.label ? '' : 'none';
    text.textContent = p.text;
    banner.style.setProperty('--enter', p.enter + 'ms');
    banner.style.setProperty('--exit', p.exit + 'ms');
    var timers = [];
    var on = false;
    function later(fn, ms) { timers.push(win.setTimeout(fn, ms)); }
    function clearAll() { timers.forEach(function (t) { win.clearTimeout(t); }); timers = []; }
    function show() {
      fit(doc, win, banner);
      banner.classList.remove('is-leaving');
      banner.classList.add('is-on');
      later(hide, p.hold * 1000);
    }
    function hide() {
      if (!banner.classList.contains('is-on')) return;
      banner.classList.add('is-leaving');
      banner.classList.remove('is-on');
    }
    function cycle() { show(); later(cycle, p.interval * 1000); }
    // setOn(true): shown now, then every interval. setOn(false): hidden now (exit motion), nothing scheduled.
    function setOn(v) {
      v = v === true;
      if (v === on) return;
      on = v;
      clearAll();
      if (on) cycle(); else hide();
    }
    return { setOn: setOn, isOn: function () { return on; }, stop: function () { clearAll(); on = false; } };
  }

  // Live gate (D196): the feature flag named by the `flag` query value, read from the overlay server's
  // /_ujwalam/flags.json every pollMs. Any failure (server without the route, bad answer) reads as off.
  function parseFlag(search) {
    var f = String(new URLSearchParams(search || '').get('flag') || '');
    return /^[a-z][a-z0-9-]{0,47}$/.test(f) ? f : '';
  }
  function flagOn(state, id) { return !!state && typeof state === 'object' && state[id] === true; }
  function watchFlag(id, ctl, win, pollMs) {
    function poll() {
      win.fetch('/_ujwalam/flags.json', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (s) { ctl.setOn(flagOn(s, id)); }, function () { ctl.setOn(false); });
    }
    poll();
    return win.setInterval(poll, pollMs || 5000);
  }

  var api = { RANGES: RANGES, TEXT_MAX: TEXT_MAX, parseParams: parseParams, buildQuery: buildQuery, schedule: schedule, run: run, parseFlag: parseFlag, flagOn: flagOn, watchFlag: watchFlag };
  root.TestBroadcast = api;
})(typeof window !== 'undefined' ? window : globalThis);
