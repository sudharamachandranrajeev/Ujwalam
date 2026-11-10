// SPDX-License-Identifier: GPL-3.0-or-later
#include "theme.h"

#include "depth.h"
#include "icons.h"
#include "interaction.h"

#include <QAbstractButton>
#include <QApplication>
#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QFont>
#include <QFontInfo>
#include <QHash>
#include <QJsonArray>
#include <QJsonDocument>
#include <QPalette>
#include <QRegularExpression>
#include <QStandardPaths>
#include <QStyleFactory>
#include <QWidget>

#include <cmath>

namespace theme {

namespace {

const QString kDefaultId = QStringLiteral("violet-night");

struct Grad {
	bool on = false;
	QColor from, to;
	int angle = 90;
};

struct Data {
	QString id, name, topic;
	bool dark = true;
	bool custom = false;
	QHash<QString, QColor> colors;
	Grad gradWindow, gradAccent;
	QString family;
	QStringList fallbacks;
	qreal base = 10, captionSize = 8, titleSize = 15, letterSpacing = 0, captionSpacing = 0;
	int headingWeight = 600;
	bool captionCaps = false;
	int rs = 6, rm = 8, rl = 16, spS = 4, spM = 8, spL = 12, bw = 1, ctl = 18, round = 52;
	QHash<QString, DepthSpec> depth;
	int fast = 120, normal = 180, slow = 260;
	QString easing = QStringLiteral("outCubic");
	qreal lift = 1, sink = 1;
	Background bg;
	qreal stroke = 2.0;
	bool valid = false;
};

Data g_cur;
QString g_effects = QStringLiteral("full");
Notifier *g_notifier = nullptr;

QStringList searchDirs()
{
	QStringList d;
	const QString env = qEnvironmentVariable("UJWALAM_THEMES_DIR");
	if (!env.isEmpty())
		d << env;
	d << QCoreApplication::applicationDirPath() + QStringLiteral("/themes");
	const QString appData = QStandardPaths::writableLocation(QStandardPaths::AppDataLocation);
	if (!appData.isEmpty())
		d << appData + QStringLiteral("/themes");
	// A build inside the repo (out/studio/build): the repo's data/themes, so an edited pack shows without a rebuild.
	QDir up(QCoreApplication::applicationDirPath());
	for (int i = 0; i < 5 && up.cdUp(); i++)
		if (QDir(up.filePath(QStringLiteral("data/themes"))).exists()) {
			d << up.filePath(QStringLiteral("data/themes"));
			break;
		}
	return d;
}

QJsonObject readJson(const QString &path)
{
	QFile f(path);
	if (!f.open(QIODevice::ReadOnly))
		return {};
	QJsonParseError err;
	const QJsonDocument doc = QJsonDocument::fromJson(f.readAll(), &err);
	return err.error == QJsonParseError::NoError && doc.isObject() ? doc.object() : QJsonObject();
}

bool validId(const QString &id)
{
	static const QRegularExpression re(QStringLiteral("^[a-z0-9]+(-[a-z0-9]+)*$"));
	return id.size() <= 40 && re.match(id).hasMatch();
}

QJsonObject packJson(const QString &id, bool *custom = nullptr)
{
	if (!validId(id))
		return {};
	for (const QString &dir : searchDirs()) {
		const QJsonObject o = readJson(dir + QLatin1Char('/') + id + QStringLiteral(".json"));
		if (!o.isEmpty() && o.value(QStringLiteral("id")).toString() == id) {
			if (custom)
				*custom = !QFile::exists(QStringLiteral(":/themes/") + id + QStringLiteral(".json"));
			return o;
		}
	}
	const QJsonObject o = readJson(QStringLiteral(":/themes/") + id + QStringLiteral(".json"));
	if (custom)
		*custom = false;
	return o;
}

QColor col(const QJsonValue &v, const QColor &fallback)
{
	const QString s = v.toString();
	if (s.startsWith(QLatin1Char('#'))) {
		const QColor c(s);
		if (c.isValid())
			return c;
	}
	return fallback;
}
qreal num(const QJsonValue &v, qreal fallback, qreal lo, qreal hi)
{
	return v.isDouble() ? std::clamp(v.toDouble(), lo, hi) : fallback;
}
int inum(const QJsonValue &v, int fallback, int lo, int hi)
{
	return v.isDouble() ? std::clamp(int(std::lround(v.toDouble())), lo, hi) : fallback;
}
QString str(const QJsonValue &v, const QString &fallback)
{
	return v.isString() && !v.toString().isEmpty() ? v.toString() : fallback;
}
bool boolean(const QJsonValue &v, bool fallback)
{
	return v.isBool() ? v.toBool() : fallback;
}

Grad grad(const QJsonValue &v, const Grad &fallback)
{
	if (!v.isObject())
		return fallback;
	const QJsonObject o = v.toObject();
	Grad g;
	g.on = true;
	g.from = col(o.value(QStringLiteral("from")), fallback.from);
	g.to = col(o.value(QStringLiteral("to")), fallback.to);
	g.angle = inum(o.value(QStringLiteral("angle")), fallback.angle, 0, 359);
	return g;
}

DepthSpec depthSpec(const QJsonValue &v, const DepthSpec &fallback)
{
	if (!v.isObject())
		return fallback;
	const QJsonObject o = v.toObject();
	DepthSpec d;
	if (o.value(QStringLiteral("shadow")).isObject()) {
		const QJsonObject s = o.value(QStringLiteral("shadow")).toObject();
		d.shadow = {true, inum(s.value(QStringLiteral("blur")), 12, 0, 40), inum(s.value(QStringLiteral("offsetX")), 0, -12, 12),
			    inum(s.value(QStringLiteral("offsetY")), 3, -12, 12), str(s.value(QStringLiteral("color")), QStringLiteral("#000000")),
			    num(s.value(QStringLiteral("opacity")), 0.3, 0, 1)};
	}
	if (o.value(QStringLiteral("glow")).isObject()) {
		const QJsonObject s = o.value(QStringLiteral("glow")).toObject();
		d.glow = {true, inum(s.value(QStringLiteral("blur")), 12, 0, 40), str(s.value(QStringLiteral("color")), QStringLiteral("accent")),
			  num(s.value(QStringLiteral("opacity")), 0.3, 0, 0.8), str(s.value(QStringLiteral("when")), QStringLiteral("active"))};
	}
	if (o.value(QStringLiteral("extrusion")).isObject()) {
		const QJsonObject s = o.value(QStringLiteral("extrusion")).toObject();
		d.extrusion = {true, inum(s.value(QStringLiteral("depth")), 2, 1, 6), str(s.value(QStringLiteral("color")), QStringLiteral("#000000")),
			       s.value(QStringLiteral("color2")).toString()};
	}
	return d;
}

const QStringList kColorKeys = {QStringLiteral("bg"),     QStringLiteral("panel"),    QStringLiteral("field"),   QStringLiteral("border"),
				QStringLiteral("text"),   QStringLiteral("muted"),    QStringLiteral("accent"),  QStringLiteral("accentHi"),
				QStringLiteral("danger"), QStringLiteral("ok"),       QStringLiteral("onAccent"), QStringLiteral("disabled")};
const QStringList kDepthClasses = {QStringLiteral("card"),         QStringLiteral("button"), QStringLiteral("primaryButton"), QStringLiteral("roundControl"),
				   QStringLiteral("toast"),        QStringLiteral("menu"),   QStringLiteral("taskPanel")};

// Merge a pack over a base (the default pack); with no base the values only have to parse.
Data parse(const QJsonObject &o, const Data *base)
{
	Data d = base ? *base : Data();
	d.id = str(o.value(QStringLiteral("id")), d.id);
	d.name = str(o.value(QStringLiteral("name")), d.name.isEmpty() ? d.id : d.name);
	d.topic = str(o.value(QStringLiteral("topic")), d.topic);
	d.dark = boolean(o.value(QStringLiteral("dark")), d.dark);
	const QJsonObject c = o.value(QStringLiteral("colors")).toObject();
	for (const QString &k : kColorKeys)
		d.colors[k] = col(c.value(k), d.colors.value(k));
	const QJsonObject gr = o.value(QStringLiteral("gradients")).toObject();
	d.gradWindow = grad(gr.value(QStringLiteral("window")), d.gradWindow);
	d.gradAccent = grad(gr.value(QStringLiteral("accent")), d.gradAccent);
	const QJsonObject t = o.value(QStringLiteral("typography")).toObject();
	d.family = str(t.value(QStringLiteral("family")), d.family);
	if (t.value(QStringLiteral("fallbacks")).isArray()) {
		d.fallbacks.clear();
		for (const QJsonValue &v : t.value(QStringLiteral("fallbacks")).toArray())
			if (v.isString())
				d.fallbacks << v.toString();
	}
	d.base = num(t.value(QStringLiteral("baseSize")), d.base, 8, 14);
	d.captionSize = num(t.value(QStringLiteral("captionSize")), d.captionSize, 6, 12);
	d.titleSize = num(t.value(QStringLiteral("titleSize")), d.titleSize, 10, 24);
	d.headingWeight = inum(t.value(QStringLiteral("headingWeight")), d.headingWeight, 300, 900);
	d.letterSpacing = num(t.value(QStringLiteral("letterSpacing")), d.letterSpacing, -0.5, 2);
	d.captionSpacing = num(t.value(QStringLiteral("captionLetterSpacing")), d.captionSpacing, 0, 4);
	d.captionCaps = boolean(t.value(QStringLiteral("captionCaps")), d.captionCaps);
	const QJsonObject g = o.value(QStringLiteral("geometry")).toObject();
	const QJsonObject rad = g.value(QStringLiteral("radius")).toObject(), sp = g.value(QStringLiteral("spacing")).toObject();
	d.rs = inum(rad.value(QStringLiteral("small")), d.rs, 0, 40);
	d.rm = inum(rad.value(QStringLiteral("medium")), d.rm, 0, 40);
	d.rl = inum(rad.value(QStringLiteral("large")), d.rl, 0, 40);
	d.spS = inum(sp.value(QStringLiteral("small")), d.spS, 0, 40);
	d.spM = inum(sp.value(QStringLiteral("medium")), d.spM, 0, 40);
	d.spL = inum(sp.value(QStringLiteral("large")), d.spL, 0, 40);
	d.bw = inum(g.value(QStringLiteral("borderWidth")), d.bw, 0, 3);
	d.ctl = inum(g.value(QStringLiteral("controlHeight")), d.ctl, 14, 40);
	d.round = inum(g.value(QStringLiteral("roundControl")), d.round, 36, 72);
	const QJsonObject dp = o.value(QStringLiteral("depth")).toObject();
	for (const QString &k : kDepthClasses)
		d.depth[k] = depthSpec(dp.value(k), d.depth.value(k));
	const QJsonObject m = o.value(QStringLiteral("motion")).toObject();
	d.fast = inum(m.value(QStringLiteral("fastMs")), d.fast, 0, 400);
	d.normal = inum(m.value(QStringLiteral("normalMs")), d.normal, 0, 600);
	d.slow = inum(m.value(QStringLiteral("slowMs")), d.slow, 0, 600);
	d.easing = str(m.value(QStringLiteral("easing")), d.easing);
	d.lift = num(m.value(QStringLiteral("hoverLift")), d.lift, 0, 4);
	d.sink = num(m.value(QStringLiteral("pressSink")), d.sink, 0, 4);
	const QJsonObject b = o.value(QStringLiteral("background")).toObject();
	d.bg.kind = str(b.value(QStringLiteral("kind")), d.bg.kind);
	d.bg.pattern = str(b.value(QStringLiteral("pattern")), d.bg.pattern);
	d.bg.patternColor = col(b.value(QStringLiteral("patternColor")), d.bg.patternColor);
	d.bg.patternOpacity = num(b.value(QStringLiteral("patternOpacity")), d.bg.patternOpacity, 0, 0.15);
	d.bg.patternSpacing = inum(b.value(QStringLiteral("patternSpacing")), d.bg.patternSpacing, 3, 80);
	d.stroke = num(o.value(QStringLiteral("icons")).toObject().value(QStringLiteral("stroke")), d.stroke, 1.2, 3);
	d.valid = d.colors.value(QStringLiteral("bg")).isValid() && !d.family.isEmpty();
	return d;
}

const Data &defaultData()
{
	static const Data d = parse(readJson(QStringLiteral(":/themes/") + kDefaultId + QStringLiteral(".json")), nullptr);
	return d;
}

Data load(const QString &id)
{
	bool custom = false;
	const QJsonObject o = packJson(id, &custom);
	if (o.isEmpty())
		return Data();
	Data d = parse(o, &defaultData());
	d.custom = custom;
	d.bg.from = d.gradWindow.from;
	d.bg.to = d.gradWindow.to;
	d.bg.angle = d.gradWindow.angle;
	return d;
}

QString gradientQss(const Grad &g)
{
	const qreal a = g.angle * M_PI / 180.0, dx = std::cos(a) / 2, dy = std::sin(a) / 2;
	return QStringLiteral("qlineargradient(x1:%1, y1:%2, x2:%3, y2:%4, stop:0 %5, stop:1 %6)")
		.arg(0.5 - dx, 0, 'f', 3).arg(0.5 - dy, 0, 'f', 3).arg(0.5 + dx, 0, 'f', 3).arg(0.5 + dy, 0, 'f', 3)
		.arg(g.from.name(), g.to.name());
}

// The stylesheet. @name is a token from the pack (colours, radii, sizes); nothing here is a literal colour.
const char *kQss = R"(
QToolButton { background: @field; color: @text; border: @bw solid @border; border-radius: @rm; padding: 5px 12px; }
QToolButton:hover { border-color: @accentHi; }
QToolButton:pressed { background: @border; }
QToolButton::menu-indicator { image: none; width: 0; }
QMenu { background: @field; color: @text; border: @bw solid @border; border-radius: @rm; padding: 4px; }
QMenu::item { padding: 6px 18px; border-radius: @rs; }
QMenu::item:selected { background: @accent; color: @onAccent; }
QMenu::separator { height: 1px; background: @border; margin: 4px 8px; }
QToolTip { background: @field; color: @text; border: @bw solid @border; padding: 4px; }
QGroupBox { background: @panel; border: @bw solid @border; border-radius: @rl; margin-top: 22px; padding: 16px 12px 12px 12px; }
QGroupBox::title { subcontrol-origin: margin; subcontrol-position: top left; left: 4px; padding: 0 4px; color: @muted;
  font-size: @cs; font-weight: @hw; }
QFrame#strip { background: @field; border: @bw solid @border; border-radius: @rcard; }
QFrame#strip QLabel { background: transparent; }
QLabel#heading { color: @muted; font-size: @cs; font-weight: @hw; }
QLabel#pill { background: @field; border: @bw solid @border; border-radius: @rpill; padding: 3px 10px; color: @text; }
QPushButton { background: @field; color: @text; border: @bw solid @border; border-radius: @rm; padding: 5px 12px; min-height: @ctl; }
QPushButton:hover { border-color: @accentHi; }
QPushButton:pressed { background: @border; }
QPushButton:focus { border-color: @accentHi; }
QPushButton:disabled { color: @disabled; border-color: @field; }
QPushButton:checked { background: @accent; border-color: @accent; color: @onAccent; }
QPushButton[role="primary"] { background: @accentFill; border-color: @accent; color: @onAccent; font-weight: @hw; }
QPushButton[role="primary"]:hover { border-color: @accentHi; }
QPushButton[role="danger"] { background: transparent; border-color: @danger; color: @danger; font-weight: @hw; }
QPushButton[role="danger"]:checked { background: @danger; color: @onAccent; }
QPushButton[role="primary"]:disabled, QPushButton[role="danger"]:disabled { background: @field; border-color: @border; color: @disabled; }
QListWidget, QTreeWidget, QTableWidget, QPlainTextEdit, QTextEdit { background: @panel; border: @bw solid @border; border-radius: @rcard; padding: 4px; }
QListWidget::item { padding: 4px 6px; border-radius: @rs; }
QListWidget::item:selected { background: @accent; color: @onAccent; }
QListWidget::item:hover:!selected { background: @field; }
QLineEdit, QSpinBox, QDoubleSpinBox, QComboBox { background: @field; border: @bw solid @border; border-radius: @rm; padding: 4px 8px; color: @text;
  selection-background-color: @accent; selection-color: @onAccent; }
QLineEdit:hover, QSpinBox:hover, QDoubleSpinBox:hover, QComboBox:hover { border-color: @disabled; }
QLineEdit:focus, QSpinBox:focus, QDoubleSpinBox:focus, QComboBox:focus { border-color: @accent; }
QComboBox QAbstractItemView { background: @field; border: @bw solid @border; selection-background-color: @accent; selection-color: @onAccent; }
QCheckBox::indicator, QListWidget::indicator { width: 16px; height: 16px; border-radius: @rs4; border: @bw solid @disabled; background: @field; }
QCheckBox::indicator:hover { border-color: @accentHi; }
QCheckBox::indicator:checked, QListWidget::indicator:checked { background: @accent; border-color: @accent; }
QSlider::groove:horizontal { height: 4px; background: @border; border-radius: 2px; }
QSlider::sub-page:horizontal { background: @accent; border-radius: 2px; }
QSlider::handle:horizontal { background: @text; width: 14px; margin: -6px 0; border-radius: 7px; }
QSlider::handle:horizontal:hover { background: @accentHi; }
QProgressBar { background: @field; border: @bw solid @border; border-radius: @rs; text-align: center; }
QProgressBar::chunk { background: @accent; border-radius: @rs; }
QScrollArea { border: none; background: transparent; }
QScrollArea > QWidget > QWidget { background: transparent; }
QScrollBar:vertical { background: transparent; width: 10px; margin: 2px; }
QScrollBar::handle:vertical { background: @border; border-radius: 4px; min-height: 24px; }
QScrollBar::handle:vertical:hover { background: @disabled; }
QScrollBar:horizontal { background: transparent; height: 10px; margin: 2px; }
QScrollBar::handle:horizontal { background: @border; border-radius: 4px; min-width: 24px; }
QScrollBar::handle:horizontal:hover { background: @disabled; }
QScrollBar::add-line, QScrollBar::sub-line { width: 0; height: 0; }
QSplitter::handle { background: transparent; }
QStatusBar { background: transparent; color: @muted; }
QTabBar::tab { background: @field; color: @muted; border: @bw solid @border; border-radius: @rm; padding: 4px 12px; margin-right: 4px; }
QTabBar::tab:hover:!selected { border-color: @accentHi; color: @text; }
QTabBar::tab:selected { background: @accent; color: @onAccent; border-color: @accent; }
QLabel#muted { color: @muted; background: transparent; }
QToolButton#taskClose { border: none; background: transparent; color: @muted; padding: 0 6px; border-radius: @rs; }
QToolButton#taskClose:hover { background: @border; color: @text; }
QWidget#taskChip { background: @field; border: @bw solid @accent; border-radius: @rpill; }
QWidget#taskChip[quiet="true"] { border-color: @border; }
QWidget#taskChip[stalled="true"] { border: 2px solid @danger; }
QWidget#taskChip QLabel { background: transparent; color: @text; font-weight: @hw; }
QWidget#taskChip[quiet="true"] QLabel { color: @muted; font-weight: normal; }
QFrame#taskPanel { background: @panel; border: @bw solid @border; border-radius: @rpanel; }
QFrame#taskRow { background: @field; border: @bw solid @border; border-radius: @rpill; }
QFrame#taskRow[stalled="true"] { border: 2px solid @danger; }
QFrame#taskRow QLabel { background: transparent; }
QLabel#taskTitle { color: @text; font-weight: @hw; }
QLabel#taskStage, QLabel#taskCount { color: @text; }
QLabel#taskWarn { color: @danger; font-weight: @hw; }
QFrame#toast { background: @panel; border: 2px solid @accent; border-radius: @rtoast; }
QFrame#toast[failed="true"] { border-color: @danger; }
QFrame#toast QLabel { background: transparent; color: @text; }
QLabel#toastTitle { font-weight: @hw; font-size: 11pt; }
QLabel#toastNote { font-size: 10pt; }
QFrame#statCard { background: @panel; border: @bw solid @border; border-radius: @rinner; }
QFrame#statCard QLabel { background: transparent; }
QLabel#statName { color: @muted; font-size: @cs; font-weight: @hw; }
QLabel#statValue { color: @text; font-size: @fs; font-weight: @hw; }
QLabel#statBig { color: @text; font-size: 20pt; font-weight: @hw; }
QFrame#card { background: @panel; border: @bw solid @border; border-radius: @rl; }
QFrame#card QLabel { background: transparent; }
QLabel#ctlCaption { color: @muted; font-size: @cs; background: transparent; }
QLabel#brand { font-size: 14pt; font-weight: 700; color: @text; padding-right: 6px; background: transparent; }
QPushButton#tb, QToolButton#tb { background: transparent; border: none; border-radius: @rpill; padding: 6px 12px; color: @text; font-size: 9pt; min-height: 20px; }
QPushButton#tb:hover, QToolButton#tb:hover { background: @field; }
QPushButton#tb:pressed, QToolButton#tb:pressed { background: @border; }
QPushButton#tb:disabled { color: @disabled; background: transparent; }
QPushButton#round { background: @field; border: @bw solid @border; border-radius: @rround; padding: 0; min-width: @round; max-width: @round; min-height: @round; max-height: @round; }
QPushButton#round:hover { border-color: @accentHi; }
QPushButton#round:pressed { background: @border; }
QPushButton#round:disabled { background: @field; border: @bw solid @border; }
QPushButton#round[role="primary"] { background: @accentFill; border: @bw solid @accent; }
QPushButton#round[role="primary"][active="true"] { background: @danger; border: @bw solid @danger; }
QPushButton#round[role="primary"]:disabled { background: @field; border: @bw solid @border; }
QPushButton#round[role="danger"] { background: transparent; border: 2px solid @danger; }
QPushButton#round[role="danger"][active="true"] { background: @danger; }
QPushButton#round[role="danger"]:disabled { background: transparent; border: 2px solid @border; }
QFrame#lookCard { background: @field; border: @bw solid @border; border-radius: @rinner; }
QFrame#lookCard QLabel { background: transparent; }
QLabel#lookName { font-weight: @hw; }
QListWidget#sceneCards { background: transparent; border: none; padding: 0; }
QListWidget#sceneCards::item { padding: 0; background: transparent; }
QListWidget#sceneCards::item:selected, QListWidget#sceneCards::item:hover { background: transparent; }
QListWidget#settingsNav { background: transparent; border: none; padding: 0; outline: none; }
QListWidget#settingsNav::item { padding: 10px 14px; border-radius: @rpill; margin-bottom: 4px; color: @muted; }
QListWidget#settingsNav::item:selected { background: @field; color: @text; font-weight: @hw; }
QListWidget#settingsNav::item:hover:!selected { background: @panel; color: @text; }
QLabel#sectionTitle { font-size: @ts; font-weight: @hw; background: transparent; }
QFrame#themeCard { background: @field; border: @bw solid @border; border-radius: @rinner; }
)";

QString buildQss(const Data &d)
{
	QHash<QString, QString> t;
	for (auto it = d.colors.cbegin(); it != d.colors.cend(); ++it)
		t[it.key()] = it.value().name();
	auto px = [](int v) { return QStringLiteral("%1px").arg(v); };
	t[QStringLiteral("rs")] = px(d.rs);
	t[QStringLiteral("rs4")] = px(std::min(d.rs, 4));
	t[QStringLiteral("rm")] = px(d.rm);
	t[QStringLiteral("rl")] = px(d.rl);
	t[QStringLiteral("rpill")] = px(std::min(d.rm + 2, d.rl));
	t[QStringLiteral("rinner")] = px((d.rm + d.rl) / 2);
	t[QStringLiteral("rcard")] = px(std::max(d.rm, d.rl - 2));
	t[QStringLiteral("rpanel")] = px(std::max(d.rm, d.rl - 2));
	t[QStringLiteral("rtoast")] = px(d.rm + std::min(4, d.rl));
	t[QStringLiteral("rround")] = px(d.round / 2);
	t[QStringLiteral("round")] = px(d.round);
	t[QStringLiteral("bw")] = px(d.bw);
	t[QStringLiteral("ctl")] = px(d.ctl);
	t[QStringLiteral("hw")] = QString::number(d.headingWeight);
	t[QStringLiteral("cs")] = QStringLiteral("%1pt").arg(d.captionSize);
	t[QStringLiteral("fs")] = QStringLiteral("%1pt").arg(d.base);
	t[QStringLiteral("ts")] = QStringLiteral("%1pt").arg(d.titleSize);
	t[QStringLiteral("accentFill")] = d.gradAccent.on ? gradientQss(d.gradAccent) : d.colors.value(QStringLiteral("accent")).name();
	static const QRegularExpression re(QStringLiteral("@([A-Za-z0-9]+)"));
	QString qss = QString::fromUtf8(kQss);
	QString out;
	qsizetype last = 0;
	auto it = re.globalMatch(qss);
	while (it.hasNext()) {
		const auto m = it.next();
		out += qss.mid(last, m.capturedStart() - last);
		out += t.value(m.captured(1), m.captured(0));
		last = m.capturedEnd();
	}
	return out + qss.mid(last);
}

void applyPalette(QApplication &app, const Data &d)
{
	const auto c = [&](const char *k) { return d.colors.value(QLatin1String(k)); };
	QPalette p;
	p.setColor(QPalette::Window, c("bg"));
	p.setColor(QPalette::WindowText, c("text"));
	p.setColor(QPalette::Base, c("panel"));
	p.setColor(QPalette::AlternateBase, c("field"));
	p.setColor(QPalette::Text, c("text"));
	p.setColor(QPalette::Button, c("field"));
	p.setColor(QPalette::ButtonText, c("text"));
	p.setColor(QPalette::ToolTipBase, c("field"));
	p.setColor(QPalette::ToolTipText, c("text"));
	p.setColor(QPalette::PlaceholderText, c("muted"));
	p.setColor(QPalette::Highlight, c("accent"));
	p.setColor(QPalette::HighlightedText, c("onAccent"));
	p.setColor(QPalette::Link, c("accentHi"));
	for (auto role : {QPalette::WindowText, QPalette::Text, QPalette::ButtonText})
		p.setColor(QPalette::Disabled, role, c("disabled"));
	app.setPalette(p);
}

void applyFont(QApplication &app, const Data &d)
{
	QFont f;
	QStringList fam{d.family};
	fam << d.fallbacks;
	f.setFamilies(fam);
	f.setPointSizeF(d.base);
	f.setLetterSpacing(QFont::AbsoluteSpacing, d.letterSpacing);
	app.setFont(f);
}

// Icons are pictures made with a colour: draw them again in the new theme's colours.
void refreshIcons()
{
	const QColor ink = color(QStringLiteral("text"));
	for (QWidget *w : QApplication::allWidgets()) {
		auto *b = qobject_cast<QAbstractButton *>(w);
		if (!b)
			continue;
		const QStringList spec = b->property("themeIcon").toString().split(QLatin1Char(':')); // "<name>:<px>"
		if (spec.size() == 2) {
			b->setIcon(icons::make(spec[0], ink, spec[1].toInt()));
			continue;
		}
		const QString state = b->property("iconState").toString(); // round controls: "<icon>+" (active) or "<icon>-"
		if (state.size() > 1) {
			const bool active = state.endsWith(QLatin1Char('+'));
			const QString role = b->property("role").toString();
			const bool primary = role == QStringLiteral("primary"), danger = role == QStringLiteral("danger");
			const QColor c = (primary || (danger && active)) ? color(QStringLiteral("onAccent")) : danger ? color(QStringLiteral("danger")) : ink;
			b->setIcon(icons::make(state.left(state.size() - 1), c, std::max(14, b->iconSize().width()), color(QStringLiteral("muted"))));
		}
	}
}

void applyAll(QApplication &app)
{
	applyPalette(app, g_cur);
	applyFont(app, g_cur);
	app.setStyleSheet(buildQss(g_cur));
	interaction::refresh(); // captions, backgrounds
	depth::refreshAll();
	refreshIcons();
	for (QWidget *w : QApplication::allWidgets())
		w->update();
	emit notifier()->changed();
}

} // namespace

