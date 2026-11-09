# 2026-11-09 — Twitch takes either rtmp:// or rtmps:// (D309 proposed)

## Why

`docs/evidence/2026-11-04-twitch-rtmps.md` switched the Twitch target to `rtmps`. The plan code requires
`target.transport === sink.proto`, and the host checks the stored server address's scheme against the transport on
its connect thread. The server address stored in `Ujwalam/stream/twitch-server` still starts with `rtmp://`, so the
Twitch stream failed. User decision (2026-11-09): Twitch must accept either scheme.

## Design

- **Data, not code.** `data/outputs/alpha-live.json` gives the Twitch target `"transport": "auto"`. The allowed
  schemes come from `data/platforms/twitch.json` `protocols.value` (`rtmp`, `rtmps`, sourced to the live ingest API).
  No platform name is hardcoded.
- **Plan rules** (`app/host/lib/outputs-plan.mjs`):
  - `auto` is allowed only with `serverRef` (a per-account address in Credential Manager), never with a data `server`
    and never in a loopback form.
  - `auto` is allowed only on a platform whose protocols include both `rtmp` and `rtmps`. Kick (`["rtmps"]`) is
    refused with a message that says to name the transport. Kick stays `rtmps`.
  - The preset's sink `proto` must be one of the allowed schemes. After resolution, the sink's `proto` in the host
    params is set to the chosen transport, so the host's `proto == transport` rule stays as it is.
  - `plan()`/`planFile()` take `opts.schemes`: `{ "<serverRef>": { present, scheme } | { error: true } }`. For `auto`,
    the stored scheme picks the transport. A scheme outside the allowed set, no scheme, no stored address, or an
    unreadable address is refused. The message names the credential target (`Ujwalam/stream/twitch-server`) and the
    `credential set` command, never the value. For a named transport (Kick, `rtmps`), a stored address with another
    scheme is now refused when the plan is built. A missing or unreadable address is left to the host's `urlPresent`
    and the readiness check, as before.
  - Without `opts.schemes` (validation only: `tools/outputs-validate-presets.mjs`, tests), an `auto` target stays
    `auto` in the params and is listed in the result's `unresolved`. The host refuses `auto`
    (`one_of rtmp|rtmps|srt|file`), so an unresolved plan cannot stream. It fails closed.
  - `readServerSchemes(file, readFacts, { select })` gathers scheme facts for the plan's (selected) `serverRef`s only.
    `readFacts` is `readiness.mjs` `credentialFacts(store, { scheme: true })`, which reads the value, keeps only the
    lower-case scheme and drops the value.
- **Launcher** (`services/studio-ui/launch.mjs`): with `--live` and the real host, the launcher reads the schemes
  before `planFile`. A refusal prints `[studio] outputs plan refused: ...` and stops, before anything goes live. A
  stand-in (script) host reaches no platform, so the launcher reads nothing and prints that `auto` was not chosen. The
  launcher prints the chosen transport per sink (`transport rtmp`, no `://`, no address). `outputs-params.json`
  carries only the transport and the target name.
- **Host (C++)**: unchanged. The host re-reads the address on the connect thread and requires its scheme to equal the
  transport (`Outputs::valid_live_url`). If the address changes after start to another scheme, the connect fails
  closed.
- **Readiness** (`services/studio-ui/readiness.mjs`): `planTargets()` adds `schemes` (from data/platforms) to `auto`
  targets.
  - Not live: Twitch passes with `rtmp://` or `rtmps://`. Any other scheme or none gives
    "Twitch (twitch): server address starts with https://, but this output takes only rtmp:// or rtmps://".
  - Live, Twitch: the address changed to the other allowed scheme after start gives "... The address was changed
    after the studio started; restart the studio with --live to use it". Any other scheme gives "... Twitch takes only
    rtmp:// or rtmps://; set it again with one of those".
  - Kick keeps "Set it again with rtmps://".
- `data/platforms/twitch.json` ingest note updated (text only, no value or date change).

