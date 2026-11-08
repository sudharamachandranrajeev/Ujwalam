// SPDX-License-Identifier: GPL-3.0-or-later
#include "look_panel.h"
#include "motion.h"
#include "theme.h"

#include <QAbstractButton>
#include <QColorDialog>
#include <QDoubleSpinBox>
#include <QFont>
#include <QFrame>
#include <QHBoxLayout>
#include <QLabel>
#include <QLineEdit>
#include <QPainter>
#include <QPushButton>
#include <QRegularExpression>
#include <QRegularExpressionValidator>
#include <QSlider>
#include <QTimer>
#include <QVBoxLayout>

#include <algorithm>
#include <cmath>

// An on/off switch: a pill with a knob that slides (motion.h; at once when motion is off).
class Switch : public QAbstractButton {
public:
	explicit Switch(QWidget *parent = nullptr) : QAbstractButton(parent)
	{
		setCheckable(true);
		setCursor(Qt::PointingHandCursor);
		setFixedSize(38, 22);
		setFocusPolicy(Qt::TabFocus);
		connect(this, &QAbstractButton::toggled, this, [this](bool on) {
			motion::run(this, pos_, on ? 1.0 : 0.0, 140, QEasingCurve::OutCubic, [this](const QVariant &v) {
				pos_ = v.toReal();
				update();
			});
		});
	}
	void setCheckedSilently(bool on)
	{
		const QSignalBlocker b(this);
		setChecked(on);
		pos_ = on ? 1.0 : 0.0;
		update();
	}

protected:
	void paintEvent(QPaintEvent *) override
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
		if (hasFocus()) {
			p.setBrush(Qt::NoBrush);
			p.setPen(QPen(theme::color(QStringLiteral("accentHi")), 1.5));
			p.drawRoundedRect(rect().adjusted(1, 1, -1, -1), 11, 11);
		}
	}

private:
	qreal pos_ = 0;
};

namespace {

QString groupTitle(const QString &g)
{
	if (g == QLatin1String("shape"))
		return QStringLiteral("Shape");
	if (g == QLatin1String("filter"))
		return QStringLiteral("Filters");
	if (g == QLatin1String("camera"))
		return QStringLiteral("Camera");
	if (g == QLatin1String("compositing"))
		return QStringLiteral("Blend");
	if (g == QLatin1String("light"))
		return QStringLiteral("Shadow & glow");
	return g.isEmpty() ? QStringLiteral("Other") : g.left(1).toUpper() + g.mid(1);
}

QLabel *caption(const QString &text, QWidget *parent)
{
	auto *l = new QLabel(text.toUpper(), parent);
	l->setObjectName(QStringLiteral("heading"));
	QFont f = l->font();
	f.setLetterSpacing(QFont::AbsoluteSpacing, 1.0);
	l->setFont(f);
	return l;
}

QString swatchStyle(const QString &col)
{
	return QStringLiteral("QPushButton#swatch { background: %1; border: 1px solid #5d5972; border-radius: 6px; }").arg(col);
}

} // namespace

LookPanel::LookPanel(QWidget *parent) : QWidget(parent), debounce_(new QTimer(this))
{
	root_ = new QVBoxLayout(this);
	root_->setContentsMargins(0, 0, 0, 0);
	root_->setSpacing(8);
	debounce_->setSingleShot(true);
	debounce_->setInterval(250); // short pause after the last change, so a slider drag sends once
	connect(debounce_, &QTimer::timeout, this, [this]() { emit commit(); });
	// Live: no automatic sends (each one needs "yes, on air"); the Apply button sends the whole list once.
	liveBar_ = new QWidget(this);
	auto *lh = new QHBoxLayout(liveBar_);
	lh->setContentsMargins(0, 0, 0, 0);
	auto *hint = new QLabel(QStringLiteral("You are live. Changes are sent when you press Apply (it asks for \"yes, on air\")."), liveBar_);
	hint->setWordWrap(true);
	hint->setObjectName(QStringLiteral("muted"));
	apply_ = new QPushButton(QStringLiteral("Apply"), liveBar_);
	apply_->setProperty("role", QStringLiteral("primary"));
	apply_->setEnabled(false);
	connect(apply_, &QPushButton::clicked, this, [this]() {
		dirty_ = false;
		apply_->setEnabled(false);
		emit commit();
	});
	lh->addWidget(hint, 1);
	lh->addWidget(apply_);
	liveBar_->setVisible(false);
	root_->addWidget(liveBar_);
	empty_ = new QLabel(QStringLiteral("No looks are available."), this);
	empty_->setObjectName(QStringLiteral("muted"));
	root_->addWidget(empty_);
}

