// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-studio: the Qt studio shell (P5a, docs/plan/2026-11-06-p5a-qt-shell-plan.md).
// Started by the alpha launcher, which passes the UI server URL and its one-time launch key in the environment
// (UJWALAM_UI_URL, UJWALAM_UI_LAUNCH_KEY), never on argv. Both are read once and removed from the environment.
// Window rule (D316, replaces D219): a normal app window. It opens where Windows places it (the main display) and is
// activated when the user starts it. UJWALAM_HEADLESS=1: no window at all; the shell
// logs in, lists the scenes, prints one line ("studio smoke: ok, <n> scene(s)") and exits (tests).
// LU4 studio swap (D346):
//   UJWALAM_STUDIO_CONTROL=1 (set by the launcher, which then gives a stdin pipe): one command per line on stdin.
//     "swap-close": close for an update (MainWindow::swapClose, exit 75; no quit lock, the launcher keeps the host).
//     End of input is ignored (the launcher gone: the window stays, as before).
//   stdout lines the launcher waits for: "studio attach: ready" (logged in, window started) and
//     "studio attach: preview <h|v> embedded" (the host's preview sits in its slot again).
//   UJWALAM_HEADLESS=1 + UJWALAM_STUDIO_HIDDEN=1 (tests): the full window on the native platform, laid out and "shown"
//     with Qt::WA_DontShowOnScreen, so the host can embed its previews into real (hidden) window handles. Nothing ever
//     reaches the screen; the host refuses a visible parent when headless. UJWALAM_STUDIO_TEST_CLOSE_MS=N there: the
//     user's close (closeEvent, exit 0) N ms after "ready", so a test can check that a normal close still stops all;
//     a file ujwalam-studio.test-close next to the exe (text: N) does the same for that build only.
//   Headless only (tests): a file ujwalam-studio.test-crash next to the exe makes this build crash at start (its text
//     is the UJWALAM_STUDIO_TEST_CRASH kind), for the swap rollback test with a build that crashes.
#include "api_client.h"
#include "depth.h"
#include "interaction.h"
#include "main_window.h"
#include "motion.h"
#include "specimen.h"
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
#include <string>
#include <thread>
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

