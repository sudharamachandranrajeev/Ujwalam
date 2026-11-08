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
	f.setCapitalization(c.caps ? QFont::AllUppercase : QFont::MixedCase);
	if (f != w->font())
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
		if (b.kind == QStringLiteral("solid"))
			return false;
		QPainter p(w);
		p.setClipRegion(static_cast<QPaintEvent *>(e)->region());
		const QRectF r = w->rect();
		if (b.from != b.to) {
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
			if (isCaption(w))
				applyCaption(w);
			else if (!w->isWindow() && !w->graphicsEffect() && !depth::classFor(w).isEmpty())
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
}

} // namespace interaction
