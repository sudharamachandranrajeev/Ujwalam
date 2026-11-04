# SPDX-License-Identifier: GPL-3.0-or-later
"""Crash-safe capture-card recorder for reference footage.

Records the capture device directly (not a program output) into 60 s
fragmented MP4 segments, so a stop, kill or crash loses at most the
fragment in flight. Stop cleanly by creating the STOP file in the output
folder; the recorder then sends 'q' to ffmpeg so the last segment is
finalised. `verify` checks every segment afterwards.

  python -I tools/capture/record.py record --out DIR --name PREFIX
  python -I tools/capture/record.py verify --out DIR --name PREFIX

Recorder state (P2b W1): `record` writes DIR/PREFIX.state.json when it starts and
updates it when it ends:
  {"state": "recording" | "restarting" | "stopped" | "ffmpeg_failed" | "failed", "pid",
   "ffmpegPid", "segmentS", "fps", "source", "vcodec", "audio", "started", "ended",
   "ffmpegExit", "stopRequested", "mediaStartUtc", "segmentStart", "restarts", "gaps",
   "gapsFile", "failReason", "restartLimit", "restartWindowS"}
"ffmpeg_failed" = ffmpeg exited non-zero while finalising after a STOP; "failed" = restart limit.
A file left at "recording" whose pid and ffmpegPid are both gone means the recorder was
killed: the last segment was in flight. The coverage tracker (services/clip/coverage.py)
reads this file to know when the last segment is final; `verify` reads it to tell a
closed segment from the one in flight.

Restart after a crash (user decision 2026-10-28): when ffmpeg exits unexpectedly (no STOP,
max duration not reached), record.py starts a new ffmpeg that continues the segment numbering
(-segment_start_number = highest existing index + 1; an existing segment is never
overwritten) for the time left. Each crash is logged (exit code and the last stderr lines) and
gets a gap record, appended to DIR/PREFIX.gaps.jsonl once the gap has ended:
  {"gap": n, "reason", "exitCode", "crashUtc", "startUtc", "endUtc", "startS", "endS",
   "durationS", "startSource", "afterSegment", "beforeSegment", "restart", "stderrTail"}
startUtc is the last write to the segment in flight at the crash (its last good media);
endUtc is the creation of the new ffmpeg's first segment. startS/endS are seconds from
mediaStartUtc (the creation of the session's first segment). A gap that never ends (restart
limit, or STOP before the restart produced a segment) is written with endUtc/endS null.
At most RESTART_LIMIT restarts in any RESTART_WINDOW_S: the next crash inside the window
stops the recorder with state "failed", a failReason, a FAILED console line and exit 1.
State values: "recording", "restarting", "stopped", "failed" ("ffmpeg_failed" was written by
the W1 version, which did not restart).

Test-only options (tests/py/test_record.py): --source lavfi records an ffmpeg test
pattern and a sine tone instead of the capture card (a real ffmpeg recording, not a
mock); --segment-s and --fps shorten segments; --vcodec picks the encoder for the
lavfi source only (the device path always uses h264_nvenc). No encoder session limit
is assumed: an encoder that cannot open makes ffmpeg exit, which is reported.
--restart-limit and --restart-window-s override the restart limit (tests only).
"""
import argparse
import collections
import datetime
import json
import os
import pathlib
import re
import subprocess
import sys
import time

# No console window on Windows (D191): every subprocess call passes **NO_WINDOW.
NO_WINDOW = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}

FPS = 60
SEGMENT_S = 60
# Restart limit (user decision 2026-10-28): at most 5 restarts in any 10-minute window.
RESTART_LIMIT = 5
RESTART_WINDOW_S = 600
RESTART_DELAY_S = 1.0   # pause before a restart, so a broken device is not hammered
STDERR_TAIL = 20        # stderr lines kept per crash
MAX_END_TOLERANCE_S = 5  # exit 0 within this of the max duration = the max was reached
DEVICE_VCODEC = "h264_nvenc"
VCODECS = {
    # the device path; settings unchanged since A5c
    "h264_nvenc": ["-preset", "p5", "-rc", "vbr", "-cq", "19", "-b:v", "50M", "-maxrate", "80M"],
    # software fallback for the lavfi test source only (the LGPL ffmpeg build has no libx264)
    "libopenh264": ["-b:v", "4M"],
}


