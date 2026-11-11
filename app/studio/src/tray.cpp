// SPDX-License-Identifier: GPL-3.0-or-later
#include "tray.h"
#include "taskbar.h"
#include "theme.h"

#include <QAction>
#include <QCursor>
#include <QFrame>
#include <QGuiApplication>
#include <QHBoxLayout>
#include <QLabel>
#include <QMenu>
#include <QPushButton>
#include <QScreen>
#include <QSystemTrayIcon>
#include <QTimer>
#include <QVBoxLayout>
#include <algorithm>
#include <cmath>

namespace {
bool isActive(const QJsonObject &t)
{
	const QString st = t.value(QStringLiteral("state")).toString();
	return st == QStringLiteral("running") || st == QStringLiteral("waiting");
}
QString line(const QJsonObject &t)
{
	const double f = tasktime::fraction(t);
	QString s = t.value(QStringLiteral("title")).toString();
	if (t.value(QStringLiteral("state")).toString() == QStringLiteral("running") && f >= 0)
		s += QStringLiteral(" (%1%)").arg(int(std::lround(f * 100)));
	const QString tt = tasktime::text(t);
	return tt.isEmpty() ? s : s + QStringLiteral(" - ") + tt;
}
} // namespace

TrayKeeper::TrayKeeper(const QIcon &icon, QObject *parent) : QObject(parent), icon_(icon)
{
	bool ok = false;
	const int ms = qEnvironmentVariableIntValue("UJWALAM_TRAY_FINISH_MS", &ok);
	if (ok && ms >= 0)
		finishMs_ = std::min(ms, 60000);
}

TrayKeeper::~TrayKeeper()
{
	if (list_)
		list_->deleteLater();
	delete menu_;
}

int TrayKeeper::activeCount(const QJsonArray &tasks)
{
	int n = 0;
	for (const QJsonValue &v : tasks)
		n += isActive(v.toObject()) ? 1 : 0;
	return n;
}

void TrayKeeper::begin(const QJsonArray &tasks)
{
	active_ = true;
	finishing_ = false;
	if (!menu_)
		menu_ = new QMenu();
	if (QSystemTrayIcon::isSystemTrayAvailable() && !tray_) {
		tray_ = new QSystemTrayIcon(icon_, this);
		tray_->setContextMenu(menu_);
		// Only a click opens the list (never by itself); a right click shows the menu (Qt does that).
		connect(tray_, &QSystemTrayIcon::activated, this, [this](QSystemTrayIcon::ActivationReason r) {
			if (r == QSystemTrayIcon::Trigger || r == QSystemTrayIcon::DoubleClick)
				showList();
		});
	}
	if (tray_) {
		tray_->show();
		tray_->showMessage(QStringLiteral("Ujwalam is still working"),
				   QStringLiteral("Tasks keep running here in the tray. Click the icon to see them."), QSystemTrayIcon::Information, 4000);
	}
	messages_++;
	lastMessage_ = QStringLiteral("still working");
	update(tasks);
}

void TrayKeeper::end()
{
	active_ = false;
	finishing_ = false;
	finishGen_++; // a pending "all finished" countdown ends with the tray
	if (list_)
		list_->hide();
	if (tray_)
		tray_->hide();
}

void TrayKeeper::update(const QJsonArray &tasks)
{
	if (!active_)
		return;
	tasks_ = tasks;
	const int n = activeCount(tasks);
	QStringList parts;
	for (const QJsonValue &v : tasks)
		if (isActive(v.toObject()))
			parts << line(v.toObject());
	tip_ = n == 0 ? QStringLiteral("Ujwalam: all tasks finished")
		      : QStringLiteral("Ujwalam: %1 task%2 running\n%3").arg(n).arg(n == 1 ? QString() : QStringLiteral("s")).arg(parts.join(QLatin1Char('\n')));
	if (tray_)
		tray_->setToolTip(tip_.left(120)); // Windows cuts tray tooltips at 127 characters
	rebuild();
	if (n > 0 && finishing_) {
		// A new task started during the "all finished" countdown: the countdown is cancelled, the tray stays.
		finishing_ = false;
		finishGen_++;
		cancels_++;
		if (tray_)
			tray_->showMessage(QStringLiteral("Ujwalam is still working"), QStringLiteral("A new task started; Ujwalam stays in the tray."),
					   QSystemTrayIcon::Information, 4000);
		messages_++;
		lastMessage_ = QStringLiteral("still working");
	}
	if (n == 0 && !finishing_) {
		finishing_ = true;
		const int gen = ++finishGen_;
		if (tray_)
			tray_->showMessage(QStringLiteral("Ujwalam: all tasks finished"), QStringLiteral("Nothing is running any more; Ujwalam has closed."),
					   QSystemTrayIcon::Information, 4000);
		messages_++;
		lastMessage_ = QStringLiteral("all finished");
		// Time to read the notification; then the studio ends (and the launcher stops the rest).
		QTimer::singleShot(finishMs_ >= 0 ? finishMs_ : tray_ ? 3000 : 300, this, [this, gen]() {
			// Checked again when it fires: still this countdown, still in the tray, still nothing running.
			if (stillFinished(gen))
				emit allFinished(gen);
		});
	}
}

