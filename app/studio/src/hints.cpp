// SPDX-License-Identifier: GPL-3.0-or-later
#include "hints.h"

#include <QCheckBox>
#include <QEnterEvent>
#include <QHBoxLayout>
#include <QLabel>
#include <QPushButton>
#include <QToolButton>

HintBubble::HintBubble(QWidget *host) : Bubble(host)
{
	setFixedWidth(340);
	auto *top = new QHBoxLayout();
	title_ = new QLabel(this);
	title_->setObjectName(QStringLiteral("guideTitle"));
	title_->setWordWrap(true);
	close_ = new QToolButton(this);
	close_->setObjectName(QStringLiteral("guideClose"));
	close_->setText(QStringLiteral("×"));
	close_->setToolTip(QStringLiteral("Close this tip"));
	close_->setFocusPolicy(Qt::NoFocus);
	close_->setProperty("noGlow", true);
	close_->setCursor(Qt::PointingHandCursor);
	top->addWidget(title_, 1);
	top->addWidget(close_, 0, Qt::AlignTop);
	body()->addLayout(top);
	text_ = new QLabel(this);
	text_->setObjectName(QStringLiteral("guideText"));
	text_->setWordWrap(true);
	body()->addWidget(text_);
	auto *row = new QHBoxLayout();
	never_ = new QCheckBox(QStringLiteral("Don't show this again"), this);
	never_->setObjectName(QStringLiteral("guideCheck"));
	never_->setFocusPolicy(Qt::NoFocus);
	never_->setCursor(Qt::PointingHandCursor);
	gotIt_ = new QPushButton(QStringLiteral("Got it"), this);
	gotIt_->setObjectName(QStringLiteral("guideBtn"));
	gotIt_->setProperty("role", QStringLiteral("primary"));
	gotIt_->setFocusPolicy(Qt::NoFocus);
	gotIt_->setCursor(Qt::PointingHandCursor);
	row->addWidget(never_);
	row->addStretch(1);
	row->addWidget(gotIt_);
	body()->addLayout(row);
	timer_ = new QTimer(this);
	timer_->setSingleShot(true);
	connect(timer_, &QTimer::timeout, this, [this]() { emit dismissed(false); });
	connect(close_, &QToolButton::clicked, this, [this]() { emit dismissed(never_->isChecked()); });
	connect(gotIt_, &QPushButton::clicked, this, [this]() { emit dismissed(never_->isChecked()); });
}

void HintBubble::setContent(const QString &title, const QString &text)
{
	title_->setText(title);
	text_->setText(text);
	never_->setChecked(false);
}

bool HintBubble::never() const { return never_->isChecked(); }
void HintBubble::setNever(bool on) { never_->setChecked(on); }

void HintBubble::click(const QString &what)
{
	(what == QStringLiteral("close") ? static_cast<QAbstractButton *>(close_) : static_cast<QAbstractButton *>(gotIt_))->click();
}

void HintBubble::armTimer()
{
	// A hidden window (the headless probe) keeps the hint until it is dismissed, so a test can look at it;
	// UJWALAM_GUIDE_HINT_MS (tests) sets the time instead and applies there too.
	if (const int ms = qEnvironmentVariableIntValue("UJWALAM_GUIDE_HINT_MS"); ms > 0) {
		timer_->start(ms);
		return;
	}
	if (parentWidget() && parentWidget()->isVisible())
		timer_->start(Hints::kAutoHideMs);
}

void HintBubble::enterEvent(QEnterEvent *)
{
	timer_->stop(); // hovered: stays
}

void HintBubble::leaveEvent(QEvent *)
{
	if (shownLogically() && parentWidget() && parentWidget()->isVisible())
		timer_->start(3000); // a moment to finish reading after the mouse leaves
}

// ---- Hints ----

Hints::Hints(QWidget *host, AnchorResolver resolve) : QObject(host), host_(host), resolve_(std::move(resolve))
{
	bubble_ = new HintBubble(host);
	connect(bubble_, &HintBubble::dismissed, this, [this](bool never) {
		const QString id = id_;
		if (id.isEmpty())
			return;
		id_.clear();
		bubble_->vanish();
		emit closed(id, never);
	});
}

bool Hints::show(const QString &id, const QString &anchor, const QString &title, const QString &text)
{
	if (showing())
		return false;
	const QRect r = resolve_(anchor);
	if (r.isEmpty())
		return false;
	id_ = id;
	anchor_ = anchor;
	seen_++;
	bubble_->setContent(title, text);
	bubble_->pointAt(r);
	bubble_->appear();
	bubble_->armTimer();
	return true;
}

void Hints::hideNow()
{
	if (!showing())
		return;
	const QString id = id_;
	id_.clear();
	bubble_->vanish();
	emit closed(id, false);
}

void Hints::refresh()
{
	if (!showing())
		return;
	const QRect r = resolve_(anchor_);
	if (r.isEmpty())
		return hideNow();
	bubble_->pointAt(r);
}

void Hints::click(const QString &what, bool tickNever)
{
	if (!showing())
		return;
	if (tickNever)
		bubble_->setNever(true);
	bubble_->click(what);
}

QJsonObject Hints::probe() const
{
	QJsonObject o;
	o.insert(QStringLiteral("showing"), showing());
	o.insert(QStringLiteral("id"), id_);
	o.insert(QStringLiteral("seen"), seen_);
	if (showing()) {
		o.insert(QStringLiteral("anchor"), anchor_);
		o.insert(QStringLiteral("arrow"), int(bubble_->arrowSide()));
	}
	return o;
}