Notifier *notifier()
{
	if (!g_notifier)
		g_notifier = new Notifier();
	return g_notifier;
}

void apply(QApplication &app)
{
	app.setStyle(QStyleFactory::create(QStringLiteral("Fusion")));
	QString id = qEnvironmentVariable("UJWALAM_THEME");
	if (id.isEmpty())
		id = kDefaultId;
	g_cur = load(id);
	if (!g_cur.valid)
		g_cur = load(kDefaultId);
	if (!g_cur.valid) // the embedded default is missing: Fusion's own look
		return;
	const QString fx = qEnvironmentVariable("UJWALAM_EFFECTS");
	if (fx == QStringLiteral("reduced") || fx == QStringLiteral("full"))
		g_effects = fx;
	applyPalette(app, g_cur);
	applyFont(app, g_cur);
	app.setStyleSheet(buildQss(g_cur));
}

bool setCurrent(const QString &id)
{
	if (id == g_cur.id && g_cur.valid)
		return true;
	Data d = load(id);
	if (!d.valid)
		return false;
	g_cur = d;
	applyAll(*qobject_cast<QApplication *>(QCoreApplication::instance()));
	return true;
}

QString currentId()
{
	return g_cur.id;
}

void setEffects(const QString &mode)
{
	const QString m = mode == QStringLiteral("reduced") ? mode : QStringLiteral("full");
	if (m == g_effects)
		return;
	g_effects = m;
	depth::refreshAll();
	for (QWidget *w : QApplication::allWidgets())
		w->update();
	emit notifier()->changed();
}

