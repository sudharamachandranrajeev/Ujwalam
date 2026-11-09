# Live test kit: what a one-hour test stream still needed (2026-11-09)

Result: **PASS (headless tests, Qt headless probe, quick CI). Not yet used on a real stream.** New behaviour is behind
the flag `live-test-kit`, off by default. Branch `live/test-banner`. Proposed decision D305 is at the end.

Scope: the four items of AGENTS.md "Live stream testing" that a one-hour test stream needs: the on-screen test
banner, the spoken announcement, the chat feedback question and collection, and the studio window showing stream
recovery and audio problems.

## 1. Test banner on H and V: already built (BM3, D196), nothing changed

- Flag `test-broadcast` (off), preset `registry/presets/test-broadcast.json` on function `timed-banner`, page
  `services/overlay-server/pages/ujwalam-test-broadcast/` (plain `<script>`, no CDN, `textContent` only, tokens),
  layers in `scene-default-h.json` and `scene-default-v.json` (V placed inside the safe area, D232).
- Entrance 450 ms (< 600), exit 300 ms (< 400), every 15 min, hold 18 s; text: "Test broadcast. We are trying new
  streaming software. Tell us in chat how the video, sound and scenes look."
- Checked again today: `node --test tests/test-broadcast.test.mjs` passes (see section 5).
- Still open from BM3: H/V frame captures from the real host (need the host and the user's yes). UNVERIFIED on a real
  frame that nothing is cut on V.

## 2. Speaker.bot announcement: Ujwalam reminds; the user's own Streamer.bot action speaks

How the code talks to the bots today (searched `services/` for speaker/streamer):

- `services/event-core/streamerbot/`: read-only WebSocket connector, events in, never sends (P3 rule, D192).
- `services/bots/index.mjs`: starts/stops the user's installed copies; `health()` opens a TCP connection and sends
  nothing to either bot.
- No code sends anything to Speaker.bot or Streamer.bot. A Streamer.bot DoAction write path is BM8, planned for P15
  after an ADR and a security review.

So the only allowed path is the user's own Streamer.bot action (BM4 setup:
`docs/tests/2026-11-04-A0-S1-streamerbot-test-action.md`), which posts the chat question and has Speaker.bot read the
announcement. Ujwalam does **not** trigger it: "Ujwalam's Streamer.bot connection stays read-only" (AGENTS.md) rules
out a DoAction call, and a direct Speaker.bot "speak" request would be a new write path into another program that
needs the same review. What was added:

- `data/live/test-kit.json` (status `unverified`, a source per value): the action name (`Ujwalam test stream`),
  the announcement, the chat question, its prefix, the reply marker `fb:`, the reply window (10 min) and the
  reminder time (10 min). Nothing of this is written in code (a test checks it).
- With the flag on, for the first `reminderMin` minutes after the stream goes live, the studio window and the
  control page show: `Test stream: start your Streamer.bot action "Ujwalam test stream" now (it posts the feedback
  question and has Speaker.bot read the announcement). Ujwalam does not post or speak.`

UNVERIFIED: that the action exists on the laptop under that name, and that its Speaker.bot step speaks (the first
real stream ran without the spoken step, user 2026-11-03; on Streamer.bot 0.2.8 the step is copied from the user's
TTS action).

## 3. Chat feedback: collected by itself when the stream ends

Already there: `tools/collect-stream-feedback.mjs` (BM5, D195), read-only on `event-core.db`, writes
`feedback/YYYY-MM-DD-stream-feedback.md` (gitignored), escapes viewer text, never duplicates. Gaps filled:

- With the flag on, the studio UI server watches `host.status.live`; when a stream ends (live -> offline) it runs
  the collector for exactly that stream's time span, with the prefix, marker and window from `test-kit.json`, into
  the launcher's feedback folder. It runs after the status poll (never blocks it) and never throws: a failure shows
  as a warning line ("Viewer feedback was not collected: ... Run tools/collect-stream-feedback.mjs by hand.").
- After the stream the strip shows: `Viewer feedback saved: N message(s) (YouTube a, Twitch b, Kick c) in
  feedback/<date>-stream-feedback.md`. Counts and the file name only; no viewer text or names leave that file.
