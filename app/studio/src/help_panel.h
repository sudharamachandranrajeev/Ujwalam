// SPDX-License-Identifier: GPL-3.0-or-later
// Floating help (D294 proposed): the "?" button in the top bar opens this panel under it. Two illustrated sections,
// "How clips are made" and "Posting your clips", each with a "Show me" button that runs a short tour on the related
// controls, plus "Replay the welcome tour". The pictures are drawn with Qt (no image files). Non-modal: a child widget
// of the main window that never takes focus; it slides in and fades unless motion is off. The posting text says what
// is built today, what needs the user's typed yes, and what does not exist yet; keep it in step with services/posting.
#pragma once

#include "coach.h"

#include <QFrame>

class QLabel;
class QPushButton;
class QToolButton;
class QVBoxLayout;

class HelpArt : public QWidget { // the little pictures
	Q_OBJECT
public:
	enum Kind { Clips, Posting };
	explicit HelpArt(Kind kind, QWidget *parent);
	QSize sizeHint() const override;
	bool hasHeightForWidth() const override { return true; }
	int heightForWidth(int w) const override;

protected:
	void paintEvent(QPaintEvent *) override;

private:
	Kind kind_;
};

class HelpPanel : public QFrame {
	Q_OBJECT
public:
	HelpPanel(QWidget *host, AnchorResolver resolve);
	void open();
	void close();
	void toggle() { isOpen() ? close() : open(); }
	bool isOpen() const { return open_; }
	void refresh(); // after the window moved or resized
	// What this build has switched on (feature flags `posting`, `auto-post`): one honest status line in the posting section.
	void setAvoid(std::function<QList<QRect>()> f) { avoid_ = std::move(f); } // native preview windows paint over Qt widgets
	void setFacts(bool postingOn, bool autoPostOn);
	void click(const QString &what); // probe: show-clips | show-posting | replay | close
	QJsonObject probe() const;

signals:
	void showMe(const QString &tourId);
	void replayTour();
	void closed();

private:
	void place();
	QPoint home() const;
	QWidget *host_;
	AnchorResolver resolve_;
	QLabel *facts_;
	QPushButton *showClips_, *showPosting_, *replay_;
	QToolButton *close_;
	std::function<QList<QRect>()> avoid_;
	bool open_ = false, postingOn_ = false, autoOn_ = false;
};
