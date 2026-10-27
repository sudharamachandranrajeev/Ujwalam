# 2026-10-27 — P2a A0: Twitch VOD chat download

## Tool

TwitchDownloaderCLI 1.56.5, from the official GitHub release (`lay295/TwitchDownloader`). The zip SHA-256 `8b1b0695f2b1b6bf0d2535fab4b84032951cded8cf4078dfdf4d58e391c813a0` matches the release digest. Extracted to `C:\AI\Claude\_vendor\TwitchDownloaderCLI-1.56.5\`, no installer; recorded in `_vendor\MANIFEST.md`. The exe is not Authenticode-signed.

## VOD list

- Channel: the user's Twitch channel, `<twitch-channel>` (`channels.twitch` in the gitignored `data/profile.local.json`). The name comes from `legacy/spark/comic-pop.html`.
- Listing (metadata only): `yt-dlp --flat-playlist -J "https://www.twitch.tv/<twitch-channel>/videos?filter=archives&sort=time"`. It returned 33 past broadcasts, 2026-09-09 to 2026-10-22.
- Start times came from the thumbnail path timestamp, then were checked against `video.created_at` in the downloaded JSON (stored in UTC; the thumbnail time is local BST, 1 h ahead).
- Retention: the oldest VOD is 48 days old, so retention is longer than 7 days. Nothing was expiring on 2026-10-27. The exact retention period is UNVERIFIED.

## Download

Command, for each VOD from 2026-09-24 onward (the corpus range):

```
TwitchDownloaderCLI.exe chatdownload --id <vod-id> -o C:\AI\Claude\_data\Ujwalam\chat\twitch\twitch-<date>-<vod-id>.json --collision Overwrite
```

- Result: 22 VODs, all exit 0, 22 JSON files, 0.08 MB in total. Stored outside the repo (viewer data, never committed). They can move into the analysis-cache folder once it is chosen (A2).
- Comment counts only (the comment text was not read or shown):

| VOD start (local) | Comments |
|---|---|
| 09-24, 09-25 | 0, 0 |
| 09-26 | 21 |
| 09-27 (two VODs) | 18, 3 |
| 09-28, 09-29 (5 VODs), 09-30, 10-01 | 0 each |
| 10-13, 10-14, 10-15 | 1, 5, 2 |
| 10-16 | 0 |
| 10-17 | 2 |
| 10-18 | 0 |
| 10-20 | 6 |
| 10-21 | 15 |
| 10-22 | 0 |

Total: 73 comments across 22 VODs.

## Findings

1. **Twitch chat is too sparse to be a clip signal on its own.** The two planned labelled sessions have 0 comments (18 Oct) and 6 comments (20 Oct). Chat signal must come mainly from YouTube chat replay and the engage logs (A3). Whether any source has enough chat for the "beats chat-only baseline" test is decided at A3.
2. **The Twitch VODs are shorter than the Meld sessions** on some days (20 Oct: 151 min VOD vs a 7 h 13 min clip session). The Twitch push may not have run for the whole session. Alignment uses `created_at` plus the VOD length, and A3 reports the overlap per session.
