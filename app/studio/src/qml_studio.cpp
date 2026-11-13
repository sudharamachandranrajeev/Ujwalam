// SPDX-License-Identifier: GPL-3.0-or-later
#include "qml_studio.h"
#include "api_client.h"
#include "main_window.h"
#include "qml_bridge.h"
#include "theme.h"

#include <QCoreApplication>
#include <QDir>
#include <QGuiApplication>
#include <QJsonArray>
#include <QJsonDocument>
#include <QMetaMethod>
#include <QQmlApplicationEngine>
#include <QtQml/qqml.h>
#include <QQmlContext>
#include <QQuickItem>
#include <QQuickStyle>
#include <QQuickWindow>
#include <QSet>
#include <QSGRendererInterface>
#include <cstdio>

QmlStudio::QmlStudio(ApiClient *api, QObject *parent) : QObject(parent), api_(api) {}

QmlStudio::~QmlStudio()
{
	engine_.reset(); // the window and its preview surfaces go first; then the bridge objects they call
}

bool QmlStudio::begin(Mode mode)
{
	// Our own style on Basic, driven only by theme tokens (plan: Style). Basic needs no native style plugin.
	QQuickStyle::setStyle(QStringLiteral("Basic"));
	// Off screen (tests) the scene graph draws in software: no GPU, nothing reaches a screen. On screen: the default
	// (Direct3D 11 on Windows).
	if (mode == Mode::Probe)
		QQuickWindow::setGraphicsApi(QSGRendererInterface::Software);
	engine_ = std::make_unique<QQmlApplicationEngine>();
	// The packaged studio keeps the Qt Quick imports beside the exe (studio/qml); a dev build finds the kit's own.
	engine_->addImportPath(QCoreApplication::applicationDirPath() + QStringLiteral("/qml"));
	qapi_ = new QmlApi(api_, engine_.get(), this);
	theme_ = new QmlTheme(this);
	PreviewView::setApi(api_);
	qmlRegisterSingletonInstance("Ujwalam.Core", 1, 0, "Api", qapi_);
	qmlRegisterSingletonInstance("Ujwalam.Core", 1, 0, "Theme", theme_);
	qmlRegisterType<PreviewView>("Ujwalam.Core", 1, 0, "PreviewView");
	engine_->addImageProvider(QStringLiteral("icon"), new IconProvider()); // the engine owns it
	engine_->rootContext()->setContextProperty(QStringLiteral("studioHidden"), mode == Mode::Hidden);
	engine_->loadFromModule("Ujwalam.Studio", "Main");
	const QList<QObject *> roots = engine_->rootObjects();
	win_ = roots.isEmpty() ? nullptr : qobject_cast<QQuickWindow *>(roots.first());
	if (!win_) {
		std::fprintf(stderr, "studio: the QML window did not load (see the studio log)\n");
		return false;
	}
	switch (mode) {
	case Mode::Normal: // a normal window on the main display, activated like any app the user starts (D316)
		win_->show();
		win_->raise();
		win_->requestActivate();
		break;
	case Mode::Hidden: // a native handle without a show: the host's headless rule needs a hidden top-level parent
		win_->setFlag(Qt::WindowDoesNotAcceptFocus, true);
		win_->resize(1600, 900);
		win_->create();
		break;
	case Mode::Probe: // the offscreen platform: "shown" so bindings and layouts run, never on a screen
		win_->resize(1600, 900);
		win_->show();
		break;
	}
	QMetaObject::invokeMethod(win_, "start");
	return true;
}

void QmlStudio::swapClose()
{
	std::printf("studio swap: closing for an update (host and outputs keep running)\n");
	std::fflush(stdout);
	QCoreApplication::exit(MainWindow::kSwapExitCode);
}

void QmlStudio::close()
{
	if (win_)
		win_->close(); // onClosing in Main.qml asks about running tasks, as the widget closeEvent does
}

