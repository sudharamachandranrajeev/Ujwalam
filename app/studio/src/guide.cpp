// SPDX-License-Identifier: GPL-3.0-or-later
#include "guide.h"
#include "coach.h"
#include "help_panel.h"
#include "hints.h"

#include <QAbstractButton>
#include <QApplication>
#include <QCheckBox>
#include <QDialog>
#include <QEvent>
#include <QGroupBox>
#include <QHBoxLayout>
#include <QSignalBlocker>
#include <QLabel>
#include <QMainWindow>
#include <QPushButton>
#include <QRegularExpression>
#include <QStatusBar>
#include <QTimer>
#include <QVBoxLayout>

Guide::Guide(QMainWindow *host, ApiClient *api) : QObject(host), host_(host), api_(api)
{
	auto resolve = [this](const QString &a) { return rectOf(a); };
	auto avoid = [this]() { return previewRects(); };
	coach_ = new Coach(host, resolve);
	hints_ = new Hints(host, resolve);
	help_ = new HelpPanel(host, resolve);
	coach_->card()->setAvoid(avoid);
	hints_->bubble()->setAvoid(avoid);
	help_->setAvoid(avoid);
	host->installEventFilter(this);
	connect(coach_, &Coach::ended, this, [this](const QString &id, bool completed, bool never) {
		if (id == QStringLiteral("welcome") && (completed || never)) {
			tourDone_ = true;
			save(QJsonObject{{QStringLiteral("tourDone"), true}});
			updateSettingsPage();
		}
	});
	connect(hints_, &Hints::closed, this, [this](const QString &id, bool never) {
		if (never)
			addDismissed(id);
	});
	connect(help_, &HelpPanel::showMe, this, [this](const QString &id) {
		help_->close();
		startTour(id);
	});
	connect(help_, &HelpPanel::replayTour, this, [this]() {
		help_->close();
		replayWelcome();
	});
}

void Guide::anchor(const QString &name, std::initializer_list<QWidget *> widgets)
{
	QList<QPointer<QWidget>> l;
	for (QWidget *w : widgets)
		if (w)
			l << QPointer<QWidget>(w);
	anchors_.insert(name, l);
}

void Guide::attachHelpButton(QAbstractButton *b)
{
	anchors_.insert(QStringLiteral("help"), {QPointer<QWidget>(b)});
	connect(b, &QAbstractButton::clicked, this, [this]() {
		if (coach_->active())
			coach_->stop(false);
		hints_->hideNow();
		help_->toggle();
	});
}

QRect Guide::rectOf(const QString &name) const
{
	QList<QPointer<QWidget>> ws = anchors_.value(name);
	if (name == QStringLiteral("taskBar")) { // the top bar that holds the task button (2026-11-10; the status bar before)
		const QList<QPointer<QWidget>> chip = anchors_.value(QStringLiteral("taskChip"));
		QWidget *bar = !chip.isEmpty() && chip.first() ? chip.first()->parentWidget() : nullptr;
		ws = {QPointer<QWidget>(bar && bar != host_ ? bar : host_->statusBar())};
	}
	else if (ws.isEmpty())
		if (QWidget *w = host_->findChild<QWidget *>(name)) // a name another part of the window gave its widget
			ws << QPointer<QWidget>(w);
	QRect r;
	for (const QPointer<QWidget> &w : ws) {
		if (!w || !host_->isAncestorOf(w))
			continue;
		bool hidden = false;
		for (const QWidget *a = w; a && a != host_; a = a->parentWidget())
			hidden = hidden || a->isHidden();
		if (hidden || w->width() < 6 || w->height() < 6)
			continue;
		r = r.united(QRect(w->mapTo(host_, QPoint(0, 0)), w->size()));
	}
	if (r.isEmpty() && name == QStringLiteral("taskChip"))
		return rectOf(QStringLiteral("taskBar")); // the chip is hidden while nothing runs
	return r.intersected(host_->rect());
}

QList<QRect> Guide::previewRects() const
{
	QList<QRect> out;
	for (const char *n : {"previewH", "previewV"})
		if (const QRect r = rectOf(QLatin1String(n)); !r.isEmpty())
			out << r;
	return out;
}

bool Guide::eventFilter(QObject *o, QEvent *e)
{
	if (o == host_ && (e->type() == QEvent::Resize || e->type() == QEvent::Move))
		QTimer::singleShot(0, this, &Guide::refresh);
	return QObject::eventFilter(o, e);
}

