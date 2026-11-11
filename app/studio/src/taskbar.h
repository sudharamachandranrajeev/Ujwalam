// SPDX-License-Identifier: GPL-3.0-or-later
// Task panel (D287; reworked after the user's feedback of 2026-11-10): shows what the software is doing, in plain words,
// without ever getting in the way. A button at the top right of the window ("2 tasks"; quiet "Tasks" when only finished
// ones are listed; hidden when there are none) opens a panel under it with every task in full: name, current stage in
// plain words and its step, the count ("frame 412 of 3148") with a percent bar, elapsed time, time left measured from
// the real rate ("estimating..." until there is one), when the last progress came, a Stop button, and a warning when a
// running task has sent no progress for a while (data/studio/tasks.json). Short notifications appear at the top right
// when a long job starts and when a task finishes or fails; a click on one opens the panel. Everything is a child widget
// of the main window: no top-level window, no focus, no modal dialog. The tasks come from the UI server's status
// snapshot (tasks[]; services/studio-ui/tasks.mjs).
#pragma once

#include <QFrame>
#include <QJsonArray>
#include <QJsonObject>
#include <QMap>
#include <QObject>
#include <QPointer>
#include <QSet>
#include <QVector>
#include <QWidget>

class QLabel;
class QMainWindow;
class QPushButton;
class QScrollArea;
class QToolButton;
class QVBoxLayout;
class QVariantAnimation;

namespace tasktime {
// "2:13 elapsed · about 4 min left" from a task's elapsedMs / etaMs (services/studio-ui/tasks.mjs, D311 proposed);
// "estimating time left" while the rate is being measured, "time left unknown" when the amount of work is unknown.
// Shared by the task panel, the close question and the tray.
QString text(const QJsonObject &t);
QString duration(double ms); // m:ss, or h:mm:ss
// 0..1, or -1 when the amount of work is unknown
double fraction(const QJsonObject &t);
// The panel's lines for one task (also in the probe, so tests read what the user reads).
QString stageLine(const QJsonObject &t); // "Step 1 of 5: Reading the game screen"
QString countLine(const QJsonObject &t); // "Frame 412 of 3,148 (13%)"
QString etaLine(const QJsonObject &t);   // "About 4 min left in this step" / "Estimating time left..."
QString lastLine(const QJsonObject &t);  // "Last progress 12 s ago" / "No progress yet (started 3:10 ago)"
QString stallLine(const QJsonObject &t); // "No progress for 5 min - it may be stuck", or empty
QString ago(double ms);                  // "12 s", "5 min", "1 h 4 min"
} // namespace tasktime

// A thin progress bar whose value glides to its target (220 ms, OutCubic); fraction < 0 = unknown, shown as a sweep.
class SmoothBar : public QWidget {
public:
	explicit SmoothBar(int height, QWidget *parent = nullptr);
	void setProgress(const QString &state, double fraction);
	QSize sizeHint() const override { return {120, h_}; }

protected:
	void paintEvent(QPaintEvent *) override;
	void showEvent(QShowEvent *) override;
	void hideEvent(QHideEvent *) override;

private:
	void sync();
	int h_;
	QString state_ = QStringLiteral("running");
	double value_ = 0, target_ = 0, phase_ = 0;
	bool indeterminate_ = false;
	// glide_ deletes itself when it ends (motion::run): a QPointer, never a raw pointer. A raw one here was the
	// 2026-11-08 studio crash (stop() on the freed animation at the next status poll).
	QPointer<QVariantAnimation> glide_;
	QVariantAnimation *sweep_ = nullptr; // owned: deleted only by sync()
};

