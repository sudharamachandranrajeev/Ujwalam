// SPDX-License-Identifier: GPL-3.0-or-later
// Central interaction feedback and window decoration (D293), installed once on the QApplication. Nothing here touches
// a widget by hand:
//   - first show of a widget: it gets its depth class (depth.cpp) and caption fonts (heading, stat names, control
//     captions: size, letter spacing and caps from the theme pack)
//   - first show of a main window or dialog: the theme's background (gradient, grid, dots, scanlines, diagonal) is
//     painted behind its widgets, drawn by Qt, no image files
//   - a menu, dialog or tooltip opening fades in (menus also slide 6 px); the durations and easing are the theme's
//   - hover, press and focus feedback is in motion.cpp (overlay) and depth.cpp (lift, sink, glow)
// All of it is skipped (final state at once) when motion is off or reduced, and none of it runs while the UI is idle.
#pragma once

class QApplication;

namespace interaction {

void install(QApplication &app);
// After a theme change: caption fonts and backgrounds are applied again to every open widget.
void refresh();

} // namespace interaction
