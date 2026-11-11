// SPDX-License-Identifier: GPL-3.0-or-later
#include "interaction.h"

#include "depth.h"
#include "motion.h"
#include "theme.h"

#include <QApplication>
#include <QDialog>
#include <QEvent>
#include <QFont>
#include <QLabel>
#include <QLinearGradient>
#include <QMainWindow>
#include <QMenu>
#include <QPaintEvent>
#include <QPainter>
#include <QPointer>
#include <QPushButton>
#include <QTabBar>
#include <QVariantAnimation>

#include <algorithm>
#include <cmath>

namespace interaction {

namespace {

bool isCaption(const QWidget *w)
{
	const QString n = w->objectName();
	return n == QStringLiteral("heading") || n == QStringLiteral("statName") || n == QStringLiteral("ctlCaption");
}

void applyCaption(QWidget *w)
{
	const theme::Caption c = theme::caption();
	QFont f = w->font();
	f.setLetterSpacing(QFont::AbsoluteSpacing, c.spacing);
	const bool caps = c.caps || (theme::caps().heading && w->objectName() == QStringLiteral("heading"));
	f.setCapitalization(caps ? QFont::AllUppercase : QFont::MixedCase);
	if (f != w->font())
		w->setFont(f);
}

// Caps flags of the pack (D336, flag theme-components): button labels, tab labels, section titles. A widget whose
// capitalisation already matches is left alone, so with the flag off nothing is set on any widget.
void applyCaps(QWidget *w)
{
	const theme::Caps c = theme::caps();
	bool want = false;
	if (qobject_cast<QPushButton *>(w))
		want = c.button;
	else if (qobject_cast<QTabBar *>(w))
		want = c.tab;
	else if (w->objectName() == QStringLiteral("sectionTitle"))
		want = c.heading;
	else
		return;
	const QFont::Capitalization cap = want ? QFont::AllUppercase : QFont::MixedCase;
	if (w->font().capitalization() == cap)
		return;
	QFont f = w->font();
	f.setCapitalization(cap);
	w->setFont(f);
}

// Paints the theme's backdrop on a window before the window paints itself.
class Backdrop : public QObject {
public:
	using QObject::QObject;
	bool eventFilter(QObject *o, QEvent *e) override
	{
		if (e->type() != QEvent::Paint)
			return false;
		auto *w = static_cast<QWidget *>(o);
		const theme::Background b = theme::background();
		if ((b.kind == QStringLiteral("solid") && !b.frame) || theme::performance()) // High performance: the plain window colour
			return false;
		QPainter p(w);
		p.setClipRegion(static_cast<QPaintEvent *>(e)->region());
		const QRectF r = w->rect();
		if (b.kind != QStringLiteral("solid") && b.from != b.to) {
			const qreal a = b.angle * M_PI / 180.0, dx = std::cos(a) / 2, dy = std::sin(a) / 2;
			QLinearGradient g(r.left() + r.width() * (0.5 - dx), r.top() + r.height() * (0.5 - dy), r.left() + r.width() * (0.5 + dx),
					  r.top() + r.height() * (0.5 + dy));
			g.setColorAt(0, b.from);
			g.setColorAt(1, b.to);
			p.fillRect(r, g);
		}
		if (b.kind == QStringLiteral("pattern") && b.pattern != QStringLiteral("none") && b.patternOpacity > 0) {
			QColor c = b.patternColor;
			c.setAlphaF(b.patternOpacity);
			const int s = b.patternSpacing, W = w->width(), H = w->height();
			p.setPen(QPen(c, 1));
			if (b.pattern == QStringLiteral("grid")) {
				for (int x = 0; x < W; x += s)
					p.drawLine(x, 0, x, H);
				for (int y = 0; y < H; y += s)
					p.drawLine(0, y, W, y);
			} else if (b.pattern == QStringLiteral("scanlines")) {
				for (int y = 0; y < H; y += s)
					p.drawLine(0, y, W, y);
			} else if (b.pattern == QStringLiteral("diagonal")) {
				for (int x = -H; x < W; x += s)
					p.drawLine(x, H, x + H, 0);
			} else if (b.pattern == QStringLiteral("dots")) {
				p.setPen(Qt::NoPen);
				p.setBrush(c);
				for (int y = s / 2; y < H; y += s)
					for (int x = s / 2; x < W; x += s)
						p.drawEllipse(QPointF(x, y), 1.1, 1.1);
			} else if (b.pattern == QStringLiteral("blueprint")) { // D336: fine grid, a stronger line every 5 cells
				QColor major = b.patternColor;
				major.setAlphaF(std::min(1.0, b.patternOpacity * 2.5));
				for (int i = 0, x = 0; x < W; x += s, i++) {
					p.setPen(QPen(i % 5 ? c : major, 1));
					p.drawLine(x, 0, x, H);
				}
				for (int i = 0, y = 0; y < H; y += s, i++) {
					p.setPen(QPen(i % 5 ? c : major, 1));
					p.drawLine(0, y, W, y);
				}
			} else if (b.pattern == QStringLiteral("columns")) { // D336: faint layout columns (12, gutters of one spacing)
				const qreal colW = (W - 13.0 * s) / 12.0;
				if (colW > 4) {
					p.setPen(Qt::NoPen);
					p.setBrush(c);
					for (int i = 0; i < 12; i++)
						p.drawRect(QRectF(s + i * (colW + s), 0, colW, H));
				}
			}
		}
		if (b.frame && b.frameOpacity > 0) { // D336: thin outer frame with registration ticks
			QColor fc = b.patternColor;
			fc.setAlphaF(b.frameOpacity);
			const QRectF fr = r.adjusted(6.5, 6.5, -6.5, -6.5);
			p.setBrush(Qt::NoBrush);
			p.setPen(QPen(fc, 1));
			p.drawRect(fr);
			if (b.frameTicks) {
				fc.setAlphaF(std::min(1.0, b.frameOpacity * 1.8));
				p.setPen(QPen(fc, 2));
				const qreal t = 14;
				for (const QPointF &corner : {fr.topLeft(), fr.topRight(), fr.bottomLeft(), fr.bottomRight()}) {
					const qreal sx = corner.x() < fr.center().x() ? 1 : -1, sy = corner.y() < fr.center().y() ? 1 : -1;
					p.drawLine(corner, corner + QPointF(sx * t, 0));
					p.drawLine(corner, corner + QPointF(0, sy * t));
				}
				p.setPen(QPen(fc, 1));
				const QPointF mids[] = {{fr.center().x(), fr.top()}, {fr.center().x(), fr.bottom()}, {fr.left(), fr.center().y()}, {fr.right(), fr.center().y()}};
				for (int i = 0; i < 4; i++) {
					const QPointF m = mids[i];
					if (i < 2)
						p.drawLine(m + QPointF(0, i == 0 ? 0 : -6), m + QPointF(0, i == 0 ? 6 : 0));
					else
						p.drawLine(m + QPointF(i == 2 ? 0 : -6, 0), m + QPointF(i == 2 ? 6 : 0, 0));
				}
			}
		}
		return false;
	}
};

class Filter : public QObject {
public:
	explicit Filter(QObject *parent) : QObject(parent), backdrop_(new Backdrop(this)) {}