- The CLI uses the same `test-kit.json` defaults when `--question-prefix`, `--marker` or `--window-min` are not given.
- Ujwalam never posts the question (the user's Streamer.bot action does).

## 4. Studio window (Qt) and control page: stream recovery and sound problems in plain words

- `services/studio-ui/live-test-kit.mjs` `liveAlerts()` (pure) builds `alerts: [{ id, level, text }]` in the
  `/ui/api/status` snapshot when the flag is on: the newest stream-recovery event of this session first (its own
  text from `stream-recovery.mjs`, level `warn` when restarted, `error` otherwise), then each `audioHealth` warning
  as `Sound problem: Game audio missing. Ujwalam is restarting that sound; if it stays silent, check the device and
  its cable.`, then the Streamer.bot reminder and the feedback result.
- Qt (`app/studio/src/main_window.cpp`): a strip under the top bar (`alertBar`), plain text only, one line per
  alert, border coloured by the worst level (theme tokens `danger` / `accent` / `border`), hidden when empty or with
  the flag off. `probe()` reports `alerts { shown, text, level }`.
- Control page (`ui/js/app.js`): the existing audio and recovery pills stay; a new `st-testkit` pill shows the
  reminder and the feedback result (`textContent` via `setText`).

## 5. Tests and checks

| Command | Result |
|---|---|
| `node --test tests/live-test-kit.test.mjs` | 13/13 pass: config + sources, no texts in code, bad config refused, flag off by default, package list; `liveAlerts` cases; auto-collect on a temp DB with placeholder names (3 replies kept, question/unrelated/pre-stream rows left out, once only, flag off = nothing, missing DB = failed result); server flag off = no `alerts`, flag on = sound line + reminder while live, feedback line after |
| `node --test tests/studio-qt-alerts.test.mjs` (shell built with `node app/studio/tools/build.mjs`) | 2/2 pass: flag off = strip hidden; flag on = 3 lines (recovery text, sound line, reminder with the action name), level `error` |
| touched suites (stream-feedback, studio-qt-shell, package-alpha, studio-ui-server, test-broadcast, studio-ui-readiness, stream-recovery, studio-ui-alpha, studio-ui-live-test) | 204 tests: 201 pass, 2 skipped (pre-existing skips), 1 fail = `test-broadcast` "registry validates", caused by the worktree having no `legacy/` (legacySource paths missing); after linking `legacy/` to the main checkout, `tests/test-broadcast.test.mjs` 14/14 pass |
| `node tools/ci.mjs --quick` | 8/8 pass in 27.4 s (build, lint, build-host, validate-registry, validate-outputs, validate-games, private-scan, legacy-verify) |

All headless (`UJWALAM_HEADLESS=1`), fake host, 127.0.0.1 only; nothing went live, nothing was posted, spoken or
sent to Streamer.bot or Speaker.bot.

## 6. Also fixed

`tools/package/manifest.mjs` did not ship `data/live/readiness.json` and `data/live/recovery.json`: in the packaged
alpha the readiness check and stream recovery would read no config (recovery reason `config`, streams not
restarted). Both are now listed, with `data/live/test-kit.json` and `tools/collect-stream-feedback.mjs` (imported by
the UI server).

## UNVERIFIED / open

- The Streamer.bot action name and its Speaker.bot step on the laptop (section 2).
- Banner H/V captures from the real host (BM3).
- The auto-collection on a real stream: event-core.db written by the real event core during a live stream (the
  table and columns match the BM5 tests; real chat never used in tests).
- The look of the Qt strip on a real display (only the headless probe ran).

## Proposed decision D305

D305 (proposed 2026-11-09): Live test kit behind flag `live-test-kit` (off). Ujwalam does not speak, post or
trigger Streamer.bot actions for a test stream; the user's own Streamer.bot action (name and texts in
`data/live/test-kit.json`) posts the feedback question and has Speaker.bot read the announcement, and Ujwalam only
reminds the user to start it for the first minutes after going live. When a stream ends, the studio UI server
collects the viewers' replies read-only from `event-core.db` into `feedback/YYYY-MM-DD-stream-feedback.md`
(gitignored). The status snapshot carries plain-words `alerts` (stream recovery, sound problems, the reminder, the
feedback result), shown as a strip in the Qt studio window and as a pill on the control page. A write path into
Streamer.bot or Speaker.bot stays BM8 (P15, ADR and security review).

## Files changed

- New: `data/live/test-kit.json`, `services/studio-ui/live-test-kit.mjs`, `tests/live-test-kit.test.mjs`,
  `tests/studio-qt-alerts.test.mjs`, this file.
- Changed: `data/flags.json`, `services/studio-ui/server.mjs`, `tools/collect-stream-feedback.mjs`,
  `tools/package/manifest.mjs`, `ui/index.html`, `ui/js/app.js`, `app/studio/src/main_window.cpp`,
  `app/studio/src/main_window.h`.
