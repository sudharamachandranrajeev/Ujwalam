# P3 E8: independent security review of the event core

Date: 2026-10-29. Reviewer: independent subagent, code only. I did not read anything under `docs/`, `legacy/` or
`data/profile.local.json`. I read the code in scope and wrote probe scripts in a session scratch folder (`<scratch>/e8/`,
outside the repo). Every probe ran on 127.0.0.1 with temp data directories and invented text and names. No real
Streamer.bot, platform or data directory was touched. Everything the probes started was stopped.

Paths below are repo-relative. `<scratch>` is the session scratch folder. `<user>` is the Windows user.

Scope: `services/event-core/**` (api, streamerbot, moderation, livelock, audit, diag, config, model, validate,
dedupe, bus, index, cli, priority); `data/actions`, `data/moderation`, `data/platforms`; `tools/mock`, `tools/soak`,
`tools/stray-procs.mjs`, `tools/audit-crash*.mjs`, `tools/idem-crash-child.mjs`, `tools/git-hooks/*`,
`tools/lint.mjs`, `tools/ci.mjs`.

Baseline: `node --test --test-concurrency=4 tests/event-core-*.test.mjs` gave `tests 355, pass 355, fail 0, skipped 0`.

## Classes

- **fix-first**: must be fixed before P3 closes.
- **should-fix**: real weakness. Fix it, or record an ADR or owner decision, before the feature it guards goes live.
- **nit**: low risk, hardening or documentation.

## Findings (sorted by severity)

| id | class | area | summary |
|---|---|---|---|
| E8-01 | fix-first | git hooks | private scan silently skips any file that has a NUL byte, so UTF-16 text with a private term passes pre-commit |
| E8-02 | should-fix (ADR) | gate / API | one api-token holder can request and confirm its own actions: purges all raw chat, and passes the live two-step |
| E8-03 | should-fix | API | an unauthenticated local process can fill all 64 connection slots and make `actions.panic` fail |
| E8-04 | should-fix | Streamer.bot | auth downgrade: a stored password is never used if the server's Hello asks for no auth, and the server is not authenticated |
| E8-05 | should-fix | Streamer.bot | no inbound WebSocket message size cap: a 64 MiB frame was parsed whole |
| E8-06 | should-fix | ACL | `protectPath` keeps other explicit ACEs, does not re-protect existing children and grants by `USERNAME`, not SID |
| E8-07 | should-fix | git hooks | private scan drops terms shorter than 4 characters and misses 3+ separators, invisible characters and fullwidth forms |
| E8-08 | should-fix (owner) | moderation | normaliser misses soft hyphen, word joiner, fullwidth forms and homoglyphs, so blocklist entries are bypassed |
| E8-09 | nit | subprocess | `icacls`, `powershell(.exe)`, `python`, `git` and `taskkill` are spawned by bare name (PATH order; the cwd was not searched in the probe) |
| E8-10 | nit | audit | hash chain is unkeyed: it detects accidental damage but not deliberate tampering by a file-write-capable user |
| E8-11 | nit | privacy / display | bidi and format characters stay in stored text and SSE, and are printed by `listen --show-text` |
| E8-12 | nit | Streamer.bot | backoff resets after Subscribe, so a server that accepts and then drops gives about 1.3 reconnects per second |
| E8-13 | nit | git hooks | pre-push imports `tools/label/labels-export.mjs` from the commit being pushed |
| E8-14 | nit | API | a token holder can use up the 16 SSE slots (by design) |
| E8-15 | nit | CLI | `listen` writes fixtures into an existing data dir without re-applying the ACL; `--url` accepts a non-loopback `ws://` |
| E8-16 | nit | credential | the password comes back on PowerShell stdout decoded as utf8; non-ASCII passwords are UNVERIFIED |

Count: fix-first 1, should-fix 7, nit 8.

---

### E8-01 (fix-first): private scan skips files with a NUL byte, including UTF-16 text

- **Where:** `tools/git-hooks/private-scan.mjs:84` (`const isBinary = (buf) => buf.includes(0);`). The skip is used in
  pre-commit (`:246`, `if (buf === null || isBinary(buf)) continue;`), in the worktree scan (`:271`), in `scan-files`
  (`:284`) and in the history scan used by pre-push (`:334`). None of these paths reports the skip.
- **Attack / failure scenario:** this needs no attacker. Windows PowerShell 5.1 `>` and `Out-File`, `reg export`
  and several Windows tools write UTF-16LE by default. Such a file can hold a private term: a brand, channel, IGN or
  path. The file is staged, the hook sees the NUL bytes, skips the file, and the commit and push pass. The repo is
  public, so the rule's backstop fails open without saying so.
- **Evidence:** I made a throwaway git repo in `<scratch>/e8/scan/repo` with a scratch profile holding only invented
  terms (`{"brand":"Zorblax","tag":"KQ9","ign":"Zorblax_Prime"}`).

  ```
  git add notes.txt            # "﻿hello zorblax\n" as UTF-16LE
  node tools/git-hooks/private-scan.mjs pre-commit --profile ../profile.json   -> exit=0 (no output)
  git add plain.txt            # same text, UTF-8
  node tools/git-hooks/private-scan.mjs pre-commit --profile ../profile.json   -> plain.txt:1: term #1, exit=1
  ```

  `scan-files` gave the same result. `c2-utf16.txt` exited 0 and `c7-nul.txt` (`"zorblax\n\0\n"`) exited 0.
- **Fix:**
  1. Decode before deciding. A UTF-16LE or UTF-16BE BOM, or an alternating-NUL pattern, means decode as UTF-16 and
     scan the text.
  2. For other NUL-containing blobs, also scan the bytes as latin1 and as UTF-16LE, because a term inside a binary
     still leaks.
  3. Never skip silently. Refuse a NUL-containing file unless `.gitattributes` marks it `binary` (media and fonts).
     Print one line naming the rule.
  4. Add tests for UTF-16LE with BOM, UTF-16LE without BOM, UTF-16BE, and "text plus one NUL".

### E8-02 (should-fix, needs an ADR): one api client can approve its own actions

