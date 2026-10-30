// SPDX-License-Identifier: GPL-2.0-or-later
// Same-origin client for the studio UI server. The page holds only the CSRF value from /ui/api/session; the session
// cookie is HttpOnly and no backend token ever reaches this page.
(function () {
  'use strict';
  var csrf = null;

  function request(method, path, body) {
    var opts = { method: method, credentials: 'same-origin', headers: {} };
    if (method === 'POST') {
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['X-Ujwalam-Csrf'] = csrf || '';
      opts.body = JSON.stringify(body || {});
    }
    return fetch(path, opts).then(function (r) {
      return r.text().then(function (t) {
        var j = null;
        try { j = t ? JSON.parse(t) : null; } catch (e) { j = null; }
        if (!r.ok) { var err = new Error((j && j.error) || t || ('http-' + r.status)); err.status = r.status; throw err; }
        return j;
      });
    });
  }

  window.Api = {
    session: function () { return request('GET', '/ui/api/session').then(function (s) { csrf = s.csrf; return s; }); },
    status: function () { return request('GET', '/ui/api/status'); },
    host: function (method, params) { return request('POST', '/ui/api/host', { method: method, params: params || {} }); },
    importMeld: function () { return request('POST', '/ui/api/project/import-meld', {}); },
    projectLoad: function (skipUnavailable) { return request('POST', '/ui/api/project/load', skipUnavailable ? { skipUnavailable: true } : {}); },
    coreRequest: function (id, params) { return request('POST', '/ui/api/core/request', { id: id, params: params || {} }); },
    confirm: function (pendingId, text) { return request('POST', '/ui/api/confirm', { pendingId: pendingId, text: text }); },
    cancel: function (pendingId) { return request('POST', '/ui/api/cancel', { pendingId: pendingId }); },
    events: function (onStatus, onState) {
      var es = new EventSource('/ui/api/events');
      es.addEventListener('status', function (e) { try { onStatus(JSON.parse(e.data)); } catch (x) { /* ignore a bad frame */ } });
      es.onopen = function () { onState(true); };
      es.onerror = function () { onState(false); };
      return es;
    }
  };
})();
