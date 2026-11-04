# 2026-11-04 — Twitch RTMPS (resolves D148's open item)

## Finding

Twitch's live ingest API (`https://ingest.twitch.tv/ingests`, the same endpoint `dev.twitch.tv`'s
Get Ingest Servers reference documents) was queried directly:

```
$ curl -s https://ingest.twitch.tv/ingests
{
  "ingests": [
    { "name": "Default", "url_template": "rtmp://ingest.global-contribute.live-video.net/app/{stream_key}",
      "url_template_secure": "rtmps://ingest.global-contribute.live-video.net/app/{stream_key}", ... },
    { "name": "Europe (Ireland)", "url_template": "rtmp://euw10.contribute.live-video.net/app/{stream_key}",
      "url_template_secure": "rtmps://euw10.contribute.live-video.net/app/{stream_key}", ... },
    ... 14 entries total, every one carrying both templates ...
  ]
}
```

Every ingest server has a `url_template_secure` alongside `url_template` — same host, scheme swapped,
no explicit port on either (default 1935 for `rtmp`, default 443 for `rtmps`). This was previously
marked `unverified` in `data/platforms/twitch.json` ("Page names RTMP only. RTMPS availability
UNVERIFIED") because the static docs page only shows the plain-RTMP example; the live API response is
the actual source of truth and confirms RTMPS.

## Changes

- `data/platforms/twitch.json`: `protocols.value` now `["rtmp", "rtmps"]`, sourced to the live API
  (`ingest.twitch.tv`, added to the schema test's official-source allowlist alongside the other
  `*.twitch.tv` domains). `ingest.value` gained `urlFormatSecure`.
- `data/outputs/alpha-live.json`: the `twitch` target transport changed from `rtmp` to `rtmps`.
- `data/outputs/presets/youtube-1080p60.json`: the `twitch` sink's `proto` changed from `rtmp` to
  `rtmps` to match (the plan code requires `target.transport === sink.proto`).
- Two check rules fixed openly (not worked around), per AGENTS.md:
  - `tests/outputs/schema.test.mjs`'s URL-placement test now also allows `ingest.value.urlFormatSecure`
    (previously only `servers[].url` and `urlFormat`).
  - The same file's official-source allowlist now includes `ingest.twitch.tv` (Twitch's own documented
    live-data API host, not previously listed alongside `dev.twitch.tv`/`help.twitch.tv`/`blog.twitch.tv`).
  - The "platform whose protocols don't include the transport" negative-path test used Twitch+rtmps as
    its example; since Twitch now legitimately takes rtmps, the example was swapped to Kick+rtmp (Kick's
    `protocols.value` is `["rtmps"]` only, so rtmp is still genuinely refused there).

## Tests

```
node --test tests/outputs/schema.test.mjs        25/25 PASS
node --test app/host/tests/outputs-plan.test.mjs 12/12 PASS
node tools/outputs-validate-presets.mjs          no twitch/kick errors (pre-existing UNVERIFIED-limit
                                                  warnings unrelated to this change)
```

## What the user still needs to do

The stream server URL stored in Credential Manager under `Ujwalam/stream/twitch-server` was set with a
plain `rtmp://` URL. Per D148/D146 I never read or write that value myself. **Before the next live
test**, re-run:

```
node services/event-core/cli.mjs credential set --target Ujwalam/stream/twitch-server
```

and enter the **same host**, scheme changed to `rtmps://` (e.g. if it was
`rtmp://<region>.contribute.live-video.net/app`, set it to
`rtmps://<region>.contribute.live-video.net/app` — same host, no port needed in either case). The
current `credential status` check only warns about `?` query suffixes, not the scheme, so a stale
`rtmp://` value will not be caught automatically; a real test stream will fail if the two disagree
(the plan now requires `rtmps`).

## Status

Code, data and tests done, full local pass. Live-use UNVERIFIED (needs the user's server-credential
update above, then a real test stream).
