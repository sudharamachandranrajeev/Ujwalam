// SPDX-License-Identifier: GPL-3.0-or-later
#include "help_panel.h"
#include "theme.h"
#include "motion.h"

#include <QGraphicsOpacityEffect>
#include <QHBoxLayout>
#include <QLabel>
#include <QPainter>
#include <QPainterPath>
#include <QPushButton>
#include <QScrollArea>
#include <QToolButton>
#include <QVBoxLayout>
#include <QVariantAnimation>
#include <algorithm>
#include <cmath>

// ---- the pictures ----

HelpArt::HelpArt(Kind kind, QWidget *parent) : QWidget(parent), kind_(kind)
{
	setFocusPolicy(Qt::NoFocus);
	setAttribute(Qt::WA_TransparentForMouseEvents);
	QSizePolicy sp(QSizePolicy::Expanding, QSizePolicy::Preferred);
	sp.setHeightForWidth(true);
	setSizePolicy(sp);
}

namespace {
constexpr int kArtW = 392;
}
QSize HelpArt::sizeHint() const
{
	return QSize(kArtW, kind_ == Clips ? 104 : 164);
}

int HelpArt::heightForWidth(int w) const
{
	return sizeHint().height() * w / kArtW;
}

namespace {
constexpr int kNodeW = 76, kNodeH = 46;

enum Icon { Screen, Magnifier, Funnel, Cuts, Review, Upload, Box };

void drawIcon(QPainter &p, Icon icon, const QPointF &c)
{
	const QColor ink = guidecol::text(), acc = guidecol::accentHi();
	p.save();
	p.setBrush(Qt::NoBrush);
	p.setPen(QPen(ink, 1.6, Qt::SolidLine, Qt::RoundCap, Qt::RoundJoin));
	switch (icon) {
	case Screen:
		p.drawRoundedRect(QRectF(c.x() - 15, c.y() - 11, 30, 19), 3, 3);
		p.drawLine(QPointF(c.x() - 6, c.y() + 12), QPointF(c.x() + 6, c.y() + 12));
		p.setPen(QPen(acc, 1.6));
		p.drawEllipse(c + QPointF(3, -2), 4, 4);
		p.drawLine(c + QPointF(3, -9), c + QPointF(3, 5));
		p.drawLine(c + QPointF(-4, -2), c + QPointF(10, -2));
		break;
	case Magnifier:
		p.setPen(QPen(acc, 2.2, Qt::SolidLine, Qt::RoundCap));
		p.drawEllipse(c + QPointF(-3, -3), 9, 9);
		p.drawLine(c + QPointF(4, 4), c + QPointF(12, 12));
		break;
	case Funnel: {
		QPolygonF f;
		f << c + QPointF(-13, -10) << c + QPointF(13, -10) << c + QPointF(3, 1) << c + QPointF(3, 11) << c + QPointF(-3, 8) << c + QPointF(-3, 1);
		p.setPen(QPen(acc, 1.8, Qt::SolidLine, Qt::RoundCap, Qt::RoundJoin));
		p.drawPolygon(f);
		break;
	}
	case Cuts:
		p.setPen(Qt::NoPen);
		p.setBrush(acc);
		p.drawRoundedRect(QRectF(c.x() - 17, c.y() - 7, 22, 14), 2.5, 2.5);
		p.setBrush(guidecol::accent());
		p.drawRoundedRect(QRectF(c.x() + 9, c.y() - 12, 9, 22), 2.5, 2.5);
		break;
	case Review:
		p.drawRoundedRect(QRectF(c.x() - 13, c.y() - 11, 26, 22), 3, 3);
		p.setPen(QPen(guidecol::ok(), 2.4, Qt::SolidLine, Qt::RoundCap, Qt::RoundJoin));
		p.drawPolyline(QPolygonF({c + QPointF(-6, 0), c + QPointF(-2, 4), c + QPointF(6, -5)}));
		break;
	case Upload:
		p.setPen(QPen(acc, 2.2, Qt::SolidLine, Qt::RoundCap, Qt::RoundJoin));
		p.drawLine(c + QPointF(0, 10), c + QPointF(0, -9));
		p.drawPolyline(QPolygonF({c + QPointF(-7, -2), c + QPointF(0, -10), c + QPointF(7, -2)}));
		p.drawLine(c + QPointF(-10, 12), c + QPointF(10, 12));
		break;
	case Box:
		p.setPen(QPen(guidecol::muted(), 1.8, Qt::SolidLine, Qt::RoundCap, Qt::RoundJoin));
		p.drawRoundedRect(QRectF(c.x() - 12, c.y() - 4, 24, 15), 2, 2);
		p.drawLine(c + QPointF(-12, -4), c + QPointF(-8, -10));
		p.drawLine(c + QPointF(12, -4), c + QPointF(8, -10));
		p.drawLine(c + QPointF(-8, -10), c + QPointF(8, -10));
		break;
	}
	p.restore();
}

// A step: rounded box with an icon and its caption under it. dashed = something you do yourself / not automatic.
void drawNode(QPainter &p, const QPointF &topLeft, Icon icon, const QString &caption, bool dashed = false)
{
	const QRectF r(topLeft, QSizeF(kNodeW, kNodeH));
	p.save();
	p.setBrush(guidecol::field());
	QPen pen(dashed ? guidecol::muted() : guidecol::accent(), 1.3);
	if (dashed)
		pen.setStyle(Qt::DashLine);
	p.setPen(pen);
	p.drawRoundedRect(r, 10, 10);
	p.restore();
	drawIcon(p, icon, r.center());
	p.setPen(guidecol::muted());
	QFont f = p.font();
	f.setPointSizeF(8);
	p.setFont(f);
	p.drawText(QRectF(r.left() - 8, r.bottom() + 3, r.width() + 16, 26), Qt::AlignHCenter | Qt::AlignTop | Qt::TextWordWrap, caption);
}

void drawArrow(QPainter &p, const QPointF &a, const QPointF &b, bool dashed = false)
{
	p.save();
	QPen pen(dashed ? guidecol::muted() : guidecol::accentHi(), 1.5, dashed ? Qt::DashLine : Qt::SolidLine, Qt::RoundCap);
	p.setPen(pen);
	p.drawLine(a, b);
	const QPointF d = b - a;
	const qreal len = std::hypot(d.x(), d.y());
	if (len > 1) {
		const QPointF u = d / len, n(-u.y(), u.x());
		p.setPen(QPen(pen.color(), 1.5, Qt::SolidLine, Qt::RoundCap));
		p.drawLine(b, b - u * 6 + n * 3.5);
		p.drawLine(b, b - u * 6 - n * 3.5);
	}
	p.restore();
}
} // namespace

