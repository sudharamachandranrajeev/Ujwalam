// SPDX-License-Identifier: GPL-3.0-or-later
// Studio themes (D285, D293): the whole look of the shell as data. A theme pack is data/themes/<id>.json (schema
// data/themes/theme.schema.json): colour tokens, type, geometry, depth (shadow, glow, extrusion per element class),
// motion, background and icon weight. The built-in packs are embedded in the exe; a file with the same id in
// UJWALAM_THEMES_DIR, <exe>/themes, <app data>/themes or the repo's data/themes replaces the embedded one, and a new id
// there is a custom theme. A pack may leave any part out: it falls back to Violet Night (the embedded default).
//
// Use from code:
//   theme::color("accent")      a colour token: bg panel field border text muted accent accentHi danger ok onAccent disabled
//   theme::hex("accent")        the same as "#rrggbb" for stylesheets
//   theme::radius(theme::Radius::Medium)   corner radius in px from the pack (Small, Medium, Large)
//   theme::depth(widget, "card")           give a widget a depth class: card button primaryButton roundControl toast menu taskPanel
// Switching: theme::setCurrent(id) re-applies palette, font, stylesheet, depth effects and icons to every open widget.
#pragma once

#include <QColor>
#include <QEasingCurve>
#include <QJsonObject>
#include <QList>
#include <QObject>
#include <QString>
#include <QStringList>

class QApplication;
class QWidget;

namespace theme {

enum class Radius { Small, Medium, Large };

// Depth of one element class (see the schema). A part with enabled == false is off.
struct Shadow {
	bool enabled = false;
	int blur = 0, offsetX = 0, offsetY = 0;
	QString color; // hex or token
	qreal opacity = 0;
};
struct Glow {
	bool enabled = false;
	int blur = 0;
	QString color; // hex, token or "auto"
	qreal opacity = 0;
	QString when; // always | active | hover | focus
};
struct Extrusion {
	bool enabled = false;
	int depth = 0;
	QString color, color2; // hex or token; color2 empty = one colour
};
struct DepthSpec {
	Shadow shadow;
	Glow glow;
	Extrusion extrusion;
	bool any() const { return shadow.enabled || glow.enabled || extrusion.enabled; }
};

struct Info {
	QString id, name, topic;
	bool dark = true;
	bool custom = false; // not one of the embedded packs
	QColor bg, panel, field, border, text, muted, accent, accentHi, danger, ok, onAccent;
	QColor gradFrom, gradTo; // accent gradient ends
	int radiusSmall = 6, radiusMedium = 8, radiusLarge = 16;
	QString family;
	bool glow = false, extrusion = false;
};

// Start: reads the pack named by UJWALAM_THEME, else "violet-night", and applies it. Call once before any widget exists.
void apply(QApplication &app);
// Switch live. false (and nothing changes) when the id is unknown. Unknown ids fall back to violet-night only at start.
bool setCurrent(const QString &id);
QString currentId();
QList<Info> available();

// "full" (depth effects as the pack says), "reduced" (no depth effects) or "performance" (High performance, 2026-11-10:
// no depth effects, no gradients or backdrop pattern, no hover overlays and no animation: flat fills, the cheapest
// paint and the fewest cached pictures). Any theme can run in any mode.
void setEffects(const QString &mode);
QString effects();
bool effectsOn();
bool performance();

QColor color(const QString &token);
QString hex(const QString &token);
QColor resolve(const QString &ref, bool active = false); // hex | token | auto (accent, danger when active)
int radius(Radius size);
int roundSize();
int spacing(Radius size);
int borderWidth();
qreal iconStroke();

// Motion from the pack.
int duration(const QString &which); // fast | normal | slow, in ms
QEasingCurve::Type easing();
qreal hoverLift();
qreal pressSink();

DepthSpec depthSpec(const QString &cls);
int depthRadius(const QString &cls, const QSize &widget); // the corner radius the stylesheet gives that class

// Background drawn by Qt behind the windows (see interaction.cpp).
struct Background {
	QString kind, pattern; // kind: solid | gradient | pattern
	QColor patternColor, from, to;
	qreal patternOpacity = 0;
	int patternSpacing = 24, angle = 90;
};
Background background();

// Caption text (headings, stat names, control captions): size, spacing and caps from the pack.
struct Caption {
	qreal pointSize = 8, spacing = 0;
	bool caps = false;
	int weight = 600;
};
Caption caption();

// Gives the widget a depth class (property "depth") and attaches or refreshes its effect. cls empty removes it.
void depth(QWidget *w, const QString &cls);

// Emits changed() after a switch (theme, effects). Widgets that colour themselves in paintEvent just update().
// LU2 (D324): the current pack file reloads when it changes on disk (directory watch, debounced). A valid file applies
// at once (changed()); an invalid one keeps the last good look and emits rejected() with the reason (the window shows
// it as a notification) plus a warning line in the log.
class Notifier : public QObject {
	Q_OBJECT
signals:
	void changed();
	void rejected(const QString &title, const QString &why);
};
Notifier *notifier();

// Problems with a theme pack file's text for the given id (JSON, id, required parts, colour tokens); empty = usable.
QString packProblem(const QByteArray &bytes, const QString &id);

// Probe (tests): applied theme id, effects mode, the font Qt really picked, counts, accent, reloads and rejections.
QJsonObject probe();
bool probeAction(const QString &action); // theme:<id> | effects:<full|reduced>

} // namespace theme
