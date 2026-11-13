// SPDX-License-Identifier: GPL-3.0-or-later
// D375 The clips folder as the source of automatic posts (user 2026-11-13: every finished video in the clips folder is
// a candidate). The clips folder is the clipper's --publish folder (record-clips.mjs: clipsFolder(dataDir), the user's
// setting folders.clips, else <data>/clips), laid out as <clips>/<YYYY-MM-DD>/<name>.mp4 (clip_names.py).
//   scanClipsFolder({ dataDir, folder?, probeSeconds? }) -> { folder, rows: [uploads.json-shaped rows], unknown: n }
// Each video file whose name follows clip_names.py becomes one row: the uploads.json row for the same file when there is
// one (matched by full path, then by file name: the folder may have moved), else a row built from the name (kind, label,
// seconds from ffprobe, run 'clips-folder'). packageUploads({ rows }) then packages the ones that have no package yet
// (same-bytes files are skipped by the ledger). Reads only; never changes a file.
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { clipsFolder } from '../studio-ui/user-settings.mjs';

/** clip_names.py NAME_RE (keep the two in step). */
export const CLIP_NAME = /^([a-z0-9-]+)_(short|montage|won-reel|impact-play)_(\d{8}-\d{6})_([a-z0-9-]+)_(\d{2,3})_(v|h|v-[a-z0-9-]+)\.mp4$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const FOLDER_RUN = 'clips-folder';
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const realFile = (p) => { try { const s = lstatSync(p); return s.isFile() && !s.isSymbolicLink(); } catch { return false; } };
const realDir = (p) => { try { const s = lstatSync(p); return s.isDirectory() && !s.isSymbolicLink(); } catch { return false; } };
const norm = (p) => path.resolve(p).toLowerCase();

/** Length in seconds from ffprobe (FFPROBE or PATH; hidden window, D191), or null. */
export function ffprobeSeconds(file) {
  const r = spawnSync(process.env.FFPROBE || 'ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  const v = Number(String(r.stdout ?? '').trim());
  return r.status === 0 && Number.isFinite(v) && v > 0 ? Number(v.toFixed(3)) : null;
}

export function scanClipsFolder({ dataDir, folder = clipsFolder(dataDir), probeSeconds = ffprobeSeconds } = {}) {
  let known = [];
  try { const j = JSON.parse(readFileSync(path.join(dataDir, 'clips', 'uploads.json'), 'utf8')); if (Array.isArray(j?.files)) known = j.files.filter((r) => isPlain(r) && typeof r.file === 'string'); } catch { /* none yet */ }
  const byPath = new Map(known.map((r) => [norm(r.file), r]));
  const byName = new Map(known.map((r) => [path.basename(r.file).toLowerCase(), r]));
  const rows = []; let unknown = 0;
  if (!realDir(folder)) return { folder, rows, unknown };
  for (const day of readdirSync(folder).filter((d) => DAY.test(d)).sort()) {
    const dir = path.join(folder, day);
    if (!realDir(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      const m = CLIP_NAME.exec(name);
      if (!m) { if (name.toLowerCase().endsWith('.mp4')) unknown++; continue; }
      if (!realFile(file)) continue;
      const row = byPath.get(norm(file)) ?? byName.get(name.toLowerCase());
      if (row) { rows.push({ ...row, file }); continue; }
      rows.push({ file, kind: m[2], label: m[4], seconds: probeSeconds(file), run: FOLDER_RUN, posted: [] });
    }
  }
  return { folder, rows, unknown };
}
