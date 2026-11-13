// SPDX-License-Identifier: GPL-3.0-or-later
#include "motion.h"
#include "soft.h"
#include "theme.h"

#include <QAbstractButton>
#include <QApplication>
#include <QEvent>
#include <QFocusEvent>
#include <QMouseEvent>
#include <QFrame>
#include <QLabel>
#include <QPainter>
#include <QPointer>
#include <QToolButton>
#include <QVariantAnimation>

#include <algorithm>

#ifdef Q_OS_WIN
#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#endif

namespace motion {

namespace {
QString g_mode = QStringLiteral("system");
}

void setMode(const QString &m)
{
	g_mode = (m == QStringLiteral("on") || m == QStringLiteral("off")) ? m : QStringLiteral("system");
}

QString mode()
{
	return g_mode;
}

bool systemAnimations()
{
	// UJWALAM_REDUCE_MOTION=1 turns motion off; =0 turns it on even when Windows has animation effects off.
	const QString env = qEnvironmentVariable("UJWALAM_REDUCE_MOTION");
	if (env == QStringLiteral("1"))
		return false;
	if (env == QStringLiteral("0"))
		return true;
	if (theme::performance()) // High performance (2026-11-10): no animation at all
		return false;
	if (g_mode == QStringLiteral("off"))
		return false;
	if (g_mode == QStringLiteral("on"))
		return true;
#ifdef Q_OS_WIN
	BOOL on = TRUE;
	if (SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION, 0, &on, 0))
		return on != FALSE;
#endif
	return true;
}

bool enabled(const QWidget *w)
{
	return w && w->isVisible() && systemAnimations();
}

QColor mix(const QColor &a, const QColor &b, qreal t)
{
	t = std::clamp(t, 0.0, 1.0);
	return QColor::fromRgbF(a.redF() + (b.redF() - a.redF()) * t, a.greenF() + (b.greenF() - a.greenF()) * t,
				a.blueF() + (b.blueF() - a.blueF()) * t, a.alphaF() + (b.alphaF() - a.alphaF()) * t);
}

QVariantAnimation *run(QWidget *context, const QVariant &from, const QVariant &to, int ms, QEasingCurve::Type curve,
		       std::function<void(const QVariant &)> step, std::function<void()> done)
{
	if (!enabled(context) || ms <= 0) {
		step(to);
		if (done)
			done();
		return nullptr;
	}
	auto *a = new QVariantAnimation(context);
	a->setStartValue(from);
	a->setEndValue(to);
	// The call sites ask for the studio's standard timing (OutCubic, 180 ms); the theme pack decides what that means
	// (D293): its normal duration and its easing replace them, other durations scale with them.
	a->setDuration(curve == QEasingCurve::OutCubic ? int(ms * (theme::duration(QStringLiteral("normal")) / 180.0) + 0.5) : ms);
	a->setEasingCurve(curve == QEasingCurve::OutCubic ? theme::easing() : curve);
	QObject::connect(a, &QVariantAnimation::valueChanged, context, [step](const QVariant &v) { step(v); });
	QObject::connect(a, &QVariantAnimation::finished, context, [a, done]() {
		if (done)
			done();
		a->deleteLater();
	});
	a->start();
	return a;
}

