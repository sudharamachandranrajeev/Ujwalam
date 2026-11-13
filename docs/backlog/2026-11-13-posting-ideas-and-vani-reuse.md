# 2026-11-13 — Posting: ideas taken from Vani, and Ujwalam work Vani can reuse later

Source: the user's message on 2026-11-13: "drop the vani plan for now ... incorporate any beneficial research done
here that can [be] repurposed ... for vani and it can be repurposed later". No Vani integration is planned. Posting
stays in Ujwalam (local upload straight to YouTube, `publishAt` scheduling, tokens in Windows Credential Manager).

Vani (sibling repo, social media manager; Flutter client + a Cloudflare Worker hub) was read on 2026-11-13, read only.
Its working tree was damaged at that time (missing git object, about 51 deleted files); nothing in it was changed.

## Ideas from Vani worth building into Ujwalam's posting (backlog, each behind a flag, none approved yet)

| Idea | In Vani | For Ujwalam | Needs |
|---|---|---|---|
| Posting calendar, month and week views, drag a post to another day to reschedule | Calendar screen | Qt view of the upload queue and the channel's scheduled posts; a drag changes the slot (queued items: local; uploaded items: `videos.update status.publishAt`) | nothing new; builds on the editable schedule (D375) |
| Failed posts listed with a retry button | Calendar | Queue items in `failed` shown with the reason and a one-click retry | none |
| Best times to post | Analytics | From AN1 numbers per posting hour; feeds RP5's posting-time band (learned, reported; applying it to the schedule needs the user's yes) | real AN1 data |
| First comment on a YouTube upload | Composer | Optional pinned first comment per kind (e.g. channel links) | `youtube.force-ssl` scope: a wider permission, ask the user first |
| Live character counts per platform | Composer | Title/description length checks already come from `data/platforms/*.json`; show the counts in the post editor | none |
| Recycle evergreen posts | Composer/queue | Not for YouTube (no re-uploads of the same video); maybe later for other platforms | user decision |
| Workspaces (one profile per brand/channel) | Profiles | Only if the user runs more than one channel | user decision |

## Ujwalam work that Vani can reuse later (keep these modules self-contained)

- `services/posting/schedule.mjs`: slot math in UTC, gap-filling around a channel's existing scheduled posts, never two
  posts within the gap, retry close to the time, cap on how far ahead.
- `services/posting/schedule-read.mjs`: reading a big channel's scheduled posts with a lookback stop instead of a
  page cap that fails closed.
- `services/posting/youtube.mjs`: resumable upload with `status.publishAt` (YouTube shows it as "Scheduled"), per-chunk
  deadline before the slot, quota-aware pacing. Vani's hub uploads at the posting time as public, so YouTube cannot
  see its schedule in advance; switching it to `publishAt` would let both apps see each other's posts.
- `services/analytics/`: YouTube Analytics scopes, 24 h / 7 d checkpoints, local store.
- `services/learning/mix.mjs`: Thompson sampling over post choices within approved limits, with logged, undoable
  weekly changes.
- Delete-after-upload safety rules (only after YouTube reports `processed`; exact file by hash and path; never outside
  the clips folder).

Keep the posting logic in `services/posting` with the studio-ui routes as a thin layer, so a later port (to Vani's
TypeScript hub, for example) copies logic, not UI glue.