QString effects()
{
	return g_effects;
}

bool effectsOn()
{
	return g_effects != QStringLiteral("reduced");
}

QList<Info> available()
{
	QStringList ids;
	for (const QString &f : QDir(QStringLiteral(":/themes")).entryList({QStringLiteral("*.json")}))
		ids << f.left(f.size() - 5);
	for (const QString &dir : searchDirs())
		for (const QString &f : QDir(dir).entryList({QStringLiteral("*.json")}))
			if (!f.endsWith(QStringLiteral(".schema.json")) && !ids.contains(f.left(f.size() - 5)))
				ids << f.left(f.size() - 5);
	// Violet Night first, then the embedded ones in name order, then custom packs.
	ids.sort();
	ids.removeAll(kDefaultId);
	ids.prepend(kDefaultId);
	QList<Info> out;
	for (const QString &id : ids) {
		const Data d = load(id);
		if (!d.valid)
			continue;
		Info i;
		i.id = d.id;
		i.name = d.name;
		i.topic = d.topic;
		i.dark = d.dark;
		i.custom = d.custom;
		i.bg = d.colors.value(QStringLiteral("bg"));
		i.panel = d.colors.value(QStringLiteral("panel"));
		i.field = d.colors.value(QStringLiteral("field"));
		i.border = d.colors.value(QStringLiteral("border"));
		i.text = d.colors.value(QStringLiteral("text"));
		i.accent = d.colors.value(QStringLiteral("accent"));
		i.accentHi = d.colors.value(QStringLiteral("accentHi"));
		i.danger = d.colors.value(QStringLiteral("danger"));
		i.gradFrom = d.gradAccent.on ? d.gradAccent.from : i.accent;
		i.gradTo = d.gradAccent.on ? d.gradAccent.to : i.accent;
		i.radiusSmall = d.rs;
		i.radiusMedium = d.rm;
		i.radiusLarge = d.rl;
		i.family = d.family;
		i.glow = d.depth.value(QStringLiteral("primaryButton")).glow.enabled; // what the swatch shows: the main button's halo
		i.extrusion = d.depth.value(QStringLiteral("primaryButton")).extrusion.enabled || d.depth.value(QStringLiteral("roundControl")).extrusion.enabled;
		out << i;
	}
	return out;
}

