# 2026-11-13 — Ujwalam posting work that Vani can reuse later

Source: the user's messages on 2026-11-13: "drop the vani plan for now" and "don't use any vani ideas here. ideas from
here can be later used for vani. don't add anything from vani to ujwalam". So: no Vani integration, and nothing from
Vani is added to Ujwalam. Posting stays in Ujwalam (local upload straight to YouTube, `publishAt` scheduling, tokens in
Windows Credential Manager). This file only lists Ujwalam work a later Vani session may port.

## Ujwalam modules worth reusing in Vani later (keep them self-contained)

- `services/posting/schedule.mjs`: slot math in UTC, gap-filling around a channel's existing scheduled posts, never two
  posts within the gap, retry close to the time, cap on how far ahead.
- `services/posting/schedule-read.mjs`: reading a big channel's scheduled posts with a lookback stop instead of a
  page cap that fails closed.
- `services/posting/youtube.mjs`: resumable upload with `status.publishAt` (YouTube shows it as "Scheduled"), per-chunk
  deadline before the slot, quota-aware pacing.
- `services/analytics/`: YouTube Analytics scopes, 24 h / 7 d checkpoints, local store.
- `services/learning/mix.mjs`: Thompson sampling over post choices within approved limits, with logged, undoable
  weekly changes.
- Delete-after-upload safety rules (only after YouTube reports `processed`; exact file by hash and path; never outside
  the clips folder).

Keep the posting logic in `services/posting` with the studio-ui routes as a thin layer, so a later port copies logic,
not UI glue.
