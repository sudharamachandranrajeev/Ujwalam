// SPDX-License-Identifier: GPL-3.0-or-later
#include "taskbar.h"
#include "depth.h"
#include "motion.h"
#include "theme.h"

#include <QGraphicsOpacityEffect>
#include <QHBoxLayout>
#include <QLabel>
#include <QMainWindow>
#include <QMouseEvent>
#include <QPainter>
#include <QPointer>
#include <QPushButton>
#include <QScrollArea>
#include <QStyle>
#include <QTimer>
#include <QToolButton>
#include <QVBoxLayout>
#include <QVariantAnimation>
#include <algorithm>
#include <cmath>
#include <iterator>

namespace {
const int kGap = 14;        // from the window's right edge
const int kPanelW = 440;    // wide enough that a task's lines are read in full (they wrap, never cut)
const int kToastW = 360;
const int kToastMs = 6000;  // a notification stays this long (the x or a click closes it sooner)

QColor stateColour(const QString &s)
{
	if (s == QStringLiteral("done"))
		return theme::color(QStringLiteral("ok"));
	if (s == QStringLiteral("failed"))
		return theme::color(QStringLiteral("danger"));
	if (s == QStringLiteral("waiting"))
		return theme::color(QStringLiteral("muted"));
	return theme::color(QStringLiteral("accent"));
}
QString str(const QJsonObject &t, const char *k)
{
	return t.value(QLatin1String(k)).toString();
}
bool isRunning(const QJsonObject &t)
{
	return str(t, "state") == QStringLiteral("running");
}
// Long jobs get a notification when they start (D311 proposed); the studio's own quick actions (saving settings, a
// preview) only when they finish, as before.
bool longJob(const QJsonObject &t)
{
	const QString k = str(t, "kind");
	return !str(t, "id").startsWith(QStringLiteral("ui-")) || k == QStringLiteral("upload") || k == QStringLiteral("import");
}
// The Stop route ends the launcher's background jobs (clip making, uploads); the UI server's own short actions have no stop.
bool stoppable(const QJsonObject &t)
{
	const QString st = str(t, "state");
	return (st == QStringLiteral("running") || st == QStringLiteral("waiting")) && !str(t, "id").startsWith(QStringLiteral("ui-"));
}
QString plural(const QString &unit)
{
	if (unit == QStringLiteral("MB"))
		return unit;
	if (unit.endsWith(QLatin1Char('s')) || unit.endsWith(QStringLiteral("ch")))
		return unit + QStringLiteral("es");
	return unit + QLatin1Char('s');
}
void repolish(QWidget *w)
{
	w->style()->unpolish(w);
	w->style()->polish(w);
}
} // namespace

// ---- tasktime ----

double tasktime::fraction(const QJsonObject &t)
{
	if (str(t, "state") == QStringLiteral("done"))
		return 1.0;
	if (t.value(QStringLiteral("measured")) == QJsonValue(false)) // a step that reports no progress (publish, montage)
		return -1.0;
	const QJsonValue p = t.value(QStringLiteral("progress"));
	if (p.isDouble())
		return std::clamp(p.toDouble(), 0.0, 1.0);
	const double total = t.value(QStringLiteral("total")).toDouble(-1);
	if (total <= 0 || t.value(QStringLiteral("done")).isNull())
		return -1.0;
	return std::clamp(t.value(QStringLiteral("done")).toDouble() / total, 0.0, 1.0);
}

QString tasktime::duration(double ms)
{
	const qint64 s = qint64(std::max(0.0, ms) / 1000.0);
	const qint64 h = s / 3600, m = (s % 3600) / 60, sec = s % 60;
	if (h > 0)
		return QStringLiteral("%1:%2:%3").arg(h).arg(m, 2, 10, QLatin1Char('0')).arg(sec, 2, 10, QLatin1Char('0'));
	return QStringLiteral("%1:%2").arg(m).arg(sec, 2, 10, QLatin1Char('0'));
}

QString tasktime::ago(double ms)
{
	const qint64 s = qint64(std::max(0.0, ms) / 1000.0);
	if (s < 60)
		return QStringLiteral("%1 s").arg(s);
	if (s < 3600)
		return QStringLiteral("%1 min").arg(s / 60);
	return QStringLiteral("%1 h %2 min").arg(s / 3600).arg((s % 3600) / 60);
}

namespace {
// "about 4 min left" / "less than a minute left" from etaMs, or empty when unknown.
QString leftText(const QJsonObject &t)
{
	const QJsonValue eta = t.value(QStringLiteral("etaMs"));
	if (!eta.isDouble())
		return QString();
	const double sec = eta.toDouble() / 1000.0;
	if (sec < 60)
		return QStringLiteral("less than a minute left");
	if (sec < 3600)
		return QStringLiteral("about %1 min left").arg(qint64(std::ceil(sec / 60.0)));
	return QStringLiteral("about %1 h %2 min left").arg(qint64(sec / 3600)).arg(qint64(std::fmod(sec, 3600.0) / 60.0));
}
} // namespace

