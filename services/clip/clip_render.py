# SPDX-License-Identifier: GPL-3.0-or-later
"""F6 vertical variants: ffmpeg filter graphs and the render call.

Layouts (data/clip/layouts.json, build plan 4.10):
  crop   full crop: a 9:16 window of the source at centerX, scaled to the output frame.
  stack  gameplay + facecam: the facecam rectangle on top (topHeight px), the game rectangle below, each cropped to
         cover its panel.
  fill   blurred fill: the whole source fitted in the frame over a blurred, cover-scaled copy (blurred at quarter
         size to keep the CPU cost low). gblur, not boxblur: boxblur is GPL-only and absent from LGPL ffmpeg builds.
  canvas the studio's V canvas recording itself (input "v"): the clip looks exactly like the vertical stream scene
         (design, overlays, blurred game layer); only fitted to the output frame (user decision 2026-11-07).
Captions are burned with the libass `subtitles` filter. ffmpeg runs with cwd = the clip folder and a bare file
name, so no Windows path ever needs filter escaping.

Encoders: libopenh264 (CPU) or h264_nvenc (GPU). 'auto' picks NVENC only when no ujwalam-host runs (a live stream
or soak owns the GPU; one GPU job at a time). Children run at below-normal priority with 4 threads.
"""

from __future__ import annotations

import os

from clip_common import ClipError, FFMPEG_THREADS, host_running, run_tool

ENCODERS = {
    "libopenh264": ["-c:v", "libopenh264", "-b:v", "8000k", "-maxrate", "10000k", "-g", "120"],
    "h264_nvenc": ["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "21", "-b:v", "10000k",
                   "-maxrate", "14000k", "-bufsize", "20000k", "-g", "120", "-bf", "2"],
}
AUDIO = ["-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2"]


def _even(x):
    return max(2, int(x) // 2 * 2)


def pick_encoder(choice):
    if choice == "auto":
        return "libopenh264" if host_running() else "h264_nvenc"
    if choice not in ENCODERS:
        raise ClipError(f"unknown encoder {choice} (use {', '.join(ENCODERS)} or auto)")
    return choice


def _rect(norm, iw, ih):
    x, y, w, h = (float(v) for v in norm)
    if not (0 <= x < 1 and 0 <= y < 1 and 0 < w <= 1 and 0 < h <= 1 and x + w <= 1.0001 and y + h <= 1.0001):
        raise ClipError("layout rectangle out of range (normalised x, y, w, h)")
    px, py = _even(x * iw) if x > 0 else 0, _even(y * ih) if y > 0 else 0
    return min(_even(w * iw), iw - px), min(_even(h * ih), ih - py), px, py


def _cover(w, h):
    return f"scale={w}:{h}:force_original_aspect_ratio=increase:flags=bicubic,crop={w}:{h}"


def layout_graph(layout, iw, ih, ow, oh):
    """Returns the video filter graph from [0:v] to [vout] (without captions and final format)."""
    kind = layout["kind"]
    if kind == "canvas":
        return (f"[0:v]scale={ow}:{oh}:force_original_aspect_ratio=decrease:flags=lanczos,"
                f"pad={ow}:{oh}:(ow-iw)/2:(oh-ih)/2,setsar=1[vout]")
    if kind == "crop":
        if iw * oh >= ih * ow:   # source wider than the output aspect: cut the sides
            cw, ch = _even(ih * ow / oh), _even(ih)
        else:                    # source narrower (already vertical): cut top and bottom
            cw, ch = _even(iw), _even(iw * oh / ow)
        cx = float(layout.get("centerX", 0.5)) * iw
        x = int(min(max(0, cx - cw / 2), iw - cw)) // 2 * 2
        y = (ih - ch) // 2 // 2 * 2
        return f"[0:v]crop={cw}:{ch}:{x}:{y},scale={ow}:{oh}:flags=lanczos,setsar=1[vout]"
    if kind == "fill":
        blur = max(1, int(layout.get("blur", 24)) // 4)
        qw, qh = _even(ow / 4), _even(oh / 4)
        return (f"[0:v]split=2[bg][fg];"
                f"[bg]{_cover(qw, qh)},gblur=sigma={blur}:steps=2,scale={ow}:{oh}:flags=bilinear[bgb];"
                f"[fg]scale={ow}:{oh}:force_original_aspect_ratio=decrease:flags=lanczos[fgs];"
                f"[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1[vout]")
    if kind == "stack":
        top = _even(layout.get("topHeight", 640))
        if not 0 < top < oh:
            raise ClipError("stack layout topHeight out of range")
        fw, fh, fx, fy = _rect(layout["facecam"], iw, ih)
        gw, gh, gx, gy = _rect(layout["game"], iw, ih)
        return (f"[0:v]split=2[a][b];"
                f"[a]crop={fw}:{fh}:{fx}:{fy},{_cover(ow, top)}[cam];"
                f"[b]crop={gw}:{gh}:{gx}:{gy},{_cover(ow, oh - top)}[game];"
                f"[cam][game]vstack=inputs=2,setsar=1[vout]")
    raise ClipError(f"unknown layout kind {kind}")


def render_argv(ffmpeg, src, start, dur, graph, encoder, out_name, has_audio, captions=None):
    """argv for one variant. captions: a bare ASS file name in the working folder, or None."""
    tail = ",subtitles=" + captions if captions else ""
    graph = graph.replace("[vout]", "[vpre]", 1) + f";[vpre]format=yuv420p{tail}[vout]"
    argv = [ffmpeg, "-v", "error", "-nostdin", "-y", "-threads", str(FFMPEG_THREADS), "-filter_threads", "2",
            "-ss", f"{start:.3f}", "-t", f"{dur:.3f}", "-i", src]
    if not has_audio:
        argv += ["-f", "lavfi", "-t", f"{dur:.3f}", "-i", "anullsrc=r=48000:cl=stereo"]
    argv += ["-filter_complex", graph, "-map", "[vout]", "-map", "0:a:0" if has_audio else "1:a:0",
             "-fpsmax", "60", *ENCODERS[encoder], *AUDIO, "-movflags", "+faststart", "-shortest", "-f", "mp4",
             out_name]
    return argv


def render_variant(ffmpeg, src, info, cand, layout, frame, encoder, workdir, captions=None, timeout=1800):
    """Renders one variant into workdir/<layout id>.mp4 (written as .part, renamed on success)."""
    ow, oh = int(frame["width"]), int(frame["height"])
    graph = layout_graph(layout, info["width"], info["height"], ow, oh)
    name = f"{layout['id']}.mp4"
    part = name + ".part"
    dur = float(cand["end"]) - float(cand["start"])
    argv = render_argv(ffmpeg, src, float(cand["start"]), dur, graph, encoder, part, info["has_audio"], captions)
    r = run_tool(argv, cwd=workdir, timeout=timeout)
    if r.returncode != 0:
        try:
            os.remove(os.path.join(workdir, part))
        except OSError:
            pass
        raise ClipError(f"render {cand['id']}/{layout['id']} failed: {r.stderr.strip()[-300:]}")
    os.replace(os.path.join(workdir, part), os.path.join(workdir, name))
    return name