def ffmpeg_cmd(video, audio, size, pattern, max_s, fps=FPS, segment_s=SEGMENT_S,
               source="dshow", vcodec=DEVICE_VCODEC, start_number=0):
    if source == "lavfi":
        # -re: generate in real time, so a kill lands mid-segment as it would on a live card
        inputs = ["-re", "-f", "lavfi", "-i", f"testsrc2=size={size}:rate={fps}"]
        if audio:
            inputs += ["-re", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"]
        inputs += ["-map", "0:v"] + (["-map", "1:a"] if audio else []) + ["-pix_fmt", "yuv420p"]
    else:
        src = f"video={video}" + (f":audio={audio}" if audio else "")
        inputs = ["-f", "dshow", "-rtbufsize", "1024M", "-video_size", size,
                  "-framerate", str(fps), "-pixel_format", "nv12", "-i", src]
    return [
        "ffmpeg", "-hide_banner", "-loglevel", "warning", "-nostats",
        *inputs,
        "-t", str(max_s),
        "-c:v", vcodec, *VCODECS[vcodec],
        "-force_key_frames", f"expr:gte(t,n_forced*{segment_s})", "-g", str(2 * fps),
        *(["-c:a", "aac", "-b:a", "192k"] if audio else []),
        "-f", "segment", "-segment_time", str(segment_s), "-reset_timestamps", "1",
        # only on a restart, so the first ffmpeg's command stays the A5c command
        *(["-segment_start_number", str(start_number)] if start_number else []),
        "-segment_format", "mp4",
        "-segment_format_options", "movflags=+frag_keyframe+empty_moov+default_base_moof",
        str(pattern),
    ]


def seg_index(p, name):
    m = re.fullmatch(re.escape(name) + r"-(\d+)\.mp4", pathlib.Path(p).name)
    return int(m.group(1)) if m else None


def segments(out, name):
    """Segment files in index order (numeric, so -1000 sorts after -999)."""
    found = [p for p in pathlib.Path(out).glob(f"{name}-*.mp4") if seg_index(p, name) is not None]
    return sorted(found, key=lambda p: seg_index(p, name))


def gaps_path(out, name):
    return pathlib.Path(out) / f"{name}.gaps.jsonl"


def read_gaps(out, name):
    """Gap records from DIR/PREFIX.gaps.jsonl ([] when there is none); a torn last line is skipped."""
    rows = []
    try:
        with open(gaps_path(out, name), encoding="utf-8") as f:
            for line in f:
                try:
                    rows.append(json.loads(line))
                except ValueError:
                    pass
    except OSError:
        pass
    return rows


def append_gap(out, name, gap):
    with open(gaps_path(out, name), "a", encoding="utf-8") as f:
        f.write(json.dumps(gap) + "\n")
        f.flush()
        os.fsync(f.fileno())


class RestartLimiter:
    """At most `limit` restarts in any `window_s` seconds; crash() says whether to restart."""

    def __init__(self, limit=RESTART_LIMIT, window_s=RESTART_WINDOW_S, clock=time.monotonic):
        self.limit, self.window_s, self.clock = limit, window_s, clock
        self.crashes = collections.deque()

    def crash(self):
        now = self.clock()
        self.crashes.append(now)
        while self.crashes and now - self.crashes[0] > self.window_s:
            self.crashes.popleft()
        return len(self.crashes) <= self.limit


def state_path(out, name):
    return pathlib.Path(out) / f"{name}.state.json"


def read_state(out, name):
    try:
        with open(state_path(out, name), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def write_state(out, name, st):
    p = state_path(out, name)
    tmp = p.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(st, f, indent=1)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, p)


def _now():
    return datetime.datetime.now().astimezone().isoformat(timespec="seconds")


def _utc(ts):
    return (datetime.datetime.fromtimestamp(ts, datetime.timezone.utc)
            .isoformat(timespec="milliseconds").replace("+00:00", "Z"))


def _birth(p):
    """Creation time of a file (Windows: st_birthtime, else st_ctime); now if unknown."""
    s = os.stat(p)
    b = getattr(s, "st_birthtime", None)
    if b is None and os.name == "nt":
        b = s.st_ctime
    return b if b is not None else time.time()


def _tail(log_path, offset, n=STDERR_TAIL):
    """The last n non-empty lines that one ffmpeg run wrote to the log (from byte offset)."""
    try:
        with open(log_path, "rb") as f:
            f.seek(offset)
            data = f.read()
    except OSError:
        return []
    return [ln for ln in data.decode("utf-8", "replace").splitlines() if ln.strip()][-n:]


def record(a):
    out = pathlib.Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    stop = out / "STOP"
    stop.unlink(missing_ok=True)
    if segments(out, a.name):
        sys.exit(f"refusing: {a.name}-*.mp4 already exists in {out}")
    if gaps_path(out, a.name).exists():
        sys.exit(f"refusing: {gaps_path(out, a.name)} already exists")
    if a.source != "lavfi" and a.vcodec != DEVICE_VCODEC:
        sys.exit(f"--vcodec {a.vcodec} is for --source lavfi only; the device path uses {DEVICE_VCODEC}")
    max_s = a.max_s if a.max_s else a.max_min * 60
    log_path = out / f"{a.name}.log"
    open(log_path, "w", encoding="utf-8").close()

    def rlog(msg):
        # only called while no ffmpeg is writing the log (before a launch, after an exit)
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(f"[record {_utc(time.time())}] {msg}\n")

    def launch(start_number, dur):
        lf = open(log_path, "ab")
        lf.seek(0, os.SEEK_END)
        off = lf.tell()
        p = subprocess.Popen(
            ffmpeg_cmd(a.video, a.audio, a.size, out / f"{a.name}-%03d.mp4", dur, fps=a.fps,
                       segment_s=a.segment_s, source=a.source, vcodec=a.vcodec, start_number=start_number),
            stdin=subprocess.PIPE, stdout=lf, stderr=lf, **NO_WINDOW)
        lf.close()  # the child holds its own handle
        return p, off

    limiter = RestartLimiter(a.restart_limit, a.restart_window_s)
    t0 = time.time()
    proc, off = launch(0, max_s)
    st = {"state": "recording", "pid": os.getpid(), "ffmpegPid": proc.pid, "segmentS": a.segment_s,
          "fps": a.fps, "source": a.source, "vcodec": a.vcodec, "audio": bool(a.audio),
          "started": _now(), "ended": None, "ffmpegExit": None, "stopRequested": False,
          "mediaStartUtc": None, "segmentStart": 0, "restarts": 0, "gaps": 0,
          "gapsFile": gaps_path(out, a.name).name, "failReason": None,
          "restartLimit": a.restart_limit, "restartWindowS": a.restart_window_s}
    write_state(out, a.name, st)
    print(f"recording pid={proc.pid}; stop: create {stop}", flush=True)
    media0 = None      # creation time of the session's first segment = session second 0
    pending = []       # gaps waiting for the first segment of the restarted ffmpeg
    first_seg = 0      # index of the first segment the current ffmpeg writes

    def rel(ts):
        return None if ts is None or media0 is None else round(ts - media0, 3)

    def write_pending(end_ts, before):
        for g in pending:
            start_ts = g.pop("_start")
            g.update(endUtc=_utc(end_ts) if end_ts is not None else None,
                     startS=rel(start_ts), endS=rel(end_ts),
                     durationS=round(end_ts - start_ts, 3) if end_ts is not None else None,
                     beforeSegment=before)
            append_gap(out, a.name, g)
            st["gaps"] += 1
        pending.clear()

    def poll_segments():
        nonlocal media0
        if media0 is None:
            s = segments(out, a.name)
            if s:
                media0 = _birth(s[0])
                st["mediaStartUtc"] = _utc(media0)
                write_state(out, a.name, st)
        nxt = out / f"{a.name}-{first_seg:03d}.mp4"
        if pending and nxt.exists():
            end_ts = _birth(nxt)
            n = len(pending)
            write_pending(end_ts, nxt.name)
            st["state"] = "recording"
            write_state(out, a.name, st)
            print(f"GAP closed: {n} gap(s) end at {_utc(end_ts)}; recording again in {nxt.name}", flush=True)

    def request_stop(why):
        print(f"{why}; sending q", flush=True)
        st["stopRequested"] = True
        try:
            proc.stdin.write(b"q")
            proc.stdin.flush()
        except OSError:
            pass
        try:
            proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            proc.terminate()

    def supervise():
        """Wait for the current ffmpeg to exit; returns the stop reason, or None for an exit."""
        last_total, last_change = -1, time.monotonic()
        try:
            while proc.poll() is None:
                time.sleep(1)
                poll_segments()
                total = sum(p.stat().st_size for p in segments(out, a.name) if p.exists())
                now = time.monotonic()
                if total != last_total:
                    last_total, last_change = total, now
                elif now - last_change > 10:
                    print(f"STALL: no bytes written for {now - last_change:.0f} s", flush=True)
                if stop.exists():
                    request_stop("stop requested")
                    return "stop"
        except KeyboardInterrupt:
            request_stop("interrupted")
            return "interrupted"
        return None

    def stop_during_delay():
        try:
            t_end = time.monotonic() + RESTART_DELAY_S
            while time.monotonic() < t_end:
                if stop.exists():
                    return "stop"
                time.sleep(0.1)
        except KeyboardInterrupt:
            return "interrupted"
        return None

    exit_code = 0
    while True:
        why = supervise()
        code = proc.wait()
        poll_segments()
        if why:
            exit_code = 1 if code != 0 else 0  # ffmpeg failed while finalising
            break
        if code == 0 and time.time() - t0 >= max_s - MAX_END_TOLERANCE_S:
            break  # the max duration was reached
        # ---- unexpected exit: a crash
        crash_ts = time.time()
        tail = _tail(log_path, off)
        segs = segments(out, a.name)
        last = segs[-1] if segs else None
        start_ts, src = ((os.path.getmtime(last), "last-segment-write") if last else (crash_ts, "wall-clock"))
        reason = (f"ffmpeg exited {code} unexpectedly" if code != 0
                  else "ffmpeg exited 0 before the max duration")
        gap = {"gap": st["gaps"] + len(pending) + 1, "reason": reason, "exitCode": code,
               "crashUtc": _utc(crash_ts), "startUtc": _utc(start_ts), "startSource": src,
               "afterSegment": last.name if last else None, "restart": None, "stderrTail": tail,
               "_start": start_ts}
        pending.append(gap)
        rlog(f"CRASH {gap['gap']}: {reason} (exit code {code}); in flight: {gap['afterSegment']}; "
             f"last {len(tail)} stderr line(s) of this run:")
        rlog("  stderr: " + (" | ".join(tail) if tail else "(none)"))
        print(f"CRASH: {reason}; in flight {gap['afterSegment']}", flush=True)
        if not limiter.crash():
            fail = (f"restart limit reached: crash {len(limiter.crashes)} within {limiter.window_s:g} s "
                    f"(at most {limiter.limit} restarts per {limiter.window_s:g} s); not restarting")
            rlog("FAILED: " + fail)
            write_pending(None, None)
            st.update(state="failed", failReason=fail, ended=_now(), ffmpegExit=code)
            write_state(out, a.name, st)
            print(f"FAILED: {fail}. Recording stopped; check the capture device. "
                  f"State: {state_path(out, a.name)}", flush=True)
            sys.exit(1)
        remaining = max_s - (time.time() - t0)
        if remaining < 1:
            rlog("max duration reached at the crash; not restarting")
            break
        why = stop_during_delay()
        if why:
            print(f"{why} before the restart", flush=True)
            st["stopRequested"] = True
            break
        segs = segments(out, a.name)
        first_seg = (seg_index(segs[-1], a.name) + 1) if segs else 0
        if (out / f"{a.name}-{first_seg:03d}.mp4").exists():  # never overwrite a segment
            sys.exit(f"refusing to restart: {a.name}-{first_seg:03d}.mp4 exists")
        st["restarts"] += 1
        gap["restart"] = st["restarts"]
        remaining = max_s - (time.time() - t0)
        rlog(f"RESTART {st['restarts']}: new ffmpeg from segment {first_seg:03d} for {remaining:.1f} s")
        proc, off = launch(first_seg, round(remaining, 1))
        st.update(state="restarting", ffmpegPid=proc.pid, segmentStart=first_seg)
        write_state(out, a.name, st)
        print(f"RESTART {st['restarts']}: ffmpeg pid={proc.pid} from {a.name}-{first_seg:03d}.mp4", flush=True)
    stop.unlink(missing_ok=True)
    if pending:
        write_pending(None, None)  # stopped before the restarted ffmpeg wrote a segment
    st.update(state="stopped" if exit_code == 0 else "ffmpeg_failed", ended=_now(), ffmpegExit=code)
    write_state(out, a.name, st)
    print(f"ffmpeg exit {code}" + (f"; {st['restarts']} restart(s), {st['gaps']} gap(s)" if st["restarts"] else ""),
          flush=True)
    sys.exit(exit_code)


def probe(path):
    """(video packets, format duration, ffprobe stderr) — unchanged since A5c."""
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-count_packets", "-select_streams", "v:0",
         "-show_entries", "stream=nb_read_packets:format=duration", "-of", "json", str(path)],
        capture_output=True, text=True, **NO_WINDOW)
    info = json.loads(r.stdout or "{}")
    frames = int(info.get("streams", [{}])[0].get("nb_read_packets", 0))
    dur = float(info.get("format", {}).get("duration", 0) or 0)
    return frames, dur, r.stderr.strip()


