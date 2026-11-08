# SPDX-License-Identifier: GPL-3.0-or-later
"""Face link: the shared-memory block between the host and the face worker (D295 proposed).

The HOST creates a named file mapping `Local\\ujwalam-face-<host pid>` (owner-only DACL; it refuses to start the link
if the name already exists) and writes camera frames into it; the worker only OPENS it (OpenFileMappingW, never
creates) and writes masks and landmarks back. Mirror of app/host/src/face.h; keep both in step (version below).

Authentication (version 2): the studio launcher makes one random 32-byte link key per launch and gives it to the host
by environment (the host reads it and removes it from its environment, like its tokens) and to the worker on its
stdin pipe (never argv, never the worker's environment). The host writes it into the header; the worker opens a
mapping only when the key matches (constant-time compare) and the mapping's owner is the worker's own user, so a
mapping squatted under the host's name by another process is never used.

Layout (little endian, byte offsets):
  header 0..4095
    0 u32 magic 'UJFA' (0x41464A55)   4 u32 version (2)   8 u32 total size
   -- host block (host writes)
   16 u32 frame lock (seqlock: odd while the host writes the frame)
   20 u32 frame w   24 u32 frame h   28 u32 frame stride (w * 4)
   32 u64 frame seq   40 i64 frame ts (Unix ms, when the host rendered it)
   48 u32 source w   52 u32 source h (the camera source's own size; the frame is it scaled to fit FRAME_MAX)
   56 u32 want (bit 0 mask, bit 1 landmarks)   60 f32 mask smoothing 0..0.95
   64 i64 host heartbeat (Unix ms, every tick)   72 u32 host pid
   76 u32 target generation of the frame in the slot (changes when the host's face target camera changes)
   80 u8[32] link key
   -- worker block (worker writes)
  128 u32 result lock (seqlock)   132 u32 mask w   136 u32 mask h   140 u32 face found (0/1)
  144 u64 result seq   152 u64 frame seq it answers   160 i64 that frame's ts (echo; the host uses its own clock)
  168 i64 worker heartbeat (Unix ms, at least every 500 ms)   176 u32 worker pid   180 u32 landmark count (0 or 468)
  184 f32 inference ms   188 f32[4] face box x, y, w, h (0..1 of the frame)   204 f32 face score
  208 f32[3] roll (degrees), yaw, pitch (-1..1)   220 f32[4] blink right, blink left, mouth, brows (0..1)
  236 u32 status bits (bit 0: segmentation on the GPU, bit 1: landmarks on the GPU)
  240 u32 mask valid (1: the mask slot holds a new mask for this result)   244 u32 target generation echoed
  248 u64 mask seq (advances only when a new mask is written)
  frame    at 4096: BGRA top-down, at most 640 x 360
  mask     at FRAME_OFF + 921600: u8, at most 640 x 360 (0 background .. 255 person), same size as the frame
  landmarks at MASK_OFF + 230400: f32 [468][3] x, y in 0..1 of the frame, z in frame-width units

Memory ordering: the host writes with InterlockedIncrement (full barriers) and reads with acquire loads. This side
runs on x86-64 only (Link.open refuses anything else): CPython makes each store in its own C call, in program order,
and x86-64 never reorders stores with stores or loads with loads. On top of that the result seqlock is published
with explicit full barriers (FlushProcessWriteBuffers, a documented process-wide memory barrier) after the lock goes
odd and before it goes even, so the payload is visible before the even lock that publishes it.
"""

from __future__ import annotations

import collections
import ctypes
import hmac
import os
import platform
import struct
import time

import numpy as np

MAGIC = 0x41464A55
VERSION = 2
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
KEY_OFF, KEY_BYTES = 80, 32

WANT_MASK, WANT_LANDMARKS = 1, 2

Frame = collections.namedtuple("Frame", "seq ts px src gen")


def link_name(host_pid):
    return f"Local\\ujwalam-face-{int(host_pid)}"


def now_ms():
    return int(time.time() * 1000)


def parse_key(text):
    """The link key from its 64-hex-character text form, or None."""
    if not isinstance(text, str) or len(text) != KEY_BYTES * 2:
        return None
    try:
        return bytes.fromhex(text) if text == text.lower() else None
    except ValueError:
        return None


def _barrier():
    """Full memory barrier (no-op where the Win32 call does not exist, e.g. the unit tests on another OS)."""
    if _BARRIER is not None:
        _BARRIER()


