# SPDX-License-Identifier: GPL-3.0-or-later
"""F6 post-stream clipper (docs/plan/2026-11-03-f6-clip-pipeline-plan.md). Behind the feature flag `clip-pipeline`
(data/flags.json, off by default): every subcommand exits 3 while the flag is off in the data dir.

  candidates  --recording FILE [--markers FILE ...] [--chat-db event-core.db] [--hits FILE] [--record-start ISO]
              [--no-audio] --out DIR
              -> DIR/candidates.json (times, scores, reasons; no chat text, no marker notes, no names)
  render      --recording FILE --out DIR [--layouts a,b,c] [--only c01,c02] [--encoder auto|libopenh264|h264_nvenc]
              [--captions none|whisper-cli|faster-whisper] [--whisper-bin F --whisper-model F] [--language xx]
              -> DIR/clips/<id>/<layout>.mp4 (+ captions.ass), DIR/render.json
  validate    --out DIR [--no-decode]  -> DIR/report.json; exit 4 when any file fails
  run         candidates + render + validate with the same options

Common: [--data-dir DIR] (flags.local.json; default paths.event_core_data from data/profile.local.json)
        [--ffmpeg F] [--ffprobe F] [--ranking F] [--layouts-file F] [--targets F]

Inputs are only read (the recording is an ffmpeg input; the chat db is opened read-only). --out must be outside the
repository or gitignored, and never inside the clips corpus. One render at a time; children run at below-normal
priority with 4 threads. Run isolated: python -I services/clip/clipper.py ...
"""

from __future__ import annotations

import argparse
import os
import sys
import tempfile
import time
from datetime import timezone

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import clip_captions as caps  # noqa: E402
import clip_rank as rank  # noqa: E402
import clip_render as rnd  # noqa: E402
import clip_signals as sig  # noqa: E402
import clip_validate as val  # noqa: E402
from clip_common import (  # noqa: E402
    EXIT_FLAG_OFF, FLAG, ClipError, check_out_dir, corpus_dir, eprint, find_tool, flag_on, load_config, load_json,
    lower_own_priority, media_info, resolve_data_dir, write_json_atomic,
)

TOOL_VERSION = 1
CANDIDATES = "candidates.json"
RENDER = "render.json"
REPORT = "report.json"


def _tools(a):
    return find_tool("ffmpeg", a.ffmpeg), find_tool("ffprobe", a.ffprobe)


def _same_recording(a, doc):
    if os.path.basename(a.recording) != doc.get("recording"):
        raise ClipError("--recording does not match the recording named in candidates.json")


# ---------------------------------------------------------------- candidates

def cmd_candidates(a):
    ffmpeg, ffprobe = _tools(a)
    cfg = load_config("ranking", a.ranking)
    if not os.path.isfile(a.recording):
        raise ClipError("recording not found")
    info = media_info(ffprobe, a.recording)
    dur = info["duration"]
    if dur <= 0:
        raise ClipError("recording has no duration")
    start = sig.recording_start(a.recording, a.record_start)
    markers, mstats = sig.read_markers(a.markers, start, dur)
    counts, intents, cstats = sig.read_chat(a.chat_db, start, dur, cfg["chat"]["intentPattern"])
    if a.no_audio or not info["has_audio"]:
        lufs, astats = None, {"available": False, "reason": "skipped" if a.no_audio else "no audio stream"}
    else:
        lufs, astats = sig.audio_loudness(ffmpeg, a.recording, dur, float(cfg["audio"]["floorLufs"]))
    hits, hstats = sig.read_hits(a.hits, dur)
    w = cfg["weights"]
    gap = int(cfg["peaks"]["minGapSec"])
    events = rank.marker_events(markers, w)
    events += rank.chat_events(counts if a.chat_db else None, intents, {**cfg["chat"], "minGapSec": gap}, w)
    aev, abase = rank.loudness_events(lufs, cfg["audio"], w, gap)
    events += aev
    events += rank.detector_events(hits, cfg.get("detectorWeights", {}))
    cands = rank.build_candidates(events, dur, cfg)
    doc = {
        "tool": "clipper", "toolVersion": TOOL_VERSION, "createdAt": _now(),
        "recording": os.path.basename(a.recording),
        "recordStartUtc": start.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
        "duration": round(dur, 3),
        "source": {k: info[k] for k in ("width", "height", "fps", "vcodec", "has_audio")},
        "ranking": {"version": cfg.get("version"), "status": cfg.get("status"), "approvedBy": cfg.get("approvedBy")},
        "signals": {
            "markers": mstats,
            "chat": cstats if a.chat_db else {"available": False},
            "audio": {**astats, **({"baseline": abase} if abase else {})},
            "detectors": hstats or {"available": False},
            "events": len(events),
        },
        "candidates": cands,
    }
    os.makedirs(a.out, exist_ok=True)
    write_json_atomic(os.path.join(a.out, CANDIDATES), doc)
    print(f"candidates: {len(cands)} from {len(events)} events "
          f"(markers {mstats['matched']}, chat {'on' if a.chat_db else 'off'}, "
          f"audio {'on' if astats.get('available') else 'off'}, detectors {len(hits)}); ranking {cfg.get('status')}")
    return 0


