# SPDX-License-Identifier: GPL-3.0-or-later
"""F6 output layout (user 2026-11-08): finished videos to the clips folder under the clip_names.py convention, every
other file in the app data folder; the live clipper's replay saves removed once edited; `tidy` for older folders.

publish(work, to, data_dir, ...) -> [row]   each validated (PASS) video of a run folder in app data is linked (a hard
    link, so no second copy on disk; a copy when the folders are on different drives) into
    <to>/<YYYY-MM-DD>/<convention name>.mp4. The run folder keeps its own file (posting packages from it). Rows go to
    <work>/published.json and the upload list <data>/clips/uploads.json ({file, kind, label, run, posted: []}).
drop_used_saves(paths) -> deleted   the live clipper's replay saves (host names replay-<H|V>-<stamp>[-n].mkv inside a
    'replay' folder) after live-review made clips from them. Anything else is never touched.
tidy_plan(recordings, clips, data_dir) -> [action]   read-only; `apply_plan` acts on it (clipper.py tidy --apply).
"""

from __future__ import annotations

import json
import os
import re
import shutil
from datetime import datetime

import clip_names as names
from clip_common import ClipError, load_json, write_json_atomic

PUBLISHED = "published.json"
UPLOADS = os.path.join("clips", "uploads.json")
RUNS = os.path.join("clips", "runs")
ANALYSIS = ("candidates.json", "detector-hits.jsonl", "detector-pass.json", "match-stats.json", "matches.json",
            "render.json", "report.json", PUBLISHED)
REPLAY_RE = re.compile(r"^replay-[HV]-\d{8}-\d{6}(-\d+)?\.mkv$", re.IGNORECASE)
RECORDING_RE = re.compile(r"^[A-Za-z0-9._-]+-[hv]-\d{8}-\d{6}\.(mkv|mp4|mov)$", re.IGNORECASE)
STAMP_RE = re.compile(r"(\d{8}-\d{6})")


def _stamp_time(text):
    m = STAMP_RE.search(text or "")
    return datetime.strptime(m.group(1), "%Y%m%d-%H%M%S") if m else None


def kind_of(clip_id, doc_tool=None):
    if str(clip_id).startswith("W"):
        return "won-reel"
    if str(clip_id).startswith("I") and (doc_tool or "").startswith("clipper.montage"):
        return "impact-play"  # D326
    if str(clip_id).startswith("M") and (doc_tool or "").startswith("clipper.montage"):
        return "montage"
    return "short"


def clip_time(clip, rec_start_local, kind):
    """Local wall time of the clip's first moment (naive datetime), or None."""
    if clip.get("wallStart") is not None:
        return names.local_time(float(clip["wallStart"]))
    if rec_start_local is None:
        return None
    from datetime import timedelta
    if kind in ("montage", "won-reel", "impact-play") and clip.get("pieces"):
        off = min(float(p["start"]) for p in clip["pieces"])
    else:
        off = float(clip.get("start") or 0.0)
    return rec_start_local + timedelta(seconds=off)


def _kills(clip):
    return sum(int(p.get("kills") or 0) for p in clip.get("pieces") or [])


def name_rows(rdoc, game, layouts_by_id, det_weights=None, rec_start_local=None):
    """[(clip, file row, kind, when, label, canvas)] for every rendered file of a render.json (no file access)."""
    tool = rdoc.get("tool") or ""
    if rec_start_local is None:
        rec_start_local = _stamp_time(rdoc.get("recording"))
    out = []
    for c in rdoc.get("clips") or []:
        kind = kind_of(c.get("id"), tool)
        when = clip_time(c, rec_start_local, kind) or _stamp_time(c.get("source")) or datetime.now()
        label = names.label_for(kind, c.get("labels"), _kills(c), det_weights, part=c.get("part"), parts=c.get("parts"))
        for f in c.get("files") or []:
            lay = layouts_by_id.get(f.get("layout")) or ({"input": "v"} if str(f.get("layout", "")).endswith("-v") else
                                                          {"id": f.get("layout")})
            out.append((c, f, kind, when, label, names.canvas_suffix(lay)))
    return out


def _link_or_copy(src, dst):
    try:
        os.link(src, dst)
        return "link"
    except OSError:
        shutil.copy2(src, dst)
        return "copy"


def _passed(report):
    """{(id, file): ok} from report.json; None when there is no report."""
    if not report:
        return None
    return {(r.get("id"), r.get("file")): bool(r.get("ok")) for r in report.get("results") or []}