QString tasktime::text(const QJsonObject &t)
{
	const QString st = str(t, "state");
	const QJsonValue el = t.value(QStringLiteral("elapsedMs"));
	QString out = el.isDouble() ? QStringLiteral("%1 elapsed").arg(duration(el.toDouble())) : QString();
	if (st == QStringLiteral("done") || st == QStringLiteral("failed"))
		return el.isDouble() ? QStringLiteral("took %1").arg(duration(el.toDouble())) : QString();
	QString left;
	if (st == QStringLiteral("waiting"))
		left = QStringLiteral("waiting its turn");
	else {
		const QString l = leftText(t);
		if (!l.isEmpty())
			left = (str(t, "stage").isEmpty() ? QString() : QStringLiteral("this step: ")) + l;
		else // never a guessed number: the rate is being measured, or the amount of work is not known
			left = fraction(t) >= 0 ? QStringLiteral("estimating time left") : QStringLiteral("time left unknown");
		if (t.value(QStringLiteral("stalled")).toBool(false))
			left += QStringLiteral(" · no progress for %1").arg(ago(t.value(QStringLiteral("silentMs")).toDouble()));
	}
	return out.isEmpty() ? left : out + QStringLiteral(" · ") + left;
}

QString tasktime::stageLine(const QJsonObject &t)
{
	if (!isRunning(t))
		return QString();
	QString words = str(t, "stageText");
	if (words.isEmpty())
		words = QStringLiteral("Working");
	const QJsonObject step = t.value(QStringLiteral("step")).toObject();
	const int i = step.value(QStringLiteral("index")).toInt(0), n = step.value(QStringLiteral("count")).toInt(0);
	if (i > 0 && n > 1)
		return QStringLiteral("Step %1 of %2: %3").arg(i).arg(n).arg(words);
	return words;
}

QString tasktime::countLine(const QJsonObject &t)
{
	if (!isRunning(t))
		return QString();
	const double f = fraction(t);
	if (f < 0)
		return QStringLiteral("Working; how much is left is not known for this step");
	const int pct = int(std::floor(f * 100));
	const QString unit = str(t, "unit");
	const QJsonValue d = t.value(QStringLiteral("done")), n = t.value(QStringLiteral("total"));
	if (unit.isEmpty() || !d.isDouble() || !n.isDouble())
		return QStringLiteral("%1% done").arg(pct);
	return QStringLiteral("%1 of %2 %3 (%4%)").arg(qint64(d.toDouble())).arg(qint64(n.toDouble())).arg(plural(unit)).arg(pct);
}

QString tasktime::etaLine(const QJsonObject &t)
{
	const QString st = str(t, "state");
	const QJsonValue el = t.value(QStringLiteral("elapsedMs"));
	const QString elapsed = el.isDouble() ? QStringLiteral("Elapsed %1").arg(duration(el.toDouble())) : QString();
	QString left;
	if (st == QStringLiteral("done") || st == QStringLiteral("failed"))
		return el.isDouble() ? QStringLiteral("Took %1").arg(duration(el.toDouble())) : QString();
	if (st == QStringLiteral("waiting"))
		left = QStringLiteral("Waiting its turn");
	else {
		QString l = leftText(t);
		if (!l.isEmpty()) {
			l[0] = l[0].toUpper();
			left = str(t, "stage").isEmpty() ? l : l + QStringLiteral(" in this step");
		} else
			left = fraction(t) >= 0 ? QStringLiteral("Estimating time left...") : QStringLiteral("Time left unknown");
	}
	return elapsed.isEmpty() ? left : elapsed + QStringLiteral(" · ") + left;
}

QString tasktime::lastLine(const QJsonObject &t)
{
	if (!isRunning(t))
		return QString();
	const QJsonValue s = t.value(QStringLiteral("silentMs"));
	if (!s.isDouble())
		return QString();
	if (t.value(QStringLiteral("progressAt")).isDouble())
		return QStringLiteral("Last progress %1 ago").arg(ago(s.toDouble()));
	return QStringLiteral("No progress yet (started %1 ago)").arg(ago(s.toDouble()));
}

QString tasktime::stallLine(const QJsonObject &t)
{
	if (!isRunning(t) || !t.value(QStringLiteral("stalled")).toBool(false))
		return QString();
	return QStringLiteral("No progress for %1 - it may be stuck").arg(ago(t.value(QStringLiteral("silentMs")).toDouble()));
}

// ---- SmoothBar ----

SmoothBar::SmoothBar(int height, QWidget *parent) : QWidget(parent), h_(height)
{
	setFixedHeight(height);
	setAttribute(Qt::WA_TransparentForMouseEvents);
}

void SmoothBar::setProgress(const QString &state, double fraction)
{
	state_ = state;
	indeterminate_ = fraction < 0 && state == QStringLiteral("running");
	target_ = fraction < 0 ? 0.0 : fraction;
	if (glide_) { // still gliding (a QPointer: null once the animation ended and deleted itself)
		glide_->stop();
		glide_->deleteLater();
	}
	glide_ = motion::run(this, value_, target_, 220, QEasingCurve::OutCubic, [this](const QVariant &v) {
		value_ = v.toDouble();
		update();
	});
	sync();
	update();
}