# ---------------------------------------------------------------- render

def cmd_render(a):
    ffmpeg, ffprobe = _tools(a)
    doc = load_json(os.path.join(a.out, CANDIDATES))
    _same_recording(a, doc)
    info = media_info(ffprobe, a.recording)
    lay_doc = load_config("layouts", a.layouts_file)
    targets = load_config("targets", a.targets)
    frame = lay_doc["output"]
    wanted = [x for x in (a.layouts or "").split(",") if x] or [x["id"] for x in lay_doc["layouts"]]
    by_id = {x["id"]: x for x in lay_doc["layouts"]}
    missing = [x for x in wanted if x not in by_id]
    if missing:
        raise ClipError(f"unknown layout(s): {', '.join(missing)}")
    only = {x for x in (a.only or "").split(",") if x}
    cands = [c for c in doc["candidates"] if not only or c["id"] in only]
    encoder = rnd.pick_encoder(a.encoder)
    safe = caps.safe_area(targets)
    opts = {"whisper_bin": a.whisper_bin, "whisper_model": a.whisper_model, "language": a.language}
    out_rows, failed = [], 0
    t0 = time.monotonic()
    for c in cands:
        wd = os.path.join(a.out, "clips", c["id"])
        os.makedirs(wd, exist_ok=True)
        dur = float(c["end"]) - float(c["start"])
        cinfo = {"backend": a.captions, "status": "off"}
        capname = None
        if a.captions != "none":
            if not info["has_audio"]:
                cinfo = {"backend": a.captions, "status": "unavailable", "reason": "no audio"}
            else:
                with tempfile.TemporaryDirectory(dir=wd) as td:
                    wav = os.path.join(td, "clip.wav")
                    caps.extract_wav(ffmpeg, a.recording, float(c["start"]), dur, wav)
                    segs, cinfo = caps.transcribe(a.captions, wav, opts)
                if segs:
                    with open(os.path.join(wd, "captions.ass"), "w", encoding="utf-8", newline="\n") as f:
                        f.write(caps.to_ass(segs, frame, safe, duration=dur))
                    capname = "captions.ass"
        files, errors = [], []
        for lid in wanted:
            lay = by_id[lid]
            t1 = time.monotonic()
            try:
                name = rnd.render_variant(ffmpeg, a.recording, info, c, lay, frame, encoder, wd, capname)
            except ClipError as e:  # one failed variant never stops the others; validate reports it
                errors.append({"layout": lid, "error": str(e)[-300:]})
                failed += 1
                eprint(f"render {c['id']}/{lid}: FAILED")
                continue
            files.append({"layout": lid, "file": name, "geometry": lay.get("geometry", "unverified"),
                          "seconds": round(time.monotonic() - t1, 2)})
            print(f"render {c['id']}/{lid}: {files[-1]['seconds']} s")
        out_rows.append({"id": c["id"], "start": c["start"], "end": c["end"], "captions": cinfo, "files": files,
                         "errors": errors})
    write_json_atomic(os.path.join(a.out, RENDER), {
        "tool": "clipper", "toolVersion": TOOL_VERSION, "createdAt": _now(), "recording": doc["recording"],
        "encoder": encoder, "frame": frame, "layoutsVersion": lay_doc.get("version"),
        "seconds": round(time.monotonic() - t0, 2), "failed": failed, "clips": out_rows,
    })
    print(f"render: {sum(len(r['files']) for r in out_rows)} file(s), {failed} failed, with {encoder}, "
          f"captions {a.captions}")
    return 0  # failures are carried into render.json; validate turns them into a non-zero exit