QColor color(const QString &token)
{
	return g_cur.colors.value(token, QColor());
}

QString hex(const QString &token)
{
	return color(token).name();
}

QColor resolve(const QString &ref, bool active)
{
	if (ref.startsWith(QLatin1Char('#')))
		return QColor(ref);
	if (ref == QStringLiteral("auto"))
		return color(active ? QStringLiteral("danger") : QStringLiteral("accent"));
	return color(ref);
}

int radius(Radius size)
{
	return size == Radius::Small ? g_cur.rs : size == Radius::Large ? g_cur.rl : g_cur.rm;
}

int roundSize()
{
	return g_cur.round;
}

int spacing(Radius size)
{
	return size == Radius::Small ? g_cur.spS : size == Radius::Large ? g_cur.spL : g_cur.spM;
}

int borderWidth()
{
	return g_cur.bw;
}

qreal iconStroke()
{
	return g_cur.stroke;
}

int duration(const QString &which)
{
	return which == QStringLiteral("fast") ? g_cur.fast : which == QStringLiteral("slow") ? g_cur.slow : g_cur.normal;
}

QEasingCurve::Type easing()
{
	static const QHash<QString, QEasingCurve::Type> m{
		{QStringLiteral("linear"), QEasingCurve::Linear},     {QStringLiteral("outQuad"), QEasingCurve::OutQuad},
		{QStringLiteral("outCubic"), QEasingCurve::OutCubic}, {QStringLiteral("outExpo"), QEasingCurve::OutExpo},
		{QStringLiteral("outBack"), QEasingCurve::OutBack},   {QStringLiteral("inOutQuad"), QEasingCurve::InOutQuad},
		{QStringLiteral("inOutCubic"), QEasingCurve::InOutCubic}};
	return m.value(g_cur.easing, QEasingCurve::OutCubic);
}

