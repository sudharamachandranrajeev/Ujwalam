// SPDX-License-Identifier: GPL-3.0-or-later
#include "icons.h"
#include "theme.h"

#include <QPainter>
#include <QPainterPath>
#include <QPixmap>

namespace icons {

namespace {

void draw(QPainter &p, const QString &n, const QColor &c)
{
	QPen pen(c, theme::iconStroke(), Qt::SolidLine, Qt::RoundCap, Qt::RoundJoin);
	p.setPen(pen);
	p.setBrush(Qt::NoBrush);
	if (n == QLatin1String("play")) {
		QPainterPath t;
		t.moveTo(8, 5.5);
		t.lineTo(19, 12);
		t.lineTo(8, 18.5);
		t.closeSubpath();
		p.setBrush(c);
		p.drawPath(t);
	} else if (n == QLatin1String("stop")) {
		p.setBrush(c);
		p.drawRoundedRect(QRectF(6.5, 6.5, 11, 11), 2.5, 2.5);
	} else if (n == QLatin1String("record")) {
		p.setBrush(c);
		p.drawEllipse(QPointF(12, 12), 6, 6);
	} else if (n == QLatin1String("clip")) { // a film frame with a spark: "keep the last moments"
		p.drawRoundedRect(QRectF(3.5, 6.5, 17, 11), 2.5, 2.5);
		QPainterPath t;
		t.moveTo(10.5, 9.5);
		t.lineTo(14.5, 12);
		t.lineTo(10.5, 14.5);
		t.closeSubpath();
		p.setBrush(c);
		p.drawPath(t);
		p.drawLine(QPointF(7, 3.5), QPointF(7, 5.5));
		p.drawLine(QPointF(12, 2.5), QPointF(12, 5));
		p.drawLine(QPointF(17, 3.5), QPointF(17, 5.5));
	} else if (n == QLatin1String("flag")) {
		p.drawLine(QPointF(6.5, 4), QPointF(6.5, 20));
		QPainterPath f;
		f.moveTo(6.5, 5);
		f.lineTo(18.5, 5);
		f.lineTo(15.5, 9.5);
		f.lineTo(18.5, 14);
		f.lineTo(6.5, 14);
		p.setBrush(c);
		p.drawPath(f);
	} else if (n == QLatin1String("undo") || n == QLatin1String("redo")) {
		const bool undo = n == QLatin1String("undo");
		if (!undo)
			p.translate(24, 0), p.scale(-1, 1);
		QPainterPath a;
		a.moveTo(8, 8.5);
		a.cubicTo(14, 6.5, 19.5, 9.5, 19.5, 14.5);
		a.cubicTo(19.5, 17, 18, 18.5, 16.5, 19);
		p.drawPath(a);
		p.drawLine(QPointF(8, 8.5), QPointF(11.5, 5));
		p.drawLine(QPointF(8, 8.5), QPointF(11.5, 12));
	} else if (n == QLatin1String("folder")) {
		QPainterPath f;
		f.moveTo(3.5, 7.5);
		f.lineTo(3.5, 18);
		f.quadTo(3.5, 19.5, 5, 19.5);
		f.lineTo(19, 19.5);
		f.quadTo(20.5, 19.5, 20.5, 18);
		f.lineTo(20.5, 9.5);
		f.quadTo(20.5, 8, 19, 8);
		f.lineTo(11.5, 8);
		f.lineTo(9.5, 5.5);
		f.lineTo(5, 5.5);
		f.quadTo(3.5, 5.5, 3.5, 7);
		f.closeSubpath();
		p.drawPath(f);
	} else if (n == QLatin1String("gear")) {
		p.drawEllipse(QPointF(12, 12), 3, 3);
		for (int i = 0; i < 8; i++) {
			p.save();
			p.translate(12, 12);
			p.rotate(i * 45.0);
			p.drawLine(QPointF(0, -6.8), QPointF(0, -9.2));
			p.restore();
		}
		p.drawEllipse(QPointF(12, 12), 6.6, 6.6);
	} else if (n == QLatin1String("more")) {
		p.setPen(Qt::NoPen);
		p.setBrush(c);
		for (int i = 0; i < 3; i++)
			p.drawEllipse(QPointF(5.5 + 6.5 * i, 12), 1.9, 1.9);
	} else if (n == QLatin1String("sliders")) {
		for (int i = 0; i < 3; i++) {
			const double y = 6.5 + 5.5 * i;
			p.drawLine(QPointF(4, y), QPointF(20, y));
			p.setBrush(QColor(0, 0, 0, 0));
			p.save();
			p.setBrush(c);
			p.drawEllipse(QPointF(7 + 5 * ((i * 2) % 3), y), 2.2, 2.2);
			p.restore();
		}
	}
}

QPixmap pixmap(const QString &name, const QColor &c, int px)
{
	const qreal dpr = 2.0;
	QPixmap pm(QSize(px, px) * dpr);
	pm.fill(Qt::transparent);
	pm.setDevicePixelRatio(dpr);
	QPainter p(&pm);
	p.setRenderHint(QPainter::Antialiasing, true);
	p.scale(px / 24.0, px / 24.0);
	draw(p, name, c);
	return pm;
}

} // namespace

QIcon make(const QString &name, const QColor &colour, int px, const QColor &disabled)
{
	QIcon i;
	i.addPixmap(pixmap(name, colour, px), QIcon::Normal);
	QColor dim = disabled.isValid() ? disabled : colour;
	if (!disabled.isValid())
		dim.setAlphaF(0.35f);
	i.addPixmap(pixmap(name, dim, px), QIcon::Disabled);
	return i;
}

} // namespace icons
