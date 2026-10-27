# 2026-10-27 — P1 phase gate (partial, P1 stays open)

Partial gate for the P1a commit, updated after P1b device session 2 (2026-10-27). Every Done-when row now has a result, and every P1 row is PASS. The user reviewed the gate on 2026-10-27 and approved the P1b commit.

## Done when

| Done when | Result | Evidence |
|---|---|---|
| ★ Chat Charge renders in a recording | PASS | `2026-10-27-p1a-chat-charge.md`; `out/p1/chat-charge-h.mkv` (h264 1920×1080@60, NVENC `obs_nvenc_h264_tex`, 20.1 s, 0 dropped); frames `p1/chat-charge-h-1…6.png` |
| H and V recordings both work (no devices) | PASS | `2026-10-27-p1a-output-graph.md`; `two-canvas-h.mkv` 1920×1080, `two-canvas-v.mkv` 1080×1920, both 60 fps, 0 dropped |
| H and V recordings with devices (capture card on H, Insta360 on V) | PASS (session 2, test 3) | `2026-10-27-p1b-devices.md` § Session 2 test 3. `p1b2-t3-hv-h.mkv` (1920×1080@60, 30.15 s, 1811 frames, 0 dropped) and `p1b2-t3-hv-v.mkv` (1080×1920@60, 30.48 s, 1830 frames, 0 dropped); one NVENC encoder per canvas; card 1280×720@60 NV12, camera 1920×1080@30 MJPEG; no `0x800705AA`; Chat Charge seen on both canvases at the same 6 events. Each device alone also passed (tests 1, 2). |
| Capture card + mic | PASS (session 2, tests 1 + 3) | Card live game picture (not "No Signal"), 1199-1200 unique frames per 20 s (60 fps); HDMI audio peak −5.1 dBFS (meter), max −4.6 dB / mean −27.5 dB (volumedetect). Mic opened with the card in test 3 (peak −45.3 dBFS, quiet); session 1 mic peak −24.3 dBFS. |
| 5 plugins tiered | PASS (tiers recorded) | `docs/plugins/compat-matrix.md`. The Background Removal device test was not run: the plugin is tier C (does not load on OBS 32.1.2 / Qt 6.8). It is deferred to the camera-effects phase, not blocked on P1. |
| ★ Chat Charge side-by-side parity vs legacy | PASS (session 2, test 4) | `2026-10-27-p1b-devices.md` § test 4. The same 33 scheduled mock events went to legacy (headless Chrome 156) and libobs at once. Fired/dropped agree 33/33. Fire intervals are identical on both hosts: 300 ms spacing 1799/1801/1800 ms, 1200 ms spacing 2380/2400/2409, 1600 ms spacing all fire. This matches the legacy 620 ms + 900 ms cooldown rule. Colours `#a74837` / `#83a1dc` / `#e9dada` (legacy) vs hues 5-6° / 220-222° (libobs). Edge share within 220 px: 0.899 vs 0.862. Flash rate 0 flashes/s (limit 3), max window step ΔL 0.002. Legacy inside Meld: UNVERIFIED (Meld kept closed). |

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
| `npm test` | tests 90, pass 90, fail 0, skipped 0 (re-run after session 2) |
| `npm run validate:registry` | `OK: registry valid` (re-run after session 2) |
| `npm run legacy:verify` | `OK: legacy matches legacy.manifest.sha256` (before test 4 and after session 2) |
| `npm run validate:outputs` | exit 0, `Total egress: 70140 kbps` (re-run after session 2) |
| Spike build | CMake + MSVC 14.44 build log in `2026-10-27-p1a-build.md` (build output in `app/spike/build/`, gitignored) |

## Placeholders, mocks, risks

- Mock Streamer.bot used to fire Chat Charge test events (test harness only; not a feature). Session 2 added a scheduled mock (`app/spike/tools/mock-chat-schedule.mjs`) and the parity tools `legacy-browser-trace.mjs`, `flash-rate.mjs`, `parity-cooldown.mjs`. All are spike test tools, not product code.
- The capture card (AVerMedia Live Gamer Ultra 2.1, supports up to 4K per the user) delivered 1280×720@60 by default, upscaled to the 1920×1080 canvas. Its format list was not read (UNVERIFIED). Selecting the device format is P5 work.
- The cause of the session 1 Insta360 `0x800705AA` is UNVERIFIED. It did not occur in session 2 (alone or with the card).
- Parity timing: libobs latency (12-79 ms, mean 37) is anchored to the output start signal, so it carries ±1-2 frames plus encoder delay. The red-flash criterion was not measured (UNVERIFIED). Chat Charge variant and colour are random per host, so per-effect pixels are compared as distributions, not pairs.
- Seven session 2 frames show the user's face, other players' names, or a game watermark that may be an account id. They are local only in `docs/evidence/private/` (gitignored); the list is in `2026-10-27-p1b-devices.md`.
- libobs `rtmp-services` / `win-capture` contact obsproject.com at startup; host is not offline by default (fix in P4).
- win-dshow enumerates every DirectShow camera when a dshow source starts.
- Discord held one NVENC session during tests.
- Plugin tiers: Move A, Source Clone A, obs-browser B, Background Removal C (Qt 6.11 vs 6.8.3), obs-websocket C headless, Advanced Scene Switcher C headless, LocalVocal skipped (no OBS 32 statement).

## Remaining for P1b

- Done in session 2: capture card with a real HDMI signal, Insta360 alone, H + V together, and ★ Chat Charge parity (cooldown, flash rate).
- Not P1 work: Background Removal is deferred to the camera-effects phase (options a/b/c in `docs/plugins/compat-matrix.md`).
- Not run: the device-disconnect test (optional in the session 2 brief).
- Gate review done (2026-10-27): frames with the user's face or other players' names stay local only; the other frames are committed.

## Housekeeping

Deleted with user approval (scratch, `out/p1/`, never tracked): `probe-frame-2s.png`, `diff-300-1.png`, `chat-charge-h.timeline-t32.json`, `chat-charge-h.timeline-t40.json`, `probe-p1b/` (h15.png, v15.png), `module-config-ass/` (4 files), empty `module-config-ws/`. The 13 recordings are kept until the P1 gate passes. Session 2 added 6 recordings; `out/p1` is now 460.3 MB (limit 1 GB). Session 2 deleted nothing. After the gate review, with user approval: deleted `out/p1/p1b2-t4-parity.*`, `mock-parity.log` and `legacy-chrome-trace.json` (parity run 1, superseded by run 2), and the session scratch frames and Chrome profile. `out/p1` now holds 18 recordings (403 MB), kept outside git until O2 as the encoder-graph baseline; the user decides then.