## Tests (2026-11-09, worktree `live/twitch-scheme`)

```
node --test app/host/tests/outputs-plan.test.mjs     17/17 PASS (5 new)
  twitch "auto": stored rtmp:// or rtmps:// picks the transport, sink proto follows; kick stays rtmps
  twitch "auto": https, no scheme, not stored, unreadable, not read -> refused naming Ujwalam/stream/twitch-server only
  kick (named rtmps): stored rtmp:// refused at build time; missing/unreadable left to host + readiness
  "auto" rules: serverRef only, platform with both schemes (kick refused), never loopback
  readServerSchemes: only the (selected) serverRefs read, scheme facts only, failed read = { error }, params carry no address
node --test tests/studio-ui-readiness.test.mjs        35/35 PASS (3 new; the not-live case now uses Kick for the mismatch)
node --test tests/studio-ui-live-test.test.mjs tests/stream-day.test.mjs tests/outputs/schema.test.mjs   40/40 PASS
node --test tests/studio-ui-alpha.test.mjs            36 PASS, 1 skipped (face worker: no .venv-gpu in the worktree)
  --live with the stand-in host: twitch target stays "auto", launcher says no address was read, no rtmp(s):// in output
node tools/outputs-validate-presets.mjs               PASS (twitch shown as "auto: rtmp or rtmps from the stored server address at start")
node tools/ci.mjs --quick                             9/9 PASS (pre-commit hook)
```

The secret-leak checks use a sentinel host `secret-ingest-zz9.example` as the stored address. It never appears in a
plan, its params, an error message or a readiness result.

## Loopback

The loopback suites (`o1-loopback`, stream-day) use loopback plans whose targets are rebuilt as `rtmp` on 127.0.0.1.
They do not go through `auto`, and their tests pass unchanged. No loopback ffprobe run was made for this change. The
host and its output code are unchanged.

## UNVERIFIED

- The real-host `--live` launch path that reads `Ujwalam/stream/twitch-server` through Credential Manager was not run.
  It reads a real credential, so tests use the stand-in host and injected facts. First check: start the studio with
  `--live` and confirm the line `[studio] sink twitch: transport rtmp (...)` with the current stored `rtmp://` address.
- Twitch over plain `rtmp://` sends the stream key unencrypted in transit. This is the user's choice (D309). Storing
  the `rtmps://` form of the same host keeps encryption, and no other change is needed.
- Live use on a real stream: not done (needs the user's "start stream test").

## Proposed D309

> **D309 (proposed 2026-11-09): Twitch takes either rtmp:// or rtmps://.** The Twitch live target uses
> `"transport": "auto"` (`data/outputs/alpha-live.json`). At output build time, the launcher reads only the scheme of
> the server address stored in `Ujwalam/stream/twitch-server`. The value is dropped at once and never logged,
> persisted or put in params. That scheme picks the transport, if it is one of the platform's rtmp/rtmps protocols in
> `data/platforms/twitch.json`. Anything else (another scheme, no scheme, no stored address, unreadable) refuses the
> plan with a plain message that names the credential target, not its value. `auto` needs `serverRef` and a platform
> that takes both schemes. Kick (rtmps only) cannot use it and stays `rtmps`; a stored `rtmp://` Kick address is
> refused at build time. The host is unchanged and re-checks the scheme against the chosen transport when it connects.
> Readiness accepts either scheme for Twitch and asks for a restart when the address changes scheme after start.

## Files changed

- `app/host/lib/outputs-plan.mjs`
- `app/host/tests/outputs-plan.test.mjs`
- `data/outputs/alpha-live.json`
- `data/platforms/twitch.json` (note text only)
- `services/studio-ui/launch.mjs`
- `services/studio-ui/readiness.mjs`
- `tests/studio-ui-alpha.test.mjs`
- `tests/studio-ui-readiness.test.mjs`
- `tools/outputs-validate-presets.mjs`
- `docs/evidence/2026-11-09-twitch-either-scheme.md` (this file)
