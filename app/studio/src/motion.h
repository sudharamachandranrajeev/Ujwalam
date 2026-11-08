// SPDX-License-Identifier: GPL-3.0-or-later
// Motion helpers (D287): short eased animations for the studio shell. Nothing here runs while the UI is idle: every
// animation is started by a change (hover, a task finishing, a chip changing colour) and ends by itself, except the
// task chip's pulse and the indeterminate bar sweep, which run only while a task is running and the widget is visible.
// Motion is skipped (final state at once) when Windows "animation effects" are off (SPI_GETCLIENTAREAANIMATION),
// when UJWALAM_REDUCE_MOTION=1, or when the widget is not shown (headless probe).
#pragma once

#include <QColor>
#include <QEasingCurve>
#include <QVariant>
#include <functional>

class QApplication;
class QLabel;
class QObject;
class QVariantAnimation;
class QWidget;

namespace motion {

bool systemAnimations();           // Windows setting + UJWALAM_REDUCE_MOTION
bool enabled(const QWidget *w);    // systemAnimations() and w is visible

QColor mix(const QColor &a, const QColor &b, qreal t);

// One-shot animation of a value from..to (qreal, QPointF, QColor ...). Parent owns it and it deletes itself when done.
// When motion is off, step(to) and done() run at once. Returns the animation (nullptr when skipped).
QVariantAnimation *run(QWidget *context, const QVariant &from, const QVariant &to, int ms, QEasingCurve::Type curve,
		       std::function<void(const QVariant &)> step, std::function<void()> done = {});

// Hover glow on buttons and cards: a mouse-transparent overlay child that fades in/out (180 ms) on enter/leave.
// Installed once for the whole app: any shown QPushButton / QToolButton / QFrame#strip gets one.
void installHover(QApplication &app);

// A status chip (QLabel#pill) that fades between its normal look and a filled colour.
void setChip(QLabel *chip, bool on, const QColor &fill);

} // namespace motion
