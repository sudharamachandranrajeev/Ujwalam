// SPDX-License-Identifier: GPL-3.0-or-later
// Studio look (D285): dark violet panels with rounded cards and a purple accent, after the user's reference video
// (data/stream assets/Stream layout, local only). One place for every colour the shell uses.
#pragma once

class QApplication;

namespace theme {

// Colours (#rrggbb), shared by the stylesheet and the few widgets that colour themselves.
inline constexpr const char *kBg = "#14121c";      // window
inline constexpr const char *kPanel = "#1b1926";   // cards (group boxes, lists)
inline constexpr const char *kField = "#242132";   // inputs, buttons
inline constexpr const char *kBorder = "#2f2b42";
inline constexpr const char *kText = "#e9e7f2";
inline constexpr const char *kMuted = "#8c88a3";
inline constexpr const char *kAccent = "#9a6bff";  // primary actions, selection
inline constexpr const char *kAccentHi = "#b18cff";
inline constexpr const char *kDanger = "#e5484d";  // live, recording
inline constexpr const char *kOk = "#3ccf91";

// Fusion style, a dark palette and the stylesheet. Buttons with the dynamic property role=primary|danger get the
// accent or red fill; labels named "pill" are status chips; labels named "heading" are small upper-case captions.
void apply(QApplication &app);

} // namespace theme
