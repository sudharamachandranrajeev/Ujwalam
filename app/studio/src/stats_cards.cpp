// SPDX-License-Identifier: GPL-3.0-or-later
#include "stats_cards.h"
#include "theme.h"

#include <QDateTime>
#include <QFrame>
#include <QGridLayout>
#include <QHBoxLayout>
#include <QLabel>
#include <QLinearGradient>
#include <QPainter>
#include <QPainterPath>
#include <QTimer>
#include <QVBoxLayout>
#include <algorithm>

namespace {
constexpr int kKeep = 90; // 3 minutes at one sample per 2 s
}

Sparkline::Sparkline(double lo, double hi, QWidget *parent) : QWidget(parent), lo_(lo), hi_(hi)
{
	setMinimumHeight(30);
	setAttribute(Qt::WA_TransparentForMouseEvents);
}

void Sparkline::push(double v)
{
	v_.append(v);
	while (v_.size() > kKeep)
		v_.removeFirst();
	update();
}

void Sparkline::paintEvent(QPaintEvent *)
{
	if (v_.size() < 2)
		return;
	QPainter p(this);
	p.setRenderHint(QPainter::Antialiasing);
	const QRectF r = QRectF(rect()).adjusted(1, 3, -1, -2);
	const double span = std::max(1e-6, hi_ - lo_);
	QPainterPath line;
	for (int i = 0; i < v_.size(); i++) {
		const double x = r.left() + r.width() * i / double(kKeep - 1) + r.width() * (kKeep - v_.size()) / double(kKeep - 1);
		const double y = r.bottom() - r.height() * std::clamp((v_[i] - lo_) / span, 0.0, 1.0);
		i ? line.lineTo(x, y) : line.moveTo(x, y);
	}
	QPainterPath fill = line;
	fill.lineTo(line.currentPosition().x(), r.bottom());
	fill.lineTo(line.pointAtPercent(0).x(), r.bottom());
	fill.closeSubpath();
	QLinearGradient g(0, r.top(), 0, r.bottom());
	QColor top(theme::color(QStringLiteral("accent"))), bot(theme::color(QStringLiteral("accent")));
	top.setAlphaF(0.35f);
	bot.setAlphaF(0.0f);
	g.setColorAt(0, top);
	g.setColorAt(1, bot);
	p.fillPath(fill, g);
	p.setPen(QPen(theme::color(QStringLiteral("accentHi")), 1.6, Qt::SolidLine, Qt::RoundCap, Qt::RoundJoin));
	p.setBrush(Qt::NoBrush);
	p.drawPath(line);
}

StatsCards::StatsCards(QWidget *parent) : QWidget(parent), clock_(new QTimer(this))
{
	auto *g = new QGridLayout(this);
	g->setContentsMargins(0, 0, 0, 0);
	theme::space(g, 8);
	auto card = [this](const QString &name, QLabel *&value, Sparkline *&line, double lo, double hi) {
		auto *f = new QFrame(this);
		f->setObjectName(QStringLiteral("statCard"));
		auto *v = new QVBoxLayout(f);
		theme::margins(v, 12, 8, 12, 8);
		theme::space(v, 2);
		auto *top = new QHBoxLayout();
		auto *n = new QLabel(name, f);
		n->setObjectName(QStringLiteral("statName"));
		value = new QLabel(QStringLiteral("-"), f);
		value->setObjectName(QStringLiteral("statValue"));
		top->addWidget(n);
		top->addStretch(1);
		top->addWidget(value);
		v->addLayout(top);
		line = new Sparkline(lo, hi, f);
		v->addWidget(line);
		return f;
	};
	// the session card: a big clock
	auto *s = new QFrame(this);
	s->setObjectName(QStringLiteral("statCard"));
	auto *sv = new QVBoxLayout(s);
	theme::margins(sv, 12, 8, 12, 8);
	sv->setSpacing(0);
	auto *sh = new QLabel(QStringLiteral("STREAM STATS"), s);
	sh->setObjectName(QStringLiteral("heading"));
	session_ = new QLabel(QStringLiteral("Not live"), s);
	session_->setObjectName(QStringLiteral("statBig"));
	sessionNote_ = new QLabel(QStringLiteral("Session time"), s);
	sessionNote_->setObjectName(QStringLiteral("muted"));
	sv->addWidget(sh);
	sv->addWidget(session_);
	sv->addWidget(sessionNote_);
	g->addWidget(s, 0, 0, 1, 2);
	g->addWidget(card(QStringLiteral("GPU"), gpuV_, gpu_, 0, 100), 1, 0);
	g->addWidget(card(QStringLiteral("CPU"), cpuV_, cpu_, 0, 100), 1, 1);
	g->addWidget(card(QStringLiteral("FPS"), fpsV_, fps_, 0, 75), 2, 0, 1, 2);
	connect(clock_, &QTimer::timeout, this, &StatsCards::tickClock);
}

QString StatsCards::sessionText() const
{
	return session_->text();
}

int StatsCards::samples() const
{
	return cpu_->count();
}

void StatsCards::tickClock()
{
	const qint64 s = std::max<qint64>(0, (QDateTime::currentMSecsSinceEpoch() - since_) / 1000);
	session_->setText(QStringLiteral("%1:%2:%3").arg(s / 3600, 2, 10, QLatin1Char('0')).arg(s / 60 % 60, 2, 10, QLatin1Char('0')).arg(s % 60, 2, 10, QLatin1Char('0')));
}

void StatsCards::sample(double cpuPct, double gpuPct, double fps, int dropped, bool live, bool recording)
{
	cpu_->push(cpuPct);
	gpu_->push(gpuPct);
	fps_->push(fps);
	cpuV_->setText(QStringLiteral("%1%").arg(cpuPct, 0, 'f', 0));
	gpuV_->setText(QStringLiteral("%1%").arg(gpuPct, 0, 'f', 0));
	fpsV_->setText(QStringLiteral("%1 fps, %2 dropped").arg(fps, 0, 'f', 1).arg(dropped));
	const bool on = live || recording;
	if (on && !active_) {
		since_ = QDateTime::currentMSecsSinceEpoch();
		clock_->start(1000); // the only timer here, and only while something is on air or recording
		tickClock();
	} else if (!on && active_) {
		clock_->stop();
		session_->setText(QStringLiteral("Not live"));
	}
	active_ = on;
	sessionNote_->setText(live ? QStringLiteral("On air") : recording ? QStringLiteral("Recording") : QStringLiteral("Session time"));
}