namespace {
QJsonValue jsonOf(const QVariant &v)
{
	if (v.metaType().id() == qMetaTypeId<QJSValue>())
		return QJsonValue::fromVariant(v.value<QJSValue>().toVariant(QJSValue::ConvertJSObjects));
	return QJsonValue::fromVariant(v);
}

// The QObject children and, for an item, its visual children (a list's delegates and a window's content are reached
// through either, depending on how they were made); each object once. A popup or dialog is no item: its header,
// content and footer are reached through those properties (the same names a window's content item uses).
QList<QObject *> kids(const QObject *o)
{
	QList<QObject *> k = o->children();
	if (const auto *it = qobject_cast<const QQuickItem *>(o))
		for (QQuickItem *c : it->childItems())
			if (!k.contains(c))
				k.append(c);
	if (const auto *w = qobject_cast<const QQuickWindow *>(o); w && !k.contains(w->contentItem()))
		k.append(w->contentItem());
	if (!qobject_cast<const QQuickItem *>(o)) // an item's own content item is among its child items already
		for (const char *p : {"header", "contentItem", "footer"})
			if (QObject *c = o->property(p).value<QObject *>(); c && !k.contains(c))
				k.append(c);
	return k;
}

void collect(const QObject *o, QJsonArray &out, QSet<const QObject *> &seen)
{
	for (const QObject *c : kids(o)) {
		if (seen.contains(c))
			continue;
		seen.insert(c);
		if (!c->objectName().isEmpty() && out.size() < 2000) {
			QJsonObject n;
			n.insert(QStringLiteral("name"), c->objectName());
			n.insert(QStringLiteral("type"), QString::fromLatin1(c->metaObject()->className()).section(QLatin1Char('_'), 0, 0));
			for (const char *p : {"text", "checked", "enabled", "value", "visible", "opened", "toolTipText"}) {
				const QVariant v = c->property(p);
				if (v.isValid())
					n.insert(QLatin1String(p), jsonOf(v));
			}
			if (const auto *it = qobject_cast<const QQuickItem *>(c)) {
				const QRectF r = it->mapRectToScene(it->boundingRect());
				n.insert(QStringLiteral("rect"), QJsonArray{qRound(r.x()), qRound(r.y()), qRound(r.width()), qRound(r.height())});
			}
			out.append(n);
		}
		collect(c, out, seen);
	}
}

// Each object once, as in collect(): a popup and its item reach each other, so a walk without the set never ends.
QObject *findNamed(QObject *root, const QString &name, QSet<const QObject *> &seen)
{
	if (!root || seen.contains(root))
		return nullptr;
	seen.insert(root);
	if (root->objectName() == name)
		return root;
	for (QObject *c : kids(root))
		if (QObject *f = findNamed(c, name, seen))
			return f;
	return nullptr;
}

QObject *findNamed(QObject *root, const QString &name)
{
	QSet<const QObject *> seen;
	return findNamed(root, name, seen);
}
} // namespace

QJsonObject QmlStudio::probe() const
{
	QJsonObject o;
	o.insert(QStringLiteral("ui"), QStringLiteral("qml"));
	o.insert(QStringLiteral("theme"), theme::currentId());
	if (!win_)
		return o;
	QJsonArray tree;
	QSet<const QObject *> seen;
	collect(win_, tree, seen);
	o.insert(QStringLiteral("tree"), tree);
	QVariant state;
	if (QMetaObject::invokeMethod(win_, "probeState", Q_RETURN_ARG(QVariant, state)))
		o.insert(QStringLiteral("state"), jsonOf(state));
	o.insert(QStringLiteral("size"), QJsonArray{win_->width(), win_->height()});
	return o;
}

bool QmlStudio::probeAction(const QString &action)
{
	if (action.startsWith(QStringLiteral("theme:")) || action.startsWith(QStringLiteral("effects:")))
		return theme::probeAction(action);
	if (action.startsWith(QStringLiteral("type:"))) { // type:<objectName>=<text>: a text field's whole text, as typed
		const qsizetype eq = action.indexOf(QLatin1Char('='));
		QObject *t = eq > 5 ? findNamed(win_, action.mid(5, eq - 5)) : nullptr;
		return t && t->property("enabled").toBool() && t->setProperty("text", action.mid(eq + 1));
	}
	if (!action.startsWith(QStringLiteral("click:"))) {
		// settings-* and other window actions live in Main.qml (probeAction), named as on the widget studio.
		QVariant done;
		return win_ && QMetaObject::invokeMethod(win_, "probeAction", Q_RETURN_ARG(QVariant, done), Q_ARG(QVariant, action)) && done.toBool();
	}
	QObject *t = findNamed(win_, action.mid(6));
	if (!t || !t->property("enabled").toBool())
		return false;
	// A Qt Quick Controls button: click() toggles a checkable one and emits clicked, as a real click does.
	if (t->metaObject()->indexOfMethod("click()") >= 0)
		return QMetaObject::invokeMethod(t, "click");
	return t->metaObject()->indexOfSignal("clicked()") >= 0 && QMetaObject::invokeMethod(t, "clicked");
}

bool QmlStudio::shot(const QString &png) const
{
	return win_ && win_->grabWindow().save(png, "PNG");
}
