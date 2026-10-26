# Licence headers and publishing rules

Ujwalam is licensed GPL-2.0-or-later (`LICENSE`, `package.json`). The full licence text in `LICENSE` is still a placeholder (short form with SPDX id and FSF URL).

D3 (personal tool vs product) is settled as "personal first, product-ready architecture", but distribution (installer, GPL release) is deferred to P17, so licence work here is preparation only.

## Header rule

Every source file starts with an SPDX header in the language's comment form:

| Language | Header |
|---|---|
| JS / MJS / TS / C / C++ / QML | `// SPDX-License-Identifier: GPL-2.0-or-later` |
| Python / shell / YAML / TOML | `# SPDX-License-Identifier: GPL-2.0-or-later` |
| HTML / XML | `<!-- SPDX-License-Identifier: GPL-2.0-or-later -->` |
| CSS | `/* SPDX-License-Identifier: GPL-2.0-or-later */` |
| PowerShell | `# SPDX-License-Identifier: GPL-2.0-or-later` |

JSON cannot carry comments; its licence is covered by the repo `LICENSE`. Files under `legacy/` are not headered (read-only reference).

## Never publish

- `legacy/`: private reference copy of Meld Schenanigans; never distributed. It may contain personal paths and channel details.
- Microsoft fonts **Corbel** and **Consolas**: not redistributable. Themes reference them by name only; never bundle the files.
- Excluded from the legacy copy and never to be committed: `engage/logs/`, `engage/memory/` (viewer data), `brand/secrets.local.js`, `.claude/settings.local.json`.

## Fonts found in `legacy/brand/fonts/`

| File family | Licence evidence in repo | Status |
|---|---|---|
| Black Ops One (`BlackOpsOne-Latin-400.woff2`) | `LICENSE-BlackOpsOne-OFL.txt` states SIL OFL 1.1 | OFL believed; text present in legacy, still UNVERIFIED until compared with upstream |
| Baloo Chettan 2 (Latin + Malayalam, 500/700/800) | `LICENSE-BalooChettan2-OFL.txt` states SIL OFL 1.1 | OFL believed; UNVERIFIED |
| Alfa Slab One (`AlfaSlabOne-Latin-400.woff2`) | `LICENSE-AlfaSlabOne-OFL.txt` states SIL OFL 1.1 | OFL believed; UNVERIFIED |
| Luckiest Guy (`LuckiestGuy-Latin-400.woff2`) | `LICENSE-LuckiestGuy.txt` is the Apache License 2.0 text | Apache-2.0 believed; UNVERIFIED |

All four are UNVERIFIED: the licence file names a licence, but the woff2 subsets were not checked against upstream. Verify before any distribution. If a font is bundled, ship its licence file beside it.
