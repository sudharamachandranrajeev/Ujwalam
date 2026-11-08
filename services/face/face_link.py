# SPDX-License-Identifier: GPL-3.0-or-later
"""Face link: the shared-memory block between the host and the face worker (D295 proposed).

The HOST creates a named file mapping `Local\\ujwalam-face-<host pid>` (owner-only DACL; it refuses to start the link
if the name already exists) and writes camera frames into it; the worker only OPENS it (OpenFileMappingW, never
creates) and writes masks and landmarks back. Mirror of app/host/src/face.h; keep both in step (version below).

Layout (little endian, byte offsets):
  header 0..4095
    0 u32 magic 'UJFA' (0x41464A55)   4 u32 version (1)   8 u32 total size
   -- host block (host writes)
   16 u32 frame lock (seqlock: odd while the host writes the frame)
   20 u32 frame w   24 u32 frame h   28 u32 frame stride (w * 4)
   32 u64 frame seq   40 i64 frame ts (Unix ms, when the host rendered it)
   48 u32 source w   52 u32 source h (the camera source's own size; the frame is it scaled to fit FRAME_MAX)
   56 u32 want (bit 0 mask, bit 1 landmarks)   60 f32 mask smoothing 0..0.95
   64 i64 host heartbeat (Unix ms, every tick)   72 u32 host pid
   -- worker block (worker writes)
  128 u32 result lock (seqlock)   132 u32 mask w   136 u32 mask h   140 u32 face found (0/1)
  144 u64 result seq   152 u64 frame seq it answers   160 i64 that frame's ts
  168 i64 worker heartbeat (Unix ms, at least every 500 ms)   176 u32 worker pid   180 u32 landmark count (0 or 468)
  184 f32 inference ms   188 f32[4] face box x, y, w, h (0..1 of the frame)   204 f32 face score
  208 f32[3] roll (degrees), yaw, pitch (-1..1)   220 f32[4] blink right, blink left, mouth, brows (0..1)
  236 u32 status bits (bit 0: segmentation on the GPU, bit 1: landmarks on the GPU)
  frame    at 4096: BGRA top-down, at most 640 x 360
  mask     at FRAME_OFF + 921600: u8, at most 640 x 360 (0 background .. 255 person), same aspect as the frame
  landmarks at MASK_OFF + 230400: f32 [468][3] x, y in 0..1 of the frame, z in frame-width units
"""

from __future__ import annotations

import ctypes
import os
import struct
import time

import numpy as np

MAGIC = 0x41464A55
VERSION = 1
FRAME_MAX_W, FRAME_MAX_H = 640, 360
HEADER = 4096
FRAME_OFF = HEADER
FRAME_BYTES = FRAME_MAX_W * FRAME_MAX_H * 4
MASK_OFF = FRAME_OFF + FRAME_BYTES
MASK_BYTES = FRAME_MAX_W * FRAME_MAX_H
LMK_OFF = MASK_OFF + MASK_BYTES
LMK_MAX = 468
LMK_BYTES = LMK_MAX * 3 * 4
TOTAL = (LMK_OFF + LMK_BYTES + 4095) // 4096 * 4096

WANT_MASK, WANT_LANDMARKS = 1, 2


def link_name(host_pid):
    return f"Local\\ujwalam-face-{int(host_pid)}"


def now_ms():
    return int(time.time() * 1000)


class _Win:
    FILE_MAP_READ, FILE_MAP_WRITE = 0x0004, 0x0002

    def __init__(self):
        k = ctypes.WinDLL("kernel32", use_last_error=True)
        k.OpenFileMappingW.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_wchar_p]
        k.OpenFileMappingW.restype = ctypes.c_void_p
        k.MapViewOfFile.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_size_t]
        k.MapViewOfFile.restype = ctypes.c_void_p
        k.UnmapViewOfFile.argtypes = [ctypes.c_void_p]
        k.CloseHandle.argtypes = [ctypes.c_void_p]
        self.k = k