void HelpArt::paintEvent(QPaintEvent *)
{
	QPainter p(this);
	p.setRenderHint(QPainter::Antialiasing);
	p.scale(qreal(width()) / kArtW, qreal(width()) / kArtW); // drawn on a 392-wide sheet, scaled to the panel
	const int width = kArtW;
	QPainterPath bg;
	bg.addRoundedRect(QRectF(0.5, 0.5, kArtW - 1, sizeHint().height() - 1), 12, 12);
	p.fillPath(bg, guidecol::panel().darker(125));
	if (kind_ == Clips) {
		const qreal gap = (width - 4 * kNodeW) / 5.0, y = 12;
		const Icon icons[] = {Screen, Magnifier, Funnel, Cuts};
		const char *caps[] = {"Your game screen", "Find the best moments", "Match filter", "H and V clips"};
		for (int i = 0; i < 4; i++) {
			const qreal x = gap + i * (kNodeW + gap);
			drawNode(p, QPointF(x, y), icons[i], QString::fromLatin1(caps[i]));
			if (i < 3)
				drawArrow(p, QPointF(x + kNodeW + 3, y + kNodeH / 2), QPointF(x + kNodeW + gap - 3, y + kNodeH / 2));
		}
	} else {
		const qreal x0 = 14, x1 = 128, x2 = 288;
		drawNode(p, QPointF(x0, 54), Cuts, QStringLiteral("A finished clip"));
		drawNode(p, QPointF(x1, 54), Review, QStringLiteral("You read and approve"));
		drawNode(p, QPointF(x2, 10), Upload, QStringLiteral("YouTube Shorts, private"));
		drawNode(p, QPointF(x2, 98), Box, QStringLiteral("TikTok, Reels: package"), true);
		drawArrow(p, QPointF(x0 + kNodeW + 3, 77), QPointF(x1 - 3, 77));
		drawArrow(p, QPointF(x1 + kNodeW + 3, 70), QPointF(x2 - 3, 33));
		drawArrow(p, QPointF(x1 + kNodeW + 3, 84), QPointF(x2 - 3, 121), true);
	}
}

