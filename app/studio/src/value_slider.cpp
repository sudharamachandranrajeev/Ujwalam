// SPDX-License-Identifier: GPL-3.0-or-later
// The shared value slider (D330). See value_slider.h.
#include "value_slider.h"

#include <QApplication>
#include <QHBoxLayout>
#include <QKeyEvent>
#include <QMouseEvent>
#include <QStyle>
#include <QStyleOptionSlider>
#include <QTimer>
#include <QWheelEvent>

#include <algorithm>
#include <cmath>

JumpSlider::JumpSlider(QWidget *parent) : QSlider(Qt::Horizontal, parent)
{
	setFocusPolicy(Qt::StrongFocus); // tab and click focus; never wheel focus (see wheelEvent)
}

int JumpSlider::valueAt(const QPoint &pos) const
{
	QStyleOptionSlider opt;
	initStyleOption(&opt);
	const QRect groove = style()->subControlRect(QStyle::CC_Slider, &opt, QStyle::SC_SliderGroove, this);
	const QRect handle = style()->subControlRect(QStyle::CC_Slider, &opt, QStyle::SC_SliderHandle, this);
	const int span = std::max(1, groove.width() - handle.width());
	const int x = pos.x() - groove.x() - handle.width() / 2;
	return QStyle::sliderValueFromPosition(minimum(), maximum(), std::clamp(x, 0, span), span, opt.upsideDown);
}

QPoint JumpSlider::pointFor(int value) const
{
	QStyleOptionSlider opt;
	initStyleOption(&opt);
	opt.sliderPosition = value;
	opt.sliderValue = value;
	return style()->subControlRect(QStyle::CC_Slider, &opt, QStyle::SC_SliderHandle, this).center();
}

void JumpSlider::mousePressEvent(QMouseEvent *e)
{
	if (e->button() != Qt::LeftButton) {
		QSlider::mousePressEvent(e);
		return;
	}
	QStyleOptionSlider opt;
	initStyleOption(&opt);
	const QRect handle = style()->subControlRect(QStyle::CC_Slider, &opt, QStyle::SC_SliderHandle, this);
	if (handle.contains(e->position().toPoint())) {
		QSlider::mousePressEvent(e); // on the handle: an ordinary drag
		return;
	}
	// On the track: jump there, then press on the handle where it now is, so holding the button drags on from the
	// new place (Qt's own press would page-step towards the click instead).
	setFocus(Qt::MouseFocusReason);
	setValue(valueAt(e->position().toPoint()));
	const QPoint at = pointFor(value());
	QMouseEvent press(e->type(), QPointF(at), e->scenePosition(), e->globalPosition(), e->button(), e->buttons(), e->modifiers());
	QSlider::mousePressEvent(&press);
	e->setAccepted(press.isAccepted());
}

void JumpSlider::wheelEvent(QWheelEvent *e)
{
	if (!hasFocus()) {
		e->ignore(); // the panel scrolls instead
		return;
	}
	QSlider::wheelEvent(e);
}

NumberBox::NumberBox(QWidget *parent) : QDoubleSpinBox(parent)
{
	setFocusPolicy(Qt::StrongFocus);
	setKeyboardTracking(false); // a typed value counts on Enter or when the box loses focus, not per key
	setButtonSymbols(QAbstractSpinBox::NoButtons);
	setAlignment(Qt::AlignRight | Qt::AlignVCenter);
	setAccelerated(true);
}

void NumberBox::wheelEvent(QWheelEvent *e)
{
	if (!hasFocus()) {
		e->ignore();
		return;
	}
	QDoubleSpinBox::wheelEvent(e);
}

ValueSlider::ValueSlider(double lo, double hi, double step, int decimals, QWidget *parent)
	: QWidget(parent), slider_(new JumpSlider(this)), box_(new NumberBox(this)), settle_(new QTimer(this)), lo_(lo),
	  step_(step > 0 ? step : 1)
{
	if (hi < lo)
		std::swap(lo, hi);
	lo_ = lo;
	const int n = std::max(1, std::min(100000, (int)std::lround((hi - lo) / step_)));
	slider_->setRange(0, n);
	slider_->setSingleStep(1);
	slider_->setPageStep(std::max(1, n / 10));
	box_->setRange(lo, hi);
	box_->setDecimals(decimals);
	box_->setSingleStep(step_);
	box_->setFixedWidth(64);
	box_->setToolTip(QStringLiteral("Type a value and press Enter"));
	auto *h = new QHBoxLayout(this);
	h->setContentsMargins(0, 0, 0, 0);
	h->setSpacing(8);
	h->addWidget(slider_, 1);
	h->addWidget(box_);
	settle_->setSingleShot(true);
	settle_->setInterval(250);
	connect(settle_, &QTimer::timeout, this, &ValueSlider::commit);
	connect(slider_, &QSlider::valueChanged, this, [this](int pos) {
		const double v = fromPos(pos);
		{
			const QSignalBlocker b(box_);
			box_->setValue(v);
		}
		emit valueChanged(box_->value());
		if (!slider_->isSliderDown())
			settle_->start(); // a key, the wheel or a click that is not held: commit after the pause
	});
	connect(slider_, &QSlider::sliderReleased, this, [this]() {
		settle_->stop();
		commit();
	});
	connect(box_, &QDoubleSpinBox::valueChanged, this, [this](double v) {
		{
			const QSignalBlocker b(slider_);
			slider_->setValue(toPos(v));
		}
		emit valueChanged(v);
		settle_->stop();
		commit();
	});
}