void Guide::refresh()
{
	coach_->refresh();
	hints_->refresh();
	help_->refresh();
}

// ---- data and choices ----

void Guide::start()
{
	api_->get(QStringLiteral("ui/api/guide"), [this](bool ok, const QJsonObject &b, const QString &) {
		if (ok) { // an older server has no such route: no tips then, nothing else changes
			tours_ = b.value(QStringLiteral("tours")).toArray();
			hintDefs_ = b.value(QStringLiteral("hints")).toArray();
		}
		textLoaded_ = true;
		maybeWelcome(0);
	});
	api_->get(QStringLiteral("ui/api/settings"), [this](bool ok, const QJsonObject &b, const QString &) {
		const QJsonObject g = b.value(QStringLiteral("settings")).toObject().value(QStringLiteral("ui")).toObject().value(QStringLiteral("guide")).toObject();
		if (ok && !g.isEmpty()) {
			tips_ = g.value(QStringLiteral("tips")).toBool(true);
			tourDone_ = g.value(QStringLiteral("tourDone")).toBool(false);
			dismissed_.clear();
			for (const QJsonValue &v : g.value(QStringLiteral("dismissed")).toArray())
				dismissed_ << v.toString();
		}
		settingsLoaded_ = true;
		maybeWelcome(0);
	});
}

// The welcome tour starts by itself on a shown window, once, for a user who has not finished or dismissed it. Not
// over a modal window (the first-run clip question comes first); it looks again every 2 s, at most 30 times.
void Guide::maybeWelcome(int tries)
{
	if (!textLoaded_ || !settingsLoaded_ || !tips_ || tourDone_ || !host_->isVisible() || (welcomeTried_ && tries == 0))
		return;
	welcomeTried_ = true;
	if (QApplication::activeModalWidget() || coach_->active()) {
		if (tries < 30)
			QTimer::singleShot(2000, this, [this, tries]() { maybeWelcome(tries + 1); });
		return;
	}
	QTimer::singleShot(600, this, [this]() {
		if (tips_ && !tourDone_ && !coach_->active())
			startTour(QStringLiteral("welcome"));
	});
}

void Guide::save(const QJsonObject &part)
{
	api_->post(QStringLiteral("ui/api/settings"), QJsonObject{{QStringLiteral("ui"), QJsonObject{{QStringLiteral("guide"), part}}}},
		   [this](bool ok, const QJsonObject &, const QString &) { saveFailed_ = !ok; });
}

void Guide::setTips(bool on)
{
	if (tips_ == on)
		return;
	tips_ = on;
	save(QJsonObject{{QStringLiteral("tips"), on}});
	if (!on)
		hints_->hideNow();
	updateSettingsPage();
}

void Guide::resetDismissed()
{
	dismissed_.clear();
	tourDone_ = false;
	seenThisSession_.clear();
	save(QJsonObject{{QStringLiteral("dismissed"), QJsonArray()}, {QStringLiteral("tourDone"), false}});
	updateSettingsPage();
}

void Guide::addDismissed(const QString &id)
{
	if (id.isEmpty() || dismissed_.contains(id))
		return;
	dismissed_ << id;
	while (dismissed_.size() > 200)
		dismissed_.removeFirst();
	save(QJsonObject{{QStringLiteral("dismissed"), QJsonArray::fromStringList(dismissed_)}});
	updateSettingsPage();
}

QJsonObject Guide::tourById(const QString &id) const
{
	for (const QJsonValue &v : tours_)
		if (v.toObject().value(QStringLiteral("id")).toString() == id)
			return v.toObject();
	return {};
}

void Guide::startTour(const QString &id)
{
	const QJsonObject t = tourById(id);
	if (t.isEmpty())
		return;
	hints_->hideNow();
	help_->close();
	coach_->start(t, id == QStringLiteral("welcome"));
}

bool Guide::trigger(const QString &trig)
{
	if (!tips_ || !textLoaded_ || coach_->active() || help_->isOpen())
		return false;
	for (const QJsonValue &v : hintDefs_) {
		const QJsonObject h = v.toObject();
		if (h.value(QStringLiteral("trigger")).toString() != trig)
			continue;
		const QString id = h.value(QStringLiteral("id")).toString();
		if (dismissed_.contains(id) || seenThisSession_.contains(id))
			return false;
		if (hints_->show(id, h.value(QStringLiteral("anchor")).toString(), h.value(QStringLiteral("title")).toString(), h.value(QStringLiteral("text")).toString())) {
			seenThisSession_ << id;
			return true;
		}
		return false;
	}
	return false;
}