void SmoothBar::sync()
{
	const bool want = indeterminate_ && isVisible() && motion::systemAnimations();
	if (want && !sweep_) {
		sweep_ = new QVariantAnimation(this);
		sweep_->setStartValue(0.0);
		sweep_->setEndValue(1.0);
		sweep_->setDuration(1400);
		sweep_->setLoopCount(-1);
		sweep_->setEasingCurve(QEasingCurve::InOutSine);
		connect(sweep_, &QVariantAnimation::valueChanged, this, [this](const QVariant &v) {
			phase_ = v.toDouble();
			update();
		});
		sweep_->start();
	} else if (!want && sweep_) {
		sweep_->stop();
		sweep_->deleteLater();
		sweep_ = nullptr;
	}
}

void SmoothBar::showEvent(QShowEvent *)
{
	sync();
}
void SmoothBar::hideEvent(QHideEvent *)
{
	sync();
}

void SmoothBar::paintEvent(QPaintEvent *)
{
	QPainter p(this);
	p.setRenderHint(QPainter::Antialiasing);
	const QRectF r(rect());
	const qreal rad = r.height() / 2;
	p.setPen(Qt::NoPen);
	p.setBrush(theme::color(QStringLiteral("border")));
	p.drawRoundedRect(r, rad, rad);
	p.setBrush(stateColour(state_));
	if (indeterminate_) {
		const qreal w = r.width() * 0.32, x = (r.width() - w) * phase_;
		p.setClipRect(r);
		p.drawRoundedRect(QRectF(x, 0, w, r.height()), rad, rad);
		return;
	}
	if (value_ <= 0.0)
		return;
	p.drawRoundedRect(QRectF(0, 0, std::max<qreal>(r.height(), r.width() * value_), r.height()), rad, rad);
}

// ---- TaskChip ----

TaskChip::TaskChip(QWidget *parent) : QWidget(parent)
{
	setObjectName(QStringLiteral("taskChip"));
	setFocusPolicy(Qt::NoFocus);
	setCursor(Qt::PointingHandCursor);
	setAttribute(Qt::WA_StyledBackground, true);
	auto *h = new QHBoxLayout(this);
	h->setContentsMargins(24, 3, 12, 3); // left room for the pulsing dot
	h->setSpacing(6);
	text_ = new QLabel(this);
	text_->setAttribute(Qt::WA_TransparentForMouseEvents);
	h->addWidget(text_);
	hide();
}

QString TaskChip::text() const
{
	return text_->text();
}

void TaskChip::setState(int running, int waiting, int listed, int stalled, const QString &tip)
{
	active_ = running + waiting > 0;
	QString t;
	if (running > 0)
		t = running == 1 ? QStringLiteral("1 task running") : QStringLiteral("%1 tasks running").arg(running);
	else if (waiting > 0)
		t = waiting == 1 ? QStringLiteral("1 task waiting") : QStringLiteral("%1 tasks waiting").arg(waiting);
	else
		t = QStringLiteral("Tasks"); // only finished ones are listed: a quiet button
	if (stalled > 0)
		t += QStringLiteral(" - %1 may be stuck").arg(stalled);
	text_->setText(t);
	setToolTip(tip.isEmpty() ? QStringLiteral("Show the task list") : tip);
	if (property("quiet").toBool() != !active_ || property("stalled").toBool() != (stalled > 0)) {
		setProperty("quiet", !active_);
		setProperty("stalled", stalled > 0);
		repolish(this);
		repolish(text_);
	}
	setVisible(listed > 0);
	sync();
	update();
}

void TaskChip::sync()
{
	const bool want = active_ && isVisible() && motion::systemAnimations();
	if (want && !pulseAnim_) {
		pulseAnim_ = new QVariantAnimation(this);
		pulseAnim_->setStartValue(0.0);
		pulseAnim_->setEndValue(1.0);
		pulseAnim_->setDuration(1600);
		pulseAnim_->setLoopCount(-1);
		connect(pulseAnim_, &QVariantAnimation::valueChanged, this, [this](const QVariant &v) {
			pulse_ = 0.35 + 0.65 * (0.5 - 0.5 * std::cos(v.toReal() * 6.283185307)); // a slow breath
			update(QRect(6, 0, 18, height()));                                       // only the dot
		});
		pulseAnim_->start();
	} else if (!want && pulseAnim_) {
		pulseAnim_->stop();
		pulseAnim_->deleteLater();
		pulseAnim_ = nullptr;
		pulse_ = 1.0;
	}
}

void TaskChip::showEvent(QShowEvent *)
{
	sync();
}
void TaskChip::hideEvent(QHideEvent *)
{
	sync();
}

void TaskChip::mouseReleaseEvent(QMouseEvent *e)
{
	if (e->button() == Qt::LeftButton && rect().contains(e->position().toPoint()))
		emit clicked();
}

