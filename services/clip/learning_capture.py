# SPDX-License-Identifier: GPL-3.0-or-later
"""LL1 + LL3 (D340): the clip pipeline's evidence goes into the local learning store, and low-confidence reads are
queued for an optional review after the stream.

Store: the same one LL2 writes (services/learning/store.mjs, D338): <data>/learning-store/<session>/, one folder per
stream session, gitignored and refused by the private scan (LL5), capped at 5 GB in total (whole sessions removed
oldest first by the launcher's cap pass). This module adds three files to a session folder:

  evidence.jsonl  one row per OCR'd live frame that produced detector hits:
                  {v, at, t, mode, hits: [hit rows, detector_pass.frame_hits format], texts: [{text, score, g}]}
                  `texts` are the OCR texts of that frame (local store only; they can hold player names).
  review.jsonl    one row per low-confidence read (LL3), queued for the review in My clips:
                  {v, id, at, t, kind, detector, label, mode, ocrScore, threshold, value, choices, frame, texts, ...}
                  kind: unclassified-banner (a signalled W1 VICTORY/DEFEAT word whose position fits none of the pack's
                  banner.kinds), ocr-low (a signalled hit read with an OCR score below game.json ocr.minConfidence;
                  none while that value is null), unknown-mode (a match of the stream's recording whose game mode the
                  match gate could not tell, written by `clipper.py live-review`).
  frames/<id>.jpg the frame of a review item only (no other frame is ever kept).
  session.json    {v, createdAt}, written once with the first file (the cap's age order, as store.mjs).

Thresholds come from the data files only (game.json ocr.minConfidence, the W1 banner kinds, the pack's mode names);
none is invented here. Nothing here loads a model or touches the GPU: JPEG encoding (OpenCV, CPU) of a review frame
and appends to files, on a background thread behind a small bounded queue. The live clipper never waits for it: a
full queue, a failed write or a full store drops the item (the writer keeps the whole store under the cap: what the
cap leaves after the other sessions, measured on the writer thread at start). frame() only counts drops; the writer
thread logs them (the first, then one line per 100) and ignores a failing log. LiveCapture.frame() never raises.
"""

from __future__ import annotations

import json
import os
import queue
import re
import threading
from datetime import datetime, timezone

STORE_DIR = "learning-store"
CAP_BYTES = 5 * 1024 ** 3  # the store's cap (services/learning/store.mjs CAP_BYTES, user 2026-11-10)
SESSION_META = "session.json"
EVIDENCE = "evidence.jsonl"
REVIEW = "review.jsonl"
FRAMES = "frames"
KINDS = ("unclassified-banner", "ocr-low", "unknown-mode")
NOT_A_BANNER = "not a banner"
WRONG_READ = "wrong read"
SESSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$")
ITEM_RE = re.compile(r"^[a-z][a-z0-9-]{0,63}$")
QUEUE_MAX = 8  # items waiting for the writer thread; more are dropped (never a wait in the live loop)
# Kept free under the cap for LL2 label rows (launcher, UI server, collector) appended while this session writes.
LABEL_MARGIN = 16 * 1024 ** 2
JPEG_QUALITY = 85


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def session_id(raw):
    """Safe session folder name, as store.mjs sessionId ('' when nothing usable is left)."""
    s = re.sub(r"[^A-Za-z0-9._-]", "_", str(raw or ""))
    s = re.sub(r"^[._-]+", "", s)[:100]
    return s if SESSION_RE.match(s) else ""


def ocr_threshold(pack):
    """game.json ocr.minConfidence as a number in (0, 1], else None (no ocr-low item is queued)."""
    v = (pack.get("ocr") or {}).get("minConfidence")
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not 0 < v <= 1:
        return None
    return float(v)


def banner_kinds(pack):
    """The W1 banner kinds of the pack ("round", "match"), in pack order."""
    w1 = next((d for d in pack.get("detectors", []) if d.get("id") == "W1"), None) or {}
    return [k["kind"] for k in (w1.get("banner") or {}).get("kinds") or [] if isinstance(k.get("kind"), str)]


