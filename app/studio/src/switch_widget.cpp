// SPDX-License-Identifier: GPL-3.0-or-later
#include "switch_widget.h"
#include "motion.h"
#include "theme.h"

#include <QFont>
#include <QPainter>

Switch::Switch(QWidget *parent) : QAbstractButton(parent)
{
	setCheckable(true);
	setCursor(Qt::PointingHandCursor);
	setFixedSize(58, 22); // wide enough for the ON / OFF text (user feedback: toggles with visible text)
	setFocusPolicy(Qt::TabFocus);
	connect(this, &QAbstractButton::toggled, this, [this](bool on) {
		motion::run(this, pos_, on ? 1.0 : 0.0, 140, QEasingCurve::OutCubic, [this](const QVariant &v) {
			pos_ = v.toReal();
			update();
		});
	});
}

void Switch::setCheckedSilently(bool on)
{
	const QSignalBlocker b(this);
	setChecked(on);
	pos_ = on ? 1.0 : 0.0;
	update();
}

void Switch::paintEvent(QPaintEvent *)
{
	QPainter p(this);
	p.setRenderHint(QPainter::Antialiasing, true);
	QColor track = motion::mix(theme::color(QStringLiteral("border")), theme::color(QStringLiteral("accent")), pos_);
	if (!isEnabled())
		track.setAlphaF(0.4f);
	p.setPen(Qt::NoPen);
	p.setBrush(track);
	p.drawRoundedRect(rect().adjusted(0, 1, 0, -1), 10, 10);
	p.setBrush(theme::color(QStringLiteral("text")));
	const qreal r = 8, x = 11 + pos_ * (width() - 22);
	p.drawEllipse(QPointF(x, height() / 2.0), r, r);
	// The state in words on the free side of the knob, so on and off never depend on colour alone.
	QFont f = font();
	f.setPixelSize(9);
	f.setBold(true);
	p.setFont(f);
	p.setPen(theme::color(QStringLiteral("text")));
	const bool on = isChecked();
	const QRectF textRect = on ? QRectF(4, 0, width() - 26, height()) : QRectF(22, 0, width() - 26, height());
	p.drawText(textRect, Qt::AlignCenter, on ? QStringLiteral("ON") : QStringLiteral("OFF"));
	if (hasFocus()) {
		p.setBrush(Qt::NoBrush);
		p.setPen(QPen(theme::color(QStringLiteral("accentHi")), 1.5));
		p.drawRoundedRect(rect().adjusted(1, 1, -1, -1), 11, 11);
	}
}
