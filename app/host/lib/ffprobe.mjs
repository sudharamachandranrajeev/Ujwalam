// SPDX-License-Identifier: GPL-2.0-or-later
// ffprobe helpers for loopback assertions. ffprobe is found on PATH (or FFPROBE); nothing is installed.
import { spawnSync } from 'node:child_process';

const FFPROBE = process.env.FFPROBE || 'ffprobe';

function run(args) {
  const r = spawnSync(FFPROBE, ['-v', 'error', ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`ffprobe failed (${r.status}): ${(r.stderr || '').trim().slice(0, 300)}`);
  return r.stdout;
}

export function ffprobeVersion() {
  const r = spawnSync(FFPROBE, ['-version'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split('\n')[0].trim() : null;
}

function rate(s) {
  if (!s || !s.includes('/')) return Number(s) || 0;
  const [n, d] = s.split('/').map(Number);
  return d ? n / d : 0;
}

// Streams, format and per-stream packet totals of a media file.
export function probe(file) {
  const meta = JSON.parse(run(['-show_streams', '-show_format', '-of', 'json', file]));
  const pk = JSON.parse(run(['-show_entries', 'packet=stream_index,pts_time,dts_time,size,flags', '-of', 'json', file])).packets ?? [];
  const per = new Map();
  for (const p of pk) {
    const s = per.get(p.stream_index) ?? { packets: 0, bytes: 0, first: Infinity, last: -Infinity, keyframes: [] };
    s.packets++;
    s.bytes += Number(p.size);
    const t = Number(p.pts_time ?? p.dts_time);
    if (Number.isFinite(t)) {
      s.first = Math.min(s.first, t);
      s.last = Math.max(s.last, t);
      if (p.flags?.startsWith('K')) s.keyframes.push(t);
    }
    per.set(p.stream_index, s);
  }
  const streams = meta.streams.map((s) => {
    const t = per.get(s.index) ?? { packets: 0, bytes: 0, first: 0, last: 0, keyframes: [] };
    const span = t.last > t.first ? t.last - t.first : 0;
    const o = {
      index: s.index, type: s.codec_type, codec: s.codec_name, profile: s.profile,
      packets: t.packets, bytes: t.bytes, spanSec: span,
      measuredKbps: span > 0 ? (t.bytes * 8) / span / 1000 : 0
    };
    if (s.codec_type === 'video') {
      Object.assign(o, {
        width: s.width, height: s.height, avgFps: rate(s.avg_frame_rate), rFps: rate(s.r_frame_rate),
        measuredFps: span > 0 ? (t.packets - 1) / span : 0, pixFmt: s.pix_fmt
      });
      const k = t.keyframes;
      if (k.length > 1) {
        const gaps = k.slice(1).map((x, i) => x - k[i]);
        o.keyframes = k.length;
        o.gopSecMedian = gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
      }
    }
    if (s.codec_type === 'audio') Object.assign(o, { sampleRate: Number(s.sample_rate), channels: s.channels });
    return o;
  });
  return { file, format: meta.format?.format_name, durationSec: Number(meta.format?.duration), streams };
}

// MD5 of each packet's payload for one stream type, in order (to show two sinks carry the same encoder output).
// limit 0 = every packet. Sinks that join a running encoder start at its next keyframe, so compare whole files
// (common / shorter), not the first N packets.
export function packetHashes(file, type = 'v', limit = 0) {
  const win = limit ? ['-read_intervals', `%+#${limit}`] : [];
  const out = run(['-select_streams', type, '-show_entries', 'packet=data_hash', '-show_data_hash', 'MD5',
    ...win, '-of', 'csv=p=0', file]);
  return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

export function overlap(a, b) {
  const sb = new Set(b);
  const n = a.filter((h) => sb.has(h)).length;
  return { common: n, ofA: a.length, ofB: b.length, ratio: a.length ? n / Math.min(a.length, b.length || 1) : 0 };
}