void TaskChip::paintEvent(QPaintEvent *)
{
	QPainter p(this);
	p.setRenderHint(QPainter::Antialiasing);
	QColor c(theme::color(property("stalled").toBool() ? QStringLiteral("danger") : active_ ? QStringLiteral("accentHi") : QStringLiteral("muted")));
	c.setAlphaF(active_ ? pulse_ : 1.0);
	p.setPen(Qt::NoPen);
	p.setBrush(c);
	p.drawEllipse(QPointF(14, height() / 2.0), 4.0, 4.0);
}

// ---- TaskRow ----

TaskRow::TaskRow(const QString &id, QWidget *parent) : QFrame(parent), id_(id)
{
	setObjectName(QStringLiteral("taskRow"));
	auto *v = new QVBoxLayout(this);
	v->setContentsMargins(12, 10, 10, 10);
	v->setSpacing(4);
	auto *top = new QHBoxLayout();
	title_ = new QLabel(this);
	title_->setObjectName(QStringLiteral("taskTitle"));
	title_->setWordWrap(true);
	state_ = new QLabel(this);
	state_->setObjectName(QStringLiteral("muted"));
	close_ = new QToolButton(this);
	close_->setText(QStringLiteral("x"));
	close_->setObjectName(QStringLiteral("taskClose"));
	close_->setProperty("noGlow", true);
	close_->setFocusPolicy(Qt::NoFocus);
	close_->setToolTip(QStringLiteral("Remove from the list"));
	close_->hide();
	connect(close_, &QToolButton::clicked, this, [this]() { emit dismissed(id_); });
	top->addWidget(title_, 1);
	top->addWidget(state_, 0, Qt::AlignTop);
	top->addWidget(close_, 0, Qt::AlignTop);
	v->addLayout(top);
	auto line = [&](const QString &name) {
		auto *l = new QLabel(this);
		l->setObjectName(name);
		l->setWordWrap(true);
		v->addWidget(l);
		return l;
	};
	stage_ = line(QStringLiteral("taskStage")); // "Step 1 of 5: Reading the game screen"
	count_ = line(QStringLiteral("taskCount")); // "412 of 3148 frames (13%)"
	bar_ = new SmoothBar(6, this);
	v->addWidget(bar_);
	time_ = line(QStringLiteral("muted")); // elapsed and time left (D311 proposed)
	last_ = line(QStringLiteral("muted")); // when the last progress came
	note_ = line(QStringLiteral("muted")); // the job's own short note
	warn_ = line(QStringLiteral("taskWarn")); // no progress for a while
	auto *bottom = new QHBoxLayout();
	bottom->addStretch(1);
	stop_ = new QPushButton(QStringLiteral("Stop"), this);
	stop_->setObjectName(QStringLiteral("taskStop"));
	stop_->setProperty("role", QStringLiteral("danger"));
	stop_->setFocusPolicy(Qt::NoFocus);
	stop_->setCursor(Qt::PointingHandCursor);
	stop_->setToolTip(QStringLiteral("Stop the background jobs (clip making and uploads). Unfinished clip jobs run again at the next start."));
	connect(stop_, &QPushButton::clicked, this, [this]() { emit stopRequested(id_); });
	bottom->addWidget(stop_);
	v->addLayout(bottom);
}

void TaskRow::setTask(const QJsonObject &t)
{
	const QString st = str(t, "state");
	finished_ = st == QStringLiteral("done") || st == QStringLiteral("failed");
	const bool stalled = isRunning(t) && t.value(QStringLiteral("stalled")).toBool(false);
	title_->setText(str(t, "title"));
	const QString s = st == QStringLiteral("done")     ? QStringLiteral("Done")
			  : st == QStringLiteral("failed")  ? QStringLiteral("Failed")
			  : st == QStringLiteral("waiting") ? QStringLiteral("Waiting")
			  : stalled                         ? QStringLiteral("May be stuck")
							    : QStringLiteral("Running");
	state_->setText(s);
	state_->setStyleSheet(st == QStringLiteral("failed") || stalled ? QStringLiteral("color:%1;").arg(theme::hex(QStringLiteral("danger")))
			      : st == QStringLiteral("done")            ? QStringLiteral("color:%1;").arg(theme::hex(QStringLiteral("ok")))
									: QString());
	auto set = [](QLabel *l, const QString &text) {
		l->setText(text);
		l->setVisible(!text.isEmpty());
	};
	set(stage_, tasktime::stageLine(t));
	set(count_, tasktime::countLine(t));
	set(time_, tasktime::etaLine(t));
	set(last_, tasktime::lastLine(t));
	set(note_, str(t, "note"));
	set(warn_, tasktime::stallLine(t));
	bar_->setProgress(st, st == QStringLiteral("waiting") ? 0.0 : tasktime::fraction(t));
	bar_->setVisible(st != QStringLiteral("done"));
	close_->setVisible(finished_);
	stop_->setVisible(stoppable(t));
	if (property("stalled").toBool() != stalled) {
		setProperty("stalled", stalled);
		repolish(this);
	}
}

// ---- Toast ----

