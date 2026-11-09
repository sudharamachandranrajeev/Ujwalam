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
#include <QScrollArea>
#include <QStatusBar>
#include <QTimer>
#include <QToolButton>
#include <QVBoxLayout>
#include <QVariantAnimation>
#include <algorithm>
#include <cmath>
#include <iterator>

namespace {
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
double fractionOf(const QJsonObject &t)
{
	return tasktime::fraction(t);
}
// Long jobs get a toast when they start (D310 proposed); the studio's own quick actions (saving settings, a preview)
// only when they finish, as before.
bool longJob(const QJsonObject &t)
{
	const QString k = t.value(QStringLiteral("kind")).toString();
	return !t.value(QStringLiteral("id")).toString().startsWith(QStringLiteral("ui-")) || k == QStringLiteral("upload") || k == QStringLiteral("import");
}
} // namespace

// ---- tasktime ----

double tasktime::fraction(const QJsonObject &t)
{
	if (t.value(QStringLiteral("state")).toString() == QStringLiteral("done"))
		return 1.0;
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

QString tasktime::text(const QJsonObject &t)
{
	const QString st = t.value(QStringLiteral("state")).toString();
	const QJsonValue el = t.value(QStringLiteral("elapsedMs"));
	QString out = el.isDouble() ? QStringLiteral("%1 elapsed").arg(duration(el.toDouble())) : QString();
	if (st == QStringLiteral("done") || st == QStringLiteral("failed"))
		return el.isDouble() ? QStringLiteral("took %1").arg(duration(el.toDouble())) : QString();
	QString left;
	if (st == QStringLiteral("waiting"))
		left = QStringLiteral("waiting its turn");
	else {
		const QJsonValue eta = t.value(QStringLiteral("etaMs"));
		if (!eta.isDouble())
			left = QStringLiteral("time left unknown");
		else {
			const double sec = eta.toDouble() / 1000.0;
			const QString step = t.value(QStringLiteral("stage")).toString().isEmpty() ? QString() : QStringLiteral("this step: ");
			if (sec < 60)
				left = step + QStringLiteral("less than a minute left");
			else if (sec < 3600)
				left = step + QStringLiteral("about %1 min left").arg(qint64(std::ceil(sec / 60.0)));
			else
				left = step + QStringLiteral("about %1 h %2 min left").arg(qint64(sec / 3600)).arg(qint64(std::fmod(sec, 3600.0) / 60.0));
		}
	}
	return out.isEmpty() ? left : out + QStringLiteral(" · ") + left;
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
	h->setContentsMargins(24, 2, 10, 2); // left room for the pulsing dot
	h->setSpacing(8);
	text_ = new QLabel(this);
	text_->setAttribute(Qt::WA_TransparentForMouseEvents);
	bar_ = new SmoothBar(4, this);
	bar_->setFixedWidth(70);
	h->addWidget(text_);
	h->addWidget(bar_, 0, Qt::AlignVCenter);
	hide();
}

QString TaskChip::text() const
{
	return text_->text();
}

void TaskChip::setState(int running, int waiting, double fraction, const QString &tip)
{
	active_ = running + waiting > 0;
	QString t;
	if (running > 0)
		t = running == 1 ? QStringLiteral("1 task running") : QStringLiteral("%1 tasks running").arg(running);
	else if (waiting > 0)
		t = waiting == 1 ? QStringLiteral("1 task waiting") : QStringLiteral("%1 tasks waiting").arg(waiting);
	text_->setText(t);
	bar_->setProgress(running > 0 ? QStringLiteral("running") : QStringLiteral("waiting"), running > 0 ? fraction : 0.0);
	setToolTip(tip);
	setVisible(active_);
	sync();
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
	QColor c(theme::color(QStringLiteral("accentHi")));
	c.setAlphaF(pulse_);
	p.setPen(Qt::NoPen);
	p.setBrush(c);
	p.drawEllipse(QPointF(14, height() / 2.0), 4.0, 4.0);
}

// ---- TaskRow ----

TaskRow::TaskRow(const QString &id, QWidget *parent) : QFrame(parent), id_(id)
{
	setObjectName(QStringLiteral("taskRow"));
	auto *v = new QVBoxLayout(this);
	v->setContentsMargins(12, 8, 8, 10);
	v->setSpacing(4);
	auto *top = new QHBoxLayout();
	title_ = new QLabel(this);
	title_->setWordWrap(true);
	state_ = new QLabel(this);
	state_->setObjectName(QStringLiteral("muted"));
	close_ = new QToolButton(this);
	close_->setText(QStringLiteral("x"));
	close_->setObjectName(QStringLiteral("taskClose"));
	close_->setProperty("noGlow", true);
	close_->setFocusPolicy(Qt::NoFocus);
	close_->setToolTip(QStringLiteral("Dismiss"));
	close_->hide();
	connect(close_, &QToolButton::clicked, this, [this]() { emit dismissed(id_); });
	top->addWidget(title_, 1);
	top->addWidget(state_);
	top->addWidget(close_);
	v->addLayout(top);
	note_ = new QLabel(this);
	note_->setObjectName(QStringLiteral("muted"));
	note_->setWordWrap(true);
	v->addWidget(note_);
	bar_ = new SmoothBar(5, this);
	v->addWidget(bar_);
	time_ = new QLabel(this); // elapsed and time left (D310 proposed)
	time_->setObjectName(QStringLiteral("muted"));
	v->addWidget(time_);
}

void TaskRow::setTask(const QJsonObject &t)
{
	const QString st = t.value(QStringLiteral("state")).toString();
	finished_ = st == QStringLiteral("done") || st == QStringLiteral("failed");
	title_->setText(t.value(QStringLiteral("title")).toString());
	const double total = t.value(QStringLiteral("total")).toDouble(-1);
	QString s;
	if (st == QStringLiteral("done"))
		s = QStringLiteral("Done");
	else if (st == QStringLiteral("failed"))
		s = QStringLiteral("Failed");
	else if (st == QStringLiteral("waiting"))
		s = QStringLiteral("Waiting");
	else if (total > 0 && !t.value(QStringLiteral("done")).isNull())
		s = QStringLiteral("%1 of %2").arg(int(t.value(QStringLiteral("done")).toDouble())).arg(int(total));
	else
		s = QStringLiteral("Working...");
	state_->setText(s);
	state_->setStyleSheet(st == QStringLiteral("failed") ? QStringLiteral("color:%1;").arg(theme::hex(QStringLiteral("danger")))
			      : st == QStringLiteral("done")  ? QStringLiteral("color:%1;").arg(theme::hex(QStringLiteral("ok")))
							      : QString());
	const QString n = t.value(QStringLiteral("note")).toString();
	note_->setText(n);
	note_->setVisible(!n.isEmpty());
	close_->setVisible(finished_);
	const QString tt = tasktime::text(t);
	time_->setText(tt);
	time_->setVisible(!tt.isEmpty());
	bar_->setProgress(st, st == QStringLiteral("waiting") ? 0.0 : fractionOf(t));
}

// ---- Toast ----

Toast::Toast(const QString &title, const QString &note, bool failed, QWidget *parent) : QFrame(parent)
{
	setObjectName(QStringLiteral("toast"));
	setProperty("failed", failed);
	setFocusPolicy(Qt::NoFocus);
	setAttribute(Qt::WA_TransparentForMouseEvents); // clicks go through to the studio underneath
	auto *h = new QHBoxLayout(this);
	h->setContentsMargins(14, 10, 8, 10);
	auto *v = new QVBoxLayout();
	v->setSpacing(2);
	auto *t = new QLabel(title, this);
	t->setWordWrap(true);
	t->setStyleSheet(QStringLiteral("font-weight:600;background:transparent;"));
	v->addWidget(t);
	if (!note.isEmpty()) {
		auto *n = new QLabel(note, this);
		n->setWordWrap(true);
		n->setStyleSheet(QStringLiteral("color:%1;background:transparent;").arg(theme::hex(QStringLiteral("muted"))));
		v->addWidget(n);
	}
	h->addLayout(v, 1);
	auto *x = new QToolButton(this);
	x->setText(QStringLiteral("x"));
	x->setObjectName(QStringLiteral("taskClose"));
	x->setProperty("noGlow", true);
	x->setFocusPolicy(Qt::NoFocus);
	connect(x, &QToolButton::clicked, this, [this]() { emit closeRequested(this); });
	h->addWidget(x, 0, Qt::AlignTop);
	setFixedWidth(330);
	adjustSize();
}

// ---- TaskBar ----

TaskBar::TaskBar(QMainWindow *host) : QObject(host), host_(host)
{
	chip_ = new TaskChip(host->statusBar());
	connect(chip_, &TaskChip::clicked, this, [this]() { setPanelOpen(!open_); });

	panel_ = new QFrame(host);
	panel_->setObjectName(QStringLiteral("taskPanel"));
	panel_->setFocusPolicy(Qt::NoFocus);
	panel_->setFixedWidth(380);
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
	hideBtn->setFocusPolicy(Qt::NoFocus);
	connect(hideBtn, &QToolButton::clicked, this, [this]() { setPanelOpen(false); });
	head->addWidget(ht);
	head->addStretch(1);
	head->addWidget(count_);
	head->addWidget(hideBtn);
	pv->addLayout(head);
	auto *scroll = new QScrollArea(panel_);
	scroll->setWidgetResizable(true);
	scroll->setFocusPolicy(Qt::NoFocus);
	scroll->setFrameShape(QFrame::NoFrame);
	scroll->setMaximumHeight(340);
	scroll->setMinimumHeight(40);
	auto *inner = new QWidget(scroll);
	rows_ = new QVBoxLayout(inner);
	rows_->setContentsMargins(0, 0, 0, 0);
	rows_->setSpacing(6);
	empty_ = new QLabel(QStringLiteral("Nothing is running."), inner);
	empty_->setObjectName(QStringLiteral("muted"));
	rows_->addWidget(empty_);
	rows_->addStretch(1);
	scroll->setWidget(inner);
	pv->addWidget(scroll);
	panel_->hide();
}

void TaskBar::update(const QJsonArray &tasks, double serverNowMs)
{
	tasks_ = tasks;
	running_ = waiting_ = 0;
	double sum = 0;
	int determinate = 0, indeterminate = 0;
	QStringList titles;
	QSet<QString> present;
	for (const QJsonValue &v : tasks) {
		const QJsonObject t = v.toObject();
		const QString id = t.value(QStringLiteral("id")).toString(), st = t.value(QStringLiteral("state")).toString();
		present.insert(id);
		const QString was = lastState_.value(id);
		const bool wasActive = was == QStringLiteral("running") || was == QStringLiteral("waiting");
		const bool finished = st == QStringLiteral("done") || st == QStringLiteral("failed");
		// A toast when a task we saw working finishes, or one that finished just before this poll (a quick action).
		const double age = serverNowMs - t.value(QStringLiteral("updatedAt")).toDouble(0);
		if (finished && !dismissed_.contains(id) && (wasActive || (was.isEmpty() && !first_ && age >= 0 && age < 6000)))
			toast(t.value(QStringLiteral("title")).toString(), t.value(QStringLiteral("note")).toString(), st == QStringLiteral("failed"));
		// A toast when a long job starts (one we did not see before, after the first poll: no burst at window open).
		if (!finished && was.isEmpty() && !first_ && longJob(t)) {
			startToasts_++;
			toast(QStringLiteral("Started: %1").arg(t.value(QStringLiteral("title")).toString()), QStringLiteral("Its progress is in the task list."), false);
		}
		lastState_[id] = st;
		if (st == QStringLiteral("running")) {
			running_++;
			const double f = fractionOf(t);
			if (f >= 0) {
				sum += f;
				determinate++;
			} else
				indeterminate++;
			titles << t.value(QStringLiteral("title")).toString();
		} else if (st == QStringLiteral("waiting")) {
			waiting_++;
			titles << t.value(QStringLiteral("title")).toString();
		}
	}
	for (auto it = lastState_.begin(); it != lastState_.end();)
		it = present.contains(it.key()) ? std::next(it) : lastState_.erase(it);
	dismissed_.intersect(present);
	first_ = false;
	// One bar for the chip: the average of the known fractions; unknown work shows the sweep.
	const double frac = determinate > 0 && indeterminate == 0 ? sum / determinate : -1.0;
	chip_->setState(running_, waiting_, frac, titles.join(QLatin1Char('\n')));
	rebuildRows();
}

void TaskBar::rebuildRows()
{
	QSet<QString> want;
	int idx = 0;
	for (const QJsonValue &v : tasks_) {
		const QJsonObject t = v.toObject();
		const QString id = t.value(QStringLiteral("id")).toString();
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
			});
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
			return;
		}
}