void LookPanel::setLive(bool live)
{
	if (live == live_)
		return;
	live_ = live;
	liveBar_->setVisible(live);
	if (!live)
		apply_->setEnabled(false);
}

int LookPanel::indexOf(const QString &type) const
{
	for (int i = 0; i < effects_.size(); i++)
		if (effects_.at(i).toObject().value(QStringLiteral("type")).toString() == type)
			return i;
	return -1;
}

QJsonObject LookPanel::defaultOf(const LookType &t) const
{
	QJsonObject o;
	o.insert(QStringLiteral("type"), t.type);
	for (const auto &p : t.params)
		o.insert(p.key, p.colour ? QJsonValue(p.cdef) : QJsonValue(p.def));
	return o;
}

void LookPanel::changed()
{
	emit edited(effects_);
	if (live_) {
		dirty_ = true;
		apply_->setEnabled(true);
	} else
		debounce_->start();
}

void LookPanel::setParam(const QString &type, const QString &key, const QJsonValue &v)
{
	const int i = indexOf(type);
	if (i < 0)
		return;
	QJsonObject o = effects_.at(i).toObject();
	if (o.value(key) == v)
		return;
	o.insert(key, v);
	effects_.replace(i, o);
	changed();
}

void LookPanel::toggle(Card &c, bool on)
{
	const int i = indexOf(c.t.type);
	if (on && i < 0) {
		if (effects_.size() >= max_) {
			c.sw->setCheckedSilently(false);
			emit limit(QStringLiteral("A layer has at most %1 effects. Switch one off first.").arg(max_));
			return;
		}
		effects_.append(defaultOf(c.t));
	} else if (!on && i >= 0)
		effects_.removeAt(i);
	else
		return;
	c.body->setVisible(on);
	changed();
}

void LookPanel::setTypes(const QList<LookType> &types)
{
	cards_.clear();
	// groups in the usual order, then any other in the order first seen; "rounded" leads its group
	QStringList order = {QStringLiteral("shape"), QStringLiteral("filter"), QStringLiteral("camera"), QStringLiteral("compositing"), QStringLiteral("light")};
	for (const auto &t : types)
		if (!order.contains(t.group))
			order << t.group;
	while (root_->count() > 2) { // old captions, cards and the trailing stretch
		QLayoutItem *it = root_->takeAt(2);
		if (it->widget())
			it->widget()->deleteLater();
		delete it;
	}
	empty_->setVisible(types.isEmpty());
	for (const QString &g : order) {
		QList<LookType> mine;
		for (const auto &t : types)
			if (t.group == g)
				mine.append(t);
		if (mine.isEmpty())
			continue;
		std::stable_sort(mine.begin(), mine.end(), [](const LookType &a, const LookType &b) {
			return a.type == QLatin1String("rounded") && b.type != QLatin1String("rounded");
		});
		root_->addWidget(caption(groupTitle(g), this));
		for (const LookType &t : mine) {
			Card c;
			c.t = t;
			c.frame = new QFrame(this);
			c.frame->setObjectName(QStringLiteral("lookCard"));
			auto *v = new QVBoxLayout(c.frame);
			v->setContentsMargins(12, 8, 12, 8);
			v->setSpacing(6);
			auto *head = new QHBoxLayout();
			auto *name = new QLabel(t.label, c.frame);
			name->setObjectName(QStringLiteral("lookName"));
			c.sw = new Switch(c.frame);
			c.sw->setToolTip(QStringLiteral("Switch %1 on or off for this layer").arg(t.label));
			head->addWidget(name, 1);
			head->addWidget(c.sw);
			v->addLayout(head);
			c.body = new QWidget(c.frame);
			auto *bv = new QVBoxLayout(c.body);
			bv->setContentsMargins(0, 2, 0, 2);
			bv->setSpacing(6);
			for (const LookParam &p : t.params) {
				auto *cap = new QLabel(p.label, c.body);
				cap->setObjectName(QStringLiteral("muted"));
				bv->addWidget(cap);
				auto *row = new QHBoxLayout();
				const QString type = t.type, key = p.key;
				if (p.colour) {
					auto *sw = new QPushButton(c.body);
					sw->setObjectName(QStringLiteral("swatch"));
					sw->setFixedSize(30, 24);
					auto *line = new QLineEdit(p.cdef, c.body);
					line->setValidator(new QRegularExpressionValidator(QRegularExpression(QStringLiteral("^#[0-9a-fA-F]{6}$")), line));
					line->setMaxLength(7);
					sw->setStyleSheet(swatchStyle(p.cdef));
					connect(line, &QLineEdit::textChanged, this, [this, line, sw, type, key](const QString &txt) {
						if (!line->hasAcceptableInput())
							return;
						sw->setStyleSheet(swatchStyle(txt));
						setParam(type, key, txt.toLower());
					});
					connect(sw, &QPushButton::clicked, this, [this, line]() {
						const QColor c2 = QColorDialog::getColor(QColor(line->text()), this, QStringLiteral("Pick a colour"));
						if (c2.isValid())
							line->setText(c2.name());
					});
					row->addWidget(sw);
					row->addWidget(line, 1);
					c.hex[p.key] = line;
					c.swatches[p.key] = sw;
				} else {
					const int n = std::max(1, std::min(4000, (int)std::lround((p.hi - p.lo) / p.step)));
					auto *sl = new QSlider(Qt::Horizontal, c.body);
					sl->setRange(0, n);
					auto *sp = new QDoubleSpinBox(c.body);
					sp->setRange(p.lo, p.hi);
					sp->setDecimals(p.dec);
					sp->setSingleStep(p.step);
					sp->setButtonSymbols(QAbstractSpinBox::NoButtons);
					sp->setFixedWidth(64);
					const double lo = p.lo, step = p.step;
					connect(sl, &QSlider::valueChanged, this, [this, sp, type, key, lo, step](int s) {
						{
							const QSignalBlocker b(sp);
							sp->setValue(lo + s * step);
						}
						setParam(type, key, sp->value());
					});
					connect(sp, &QDoubleSpinBox::valueChanged, this, [this, sl, type, key, lo, step](double val) {
						{
							const QSignalBlocker b(sl);
							sl->setValue((int)std::lround((val - lo) / step));
						}
						setParam(type, key, val);
					});
					row->addWidget(sl, 1);
					row->addWidget(sp);
					c.sliders[p.key] = sl;
					c.spins[p.key] = sp;
				}
				bv->addLayout(row);
			}
			c.body->setVisible(false);
			v->addWidget(c.body);
			root_->addWidget(c.frame);
			cards_.append(c);
			const QString type = t.type;
			connect(c.sw, &QAbstractButton::toggled, this, [this, type](bool on) {
				for (Card &k : cards_)
					if (k.t.type == type)
						toggle(k, on);
			});
		}
	}
	root_->addStretch(1);
	setEffects(effects_);
}