namespace {

// The feedback overlay: paints over its parent, never takes the mouse. Hover tints it with the accent (brighten),
// a press darkens it, keyboard focus draws a ring. Strength 0..1 each, animated with the theme's timing.
class Glow : public QWidget {
public:
	explicit Glow(QWidget *parent, int radius) : QWidget(parent), radius_(radius)
	{
		setObjectName(QStringLiteral("hoverGlow"));
		setAttribute(Qt::WA_TransparentForMouseEvents);
		setAttribute(Qt::WA_NoSystemBackground);
		setFocusPolicy(Qt::NoFocus);
		parent->installEventFilter(this);
		setGeometry(parent->rect());
		hide();
	}
	~Glow() override
	{
		// High performance removes overlays while one may be fading: its animation calls back into this object.
		for (QPointer<QVariantAnimation> *slot : {&hoverAnim_, &pressAnim_, &focusAnim_})
			if (*slot) {
				(*slot)->stop();
				(*slot)->deleteLater();
			}
	}
	bool eventFilter(QObject *o, QEvent *e) override
	{
		auto *p = parentWidget();
		if (o != p)
			return false;
		switch (e->type()) {
		case QEvent::Enter:
			if (p->isEnabled())
				to(hover_, 1.0, hoverAnim_);
			break;
		case QEvent::Leave:
		case QEvent::Hide:
		case QEvent::EnabledChange:
			to(hover_, 0.0, hoverAnim_);
			to(press_, 0.0, pressAnim_);
			break;
		case QEvent::MouseButtonPress:
			if (p->isEnabled() && static_cast<QMouseEvent *>(e)->button() == Qt::LeftButton)
				to(press_, 1.0, pressAnim_);
			break;
		case QEvent::MouseButtonRelease:
			to(press_, 0.0, pressAnim_);
			break;
		case QEvent::FocusIn:
			// a ring for keyboard focus only: a mouse click already shows the pressed state
			if (static_cast<QFocusEvent *>(e)->reason() != Qt::MouseFocusReason)
				to(focus_, 1.0, focusAnim_);
			break;
		case QEvent::FocusOut:
			to(focus_, 0.0, focusAnim_);
			break;
		case QEvent::Resize:
			setGeometry(p->rect());
			break;
		default:
			break;
		}
		return false;
	}

protected:
	void paintEvent(QPaintEvent *) override
	{
		if (soft::owns(parentWidget())) // D376: the soft painter shows hover, press and focus itself
			return;
		QPainter p(this);
		p.setRenderHint(QPainter::Antialiasing);
		const QRectF r = QRectF(rect()).adjusted(0.5, 0.5, -0.5, -0.5);
		if (hover_ > 0.001) {
			QColor fill = theme::color(QStringLiteral("accentHi"));
			fill.setAlphaF(0.20 * hover_);
			QColor edge = theme::color(QStringLiteral("accent"));
			edge.setAlphaF(0.95 * hover_);
			p.setBrush(fill);
			p.setPen(QPen(edge, 1));
			p.drawRoundedRect(r, radius_, radius_);
		}
		if (press_ > 0.001) {
			p.setBrush(QColor(0, 0, 0, int(70 * press_)));
			p.setPen(Qt::NoPen);
			p.drawRoundedRect(r, radius_, radius_);
		}
		if (focus_ > 0.001) {
			QColor ring = theme::color(QStringLiteral("accentHi"));
			ring.setAlphaF(0.9 * focus_);
			p.setBrush(Qt::NoBrush);
			p.setPen(QPen(ring, 2));
			p.drawRoundedRect(r.adjusted(1, 1, -1, -1), std::max(0, radius_ - 1), std::max(0, radius_ - 1));
		}
	}

private:
	void to(qreal &v, qreal target, QPointer<QVariantAnimation> &slot)
	{
		if (qFuzzyCompare(v + 1.0, target + 1.0))
			return;
		if (slot)
			slot->stop();
		const qreal from = v;
		if (target > 0)
			raise(), show();
		qreal *vp = &v;
		slot = run(parentWidget(), from, target, 180, QEasingCurve::OutCubic, [this, vp](const QVariant &x) { *vp = x.toReal(); update(); },
			   [this]() { settle(); });
		if (!slot)
			settle();
	}
	void settle()
	{
		if (hover_ <= 0 && press_ <= 0 && focus_ <= 0)
			hide();
	}
	int radius_;
	qreal hover_ = 0, press_ = 0, focus_ = 0;
	QPointer<QVariantAnimation> hoverAnim_, pressAnim_, focusAnim_;
};

// Gives a button, strip or task row its hover overlay (once). None in High performance.
void attachGlow(QWidget *w)
{
	if (!w || theme::performance() || w->findChild<QWidget *>(QStringLiteral("hoverGlow"), Qt::FindDirectChildrenOnly))
		return;
	int radius = 0;
	if (w->objectName() == QStringLiteral("round"))
		radius = std::min(w->width(), w->height()) / 2; // the round control buttons (D290)
	else if (qobject_cast<QAbstractButton *>(w) && (w->inherits("QPushButton") || w->inherits("QToolButton")))
		radius = theme::radius(theme::Radius::Medium);
	else if (w->objectName() == QStringLiteral("strip") || w->objectName() == QStringLiteral("taskRow"))
		radius = theme::radius(theme::Radius::Medium) + 2;
	if (radius && !w->property("noGlow").toBool())
		new Glow(w, radius);
}

class HoverFilter : public QObject {
public:
	using QObject::QObject;
	bool eventFilter(QObject *o, QEvent *e) override
	{
		if (e->type() == QEvent::Show)
			attachGlow(qobject_cast<QWidget *>(o));
		return false;
	}
};

} // namespace

