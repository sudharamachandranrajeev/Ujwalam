// SPDX-License-Identifier: GPL-3.0-or-later
#include "coach.h"
#include "motion.h"
#include "theme.h"

#include <QCheckBox>
#include <QGraphicsOpacityEffect>
#include <QHBoxLayout>
#include <QLabel>
#include <QPainter>
#include <QPainterPath>
#include <QPushButton>
#include <QToolButton>
#include <QVBoxLayout>
#include <QVariantAnimation>
#include <algorithm>

// ---- colours: the one place that knows where they come from: the active theme (D293) ----
namespace guidecol {
QColor panel() { return theme::color(QStringLiteral("panel")); }
QColor border() { return theme::color(QStringLiteral("border")); }
QColor text() { return theme::color(QStringLiteral("text")); }
QColor muted() { return theme::color(QStringLiteral("muted")); }
QColor accent() { return theme::color(QStringLiteral("accent")); }
QColor accentHi() { return theme::color(QStringLiteral("accentHi")); }
QColor field() { return theme::color(QStringLiteral("field")); }
QColor ok() { return theme::color(QStringLiteral("ok")); }

QString css()
{
	const QString a = accent().name(), ah = accentHi().name(), f = field().name(), b = border().name(), t = text().name(), m = muted().name();
	const QString hov = motion::mix(field(), accent(), 0.28).name();
	return QStringLiteral(
		       "QLabel { background: transparent; color: %1; }"
		       "QLabel#guideCount { color: %2; font-size: 8pt; font-weight: 600; }"
		       "QLabel#guideTitle { font-size: 12pt; font-weight: 600; }"
		       "QLabel#guideText { color: %3; }"
		       "QPushButton#guideBtn { background: %4; color: %1; border: 1px solid %5; border-radius: 8px; padding: 5px 14px; }"
		       "QPushButton#guideBtn:hover { background: %6; border-color: %7; }"
		       "QPushButton#guideBtn:pressed { background: %8; }"
		       "QPushButton#guideBtn:disabled { color: %2; background: transparent; border-color: transparent; }"
		       "QPushButton#guideBtn[role=\"primary\"] { background: %8; color: %10; border-color: %8; }"
		       "QPushButton#guideBtn[role=\"primary\"]:hover { background: %7; border-color: %7; }"
		       "QPushButton#guideBtn[role=\"primary\"]:pressed { background: %9; border-color: %9; }"
		       "QPushButton#guideBtn[role=\"quiet\"] { background: transparent; border-color: transparent; color: %2; }"
		       "QPushButton#guideBtn[role=\"quiet\"]:hover { color: %1; background: %4; }"
		       "QToolButton#guideClose { border: none; background: transparent; color: %2; font-size: 14pt; padding: 0 6px; border-radius: 6px; }"
		       "QToolButton#guideClose:hover { color: %1; background: %4; }"
		       "QToolButton#guideClose:pressed { background: %5; }"
		       "QCheckBox#guideCheck { color: %2; spacing: 7px; background: transparent; }"
		       "QCheckBox#guideCheck:hover { color: %1; }"
		       "QCheckBox#guideCheck::indicator { width: 14px; height: 14px; border-radius: 4px; border: 1px solid %5; background: %4; }"
		       "QCheckBox#guideCheck::indicator:hover { border-color: %7; }"
		       "QCheckBox#guideCheck::indicator:checked { background: %8; border-color: %8; }")
		.arg(t, m, t, f, b, hov, ah, a, accent().darker(125).name(), theme::hex(QStringLiteral("onAccent")));
}
} // namespace guidecol

// ---- Bubble ----

Bubble::Bubble(QWidget *host) : QWidget(host)
{
	setFocusPolicy(Qt::NoFocus);
	setAttribute(Qt::WA_StyledBackground, false);
	setStyleSheet(guidecol::css());
	connect(theme::notifier(), &theme::Notifier::changed, this, [this]() { // a theme switch recolours the card
		setStyleSheet(guidecol::css());
		update();
	});
	auto *l = new QVBoxLayout(this);
	l->setContentsMargins(kArrow + 16, kArrow + 12, kArrow + 16, kArrow + 12);
	l->setSpacing(8);
	body_ = l;
	hide();
}