void LookPanel::setEffects(const QJsonArray &effects)
{
	effects_ = effects;
	for (Card &c : cards_) {
		const int i = indexOf(c.t.type);
		const QJsonObject e = i >= 0 ? effects_.at(i).toObject() : QJsonObject();
		c.sw->setCheckedSilently(i >= 0);
		c.body->setVisible(i >= 0);
		for (const LookParam &p : c.t.params) {
			if (p.colour) {
				QLineEdit *line = c.hex.value(p.key);
				const QSignalBlocker b(line);
				const QString col = e.value(p.key).toString(p.cdef);
				line->setText(col);
				c.swatches.value(p.key)->setStyleSheet(swatchStyle(col));
			} else {
				const double v = e.value(p.key).toDouble(p.def);
				const QSignalBlocker b1(c.sliders.value(p.key)), b2(c.spins.value(p.key));
				c.spins.value(p.key)->setValue(v);
				c.sliders.value(p.key)->setValue((int)std::lround((v - p.lo) / p.step));
			}
		}
	}
}

void LookPanel::clearPending()
{
	dirty_ = false;
	apply_->setEnabled(false);
	debounce_->stop();
}

QJsonObject LookPanel::probe() const
{
	QJsonArray cards, groups;
	for (const Card &c : cards_) {
		cards.append(QJsonObject{{QStringLiteral("type"), c.t.type}, {QStringLiteral("group"), c.t.group}, {QStringLiteral("on"), c.sw->isChecked()},
					 {QStringLiteral("params"), (int)c.t.params.size()}});
		if (!groups.contains(c.t.group))
			groups.append(c.t.group);
	}
	return QJsonObject{{QStringLiteral("cards"), cards}, {QStringLiteral("groups"), groups}, {QStringLiteral("effects"), effects_},
			   {QStringLiteral("live"), live_}, {QStringLiteral("applyEnabled"), apply_->isEnabled()}};
}

bool LookPanel::probeToggle(const QString &type, bool on)
{
	for (Card &c : cards_)
		if (c.t.type == type) {
			if (c.sw->isChecked() != on)
				c.sw->click(); // the real switch: toggled -> toggle()
			return true;
		}
	return false;
}

bool LookPanel::probeSet(const QString &type, const QString &key, double value)
{
	for (Card &c : cards_)
		if (c.t.type == type && c.spins.contains(key) && c.sw->isChecked()) {
			c.spins.value(key)->setValue(value); // the real spin box: its handler sets the value
			return true;
		}
	return false;
}
