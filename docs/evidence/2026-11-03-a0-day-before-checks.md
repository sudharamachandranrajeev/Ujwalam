# A0 first real stream: day-before checks run early (2026-11-03)

Steps from `docs/tests/2026-11-05-A0-first-real-stream.md` "The day before" that need no stream and no platform contact, run on the laptop by the agent. Repeat steps 1-3 on the day before; the results below can go stale.

| Step | Result | Evidence |
|---|---|---|
| 1 Disk | PASS | recordings folder on C:, 469.4 GB free (needs about 3 x 7.5 GB per hour) |
| 3 Keys | PASS | `credential status` prints `credential: set` for `youtube-h`, `youtube-v`, `twitch`, `twitch-server`, `kick`, `kick-server`. The Twitch key carries no `?` query (new check in `credential status`, never prints the value) |
| 6 Dry run, banner | PASS | `docs/evidence/2026-11-03-bot-manager-bm3-test-broadcast.md` (H/V capture, after the overlay root fix D200) |
| 7 Bots, clash check | PASS (machine part) | `node tools/bot-clash-check.mjs`: exit 0, `CLASHES: none`; Streamer.bot has no hotkeys defined. Manual items (Speaker.bot audio captured twice, one alert per event) stay for the user |
| 8 Streamer.bot action | OPEN | the user deferred it; the action exists with the three chat steps; the Speaker.bot step and the timer are still to add |
| 9 Chat reaches Ujwalam | PARTLY | studio started without `--mock` and without `--live` while the real Streamer.bot ran: the event core printed `[serve] info: connected` (no "mock Streamer.bot"), 0 sinks, nothing sent. No chat message was seen: nobody was chatting. Seeing a real message in the chat list stays for the dry run |

Also checked the same day: bot start, stop and stop on studio stop with the real bots (`docs/evidence/2026-11-03-bot-manager-bm1-bm2-bm6.md`). Streamer.bot is force-closed after 10 s on every stop; the Stop confirmation now warns about it (BM1b).

## Files
Created: this file. Changed: `services/event-core/cli.mjs`, `tests/event-core-streamerbot-credential.test.mjs`, `docs/tests/2026-11-05-A0-first-real-stream.md`.
