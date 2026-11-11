// SPDX-License-Identifier: GPL-3.0-or-later
#include "specimen.h"

#include "icons.h"
#include "switch_widget.h"
#include "taskbar.h"
#include "theme.h"
#include "value_slider.h"

#include <QApplication>
#include <QCheckBox>
#include <QComboBox>
#include <QGridLayout>
#include <QGroupBox>
#include <QHBoxLayout>
#include <QJsonArray>
#include <QLabel>
#include <QLineEdit>
#include <QListWidget>
#include <QProgressBar>
#include <QPushButton>
#include <QScreen>
#include <QScrollArea>
#include <QSpinBox>
#include <QTabBar>
#include <QVBoxLayout>

namespace appearance {

namespace {

QGroupBox *section(QWidget *parent, const QString &title, QGridLayout *grid, int row, int col)
{
	auto *box = new QGroupBox(title, parent);
	box->setProperty("specimenSection", title);
	grid->addWidget(box, row, col);
	return box;
}

QPushButton *button(QWidget *parent, const QString &text, const QString &role = QString(), bool enabled = true)
{
	auto *b = new QPushButton(text, parent);
	if (!role.isEmpty())
		b->setProperty("role", role);
	b->setEnabled(enabled);
	b->setFocusPolicy(Qt::NoFocus); // a specimen: nothing takes the focus from the Settings window
	return b;
}

// A round transport control as the studio window makes it (QPushButton#round, theme icon by iconState).
QWidget *round(QWidget *parent, const QString &icon, const QString &caption, const QString &role, bool active, bool enabled)
{
	auto *cell = new QWidget(parent);
	auto *v = new QVBoxLayout(cell);
	v->setContentsMargins(0, 0, 0, 0);
	theme::space(v, 6);
	auto *b = new QPushButton(cell);
	b->setObjectName(QStringLiteral("round"));
	b->setFixedSize(theme::roundSize(), theme::roundSize());
	b->setIconSize(QSize(24, 24));
	b->setFocusPolicy(Qt::NoFocus);
	if (!role.isEmpty())
		b->setProperty("role", role);
	b->setProperty("active", active);
	b->setEnabled(enabled);
	b->setProperty("iconState", icon + (active ? QStringLiteral("+") : QStringLiteral("-"))); // theme switches redraw it
	const bool primary = role == QStringLiteral("primary"), danger = role == QStringLiteral("danger");
	const QColor ink = (primary || (danger && active)) ? theme::color(QStringLiteral("onAccent"))
			   : danger                        ? theme::color(QStringLiteral("danger"))
							   : theme::color(QStringLiteral("text"));
	b->setIcon(icons::make(icon, ink, 24, theme::color(QStringLiteral("muted"))));
	auto *cap = new QLabel(caption, cell);
	cap->setObjectName(QStringLiteral("ctlCaption"));
	cap->setAlignment(Qt::AlignCenter);
	v->addWidget(b, 0, Qt::AlignHCenter);
	v->addWidget(cap);
	return cell;
}

QLabel *label(QWidget *parent, const QString &text, const QString &name = QString())
{
	auto *l = new QLabel(text, parent);
	if (!name.isEmpty())
		l->setObjectName(name);
	l->setWordWrap(true);
	return l;
}

} // namespace

Specimen::Specimen(QWidget *parent) : QDialog(parent)
{
	setObjectName(QStringLiteral("themeSpecimen"));
	setWindowTitle(QStringLiteral("Theme components"));
	auto *outer = new QVBoxLayout(this);
	theme::margins(outer, 12, 12, 12, 12);
	theme::space(outer, 8);
	auto *intro = label(this, QStringLiteral("Every component of the studio window in the current theme, in each of its states. "
						 "Switch the theme in Settings to compare; this window follows at once. Nothing here does anything."),
			    QStringLiteral("muted"));
	outer->addWidget(intro);
	auto *scroll = new QScrollArea(this);
	scroll->setObjectName(QStringLiteral("specimenScroll"));
	scroll->setWidgetResizable(true);
	scroll->setFrameShape(QFrame::NoFrame);
	body_ = new QWidget(scroll);
	body_->setObjectName(QStringLiteral("specimenBody"));
	body_->setProperty("bubbleHost", true); // the slider's value bubble is part of the sheet
	scroll->setWidget(body_);
	outer->addWidget(scroll, 1);
	auto *grid = new QGridLayout(body_);
	theme::margins(grid, 4, 4, 4, 4);
	theme::space(grid, 12);

	{ // Buttons in every state
		auto *box = section(body_, QStringLiteral("BUTTONS"), grid, 0, 0);
		auto *g = new QGridLayout(box);
		theme::space(g, 8);
		g->addWidget(button(box, QStringLiteral("Plain")), 0, 0);
		g->addWidget(button(box, QStringLiteral("Primary"), QStringLiteral("primary")), 0, 1);
		g->addWidget(button(box, QStringLiteral("Danger"), QStringLiteral("danger")), 0, 2);
		auto *checked = button(box, QStringLiteral("Checked"));
		checked->setCheckable(true);
		checked->setChecked(true);
		g->addWidget(checked, 1, 0);
		g->addWidget(button(box, QStringLiteral("Disabled"), QString(), false), 1, 1);
		g->addWidget(button(box, QStringLiteral("Primary off"), QStringLiteral("primary"), false), 1, 2);
		auto *tb = button(box, QStringLiteral("Toolbar"));
		tb->setObjectName(QStringLiteral("tb"));
		g->addWidget(tb, 2, 0);
		auto *pressed = button(box, QStringLiteral("Pressed"));
		pressed->setDown(true);
		g->addWidget(pressed, 2, 1);
	}
	{ // Round transport controls
		auto *box = section(body_, QStringLiteral("TRANSPORT"), grid, 0, 1);
		auto *h = new QHBoxLayout(box);
		theme::space(h, 10);
		h->addWidget(round(box, QStringLiteral("play"), QStringLiteral("Start"), QStringLiteral("primary"), false, true));
		h->addWidget(round(box, QStringLiteral("stop"), QStringLiteral("Live"), QStringLiteral("primary"), true, true));
		h->addWidget(round(box, QStringLiteral("record"), QStringLiteral("Record"), QStringLiteral("danger"), false, true));
		h->addWidget(round(box, QStringLiteral("record"), QStringLiteral("Recording"), QStringLiteral("danger"), true, true));
		h->addWidget(round(box, QStringLiteral("clip"), QStringLiteral("Clip"), QString(), false, true));
		h->addWidget(round(box, QStringLiteral("flag"), QStringLiteral("Off"), QString(), false, false));
		h->addStretch(1);
	}
	{ // Inputs
		auto *box = section(body_, QStringLiteral("INPUTS"), grid, 0, 2);
		auto *v = new QVBoxLayout(box);
		theme::space(v, 6);
		auto *normal = new QLineEdit(box);
		normal->setPlaceholderText(QStringLiteral("Search scenes"));
		normal->setFocusPolicy(Qt::NoFocus);
		v->addWidget(normal);
		auto *error = new QLineEdit(QStringLiteral("rtmp:/bad address"), box);
		error->setProperty("error", true);
		error->setFocusPolicy(Qt::NoFocus);
		v->addWidget(error);
		v->addWidget(label(box, QStringLiteral("The address must start with rtmp:// or rtmps://"), QStringLiteral("taskWarn")));
		auto *off = new QLineEdit(QStringLiteral("Disabled"), box);
		off->setEnabled(false);
		v->addWidget(off);
		auto *row = new QHBoxLayout();
		auto *combo = new QComboBox(box);
		combo->addItems({QStringLiteral("1080p60"), QStringLiteral("1440p60")});
		combo->setFocusPolicy(Qt::NoFocus);
		auto *spin = new QSpinBox(box);
		spin->setRange(0, 60000);
		spin->setValue(6000);
		spin->setSuffix(QStringLiteral(" kbps"));
		spin->setFocusPolicy(Qt::NoFocus);
		row->addWidget(combo, 1);
		row->addWidget(spin, 1);
		v->addLayout(row);
	}
	{ // Tabs and selection
		auto *box = section(body_, QStringLiteral("TABS AND SELECTION"), grid, 1, 0);
		auto *v = new QVBoxLayout(box);
		theme::space(v, 8);
		auto *tabs = new QTabBar(box);
		tabs->setObjectName(QStringLiteral("specimenTabs"));
		tabs->setFocusPolicy(Qt::NoFocus);
		tabs->setDrawBase(false);
		for (const char *t : {"Scenes", "Audio", "Outputs", "Chat"})
			tabs->addTab(QString::fromLatin1(t));
		tabs->setCurrentIndex(1);
		v->addWidget(tabs);
		auto *checks = new QHBoxLayout();
		auto *c1 = new QCheckBox(QStringLiteral("Checked"), box);
		c1->setChecked(true);
		auto *c2 = new QCheckBox(QStringLiteral("Clear"), box);
		auto *c3 = new QCheckBox(QStringLiteral("Disabled"), box);
		c3->setEnabled(false);
		for (auto *c : {c1, c2, c3}) {
			c->setFocusPolicy(Qt::NoFocus);
			checks->addWidget(c);
		}
		checks->addStretch(1);
		v->addLayout(checks);
		auto *sw = new QHBoxLayout();
		auto *on = new Switch(box);
		on->setObjectName(QStringLiteral("specimenSwitchOn"));
		on->setCheckedSilently(true);
		auto *offSw = new Switch(box);
		offSw->setObjectName(QStringLiteral("specimenSwitchOff"));
		auto *dis = new Switch(box);
		dis->setEnabled(false);
		for (auto *s : {on, offSw, dis}) {
			s->setFocusPolicy(Qt::NoFocus);
			sw->addWidget(s);
		}
		sw->addWidget(label(box, QStringLiteral("Switches: on, off, disabled"), QStringLiteral("muted")), 1);
		v->addLayout(sw);
	}
	{ // Sliders, progress and the stepper
		auto *box = section(body_, QStringLiteral("SLIDERS AND PROGRESS"), grid, 1, 1);
		auto *v = new QVBoxLayout(box);
		theme::space(v, 8);
		auto *vs = new ValueSlider(0, 100, 1, 0, box);
		vs->setObjectName(QStringLiteral("specimenSlider"));
		vs->setSuffix(QStringLiteral(" %"));
		vs->setValue(75);
		vs->setBubblePinned(true); // shows only when the pack asks for the bubble
		v->addSpacing(theme::spacing(18)); // room for the bubble above the handle
		v->addWidget(vs);
		auto *bar = new QProgressBar(box);
		bar->setRange(0, 100);
		bar->setValue(65);
		bar->setFormat(QStringLiteral("Uploading %p%"));
		v->addWidget(bar);
		auto *steps = new QHBoxLayout();
		theme::space(steps, 6);
		steps->addWidget(label(box, QStringLiteral("1 Config"), QStringLiteral("pill")));
		auto *cur = button(box, QStringLiteral("2 Upload"));
		cur->setCheckable(true);
		cur->setChecked(true);
		steps->addWidget(cur);
		steps->addWidget(label(box, QStringLiteral("3 Verify"), QStringLiteral("pill")));
		steps->addStretch(1);
		v->addLayout(steps);
	}
	{ // Chips
		auto *box = section(body_, QStringLiteral("CHIPS"), grid, 1, 2);
		auto *v = new QVBoxLayout(box);
		theme::space(v, 6);
		auto *busy = new TaskChip(box);
		busy->setProperty("specimenChip", QStringLiteral("busy"));
		busy->setState(2, 0, 2, 0, QString());
		auto *quiet = new TaskChip(box);
		quiet->setProperty("specimenChip", QStringLiteral("quiet"));
		quiet->setState(0, 0, 1, 0, QString());
		auto *stuck = new TaskChip(box);
		stuck->setProperty("specimenChip", QStringLiteral("stuck"));
		stuck->setState(1, 0, 1, 1, QString());
		for (auto *c : {busy, quiet, stuck})
			v->addWidget(c, 0, Qt::AlignLeft);
		auto *pills = new QHBoxLayout();
		for (const char *t : {"Active", "Pending", "Done"})
			pills->addWidget(label(box, QString::fromLatin1(t), QStringLiteral("pill")));
		pills->addStretch(1);
		v->addLayout(pills);
	}
	{ // Cards and the list
		auto *box = section(body_, QStringLiteral("CARDS AND LISTS"), grid, 2, 0);
		auto *h = new QHBoxLayout(box);
		theme::space(h, 10);
		auto *card = new QFrame(box);
		card->setObjectName(QStringLiteral("card"));
		auto *cv = new QVBoxLayout(card);
		theme::margins(cv, 12, 10, 12, 12);
		cv->addWidget(label(card, QStringLiteral("Card"), QStringLiteral("lookName")));
		cv->addWidget(label(card, QStringLiteral("A raised surface for a group of controls."), QStringLiteral("muted")));
		h->addWidget(card, 1);
		auto *stat = new QFrame(box);
		stat->setObjectName(QStringLiteral("statCard"));
		auto *sv = new QVBoxLayout(stat);
		theme::margins(sv, 12, 8, 12, 8);
		sv->addWidget(label(stat, QStringLiteral("Bitrate"), QStringLiteral("statName")));
		sv->addWidget(label(stat, QStringLiteral("6000 kbps"), QStringLiteral("statValue")));
		h->addWidget(stat, 1);
		auto *list = new QListWidget(box);
		list->setFocusPolicy(Qt::NoFocus);
		list->addItems({QStringLiteral("Main scene"), QStringLiteral("Starting soon"), QStringLiteral("Be right back"), QStringLiteral("Ending")});
		list->setCurrentRow(0);
		list->setFixedHeight(130);
		h->addWidget(list, 1);
	}
	{ // Feedback: toasts
		auto *box = section(body_, QStringLiteral("FEEDBACK"), grid, 2, 1);
		auto *v = new QVBoxLayout(box);
		theme::space(v, 8);
		for (const bool failed : {false, true}) {
			auto *toast = new QFrame(box);
			toast->setObjectName(QStringLiteral("toast"));
			toast->setProperty("failed", failed);
			auto *tv = new QVBoxLayout(toast);
			theme::margins(tv, 14, 10, 14, 10);
			tv->addWidget(label(toast, failed ? QStringLiteral("Upload failed") : QStringLiteral("Clip saved"), QStringLiteral("toastTitle")));
			tv->addWidget(label(toast, failed ? QStringLiteral("The network dropped. Try again.") : QStringLiteral("Saved to your clips folder."),
					    QStringLiteral("toastNote")));
			v->addWidget(toast);
		}
	}
	{ // Headings and text
		auto *box = section(body_, QStringLiteral("HEADINGS AND TEXT"), grid, 2, 2);
		auto *v = new QVBoxLayout(box);
		theme::space(v, 4);
		v->addWidget(label(box, QStringLiteral("Section title"), QStringLiteral("sectionTitle")));
		v->addWidget(label(box, QStringLiteral("Heading"), QStringLiteral("heading")));
		v->addWidget(label(box, QStringLiteral("Body text in the window font.")));
		v->addWidget(label(box, QStringLiteral("Muted text for hints and help."), QStringLiteral("muted")));
		v->addWidget(label(box, QStringLiteral("Caption"), QStringLiteral("ctlCaption")));
	}
	for (int c = 0; c < 3; c++)
		grid->setColumnStretch(c, 1);
	grid->setRowStretch(3, 1);

	QSize want(1180, 760);
	if (QScreen *s = screen())
		want = want.boundedTo(s->availableGeometry().size() - QSize(40, 60));
	resize(want);
}

void specimenRefresh()
{
	for (QWidget *w : QApplication::allWidgets())
		if (auto *vs = qobject_cast<ValueSlider *>(w))
			vs->updateBubble();
}

QJsonObject specimenProbe()
{
	Specimen *sp = nullptr;
	for (QWidget *w : QApplication::topLevelWidgets())
		if (auto *s = qobject_cast<Specimen *>(w); s && s->isVisible())
			sp = s;
	if (!sp)
		for (QWidget *w : QApplication::allWidgets())
			if (auto *s = qobject_cast<Specimen *>(w); s && s->isVisible())
				sp = s;
	QJsonObject o;
	o.insert(QStringLiteral("open"), sp != nullptr);
	if (!sp)
		return o;
	QJsonArray sections;
	for (auto *box : sp->findChildren<QGroupBox *>())
		if (box->property("specimenSection").isValid())
			sections.append(box->property("specimenSection").toString());
	o.insert(QStringLiteral("sections"), sections);
	o.insert(QStringLiteral("widgets"), int(sp->findChildren<QWidget *>().size()));
	if (auto *vs = sp->findChild<ValueSlider *>(QStringLiteral("specimenSlider")))
		o.insert(QStringLiteral("bubbleShown"), vs->bubbleShown());
	QJsonObject chips;
	for (auto *c : sp->findChildren<TaskChip *>())
		if (auto *l = c->findChild<QLabel *>())
			chips.insert(c->property("specimenChip").toString(), l->text());
	o.insert(QStringLiteral("chips"), chips);
	if (auto *tabs = sp->findChild<QTabBar *>(QStringLiteral("specimenTabs")))
		o.insert(QStringLiteral("tabCaps"), tabs->font().capitalization() == QFont::AllUppercase);
	int depth = 0;
	for (auto *w : sp->findChildren<QWidget *>())
		if (w->graphicsEffect())
			depth++;
	o.insert(QStringLiteral("depthWidgets"), depth);
	return o;
}

} // namespace appearance