- **Where:**
  - `services/event-core/api/methods.mjs:64`: `outcome()` returns `confirm` with `phrase` and `actionHash` to the
    requester.
  - `methods.mjs:94-101`: `actions.confirm` is open to the `api` role.
  - `methods.mjs:124-131`: `audit.purge` becomes a `chat.raw.purge` request.
  - `services/event-core/livelock/gate.mjs:67`: `CONFIRM_SOURCES = ['ui','api']`.
  - `gate.mjs:271-282`: the two-step response hands out each step's phrase.
  - `services/event-core/api/executor.mjs:12-21`: `chat.raw.purge` really purges, even in mock mode.
- **Attack scenario:** the threat model includes a compromised API client. Any holder of the api token can run
  `audit.purge {all:true}` and receive `{confirmId, phrase, actionHash}`. It can then call `actions.confirm` with
  those values and delete all stored raw chat. The token can come from a stray tool, a future plugin or AI helper, or
  anything that reads `api.json` as the same user. While live, it can step through the two-step on-air confirmation
  in the same way. So the confirmation proves only that the client can echo the response. It does not prove a human
  said "yes" or "yes, on air". The gate is correct as written: the catalogue says "Needs a confirmation from ui or
  api". The gap is in the design. In P3 the only real effect is the purge. That changes when P4 and P6 add studio
  handlers and P15 adds the LAN remote.
- **Evidence:** `node <scratch>/e8/probe-api.mjs` (rig with a real audit in a temp dir and 5 invented chat lines):

  ```
  A12 request: {"hasPhrase":true,"hasHash":true,"phrase":"yes, on air"}
  A12 confirm by same token: {"verdict":"allow","reason":"confirmed","dispatch":{"ok":true,"result":{"purged":5,"all":true}}}
  A13 scene.switch while live: {"phrase":"yes","step":1}
  A13 after self-confirm steps: {"steps":2,"executed":["chat.raw.purge","scene.switch"]}
  ```

  `live.set` was issued with the system token. Both confirm steps of `scene.switch` used the same api token.
- **Fix:** write an ADR before P4 that separates "may request" from "may confirm".
  1. Confirmation must come from a channel that only a human-facing surface holds. Options: a `confirm` token or
     role that is never written to `api.json`, kept in the Qt app process; or a TTY prompt for CLI use.
  2. The response to `actions.request` must not carry the phrase or actionHash to a client that cannot confirm.
     Return only `confirmId` and a status.
  3. Record the confirmer identity separately from the requester. Refuse when they are the same credential, for
     destructive and on-air classes.
  4. Until then, document the limit: "api token = full authority, including destructive purge". Do not hand the api
     token to anything except the UI.

### E8-03 (should-fix): connection-slot exhaustion blocks the API, including panic

- **Where:** `services/event-core/api/server.mjs:24-30` (`headersTimeoutMs: 10_000`, `maxConnections: 64`),
  `server.mjs:79` and `server.mjs:82` (the idle timer covers only sockets with `bytesRead === 0`).
- **Attack scenario:** any local process can open loopback sockets. That includes processes of other users,
  because loopback has no per-user scope, and it needs no token. The attacker opens 64 sockets and writes a partial
  request line and Host header, so `bytesRead > 0` and the 30 s idle drop does not apply. Each socket lives about
  10 s until the headers timeout, then the attacker reopens it. Connections over the limit are reset, so the UI's
  `actions.panic` (or any RPC) gets `ECONNRESET`. Panic is a safety control and should be the last thing that can be
  starved.
- **Evidence:** `node <scratch>/e8/probe-conn.mjs`. The first run held 70 half-open sockets:
  `F1 panic while 70 half-open sockets held: {"err":"ECONNRESET"} ... sockets still open by attacker: 64`. The second
  run reopened each socket as soon as it closed:

  ```
  F0 panic before attack: 200 {"ok":true,"reason":"panic-engaged"}
  F1 25 panic attempts over ~25 s under attack: 14 answered 200, others: ["ECONNRESET"]; attacker connections opened: 19924
  ```

  An attacker that holds exactly 64 sockets keeps every attempt failing until a header timeout frees a slot.
- **Fix:**
  1. Put a cap of about 8 on connections that have not yet sent a complete, authenticated request, separate from
     the total cap. Drop the oldest unauthenticated socket when a new one arrives.
  2. Lower the headers timeout for unauthenticated sockets to 1-2 s.
  3. Let the UI keep one authenticated keep-alive connection.
  4. Make panic available on a path that does not depend on the HTTP listener: in-process in the Qt app (P4), and a
     CLI that writes a panic file or a named pipe the core polls.
  5. Add a test that holds `maxConnections` half-open sockets and asserts panic still succeeds.

### E8-04 (should-fix): Streamer.bot auth downgrade and no server authentication

- **Where:** `services/event-core/streamerbot/connector.mjs:155`. `if (hello.authentication) { ... }`. Otherwise
  the connector goes straight to Subscribe. `getPassword` is never consulted.
- **Attack scenario:** a local process binds `127.0.0.1:8080` before Streamer.bot does, for example after a
  Streamer.bot crash or restart, or when it is not running. The fake server sends a Hello without `authentication`.
  The connector subscribes and publishes everything the fake server sends, as `source: 'streamerbot'` events:
  invented chat, follows, raids, bits and redemptions. Chat stays tainted, so the gate is not bypassed. Fake alerts,
  however, reach the alert path and are recorded as fixtures for P9. If the fake server does ask for auth, it
  receives `base64(SHA256(base64(SHA256(pw+salt))+challenge))` with a salt and challenge it chose, which permits an
  offline dictionary attack on the stored password. The protocol cannot fix that part. It is a reason to bind the
  server identity locally.
- **Evidence:** `node <scratch>/e8/probe-sb.mjs`, with the repo mock started with `password: null` and a connector
  whose `getPassword` returns a stored secret:

  ```
  B1 state with stored password, server asks no auth: {"state":"connected","passwordReads":0}
  B2 injected chat accepted: {"published":2,"busSeen":1}
  ```
- **Fix:**
  1. If a password is configured (Credential Manager has an entry), a Hello without `authentication` is fatal:
     `auth-expected`, no reconnect, an audit row, and an `onNote` error.
  2. Optional: before connecting, check that the process owning the port is Streamer.bot (owning PID and executable
     path through `Get-NetTCPConnection`). Record a mismatch as an audit row.
  3. Show the server's `info.name` and version in core status, so the UI can flag an unexpected server.