QPoint Bubble::pointAt(const QRect &target, Side pref)
{
	// The card never covers its target: try below, above, left, right (the wanted side first), then the roomiest side
	// with a narrower card. The card's outer edge sits a gap from the target; the arrow lives inside the card's margin.
	if (!property("baseW").isValid())
		setProperty("baseW", width());
	const int w0 = property("baseW").toInt();
	const QRect bounds = parentWidget()->rect().adjusted(6, 6, -6, -6);
	const int gap = 4;
	const QList<QRect> avoid = avoid_ ? avoid_() : QList<QRect>();
	auto sized = [&](int w) {
		setFixedWidth(w);
		layout()->invalidate();
		layout()->activate();
		const int h = layout()->hasHeightForWidth() ? layout()->totalHeightForWidth(w) : layout()->sizeHint().height();
		setFixedHeight(h);
		return h;
	};
	auto rectFor = [&](Side s, int w, int h) {
		const QPoint c = target.center();
		auto cx = [&](int x) { return std::max(bounds.left(), std::min(x, bounds.right() - w + 1)); };
		auto cy = [&](int y) { return std::max(bounds.top(), std::min(y, bounds.bottom() - h + 1)); };
		switch (s) {
		case Below: return QRect(QPoint(cx(c.x() - w / 2), target.bottom() + 1 + gap), QSize(w, h));
		case Above: return QRect(QPoint(cx(c.x() - w / 2), target.top() - gap - h), QSize(w, h));
		case Left: return QRect(QPoint(target.left() - gap - w, cy(c.y() - h / 2)), QSize(w, h));
		default: return QRect(QPoint(target.right() + 1 + gap, cy(c.y() - h / 2)), QSize(w, h));
		}
	};
	auto free = [&](Side s) {
		switch (s) {
		case Below: return bounds.bottom() - target.bottom();
		case Above: return target.top() - bounds.top();
		case Left: return target.left() - bounds.left();
		default: return bounds.right() - target.right();
		}
	};
	auto ok = [&](const QRect &r, bool useAvoid) {
		if (!bounds.contains(r) || r.intersects(target))
			return false;
		if (useAvoid)
			for (const QRect &a : avoid)
				if (r.adjusted(kArrow, kArrow, -kArrow, -kArrow).intersects(a))
					return false;
		return true;
	};
	QList<Side> order = {Below, Above, Left, Right};
	if (pref != None) {
		order.removeAll(pref);
		order.prepend(pref);
	}
	const int h0 = sized(w0);
	Side pickSide = None;
	QRect pick;
	for (const bool useAvoid : {true, false}) {
		for (const Side sd : order) {
			const QRect r = rectFor(sd, w0, h0);
			if (ok(r, useAvoid)) {
				pickSide = sd;
				pick = r;
				break;
			}
		}
		if (pickSide != None)
			break;
	}
	if (pickSide == None) { // nothing fits at full width: the roomiest side, a narrower card
		QList<Side> by = order;
		std::sort(by.begin(), by.end(), [&](Side a, Side b) { return free(a) > free(b); });
		for (const Side sd : by) {
			const bool wide = sd == Left || sd == Right;
			const int w = wide ? std::max(180, std::min(w0, free(sd) - gap - 1)) : std::min(w0, bounds.width());
			const int h = sized(w);
			const QRect r = rectFor(sd, w, h);
			if (ok(r, false)) {
				pickSide = sd;
				pick = r;
				break;
			}
		}
		if (pickSide == None) { // a target that fills the window: best effort, clamped
			pickSide = by.first();
			const int h = sized(std::min(w0, bounds.width()));
			pick = rectFor(pickSide, width(), h);
			pick.moveTo(std::max(bounds.left(), pick.x()), std::max(bounds.top(), pick.y()));
		}
	}
	side_ = pickSide;
	const QPoint at = pick.topLeft();
	const int w = width(), h = height();
	const QPoint tip = (side_ == Right || side_ == Left) ? QPoint(0, target.center().y() - at.y()) : QPoint(target.center().x() - at.x(), 0);
	const int lo = kArrow + 18, hiX = std::max(lo, w - kArrow - 18), hiY = std::max(lo, h - kArrow - 18);
	along_ = (side_ == Right || side_ == Left) ? std::max(lo, std::min(tip.y(), hiY)) : std::max(lo, std::min(tip.x(), hiX));
	move(at);
	update();
	return at;
}

void Bubble::appear(QPoint)
{
	open_ = true;
	show();
	raise();
	const QPoint end = pos();
	if (!motion::enabled(this)) {
		setGraphicsEffect(nullptr);
		return;
	}
	auto *fx = new QGraphicsOpacityEffect(this);
	fx->setOpacity(0);
	setGraphicsEffect(fx);
	fx_ = fx;
	motion::run(
		this, 0.0, 1.0, 220, QEasingCurve::OutCubic,
		[this, end](const QVariant &v) {
			if (fx_)
				fx_->setOpacity(v.toReal());
			move(end + QPoint(0, int((1.0 - v.toReal()) * 10)));
		},
		[this]() { setGraphicsEffect(nullptr); });
}

