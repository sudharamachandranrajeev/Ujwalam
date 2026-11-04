// SPDX-License-Identifier: GPL-3.0-or-later
// A6 labelling page: logic with no DOM, shared by label.js and tests/label-server.test.mjs.
// Plain script (no module syntax): in the page it sets LabelCore on the global object; under Node
// (tests, through node:vm) it sets module.exports.
(function (root) {
  'use strict';

  // Draft saves, one at a time.
  // - Every save() is chained on one promise, so a save never starts while another is in flight.
  // - save() rejects when its save fails (or the saver is blocked); callers stop and show the error.
  // - Dirty is an edit counter: a save that completes marks clean only the edits made before it was
  //   sent. Edits made while it was in flight stay dirty.
  // - reset() starts a new session; a save from the previous session that completes later does not
  //   touch the new counters.
  // - block(why, kind) stops all saves; unblock(kind) lifts it only when the block is of that kind, so
  //   gaining the lock ('read-only') never lifts a "draft changed elsewhere" or "draft not loaded" block
  //   (review H1: after F5 the new tab waited for the old tab's release, then got the lock, and its
  //   autosave stayed off silently).
  function createSaver() {
    var chain = Promise.resolve();
    var edits = 0, saved = 0, gen = 0, blockedWhy = null, blockedKind = null;
    return {
      edit: function () { edits++; },
      dirty: function () { return edits !== saved; },
      blocked: function () { return blockedWhy; },
      blockedKind: function () { return blockedKind; },
      // A 'changed' or 'draft-load' block is never turned into 'read-only' (review round 4, R8): a
      // heartbeat that finds the lock gone must not replace it, or a later writer reply would lift it.
      block: function (why, kind) {
        kind = kind || 'other';
        if (blockedWhy !== null && kind === 'read-only' && (blockedKind === 'changed' || blockedKind === 'draft-load')) return false;
        blockedWhy = String(why); blockedKind = kind;
        return true;
      },
      unblock: function (kind) {
        if (blockedWhy === null || blockedKind !== kind) return false;
        blockedWhy = null; blockedKind = null;
        return true;
      },
      reset: function () { gen++; edits = 0; saved = 0; blockedWhy = null; blockedKind = null; },
      // send() is called when this save's turn comes and returns a promise of the server reply.
      // Resolves with the reply, or null when there was nothing to save.
      save: function (send) {
        var run = chain.then(function () {
          if (blockedWhy) throw new Error(blockedWhy);
          var mark = edits, g = gen;
          if (mark === saved) return null;
          return Promise.resolve(send()).then(function (reply) {
            if (g === gen && mark > saved) saved = mark;
            return reply;
          });
        });
        chain = run.catch(function () { /* the next save still runs; this one's caller sees the error */ });
        return run;
      },
      // Runs fn() in the same queue (after pending saves, before later ones), for a request that
      // changes the stored draft, such as opening pass 2. Rejects like save().
      queue: function (fn) {
        var run = chain.then(function () {
          if (blockedWhy) throw new Error(blockedWhy);
          return fn();
        });
        chain = run.catch(function () { /* keep the queue alive */ });
        return run;
      }
    };
  }

  // True when Enter or Space reaches a focused button outside a modal. The page ignores the key
  // (no shortcut, no button activation), so a header button cannot repeat its action.
  function isButtonActivationKey(target, modalOpen, key) {
    return !modalOpen && !!target && target.tagName === 'BUTTON' && (key === 'Enter' || key === ' ' || key === 'Spacebar');
  }

  // An async result applies only while the session it was started for is still the open one.
  function sameSession(startedFor, current) { return startedFor != null && startedFor === current; }

  // The per-launch token from the page URL (?t=<64 hex>), or null.
  function readToken(search) {
    var m = /[?&]t=([0-9a-f]{64})(?:&|$)/.exec(String(search || ''));
    return m ? m[1] : null;
  }
  // A tab id (hex) from random bytes (crypto.getRandomValues in the page).
  function tabId(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return s;
  }
  // -> list names ('labels', 'events') that a save would take from non-empty to empty.
  // saved: { labels: n, events: n } counts of the last saved draft.
  function wouldEmpty(saved, draft) {
    var out = [];
    ['labels', 'events'].forEach(function (k) {
      if (saved && saved[k] > 0 && !((draft && draft[k]) || []).length) out.push(k);
    });
    return out;
  }
  // "Add highlight" guard: a repeat within ms at (nearly) the same playhead is ignored.
  function createRepeatGuard(ms, eps) {
    var lastT = null, lastAt = -Infinity;
    return {
      accept: function (t, now) {
        if (lastT !== null && now - lastAt < ms && Math.abs(t - lastT) <= eps) return false;
        lastT = t; lastAt = now;
        return true;
      }
    };
  }
  // Diff from POST export-preview -> lines for the confirm dialog (ids and times only). Items are
  // matched on their times (labels-export.mjs), so a moved highlight is "removed" plus "added".
  function diffLines(diff, max) {
    if (!diff) return [];
    var lines = [];
    var t = function (x) { return typeof x === 'number' ? x.toFixed(3) + ' s' : '?'; };
    diff.added.forEach(function (x) { lines.push('added ' + x.kind + ' ' + x.id + ' at ' + t(x.timeSec)); });
    diff.removed.forEach(function (x) { lines.push('removed ' + x.kind + ' ' + x.id + ' at ' + t(x.timeSec)); });
    diff.changed.forEach(function (x) { lines.push('changed ' + x.kind + ' ' + x.id + ' at ' + t(x.timeSec) + (x.wasId && x.wasId !== x.id ? ' (was ' + x.wasId + ')' : '')); });
    if (max && lines.length > max) { var n = lines.length - max; lines = lines.slice(0, max); lines.push('... and ' + n + ' more'); }
    return lines;
  }

  // A POST lock reply -> what the page does. Also blocks or unblocks the saver:
  //   writer  -> the tab may save: a read-only block is lifted (other blocks stay). reload is true when
  //              the lock came on a retry (tries > 0): the previous tab's final save may have landed
  //              during its release grace, after this tab read the draft, so the page reloads the
  //              draft before any save (review round 4, R1).
  //   retry   -> the previous tab is releasing: read-only for now, ask again after r.retryMs
  //   stale   -> read-only; the page offers a take-over (only after the user confirms)
  //   held    -> read-only: another live tab or launch has the session
  // -> { action, readOnly, why, retryMs?, reload? }
  function lockReply(saver, r, tries, maxTries) {
    if (r && r.writer) { saver.unblock('read-only'); return { action: 'writer', readOnly: false, why: '', reload: (tries || 0) > 0 }; }
    var out;
    if (r && r.retryMs && (tries || 0) < maxTries) out = { action: 'retry', readOnly: true, why: 'waiting for the previous tab to release the session', retryMs: r.retryMs };
    else if (r && r.stale) out = { action: 'stale', readOnly: true, why: 'a stale lock from another tab or launch is on this session' };
    else out = { action: 'held', readOnly: true, why: 'another tab or launch has this session open' };
    saver.block('read-only: ' + out.why, 'read-only');
    return out;
  }
  // Tab close (review M5): prompt when anything is unsaved or saving is off; send the final save at
  // pagehide only when it can be sent: dirty, not blocked, and small enough for fetch keepalive
  // (browsers cap keepalive bodies at about 64 KiB in flight). sendBeacon is not used (see server.mjs).
  function unloadPlan(saver, bodyBytes, keepaliveMax) {
    var dirty = saver.dirty(), blocked = saver.blocked();
    return { prompt: dirty || !!blocked, send: dirty && !blocked && bodyBytes <= keepaliveMax };
  }

  var api = {
    createSaver: createSaver, isButtonActivationKey: isButtonActivationKey, sameSession: sameSession,
    readToken: readToken, tabId: tabId, wouldEmpty: wouldEmpty, createRepeatGuard: createRepeatGuard, diffLines: diffLines,
    lockReply: lockReply, unloadPlan: unloadPlan
  };
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else root.LabelCore = api;
})(this);
