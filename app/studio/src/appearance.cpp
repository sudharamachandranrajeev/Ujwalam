// SPDX-License-Identifier: GPL-3.0-or-later
#include "appearance.h"

#include "theme.h"

#include <QAbstractButton>
#include <QButtonGroup>
#include <QCheckBox>
#include <QComboBox>
#include <QEnterEvent>
#include <QFont>
#include <QFormLayout>
#include <QGridLayout>
#include <QGroupBox>
#include <QLabel>
#include <QLinearGradient>
#include <QPainter>
#include <QPolygonF>
#include <QScrollArea>
#include <QSignalBlocker>
#include <QVBoxLayout>

#include <algorithm>

namespace appearance {

namespace {

// One theme as a card: a miniature window drawn in the theme's own colours, corners, accent fill, glow and bevel.
class ThemeCard : public QAbstractButton {
public:
	ThemeCard(const theme::Info &info, QWidget *parent) : QAbstractButton(parent), info_(info)
	{
		setCheckable(true);
		setObjectName(QStringLiteral("themeCard"));
		setProperty("noDepth", true);
		setProperty("noGlow", true);
		setCursor(Qt::PointingHandCursor);
		setFixedSize(136, 122);
		setToolTip(info.topic);
		setAccessibleName(info.name);
		setAccessibleDescription(info.topic);
	}
	QString themeId() const { return info_.id; }

protected:
	void paintEvent(QPaintEvent *) override
	{
		QPainter p(this);
		p.setRenderHint(QPainter::Antialiasing);
		const theme::Info &t = info_;
		const QRectF r = QRectF(rect()).adjusted(1.5, 1.5, -1.5, -1.5);
		const qreal rl = std::min<qreal>(t.radiusLarge, 12), rm = std::min<qreal>(t.radiusMedium, 9);
		// the miniature window
		p.setPen(Qt::NoPen);
		p.setBrush(t.bg);
		p.drawRoundedRect(r, 10, 10);
		const QRectF panel(r.left() + 8, r.top() + 8, r.width() - 16, r.height() - 54);
		p.setBrush(t.panel);
		p.setPen(QPen(t.border, 1));
		p.drawRoundedRect(panel, rl, rl);
		// a field and a primary button
		const QRectF field(panel.left() + 8, panel.top() + 9, panel.width() * 0.45, 12);
		p.setBrush(t.field);
		p.drawRoundedRect(field, rm / 1.5, rm / 1.5);
		const QRectF btn(panel.left() + 8, panel.bottom() - 22, 50, 15);
		if (t.glow) { // a halo behind the primary button
			for (int i = 4; i >= 1; i--) {
				QColor g = t.accent;
				g.setAlphaF(0.08f);
				p.setPen(Qt::NoPen);
				p.setBrush(g);
				p.drawRoundedRect(btn.adjusted(-i * 1.5, -i * 1.5, i * 1.5, i * 1.5), rm + i, rm + i);
			}
		}
		if (t.extrusion) {
			p.setPen(Qt::NoPen);
			p.setBrush(t.accent.darker(220));
			p.drawRoundedRect(btn.translated(0, 2), rm, rm);
		}
		QLinearGradient g(btn.topLeft(), btn.bottomLeft());
		g.setColorAt(0, t.gradFrom);
		g.setColorAt(1, t.gradTo);
		p.setPen(Qt::NoPen);
		p.setBrush(g);
		p.drawRoundedRect(btn, rm, rm);
		// a round control with a danger dot, and two text lines
		const QPointF c(panel.right() - 18, panel.bottom() - 15);
		if (t.extrusion) {
			p.setBrush(t.border.darker(160));
			p.drawEllipse(c + QPointF(0, 2), 10, 10);
		}
		p.setBrush(t.field);
		p.setPen(QPen(t.border, 1));
		p.drawEllipse(c, 10, 10);
		p.setPen(Qt::NoPen);
		p.setBrush(t.danger);
		p.drawEllipse(c, 3.5, 3.5);
		p.setBrush(t.text);
		p.setOpacity(0.55);
		p.drawRoundedRect(QRectF(panel.left() + panel.width() * 0.58, panel.top() + 11, panel.width() * 0.3, 3), 1.5, 1.5);
		p.drawRoundedRect(QRectF(panel.left() + panel.width() * 0.58, panel.top() + 18, panel.width() * 0.2, 3), 1.5, 1.5);
		p.setOpacity(1);
		// name, in the theme's own colour and type
		QFont f = font();
		f.setFamily(t.family);
		f.setPointSizeF(9);
		f.setBold(true);
		p.setFont(f);
		p.setPen(t.text);
		const QRectF nameBox(r.left() + 10, r.bottom() - 44, r.width() - 34, 20);
		p.drawText(nameBox, Qt::AlignVCenter | Qt::AlignLeft,
			   p.fontMetrics().elidedText(t.name + (t.custom ? QStringLiteral(" (yours)") : QString()), Qt::ElideRight, int(nameBox.width())));
		// the colour tokens as swatches: surfaces, text, muted, accent, danger, ok
		const QList<QColor> sw{t.bg, t.panel, t.field, t.text, t.muted, t.accent, t.danger, t.ok};
		qreal x = r.left() + 10;
		for (const QColor &col : sw) {
			p.setBrush(col);
			p.setPen(QPen(t.border, 1));
			p.drawRoundedRect(QRectF(x, r.bottom() - 19, 11, 10), 3, 3);
			x += 13;
		}
		// frame: accent when chosen, soft when pointed at
		const qreal w = isChecked() ? 2.2 : (underMouse() ? 1.6 : 1.0);
		p.setBrush(Qt::NoBrush);
		p.setPen(QPen(isChecked() ? t.accentHi : (underMouse() ? t.accent : t.border), w));
		p.drawRoundedRect(r, 10, 10);
		if (isChecked()) {
			const QPointF k(r.right() - 14, r.bottom() - 34);
			p.setPen(Qt::NoPen);
			p.setBrush(t.accent);
			p.drawEllipse(k, 8, 8);
			p.setPen(QPen(t.onAccent, 1.8, Qt::SolidLine, Qt::RoundCap, Qt::RoundJoin));
			p.drawPolyline(QPolygonF{k + QPointF(-3.5, 0.2), k + QPointF(-1, 2.8), k + QPointF(3.6, -2.6)});
		}
	}
	void enterEvent(QEnterEvent *e) override
	{
		QAbstractButton::enterEvent(e);
		update();
	}
	void leaveEvent(QEvent *e) override
	{
		QAbstractButton::leaveEvent(e);
		update();
	}

private:
	theme::Info info_;
};

} // namespace

Page::Page(const QString &themeNow, const QString &effectsNow, const QString &motionNow, QWidget *parent)
	: QWidget(parent), themeNow_(themeNow), effectsNow_(effectsNow), chosen_(themeNow)
{
	// The page scrolls inside Settings: with many themes it is taller than the dialog.
	auto *outer = new QVBoxLayout(this);
	outer->setContentsMargins(0, 0, 0, 0);
	auto *scroll = new QScrollArea(this);
	scroll->setObjectName(QStringLiteral("appearanceScroll"));
	scroll->setWidgetResizable(true);
	scroll->setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
	scroll->setFrameShape(QFrame::NoFrame);
	auto *body = new QWidget(scroll);
	scroll->setWidget(body);
	outer->addWidget(scroll);
	auto *v = new QVBoxLayout(body);
	v->setContentsMargins(0, 0, 8, 0);
	v->setSpacing(12);

	auto *box = new QGroupBox(QStringLiteral("THEME"), body);
	auto *bv = new QVBoxLayout(box);
	auto *hint = new QLabel(QStringLiteral("A theme changes the whole window: colours, type, corners, shadows, glow and motion. Click one to try it; Save keeps it. Your own theme files go in the themes folder next to the program."), box);
	hint->setWordWrap(true);
	hint->setObjectName(QStringLiteral("muted"));
	bv->addWidget(hint);
	auto *grid = new QGridLayout();
	grid->setSpacing(10);
	auto *group = new QButtonGroup(this);
	group->setExclusive(true);
	int i = 0;
	for (const theme::Info &t : theme::available()) {
		auto *card = new ThemeCard(t, box);
		card->setChecked(t.id == themeNow);
		group->addButton(card);
		grid->addWidget(card, i / 4, i % 4);
		connect(card, &QAbstractButton::clicked, this, [this, id = t.id]() {
			chosen_ = id;
			theme::setCurrent(id);
		});
		i++;
	}
	grid->setColumnStretch(4, 1);
	bv->addLayout(grid);
	v->addWidget(box);

	auto *fxBox = new QGroupBox(QStringLiteral("EFFECTS"), body);
	auto *fv = new QVBoxLayout(fxBox);
	// High performance (2026-11-10): any theme, drawn flat. Off by default; it implies "Reduce effects".
	perf_ = new QCheckBox(QStringLiteral("High performance (flat look: no shadows, glow, gradients or animation)"), fxBox);
	perf_->setObjectName(QStringLiteral("settingsPerformance"));
	perf_->setChecked(effectsNow == QStringLiteral("performance"));
	auto *ph = new QLabel(QStringLiteral("Less to draw and fewer cached pictures. Colours, type and corners stay as the theme says."), fxBox);
	ph->setWordWrap(true);
	ph->setObjectName(QStringLiteral("muted"));
	reduce_ = new QCheckBox(QStringLiteral("Reduce effects (no shadows, glow or 3D edges)"), fxBox);
	reduce_->setObjectName(QStringLiteral("settingsReduceEffects"));
	reduce_->setChecked(effectsNow != QStringLiteral("full"));
	reduce_->setEnabled(!perf_->isChecked());
	auto *fh = new QLabel(QStringLiteral("Turn this on if the window feels slow on this PC. Gradients and animations stay."), fxBox);
	fh->setWordWrap(true);
	fh->setObjectName(QStringLiteral("muted"));
	connect(perf_, &QCheckBox::toggled, this, [this](bool on) {
		const QSignalBlocker b(reduce_);
		reduce_->setEnabled(!on);
		if (on)
			reduce_->setChecked(true);
		theme::setEffects(effects());
	});
	connect(reduce_, &QCheckBox::toggled, this, [this](bool) { theme::setEffects(effects()); });
	fv->addWidget(perf_);
	fv->addWidget(ph);
	fv->addWidget(reduce_);
	fv->addWidget(fh);
	v->addWidget(fxBox);

	auto *motionBox = new QGroupBox(QStringLiteral("ANIMATIONS"), body);
	auto *mf = new QFormLayout(motionBox);
	motion_ = new QComboBox(motionBox);
	motion_->setObjectName(QStringLiteral("settingsMotion"));
	motion_->addItem(QStringLiteral("Follow Windows"), QStringLiteral("system"));
	motion_->addItem(QStringLiteral("Always on"), QStringLiteral("on"));
	motion_->addItem(QStringLiteral("Off"), QStringLiteral("off"));
	motion_->setCurrentIndex(std::max(0, motion_->findData(motionNow)));
	mf->addRow(QStringLiteral("Motion in the window:"), motion_);
	v->addWidget(motionBox);
	v->addStretch(1);
}

QString Page::themeId() const
{
	return chosen_;
}

QString Page::effects() const
{
	if (perf_->isChecked())
		return QStringLiteral("performance");
	return reduce_->isChecked() ? QStringLiteral("reduced") : QStringLiteral("full");
}

QString Page::motion() const
{
	return motion_->currentData().toString();
}

void Page::revert()
{
	theme::setCurrent(themeNow_);
	theme::setEffects(effectsNow_);
}

bool Page::pick(const QString &id)
{
	for (auto *b : findChildren<QAbstractButton *>())
		if (auto *card = dynamic_cast<ThemeCard *>(b); card && card->themeId() == id) {
			card->click();
			return true;
		}
	return false;
}

} // namespace appearance