qreal hoverLift()
{
	return g_cur.lift;
}

qreal pressSink()
{
	return g_cur.sink;
}

DepthSpec depthSpec(const QString &cls)
{
	return g_cur.depth.value(cls);
}

int depthRadius(const QString &cls, const QSize &sz)
{
	const int cap = std::min(sz.width(), sz.height()) / 2;
	int r = g_cur.rm;
	if (cls == QStringLiteral("roundControl"))
		r = cap;
	else if (cls == QStringLiteral("card"))
		r = g_cur.rl;
	else if (cls == QStringLiteral("taskPanel"))
		r = std::max(g_cur.rm, g_cur.rl - 2);
	else if (cls == QStringLiteral("toast"))
		r = g_cur.rm + std::min(4, g_cur.rl);
	return std::min(r, cap);
}

Background background()
{
	Background b = g_cur.bg;
	return b;
}

Caption caption()
{
	return {g_cur.captionSize, g_cur.captionSpacing, g_cur.captionCaps, g_cur.headingWeight};
}

void depth(QWidget *w, const QString &cls)
{
	depth::attach(w, cls);
}

QJsonObject probe()
{
	QJsonObject o;
	o.insert(QStringLiteral("id"), g_cur.id);
	o.insert(QStringLiteral("name"), g_cur.name);
	o.insert(QStringLiteral("effects"), g_effects);
	o.insert(QStringLiteral("custom"), g_cur.custom);
	o.insert(QStringLiteral("family"), g_cur.family);
	o.insert(QStringLiteral("appliedFamily"), QFontInfo(QApplication::font()).family());
	o.insert(QStringLiteral("depthWidgets"), depth::count());
	o.insert(QStringLiteral("depthEligible"), depth::eligible());
	o.insert(QStringLiteral("backgroundKind"), g_cur.bg.kind);
	QJsonArray ids;
	for (const Info &i : available())
		ids.append(i.id);
	o.insert(QStringLiteral("available"), ids);
	return o;
}

bool probeAction(const QString &action)
{
	if (action.startsWith(QStringLiteral("theme:")))
		return setCurrent(action.mid(6));
	if (action.startsWith(QStringLiteral("effects:"))) {
		const QString m = action.mid(8);
		if (m != QStringLiteral("full") && m != QStringLiteral("reduced"))
			return false;
		setEffects(m);
		return true;
	}
	return false;
}

} // namespace theme