def publish(work, to, data_dir, game, layouts_by_id, det_weights=None, run_name=None, rec_start_local=None):
    """Links each PASS video of the run folder `work` into the clips folder `to`. Returns the rows written."""
    rdoc = load_json(os.path.join(work, "render.json"))
    rep_path = os.path.join(work, "report.json")
    passed = _passed(load_json(rep_path) if os.path.isfile(rep_path) else None)
    if passed is None:
        raise ClipError("publish needs report.json (validate first)")
    prev_path = os.path.join(work, PUBLISHED)
    try:
        prev = [r for r in (load_json(prev_path).get("files") or []) if os.path.isfile(r.get("file", ""))]             if os.path.isfile(prev_path) else []
    except ClipError:
        prev = []
    done = {(r.get("id"), r.get("layout")) for r in prev}
    rows, counters = [], {}
    for c, f, kind, when, label, canvas in name_rows(rdoc, game, layouts_by_id, det_weights, rec_start_local):
        if not passed.get((c["id"], f["file"])) or (c["id"], f["layout"]) in done:
            continue
        src = os.path.join(work, "clips", c["id"], f["file"])
        if not os.path.isfile(src):
            continue
        day = os.path.join(to, names.day_folder(when))
        os.makedirs(day, exist_ok=True)
        start_nn = counters.get((kind, canvas), 0) + 1
        name, nn = names.free_name(lambda n: os.path.exists(os.path.join(day, n)),
                                   lambda n: names.clip_name(game, kind, when, label, n, canvas), start_nn)
        counters[(kind, canvas)] = nn
        how = _link_or_copy(src, os.path.join(day, name))
        rows.append({"id": c["id"], "layout": f["layout"], "file": os.path.join(day, name), "how": how, "kind": kind,
                     "label": label, "seconds": round(float(c["end"]) - float(c["start"]), 3),
                     **({"thumbnail": True} if f.get("thumbnail") else {})})  # RP6: frame 0 is the cover
    run = run_name or os.path.basename(os.path.normpath(work))
    write_json_atomic(prev_path, {"tool": "clipper.publish", "to": to, "files": prev + rows})
    if data_dir and rows:
        add_uploads(data_dir, [{**{k: r[k] for k in ("file", "kind", "label", "seconds")}, "run": run,
                                "recording": rdoc.get("recording"), "posted": [],
                                **({"thumbnail": True} if r.get("thumbnail") else {})} for r in rows])
    return rows


def add_uploads(data_dir, rows):
    p = os.path.join(data_dir, UPLOADS)
    try:
        doc = load_json(p) if os.path.isfile(p) else {}
    except ClipError:
        doc = {}
    files = [x for x in doc.get("files") or [] if isinstance(x, dict)]
    have = {x.get("file") for x in files}
    now = datetime.now().astimezone().isoformat(timespec="seconds")
    files += [{**r, "addedAt": now} for r in rows if r["file"] not in have]
    os.makedirs(os.path.dirname(p), exist_ok=True)
    write_json_atomic(p, {"$comment": "Finished clips in the clips folder and where each was posted (posted: "
                                      "[{target, at, id}]). Written by clipper.py publish; read by the studio.",
                          "version": 1, "files": files})


def is_replay_save(path):
    return bool(REPLAY_RE.match(os.path.basename(path))) and os.path.basename(os.path.dirname(path)).lower() == "replay"


def drop_used_saves(paths):
    """Deletes the given live-clipper replay saves (host-named, in a replay folder). Returns the deleted paths."""
    gone = []
    for p in sorted(set(paths)):
        if is_replay_save(p) and os.path.isfile(p):
            try:
                os.remove(p)
                gone.append(p)
            except OSError:
                pass
    return gone


# ---------------------------------------------------------------- tidy (older folders)

def _saves_rows(data_dir):
    rows = []
    root = os.path.join(data_dir, "live-clips") if data_dir else None
    if not root or not os.path.isdir(root):
        return rows
    for d in sorted(os.listdir(root)):
        p = os.path.join(root, d, "saves.jsonl")
        if os.path.isfile(p):
            with open(p, encoding="utf-8") as f:
                for line in f:
                    try:
                        rows.append(json.loads(line))
                    except ValueError:
                        pass
    return rows


def _norm(p):
    return os.path.normcase(os.path.normpath(p))


def _run_dirs(root):
    """Run folders (with render.json or any analysis file) under a clips folder, the montage sub-runs included."""
    out = []
    for e in sorted(os.listdir(root)):
        d = os.path.join(root, e)
        if not os.path.isdir(d) or re.match(r"^\d{4}-\d{2}-\d{2}$", e):
            continue
        out.append(d)
    return out


