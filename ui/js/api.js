// SPDX-License-Identifier: GPL-3.0-or-later
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
        if (!r.ok) { var err = new Error((j && j.error) || t || ('http-' + r.status)); err.status = r.status; err.detail = j && typeof j.detail === 'string' ? j.detail : null; throw err; }
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
    readiness: function () { return request('GET', '/ui/api/readiness'); },
    endAll: function () { return request('POST', '/ui/api/streams/end-all', {}); },
    flags: function () { return request('GET', '/ui/api/flags'); },
    setFlag: function (id, on) { return request('POST', '/ui/api/flags/set', { id: id, on: on }); },
    feedback: function () { return request('GET', '/ui/api/feedback'); },
    saveNote: function (id, text, tag, severity) { return request('POST', '/ui/api/feedback/note', { id: id, text: text, tag: tag, severity: severity }); },
    bots: function () { return request('GET', '/ui/api/bots'); },
    botStart: function (bot) { return request('POST', '/ui/api/bots/start', { bot: bot }); },
    botStop: function (bot) { return request('POST', '/ui/api/bots/stop', { bot: bot }); },
    reportUrl: function (title, note) { return request('GET', '/ui/api/report-url?title=' + encodeURIComponent(title || '') + '&note=' + encodeURIComponent(note || '')); },
    posts: function () { return request('GET', '/ui/api/posts'); },
    postsAuto: function () { return request('GET', '/ui/api/posts/auto'); },
    postMediaUrl: function (id, kind) { return '/ui/api/posts/media?id=' + encodeURIComponent(id) + '&kind=' + encodeURIComponent(kind); },
    postEdit: function (id, fields) { var b = { id: id }; Object.keys(fields).forEach(function (k) { b[k] = fields[k]; }); return request('POST', '/ui/api/posts/edit', b); },
    postStatus: function (id, status) { return request('POST', '/ui/api/posts/status', { id: id, status: status }); },
    ytStatus: function () { return request('GET', '/ui/api/posts/youtube/status'); },
    ytUpload: function (id, confirm) { return request('POST', '/ui/api/posts/youtube/upload', { id: id, confirm: confirm }); },
    ytCheck: function (id) { return request('POST', '/ui/api/posts/youtube/check', { id: id }); },
    postOpen: function (id) { return request('POST', '/ui/api/posts/open', { id: id }); },
    edits: function () { return request('GET', '/ui/api/edits'); },
    structure: function () { return request('GET', '/ui/api/project/structure'); },
    transitions: function () { return request('GET', '/ui/api/project/transitions'); },
    setTransition: function (body) { return request('POST', '/ui/api/project/transition', body); },
    structureEdit: function (body) { return request('POST', '/ui/api/project/structure', body); },
    undo: function () { return request('POST', '/ui/api/edits/undo', {}); },
    redo: function () { return request('POST', '/ui/api/edits/redo', {}); },
    events: function (onStatus, onState, onFlags, onEdits) {
      var es = new EventSource('/ui/api/events');
      if (onFlags) es.addEventListener('flags', function (e) { try { onFlags(JSON.parse(e.data)); } catch (x) { /* ignore a bad frame */ } });
      if (onEdits) es.addEventListener('edits', function (e) { try { onEdits(JSON.parse(e.data)); } catch (x) { /* ignore a bad frame */ } });
      es.addEventListener('status', function (e) { try { onStatus(JSON.parse(e.data)); } catch (x) { /* ignore a bad frame */ } });
      es.onopen = function () { onState(true); };
      es.onerror = function () { onState(false); };
      return es;
    }
  };
})();
