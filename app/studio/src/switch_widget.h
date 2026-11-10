// SPDX-License-Identifier: GPL-3.0-or-later
// An on/off switch: a pill with a knob that slides (motion.h; at once when motion is off). Theme tokens only
// (border, accent, accentHi, text). Shows ON / OFF in words beside the knob. Used by the Look panel (D290), the Outputs
// panel (D327 OS3) and the Settings switch rows (D331, N2).
#pragma once

#include <QAbstractButton>

class Switch : public QAbstractButton {
public:
	explicit Switch(QWidget *parent = nullptr);
	void setCheckedSilently(bool on); // no toggled signal, no animation

protected:
	void paintEvent(QPaintEvent *) override;

private:
	qreal pos_ = 0;
};
