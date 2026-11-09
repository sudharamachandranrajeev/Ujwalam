// SPDX-License-Identifier: GPL-3.0-or-later
// Task bar (D287): shows what the software is doing, in plain words, without ever getting in the way. A chip in the
// status bar ("2 tasks running" + a thin bar; hidden when idle), a slide-up list of tasks on click, and short toasts
// when something finishes or fails. Everything is a child widget of the main window: no top-level window, no focus,
// no modal dialog, toasts let mouse clicks through (only their close button takes one). The tasks come from the UI
// server's status snapshot (tasks[]; services/studio-ui/tasks.mjs).
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
class QToolButton;
class QVBoxLayout;
class QVariantAnimation;

namespace tasktime {
// "2:13 elapsed · about 4 min left" from a task's elapsedMs / etaMs (services/studio-ui/tasks.mjs, D311 proposed);
// "time left unknown" when the server could not measure a rate. Shared by the task list and the tray.
QString text(const QJsonObject &t);
QString duration(double ms); // m:ss, or h:mm:ss
// 0..1, or -1 when the amount of work is unknown
double fraction(const QJsonObject &t);
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

class TaskChip : public QWidget {
	Q_OBJECT
public:
	explicit TaskChip(QWidget *parent);
	void setState(int running, int waiting, double fraction, const QString &tip);
	QString text() const;

signals:
	void clicked();

protected:
	void mouseReleaseEvent(QMouseEvent *e) override;
	void paintEvent(QPaintEvent *) override;
	void showEvent(QShowEvent *) override;
	void hideEvent(QHideEvent *) override;

private:
	void sync();
	QLabel *text_;
	SmoothBar *bar_;
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

private:
	QString id_;
	bool finished_ = false;
	QLabel *title_, *state_, *note_, *time_;
	SmoothBar *bar_;
	QToolButton *close_;
};

class Toast : public QFrame {
	Q_OBJECT
public:
	Toast(const QString &title, const QString &note, bool failed, QWidget *parent);
signals:
	void closeRequested(Toast *t);
};

class TaskBar : public QObject {
	Q_OBJECT
public:
	explicit TaskBar(QMainWindow *host);
	TaskChip *chip() const { return chip_; }
	// tasks from the status snapshot; serverNowMs = the snapshot's own clock (task times use it)
	void update(const QJsonArray &tasks, double serverNowMs);
	void reposition(); // after the window moved or resized
	void setPanelOpen(bool open);
	bool panelOpen() const { return open_; }
	void dismissFirstFinished();
	QJsonObject probe() const;
	int active() const { return running_ + waiting_; } // running + waiting (the close question, D311 proposed)
	const QJsonArray &tasks() const { return tasks_; }

private:
	void rebuildRows();
	void toast(const QString &title, const QString &note, bool failed);
	void closeToast(Toast *t);
	void layoutToasts(bool animate);
	QMainWindow *host_;
	TaskChip *chip_;
	QFrame *panel_;
	QVBoxLayout *rows_;
	QLabel *empty_, *count_;
	QMap<QString, TaskRow *> rowById_;
	QMap<QString, QString> lastState_; // id -> state seen last
	QSet<QString> dismissed_;
	QJsonArray tasks_;
	QVector<Toast *> toasts_;
	QPointer<QVariantAnimation> panelAnim_; // the list's slide (self-deleting); a new slide stops the old one
	bool open_ = false, first_ = true;
	int running_ = 0, waiting_ = 0, shown_ = 0, startToasts_ = 0;
};
