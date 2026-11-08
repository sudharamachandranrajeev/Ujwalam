# SPDX-License-Identifier: GPL-3.0-or-later
"""F6 post-stream clipper (docs/plan/2026-11-03-f6-clip-pipeline-plan.md). Behind the feature flag `clip-pipeline`
(data/flags.json, off by default): every subcommand exits 3 while the flag is off in the data dir.

  detect      --recording FILE --out DIR [--game codm] [--detector-config F] [--profile F] [--layout F | --project F] [--fps F]
              [--threads 1-4]
              -> DIR/detector-hits.jsonl + DIR/detector-pass.json: the game pack's detectors over the H recording
              (OCR venv; sample rate from data/clip/detector-pass.json; one heavy job at a time)
  candidates  --recording FILE [--markers FILE ...] [--chat-db event-core.db] [--hits FILE] [--record-start ISO]
              [--no-audio] --out DIR
              -> DIR/candidates.json (times, scores, reasons, detectorHits; no chat text, no marker notes, no names)
              Without --hits, DIR/detector-hits.jsonl from `detect` on the same recording is used. Detector hits
              weigh 0 until ranking.json detectorWeightsStatus is "approved": listed and attached, never ranked.
  render      --recording FILE --out DIR [--v-recording FILE] [--layouts a,b,c] [--only c01,c02] [--encoder auto|libopenh264|h264_nvenc]
              [--captions none|whisper-cli|faster-whisper] [--whisper-bin F --whisper-model F] [--language xx]
              -> DIR/clips/<id>/<layout>.mp4 (+ captions.ass), DIR/render.json
  gate        --recording FILE --out DIR [--hits F]
              -> DIR/matches.json: the recording split into matches by their end screens, each kept or skipped by
              settings.json clips.matchGate (match_gate.py, D286 proposed); candidates.json keeps the passing
              candidates and moves the others to `gatedOut`. Uses DIR/detector-hits.jsonl and DIR/match-stats.json
              from `detect`; without them every candidate is kept.
  validate    --out DIR [--no-decode]  -> DIR/report.json; exit 4 when any file fails
  run         [--detect] candidates + gate + render + validate with the same options (--detect runs `detect` first)
  live-review --saves DIR --out DIR [--layouts ...] [--encoder ...] [--matches FILE]
              -> DIR/clips/<id>/<layout>.mp4 + DIR/render.json from the live clipper's replay saves
              (DIR/saves.jsonl, live_worker.py); overlapping saves are merged; then `validate --out DIR`.
              --matches: matches.json of the same session's recording; saves inside skipped matches are dropped.

Progress (stderr, one per line, for the studio): ujwalam-progress {"stage":"<detect|candidates|render|validate|review|
gate>","done":<int>,"total":<int>,"note":"<short plain text, no names>"} (clip_common.progress_line). The detector
pass writes one at least every 2 s; render and live-review one per clip.

Common: [--data-dir DIR] (flags.local.json; default paths.event_core_data from data/profile.local.json)
        [--ffmpeg F] [--ffprobe F] [--ranking F] [--layouts-file F] [--targets F]

Inputs are only read (the recording is an ffmpeg input; the chat db is opened read-only). --out must be outside the
repository or gitignored, and never inside the clips corpus. One render at a time; children run at below-normal
priority with 4 threads. Run isolated: python -I services/clip/clipper.py ...
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import time
from datetime import datetime, timezone

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import clip_captions as caps  # noqa: E402
import clip_rank as rank  # noqa: E402
import clip_render as rnd  # noqa: E402
import clip_signals as sig  # noqa: E402
import clip_validate as val  # noqa: E402
import game_pack  # noqa: E402
import match_gate as mg  # noqa: E402
from clip_common import (  # noqa: E402
    EXIT_FLAG_OFF, FLAG, PROFILE_FILE, ClipError, check_out_dir, clips_allowed, corpus_dir, eprint, find_tool, flag_on, load_config,
    load_json, lower_own_priority, match_gate_settings, media_info, progress_line, resolve_data_dir, write_json_atomic,
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
    progress_line("candidates", 0, 1, "reading markers, chat, audio and detector hits")
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
    hits_path = a.hits or _own_hits(a)
    hits, hstats = sig.read_hits(hits_path, dur)
    approved = cfg.get("detectorWeightsStatus") == "approved"
    w = cfg["weights"]
    gap = int(cfg["peaks"]["minGapSec"])
    events = rank.marker_events(markers, w)
    events += rank.chat_events(counts if a.chat_db else None, intents, {**cfg["chat"], "minGapSec": gap}, w)
    aev, abase = rank.loudness_events(lufs, cfg["audio"], w, gap)
    events += aev
    dev = rank.detector_events(hits, cfg.get("detectorWeights", {}), approved)
    events += dev
    deaths = rank.death_spans(hits, cfg)
    cands = rank.build_candidates(events, dur, cfg, deaths)
    if hstats is not None:
        hstats = {**hstats, "file": os.path.basename(hits_path), "weightsStatus": cfg.get("detectorWeightsStatus"),
                  "rule": "a detector hit counts only when detectorWeightsStatus is 'approved'; until then weight 0, "
                          "listed and attached as a reason, never opens or ranks a candidate",
                  "counted": sum(1 for e in dev if not e["attachOnly"]),
                  "attached": sum(1 for e in dev if e.get("candidate"))}
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
        # every detector hit, shown even when it adds nothing to a score (no OCR text, no names)
        "detectorHits": [{"t": round(h["t"], 2), "detector": h["detector"], "label": h.get("label"),
                          "signal": h.get("signal"), "weight": e["w"], "candidate": e.get("candidate")}
                         for h, e in zip(hits, dev)],
    }
    os.makedirs(a.out, exist_ok=True)
    write_json_atomic(os.path.join(a.out, CANDIDATES), doc)
    print(f"candidates: {len(cands)} from {len(events)} events "
          f"(markers {mstats['matched']}, chat {'on' if a.chat_db else 'off'}, "
          f"audio {'on' if astats.get('available') else 'off'}, detectors {len(hits)}); ranking {cfg.get('status')}")
    progress_line("candidates", 1, 1, f"{len(cands)} candidate(s)")
    return 0


# ---------------------------------------------------------------- gate

def _gate_pack(a):
    """The game pack named by the detect summary in --out (else the default game); None when it cannot be loaded."""
    import detector_pass as dp
    game = getattr(a, "game", None)
    s = os.path.join(a.out, dp.SUMMARY)
    if not game and os.path.isfile(s):
        try:
            game = load_json(s).get("game")
        except ClipError:
            game = None
    try:
        _gid, st, _doc = dp.load_settings(game, getattr(a, "detector_config", None))
        return game_pack.load_pack(dp.pack_path(st))
    except (ClipError, OSError, ValueError, KeyError):
        return None


def _match_stats(a):
    """DIR/match-stats.json from `detect` on the same recording, else None (older runs: the kill feed hits count)."""
    p = os.path.join(a.out, mg.STATS)
    if not os.path.isfile(p):
        return None
    doc = load_json(p)
    return doc if doc.get("recording") == os.path.basename(a.recording) else None


def cmd_gate(a):
    """Match gate (match_gate.py): splits the recording into matches by their end screens and keeps only the
    candidates of matches that pass clips.matchGate. -> DIR/matches.json; candidates.json keeps the passing
    candidates in `candidates` and moves the others to `gatedOut` (with the reason)."""
    path = os.path.join(a.out, CANDIDATES)
    doc = load_json(path)
    _same_recording(a, doc)
    gate = match_gate_settings(resolve_data_dir(a.data_dir))
    cands = [{k: v for k, v in c.items() if k not in ("match", "gateReason")}
             for c in doc.get("candidates", []) + doc.get("gatedOut", [])]
    cands.sort(key=lambda c: (c.get("rank", 0), c.get("id", "")))
    hits_path = getattr(a, "hits", None) or _own_hits(a)
    hits = mg.read_hits(hits_path)
    pack = _gate_pack(a) or {}
    cfg = mg.stats_config(pack)
    stats = _match_stats(a)
    matches = mg.segment(hits, stats, float(doc.get("duration") or 0.0), cfg)
    progress_line("gate", 0, len(matches), "sorting clips by match")
    kept, dropped = mg.gate_candidates(cands, matches, gate)
    start = sig.parse_iso(doc.get("recordStartUtc"))
    for i, m in enumerate(matches, 1):
        if start:
            m["startUtc"] = _iso_ms(start.timestamp() + m["start"])
            m["endUtc"] = _iso_ms(start.timestamp() + m["end"])
        progress_line("gate", i, len(matches), f"match {i}: {'kept' if m['passed'] else 'skipped'}")
    write_json_atomic(os.path.join(a.out, mg.MATCHES), {
        "tool": "clipper.gate", "toolVersion": mg.TOOL_VERSION, "createdAt": _now(), "recording": doc["recording"],
        "recordStartUtc": doc.get("recordStartUtc"), "duration": doc.get("duration"),
        "gate": gate, "packVersion": pack.get("version"),
        "inputs": {"hits": os.path.basename(hits_path) if hits_path else None,
                   "matchStats": mg.STATS if stats else None,
                   "killsFallback": None if stats else "kill-feed hit instances (undercount close kills)"},
        "rules": "a match passes when the streamer's card is #1-#3 on the top-3 screen (top3 on) or the streamer's "
                 "kills reach minKills (minKills set); a match with no end screen seen, or whose end screens were "
                 "not read, keeps its clips",
        "matches": matches,
    })
    doc["candidates"], doc["gatedOut"] = kept, dropped
    doc["matchGate"] = {"settings": gate, "file": mg.MATCHES, "matches": len(matches), "kept": len(kept),
                        "dropped": len(dropped)}
    write_json_atomic(path, doc)
    print(f"gate: {len(matches)} match(es) ({sum(1 for m in matches if m['endSeen'])} with an end screen), "
          f"{sum(1 for m in matches if m['passed'])} kept; candidates {len(kept)} kept, {len(dropped)} skipped "
          f"(top3 {'on' if gate['top3'] else 'off'}, minKills {gate['minKills']})")
    for m in matches:
        print(f"gate: match {m['index']} {m['start']:.0f}-{m['end']:.0f} s: {'KEPT' if m['passed'] else 'SKIPPED'} "
              f"({m['reason']})")
    return 0


# ---------------------------------------------------------------- detect

def _own_hits(a):
    """DIR/detector-hits.jsonl from an earlier `detect` on the same recording, else None."""
    import detector_pass as dp
    p = os.path.join(a.out, dp.HITS)
    s = os.path.join(a.out, dp.SUMMARY)
    if not (os.path.isfile(p) and os.path.isfile(s)):
        return None
    if load_json(s).get("recording") != os.path.basename(a.recording):
        eprint("candidates: detector hits in --out belong to another recording; not used")
        return None
    return p


def _dml_available():
    try:
        import onnxruntime
        return "DmlExecutionProvider" in onnxruntime.get_available_providers()
    except ImportError:
        return False


def cmd_detect(a):
    """Post-stream detector pass over the H recording -> DIR/detector-hits.jsonl + DIR/detector-pass.json."""
    import detector_pass as dp  # needs the OCR venv (numpy, cv2, rapidocr) only from here on
    _ffmpeg, ffprobe = _tools(a)
    if not os.path.isfile(a.recording):
        raise ClipError("recording not found")
    info = media_info(ffprobe, a.recording)
    gid, st, cdoc = dp.load_settings(a.game, a.detector_config)
    if a.fps:
        st["fps"] = float(a.fps)
    pack = game_pack.load_pack(dp.pack_path(st))
    names, have_profile = dp.load_names(a.profile or PROFILE_FILE, pack["nameMatch"]["profileKey"])
    try:
        layout, lsrc = dp.layout_for(a.recording, a.layout, a.project)
    except ValueError as e:
        raise ClipError(f"--project: {e}")
    print(f"detect: layout {lsrc}, game {layout['game']}, visible {layout['visible']}")
    gpu = _dml_available()
    if gpu:  # OCR on the GPU (D227): only when this Python has onnxruntime-directml (.venv-gpu)
        import g1_scan
        g1_scan.set_ocr_params({"EngineConfig.onnxruntime.use_dml": True})
    total = int(info["duration"] * float(st["fps"])) + 1
    progress_line("detect", 0, total, "reading the game screen")
    with dp.HeavyJobLock():
        summ = dp.run_pass(a.recording, a.out, st, pack, names, layout, threads=a.threads, total_frames=total,
                           progress_line=lambda d, n: progress_line("detect", d, n, "reading the game screen"))
    doc = {
        "tool": "clipper.detect", "toolVersion": TOOL_VERSION, "detectorPassVersion": dp.TOOL_VERSION,
        "createdAt": _now(), "recording": os.path.basename(a.recording), "duration": round(info["duration"], 3),
        "game": gid, "packVersion": pack.get("version"),
        "config": {"version": cdoc.get("version"), "status": cdoc.get("status"), "fps": st["fps"],
                   "diffGate": st["diffGate"], "nameMin": st["nameMin"], "mergeGapSec": st["mergeGapSec"]},
        "layout": {"source": lsrc, "status": "unverified" if lsrc == "full-frame" else lsrc,
                   "game": layout["game"], "visible": layout["visible"]},
        "profileNames": len(names) if have_profile else 0,
        "detectorStatus": {d["id"]: d.get("status") for d in pack["detectors"]},
        "threads": a.threads, "ocr": "gpu-directml" if gpu else "cpu", **summ,
    }
    write_json_atomic(os.path.join(a.out, dp.SUMMARY), doc)
    print(f"detect: {summ['hits']} hit(s), {summ['signalHits']} with signal, from {summ['ocrFrames']} OCR frames "
          f"at {st['fps']} fps in {summ['seconds']} s; detectors unverified, weights not approved")
    return 0


# ---------------------------------------------------------------- render

def v_recording(h_path, given=None):
    """The V canvas recording of the same session: --v-recording, else the sibling file whose name has '-v-' where
    the H file has '-h-' (sinks record H and V from one start, e.g. practice-h-<ts>.mkv / practice-v-<ts>.mkv)."""
    if given:
        return given if os.path.isfile(given) else None
    d, base = os.path.split(h_path)
    if "-h-" not in base:
        return None
    cand = os.path.join(d, base.replace("-h-", "-v-", 1))
    return cand if os.path.isfile(cand) else None


def cmd_render(a):
    ffmpeg, ffprobe = _tools(a)
    doc = load_json(os.path.join(a.out, CANDIDATES))
    _same_recording(a, doc)
    info = media_info(ffprobe, a.recording)
    lay_doc = load_config("layouts", a.layouts_file)
    targets = load_config("targets", a.targets)
    frame = lay_doc["output"]
    wanted = ([x for x in (a.layouts or "").split(",") if x] or lay_doc.get("default")
              or [x["id"] for x in lay_doc["layouts"]])
    by_id = {x["id"]: x for x in lay_doc["layouts"]}
    missing = [x for x in wanted if x not in by_id]
    if missing:
        raise ClipError(f"unknown layout(s): {', '.join(missing)}")
    sources = {"h": (a.recording, info)}
    if any(by_id[x].get("input") == "v" for x in wanted):
        vrec = v_recording(a.recording, a.v_recording)
        if not vrec:
            raise ClipError("layout needs the V canvas recording: none next to the H recording; give --v-recording")
        sources["v"] = (vrec, media_info(ffprobe, vrec))
    only = {x for x in (a.only or "").split(",") if x}
    cands = [c for c in doc["candidates"] if not only or c["id"] in only]
    encoder = rnd.pick_encoder(a.encoder)
    safe = caps.safe_area(targets)
    opts = {"whisper_bin": a.whisper_bin, "whisper_model": a.whisper_model, "language": a.language}
    out_rows, failed = [], 0
    t0 = time.monotonic()
    progress_line("render", 0, len(cands), "making clip videos")
    for n, c in enumerate(cands, 1):
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
                src, sinfo = sources[lay.get("input", "h")]
                name = rnd.render_variant(ffmpeg, src, sinfo, c, lay, frame, encoder, wd, capname)
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
        progress_line("render", n, len(cands), f"clip {c['id']} {'failed' if errors else 'done'}")
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
    total = sum(len(c["files"]) for c in rdoc["clips"])
    progress_line("validate", 0, total, "checking clip files")
    for c in rdoc["clips"]:
        exp = float(c["end"]) - float(c["start"])
        for f in c["files"]:
            p = os.path.join(a.out, "clips", c["id"], f["file"])
            res = val.validate_file(ffmpeg, ffprobe, p, exp, frame, targets, decode=not a.no_decode)
            rows.append({"id": c["id"], "layout": f["layout"], "file": f["file"], "geometry": f["geometry"],
                         "captions": c["captions"].get("status"), **res})
            bad += 0 if res["ok"] else 1
            progress_line("validate", sum(1 for r in rows if r.get("file")), total,
                          f"clip {c['id']} {'ok' if res['ok'] else 'failed'}")
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


def merge_saves(rows, durations):
    """Live saves -> clip windows. rows: saves.jsonl rows; durations: {path: seconds} of each save's V file.
    A save's clip is [at - startBack, at - endBack] in wall time. Overlapping clips merge into one cut from the
    later save's file when that file still holds the earlier start; otherwise they stay separate."""
    items = []
    for r in rows:
        at = sig.parse_iso(r.get("at"))
        v = next((f.get("path") for f in r.get("files", []) if str(f.get("canvas", "")).lower() == "v" and f.get("path")), None)
        if not at or not v or v not in durations:
            continue
        t = at.timestamp()
        items.append({"s": t - float(r["startBack"]), "e": t - float(r["endBack"]), "at": t, "file": v,
                      "score": r.get("score", 0), "labels": list(r.get("labels", [])), "reasons": [r.get("reason")]})
    items.sort(key=lambda x: x["s"])
    out = []
    for it in items:
        prev = out[-1] if out else None
        if prev and it["s"] <= prev["e"] and it["at"] - prev["s"] <= durations[it["file"]]:
            prev.update(e=max(prev["e"], it["e"]), at=it["at"], file=it["file"], score=prev["score"] + it["score"],
                        labels=prev["labels"] + it["labels"], reasons=prev["reasons"] + it["reasons"])
        else:
            out.append(dict(it))
    clips = []
    for i, c in enumerate(out, 1):
        dur = durations[c["file"]]
        start, end = max(0.0, dur - (c["at"] - c["s"])), max(0.0, dur - (c["at"] - c["e"]))
        if end - start < 1.0:
            continue
        clips.append({"id": f"L{i:02d}", "file": c["file"], "start": round(start, 3), "end": round(end, 3),
                      "score": c["score"], "labels": c["labels"], "reasons": c["reasons"]})
    return clips


