// SPDX-License-Identifier: GPL-3.0-or-later
#include "soft.h"

#include "motion.h"
#include "switch_widget.h"
#include "theme.h"

#include <QAbstractButton>
#include <QApplication>
#include <QFocusEvent>
#include <QGroupBox>
#include <QHash>
#include <QImage>
#include <QLinearGradient>
#include <QMouseEvent>
#include <QPainter>
#include <QPainterPath>
#include <QPixmap>
#include <QPointer>
#include <QRadialGradient>
#include <QVariantAnimation>
#include <QWidget>

#include <algorithm>
#include <cmath>
#include <vector>

namespace soft {

namespace {

enum Tone { Neutral = 0, Warm = 1, Hot = 2 }; // Hot: a live (active) round control, in the danger colour

QHash<quint64, QPixmap> g_cache;
QHash<QWidget *, class Painter *> g_painters;

// How much of the pack's shadow a kind gets (a small control throws a smaller shadow than a card).
qreal scaleOf(Kind k)
{
	switch (k) {
	case Kind::Card: return 1.0;
	case Kind::Small: return 0.7;
	case Kind::Plate: return 0.6;
	case Kind::Pill: return 0.42;
	case Kind::Round: return 0.6;
	default: return 0;
	}
}

QColor alpha(QColor c, qreal a)
{
	c.setAlphaF(float(std::clamp(a, 0.0, 1.0)));
	return c;
}

// Three box blurs in a row: close to a Gaussian, on the alpha channel only (the picture is built once and cached).
void boxBlur(QImage &a, int r)
{
	if (r < 1)
		return;
	const int w = a.width(), h = a.height(), n = 2 * r + 1;
	std::vector<int> tmp(size_t(std::max(w, h)));
	for (int pass = 0; pass < 3; pass++) {
		for (int y = 0; y < h; y++) {
			uchar *row = a.scanLine(y);
			for (int x = 0; x < w; x++)
				tmp[size_t(x)] = row[x];
			int sum = 0;
			for (int i = -r; i <= r; i++)
				sum += tmp[size_t(std::clamp(i, 0, w - 1))];
			for (int x = 0; x < w; x++) {
				row[x] = uchar(sum / n);
				sum += tmp[size_t(std::min(x + r + 1, w - 1))] - tmp[size_t(std::max(x - r, 0))];
			}
		}
		for (int x = 0; x < w; x++) {
			for (int y = 0; y < h; y++)
				tmp[size_t(y)] = a.scanLine(y)[x];
			int sum = 0;
			for (int i = -r; i <= r; i++)
				sum += tmp[size_t(std::clamp(i, 0, h - 1))];
			for (int y = 0; y < h; y++) {
				a.scanLine(y)[x] = uchar(sum / n);
				sum += tmp[size_t(std::min(y + r + 1, h - 1))] - tmp[size_t(std::max(y - r, 0))];
			}
		}
	}
}

// One shadow layer of a plate into out (premultiplied, device pixels). The layer is fitted into the room around the
// face: a blur that would reach past the widget's edge is cut short there, so it never ends in a hard line.
void layer(QImage &out, const QRectF &plate, qreal radius, const theme::Shadow &s, qreal scale, const QMargins &room, const QColor &color, qreal dpr)
{
	if (!s.enabled || s.opacity <= 0.001 || !color.isValid())
		return;
	const int ox = std::clamp(int(std::lround(s.offsetX * scale)), -room.left(), room.right());
	const int oy = std::clamp(int(std::lround(s.offsetY * scale)), -room.top(), room.bottom());
	int b = int(std::lround(s.blur * scale));
	b = std::min({b, room.left() + std::min(0, ox), room.right() - std::max(0, ox), room.top() + std::min(0, oy), room.bottom() - std::max(0, oy)});
	b = std::max(0, b);
	QImage a(out.size(), QImage::Format_Alpha8);
	a.fill(0);
	{
		QPainter p(&a);
		p.setRenderHint(QPainter::Antialiasing);
		p.scale(dpr, dpr);
		p.setPen(Qt::NoPen);
		p.setBrush(QColor(0, 0, 0, 255));
		// the shape shrinks by half the blur so the soft edge centres on the plate's outline
		const qreal in = b * 0.35;
		p.drawRoundedRect(plate.translated(ox, oy).adjusted(in, in, -in, -in), std::max(0.0, radius - in), std::max(0.0, radius - in));
	}
	boxBlur(a, int(std::lround(b * dpr / 3.0)));
	const int op = int(std::lround(s.opacity * 256));
	const int cr = color.red(), cg = color.green(), cb = color.blue();
	for (int y = 0; y < out.height(); y++) {
		const uchar *src = a.constScanLine(y);
		auto *dst = reinterpret_cast<QRgb *>(out.scanLine(y));
		for (int x = 0; x < out.width(); x++) {
			const int al = (src[x] * op) >> 8;
			if (!al)
				continue;
			const QRgb d = dst[x];
			const int inv = 255 - al;
			dst[x] = qRgba((cr * al + qRed(d) * inv) / 255, (cg * al + qGreen(d) * inv) / 255, (cb * al + qBlue(d) * inv) / 255,
				       al + (qAlpha(d) * inv) / 255);
		}
	}
}

// The shadow picture of a face of corner radius r: a (2r + 4) square plate (its middle 2 px are stretched) with the room around it. slice: where to cut
// the nine pieces (logical px).
const QPixmap &shadowPix(Kind k, int r, Tone tone, qreal dpr, QMargins *slice)
{
	const QMargins rm = room(k);
	*slice = QMargins(rm.left() + r + 1, rm.top() + r + 1, rm.right() + r + 1, rm.bottom() + r + 1); // 2 px of middle to stretch
	const quint64 key = quint64(int(k)) | (quint64(r) << 4) | (quint64(tone) << 16) | (quint64(std::lround(dpr * 100)) << 20);
	auto it = g_cache.constFind(key);
	if (it != g_cache.constEnd())
		return it.value();
	const theme::Surface s = theme::surface();
	const int core = 2 * r + 4;
	const QSize logical(core + rm.left() + rm.right(), core + rm.top() + rm.bottom());
	QImage out(logical * dpr, QImage::Format_ARGB32_Premultiplied);
	out.fill(0);
	const QRectF plate(rm.left(), rm.top(), core, core);
	const qreal sc = scaleOf(k);
	layer(out, plate, r, s.halo, sc, rm, theme::resolve(s.halo.color), dpr);
	theme::Shadow wide = s.shadow;
	if (tone != Neutral)
		wide.opacity *= 0.55; // a lit control throws less grey and more of its own light
	layer(out, plate, r, wide, sc, rm, theme::resolve(wide.color), dpr);
	layer(out, plate, r, s.contact, 1.0, rm, theme::resolve(s.contact.color), dpr);
	if (tone == Warm)
		layer(out, plate, r, s.glowHalo, sc, rm, s.glowColor, dpr);
	else if (tone == Hot)
		layer(out, plate, r, s.glowHalo, sc, rm, theme::color(QStringLiteral("danger")), dpr);
	QPixmap px = QPixmap::fromImage(out);
	px.setDevicePixelRatio(dpr);
	return *g_cache.insert(key, px);
}

// Nine pieces: the corners as they are, the edges and the middle stretched.
void drawNine(QPainter &p, const QRect &t, const QPixmap &px, const QMargins &m)
{
	const qreal d = px.devicePixelRatio();
	const int sw = px.width(), sh = px.height();
	int tx[4] = {t.left(), t.left() + m.left(), t.right() + 1 - m.right(), t.right() + 1};
	int ty[4] = {t.top(), t.top() + m.top(), t.bottom() + 1 - m.bottom(), t.bottom() + 1};
	if (tx[2] < tx[1])
		tx[1] = tx[2] = (tx[1] + tx[2]) / 2;
	if (ty[2] < ty[1])
		ty[1] = ty[2] = (ty[1] + ty[2]) / 2;
	const int sx[4] = {0, int(std::lround(m.left() * d)), sw - int(std::lround(m.right() * d)), sw};
	const int sy[4] = {0, int(std::lround(m.top() * d)), sh - int(std::lround(m.bottom() * d)), sh};
	for (int j = 0; j < 3; j++)
		for (int i = 0; i < 3; i++) {
			const QRectF dst(tx[i], ty[j], tx[i + 1] - tx[i], ty[j + 1] - ty[j]);
			const QRectF src(sx[i], sy[j], sx[i + 1] - sx[i], sy[j + 1] - sy[j]);
			if (dst.width() > 0 && dst.height() > 0 && src.width() > 0 && src.height() > 0)
				p.drawPixmap(dst, px, src);
		}
}

class Painter : public QObject {
public:
	Painter(QWidget *w, Kind k) : QObject(w), w_(w), kind_(k)
	{
		g_painters.insert(w, this);
		w->installEventFilter(this);
		applyRoom();
	}
	~Painter() override
	{
		g_painters.remove(w_);
		for (QPointer<QVariantAnimation> *slot : {&hoverAnim_, &pressAnim_})
			if (*slot) {
				(*slot)->stop();
				(*slot)->deleteLater();
			}
	}

