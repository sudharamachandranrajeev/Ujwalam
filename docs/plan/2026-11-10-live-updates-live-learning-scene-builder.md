# Live updates, learning while streaming, scene builder (2026-11-10)

Status: APPROVED by the user 2026-11-10 (plan and order: yes; learning store 5 GB total, oldest streams removed first:
yes; a local vision model for layout reading: yes, if the hardware allows it, asked again before any install). Decision
D324. Amends the build plan (§4.6, §4.7, §4.10, §6).

User (2026-11-10): "all training data if needed anything in future will need to be learnt while the user uses the software
for live streaming. The software should be built in a way that it can test all changes from now on even if the software
is running - means changes should be able to implement live, on air, reliably and with no bugs, crashes and errors. The
another main function of the app should be scene builder (if not already in scope add it), redesigning everything based
on the reference image or video, to match theme."

## A. Live updates while on air (LU)

Today: the libobs host (encoders, outputs) is its own process; the Qt studio, the Node event core, the overlay server and
the clip/AI workers are separate processes; closing the studio stops everything (D280). An update today means close and
reinstall, which ends the stream.

Goal: an update applies while live without dropping a frame of the stream or recording, and rolls back on its own if the
new part fails.

| Id | What | Done when |
|---|---|---|
| LU1 | Update kinds. Each change is classed by the part it touches: data (presets, themes, packs, rules), overlay pages, services (event core, workers, studio-ui server), studio window, host. The packager writes this class into the release. | Every alpha.N lists its update kind per part; test on a fixture release. |
| LU2 | Data hot-reload: presets, themes, game packs, posting rules, flags reload from disk on change; schema-checked first; an invalid file keeps the old one and shows why. | Change each data kind while a loopback stream runs; no frame drop (ffprobe on the loopback), old value kept on a broken file. |
| LU3 | Service swap: the supervisor starts the new version of a service next to the old one, health-checks it, moves the API over, then stops the old one; on a failed check it keeps the old one. | Swap each service 20 times during a loopback stream: 0 dropped frames, 0 lost events (sequence numbers), rollback test with a crashing build. |
| LU4 | Studio window swap: closing the studio for an update no longer stops the host; the new studio reattaches to the running host (previews re-embed, state from the host). A normal close still stops everything (D280 kept). | Swap the studio 20 times during a loopback stream: no drop; previews back within 3 s. |
| LU5 | Host: never swapped while live (it owns the encoders; a swap would drop the stream). A host update is staged and applied at the next stop, with the user told what waits. | Host change during live is queued, applied after stop; test. |
| LU6 | Install while running: `Install-Ujwalam.ps1` gets a live mode that installs side by side and triggers LU2–LU5 instead of refusing while the app runs (install guard by path, D-existing, stays for the host part). | E2E: install alpha.N+1 during a loopback stream, every part except the host updated, stream unbroken. |
| LU7 | Safety: an update while live needs the "yes, on air" confirmation (existing studio-write rule); feature flags stay off by default; the control page shows each part's version and "waiting for stop" items. | Test the confirm gate; flag defaults test. |
| LU8 | Reliability gate for every change from now on: the full CI plus a "live soak": a 30-min loopback stream with scripted scene switches, effects, chat, clip saves and one update of each kind, asserting 0 dropped frames, no crash, no error log lines. A change ships only after it passes. | Soak job in CI tooling, run before each release. |

Honest limit: "no bugs, crashes and errors" cannot be proven; LU8 is the gate that makes a broken change fail before
release, and LU3/LU4 rollback limit the damage of one that slips through.

## B. Learning while streaming (LL)

Today: detector values and game packs are tuned from recordings and labels; P2 asks the user for training data per phase.

Goal: from now on the app learns from what happens during the user's own live streams and recordings; no separate
labelling sessions are asked for.

| Id | What | Done when |
|---|---|---|
| LL1 | Capture: while live, the clip pipeline keeps the evidence it already reads (detector hits, OCR text, frames only for items that need review) in a local, gitignored learning store per stream, capped at 5 GB total (user, 2026-11-10), oldest streams removed first. | Store written on a loopback stream; cap enforced. |
| LL2 | Signals the user already gives: kept / deleted / posted clips, the feedback hotkey (Ctrl+Alt+F), chat-feedback replies, the user's renames. Each becomes a label with source and time. | Test each signal → label row. |
| LL3 | Low-confidence reads (unknown mode, unclassified banner, OCR below threshold) are queued; after the stream the user can confirm in a short review in "My clips" (optional; never blocks anything). | Review page lists queued items; confirm writes a label. |
| LL4 | Training runs only after the stream ends (VRAM rule: nothing extra loaded while live), one job at a time, BelowNormal; a new pack version is proposed only if it beats the current one on held-out streams (existing rule) and ships behind a flag. | Pack proposal with held-out score; flag off by default. |
| LL5 | Privacy: learning data stays local and gitignored; committed labels keep placeholder names and no images (existing rules). | Private scan covers the store paths. |

## C. Scene builder from a reference (SB)

In scope already: "Theme from media" (§4.6: palette from an image) and "Theme → scene generator" (§4.7: layout slots with
H/V rules and safe zones). New: build or restyle scenes from a reference image or video, and restyle the app to match.

| Id | What | Done when |
|---|---|---|
| SB1 | Reference input: an image or a video file (frames sampled), local only. | Load both kinds; video sampled to N frames. |
| SB2 | Read the reference: palette (existing §4.6 method), type feel, corner radius, glow/shadow use, and the layout: where game, camera, chat, alerts and graphics sit (slot detection with rules first; an optional local vision model only through a typed schema, never a paid API). | On a set of reference images, slots and palette match a human check. |
| SB3 | Build: new H and V scenes from the slots with the user's real sources linked by reference; theme tokens for overlays; V framed so nothing important is cut (existing rule). Never changes existing scenes (import rule); output is new namespaced scenes plus a dry-run diff. | Built scene matches the reference layout within tolerance; existing state hash unchanged. |
| SB4 | Restyle: the same reference can produce a studio theme (data/themes, today's theme system) so the app matches the stream look. | Theme file from a reference passes the WCAG checks. |
| SB5 | Iterate: the user adjusts in the studio (move, resize, swap slot); "similar" variants; save as a scene package. | Round trip build → edit → package → import. |

## Order (proposal)

1. LU8 soak gate and LU2 data hot-reload first (they protect every later change).
2. LU3 service swap, LU4 studio swap, LU5 host staging, LU6 live install, LU7.
3. LL1–LL5 alongside, starting with LL2 signals (cheap, no model work).
4. SB1–SB5 after LU2 (scene builder output is data and benefits from hot-reload).

Routing: LU (live path, supervisor, host) on the strongest model with Codex second review; LL on the strongest model;
SB layout reading on the strongest model, UI parts mid-tier.