def saves_between(rows, since=None, until=None):
    """The saves of one recording or stream (D284): "at" within [since, until]. Both sides are ISO UTC with
    milliseconds and a Z (live_worker and the launcher), so string order is time order."""
    return [r for r in rows if (not since or str(r.get("at", "")) >= since) and (not until or str(r.get("at", "")) <= until)]


def cmd_live_review(a):
    ffmpeg, ffprobe = _tools(a)
    path = os.path.join(a.saves, "saves.jsonl")
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    rows.append(json.loads(line))
                except ValueError:
                    eprint("live-review: skipped a bad saves.jsonl line")
    rows = saves_between(rows, a.since, a.until)
    gate_info = {"applied": False, "reason": "no matches.json given (--matches): every save kept"}
    if a.matches:
        mdoc = load_json(a.matches)
        gate = match_gate_settings(resolve_data_dir(a.data_dir))
        progress_line("gate", 0, 1, "sorting saves by match")
        rows, dropped = mg.gate_saves(rows, mdoc.get("matches") or [], gate, sig.parse_iso)
        gate_info = {"applied": True, "settings": gate, "matches": len(mdoc.get("matches") or []),
                     "keptSaves": len(rows), "droppedSaves": dropped}
        progress_line("gate", 1, 1, f"{len(rows)} save(s) kept, {len(dropped)} skipped")
        print(f"live-review: match gate kept {len(rows)} save(s), skipped {len(dropped)}")
    infos = {}
    for r in rows:
        for fl in r.get("files", []):
            p = fl.get("path")
            if str(fl.get("canvas", "")).lower() == "v" and p and p not in infos and os.path.isfile(p):
                infos[p] = media_info(ffprobe, p)
    clips = merge_saves(rows, {p: i["duration"] for p, i in infos.items()})
    lay_doc = load_config("layouts", a.layouts_file)
    frame = lay_doc["output"]
    by_id = {x["id"]: x for x in lay_doc["layouts"]}
    wanted = [x for x in (a.layouts or "").split(",") if x] or lay_doc.get("default") or []
    bad = [x for x in wanted if x not in by_id or by_id[x].get("input") != "v"]
    if bad:
        raise ClipError(f"live-review renders V-canvas layouts only: {', '.join(bad)}")
    encoder = rnd.pick_encoder(a.encoder)
    out_rows, failed = [], 0
    progress_line("review", 0, len(clips), "making clip videos from live saves")
    for n, c in enumerate(clips, 1):
        wd = os.path.join(a.out, "clips", c["id"])
        os.makedirs(wd, exist_ok=True)
        files, errors = [], []
        for lid in wanted:
            try:
                name = rnd.render_variant(ffmpeg, c["file"], infos[c["file"]], c, by_id[lid], frame, encoder, wd)
                files.append({"layout": lid, "file": name, "geometry": by_id[lid].get("geometry", "unverified")})
                print(f"live-review {c['id']}/{lid}: rendered ({c['end'] - c['start']:.1f} s)")
            except ClipError as e:
                errors.append({"layout": lid, "error": str(e)[-300:]})
                failed += 1
                eprint(f"live-review {c['id']}/{lid}: FAILED")
        out_rows.append({"id": c["id"], "start": c["start"], "end": c["end"], "source": os.path.basename(c["file"]),
                         "score": c["score"], "labels": c["labels"], "reasons": c["reasons"],
                         "captions": {"backend": "none", "status": "off"}, "files": files, "errors": errors})
        progress_line("review", n, len(clips), f"clip {c['id']} {'failed' if errors else 'done'}")
    write_json_atomic(os.path.join(a.out, RENDER), {
        "tool": "clipper", "toolVersion": TOOL_VERSION, "createdAt": _now(), "recording": "live-saves",
        "saves": len(rows), "encoder": encoder, "frame": frame, "layoutsVersion": lay_doc.get("version"),
        "failed": failed, "matchGate": gate_info, "clips": out_rows,
    })
    print(f"live-review: {len(rows)} save(s) -> {len(clips)} clip(s), {failed} failed render(s)")
    return 0


