// SPDX-License-Identifier: GPL-3.0-or-later
#include "qml_bridge.h"
#include "api_client.h"
#include "icons.h"
#include "motion.h"
#include "theme.h"

#include <QClipboard>
#include <QFileDialog>
#include <QGuiApplication>
#include <QJSEngine>
#include <QJsonDocument>
#include <QPainter>
#include <QQuickWindow>
#include <algorithm>
#include <cmath>
#include <cstdio>

// ---- Api ----

QmlApi::QmlApi(ApiClient *api, QJSEngine *engine, QObject *parent) : QObject(parent), api_(api), engine_(engine) {}

// Counted down after the callback, so a request the callback sends next keeps the count above 0 in between.
void QmlApi::reply(QJSValue done, bool ok, const QJsonObject &body, const QString &err)
{
	if (done.isCallable()) {
		const QJSValue r = done.call({QJSValue(ok), engine_->toScriptValue(body), QJSValue(err)});
		if (r.isError())
			qWarning("qml: callback error: %s", qPrintable(r.toString()));
	}
	inFlight_--;
}

static QJsonObject toObject(const QJSValue &v)
{
	if (!v.isObject())
		return {};
	return QJsonObject::fromVariantMap(v.toVariant(QJSValue::ConvertJSObjects).toMap());
}

void QmlApi::get(const QString &route, const QJSValue &done)
{
	inFlight_++;
	api_->get(route, [this, done](bool ok, const QJsonObject &b, const QString &e) { reply(done, ok, b, e); });
}

void QmlApi::post(const QString &route, const QJSValue &body, const QJSValue &done)
{
	inFlight_++;
	api_->post(route, toObject(body), [this, done](bool ok, const QJsonObject &b, const QString &e) { reply(done, ok, b, e); });
}

void QmlApi::host(const QString &method, const QJSValue &params, const QJSValue &done)
{
	inFlight_++;
	api_->host(method, toObject(params), [this, done](bool ok, const QJsonObject &b, const QString &e) { reply(done, ok, b, e); });
}

void QmlApi::log(const QString &line)
{
	std::printf("%s\n", qUtf8Printable(line.left(2000)));
	std::fflush(stdout);
}

QString QmlApi::chooseFolder(const QString &title, const QString &start) const
{
	return QFileDialog::getExistingDirectory(nullptr, title, start);
}

void QmlApi::copyText(const QString &text) const
{
	QGuiApplication::clipboard()->setText(text);
}

// ---- Theme ----

QmlTheme::QmlTheme(QObject *parent) : QObject(parent)
{
	connect(theme::notifier(), &theme::Notifier::changed, this, &QmlTheme::changed);
}

QString QmlTheme::id() const { return theme::currentId(); }

bool QmlTheme::dark() const
{
	for (const theme::Info &i : theme::available())
		if (i.id == theme::currentId())
			return i.dark;
	return true;
}

QVariantMap QmlTheme::colors() const
{
	QVariantMap m;
	for (const char *t : {"bg", "panel", "field", "border", "text", "muted", "accent", "accentHi", "danger", "ok", "onAccent", "disabled"})
		m.insert(QLatin1String(t), theme::color(QLatin1String(t)));
	return m;
}

QString QmlTheme::family() const
{
	for (const theme::Info &i : theme::available())
		if (i.id == theme::currentId())
			return i.family;
	return QStringLiteral("Inter");
}

int QmlTheme::radiusSmall() const { return theme::radius(theme::Radius::Small); }
int QmlTheme::radiusMedium() const { return theme::radius(theme::Radius::Medium); }
int QmlTheme::radiusLarge() const { return theme::radius(theme::Radius::Large); }
int QmlTheme::fast() const { return theme::duration(QStringLiteral("fast")); }
int QmlTheme::normal() const { return theme::duration(QStringLiteral("normal")); }
// Animations run unless High performance is on, or the user's choice (Settings > Appearance > Animations), the Windows
// setting or UJWALAM_REDUCE_MOTION says no (motion::systemAnimations, the widget studio's rule).
bool QmlTheme::motion() const { return !theme::performance() && motion::systemAnimations(); }

QString QmlTheme::icon(const QString &name, const QString &token, int px) const
{
	const QColor c = token.startsWith(QLatin1Char('#')) ? QColor(token) : theme::color(token);
	return QStringLiteral("image://icon/%1/%2/%3").arg(name, c.name().mid(1)).arg(std::clamp(px, 8, 64));
}

bool QmlTheme::setCurrent(const QString &id) { return theme::setCurrent(id); }
void QmlTheme::setEffects(const QString &mode) { theme::setEffects(mode); }

QVariantList QmlTheme::themes() const
{
	QVariantList out;
	for (const theme::Info &i : theme::available())
		out.append(QVariantMap{{QStringLiteral("id"), i.id}, {QStringLiteral("name"), i.name}, {QStringLiteral("topic"), i.topic},
				       {QStringLiteral("dark"), i.dark}, {QStringLiteral("accent"), i.accent.name()}, {QStringLiteral("bg"), i.bg.name()},
				       {QStringLiteral("panel"), i.panel.name()}, {QStringLiteral("text"), i.text.name()}});
	return out;
}

QString QmlTheme::effects() const { return theme::effects(); }

void QmlTheme::setMotionMode(const QString &mode)
{
	motion::setMode(mode);
	emit changed();
}

QString QmlTheme::motionMode() const { return motion::mode(); }

// ---- Icons ----

IconProvider::IconProvider() : QQuickImageProvider(QQuickImageProvider::Pixmap) {}

