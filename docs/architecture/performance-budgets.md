# Performance budgets

Approved by the user on 2026-10-28 (P3 plan, decision 3). PB-17 added on the user's approval of 2026-10-28; status UNVERIFIED until a quiet run confirms it. Every budget is `UNVERIFIED` until it is measured. Defined in P3 E0, before any code, as the standing checks require (`docs/plan/2026-10-28-core-build-order-and-checks.md` §3).

## Rules

1. **Replace after the first benchmark run.** After the first benchmark run for a budget, the budget is replaced by the measured value plus a margin. The proposed margin is 20 % headroom. The user confirms the margin at the first replacement. The row then links the evidence file, and `status` becomes `measured`.
2. **Regression check.** From then on, `npm run bench` flags any benchmarked metric that is more than 10 % worse than the last passing run (`tools/bench/run.mjs`). A user-approved change of the baseline goes through `npm run bench -- --accept "<reason>"` and is logged.
3. **Live path rule.** Nothing on the stream's critical path waits on network, disk scans, OCR or Jev.
4. **Machine context.** Every benchmark run records CPU model, logical cores, RAM, OS version, node and python version, and AC/battery state. A value measured on battery is not used to replace a budget.

## Budgets

| id | metric | budget | how measured (tool/counter) | first measurable in | status | measured value | date |
|---|---|---|---|---|---|---|---|
| PB-01 | Compositor frame time at 60 fps, H and V canvases rendering | p99 <= 12 ms | libobs per-frame render timing (frame-time counters), logged per frame, percentile over a 10 min window | P5/P6 | UNVERIFIED | | |
| PB-02 | Render-lag frames over 2 h | 0 | libobs lagged-frames counter at the end of a 2 h run | P6 | UNVERIFIED | | |
| PB-03 | Encoder-skipped frames over 2 h | <= 0.1 % of frames | libobs skipped-frames counter divided by total frames, per encoder rung | P6 | UNVERIFIED | | |
| PB-04 | Network-dropped frames over 2 h | <= 0.5 % of frames | libobs output dropped-frames counter divided by total frames, per sink | P6 | UNVERIFIED | | |
| PB-05 | NVENC encoder load while live | <= 80 % | NVML encoder utilisation (`nvidia-smi` encoder utilisation query), sampled once per second | P6 | UNVERIFIED | | |
| PB-06 | CPU while live | <= 60 % | whole-machine CPU counter (Windows performance counters, `typeperf`), sampled once per second | P6 | UNVERIFIED | | |
| PB-07 | GPU 3D load while live | <= 80 % | NVML GPU utilisation (`nvidia-smi`), sampled once per second | P6 | UNVERIFIED | | |
| PB-08 | VRAM while live | <= 5 GB of 6 GB | NVML memory used (`nvidia-smi`), peak over the run | P6 | UNVERIFIED | | |
| PB-09 | App and services RAM | <= 4 GB | sum of working set (private bytes) of the Qt app, event core, live-AI sidecar and clip worker, peak over the run | P6 | UNVERIFIED | | |
| PB-10 | UI input to visible response | <= 100 ms | UI event timestamp to the next presented frame, logged by the app's UI latency probe | P5 | UNVERIFIED | | |
| PB-11 | UI main-thread stall | none > 50 ms | main-thread watchdog (heartbeat gap) logged by the app | P5 | UNVERIFIED | | |
| PB-12 | Event latency, event core internal (ingest to action dispatch) | p95 <= 20 ms | event-core latency bench in `tools/bench/benches/` (monotonic timestamps at ingest and dispatch) | P3 (E7) | UNVERIFIED | | |
| PB-13 | Event latency, chat to effect (p95) | p95 <= 250 ms | chat message timestamp to first rendered frame of the effect, measured from rendered-frame luminance | P7 | UNVERIFIED | | |
| PB-14 | Event latency, chat to effect (p99) | p99 <= 500 ms | same measurement as PB-13 | P7 | UNVERIFIED | | |
| PB-15 | Memory growth over 2 h, event core | <= 5 % or <= 100 MB, after a 10 min warm-up | process working set sampled every 10 s during the E7 2 h soak | P3 (E7) | UNVERIFIED | | |
| PB-16 | Memory growth over 2 h, app | <= 5 % or <= 100 MB, after a 10 min warm-up | process working set of the app and each service, sampled every 10 s during the P6 2 h soak | P6 | UNVERIFIED | | |
| PB-17 | Stall tracer overhead | ingest p95 delta (tracer on minus off) <= 0.02 ms; idle main-thread busy <= 300 ms/min (0.5 % of one core), tracer and watchdog on | bench `stall-tracer-overhead` (`ingest_p95_delta_ms`, `idle_main_busy_ms_per_min`) | P3 (E7) | UNVERIFIED | | |

Notes:

- "5 % or 100 MB": the growth passes if either limit holds. The test reports both.
- PB-12 covers the event core only. Chat to on-screen effect (PB-13, PB-14) is measured in P7, when effects exist.
- Benchmarks reference these ids through the `budget` field of a bench module. The two tooling benches that exist today (registry validator and private scan wall time) have `budget: null`: they guard the CI loop, not a product budget.
