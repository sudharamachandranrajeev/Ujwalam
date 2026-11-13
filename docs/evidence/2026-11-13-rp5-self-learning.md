# RP5 / AN2 self-learning within limits - evidence (2026-11-13)

Plan: `docs/plan/2026-11-12-reel-polish-music-learning.md` (RP5), `docs/plan/2026-11-11-growth-content-instagram-plan.md`
(AN2). Decisions D364 (auto within limits, user) and D373 (this build, proposed). Builds on AN1a/AN1b (D371, D372).

Status: **built behind flag `self-learning` (off by default; its API also needs `growth`); tested with faked analytics
numbers only.** No real YouTube numbers exist yet (the user's Google setup is pending), so the reward on real videos,
the cold-start threshold and the size of real weekly moves are UNVERIFIED.

## What was built

- `data/clip/learning-mix.json`: limits (minShare 0.10, maxStepPoints 15, periodDays 7, what is never changed), cold
  start (minVideos 8, minPerDimension 4), reward weights and cap, bandit prior and draws, the six dimensions with their
  arms, defaults and where each applies. Data, not code.
- `services/learning/mix.mjs`: linking (analytics summary rows joined to posts by post id), reward, seeded Thompson
  sampling (mulberry32 + Marsaglia-Tsang gamma), `limitShares` (floor + weekly cap, sum 1), `step` (once per 7 days;
  cold start writes nothing), `undo` (newest change still in effect), `view`, `weeklyReport`, `appliedKindShares`.
  Writes only `<data>/learning/mix.json` and `<data>/learning/mix-log.jsonl` (app data; also gitignored by name).
- `services/learning/mix-cli.mjs`: `show [--json] | step | undo | report` (exit 3 with the flag off).
- Linking record: `services/clip/clip_publish.py` writes `choices` {transition, title, music, mixAt?} on each reel row of
  `uploads.json` (from the render record: what the reel really used); `services/posting/index.mjs` `cleanChoices` copies
  it into `post.json` `source.choices`; the post view exposes `choices`.
- Planner: `services/clip/learning_mix.py` + `clipper.py montage`: with a mix in use, per reel transition/title/music
  drawn from the shares (seeded; only ever switched off, never on), one montage length band per run inside the user's
  limits; `render.json` gets `learningMix` and per-reel `learning`. Without a mix: the same objects are returned
  (`is` checks in the tests), so the plan is unchanged.
- Auto-post: `mixOrder` + `planAuto({ kindShares })`; `auto-chain.mjs` and `posting/cli.mjs auto` pass the kind shares
  only with the flag on and a mix in use. Only the order inside each rule's daily cap changes.
- Studio UI (`services/studio-ui/server.mjs`), session + CSRF like the Growth routes:
  - `GET /ui/api/growth/mix` -> mix in use, status (`cold-start` | `waiting-for-weekly-change` | `learning`), reason,
    numbers, log (last 20), `canUndo`, `report` text.
  - `POST /ui/api/growth/mix/undo` `{}` -> 200 with the new view, 409 `nothing-to-undo`, 400 `bad-params`.
  - Both 404 `growth-off` / `self-learning-off` when a flag is off. The weekly `step` runs after a successful
    `POST /ui/api/growth/refresh` (result in `mix`).
- `data/flags.json`: `self-learning` (page posting, off).
- `tools/package/manifest.mjs`: ships `data/clip/learning-mix.json` (services/learning was already in REPO_DIRS; no new
  services directory).

## Commands and results

    node --test --test-reporter=spec tests/learning-mix.test.mjs
    ... tests 19, pass 19, fail 0   (first commit)
    ... tests 26, pass 26, fail 0   (after the Codex review fixes: floor + cap together or null, incl. a 2000-case
        seeded property check; a cut-off log record dropped and not merged; failed state write logs nothing; failed undo
        keeps history; failed append repaired from the state; undo restores the earlier changedAt; tail-only log read)

    python -I -m unittest discover -s tests/py -t tests/py -p "test_learning_mix.py"
    ... Ran 9 tests, OK

    python -I -m unittest discover -s tests/py -t tests/py
    ... Ran 665 tests, OK (skipped=53)

    node --test (analytics, flags, learning-*, package-alpha, posting*, studio-qt-growth, studio-ui-growth,
                 studio-ui-posting*, studio-ui-flags-feedback, studio-ui-server)
    ... tests 340, pass 336, fail 1, skipped 3: package-alpha 'repo file set' (data/clip/learning-mix.json not in the
        package); fixed by adding it to tools/package/manifest.mjs REPO_FILES, then package-alpha: tests 19, pass 16,
        fail 0, skipped 3 (need a built studio / OBS runtime)

    npm run lint
    ... lint: 0 finding(s)

Covered: reward formula values and per-checkpoint median; same seed -> same targets; better arm higher win probability;
15-point cap and 10 % floor (incl. lifting a share below the floor); cold start (nothing written, reason text, mix not
applied); a change logged with its numbers and inside the limits; once a week (too-soon); two undos back to today's
defaults (applied false); a dimension with too few known choices keeps its shares; auto-post plan identical with
kindShares null, order only with a mix; CLI flag gate, step/report/undo; API flag gates, 401 without session, 403
without CSRF, 409 nothing to undo, undo after a change. Python: flag off / cold / bad file -> no mix; plan unchanged
without a mix; seeded picks near the 10 % share; a feature that is off never turned on; length band inside the user's
limits; publish writes `choices`.

Not run (main session runs after merge): full `npm run ci`, GPU tests.

## UNVERIFIED

- Reward and shares on real YouTube numbers (no Google setup yet); `viewedPctCap` 150 and `minVideos` 8 are agent values.
- A real montage run with the flag on (planner path tested by unit tests only; no render was made here).
- Posting time is learned and reported only; it is not applied to the schedule.
- The Growth window's one-click undo button is not built (API ready; main session wires the Qt button).