	// A plate has no stylesheet margin: its room comes as contents margins, given back when the look has no surfaces.
	void applyRoom()
	{
		if (kind_ != Kind::Plate)
			return;
		if (theme::surface().on) {
			if (!roomSet_) {
				oldMargins_ = w_->contentsMargins();
				roomSet_ = true;
			}
			w_->setContentsMargins(room(kind_) + QMargins(16, 10, 16, 10));
		} else if (roomSet_) {
			w_->setContentsMargins(oldMargins_);
			roomSet_ = false;
		}
	}

	bool eventFilter(QObject *o, QEvent *e) override
	{
		if (o != w_)
			return false;
		const bool interactive = kind_ == Kind::Pill || kind_ == Kind::Round;
		switch (e->type()) {
		case QEvent::Paint:
			if (theme::surface().on)
				paint();
			break;
		case QEvent::Enter:
			if (interactive && w_->isEnabled())
				to(hover_, 1.0, hoverAnim_);
			break;
		case QEvent::Leave:
		case QEvent::Hide:
		case QEvent::EnabledChange:
			if (interactive) {
				to(hover_, 0.0, hoverAnim_);
				to(press_, 0.0, pressAnim_);
			}
			break;
		case QEvent::MouseButtonPress:
			if (interactive && w_->isEnabled() && static_cast<QMouseEvent *>(e)->button() == Qt::LeftButton)
				to(press_, 1.0, pressAnim_);
			break;
		case QEvent::MouseButtonRelease:
			if (interactive)
				to(press_, 0.0, pressAnim_);
			break;
		case QEvent::FocusIn:
			ring_ = static_cast<QFocusEvent *>(e)->reason() != Qt::MouseFocusReason; // a ring for keyboard focus only
			break;
		case QEvent::FocusOut:
			ring_ = false;
			break;
		default:
			break;
		}
		return false;
	}

