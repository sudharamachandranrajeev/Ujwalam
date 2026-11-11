// SPDX-License-Identifier: GPL-3.0-or-later
#include "theme.h"

#include "depth.h"
#include "icons.h"
#include "interaction.h"
#include "motion.h"

#include <QAbstractButton>
#include <QApplication>
#include <QCoreApplication>
#include <QCryptographicHash>
#include <QDateTime>
#include <QFileInfo>
#include <QFileSystemWatcher>
#include <QTimer>
#include <QDir>
#include <QSet>
#include <QFile>
#include <QFont>
#include <QFontDatabase>
#include <QFontInfo>
#include <QHash>
#include <QJsonArray>
#include <QJsonDocument>
#include <QLayout>
#include <QMargins>
#include <QPalette>
#include <QRect>
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
	QJsonObject src; // the accepted pack JSON this look was parsed from (D336: a flag switch parses it again)
	QHash<QString, QColor> colors;
	Grad gradWindow, gradAccent, gradPanel, gradControl; // panel / control: optional surface gradients (cards, buttons)
	QString family;
	QStringList fallbacks;
	qreal base = 10, captionSize = 8, titleSize = 15, letterSpacing = 0, captionSpacing = 0;
	int headingWeight = 600;
	bool captionCaps = false;
	int rs = 6, rm = 8, rl = 16, spS = 4, spM = 8, spL = 12, bw = 1, ctl = 18, round = 52;
	int padY = 5, padX = 12; // button padding (optional geometry.controlPadding)
	QHash<QString, DepthSpec> depth;
	int fast = 120, normal = 180, slow = 260;
	QString easing = QStringLiteral("outCubic");
	qreal lift = 1, sink = 1;
	Background bg;
	qreal stroke = 2.0;
	// Schema v2 (D336): read only while the flag theme-components is on; never inherited from the default pack.
	QHash<QString, QString> comp; // "button.shape" -> "pill"; booleans as "true" / "false"
	bool buttonCaps = false, tabCaps = false, headingCaps = false;
	QHash<QString, qreal> scale; // h1 h2 subtitle body caption button (pt)
	bool valid = false;
};

Data g_cur;
QString g_effects = QStringLiteral("full");
bool g_components = false; // the flag theme-components (D336)
qreal g_appliedDensity = 1.0;
QString g_baseStyleHash; // probe: the base stylesheet as applied (parity of packs without a components block, D336)
int g_fragmentLength = 0; // probe: characters of variant fragments in the applied stylesheet
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

// Bundled open-licence fonts (SIL OFL 1.1, D344): data/fonts beside the app (package: <root>/data/fonts, studio exe in
// <root>/studio), or UJWALAM_FONTS_DIR. Loaded for this process only with addApplicationFont; never installed into Windows.
QStringList g_bundledFamilies;