void TrayKeeper::rebuild()
{
	if (menu_) {
		menu_->clear();
		for (const QJsonValue &v : tasks_) {
			QAction *a = menu_->addAction(line(v.toObject()));
			a->setEnabled(false);
		}
		if (!tasks_.isEmpty())
			menu_->addSeparator();
		connect(menu_->addAction(QStringLiteral("Open Ujwalam")), &QAction::triggered, this, &TrayKeeper::openRequested);
		connect(menu_->addAction(QStringLiteral("Stop all and quit")), &QAction::triggered, this, &TrayKeeper::stopAllRequested);
	}
	if (!list_ || !rows_)
		return;
	while (QLayoutItem *it = rows_->takeAt(0)) {
		if (it->widget())
			it->widget()->deleteLater();
		delete it;
	}
	for (const QJsonValue &v : tasks_) {
		const QJsonObject t = v.toObject();
		auto *row = new QFrame(list_);
		row->setObjectName(QStringLiteral("taskRow"));
		auto *rv = new QVBoxLayout(row);
		theme::margins(rv, 10, 6, 10, 8);
		theme::space(rv, 3);
		auto *title = new QLabel(t.value(QStringLiteral("title")).toString(), row);
		title->setWordWrap(true);
		rv->addWidget(title);
		auto *bar = new SmoothBar(5, row);
		const QString st = t.value(QStringLiteral("state")).toString();
		bar->setProgress(st, st == QStringLiteral("waiting") ? 0.0 : tasktime::fraction(t));
		rv->addWidget(bar);
		auto *tt = new QLabel(tasktime::text(t), row);
		tt->setObjectName(QStringLiteral("muted"));
		rv->addWidget(tt);
		rows_->addWidget(row);
	}
	if (tasks_.isEmpty())
		rows_->addWidget(new QLabel(QStringLiteral("Nothing is running."), list_));
	list_->adjustSize();
}

void TrayKeeper::showList()
{
	if (!list_) {
		// A small popup-style tool window shown without activation, so opening it from the tray leaves the game or other
		// app in front. D316 dropped the hard no-focus rule; this stays as the simpler choice for a quick task list.
		list_ = new QFrame(nullptr, Qt::Tool | Qt::FramelessWindowHint | Qt::WindowStaysOnTopHint | Qt::WindowDoesNotAcceptFocus);
		list_->setAttribute(Qt::WA_ShowWithoutActivating, true);
		list_->setObjectName(QStringLiteral("taskPanel"));
		list_->setFixedWidth(360);
		auto *v = new QVBoxLayout(list_);
		theme::margins(v, 12, 10, 12, 12);
		theme::space(v, 8);
		auto *head = new QLabel(QStringLiteral("UJWALAM TASKS"), list_);
		head->setObjectName(QStringLiteral("heading"));
		v->addWidget(head);
		rows_ = new QVBoxLayout();
		theme::space(rows_, 6);
		v->addLayout(rows_);
		auto *btns = new QHBoxLayout();
		auto *open = new QPushButton(QStringLiteral("Open Ujwalam"), list_);
		auto *stop = new QPushButton(QStringLiteral("Stop all"), list_);
		auto *hide = new QPushButton(QStringLiteral("Hide"), list_);
		for (QPushButton *b : {open, stop, hide})
			b->setFocusPolicy(Qt::NoFocus);
		connect(open, &QPushButton::clicked, this, &TrayKeeper::openRequested);
		connect(stop, &QPushButton::clicked, this, &TrayKeeper::stopAllRequested);
		connect(hide, &QPushButton::clicked, list_, &QWidget::hide);
		btns->addWidget(open);
		btns->addWidget(stop);
		btns->addStretch(1);
		btns->addWidget(hide);
		v->addLayout(btns);
	}
	if (list_->isVisible()) { // a second click closes it
		list_->hide();
		return;
	}
	rebuild();
	list_->adjustSize();
	if (QScreen *s = QGuiApplication::screenAt(QCursor::pos()) ? QGuiApplication::screenAt(QCursor::pos()) : QGuiApplication::primaryScreen()) {
		const QRect a = s->availableGeometry();
		list_->move(a.right() - list_->width() - 12, a.bottom() - list_->height() - 12);
	}
	list_->show();
	listShows_++;
}

QJsonObject TrayKeeper::probe() const
{
	QJsonObject o;
	o.insert(QStringLiteral("active"), active_);
	o.insert(QStringLiteral("available"), QSystemTrayIcon::isSystemTrayAvailable());
	o.insert(QStringLiteral("iconShown"), tray_ && tray_->isVisible());
	o.insert(QStringLiteral("tooltip"), tip_);
	o.insert(QStringLiteral("running"), activeCount(tasks_));
	o.insert(QStringLiteral("finishing"), finishing_);
	o.insert(QStringLiteral("cancels"), cancels_);
	o.insert(QStringLiteral("listShown"), list_ && list_->isVisible());
	o.insert(QStringLiteral("listShows"), listShows_);
	o.insert(QStringLiteral("messages"), messages_);
	o.insert(QStringLiteral("lastMessage"), lastMessage_);
	o.insert(QStringLiteral("iconNull"), icon_.isNull());
	QJsonArray rows;
	for (const QJsonValue &v : tasks_)
		rows.append(line(v.toObject()));
	o.insert(QStringLiteral("rows"), rows);
	QJsonArray menu;
	if (menu_)
		for (QAction *a : menu_->actions())
			if (!a->isSeparator())
				menu.append(a->text());
	o.insert(QStringLiteral("menu"), menu);
	return o;
}