_BARRIER = None
if os.name == "nt":
    try:
        _BARRIER = ctypes.WinDLL("kernel32").FlushProcessWriteBuffers
        _BARRIER.argtypes = []
        _BARRIER.restype = None
    except (OSError, AttributeError):  # pragma: no cover - every supported Windows has it (Vista+)
        _BARRIER = None


class _Win:
    FILE_MAP_READ, FILE_MAP_WRITE, READ_CONTROL = 0x0004, 0x0002, 0x00020000
    SE_KERNEL_OBJECT, OWNER_SECURITY_INFORMATION = 6, 0x1
    TOKEN_QUERY, TOKEN_USER, TOKEN_OWNER = 0x0008, 1, 4

    def __init__(self):
        k = ctypes.WinDLL("kernel32", use_last_error=True)
        k.OpenFileMappingW.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_wchar_p]
        k.OpenFileMappingW.restype = ctypes.c_void_p
        k.MapViewOfFile.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_size_t]
        k.MapViewOfFile.restype = ctypes.c_void_p
        k.UnmapViewOfFile.argtypes = [ctypes.c_void_p]
        k.CloseHandle.argtypes = [ctypes.c_void_p]
        k.GetCurrentProcess.restype = ctypes.c_void_p
        k.LocalFree.argtypes = [ctypes.c_void_p]
        a = ctypes.WinDLL("advapi32", use_last_error=True)
        a.GetSecurityInfo.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_uint32, ctypes.POINTER(ctypes.c_void_p),
                                      ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]
        a.GetSecurityInfo.restype = ctypes.c_uint32
        a.OpenProcessToken.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.POINTER(ctypes.c_void_p)]
        a.GetTokenInformation.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32,
                                          ctypes.POINTER(ctypes.c_uint32)]
        a.EqualSid.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        self.k, self.a = k, a

    def _token_sid(self, tok, cls):
        n = ctypes.c_uint32(0)
        self.a.GetTokenInformation(tok, cls, None, 0, ctypes.byref(n))
        if not n.value:
            return None, None
        buf = ctypes.create_string_buffer(n.value)
        if not self.a.GetTokenInformation(tok, cls, buf, n, ctypes.byref(n)):
            return None, None
        # TOKEN_USER {SID_AND_ATTRIBUTES {PSID, DWORD}} and TOKEN_OWNER {PSID}: the SID pointer comes first in both
        return buf, ctypes.c_void_p.from_buffer(buf).value

    def owner_is_me(self, handle):
        """True when the mapping's owner SID is this process's user (or its default owner, e.g. Administrators for an
        elevated token: the host, started by the same launcher with the same token, has the same one)."""
        owner, sd = ctypes.c_void_p(), ctypes.c_void_p()
        if self.a.GetSecurityInfo(handle, self.SE_KERNEL_OBJECT, self.OWNER_SECURITY_INFORMATION, ctypes.byref(owner),
                                  None, None, None, ctypes.byref(sd)) != 0:
            return False
        tok = ctypes.c_void_p()
        try:
            if not self.a.OpenProcessToken(self.k.GetCurrentProcess(), self.TOKEN_QUERY, ctypes.byref(tok)):
                return False
            try:
                for cls in (self.TOKEN_USER, self.TOKEN_OWNER):
                    keep, sid = self._token_sid(tok, cls)
                    if sid and owner.value and self.a.EqualSid(owner, sid):
                        del keep
                        return True
                return False
            finally:
                self.k.CloseHandle(tok)
        finally:
            self.k.LocalFree(sd)


