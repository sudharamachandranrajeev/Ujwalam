// SPDX-License-Identifier: GPL-3.0-or-later
// "Behind the scenes" hints (D294 proposed): one small card at a time, pointing at the part of the window the news is
// about, shown the first time something happens. It hides itself after about 8 s unless the mouse is over it. Close
// (x) or "Got it" hides it now; "Don't show this again" remembers that for good (the Guide stores it in
// settings.json ui.guide.dismissed). Child widget of the main window, no focus, no top-level window (a design
// choice; D316 dropped the old no-focus rule).
#pragma once

#include "coach.h"

#include <QObject>
#include <QTimer>

class HintBubble : public Bubble {
	Q_OBJECT
public:
	explicit HintBubble(QWidget *host);
	void setContent(const QString &title, const QString &text);
	bool never() const;
	void setNever(bool on);
	void click(const QString &what); // probe: "got-it" | "close"
	void armTimer();                 // (re)start the auto-hide

signals:
	void dismissed(bool never);

protected:
	void enterEvent(QEnterEvent *) override;
	void leaveEvent(QEvent *) override;

private:
	QLabel *title_, *text_;
	QCheckBox *never_;
	QPushButton *gotIt_;
	QToolButton *close_;
	QTimer *timer_;
};

class Hints : public QObject {
	Q_OBJECT
public:
	static constexpr int kAutoHideMs = 8000;
	Hints(QWidget *host, AnchorResolver resolve);
	// Shows the hint now; false when one is already showing or the anchor is not on screen.
	bool show(const QString &id, const QString &anchor, const QString &title, const QString &text);
	bool showing() const { return !id_.isEmpty(); }
	QString currentId() const { return id_; }
	void hideNow();
	void refresh();
	void click(const QString &what, bool tickNever);
	QJsonObject probe() const;
	Bubble *bubble() const { return bubble_; }

signals:
	void closed(const QString &id, bool neverAgain);

private:
	QWidget *host_;
	AnchorResolver resolve_;
	HintBubble *bubble_;
	QString id_, anchor_;
	int seen_ = 0;
};
