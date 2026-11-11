// SPDX-License-Identifier: GPL-3.0-or-later
#include "switch_widget.h"
#include "motion.h"
#include "theme.h"

#include <QFont>
#include <QLinearGradient>
#include <QPainter>
#include <QPolygonF>

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
	const QString variant = theme::component(QStringLiteral("switch")); // D336; empty: the base look below
	if (!variant.isEmpty()) {
		paintVariant(variant);
		return;
	}
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

// Theme component variants (D336, flag theme-components). Ink on the "on" track is onAccent and on the "off" track text,
// so the knob and the words keep their contrast (tests/studio-theme-contrast.test.mjs).
//   plain     the knob only; a tick in the knob when on, a ring when off (state never by colour alone)
//   labelled  ON / OFF in the track beside the knob
//   bezel     labelled, inside a 2 px gradient rim; the knob glows when on (not in High performance)
void Switch::paintVariant(const QString &variant)
{
	QPainter p(this);
	p.setRenderHint(QPainter::Antialiasing, true);
	const bool bezel = variant == QStringLiteral("bezel");
	const qreal inset = bezel ? 2 : 0;
	const QRectF outer = QRectF(rect()).adjusted(0, 1, 0, -1);
	const QRectF tr = outer.adjusted(inset, inset, -inset, -inset);
	const qreal tRad = tr.height() / 2;
	if (bezel) {
		QLinearGradient g(outer.topLeft(), outer.bottomLeft());
		g.setColorAt(0, theme::color(QStringLiteral("accentHi")));
		g.setColorAt(1, theme::color(QStringLiteral("border")));
		p.setPen(Qt::NoPen);
		p.setBrush(theme::performance() ? QBrush(theme::color(QStringLiteral("border"))) : QBrush(g));
		p.drawRoundedRect(outer, outer.height() / 2, outer.height() / 2);
	}
	QColor track = motion::mix(theme::color(QStringLiteral("border")), theme::color(QStringLiteral("accent")), pos_);
	if (!isEnabled())
		track.setAlphaF(0.4f);
	p.setPen(Qt::NoPen);
	p.setBrush(track);
	p.drawRoundedRect(tr, tRad, tRad);
	const bool on = isChecked();
	const QColor ink = on ? theme::color(QStringLiteral("onAccent")) : theme::color(QStringLiteral("text"));
	const qreal r = tRad - 2.5, x = tr.left() + tRad + pos_ * (tr.width() - 2 * tRad), cy = tr.center().y();
	if (bezel && on && !theme::performance()) {
		QColor halo = theme::color(QStringLiteral("accentHi"));
		for (int i = 3; i >= 1; i--) {
			halo.setAlphaF(0.12f);
			p.setBrush(halo);
			p.drawEllipse(QPointF(x, cy), r + i * 1.5, r + i * 1.5);
		}
	}
	p.setBrush(ink);
	p.drawEllipse(QPointF(x, cy), r, r);
	if (variant == QStringLiteral("plain")) {
		p.setBrush(Qt::NoBrush);
		p.setPen(QPen(track, 1.8, Qt::SolidLine, Qt::RoundCap, Qt::RoundJoin));
		if (on) {
			QPolygonF tick;
			tick << QPointF(x - r * 0.45, cy) << QPointF(x - r * 0.1, cy + r * 0.38) << QPointF(x + r * 0.5, cy - r * 0.4);
			p.drawPolyline(tick);
		} else
			p.drawEllipse(QPointF(x, cy), r * 0.42, r * 0.42);
	} else {
		QFont f = font();
		f.setPixelSize(9);
		f.setBold(true);
		p.setFont(f);
		p.setPen(ink);
		const qreal knobW = 2 * tRad;
		const QRectF textRect = on ? QRectF(tr.left() + 3, tr.top(), tr.width() - knobW - 3, tr.height())
					   : QRectF(tr.left() + knobW, tr.top(), tr.width() - knobW - 3, tr.height());
		p.drawText(textRect, Qt::AlignCenter, on ? QStringLiteral("ON") : QStringLiteral("OFF"));
	}
	if (hasFocus()) {
		p.setBrush(Qt::NoBrush);
		p.setPen(QPen(theme::color(QStringLiteral("accentHi")), 1.5));
		p.drawRoundedRect(QRectF(rect()).adjusted(1, 1, -1, -1), height() / 2.0, height() / 2.0);
	}
}