void loadBundledFonts()
{
	QStringList dirs;
	const QString env = qEnvironmentVariable("UJWALAM_FONTS_DIR");
	if (!env.isEmpty())
		dirs << env;
	dirs << QCoreApplication::applicationDirPath() + QStringLiteral("/fonts");
	QDir up(QCoreApplication::applicationDirPath());
	for (int i = 0; i < 5 && up.cdUp(); i++)
		if (QDir(up.filePath(QStringLiteral("data/fonts"))).exists()) {
			dirs << up.filePath(QStringLiteral("data/fonts"));
			break;
		}
	QSet<QString> seen;
	for (const QString &d : dirs)
		for (const QFileInfo &fi : QDir(d).entryInfoList({QStringLiteral("*.ttf")}, QDir::Files, QDir::Name)) {
			if (seen.contains(fi.fileName()))
				continue;
			seen.insert(fi.fileName());
			const int id = QFontDatabase::addApplicationFont(fi.absoluteFilePath());
			if (id >= 0)
				for (const QString &fam : QFontDatabase::applicationFontFamilies(id))
					if (!g_bundledFamilies.contains(fam))
						g_bundledFamilies << fam;
		}
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

Shadow shadowPart(const QJsonObject &s, const QString &color)
{
	return {true,
		inum(s.value(QStringLiteral("blur")), 12, 0, 40),
		inum(s.value(QStringLiteral("offsetX")), 0, -12, 12),
		inum(s.value(QStringLiteral("offsetY")), 3, -12, 12),
		str(s.value(QStringLiteral("color")), color),
		num(s.value(QStringLiteral("opacity")), 0.3, 0, 1)};
}

// v2: the pack has a components block and the flag theme-components is on (D336); otherwise only the v1 parts.
DepthSpec depthSpec(const QJsonValue &v, const DepthSpec &fallback, bool v2)
{
	if (!v.isObject())
		return fallback;
	const QJsonObject o = v.toObject();
	DepthSpec d;
	if (o.value(QStringLiteral("shadow")).isObject())
		d.shadow = shadowPart(o.value(QStringLiteral("shadow")).toObject(), QStringLiteral("#000000"));
	if (v2) { // schema v2 (D336): only with the flag theme-components and the pack's components block
		if (o.value(QStringLiteral("highlight")).isObject())
			d.highlight = shadowPart(o.value(QStringLiteral("highlight")).toObject(), QStringLiteral("#ffffff"));
		if (o.value(QStringLiteral("inset")).isObject()) {
			const QJsonObject s = o.value(QStringLiteral("inset")).toObject();
			const Shadow sh = shadowPart(s, QStringLiteral("#000000"));
			d.inset = {true, sh.blur, sh.offsetX, sh.offsetY, sh.color, sh.opacity, s.value(QStringLiteral("when")).toString() == QStringLiteral("pressed")};
		}
		if (o.value(QStringLiteral("rim")).isObject()) {
			const QJsonObject s = o.value(QStringLiteral("rim")).toObject();
			d.rim.enabled = true;
			d.rim.from = str(s.value(QStringLiteral("from")), QStringLiteral("border"));
			d.rim.to = str(s.value(QStringLiteral("to")), d.rim.from);
			d.rim.width = inum(s.value(QStringLiteral("width")), 1, 1, 4);
			if (s.value(QStringLiteral("innerGlow")).isObject()) {
				const QJsonObject g = s.value(QStringLiteral("innerGlow")).toObject();
				d.rim.glow = true;
				d.rim.glowColor = str(g.value(QStringLiteral("color")), QStringLiteral("accent"));
				d.rim.glowOpacity = num(g.value(QStringLiteral("opacity")), 0.4, 0, 0.8);
				d.rim.glowWidth = inum(g.value(QStringLiteral("width")), 1, 1, 3);
			}
		}
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

// ---- Components block (schema v2, D336) ----
const QStringList kBool = {QStringLiteral("true"), QStringLiteral("false")};

// Empty when the pack's components block is usable (or absent); else why not. Unknown keys and variants are refused,
// so a typo never silently falls back to the base look.
QString componentsProblem(const QJsonObject &pack)
{
	if (!pack.contains(QStringLiteral("components")))
		return {};
	const QJsonValue cv = pack.value(QStringLiteral("components"));
	if (!cv.isObject())
		return QStringLiteral("components must be an object");
	const QJsonObject c = cv.toObject();
	auto variants = [](const QString &key) -> const QStringList * {
		for (const auto &kv : componentVariants())
			if (kv.first == key)
				return &kv.second;
		return nullptr;
	};
	auto check = [&](const QString &key, const QJsonValue &v) -> QString {
		const QStringList *allowed = variants(key);
		if (!allowed)
			return QStringLiteral("components.%1 is not a known component").arg(key);
		if (*allowed == kBool)
			return v.isBool() ? QString() : QStringLiteral("components.%1 must be true or false").arg(key);
		if (!v.isString() || !allowed->contains(v.toString()))
			return QStringLiteral("components.%1 must be one of %2").arg(key, allowed->join(QStringLiteral(", ")));
		return {};
	};
	for (auto it = c.begin(); it != c.end(); ++it) {
		const QString k = it.key();
		if (k == QStringLiteral("button") || k == QStringLiteral("slider")) {
			if (!it.value().isObject())
				return QStringLiteral("components.%1 must be an object").arg(k);
			const QJsonObject sub = it.value().toObject();
			for (auto s = sub.begin(); s != sub.end(); ++s)
				if (const QString why = check(k + QLatin1Char('.') + s.key(), s.value()); !why.isEmpty())
					return why;
			continue;
		}
		if (const QString why = check(k, it.value()); !why.isEmpty())
			return why;
	}
	return {};
}

QHash<QString, QString> readComponents(const QJsonObject &pack)
{
	QHash<QString, QString> out;
	const QJsonObject c = pack.value(QStringLiteral("components")).toObject();
	auto put = [&](const QString &key, const QJsonValue &v) {
		if (v.isBool())
			out.insert(key, v.toBool() ? QStringLiteral("true") : QStringLiteral("false"));
		else if (v.isString())
			out.insert(key, v.toString());
	};
	for (auto it = c.begin(); it != c.end(); ++it) {
		if (it.value().isObject()) {
			const QJsonObject sub = it.value().toObject();
			for (auto s = sub.begin(); s != sub.end(); ++s)
				put(it.key() + QLatin1Char('.') + s.key(), s.value());
		} else
			put(it.key(), it.value());
	}
	return out;
}

// Merge a pack over a base (the default pack); with no base the values only have to parse.
Data parse(const QJsonObject &o, const Data *base)
{
	Data d = base ? *base : Data();
	// Schema v2 parts (D336) apply only with the flag on AND a components block in this pack: a pack without one looks
	// exactly as it does with the flag off, whatever other v2 fields it carries (Codex review of T1).
	const bool v2 = g_components && o.contains(QStringLiteral("components"));
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
	// Surface gradients are the pack's own: never inherited from the default pack (a flat pack stays flat).
	d.gradPanel = grad(gr.value(QStringLiteral("panel")), Grad());
	d.gradControl = grad(gr.value(QStringLiteral("control")), Grad());
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
	const QJsonObject pad = g.value(QStringLiteral("controlPadding")).toObject();
	d.padY = inum(pad.value(QStringLiteral("y")), 5, 2, 12);
	d.padX = inum(pad.value(QStringLiteral("x")), 12, 4, 24);
	const QJsonObject dp = o.value(QStringLiteral("depth")).toObject();
	for (const QString &k : kDepthClasses)
		d.depth[k] = depthSpec(dp.value(k), d.depth.value(k), v2);
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
	// Schema v2 (D336): the pack's own parts only (never the default pack's), and only when v2 (above). Otherwise the
	// v2 patterns draw as the nearest v1 look (blueprint as grid, columns as none).
	d.comp.clear();
	d.scale.clear();
	d.buttonCaps = d.tabCaps = d.headingCaps = false;
	d.bg.frame = d.bg.frameTicks = false;
	d.bg.frameOpacity = 0;
	if (v2) {
		d.comp = readComponents(o);
		d.buttonCaps = boolean(t.value(QStringLiteral("buttonCaps")), false);
		d.tabCaps = boolean(t.value(QStringLiteral("tabCaps")), false);
		d.headingCaps = boolean(t.value(QStringLiteral("headingCaps")), false);
		const QJsonObject sc = t.value(QStringLiteral("scale")).toObject();
		for (auto it = sc.begin(); it != sc.end(); ++it)
			if (it.value().isDouble())
				d.scale.insert(it.key(), std::clamp(it.value().toDouble(), 6.0, 28.0));
		if (d.scale.contains(QStringLiteral("body")))
			d.base = std::clamp(d.scale.value(QStringLiteral("body")), 8.0, 14.0);
		if (d.scale.contains(QStringLiteral("caption")))
			d.captionSize = std::clamp(d.scale.value(QStringLiteral("caption")), 6.0, 12.0);
		const QJsonObject fr = b.value(QStringLiteral("frame")).toObject();
		if (!fr.isEmpty()) {
			d.bg.frame = true;
			d.bg.frameTicks = boolean(fr.value(QStringLiteral("ticks")), false);
			d.bg.frameOpacity = num(fr.value(QStringLiteral("opacity")), 0.3, 0, 0.6);
		}
	} else if (d.bg.pattern == QStringLiteral("blueprint"))
		d.bg.pattern = QStringLiteral("grid");
	else if (d.bg.pattern == QStringLiteral("columns"))
		d.bg.pattern = QStringLiteral("none");
	d.valid = d.colors.value(QStringLiteral("bg")).isValid() && !d.family.isEmpty();
	return d;
}

const Data &defaultData()
{
	static const Data d = parse(readJson(QStringLiteral(":/themes/") + kDefaultId + QStringLiteral(".json")), nullptr);
	return d;
}

// ---- LU2: live reload of the current pack (D324) ----
QFileSystemWatcher *g_watch = nullptr;
QTimer *g_reloadTimer = nullptr;
QByteArray g_fileHash; // content hash of the pack file the current look came from (empty: embedded)
int g_reloads = 0, g_rejects = 0;
QString g_lastReject;

QString packFile(const QString &id)
{
	if (!validId(id))
		return {};
	for (const QString &dir : searchDirs()) {
		const QString p = dir + QLatin1Char('/') + id + QStringLiteral(".json");
		if (QFile::exists(p))
			return p;
	}
	return {};
}

QByteArray readBytes(const QString &path, bool *ok)
{
	QFile f(path);
	*ok = f.open(QIODevice::ReadOnly);
	return *ok ? f.readAll() : QByteArray();
}

QByteArray hashOf(const QByteArray &b)
{
	return QCryptographicHash::hash(b, QCryptographicHash::Sha256);
}

void rememberFile(const QString &id)
{
	const QString p = packFile(id);
	bool ok = false;
	const QByteArray b = p.isEmpty() ? QByteArray() : readBytes(p, &ok);
	g_fileHash = ok ? hashOf(b) : QByteArray();
	if (g_watch && ok && !g_watch->files().contains(p))
		g_watch->addPath(p);
}

// A pack's JSON made into the look (merged over the default pack). The JSON is kept with the look, so a flag switch
// parses the accepted version again, never a newer file on disk that live reload refused (D336).
Data fromJson(const QJsonObject &o, bool custom)
{
	if (o.isEmpty())
		return Data();
	if (const QString why = componentsProblem(o); !why.isEmpty()) { // D336: an unknown variant makes the pack unusable
		qWarning("theme: %s not usable: %s", qPrintable(o.value(QStringLiteral("id")).toString()), qPrintable(why));
		return Data();
	}
	Data d = parse(o, &defaultData());
	d.src = o;
	d.custom = custom;
	d.bg.from = d.gradWindow.from;
	d.bg.to = d.gradWindow.to;
	d.bg.angle = d.gradWindow.angle;
	return d;
}

Data load(const QString &id)
{
	bool custom = false;
	const QJsonObject o = packJson(id, &custom); // before fromJson: argument order is unspecified
	return fromJson(o, custom);
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
QToolButton { background: @controlFill; color: @text; border: @bw solid @border; border-radius: @rm; padding: @padY @padX; }
QToolButton:hover { border-color: @accentHi; }
QToolButton:pressed { background: @border; }
QToolButton::menu-indicator { image: none; width: 0; }
QMenu { background: @field; color: @text; border: @bw solid @border; border-radius: @rm; padding: 4px; }
QMenu::item { padding: 6px 18px; border-radius: @rs; }
QMenu::item:selected { background: @accent; color: @onAccent; }
QMenu::separator { height: 1px; background: @border; margin: 4px 8px; }
QToolTip { background: @field; color: @text; border: @bw solid @border; padding: 4px; }
QGroupBox { background: @panelFill; border: @bw solid @border; border-radius: @rl; margin-top: 22px; padding: 16px 12px 12px 12px; }
QGroupBox::title { subcontrol-origin: margin; subcontrol-position: top left; left: 4px; padding: 0 4px; color: @muted;
  font-size: @cs; font-weight: @hw; }
QFrame#strip { background: @field; border: @bw solid @border; border-radius: @rcard; }
QFrame#strip QLabel { background: transparent; }
QLabel#heading { color: @muted; font-size: @cs; font-weight: @hw; }
QLabel#pill { background: @field; border: @bw solid @border; border-radius: @rpill; padding: 3px 10px; color: @text; }
QPushButton { background: @controlFill; color: @text; border: @bw solid @border; border-radius: @rm; padding: @padY @padX; min-height: @ctl; }
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
QFrame#taskPanel { background: @panelFill; border: @bw solid @border; border-radius: @rpanel; }
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
QFrame#statCard { background: @panelFill; border: @bw solid @border; border-radius: @rinner; }
QFrame#statCard QLabel { background: transparent; }
QLabel#statName { color: @muted; font-size: @cs; font-weight: @hw; }
QLabel#statValue { color: @text; font-size: @fs; font-weight: @hw; }
QLabel#statBig { color: @text; font-size: 20pt; font-weight: @hw; }
QFrame#card { background: @panelFill; border: @bw solid @border; border-radius: @rl; }
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

// a + (b - a) * t per channel, rounded: the same formula as tests/studio-theme-contrast.test.mjs (mix()).
QColor mixc(const QColor &a, const QColor &b, qreal t)
{
	auto ch = [t](int x, int y) { return int(std::lround(x + (y - x) * t)); };
	return QColor(ch(a.red(), b.red()), ch(a.green(), b.green()), ch(a.blue(), b.blue()));
}

// Derived colours the variant fragments use (D336). Mirrored in tests/studio-theme-contrast.test.mjs (derived()):
// change both together.
QHash<QString, QColor> derived(const Data &d)
{
	const auto c = [&](const char *k) { return d.colors.value(QLatin1String(k)); };
	const QColor black(0, 0, 0), white(255, 255, 255);
	QHash<QString, QColor> x;
	x[QStringLiteral("tint")] = mixc(c("field"), c("accent"), 0.18);       // soft and tinted fills, selected boxed tab
	x[QStringLiteral("focusTint")] = mixc(c("field"), c("accent"), 0.10);  // glow focus fill
	x[QStringLiteral("well")] = mixc(c("field"), black, d.dark ? 0.28 : 0.06); // inset inputs and tracks
	x[QStringLiteral("wellShade")] = mixc(x.value(QStringLiteral("well")), black, 0.35);
	x[QStringLiteral("accentDim")] = mixc(c("border"), c("accent"), 0.45); // framed cards, bracket frames
	x[QStringLiteral("metalHi")] = mixc(c("field"), c("text"), 0.10);      // metal fills: top
	x[QStringLiteral("metalLo")] = mixc(c("field"), black, 0.25);          // metal fills: bottom
	x[QStringLiteral("accentTop")] = mixc(c("accent"), white, 0.12);       // metal primary: top
	x[QStringLiteral("accentBot")] = mixc(c("accent"), black, 0.12);       // metal primary: bottom
	x[QStringLiteral("sphereHi")] = mixc(c("accent"), white, 0.5);         // sphere slider handle light
	return x;
}

// The variant stylesheet fragments (D336): appended after the base stylesheet, so a fragment rule wins over the base
// rule of the same weight. A component the pack leaves out adds nothing (the base look). Tokens as in kQss plus the
// derived colours above and the sizes set here.
QString componentQss(const Data &d, QHash<QString, QString> &t, bool flat)
{
	if (!g_components)
		return {};
	// Rules every pack gets with the flag on, for things that exist only with it: the error state of fields (the
	// specimen shows it; no studio field sets the property yet) and the slider's value bubble.
	const QString errorRule =
		QStringLiteral("QLineEdit[error=\"true\"], QSpinBox[error=\"true\"], QComboBox[error=\"true\"] { border-color: @danger; }\n"
			       "QLabel#valueBubble { background: @text; color: @bg; border-radius: @rs; padding: 2px 6px; font-weight: @hw; }\n");
	if (d.comp.isEmpty() && d.scale.isEmpty())
		return errorRule;
	auto px = [](int v) { return QStringLiteral("%1px").arg(v); };
	const QHash<QString, QColor> x = derived(d);
	for (auto it = x.cbegin(); it != x.cend(); ++it)
		t[it.key()] = it.value().name();
	const int btnH = d.ctl + 2 * d.padY + 2 * d.bw;
	t[QStringLiteral("rbtnPill")] = px(btnH / 2);
	t[QStringLiteral("rsharp")] = px(std::min(d.rs, 2));
	t[QStringLiteral("padYm1")] = px(std::max(0, d.padY - 1));
	t[QStringLiteral("padXm1")] = px(std::max(0, d.padX - 1));
	const auto v = [&](const char *key) { return d.comp.value(QLatin1String(key)); };
	QString q = errorRule;

	// Buttons: shape
	const QString shape = v("button.shape");
	if (shape == QStringLiteral("rounded"))
		q += QStringLiteral("QPushButton { border-radius: @rm; }\n");
	else if (shape == QStringLiteral("pill"))
		q += QStringLiteral("QPushButton { border-radius: @rbtnPill; }\n");
	else if (shape == QStringLiteral("sharp"))
		q += QStringLiteral("QPushButton { border-radius: @rsharp; } QPushButton#round { border-radius: @rsharp; }\n");
	// Buttons: style (primary, plain and round controls)
	const QString style = v("button.style");
	const QString metal = flat ? QStringLiteral("@field")
				   : QStringLiteral("qlineargradient(x1:0, y1:0, x2:0, y2:1, stop:0 @metalHi, stop:0.55 @field, stop:1 @metalLo)");
	const QString metalAccent = flat ? QStringLiteral("@accent") : QStringLiteral("qlineargradient(x1:0, y1:0, x2:0, y2:1, stop:0 @accentTop, stop:1 @accentBot)");
	if (style == QStringLiteral("solid"))
		q += QStringLiteral("QPushButton { background: @field; } QPushButton[role=\"primary\"] { background: @accent; }\n"
				    "QPushButton#round[role=\"primary\"] { background: @accent; }\n");
	else if (style == QStringLiteral("soft"))
		q += QStringLiteral("QPushButton { background: @tint; border-color: @tint; } QPushButton[role=\"primary\"] { background: @accent; border-color: @accent; }\n"
				    "QPushButton#round { background: @tint; border-color: @tint; }\n");
	else if (style == QStringLiteral("metal"))
		q += QStringLiteral("QPushButton { background: %1; border-color: @metalLo; } QPushButton[role=\"primary\"] { background: %2; border-color: @accentBot; }\n"
				    "QPushButton#round { background: %1; border-color: @metalLo; } QPushButton#round[role=\"primary\"] { background: %2; border-color: @accentBot; }\n")
			     .arg(metal, metalAccent);
	else if (style == QStringLiteral("bezel"))
		q += QStringLiteral("QPushButton { border: 2px solid @border; padding: @padYm1 @padXm1; } QPushButton[role=\"primary\"] { border: 2px solid @accentHi; }\n"
				    "QPushButton#round { border: 3px solid @border; } QPushButton#round[role=\"primary\"] { border: 3px solid @accentHi; }\n");
	else if (style == QStringLiteral("neumorph"))
		q += QStringLiteral("QPushButton { background: @bg; border-color: @bg; } QPushButton[role=\"primary\"] { background: @accent; border-color: @accent; }\n"
				    "QPushButton#round { background: @bg; border-color: @bg; }\n");
	// Plain buttons: secondary
	const QString sec = v("button.secondary");
	if (sec == QStringLiteral("outline"))
		q += QStringLiteral("QPushButton { background: transparent; border-color: @accent; color: @accentHi; } QPushButton:hover { background: @tint; }\n");
	else if (sec == QStringLiteral("tinted"))
		q += QStringLiteral("QPushButton { background: @tint; border-color: @tint; color: @accentHi; } QPushButton:hover { border-color: @accentHi; }\n");
	else if (sec == QStringLiteral("ghost"))
		q += QStringLiteral("QPushButton { background: transparent; border-color: transparent; color: @accentHi; } QPushButton:hover { background: @tint; }\n");

	// Tabs
	const QString tabs = v("tabs");
	if (tabs == QStringLiteral("pill"))
		q += QStringLiteral("QTabBar::tab { border-radius: @rbtnPill; }\n");
	else if (tabs == QStringLiteral("underline"))
		q += QStringLiteral("QTabBar::tab { background: transparent; border: none; border-bottom: 2px solid transparent; border-radius: 0; color: @muted; padding: 6px 12px; margin-right: 8px; }\n"
				    "QTabBar::tab:hover:!selected { color: @text; border-bottom-color: @border; }\n"
				    "QTabBar::tab:selected { background: transparent; color: @accentHi; border-bottom: 2px solid @accent; }\n");
	else if (tabs == QStringLiteral("segmented"))
		q += QStringLiteral("QTabBar::tab { margin-right: 0; border-radius: 0; background: @field; }\n"
				    "QTabBar::tab:first { border-top-left-radius: @rm; border-bottom-left-radius: @rm; }\n"
				    "QTabBar::tab:last { border-top-right-radius: @rm; border-bottom-right-radius: @rm; }\n"
				    "QTabBar::tab:only-one { border-radius: @rm; }\n");
	else if (tabs == QStringLiteral("boxed"))
		q += QStringLiteral("QTabBar::tab { background: transparent; border: @bw solid @border; border-radius: @rs; }\n"
				    "QTabBar::tab:selected { background: @tint; color: @accentHi; border: @bw solid @accent; }\n");

	// Inputs
	const QString input = v("input");
	const QString fields = QStringLiteral("QLineEdit, QSpinBox, QDoubleSpinBox, QComboBox");
	if (input == QStringLiteral("filled"))
		q += fields + QStringLiteral(" { background: @field; border: @bw solid transparent; border-bottom: @bw solid @muted; }\n");
	else if (input == QStringLiteral("inset"))
		q += fields + QStringLiteral(" { background: @well; border: @bw solid @border; border-top: 2px solid @wellShade; }\n");
	else if (input == QStringLiteral("underline"))
		q += fields + QStringLiteral(" { background: transparent; border: none; border-bottom: @bw solid @muted; border-radius: 0; padding: 4px 2px; }\n");
	// Focus (inputs and buttons); an underline input keeps its focus on the line
	const QString focus = v("focus");
	const QString focused = QStringLiteral("QLineEdit:focus, QSpinBox:focus, QDoubleSpinBox:focus, QComboBox:focus");
	if (input == QStringLiteral("underline") && !focus.isEmpty())
		q += focused + QStringLiteral(" { border-bottom: 2px solid @accent; }\n");
	else if (focus == QStringLiteral("border"))
		q += focused + QStringLiteral(" { border-color: @accent; }\n");
	else if (focus == QStringLiteral("ring"))
		q += focused + QStringLiteral(" { border: 2px solid @accent; padding: 3px 7px; }\n");
	else if (focus == QStringLiteral("glow"))
		q += focused + QStringLiteral(" { border-color: @accentHi; background: @focusTint; }\n");
	if (focus == QStringLiteral("ring"))
		q += QStringLiteral("QPushButton:focus { border: 2px solid @accent; padding: @padYm1 @padXm1; }\n");
	else if (focus == QStringLiteral("glow"))
		q += QStringLiteral("QPushButton:focus { border-color: @accentHi; }\n");

	// Slider: track and handle (the handle is centred on the track)
	const QString track = v("slider.track"), handle = v("slider.handle");
	if (!track.isEmpty() || !handle.isEmpty()) {
		const int g = (track == QStringLiteral("thick") || track == QStringLiteral("inset")) ? 8 : 4;
		const int hw = handle == QStringLiteral("bar") ? 6 : handle == QStringLiteral("sphere") ? 16 : 14;
		const int hh = handle == QStringLiteral("bar") ? 18 : hw;
		const QString grooveFill = track == QStringLiteral("inset") ? QStringLiteral("@well; border: 1px solid @wellShade") : QStringLiteral("@border");
		q += QStringLiteral("QSlider::groove:horizontal { height: %1px; background: %2; border-radius: %3px; }\n"
				    "QSlider::sub-page:horizontal { background: @accent; border-radius: %3px; }\n")
			     .arg(g)
			     .arg(grooveFill)
			     .arg(g / 2);
		const QString hfill = handle == QStringLiteral("sphere")
					      ? (flat ? QStringLiteral("@accent")
						      : QStringLiteral("qradialgradient(cx:0.35, cy:0.35, radius:0.8, fx:0.35, fy:0.35, stop:0 @sphereHi, stop:1 @accent)"))
					      : QStringLiteral("@text");
		q += QStringLiteral("QSlider::handle:horizontal { background: %1; width: %2px; height: %3px; margin: -%4px 0; border-radius: %5px; }\n")
			     .arg(hfill)
			     .arg(hw)
			     .arg(hh)
			     .arg((hh - g) / 2)
			     .arg(handle == QStringLiteral("bar") ? 2 : hw / 2);
	}

	// Section headers (group titles, headings)
	const QString head = v("sectionHeader");
	if (head == QStringLiteral("rule"))
		q += QStringLiteral("QGroupBox::title { color: @text; border-bottom: 1px solid @accent; padding: 0 4px 2px 4px; }\n"
				    "QLabel#heading { border-bottom: 1px solid @border; padding-bottom: 2px; }\n");
	else if (head == QStringLiteral("caps"))
		q += QStringLiteral("QGroupBox::title { color: @text; } QLabel#heading { color: @text; }\n");
	else if (head == QStringLiteral("bracket"))
		q += QStringLiteral("QGroupBox { border-color: @accentDim; border-radius: @rs; }\n"
				    "QGroupBox::title { left: 10px; border: @bw solid @accent; background: @bg; color: @accentHi; padding: 1px 6px; }\n"
				    "QLabel#heading { color: @accentHi; }\n");

	// Cards (cards, stat cards, group boxes)
	const QString card = v("card");
	const QString cards = QStringLiteral("QFrame#card, QFrame#statCard, QGroupBox");
	if (card == QStringLiteral("flat"))
		q += cards + QStringLiteral(" { background: @panel; border-color: @panel; }\n");
	else if (card == QStringLiteral("neumorph"))
		q += cards + QStringLiteral(" { background: @bg; border-color: @bg; }\n");
	else if (card == QStringLiteral("framed"))
		q += cards + QStringLiteral(" { background: transparent; border: @bw solid @accentDim; border-radius: @rs; }\n");

	// Lists
	if (v("list") == QStringLiteral("plates"))
		q += QStringLiteral("QListWidget::item { background: @field; border: @bw solid @border; border-radius: @rm; margin: 2px 0; padding: 6px 8px; }\n");
	// Chips
	if (v("chip") == QStringLiteral("bracket"))
		q += QStringLiteral("QWidget#taskChip { background: transparent; border-radius: 0; } QLabel#pill { background: transparent; border-radius: 0; }\n");

	// Type scale
	auto pt = [&](const char *k) { return QStringLiteral("%1pt").arg(d.scale.value(QLatin1String(k))); };
	if (d.scale.contains(QStringLiteral("h1")))
		q += QStringLiteral("QLabel#sectionTitle { font-size: %1; }\n").arg(pt("h1"));
	if (d.scale.contains(QStringLiteral("h2")))
		q += QStringLiteral("QLabel#toastTitle, QLabel#lookName { font-size: %1; }\n").arg(pt("h2"));
	if (d.scale.contains(QStringLiteral("subtitle")))
		q += QStringLiteral("QGroupBox::title { font-size: %1; }\n").arg(pt("subtitle"));
	if (d.scale.contains(QStringLiteral("button")))
		q += QStringLiteral("QPushButton { font-size: %1; }\n").arg(pt("button"));
	return q;
}

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
	// High performance: flat fills only (a gradient brush costs more to paint than a solid one).
	const bool flat = g_effects == QStringLiteral("performance");
	t[QStringLiteral("accentFill")] = d.gradAccent.on && !flat ? gradientQss(d.gradAccent) : d.colors.value(QStringLiteral("accent")).name();
	t[QStringLiteral("panelFill")] = d.gradPanel.on && !flat ? gradientQss(d.gradPanel) : d.colors.value(QStringLiteral("panel")).name();
	t[QStringLiteral("controlFill")] = d.gradControl.on && !flat ? gradientQss(d.gradControl) : d.colors.value(QStringLiteral("field")).name();
	t[QStringLiteral("padY")] = px(d.padY);
	t[QStringLiteral("padX")] = px(d.padX);
	static const QRegularExpression re(QStringLiteral("@([A-Za-z0-9]+)"));
	const QString fragment = componentQss(d, t, flat); // D336: variant fragments after the base (fills more tokens)
	auto subst = [&t](const QString &qss) {
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
	};
	const QString base = subst(QString::fromUtf8(kQss)), frag = subst(fragment);
	g_baseStyleHash = QCryptographicHash::hash(base.toUtf8(), QCryptographicHash::Sha256).toHex().left(16);
	g_fragmentLength = int(frag.size());
	return base + frag;
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

void applyAll(QApplication &app);

// The current pack's file changed (or a file appeared in a theme folder): apply a valid new version, keep the look
// on an invalid one. A file that fails to parse less than 300 ms after it was written is retried (still being saved).
void reloadCurrent()
{
	if (!g_cur.valid)
		return;
	const QString p = packFile(g_cur.id);
	if (p.isEmpty())
		return; // embedded pack only, or the file is between delete and rename: the next event retries
	if (g_watch && !g_watch->files().contains(p))
		g_watch->addPath(p); // a save through rename replaced the watched file
	bool ok = false;
	const QByteArray b = readBytes(p, &ok);
	if (!ok)
		return;
	const QByteArray h = hashOf(b);
	if (h == g_fileHash)
		return;
	const QString why = packProblem(b, g_cur.id);
	if (!why.isEmpty()) {
		const qint64 age = QFileInfo(p).lastModified().msecsTo(QDateTime::currentDateTime());
		if (age >= 0 && age < 300) {
			g_reloadTimer->start(300);
			return;
		}
		g_fileHash = h; // reported once per version of the file
		g_rejects++;
		g_lastReject = why;
		qWarning("theme: %s.json not applied, the last good look stays: %s", qPrintable(g_cur.id), qPrintable(why));
		emit notifier()->rejected(QStringLiteral("Theme not applied: the file has a problem"),
					  QStringLiteral("%1.json: %2. The last good look stays.").arg(g_cur.id, why));
		return;
	}
	Data d = load(g_cur.id);
	if (!d.valid)
		return;
	g_fileHash = h;
	g_cur = d;
	g_reloads++;
	qInfo("theme: %s.json changed on disk; applied", qPrintable(g_cur.id));
	applyAll(*qobject_cast<QApplication *>(QCoreApplication::instance()));
}

void startWatch()
{
	if (g_watch)
		return;
	g_watch = new QFileSystemWatcher(qApp);
	g_reloadTimer = new QTimer(qApp);
	g_reloadTimer->setSingleShot(true);
	QObject::connect(g_reloadTimer, &QTimer::timeout, qApp, []() { reloadCurrent(); });
	const auto kick = [](const QString &) { g_reloadTimer->start(200); };
	QObject::connect(g_watch, &QFileSystemWatcher::fileChanged, qApp, kick);
	QObject::connect(g_watch, &QFileSystemWatcher::directoryChanged, qApp, kick);
	for (const QString &dir : searchDirs())
		if (QDir(dir).exists())
			g_watch->addPath(dir);
}

// Density (D336): every layout and widget that took its spacing through theme::space / theme::margins gets it again
// from the built-in value it kept, when the factor changed.
void relayoutDensity()
{
	const qreal f = densityFactor();
	if (std::abs(f - g_appliedDensity) < 0.001)
		return;
	g_appliedDensity = f;
	for (QWidget *top : QApplication::topLevelWidgets()) {
		QList<QObject *> objs;
		for (QLayout *l : top->findChildren<QLayout *>())
			objs << l;
		for (QWidget *w : top->findChildren<QWidget *>())
			objs << w;
		objs << top;
		if (top->layout())
			objs << top->layout();
		for (QObject *o : objs) {
			const QVariant sp = o->property("ujwSpace");
			if (sp.isValid())
				if (auto *l = qobject_cast<QLayout *>(o))
					l->setSpacing(spacing(sp.toInt()));
			const QVariant m = o->property("ujwMargins");
			if (m.isValid()) {
				const QRect r = m.toRect(); // left, top, right, bottom as x, y, width, height
				const QMargins mm(spacing(r.x()), spacing(r.y()), spacing(r.width()), spacing(r.height()));
				if (auto *l = qobject_cast<QLayout *>(o))
					l->setContentsMargins(mm);
				else if (auto *w = qobject_cast<QWidget *>(o))
					w->setContentsMargins(mm);
			}
		}
	}
}

void applyAll(QApplication &app)
{
	applyPalette(app, g_cur);
	applyFont(app, g_cur);
	app.setStyleSheet(buildQss(g_cur));
	relayoutDensity();
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
	loadBundledFonts();
	g_cur = load(id);
	if (!g_cur.valid)
		g_cur = load(kDefaultId);
	if (!g_cur.valid) // the embedded default is missing: Fusion's own look
		return;
	const QString fx = qEnvironmentVariable("UJWALAM_EFFECTS");
	if (fx == QStringLiteral("reduced") || fx == QStringLiteral("full") || fx == QStringLiteral("performance"))
		g_effects = fx;
	applyPalette(app, g_cur);
	applyFont(app, g_cur);
	app.setStyleSheet(buildQss(g_cur));
	startWatch();
	rememberFile(g_cur.id);
}

QString packProblem(const QByteArray &bytes, const QString &id)
{
	QJsonParseError err;
	const QJsonDocument doc = QJsonDocument::fromJson(bytes, &err);
	if (err.error != QJsonParseError::NoError)
		return QStringLiteral("not valid JSON (at character %1)").arg(err.offset);
	if (!doc.isObject())
		return QStringLiteral("not a JSON object");
	const QJsonObject o = doc.object();
	if (o.value(QStringLiteral("id")).toString() != id)
		return QStringLiteral("its id must be %1").arg(id);
	// The parts the schema (data/themes/theme.schema.json) requires.
	for (const char *k : {"name", "topic", "version", "dark", "colors", "typography", "geometry", "depth", "motion", "background", "icons"})
		if (!o.contains(QLatin1String(k)))
			return QStringLiteral("%1 is missing").arg(QLatin1String(k));
	if (!o.value(QStringLiteral("colors")).isObject())
		return QStringLiteral("colors must be an object");
	static const QRegularExpression hex(QStringLiteral("^#[0-9a-fA-F]{6}$"));
	const QJsonObject c = o.value(QStringLiteral("colors")).toObject();
	for (const QString &k : kColorKeys)
		if (!hex.match(c.value(k).toString()).hasMatch())
			return QStringLiteral("colors.%1 must be a colour like #1a2b3c").arg(k);
	return componentsProblem(o); // D336: unknown components or variants are refused
}

const QList<QPair<QString, QStringList>> &componentVariants()
{
	static const QList<QPair<QString, QStringList>> v = {
		{QStringLiteral("button.shape"), {QStringLiteral("rounded"), QStringLiteral("pill"), QStringLiteral("sharp")}},
		{QStringLiteral("button.style"),
		 {QStringLiteral("solid"), QStringLiteral("soft"), QStringLiteral("metal"), QStringLiteral("bezel"), QStringLiteral("neumorph")}},
		{QStringLiteral("button.secondary"), {QStringLiteral("outline"), QStringLiteral("tinted"), QStringLiteral("ghost")}},
		{QStringLiteral("button.caps"), kBool},
		{QStringLiteral("tabs"), {QStringLiteral("pill"), QStringLiteral("underline"), QStringLiteral("segmented"), QStringLiteral("boxed")}},
		{QStringLiteral("input"), {QStringLiteral("outline"), QStringLiteral("filled"), QStringLiteral("inset"), QStringLiteral("underline")}},
		{QStringLiteral("focus"), {QStringLiteral("border"), QStringLiteral("ring"), QStringLiteral("glow")}},
		{QStringLiteral("switch"), {QStringLiteral("plain"), QStringLiteral("labelled"), QStringLiteral("bezel")}},
		{QStringLiteral("slider.track"), {QStringLiteral("thin"), QStringLiteral("thick"), QStringLiteral("inset")}},
		{QStringLiteral("slider.handle"), {QStringLiteral("round"), QStringLiteral("sphere"), QStringLiteral("bar")}},
		{QStringLiteral("slider.valueBubble"), kBool},
		{QStringLiteral("sectionHeader"), {QStringLiteral("plain"), QStringLiteral("rule"), QStringLiteral("caps"), QStringLiteral("bracket")}},
		{QStringLiteral("card"), {QStringLiteral("flat"), QStringLiteral("raised"), QStringLiteral("neumorph"), QStringLiteral("framed")}},
		{QStringLiteral("list"), {QStringLiteral("plain"), QStringLiteral("plates")}},
		{QStringLiteral("chip"), {QStringLiteral("pill"), QStringLiteral("bracket")}},
		{QStringLiteral("density"), {QStringLiteral("compact"), QStringLiteral("normal"), QStringLiteral("airy")}},
	};
	return v;
}

void setComponents(bool on)
{
	if (on == g_components)
		return;
	g_components = on;
	if (!g_cur.valid)
		return;
	const Data d = fromJson(g_cur.src, g_cur.custom); // the accepted pack parsed again with or without its v2 parts
	if (!d.valid)
		return;
	g_cur = d;
	qInfo("theme: components %s", on ? "on" : "off");
	applyAll(*qobject_cast<QApplication *>(QCoreApplication::instance()));
}

bool componentsOn()
{
	return g_components;
}

QString component(const QString &key)
{
	return g_components ? g_cur.comp.value(key) : QString();
}

bool componentFlag(const QString &key)
{
	return component(key) == QStringLiteral("true");
}

Caps caps()
{
	Caps c;
	if (!g_components)
		return c;
	c.button = g_cur.buttonCaps || componentFlag(QStringLiteral("button.caps"));
	c.tab = g_cur.tabCaps;
	c.heading = g_cur.headingCaps || component(QStringLiteral("sectionHeader")) == QStringLiteral("caps");
	return c;
}

qreal densityFactor()
{
	const QString d = component(QStringLiteral("density"));
	return d == QStringLiteral("compact") ? 0.75 : d == QStringLiteral("airy") ? 1.25 : 1.0;
}

int spacing(int basePx)
{
	const qreal f = densityFactor();
	return f == 1.0 ? basePx : int(std::lround(basePx * f));
}

void space(QLayout *l, int basePx)
{
	if (!l)
		return;
	l->setProperty("ujwSpace", basePx);
	l->setSpacing(spacing(basePx));
}

void margins(QLayout *l, int left, int top, int right, int bottom)
{
	if (!l)
		return;
	l->setProperty("ujwMargins", QRect(left, top, right, bottom));
	l->setContentsMargins(spacing(left), spacing(top), spacing(right), spacing(bottom));
}

void margins(QWidget *w, int left, int top, int right, int bottom)
{
	if (!w)
		return;
	w->setProperty("ujwMargins", QRect(left, top, right, bottom));
	w->setContentsMargins(spacing(left), spacing(top), spacing(right), spacing(bottom));
}

bool setCurrent(const QString &id)
{
	if (id == g_cur.id && g_cur.valid)
		return true;
	Data d = load(id);
	if (!d.valid)
		return false;
	g_cur = d;
	rememberFile(id);
	applyAll(*qobject_cast<QApplication *>(QCoreApplication::instance()));
	return true;
}

QString currentId()
{
	return g_cur.id;
}

void setEffects(const QString &mode)
{
	const QString m = (mode == QStringLiteral("reduced") || mode == QStringLiteral("performance")) ? mode : QStringLiteral("full");
	if (m == g_effects)
		return;
	const bool flatChanged = (m == QStringLiteral("performance")) != (g_effects == QStringLiteral("performance"));
	g_effects = m;
	if (flatChanged && g_cur.valid) // gradients on or off: the stylesheet changes
		qobject_cast<QApplication *>(QCoreApplication::instance())->setStyleSheet(buildQss(g_cur));
	motion::dropHover(m == QStringLiteral("performance")); // hover overlays go (and come back) with High performance
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
	return g_effects == QStringLiteral("full");
}

bool performance()
{
	return g_effects == QStringLiteral("performance");
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
		i.muted = d.colors.value(QStringLiteral("muted"));
		i.ok = d.colors.value(QStringLiteral("ok"));
		i.onAccent = d.colors.value(QStringLiteral("onAccent"));
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
	o.insert(QStringLiteral("bundledFamilies"), QJsonArray::fromStringList(g_bundledFamilies));
	o.insert(QStringLiteral("depthWidgets"), depth::count());
	o.insert(QStringLiteral("depthEligible"), depth::eligible());
	o.insert(QStringLiteral("backgroundKind"), g_cur.bg.kind);
	o.insert(QStringLiteral("performance"), performance());
	o.insert(QStringLiteral("hoverOverlays"), motion::hoverCount());
	o.insert(QStringLiteral("gradientsInStyle"), qApp->styleSheet().contains(QStringLiteral("qlineargradient")));
	QJsonArray ids;
	for (const Info &i : available())
		ids.append(i.id);
	o.insert(QStringLiteral("available"), ids);
	o.insert(QStringLiteral("accent"), g_cur.colors.value(QStringLiteral("accent")).name());
	o.insert(QStringLiteral("reloads"), g_reloads); // LU2: applied changes of the pack file
	o.insert(QStringLiteral("rejects"), g_rejects); // LU2: invalid versions kept out
	o.insert(QStringLiteral("lastReject"), g_lastReject);
	// D336: the components flag, the variants the current pack gives (empty = base look), density and caps.
	o.insert(QStringLiteral("componentsOn"), g_components);
	QJsonObject comp;
	for (const auto &kv : componentVariants())
		if (!component(kv.first).isEmpty())
			comp.insert(kv.first, component(kv.first));
	o.insert(QStringLiteral("components"), comp);
	o.insert(QStringLiteral("density"), densityFactor());
	const Caps c = caps();
	o.insert(QStringLiteral("caps"), QJsonObject{{QStringLiteral("button"), c.button}, {QStringLiteral("tab"), c.tab}, {QStringLiteral("heading"), c.heading}});
	o.insert(QStringLiteral("pattern"), g_cur.bg.pattern);
	o.insert(QStringLiteral("frame"), g_cur.bg.frame);
	o.insert(QStringLiteral("baseStyleHash"), g_baseStyleHash);
	o.insert(QStringLiteral("fragmentLength"), g_fragmentLength);
	int v2Depth = 0; // depth classes using a v2 part (highlight, inset or rim)
	for (const DepthSpec &ds : g_cur.depth)
		if (ds.highlight.enabled || ds.inset.enabled || ds.rim.enabled)
			v2Depth++;
	o.insert(QStringLiteral("depthV2Classes"), v2Depth);
	return o;
}

bool probeAction(const QString &action)
{
	if (action.startsWith(QStringLiteral("theme:")))
		return setCurrent(action.mid(6));
	if (action == QStringLiteral("components:on") || action == QStringLiteral("components:off")) { // D336 (tests)
		setComponents(action.endsWith(QStringLiteral("on")));
		return true;
	}
	if (action.startsWith(QStringLiteral("effects:"))) {
		// "effects:a+b" applies a then b in the same event-loop turn (a quick toggle, before deferred deletes run)
		const QStringList modes = action.mid(8).split(QLatin1Char('+'));
		for (const QString &m : modes)
			if (m != QStringLiteral("full") && m != QStringLiteral("reduced") && m != QStringLiteral("performance"))
				return false;
		for (const QString &m : modes)
			setEffects(m);
		return true;
	}
	return false;
}

} // namespace theme