// What changed since the last snapshot decides which hint to show. No timers, no polling of our own.
void Guide::onStatus(const QJsonObject &s)
{
	const QJsonObject h = s.value(QStringLiteral("host")).toObject(), cl = s.value(QStringLiteral("clips")).toObject();
	const bool live = h.value(QStringLiteral("live")).toBool(), rec = h.value(QStringLiteral("recording")).toBool();
	const bool running = !cl.value(QStringLiteral("running")).toObject().isEmpty();
	const QJsonObject set = cl.value(QStringLiteral("settings")).toObject();
	if (havePrev_) {
		const QString mode = set.value((prevLive_ || live) ? QStringLiteral("live") : QStringLiteral("recording")).toString();
		if (prevRec_ && !rec && mode == QStringLiteral("ask"))
			trigger(QStringLiteral("recording-stopped-ask"));
		if (!prevLive_ && live)
			trigger(QStringLiteral("went-live"));
		if (!prevRunning_ && running)
			trigger(QStringLiteral("clip-run-started"));
	}
	prevLive_ = live;
	prevRec_ = rec;
	prevRunning_ = running;
	havePrev_ = true;
	const QJsonArray tasks = s.value(QStringLiteral("tasks")).toArray();
	// The clipper reports each match's verdict as a task note ("match 2: skipped", stage "gate"); the live review says "N skipped".
	static const QRegularExpression skipped(QStringLiteral("^match \\d+: skipped|(^|[^0-9])[1-9][0-9]* skipped"));
	for (const QJsonValue &v : tasks) {
		const QJsonObject t = v.toObject();
		const QString key = t.value(QStringLiteral("id")).toString() + QLatin1Char('|') + t.value(QStringLiteral("note")).toString();
		if (t.value(QStringLiteral("stage")).toString() == QStringLiteral("gate") && skipped.match(t.value(QStringLiteral("note")).toString()).hasMatch() && !skipSeen_.contains(key)) {
			if (trigger(QStringLiteral("match-skipped")))
				skipSeen_ << key;
			break;
		}
	}
	if (!tasks.isEmpty() && !firstTaskSeen_ && trigger(QStringLiteral("first-task")))
		firstTaskSeen_ = true;
}

void Guide::onLayerEffects(bool has)
{
	if (has)
		trigger(QStringLiteral("layer-with-effects"));
}

void Guide::setFlags(bool postingOn, bool autoPostOn)
{
	help_->setFacts(postingOn, autoPostOn);
}

// ---- Settings > Help & tips ----

void Guide::fillSettingsPage(QVBoxLayout *page, QDialog *dlg)
{
	settingsDlg_ = dlg;
	auto *box = new QGroupBox(QStringLiteral("TIPS FOR NEW USERS"), dlg);
	tipsBox_ = box;
	auto *v = new QVBoxLayout(box);
	v->setSpacing(10);
	auto *on = new QCheckBox(QStringLiteral("Show tips for new users"), box);
	on->setObjectName(QStringLiteral("guideTips"));
	on->setChecked(tips_);
	auto *hint = new QLabel(QStringLiteral("Tips are small cards that explain what Ujwalam is doing, in front of and behind the scenes. These buttons act at once. The ? button in the top bar always opens Help."), box);
	hint->setWordWrap(true);
	hint->setObjectName(QStringLiteral("muted"));
	auto *status = new QLabel(box);
	status->setObjectName(QStringLiteral("guideStatus"));
	auto *reset = new QPushButton(QStringLiteral("Reset all \"Don't show again\""), box);
	reset->setObjectName(QStringLiteral("guideReset"));
	auto *replay = new QPushButton(QStringLiteral("Replay the welcome tour"), box);
	replay->setObjectName(QStringLiteral("guideReplay"));
	auto *row = new QHBoxLayout();
	row->addWidget(reset);
	row->addWidget(replay);
	row->addStretch(1);
	v->addWidget(on);
	v->addWidget(hint);
	v->addWidget(status);
	v->addLayout(row);
	page->addWidget(box);
	page->addStretch(1);
	connect(on, &QCheckBox::toggled, this, &Guide::setTips);
	connect(reset, &QPushButton::clicked, this, &Guide::resetDismissed);
	connect(replay, &QPushButton::clicked, this, [this, dlg]() {
		dlg->reject(); // the tour points at the main window: close Settings first
		QTimer::singleShot(0, this, &Guide::replayWelcome);
	});
	updateSettingsPage();
}

