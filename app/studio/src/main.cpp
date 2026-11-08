// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-studio: the Qt studio shell (P5a, docs/plan/2026-11-06-p5a-qt-shell-plan.md).
// Started by the alpha launcher, which passes the UI server URL and its one-time launch key in the environment
// (UJWALAM_UI_URL, UJWALAM_UI_LAUNCH_KEY), never on argv. Both are read once and removed from the environment.
// Window rule (D219): the window opens on the second display when there is one, shown without taking focus; with
// one display it opens there. UJWALAM_HEADLESS=1: no window at all; the shell
// logs in, lists the scenes, prints one line ("studio smoke: ok, <n> scene(s)") and exits (tests).
#include "api_client.h"
#include "depth.h"
#include "interaction.h"
#include "main_window.h"
#include "motion.h"
#include "theme.h"

#include <QApplication>
#include <QLayout>
#include <QWidget>
#include <QJsonDocument>
#include <QGuiApplication>
#include <QJsonArray>
#include <QPixmap>
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
	theme::apply(app);
	motion::installHover(app); // hover glow on buttons and cards (D287)
	interaction::install(app); // depth effects, captions, backdrops, popup fades (D293)
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
		// The saved theme and effects choice (settings.json ui.theme / ui.effects, D293) is applied before the window
		// shows, so it never flashes the default look. UJWALAM_THEME / UJWALAM_EFFECTS (tests) win.
		api.get(QStringLiteral("ui/api/settings"), [&](bool okS, const QJsonObject &sb, const QString &) {
		if (okS) {
			const QJsonObject ui = sb.value(QStringLiteral("settings")).toObject().value(QStringLiteral("ui")).toObject();
			if (qEnvironmentVariable("UJWALAM_THEME").isEmpty() && !ui.value(QStringLiteral("theme")).toString().isEmpty())
				theme::setCurrent(ui.value(QStringLiteral("theme")).toString());
			if (qEnvironmentVariable("UJWALAM_EFFECTS").isEmpty() && !ui.value(QStringLiteral("effects")).toString().isEmpty())
				theme::setEffects(ui.value(QStringLiteral("effects")).toString());
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
				// D285: a picture of the window as the probe saw it (evidence for the look; never shown on screen).
				const QString shot = qEnvironmentVariable("UJWALAM_STUDIO_PROBE_SHOT");
				if (shot.endsWith(QStringLiteral(".png"), Qt::CaseInsensitive)) {
					win.resize(1600, 900);
					// The window is never shown, so pending layout work (a card that just opened, the scroll area's
					// body) has not run: do it now, children first, then paint.
					for (int pass = 0; pass < 2; pass++) {
						QCoreApplication::sendPostedEvents(nullptr, QEvent::LayoutRequest);
						for (QWidget *w : win.findChildren<QWidget *>())
							if (w->layout())
								w->layout()->activate();
						win.layout()->activate();
					}
					win.grab(); // the first picture lays the never-shown window out; the cards are then placed on real sizes
					win.refreshGuide(); // tips, tour and help cards re-placed on the laid-out window
					o.insert(QStringLiteral("shot"), win.grab().save(shot, "PNG"));
					if (QWidget *sw = win.settingsWindow()) { // an open Settings window gets its own picture
						for (QWidget *w : sw->findChildren<QWidget *>())
							if (w->layout())
								w->layout()->activate();
						sw->layout()->activate();
						o.insert(QStringLiteral("settingsShot"), sw->grab().save(shot.left(shot.size() - 4) + QStringLiteral("-settings.png"), "PNG"));
					}
				}
				if (qEnvironmentVariableIntValue("UJWALAM_STUDIO_PROBE_BENCH") > 0) { // repaint cost of the depth effects (D293)
					QJsonObject bench;
					bench.insert(QStringLiteral("theme"), theme::currentId());
					bench.insert(QStringLiteral("depthWidgets"), depth::count());
					bench.insert(QStringLiteral("full"), depth::measurePaint(&win, 100));
					theme::setEffects(QStringLiteral("reduced"));
					bench.insert(QStringLiteral("reduced"), depth::measurePaint(&win, 100));
					bench.insert(QStringLiteral("unit"), QStringLiteral("ms per full-window paint, 1600x900, effect caches dropped each time"));
					o.insert(QStringLiteral("bench"), bench);
				}
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
	});
	const int r = app.exec();
	return code ? code : r;
}
