# 2026-10-27 — P2a A3: chat and engage-log alignment to clip sessions

**Result: PASS. All three sources are aligned and the coverage is reported.** Chat is very sparse in every session. The clip name time (END) cannot be checked from chat, so that check is NOT MEASURABLE. The PC clock was measured against the platform clocks instead (section 4).

The repo holds aggregates only. Per-event data (no text, no names, no author ids) and the downloaded chat stay in `C:\AI\Claude\_data\Ujwalam\chat\`. Nothing was installed. The corpus was not opened; only the existing `index.json` was read. The engage logs were read in place, read-only. Only these fields were used: `t`, `kind`, `platform`, `action`, `reason` (a program code) and `outputs`. Meld prefs and stream keys were not read.

## Tool

`services/clip/chat_align.py` (stdlib only, `python -I`; every path is an argument). It refuses an `--out` folder inside the repository.

- Sessions and clips come from `index.json` (`session_index.py`, `nameTime: end`). An event is placed in the clip whose trimmed range `[start + trimIn, start + duration)` contains it. Each event gets `clipTimeSec`, and `cacheTimeSec` on the A2b cache timeline.
- Twitch: event time = `video.created_at + content_offset_seconds`. Role `owner` when the commenter id equals the streamer id; otherwise `viewer`.
- YouTube: event time = `timestampUsec` (server time). Renderers counted: text, paid, sticker and membership; engagement notices are ignored. Role: `owner` (channel id or OWNER badge), `moderator` (MODERATOR badge) or `viewer`. H or V comes from `width`/`height` in `.info.json`.
- Engage: a `message` with reason `self-echo` or `bot` counts as `bot-self`; reason `duplicate` counts as `duplicate`. Every other message counts as `viewer`. `sent` records are counted too.
- Outputs: `events.jsonl` (source, platform, utc, type, role, session, clip, clipTimeSec, cacheTimeSec) and `summary.json`.

## Commands

```
# YouTube VOD list (public metadata). The channel is the YouTube handle in
# legacy/brand/brand.config.js (socials, youtube); it resolved to <youtube-channel-id>
# (channels.youtube_channel_id in the gitignored data/profile.local.json).
yt-dlp --ignore-config --flat-playlist -J "https://www.youtube.com/channel/<youtube-channel-id>/streams"
yt-dlp --ignore-config --skip-download --playlist-items 1-70 \
  --print "%(id)s|%(release_timestamp)s|%(timestamp)s|%(duration)s|%(live_status)s|%(width)sx%(height)s|%(was_live)s" <same URL>

# Live-chat replay for the 36 VODs from 2026-09-24 onward (no login, no cookies)
yt-dlp --ignore-config --skip-download --write-subs --sub-langs live_chat --no-write-auto-subs \
  -a ids.txt --write-info-json -o "C:/AI/Claude/_data/Ujwalam/chat/youtube/yt-%(release_date)s-%(id)s.%(ext)s"

# Alignment
python -I services/clip/chat_align.py --index C:/AI/Claude/_data/Ujwalam/index/index.json \
  --out C:/AI/Claude/_data/Ujwalam/chat/aligned \
  --twitch-dir C:/AI/Claude/_data/Ujwalam/chat/twitch \
  --youtube-dir C:/AI/Claude/_data/Ujwalam/chat/youtube \
  --engage-dir "C:/AI/Claude/Meld Schenanigans/engage/logs"
