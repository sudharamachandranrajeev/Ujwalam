// SPDX-License-Identifier: GPL-2.0-or-later
// Minimal ZIP writer and reader (stdlib only: node:zlib deflate-raw and crc32). No Zip64: the writer refuses an entry
// or an archive over 4 GiB - 1 and more than 65535 entries, which the alpha package and the diagnostics bundle never
// reach. Names are stored with forward slashes and the UTF-8 flag; every entry gets the same fixed DOS time (from
// `mtime`) so a rebuild of the same inputs gives the same bytes.
//   writeZip(outFile, entries, { mtime }) -> { entries, bytes }
//     entries: [{ name, file } | { name, data: Buffer|string }]; a file is read once, stored if deflate does not help.
//   readZip(file) -> [{ name, method, crc, compressedSize, size, offset }]
//   extractEntry(file, entry) -> Buffer (crc checked)
import { closeSync, openSync, readFileSync, readSync, renameSync, statSync, writeSync, fstatSync } from 'node:fs';
import zlib from 'node:zlib';

const MAX32 = 0xffffffff;
const crc32 = (buf) => zlib.crc32(buf) >>> 0;

function dosTime(d) {
  const t = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const day = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time: t & 0xffff, date: day & 0xffff };
}

function checkName(name) {
  if (typeof name !== 'string' || !name || name.length > 1024) throw new Error('zip: bad entry name');
  if (name.includes('\\') || name.startsWith('/') || /(^|\/)\.\.?(\/|$)/.test(name) || /\/\//.test(name) || name.endsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw new Error(`zip: unsafe entry name ${JSON.stringify(name)}`);
  }
}

export function writeZip(outFile, entries, { mtime = new Date(2026, 0, 1), level = 6 } = {}) {
  if (entries.length > 0xffff) throw new Error('zip: more than 65535 entries');
  const { time, date } = dosTime(mtime);
  const partial = `${outFile}.partial`;
  const fd = openSync(partial, 'w');
  const central = [];
  let pos = 0;
  const write = (b) => { writeSync(fd, b); pos += b.length; };
  const seen = new Set();
  try {
    for (const e of entries) {
      checkName(e.name);
      if (seen.has(e.name.toLowerCase())) throw new Error(`zip: duplicate entry ${e.name}`);
      seen.add(e.name.toLowerCase());
      const raw = e.data !== undefined ? (Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8')) : readFileSync(e.file);
      if (raw.length > MAX32) throw new Error(`zip: ${e.name} is over 4 GiB`);
      const crc = crc32(raw);
      let method = 8;
      let body = zlib.deflateRawSync(raw, { level });
      if (body.length >= raw.length) { method = 0; body = raw; }
      const name = Buffer.from(e.name, 'utf8');
      const offset = pos;
      if (offset > MAX32) throw new Error('zip: archive over 4 GiB');
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(20, 4);
      lh.writeUInt16LE(0x0800, 6); // UTF-8 names
      lh.writeUInt16LE(method, 8);
      lh.writeUInt16LE(time, 10);
      lh.writeUInt16LE(date, 12);
      lh.writeUInt32LE(crc, 14);
      lh.writeUInt32LE(body.length, 18);
      lh.writeUInt32LE(raw.length, 22);
      lh.writeUInt16LE(name.length, 26);
      lh.writeUInt16LE(0, 28);
      write(lh); write(name); write(body);
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0);
      ch.writeUInt16LE(20, 4);
      ch.writeUInt16LE(20, 6);
      ch.writeUInt16LE(0x0800, 8);
      ch.writeUInt16LE(method, 10);
      ch.writeUInt16LE(time, 12);
      ch.writeUInt16LE(date, 14);
      ch.writeUInt32LE(crc, 16);
      ch.writeUInt32LE(body.length, 20);
      ch.writeUInt32LE(raw.length, 24);
      ch.writeUInt16LE(name.length, 28);
      ch.writeUInt32LE(offset, 42);
      central.push(Buffer.concat([ch, name]));
    }
    const cdStart = pos;
    for (const c of central) write(c);
    const cdSize = pos - cdStart;
    if (pos > MAX32) throw new Error('zip: archive over 4 GiB');
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(central.length, 8);
    eocd.writeUInt16LE(central.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdStart, 16);
    write(eocd);
  } finally {
    closeSync(fd);
  }
  renameSync(partial, outFile);
  return { entries: central.length, bytes: statSync(outFile).size };
}

function readAt(fd, offset, length) {
  const b = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const n = readSync(fd, b, got, length - got, offset + got);
    if (n === 0) throw new Error('zip: truncated');
    got += n;
  }
  return b;
}

export function readZip(file) {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const tailLen = Math.min(size, 22 + 0xffff);
    const tail = readAt(fd, size - tailLen, tailLen);
    let at = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { at = i; break; }
    if (at < 0) throw new Error('zip: no end of central directory');
    const count = tail.readUInt16LE(at + 10);
    const cdSize = tail.readUInt32LE(at + 12);
    const cdStart = tail.readUInt32LE(at + 16);
    const cd = readAt(fd, cdStart, cdSize);
    const out = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('zip: bad central header');
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      out.push({
        name: cd.subarray(p + 46, p + 46 + nameLen).toString('utf8'),
        method: cd.readUInt16LE(p + 10),
        crc: cd.readUInt32LE(p + 16),
        compressedSize: cd.readUInt32LE(p + 20),
        size: cd.readUInt32LE(p + 24),
        offset: cd.readUInt32LE(p + 42),
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  } finally {
    closeSync(fd);
  }
}

export function extractEntry(file, entry) {
  const fd = openSync(file, 'r');
  try {
    const lh = readAt(fd, entry.offset, 30);
    if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error('zip: bad local header');
    const start = entry.offset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
    const body = readAt(fd, start, entry.compressedSize);
    const data = entry.method === 0 ? body : entry.method === 8 ? zlib.inflateRawSync(body) : null;
    if (!data) throw new Error(`zip: unsupported method ${entry.method}`);
    if (crc32(data) !== entry.crc) throw new Error(`zip: crc mismatch in ${entry.name}`);
    return data;
  } finally {
    closeSync(fd);
  }
}
