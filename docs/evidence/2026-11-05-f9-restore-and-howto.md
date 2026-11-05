# F9: restore tool and how-to (2026-11-05)

## Built

- `tools/restore-local.mjs`: `list`, `verify <archive>`, `restore <archive> [--to DIR]`, `apply [--from DIR] [--to ROOT] --confirm "yes, restore"`. Reuses `findSevenZip`, `CREDENTIAL_TARGET` from `tools/backup-local.mjs`; backup_dir from `data/profile.local.json`; password from Credential Manager `Ujwalam/backup`, to 7-Zip on stdin only; `windowsHide: true`.
- `restore` extracts into `%LOCALAPPDATA%\Ujwalam\restore\<timestamp>` (refuses a non-empty dir); touches no live file.
- `apply` needs the exact confirmation; each replaced file moves to `<root>/_to_delete/<timestamp>/<path>` first; nothing is deleted; paths escaping the root are refused.
- `npm run restore` added to `package.json`.
- `docs/how-to.md` written; `tools/package/build-alpha.mjs` ships it as `HOW-TO.md` (`TOP_FILES` in `tools/package/manifest.mjs` extended).

## Tests

```
node --test tests/restore-local.test.mjs tests/package-alpha.test.mjs
ℹ tests 19  ℹ pass 18  ℹ fail 0  ℹ skipped 1   (skipped: full build, needs UJWALAM_PACKAGE_E2E=1)
node tools/lint.mjs
lint: 0 finding(s)
```

Real CLI smoke (no password read, no 7-Zip run):

```
node tools/restore-local.mjs bogus                       -> usage, exit 64
node tools/restore-local.mjs apply --from /nonexistent   -> restore: refused: pass --confirm "yes, restore", exit 64
node tools/restore-local.mjs apply --from /nonexistent --confirm "yes, restore" -> restore: staging dir not found, exit 1
npm run restore --silent -- list                         -> 3 archives, newest first, size and date, exit 0
```

## UNVERIFIED

- Real `7z x` extraction with the real password and an encrypted-header archive (tests use a fake runner). The extract call passes the password twice on stdin (header plus data prompt) and `-p` with no value, the same way backup does.
- Real hotkey key presses (code defaults checked: `app/host/src/host_config.h`).
- Backup, restore, clipper and posting are not in the zip (manifest has no `tools/backup-local.mjs`, `tools/restore-local.mjs` or `.py`); the how-to says they run from the source checkout.
- The full zip build with `HOW-TO.md` was not run (needs host exe and OBS runtime); only the allowlist/forbidden checks and the packager source are asserted.
- CI was not run (a full CI was in progress).

## Files

Created: `tools/restore-local.mjs`, `tests/restore-local.test.mjs`, `docs/how-to.md`, `docs/evidence/2026-11-05-f9-restore-and-howto.md`.
Changed: `package.json`, `tools/package/build-alpha.mjs`, `tools/package/manifest.mjs`, `tests/package-alpha.test.mjs`.