def tidy_plan(recordings, clips, data_dir, game="game", layouts_by_id=None, det_weights=None):
    """Read-only plan: [{action, src, dst?, why}], action in move | rename | delete | keep | leave."""
    plan, used = [], set()
    saves = _saves_rows(data_dir)
    save_v = {}  # V basename -> (wall start, [H, V paths])
    for r in saves:
        fs = [f.get("path") for f in r.get("files") or [] if f.get("path")]
        v = next((f.get("path") for f in r.get("files") or [] if str(f.get("canvas", "")).upper() == "V"), None)
        try:
            at = datetime.fromisoformat(str(r.get("at")).replace("Z", "+00:00")).timestamp()
        except ValueError:
            at = None
        if v:
            save_v[os.path.basename(v).lower()] = ((at - float(r.get("startBack") or 0)) if at else None, fs)
    runs_root = os.path.join(data_dir, RUNS) if data_dir else None
    if clips and os.path.isdir(clips):
        for d in _run_dirs(clips):
            run = os.path.basename(d)
            subs = [d] + ([os.path.join(d, "montage")] if os.path.isdir(os.path.join(d, "montage")) else [])
            g = game
            dp = os.path.join(d, "detector-pass.json")
            if os.path.isfile(dp):
                try:
                    g = load_json(dp).get("game") or game
                except ClipError:
                    pass
            videos = set()
            counters = {}
            for sd in subs:
                rp = os.path.join(sd, "render.json")
                if not os.path.isfile(rp):
                    continue
                rdoc = load_json(rp)
                rep = os.path.join(sd, "report.json")
                passed = _passed(load_json(rep) if os.path.isfile(rep) else None)
                for c in rdoc.get("clips") or []:
                    if c.get("source") and c.get("wallStart") is None:
                        hit = save_v.get(str(c["source"]).lower())
                        if hit and hit[0] is not None:
                            c["wallStart"] = hit[0] + float(c.get("start") or 0.0)
                            used.update(_norm(x) for x in hit[1])
                for c, f, kind, when, label, canvas in name_rows(rdoc, g, layouts_by_id or {}, det_weights,
                                                                 _stamp_time(run)):
                    src = os.path.join(sd, "clips", c["id"], f["file"])
                    if not os.path.isfile(src):
                        continue
                    videos.add(_norm(src))
                    day = os.path.join(clips, names.day_folder(when))
                    nn = counters.get((kind, canvas), 0) + 1
                    taken = {_norm(a.get("dst", "")) for a in plan}
                    name, nn = names.free_name(lambda n: os.path.exists(os.path.join(day, n)) or
                                               _norm(os.path.join(day, n)) in taken,
                                               lambda n: names.clip_name(g, kind, when, label, n, canvas), nn)
                    counters[(kind, canvas)] = nn
                    ok = None if passed is None else passed.get((c["id"], f["file"]))
                    why = "finished clip, renamed by the convention" + (
                        "" if ok else " (not validated)" if ok is None else " (validation FAILED: check before posting)")
                    plan.append({"action": "rename", "src": src, "dst": os.path.join(day, name), "why": why})
            for base, _dirs, files in os.walk(d):
                for fn in files:
                    p = os.path.join(base, fn)
                    if _norm(p) in videos:
                        continue
                    rel = os.path.relpath(p, d)
                    dst = os.path.join(runs_root, run, rel) if runs_root else None
                    plan.append({"action": "move", "src": p, "dst": dst,
                                 "why": "analysis or working file: to the app data folder"})
        for e in sorted(os.listdir(clips)):
            p = os.path.join(clips, e)
            if os.path.isfile(p):
                plan.append({"action": "leave", "src": p, "why": "unknown file in the clips folder: left alone"})
    if recordings and os.path.isdir(recordings):
        for e in sorted(os.listdir(recordings)):
            p = os.path.join(recordings, e)
            if os.path.isfile(p):
                plan.append({"action": "keep" if RECORDING_RE.match(e) else "leave", "src": p,
                             "why": "full recording (<profile>-<h|v>-<YYYYMMDD-HHMMSS>)" if RECORDING_RE.match(e)
                             else "not a recording name: left alone"})
        rd = os.path.join(recordings, "replay")
        listed = {_norm(x) for r in saves for x in [f.get("path") for f in r.get("files") or []] if x}
        if os.path.isdir(rd):
            for e in sorted(os.listdir(rd)):
                p = os.path.join(rd, e)
                if not os.path.isfile(p):
                    continue
                n = _norm(p)
                if n in used and is_replay_save(p):
                    plan.append({"action": "delete", "src": p, "why": "live clipper save, already edited into clips"})
                elif n in listed:
                    plan.append({"action": "keep", "src": p,
                                 "why": "live clipper save not yet edited into clips (the full recording also has it)"})
                else:
                    plan.append({"action": "keep", "src": p, "why": "replay saved by hand (host name): kept"})
    return plan


def apply_plan(plan, clips=None):
    """Acts on a tidy plan: renames and moves never overwrite (an existing target is skipped); deletes only live
    clipper replay saves. Then removes run folders left empty under `clips`. Returns {done, skipped}."""
    done, skipped = [], []
    for a in plan:
        act, src, dst = a["action"], a["src"], a.get("dst")
        try:
            if act in ("rename", "move"):
                if not dst or os.path.exists(dst) or not os.path.isfile(src):
                    skipped.append({**a, "reason": "target exists or source gone"})
                    continue
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.move(src, dst)
            elif act == "delete":
                if not is_replay_save(src):
                    skipped.append({**a, "reason": "not a replay save"})
                    continue
                os.remove(src)
            else:
                continue
            done.append(a)
        except OSError as e:
            skipped.append({**a, "reason": str(e)[:200]})
    if clips and os.path.isdir(clips):
        for d in _run_dirs(clips):
            for base, _dirs, _files in sorted(os.walk(d), key=lambda x: -len(x[0])):
                try:
                    os.rmdir(base)  # only empty folders
                except OSError:
                    pass
    return {"done": done, "skipped": skipped}
