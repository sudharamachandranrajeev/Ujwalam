# Reel and montage feature research

Date: 2026-11-11
Scope: public web sources only. No personal, channel or brand names used. Research notes, not a decision. Nothing here is applied until the user approves it.

Evidence grades used below:
- strong = platform docs or a large named dataset, or several independent sources agree
- medium = several creator-tool sources agree, no primary data seen
- weak = one source, vendor marketing, or opinion

Honest limit: most "what works" claims come from editing-tool vendor blogs that quote studies second-hand. No independent study on mobile FPS kill montages specifically was found. Everything else is marked UNVERIFIED where it could not be confirmed.

## Recommended features for Ujwalam, ranked

| # | Feature | Why | Evidence |
|---|---------|-----|----------|
| 1 | Open on the payoff (best kill or the moment before it in the first 1-3 s), cut setup and walking | Platforms measure the swipe decision early. YouTube reports "viewed vs swiped away"; Instagram reports `reels_skip_rate` (skips in first 3 s). Every source says hook first | strong that early retention matters (platform metrics); medium on tactics |
| 2 | Hook-quality score in the clip ranker (action in frame 0, no black or menu frames, motion already running) | Cheap to compute from frames; directly tied to the two skip metrics above | medium |
| 3 | Auto captions, large, 1-2 words per beat, safe zone, with outline | Many viewers watch muted; game audio is muted first. Style details are opinion, the need is consistent | medium |
| 4 | Vertical 9:16 reframe that follows the action (kill feed, crosshair, scoreboard kept in frame) | Both platforms are vertical-first; Instagram crops non-9:16 Live to vertical too | strong (format), medium (tracking value) |
| 5 | Loop-friendly endings (last frame matches first frame, or cut at the peak) and 15-45 s default length | YouTube counts a view on start and replay since 2025-03-31; Instagram ranks watch time. Length bands are rule of thumb | medium |
| 6 | Kill counter / streak overlay (data-driven from the existing detector) | Fits the "streak-only" clip style; creator tools list it. No data on reach lift | weak to medium |
| 7 | Beat-synced cuts with a music bed (onset detection on a licensed or user-supplied track) | Common in montage tools; no controlled evidence for reach | weak |
| 8 | Punch-in zoom and short speed ramp on the kill frame | Standard montage grammar; no measured effect found | weak |
| 9 | Cover/thumbnail picker (best frame plus a few words) for long videos and Reels cover | Thumbnails matter for long videos (click-through); Shorts feed ignores covers mostly | medium (long), weak (Shorts) |
| 10 | Title and hashtag suggestions (local model, redacted) | Low risk helper. Hashtag lift is weak; YouTube and Instagram both say they mainly use content signals | weak |
| 11 | Posting-time hints from the user's own analytics (not a global table) | Global "best time" tables disagree; own data is better | medium (own data), weak (global tables) |
| 12 | Own-content analytics pull (YouTube, Instagram) feeding the clip ranker | Closes the loop; free APIs exist (see section 4) | strong (API exists), medium (benefit) |
| 13 | Instagram Live output (manual key paste, 9:16 rung) | Works today without any API; see section 3 | strong (it works), but low priority vs. above |

## 1. Editing features and what the evidence says

