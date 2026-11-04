# Meld import: wrapper-less session file (D145, D206)

Date: 2026-11-04. Main session. Status: PASS on tests and on the real local session files (counts only; no names or values read out).

## Finding

The two Meld session shapes carry two different version fields:

| File (local, read-only) | Outer `version` | Inner `session.version` | Scenes |
|---|---|---|---|
| `legacy/meld/session-backups/*.json` (6 files, 2026-09-29) | 1 | 3 | 10 |
| Meld package `session.bak.json` (2026-04-07) | 1 | 2 | 10 |
| `session file/` copy (2026-10-26, live file shape) | absent | 3 | 12 |

The outer field is the wrapper format; the inner field is the session schema. The importer checked only the outer one, so the wrapper-less live file was refused ("unsupported Meld session version undefined"). The 2026-11-03 note that the inner version was 1 was wrong.

## Change

`services/project/import-meld.mjs`: an outer `version` must be 1, as before. Without one, the inner schema version must be 2 or 3 (both seen and imported); anything else is refused, not guessed. The report carries `sessionVersion` (outer, or null) and `sessionSchemaVersion` (inner).

## Evidence

```
node --test tests/project-import-meld.test.mjs
ℹ pass 14
ℹ fail 0
```

New and changed tests: the wrapper-less shape gives the same project as the wrapped one; a missing or unknown inner version (4) is refused.

Real files through `importMeld` (counts only, scratch script outside the repo):

```
session file/ (wrapper-less, schema 3): scenes 12, V merged 12, layers seen 390, imported 154, paired 13, devices 7, audio 47, overlays 5, skipped 199, warnings 3
legacy session backup (wrapped, schema 3): scenes 10, V merged 10, layers seen 355, imported 150, paired 13, devices 7, audio 43, overlays 3, skipped 177, warnings 3
```

Open: the skipped layers are the same kinds as in the 2026-10-30 import evidence (unmapped Meld kinds); not re-reviewed here. No scene, layer or setting was changed: the importer only reads.