### E8-05 (should-fix): no inbound WebSocket size cap

- **Where:** `services/event-core/streamerbot/connector.mjs:139` (`JSON.parse` on the whole message) and `:199`
  (the message handler). No size check comes before the parse. The global WebSocket (undici) has no payload limit
  set.
- **Attack scenario:** a fake or misbehaving server (see E8-04) sends one very large text frame, or a few of them.
  The core buffers the frame, converts it to a string and parses it on the event loop. Memory grows to more than
  20 times the frame size, and the parse stalls ingest and the API. A few such frames can exhaust the core's memory.
  The 500-character cap in the model applies only after the parse.
- **Evidence:** in `probe-sb.mjs`, one 64 MiB chat frame:
  `B3 64 MiB frame: {"state":"connected","rssDeltaMB":1371,"ms":4088}`. The mock ran in the same process, so part of
  the RSS growth is the sender's own copies. The connector stayed connected and accepted the frame.
- **Fix:** before `JSON.parse`, drop any message whose length is over a fixed cap, for example 256 KiB. That is far
  above any real Streamer.bot event. Count the drop as `oversize` in stats. After N oversize frames, close and
  reconnect with backoff. If undici exposes a max-payload option, set it too.

### E8-06 (should-fix): `protectPath` does not make a directory private

- **Where:** `services/event-core/config.mjs:44-48`:
  `const user = process.env.USERNAME; ... spawnSync('icacls', [p, '/inheritance:r', '/grant:r', grant])`, and
  `config.mjs:55-58`, where `ensureSecureDir` protects only a newly created leaf.
- **Attack scenario:**
  1. `/inheritance:r` removes inherited ACEs, and `/grant:r` replaces only the current user's ACE. Any explicit ACE
     already on the directory survives, yet `protectPath` reports `'acl'`. This happens with a data dir that was
     created by another tool, copied, or placed on a share. Because the grant is `(OI)(CI)`, the database, WAL,
     `pseudo.key` and `stalls.jsonl` created inside the directory inherit the surviving ACE. Raw chat and the
     pseudonym key then stay readable by that principal.
  2. Files already in the directory are not re-protected, because there is no `/T`. A database or key written before
     E6, or by `audit` CLI commands that call only `ensureSecureDir`, keeps its old ACL.
  3. The grant names `%USERNAME%` without a domain and is not a SID. On a domain-joined machine, or when a local and
     a domain account share a name, icacls resolves the name and can pick the wrong principal (UNVERIFIED on this
     machine). The variable can also be changed in the environment.
- **Evidence:** `node <scratch>/e8/probe-acl2.mjs`. The probe gives a temp dir an explicit `BUILTIN\Users` RX ACE,
  then calls `protectPath(dir, {dir:true})`:

  ```
  before: [ 'BUILTIN\\Users', 'NT AUTHORITY\\SYSTEM', 'BUILTIN\\Administrators', '<current-user>' ]
  protectPath: acl
  after: [ '<current-user>', 'BUILTIN\\Users' ]
  ```
- **Fix:**
  1. Set the whole DACL instead of editing it. Get the current user's SID (`whoami /user /fo csv` or the process
     token) and grant `*<SID>`.
  2. Remove every other explicit ACE (`icacls p /reset` first, then `/inheritance:r /grant:r *<SID>:(OI)(CI)F`), or
     use `Set-Acl` with `SetAccessRuleProtection($true,$false)`.
  3. Apply `/T` to existing children.
  4. Then read the ACL back and fail closed unless only the user SID (optionally SYSTEM) is present.
  5. Use the same helper for `api.json`, `pseudo.key` and the audit database, and in the `audit` and `listen` CLI
     paths.

### E8-07 (should-fix): private-scan term matching gaps

- **Where:** `tools/git-hooks/private-scan.mjs:60` (`if (core.length < 4 || seen.has(core)) continue;`) and `:64`
  (`esc.join('[^\\p{L}\\p{N}\\r\\n]{0,2}')`, flag `iu`, no normalisation).
- **Failure scenario:**
  1. A term whose alphanumeric core is shorter than 4 characters is dropped without any message. Clan tags and short
     IGN variants are often 2-3 characters, and CLAUDE.md names the clan tag explicitly. I did not read the real
     profile, so whether it holds such a term is UNVERIFIED. If it does, this finding is fix-first.
  2. Three or more separators between letters evade the scan. So do three or more zero-width characters, because
     they count as separators. Fullwidth letters evade too. A term split across lines is not caught (accepted as a
     limit).
- **Evidence:** `scan-files` with the invented profile (exit 1 = hit):

  ```
  c1-plain.txt     "hello zorblax"                 exit=1
  c3-sep3.txt      "z - o - r - b - l - a - x"     exit=0
  c4-fullwidth.txt fullwidth "zorblax"            exit=0
  c5-short.txt     "clan KQ9 here"                 exit=0   (3-char term dropped at load, no warning)
  c6-split.txt     "zorb\nlax"                     exit=0
  c8-zwj.txt       "zo" + 3 x U+200B + "rblax"     exit=0
  ```
- **Fix:**
  1. Apply NFKC and strip `\p{Cf}` (format characters, including zero-width and bidi) before matching.
  2. Allow any run of non-alphanumeric characters (not only 2) between letters, still bounded by the line.
  3. Match short terms (2-3 characters) as whole tokens (`(?<![\p{L}\p{N}])term(?![\p{L}\p{N}])`) instead of dropping
     them.
  4. Print the count of profile terms loaded and skipped on every run, numbers only.

### E8-08 (should-fix, owner decision): moderation normaliser bypasses

- **Where:** `services/event-core/moderation/text.mjs:9`. `ZERO_WIDTH` covers only U+200B-200F, U+202A-202E,
  U+2066-2069 and U+FEFF. There is no NFKC and no confusable folding.
- **Attack scenario:** a viewer writes a blocked phrase or link with a soft hyphen (U+00AD), a word joiner (U+2060),
  fullwidth letters or Cyrillic look-alikes. `dropMessage` does not match, and the message is published as clean.
  Today the effect is limited to stored text and SSE consumers, but overlays and replies come later.