class Link:
    """Worker side of the face link. open() returns None while the host has no link (not running, or no face
    effect yet), or when the mapping is not the host's (wrong key or owner). Never creates the mapping."""

    def __init__(self, base, handle, win, size=TOTAL):
        self.base, self.handle, self.win, self.size = base, handle, win, size
        self.buf = (ctypes.c_ubyte * size).from_address(base)
        self.mv = memoryview(self.buf)
        self.u32 = np.frombuffer(self.buf, np.uint32, HEADER // 4)
        self.result_seq = self._get("<Q", 144)  # a restarted worker continues the count, so the host sees a change
        self.mask_seq = self._get("<Q", 248)

    @classmethod
    def open(cls, host_pid, key):
        """The host's link, or None. `key`: the 32-byte link key from the launcher (None: never opens)."""
        if os.name != "nt" or platform.machine().lower() not in ("amd64", "x86_64"):
            return None  # the ordering argument above holds on x86-64 only
        if not isinstance(key, (bytes, bytearray)) or len(key) != KEY_BYTES:
            return None
        w = _Win()
        # READ_CONTROL: needed to read the mapping's owner (the host's owner-only DACL grants this user everything)
        h = w.k.OpenFileMappingW(w.FILE_MAP_READ | w.FILE_MAP_WRITE | w.READ_CONTROL, 0, link_name(host_pid))
        if not h:
            return None
        if not w.owner_is_me(h):
            w.k.CloseHandle(h)
            return None
        base = w.k.MapViewOfFile(h, w.FILE_MAP_READ | w.FILE_MAP_WRITE, 0, 0, TOTAL)
        if not base:
            w.k.CloseHandle(h)
            return None
        link = cls(base, h, w)
        if not link.header_ok(key):
            link.close()
            return None
        return link

    def header_ok(self, key):
        """Magic, version, size and the link key (constant-time compare)."""
        if self.u32[0] != MAGIC or self.u32[1] != VERSION or self.u32[2] < TOTAL:
            return False
        return hmac.compare_digest(bytes(self.mv[KEY_OFF:KEY_OFF + KEY_BYTES]), bytes(key))

    def close(self):
        if self.base:
            self.mv.release()
            self.u32 = None
            self.buf = None
            if self.win is not None:
                self.win.k.UnmapViewOfFile(self.base)
                self.win.k.CloseHandle(self.handle)
            self.base = None

    # -- header fields
    def _get(self, fmt, off):
        return struct.unpack_from(fmt, self.mv, off)[0]

    def _put(self, fmt, off, v):
        struct.pack_into(fmt, self.mv, off, v)

    def host_alive(self, max_age_ms=3000):
        age = now_ms() - self._get("<q", 64)
        return -1000 <= age <= max_age_ms  # a heartbeat from the future is not a live host

    def want(self):
        return self._get("<I", 56)

    def smoothing(self):
        return self._get("<f", 60)

    def frame_seq(self):
        return self._get("<Q", 32)

    def read_frame(self, last_seq=0, tries=5):
        """Frame(seq, ts_ms, BGRA array h x w x 4, (src_w, src_h), target generation) of a frame newer than last_seq,
        or None. Seqlock read: retried while the host is writing."""
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
            gen = self._get("<I", 76)
            px = np.frombuffer(self.buf, np.uint8, h * stride, FRAME_OFF).reshape(h, w, 4).copy()
            if int(self.u32[4]) == s1:
                return Frame(seq, ts, px, src, gen)
        return None

    def heartbeat(self):
        self._put("<q", 168, now_ms())
        self._put("<I", 176, os.getpid())

    def write_result(self, frame_seq, frame_ts, mask=None, landmarks=None, box=None, score=0.0, feats=None,
                     infer_ms=0.0, status=0, gen=0):
        """Publish one result (seqlock write). mask: u8 h x w (<= 640 x 360) or None (then the result carries no mask:
        mask valid 0, the host keeps its last mask and lets it age); landmarks: [468, 3] floats normalised to the
        frame, or None (no face); gen: the target generation of the frame this answers."""
        if mask is not None:
            mh, mw = mask.shape
            if mw > FRAME_MAX_W or mh > FRAME_MAX_H:
                raise ValueError("mask larger than 640 x 360")
        lm = None
        if landmarks is not None:
            lm = np.asarray(landmarks, np.float32)
            if lm.shape != (LMK_MAX, 3):
                raise ValueError("landmarks must be 468 x 3")
        u = self.u32
        u[32] = (int(u[32]) + 1) | 1  # odd: writing (offset 128 / 4 = 32)
        _barrier()  # the odd lock is visible before any payload byte
        if mask is not None:
            np.frombuffer(self.buf, np.uint8, mw * mh, MASK_OFF).reshape(mh, mw)[:] = mask
            self._put("<I", 132, mw)
            self._put("<I", 136, mh)
            self.mask_seq += 1
            self._put("<Q", 248, self.mask_seq)
        self._put("<I", 240, 1 if mask is not None else 0)
        n = 0
        if lm is not None:
            n = LMK_MAX
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
        self._put("<I", 244, int(gen) & 0xFFFFFFFF)
        self.result_seq += 1
        self._put("<Q", 152, int(frame_seq))
        self._put("<q", 160, int(frame_ts))
        self._put("<Q", 144, self.result_seq)
        self.heartbeat()
        _barrier()  # every payload byte is visible before the even lock that publishes it
        u[32] = int(u[32]) + 1  # even: done