def mode_choices(cfg):
    """Game modes the pack names (match_gate.stats_config: S1 modeNames, C1 cues, C2 header cues, banner subtitles),
    lower case, sorted. The review offers only these."""
    out = set()
    for n in cfg.get("modeNames") or []:
        out.add((n if isinstance(n, str) else n.get("mode") or "").lower())
    for q in list(cfg.get("modeCues") or []) + list(cfg.get("headerCues") or []) + \
            list((cfg.get("banner") or {}).get("subtitles") or []):
        out.update(x.lower() for x in q.get("modes") or [] if isinstance(x, str))
    out.discard("")
    return sorted(out)


def review_reads(rows, ocr_min, kinds):
    """Low-confidence reads among one frame's hit rows -> [{key, kind, detector, label, ocrScore, threshold, value,
    choices}]. Only signalled rows (the ones that would count for a clip or a match) are looked at."""
    out = []
    for r in rows:
        if not r.get("signal"):
            continue
        d, label, score = r.get("detector"), r.get("label"), r.get("ocrScore")
        if d == "W1" and "banner" in r and r.get("banner") is None and kinds:
            out.append({"key": ("unclassified-banner", d, label), "kind": "unclassified-banner", "detector": d,
                        "label": label, "ocrScore": score, "threshold": None, "value": None,
                        "choices": list(kinds) + [NOT_A_BANNER]})
        if ocr_min is not None and isinstance(score, (int, float)) and score < ocr_min:
            out.append({"key": ("ocr-low", d, label), "kind": "ocr-low", "detector": d, "label": label,
                        "ocrScore": score, "threshold": ocr_min, "value": label,
                        "choices": [label, WRONG_READ] if isinstance(label, str) and label else [WRONG_READ]})
    return out


def _dir_bytes(d):
    n = 0
    for root, _dirs, files in os.walk(d):
        for f in files:
            try:
                n += os.lstat(os.path.join(root, f)).st_size
            except OSError:
                pass
    return n


class SessionWriter:
    """Appends to one session folder of the store. Synchronous; raises OSError / ValueError on failure.
    budget: the store's cap. This session may hold what the cap leaves after every other file of the store and
    LABEL_MARGIN (size_up(); Codex review: the launcher's cap pass runs only now and then and never removes the newest
    session, so the writer itself keeps the store's total under the cap). A write that would pass it is refused."""

    def __init__(self, data_dir, session, budget=CAP_BYTES):
        s = session_id(session)
        if not s or not data_dir:
            raise ValueError("learning store: no data folder or bad session name")
        self.root = os.path.join(os.path.abspath(data_dir), STORE_DIR)
        self.dir = os.path.join(self.root, s)
        self.session, self.cap = s, budget
        self.budget, self.used = None, 0  # set by size_up(), a walk of the store (never on the live loop)

    def size_up(self):
        """Measures the store: this session's bytes (used) and what the cap leaves for it (budget)."""
        own = others = 0
        try:
            names = os.listdir(self.root)
        except OSError:
            names = []
        for n in names:
            p = os.path.join(self.root, n)
            if os.path.normcase(p) == os.path.normcase(self.dir):
                own = _dir_bytes(p)
            elif os.path.isdir(p) and not os.path.islink(p):
                others += _dir_bytes(p)
            else:
                try:
                    others += os.lstat(p).st_size
                except OSError:
                    pass
        self.used = own
        self.budget = max(0, self.cap - others - LABEL_MARGIN)
        return self.budget

    def _ensure(self):
        os.makedirs(os.path.join(self.dir, FRAMES), exist_ok=True)
        try:  # written once ('x'): the session's start, the cap's age order (store.mjs)
            with open(os.path.join(self.dir, SESSION_META), "x", encoding="utf-8", newline="\n") as f:
                f.write(json.dumps({"v": 1, "createdAt": now_iso()}) + "\n")
        except FileExistsError:
            pass

    def _room(self, n):
        if self.budget is None:
            self.size_up()
        if self.used + n > self.budget:
            raise ValueError("learning store: session over the store's cap")

    def append(self, name, row):
        line = (json.dumps(row, ensure_ascii=False) + "\n").encode("utf-8")
        self._room(len(line))
        self._ensure()
        with open(os.path.join(self.dir, name), "ab") as f:
            f.write(line)
        self.used += len(line)

    def frame(self, item_id, jpeg):
        if not ITEM_RE.match(item_id):
            raise ValueError("learning store: bad item id")
        self._room(len(jpeg))
        self._ensure()
        rel = f"{FRAMES}/{item_id}.jpg"
        with open(os.path.join(self.dir, FRAMES, f"{item_id}.jpg"), "wb") as f:
            f.write(jpeg)
        self.used += len(jpeg)
        return rel

    def item_ids(self):
        """Ids already in review.jsonl (a re-run adds no duplicate)."""
        ids = set()
        try:
            with open(os.path.join(self.dir, REVIEW), encoding="utf-8") as f:
                for line in f:
                    try:
                        ids.add(json.loads(line).get("id"))
                    except ValueError:
                        pass
        except OSError:
            pass
        return ids

    def add_item(self, item, jpeg=None):
        """Writes a review item (its frame first, when given). Returns the row written."""
        row = dict(item)
        row["frame"] = self.frame(row["id"], jpeg) if jpeg else None
        self.append(REVIEW, row)
        return row