Toast::Toast(const QString &title, const QString &note, bool failed, QWidget *parent) : QFrame(parent)
{
	setObjectName(QStringLiteral("toast"));
	setProperty("failed", failed);
	setFocusPolicy(Qt::NoFocus);
	setCursor(Qt::PointingHandCursor);
	setToolTip(QStringLiteral("Show the task list"));
	auto *h = new QHBoxLayout(this);
	h->setContentsMargins(16, 12, 8, 12);
	auto *v = new QVBoxLayout();
	v->setSpacing(3);
	auto *t = new QLabel(title, this);
	t->setObjectName(QStringLiteral("toastTitle"));
	t->setWordWrap(true);
	t->setAttribute(Qt::WA_TransparentForMouseEvents);
	v->addWidget(t);
	if (!note.isEmpty()) {
		auto *n = new QLabel(note, this);
		n->setObjectName(QStringLiteral("toastNote"));
		n->setWordWrap(true);
		n->setAttribute(Qt::WA_TransparentForMouseEvents);
		v->addWidget(n);
	}
	h->addLayout(v, 1);
	auto *x = new QToolButton(this);
	x->setText(QStringLiteral("x"));
	x->setObjectName(QStringLiteral("taskClose"));
	x->setProperty("noGlow", true);
	x->setFocusPolicy(Qt::NoFocus);
	x->setToolTip(QStringLiteral("Close"));
	connect(x, &QToolButton::clicked, this, [this]() { emit closeRequested(this); });
	h->addWidget(x, 0, Qt::AlignTop);
	setFixedWidth(kToastW);
	adjustSize();
}

void Toast::mouseReleaseEvent(QMouseEvent *e)
{
	if (e->button() == Qt::LeftButton && rect().contains(e->position().toPoint()))
		emit clicked(this);
}

// ---- TaskBar ----

TaskBar::TaskBar(QMainWindow *host) : QObject(host), host_(host)
{
	chip_ = new TaskChip(host);
	connect(chip_, &TaskChip::clicked, this, [this]() { setPanelOpen(!open_); });

	panel_ = new QFrame(host);
	panel_->setObjectName(QStringLiteral("taskPanel"));
	panel_->setFocusPolicy(Qt::NoFocus);
	panel_->setFixedWidth(kPanelW);
	auto *pv = new QVBoxLayout(panel_);
	pv->setContentsMargins(12, 10, 12, 12);
	pv->setSpacing(8);
	auto *head = new QHBoxLayout();
	auto *ht = new QLabel(QStringLiteral("TASKS"), panel_);
	ht->setObjectName(QStringLiteral("heading"));
	count_ = new QLabel(panel_);
	count_->setObjectName(QStringLiteral("muted"));
	auto *hideBtn = new QToolButton(panel_);
	hideBtn->setText(QStringLiteral("Hide"));
	hideBtn->setObjectName(QStringLiteral("taskHide"));
	hideBtn->setFocusPolicy(Qt::NoFocus);
	connect(hideBtn, &QToolButton::clicked, this, [this]() { setPanelOpen(false); });
	// Clears every finished (done or failed) task from the list at once; running and waiting tasks stay (user, 2026-11-10).
	clearBtn_ = new QToolButton(panel_);
	clearBtn_->setText(QStringLiteral("Clear finished"));
	clearBtn_->setObjectName(QStringLiteral("taskClear"));
	clearBtn_->setToolTip(QStringLiteral("Remove all finished and failed tasks from this list"));
	clearBtn_->setFocusPolicy(Qt::NoFocus);
	clearBtn_->hide();
	connect(clearBtn_, &QToolButton::clicked, this, &TaskBar::clearFinished);
	head->addWidget(ht);
	head->addStretch(1);
	head->addWidget(count_);
	head->addWidget(clearBtn_);
	head->addWidget(hideBtn);
	pv->addLayout(head);
	scroll_ = new QScrollArea(panel_);
	scroll_->setWidgetResizable(true);
	scroll_->setFocusPolicy(Qt::NoFocus);
	scroll_->setFrameShape(QFrame::NoFrame);
	scroll_->setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff); // lines wrap; nothing is cut off to the side
	scroll_->setMinimumHeight(40);
	auto *inner = new QWidget(scroll_);
	rows_ = new QVBoxLayout(inner);
	rows_->setContentsMargins(0, 0, 0, 0);
	rows_->setSpacing(8);
	empty_ = new QLabel(QStringLiteral("Nothing is running."), inner);
	empty_->setObjectName(QStringLiteral("muted"));
	rows_->addWidget(empty_);
	rows_->addStretch(1);
	scroll_->setWidget(inner);
	pv->addWidget(scroll_);
	panel_->hide();
}