def cmd_montage(a):
    """Kill montages (clip_montage.py, data/clip/montage.json) from the detector hits of the H recording, cut from the
    V recording of the same session -> DIR/montage/clips/<id>/montage-v.mp4 + DIR/montage/render.json +
    DIR/montage/candidates.json (then `validate --out DIR/montage`; then the folder packages for posting)."""
    import clip_montage as mont
    ffmpeg, ffprobe = _tools(a)
    hits_path = a.hits or os.path.join(a.out, "detector-hits.jsonl")
    if not os.path.isfile(hits_path):
        raise ClipError("no detector hits: run `detect` on this recording first (or give --hits)")
    info = media_info(ffprobe, a.recording)
    hits, _ = sig.read_hits(hits_path, info["duration"])
    vrec = v_recording(a.recording, a.v_recording)
    if not vrec:
        raise ClipError("montage cuts the V canvas recording: none next to the H recording; give --v-recording")
    vinfo = media_info(ffprobe, vrec)
    if not vinfo["has_audio"]:
        raise ClipError("the V recording has no audio stream")
    ranking = load_config("ranking", a.ranking)
    cfg = load_config("montage", a.montage_config)
    frame = load_config("layouts", a.layouts_file)["output"]
    plans = mont.plan_montages(hits, ranking, cfg, min(info["duration"], vinfo["duration"]))
    encoder = rnd.pick_encoder(a.encoder)
    out = os.path.join(a.out, "montage")
    os.makedirs(out, exist_ok=True)
    sts, _ = mont.streaks(hits, ranking, cfg)
    print(f"montage: {len(sts)} qualifying streak(s), {sum(len(s['kills']) for s in sts)} kill(s) in them")
    reels = mont.match_reels(hits, ranking, cfg, min(info["duration"], vinfo["duration"]))  # won matches (W1 VICTORY), every own kill (D237)
    print(f"montage: {len(reels)} won-match reel(s)")
    jobs = [(f"M{i:02d}", m) for i, m in enumerate(plans, 1)] + [(f"W{i:02d}", m) for i, m in enumerate(reels, 1)]
    rows, failed = [], 0
    for cid, m in jobs:
        wd = os.path.join(out, "clips", cid)
        os.makedirs(wd, exist_ok=True)
        argv = mont.render_argv(ffmpeg, vrec, m["pieces"], frame, rnd.ENCODERS[encoder], rnd.AUDIO,
                                int(cfg["audioFadeMs"]), "montage-v.mp4.part")
        r = rnd.run_tool(argv, cwd=wd, timeout=1800)
        files, errors = [], []
        if r.returncode == 0:
            os.replace(os.path.join(wd, "montage-v.mp4.part"), os.path.join(wd, "montage-v.mp4"))
            files.append({"layout": "montage-v", "file": "montage-v.mp4", "geometry": "canvas"})
            print(f"montage {cid}: {m['seconds']:.1f} s, {len(m['pieces'])} piece(s), score {m['score']:g}")
        else:
            errors.append({"layout": "montage-v", "error": r.stderr.strip()[-300:]})
            failed += 1
            eprint(f"montage {cid}: FAILED")
        rows.append({"id": cid, "start": 0.0, "end": m["seconds"], "score": m["score"], "labels": m["labels"],
                     "pieces": m["pieces"], "captions": {"backend": "none", "status": "off"}, "files": files,
                     "errors": errors})
    write_json_atomic(os.path.join(out, RENDER), {
        "tool": "clipper.montage", "toolVersion": TOOL_VERSION, "createdAt": _now(),
        "recording": os.path.basename(a.recording), "vRecording": os.path.basename(vrec), "encoder": encoder,
        "frame": frame, "montageVersion": cfg.get("version"), "montageStatus": cfg.get("status"),
        "failed": failed, "clips": rows,
    })
    # candidates.json in the montage folder makes it a clip run folder for posting (services/posting packageRun):
    # times are on the montage's own timeline (0 .. seconds); anchor = the first kill (cover frame); the source
    # recording times are in `pieces`
    pre = float(cfg["preSec"])
    write_json_atomic(os.path.join(out, CANDIDATES), {
        "tool": "clipper.montage", "toolVersion": TOOL_VERSION, "createdAt": _now(),
        "recording": os.path.basename(a.recording),
        "recordStartUtc": sig.recording_start(a.recording, a.record_start).isoformat().replace("+00:00", "Z"),
        "candidates": [{"id": r["id"], "rank": i, "kind": "won-match" if r["id"].startswith("W") else "montage",
                        "start": 0.0, "end": r["end"], "anchor": min(pre, r["end"]), "score": r["score"],
                        "labels": r["labels"], "pieces": r["pieces"]}
                       for i, r in enumerate((r for r in rows if r["files"]), 1)],
    })
    print(f"montage: {len(plans)} montage(s), {len(reels)} won-match reel(s), {failed} failed; "
          f"validate with: validate --out {out}")
    return 0