void Bubble::vanish(std::function<void()> done)
{
	open_ = false;
	if (!isVisible() || !motion::enabled(this)) {
		setGraphicsEffect(nullptr);
		hide();
		if (done)
			done();
		return;
	}
	auto *fx = new QGraphicsOpacityEffect(this);
	fx->setOpacity(1);
	setGraphicsEffect(fx);
	fx_ = fx;
	const QPoint start = pos();
	motion::run(
		this, 1.0, 0.0, 160, QEasingCurve::InCubic,
		[this, start](const QVariant &v) {
			if (fx_)
				fx_->setOpacity(v.toReal());
			move(start + QPoint(0, int((1.0 - v.toReal()) * 6)));
		},
		[this, start, done]() {
			if (open_) // shown again meanwhile
				return;
			setGraphicsEffect(nullptr);
			hide();
			move(start);
			if (done)
				done();
		});
}

void Bubble::paintEvent(QPaintEvent *)
{
	QPainter p(this);
	p.setRenderHint(QPainter::Antialiasing);
	const QRectF card = QRectF(rect()).adjusted(kArrow, kArrow, -kArrow, -kArrow);
	// soft shadow: a few faint rings, no blur effect (cheap, and fine on a layered paint)
	for (int i = 5; i >= 1; i--) {
		p.setPen(Qt::NoPen);
		p.setBrush(QColor(0, 0, 0, 14));
		p.drawRoundedRect(card.adjusted(-i, -i + 2, i, i + 2), 14 + i, 14 + i);
	}
	QPainterPath path;
	path.addRoundedRect(card, 14, 14);
	if (side_ != None) {
		QPolygonF tri;
		const qreal a = along_, e = 0.5; // e: overlap so the join has no seam
		switch (side_) {
		case Right: tri << QPointF(card.left() + e, a - 9) << QPointF(0, a) << QPointF(card.left() + e, a + 9); break;
		case Left: tri << QPointF(card.right() - e, a - 9) << QPointF(width(), a) << QPointF(card.right() - e, a + 9); break;
		case Below: tri << QPointF(a - 9, card.top() + e) << QPointF(a, 0) << QPointF(a + 9, card.top() + e); break;
		case Above: tri << QPointF(a - 9, card.bottom() - e) << QPointF(a, height()) << QPointF(a + 9, card.bottom() - e); break;
		default: break;
		}
		QPainterPath t;
		t.addPolygon(tri);
		t.closeSubpath();
		path = path.united(t);
	}
	p.setBrush(guidecol::panel());
	p.setPen(QPen(guidecol::accent(), 1.2));
	p.drawPath(path);
}

// ---- CoachOverlay ----

CoachOverlay::CoachOverlay(QWidget *host) : QWidget(host)
{
	setAttribute(Qt::WA_TransparentForMouseEvents);
	setFocusPolicy(Qt::NoFocus);
	hide();
}

void CoachOverlay::setHole(const QRect &r, bool animate)
{
	const QRectF to(r);
	if (!animate || hole_.isEmpty() || !motion::enabled(this)) {
		hole_ = to;
		update();
		return;
	}
	const QRectF from = hole_;
	motion::run(this, from, to, 280, QEasingCurve::InOutCubic, [this](const QVariant &v) {
		hole_ = v.toRectF();
		update();
	});
}

void CoachOverlay::paintEvent(QPaintEvent *)
{
	QPainter p(this);
	p.setRenderHint(QPainter::Antialiasing);
	QPainterPath path;
	path.addRect(rect());
	const QRectF h = hole_.adjusted(-8, -8, 8, 8);
	if (!hole_.isEmpty()) {
		QPainterPath hp;
		hp.addRoundedRect(h, 14, 14);
		path = path.subtracted(hp);
	}
	p.fillPath(path, QColor(6, 4, 14, int(150 * dim_)));
	if (!hole_.isEmpty()) {
		QColor a = guidecol::accent();
		a.setAlpha(int(70 * dim_));
		p.setPen(QPen(a, 7));
		p.setBrush(Qt::NoBrush);
		p.drawRoundedRect(h, 14, 14);
		a.setAlpha(int(230 * dim_));
		p.setPen(QPen(a, 2));
		p.drawRoundedRect(h, 14, 14);
	}
}

// ---- Coach ----