// ---- the panel ----

namespace {
QLabel *para(const QString &text, QWidget *parent, const char *name = "guideText")
{
	auto *l = new QLabel(text, parent);
	l->setObjectName(QString::fromLatin1(name));
	l->setWordWrap(true);
	l->setTextInteractionFlags(Qt::NoTextInteraction);
	return l;
}
QLabel *bullet(const QString &text, QWidget *parent)
{
	return para(QStringLiteral("•  ") + text, parent);
}
QLabel *label(const QString &text, QWidget *parent)
{
	auto *l = para(text, parent, "guideCount");
	return l;
}
} // namespace

HelpPanel::HelpPanel(QWidget *host, AnchorResolver resolve) : QFrame(host), host_(host), resolve_(std::move(resolve))
{
	setObjectName(QStringLiteral("guideHelp"));
	setFocusPolicy(Qt::NoFocus);
	const auto restyle = [this]() {
		setStyleSheet(guidecol::css() +
			      QStringLiteral("QFrame#guideHelp { background: %1; border: 1px solid %2; border-radius: 16px; }"
					     "QScrollArea, QScrollArea > QWidget > QWidget { background: transparent; border: none; }"
					     "QLabel#guideSection { font-size: 11pt; font-weight: 600; }")
				      .arg(guidecol::panel().name(), guidecol::border().name()));
		update();
	};
	restyle();
	connect(theme::notifier(), &theme::Notifier::changed, this, restyle);
	auto *outer = new QVBoxLayout(this);
	outer->setContentsMargins(16, 12, 10, 14);
	outer->setSpacing(8);
	auto *head = new QHBoxLayout();
	auto *t = new QLabel(QStringLiteral("Help"), this);
	t->setObjectName(QStringLiteral("guideTitle"));
	close_ = new QToolButton(this);
	close_->setObjectName(QStringLiteral("guideClose"));
	close_->setText(QStringLiteral("×"));
	close_->setToolTip(QStringLiteral("Close help"));
	close_->setFocusPolicy(Qt::NoFocus);
	close_->setProperty("noGlow", true);
	close_->setCursor(Qt::PointingHandCursor);
	head->addWidget(t);
	head->addStretch(1);
	head->addWidget(close_);
	outer->addLayout(head);

	auto *scroll = new QScrollArea(this);
	scroll->setFrameShape(QFrame::NoFrame);
	scroll->setWidgetResizable(true);
	scroll->setFocusPolicy(Qt::NoFocus);
	scroll->setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
	auto *body = new QWidget();
	auto *v = new QVBoxLayout(body);
	v->setContentsMargins(0, 0, 6, 0);
	v->setSpacing(8);

	// How clips are made
	auto *s1 = new QLabel(QStringLiteral("How clips are made"), body);
	s1->setObjectName(QStringLiteral("guideSection"));
	v->addWidget(s1);
	v->addWidget(new HelpArt(HelpArt::Clips, body));
	v->addWidget(bullet(QStringLiteral("Ujwalam reads the game screen in your recording, or while you stream, and finds your best moments."), body));
	v->addWidget(bullet(QStringLiteral("The match filter keeps clips only from matches that went well: by default the ones where you finish in the top 3. You can also set a number of kills."), body));
	v->addWidget(bullet(QStringLiteral("Each moment is cut into a wide (H) clip and a tall (V) clip."), body));
	v->addWidget(bullet(QStringLiteral("Clips are saved in the My clips folder. While you are live, only light work runs; the clip videos are made after the stream."), body));
	v->addWidget(bullet(QStringLiteral("You choose when it happens (ask me, after I stop, while I record, or never) in Settings, Clips. Save clip and Mark moment work any time."), body));
	showClips_ = new QPushButton(QStringLiteral("Show me"), body);
	showClips_->setObjectName(QStringLiteral("guideBtn"));
	showClips_->setProperty("role", QStringLiteral("primary"));
	showClips_->setFocusPolicy(Qt::NoFocus);
	showClips_->setCursor(Qt::PointingHandCursor);
	v->addWidget(showClips_, 0, Qt::AlignLeft);
	v->addSpacing(8);

	// Posting your clips
	auto *s2 = new QLabel(QStringLiteral("Posting your clips"), body);
	s2->setObjectName(QStringLiteral("guideSection"));
	v->addWidget(s2);
	v->addWidget(new HelpArt(HelpArt::Posting, body));
	v->addWidget(label(QStringLiteral("WORKS TODAY"), body));
	v->addWidget(bullet(QStringLiteral("Posts (in the More menu, when posting is switched on) shows a package for each clip: the video, a cover picture and text for YouTube Shorts, TikTok and Instagram Reels. You read, edit and approve each one. This step sends nothing."), body));
	v->addWidget(bullet(QStringLiteral("An approved clip can go to YouTube Shorts as a private video. It goes up only when you click Upload, and nothing becomes public by itself. Signing in to YouTube is set up from the command line for now."), body));
	v->addWidget(bullet(QStringLiteral("TikTok and Instagram Reels: Ujwalam prepares the package only. You upload those yourself."), body));
	v->addWidget(label(QStringLiteral("NEEDS YOUR CLICK"), body));
	v->addWidget(bullet(QStringLiteral("Switching posting on, and every upload. Uploads are refused while you are live."), body));
	v->addWidget(label(QStringLiteral("AUTOMATIC POSTING"), body));
	v->addWidget(bullet(QStringLiteral("It exists only as an opt-in rule file used from the command line after a stream, and it is off. The rule list is empty, so nothing posts by itself. A rule can approve matching clips, and only if you also allow it, upload them privately to YouTube Shorts. There is no switch for it in this window yet."), body));
	facts_ = para(QString(), body, "guideCount");
	facts_->setObjectName(QStringLiteral("helpFacts"));
	v->addWidget(facts_);
	showPosting_ = new QPushButton(QStringLiteral("Show me"), body);
	showPosting_->setObjectName(QStringLiteral("guideBtn"));
	showPosting_->setProperty("role", QStringLiteral("primary"));
	showPosting_->setFocusPolicy(Qt::NoFocus);
	showPosting_->setCursor(Qt::PointingHandCursor);
	v->addWidget(showPosting_, 0, Qt::AlignLeft);
	v->addStretch(1);
	scroll->setWidget(body);
	outer->addWidget(scroll, 1);

	replay_ = new QPushButton(QStringLiteral("Replay the welcome tour"), this);
	replay_->setObjectName(QStringLiteral("guideBtn"));
	replay_->setFocusPolicy(Qt::NoFocus);
	replay_->setCursor(Qt::PointingHandCursor);
	outer->addWidget(replay_, 0, Qt::AlignLeft);
	setFacts(false, false);

	connect(close_, &QToolButton::clicked, this, &HelpPanel::close);
	connect(showClips_, &QPushButton::clicked, this, [this]() { emit showMe(QStringLiteral("clips")); });
	connect(showPosting_, &QPushButton::clicked, this, [this]() { emit showMe(QStringLiteral("posting")); });
	connect(replay_, &QPushButton::clicked, this, [this]() { emit replayTour(); });
	hide();
}

