// SPDX-License-Identifier: GPL-2.0-or-later
// Overlay relay script: bridge feed -> BroadcastChannel 'rp-events'. Plain script, no CDN, no DOM output.
// UNVERIFIED: that every browser source in the libobs (CEF) session shares one BroadcastChannel scope. If it does
// not, the host posts the same { rp: 'event', type, data } object into each page instead (window.postMessage).
(function () {
  'use strict';

  var TYPES = ['effect', 'follow', 'sub', 'gift', 'raid', 'member', 'donation'];
  var q = new URLSearchParams(location.search);
  var port = parseInt(q.get('feed') || '', 10);
  var scope = q.get('scope') === 'display' ? '/display' : '/';
  if (!(port > 0 && port < 65536)) { console.warn('[relay] ?feed=<port> is required'); return; }

  var channel = null;
  try { channel = new BroadcastChannel('rp-events'); } catch (err) { console.warn('[relay] no BroadcastChannel'); return; }

  function plain(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

  var retry = 1000;
  function open() {
    var ws;
    try { ws = new WebSocket('ws://127.0.0.1:' + port + scope); } catch (err) { later(); return; }
    ws.onopen = function () { retry = 1000; };
    ws.onmessage = function (e) {
      var m;
      try { m = JSON.parse(e.data); } catch (err) { return; }
      if (!plain(m) || m.rp !== 'event' || TYPES.indexOf(m.type) === -1 || !plain(m.data)) return;
      channel.postMessage({ rp: 'event', type: m.type, data: m.data });
    };
    ws.onclose = later;
    ws.onerror = function () { /* onclose retries */ };
  }
  function later() { setTimeout(open, retry); retry = Math.min(retry * 1.6, 15000); }
  open();
})();