namespace {
QPushButton *button(const QString &text, QWidget *parent, const char *role = nullptr)
{
	auto *b = new QPushButton(text, parent);
	b->setObjectName(QStringLiteral("guideBtn"));
	b->setFocusPolicy(Qt::NoFocus);
	b->setCursor(Qt::PointingHandCursor);
	if (role)
		b->setProperty("role", QString::fromLatin1(role));
	return b;
}
} // namespace

Coach::Coach(QWidget *host, AnchorResolver resolve) : QObject(host), host_(host), resolve_(std::move(resolve))
{
	dim_ = new CoachOverlay(host);
	card_ = new Bubble(host);
	card_->setFixedWidth(380);
	auto *top = new QHBoxLayout();
	count_ = new QLabel(card_);
	count_->setObjectName(QStringLiteral("guideCount"));
	close_ = new QToolButton(card_);
	close_->setObjectName(QStringLiteral("guideClose"));
	close_->setText(QStringLiteral("×"));
	close_->setToolTip(QStringLiteral("Close the tour"));
	close_->setFocusPolicy(Qt::NoFocus);
	close_->setProperty("noGlow", true);
	close_->setCursor(Qt::PointingHandCursor);
	top->addWidget(count_);
	top->addStretch(1);
	top->addWidget(close_);
	card_->body()->addLayout(top);
	title_ = new QLabel(card_);
	title_->setObjectName(QStringLiteral("guideTitle"));
	title_->setWordWrap(true);
	text_ = new QLabel(card_);
	text_->setObjectName(QStringLiteral("guideText"));
	text_->setWordWrap(true);
	card_->body()->addWidget(title_);
	card_->body()->addWidget(text_);
	never_ = new QCheckBox(QStringLiteral("Don't show this again"), card_);
	never_->setObjectName(QStringLiteral("guideCheck"));
	never_->setFocusPolicy(Qt::NoFocus);
	never_->setCursor(Qt::PointingHandCursor);
	card_->body()->addWidget(never_);
	auto *row = new QHBoxLayout();
	skip_ = button(QStringLiteral("Skip tour"), card_, "quiet");
	back_ = button(QStringLiteral("Back"), card_);
	next_ = button(QStringLiteral("Next"), card_, "primary");
	row->addWidget(skip_);
	row->addStretch(1);
	row->addWidget(back_);
	row->addWidget(next_);
	card_->body()->addLayout(row);
	connect(next_, &QPushButton::clicked, this, &Coach::next);
	connect(back_, &QPushButton::clicked, this, &Coach::back);
	connect(skip_, &QPushButton::clicked, this, [this]() { stop(false); });
	connect(close_, &QToolButton::clicked, this, [this]() { stop(false); });
}

bool Coach::available(int idx) const
{
	if (idx < 0 || idx >= steps_.size())
		return false;
	return !resolve_(steps_.at(idx).toObject().value(QStringLiteral("anchor")).toString()).isEmpty();
}

int Coach::step(int from, int dir) const
{
	for (int i = from + dir; i >= 0 && i < steps_.size(); i += dir)
		if (available(i))
			return i;
	return -1;
}

bool Coach::start(const QJsonObject &tour, bool offerNever)
{
	overlaps_.clear();
	if (active_) {
		active_ = false;
		dim_->hide();
		card_->hide();
	}
	tour_ = tour;
	steps_ = tour.value(QStringLiteral("steps")).toArray();
	total_ = 0;
	for (int i = 0; i < steps_.size(); i++)
		total_ += available(i) ? 1 : 0;
	if (total_ == 0)
		return false;
	offerNever_ = offerNever;
	never_->setChecked(false);
	never_->setVisible(offerNever);
	active_ = true;
	dim_->setGeometry(host_->rect());
	dim_->setDim(0);
	dim_->show();
	dim_->raise();
	motion::run(dim_, 0.0, 1.0, 240, QEasingCurve::OutCubic, [this](const QVariant &v) { dim_->setDim(v.toReal()); });
	dim_->setDim(motion::enabled(dim_) ? 0.0 : 1.0);
	show(step(-1, +1), false);
	card_->appear();
	return true;
}

