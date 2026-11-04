# Licence verification: FFmpeg build flags, Qt version, CEF credits (2026-11-05)

Session: Hermes WhatsApp, branch `hermes/licence-audit`. Follows up the
UNVERIFIED rows in `docs/third-party-notices.md` and the open item from
D133 ("Open before distributing the zip to anyone").

## Method
Inspected the actual built OBS runtime shipped in
`out/dist/ujwalam-0.1.0-alpha.1-win64/obs/` (not source, not assumptions):
read embedded ASCII strings out of the DLLs directly (`grep -a`), since
`strings` isn't on this machine's PATH.

## Finding 1 — FFmpeg build flags (resolves the "which" UNVERIFIED row)
`bin/64bit/avcodec-61.dll` contains its own build configuration string:

```
--enable-libmp3lame --enable-w32threads --enable-version3 --enable-gpl
--enable-libx264 --enable-libopus --enable-libvorbis --enab[...truncated]
```

- `--enable-gpl` is present (confirmed, 1 match).
- `--enable-nonfree` is **absent** (0 matches).
- `--enable-version3` is present.

Per FFmpeg's own licensing documentation: `--enable-gpl` alone makes the
build GPL-2.0-or-later (because of `libx264`); adding `--enable-version3`
**upgrades the applicable GPL/LGPL version to 3** for the whole build.
`--enable-nonfree` is absent, so this is not a proprietary/non-free build.

**Conclusion: this FFmpeg build is GPL-3.0-or-later, not GPL-2.0-or-later
and not LGPL.** The existing `third-party-notices.md` row ("LGPL-2.1-or-later,
or GPL-2.0-or-later if built with GPL parts... UNVERIFIED which") is wrong
on both counts and needs correcting (done in this change).

## Finding 2 — Qt version
`bin/64bit/Qt6Core.dll` contains the string `Qt 6.8.3`. Confirms the Qt
row's "LGPL-3.0-only" licence call was already right; only the version
number was unconfirmed. Modules present: `Qt6Core.dll`, `Qt6Gui.dll`,
`Qt6Widgets.dll` — matches the notices doc's existing list, no extra
modules found.

## Finding 3 — x264
`bin/64bit/libx264-164.dll` present (build 164). Licence GPL-2.0-or-later,
unchanged from the existing notices row; compatible with the FFmpeg
GPL-3.0-or-later determination above (x264 is "-or-later").

## Finding 4 — CEF/Chromium credits: still open, not resolved
Searched `obs-plugins/64bit/` for any CEF/Chromium license or credits file
(`*license*`, `*credits*`, `*.pak` contents not decompiled). Found only
the resource `.pak` files (`chrome_100_percent.pak`, `chrome_200_percent.pak`,
`resources.pak`, `locales/en-US.pak`) and `libcef.dll` itself — **no
LICENSE.txt or credits.html ships with this runtime.** This matches what
the existing notices doc already said ("the runtime has no CEF credits
file, so the zip carries none"). Not resolved by this session — the
Chromium/CEF credits text (BSD-3-Clause for CEF's own wrapper, plus dozens
of embedded third-party licences for Chromium itself) isn't obtainable by
inspecting this runtime; it would need sourcing from the CEF distribution
page (https://cef-builds.spotifycdn.com/index.html) or generating it from
a running `chrome://credits`-equivalent page, neither done here.

## IMPORTANT — flags a conflict with the just-committed top-level LICENSE
D212 (commit just before this session) filled the repo's top-level
`LICENSE` with the verbatim **GPL-2.0** text. Given Finding 1, the shipped
FFmpeg subset is actually **GPL-3.0-or-later**. OBS itself and its plugins
are GPL-2.0-or-later ("-or-later", so GPL-3 compatible), and x264 is also
"-or-later". Combining a GPL-3.0-or-later component (FFmpeg, as built) with
GPL-2.0-or-later components in one distributed work generally means the
**combined work must be distributed under GPL-3.0** (the stricter,
compatible option both sides allow) — not GPL-2.0 as D212 currently has it.

**This is not acted on in this session** — changing the top-level `LICENSE`
reverses a very recent, explicit decision (D212) and has real legal
weight; it needs the user's (or the next strongest-tier session's) review,
not a unilateral fix from here. Recommendation: re-run D212 with
`docs/licenses/GPL-3.0.txt` (added this session) instead of GPL-2.0 text,
after confirming this reasoning.

## Changes made this session
- `docs/licenses/GPL-3.0.txt`, `docs/licenses/LGPL-3.0.txt` added (verbatim
  FSF text, fetched from gnu.org 2026-11-05).
- `docs/notices-qt-relinking.md` — Qt LGPL-3.0 relinking compliance note.
- `docs/third-party-notices.md` — FFmpeg row corrected to GPL-3.0-or-later
  with the verified build-flag evidence; Qt row version confirmed 6.8.3.
- **Not changed:** top-level `LICENSE` (flagged above, needs review).
- **Not resolved:** CEF/Chromium credits text (needs external sourcing).