# ---------------------------------------------------------------- validate

def cmd_validate(a):
    ffmpeg, ffprobe = _tools(a)
    rdoc = load_json(os.path.join(a.out, RENDER))
    targets = load_config("targets", a.targets)
    frame = rdoc["frame"]
    rows, bad = [], 0
    for c in rdoc["clips"]:
        exp = float(c["end"]) - float(c["start"])
        for f in c["files"]:
            p = os.path.join(a.out, "clips", c["id"], f["file"])
            res = val.validate_file(ffmpeg, ffprobe, p, exp, frame, targets, decode=not a.no_decode)
            rows.append({"id": c["id"], "layout": f["layout"], "file": f["file"], "geometry": f["geometry"],
                         "captions": c["captions"].get("status"), **res})
            bad += 0 if res["ok"] else 1
            print(f"validate {c['id']}/{f['layout']}: {'PASS' if res['ok'] else 'FAIL ' + '; '.join(res['issues'])}")
        for e in c.get("errors", []):
            rows.append({"id": c["id"], "layout": e["layout"], "file": None, "ok": False,
                         "issues": ["render failed"], "error": e["error"]})
            bad += 1
            print(f"validate {c['id']}/{e['layout']}: FAIL render failed")
    write_json_atomic(os.path.join(a.out, REPORT), {
        "tool": "clipper", "toolVersion": TOOL_VERSION, "createdAt": _now(), "recording": rdoc["recording"],
        "targetsVersion": targets.get("version"),
        "targetsUnverified": [t["id"] for t in targets.get("targets", []) if t.get("unverified")],
        "files": len(rows), "failed": bad, "results": rows,
    })
    print(f"validate: {len(rows) - bad}/{len(rows)} PASS")
    return 0 if bad == 0 else 4


def cmd_run(a):
    for step in (cmd_candidates, cmd_render, cmd_validate):
        rc = step(a)
        if rc:
            return rc
    return 0


def _now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


# ---------------------------------------------------------------- cli

def build_parser():
    p = argparse.ArgumentParser(prog="clipper", description="F6 post-stream clipper (flag: clip-pipeline)")
    p.add_argument("--data-dir")
    p.add_argument("--ffmpeg")
    p.add_argument("--ffprobe")
    p.add_argument("--ranking")
    p.add_argument("--layouts-file")
    p.add_argument("--targets")
    sub = p.add_subparsers(dest="cmd", required=True)

    def common(sp, recording=True):
        sp.add_argument("--out", required=True)
        if recording:
            sp.add_argument("--recording", required=True)

    def cand_args(sp):
        sp.add_argument("--markers", action="append", default=[])
        sp.add_argument("--chat-db")
        sp.add_argument("--hits")
        sp.add_argument("--record-start")
        sp.add_argument("--no-audio", action="store_true")

    def render_args(sp):
        sp.add_argument("--layouts")
        sp.add_argument("--only")
        sp.add_argument("--encoder", default="auto")
        sp.add_argument("--captions", default="none", choices=caps.BACKENDS)
        sp.add_argument("--whisper-bin")
        sp.add_argument("--whisper-model")
        sp.add_argument("--language")

    s = sub.add_parser("candidates"); common(s); cand_args(s); s.set_defaults(fn=cmd_candidates)
    s = sub.add_parser("render"); common(s); render_args(s); s.set_defaults(fn=cmd_render)
    s = sub.add_parser("validate"); common(s, recording=False); s.add_argument("--no-decode", action="store_true")
    s.set_defaults(fn=cmd_validate)
    s = sub.add_parser("run"); common(s); cand_args(s); render_args(s); s.add_argument("--no-decode", action="store_true")
    s.set_defaults(fn=cmd_run)
    return p


def main(argv=None):
    a = build_parser().parse_args(argv)
    try:
        data_dir = resolve_data_dir(a.data_dir)
        if not flag_on(data_dir, FLAG):
            eprint(f"clipper: the '{FLAG}' feature flag is off (switch it on from the control page)")
            return EXIT_FLAG_OFF
        a.out = os.path.abspath(a.out)
        check_out_dir(a.out, corpus_dir())
        lower_own_priority()
        return a.fn(a)
    except ClipError as e:
        eprint(f"clipper: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
