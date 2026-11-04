// SPDX-License-Identifier: GPL-3.0-or-later
// Minimal RFC 6455 server side for the overlay feed. Node stdlib only.
//
// Scope on purpose: text frames out, small unfragmented masked text frames in (the Streamer.bot "Subscribe" request),
// ping/pong and close. No extensions, no compression, no fragmentation, no binary. Anything else closes the socket.

import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const MAX_IN_PAYLOAD = 16_384;

export function acceptKey(key) {
  return createHash('sha1').update(key + GUID).digest('base64');
}

/** One server-to-client frame (never masked). */
export function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}

export const textFrame = (s) => encodeFrame(0x1, Buffer.from(s, 'utf8'));
export const closeFrame = (code) => { const b = Buffer.alloc(2); b.writeUInt16BE(code); return encodeFrame(0x8, b); };

/** Incremental parser. feed(chunk) returns { frames: [{opcode, payload}], error?: closeCode }. */
export function createParser(maxPayload = MAX_IN_PAYLOAD) {
  let buf = Buffer.alloc(0);
  return function feed(chunk) {
    buf = Buffer.concat([buf, chunk]);
    const frames = [];
    while (buf.length >= 2) {
      const fin = (buf[0] & 0x80) !== 0;
      const rsv = buf[0] & 0x70;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (rsv || !masked) return { frames, error: 1002 };
      if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (buf.length < 10) break;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(maxPayload)) return { frames, error: 1009 };
        len = Number(big); off = 10;
      }
      if (len > maxPayload) return { frames, error: 1009 };
      if (buf.length < off + 4 + len) break;
      const mask = buf.subarray(off, off + 4);
      const data = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
      buf = buf.subarray(off + 4 + len);
      if (!fin || opcode === 0x0 || opcode === 0x2 || opcode > 0xa) return { frames, error: 1003 };
      if (opcode >= 0x8 && len > 125) return { frames, error: 1002 };
      frames.push({ opcode, payload: data });
    }
    return { frames };
  };
}

/** Complete the upgrade on `socket` and return a connection { send(text) -> boolean, close(code), onText(fn), onClose(fn), socket }.
 *  The caller has already checked Host and Origin. Returns null when the handshake headers are not valid. */
export function acceptUpgrade(req, socket, { maxPayload = MAX_IN_PAYLOAD } = {}) {
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(key) || req.headers['sec-websocket-version'] !== '13') return null;
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
  socket.setNoDelay?.(true);
  let closed = false;
  let textFn = () => {};
  let closeFn = () => {};
  const feed = createParser(maxPayload);
  const conn = {
    socket,
    send(text) {
      if (closed) return false;
      try { return socket.write(textFrame(text)); } catch { return false; }
    },
    close(code = 1000) {
      if (closed) return;
      closed = true;
      try { socket.end(closeFrame(code)); } catch { /* gone */ }
      setTimeout(() => socket.destroy(), 500).unref();
    },
    onText(fn) { textFn = fn; },
    onClose(fn) { closeFn = fn; },
    get closed() { return closed; },
  };
  socket.on('data', (chunk) => {
    if (closed) return;
    const r = feed(chunk);
    for (const f of r.frames) {
      if (f.opcode === 0x1) { try { textFn(f.payload.toString('utf8')); } catch { /* a handler bug must not kill the feed */ } }
      else if (f.opcode === 0x9) { try { socket.write(encodeFrame(0xa, f.payload)); } catch { /* gone */ } }
      else if (f.opcode === 0x8) { conn.close(1000); return; }
    }
    if (r.error) conn.close(r.error);
  });
  socket.on('close', () => { closed = true; closeFn(); });
  socket.on('error', () => { try { socket.destroy(); } catch { /* gone */ } });
  return conn;
}
