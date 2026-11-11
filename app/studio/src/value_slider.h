// SPDX-License-Identifier: GPL-3.0-or-later
// One slider for every number in the studio window (D330, user 2026-11-10: "the drag slider only drag and it need to
// be clicked and change in values"). A horizontal slider with an editable number box next to it:
//   - a click anywhere on the slider jumps to that value (and keeps dragging from there while the button is held);
//   - the number box takes a typed value, applied with Enter (or when it loses focus);
//   - arrow keys step by one step, PageUp / PageDown by a page, Home / End go to the ends (slider focused);
//   - the mouse wheel only changes the value while the slider or the box has focus, so scrolling a panel past a slider
//     never changes it.
// valueChanged fires on every change (dragging included) for live previews; committed fires once the user is done:
// on release of a click or drag, on Enter in the box, and 250 ms after the last key or wheel step. committed never
// fires twice in a row for the same value. setValue (from code) fires neither.
#pragma once

#include <QDoubleSpinBox>
#include <QPointer>
#include <QSlider>
#include <QWidget>

class QLabel;
class QTimer;

// The slider part: a click on the track jumps there; the wheel needs focus.
class JumpSlider : public QSlider {
public:
	explicit JumpSlider(QWidget *parent = nullptr);
	int valueAt(const QPoint &pos) const; // the slider value under a point (track geometry of the current style)
	QPoint pointFor(int value) const;     // the centre of the handle when it shows value

protected:
	void mousePressEvent(QMouseEvent *e) override;
	void wheelEvent(QWheelEvent *e) override; // one notch = one step

private:
	int wheelRest_ = 0; // partial notches (fine-scroll touchpads)
};

// The number box: the wheel needs focus.
class NumberBox : public QDoubleSpinBox {
public:
	explicit NumberBox(QWidget *parent = nullptr);

protected:
	void wheelEvent(QWheelEvent *e) override; // one notch = one step

private:
	int wheelRest_ = 0;
};

class ValueSlider : public QWidget {
	Q_OBJECT
public:
	// lo..hi in steps of step (at most 100000 positions); decimals for the box.
	ValueSlider(double lo, double hi, double step, int decimals, QWidget *parent = nullptr);
	~ValueSlider() override;
	void setValue(double v); // from code: no signals
	double value() const;
	void setSuffix(const QString &s);
	void setPageStep(double v); // in value units (default: a tenth of the range, at least one step)
	void setBoxWidth(int px);
	JumpSlider *slider() const { return slider_; }
	NumberBox *box() const { return box_; }

	// Headless probes (tests only): real events sent to the real widgets, so their own handlers run.
	bool probeClick(double fraction); // a press and release on the track at that share of its width (0..1)
	bool probeType(const QString &text); // types into the box and presses Enter
	bool probeKey(int key);           // one key press on the slider (Qt::Key_Right, Qt::Key_PageUp, ...)
	bool probeWheel(int steps, bool focused); // wheel notches over the slider, with or without focus first
	// a press on the track at share `from`, held still for holdMs, then moved to share `to` and released
	bool probeHoldDrag(double from, double to, int holdMs);
	bool probeBoxKey(int key, int times); // key presses in the number box (Qt::Key_Up steps it), one after another
	// Value bubble (D336, components.slider.valueBubble): the value in a small bubble above the handle while it is
	// dragged. Pinned (the theme specimen page): shown whenever the slider is visible and the pack asks for it.
	void setBubblePinned(bool on);
	bool bubbleShown() const;
	void updateBubble(); // show, move or hide the value bubble (after a layout change: call again)

signals:
	void valueChanged(double v);
	void committed(double v);

private:
	double fromPos(int pos) const;
	int toPos(double v) const;
	void commit();

	JumpSlider *slider_;
	NumberBox *box_;
	QTimer *settle_; // key and wheel steps: commit after a short pause
	double lo_, step_;
	double last_ = 0;     // the last committed value
	bool hasLast_ = false;
	QPointer<QLabel> bubble_; // child of the window, created on first use, deleted with the slider
	bool bubblePinned_ = false;
};
