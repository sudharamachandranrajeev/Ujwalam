// SPDX-License-Identifier: GPL-3.0-or-later
#include "depth.h"

#include "motion.h"
#include "theme.h"

#include <QAbstractButton>
#include <QApplication>
#include <QElapsedTimer>
#include <QEvent>
#include <QGraphicsEffect>
#include <QImage>
#include <QMouseEvent>
#include <QPainter>
#include <QPainterPath>
#include <QPointer>
#include <QPushButton>
#include <QVariantAnimation>

#include <algorithm>
#include <cstdio>
#include <cmath>

namespace depth {

namespace {

int g_count = 0;

// A soft edge without a blur pass: k nested translucent rounded rectangles, the largest the faintest.
void soft(QPainter *p, const QRectF &base, qreal radius, int blur, const QColor &c, qreal opacity)
{
	if (blur <= 0 || opacity <= 0.001)
		return;
	const int k = std::clamp(blur / 2, 3, 10);
	const qreal q = 1.0 - std::pow(1.0 - std::clamp(opacity, 0.0, 0.95), 1.0 / k);
	QColor fill = c;
	fill.setAlphaF(q);
	p->setPen(Qt::NoPen);
	p->setBrush(fill);
	for (int i = 0; i < k; i++) {
		const qreal grow = blur * std::pow(qreal(k - i) / k, 1.4) - blur * 0.25; // a little tighter than the box: no halo at the sides
		p->drawRoundedRect(base.adjusted(-grow, -grow, grow, grow), radius + std::max<qreal>(0, grow), radius + std::max<qreal>(0, grow));
	}
}

class DepthEffect : public QGraphicsEffect {
public:
	explicit DepthEffect(QWidget *w) : QGraphicsEffect(w), w_(w)
	{
		g_count++;
		w->installEventFilter(this);
		if (auto *b = qobject_cast<QAbstractButton *>(w))
			connect(b, &QAbstractButton::toggled, this, [this]() { syncGlow(); });
	}
	~DepthEffect() override { g_count--; }

	void setClass(const QString &cls)
	{
		cls_ = cls;
		spec_ = theme::depthSpec(cls);
		hover_ = press_ = 0;
		glow_ = glowTarget();
		updateBoundingRect();
		update();
	}