#ifdef Q_OS_WIN
// Headless test builds only: the text of a marker file beside the exe, or empty (LU4 tests: ujwalam-studio.test-crash
// holds a crash kind, ujwalam-studio.test-close the ms after "ready" for a user close).
static QString testMarker(const wchar_t *name)
{
	wchar_t exe[MAX_PATH] = {};
	const DWORD n = GetModuleFileNameW(nullptr, exe, MAX_PATH);
	if (!n || n >= MAX_PATH)
		return QString();
	std::wstring f(exe, n);
	const size_t slash = f.find_last_of(L"\\/");
	f = (slash == std::wstring::npos ? std::wstring() : f.substr(0, slash + 1)) + name;
	HANDLE h = CreateFileW(f.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
	if (h == INVALID_HANDLE_VALUE)
		return QString();
	char buf[64] = {};
	DWORD got = 0;
	ReadFile(h, buf, sizeof(buf) - 1, &got, nullptr);
	CloseHandle(h);
	return QString::fromLatin1(buf, (int)got).trimmed();
}

// Reads the launcher's control lines from stdin on its own thread and hands each one to the Qt thread (LU4, D346).
static void startControlReader(QApplication *app, std::function<void(const QString &)> onLine)
{
	HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
	if (in == nullptr || in == INVALID_HANDLE_VALUE || GetFileType(in) != FILE_TYPE_PIPE)
		return;
	std::thread([in, app, onLine]() {
		std::string line;
		char buf[256];
		DWORD got = 0;
		while (ReadFile(in, buf, sizeof(buf), &got, nullptr) && got > 0) {
			for (DWORD i = 0; i < got; i++) {
				if (buf[i] == '\n') {
					const QString l = QString::fromLatin1(line.data(), (int)line.size()).trimmed();
					line.clear();
					QMetaObject::invokeMethod(app, [onLine, l]() { onLine(l); }, Qt::QueuedConnection);
				} else if (line.size() < 200)
					line.push_back(buf[i]);
			}
		}
	}).detach(); // end of input (the launcher gone) ends only this thread
}
#endif

int main(int argc, char **argv)
{
	const bool headless = qEnvironmentVariable("UJWALAM_HEADLESS") == QStringLiteral("1");
	const bool hidden = headless && qEnvironmentVariable("UJWALAM_STUDIO_HIDDEN") == QStringLiteral("1");
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
#ifdef Q_OS_WIN
	if (headless) { // a test build that crashes at start (LU4 swap rollback test)
		const QString kind = testMarker(L"ujwalam-studio.test-crash");
		if (!kind.isEmpty() && logs.crash) {
			std::printf("studio: test build crashing at start (%s)\n", qUtf8Printable(kind));
			std::fflush(stdout);
			studiolog::testCrash(kind);
		}
	}
#endif
	if (headless && !hidden)
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
#ifdef Q_OS_WIN
	if (qEnvironmentVariable("UJWALAM_STUDIO_CONTROL") == QStringLiteral("1"))
		startControlReader(&app, [&win](const QString &cmd) {
			if (cmd == QStringLiteral("swap-close"))
				win.swapClose();
		});
#endif
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
					// D336: the theme specimen sheet, uncut (its scroll area shows only part of it on a small screen)
					for (QWidget *tl : QApplication::topLevelWidgets())
						if (auto *sp = qobject_cast<appearance::Specimen *>(tl); sp && sp->isVisible()) {
							for (QWidget *w : sp->findChildren<QWidget *>())
								if (w->layout())
									w->layout()->activate();
							sp->layout()->activate();
							sp->grab();
							appearance::specimenRefresh();
							// On the theme's window colour: the sheet itself is transparent over the window's backdrop.
							QWidget *body = sp->body();
							const qreal dpr = body->devicePixelRatioF();
							QPixmap pm(body->size() * dpr);
							pm.setDevicePixelRatio(dpr);
							pm.fill(theme::color(QStringLiteral("bg")));
							body->render(&pm, QPoint(), QRegion(), QWidget::DrawChildren);
							o.insert(QStringLiteral("specimenShot"), pm.save(shot.left(shot.size() - 4) + QStringLiteral("-specimen.png"), "PNG"));
							o.insert(QStringLiteral("specimenShotPixels"), QJsonArray{pm.width(), pm.height()});
							o.insert(QStringLiteral("specimenShotSize"), QJsonArray{sp->body()->width(), sp->body()->height()});
						}
					int k = 0; // any other open dialog (Posts, add windows): its own picture each (2026-11-10 theme check)
					for (QWidget *tl : QApplication::topLevelWidgets())
						if (qobject_cast<QDialog *>(tl) && tl != win.settingsWindow() && tl->isVisible() && !qobject_cast<appearance::Specimen *>(tl)) {
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
		if (hidden) { // LU4 tests: the real window, never on screen, previews embedded into its hidden handles
			win.setAttribute(Qt::WA_DontShowOnScreen, true);
			win.setAttribute(Qt::WA_ShowWithoutActivating, true);
			win.resize(1600, 900);
			win.show();
			win.start();
			std::printf("studio attach: ready (hidden)\n");
			std::fflush(stdout);
			// Tests: the user's close after this many ms (closeEvent, exit 0), to check that it still stops all (D280).
			// The env var reaches every window of a run; ujwalam-studio.test-close beside the exe (its text: the ms)
			// only that build, so a swap test can close the window on probation (Codex review of D346).
			int closeMs = qEnvironmentVariableIntValue("UJWALAM_STUDIO_TEST_CLOSE_MS");
#ifdef Q_OS_WIN
			if (closeMs <= 0)
				closeMs = testMarker(L"ujwalam-studio.test-close").toInt();
#endif
			if (closeMs > 0)
				QTimer::singleShot(closeMs, &win, [&win]() { win.close(); });
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
		std::printf("studio attach: ready\n");
		std::fflush(stdout);
		});
	});
	const int r = app.exec();
	qInfo("studio exiting with code %d", code ? code : r);
	return code ? code : r;
}