| Topic | Finding | Source type | Grade |
|-------|---------|-------------|-------|
| Hook, first 1-3 s | Open on the payoff or tension, not setup. Cut walking and menus. Start with motion already running | Several editing-tool blogs agree | medium |
| Early retention numbers | Vendors quote 70-90% retained at 3 s for healthy Shorts, and conflict. No official YouTube threshold exists. Use your own median | Vendor blogs | weak |
| Swipe metrics (platform) | YouTube Studio: "viewed vs swiped away". Instagram API: `reels_skip_rate` = share of initial views skipped within 3 s (marked estimated, in development) | Platform docs | strong |
| Captions | Large, high contrast (white with dark outline), 1-2 words per beat, keep inside safe zone, highlight the stressed word. Many views are muted. The "80% caption completion" and "19% retention lift" figures are second-hand, UNVERIFIED | Vendor blogs | medium (need), weak (numbers) |
| Beat-synced cuts, zooms, speed ramps | Widely recommended by clip and editing tools. No controlled study found for gaming reach. Treat as style, make them presets the user can tune | Vendor blogs | weak |
| Kill counter | Seen in creator and clip-tool feature lists. No reach data | Vendor pages | weak |
| Sound | Sound-off viewing is common, so captions carry the clip; a music bed and sound effects are a style choice. UNVERIFIED lift | Vendor blogs | weak |
| Length | YouTube Shorts max is 3 minutes since 2024-10-15. Vendor rule of thumb: 0-20 s aim 70-90% completion, 20-40 s 50-70%, 40-60 s 40-60%. One source claims 15-30 s Shorts have 25% higher engagement (cited from a 2023 study, not seen, UNVERIFIED). Another view: length is not penalised, early drop-off is | Platform news + vendor blogs | medium |
| Loopability | YouTube since 2025-03-31 counts a view on start and on replay; the old metric is now "engaged views" in Analytics. So loops raise raw views. Whether loops raise recommendation is UNVERIFIED | Trade press on YouTube announcement | medium |
| Instagram ranking | Instagram's head said in 2025-01 the top Reels signals are watch time, likes per reach, and sends per reach. Sends matter most for reaching non-followers. "3-5x weight" figures are blog claims, UNVERIFIED. Original content is favoured over reposts (the 40-60% figure is a blog estimate, UNVERIFIED) | Secondary write-ups of a platform statement | medium |
| Thumbnails/covers | Not studied for Shorts in the sources found. For long videos, thumbnail plus title drive click-through (general YouTube knowledge, no source fetched) | none fetched | weak |
| Titles, hashtags | No data-backed gaming-specific finding. Keep short, put the game and the moment in plain words. UNVERIFIED lift | none | weak |
| Posting times | Studies (Sprout about 307,000 profiles; Adobe 24,000 Shorts and 22,125 Reels; Buffer millions of posts) are cited only through blog summaries and disagree: Reels Mon-Tue afternoon; Shorts Friday 4-7 pm or Tue-Thu. Audience time zone matters more. Consistency matters more than slot | Secondary summaries of large datasets | weak to medium |
| Slow motion, kill montages | Nothing data-backed found. Gap | none | UNVERIFIED |

Source links:
- Shorts length and view counting: https://www.socialmediatoday.com/news/youtube-expands-3-minute-shorts-to-all-users/736967/ and https://ppc.land/youtube-changes-how-shorts-views-are-counted-from-march-31/ and YouTube help https://support.google.com/youtube/answer/10059070
- Shorts retention and swipe metric (vendor): https://www.shortimize.com/blog/youtube-shorts-retention-rate , https://vidiq.com/blog/post/youtube-shorts-algorithm/ , https://www.opus.pro/blog/ideal-youtube-shorts-length-format-retention
- 13.5M clip editing analysis (vendor, not read in full): https://www.opus.pro/blog/video-editing-tips
- Gaming shorts pattern (vendor): https://clip.dor.gg/en/blog/gaming-shorts-viral-pattern
- Reels signals: https://www.socialpilot.co/de/blog/instagram-reels-algorithm and https://buffer.com/resources/instagram-algorithms/
- Posting times: https://buffer.com/resources/best-time-to-post-social-media/ , https://postfa.st/blog/best-time-to-post-social-media-data-report

## 2. Features creators request from clip tools

No independent request tracker was found (Reddit and review sites not retrieved). The list below is what the tools themselves advertise and compare on, so it shows where the market is, not proven demand. Grade medium at best.