def encode_jpeg(img):
    """BGR array -> JPEG bytes (OpenCV, CPU), or None when OpenCV is missing or the encode fails."""
    try:
        import cv2
        ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), JPEG_QUALITY])
        return bytes(buf) if ok else None
    except Exception:  # noqa: BLE001  (never fails the caller)
        return None


class LiveCapture:
    """The live worker's side (LL1 + LL3). frame() is called once per sampled frame on the live loop: it only builds
    small dicts and puts them on a bounded queue (put_nowait); a daemon thread writes. Never raises."""

    def __init__(self, data_dir, session, pack, log, budget=CAP_BYTES, max_queue=QUEUE_MAX, encode=encode_jpeg):
        self.log, self.encode = log, encode  # log: called on the writer thread only, never from frame()
        self.writer = SessionWriter(data_dir, session, budget)
        self.ocr_min = ocr_threshold(pack)
        self.kinds = banner_kinds(pack)
        self.q = queue.Queue(maxsize=max_queue)
        self.active = set()  # review keys on the last OCR'd frame: one item per appearance, not one per frame
        self.taken = self.writer.item_ids()  # a session folder written before (same name) keeps its items
        self.n = 0
        # The live loop adds only to _live_drops/_live_why; the writer thread owns the other counters.
        self._evidence = self._items = self._writer_drops = self._live_drops = self._reported = 0
        self._live_why = self._writer_why = ""
        self._stop = threading.Event()
        self.thread = threading.Thread(target=self._run, name="learning-capture", daemon=True)
        self.thread.start()

    @property
    def stats(self):
        return {"evidence": self._evidence, "items": self._items, "dropped": self._writer_drops + self._live_drops}

    def _drop_live(self, why):
        """Live loop side: counts only. No logging here (Codex review: a stalled or failing log pipe must never reach
        the live loop); the writer thread reports the drops."""
        self._live_drops += 1
        self._live_why = why

    def _report(self):
        """Writer thread: one log line at the first drop, then one per 100 more; a failing log is ignored."""
        total = self._writer_drops + self._live_drops
        if total == self._reported or (self._reported and total // 100 == self._reported // 100):
            return
        self._reported = total
        try:
            self.log(f"learning: dropped {total} item(s) ({self._writer_why or self._live_why})")
        except Exception:  # noqa: BLE001  (a closed or broken stderr never stops the writer)
            pass

    def frame(self, t, img, rows, boxes, mode, fresh):
        """One sampled frame: rows = its hit rows; boxes = its OCR boxes; fresh = OCR ran on it (an unchanged frame
        repeats the last one and adds nothing)."""
        try:
            if not fresh:
                return
            at = now_iso()
            texts = [{"text": str(b.get("text", ""))[:200], "score": round(float(b.get("score", 0.0)), 4),
                      "g": b.get("g")} for b in boxes or []]
            hits = [{k: v for k, v in r.items() if k != "t"} for r in rows]
            reads = review_reads(rows, self.ocr_min, self.kinds)
            keys = {r["key"] for r in reads}
            new = [r for r in reads if r["key"] not in self.active]
            self.active = keys
            if hits:
                self._put(("evidence", {"v": 1, "at": at, "t": round(float(t), 3), "mode": mode, "hits": hits,
                                        "texts": texts}, None))
            for r in new:
                self.n += 1
                while f"live-{self.n:05d}" in self.taken:
                    self.n += 1
                item = {"v": 1, "id": f"live-{self.n:05d}", "at": at, "t": round(float(t), 3), "mode": mode,
                        **{k: v for k, v in r.items() if k != "key"}, "texts": texts}
                self._put(("item", item, img))
        except Exception as e:  # noqa: BLE001  (the live clipper never fails because of learning)
            self._drop_live(type(e).__name__)

    def _put(self, job):
        try:
            self.q.put_nowait(job)
        except queue.Full:
            self._drop_live("writer busy")

    def _run(self):
        try:  # the store's size, once, here (off the live loop); writes then count against what the cap leaves
            self.writer.size_up()
        except Exception:  # noqa: BLE001  (budget stays unset: the first write measures again)
            pass
        while not (self._stop.is_set() and self.q.empty()):
            try:
                kind, row, img = self.q.get(timeout=0.5)
            except queue.Empty:
                self._report()
                continue
            try:
                if kind == "evidence":
                    self.writer.append(EVIDENCE, row)
                    self._evidence += 1
                else:
                    self.writer.add_item(row, self.encode(img) if img is not None else None)
                    self._items += 1
            except Exception as e:  # noqa: BLE001
                self._writer_drops += 1
                self._writer_why = f"{type(e).__name__}: {str(e)[:80]}"
            finally:
                self._report()  # before task_done: a q.join() caller sees the log line too
                self.q.task_done()
        self._report()

    def close(self, timeout=5.0):
        """Writes what is queued (up to timeout) and stops the thread."""
        self._stop.set()
        self.thread.join(timeout)


def queue_unknown_modes(data_dir, session, matches, cfg, frame_of=None, log=None):
    """LL3 from `clipper.py live-review` (post-stream): one unknown-mode item per match of the stream's recording that
    showed an end screen but whose game mode the match gate could not tell (gameMode None). frame_of(match) -> JPEG
    bytes or None (one frame of the recording at the match's end screen). Returns the number of items written; any
    failure is logged and returns what was written (never raises)."""
    log = log or (lambda *_: None)
    n = 0
    try:
        choices = mode_choices(cfg)
        if not choices:
            return 0
        w = SessionWriter(data_dir, session)
        have = w.item_ids()
        for i, m in enumerate(matches, 1):
            if not m.get("endSeen") or m.get("gameMode"):
                continue
            item_id = f"mode-{i:03d}"
            if item_id in have:
                continue
            jpeg = None
            if frame_of:
                try:
                    jpeg = frame_of(m)
                except Exception:  # noqa: BLE001
                    jpeg = None
            w.add_item({"v": 1, "id": item_id, "at": now_iso(), "t": m.get("endScreenAt"), "kind": "unknown-mode",
                        "detector": None, "label": None, "mode": m.get("mode"), "ocrScore": None, "threshold": None,
                        "value": None, "choices": choices, "match": i, "matchStartUtc": m.get("startUtc"),
                        "matchEndUtc": m.get("endUtc"), "modeReason": m.get("modeReason"),
                        "modeEvidence": [{"source": e.get("source"), "text": e.get("text")}
                                         for e in m.get("modeEvidence") or []][:8],
                        "texts": []}, jpeg)
            n += 1
    except Exception as e:  # noqa: BLE001  (the clips are made either way)
        log(f"learning: review items not written ({type(e).__name__})")
    return n
