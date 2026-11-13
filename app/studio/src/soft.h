// SPDX-License-Identifier: GPL-3.0-or-later
// Soft surfaces (D376): the raised plates, pills and round controls of a pack with a "surface" block (theme.h Surface;
// the Soft pack). Painted behind the widget's own paint from an event filter, never with a QGraphicsEffect, so text
// always lands on an opaque face (ClearType stays on) and nothing is drawn through an offscreen picture:
//   shadow layers  halo (light, up-left), wide soft shadow, tight contact shadow; the warm glow halo for active controls.
//                  Built once per kind, corner radius, tone and device pixel ratio as a 9-slice picture (blurred
//                  properly, three box passes) and drawn as nine pieces.
//   face           a vertical gradient, a 1 px light edge along the top fading into a darker edge along the bottom.
//   warm glow      a checked button lights its face; a row whose switch is on glows from the knob onto the plate and a
//                  little past its edge. Hover and press fade in the theme's fast time (motion.h; at once when off).
// Kinds: card (QGroupBox, QFrame#card), small (QFrame#strip / #statCard / #lookCard; the theme cards paint themselves), plate (a plain QWidget
// row that holds a Switch), pill (QPushButton except #tb / #taskClose), round (QPushButton#round). The room around each
// face for its shadow is room(kind): the stylesheet gives the same margin (theme.cpp), a plate gets it as contents margins.
// Reduced effects: no shadows or glow. High performance: flat faces only.
#pragma once

#include <QMargins>
#include <QPointF>

class QWidget;

namespace soft {

enum class Kind { None, Card, Small, Plate, Pill, Round };

Kind kindOf(const QWidget *w);
QMargins room(Kind k);       // logical px around the face for its shadow (from the pack's surface margins)
void attach(QWidget *w);     // Polish / theme switch: a painter for w when the pack has surfaces and w is one of the kinds
void refreshAll();           // after a theme or effects switch: drop the cached pictures, attach, repaint
bool owns(const QWidget *w); // a soft painter draws w's face now (motion's hover overlay stays out of the way)
QPointF state(const QWidget *w); // (probe) hover and press of w's painter, 0..1 each; (-1, -1) without a painter
int count();                 // widgets with a painter while surfaces are on (probe)
int cached();                // cached shadow pictures (probe)
void dropCache();            // (bench) forget the cached pictures: the next paints build them again

} // namespace soft
