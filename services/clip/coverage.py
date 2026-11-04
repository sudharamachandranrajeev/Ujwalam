# SPDX-License-Identifier: GPL-3.0-or-later
"""Capture coverage tracker (P2b W1, workflow step T2).

Checks recordings against a game pack's capture plan (data/games/<id>/capture-plan.json) and
reports each plan item the first time it is captured. The detector logic is not duplicated:
frames are sampled, OCR'd and analysed with g1_scan (decode_frames, scan_frame, classify_frame,
find_events), and the pack is loaded with game_pack. Each item's `match` criteria (data in the
capture plan) decide which detections count:
  auto    the first matching detection captures the item;
  manual  no measured cue exists for an automatic decision: matching detections are only
          candidates, and the user confirms the item with `mark`.

Coverage state is local and gitignored: data/games/<id>/local/coverage.json by default, with
evidence crops next to it (coverage-crops/) and the tracker's scan rows (coverage-scans/, the
g1_scan scan format, so `g1_scan.py analyse` can read them). The committed capture plan is never
written. OCR text holds player names, so the state folder must be gitignored or outside the repo
(the tool refuses otherwise); the console shows only item ids, segment names and times.

Subcommands
  watch   follow a folder that tools/capture/record.py is writing; process each segment once it
          is final (the next segment exists, or the STOP file, or the recorder state file says
          stopped/failed, or the recorder's processes are gone after a kill or crash).
          After an ffmpeg crash record.py restarts into the next segment index: the segment
          in flight at the crash is final once the next one exists, and each restart gap
          from <name>.gaps.jsonl is printed as a `gap:` line.
          --dir DIR --name PREFIX [--once]
  files   existing recordings (files or folders, e.g. normal play or stream VODs)
          PATH [PATH ...] [--scan FILE.jsonl ... (reuse g1_scan scan rows instead of new OCR)]
  status  print the coverage of every plan item and the "still missing" list   [--json]
  mark    the user confirms an item (manual items, or anything the tracker missed)
          ITEM [--candidate N | --segment FILE --t SEC] [--note TEXT] [--clear]

Common: --pack data/games/<id> [--state FILE]; watch/files also --profile, --layout, --fps,
--diff-gate, --name-min, --session-label, --hwaccel; global --threads N (OCR threads, default 4).
The process and its ffmpeg children run at below-normal priority, OCR on --threads threads, so
the tracker never competes with the game or a live stream; lagging behind the recorder is fine.

Needs the OCR venv for watch/files (numpy, opencv-python-headless, rapidocr, onnxruntime);
status and mark are stdlib only.
"""

from __future__ import annotations

import argparse
import datetime
import glob
import json
import os
import re
import sys
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import g1_scan
import g1_text as gt
import game_pack

TOOL_VERSION = 1
MAX_CANDIDATES = 5  # candidates kept per item with crops; later ones are only counted
CANDIDATE_GAP_S = 30.0  # a kept candidate within this many seconds of the same segment makes a new one count-only
MEDIA_EXT = (".mp4", ".mkv", ".mov", ".flv", ".ts", ".m4v")
CROP_PAD = 0.03  # game-area fraction around a detection box when no ROI bounds the crop
STATE_NAME = "coverage.json"


def _now():
    return datetime.datetime.now().astimezone().isoformat(timespec="seconds")


# ---------------------------------------------------------------- plan + matching

def load_plan(pack_path):
    with open(os.path.join(game_pack.pack_dir(pack_path), "capture-plan.json"), encoding="utf-8") as f:
        return json.load(f)


def _centre_in(g, roi):
    return g1_scan._in_roi(g, roi)  # same centre test as the analyse ROI fit (no slack)


