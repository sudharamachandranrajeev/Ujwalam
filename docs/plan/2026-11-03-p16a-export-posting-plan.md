# 2026-11-03 - P16a export-only posting plan

Scope (user-approved 2026-11-03): turn a validated clip run into private draft packages for review. No uploads, no OAuth, no network. Behind the feature flag `posting` (`data/flags.json`, off by default).

## Flow

1. `node services/posting/cli.mjs package --run <clip run folder>` (exit 3 while the flag is off).
2. For each clip x target (`youtube-shorts`, `tiktok`, `instagram-reels`, ids from `data/clip/targets.json`) the packager takes the variant that `report.json` marks PASS for that target (layout order in `data/posting/templates.json`: full-crop, blurred-fill, game-facecam; none = skipped `no-pass-variant`).
3. Writes `<run>/posts/<clipId>/<target>/`: `<layout>.mp4` (byte copy, SHA-256 re-checked, never re-encoded), `cover.jpg` (ffmpeg, CPU, one thread, at the candidate anchor time), `captions.ass` if present, `post.json`.
4. `post.json`: title, description, tags, hashtags, target, `privacy: "private"` (fixed), `status: "draft"`, `source {run, clipId, layout, startSec, endSec, sha256}`, `limits {checks, status}`, `unresolved` placeholder keys.
5. Ledger `<dataDir>/posting/ledger.json`, key = video SHA-256 + target, value = status draft/approved/rejected and the package folder. A video is never packaged twice for a target (also after reject). Later upload steps reuse it.
6. Control page "Posts" (button only while `posting` is on): list, preview video and cover, edit title/description/tags/hashtags, approve, reject, open folder.

## Rules kept

- Text from `data/posting/templates.json`: placeholders only. `{handles.x}` and `{links.x}` resolve from the local profile (angle-bracket template values count as missing), `{date}` = stream date from `candidates.json`, `{n}` = clip rank. Unresolved placeholders stay literal and block approval. Chat text, viewer names, marker notes and candidate reasons are never read into post text.
- Limits in `data/posting/limits.json`: checked against official pages 2026-11-03 (D189), per platform field with its counting unit. Over a limit = flagged in `post.json` and review, approval refused, text never truncated.
- Approve checks: title present, inside limits, no unresolved placeholder, video SHA-256 unchanged. An edit drops an approved package back to draft.
- Media served by the studio server only by (id, kind in video|cover); the file name comes from `post.json`, must be a plain file with `.mp4`/`.jpg` inside the package folder (real-path check, no links); Range supported. CSP gains `media-src 'self'`.
- Open folder: local `explorer.exe` from SystemRoot (or `open`/`xdg-open`), only for a ledger-known package.

## Design choice: Node, not Python

The studio server edits and approves packages and owns the ledger semantics; the profile resolver (`services/project/scene-preset.mjs`) is Node; one implementation avoids two writers in two languages. Coupling to the clipper is only the JSON files (`candidates.json`, `report.json`). ffmpeg is looked up the same way as the clipper (`--ffmpeg`, else PATH; never downloaded).

## Ledger ownership

`services/posting/index.mjs` is the only code that writes `ledger.json` and `post.json` (atomic rename, fresh read before each write). The packager CLI and the studio server both call it; they are short-lived read-modify-write operations. Not safe against two truly simultaneous writers; acceptable for one user, and noted as a limit.

## Not built (later)

Uploads, OAuth, scheduling, per-platform metadata beyond title/description/tags/hashtags, thumbnails chosen by the user, batch approve.

## Needs the user

1. ~~Check the limits in `data/posting/limits.json` against the platforms' official pages.~~ Done 2026-11-03 (D189).
2. Check the template wording; add `handles.*` and `links.discord` to `data/profile.local.json` if missing.
3. Layout preference (`layoutPreference`) if full-crop should not be the first choice.
