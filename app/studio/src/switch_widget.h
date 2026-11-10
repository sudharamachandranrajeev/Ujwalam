// SPDX-License-Identifier: GPL-3.0-or-later
// An on/off switch: a pill with a knob that slides (motion.h; at once when motion is off). Theme tokens only
// (border, accent, accentHi, text). Used by the Look panel (D290) and the Outputs panel (D327 OS3).
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