class Matcher:
    """Maps one frame's detector events to capture-plan items using the items' match criteria."""

    def __init__(self, pack, plan, names, name_min):
        self.pack = pack
        self.names = names
        self.name_min = name_min
        self.det = {d["id"]: d for d in pack["detectors"]}
        self.screens = {s["id"]: s for s in pack.get("screens", [])}
        self.items = plan["items"]
        self.tag_only = set(pack.get("taggingOnlyModes", []))

    def best_pattern(self, det_id, text):
        pats = self.det[det_id].get("patterns") or []
        t = gt.normalise(text)
        if not pats or not t:
            return None
        return max(pats, key=lambda p: gt.partial_ratio(gt.normalise(p), t))

    def check(self, c, ev, mode, name_boxes):
        """None if the criterion fails, else the region (game fractions) that bounds the evidence crop."""
        d = self.det.get(c["detector"])
        if d is None or ev["det"] != c["detector"]:
            return None
        g = ev["box"]["g"]
        if "frameModes" in c and mode not in c["frameModes"]:
            return None
        if "medal" in c and (ev.get("medal") or {}).get("medal") != c["medal"]:
            return None
        if "nameMatched" in c and ev.get("nameMatched") is not c["nameMatched"]:
            return None
        if "pattern" in c and self.best_pattern(d["id"], ev["box"]["text"]) != c["pattern"]:
            return None
        region = None
        if "rois" in c:
            rois = [r for r in d["rois"] if r["id"] in c["rois"] and _centre_in(g, r)]
            if c.get("nameInRoi") is not None:
                rois = [r for r in rois if any(_centre_in(nb["g"], r) for nb in name_boxes) == c["nameInRoi"]]
            if not rois:
                return None
            region = rois[0]
        if "screen" in c:
            cues = [q["roi"] for q in self.screens.get(c["screen"], {}).get("cues", [])
                    if q.get("roi") and _centre_in(g, q["roi"])]
            if not cues:
                return None
            region = region or cues[0]
        if region is None:
            region = {"x0": max(0.0, g[0] - CROP_PAD), "y0": max(0.0, g[1] - CROP_PAD),
                      "x1": min(1.0, g[2] + CROP_PAD), "y1": min(1.0, g[3] + CROP_PAD)}
        return {k: region[k] for k in ("x0", "y0", "x1", "y1")}

    def frame(self, boxes):
        """(frame mode, [(item, criterion index, event, crop region)]) for one frame's OCR boxes."""
        mode = g1_scan.classify_frame(boxes)
        if mode in self.tag_only:
            return mode, []
        evs = g1_scan.find_events(boxes, self.pack, self.names, self.name_min)
        name_boxes = [e["box"] for e in evs if e["det"] == "NAME"]
        out = []
        for item in self.items:
            done = False
            for ci, c in enumerate(item["match"].get("when", [])):
                for ev in evs:
                    region = self.check(c, ev, mode, name_boxes)
                    if region is not None:
                        out.append((item, ci, ev, region))
                        done = True
                        break
                if done:
                    break
        return mode, out


# ---------------------------------------------------------------- state

def default_state(pack_path):
    return os.path.join(game_pack.pack_dir(pack_path), "local", STATE_NAME)


def empty_state(plan, pack):
    return {"tool": "coverage", "toolVersion": TOOL_VERSION, "game": plan["game"], "planVersion": plan["version"],
            "packVersion": pack.get("version") if pack else None, "created": _now(), "updated": None,
            "items": {}, "processed": {}}


def sync_items(state, plan):
    """Every plan item has a state entry; confirm mode follows the plan."""
    for i in plan["items"]:
        e = state["items"].setdefault(i["id"], {"status": "missing", "evidence": None, "candidates": [],
                                                "candidateCount": 0})
        e["confirm"] = i["match"]["confirm"]
        e["mode"] = i["mode"]
    return state


