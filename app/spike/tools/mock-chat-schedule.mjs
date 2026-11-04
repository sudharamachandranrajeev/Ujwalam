// SPDX-License-Identifier: GPL-3.0-or-later
// Scheduled pretend Streamer.bot for overlay timing tests (cooldown, flash rate). Same envelope
// as legacy/tools/mock-streamerbot.mjs, Node built-ins only. Chat text is synthetic.
//
//   node mock-chat-schedule.mjs --port 8095 --clients 2 --delay 6000 \
//     --schedule 300x20,gap3000,1200x8,gap3000,1600x5 [--log FILE]
//
// Waits until --clients clients have subscribed, waits --delay ms, then sends one
// Twitch.ChatMessage per step: "<interval>x<count>" sends <count> messages <interval> ms apart
// (the first one immediately), "gap<ms>" waits. Send times are scheduled from one start time, so
// they do not drift. Every send is logged as a JSON line with its UTC wall-clock time in ms.
// Exits 2 s after the last send.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : d; };
const PORT = Number(arg('port', 8095));
const CLIENTS = Number(arg('clients', 1));
const DELAY = Number(arg('delay', 3000));
const LOG = arg('log', '');
const SCHEDULE = arg('schedule', '300x20,gap3000,1200x8,gap3000,1600x5');

function log(obj) {
  const line = JSON.stringify({ t: new Date().toISOString(), ms: Date.now(), ...obj });
  console.log(line);
  if (LOG) appendFileSync(LOG, line + '\n');
}

// Offsets (ms from the start of the schedule) and the phase each send belongs to.
const plan = [];
let at = 0;
for (const step of SCHEDULE.split(',').map((s) => s.trim()).filter(Boolean)) {
  const gap = /^gap(\d+)$/.exec(step);
  const run = /^(\d+)x(\d+)$/.exec(step);
  if (gap) { at += Number(gap[1]); continue; }
  if (!run) { console.error('bad step ' + step); process.exit(1); }
  const every = Number(run[1]), count = Number(run[2]);
  for (let n = 0; n < count; n++) { plan.push({ at, phase: `${every}ms`, n }); if (n < count - 1) at += every; }
  at += every; // the next step starts one interval after this run's last send
}

const clients = new Set();
let subscribed = 0;

function send(sock, obj) {
  const payload = Buffer.from(JSON.stringify(obj));
  let header;
  if (payload.length < 126) header = Buffer.from([0x81, payload.length]);
  else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.length, 2); }
  sock.write(Buffer.concat([header, payload]));
}

function parseFrames(sock, buf) {
  while (buf.length >= 2) {
    const op = buf[0] & 0x0f; let len = buf[1] & 0x7f; let off = 2;
    if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
    const masked = buf[1] & 0x80; const maskOff = off; if (masked) off += 4;
    if (buf.length < off + len) break;
    let data = buf.subarray(off, off + len);
    if (masked) { const mask = buf.subarray(maskOff, maskOff + 4); data = Buffer.from(data.map((b, i) => b ^ mask[i % 4])); }
    buf = buf.subarray(off + len);
    if (op === 8) { sock.end(); clients.delete(sock); return Buffer.alloc(0); }
    if (op === 9) { sock.write(Buffer.from([0x8a, 0])); continue; }
    if (op === 1) {
      let m; try { m = JSON.parse(data.toString('utf8')); } catch { continue; }
      if (m.request === 'Subscribe') {
        send(sock, { id: m.id, status: 'ok', events: m.events || {} });
        subscribed++;
        log({ ev: 'subscribed', clients: subscribed });
        if (subscribed === CLIENTS) setTimeout(run, DELAY);
      } else if (m.request) send(sock, { id: m.id, status: 'ok' });
    }
  }
  return buf;
}

function emit(p, k) {
  const ms = Date.now(); // taken before the socket writes; logged as the send time
  const data = { messageId: `p-${k}`, text: `parity test ${k}`, user: { id: '1', login: 'tester', name: 'Tester' }, isTest: true };
  const msg = { timeStamp: new Date().toISOString(), event: { source: 'Twitch', type: 'ChatMessage' }, data };
  for (const s of clients) send(s, msg);
  log({ ev: 'send', ms, k, phase: p.phase, n: p.n, plannedOffset: p.at, clients: clients.size });
}

function run() {
  const t0 = Date.now();
  log({ ev: 'schedule-start', sends: plan.length, schedule: SCHEDULE });
  let k = 0;
  const tick = () => {
    while (k < plan.length && Date.now() - t0 >= plan[k].at) { emit(plan[k], k); k++; }
    if (k < plan.length) setTimeout(tick, Math.max(0, Math.min(5, plan[k].at - (Date.now() - t0))));
    else setTimeout(() => { log({ ev: 'done' }); process.exit(0); }, 2000);
  };
  tick();
}

const server = createServer((req, res) => { res.writeHead(426); res.end('WebSocket only'); });
server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  clients.add(sock);
  log({ ev: 'connected', clients: clients.size });
  send(sock, { timeStamp: new Date().toISOString(), request: 'Hello', session: 'mock-session', info: { name: 'mock-chat-schedule', os: 'windows', mode: 'ui' } });
  let pending = Buffer.alloc(0);
  sock.on('data', (chunk) => { pending = parseFrames(sock, Buffer.concat([pending, chunk])); });
  sock.on('close', () => { clients.delete(sock); log({ ev: 'gone', clients: clients.size }); });
  sock.on('error', () => clients.delete(sock));
});
server.listen(PORT, '127.0.0.1', () => log({ ev: 'listening', port: PORT, plannedSends: plan.length, plannedSpanMs: at }));
