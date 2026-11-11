// SPDX-License-Identifier: GPL-3.0-or-later
// The shared value slider (D330). See value_slider.h.
#include "value_slider.h"

#include "theme.h"

#include <QApplication>
#include <QEventLoop>
#include <QHBoxLayout>
#include <QLabel>
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
	// One notch is one step (Qt's own wheel moves the Windows "lines per notch", 3 by default); a fine-scroll touchpad
	// adds up its partial notches.
	wheelRest_ += e->angleDelta().y();
	const int notches = wheelRest_ / 120;
	wheelRest_ -= notches * 120;
	if (notches != 0)
		setValue(value() + notches * singleStep());
	e->accept();
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
	wheelRest_ += e->angleDelta().y(); // one notch, one step (as the slider)
	const int notches = wheelRest_ / 120;
	wheelRest_ -= notches * 120;
	if (notches != 0)
		stepBy(notches);
	e->accept();
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
	theme::space(h, 8);
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
		updateBubble();
		if (!slider_->isSliderDown())
			settle_->start(); // a key, the wheel or a click that is not held: commit after the pause
	});
	// A mouse gesture commits on release only: the jump of a track click starts the settle timer before the slider is
	// down, so the press stops it (else a hold-and-drag past 250 ms committed a value on the way, Codex review).
	connect(slider_, &QSlider::sliderPressed, settle_, &QTimer::stop);
	connect(slider_, &QSlider::sliderPressed, this, &ValueSlider::updateBubble);
	connect(slider_, &QSlider::sliderReleased, this, [this]() {
		settle_->stop();
		commit();
		updateBubble();
	});
	connect(theme::notifier(), &theme::Notifier::changed, this, &ValueSlider::updateBubble);
	// The box: a step (arrow key held, wheel) waits for the pause like the slider's keys; Enter or leaving the box
	// commits at once.
	connect(box_, &QDoubleSpinBox::valueChanged, this, [this](double v) {
		{
			const QSignalBlocker b(slider_);
			slider_->setValue(toPos(v));
		}
		emit valueChanged(v);
		settle_->start();
	});
	connect(box_, &QAbstractSpinBox::editingFinished, this, [this]() {
		settle_->stop();
		commit();
	});
}

ValueSlider::~ValueSlider()
{
	delete bubble_.data(); // a child of the window, not of the slider
}

void ValueSlider::setBubblePinned(bool on)
{
	bubblePinned_ = on;
	updateBubble();
}

bool ValueSlider::bubbleShown() const
{
	return bubble_ && !bubble_->isHidden();
}

void ValueSlider::updateBubble()
{
	const bool want = theme::componentFlag(QStringLiteral("slider.valueBubble")) && (slider_->isSliderDown() || bubblePinned_);
	if (!want) {
		if (bubble_)
			bubble_->hide();
		return;
	}
	QWidget *win = window(); // or the nearest ancestor that hosts bubbles (the theme specimen's sheet, pictured uncut)
	for (QWidget *p = parentWidget(); p; p = p->parentWidget())
		if (p->property("bubbleHost").toBool()) {
			win = p;
			break;
		}
	if (!bubble_ || bubble_->parentWidget() != win) {
		delete bubble_.data();
		bubble_ = new QLabel(win);
		bubble_->setObjectName(QStringLiteral("valueBubble"));
		bubble_->setAttribute(Qt::WA_TransparentForMouseEvents);
		bubble_->setAlignment(Qt::AlignCenter);
	}
	bubble_->setText(box_->textFromValue(box_->value()) + box_->suffix());
	bubble_->adjustSize();
	const QPoint handle = slider_->mapTo(win, slider_->pointFor(slider_->value()));
	bubble_->move(handle.x() - bubble_->width() / 2, slider_->mapTo(win, QPoint(0, 0)).y() - bubble_->height() - 2);
	bubble_->show();
	bubble_->raise();
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

bool ValueSlider::probeHoldDrag(double from, double to, int holdMs)
{
	if (!isEnabled())
		return false;
	const auto at = [this](double f) { return slider_->pointFor((int)std::lround(std::clamp(f, 0.0, 1.0) * slider_->maximum())); };
	const QPoint a = at(from);
	QMouseEvent press(QEvent::MouseButtonPress, QPointF(a), slider_->mapToGlobal(QPointF(a)), Qt::LeftButton, Qt::LeftButton, Qt::NoModifier);
	QApplication::sendEvent(slider_, &press);
	QEventLoop wait; // the settle timer would fire in here if the press had not stopped it
	QTimer::singleShot(holdMs, &wait, &QEventLoop::quit);
	wait.exec();
	const QPoint b = at(to);
	QMouseEvent move(QEvent::MouseMove, QPointF(b), slider_->mapToGlobal(QPointF(b)), Qt::NoButton, Qt::LeftButton, Qt::NoModifier);
	QApplication::sendEvent(slider_, &move);
	QMouseEvent release(QEvent::MouseButtonRelease, QPointF(b), slider_->mapToGlobal(QPointF(b)), Qt::LeftButton, Qt::NoButton, Qt::NoModifier);
	QApplication::sendEvent(slider_, &release);
	return true;
}

bool ValueSlider::probeBoxKey(int key, int times)
{
	if (!isEnabled())
		return false;
	box_->setFocus(Qt::OtherFocusReason);
	for (int i = 0; i < times; i++) {
		QKeyEvent k(QEvent::KeyPress, key, Qt::NoModifier);
		QApplication::sendEvent(box_, &k);
	}
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