void HelpPanel::setFacts(bool postingOn, bool autoPostOn)
{
	postingOn_ = postingOn;
	autoOn_ = autoPostOn;
	facts_->setText(QStringLiteral("In this build: posting is %1, automatic posting is %2.").arg(postingOn ? QStringLiteral("ON") : QStringLiteral("OFF"), autoPostOn ? QStringLiteral("ON") : QStringLiteral("OFF")));
}

QPoint HelpPanel::home() const
{
	const QRect a = resolve_(QStringLiteral("help"));
	return QPoint(0, a.isEmpty() ? 60 : a.bottom() + 10);
}

// Right-aligned under the top bar, as wide as the room right of the preview windows allows (340..440 px): a native
// preview window always paints over a Qt widget, so the panel stays clear of them.
void HelpPanel::place()
{
	const int y = home().y(), h = std::max(260, std::min(660, host_->height() - y - 48));
	int left = 6;
	if (avoid_)
		for (const QRect &r : avoid_())
			if (r.bottom() >= y && r.top() <= y + h)
				left = std::max(left, r.right() + 8);
	const int w = std::max(340, std::min(440, host_->width() - 10 - left));
	setFixedSize(w, h);
	move(host_->width() - w - 10, y);
}

void HelpPanel::refresh()
{
	if (open_)
		place();
}