void Guide::updateSettingsPage()
{
	if (!settingsDlg_)
		return;
	if (auto *st = settingsDlg_->findChild<QLabel *>(QStringLiteral("guideStatus")))
		st->setText(QStringLiteral("%1 tip(s) hidden with \"Don't show again\". The welcome tour is %2.")
				    .arg(dismissed_.size())
				    .arg(tourDone_ ? QStringLiteral("done or hidden") : QStringLiteral("not hidden")));
	if (auto *cb = settingsDlg_->findChild<QCheckBox *>(QStringLiteral("guideTips")); cb && cb->isChecked() != tips_) {
		const QSignalBlocker b(cb);
		cb->setChecked(tips_);
	}
}

// ---- headless probe ----

bool Guide::probeAction(const QString &action)
{
	const QStringList p = action.split(QLatin1Char(':'));
	if (p.size() >= 2 && p[0] == QStringLiteral("guide-tour")) {
		if (p[1] == QStringLiteral("start")) {
			startTour(p.size() > 2 ? p[2] : QStringLiteral("welcome"));
			return coach_->active();
		}
		if (!coach_->active())
			return false;
		if (p[1] == QStringLiteral("tick"))
			coach_->setNeverTicked(true);
		else
			coach_->click(p[1]);
		return true;
	}
	if (p.size() == 2 && p[0] == QStringLiteral("guide-hint")) {
		if (p[1] == QStringLiteral("gotit") || p[1] == QStringLiteral("close") || p[1] == QStringLiteral("tick-gotit")) {
			if (!hints_->showing())
				return false;
			hints_->click(p[1] == QStringLiteral("close") ? QStringLiteral("close") : QStringLiteral("got-it"), p[1] == QStringLiteral("tick-gotit"));
			return true;
		}
		return trigger(p[1]);
	}
	if (p.size() == 2 && p[0] == QStringLiteral("guide-help")) {
		if (p[1] == QStringLiteral("open")) {
			if (coach_->active())
				coach_->stop(false);
			help_->open();
			return help_->isOpen();
		}
		help_->click(p[1]);
		return true;
	}
	if (p.size() == 2 && p[0] == QStringLiteral("guide-tips")) {
		setTips(p[1] == QStringLiteral("on"));
		return true;
	}
	if (p.size() == 2 && p[0] == QStringLiteral("guide-settings")) { // the real widgets in Settings > Help & tips
		if (!settingsDlg_)
			return false;
		if (p[1] == QStringLiteral("reset") || p[1] == QStringLiteral("replay")) {
			auto *b = settingsDlg_->findChild<QPushButton *>(p[1] == QStringLiteral("reset") ? QStringLiteral("guideReset") : QStringLiteral("guideReplay"));
			if (!b)
				return false;
			b->click();
			return true;
		}
		if (p[1] == QStringLiteral("tips-on") || p[1] == QStringLiteral("tips-off")) {
			auto *cb = settingsDlg_->findChild<QCheckBox *>(QStringLiteral("guideTips"));
			if (!cb)
				return false;
			cb->setChecked(p[1] == QStringLiteral("tips-on"));
			return true;
		}
	}
	return false;
}

QJsonObject Guide::probe() const
{
	QJsonObject o;
	o.insert(QStringLiteral("ready"), textLoaded_ && settingsLoaded_);
	o.insert(QStringLiteral("tips"), tips_);
	o.insert(QStringLiteral("tourDone"), tourDone_);
	o.insert(QStringLiteral("dismissed"), QJsonArray::fromStringList(dismissed_));
	QJsonArray ids, names;
	for (const QJsonValue &v : tours_)
		ids.append(v.toObject().value(QStringLiteral("id")).toString());
	for (auto it = anchors_.constBegin(); it != anchors_.constEnd(); ++it)
		if (!rectOf(it.key()).isEmpty())
			names.append(it.key());
	o.insert(QStringLiteral("tours"), ids);
	o.insert(QStringLiteral("hintDefs"), hintDefs_.size());
	o.insert(QStringLiteral("anchors"), names);
	o.insert(QStringLiteral("saveFailed"), saveFailed_);
	o.insert(QStringLiteral("coach"), coach_->probe());
	o.insert(QStringLiteral("hint"), hints_->probe());
	o.insert(QStringLiteral("help"), help_->probe());
	return o;
}
