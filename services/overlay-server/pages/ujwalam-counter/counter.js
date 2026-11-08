// SPDX-License-Identifier: GPL-3.0-or-later
// Audience counter page logic (D250). Plain script, no CDN, safe DOM (textContent only). Loaded by index.html as a
// global (UjwCounter); tests run it in a vm context.
(function (root) {
  'use strict';

  var PLATFORMS = ['twitch', 'youtube', 'kick'];
  var COUNTERS = ['followers', 'subscribers'];
  var TEXT_MAX = 40;

  // search: location.search. Returns null when the platform or counter is not one we know (nothing is shown).
  function parseParams(search) {
    var q = new URLSearchParams(search || '');
    var platform = String(q.get('platform') || '');
    var counter = String(q.get('counter') || '');
    if (PLATFORMS.indexOf(platform) < 0 || COUNTERS.indexOf(counter) < 0) return null;
    return {
      platform: platform,
      counter: counter,
      label: String(q.get('label') || '').trim().slice(0, TEXT_MAX),
      noun: String(q.get('noun') || '').trim().slice(0, TEXT_MAX),
    };
  }

  // The value to show from a /_ujwalam/counters.json answer, or null (hidden): flag off, not read yet, or junk.
  function pick(json, p) {
    if (!json || json.on !== true || !json.counters || typeof json.counters !== 'object') return null;
    var m = json.counters[p.platform];
    var v = m && typeof m === 'object' ? m[p.counter] : undefined;
    return typeof v === 'number' && isFinite(v) && v >= 0 && Math.floor(v) === v ? v : null;
  }

  // "Twitch 339 Followers": label and noun around the number; either may be empty.
  function text(p, v) {
    return [p.label, String(v), p.noun].filter(function (s) { return s !== ''; }).join(' ');
  }

  // Shows/updates the counter. el gets the text and the is-on class; a change gets is-bump for one short pulse.
  function render(el, p, v) {
    if (v === null) { el.classList.remove('is-on'); return; }
    var t = text(p, v);
    if (el.textContent !== t) {
      var wasOn = el.classList.contains('is-on') && el.textContent !== '';
      el.textContent = t;
      if (wasOn) { el.classList.remove('is-bump'); void el.offsetWidth; el.classList.add('is-bump'); }
    }
    el.classList.add('is-on');
  }

  // Largest font (60 % of the box height) at which the text fits the box width.
  function fit(el, win) {
    var size = Math.max(10, Math.floor((el.clientHeight || win.innerHeight || 60) * 0.6));
    el.style.fontSize = size + 'px';
    var guard = 60;
    while (el.scrollWidth > el.clientWidth + 1 && size > 10 && guard-- > 0) { size -= 2; el.style.fontSize = size + 'px'; }
  }

  // Polls the overlay server every intervalMs; a failed read keeps what is shown.
  function run(p, doc, win, intervalMs) {
    var el = doc.getElementById('counter');
    function tick() {
      win.fetch('/_ujwalam/counters.json', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { if (!j) return; var before = el.textContent; render(el, p, pick(j, p)); if (el.textContent !== before) fit(el, win); })
        .catch(function () { /* keep what is shown */ });
    }
    tick();
    return win.setInterval(tick, intervalMs);
  }

  root.UjwCounter = { parseParams: parseParams, pick: pick, text: text, render: render, fit: fit, run: run };
})(typeof window !== 'undefined' ? window : globalThis);
