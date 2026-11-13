// SPDX-License-Identifier: GPL-3.0-or-later
// The Qt Quick studio window (D355, flag studio-qml; docs/plan/2026-11-11-qml-studio-plan.md). main.cpp starts it
// instead of MainWindow when the launcher sets UJWALAM_STUDIO_QML=1. The screens live in app/studio/qml (module
// Ujwalam.Studio); they reach the C++ core through the Api, Theme and PreviewView types of qml_bridge.h (module
// Ujwalam.Core), on the same UI server routes as the widget studio.
// The launcher's lines stay the same: "studio attach: ready", "studio attach: ready (hidden)", "studio attach: preview
// <c> embedded", "studio swap: ...", "studio close: stop tasks (n)" and the probe's "studio probe: {json}".
#pragma once

#include <QJsonObject>
#include <QObject>
#include <memory>

class ApiClient;
class QQmlApplicationEngine;
class QQuickWindow;
class QmlApi;
class QmlTheme;

class QmlStudio : public QObject {
	Q_OBJECT
public:
	// Normal: shown and activated (D316). Hidden (LU4 tests): a real native window that is never shown, so the host can
	// embed its previews into hidden handles. Probe (tests, offscreen platform): shown off screen, read by probe().
	enum class Mode { Normal, Hidden, Probe };
	explicit QmlStudio(ApiClient *api, QObject *parent = nullptr);
	~QmlStudio() override;
	// Loads Main.qml, places the window for the mode and starts its loads and polls. false: QML did not load (logged).
	bool begin(Mode mode);
	// LU4 studio swap (D346): exit 75, nothing stopped (the host and its outputs keep running).
	void swapClose();
	void close();
	// Tests: the objectName tree of the window (and its popups) plus the screens' own state; one action per call
	// (click:<objectName> | theme:<id> | effects:<mode>); a PNG of the window.
	QJsonObject probe() const;
	bool probeAction(const QString &action);
	bool shot(const QString &png) const;
	// Tests: no API request of the screens is on the way (QmlApi::inFlight() == 0).
	bool probeIdle() const;

private:
	ApiClient *api_;
	std::unique_ptr<QQmlApplicationEngine> engine_;
	QmlApi *qapi_ = nullptr;
	QmlTheme *theme_ = nullptr;
	QQuickWindow *win_ = nullptr;
};
