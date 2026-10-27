# P1a: ★ Chat Charge renders in a libobs recording, plus parity (2026-10-27)

Result: **PASS** for "★ Chat Charge renders in a recording".
Parity: **PASS (partial)**. Timing, colour, geometry and guards were measured against legacy source values. The live side-by-side capture against legacy running in Meld is **UNVERIFIED** (not done in P1).

## Setup

- Legacy overlay served unchanged from `legacy/` with `legacy\tools\serve.ps1 -Port 8797`.
- Trigger source: the legacy mock Streamer.bot sample set, replayed on port 8094 every 2500 ms. A timestamped wrapper logged each send to `out/p1/mock-sb-chat-charge.log`. The wrapper is a scratch script and is not in the repo.
- Overlay URL: `http://localhost:8797/overlays/chat-charge/index.html?sbPort=8094&debug=1`. The debug readout (top-left 320x180) is masked out of the measurements.
- Flat colour background (`color_source_v3`). Measurements run on the recording with `app/spike/tools/effect-timeline.mjs`.

## Commands

```powershell
# NVENC safety rule: no MeldStudio*/obs64 process (checked by the spike itself via encode_allowed() and by Get-Process)
app\spike\build\ujwalam-spike.exe chat-charge --runtime C:\AI\Claude\_vendor\obs-32.1.2\runtime --out out\p1 `
  --url "http://localhost:8797/overlays/chat-charge/index.html?sbPort=8094&debug=1" --seconds 20 --preroll 5 --name chat-charge-h
ffprobe -v error -show_entries stream=codec_name,profile,width,height,r_frame_rate,pix_fmt,sample_rate,channels:format=duration -of compact out\p1\chat-charge-h.mkv
node app\spike\tools\effect-timeline.mjs --video out\p1\chat-charge-h.mkv --threshold 32 --mask 0,0,320,180 --border 6 --ref 30 --json out\p1\chat-charge-h.timeline.json
```

## Output

```
encoder 'h-video' id=obs_nvenc_h264_tex codec=h264 size=1920x1080 ... fps=60/1 active=1 settings={"bitrate":8000,"keyint_sec":2,"bf":2,"rate_control":"CBR",...}
output 'chat-charge-h' total_frames=1208 dropped=0 bytes=20105782
H video: 1920x1080 fps 60/1 format 2 skipped=0 total=1222        (render_avg 0.5-0.9 ms, lagged 0)

ffprobe: h264 High 1920x1080 60/1 yuv420p | aac LC 48000 Hz 2ch | duration 20.117 s | keyframes every 2.000 s
```

The encoder name is not stored in the mkv (writer tag `Lavf61.7.100`). The log is the proof that NVENC was used.

Overlay debug readout at the end of the run: socket subscribed, colours from tokens, messages 6, fired 5, dropped 0.

Frames (640 px): `docs/evidence/p1/chat-charge-h-1-before-f060.png`, `-2-ep1-start-f110`, `-3-ep1-peak-f124`, `-4-ep2-peak-f265`, `-5-ep3-peak-f570`, `-6-after-f700`.

Shutdown note: this run exited with a libcef breakpoint (0x80000003) **after** the file was finalised. Cause and fix are in `2026-10-27-p1a-output-graph.md`: scenes must be removed before release. Later runs exit cleanly.

## Parity against legacy behaviour

Legacy reference values come from `legacy/overlays/chat-charge` source and the `bloodmoon` theme tokens.

| Property | Legacy value | Ujwalam libobs capture | Verdict |
|---|---|---|---|
| Fires on chat messages | YouTube, Kick, `!clip` fire (skipCommands default 0) | 3 effects in the H recording, matching those 3 sample events | PASS |
| Guards | empty message and voice events must not fire | no effect for the empty-message and voice samples | PASS |
| Trigger latency | — (browser, immediate) | +35 / +85 / +16 ms from mock send to first visible frame (anchored to output start; ±1 frame) | PASS (approx.) |
| Duration | 620 ms, envelope rise 12 % (74 ms), (1-x)^1.6 decay | visible 483 / 383 / 417 ms at the detection threshold; rise to peak 67-267 ms | PASS: the decay tail falls below the threshold. Exact envelope UNVERIFIED |
| Cooldown | 900 ms | sends are 2500 ms apart, so the cooldown was not exercised | UNVERIFIED |
| Blue glow colour | `--hud-cyan` #83a1dc (hue 219.8°) | glow hue 219.1° / 220.2° | PASS |
| Red glow colour | `--threat` #a74837 (hue 9.1°) | glow hue 5.5° (4:2:0 chroma + additive blending) | PASS (approx.) |
| Not combat fallback | combat cyan #3fd8e8 = 185.7° | 219-222°; tokens are read, not fallbacks | PASS |
| Core | near-white | core RGB 165/172/198 on episode 1 (blended) | UNVERIFIED (not measurable precisely) |
| Geometry (H) | edge band 220 px, max reach well inside 600 px | share of active pixels within 220 px of an edge: 0.848 (corner variant), 1.0, 1.0; within 600 px: 1.0 | PASS |
| Geometry (V) | band 260 px | two-canvas V run: within 220 px 0.64-0.97; within 600 px 1.0 | PASS (band is wider on V, as legacy) |

Timeline episodes (`chat-charge-h.timeline.json`):

```
1 f108-136 pk124 vis=483ms rise=267 in220=0.848 in600=1 hue=220.2 core=165/172/198
2 f261-283 pk265 vis=383ms rise=67  in220=1     in600=1 hue=219.1
3 f557-581 pk570 vis=417ms rise=217 in220=1     in600=1 hue=5.5
```

## Not checked / UNVERIFIED

- Side-by-side capture of legacy Chat Charge in Meld (or a browser) with the same events. P1 compared against legacy source values only. The CLAUDE.md ★ rule requires the side-by-side before the preset port is marked done (P7b).
- Cooldown (900 ms) and flash rate (≤ 3 flashes/s). The event spacing was 2500 ms.
- obs-browser hardware acceleration was off. GPU cost with it on is UNVERIFIED.