- **Evidence:** `node <scratch>/e8/probe-mod.mjs` (committed blocklist, no local overlay):

  ```
  I1 plain: dropped=true          I1 softHyphen: dropped=false   I1 wordJoiner: dropped=false
  I1 fullwidth: dropped=false     I1 cyrillicScam: dropped=false I1 zwsp: dropped=true
  I2 1000 x 500-char worst-case lines: 22 ms   (no ReDoS in the committed patterns)
  ```
- **Fix:** the text says "same behaviour as legacy", so the owner should decide whether to diverge.
  1. Strip all `\p{Cf}` characters plus U+00AD and U+034F.
  2. Apply NFKC.
  3. Optionally fold a small confusables table (Cyrillic and Greek to Latin) for matching only, keeping the stored
     text unchanged.
  4. Keep the legacy-parity tests and add the bypass cases as new expected drops.

### E8-09 (nit): bare-name subprocess spawns

- **Where:**
  - `services/event-core/config.mjs:47` (`icacls`)
  - `services/event-core/streamerbot/credential.mjs:97` (`powershell.exe`)
  - `tools/soak/system-probe.mjs:31` (`powershell`)
  - `tools/stray-procs.mjs` (`powershell`)
  - `tools/lint.mjs:117` and `:301` (`git`, `python -I`)
  - `tools/soak/replay.mjs:382` (`taskkill`)
- **Scenario:** a writable directory early in PATH could shadow a system tool. The credential child is the
  sensitive one, because the password passes through its stdin and stdout.
- **Evidence:** `node <scratch>/e8/probe-spawn.mjs` copied `hostname.exe` as `plant/icacls.exe` and spawned `icacls`
  with `cwd: plant`, then again after `process.chdir(plant)`. Both times the real icacls ran
  (`"ICACLS name /save aclfile [/T] [/C] [/L]"`). So the cwd is not searched, and PATH order is the only exposure.
- **Fix:** in the service code (`config.mjs` and `credential.mjs`), spawn
  `path.join(process.env.SystemRoot, 'System32', ...)`, with `WindowsPowerShell\v1.0\powershell.exe` for
  PowerShell. Tools can stay as they are.

### E8-10 (nit): unkeyed audit chain

- **Where:** `services/event-core/audit/chain.mjs:13` (`createHash('sha256').update(prev + canonicalRow(r))`).
- **Scenario:** anyone who can write the database file can edit rows, recompute the chain and pass `audit verify`.
  The append-only triggers can be dropped by the same writer.
- **Fix:** document that the chain detects damage, not tampering. Optionally keep an HMAC key (stored like
  `pseudo.key`), or periodically export the head hash to a place the core cannot rewrite.

### E8-11 (nit): bidi and format characters reach stored text, SSE and the terminal

- **Where:**
  - `services/event-core/model.mjs`: `cleanString` strips C0 and C1 only.
  - `services/event-core/cli.mjs:61`: `listen --show-text` prints `displayName` and `text`.
  - The moderation `normalise` strips zero-width and bidi characters for matching only.
- **Scenario:** a display name with U+202E or U+2066 reorders the terminal line, or the line in any SSE consumer
  that renders text. This can hide or spoof the speaker's name next to the text ("Trojan Source"-style).
- **Fix:** in `--show-text`, replace `\p{Cf}` with a visible marker. Tell P5 overlays and the UI to render names in
  an isolated bidi context (`dir="auto"` / `unicode-bidi: isolate`). The stored text can stay faithful.

### E8-12 (nit): reconnect rate with a server that accepts and then drops

- **Where:** `services/event-core/streamerbot/connector.mjs:172` (`attempt = 0` after Subscribe is accepted).
- **Evidence:** `probe-sb.mjs` B4 (the mock kills the socket as soon as the Subscribe lands):
  `{"drops":13, ... "reconnects":13, ... "state":"waiting"}` in 10 s.
- **Fix:** reset `attempt` only after the connection has been stable for some time (for example 30 s), not on
  Subscribe. The rate is already bounded, so this is low priority.

### E8-13 (nit): pre-push runs code from the pushed commit

- **Where:** `tools/git-hooks/private-scan.mjs:129` and `:152`. The hook does
  `await import(.../tools/label/labels-export.mjs)` from the commit being checked.
- **Scenario:** a commit that changes `labels-export.mjs` also changes the validator that checks it. In a
  single-owner repo this is an integrity concern, not an attack: a broken or edited validator can wave labels
  through.
- **Fix:** when `labels-export.mjs` or `schema-lite.mjs` changed in the pushed range, run the validator from the
  installed hook's own tree (HEAD of the remote branch) as well, and require both to pass.

### E8-14 (nit): SSE slot exhaustion by a token holder

- **Where:** `services/event-core/api/server.mjs`, `handleEvents` (16 clients).
- **Scenario:** a token holder opens 16 streams, and the UI's stream is refused. This needs the token, so it falls
  under E8-02's trust statement.
- **Fix:** optionally reserve one slot for the system role, or drop the oldest api stream on overflow.

### E8-15 (nit): `listen` CLI data-dir ACL and non-loopback URL

- **Where:** `services/event-core/cli.mjs:66-73`. The fixture recorder uses `resolveDataDir` without `protectPath`,
  and `--url` is free-form.
- **Scenario:** fixtures (anonymised) land in a data dir whose ACL was never applied. A `ws://<lan-host>` URL sends
  the challenge response in clear text to another host, which permits an offline dictionary attack.
- **Fix:** call the E8-06 helper in `listen`. Warn on a non-loopback URL, and require `--allow-remote` for one.

### E8-16 (nit): credential stdout encoding

- **Where:** `services/event-core/streamerbot/credential.mjs`. The child's stdout is read as utf8.
- **Scenario:** Windows PowerShell 5.1 writes stdout in the console's OEM code page unless
  `[Console]::OutputEncoding` is set. A non-ASCII password could be mangled and then fail auth (UNVERIFIED: no probe,
  because it would touch Credential Manager).
- **Fix:** set `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)` in the encoded script, or return base64.
  Add a unit test with a non-ASCII value through the stdin/stdout codec only.

