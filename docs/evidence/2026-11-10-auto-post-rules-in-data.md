# Auto-post rules live in the data dir (2026-11-10)

Branch `post/rules-in-data` (from `claude/alpha0-d1`).

## Change

- User rules: `<dataDir>/posting/auto-post-rules.json` (installed app: `%LOCALAPPDATA%/Ujwalam/data/core/posting/auto-post-rules.json`). Survives updates; the CLI and the studio read the same file.
- `rulesFileFor(dataDir, explicit)` in `services/posting/auto-post.mjs`: explicit file wins; else the user file if it exists; else the shipped template `data/posting/auto-post-rules.json` (empty rules). A user file that exists is always the one loaded, so an invalid one fails closed (`bad-rules`, `rules-unreadable`, chain `bad-rules`, preview `preview-unavailable`); there is no silent fallback to the template.
- Used by `services/posting/cli.mjs` (`auto`, `auto --preview`), `services/posting/auto-chain.mjs` (step), `services/studio-ui/server.mjs` (`/ui/api/posts/auto`, `/ui/api/posts/auto/preview`). Test seams `--rules`, `opts.rulesFile`, `opts.autoRulesFile` unchanged and still win.
- `node services/posting/cli.mjs auto --init-rules [--data-dir DIR]`: copies the template to the user path only if absent (`COPYFILE_EXCL`), prints the path either way.
- `rules file: <path>` printed in `auto` dry run and `auto --preview` text; `rulesFile` in the `--preview --json`, `/ui/api/posts/auto` and `/ui/api/posts/auto/preview` JSON.
- Native studio Posts dialog (`app/studio/src/main_window.cpp`, `openPosts`): the auto-post line shows the rules file; new "Preview auto-post rules" button does a read-only GET of `ui/api/posts/auto/preview` and shows queued (id, target, kind, rule, publish time) and skipped (reason) lines, 12 each at most.
- `$comment` in `data/posting/auto-post-rules.json` says where the user copy lives.

## Tests

New: `tests/posting-rules-in-data.test.mjs` (8 tests): template when absent, user file when present, explicit wins, invalid user file fails closed (function, CLI dry run, CLI preview, chain, studio routes), `--init-rules` creates once and never overwrites, preview prints and returns the path.

```
node --test tests/posting-rules-in-data.test.mjs tests/posting-auto.test.mjs tests/posting-preview.test.mjs tests/posting-uploads.test.mjs tests/posting-auto-chain.test.mjs tests/guide.test.mjs tests/studio-ui-posting.test.mjs tests/studio-ui-posting-queue.test.mjs tests/studio-ui-server.test.mjs
ℹ tests 116   ℹ pass 116   ℹ fail 0   ℹ skipped 0
```

(A first run had 1 failure in `posting-auto.test.mjs`: it expects the dry-run header as output line 0; fixed by printing `rules file:` as line 1.)

```
node tools/ci.mjs --quick
build PASS, lint PASS, build-host PASS, build-studio PASS, validate-registry PASS, validate-outputs PASS,
validate-games PASS, private-scan PASS, legacy-verify PASS
ci: 9/9 passed in 73.8s
```

Studio: `node app/studio/tools/build.mjs` compiled main_window.cpp (build-studio PASS in CI quick).

## Studio shell

```n$ node --test tests/studio-qt-shell.test.mjs   (rebuilt studio exe with the change)
ℹ tests 47  ℹ pass 47  ℹ fail 0  ℹ skipped 0
```

## Not verified

- The new Posts-dialog button and rules-file line compile and the shell tests pass, but no test opens the Posts dialog and clicks Preview; not exercised by hand.