def probe_streams(path):
    """{codec_type: codec_name} and the video frame rate (avg_frame_rate) of a file."""
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name,avg_frame_rate",
         "-of", "json", str(path)], capture_output=True, text=True, **NO_WINDOW)
    streams = json.loads(r.stdout or "{}").get("streams", [])
    kinds = {s.get("codec_type"): s.get("codec_name") for s in streams}
    fps = None
    for s in streams:
        if s.get("codec_type") == "video" and "/" in (s.get("avg_frame_rate") or ""):
            n, d = s["avg_frame_rate"].split("/")
            fps = float(n) / float(d) if float(d) else None
    return kinds, fps


def decode_errors(path):
    """Full decode of every stream to the null muxer; returns ffmpeg's error output ('' = decodable)."""
    r = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-threads", "2", "-i", str(path), "-f", "null", "-"],
                       capture_output=True, text=True, creationflags=(subprocess.BELOW_NORMAL_PRIORITY_CLASS | subprocess.CREATE_NO_WINDOW) if os.name == "nt" else 0)
    return (r.stderr.strip() or (f"ffmpeg exit {r.returncode}" if r.returncode else ""))


def decoded_frames(path):
    """Video frames that actually decode (ffprobe -count_frames); used for the segment in flight."""
    r = subprocess.run(["ffprobe", "-v", "quiet", "-count_frames", "-select_streams", "v:0",
                        "-show_entries", "stream=nb_read_frames", "-of", "json", str(path)],
                       capture_output=True, text=True, **NO_WINDOW)
    try:
        return int(json.loads(r.stdout or "{}").get("streams", [{}])[0].get("nb_read_frames", 0))
    except (ValueError, TypeError):
        return 0