void TaskBar::update(const QJsonArray &tasks, double serverNowMs)
{
	tasks_ = tasks;
	running_ = waiting_ = stalled_ = 0;
	QStringList lines;
	QSet<QString> present;
	for (const QJsonValue &v : tasks) {
		const QJsonObject t = v.toObject();
		const QString id = str(t, "id"), st = str(t, "state"), title = str(t, "title");
		present.insert(id);
		const QString was = lastState_.value(id);
		const bool wasActive = was == QStringLiteral("running") || was == QStringLiteral("waiting");
		const bool finished = st == QStringLiteral("done") || st == QStringLiteral("failed");
		// A notification when a task we saw working finishes, or one that finished just before this poll (a quick action).
		const double age = serverNowMs - t.value(QStringLiteral("updatedAt")).toDouble(0);
		if (finished && !dismissed_.contains(id) && (wasActive || (was.isEmpty() && !first_ && age >= 0 && age < 6000)))
			toast(st == QStringLiteral("failed") ? QStringLiteral("Failed: %1").arg(title) : QStringLiteral("Done: %1").arg(title), str(t, "note"),
			      st == QStringLiteral("failed"));
		// A notification when a long job starts (one we did not see before, after the first poll: no burst at window open).
		if (!finished && was.isEmpty() && !first_ && longJob(t)) {
			startToasts_++;
			toast(QStringLiteral("Started: %1").arg(title), QStringLiteral("Click to see its progress."), false);
		}
		lastState_[id] = st;
		const bool stalled = st == QStringLiteral("running") && t.value(QStringLiteral("stalled")).toBool(false);
		// Once per stall (again only after progress came back): a notification that it may be stuck.
		if (stalled && !warned_.contains(id)) {
			warned_.insert(id);
			toast(QStringLiteral("May be stuck: %1").arg(title), tasktime::stallLine(t) + QStringLiteral(". Click to see it or stop it."), true);
		} else if (!stalled)
			warned_.remove(id);
		if (st == QStringLiteral("running")) {
			running_++;
			stalled_ += stalled ? 1 : 0;
			lines << QStringLiteral("%1 - %2").arg(title, tasktime::text(t));
		} else if (st == QStringLiteral("waiting")) {
			waiting_++;
			lines << QStringLiteral("%1 - waiting").arg(title);
		}
	}
	for (auto it = lastState_.begin(); it != lastState_.end();)
		it = present.contains(it.key()) ? std::next(it) : lastState_.erase(it);
	dismissed_.intersect(present);
	warned_.intersect(present);
	first_ = false;
	rebuildRows();
	chip_->setState(running_, waiting_, shown_, stalled_, lines.join(QLatin1Char('\n')));
	if (open_ && shown_ == 0)
		setPanelOpen(false); // nothing left to show: the panel folds away with its button
}

void TaskBar::rebuildRows()
{
	QSet<QString> want;
	int idx = 0;
	for (const QJsonValue &v : tasks_) {
		const QJsonObject t = v.toObject();
		const QString id = str(t, "id");
		if (dismissed_.contains(id))
			continue;
		want.insert(id);
		TaskRow *row = rowById_.value(id, nullptr);
		if (!row) {
			row = new TaskRow(id, panel_);
			rowById_.insert(id, row);
			connect(row, &TaskRow::dismissed, this, [this](const QString &rid) {
				dismissed_.insert(rid);
				rebuildRows();
				chip_->setState(running_, waiting_, shown_, stalled_, chip_->toolTip());
			});
			connect(row, &TaskRow::stopRequested, this, &TaskBar::stopRequested);
		}
		row->setTask(t);
		rows_->insertWidget(idx++, row);
		row->show();
	}
	for (auto it = rowById_.begin(); it != rowById_.end();) {
		if (!want.contains(it.key())) {
			it.value()->hide();
			it.value()->deleteLater();
			it = rowById_.erase(it);
		} else
			++it;
	}
	shown_ = int(want.size());
	bool anyFinished = false;
	for (const TaskRow *r : std::as_const(rowById_))
		anyFinished = anyFinished || r->finished();
	clearBtn_->setVisible(anyFinished);
	empty_->setVisible(shown_ == 0);
	count_->setText(shown_ ? QStringLiteral("%1 running, %2 listed").arg(running_).arg(shown_) : QString());
	if (open_)
		reposition();
}

void TaskBar::dismissFirstFinished()
{
	for (auto it = rowById_.begin(); it != rowById_.end(); ++it)
		if (it.value()->finished()) {
			dismissed_.insert(it.key());
			rebuildRows();
			chip_->setState(running_, waiting_, shown_, stalled_, chip_->toolTip());
			return;
		}
}

void TaskBar::clearFinished()
{
	bool any = false;
	for (auto it = rowById_.cbegin(); it != rowById_.cend(); ++it)
		if (it.value()->finished()) {
			dismissed_.insert(it.key());
			any = true;
		}
	if (!any)
		return;
	rebuildRows();
	chip_->setState(running_, waiting_, shown_, stalled_, chip_->toolTip());
	if (open_ && shown_ == 0)
		setPanelOpen(false); // nothing left to show: the panel folds away, as after the last dismiss
}

void TaskBar::clickFirstToast()
{
	if (!toasts_.isEmpty())
		emit toasts_.first()->clicked(toasts_.first());
}