	Kind kind_;

private:
	void to(qreal &v, qreal target, QPointer<QVariantAnimation> &slot)
	{
		if (qFuzzyCompare(v + 1.0, target + 1.0))
			return;
		if (slot)
			slot->stop();
		qreal *vp = &v;
		QPointer<QWidget> w(w_);
		slot = motion::run(w_, v, target, theme::duration(QStringLiteral("fast")), theme::easing(), [vp, w](const QVariant &x) {
			*vp = x.toReal();
			if (w)
				w->update();
		});
	}

	void paint()
	{
		const theme::Surface s = theme::surface();
		const QMargins rm = room(kind_);
		QRectF f = QRectF(w_->rect()).marginsRemoved(QMarginsF(rm));
		if (f.width() < 4 || f.height() < 4)
			return;
		if (kind_ == Kind::Round) {
			const qreal d = std::min(f.width(), f.height());
			f = QRectF(f.center().x() - d / 2, f.center().y() - d / 2, d, d);
		}
		qreal r = kind_ == Kind::Card ? s.cardRadius : (kind_ == Kind::Small || kind_ == Kind::Plate) ? s.plateRadius : f.height() / 2;
		r = std::min({r, f.height() / 2, f.width() / 2});
		const bool perf = theme::performance(), shadows = theme::effects() == QStringLiteral("full");
		auto *btn = qobject_cast<QAbstractButton *>(w_);
		const bool enabled = w_->isEnabled();
		const QString role = w_->property("role").toString();
		Tone tone = Neutral;
		bool primary = false, warmFace = false, hot = false;
		if (btn && enabled) {
			if (kind_ == Kind::Round && w_->property("active").toBool() && (role == QStringLiteral("primary") || role == QStringLiteral("danger")))
				hot = true, tone = Hot;
			else if (role == QStringLiteral("primary"))
				primary = true, tone = Warm;
			else if (btn->isChecked())
				warmFace = true, tone = Warm;
		}
		// A row whose switch is on glows from the knob (as far as the knob has travelled).
		qreal glow = 0;
		QPointF knob;
		if (kind_ == Kind::Plate)
			for (QObject *c : w_->children())
				if (auto *sw = dynamic_cast<Switch *>(c); sw && sw->isVisible()) {
					glow = sw->isEnabled() ? sw->knobPos() : 0;
					knob = sw->mapTo(w_, sw->knobCenter().toPoint());
					break;
				}

		QPainter p(w_);
		p.setRenderHint(QPainter::Antialiasing);
		if (!enabled)
			p.setOpacity(0.6);
		if (shadows) {
			QMargins sl;
			const int rp = std::max(0, int(std::floor(std::min({r, (f.height() - 4) / 2, (f.width() - 4) / 2}))));
			const QPixmap &px = shadowPix(kind_, rp, tone, w_->devicePixelRatioF(), &sl);
			const QRect t(int(std::lround(f.left())) - rm.left(), int(std::lround(f.top())) - rm.top(), int(std::lround(f.width())) + rm.left() + rm.right(),
				      int(std::lround(f.height())) + rm.top() + rm.bottom());
			drawNine(p, t, px, sl);
			if (glow > 0.01) { // the warm light past the plate's edge, around the knob only
				QRadialGradient g(knob, f.height() * 1.35);
				g.setColorAt(0, alpha(s.glowColor, 0.5 * glow));
				g.setColorAt(0.5, alpha(s.glowColor, 0.16 * glow));
				g.setColorAt(1, alpha(s.glowColor, 0));
				p.fillRect(w_->rect(), g);
			}
		}

		QPainterPath path;
		path.addRoundedRect(f, r, r);
		QColor top = s.faceTop, bot = s.faceBottom;
		if (hot)
			top = theme::color(QStringLiteral("danger")), bot = top.darker(118);
		else if (primary)
			top = theme::color(QStringLiteral("accent")), bot = theme::color(QStringLiteral("accentHi"));
		else if (warmFace)
			top = s.warmTop, bot = s.warmBottom;
		if (primary || hot) { // a lit face only gets deeper (its white label keeps its contrast)
			top = motion::mix(top, bot, 0.45 * hover_ + 0.5 * press_);
			bot = motion::mix(bot, bot.darker(112), press_);
		} else {
			top = motion::mix(top, s.edgeLight, 0.75 * hover_);
			top = motion::mix(top, s.wellTop, press_);
			bot = motion::mix(bot, s.wellBottom, press_);
		}
		if (perf) { // High performance: a flat face and a plain edge
			p.fillPath(path, motion::mix(top, bot, 0.5));
			p.setPen(QPen(s.edgeDark, 1));
			p.setBrush(Qt::NoBrush);
			p.drawPath(path);
			paintRing(p, f, r);
			return;
		}
		QLinearGradient lg(f.topLeft(), f.bottomLeft());
		lg.setColorAt(0, top);
		lg.setColorAt(1, bot);
		p.fillPath(path, lg);

		if (warmFace || glow > 0.01) {
			p.save();
			p.setClipPath(path);
			if (warmFace) { // lit from inside, brightest just above the middle
				QRadialGradient g(QPointF(f.center().x(), f.top() + f.height() * 0.4), std::max(f.width(), f.height()) * 0.6);
				g.setColorAt(0, alpha(s.glowCore, 0.9));
				g.setColorAt(1, alpha(s.glowCore, 0));
				p.fillRect(f, g);
			}
			if (glow > 0.01) {
				QRadialGradient g(knob, f.height() * 1.7);
				g.setColorAt(0, alpha(s.glowCore, 0.95 * glow));
				g.setColorAt(0.16, alpha(s.glowCore, 0.75 * glow));
				g.setColorAt(0.3, alpha(s.glowColor, 0.42 * glow));
				g.setColorAt(0.6, alpha(s.glowColor, 0.12 * glow));
				g.setColorAt(1, alpha(s.glowColor, 0));
				p.fillRect(f, g);
			}
			p.restore();
		}

		// The edge: light along the top, fading out, then the plate's darker thickness along the bottom.
		QLinearGradient eg(f.topLeft(), f.bottomLeft());
		const QColor lightEdge = (primary || hot) ? alpha(top.lighter(135), 0.8) : alpha(s.edgeLight, 1.0);
		// hover warms the bottom edge of a plain control (the face itself is near white already)
		const QColor darkEdge = (primary || hot) ? alpha(bot.darker(125), 0.9)
					: warmFace       ? alpha(s.warmEdge, 0.9)
							 : alpha(motion::mix(s.edgeDark, s.warmEdge, 0.8 * hover_), 0.85 + 0.15 * hover_);
		eg.setColorAt(0, lightEdge);
		eg.setColorAt(std::min(0.45, 10.0 / f.height()), alpha(lightEdge, 0));
		eg.setColorAt(std::max(0.55, 1.0 - 10.0 / f.height()), alpha(darkEdge, 0));
		eg.setColorAt(1, darkEdge);
		p.setPen(QPen(QBrush(eg), 1));
		p.setBrush(Qt::NoBrush);
		p.drawRoundedRect(f.adjusted(0.5, 0.5, -0.5, -0.5), std::max(0.0, r - 0.5), std::max(0.0, r - 0.5));
		paintRing(p, f, r);
	}