	QRectF boundingRectFor(const QRectF &r) const override
	{
		qreal m = 0;
		if (spec_.shadow.enabled)
			m = std::max<qreal>(m, spec_.shadow.blur + std::max(std::abs(spec_.shadow.offsetX), std::abs(spec_.shadow.offsetY)));
		if (spec_.glow.enabled)
			m = std::max<qreal>(m, spec_.glow.blur);
		if (spec_.extrusion.enabled)
			m = std::max<qreal>(m, spec_.extrusion.depth);
		m += theme::hoverLift() + 2;
		return r.adjusted(-m, -m, m, m);
	}

protected:
	void draw(QPainter *p) override
	{
		QPoint off;
		const QPixmap pm = sourcePixmap(Qt::LogicalCoordinates, &off, QGraphicsEffect::NoPad);
		if (pm.isNull())
			return;
		const QRectF r(off, QSizeF(pm.deviceIndependentSize()));
		const bool active = w_->property("active").toBool() || (qobject_cast<QAbstractButton *>(w_) && qobject_cast<QAbstractButton *>(w_)->isCheckable() &&
										qobject_cast<QAbstractButton *>(w_)->isChecked());
		const int rad = theme::depthRadius(cls_, r.size().toSize());
		const qreal exd = spec_.extrusion.enabled ? spec_.extrusion.depth : 0;
		const qreal dy = -theme::hoverLift() * hover_ + (exd > 0 ? exd : theme::pressSink()) * press_;
		p->save();
		p->setRenderHint(QPainter::Antialiasing, true);
		{ // the back layers never show through the widget itself (a transparent danger button stays transparent)
			QPainterPath all, face;
			all.addRect(r.adjusted(-60, -60, 60, 60));
			face.addRoundedRect(r.translated(0, std::round(dy)), rad, rad);
			p->setClipPath(all.subtracted(face));
		}
		if (spec_.shadow.enabled) {
			const qreal grow = std::max<qreal>(0, -dy) * 0.6;
			soft(p, r.translated(spec_.shadow.offsetX, spec_.shadow.offsetY + grow + std::max<qreal>(0, exd - 1) * 0.5), rad, spec_.shadow.blur,
			     theme::resolve(spec_.shadow.color, active), spec_.shadow.opacity * (1.0 - 0.35 * press_));
		}
		const qreal gl = spec_.glow.enabled ? (spec_.glow.when == QStringLiteral("hover") ? hover_ : glow_) : 0;
		if (gl > 0.002)
			soft(p, r, rad, spec_.glow.blur, theme::resolve(spec_.glow.color, active), spec_.glow.opacity * gl);
		if (exd > 0) {
			const QColor c1 = theme::resolve(spec_.extrusion.color, active);
			const QColor c2 = spec_.extrusion.color2.isEmpty() ? c1 : theme::resolve(spec_.extrusion.color2, active);
			p->setPen(Qt::NoPen);
			const int lo = int(std::floor(dy)) + 1;
			for (int k = int(exd); k >= lo; k--) {
				const qreal t = (exd - dy) > 0 ? std::clamp((k - dy) / (exd - dy), 0.0, 1.0) : 0.0;
				p->setBrush(motion::mix(c1, c2, 1.0 - t)); // near the face c2 (lighter bevel), far end c1
				p->drawRoundedRect(r.translated(0, k), rad, rad);
			}
		}
		p->restore();
		p->drawPixmap(QPointF(off) + QPointF(0, std::round(dy)), pm);
	}

	bool eventFilter(QObject *o, QEvent *e) override
	{
		if (o != w_)
			return false;
		switch (e->type()) {
		case QEvent::Enter:
			if (w_->isEnabled())
				anim(hover_, 1.0, hoverAnim_);
			syncGlow();
			break;
		case QEvent::Leave:
		case QEvent::Hide:
		case QEvent::EnabledChange:
			anim(hover_, 0.0, hoverAnim_);
			anim(press_, 0.0, pressAnim_);
			syncGlow();
			break;
		case QEvent::MouseButtonPress:
			if (static_cast<QMouseEvent *>(e)->button() == Qt::LeftButton && w_->isEnabled())
				anim(press_, 1.0, pressAnim_, true);
			break;
		case QEvent::MouseButtonRelease:
			anim(press_, 0.0, pressAnim_);
			break;
		case QEvent::FocusIn:
		case QEvent::FocusOut:
			syncGlow();
			break;
		case QEvent::DynamicPropertyChange:
			if (static_cast<QDynamicPropertyChangeEvent *>(e)->propertyName() == "active")
				syncGlow();
			break;
		default:
			break;
		}
		return false;
	}

private:
	qreal glowTarget() const
	{
		if (!spec_.glow.enabled || !w_->isEnabled())
			return 0;
		const QString &when = spec_.glow.when;
		if (when == QStringLiteral("always"))
			return 1;
		if (when == QStringLiteral("active")) {
			auto *b = qobject_cast<QAbstractButton *>(w_);
			return (w_->property("active").toBool() || (b && b->isCheckable() && b->isChecked())) ? 1 : 0;
		}
		if (when == QStringLiteral("focus"))
			return w_->hasFocus() ? 1 : 0;
		return 0; // hover follows hover_
	}
	void syncGlow()
	{
		if (spec_.glow.when != QStringLiteral("hover"))
			anim(glow_, glowTarget(), glowAnim_);
	}
	// Move value toward target with the theme's motion; no animation when motion is off or the widget is not shown.
	void anim(qreal &value, qreal target, QPointer<QVariantAnimation> &slot, bool fast = false)
	{
		if (std::abs(value - target) < 0.001)
			return;
		if (slot)
			slot->stop();
		QPointer<DepthEffect> self(this);
		qreal *v = &value;
		slot = motion::run(w_, value, target, theme::duration(fast ? "fast" : "normal") * (fast ? 0.7 : 1.0), theme::easing(),
				   [self, v](const QVariant &x) {
					   if (self) {
						   *v = x.toReal();
						   self->update();
					   }
				   });
	}

