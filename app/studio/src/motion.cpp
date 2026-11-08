// SPDX-License-Identifier: GPL-3.0-or-later
#include "motion.h"
#include "theme.h"

#include <QAbstractButton>
#include <QApplication>
#include <QEvent>
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
	a->setDuration(ms);
	a->setEasingCurve(curve);
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

// The glow itself: paints a rounded tint over its parent, strength t (0..1). Never takes the mouse.
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
	bool eventFilter(QObject *o, QEvent *e) override
	{
		auto *p = parentWidget();
		if (o != p)
			return false;
		switch (e->type()) {
		case QEvent::Enter:
			if (p->isEnabled())
				to(1.0);
			break;
		case QEvent::Leave:
		case QEvent::Hide:
		case QEvent::EnabledChange:
			to(0.0);
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
		QPainter p(this);
		p.setRenderHint(QPainter::Antialiasing);
		QColor fill(theme::kAccentHi);
		fill.setAlphaF(0.20 * t_);
		QColor edge(theme::kAccent);
		edge.setAlphaF(0.95 * t_);
		p.setBrush(fill);
		p.setPen(QPen(edge, 1));
		p.drawRoundedRect(QRectF(rect()).adjusted(0.5, 0.5, -0.5, -0.5), radius_, radius_);
	}

private:
	void to(qreal target)
	{
		if (anim_)
			anim_->stop();
		const qreal from = t_;
		if (target > 0)
			raise(), show();
		anim_ = run(parentWidget(), from, target, 180, QEasingCurve::OutCubic, [this](const QVariant &v) { t_ = v.toReal(); update(); },
			    [this, target]() { if (target <= 0) hide(); });
		if (!anim_ && target <= 0)
			hide();
	}
	int radius_;
	qreal t_ = 0;
	QPointer<QVariantAnimation> anim_;
};

class HoverFilter : public QObject {
public:
	using QObject::QObject;
	bool eventFilter(QObject *o, QEvent *e) override
	{
		if (e->type() != QEvent::Show)
			return false;
		auto *w = qobject_cast<QWidget *>(o);
		if (!w || w->findChild<QWidget *>(QStringLiteral("hoverGlow"), Qt::FindDirectChildrenOnly))
			return false;
		int radius = 0;
		if (w->objectName() == QStringLiteral("round"))
			radius = std::min(w->width(), w->height()) / 2; // the round control buttons (D290)
		else if (qobject_cast<QAbstractButton *>(w) && (w->inherits("QPushButton") || w->inherits("QToolButton")))
			radius = 8;
		else if (w->objectName() == QStringLiteral("strip") || w->objectName() == QStringLiteral("taskRow"))
			radius = 10;
		if (radius && !w->property("noGlow").toBool())
			new Glow(w, radius);
		return false;
	}
};

} // namespace

void installHover(QApplication &app)
{
	app.installEventFilter(new HoverFilter(&app));
}

void setChip(QLabel *l, bool on, const QColor &fill)
{
	const QVariant cur = l->property("chipOn");
	if (cur.isValid() && cur.toBool() == on)
		return;
	const bool first = !cur.isValid();
	l->setProperty("chipOn", on);
	auto apply = [l, fill](qreal t) {
		l->setProperty("chipT", t);
		if (t <= 0.001) {
			l->setStyleSheet(QString());
			return;
		}
		l->setStyleSheet(QStringLiteral("background:%1;border-color:%2;color:%3;")
					 .arg(mix(QColor(theme::kField), fill, t).name(), mix(QColor(theme::kBorder), fill, t).name(), mix(QColor(theme::kText), QColor(Qt::white), t).name()));
	};
	if (auto *old = l->findChild<QVariantAnimation *>(QStringLiteral("chipAnim")))
		old->stop(), old->deleteLater();
	const qreal from = l->property("chipT").toReal(), to = on ? 1.0 : 0.0;
	if (first || !enabled(l)) {
		apply(to);
		return;
	}
	auto *a = run(l, from, to, 220, QEasingCurve::OutCubic, [apply](const QVariant &v) { apply(v.toReal()); });
	if (a)
		a->setObjectName(QStringLiteral("chipAnim"));
}

} // namespace motion