	bool eventFilter(QObject *o, QEvent *e) override
	{
		const QEvent::Type t = e->type();
		if (t != QEvent::Show && t != QEvent::Polish)
			return false;
		auto *w = qobject_cast<QWidget *>(o);
		if (!w)
			return false;
		if (t == QEvent::Polish) {
			if (isCaption(w)) {
				applyCaption(w);
				return false;
			}
			applyCaps(w); // D336
			if (!w->isWindow() && !w->graphicsEffect() && !depth::classFor(w).isEmpty())
				depth::attach(w, QString()); // once per style: also in the probe, where no window is shown
			return false;
		}
		if (w->isWindow()) {
			if ((qobject_cast<QMainWindow *>(w) || qobject_cast<QDialog *>(w)) && !w->property("backdrop").toBool()) {
				w->setProperty("backdrop", true);
				w->installEventFilter(backdrop_);
			}
			openFeedback(w);
			return false;
		}
		if (!w->graphicsEffect() && !depth::classFor(w).isEmpty())
			depth::attach(w, QString());
		return false;
	}

private:
	// Menus, dialogs and tooltips fade in; menus also slide down 6 px. Motion off: nothing.
	static void openFeedback(QWidget *w)
	{
		const bool menu = qobject_cast<QMenu *>(w) != nullptr;
		if (!menu && !qobject_cast<QDialog *>(w) && !w->inherits("QTipLabel"))
			return;
		if (!motion::enabled(w) || w->property("fading").toBool())
			return;
		w->setProperty("fading", true);
		const QPoint end = w->pos();
		w->setWindowOpacity(0.0);
		const int ms = theme::duration(menu ? "fast" : "normal");
		QPointer<QWidget> pw(w);
		motion::run(w, 0.0, 1.0, ms, theme::easing(), [pw, menu, end](const QVariant &v) {
			if (!pw)
				return;
			pw->setWindowOpacity(std::clamp(v.toReal(), 0.0, 1.0));
			if (menu)
				pw->move(end + QPoint(0, int(std::lround(-6 * (1.0 - std::clamp(v.toReal(), 0.0, 1.0))))));
		}, [pw, end]() {
			if (pw) {
				pw->setWindowOpacity(1.0);
				pw->setProperty("fading", false);
			}
		});
	}
	Backdrop *backdrop_;
};

} // namespace

void install(QApplication &app)
{
	app.installEventFilter(new Filter(&app));
}

void refresh()
{
	for (QWidget *w : QApplication::allWidgets())
		if (isCaption(w))
			applyCaption(w);
		else
			applyCaps(w);
}

} // namespace interaction