def check_segment(p, need_audio, decode=True, fps_default=FPS):
    frames, dur, err = probe(p)
    kinds, fps = probe_streams(p)
    fps = fps or fps_default
    real = frames / fps
    problems = []
    if frames <= 0:
        problems.append("no video frames")
    if err:
        problems.append(err[:120])
    if abs(real - dur) > 0.5:
        problems.append("duration mismatch")
    if "video" not in kinds:
        problems.append("no video stream")
    if need_audio and "audio" not in kinds:
        problems.append("no audio stream")
    if decode and frames > 0:
        de = decode_errors(p)
        if de:
            problems.append("decode: " + de.splitlines()[0][:120])
    return {"file": p.name, "frames": frames, "fps": fps, "seconds": round(real, 3), "header": round(dur, 3),
            "streams": kinds, "ok": not problems, "problems": problems}


def verify(a):
    out = pathlib.Path(a.out)
    files = segments(out, a.name)
    if not files:
        sys.exit("no segments")
    st = read_state(out, a.name)
    gaps = read_gaps(out, a.name)
    # A recording that did not end with a clean stop (state file still "recording", ffmpeg
    # failed, restart limit) has its last segment in flight: it may be truncated and does not
    # fail verify. Likewise each restart gap may truncate the one segment in flight at that crash.
    interrupted = st is not None and not (st.get("state") == "stopped" and st.get("ffmpegExit") == 0)
    crash_cut = {g.get("afterSegment") for g in gaps if g.get("afterSegment")}
    need_audio = st.get("audio", True) if st else True
    rows = []
    total_frames, bad = 0.0, 0
    for i, p in enumerate(files):
        r = check_segment(p, need_audio, decode=not a.no_decode)
        r["inFlight"] = interrupted and i == len(files) - 1
        r["crashTruncated"] = p.name in crash_cut
        if r["inFlight"] or r["crashTruncated"]:
            r["decodedFrames"] = decoded_frames(p)
            r["decodedSeconds"] = round(r["decodedFrames"] / r["fps"], 3)
        rows.append(r)
        bad += (not r["ok"]) and not (r["inFlight"] or r["crashTruncated"])
        total_frames += r["seconds"]
        if not a.json:
            note = "" if r["ok"] else "  FAIL " + "; ".join(r["problems"])
            if r["inFlight"] or r["crashTruncated"]:
                what = "in flight" if r["inFlight"] else "in flight at a crash"
                note += f"  [{what}: {r['seconds']:.2f} s of packets, {r['decodedSeconds']:.2f} s decodable]"
            print(f"{p.name}: {r['frames']} frames = {r['seconds']:.2f} s, header {r['header']:.2f} s{note}")
    # numbering: a restart continues the index, so indices must run without holes
    idx = [seg_index(p, a.name) for p in files]
    holes = sorted(set(range(idx[0], idx[-1] + 1)) - set(idx))
    gap_s = round(sum(g.get("durationS") or 0 for g in gaps), 3)
    open_gaps = sum(1 for g in gaps if g.get("endUtc") is None)
    if not a.json:
        for g in gaps:
            end = g.get("endUtc") or "never (no restart)"
            dur = f"{g['durationS']:.2f} s" if g.get("durationS") is not None else "open"
            print(f"gap {g.get('gap')}: {g.get('startUtc')} .. {end} ({dur}); {g.get('reason')}; "
                  f"after {g.get('afterSegment')}, before {g.get('beforeSegment')}")
        if holes:
            print(f"FAIL segment numbering has holes: {holes}")
    bad += bool(holes)
    summary = {"segments": len(files), "seconds": round(total_frames, 3), "failed": bad,
               "interrupted": interrupted, "recorderState": st.get("state") if st else None,
               "failReason": st.get("failReason") if st else None,
               "restarts": st.get("restarts", 0) if st else 0, "gaps": gaps, "gapSeconds": gap_s,
               "openGaps": open_gaps, "numberingHoles": holes, "rows": rows}
    if a.json:
        print(json.dumps(summary))
    else:
        print(f"{len(files)} segments, {total_frames:.1f} s total, {bad} failed"
              + (f", {len(gaps)} gap(s) {gap_s:.1f} s" if gaps else "")
              + (" (recording interrupted; last segment in flight)" if interrupted else ""))
    sys.exit(1 if bad else 0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["record", "verify"])
    ap.add_argument("--out", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--video", default="Live Gamer Ultra 2.1-Video")
    ap.add_argument("--audio", default="HDMI/Line In (Live Gamer Ultra 2.1-Audio)")
    ap.add_argument("--size", default="1920x1080")
    ap.add_argument("--max-min", type=int, default=60)
    # test options (tests/py/test_record.py)
    ap.add_argument("--source", choices=["dshow", "lavfi"], default="dshow",
                    help="lavfi = ffmpeg test pattern + sine tone (tests only)")
    ap.add_argument("--segment-s", type=int, default=SEGMENT_S)
    ap.add_argument("--fps", type=int, default=FPS)
    ap.add_argument("--max-s", type=int, default=0, help="cap in seconds; overrides --max-min")
    ap.add_argument("--vcodec", choices=sorted(VCODECS), default=DEVICE_VCODEC)
    ap.add_argument("--restart-limit", type=int, default=RESTART_LIMIT,
                    help=argparse.SUPPRESS)  # tests only; the default is the user's limit
    ap.add_argument("--restart-window-s", type=float, default=RESTART_WINDOW_S, help=argparse.SUPPRESS)
    # verify options
    ap.add_argument("--no-decode", action="store_true", help="verify: skip the full decode check")
    ap.add_argument("--json", action="store_true", help="verify: print one JSON summary")
    a = ap.parse_args()
    record(a) if a.mode == "record" else verify(a)


if __name__ == "__main__":
    main()
