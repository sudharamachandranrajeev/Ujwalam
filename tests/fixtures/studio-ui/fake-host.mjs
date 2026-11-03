// SPDX-License-Identifier: GPL-2.0-or-later
// Fake ujwalam-host for the launcher tests (services/studio-ui/launch.mjs --host-exe <this file>). No libobs, no
// devices, no GPU. It records its argv, the NAMES of its UJWALAM_* environment variables and whether an event-core
// token came in (never the value), and the RPC calls it got, into the file named by UJWALAM_FAKE_HOST_RECORD.
// devices.list answers from UJWALAM_FAKE_HOST_DEVICES (a devices.list fixture), only with --allow-devices.
import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const token = process.env.UJWALAM_HOST_TOKEN ?? '';
const eventToken = process.env.UJWALAM_EVENT_CORE_API_TOKEN ?? '';
const record = {
  argv,
  envNames: Object.keys(process.env).filter((k) => k.startsWith('UJWALAM_')).sort(),
  eventTokenOk: /^[0-9a-f]{64}$/.test(eventToken),
  eventTokenInArgv: eventToken !== '' && argv.some((a) => a.includes(eventToken)),
  hostTokenInArgv: token !== '' && argv.some((a) => a.includes(token)),
  calls: [],
};
delete process.env.UJWALAM_HOST_TOKEN;
delete process.env.UJWALAM_EVENT_CORE_API_TOKEN;
const save = () => writeFileSync(process.env.UJWALAM_FAKE_HOST_RECORD, JSON.stringify(record, null, 2));
save();

const methods = {
  'host.shutdown': () => { setTimeout(() => { save(); process.exit(0); }, 50); return { shuttingDown: true }; },
  'overlay.status': () => ({ state: 'ready', staticPort: 50101, feedPort: 50102, eventFeed: argv.includes('--overlay-events-url'), childHasEventToken: record.eventTokenOk, browserAllowed: argv.includes('--allow-browser') }),
  'overlay.stats': () => ({ clients: 3, chatFrames: 7, busFrames: 2, effects: 0, effectsBlocked: 0, chatEffects: 0, chatGated: 0, slowDropped: 0, refused: 0 }),
  'devices.list': () => {
    if (!argv.includes('--allow-devices')) { const e = new Error('devices are disabled'); e.code = -32001; throw e; }
    return JSON.parse(readFileSync(process.env.UJWALAM_FAKE_HOST_DEVICES, 'utf8'));
  },
  'project.load': (p) => {
    const layers = p.project.scenes.flatMap((s) => s.layers);
    record.load = {
      scenes: p.project.scenes.length,
      layers: layers.length,
      browserLayers: layers.filter((l) => l.type === 'browser').length,
      captureLayers: layers.filter((l) => l.type === 'capture').length,
      browserUrls: Object.keys(p.browserUrls ?? {}).length,
      urlsOk: Object.values(p.browserUrls ?? {}).every((u) => u.startsWith('http://127.0.0.1:50101/overlays/')),
      relayScope: p.relayScope ?? null,
      bases: Object.keys(p.bases ?? {}).sort(),
      skipUnavailable: p.skipUnavailable === true,
    };
    return { built: { scenes: p.project.scenes.length, layers: layers.length }, unavailable: [], warnings: [] };
  },
  'preview.list': () => ({ previews: (arg('--preview') ?? '').split(',').filter(Boolean).map((c) => ({ canvas: c.toUpperCase(), open: true })) }),
  'log.tail': () => ({ lines: [], total: 0, capacity: 1000 }),
};

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); res.end(); return; }
    let m;
    try { m = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400); res.end(); return; }
    record.calls.push(m.method);
    save();
    const fn = methods[m.method];
    try {
      send({ jsonrpc: '2.0', id: m.id, result: fn ? fn(m.params ?? {}) : {} });
    } catch (e) {
      send({ jsonrpc: '2.0', id: m.id, error: { code: e.code ?? -32603, message: e.message } });
    }
  });
});
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  console.log(`fake host: rpc on 127.0.0.1:${port}`);
  writeFileSync(arg('--discovery'), JSON.stringify({ port, pid: process.pid, startedAt: new Date().toISOString(), token: null, path: '/rpc', apiVersion: 1 }) + '\n');
});
