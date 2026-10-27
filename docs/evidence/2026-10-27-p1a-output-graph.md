# P1a: output-graph assumptions c, d, e (2026-10-27)

| Assumption | Result |
|---|---|
| c. Two canvases (H 1920x1080 and V 1080x1920) render and record at the same time from one libobs instance | **PASS** |
| d. One encoder object feeds two outputs (encode once, many sinks) | **PASS** |
| e. GPU scaling: encode at a smaller size than the canvas without a CPU frame path | **PASS** |

No assumption failed, so no ADR is needed.

Before every encode run, the spike's `encode_allowed()` and `Get-Process` checked for `MeldStudio*` / `obs64`. No run found either process.
A Discord process held one NVENC session (AV1 1280x720@30, PID 10512) during all runs. It is the baseline in the session counts below.

## c. Two canvases

API: `obs_canvas_create("V", &ovi, OBS_CANVAS_ACTIVATE | OBS_CANVAS_EPHEMERAL)` (flags 0x12), `obs_canvas_scene_create`, `obs_canvas_set_channel(vc, 0, …)`, then the encoder bound to `obs_canvas_get_video(vc)`. H uses the main canvas (`obs_get_video()`). Each canvas has its own NVENC encoder; one AAC encoder is shared.

```powershell
app\spike\build\ujwalam-spike.exe two-canvas --runtime C:\AI\Claude\_vendor\obs-32.1.2\runtime --out out\p1 `
  --url-h "http://localhost:8797/overlays/chat-charge/index.html?sbPort=8094&canvas=horizontal" `
  --url-v "http://localhost:8797/overlays/chat-charge/index.html?sbPort=8094&canvas=vertical" --seconds 20
```

```
canvas V created: base 1080x1920 output 1080x1920 @60/1 flags=0x12
output 'rec-h' total_frames=1216 dropped=0
output 'rec-v' total_frames=1232 dropped=0
process CPU during recording: 1.6%
obs_shutdown returned
two-canvas-h.mkv : h264 High 1920x1080 60/1 ; aac LC ; duration=20.267
two-canvas-v.mkv : h264 High 1080x1920 60/1 ; aac LC ; duration=20.517
```

Both canvases show the same overlay events (effect-timeline, threshold 32):

```
H: f86 hue 4.2 | f237 hue 5.3 | f386 hue 4.9 | f688 hue 5.4      (latency from mock send +39/+55/+37/+71 ms)
V: f78 hue 221.6 | f228 hue 4.3 | f379 hue 221.1 | f678 hue 221.3 (latency +33/+32/+48/+31 ms)
```

H and V show different colours for the same event because the legacy overlay picks a random variant per canvas. Each canvas loads its own page. NVENC sessions during the run: 3 (Discord + H + V). Frames: `docs/evidence/p1/two-canvas-h-f249.png`, `two-canvas-v-f082.png`.

## d. Shared encoder

```powershell
app\spike\build\ujwalam-spike.exe shared-encoder --runtime C:\AI\Claude\_vendor\obs-32.1.2\runtime --out out\p1 --seconds 15
# packet-level comparison
ffprobe -v error -select_streams v:0 -show_entries packet=data_hash -show_data_hash SHA256 -of csv=p=0 out\p1\shared-a.mkv   # and shared-b.mkv, and a:0
```

```
sink-a video encoder=000001EF652703C0 sink-b video encoder=000001EF652703C0 (same object: yes)
sink-a audio encoder=000001EF652709C0 sink-b audio encoder=000001EF652709C0 (same object: yes)
output 'sink-a' total_frames=905 dropped=0
output 'sink-b' total_frames=924 dropped=0
stream v: a=904 b=922 b-in-a=907 first-equal=True
stream a: a=706 b=720 b-in-a=720 first-equal=True
```

- The video packets are byte-identical. The first packet is equal, and 907 of b's packets have a hash found in a; repeated static frames give equal hashes. The remaining b packets come from the ~0.3 s that b ran after a stopped.
- Audio was silence, so identical AAC frames repeat. The audio match is weaker proof than the video match; the encoder pointer equality is the main audio evidence.
- NVENC sessions went from 1 (Discord) to 2: one session for two outputs.

## e. GPU scale

```powershell
app\spike\build\ujwalam-spike.exe gpu-scale --runtime C:\AI\Claude\_vendor\obs-32.1.2\runtime --out out\p1 `
  --base 3840x2160 --scaled 1920x1080 --bg image:out\p1\media\testsrc-2160p.png `
  --url "http://localhost:8797/overlays/chat-charge/index.html?sb=0&test=1" --seconds 10
# arguments reconstructed from gpu-scale.log (the host logs the sources it creates, not argv)
```

```
encoder 'scaled-video' ... size=1920x1080 scaling=1 gpu_scaling=1 scale_type=2 video_mix=3840x2160 active=0   (before start)
[obs-nvenc] GPU scaling enabled
encoder 'scaled-video' ... size=1920x1080 scaling=1 gpu_scaling=1 scale_type=2 video_mix=1920x1080 active=1   (after start)
output 'gpu-scale' total_frames=605 dropped=0
main video: 3840x2160 fps 60/1 format 2 skipped=0 total=0
gpu-scale.mkv : h264 High 1920x1080 60/1 ; duration=10.050
```

`obs_encoder_set_gpu_scale_type(OBS_SCALE_BICUBIC)` + `obs_encoder_set_scaled_size` created an encoder-only video mix at 1920x1080. `total=0` raw frames on the main mix means no CPU scale or copy path was used. Frame: `docs/evidence/p1/gpu-scale-f300.png`.

## Shutdown finding (host requirement)

The chat-charge, shared-encoder and gpu-scale runs exited with `CRASH: exception 0x80000003 ... libcef.dll (+0x275f2e0)`. In every case this happened after the files were finalised. Cause: the main canvas holds a reference on scenes (SCENE_REF), so releasing a scene left its browser sources alive into `obs_shutdown`, and CEF was unloaded with live browsers. Fix: in the scenario teardown, call `obs_source_remove` on each scene and source before releasing it (`Bag` in `app/spike/src/scenes.cpp`). Every run after the fix logs `obs_shutdown returned` and exits 0: two-canvas, plugin-move, plugin-clone and both P1b runs.

## Not checked / UNVERIFIED

- Long-run stability (> 30 s), and NVENC load under H+V plus a streaming output. Both belong to P6.
- Replay buffer sharing the same encoder (P6).
