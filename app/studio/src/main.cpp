// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-studio: the Qt studio shell (P5a, docs/plan/2026-11-06-p5a-qt-shell-plan.md).
// Started by the alpha launcher, which passes the UI server URL and its one-time launch key in the environment
// (UJWALAM_UI_URL, UJWALAM_UI_LAUNCH_KEY), never on argv. Both are read once and removed from the environment.
// Window rule (D219): the window opens on the second display when there is one, shown without taking focus; with
// one display it opens there. UJWALAM_HEADLESS=1: no window at all; the shell
// logs in, lists the scenes, prints one line ("studio smoke: ok, <n> scene(s)") and exits (tests).
#include "api_client.h"
#include "main_window.h"

#include <QApplication>
#include <QJsonDocument>
#include <QGuiApplication>
#include <QJsonArray>
#include <QScreen>
#include <QTimer>
#include <algorithm>
#include <memory>
#include <cstdio>

static QString takeEnv(const char *name)
{
	const QString v = qEnvironmentVariable(name);
	qunsetenv(name);
	return v;
}

int main(int argc, char **argv)
{
	const bool headless = qEnvironmentVariable("UJWALAM_HEADLESS") == QStringLiteral("1");
	if (headless)
		qputenv("QT_QPA_PLATFORM", "offscreen");
	QApplication app(argc, argv);
	QApplication::setApplicationName(QStringLiteral("Ujwalam Studio"));
	const QString url = takeEnv("UJWALAM_UI_URL");
	const QString key = takeEnv("UJWALAM_UI_LAUNCH_KEY");

	ApiClient api;
	if (!api.setBase(QUrl(url)) || key.size() < 32) {
		std::fprintf(stderr, "studio: start it from the launcher (npm run alpha -- --shell qt); no UI server URL or key\n");
		return 64;
	}
	MainWindow win(&api);
	int code = 0;
	api.login(key, [&](bool ok, const QJsonObject &, const QString &err) {
		if (!ok) {
			std::fprintf(stderr, "studio: login failed: %s\n", qPrintable(err));
			code = 77;
			QTimer::singleShot(0, &app, [&app]() { app.exit(77); });
			return;
		}
		// Probe (tests): run the window's loads and polls without showing it, then print what its panels show.
		const int probeMs = qEnvironmentVariableIntValue("UJWALAM_STUDIO_PROBE_MS");
		if (headless && probeMs > 0) {
			win.start();
			// Actions (D275): one every 700 ms from 2.5 s (after the first loads and a status poll), each a real click.
			auto actions = std::make_shared<QJsonArray>();
			const QStringList todo = qEnvironmentVariable("UJWALAM_STUDIO_PROBE_ACTIONS").split(QLatin1Char(','), Qt::SkipEmptyParts);
			for (int i = 0; i < todo.size() && i < 20; i++)
				QTimer::singleShot(2500 + 700 * i, &app, [&win, actions, a = todo[i].trimmed()]() {
					QJsonObject o;
					o.insert(QStringLiteral("action"), a);
					o.insert(QStringLiteral("done"), win.probeAction(a));
					actions->append(o);
				});
			QTimer::singleShot(std::min(probeMs, 60000), &app, [&, actions]() {
				QJsonObject o = win.probe();
				o.insert(QStringLiteral("actions"), *actions);
				std::printf("studio probe: %s\n", QJsonDocument(o).toJson(QJsonDocument::Compact).constData());
				std::fflush(stdout);
				app.exit(0);
			});
			return;
		}
		if (headless) {
			api.host(QStringLiteral("scenes.list"), {}, [&](bool ok2, const QJsonObject &b, const QString &e2) {
				const QJsonValue r = b.value(QStringLiteral("result"));
				const int n = r.isArray() ? r.toArray().size() : r.toObject().value(QStringLiteral("scenes")).toArray().size();
				if (ok2)
					std::printf("studio smoke: ok, %d scene(s)\n", n);
				else
					std::fprintf(stderr, "studio smoke: scenes.list failed: %s\n", qPrintable(e2));
				std::fflush(stdout);
				app.exit(ok2 ? 0 : 1);
			});
			return;
		}
		const auto screens = QGuiApplication::screens();
		QScreen *target = screens.size() > 1 ? screens.at(1) : QGuiApplication::primaryScreen();
		if (target)
			win.move(target->availableGeometry().topLeft() + QPoint(40, 40));
		win.setAttribute(Qt::WA_ShowWithoutActivating, true);
		win.show();
		win.start();
	});
	const int r = app.exec();
	return code ? code : r;
}