	QWidget *w_;
	QString cls_;
	theme::DepthSpec spec_;
	qreal hover_ = 0, press_ = 0, glow_ = 0;
	QPointer<QVariantAnimation> hoverAnim_, pressAnim_, glowAnim_;
};

} // namespace

QString classFor(const QWidget *w)
{
	if (!w || w->isWindow() || w->property("noDepth").toBool())
		return {};
	const QString forced = w->property("depth").toString();
	if (!forced.isEmpty())
		return forced;
	const QString name = w->objectName();
	if (w->inherits("QFrame")) {
		if (name == QStringLiteral("card") || name == QStringLiteral("statCard"))
			return QStringLiteral("card");
		if (name == QStringLiteral("toast"))
			return QStringLiteral("toast");
		if (name == QStringLiteral("taskPanel"))
			return QStringLiteral("taskPanel");
		return {};
	}
	if (w->inherits("QPushButton")) {
		if (name == QStringLiteral("round"))
			return QStringLiteral("roundControl");
		if (name == QStringLiteral("tb") || name == QStringLiteral("taskClose"))
			return {};
		const QString role = w->property("role").toString();
		if (role == QStringLiteral("primary"))
			return QStringLiteral("primaryButton");
		return QStringLiteral("button");
	}
	return {};
}

void attach(QWidget *w, const QString &cls)
{
	if (!w)
		return;
	if (!cls.isEmpty())
		w->setProperty("depth", cls);
	auto *cur = w->graphicsEffect();
	auto *e = dynamic_cast<DepthEffect *>(cur);
	const QString use = cls.isEmpty() ? classFor(w) : cls;
	const theme::DepthSpec spec = theme::depthSpec(use);
	if (use.isEmpty() || !theme::effectsOn() || !spec.any() || w->property("noDepth").toBool()) {
		if (e)
			w->setGraphicsEffect(nullptr);
		return;
	}
	if (cur && !e)
		return; // another effect (a fade) is running: attach again when it ends
	if (!e) {
		e = new DepthEffect(w);
		w->setGraphicsEffect(e);
	}
	e->setClass(use);
}

void refreshAll()
{
	const auto all = QApplication::allWidgets();
	for (QWidget *w : all)
		if (w->graphicsEffect() ? dynamic_cast<DepthEffect *>(w->graphicsEffect()) != nullptr : !classFor(w).isEmpty())
			attach(w, QString());
}

int count()
{
	return g_count;
}

int eligible()
{
	if (!theme::effectsOn())
		return 0;
	int n = 0;
	for (QWidget *w : QApplication::allWidgets()) {
		const QString cls = classFor(w);
		if (!cls.isEmpty() && theme::depthSpec(cls).any())
			n++;
	}
	return n;
}

double measurePaint(QWidget *w, int repeats, bool dropCaches)
{
	const qreal dpr = w->devicePixelRatioF();
	QImage img((w->size() * dpr).expandedTo(QSize(1, 1)), QImage::Format_ARGB32_Premultiplied);
	img.setDevicePixelRatio(dpr);
	QElapsedTimer t;
	t.start();
	for (int i = 0; i < repeats; i++) {
		// Worst case: every effect's cached picture of its widget is dropped before each paint.
		if (dropCaches)
			for (QWidget *c : w->findChildren<QWidget *>())
				if (auto *g = c->graphicsEffect())
					g->update();
		img.fill(Qt::transparent);
		w->render(&img);
	}
	return t.nsecsElapsed() / 1e6 / std::max(1, repeats);
}

} // namespace depth
