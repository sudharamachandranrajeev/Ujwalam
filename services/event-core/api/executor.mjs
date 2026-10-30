// SPDX-License-Identifier: GPL-2.0-or-later
// Action executor for the event-core service (P3 E6). Node stdlib only.
//
// The gate calls execute(action) only after an allow (reads) or an accepted confirmation. P3 has one real action:
// chat.raw.purge (delete stored raw chat text). Studio actions arrive with the app (P4/P6): until then, outside mock
// mode they fail with 'no-handler' instead of pretending to succeed; in mock mode they return { mock: true }.

export function createServiceExecutor({ getCore, mock = false, onCall = () => {} }) {
  return {
    execute(act) {
      onCall(act);
      if (act.id === 'chat.raw.purge') {
        const p = act.params ?? {};
        const keys = Object.keys(p);
        if (keys.some((k) => k !== 'all' && k !== 'olderThanDays')) throw new Error('bad-params');
        if (p.all !== undefined && p.all !== true) throw new Error('bad-params');
        if (p.olderThanDays !== undefined && !(typeof p.olderThanDays === 'number' && Number.isFinite(p.olderThanDays) && p.olderThanDays >= 0)) throw new Error('bad-params');
        if (p.all === true && p.olderThanDays !== undefined) throw new Error('bad-params');
        const audit = getCore()?.audit;
        if (!audit) throw new Error('audit-unavailable');
        return audit.purge({ all: p.all === true, olderThanDays: p.olderThanDays, mode: 'api' }).then((r) => ({ purged: r.purged, all: r.all }));
      }
      if (mock) return { mock: true };
      throw new Error('no-handler');
    },
  };
}
