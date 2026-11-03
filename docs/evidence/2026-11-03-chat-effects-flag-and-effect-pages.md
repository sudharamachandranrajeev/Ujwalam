# Chat effects behind the flag, chat effect pages on guarded feeds (D204)

Date: 2026-11-03. Main session (Opus). Status: implemented and tested with loopback sockets and a fake clock. Not yet used on a real stream: a live feature is done only after a real stream with no high-severity feedback.

## Problem found

- Studio overlay layers for `chat-charge` and `chat-storm` were given the plain effects feed (`sbPath=/`). The page fires its effect on every chat message, so chat-driven plays bypassed the effect guards (budget, cooldown, region, flash limit). The guarded path `/effects/<name>` existed in the bridge (2026-10-30 evidence) but nothing pointed a page at it.
- The `chat-effects` flag (data/flags.json, off by default) was read by nothing.

## What changed

- `data/overlays/feed-scopes.json` (version 2): `effectPages` maps a folder to its effect name: `chat-charge` to `charge`, `chat-storm` to `storm`.
- `app/host/lib/project.mjs` `overlayUrls`: an effects-scope layer whose folder is in `effectPages` gets `sbPath=/effects/<name>`. Other folders are unchanged (`/` or `/display`).
- `services/overlay-server/index.mjs`: the gate refuses chat-source effects with reason `flag-off` while `chat-effects` is off. The cam-pop rule fires only while it is on. The flag is read on every decision, so a flip on the control page acts at once, also while live. No flags object (the standalone `cli.mjs`) means off. Non-chat sources (API, test buttons) skip the flag; the guards decide. Queued plays already admitted are still released.
- `services/overlay-server/cli.mjs`: header note that chat effects stay off there.

## Tests

Command (worktree, headless):

```
node --test tests/effect-guards.test.mjs tests/overlay-server.test.mjs tests/studio-ui-alpha.test.mjs
ℹ pass 71
ℹ fail 0
node --test tests/effect-guards.test.mjs
ℹ pass 31
ℹ fail 0
node tools/lint.mjs
lint: 0 finding(s), 30 allow marker(s)
```

- `tests/effect-guards.test.mjs`, "publishEffect goes through the guards ...": with the flag on, chat reaches `/effects/charge` as before. Flag off: the next chat message reaches the plain feed but not `/effects/charge`; `publishEffect('charge', {source:'chat'})` gives `{ ok: false, reason: 'flag-off' }`; an API-source play is not refused for the flag. Flag back on: the next chat message reaches `/effects/charge` again, with no restart.
- Same file, "the cam-pop rule fires only while chat-effects is on ...": a voice spike with the flag off admits nothing; with it on, the guards admit one pop. A server built without flags refuses chat-source effects with `flag-off`.
- `tests/overlay-server.test.mjs`: `feedQuery(port, 'effects', 'charge')` gives `sbPath=/effects/charge`, and a bad name is refused. Every `effectPages` name exists in `data/effects/guards.json` and no effect folder is a display folder. `overlayUrls` gives `/effects/charge` for chat-charge, `/display` for chat-list and `/` for another effects folder.

## Open

- Not tested on a real stream. For the first stream, `chat-effects` must be switched on from the control page if chat effects are wanted; it is off by default.
- Cam-pop mic level feed is not wired to the rule (open from the earlier explore). Voice-spike pops cannot happen in the studio yet.
- The guard numbers in `data/effects/guards.json` marked `unverified` (D76 to D83) still need the user's confirmation.
- Measured flash rate (`reportMeasuredFlashes`) is still not called by the host.