---

## Checked and found sound

API (`probe-api.mjs`, all on 127.0.0.1 with a random port):

- Bind: the server listens on 127.0.0.1 only and refuses any other bind (`server.mjs:52`, `:251`).
- DNS rebinding: Host `evil.example:<port>` gave **403** (A1), and `127.0.0.1.nip.io:<port>` gave **403** (A2).
- CSRF from a browser: `Origin: null` gave **403** (A3), and any `Sec-Fetch-*` header gave **403** (A4). Browsers
  always send one of these, so no page can reach the API.
- Auth: no token gave **401** (A5). The compare is a SHA-256 digest compared with `timingSafeEqual`. The body is read
  only after auth. A failure throttle exists (3 per connection, 20 per address per minute) and valid tokens still
  pass.
- Content-Type must be `application/json`: text/plain gave **415** (A6). Body cap: a 70 KiB body gave **413** (A7).
- JSON-RPC strictness: batches are refused (`-32600`, A9). Unknown top-level keys and unknown params are refused,
  and the id is limited to a string of 1-64 characters or an integer.
- Prototype keys: `{"__proto__":{...}}` in action params gave `refuse / bad-params` (A8). `canonicalJson` refuses
  `__proto__`, `constructor` and `prototype`, depth is capped at 12 and size at 8192 bytes. Provenance refuses
  accessors and Proxies.
- Roles:
  - The system token cannot confirm (`-32001 forbidden`, A10) and cannot subscribe to `chat.message` on SSE
    (**403**, A11).
  - `live.set` is system-only.
  - SSE kinds are validated (at most 8, `^[a-z][a-z0-9.]{0,31}$`). SSE frames are single-line ids and kinds with JSON
    data. The queue drops the oldest event, and a stalled client is destroyed after 30 s.
- `api.json`: written with `'wx'`, ACL applied to the temp file before the write, then fsync and rename. It is
  removed only by the owning pid. Env-supplied tokens are never written. After a hard kill, the old tokens are
  rejected on restart (covered by the soak crash mode).

Gate, live-lock and idempotency:

- The gate source is fixed by role, never taken from the client. Chat taint follows the provenance chain.
- Deny categories (stream, record, outputs, settings, devices, main mic, panic, destructive verbs) are hard-coded and
  cannot be chat-allowed by data. `chatMode: "on"` is refused at load. Every committed catalogue entry has
  `chatAllowed: false`.
- Pending confirmations are capped per source (16) and expire. The used-id set is capped. The two-step confirmation
  binds the confirmer source and the live epoch. Confirmations do not survive a restart (`unknown-confirm`).
- Idempotency keys are namespaced by origin (`ck:`, `pm:`, `ev:`) and by source. Writes fail closed without a
  durable audit record. `revalidate()` runs before execute.
- Fake-server roles (`broadcaster` and others) are not used for any authorisation decision (grep: `ROLES` appear only
  in model and map).
- The Streamer.bot send path is off (`sendEnabled` is never set in production). `allowMockSend` additionally
  requires the mock marker and a loopback URL.

Audit and privacy:

- All SQL is parameterised. Audit detail tokens are limited by `TOKEN_RE` (`^[A-Za-z0-9_.:,-]{0,64}$`). Raw text
  lives only in `chat_raw`.
- Purge sets `secure_delete=ON`, runs incremental vacuum or VACUUM, then `wal_checkpoint(TRUNCATE)`. Backup and
  export exclude `chat_raw` and refuse destinations inside the repo.
- The single-writer lock uses an exclusive SQLite lock file. A crash leaves the chain verifiable (soak crash mode).
- The anonymiser is allowlist-based, and the fixture dir must be outside the repo. Chat is never recorded as a
  fixture.
- The stall tracer writes numbers and labels only. Its files are bounded at about 2x `maxBytes`.
- `pseudoId` is an HMAC with a 32-byte random key created with `'wx'` in the protected data dir. The service applies
  the directory ACL before the core loads the key (`service.mjs:50-52`, fail closed). See E8-06 for the limits of
  that ACL.

Inputs and resources:

- Event validation caps text at 500 code points and names at 64, and strips C0 and C1 controls. The schema mirrors
  `validate.mjs`, and `unevaluatedProperties: false` keeps raw platform payloads out.
- Dedupe origins are capped at 4096, the bus queue at 1000 per subscriber, and the echo tracker at 1000 entries.
- Blocklist regexes: the committed patterns showed no catastrophic backtracking (22 ms for 1000 worst-case lines of
  500 characters). A bad pattern is skipped with a warning.
- The HTTP server has header (10 s) and request (15 s) timeouts, an 8 KiB header cap, and a 30 s drop for silent
  sockets. See E8-03 for what this does not cover.

Subprocesses and tools:

- The credential secret is never on argv. It travels over stdin and stdout, and the child gets a reduced
  environment. `-EncodedCommand` is a fixed script. A bare-name spawn did not resolve from the cwd (E8-09 probe).
- `tools/ci.mjs` uses `shell: true` only on fixed strings. The mock Streamer.bot and soak tools bind to loopback,
  use temp or data-root dirs outside the repo, and record counts only in the purge proof.
- `tools/lint.mjs`: the secret marker is accepted only under `tests/`. The machine user name is refused in paths even
  with a marker. Exclusions and exemptions are printed on every run.

## Probe files (scratch only, not committed)

`<scratch>/e8/probe-api.mjs`, `probe-sb.mjs`, `probe-conn.mjs`, `probe-acl2.mjs`, `probe-spawn.mjs`, `probe-mod.mjs`,
and `scan/` (invented profile and sample files; the throwaway git repo was deleted after the run).

## Verdict

**P3 does not pass security review yet.** One fix-first item blocks closing the phase: E8-01, the private scan
failing open on UTF-16 and NUL-containing text in a public repo.

E8-02 is a design gap. A confirmation is not proof that a human approved. It needs an ADR, plus a documented "api
token = full authority" statement until the ADR is done.

E8-03 to E8-08 should be fixed before chat-driven actions, alerts or overlays go live (P4 to P6). Each is small and
local. E8-07 becomes fix-first if the real profile holds any term shorter than 4 characters (UNVERIFIED).

