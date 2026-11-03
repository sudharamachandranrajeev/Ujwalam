# 2026-11-03 - P16a export-only posting: evidence

Plan: `docs/plan/2026-11-03-p16a-export-posting-plan.md`. Machine: the laptop (Windows 11), Node 26.x, ffmpeg n8.1.3 on PATH. No network, no devices, no platform contact. Not run: `npm run ci`, `npm test`, host or GPU tests (main session runs CI).

## Commands and results

```
node --test tests/posting.test.mjs tests/studio-ui-posting.test.mjs
  tests 20, pass 20, fail 0, skipped 0
node --test tests/flags.test.mjs tests/studio-ui-server.test.mjs tests/studio-ui-flags-feedback.test.mjs
  tests 49, pass 49, fail 0        (touched files: flags.json gains `posting`, server.mjs CSP gains media-src)
npm run lint
  lint: 0 finding(s), 27 allow marker(s)   (all markers pre-existing)
npm run test:py
  Ran 177 tests, OK (skipped=16)    (skips are the existing OCR/capture tests; no Python code changed)
```

## What the tests prove

| Done-when | Test |
|---|---|
| Only PASS variants are offered; layout order from data | `packager / packages only PASS variants` (c01 reels and all of c02 skipped, full-crop chosen over blurred-fill) |
| Video byte-for-byte, SHA-256 in post.json | same test (`sha` of copy equals source) |
| cover.jpg from ffmpeg at anchor time | same test (JPEG magic bytes, `cover.atSec` = anchor - start = 1) |
| privacy private, status draft, source block | same test |
| Text from templates, placeholders resolved from profile; no private text | same test (candidate reason text planted in the fixture never appears in post.json) |
| Missing profile key flagged, placeholder stays literal; over-limit flagged not truncated | `missing profile keys are flagged ...` |
| Limits checked against official pages (D189), counted per field in the platform's unit; templates hold placeholders only | `limits: ...`, `data files: ...` |
| Ledger: same video + target never packaged twice | `second run never packages the same video ...` |
| Approve refused over limit / placeholders / changed video; edit drops approval | `store` tests |
| Media cannot escape the package folder | `store / media: ... tampered post.json` and `posts API / media` (bad ids, kinds, ranges) |
| Posts API gated by the flag, session and CSRF | `posts API with the flag off`, `needs the session; POST needs CSRF` |
| Approve/reject write post.json + ledger; open folder only for a known id | `posts API / approve ...`, `open folder ...` |
| CLI exit 3 while the flag is off | `cli / exit 3 while the posting flag is off` |
| Page: Posts button hidden by default, no innerHTML, CSP media-src self | `the page ships the Posts button ...` |

## UNVERIFIED

- ~~All limits in `data/posting/limits.json`: agent knowledge, `checked: null`.~~ Resolved 2026-11-03 (D189): limits.json 0.2.0 checked against the official API pages, see below.
- Template wording and the layout preference are proposals.
- The Posts view was not rendered in a browser here (UI tests cover markup and API only); first look needs a manual pass with `npm run studio` and the flag on.
- Video preview in the page depends on the browser decoding the clip codec (H.264 from the clipper; expected fine).

## Limits check (2026-11-03, D189)

`data/posting/limits.json` 0.2.0 lists, per target, the fields the platform receives, each composed from post.json parts exactly as an uploader will send them (`composeField`), with its counting unit:

| Target | Field | Max | Unit | Extra | Source |
|---|---|---|---|---|---|
| youtube-shorts | title | 100 | code points | no `<` `>` | developers.google.com/youtube/v3/docs/videos |
| youtube-shorts | description (+ hashtags) | 5000 | UTF-8 bytes | no `<` `>`; > 60 hashtags = all ignored | same + support.google.com/youtube/answer/6390658 |
| youtube-shorts | tags | 500 | tag chars + commas + 2 quotes per tag with a space | | developers.google.com/youtube/v3/docs/videos |
| tiktok | caption (description + hashtags) | 2200 | UTF-16 units | | developers.tiktok.com content-posting-api-reference-direct-post |
| instagram-reels | caption (description + hashtags) | 2200 | UTF-16 units (page says "characters"; stricter reading) | 30 hashtags, 20 mentions | developers.facebook.com ig-user/media |

Correction to P16a's agent-knowledge numbers: the YouTube hashtag limit is 60, not 15, and the YouTube description limit is bytes (a Malayalam letter is 3 bytes, so about 1666 Malayalam letters fit, not 5000). Tests: `limits:` group in `tests/posting.test.mjs` (units, forbidden characters, tag length, hashtag and mention counts, every target verified with an https source and date).

## Files

Created: `data/posting/templates.json`, `data/posting/limits.json`, `services/posting/index.mjs`, `services/posting/cli.mjs`, `tests/posting.test.mjs`, `tests/studio-ui-posting.test.mjs`, this file, the plan file.
Changed: `data/flags.json`, `services/studio-ui/server.mjs`, `ui/index.html`, `ui/js/api.js`, `ui/js/app.js`, `ui/css/app.css`.
