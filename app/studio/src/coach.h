// SPDX-License-Identifier: GPL-3.0-or-later
// Coach marks (D294 proposed): a floating card with an arrow that points at a part of the studio window, a soft dim
// around it, "step N of M", Back / Next / Skip, "Don't show this again" and a close button. The tour text is data
// (data/guide/tour.json, served by the UI server). Everything is a child widget of the main window: no top-level
// window, no focus (every control is NoFocus), the dim lets mouse clicks through, only the card takes them (D191).
// The same Bubble is the hints' card (hints.h). Colours come through guidecol:: so the data-driven themes (branch
// ui/themes: theme::color(name)) swap in with one change in coach.cpp.
#pragma once

#include <QColor>
#include <QJsonArray>
#include <QJsonObject>
#include <QList>
#include <QObject>
#include <QPointer>
#include <QRect>
#include <QString>
#include <QWidget>
#include <functional>

class QCheckBox;
class QLabel;
class QPushButton;
class QToolButton;
class QVBoxLayout;
class QGraphicsOpacityEffect;

namespace guidecol {
QColor panel();
QColor border();
QColor text();
QColor muted();
QColor accent();
QColor accentHi();
QColor field();
QColor ok();
QString css(); // stylesheet for the guide widgets: #guideBtn (+ role=primary), #guideClose, #guideCheck
} // namespace guidecol

// Anchor name -> the rectangle of that part of the window in the host's coordinates; an empty rect = not on screen.
using AnchorResolver = std::function<QRect(const QString &anchor)>;

// A rounded card with an arrow on one side. The arrow room (kArrow) is part of the widget, so the card is
// sizeHint() + 2 * kArrow wide and high.
class Bubble : public QWidget {
	Q_OBJECT
public:
	enum Side { None, Left, Right, Above, Below }; // where the bubble sits relative to its target
	static constexpr int kArrow = 10;
	explicit Bubble(QWidget *host);
	QVBoxLayout *body() const { return body_; }
	// Place next to target (host coordinates) inside the host's rect; pref = Side or None for the best fit. Returns the
	// top-left it chose. Where nothing fits beside the target, the card sits over its middle with no arrow.
	QPoint pointAt(const QRect &target, Side pref = None);
	// Parts of the window the card must not cover: the preview slots are native windows (the host draws into them),
	// which always paint over a Qt widget.
	void setAvoid(std::function<QList<QRect>()> f) { avoid_ = std::move(f); }
	Side arrowSide() const { return side_; }
	// Fade in (and slide a little) / fade out then hide; static when motion is off.
	void appear(QPoint from = QPoint());
	void vanish(std::function<void()> done = {});
	bool shownLogically() const { return open_; }

protected:
	void paintEvent(QPaintEvent *) override;

private:
	QVBoxLayout *body_;
	Side side_ = None;
	int along_ = 0; // arrow position along its edge, widget coordinates
	bool open_ = false;
	std::function<QList<QRect>()> avoid_;
	QPointer<QGraphicsOpacityEffect> fx_;
};

class CoachOverlay : public QWidget { // the dim with a hole; mouse clicks go through
	Q_OBJECT
public:
	explicit CoachOverlay(QWidget *host);
	void setHole(const QRect &r, bool animate);
	void setDim(qreal d) { dim_ = d; update(); }
	QRect hole() const { return hole_.toAlignedRect(); }

protected:
	void paintEvent(QPaintEvent *) override;

private:
	QRectF hole_;
	qreal dim_ = 1.0;
};

// One tour: { id, title, steps: [{id, anchor, title, text, side?}] }.
class Coach : public QObject {
	Q_OBJECT
public:
	Coach(QWidget *host, AnchorResolver resolve);
	// Starts the tour at its first step whose anchor is on screen; false when no step can be shown.
	// offerNever: show the "Don't show this again" box (the welcome tour).
	bool start(const QJsonObject &tour, bool offerNever);
	bool active() const { return active_; }
	Bubble *card() const { return card_; }
	void next();
	void back();
	void stop(bool completed);
	void refresh(); // after the window moved or resized (and before a picture): re-place the card and the dim
	void setNeverTicked(bool on);
	void click(const QString &what); // probe: next | back | skip | close (the real buttons)
	QJsonObject probe() const;

signals:
	// The tour ended: completed = the last step's Done; neverAgain = the box was ticked.
	void ended(const QString &tourId, bool completed, bool neverAgain);

private:
	void show(int idx, bool animate);
	int step(int from, int dir) const; // next available step index in a direction, -1 = none
	bool available(int idx) const;
	QWidget *host_;
	AnchorResolver resolve_;
	CoachOverlay *dim_;
	Bubble *card_;
	QLabel *count_, *title_, *text_;
	QCheckBox *never_;
	QPushButton *back_, *next_, *skip_;
	QToolButton *close_;
	QJsonObject tour_;
	QJsonArray steps_;
	int idx_ = -1, total_ = 0, position_ = 0;
	bool active_ = false, offerNever_ = false;
};