class StateFile:
    """coverage.json with a lock file, so `mark` can run while `watch` is writing."""

    def __init__(self, path):
        self.path = os.path.abspath(path)
        self.lock = self.path + ".lock"

    def _acquire(self, timeout=30.0):
        t0 = time.monotonic()
        while True:
            try:
                fd = os.open(self.lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(fd, str(os.getpid()).encode())
                os.close(fd)
                return
            except FileExistsError:
                try:
                    if time.time() - os.path.getmtime(self.lock) > 120:  # stale lock of a killed process
                        os.unlink(self.lock)
                        continue
                except OSError:
                    continue
                if time.monotonic() - t0 > timeout:
                    raise TimeoutError(f"state lock busy: {self.lock}")
                time.sleep(0.2)

    def read(self):
        try:
            with open(self.path, encoding="utf-8") as f:
                return json.load(f)
        except FileNotFoundError:
            return None

    def update(self, fn, plan, pack=None):
        """Load (or create), apply fn(state), write atomically; returns the new state."""
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        self._acquire()
        try:
            st = self.read() or empty_state(plan, pack)
            sync_items(st, plan)
            fn(st)
            st["updated"] = _now()
            tmp = self.path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(st, f, ensure_ascii=False, indent=1)
            os.replace(tmp, self.path)
            return st
        finally:
            try:
                os.unlink(self.lock)
            except OSError:
                pass


def missing_ids(state, plan):
    return [i["id"] for i in plan["items"] if state["items"].get(i["id"], {}).get("status") != "captured"]


def missing_line(state, plan):
    parts = []
    for iid in missing_ids(state, plan):
        n = state["items"].get(iid, {}).get("candidateCount", 0)
        parts.append(f"{iid} ({n} candidate{'s' if n != 1 else ''})" if n else iid)
    return "still missing: " + (", ".join(parts) if parts else "nothing")


# ---------------------------------------------------------------- recorder folder (watch)

def _seg_index(path, name):
    m = re.fullmatch(re.escape(name) + r"-(\d+)\.mp4", os.path.basename(path))
    return int(m.group(1)) if m else None


def segment_files(folder, name):
    """record.py segments in index order (numeric; a restart after a crash continues the index)."""
    found = [p for p in glob.glob(os.path.join(folder, f"{name}-*.mp4")) if _seg_index(p, name) is not None]
    return sorted(found, key=lambda p: _seg_index(p, name))


def read_gaps(folder, name):
    """record.py restart gaps (<name>.gaps.jsonl; one JSON object per line, written when a gap ends)."""
    rows = []
    try:
        with open(os.path.join(folder, f"{name}.gaps.jsonl"), encoding="utf-8") as f:
            for line in f:
                try:
                    rows.append(json.loads(line))
                except ValueError:
                    pass  # a line being written
    except OSError:
        pass
    return rows


def gap_line(g):
    dur = f"{g['durationS']:.1f} s" if g.get("durationS") is not None else "open"
    return (f"gap: {g.get('reason')} (exit {g.get('exitCode')}); no recording from {g.get('startUtc')} "
            f"to {g.get('endUtc') or '(not restarted)'} ({dur}); after {g.get('afterSegment')}, "
            f"before {g.get('beforeSegment')}")


def read_recorder_state(folder, name):
    try:
        with open(os.path.join(folder, f"{name}.state.json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def pid_alive(pid):
    if not pid:
        return False
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes
        k = ctypes.WinDLL("kernel32", use_last_error=True)
        k.OpenProcess.restype = wintypes.HANDLE
        k.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        k.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        k.CloseHandle.argtypes = [wintypes.HANDLE]
        h = k.OpenProcess(0x1000, False, int(pid))  # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return ctypes.get_last_error() == 5  # access denied: the process exists
        try:
            code = wintypes.DWORD()
            ok = k.GetExitCodeProcess(h, ctypes.byref(code))
            return bool(ok) and code.value == 259  # STILL_ACTIVE
        finally:
            k.CloseHandle(h)
    try:
        os.kill(int(pid), 0)
        return True
    except OSError:
        return False


STOP_SETTLE_S = 5.0  # STOP without a record.py state file: newest segment unchanged this long = final


def recorder_ended(folder, name):
    """(ended, why). Ended = no more bytes will be written to the newest segment.

    The STOP file alone is not enough while record.py is still finalising the last segment
    ('q' to ffmpeg), so with a state file the recorder's own end state (or its processes
    being gone) decides."""
    stop = os.path.exists(os.path.join(folder, "STOP"))
    st = read_recorder_state(folder, name)
    if st is None:
        if stop:
            segs = segment_files(folder, name)
            if not segs or time.time() - os.path.getmtime(segs[-1]) >= STOP_SETTLE_S:
                return True, "STOP file (no recorder state file)"
            return False, "STOP file; waiting for the last segment to settle"
        return False, "no recorder state yet"
    if st.get("state") in ("stopped", "ffmpeg_failed", "failed"):
        return True, f"recorder {st['state']}" + (f": {st['failReason']}" if st.get("failReason") else "")
    if not pid_alive(st.get("pid")) and not pid_alive(st.get("ffmpegPid")):
        return True, "recorder processes gone (killed or crashed)"
    return False, "stopping" if stop else "recording"


def final_segments(folder, name):
    """Segments that will not grow any more: all but the newest, and the newest once the recorder ended."""
    segs = segment_files(folder, name)
    ended, why = recorder_ended(folder, name)
    return (segs if ended else segs[:-1]), segs, ended, why


# ---------------------------------------------------------------- tracker

class Tracker:
    def __init__(self, a, pack, plan, names, out=print):
        self.a = a
        self.pack = pack
        self.plan = plan
        self.matcher = Matcher(pack, plan, names, a.name_min)
        self.state_file = StateFile(a.state)
        self.state_dir = os.path.dirname(self.state_file.path)
        self.crops_dir = os.path.join(self.state_dir, "coverage-crops")
        self.scans_dir = os.path.join(self.state_dir, "coverage-scans")
        self.out = out
        self.layout_doc = g1_scan.load_layout(a.layout) if a.layout else None
        if self.layout_doc and "layout" in self.layout_doc:
            self.layout_doc = self.layout_doc["layout"]
        st = self.state_file.update(lambda s: None, plan, pack)
        self._sync(st)

    def _sync(self, st):
        self.captured = {k for k, v in st["items"].items() if v.get("status") == "captured"}
        self.cand_count = {k: v.get("candidateCount", 0) for k, v in st["items"].items()}
        self.cand_kept = {k: [(c.get("segment"), c.get("t")) for c in v.get("candidates") or []]
                          for k, v in st["items"].items()}

    def _keep_candidate(self, iid, seg_path, t):
        """A candidate gets a crop and a `mark --candidate` number only while fewer than MAX_CANDIDATES
        are kept and none of them is from the same segment within CANDIDATE_GAP_S (one screen shown
        for many sampled frames is one candidate)."""
        kept = self.cand_kept.get(iid, [])
        seg = os.path.abspath(seg_path)
        return len(kept) < MAX_CANDIDATES and not any(
            s == seg and tt is not None and abs(t - tt) < CANDIDATE_GAP_S for s, tt in kept)

    def processed(self):
        st = self.state_file.read() or {}
        return st.get("processed", {})

    def layout_for(self, path):
        if self.layout_doc:
            return self.layout_doc
        w, h = g1_scan.probe_size(path)
        return g1_scan.full_screen_layout(w, h, [0, 0, w, h])

    def _save_crop(self, item_id, seg_name, t, img, origin, layout, region, kind):
        import cv2
        os.makedirs(self.crops_dir, exist_ok=True)
        gx, gy, gw, gh = layout["game"]
        ox, oy = origin
        h, w = img.shape[:2]
        x0 = max(0, int(region["x0"] * gw + gx - ox))
        y0 = max(0, int(region["y0"] * gh + gy - oy))
        x1 = min(w, int(round(region["x1"] * gw + gx - ox)))
        y1 = min(h, int(round(region["y1"] * gh + gy - oy)))
        stem = f"{item_id}__{os.path.splitext(seg_name)[0]}@{t:08.2f}-{kind}"
        crop = os.path.join(self.crops_dir, stem + ".png")
        frame = os.path.join(self.crops_dir, stem + "-frame.jpg")
        if x1 > x0 and y1 > y0:
            cv2.imwrite(crop, img[y0:y1, x0:x1])
        else:
            crop = None
        s = 640 / w
        cv2.imwrite(frame, cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA))
        return crop, frame

    def on_frame(self, boxes, seg_path, t, img, origin, layout, pending):
        """Match one frame; record new captures/candidates in `pending` and print them."""
        mode, hits = self.matcher.frame(boxes)
        seg_name = os.path.basename(seg_path)
        for item, ci, ev, region in hits:
            iid = item["id"]
            auto = item["match"]["confirm"] == "auto"
            ev_rec = {"segment": os.path.abspath(seg_path), "segmentName": seg_name, "t": round(t, 3),
                      "det": ev["det"], "criterion": ci, "frameMode": mode, "at": _now(),
                      "packVersion": self.pack.get("version")}
            if auto:
                if iid in self.captured:
                    continue
                if img is not None:
                    ev_rec["crop"], ev_rec["frame"] = self._save_crop(iid, seg_name, t, img, origin, layout, region,
                                                                      "captured")
                ev_rec["by"] = "tracker"
                self.captured.add(iid)
                pending["captured"][iid] = ev_rec
                self.out(f"captured: {iid} at {seg_name}@{t:.1f}")
            else:
                if iid in self.captured:
                    continue
                self.cand_count[iid] = self.cand_count.get(iid, 0) + 1
                keep = self._keep_candidate(iid, seg_path, t)
                if keep:
                    self.cand_kept.setdefault(iid, []).append((os.path.abspath(seg_path), round(t, 3)))
                    if img is not None:
                        n = len(self.cand_kept[iid])
                        ev_rec["crop"], ev_rec["frame"] = self._save_crop(iid, seg_name, t, img, origin, layout,
                                                                          region, f"cand{n}")
                pending["candidates"].setdefault(iid, []).append(ev_rec if keep else None)
                key = (iid, seg_name)
                if key not in pending["announced"]:
                    pending["announced"].add(key)
                    self.out(f"candidate: {iid} at {seg_name}@{t:.1f} (manual: confirm with `coverage.py mark {iid}`)")

    def commit(self, seg_path, pending, stats):
        def fn(st):
            for iid, ev in pending["captured"].items():
                e = st["items"][iid]
                if e.get("status") != "captured":  # a user mark made meanwhile wins
                    e["status"] = "captured"
                    e["evidence"] = ev
            for iid, evs in pending["candidates"].items():
                e = st["items"][iid]
                for ev in evs:
                    e["candidateCount"] = e.get("candidateCount", 0) + 1
                    if ev is not None and len(e["candidates"]) < MAX_CANDIDATES:
                        e["candidates"].append(ev)
            if seg_path:
                st["processed"][os.path.abspath(seg_path)] = stats
            st["packVersion"] = self.pack.get("version")
        st = self.state_file.update(fn, self.plan, self.pack)
        self._sync(st)
        return st

    def _needs_crop(self, hits, seg_path, t):
        for item, _ci, _ev, _r in hits:
            iid = item["id"]
            if iid in self.captured:
                continue
            if item["match"]["confirm"] == "auto" or self._keep_candidate(iid, seg_path, t):
                return True
        return False

    def _pending(self):
        return {"captured": {}, "candidates": {}, "announced": set()}

    def process_media(self, path, session):
        """Sample, OCR and match one media file; append its scan rows; commit to the state."""
        layout = self.layout_for(path)
        v = g1_scan.visible_box(layout)
        origin = (v[0], v[1])
        os.makedirs(self.scans_dir, exist_ok=True)
        scan_path = os.path.join(self.scans_dir, f"{session}.jsonl")
        pending = self._pending()
        n_ocr = n_skip = 0
        last = None
        t0 = time.time()
        meta = {"src": "clip", "session": session, "clip": os.path.basename(path)}
        with open(scan_path, "a", encoding="utf-8") as fo:
            for t, img in g1_scan.decode_frames(path, self.a.fps, crop=v, hwaccel=self.a.hwaccel):
                rec, last = g1_scan.scan_frame(meta, t, img, origin, layout, last, self.a.diff_gate)
                fo.write(json.dumps(rec, ensure_ascii=False) + "\n")
                if "boxes" in rec:
                    n_ocr += 1
                    self.on_frame(rec["boxes"], path, t, img, origin, layout, pending)
                else:
                    n_skip += 1
            fo.flush()
        stats = {"session": session, "bytes": os.path.getsize(path), "mtime": os.path.getmtime(path),
                 "framesOcr": n_ocr, "framesSkipped": n_skip, "seconds": round(time.time() - t0, 1),
                 "fps": self.a.fps, "source": "ocr", "at": _now()}
        return self.commit(path, pending, stats), stats

    def process_scan_rows(self, path, rows, session):
        """Match existing g1_scan rows for one media file; crops are cut from `path` when it exists."""
        layout = self.layout_for(path) if os.path.exists(path) else self.layout_doc
        pending = self._pending()
        n = 0
        t0 = time.time()
        for r in rows:
            if "boxes" not in r:
                continue
            n += 1
            img = origin = None
            mode, hits = self.matcher.frame(r["boxes"])
            if hits and layout and os.path.exists(path) and self._needs_crop(hits, path, r["t"]):
                full = g1_scan.grab_frame(path, r["t"])
                if full is not None:
                    v = g1_scan.visible_box(layout)
                    img, origin = full[v[1]:v[3], v[0]:v[2]], (v[0], v[1])
            if hits:
                self.on_frame(r["boxes"], path, r["t"], img, origin, layout, pending)
        stats = {"session": session, "framesOcr": n, "framesSkipped": len(rows) - n,
                 "seconds": round(time.time() - t0, 1), "source": "scan", "at": _now()}
        return self.commit(path, pending, stats), stats


def _check_state_location(state_path):
    g1_scan.check_private_out(os.path.dirname(os.path.abspath(state_path)))


def _setup(a):
    pack = game_pack.load_pack(a.pack)
    plan = load_plan(a.pack)
    if plan["game"] != pack["game"]["id"]:
        sys.exit(f"capture plan game {plan['game']!r} does not match pack {pack['game']['id']!r}")
    a.state = a.state or default_state(a.pack)
    _check_state_location(a.state)
    return pack, plan


def _names(a, pack):
    names, _clan = g1_scan.load_names(a.profile, pack["nameMatch"]["profileKey"])
    return names


def cmd_watch(a):
    pack, plan = _setup(a)
    tr = Tracker(a, pack, plan, _names(a, pack), out=lambda s: print(s, flush=True))
    folder = os.path.abspath(a.dir)
    session = a.session_label or a.name
    print(f"watching {folder} for {a.name}-*.mp4 (plan {plan['game']} v{plan['version']}, pack {pack['version']}, "
          f"{len(plan['items'])} items; state {tr.state_file.path})", flush=True)
    st = tr.state_file.read()
    print(missing_line(st, plan), flush=True)
    gaps_seen = 0
    while True:
        finals, segs, ended, why = final_segments(folder, a.name)
        gaps = read_gaps(folder, a.name)
        for g in gaps[gaps_seen:]:
            print(gap_line(g), flush=True)
        gaps_seen = len(gaps)
        done = tr.processed()
        todo = [s for s in finals if os.path.abspath(s) not in done]
        for s in todo:
            st, stats = tr.process_media(s, session)
            finals2, segs2, _e, _w = final_segments(folder, a.name)
            behind = len(segs2) - 1 - segs2.index(s) if s in segs2 else 0
            print(f"segment {os.path.basename(s)}: {stats['framesOcr']} frames OCR'd, {stats['framesSkipped']} "
                  f"diff-gated, {stats['seconds']:.0f} s; {behind} segment(s) behind the recorder", flush=True)
            print(missing_line(st, plan), flush=True)
        if ended and not todo and all(os.path.abspath(s) in tr.processed() for s in segs):
            print(f"recorder ended ({why}); all {len(segs)} segment(s) processed", flush=True)
            break
        if a.once:
            break
        time.sleep(a.poll)
    print(missing_line(tr.state_file.read(), plan), flush=True)


def expand_media(paths):
    out = []
    for p in paths:
        if os.path.isdir(p):
            out += sorted(os.path.join(p, f) for f in os.listdir(p) if f.lower().endswith(MEDIA_EXT))
        elif os.path.isfile(p):
            out.append(p)
        else:
            sys.exit(f"not found: {p}")
    return out


def cmd_files(a):
    pack, plan = _setup(a)
    tr = Tracker(a, pack, plan, _names(a, pack), out=lambda s: print(s, flush=True))
    media = expand_media(a.paths)
    rows_by_clip = None
    if a.scan:
        rows_by_clip = {}
        for sp in a.scan:
            with open(sp, encoding="utf-8") as f:
                for line in f:
                    r = json.loads(line)
                    rows_by_clip.setdefault(r.get("clip") or r.get("image"), []).append(r)
    print(f"files: {len(media)} recording(s) (plan {plan['game']} v{plan['version']}, pack {pack['version']}; "
          f"state {tr.state_file.path})", flush=True)
    done = tr.processed()
    for p in media:
        key = os.path.abspath(p)
        if key in done and not a.force:
            print(f"skip {os.path.basename(p)}: already processed", flush=True)
            continue
        session = a.session_label or os.path.basename(os.path.dirname(key))
        if rows_by_clip is not None:
            rows = rows_by_clip.get(os.path.basename(p))
            if not rows:
                print(f"skip {os.path.basename(p)}: no scan rows", flush=True)
                continue
            st, stats = tr.process_scan_rows(p, rows, session)
        else:
            st, stats = tr.process_media(p, session)
        print(f"{os.path.basename(p)}: {stats['framesOcr']} frames ({stats['source']}), {stats['seconds']:.0f} s",
              flush=True)
        print(missing_line(st, plan), flush=True)


def status_rows(state, plan):
    rows = []
    for i in plan["items"]:
        e = (state or {}).get("items", {}).get(i["id"], {})
        ev = e.get("evidence") or {}
        rows.append({"id": i["id"], "mode": i["mode"], "confirm": i["match"]["confirm"],
                     "status": e.get("status", "missing"),
                     "evidence": (f"{ev.get('segmentName') or os.path.basename(ev.get('segment') or '')}@{ev['t']:.1f}"
                                  if ev.get("t") is not None else ("marked" if ev else None)),
                     "by": ev.get("by"), "crop": ev.get("crop"),
                     "candidates": e.get("candidateCount", 0)})
    return rows


def cmd_status(a):
    plan = load_plan(a.pack)
    a.state = a.state or default_state(a.pack)
    st = StateFile(a.state).read()
    if st is None:
        st = sync_items(empty_state(plan, None), plan)
    rows = status_rows(st, plan)
    if a.json:
        print(json.dumps({"state": os.path.abspath(a.state), "updated": st.get("updated"),
                          "processed": len(st.get("processed", {})), "items": rows,
                          "missing": missing_ids(st, plan)}, ensure_ascii=False))
        return
    print(f"coverage: {plan['game']} plan v{plan['version']}; state {os.path.abspath(a.state)} "
          f"(updated {st.get('updated')}); {len(st.get('processed', {}))} recording(s) processed")
    w = max(len(r["id"]) for r in rows)
    for r in rows:
        ev = r["evidence"] or "-"
        extra = f" by {r['by']}" if r["by"] else ""
        cand = f", {r['candidates']} candidate(s)" if r["candidates"] else ""
        print(f"  {r['id']:<{w}}  {r['mode']:<3} {r['confirm']:<6} {r['status']:<8} {ev}{extra}{cand}")
    print(missing_line(st, plan))


def cmd_mark(a):
    plan = load_plan(a.pack)
    ids = [i["id"] for i in plan["items"]]
    if a.item not in ids:
        sys.exit(f"unknown item {a.item!r}; plan items: {', '.join(ids)}")
    a.state = a.state or default_state(a.pack)
    _check_state_location(a.state)
    sf = StateFile(a.state)

    def fn(st):
        e = st["items"][a.item]
        if a.clear:
            e["status"], e["evidence"] = "missing", None
            return
        ev = {"by": "mark", "at": _now(), "note": a.note}
        if a.candidate is not None:
            cands = e.get("candidates") or []
            if not 1 <= a.candidate <= len(cands):
                sys.exit(f"{a.item}: candidate {a.candidate} not found ({len(cands)} stored)")
            ev.update({k: v for k, v in cands[a.candidate - 1].items() if k not in ("at", "by")})
            ev["candidate"] = a.candidate
        elif a.segment:
            ev.update({"segment": os.path.abspath(a.segment), "segmentName": os.path.basename(a.segment),
                       "t": a.t})
        e["status"], e["evidence"] = "captured", ev

    st = sf.update(fn, plan)
    print(f"{'cleared' if a.clear else 'marked'}: {a.item}")
    print(missing_line(st, plan))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--threads", type=int, default=g1_scan.DEFAULT_THREADS,
                    help="onnxruntime intra-op threads for OCR (inter-op 1); default 4")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(p):
        p.add_argument("--pack", required=True, help="game pack folder (data/games/<id>)")
        p.add_argument("--state", help="coverage state file (default <pack>/local/coverage.json, gitignored)")

    def scanning(p):
        p.add_argument("--profile", required=True, help="profile with the names (data/profile.local.json)")
        p.add_argument("--layout", help="g1_scan layout JSON (game area in the frame); default full frame")
        p.add_argument("--fps", type=float, default=1.0, help="sampled frames per second (A5b/A5c used 1)")
        p.add_argument("--diff-gate", type=float, default=1.5, help="as g1_scan scan --diff-gate")
        p.add_argument("--name-min", type=float, default=0.8, help="as g1_scan analyse --name-min")
        p.add_argument("--session-label", help="session id in the scan rows (default: name prefix / folder name)")
        p.add_argument("--hwaccel", help="ffmpeg -hwaccel for decoding (default: CPU, 2 threads)")

    p = sub.add_parser("watch", help="follow a record.py capture folder")
    common(p)
    scanning(p)
    p.add_argument("--dir", required=True)
    p.add_argument("--name", required=True, help="record.py --name prefix")
    p.add_argument("--poll", type=float, default=2.0)
    p.add_argument("--once", action="store_true", help="process the final segments present now, then exit")
    p.set_defaults(fn=cmd_watch)

    p = sub.add_parser("files", help="existing recordings (files or folders)")
    common(p)
    scanning(p)
    p.add_argument("paths", nargs="+")
    p.add_argument("--scan", nargs="+", help="reuse g1_scan scan JSONL rows (matched by clip file name)")
    p.add_argument("--force", action="store_true", help="process recordings already in the state again")
    p.set_defaults(fn=cmd_files)

    p = sub.add_parser("status")
    common(p)
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_status)

    p = sub.add_parser("mark", help="confirm an item by hand")
    common(p)
    p.add_argument("item")
    p.add_argument("--candidate", type=int, help="use stored candidate N (1-based) as the evidence")
    p.add_argument("--segment", help="recording file of the evidence")
    p.add_argument("--t", type=float, help="time in the recording (s)")
    p.add_argument("--note", help="free text (local only)")
    p.add_argument("--clear", action="store_true", help="set the item back to missing")
    p.set_defaults(fn=cmd_mark)

    a = ap.parse_args(argv)
    if a.threads < 1:
        ap.error("--threads must be >= 1")
    if a.cmd in ("watch", "files"):
        g1_scan.set_ocr_params(g1_scan.thread_params(a.threads))
        g1_scan.lower_own_priority()
    a.fn(a)


if __name__ == "__main__":
    main()