void installHover(QApplication &app)
{
	app.installEventFilter(new HoverFilter(&app));
}

void dropHover(bool drop)
{
	const auto all = QApplication::allWidgets();
	if (drop) {
		for (QWidget *w : all)
			if (w->objectName() == QStringLiteral("hoverGlow")) {
				// renamed and hidden now, deleted later: a quick switch back to Full (before the deferred delete
				// runs) must not see the dying overlay as "already there" and skip making a new one
				w->setObjectName(QStringLiteral("hoverGlowGone"));
				if (QWidget *host = w->parentWidget())
					host->removeEventFilter(w); // no hover may show it again before it goes
				w->hide();
				w->deleteLater();
			}
		return;
	}
	for (QWidget *w : all) // back from High performance: the shown widgets get their overlay again
		if (w->isVisible() && w->objectName() != QStringLiteral("hoverGlow"))
			attachGlow(w);
}

int hoverCount()
{
	int n = 0;
	for (QWidget *w : QApplication::allWidgets())
		n += w->objectName() == QStringLiteral("hoverGlow") ? 1 : 0;
	return n;
}

void setChip(QLabel *l, bool on, const QColor &fill)
{
	const QVariant cur = l->property("chipOn");
	if (cur.isValid() && cur.toBool() == on)
		return;
	const bool first = !cur.isValid();
	l->setProperty("chipOn", on);
	// The fill is a theme colour (or not): remember which token, so a theme switch can colour the chip again.
	QString token;
	for (const char *k : {"danger", "accent", "ok"})
		if (fill == theme::color(QLatin1String(k)))
			token = QLatin1String(k);
	l->setProperty("chipToken", token);
	l->setProperty("chipFill", fill);
	auto paint = [l](qreal t) {
		l->setProperty("chipT", t);
		if (t <= 0.001) {
			l->setStyleSheet(QString());
			return;
		}
		const QString token = l->property("chipToken").toString();
		const QColor f = token.isEmpty() ? l->property("chipFill").value<QColor>() : theme::color(token);
		l->setStyleSheet(QStringLiteral("background:%1;border-color:%2;color:%3;")
					 .arg(mix(theme::color(QStringLiteral("field")), f, t).name(), mix(theme::color(QStringLiteral("border")), f, t).name(),
					      mix(theme::color(QStringLiteral("text")), theme::color(QStringLiteral("onAccent")), t).name()));
	};
	if (first) // one connection per chip: a theme switch paints it again at its current strength
		QObject::connect(theme::notifier(), &theme::Notifier::changed, l, [l, paint]() { paint(l->property("chipT").toReal()); });
	if (auto *old = l->findChild<QVariantAnimation *>(QStringLiteral("chipAnim")))
		old->stop(), old->deleteLater();
	const qreal from = l->property("chipT").toReal(), to = on ? 1.0 : 0.0;
	if (first || !enabled(l)) {
		paint(to);
		return;
	}
	auto *a = run(l, from, to, 220, QEasingCurve::OutCubic, [paint](const QVariant &v) { paint(v.toReal()); });
	if (a)
		a->setObjectName(QStringLiteral("chipAnim"));
}

} // namespace motion
