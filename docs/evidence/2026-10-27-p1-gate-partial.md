# 2026-10-27 — P1 phase gate (partial, P1 stays open)

Partial gate for the P1a commit. P1 closes after the device session (P1b remainder).

## Done when

| Done when | Result | Evidence |
|---|---|---|
| ★ Chat Charge renders in a recording | PASS | `2026-10-27-p1a-chat-charge.md`; `out/p1/chat-charge-h.mkv` (h264 1920×1080@60, NVENC `obs_nvenc_h264_tex`, 20.1 s, 0 dropped); frames `p1/chat-charge-h-1…6.png` |
| H and V recordings both work (no devices) | PASS | `2026-10-27-p1a-output-graph.md`; `two-canvas-h.mkv` 1920×1080, `two-canvas-v.mkv` 1080×1920, both 60 fps, 0 dropped |
| H and V recordings with devices (capture card on H, Insta360 on V) | BLOCKED — awaiting device session | `2026-10-27-p1b-devices.md`: capture card showed "No Signal" (no phone signal); Insta360 `DShow: Run failed (0x800705AA)` |
| Capture card + mic | BLOCKED — awaiting device session | fifine SC3 mic PASS (peak −24.3 dBFS); capture card video/audio had no signal |
| 5 plugins tiered | PASS (tiers recorded; device-dependent function tests BLOCKED) | `docs/plugins/compat-matrix.md` |
| ★ Chat Charge side-by-side parity vs legacy | BLOCKED — awaiting device session | Source-value comparison done in `2026-10-27-p1a-chat-charge.md`; 900 ms cooldown and ≤ 3 flashes/s UNVERIFIED |

## Output-graph assumptions (docs/plan/2026-10-26-output-graph.md)

| Assumption | Result |
|---|---|
| Several outputs share one encoder | PASS |
| Encoder scales from the canvas on the GPU | PASS |
| Two canvases (H, V) each feed their own encoders | PASS (`obs_canvas_create`) |

No ADR needed.

## Checks

| Command | Result |
|---|---|
| `npm test` | tests 90, pass 90, fail 0, skipped 0 |
| `npm run validate:registry` | `OK: registry valid` |
| `npm run legacy:verify` | `OK: legacy matches legacy.manifest.sha256` |
| `npm run validate:outputs` | exit 0 |
| Spike build | CMake + MSVC 14.44 build log in `2026-10-27-p1a-build.md` (build output in `app/spike/build/`, gitignored) |

## Placeholders, mocks, risks

- Mock Streamer.bot used to fire Chat Charge test events (test harness only; not a feature).
- libobs `rtmp-services` / `win-capture` contact obsproject.com at startup; host is not offline by default (fix in P4).
- win-dshow enumerates every DirectShow camera when a dshow source starts.
- Discord held one NVENC session during tests.
- Plugin tiers: Move A, Source Clone A, obs-browser B, Background Removal C (Qt 6.11 vs 6.8.3), obs-websocket C headless, Advanced Scene Switcher C headless, LocalVocal skipped (no OBS 32 statement).

## Remaining for P1b (device session)

- Capture card with a real HDMI signal (video + HDMI audio).
- Insta360 alone, then H (capture card) + V (Insta360) together.
- ★ Chat Charge side-by-side parity capture vs legacy (cooldown, flash rate).
- Background Removal: deferred to the camera-effects phase (options a/b/c in `docs/plugins/compat-matrix.md`).

## Housekeeping

Deleted with user approval (scratch, `out/p1/`, never tracked): `probe-frame-2s.png`, `diff-300-1.png`, `chat-charge-h.timeline-t32.json`, `chat-charge-h.timeline-t40.json`, `probe-p1b/` (h15.png, v15.png), `module-config-ass/` (4 files), empty `module-config-ws/`. The 13 recordings are kept until the P1 gate passes.
