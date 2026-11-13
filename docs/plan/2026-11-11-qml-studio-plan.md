# 2026-11-11 — Studio UI in Qt Quick (QML): plan

Source: the user's answer to the UI audit (`2026-11-11-ui-modernisation-audit.md`): option 2 (Qt Quick), much faster than 6–10 weeks, no multi-agent work, no loss of quality. The web control page follows the studio theme.
Status: **approved by the user on 2026-11-11 (D355).**

## Approach

One agent (the main session) does all the work, in order. Each step builds on the one before. Nothing is redone in the old widgets.

- **Keep the C++ core.** The host connection, API client, settings logic and theme loading stay. The QML screens are a new view on top of them.
- **Same routes, no split (D360).** The QML screens call the UI server routes the widget studio calls, with the same rules, kept in one QML state object (`app/studio/qml/Store.qml`). The widget code is not moved or changed.
- **Previews stay native.** The host's preview windows are placed as child windows of the QML window, at the rectangle a QML `PreviewSlot` item reports. This is the same `SetParent` path the embedding uses today. Menus and popups that overlap a preview open as their own windows (`Popup.Window`, Qt 6.8), so a preview never covers them.
- **One theme source.** A QML `Theme` singleton reads the existing theme data, so all 9 themes carry over. The web page's `tokens.css` is generated from the same data, so the control page follows the studio theme.
- **Style.** A custom Qt Quick Controls style built on Basic, driven only by theme tokens. Inter for text, Barlow only for headings and numbers. Sentence case. No letter-spacing on body text. One surface level per panel instead of stacked rims and glows.
- **No install needed.** Qt 6.8.3 in `_vendor` already has Quick, Controls 2, Layouts, Effects and Shapes.
- **Behind a flag.** The QML studio ships behind `studio-qml` (off by default; switchable). The widget studio stays the default until the parity checklist passes. Then QML becomes the default, and the widget code is removed one release later.

## Steps

| Step | What | Done when |
|---|---|---|
| Q1 | Bridge (changed by D360, replaces "models"): the QML screens call the same UI server routes through the same `ApiClient` (`QmlApi`), read the theme packs (`QmlTheme`), draw the shared icons and embed the host previews (`PreviewView`). The widget studio is not changed. | All current studio tests pass unchanged. |
| Q2 | Main window: the shell, the previews in `PreviewSlot`s, scenes, layers, the mixer, and an on-air bar (LIVE state, timer, bitrate, dropped frames, a Go Live button and a Record button with labels). The audit's fixes are built in: no clipped text, a full mixer label, real visibility icons, and one Add/Remove place. | Headless probe of the QML tree; a real-screen screenshot at the user's DPI. |
| Q3 | Settings: one window with a left list and a search box, with every current page. No sideways scrolling. Plain words only: no D-numbers or file paths on the flags page or in Posts. | Every settings test that passes on the widget studio has a QML twin that passes. |
| Q4 | Other screens: clips and posts, connections, the scene builder, dialogs. A command palette (Ctrl+K) and scene hotkeys. A status bar in plain words. | The parity checklist is complete. |
| Q5 | Web control page: `tokens.css` generated from the theme, and the page restyled to match the studio. | The web page test passes, and both are checked side by side on the real screen. |
| Q6 | Switch: QML becomes the default after a real stream with no high-severity feedback. The widget code is removed one release later. | Live evidence. |

## Estimate (UNVERIFIED)

About 8–12 working sessions in total. Q1 and Q2 are the biggest steps (about 4–5 sessions). A first usable QML main window is ready behind the flag after Q2. The real-stream switch (Q6) depends on when the user streams.

## Risks

- **Live-path safety.** The models touch the code that starts and stops streams. Q1 changes no behaviour, and every step keeps the stream controls on the existing tested code paths. The Codex second opinion runs on Q1 and Q2 before merge.
- **Native previews in a QML window.** Embedding was tested on the widget window only. Q2 starts with this, so any blocker shows up on day one.
- **Test rewrite.** The widget-probe tests need QML twins (an `objectName` probe of the QML tree). They are written alongside each screen, not at the end.