class Link:
    """Worker side of the face link. open() returns None while the host has no link (not running, or no face
    effect yet). Never creates the mapping."""

    def __init__(self, base, handle, win, size=TOTAL):
        self.base, self.handle, self.win, self.size = base, handle, win, size
        self.buf = (ctypes.c_ubyte * size).from_address(base)
        self.mv = memoryview(self.buf)
        self.u32 = np.frombuffer(self.buf, np.uint32, HEADER // 4)
        self.result_seq = self._get("<Q", 144)  # a restarted worker continues the count, so the host sees a change

    @classmethod
    def open(cls, host_pid):
        if os.name != "nt":
            return None
        w = _Win()
        h = w.k.OpenFileMappingW(w.FILE_MAP_READ | w.FILE_MAP_WRITE, 0, link_name(host_pid))
        if not h:
            return None
        base = w.k.MapViewOfFile(h, w.FILE_MAP_READ | w.FILE_MAP_WRITE, 0, 0, TOTAL)
        if not base:
            w.k.CloseHandle(h)
            return None
        link = cls(base, h, w)
        if link.u32[0] != MAGIC or link.u32[1] != VERSION or link.u32[2] < TOTAL:
            link.close()
            return None
        return link

    def close(self):
        if self.base:
            self.mv.release()
            self.u32 = None
            self.buf = None
            self.win.k.UnmapViewOfFile(self.base)
            self.win.k.CloseHandle(self.handle)
            self.base = None

    # -- header fields
    def _get(self, fmt, off):
        return struct.unpack_from(fmt, self.mv, off)[0]

    def _put(self, fmt, off, v):
        struct.pack_into(fmt, self.mv, off, v)

    def host_alive(self, max_age_ms=3000):
        return now_ms() - self._get("<q", 64) <= max_age_ms

    def want(self):
        return self._get("<I", 56)

    def smoothing(self):
        return self._get("<f", 60)

    def frame_seq(self):
        return self._get("<Q", 32)

    def read_frame(self, last_seq=0, tries=5):
        """(seq, ts_ms, BGRA array h x w x 4, (src_w, src_h)) of a frame newer than last_seq, or None. Seqlock read:
        retried while the host is writing."""
        for _ in range(tries):
            s1 = int(self.u32[4])
            if s1 & 1:
                time.sleep(0.0005)
                continue
            seq = self._get("<Q", 32)
            if seq == 0 or seq == last_seq:
                return None
            w, h, stride = self._get("<I", 20), self._get("<I", 24), self._get("<I", 28)
            if not (0 < w <= FRAME_MAX_W and 0 < h <= FRAME_MAX_H and stride == w * 4):
                return None
            ts = self._get("<q", 40)
            src = (self._get("<I", 48), self._get("<I", 52))
            px = np.frombuffer(self.buf, np.uint8, h * stride, FRAME_OFF).reshape(h, w, 4).copy()
            if int(self.u32[4]) == s1:
                return seq, ts, px, src
        return None

    def heartbeat(self):
        self._put("<q", 168, now_ms())
        self._put("<I", 176, os.getpid())

    def write_result(self, frame_seq, frame_ts, mask=None, landmarks=None, box=None, score=0.0, feats=None,
                     infer_ms=0.0, status=0):
        """Publish one result (seqlock write). mask: u8 h x w (<= 640 x 360) or None; landmarks: [468, 3] floats
        normalised to the frame, or None (no face)."""
        u = self.u32
        u[32] = (int(u[32]) + 1) | 1  # odd: writing (offset 128 / 4 = 32)
        if mask is not None:
            mh, mw = mask.shape
            if mw > FRAME_MAX_W or mh > FRAME_MAX_H:
                raise ValueError("mask larger than 640 x 360")
            dst = np.frombuffer(self.buf, np.uint8, mw * mh, MASK_OFF).reshape(mh, mw)
            dst[:] = mask
            self._put("<I", 132, mw)
            self._put("<I", 136, mh)
        n = 0
        if landmarks is not None:
            lm = np.asarray(landmarks, np.float32)[:LMK_MAX, :3]
            n = lm.shape[0]
            np.frombuffer(self.buf, np.float32, n * 3, LMK_OFF)[:] = lm.ravel()
        self._put("<I", 140, 1 if n else 0)
        self._put("<I", 180, n)
        self._put("<f", 184, float(infer_ms))
        for i, v in enumerate(box if box is not None else (0, 0, 0, 0)):
            self._put("<f", 188 + 4 * i, float(v))
        self._put("<f", 204, float(score))
        f = feats or {}
        for i, k in enumerate(("roll", "yaw", "pitch")):
            self._put("<f", 208 + 4 * i, float(f.get(k, 0.0)))
        for i, k in enumerate(("blinkR", "blinkL", "mouth", "brows")):
            self._put("<f", 220 + 4 * i, float(f.get(k, 0.0)))
        self._put("<I", 236, int(status))
        self.result_seq += 1
        self._put("<Q", 152, int(frame_seq))
        self._put("<q", 160, int(frame_ts))
        self._put("<Q", 144, self.result_seq)
        self.heartbeat()
        u[32] = int(u[32]) + 1  # even: done
