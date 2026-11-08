// SPDX-License-Identifier: GPL-3.0-or-later
// Depth effects (D293): shadow, glow and a 3D extruded edge, drawn by one custom QGraphicsEffect per widget because Qt
// allows only one effect per widget. Which widget gets which class comes from rules (classFor) or from the widget's
// "depth" property; what the class looks like comes from the theme pack. Used sparingly:
//   shadow     on floating things (toasts, task list, cards, round controls)
//   glow       on primary or active things only (the pack's "when": always | active | hover | focus)
//   extrusion  on round controls and primary buttons (the packs that want a bevel)
// The effect redraws only when the widget changes or a state animation (hover, press, glow) runs; nothing runs idle.
// Widgets that repaint often (previews, meters, sliders, lists) never get one: they are not in classFor and the property
// "noDepth" = true opts any widget out. "Reduced effects" (ui.effects) removes every effect.
#pragma once

#include <QString>

class QWidget;

namespace depth {

// The class a widget gets by the rules, or empty: QFrame#card/#statCard, #toast, #taskPanel, QPushButton#round,
// QPushButton role=primary, plain QPushButton. The property "depth" on the widget wins.
QString classFor(const QWidget *w);

// Attach (or refresh) the effect for class cls on w; empty cls, reduced effects or an empty class in the pack remove it.
// Also makes room around the widget in its parent's layout margins when a shadow or glow would be cut off.
void attach(QWidget *w, const QString &cls);

// Re-evaluate every widget in the application after a theme or effects change.
void refreshAll();

// Number of widgets that currently carry an effect (probe).
int count();
// Widgets that would carry an effect under the current theme and effects mode, shown or not (probe).
int eligible();

// Repaint-cost measurement (tests/evidence): paint w this many times, return the mean ms per paint.
double measurePaint(QWidget *w, int repeats);

} // namespace depth