// Just under the top bar (the button's row); the window's top before the button is placed.
int TaskBar::topY() const
{
	QWidget *bar = chip_->parentWidget();
	if (bar && bar != host_)
		return bar->mapTo(host_, QPoint(0, bar->height())).y() + 6;
	return 48;
}

QPoint TaskBar::panelPos() const
{
	return {host_->width() - panel_->width() - kGap, topY()};
}

void TaskBar::reposition()
{
	if (open_) {
		// As tall as its rows need, up to the window's height (then the rows scroll).
		const int room = std::max(160, host_->height() - topY() - 40);
		scroll_->setMaximumHeight(std::max(40, room - 60));
		if (QWidget *inner = scroll_->widget())
			scroll_->setMinimumHeight(std::min(scroll_->maximumHeight(), std::max(40, inner->sizeHint().height())));
		panel_->adjustSize();
		if (!panelAnim_)
			panel_->move(panelPos());
	}
	layoutToasts(false);
}

void TaskBar::setPanelOpen(bool open)
{
	if (open == open_)
		return;
	open_ = open;
	// A click during the other slide: that slide stops here. Its opacity effect is replaced below (setGraphicsEffect
	// deletes the old one), so it must never step again; the step lambdas also hold the effect by QPointer.
	if (panelAnim_) {
		panelAnim_->stop();
		panelAnim_->deleteLater();
	}
	if (open) {
		panel_->show();
		reposition();
		const QPoint end = panelPos();
		panel_->raise();
		if (motion::enabled(host_)) { // slides down from under the button while fading in
			panel_->move(end - QPoint(0, 16));
			QPointer<QGraphicsOpacityEffect> fx = new QGraphicsOpacityEffect(panel_);
			fx->setOpacity(0);
			panel_->setGraphicsEffect(fx);
			panelAnim_ = motion::run(panel_, 0.0, 1.0, 200, QEasingCurve::OutCubic, [this, fx, end](const QVariant &v) {
				if (fx)
					fx->setOpacity(v.toReal());
				panel_->move(end - QPoint(0, int(16 * (1.0 - v.toReal()))));
			}, [this]() { panel_->setGraphicsEffect(nullptr); depth::attach(panel_, QString()); }); // the fade is done: the theme's depth effect again
		} else {
			panel_->move(end);
			depth::attach(panel_, QString());
		}
		for (Toast *t : toasts_)
			t->raise();
		layoutToasts(false);
	} else {
		if (motion::enabled(host_)) {
			QPointer<QGraphicsOpacityEffect> fx = new QGraphicsOpacityEffect(panel_);
			panel_->setGraphicsEffect(fx);
			const QPoint start = panel_->pos();
			panelAnim_ = motion::run(panel_, 1.0, 0.0, 160, QEasingCurve::OutCubic, [this, fx, start](const QVariant &v) {
				if (fx)
					fx->setOpacity(v.toReal());
				panel_->move(start - QPoint(0, int(16 * (1.0 - v.toReal()))));
			}, [this, start]() {
				if (!open_) {
					panel_->hide();
					panel_->setGraphicsEffect(nullptr);
					panel_->move(start);
				}
			});
		} else
			panel_->hide();
		layoutToasts(false);
	}
}

void TaskBar::toast(const QString &title, const QString &note, bool failed)
{
	if (toasts_.size() >= 3)
		closeToast(toasts_.first());
	auto *t = new Toast(title, note, failed, host_);
	toasts_.append(t);
	toastsShown_++;
	lastToast_ = title;
	toastLog_.append(title);
	if (toastLog_.size() > 10)
		toastLog_.removeFirst();
	connect(t, &Toast::closeRequested, this, &TaskBar::closeToast);
	connect(t, &Toast::clicked, this, [this](Toast *x) {
		toastClicks_++;
		setPanelOpen(true);
		closeToast(x);
	});
	t->show();
	t->raise();
	layoutToasts(false);
	if (motion::enabled(host_)) { // slide in from the right while fading in
		const QPoint end = t->pos();
		// QPointer: a fourth toast within the slide-in closes this one, and the fade-out's new effect deletes this one.
		QPointer<QGraphicsOpacityEffect> fx = new QGraphicsOpacityEffect(t);
		fx->setOpacity(0);
		t->setGraphicsEffect(fx);
		auto *in = motion::run(t, 0.0, 1.0, 240, QEasingCurve::OutCubic, [t, fx, end](const QVariant &v) {
			if (fx)
				fx->setOpacity(v.toReal());
			t->move(end + QPoint(int(40 * (1.0 - v.toReal())), 0));
		}, [t]() { t->setGraphicsEffect(nullptr); depth::attach(t, QString()); });
		if (in)
			in->setObjectName(QStringLiteral("toastIn"));
	}
	QTimer::singleShot(kToastMs, t, [this, t]() { closeToast(t); });
}

