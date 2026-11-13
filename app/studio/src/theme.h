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
class QLayout;
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
// Schema v2 (D336, flag theme-components): an inner shadow and a gradient rim with an optional inner glow edge.
struct Inset {
	bool enabled = false;
	int blur = 0, offsetX = 0, offsetY = 0;
	QString color;
	qreal opacity = 0;
	bool pressedOnly = false; // when = pressed
};
struct Rim {
	bool enabled = false;
	QString from, to; // hex or token
	int width = 1;
	bool glow = false; // innerGlow
	QString glowColor;
	qreal glowOpacity = 0;
	int glowWidth = 1;
};
struct DepthSpec {
	Shadow shadow;
	Shadow highlight; // v2: a second, light shadow (neumorphic plates)
	Glow glow;
	Extrusion extrusion;
	Inset inset;      // v2
	Rim rim;          // v2
	bool any() const { return shadow.enabled || highlight.enabled || glow.enabled || extrusion.enabled || inset.enabled || rim.enabled; }
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
	QString kind, pattern; // kind: solid | gradient | pattern; pattern v2 adds blueprint | columns
	QColor patternColor, from, to;
	qreal patternOpacity = 0;
	int patternSpacing = 24, angle = 90;
	bool frame = false, frameTicks = false; // v2: the outer frame with registration ticks
	qreal frameOpacity = 0;
};
Background background();

// Soft surfaces (D376, pack block "surface", used by the variants card "soft", button.style "raised", switch "knob",
// input "soft"): raised plates painted by soft.cpp from cached pictures (no QGraphicsEffect), sunken wells, and the warm
// glow of active controls. on is false when the pack has no surface block or its card variant is not "soft".
struct Surface {
	bool on = false;
	QColor faceTop, faceBottom;   // the face of a raised plate: top and bottom of its gradient
	QColor edgeLight, edgeDark;   // 1 px light edge along the top, darker edge (the plate's thickness) along the bottom
	QColor wellTop, wellBottom;   // sunken wells: switch tracks, fields, pressed faces
	QColor warmTop, warmBottom, warmEdge; // an active (checked) control's face: lit from inside
	QColor glowCore, glowColor;   // the warm glow: its bright centre and its amber body
	QColor glowInk;               // text and marks on a warm face
	Shadow shadow, contact, halo; // wide soft shadow below, tight contact shadow, light halo up-left
	Shadow glowHalo;              // the warm light an active control throws past its edge
	int cardRadius = 22, plateRadius = 18;
	int marginX = 8, marginTop = 5, marginBottom = 13; // room around a card for its shadow (the stylesheet's margin)
};
Surface surface();

// Text hinting from the pack (typography.hinting: default | none | vertical | full, D376). "full" keeps the glyph
// stems on the pixel grid (DirectWrite GDI-classic ClearType) at every display scale.
QString hinting();

// Caption text (headings, stat names, control captions): size, spacing and caps from the pack.
struct Caption {
	qreal pointSize = 8, spacing = 0;
	bool caps = false;
	int weight = 600;
};
Caption caption();

// ---- Theme components (schema v2, D336, flag theme-components) ----
// The flag (Settings > Advanced / control page) switches the components block, depth highlight / inset / rim, caps,
// the type scale, the blueprint and columns patterns and the frame on or off; off, every pack draws the base look.
void setComponents(bool on); // re-applies the current pack when the value changes
bool componentsOn();
// The variant the current pack gives a component, or empty for the base look (flag off, or the key left out):
//   button.shape button.style button.secondary tabs input focus switch slider.track slider.handle sectionHeader card
//   list chip density
QString component(const QString &key);
// Boolean parts: button.caps slider.valueBubble (false when the flag is off or the key is left out).
bool componentFlag(const QString &key);
// Every component key and its allowed variants (packProblem, the specimen page and the probe use it).
const QList<QPair<QString, QStringList>> &componentVariants();

// Caps from the pack (typography buttonCaps / tabCaps / headingCaps, components.button.caps, sectionHeader caps).
struct Caps {
	bool button = false, tab = false, heading = false;
};
Caps caps();

// Density (components.density): compact x0.75, normal x1, airy x1.25. spacing(px) scales one built-in spacing value;
// space() / margins() set it on a layout or widget and remember the built-in value, so a theme switch re-applies it.
qreal densityFactor();
int spacing(int basePx);
void space(QLayout *l, int basePx);
void margins(QLayout *l, int left, int top, int right, int bottom);
void margins(QWidget *w, int left, int top, int right, int bottom);

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
bool probeAction(const QString &action); // theme:<id> | effects:<full|reduced|performance> | components:<on|off>

} // namespace theme
