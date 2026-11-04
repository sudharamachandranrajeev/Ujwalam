# CEF / Chromium credits sourcing (2026-11-05, follow-up to licence-verification.md)

Picked up the one remaining open item from `docs/evidence/2026-11-05-licence-verification.md`:
"CEF/Chromium credits text still missing; no source found in the shipped runtime."

## What's verified, real, and checked in
- `docs/licenses/CEF-LICENSE.txt` — the Chromium Embedded Framework's own
  licence (BSD-3-Clause, copyright Marshall A. Greenblatt + Google Inc.),
  fetched verbatim from `raw.githubusercontent.com/chromiumembedded/cef`
  and cross-checked against Google's own support page (identical text).
  This is the licence for the CEF wrapper layer itself, exactly what the
  existing third-party-notices.md row already named.
- `docs/licenses/CEF-CHROMIUM-CREDITS-source.md` — Google's own published
  generated credits listing for "Chromium Embedded Framework (Linux)"
  (`support.google.com/webdesigner/answer/10125509`), 689 KB, listing each
  third-party component Chromium bundles with its own licence text (Abseil
  under Apache-2.0, the 2-dim FFT package, and so on — hundreds of entries).
  This is the real, official, Google-generated equivalent of `chrome://credits`
  made publicly fetchable without running a browser.

## Caveat — not a perfect match, flagged honestly
This credits page is labelled **Linux**, and lists whatever CEF/Chromium
version Google generated it for at the time — **not necessarily the exact
CEF build OBS Studio 32.1.2 vendors on Windows** (OBS 33.0's release notes
say OBS jumped CEF 127 -> 150 in that release, implying 32.1.2 shipped
somewhere in the CEF ~127 range, but this wasn't independently confirmed
against the actual `libcef.dll` in the runtime — no version string was
found in it during the 2026-11-05 binary inspection). The *licence terms*
for Chromium's bundled components rarely change which licence applies
version to version (component set grows/shrinks, licence family is stable),
so this is a reasonable, honestly-sourced placeholder — but it is not
byte-for-byte the credits for this exact build. Mark as **best-available,
not UNVERIFIED-and-ignored**.

## Recommendation for before any real distribution
Generate the exact match either by:
1. Loading `chrome://credits` inside the actual bundled `libcef.dll` (via
   `obs-browser-page.exe` or a minimal CEF host) and saving that HTML, or
2. Running Chromium's own `tools/licenses/licenses.py credits` against the
   Chromium source tag OBS 32.1.2's CEF was built from (needs the full
   Chromium source tree — heavy, likely a Phase-2/pre-GA task, not alpha).

Neither was done in this session (both need either a running CEF process
or a multi-GB source checkout); flagging as the honest next step rather
than skipping it.

## Changes made this session
- `docs/licenses/CEF-LICENSE.txt`, `docs/licenses/CEF-CHROMIUM-CREDITS-source.md` added.
- `tools/package/build-alpha.mjs`: now copies both into the zip's `notices/`
  folder when `libcef.dll` is present in the file list.
- `docs/third-party-notices.md`: CEF/Chromium row updated from
  "UNVERIFIED: the runtime has no CEF credits file, so the zip carries
  none" to "best-available, sourced 2026-11-05, platform/version caveat
  noted" with a pointer to this file.
