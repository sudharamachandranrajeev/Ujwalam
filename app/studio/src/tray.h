// SPDX-License-Identifier: GPL-3.0-or-later
// Tray (user 2026-11-09, D310 proposed): when the studio window is closed while tasks still run and the user chose
// "Keep them running in the tray", the studio process stays with only a tray icon. Its tooltip sums the tasks up; a
// click opens a small list (each task: title, progress bar, elapsed time and time left) with Open Ujwalam and Stop
// all; a right click opens the same choices as a menu. Nothing opens by itself and nothing takes focus: the list is a
// tool window shown without activation. When every task has finished, a notification says so and the studio ends
// (the launcher then stops everything else). Without a system tray (headless tests) the same model runs, unseen.
#pragma once

#include <QIcon>
#include <QJsonArray>
#include <QJsonObject>
#include <QObject>
#include <QPointer>

class QFrame;
class QMenu;
class QSystemTrayIcon;
class QVBoxLayout;
class QLabel;

class TrayKeeper : public QObject {
	Q_OBJECT
public:
	explicit TrayKeeper(const QIcon &icon, QObject *parent = nullptr);
	~TrayKeeper() override;
	void begin(const QJsonArray &tasks); // the window was closed into the tray
	void end();                          // the window is back (Open Ujwalam)
	bool active() const { return active_; }
	void update(const QJsonArray &tasks); // every status poll while active
	void showList();                      // a click on the icon (or a probe)
	QString tooltip() const { return tip_; }
	QJsonObject probe() const;
	static int activeCount(const QJsonArray &tasks);

signals:
	void openRequested();
	void stopAllRequested();
	void allFinished(); // every task done or failed: the studio may end

private:
	void rebuild();
	QIcon icon_;
	QSystemTrayIcon *tray_ = nullptr;
	QMenu *menu_ = nullptr;
	QPointer<QFrame> list_;
	QVBoxLayout *rows_ = nullptr;
	QJsonArray tasks_;
	QString tip_;
	bool active_ = false, finishing_ = false;
	int listShows_ = 0, messages_ = 0;
	QString lastMessage_;
};