void HelpPanel::open()
{
	if (open_)
		return;
	open_ = true;
	place();
	const QPoint at = pos();
	show();
	raise();
	if (!motion::enabled(this)) {
		setGraphicsEffect(nullptr);
		return;
	}
	auto *fx = new QGraphicsOpacityEffect(this);
	fx->setOpacity(0);
	setGraphicsEffect(fx);
	QPointer<QGraphicsOpacityEffect> weak(fx);
	motion::run(
		this, 0.0, 1.0, 240, QEasingCurve::OutCubic,
		[this, weak, at](const QVariant &v) {
			if (weak)
				weak->setOpacity(v.toReal());
			move(at + QPoint(int((1.0 - v.toReal()) * 36), 0));
		},
		[this]() {
			if (open_)
				setGraphicsEffect(nullptr);
		});
}

void HelpPanel::close()
{
	if (!open_)
		return;
	open_ = false;
	emit closed();
	if (!isVisible() || !motion::enabled(this)) {
		setGraphicsEffect(nullptr);
		hide();
		return;
	}
	auto *fx = new QGraphicsOpacityEffect(this);
	setGraphicsEffect(fx);
	QPointer<QGraphicsOpacityEffect> weak(fx);
	const QPoint at = pos();
	motion::run(
		this, 1.0, 0.0, 180, QEasingCurve::InCubic,
		[this, weak, at](const QVariant &v) {
			if (weak)
				weak->setOpacity(v.toReal());
			move(at + QPoint(int((1.0 - v.toReal()) * 24), 0));
		},
		[this, at]() {
			if (open_)
				return;
			setGraphicsEffect(nullptr);
			hide();
			move(at);
		});
}

void HelpPanel::click(const QString &what)
{
	if (what == QStringLiteral("show-clips"))
		showClips_->click();
	else if (what == QStringLiteral("show-posting"))
		showPosting_->click();
	else if (what == QStringLiteral("replay"))
		replay_->click();
	else if (what == QStringLiteral("close"))
		close_->click();
}

QJsonObject HelpPanel::probe() const
{
	QJsonObject o;
	o.insert(QStringLiteral("open"), open_);
	QJsonArray sections;
	for (const QLabel *l : findChildren<QLabel *>(QStringLiteral("guideSection")))
		sections.append(l->text());
	o.insert(QStringLiteral("sections"), sections);
	o.insert(QStringLiteral("facts"), facts_->text());
	o.insert(QStringLiteral("showMeButtons"), 2);
	return o;
}
