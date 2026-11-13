// SPDX-License-Identifier: GPL-3.0-or-later
// The QML studio's view of the C++ core (D355, docs/plan/2026-11-11-qml-studio-plan.md). The QML screens call the same
// studio UI server routes as the widget studio, through the same ApiClient (127.0.0.1 only, session cookie and CSRF
// kept in C++); they read the theme from the same packs (theme.h), draw the same icons (icons.h), and embed the host's
// previews with the same preview.open call into a native child window placed over a QML item.
#pragma once

#include <QJSValue>
#include <QPointer>
#include <QQuickImageProvider>
#include <QQuickItem>
#include <QRasterWindow>
#include <QTimer>
#include <QVariantMap>

class ApiClient;
class QJSEngine;

// Api: get / post / host with a JS callback (ok, body, err). Bodies cross as plain JS objects.
class QmlApi : public QObject {
	Q_OBJECT
public:
	QmlApi(ApiClient *api, QJSEngine *engine, QObject *parent = nullptr);
	Q_INVOKABLE void get(const QString &route, const QJSValue &done);
	Q_INVOKABLE void post(const QString &route, const QJSValue &body, const QJSValue &done);
	Q_INVOKABLE void host(const QString &method, const QJSValue &params, const QJSValue &done);
	// One line on stdout for the launcher and tests (the widget studio's printf lines, same text).
	Q_INVOKABLE void log(const QString &line);
	// Settings > Folders "Choose...": the Windows folder picker (no Qt Quick Dialogs module to ship). "" when cancelled.
	Q_INVOKABLE QString chooseFolder(const QString &title, const QString &start) const;

private:
	void reply(QJSValue done, bool ok, const QJsonObject &body, const QString &err);
	ApiClient *api_;
	QJSEngine *engine_;
};

// Theme: the current pack's tokens, read through theme.h (so a pack that leaves a part out falls back the same way).
class QmlTheme : public QObject {
	Q_OBJECT
	Q_PROPERTY(QString id READ id NOTIFY changed)
	Q_PROPERTY(bool dark READ dark NOTIFY changed)
	Q_PROPERTY(QVariantMap c READ colors NOTIFY changed)
	Q_PROPERTY(QString family READ family NOTIFY changed)
	Q_PROPERTY(int radiusSmall READ radiusSmall NOTIFY changed)
	Q_PROPERTY(int radiusMedium READ radiusMedium NOTIFY changed)
	Q_PROPERTY(int radiusLarge READ radiusLarge NOTIFY changed)
	Q_PROPERTY(int fast READ fast NOTIFY changed)
	Q_PROPERTY(int normal READ normal NOTIFY changed)
	Q_PROPERTY(bool motion READ motion NOTIFY changed)
public:
	explicit QmlTheme(QObject *parent = nullptr);
	QString id() const;
	bool dark() const;
	QVariantMap colors() const;
	QString family() const;
	int radiusSmall() const;
	int radiusMedium() const;
	int radiusLarge() const;
	int fast() const;
	int normal() const;
	bool motion() const;
	// "image://icon/<name>/<rrggbb>/<px>" for an icon in a token colour.
	Q_INVOKABLE QString icon(const QString &name, const QString &token, int px = 18) const;
	Q_INVOKABLE bool setCurrent(const QString &id);
	Q_INVOKABLE void setEffects(const QString &mode);
	// Settings > Appearance (Q3): the packs to choose from [{id, name, topic, dark, accent, bg, panel, text}], the
	// effects level now (full | reduced | performance) and the animation choice (system | on | off, motion.h).
	Q_INVOKABLE QVariantList themes() const;
	Q_INVOKABLE QString effects() const;
	Q_INVOKABLE void setMotionMode(const QString &mode);
	Q_INVOKABLE QString motionMode() const;
signals:
	void changed();
};

class IconProvider : public QQuickImageProvider {
public:
	IconProvider();
	QPixmap requestPixmap(const QString &id, QSize *size, const QSize &requested) override;
};

// The dark surface under a host preview: a native child window of the QML window (the host's preview window becomes
// its child, as it did with the widget studio's PreviewSlot).
class PreviewSurface : public QRasterWindow {
public:
	explicit PreviewSurface(QWindow *parent);

protected:
	void paintEvent(QPaintEvent *) override;
};

// PreviewView: a QML item that holds one host preview (canvas "h" or "v"). It keeps a native child window over its own
// rectangle and asks the host to draw the preview in it (preview.open with the window handle and the size in device
// pixels), again after a resize, a move or a host restart (reembed()).
class PreviewView : public QQuickItem {
	Q_OBJECT
	Q_PROPERTY(QString canvas READ canvas WRITE setCanvas NOTIFY canvasChanged)
	Q_PROPERTY(QString message READ message NOTIFY messageChanged)
	Q_PROPERTY(bool embedded READ embedded NOTIFY embeddedChanged)
public:
	explicit PreviewView(QQuickItem *parent = nullptr);
	~PreviewView() override;
	static void setApi(ApiClient *api);
	QString canvas() const { return canvas_; }
	void setCanvas(const QString &c);
	QString message() const { return message_; }
	bool embedded() const { return embedded_; }
	Q_INVOKABLE void reembed();

signals:
	void canvasChanged();
	void messageChanged();
	void embeddedChanged();

protected:
	void geometryChange(const QRectF &now, const QRectF &before) override;
	void itemChange(ItemChange change, const ItemChangeData &value) override;

private:
	void schedule();
	void place();
	void embed();
	void setMessage(const QString &m);
	QString canvas_;
	QString message_;
	bool embedded_ = false, busy_ = false, again_ = false;
	QRect placed_;
	QSize sent_;
	QPointer<PreviewSurface> surface_;
	QTimer debounce_, track_;
};