```

yt-dlp 2026.10.21 was already installed (WinGet). Both yt-dlp runs exited 0, and the download log has 0 error lines.

## 1. Sources

| Source | Files | Events | In a session |
|---|---|---|---|
| Twitch VOD chat (A0) | 22 VODs | 73 comments | 72 |
| YouTube live-chat replay | 36 VODs (18 dates × H + V) | 403 chat items | 399 |
| Engage logs (`message` + `sent`) | 12 day files | 400 | 400 |

- YouTube listing: the streams tab has 1,052 entries. From 2026-09-24 there are 2 VODs per stream (H 1920x1080 and V 1080x1920). `release_timestamp` matches the Twitch `video.created_at` of the same stream to within seconds, for example 3–4 s on 10-20 and 6 s on 10-22. This confirms the channel.
- YouTube VODs with an empty replay (only the engagement notice): 10-01 (H and V), 10-13 V, and 10-22 (H and V).
- Role totals, sessions only:
  - Twitch: 13 viewer and 59 owner. On Twitch the bot is the broadcaster account.
  - YouTube: 163 viewer and 236 moderator/owner. There are 0 owner messages. The moderator messages are mostly the bot account (UNVERIFIED: real moderators would also be counted here).
  - Engage: 203 "viewer" messages, 45 replies and 36 `sent`.

## 2. Per-session coverage and counts

- Span: wall clock from the first clip start to the last clip end.
- Overlap: the share of the span covered by a listed VOD.
- msg/min: viewer messages per span minute.
- Platform columns count viewer-role messages only.
- Bins: 5-minute bins of the span that hold at least one viewer message from any source.

| Session | Clips | Span min | TW ovl % | YT H/V ovl % | TW viewer | YT viewer (H/V) | YT mod | Engage viewer (TW/YT, outside VODs) | Platform msg/min | Engage msg/min | Bins with chat |
|---|---|---|---|---|---|---|---|---|---|---|---|
| s-2026-09-24-1830 | 142 | 71.3 | 87.2 | 87.2/87.3 | 0 | 8 (2/6) | 0 | — (no log) | 0.112 | — | 3/15 |
| s-2026-09-25-1852 | 243 | 121.9 | 79.0 | 79.2/79.1 | 0 | 3 (2/1) | 0 | — | 0.025 | — | 2/25 |
| s-2026-09-26-1554 | 481 | 241.6 | 77.7 | 77.8/77.8 | 0 | 8 (8/0) | 59 | — | 0.033 | — | 3/49 |
| s-2026-09-27-1051 | 679 | 341.1 | 65.1 | 65.2/65.2 | 0 | 33 (9/24) | 43 | — | 0.097 | — | 7/69 |
| s-2026-09-27-1753 | 242 | 123.5 | 39.5 | 39.5/39.5 | 0 | 23 (0/23) | 5 | — | 0.186 | — | 8/25 |
| s-2026-09-28-1829 | 649 | 326.0 | 40.0 | 40.1/40.1 | 0 | 6 (2/4) | 26 | 32 (30/2, 32) | 0.018 | 0.098 | 16/66 |
| s-2026-09-29-2001 | 122 | 61.6 | 78.9 | 84.9/82.3 | 0 | 6 (0/6) | 2 | 9 (2/7, 2) | 0.097 | 0.146 | 5/13 |
| s-2026-09-30-1743 | 213 | 107.0 | 93.0 | 93.1/93.1 | 0 | 4 (1/3) | 18 | 19 (2/17, 2) | 0.037 | 0.178 | 7/22 |
| s-2026-10-01-1944 | 99 | 49.5 | 93.3 | 93.2/93.2 | 0 | 0 | 0 | 4 (4/0, 4) | 0.000 | 0.081 | 1/10 |
| s-2026-10-13-2000 | 125 | 62.6 | 87.7 | 87.9/87.9 | 1 | 1 (1/0) | 0 | — | 0.032 | — | 2/13 |
| s-2026-10-14-1949 | 178 | 89.4 | 70.4 | 70.9/70.9 | 0 | 5 (2/3) | 12 | 13 (5/8, 2) | 0.056 | 0.145 | 4/18 |
| s-2026-10-15-2014 | 134 | 67.3 | 99.6 | 99.7/99.7 | 0 | 2 (2/0) | 6 | 7 (2/5, 0) | 0.030 | 0.104 | 2/14 |
| s-2026-10-16-1953 | 207 | 103.8 | 91.0 | 90.8/90.9 | 0 | 3 (2/1) | 0 | 5 (2/3, 2) | 0.029 | 0.048 | 3/21 |
| s-2026-10-17-1656 | 456 | 229.0 | 41.0 | 41.0/41.0 | 0 | 2 (2/0) | 11 | — (no log) | 0.009 | — | 2/46 |
| **s-2026-10-18-1221** (labelled) | 761 | 382.7 | 92.6 | 98.5/98.5 | 0 | 20 (17/3) | 28 | 36 (2/34, 3) | 0.052 | 0.094 | 11/77 |
| **s-2026-10-20-1214** (labelled) | 864 | 433.9 | 34.8 | 34.8/34.8 | 0 | 39 (20/19) | 24 | 54 (10/44, 5) | 0.090 | 0.124 | 19/87 |
| s-2026-10-21-1916 | 176 | 88.1 | 90.2 | 90.3/90.3 | 12 | 0 | 2 | 22 (21/1, 8) | 0.136 | 0.250 | 4/18 |
| s-2026-10-22-2002 | 152 | 76.1 | 92.1 | 92.2/92.2 | 0 | 0 | 0 | 2 (2/0, 2) | 0.000 | 0.026 | 1/16 |

In-clip counts (events that fall inside a trimmed clip range, not in a gap): equal to the span counts except Twitch 10-21 (11 of 12) and engage 10-20 (52 of 54).

Findings:

1. **Chat is too sparse to be a strong clip signal.** Platform viewer chat is never above 0.19 messages/min. Across all 18 sessions there are 176 platform viewer messages (13 Twitch, 163 YouTube) for about 49 h of clips. The best session has chat in 19 of 87 five-minute bins. The A2 plan's "beats chat-only baseline" test will be against a near-empty baseline. That needs a user decision (below).
2. **Engage "viewer" counts include the user's own test messages** (UNVERIFIED as to which ones). 62 of 203 arrived while no listed VOD of that platform was running. On 28 Sep all 32 did, consistent with the Twitch test messages described in `legacy/engage/server.mjs`. On Twitch the bot and the broadcaster share one account, so a message the user typed is not marked self-echo.
3. **The labelled session s-2026-10-20-1214 has a stream for only its last 34.8 %.** The VODs (Twitch, YouTube H and V) start 16,312–16,315 s (about 4 h 32 min) after the first clip. Engage was running for 421.5 min of the session but logged only 5 viewer messages outside the VODs. Either the first 4.5 h were not live, or that broadcast is not in either VOD list. UNVERIFIED; the user should say.
4. **Clipping starts before going live.** First VOD start minus session start is +16.6 s to +16,315 s in 17 sessions. On 10-17 it is −5.6 s (Twitch) and −8.6 s (YouTube). The stream start is therefore not an anchor for clip time.
5. YouTube on 10-18: 20 viewer messages in the replay against 34 in engage. The cause is UNVERIFIED: replay items deleted or held, extra broadcasts, or the user's own messages.

## 3. Twitch and YouTube times against their own server stamps

| Check | n | min | median | max |
|---|---|---|---|---|
| Twitch comment `created_at` − (`video.created_at` + offset) | 73 | +0.714 s | +1.257 s | +2.074 s |
| YouTube `timestampUsec` − (`release_timestamp` + `videoOffsetTimeMsec`) | 403 | −8.848 s | −4.294 s | +71.255 s |

Twitch VOD-offset times are 0.7–2.1 s earlier than the posting time (offsets are whole seconds). YouTube's video offset is not reliable as an absolute time, so the tool uses `timestampUsec`.

## 4. Name time = clip END: can chat check it?

**Not measurable from chat.** Clips are back-to-back slices of about 30 s from a rolling buffer, so a clip boundary is not an event. Nothing in chat is tied to it, and a chat burst near a boundary would be coincidence. No chat event has a known position inside the clip content. The stream start is not one either (finding 4). The END result therefore rests on the A2b audio measurement.

What can be measured is the PC clock, which names the clips and stamps the engage log (same machine; UNVERIFIED but very likely), against the platform clocks. Engage receive times are matched to platform post times. A pair is used only when each side is the other's only candidate within [−5 s, +20 s].

- inbound = engage receive − platform post = latency + offset. This gives offset ≤ min(inbound).
- outbound = bot reply post − engage receive of the message it answers. This gives offset ≥ −min(outbound).
- The engage `sent` record is written after the Streamer.bot call returns (`legacy/engage/server.mjs` `deliver`), so it is not used.

| Platform | inbound n / min / median | outbound n / min / median | offset bounds (PC − platform) |
|---|---|---|---|
| YouTube | 57 / 1.084 / 1.686 s | 14 / −1.110 / +0.292 s | lower 1.110, upper 1.084: they cross by 0.026 s |
| Twitch | 9 / 0.234 / 1.456 s | 2 / −0.881 / −0.870 s | lower 0.881, upper 0.234: inconsistent (one inbound pair at 0.234; the other 8 are ≥ 1.44) |

**Measured offset: the PC clock is about +1.1 s ahead of YouTube server time.** The YouTube bounds meet at 1.08–1.11 s. The Twitch data fit the same value except for one inbound pair, which is probably a mismatch. All of this is UNVERIFIED: it assumes near-zero minimum latency, and the outbound pairs may include Streamer.bot's own posts. On the clip timeline, a YouTube message lands about 1.1 s early and a Twitch message (VOD-offset time) about 2.4 s early. This is small next to chat reaction lag, so no correction is applied. The window choice moves the counts but not the bounds: with 10, 20 or 30 s the YouTube bounds are 1.110 / 1.084, and with 60 s they are 1.110 / 1.266.

## 5. Third labelled session: recommendation

Candidates that have both an engage log and clips: 28 Sep, 14 Oct, 16 Oct, 21 Oct, 22 Oct.

| Candidate | Clips | Platform viewer msgs | Engage viewer (outside VODs) | Bins | VOD overlap |
|---|---|---|---|---|---|
| 28 Sep | 649 | 6 | 32 (32) | 16/66 | 40 % |
| 14 Oct | 178 | 5 | 13 (2) | 4/18 | 70 % |
| 16 Oct | 207 | 3 | 5 (2) | 3/21 | 91 % |
| **21 Oct** | 176 | 12 (Twitch) | 22 (8) | 4/18 | 90 % |
| 22 Oct | 152 | 0 | 2 (2) | 1/16 | 92 % |

**Recommendation: 21 Oct (s-2026-10-21-1916).**
- It has the highest chat rate of any session: 0.136 platform and 0.250 engage messages/min.
- It is the only session with Twitch viewer chat (12). 18 Oct and 20 Oct are almost all YouTube, so 21 Oct adds the Twitch path to the labelled set.
- It has an engage log and 90 % VOD coverage.
- 176 clips (88 min) are quick to label.
- Caveat: its chat is one burst. All 12 Twitch messages fall within 261 s, and only 4 of 18 bins hold chat.

Hold-out (≥ 2 sessions): 14 Oct and 30 Sep. Both have an engage log, YouTube viewer chat inside the VOD, and few messages outside the VODs. 30 Sep (19 engage, 7/22 bins) is not in the candidate list, but it is a better chat hold-out than 28 Sep, whose engage traffic is all outside the VODs. 28 Sep could be a third hold-out for clip volume (649 clips). 22 Oct has no usable chat.

## Tests

```
npm run test:py   ->  Ran 48 tests in 2.630s  OK
```

`tests/py/test_chat_align.py` has 10 tests on synthetic fixtures only:
- trimmed-range clip lookup, cache time and gaps
- per-session role counts and VOD overlap
- Twitch time = VOD start + offset
- clock deltas
- no text, author names or author ids in the outputs
- `--out` refused inside the repo
- the CLI requires a source
- unique matching rejects ambiguous candidates
- the offset bounds bracket a known synthetic offset

## UNVERIFIED / open

- That the engage PC and the Meld PC share one clock. They are very likely the same machine.
- The PC − platform offset of about +1.1 s (section 4).
- YouTube moderator messages are counted as bot; real moderators would land there.
- Engage "viewer" counts include the user's own test messages.
- The first 4.5 h of 20 Oct: live with no VOD, or not live (finding 3).
- Completeness of the YouTube replay (finding 5).
- Twitch VOD-offset time is 0.7–2.1 s before the posting time (section 3).

## Files created or changed

- `services/clip/chat_align.py` (new)
- `tests/py/test_chat_align.py` (new)
- `docs/evidence/2026-10-27-p2a-a3-chat-alignment.md` (this file)
- `package.json`: not changed. `test:py` discovers the new test.
- Outside the repo:
  - `C:\AI\Claude\_data\Ujwalam\chat\youtube\`: 36 `.live_chat.json` + 36 `.info.json`
  - `C:\AI\Claude\_data\Ujwalam\chat\aligned\`: `events.jsonl`, `summary.json`
  - `C:\AI\Claude\_data\Ujwalam\chat\align-stdout.txt`