def cmd_run(a):
    steps = ((cmd_detect,) if a.detect else ()) + (cmd_candidates, cmd_gate, cmd_render, cmd_validate)
    for step in steps:
        rc = step(a)
        if rc:
            return rc
    return 0


def _now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _iso_ms(ts):
    """ISO UTC with milliseconds and a Z (the live saves' `at` format, so string order is time order)."""
    return datetime.fromtimestamp(ts, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


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
            # absolute: ffmpeg renders run in a work folder, where a relative path does not resolve
            sp.add_argument("--recording", required=True, type=os.path.abspath)

    def cand_args(sp):
        sp.add_argument("--markers", action="append", default=[])
        sp.add_argument("--chat-db")
        sp.add_argument("--hits")
        sp.add_argument("--record-start")
        sp.add_argument("--no-audio", action="store_true")

    def render_args(sp):
        sp.add_argument("--layouts")
        sp.add_argument("--only")
        sp.add_argument("--v-recording", type=os.path.abspath,
                        help="V canvas recording for source-v layouts (default: the '-v-' sibling of --recording)")
        sp.add_argument("--encoder", default="auto")
        sp.add_argument("--captions", default="none", choices=caps.BACKENDS)
        sp.add_argument("--whisper-bin")
        sp.add_argument("--whisper-model")
        sp.add_argument("--language")

    def detect_args(sp):
        sp.add_argument("--game")
        sp.add_argument("--detector-config")
        sp.add_argument("--profile")
        sp.add_argument("--layout")
        sp.add_argument("--project", type=os.path.abspath,
                        help="Ujwalam project of a canvas recording: scan only its game layer's area (D235)")
        sp.add_argument("--fps", type=float)
        sp.add_argument("--threads", type=int, default=4, choices=range(1, 5), metavar="1-4")

    s = sub.add_parser("detect"); common(s); detect_args(s); s.set_defaults(fn=cmd_detect)
    s = sub.add_parser("candidates"); common(s); cand_args(s); s.set_defaults(fn=cmd_candidates)
    s = sub.add_parser("gate"); common(s); s.add_argument("--hits"); s.add_argument("--game")
    s.add_argument("--detector-config"); s.set_defaults(fn=cmd_gate)
    s = sub.add_parser("render"); common(s); render_args(s); s.set_defaults(fn=cmd_render)
    s = sub.add_parser("validate"); common(s, recording=False); s.add_argument("--no-decode", action="store_true")
    s.set_defaults(fn=cmd_validate)
    s = sub.add_parser("run"); common(s); cand_args(s); render_args(s); s.add_argument("--no-decode", action="store_true")
    detect_args(s); s.add_argument("--detect", action="store_true")
    s.set_defaults(fn=cmd_run)
    s = sub.add_parser("montage"); common(s)
    s.add_argument("--hits"); s.add_argument("--montage-config")
    s.add_argument("--v-recording", type=os.path.abspath); s.add_argument("--encoder", default="auto")
    s.add_argument("--record-start")
    s.set_defaults(fn=cmd_montage)
    s = sub.add_parser("live-review"); common(s, recording=False)
    s.add_argument("--saves", required=True, type=os.path.abspath, help="live clipper session folder (saves.jsonl)")
    s.add_argument("--since", help="ISO UTC time: saves at or after it only")
    s.add_argument("--until", help="ISO UTC time: saves at or before it only")
    s.add_argument("--layouts"); s.add_argument("--encoder", default="auto")
    s.add_argument("--matches", type=os.path.abspath,
                   help="matches.json of the same session's recording (`run`): saves in skipped matches are dropped")
    s.set_defaults(fn=cmd_live_review)
    return p


def main(argv=None):
    a = build_parser().parse_args(argv)
    try:
        data_dir = resolve_data_dir(a.data_dir)
        if not clips_allowed(data_dir):
            eprint(f"clipper: clips are off (Settings > Clips, or the '{FLAG}' flag)")
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
