// SPDX-License-Identifier: GPL-3.0-or-later
// Reads the DLL names a Windows PE file imports (normal and delay-load import tables) and the names it exports. Used
// by the alpha packager to copy exactly the OBS runtime files the host can load (tools/package/manifest.mjs).
//   peInfo(buffer) -> { machine, pe32plus, imports: [dll], delayImports: [dll], exports: [name] }
// Throws on a file that is not a PE image.

function sections(b, peOff) {
  const n = b.readUInt16LE(peOff + 6);
  const optSize = b.readUInt16LE(peOff + 20);
  const first = peOff + 24 + optSize;
  const out = [];
  for (let i = 0; i < n; i++) {
    const s = first + i * 40;
    out.push({ va: b.readUInt32LE(s + 12), vsize: b.readUInt32LE(s + 8), raw: b.readUInt32LE(s + 20), rawSize: b.readUInt32LE(s + 16) });
  }
  return out;
}

function rvaToOff(secs, rva) {
  for (const s of secs) {
    const size = Math.max(s.vsize, s.rawSize);
    if (rva >= s.va && rva < s.va + size) return s.raw + (rva - s.va);
  }
  return -1;
}

function cstr(b, off) {
  if (off < 0 || off >= b.length) return null;
  let e = off;
  while (e < b.length && b[e] !== 0) e++;
  return b.subarray(off, e).toString('latin1');
}

export function peInfo(b) {
  if (b.length < 64 || b.readUInt16LE(0) !== 0x5a4d) throw new Error('not a PE file (no MZ)');
  const peOff = b.readUInt32LE(0x3c);
  if (peOff + 24 > b.length || b.readUInt32LE(peOff) !== 0x00004550) throw new Error('not a PE file (no PE signature)');
  const machine = b.readUInt16LE(peOff + 4);
  const opt = peOff + 24;
  const magic = b.readUInt16LE(opt);
  const pe32plus = magic === 0x20b;
  const imageBase = pe32plus ? Number(b.readBigUInt64LE(opt + 24)) : b.readUInt32LE(opt + 28);
  const ddOff = opt + (pe32plus ? 112 : 96);
  const ddCount = b.readUInt32LE(opt + (pe32plus ? 108 : 92));
  const dir = (i) => (i < ddCount ? { rva: b.readUInt32LE(ddOff + i * 8), size: b.readUInt32LE(ddOff + i * 8 + 4) } : { rva: 0, size: 0 });
  const secs = sections(b, peOff);

  const imports = [];
  const imp = dir(1);
  if (imp.rva) {
    let p = rvaToOff(secs, imp.rva);
    for (; p >= 0 && p + 20 <= b.length; p += 20) {
      const nameRva = b.readUInt32LE(p + 12);
      if (!nameRva && !b.readUInt32LE(p) && !b.readUInt32LE(p + 16)) break;
      const n = cstr(b, rvaToOff(secs, nameRva));
      if (n) imports.push(n);
    }
  }

  const delayImports = [];
  const dl = dir(13);
  if (dl.rva) {
    let p = rvaToOff(secs, dl.rva);
    for (; p >= 0 && p + 32 <= b.length; p += 32) {
      const attrs = b.readUInt32LE(p);
      let nameRva = b.readUInt32LE(p + 4);
      if (!nameRva) break;
      if ((attrs & 1) === 0) nameRva -= imageBase; // old-style descriptors hold VAs
      const n = cstr(b, rvaToOff(secs, nameRva));
      if (n) delayImports.push(n);
    }
  }

  const exports = [];
  const ex = dir(0);
  if (ex.rva) {
    const p = rvaToOff(secs, ex.rva);
    if (p >= 0 && p + 40 <= b.length) {
      const count = b.readUInt32LE(p + 24);
      const names = rvaToOff(secs, b.readUInt32LE(p + 32));
      for (let i = 0; i < count && names >= 0 && names + i * 4 + 4 <= b.length; i++) {
        const n = cstr(b, rvaToOff(secs, b.readUInt32LE(names + i * 4)));
        if (n) exports.push(n);
      }
    }
  }
  return { machine, pe32plus, imports, delayImports, exports };
}