The API perimeter (bind, Host, Origin, Sec-Fetch, token, body and JSON strictness), the gate's taint, deny and
idempotency logic, and audit purge hygiene held under every probe.

## Files created or changed

- Created: `docs/evidence/2026-10-29-p3-e8-security-review.md` (this file). No other repo file was changed.

---

## Fixes (2026-10-29)

Fixes for E8-01, E8-03 to E8-07, E8-09, E8-11 to E8-13, E8-15 and E8-16. E8-02, E8-08, E8-10 and E8-14 are not
fixed here (status below). The probes are the same scratch scripts as above, run before and after on 127.0.0.1 with
temp dirs. Nothing was committed or pushed.

| ID | Status | Test (all in `npm test`) |
| --- | --- | --- |
| E8-01 | fixed | `tests/private-scan.test.mjs`, the four "E8-01: ..." tests |
| E8-02 | not fixed: ADR proposed | `docs/adr/2026-10-29-confirmation-channel.md` (PROPOSED) |
| E8-03 | fixed (residual noted) | `tests/event-core-api.test.mjs`, "E8-03: panic gets through ..." and "E8-03: authenticated slots ..." |
| E8-04 | fixed | `tests/event-core-streamerbot.test.mjs`, "E8-04 downgrade ..." |
| E8-05 | fixed (residual noted) | `tests/event-core-streamerbot.test.mjs`, "E8-05: a message over MAX_MESSAGE_BYTES ..." |
| E8-06 | fixed | `tests/event-core-api-files.test.mjs`, "E8-06: protectPath removes pre-seeded ACEs ..." |
| E8-07 | fixed | `tests/private-scan.test.mjs`, the two "E8-07: ..." tests |
| E8-08 | not fixed: owner decision | none |
| E8-09 | fixed in service code | `tests/event-core-api-files.test.mjs` "E8-09: system tools ..."; `tests/event-core-streamerbot-credential.test.mjs` "E8-09 credential ..." |
| E8-10 | not fixed: documented limit | none |
| E8-11 | fixed for the terminal | `tests/event-core-streamerbot-cli.test.mjs`, the two "E8-11 ..." tests |
| E8-12 | fixed | `tests/event-core-streamerbot.test.mjs`, "E8-12: ..." |
| E8-13 | fixed | `tests/private-scan.test.mjs`, "E8-13: ..." |
| E8-14 | not fixed: by design | none |
| E8-15 | fixed | `tests/event-core-streamerbot.test.mjs` "E8-15 url check ..."; `tests/event-core-streamerbot-cli.test.mjs`, the two "E8-15 listen ..." tests |
| E8-16 | fixed (hardening; the fault did not reproduce) | `tests/event-core-streamerbot-credential.test.mjs`, "E8-16 credential ..." |

### E8-01: private scan decodes UTF-16 and scans binary data

- **Change:** `tools/git-hooks/private-scan.mjs`.
  - Text is decoded as UTF-8, or as UTF-16LE/BE when there is a BOM or a NUL pattern. The NUL pattern is checked
    over the first 64 KiB: at least 30% NUL bytes on one byte parity and at most 2% on the other.
  - Other files with a NUL byte are binary. They are scanned as raw bytes in five views: UTF-8, UTF-16LE and
    UTF-16BE, each UTF-16 view at byte offsets 0 and 1. Long terms allow gaps of up to 3 non-alphanumeric characters
    in binary data. Short terms match only inside printable runs of 4 or more characters, to avoid noise.
  - A binary hit is reported as `path:line: term #N (binary content, raw bytes)`.
  - Every item that is not scanned is listed as `label:1: skipped: <reason>`. An unreadable staged blob or a
    missing history object fails closed. A gitlink, a deleted file or a directory gets a note.
  - Every run prints a summary to stderr: items scanned, how many were UTF-16-decoded, how many binary, how many
    skipped.
- **Before / after** (`scan-files` with the invented profile; exit 1 = hit):

  ```
  before                       after
  c2-utf16.txt exit=0          c2-utf16.txt exit=1 :: file:1: term #1 (1 UTF-16 decoded)
  c7-nul.txt   exit=0          c7-nul.txt   exit=1 :: file:1: term #1 (binary content, raw bytes)
  ```
- **Real profile, final runs:**
  - `scan-worktree`: exit 0, 433 files, 0 hits, 21 binary scanned as raw bytes, 0 skipped.
  - `scan-history` (the only ref is `refs/heads/master`, 7 commits): exit 0, 342 items, 0 hits, 21 binary, 0 skipped.
  - So committed history has no hit and no history rewrite is needed.
  - Both runs: 7 terms loaded (0 short), 11 duplicates, 0 placeholders.

### E8-02: not fixed; ADR proposed

`docs/adr/2026-10-29-confirmation-channel.md` (Status: proposed) covers:

- the options: keep and document; a confirm credential held only by the UI; an out-of-band prompt; a
  different-credential rule;
- the recommendation: a UI-held confirm credential that is never written to `api.json`, plus the
  different-credential rule for destructive and on-air classes;
- the timing: decide before P4, server side in P4, UI side in P5.

Interim statement: **the api token has full authority, including the destructive raw-chat purge and on-air
confirmations.** Give it to nothing except the UI.

### E8-03: admission control for API connections

- **Change:** `services/event-core/api/server.mjs`.
  - New timeouts: headers 2 s, request 5 s, keep-alive 2 s, socket idle 2 s, and a pre-auth limit of 3 s from accept
    to the first authenticated request.
  - Unauthenticated connections go in a pending set with a cap of 128. When the set is full, the oldest pending
    connection is evicted, so a flood cannot hold every slot.
  - Authenticated connections have their own cap of 64, plus a reserve of 8 that only the system role can use. When
    the cap is reached, the request gets `503 too-many-connections`.
  - New stats: `pendingEvicted`, `pendingTimedOut` and `authedRefused`.