	void paintRing(QPainter &p, const QRectF &f, qreal r)
	{
		if (!ring_ || !w_->hasFocus())
			return;
		p.setBrush(Qt::NoBrush);
		p.setPen(QPen(theme::color(QStringLiteral("accent")), 2));
		p.drawRoundedRect(f.adjusted(1, 1, -1, -1), std::max(0.0, r - 1), std::max(0.0, r - 1));
	}

	QWidget *w_;
	qreal hover_ = 0, press_ = 0;
	bool ring_ = false;
	QPointer<QVariantAnimation> hoverAnim_, pressAnim_;
	QMargins oldMargins_;
	bool roomSet_ = false;
};

} // namespace

Kind kindOf(const QWidget *w)
{
	if (!w || w->isWindow() || w->property("noSoft").toBool())
		return Kind::None;
	const QString n = w->objectName();
	if (qobject_cast<const QGroupBox *>(w))
		return Kind::Card;
	if (w->inherits("QPushButton")) {
		if (n == QStringLiteral("round"))
			return Kind::Round;
		if (n == QStringLiteral("tb") || n == QStringLiteral("taskClose"))
			return Kind::None;
		return Kind::Pill;
	}
	if (w->inherits("QFrame")) {
		if (n == QStringLiteral("card"))
			return Kind::Card;
		if (n == QStringLiteral("strip") || n == QStringLiteral("statCard") || n == QStringLiteral("lookCard"))
			return Kind::Small;
		return Kind::None;
	}
	if (w->metaObject() == &QWidget::staticMetaObject) // a plain row widget that holds a switch: a plate
		for (QObject *c : w->children())
			if (dynamic_cast<Switch *>(c))
				return Kind::Plate;
	return Kind::None;
}

QMargins room(Kind k)
{
	const theme::Surface s = theme::surface();
	switch (k) {
	case Kind::Card: return {s.marginX, s.marginTop, s.marginX, s.marginBottom};
	case Kind::Small:
	case Kind::Plate: return {s.marginX * 2 / 3, s.marginTop * 2 / 3, s.marginX * 2 / 3, s.marginBottom * 2 / 3};
	case Kind::Pill: return {std::max(2, s.marginX / 3), std::max(2, s.marginTop / 3), std::max(2, s.marginX / 3), std::max(3, s.marginBottom * 2 / 5)};
	case Kind::Round: return {std::max(3, s.marginX / 2), std::max(2, s.marginTop / 2), std::max(3, s.marginX / 2), std::max(4, s.marginBottom / 2)};
	default: return {};
	}
}

void attach(QWidget *w)
{
	if (!w)
		return;
	if (Painter *p = g_painters.value(w)) {
		p->applyRoom();
		return;
	}
	if (!theme::surface().on)
		return;
	const Kind k = kindOf(w);
	if (k != Kind::None)
		new Painter(w, k);
}

void refreshAll()
{
	g_cache.clear();
	const auto all = QApplication::allWidgets();
	for (QWidget *w : all)
		attach(w);
	for (auto it = g_painters.cbegin(); it != g_painters.cend(); ++it)
		it.key()->update();
}

bool owns(const QWidget *w)
{
	return w && g_painters.contains(const_cast<QWidget *>(w)) && theme::surface().on;
}

int count()
{
	return theme::surface().on ? int(g_painters.size()) : 0;
}

int cached()
{
	return int(g_cache.size());
}

void dropCache()
{
	g_cache.clear();
}

} // namespace soft