void TaskBar::closeToast(Toast *t)
{
	if (!toasts_.contains(t))
		return;
	toasts_.removeOne(t);
	auto done = [this, t]() {
		t->hide();
		t->deleteLater();
		layoutToasts(true);
	};
	// A slide-in still running stops first: its end would swap the fade-out's effect for the depth effect.
	if (auto *in = t->findChild<QVariantAnimation *>(QStringLiteral("toastIn"), Qt::FindDirectChildrenOnly)) {
		in->stop();
		in->deleteLater();
	}
	if (motion::enabled(host_)) {
		QPointer<QGraphicsOpacityEffect> fx = new QGraphicsOpacityEffect(t);
		t->setGraphicsEffect(fx);
		const QPoint start = t->pos();
		motion::run(t, 1.0, 0.0, 200, QEasingCurve::InCubic, [t, fx, start](const QVariant &v) {
			if (fx)
				fx->setOpacity(v.toReal());
			t->move(start + QPoint(int(40 * (1.0 - v.toReal())), 0));
		}, done);
	} else
		done();
}

// Stack the notifications top-down at the top right, under the top bar; with the panel open, to its left.
void TaskBar::layoutToasts(bool animate)
{
	int y = topY();
	for (Toast *t : toasts_) {
		t->adjustSize();
		int x = host_->width() - t->width() - kGap;
		if (open_)
			x = std::max(kGap, panel_->x() - t->width() - 10);
		const QPoint to(x, y);
		if (animate && motion::enabled(host_) && t->isVisible() && t->pos() != to)
			motion::run(t, t->pos(), to, 200, QEasingCurve::OutCubic, [t](const QVariant &v) { t->move(v.toPoint()); });
		else
			t->move(to);
		y += t->height() + 8;
	}
}

QJsonObject TaskBar::probe() const
{
	QJsonObject o;
	o.insert(QStringLiteral("running"), running_);
	o.insert(QStringLiteral("waiting"), waiting_);
	o.insert(QStringLiteral("stalled"), stalled_);
	o.insert(QStringLiteral("total"), int(tasks_.size()));
	o.insert(QStringLiteral("rows"), shown_);
	o.insert(QStringLiteral("clearShown"), !clearBtn_->isHidden());
	o.insert(QStringLiteral("chipHidden"), chip_->isHidden());
	o.insert(QStringLiteral("chipQuiet"), chip_->quiet());
	o.insert(QStringLiteral("chipText"), chip_->text());
	o.insert(QStringLiteral("chipInTopBar"), chip_->parentWidget() != host_);
	o.insert(QStringLiteral("panelOpen"), open_);
	o.insert(QStringLiteral("toasts"), int(toasts_.size()));
	o.insert(QStringLiteral("toastsShown"), toastsShown_);
	o.insert(QStringLiteral("toastClicks"), toastClicks_);
	o.insert(QStringLiteral("lastToast"), lastToast_);
	o.insert(QStringLiteral("toastLog"), QJsonArray::fromStringList(toastLog_));
	o.insert(QStringLiteral("startToasts"), startToasts_);
	// Where things are, in window pixels: the panel and the notifications sit at the top right, under the top bar.
	o.insert(QStringLiteral("windowWidth"), host_->width());
	o.insert(QStringLiteral("topY"), topY());
	if (open_) {
		const QPoint pp = panelPos();
		o.insert(QStringLiteral("panel"), QJsonObject{{QStringLiteral("x"), pp.x()}, {QStringLiteral("y"), pp.y()}, {QStringLiteral("width"), panel_->width()},
							       {QStringLiteral("right"), host_->width() - (pp.x() + panel_->width())}});
	}
	QJsonArray toastPos;
	for (const Toast *t : toasts_)
		toastPos.append(QJsonObject{{QStringLiteral("x"), t->x()}, {QStringLiteral("y"), t->y()}, {QStringLiteral("width"), t->width()},
					    {QStringLiteral("right"), host_->width() - (t->x() + t->width())}});
	o.insert(QStringLiteral("toastPos"), toastPos);
	QJsonArray titles, times, detail;
	for (const QJsonValue &v : tasks_) {
		const QJsonObject t = v.toObject();
		titles.append(str(t, "title"));
		times.append(tasktime::text(t));
		const QString id = str(t, "id");
		if (dismissed_.contains(id))
			continue;
		detail.append(QJsonObject{{QStringLiteral("id"), id},
					  {QStringLiteral("title"), str(t, "title")},
					  {QStringLiteral("state"), str(t, "state")},
					  {QStringLiteral("stage"), tasktime::stageLine(t)},
					  {QStringLiteral("count"), tasktime::countLine(t)},
					  {QStringLiteral("fraction"), tasktime::fraction(t)},
					  {QStringLiteral("eta"), tasktime::etaLine(t)},
					  {QStringLiteral("last"), tasktime::lastLine(t)},
					  {QStringLiteral("warn"), tasktime::stallLine(t)},
					  {QStringLiteral("stalled"), isRunning(t) && t.value(QStringLiteral("stalled")).toBool(false)},
					  {QStringLiteral("stop"), stoppable(t)}});
	}
	o.insert(QStringLiteral("titles"), titles);
	o.insert(QStringLiteral("times"), times);
	o.insert(QStringLiteral("detail"), detail);
	return o;
}