void TaskBar::reposition()
{
	if (open_) {
		panel_->adjustSize();
		panel_->move(host_->width() - panel_->width() - 14, host_->statusBar()->geometry().top() - 8 - panel_->height());
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
		panel_->adjustSize();
		const QPoint end(host_->width() - panel_->width() - 14, host_->statusBar()->geometry().top() - 8 - panel_->height());
		panel_->raise();
		if (motion::enabled(host_)) {
			panel_->move(end + QPoint(0, 24));
			QPointer<QGraphicsOpacityEffect> fx = new QGraphicsOpacityEffect(panel_);
			fx->setOpacity(0);
			panel_->setGraphicsEffect(fx);
			panelAnim_ = motion::run(panel_, 0.0, 1.0, 220, QEasingCurve::OutCubic, [this, fx, end](const QVariant &v) {
				if (fx)
					fx->setOpacity(v.toReal());
				panel_->move(end + QPoint(0, int(24 * (1.0 - v.toReal()))));
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
			panelAnim_ = motion::run(panel_, 1.0, 0.0, 180, QEasingCurve::OutCubic, [this, fx, start](const QVariant &v) {
				if (fx)
					fx->setOpacity(v.toReal());
				panel_->move(start + QPoint(0, int(24 * (1.0 - v.toReal()))));
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
	connect(t, &Toast::closeRequested, this, &TaskBar::closeToast);
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
	QTimer::singleShot(4000, t, [this, t]() { closeToast(t); });
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

// Stack the toasts bottom-up above the status bar (and above the task list when it is open).
void TaskBar::layoutToasts(bool animate)
{
	int y = (open_ ? panel_->y() : host_->statusBar()->geometry().top()) - 10;
	for (int i = int(toasts_.size()) - 1; i >= 0; i--) {
		Toast *t = toasts_[i];
		t->adjustSize();
		y -= t->height();
		const QPoint to(host_->width() - t->width() - 14, y);
		if (animate && motion::enabled(host_) && t->isVisible() && t->pos() != to)
			motion::run(t, t->pos(), to, 200, QEasingCurve::OutCubic, [t](const QVariant &v) { t->move(v.toPoint()); });
		else
			t->move(to);
		y -= 8;
	}
}

QJsonObject TaskBar::probe() const
{
	QJsonObject o;
	o.insert(QStringLiteral("running"), running_);
	o.insert(QStringLiteral("waiting"), waiting_);
	o.insert(QStringLiteral("total"), int(tasks_.size()));
	o.insert(QStringLiteral("rows"), shown_);
	o.insert(QStringLiteral("chipHidden"), chip_->isHidden());
	o.insert(QStringLiteral("chipText"), chip_->text());
	o.insert(QStringLiteral("panelOpen"), open_);
	o.insert(QStringLiteral("toasts"), int(toasts_.size()));
	o.insert(QStringLiteral("startToasts"), startToasts_);
	QJsonArray titles, times;
	for (const QJsonValue &v : tasks_) {
		titles.append(v.toObject().value(QStringLiteral("title")).toString());
		times.append(tasktime::text(v.toObject()));
	}
	o.insert(QStringLiteral("titles"), titles);
	o.insert(QStringLiteral("times"), times);
	return o;
}