| Feature | Seen in | Note for Ujwalam |
|---------|---------|------------------|
| Auto-detect kills, aces, clutch from game events | Medal, Outplayed (per Medal's own comparison) | Ujwalam already has detectors and a streak-only style |
| Always-on replay buffer, save after the fact | Medal | libobs replay buffer already planned |
| Clip from a live stream automatically while playing | Eklipse (per its own pages) | Matches live path |
| Auto-reframe landscape to 9:16 | Eklipse, OpusClip, StreamLadder-type tools | Rank 4 |
| Auto captions, multi-language, style templates | OpusClip (vendor claims 95-97% on clean audio), Eklipse | Rank 3 |
| Virality / clip score | OpusClip. One review says it works better on talk content (80-85% usable) than gaming (about 60%), UNVERIFIED | Do a gaming-specific score from own data |
| Channel stickers, overlays, facecam layouts | Eklipse | Layout presets |
| Trim, effects, instant share link | Medal | Share link not needed (local-first) |
| Mobile editor | Eklipse | Out of scope |
| Local file only, no cloud lock-in | Outplayed is local; clips hosted online reportedly deleted after a year | Local-first is a selling point |
| Montage and highlight reel auto-assembly | Eklipse and similar | Matches match-reel goal |
| One-click publish to Shorts, Reels, other platforms | most | Post-alpha; needs API access |

Sources: https://medal.tv/compare/medal-vs-outplayed , https://eklipse.gg/compare/eklipse-vs-medal/ , https://www.twoaveragegamers.com/eklipse-vs-opusclip-head-to-head-for-gaming-streamers-2026/ . All vendor-written or vendor-quoting. CapCut auto-edit, Powder and StreamLadder pages were not retrieved: UNVERIFIED.

## 3. Instagram Live from a PC

| Fact | Detail | Source and date |
|------|--------|-----------------|
| Method | Instagram's web "Live Producer": on the web site, Add post, Live, enter title and audience, then the page shows a stream URL and stream key. Use it as "Custom RTMP" in OBS-type software | Instagram blog, published 2022-11-02 (old; re-check) |
| Access | Page said "limited access at this time" in 2022. Third parties (2026) say a Professional account (Creator or Business) is needed. Instagram's own page did not name account types | Instagram blog 2022-11-02; vendor guides 2026-01 and 2026-02. Account type UNVERIFIED from Instagram itself |
| Key changes per broadcast | Yes. "Not static, and will refresh each time you use Live Producer." Streamlabs says it resets every stream. One vendor says start soon after getting it because it can expire | Instagram blog 2022-11-02; Streamlabs support page |
| URL | RTMP/RTMPS URL shown with key. Exact scheme (rtmp vs rtmps) not confirmed in the page read. UNVERIFIED | - |
| Vertical | 9:16 recommended, not required. Horizontal streams are cropped and zoomed to vertical for viewers | Instagram blog 2022-11-02 |
| Resolution | Recommended 720x1280 at 30 fps. 480p and 360p supported, not advised. 60 fps accepted but preview shows 30. Vendors say 1080x1920; not confirmed by Instagram | Instagram blog 2022-11-02; vendor guides UNVERIFIED for 1080p |
| Bitrate | Video 2,250-6,000 kbps. Audio 44.1 kHz stereo up to 256 kbps | Instagram blog 2022-11-02 |
| Duration | Up to 4 hours (raised from 1 hour in 2020-10) | TechCrunch 2020-10-27; Instagram blog page does not state it. Re-check |
| Ending | Vendor advice: end the broadcast in Live Producer first, then stop the encoder, or viewers see a frozen frame | StreamYard-style guides; medium |
| API to create/start a live | None official. The Graph API `live_media` edge is read-only: it returns lives that are on air. Webhooks for live comments exist since 2021. Unofficial libraries use private endpoints and can break; likely against terms. Do not use | Meta developer docs (live_media reference; changelog 2021-11-09) |
| Official live-API connection | Restream says eligible accounts can use "the official Live API connection" so no new key per stream. What it is and who qualifies is UNVERIFIED | Restream support page |

Implication for Ujwalam: the stable path is a manual step. The user opens Live Producer, copies the fresh URL and key, and pastes it into a new sink for that one broadcast. Key goes to Credential Manager only, per project rules, and is discarded after the broadcast. A 9:16 rung (720x1280 or 1080x1920, 30 fps, 3-6 Mbps CBR) can reuse the existing V canvas. Live test of limits needs the user's go-ahead.

## 4. Analytics APIs for one's own content

All are free to call. None found that charge. Quota limits apply.

| Platform | What you get | Access needed | Cost | Grade |
|----------|--------------|---------------|------|-------|
| YouTube Analytics API (v2) | Per-video and per-channel metrics: views, watch time, average view duration, subscribers, likes. Retention curve via `audienceWatchRatio` by `elapsedVideoTimeRatio`, about 100 points over the chosen date range, no per-day split. Traffic sources via `insightTrafficSourceType`, which includes a Shorts value. Shorts have separate handling; since 2025-03-31 old views are "engaged views" | OAuth 2.0 by the channel owner (scope for analytics, read-only). Google Cloud project. A consent screen; apps with sensitive scopes may need Google verification (UNVERIFIED for personal single-user use) | Free. The Analytics API says each query's quota cost is computed per query. Default quota numbers were not in the pages read. The Data API has a default daily quota (commonly cited 10,000 units, UNVERIFIED here) | medium |
| YouTube Reporting API | Bulk daily reports, avoids quota pressure | Same OAuth | Free | medium |
| YouTube Data API v3 | Video list, titles, tags, upload, public stats | API key or OAuth | Free within quota | medium |
| Instagram Graph API, Reels insights | Per Reel: `views`, `reach`, `likes`, `comments`, `saved`, `shares`, `reposts`, `total_interactions`, `ig_reels_avg_watch_time`, `ig_reels_video_view_total_time` (in development), `reels_skip_rate` (first 3 s, estimated, in development), plus Facebook crossposted views. Period is always lifetime. No breakdowns. Data can lag 48 h; stored up to 2 years. Empty set instead of 0 when unavailable | Professional account (Business or Creator). Permissions: `instagram_basic` and `instagram_manage_insights` (Facebook Login also `pages_read_engagement`), or `instagram_business_basic` and `instagram_business_manage_insights` with Instagram Login. A linked Facebook Page is needed for the Facebook Login route; the Instagram Login route does not list it. A Meta developer app. App Review for other users' accounts; using your own account in development mode needs no review (standard Meta rule, UNVERIFIED in the pages read) | Free | strong (official doc, fetched 2026-11-11) |
| Twitch (Helix) | No streamer analytics endpoint. Only extension analytics (`analytics:read:extensions`) and game analytics (`analytics:read:games`, only for the game's owning organisation). A forum post says there are no streamer analytics endpoints. Stream data you can get: streams, followers, clips, stream markers, subscriptions, and EventSub events (collect your own history). Twitch Studio dashboard is manual only | User access token with scopes | Free | medium; endpoint list beyond analytics from general knowledge, UNVERIFIED |
| Kick public API | Channels, livestream info and stats, users, chat, events (webhooks, signed with Ed25519). Scopes seen in third-party SDKs: `channel:read` (channel and livestream stats), `user:read`, `chat:write`, `events:subscribe`. OAuth 2.1 with PKCE, tokens last about 2 h. What the stats endpoint returns is UNVERIFIED. No retention or per-video analytics found | Kick developer app, OAuth | Free | weak (third-party SDK docs only) |

Sources: Meta Instagram Media Insights reference https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights/ (fetched 2026-11-11); live_media reference https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/live_media.md ; YouTube Analytics docs https://developers.google.com/youtube/analytics/quota_and_compliance and third-party reports reference https://analytix.readthedocs.io/en/v2.1.0/refs/yt-analytics-reports.html ; Twitch scopes https://dev.twitch.tv/docs/authentication/scopes/ and forum https://discuss.dev.twitch.com/t/advanced-analytics/62278 ; Kick SDK docs https://docs.rs/crate/kick-api/latest (not official; official docs at dev.kick.com were not read).

Project impact: all four fit the "no paid API" rule. Tokens stay in Credential Manager. Build order by value: YouTube (retention curve and Shorts traffic), then Instagram Reels (skip rate, watch time, sends), then Twitch and Kick only for live-stream event history.

## 5. Popular topics for mobile FPS channels

Evidence is thin. Searches returned channel roundups and generic idea lists, not performance data. Treat the table as hypotheses to test against the user's own analytics, not findings.

| Content type | Typical length | Evidence |
|--------------|----------------|----------|
| Best loadout / gunsmith build for one weapon | Shorts 20-45 s; long 6-10 min | weak (idea lists; one channel shows "top guns" ranking) |
| Settings, sensitivity, controls, HUD layout guide | Shorts 30-60 s; long 8-15 min | weak |
| New mythic/legendary weapon or skin showcase (spin, kill effect, draw) | Shorts 15-40 s; long 5-8 min | weak; timing tied to season drop |
| Patch notes / season changes / meta shifts | Shorts 30-60 s; long 8-15 min | weak; timing matters, first uploads win |
| Tier list of weapons | long 8-12 min | weak |
| Kill montage / best moments / match reel | Shorts 15-45 s; reel 2-5 min | weak to medium (core of clip tools) |
| How-to-play tips, rank push guide, map callouts | Shorts 30-60 s; long 6-15 min | weak |
| Live stream highlight compilation | 8-12 min | weak |

Gap: no data on long-video length by topic. The 6-15 min range is the user's brief; no source tested it. Test with 2-3 uploads and read the YouTube retention curve.

## Gaps and next steps

1. Read Instagram's current Help Center Live page; the only first-party page found is from 2022-11-02. UNVERIFIED items: account type, RTMPS, 1080p acceptance, 4 h limit in Live Producer.
2. Read official YouTube Analytics quota table and OAuth verification rules for a single-owner app.
3. Read official Kick developer docs (dev.kick.com) for the stats fields.
4. Collect real signal from the user's own channel once analytics are connected; replace weak items above with measured ones.
5. Run a small A/B on hook-first versus normal cut, and captions on versus off, after the first batch of reels.
