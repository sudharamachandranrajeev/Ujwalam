// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-studio: the Qt studio shell (P5a, docs/plan/2026-11-06-p5a-qt-shell-plan.md).
// Started by the alpha launcher, which passes the UI server URL and its one-time launch key in the environment
// (UJWALAM_UI_URL, UJWALAM_UI_LAUNCH_KEY), never on argv. Both are read once and removed from the environment.
// Window rule (D316, replaces D219): a normal app window. It opens where Windows places it (the main display) and is
// activated when the user starts it. UJWALAM_HEADLESS=1: no window at all; the shell
// logs in, lists the scenes, prints one line ("studio smoke: ok, <n> scene(s)") and exits (tests).
#include "api_client.h"
#include "depth.h"
#include "interaction.h"
#include "main_window.h"
#include "motion.h"
#include "studio_log.h"
#include "theme.h"

#include <QApplication>
#include <QDialog>
#include <QIcon>
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
#ifdef Q_OS_WIN
#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <psapi.h>
#endif

// Memory of this process in MiB (bench only): private working set (Task Manager's "Memory"), working set, private bytes.
static QJsonObject processMemory()
{
	QJsonObject o;
#ifdef Q_OS_WIN
	struct Counters { // PROCESS_MEMORY_COUNTERS_EX2 (Windows 10 2004+), spelled out so no SDK version macro is needed
		DWORD cb;
		DWORD PageFaultCount;
		SIZE_T PeakWorkingSetSize, WorkingSetSize, QuotaPeakPagedPoolUsage, QuotaPagedPoolUsage, QuotaPeakNonPagedPoolUsage,
			QuotaNonPagedPoolUsage, PagefileUsage, PeakPagefileUsage, PrivateUsage, PrivateWorkingSetSize;
		ULONG64 SharedCommitUsage;
	} c{};
	c.cb = sizeof(c);
	const double mib = 1024.0 * 1024.0;
	if (K32GetProcessMemoryInfo(GetCurrentProcess(), reinterpret_cast<PROCESS_MEMORY_COUNTERS *>(&c), c.cb)) {
		o.insert(QStringLiteral("privateWorkingSet"), c.PrivateWorkingSetSize / mib);
		o.insert(QStringLiteral("workingSet"), c.WorkingSetSize / mib);
		o.insert(QStringLiteral("privateBytes"), c.PrivateUsage / mib);
	}
#endif
	return o;
}

static QString takeEnv(const char *name)
{
	const QString v = qEnvironmentVariable(name);
	qunsetenv(name);
	return v;
}

int main(int argc, char **argv)
{
	const bool headless = qEnvironmentVariable("UJWALAM_HEADLESS") == QStringLiteral("1");
	// Log file and crash report in <data dir>/logs when the launcher names it (studio_log.h, 2026-11-08 crash).
	const studiolog::Status logs = studiolog::install(qEnvironmentVariable("UJWALAM_STUDIO_VERSION", QStringLiteral("dev")));
	// Tests only: crash on purpose to prove the report is written. Never outside a headless run.
	if (headless && !qEnvironmentVariable("UJWALAM_STUDIO_TEST_CRASH").isEmpty()) {
		if (!logs.crash) {
			std::fprintf(stderr, "studio: UJWALAM_STUDIO_TEST_CRASH needs UJWALAM_STUDIO_LOG_DIR\n");
			return 65;
		}
		studiolog::testCrash(qEnvironmentVariable("UJWALAM_STUDIO_TEST_CRASH"));
		std::fprintf(stderr, "studio: unknown UJWALAM_STUDIO_TEST_CRASH kind\n");
		return 65;
	}
	if (headless)
		qputenv("QT_QPA_PLATFORM", "offscreen");
	QApplication app(argc, argv);
	if (logs.crash && !studiolog::reassert())
		qWarning("crash reporter: Qt start-up had replaced the unhandled-exception filter; ours is back on top");
	QApplication::setApplicationName(QStringLiteral("Ujwalam Studio"));
	{ // app icon for every window and dialog (res/png, embedded; the exe icon comes from res/ujwalam.rc)
		QIcon appIcon;
		for (const int n : {16, 24, 32, 48, 64, 256})
			appIcon.addFile(QStringLiteral(":/icon/ujwalam-%1.png").arg(n), QSize(n, n));
		QApplication::setWindowIcon(appIcon);
	}
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
			// UJWALAM_STUDIO_PROBE_SHOW=1 (tests): the window is "shown" on the offscreen platform (nothing reaches the
			// screen, nothing takes focus), so code that only runs for a visible widget runs too: the animations of the
			// task bar, the chips and the toasts (motion::enabled needs isVisible). The 2026-11-08 crash hid there.
			if (qEnvironmentVariable("UJWALAM_STUDIO_PROBE_SHOW") == QStringLiteral("1")) {
				win.setAttribute(Qt::WA_ShowWithoutActivating, true);
				win.resize(1600, 900);
				win.show();
			}
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
					int k = 0; // any other open dialog (Posts, add windows): its own picture each (2026-11-10 theme check)
					for (QWidget *tl : QApplication::topLevelWidgets())
						if (qobject_cast<QDialog *>(tl) && tl != win.settingsWindow() && tl->isVisible()) {
							for (QWidget *w : tl->findChildren<QWidget *>())
								if (w->layout())
									w->layout()->activate();
							if (tl->layout())
								tl->layout()->activate();
							tl->grab().save(shot.left(shot.size() - 4) + QStringLiteral("-dialog%1.png").arg(++k), "PNG");
						}
					o.insert(QStringLiteral("dialogShots"), k);
				}
				if (qEnvironmentVariableIntValue("UJWALAM_STUDIO_PROBE_BENCH") > 0) { // repaint cost of the depth effects (D293)
					// Paint and memory of the window in the mode it runs (2026-11-10, High performance): one process per
					// theme and mode, so memory is never carried over from another mode.
					win.resize(1600, 900);
					QJsonObject bench;
					bench.insert(QStringLiteral("theme"), theme::currentId());
					bench.insert(QStringLiteral("effects"), theme::effects());
					bench.insert(QStringLiteral("depthWidgets"), depth::count());
					bench.insert(QStringLiteral("hoverOverlays"), motion::hoverCount());
					bench.insert(QStringLiteral("paintMs"), depth::measurePaint(&win, 100, false));
					bench.insert(QStringLiteral("paintWorstMs"), depth::measurePaint(&win, 100, true));
					bench.insert(QStringLiteral("mem"), processMemory());
					bench.insert(QStringLiteral("unit"), QStringLiteral("ms per full-window paint at 1600x900 (paintWorstMs: effect caches dropped before each paint); mem in MiB after the paints"));
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
		win.show(); // a normal window on the main display, activated like any app the user starts (D316)
		win.raise();
		win.activateWindow();
		win.start();
		});
	});
	const int r = app.exec();
	qInfo("studio exiting with code %d", code ? code : r);
	return code ? code : r;
}