- **Before / after** (`probe-conn.mjs`, the reviewer's attack):

  ```
  before  F1 25 panic attempts over ~25 s under attack: 14 answered 200, others: ["ECONNRESET"]; attacker connections opened: 21674
  after   F1 25 panic attempts over ~25 s under attack: 25 answered 200, others: []; attacker connections opened: 910
  after   F1 (N=300 cycling half-open sockets) 25 panic attempts: 25 answered 200, others: []; attacker connections opened: 51071
  ```
- **Residual:** with a small `maxPending` (8), an attacker that opens new sockets faster than one client's
  connect-to-auth time can still evict that client (1 in 10 in a test). The default of 128 held in 5 of 5 runs.
  The full fix is an in-process panic path that does not use the socket (P4). Recorded as a known limit.

### E8-04: auth downgrade refused

- **Change:** `services/event-core/streamerbot/connector.mjs`.
  - A Hello without `authentication` is refused (`fatal('auth-expected')`, no reconnect loop) in two cases: when
    `authRequired` is set, or when the password store holds a non-empty password.
  - A password read error at that point gives `auth-password-read-failed`.
- **Before / after** (`probe-sb.mjs`, mock with `password: null`, stored password):

  ```
  before  B1: {"state":"connected","passwordReads":0}      B2 injected chat: {"published":2,"busSeen":1}
  after   B1: {"state":"auth-failed","passwordReads":1}    B2 injected chat: {"published":0,"busSeen":0}
  ```

### E8-05: inbound message size cap

- **Change:** `connector.mjs` exports `MAX_MESSAGE_BYTES = 1024 * 1024` (1 MiB, documented in the header).
  - The size is checked before `JSON.parse`.
  - A message over the cap is counted (`stats.oversize`) and noted (`message-oversize`). The socket is closed with
    code 4009, and the normal backoff reconnects.
  - A binary frame is counted (`stats.binary`) and dropped.
  - The test patches `JSON.parse` and confirms that an oversize message is never parsed. A message just under the
    cap is still accepted.
- **Before / after** (one 64 MiB chat frame on a connected session):

  ```
  before  B3:  {"state":"connected","rssDeltaMB":1370,"ms":4090}
  after   B3b: {"state":"connected","oversize":1,"published":0,"reconnects":1,"rssDeltaMB":194,"ms":4135}
  ```
- **Residual:** Node's built-in WebSocket (undici) has no receive-size option. The frame is still buffered by the
  transport (194 MB RSS for 64 MiB), but it is never converted, parsed or published. A transport-level cap needs a
  different WebSocket implementation (not installed, no installs). The peer is loopback by default (E8-15).

### E8-06: protectPath sets the DACL by SID and re-protects children

- **Change:** `services/event-core/config.mjs`.
  - `protectPath` now runs these steps:
    1. inheritance off, and full control for the current user's SID (`whoami /user`, read once per process);
    2. every other ACE on the item is removed by SID (read back with `icacls /save`);
    3. for a directory, everything already inside it is reset to inherit (`/reset /T /C`);
    4. the result is read back. `'acl'` is returned only when every DACL holds allow ACEs for that SID alone.
  - `ensureSecureDir` now re-protects every time, not only on create.
  - `audit/index.mjs` refuses to open on `acl-failed`.
  - `service.mjs` uses `ensureSecureDir` alone. The `listen` CLI uses it too (E8-15).
- **Before / after** (`probe-acl2.mjs`, temp dir with an explicit `BUILTIN\Users` RX ACE):

  ```
  before  protectPath: acl   after: [ '<current-user>', 'BUILTIN\\Users' ]
  after   protectPath: acl   after: [ '<current-user>' ]
  ```

  In the test, an existing directory has an inheritable `BUILTIN\Users` ACE, and a protected child file has an
  explicit `BUILTIN\Users` ACE and an `Everyone` deny ACE. After the fix, `icacls /save /T` (with the SID shown as
  `<ME>`) reads exactly:
  `D:PAI(A;OICI;FA;;;<ME>)`, `D:AI(A;ID;FA;;;<ME>)` (file), `D:AI(A;OICIID;FA;;;<ME>)` (subdir) and
  `D:AI(A;ID;FA;;;<ME>)` (nested file).
- **Limits:**
  - The owner is not changed. An owner keeps implicit READ_CONTROL and WRITE_DAC.
  - Administrators can take ownership by design.
  - `icacls /restore` with an SDDL file would set the DACL in one step, but it needs a privilege the user does not
    hold (error 1300 in the probe). So the DACL is set in the steps above.

### E8-07: short terms, separators, format characters, fullwidth forms, line breaks

- **Change:** `private-scan.mjs`.
  - Normalisation: strip `\p{Cf}` and U+034F, apply NFKC, then fold case.
  - Long terms (core of 4 or more characters) are matched on the alphanumeric skeleton. Any run of separators,
    including line breaks and CRLF, is allowed between letters. A hit is reported at the line where it starts.
  - Terms of 2-3 characters are matched as whole tokens (no letter or digit on either side). A 1-character term
    fails loudly at load.
  - Every run prints counts: terms loaded, short terms, placeholders, values without letters or digits,
    duplicates and non-string values.
- **Before / after** (invented profile):

  ```
  before: c3-sep3 exit=0  c4-fullwidth exit=0  c5-short exit=0  c6-split exit=0  c8-zwj exit=0
  after:  c3-sep3 exit=1  c4-fullwidth exit=1  c5-short exit=1 (term #2)  c6-split exit=1  c8-zwj exit=1
  ```

  The tests also cover a soft hyphen, a word joiner, ZWJ/ZWNJ, bidi controls, CGJ, mixed fullwidth, a CRLF split and
  a commit message.
- The real profile has 0 short terms, so E8-07 did not become fix-first.

### E8-08: not fixed (owner decision)

The moderation normaliser is unchanged. Legacy parity is the stated behaviour, so the owner decides whether to
diverge. The fix proposal above stands.

### E8-09: system tools by absolute path

- **Change:**
  - `config.mjs` `systemTool()` resolves tools from `%SystemRoot%\System32`. SystemRoot must be a local
    absolute `X:\` path, must agree with `%windir%` when that is set, and the tool must exist as a file. Otherwise it
    throws.
  - `icacls.exe` and `whoami.exe` (config.mjs) and `WindowsPowerShell\v1.0\powershell.exe` (credential.mjs) are run
    by that path.
  - A bogus SystemRoot gives `acl-failed`, or `credential-spawn-failed: no-system-powershell`. There is no PATH
    fallback.
- Tools (`tools/soak`, `tools/stray-procs.mjs`, `tools/lint.mjs`) are unchanged, as the finding allowed.

### E8-10: not fixed (documented limit)

The audit hash chain detects accidental damage, not deliberate tampering by a user who can write the file. There is
no HMAC key and no external head export.

### E8-11: terminal output escapes control and format characters

- **Change:** `services/event-core/cli.mjs` `displaySafe()`.
  - It replaces these characters with a visible `\u{XXXX}` text escape: C0 and C1 controls, `\p{Cf}` (bidi
    overrides and isolates, zero-width characters, soft hyphen, word joiner, BOM), line and paragraph separators,
    U+034F and the Hangul fillers.
  - `listen --show-text` applies it to the platform, the display name and the text.
  - Stored text and SSE are unchanged, as the finding allowed.
  - P5 overlays and the UI must still render names in an isolated bidi context.
- **After:** a name with U+202E and a text with U+2066 print as `[twitch] Tro\u{202E}jan: hello\u{2066}there`. No raw
  bidi character reaches the terminal (CLI test).

### E8-12: backoff resets only after a stable connection

- **Change:** `connector.mjs`. The attempt counter resets only after the connection has stayed up for
  `STABLE_MS = 30 000` ms after Subscribe, not on Subscribe.
- **Before / after** (`probe-sb.mjs` B4, the mock kills the socket as soon as Subscribe lands, 10 s):

  ```
  before  {"drops":15, ... "reconnects":15}
  after   {"drops":4,  ... "reconnects":4}
  ```

  The test checks that the waits grow 40, 80, 160, 320, 640 ms. It also checks that after a stable period the wait
  returns to the base.

### E8-13: pre-push uses the checked-out hook tooling

- **Change:** `private-scan.mjs`.
  - For pre-push and scan-history, the label validator code (`tools/label/labels-export.mjs`,
    `tools/label/schema-lite.mjs`, `data/labels.schema.json`) is read from the working tree at hook start. Label
    data still comes from the pushed tip.
  - The hook prints which validator it used, for example:
    `private-scan: label validator code from the checked-out hook tooling (working tree at hook start): tools/label/labels-export.mjs 27a9544c76c0, ...`
  - The test pushes a commit that loosens the validator. The push is still blocked, and stderr names the tooling.

### E8-14: not fixed (by design)

A token holder can still use up the 16 SSE slots. This falls under the E8-02 interim statement.

### E8-15: listen data-dir protection and non-loopback URLs

- **Change:**
  - `listen` calls `ensureSecureDir` on the data dir before the fixture recorder is created. On `acl-failed`, it
    prints a warning and turns fixtures off.
  - `checkUrl` refuses a non-`ws:`/`wss:` URL, and a `ws://` URL to a non-loopback host unless `allowRemote` is set.
    Loopback means `127.0.0.0/8`, `localhost` or `[::1]`. It throws a RangeError when the connector is created and
    in `startService` before anything starts.
  - The CLI flag `--allow-remote` (listen and serve) allows a remote host and prints a warning.
- **After:**
  - `listen --url ws://192.0.2.10:8080/` exits 1 with `refused: ... non-loopback`, and nothing is contacted.
  - With `--allow-remote`, it runs and warns.
  - In the ACL test, an existing data dir with a seeded `BUILTIN\Users` ACE holds only the current user's SID after
    `listen`, including the fixture files.

### E8-16: credential crosses PowerShell as base64

- **Change:** `credential.mjs`.
  - `get` writes `base64(UTF-8(secret))` and `set` reads the same format from stdin. Node decodes and validates the
    base64 and fails with `credential-read-failed: bad-output` if it is malformed.
  - The stored format (UTF-16LE blob) is unchanged.
- **Before / after** (`probe-cred.mjs`, TEST-ONLY target, deleted after):

  ```
  before (cp 850 and cp 437)  ascii/latin1/cjk_euro_emoji/rtl_mixed: match=true; deleted: true
  after                       ascii/latin1/cjk_euro_emoji/rtl_mixed: match=true; deleted: true
  ```

  The original fault did not reproduce on this machine, even under `chcp 437`. The base64 path removes the
  dependency on the console code page anyway. The new test round-trips CJK, euro, emoji, sharp s, RTL, quotes, `$`,
  backtick and leading/trailing spaces.

### Runs

- `npm run lint`: `lint: 0 finding(s), 26 allow marker(s)`.
- `npm test`: `tests 711, pass 711, fail 0, cancelled 0, skipped 0`.
- `private-scan.mjs scan-worktree`: exit 0, 0 hits. `scan-history`: exit 0, 0 hits (see E8-01).

### Note: raw invisible characters in other files (not changed)

Some files that this task did not touch contain raw (unescaped) format characters (U+200B to U+200F, U+202A to
U+202E, U+2066 to U+2069, U+FEFF, U+00AD, U+2028, U+2060) inside string or regex literals:

- `services/event-core/moderation/text.mjs:9`
- `tests/event-core-model.test.mjs`
- `tests/event-core-moderation-text.test.mjs`
- `tests/event-core-moderation.test.mjs`
- `tools/parity/moderation-parity.mjs`

They behave the same as escapes, but they are invisible in review (a Trojan Source-style risk). Writing them as
escapes, and adding a lint rule, is proposed and not done. The files changed by these fixes hold escapes only.

### Files created or changed by the fixes

- Created: `docs/adr/2026-10-29-confirmation-channel.md`.
- Changed:
  - `tools/git-hooks/private-scan.mjs`
  - `services/event-core/api/server.mjs`
  - `services/event-core/api/service.mjs`
  - `services/event-core/audit/index.mjs`
  - `services/event-core/config.mjs`
  - `services/event-core/cli.mjs`
  - `services/event-core/streamerbot/connector.mjs`
  - `services/event-core/streamerbot/credential.mjs`
  - `tests/private-scan.test.mjs`
  - `tests/event-core-api.test.mjs`
  - `tests/event-core-api-files.test.mjs`
  - `tests/event-core-streamerbot.test.mjs`
  - `tests/event-core-streamerbot-cli.test.mjs`
  - `tests/event-core-streamerbot-credential.test.mjs`
  - this file (the Fixes section).