void Coach::show(int idx, bool animate)
{
	idx_ = idx;
	const QJsonObject s = steps_.at(idx).toObject();
	position_ = 0;
	for (int i = 0; i <= idx; i++)
		position_ += available(i) ? 1 : 0;
	count_->setText(QStringLiteral("STEP %1 OF %2").arg(position_).arg(total_));
	title_->setText(s.value(QStringLiteral("title")).toString());
	text_->setText(s.value(QStringLiteral("text")).toString());
	back_->setEnabled(step(idx, -1) >= 0);
	const bool last = step(idx, +1) < 0;
	next_->setText(last ? QStringLiteral("Done") : QStringLiteral("Next"));
	skip_->setVisible(!last);
	const QRect r = resolve_(s.value(QStringLiteral("anchor")).toString());
	dim_->setGeometry(host_->rect());
	dim_->setHole(r, animate);
	const QString side = s.value(QStringLiteral("side")).toString();
	// "side" names where the card goes relative to the target, as Bubble::Side does
	const Bubble::Side want = side == QStringLiteral("left") ? Bubble::Left : side == QStringLiteral("right") ? Bubble::Right
				  : side == QStringLiteral("above") ? Bubble::Above : side == QStringLiteral("below") ? Bubble::Below : Bubble::None;
	const QPoint from = card_->pos();
	const QPoint dest = card_->pointAt(r, want);
	const QString sid = s.value(QStringLiteral("id")).toString();
	if (!r.isEmpty() && QRect(dest, card_->size()).intersects(r) && !overlaps_.contains(sid))
		overlaps_ << sid;
	dim_->raise();
	card_->raise();
	if (animate && motion::enabled(card_)) {
		card_->move(from);
		motion::run(card_, QPointF(from), QPointF(dest), 280, QEasingCurve::InOutCubic, [this](const QVariant &v) { card_->move(v.toPointF().toPoint()); });
	}
}

void Coach::next()
{
	if (!active_)
		return;
	const int n = step(idx_, +1);
	if (n < 0)
		stop(true);
	else
		show(n, true);
}

void Coach::back()
{
	if (!active_)
		return;
	const int n = step(idx_, -1);
	if (n >= 0)
		show(n, true);
}

void Coach::stop(bool completed)
{
	if (!active_)
		return;
	active_ = false;
	const bool never = offerNever_ && never_->isChecked();
	const QString id = tour_.value(QStringLiteral("id")).toString();
	motion::run(
		dim_, 1.0, 0.0, 200, QEasingCurve::InCubic, [this](const QVariant &v) { dim_->setDim(v.toReal()); },
		[this]() {
			if (!active_)
				dim_->hide();
		});
	card_->vanish();
	emit ended(id, completed, never);
}

void Coach::refresh()
{
	if (!active_)
		return;
	if (!available(idx_)) {
		const int n = step(idx_, +1) >= 0 ? step(idx_, +1) : step(idx_, -1);
		if (n < 0)
			return stop(true);
		idx_ = n;
	}
	show(idx_, false);
}

void Coach::setNeverTicked(bool on)
{
	if (never_->isVisibleTo(card_) || offerNever_)
		never_->setChecked(on);
}

void Coach::click(const QString &what)
{
	if (!active_)
		return;
	if (what == QStringLiteral("next"))
		next_->click();
	else if (what == QStringLiteral("back"))
		back_->click();
	else if (what == QStringLiteral("skip"))
		skip_->click();
	else if (what == QStringLiteral("close"))
		close_->click();
}

QJsonObject Coach::probe() const
{
	QJsonObject o;
	o.insert(QStringLiteral("active"), active_);
	if (!active_ && idx_ < 0)
		return o;
	const QJsonObject s = idx_ >= 0 && idx_ < steps_.size() ? steps_.at(idx_).toObject() : QJsonObject();
	const QRect r = dim_->hole();
	o.insert(QStringLiteral("tour"), tour_.value(QStringLiteral("id")).toString());
	o.insert(QStringLiteral("step"), position_);
	o.insert(QStringLiteral("of"), total_);
	o.insert(QStringLiteral("stepId"), s.value(QStringLiteral("id")).toString());
	o.insert(QStringLiteral("anchor"), s.value(QStringLiteral("anchor")).toString());
	o.insert(QStringLiteral("title"), title_->text());
	o.insert(QStringLiteral("count"), count_->text());
	o.insert(QStringLiteral("next"), next_->text());
	o.insert(QStringLiteral("backEnabled"), back_->isEnabled());
	o.insert(QStringLiteral("neverOffered"), offerNever_);
	o.insert(QStringLiteral("neverTicked"), never_->isChecked());
	o.insert(QStringLiteral("arrow"), int(card_->arrowSide()));
	o.insert(QStringLiteral("overlaps"), QJsonArray::fromStringList(overlaps_));
	o.insert(QStringLiteral("hole"), QJsonObject{{QStringLiteral("x"), r.x()}, {QStringLiteral("y"), r.y()}, {QStringLiteral("w"), r.width()}, {QStringLiteral("h"), r.height()}});
	return o;
}