double ValueSlider::fromPos(int pos) const
{
	return std::clamp(lo_ + pos * step_, box_->minimum(), box_->maximum());
}

int ValueSlider::toPos(double v) const
{
	return (int)std::lround((v - lo_) / step_);
}

void ValueSlider::commit()
{
	const double v = box_->value();
	if (hasLast_ && std::abs(v - last_) < 1e-9)
		return;
	last_ = v;
	hasLast_ = true;
	emit committed(v);
}

void ValueSlider::setValue(double v)
{
	const QSignalBlocker b1(slider_), b2(box_);
	box_->setValue(v);
	slider_->setValue(toPos(box_->value()));
	settle_->stop();
	last_ = box_->value();
	hasLast_ = true;
}

double ValueSlider::value() const
{
	return box_->value();
}

void ValueSlider::setSuffix(const QString &s)
{
	box_->setSuffix(s);
}

void ValueSlider::setPageStep(double v)
{
	slider_->setPageStep(std::max(1, (int)std::lround(v / step_)));
}

void ValueSlider::setBoxWidth(int px)
{
	box_->setFixedWidth(px);
}

bool ValueSlider::probeClick(double fraction)
{
	if (!isEnabled())
		return false;
	// The track as the style lays it out: the point whose value is that share of the range.
	const int target = (int)std::lround(std::clamp(fraction, 0.0, 1.0) * slider_->maximum());
	QPoint at = slider_->pointFor(target);
	// a press on the handle itself would be a drag, not a jump: tests click away from it
	const QPointF g = slider_->mapToGlobal(QPointF(at));
	QMouseEvent press(QEvent::MouseButtonPress, QPointF(at), g, Qt::LeftButton, Qt::LeftButton, Qt::NoModifier);
	QApplication::sendEvent(slider_, &press);
	QMouseEvent release(QEvent::MouseButtonRelease, QPointF(at), g, Qt::LeftButton, Qt::NoButton, Qt::NoModifier);
	QApplication::sendEvent(slider_, &release);
	return true;
}

bool ValueSlider::probeType(const QString &text)
{
	if (!isEnabled())
		return false;
	box_->setFocus(Qt::OtherFocusReason);
	box_->selectAll();
	QKeyEvent del(QEvent::KeyPress, Qt::Key_Delete, Qt::NoModifier);
	QApplication::sendEvent(box_, &del); // clears the selected text
	for (const QChar ch : text) {
		QKeyEvent k(QEvent::KeyPress, 0, Qt::NoModifier, QString(ch));
		QApplication::sendEvent(box_, &k);
	}
	QKeyEvent enter(QEvent::KeyPress, Qt::Key_Return, Qt::NoModifier);
	QApplication::sendEvent(box_, &enter);
	return true;
}

bool ValueSlider::probeKey(int key)
{
	if (!isEnabled())
		return false;
	slider_->setFocus(Qt::OtherFocusReason);
	QKeyEvent k(QEvent::KeyPress, key, Qt::NoModifier);
	QApplication::sendEvent(slider_, &k);
	return true;
}

bool ValueSlider::probeWheel(int steps, bool focused)
{
	if (!isEnabled())
		return false;
	if (focused)
		slider_->setFocus(Qt::OtherFocusReason);
	else if (slider_->hasFocus() || box_->hasFocus())
		setFocus(Qt::OtherFocusReason), slider_->clearFocus(), box_->clearFocus();
	const QPointF at(slider_->rect().center());
	QWheelEvent w(at, slider_->mapToGlobal(at), QPoint(), QPoint(0, 120 * steps), Qt::NoButton, Qt::NoModifier, Qt::NoScrollPhase, false);
	QApplication::sendEvent(slider_, &w);
	return true;
}