QPixmap IconProvider::requestPixmap(const QString &id, QSize *size, const QSize &)
{
	const QStringList p = id.split(QLatin1Char('/'));
	const QString name = p.value(0);
	const QColor c(QLatin1Char('#') + p.value(1));
	const int px = std::clamp(p.value(2).toInt(), 8, 64);
	QPixmap pm = icons::picture(name, c.isValid() ? c : QColor(Qt::white), px);
	if (size)
		*size = QSize(px, px);
	return pm;
}

// ---- Previews ----

namespace {
ApiClient *g_api = nullptr;
}

PreviewSurface::PreviewSurface(QWindow *parent) : QRasterWindow(parent) {}

void PreviewSurface::paintEvent(QPaintEvent *)
{
	QPainter p(this);
	p.fillRect(QRect(QPoint(0, 0), size()), QColor(10, 9, 14)); // the preview surface stays dark in every theme
}

void PreviewView::setApi(ApiClient *api) { g_api = api; }

PreviewView::PreviewView(QQuickItem *parent) : QQuickItem(parent)
{
	setFlag(ItemHasContents, false);
	debounce_.setSingleShot(true);
	debounce_.setInterval(150);
	connect(&debounce_, &QTimer::timeout, this, &PreviewView::embed);
	// A move of an ancestor (a panel resized, the window laid out again) moves this item without a geometryChange of
	// its own: check the placement a few times a second.
	track_.setInterval(250);
	connect(&track_, &QTimer::timeout, this, &PreviewView::place);
	setMessage(QStringLiteral("Preview loading..."));
}

PreviewView::~PreviewView()
{
	delete surface_; // the host drops a preview whose parent window is gone
}

void PreviewView::setCanvas(const QString &c)
{
	if (c == canvas_)
		return;
	canvas_ = c;
	emit canvasChanged();
	schedule();
}

void PreviewView::setMessage(const QString &m)
{
	if (m == message_)
		return;
	message_ = m;
	emit messageChanged();
}

void PreviewView::geometryChange(const QRectF &now, const QRectF &before)
{
	QQuickItem::geometryChange(now, before);
	place();
}

void PreviewView::itemChange(ItemChange change, const ItemChangeData &value)
{
	QQuickItem::itemChange(change, value);
	if (change == ItemSceneChange) {
		delete surface_;
		embedded_ = false;
		if (value.window) {
			surface_ = new PreviewSurface(value.window);
			track_.start();
		} else {
			track_.stop();
		}
		placed_ = QRect();
		place();
	} else if (change == ItemVisibleHasChanged) {
		place();
	} else if (change == ItemDevicePixelRatioHasChanged) {
		// Moved to a display with another scale (Codex review of Q2): the same logical rectangle is a new pixel size,
		// so embed() sends preview.open again (it compares the pixel size it last sent).
		schedule();
	}
}

void PreviewView::place()
{
	if (!surface_)
		return;
	const QRect r = mapRectToScene(boundingRect()).toAlignedRect();
	// Shown while a preview.open is on its way too: the host checks the parent window during that call.
	const bool show = isVisible() && r.width() > 0 && r.height() > 0 && (embedded_ || busy_);
	if (r != placed_) {
		placed_ = r;
		surface_->setGeometry(r);
		schedule();
	}
	if (surface_->isVisible() != show)
		surface_->setVisible(show);
}

void PreviewView::schedule() { debounce_.start(); }

void PreviewView::reembed()
{
	embedded_ = false;
	sent_ = QSize();
	schedule();
}

void PreviewView::embed()
{
	if (!g_api || !surface_ || canvas_.isEmpty() || !window())
		return;
	if (busy_) {
		again_ = true;
		return;
	}
	const qreal dpr = window()->devicePixelRatio();
	const int w = (int)std::lround(width() * dpr), h = (int)std::lround(height() * dpr);
	if (w < 160 || h < 90) {
		surface_->setVisible(false);
		return setMessage(QStringLiteral("Make this area larger to show the preview."));
	}
	if (embedded_ && sent_ == QSize(w, h))
		return; // placed again, same size: the host's window moved with its parent
	surface_->setGeometry(placed_);
	surface_->setVisible(true); // the host refuses a parent that is not a real window yet
	QJsonObject p;
	p.insert(QStringLiteral("canvas"), canvas_);
	p.insert(QStringLiteral("parent"), QString::number((qulonglong)surface_->winId()));
	p.insert(QStringLiteral("x"), 0);
	p.insert(QStringLiteral("y"), 0);
	p.insert(QStringLiteral("width"), w);
	p.insert(QStringLiteral("height"), h);
	busy_ = true;
	QPointer<PreviewView> self(this);
	g_api->host(QStringLiteral("preview.open"), p, [self, w, h](bool ok, const QJsonObject &b, const QString &err) {
		if (!self)
			return;
		self->busy_ = false;
		if (!ok) {
			const bool was = self->embedded_;
			self->embedded_ = false;
			if (was)
				emit self->embeddedChanged();
			if (self->surface_)
				self->surface_->setVisible(false);
			const QString detail = b.value(QStringLiteral("detail")).toString();
			self->setMessage(QStringLiteral("No preview here: ") + (detail.isEmpty() ? err : detail));
			// The host may still be starting or loading the project (no canvas yet): try again (D280).
			if (!self->again_ && self->isVisible())
				QTimer::singleShot(2000, self, [self]() { if (self) self->schedule(); });
		} else {
			self->sent_ = QSize(w, h);
			self->setMessage(QString());
			if (!self->embedded_) { // the launcher's studio swap waits for this line (LU4, D346)
				self->embedded_ = true;
				emit self->embeddedChanged();
				std::printf("studio attach: preview %s embedded\n", qUtf8Printable(self->canvas_));
				std::fflush(stdout);
			}
			self->place();
		}
		if (self->again_) {
			self->again_ = false;
			self->embed();
		}
	});
}