// The top-right button: a pulsing dot while something runs, "2 tasks" (or "Tasks" when only finished ones are listed),
// a red outline when a task may be stuck. Click: open or close the panel.
class TaskChip : public QWidget {
	Q_OBJECT
public:
	explicit TaskChip(QWidget *parent);
	void setState(int running, int waiting, int listed, int stalled, const QString &tip);
	QString text() const;
	bool quiet() const { return !active_; }

signals:
	void clicked();

protected:
	void mouseReleaseEvent(QMouseEvent *e) override;
	void paintEvent(QPaintEvent *) override;
	void showEvent(QShowEvent *) override;
	void hideEvent(QHideEvent *) override;

private:
	void sync();
	void render(); // the label from plain_: in square brackets when the pack's chip variant is bracket (D336)
	QLabel *text_;
	QString plain_; // the chip's words without decoration (text() returns it)
	qreal pulse_ = 1.0;
	bool active_ = false;
	QVariantAnimation *pulseAnim_ = nullptr;
};

class TaskRow : public QFrame {
	Q_OBJECT
public:
	explicit TaskRow(const QString &id, QWidget *parent);
	void setTask(const QJsonObject &t);
	QString id() const { return id_; }
	bool finished() const { return finished_; }

signals:
	void dismissed(const QString &id);
	void stopRequested(const QString &id);

private:
	QString id_;
	bool finished_ = false;
	QLabel *title_, *state_, *stage_, *count_, *time_, *last_, *note_, *warn_;
	SmoothBar *bar_;
	QToolButton *close_;
	QPushButton *stop_;
};

// A notification at the top right: readable size, the theme's text colour on the panel colour, a coloured edge (accent;
// danger for a failure). A click opens the task panel; the x closes it; it hides by itself after a few seconds.
class Toast : public QFrame {
	Q_OBJECT
public:
	Toast(const QString &title, const QString &note, bool failed, QWidget *parent);
signals:
	void closeRequested(Toast *t);
	void clicked(Toast *t);

protected:
	void mouseReleaseEvent(QMouseEvent *e) override;
};

class TaskBar : public QObject {
	Q_OBJECT
public:
	explicit TaskBar(QMainWindow *host);
	TaskChip *chip() const { return chip_; } // the caller puts it in the top bar
	// tasks from the status snapshot; serverNowMs = the snapshot's own clock (task times use it)
	void update(const QJsonArray &tasks, double serverNowMs);
	void reposition(); // after the window moved or resized
	void setPanelOpen(bool open);
	bool panelOpen() const { return open_; }
	void dismissFirstFinished();
	void clearFinished(); // the panel's "Clear finished" button: every done or failed row goes; running ones stay
	void clickFirstToast(); // tests: what a click on a notification does
	QJsonObject probe() const;
	// A short notification without a task (LU2: a data file that was not applied).
	void notice(const QString &title, const QString &note, bool failed) { toast(title, note, failed); }
	int active() const { return running_ + waiting_; } // running + waiting (the close question, D311 proposed)
	const QJsonArray &tasks() const { return tasks_; }

signals:
	void stopRequested(const QString &id); // a task's Stop button (the window asks, then stops the background tasks)

private:
	void rebuildRows();
	void toast(const QString &title, const QString &note, bool failed);
	void closeToast(Toast *t);
	void layoutToasts(bool animate);
	QPoint panelPos() const;
	int topY() const; // just under the top bar
	QMainWindow *host_;
	TaskChip *chip_;
	QFrame *panel_;
	QScrollArea *scroll_;
	QVBoxLayout *rows_;
	QLabel *empty_, *count_;
	QToolButton *clearBtn_;
	QMap<QString, TaskRow *> rowById_;
	QMap<QString, QString> lastState_; // id -> state seen last
	QSet<QString> dismissed_, warned_;
	QJsonArray tasks_;
	QVector<Toast *> toasts_;
	QPointer<QVariantAnimation> panelAnim_; // the list's slide (self-deleting); a new slide stops the old one
	bool open_ = false, first_ = true;
	int running_ = 0, waiting_ = 0, stalled_ = 0, shown_ = 0, startToasts_ = 0, toastsShown_ = 0, toastClicks_ = 0;
	QString lastToast_;
	QStringList toastLog_; // the last 10 notification titles (probe)
};
