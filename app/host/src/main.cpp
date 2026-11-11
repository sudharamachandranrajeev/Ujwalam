// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: long-running libobs host. Hosts the studio (canvases H/V, scenes, layers), native previews and the
// output graph, and serves the local JSON-RPC API on 127.0.0.1. Device sources (cameras, capture cards, mics) are
// off unless --allow-devices is given; a device session needs the user's go.
//
// Usage:
//   ujwalam-host --runtime <obs runtime dir> [--data-dir <dir>] [--discovery <file>] [--recordings <dir>]
//                [--port <n>] [--project <file.json>] [--outputs <configure-params.json>] [--preview h,v]
//                [--adapter <n>] [--allow-devices] [--allow-browser] [--allow-live] [--twitch-bandwidth-test]
//                [--host-config <file.json>] [--test-hooks] [--headless]
//                [--overlay-root <dir> --overlay-script <child.mjs> [--node <node.exe>] [--overlay-port <n>]
//                 [--overlay-feed-port <n>] [--overlay-events-url http://127.0.0.1:<p>/<path>]]
// With --allow-browser and --overlay-root the host supervises the overlay server child (overlay.h): static pages
// from the overlay root and the read-only bridge feed, both on 127.0.0.1, never on 8093 (the real Streamer.bot).
// --host-config (host_config.h): replay buffer, global hotkeys, feedback and markers folders, event-core system file.
// --test-hooks enables hotkeys.trigger (tests only).
// --test-crash <kind> (needs --test-hooks; tests only): crash on purpose right after the crash reporter is installed and
// before libobs starts (no GPU), to test the report (crash.h).
// --headless (or UJWALAM_HEADLESS=1; every test run sets it): no preview window is ever created; preview.open fails
// with CONFLICT, except an embedded one into a hidden parent window (LU4 studio-swap tests, D346). Otherwise previews are normal windows on the main display (D316).
// --twitch-bandwidth-test: keyed twitch sinks connect with "?bandwidthtest=true" appended to the stored key at connect
// time (outputs.h); the credential is never changed.
// Environment (the launcher's channel; values are never logged):
//   UJWALAM_OBS_RUNTIME        runtime dir when --runtime is not given
//   UJWALAM_HOST_TOKEN         api token (64 hex); generated when absent
//   UJWALAM_HOST_SYSTEM_TOKEN  system token (64 hex); generated when absent
//   UJWALAM_HOST_MARKERS_TOKEN markers token (64 hex, differs from the others): may call only marker.add (chat/audio)
//                              and mixer.list. Never generated, never in the discovery file; absent = role off
//   UJWALAM_HOST_CLIPS_TOKEN   clips token (64 hex, differs from the others; the live clipper, D226): may call only
//                              frames.grab, replay.save, replay.status, marker.add (source clip) and host.status.
//                              Never generated, never in the discovery file; absent = role off
//   UJWALAM_FACE_LINK_KEY      face link key (64 hex, D295): written into the face link's shared-memory header, where
//                              the face worker (which got the same key from the launcher on its stdin) checks it
//                              before it uses the mapping. Generated when absent (then no worker can attach); never
//                              logged, never in the discovery file
//   UJWALAM_HOST_DISCOVERY     discovery file when --discovery is not given
//   UJWALAM_HEADLESS           "1": same as --headless
//   UJWALAM_EVENT_CORE_API_TOKEN  event-core token for the overlay server's event feed; passed only to that child
//                              and only with --overlay-events-url
//   UJWALAM_EVENT_CORE_SYSTEM_TOKEN  event-core system token, used only by panic to send actions.panic over the
//                              event-core system pipe (panic.h); never passed to any child
// Token variables are removed from the process environment once read, so helper processes never inherit them.
// The discovery file carries a token only when the host generated it (null when it came by environment).
#include "app.h"
#include "crash.h"
#include "devices.h"
#include "discovery.h"
#include "log.h"
#include "obs_runtime.h"
#include "stats.h"

#include <windows.h>
#include <shlobj.h>

#include <cstdio>
#include <filesystem>
#include <fstream>
#include <regex>
#include <sstream>
#include <thread>

namespace fs = std::filesystem;

extern "C" {
// Ask the hybrid-graphics driver for the discrete GPU (the RTX 4050; D1). The per-app Windows graphics preference
// is reported by host.info (gpuPreference) and is never changed by the host.
__declspec(dllexport) DWORD NvOptimusEnablement = 1;
__declspec(dllexport) int AmdPowerXpressRequestHighPerformance = 1;
}

namespace {

HANDLE g_shutdown = nullptr;
App *g_app = nullptr;

BOOL WINAPI on_ctrl(DWORD type)
{
	if (g_app && !g_app->shutting_down.exchange(true))
		g_app->shutdown_reason = type == CTRL_C_EVENT ? "ctrl-c" : type == CTRL_BREAK_EVENT ? "ctrl-break" : "console";
	if (g_shutdown)
		SetEvent(g_shutdown);
	if (type == CTRL_CLOSE_EVENT || type == CTRL_LOGOFF_EVENT || type == CTRL_SHUTDOWN_EVENT)
		Sleep(4000); // give the main thread time to stop outputs before Windows ends the process
	return TRUE;
}

std::string narrow(const std::wstring &w)
{
	if (w.empty())
		return {};
	int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), nullptr, 0, nullptr, nullptr);
	std::string s((size_t)n, '\0');
	WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), s.data(), n, nullptr, nullptr);
	return s;
}

std::string env(const wchar_t *name)
{
	wchar_t buf[1024];
	DWORD n = GetEnvironmentVariableW(name, buf, 1024);
	if (!n || n >= 1024)
		return {};
	return narrow(std::wstring(buf, n));
}

bool read_json_file(const std::string &path, json::Value &out, std::string &err)
{
	std::ifstream f(fs::u8path(path), std::ios::binary);
	if (!f) {
		err = "cannot open " + path;
		return false;
	}
	std::stringstream ss;
	ss << f.rdbuf();
	std::string text = ss.str();
	if (text.size() >= 3 && (unsigned char)text[0] == 0xEF && (unsigned char)text[1] == 0xBB &&
	    (unsigned char)text[2] == 0xBF)
		text = text.substr(3);
	json::ParseResult pr = json::parse(text, 64);
	if (!pr.ok) {
		err = path + ": " + pr.error;
		return false;
	}
	out = std::move(pr.value);
	return true;
}

std::string default_data_dir()
{
	PWSTR p = nullptr;
	std::string r;
	if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &p)))
		r = (fs::path(p) / "Ujwalam" / "host").generic_u8string();
	CoTaskMemFree(p);
	return r;
}

const char *kDefaultProject = R"({"format":"ujwalam-host-test","version":1,"name":"default",
  "canvases":[{"id":"H","w":1920,"h":1080,"fps":60}],
  "scenes":[{"id":"main","canvas":"H","name":"Main","layers":[
    {"id":"bg","type":"color","settings":{"color":"#FF101418"}}]}]})";

void usage()
{
	fprintf(stderr, "usage: ujwalam-host --runtime <obs runtime dir> [--data-dir <dir>] [--discovery <file>]\n"
			"         [--recordings <dir>] [--port <n>] [--project <file.json>] [--outputs <file.json>]\n"
			"         [--preview h,v] [--adapter <n>] [--allow-devices] [--allow-browser] [--allow-live]\n"
			"         [--twitch-bandwidth-test] [--host-config <file.json>] [--test-hooks [--test-crash <kind>]] [--headless]\n"
			"         [--overlay-root <dir> --overlay-script <child.mjs> [--node <node.exe>] [--overlay-port <n>]\n"
			"          [--overlay-feed-port <n>] [--overlay-events-url <url>]]\n");
}

} // namespace

int wmain(int argc, wchar_t **wargv)
{
	SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
	App app;
	g_app = &app;
	app.start_tick = GetTickCount64();
	std::vector<std::string> args;
	for (int i = 1; i < argc; i++)
		args.push_back(narrow(wargv[i]));

	obsrt::Options o;
	std::string project_path, outputs_path, preview, port_s = "0", adapter_s = "0";
	Overlay::Config ov;
	std::string ov_port_s = "0", ov_feed_s = "0";
	bool headless = false;
	std::string test_crash;
	for (size_t i = 0; i < args.size(); i++) {
		const std::string &a = args[i];
		auto next = [&](std::string &dst) {
			if (i + 1 >= args.size()) {
				fprintf(stderr, "missing value for %s\n", a.c_str());
				exit(64);
			}
			dst = args[++i];
		};
		if (a == "--runtime")
			next(o.runtime);
		else if (a == "--data-dir")
			next(app.data_dir);
		else if (a == "--discovery")
			next(app.discovery_path);
		else if (a == "--recordings")
			next(app.recordings_dir);
		else if (a == "--port")
			next(port_s);
		else if (a == "--project")
			next(project_path);
		else if (a == "--outputs")
			next(outputs_path);
		else if (a == "--preview")
			next(preview);
		else if (a == "--adapter")
			next(adapter_s);
		else if (a == "--allow-devices")
			app.allow_devices = true;
		else if (a == "--allow-browser")
			app.allow_browser = true;
		else if (a == "--allow-live") // A0: real stream targets (outputs.h); never used by CI
			app.allow_live = true;
		else if (a == "--twitch-bandwidth-test") // runtime-only Twitch bandwidth-test suffix (outputs.h)
			app.twitch_bandwidth_test = true;
		else if (a == "--host-config")
			next(app.config_path);
		else if (a == "--test-hooks") // hotkeys.trigger; tests only
			app.test_hooks = true;
		else if (a == "--test-crash") // crash.h test trigger; needs --test-hooks
			next(test_crash);
		else if (a == "--headless") // no preview windows (tests)
			headless = true;
		else if (a == "--overlay-root")
			next(ov.root);
		else if (a == "--overlay-script")
			next(ov.script);
		else if (a == "--node")
			next(ov.node);
		else if (a == "--overlay-port")
			next(ov_port_s);
		else if (a == "--overlay-feed-port")
			next(ov_feed_s);
		else if (a == "--overlay-events-url")
			next(ov.events_url);
		else if (a == "--help" || a == "-h") {
			usage();
			return 0;
		} else {
			fprintf(stderr, "unknown argument %s\n", a.c_str());
			usage();
			return 64;
		}
	}
	if (!test_crash.empty() && !app.test_hooks) {
		fprintf(stderr, "--test-crash needs --test-hooks\n");
		return 64;
	}
	if (env(L"UJWALAM_HEADLESS") == "1")
		headless = true;
	if (o.runtime.empty())
		o.runtime = env(L"UJWALAM_OBS_RUNTIME");
	if (o.runtime.empty()) {
		fprintf(stderr, "set --runtime or UJWALAM_OBS_RUNTIME to the OBS runtime dir\n");
		return 64;
	}
	char *end = nullptr;
	long port = strtol(port_s.c_str(), &end, 10);
	if (*end || port < 0 || port > 65535) {
		fprintf(stderr, "bad --port\n");
		return 64;
	}
	long adapter = strtol(adapter_s.c_str(), &end, 10);
	if (*end || adapter < 0 || adapter > 16) {
		fprintf(stderr, "bad --adapter\n");
		return 64;
	}
	app.adapter = (uint32_t)adapter;
	for (auto [s, dst] : {std::pair<std::string *, uint16_t *>{&ov_port_s, &ov.port}, {&ov_feed_s, &ov.feed_port}}) {
		long v = strtol(s->c_str(), &end, 10);
		if (*end || v < 0 || v > 65535 || v == 8093) { // 8093 stays the real Streamer.bot's
			fprintf(stderr, "bad --overlay-port / --overlay-feed-port (0-65535, never 8093)\n");
			return 64;
		}
		*dst = (uint16_t)v;
	}
	// The event-core tokens: read and removed from the environment, so neither CEF nor any child inherits them.
	ov.events_token = env(L"UJWALAM_EVENT_CORE_API_TOKEN");
	SetEnvironmentVariableW(L"UJWALAM_EVENT_CORE_API_TOKEN", nullptr);
	Panic::Config pc;
	pc.token = env(L"UJWALAM_EVENT_CORE_SYSTEM_TOKEN");
	SetEnvironmentVariableW(L"UJWALAM_EVENT_CORE_SYSTEM_TOKEN", nullptr);
	if (!pc.token.empty() && !rpc::is_token(pc.token)) {
		fprintf(stderr, "UJWALAM_EVENT_CORE_SYSTEM_TOKEN must be 64 lowercase hex characters\n");
		return 64;
	}
	if (!app.config_path.empty()) {
		json::Value hc;
		std::string herr;
		if (!read_json_file(app.config_path, hc, herr) || !parse_host_config(hc, app.config, herr)) {
			fprintf(stderr, "--host-config: %s\n", herr.c_str());
			return 64;
		}
	}
	if (!ov.root.empty()) {
		std::error_code ec;
		if (!app.allow_browser) {
			fprintf(stderr, "--overlay-root needs --allow-browser\n");
			return 64;
		}
		if (ov.script.empty() || !fs::is_regular_file(fs::u8path(ov.script), ec) ||
		    !fs::is_directory(fs::u8path(ov.root), ec)) {
			fprintf(stderr, "--overlay-root must be a directory and --overlay-script the overlay child script\n");
			return 64;
		}
		if (ov.node.empty()) {
			wchar_t buf[MAX_PATH];
			DWORD n = SearchPathW(nullptr, L"node.exe", nullptr, MAX_PATH, buf, nullptr);
			if (n && n < MAX_PATH)
				ov.node = narrow(std::wstring(buf, n));
		}
		if (ov.node.empty() || !fs::is_regular_file(fs::u8path(ov.node), ec)) {
			fprintf(stderr, "node.exe not found; pass --node\n");
			return 64;
		}
		static const std::regex events_re("^http://127\\.0\\.0\\.1:[0-9]{1,5}/[^\\s]*$");
		if (!ov.events_url.empty() && (!std::regex_match(ov.events_url, events_re) || !rpc::is_token(ov.events_token))) {
			fprintf(stderr, "--overlay-events-url must be http://127.0.0.1:<port>/... and needs UJWALAM_EVENT_CORE_API_TOKEN\n");
			return 64;
		}
		ov.root = fs::absolute(fs::u8path(ov.root), ec).generic_u8string();
		ov.script = fs::absolute(fs::u8path(ov.script), ec).generic_u8string();
	} else if (!ov.script.empty() || !ov.events_url.empty()) {
		fprintf(stderr, "--overlay-script / --overlay-events-url need --overlay-root\n");
		return 64;
	}
	if (ov.events_url.empty())
		ov.events_token.assign(ov.events_token.size(), '0');
	if (app.data_dir.empty())
		app.data_dir = default_data_dir();
	if (app.data_dir.empty()) {
		fprintf(stderr, "cannot resolve the data dir; pass --data-dir\n");
		return 64;
	}
	if (app.discovery_path.empty())
		app.discovery_path = env(L"UJWALAM_HOST_DISCOVERY");
	if (app.discovery_path.empty())
		app.discovery_path = (fs::u8path(app.data_dir) / "host.json").generic_u8string();
	if (app.recordings_dir.empty())
		app.recordings_dir = (fs::u8path(app.data_dir) / "recordings").generic_u8string();

	// Tokens: from the launcher by environment, or generated. Removed from the environment either way.
	std::string api_token = env(L"UJWALAM_HOST_TOKEN"), sys_token = env(L"UJWALAM_HOST_SYSTEM_TOKEN");
	SetEnvironmentVariableW(L"UJWALAM_HOST_TOKEN", nullptr);
	SetEnvironmentVariableW(L"UJWALAM_HOST_SYSTEM_TOKEN", nullptr);
	bool api_from_env = !api_token.empty(), sys_from_env = !sys_token.empty();
	if ((api_from_env && !rpc::is_token(api_token)) || (sys_from_env && !rpc::is_token(sys_token))) {
		fprintf(stderr, "UJWALAM_HOST_TOKEN / UJWALAM_HOST_SYSTEM_TOKEN must be 64 lowercase hex characters\n");
		return 64;
	}
	if (!api_from_env)
		api_token = rpc::new_token();
	if (!sys_from_env)
		sys_token = rpc::new_token();
	if (api_token.empty() || sys_token.empty() || api_token == sys_token) {
		fprintf(stderr, "token generation failed\n");
		return 70;
	}
	// Markers token (least-privilege role: marker.add and mixer.list only; rpc_server.h Role::Markers). Only from the
	// launcher, never generated and never in the discovery file; absent = no markers role.
	std::string markers_token = env(L"UJWALAM_HOST_MARKERS_TOKEN");
	SetEnvironmentVariableW(L"UJWALAM_HOST_MARKERS_TOKEN", nullptr);
	if (!markers_token.empty() &&
	    (!rpc::is_token(markers_token) || markers_token == api_token || markers_token == sys_token)) {
		fprintf(stderr, "UJWALAM_HOST_MARKERS_TOKEN must be 64 lowercase hex characters and differ from the other tokens\n");
		return 64;
	}
	// Clips token (least-privilege role for the live clipper; rpc_server.h Role::Clips). Same rules as the markers token.
	std::string clips_token = env(L"UJWALAM_HOST_CLIPS_TOKEN");
	SetEnvironmentVariableW(L"UJWALAM_HOST_CLIPS_TOKEN", nullptr);
	if (!clips_token.empty() && (!rpc::is_token(clips_token) || clips_token == api_token || clips_token == sys_token ||
				     clips_token == markers_token)) {
		fprintf(stderr, "UJWALAM_HOST_CLIPS_TOKEN must be 64 lowercase hex characters and differ from the other tokens\n");
		return 64;
	}
	// Face link key (face.h): from the launcher, or generated (a worker started without the launcher cannot attach).
	std::string face_key = env(L"UJWALAM_FACE_LINK_KEY");
	SetEnvironmentVariableW(L"UJWALAM_FACE_LINK_KEY", nullptr);
	if (!face_key.empty() && !rpc::is_token(face_key)) {
		fprintf(stderr, "UJWALAM_FACE_LINK_KEY must be 64 lowercase hex characters\n");
		return 64;
	}
	if (face_key.empty())
		face_key = rpc::new_token();
	if (face_key.size() != face::kKeyBytes * 2) {
		fprintf(stderr, "face link key generation failed\n");
		return 70;
	}
	std::array<uint8_t, face::kKeyBytes> face_key_bytes{};
	for (size_t i = 0; i < face::kKeyBytes; i++)
		face_key_bytes[i] = (uint8_t)std::stoul(face_key.substr(i * 2, 2), nullptr, 16);
	face_key.assign(face_key.size(), '0');

	std::string err;
	for (const std::string &d : {app.data_dir, app.recordings_dir,
				     (fs::u8path(app.data_dir) / "logs").generic_u8string(),
				     (fs::u8path(app.discovery_path).parent_path()).generic_u8string()}) {
		if (!discovery::ensure_dir(d, err)) {
			fprintf(stderr, "cannot create %s: %s\n", d.c_str(), err.c_str());
			return 73;
		}
	}
	app.started_at = hlog::utc_now();
	{
		SYSTEMTIME t;
		GetLocalTime(&t);
		char b[32];
		snprintf(b, sizeof(b), "%04u%02u%02u-%02u%02u%02u", t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond);
		app.session = b;
	}
	if (app.config.feedback_dir.empty())
		app.config.feedback_dir = (fs::u8path(app.data_dir) / "feedback").generic_u8string();
	if (app.config.markers_dir.empty())
		app.config.markers_dir = (fs::u8path(app.data_dir) / "markers").generic_u8string();
	{
		std::string st = app.started_at.substr(0, 19);
		for (char &c : st)
			if (c == ':')
				c = '-';
		app.log_path = (fs::u8path(app.data_dir) / "logs" / ("host-" + st + ".log")).generic_u8string();
	}
	hlog::open_file(app.log_path);
	{
		crash::Config cc;
		cc.logs_dir = (fs::u8path(app.data_dir) / "logs").generic_u8string();
		cc.version = app.version;
		cc.log_file = fs::u8path(app.log_path).filename().u8string();
		cc.runtime_dir = o.runtime;
		crash::Status cs = crash::install(cc);
		if (cs.writing)
			hlog::info("crash reporter: on (text report to logs/crash-*.txt, no dump; symbols %s; %d earlier reports)",
				   cs.symbols ? "on" : "off", cs.existing);
		else
			hlog::warn("crash reporter: on, but NO report file will be written: %d crash-*.txt files in logs/ (limit %d; "
				   "nothing is deleted: move old reports away)",
				   cs.existing, crash::kMaxReports);
		if (!test_crash.empty()) {
			hlog::warn("test-crash %s (--test-hooks)", test_crash.c_str());
			if (!crash::test_trigger(test_crash)) {
				hlog::error("unknown --test-crash kind (av, abort, cxx, purecall, invalid-parameter, stack-overflow)");
				hlog::close_file();
				return 64;
			}
		}
	}
	wchar_t exe[MAX_PATH];
	DWORD en = GetModuleFileNameW(nullptr, exe, MAX_PATH);
	app.exe_path = std::wstring(exe, en);

	g_shutdown = CreateEventW(nullptr, TRUE, FALSE, nullptr);
	app.shutdown_event = g_shutdown;
	SetConsoleCtrlHandler(on_ctrl, TRUE);

	// ---- libobs
	o.config_dir = (fs::u8path(app.data_dir) / "obs-config").generic_u8string();
	o.allow_devices = app.allow_devices;
	o.allow_browser = app.allow_browser;
	o.adapter = app.adapter;
	o.low_latency_audio = app.config.low_latency_audio;
	if (!obsrt::start(o, err)) {
		hlog::error("libobs start failed: %s", err.c_str());
		return 2;
	}
	stats::init();
	Outputs::register_loopback_service();
	json::Value pref = stats::gpu_preference(app.exe_path);
	hlog::info("adapter %u: %s; windows graphics preference for this exe: %s", app.adapter,
		   obsrt::adapter_name().c_str(), pref.dump().c_str());
	hlog::info("devices %s, browser %s", app.allow_devices ? "ALLOWED" : "off", app.allow_browser ? "allowed" : "off");
	if (!app.config.monitoring_device.empty()) {
		if (!app.allow_devices) {
			hlog::info("audio monitoring output: Windows default (monitoringDevice applies only with --allow-devices)");
		} else {
			json::Value m = devices::set_monitoring_output(app.config.monitoring_device, devices::enumerate());
			if (const json::Value *pr = m.find("problem"))
				hlog::warn("audio monitoring output \"%s\": %s; using the Windows default output",
					   app.config.monitoring_device.c_str(), pr->as_string().c_str());
			else
				hlog::info("audio monitoring output: %s", m.find("device")->as_string().c_str());
		}
	}
	if (!ov.root.empty()) {
		app.overlay = std::make_unique<Overlay>(ov);
		ov.events_token.assign(ov.events_token.size(), '0');
		app.overlay->start();
		if (!app.overlay->wait_ready(15000))
			hlog::warn("overlay server not ready yet (%s); overlay layers are unavailable until it is",
				   app.overlay->status().find("state")->as_string().c_str());
	}

	int rc = 0;
	{
		Studio::Flags f;
		f.allow_devices = app.allow_devices;
		f.allow_browser = app.allow_browser;
		app.studio = std::make_unique<Studio>(f);
		{
			const auto &ah = app.config.audio_health;
			Studio::AudioHealthCfg hc;
			hc.no_data_ms = ah.no_data_ms;
			hc.max_recreates = ah.max_recreates;
			hc.max_parked = ah.max_parked;
			hc.recreate = ah.enabled;
			app.studio->set_audio_health(hc);
			if (app.test_hooks) {
				ahealth::register_test_audio_type();
				devwatch::register_test_capture_type(); // D329: capture layers on fake devices (devices.testSet)
			}
			if (ah.no_data_ms && ah.check_interval_ms) {
				Studio *st = app.studio.get();
				app.audio_watch = std::make_unique<ahealth::Ticker>(ah.check_interval_ms, [st]() { st->audio_watch_tick(); });
			}
			hlog::info("audio health: %s (no data %u ms, check %u ms, max %u restarts per source, %u parked per run; "
				   "shutdown guard %u ms)",
				   ah.enabled ? "watchdog on" : (ah.no_data_ms ? "report only" : "off"), ah.no_data_ms,
				   ah.check_interval_ms, ah.max_recreates, ah.max_parked, ah.shutdown_guard_ms);
		}
		// Device hot-plug (D329): capture layers follow devices plugged in or out while the host runs. Listing is a
		// device feature (D38): only with --allow-devices, or --test-hooks (fake lists).
		if (app.allow_devices || app.test_hooks) {
			app.device_watch = std::make_unique<devwatch::Watcher>(
				[&app](const std::vector<std::string> &removed, bool event) {
					devices_pass(app, event ? "watcher" : "connect check", removed, event);
				});
			devwatch::Watcher *w = app.device_watch.get();
			app.studio->set_check_scheduler([w](uint32_t ms) { w->check_after(ms); });
		}
		app.outputs = std::make_unique<Outputs>(*app.studio, app.recordings_dir, app.allow_live,
							app.twitch_bandwidth_test);
		app.outputs->set_replay_config(app.config.replay);
		hlog::info("real stream targets %s", app.allow_live ? "ALLOWED (--allow-live)" : "off (loopback only)");
		hlog::info("twitch bandwidth test %s",
			   app.twitch_bandwidth_test ? "ON (--twitch-bandwidth-test: twitch sinks are not broadcast)" : "off");
		pedit::Backend edit; // preview mouse editing (D230): the same Studio calls as layers.list / layers.setPlacement
		{
			Studio *st = app.studio.get();
			edit.layers = [st](const std::string &canvas, std::string &scene, std::vector<pedit::Item> &items) {
				return st->preview_items(canvas, scene, items);
			};
			edit.apply = [st](const std::string &canvas, const std::string &scene, const std::string &layer,
					  const json::Value &patch) -> std::string {
				try {
					st->layer_set_placement(scene, canvas, layer, patch);
					return "";
				} catch (const std::exception &e) {
					return e.what();
				}
			};
			Outputs *outs = app.outputs.get();
			edit.locked = [outs]() { return outs->live(); };
		}
		app.previews = std::make_unique<Previews>(headless, std::move(edit));
		hlog::info("previews: %s", headless ? "OFF (headless)" : "on (normal windows, main display)");
		pc.system_file = app.config.core_system_file;
		bool core_ready = !pc.system_file.empty() && rpc::is_token(pc.token);
		app.panic = std::make_unique<Panic>(*app.studio, std::move(pc));
		pc.token.assign(pc.token.size(), '0');
		hlog::info("panic: event-core notification %s", core_ready ? "configured" : "OFF (no system file or system token)");
		Moments::Config mc;
		mc.feedback_dir = app.config.feedback_dir;
		mc.markers_dir = app.config.markers_dir;
		mc.session = app.session;
		app.moments = std::make_unique<Moments>(app, mc);
		app.hotkeys = std::make_unique<Hotkeys>();
		app.frames = std::make_unique<Frames>((fs::u8path(app.data_dir) / "live").generic_u8string());
		// Face link (D295 proposed): mapping + tick callback. Camera frames go out only while a face effect is shown
		// and the face worker (flag face-ai) is alive; the worker is gated by the flag.
		app.face = std::make_unique<face::Link>(GetCurrentProcessId(), face_key_bytes);
		SecureZeroMemory(face_key_bytes.data(), face_key_bytes.size());
		if (app.face->ok())
			face::set(app.face.get());
		else
			app.face.reset();
		if (app.overlay) { // cam-pop mic feed (overlay.h): the overlay pump reads the named source's meter
			Studio *st = app.studio.get();
			app.overlay->set_mic_level(
				[st](const std::string &id, float &db) { return st->audio_peak_db(id, db); });
		}

		json::Value project;
		if (project_path.empty()) {
			project = json::parse(kDefaultProject).value;
		} else if (!read_json_file(project_path, project, err)) {
			hlog::error("project: %s", err.c_str());
			rc = 3;
		}
		if (!rc && model::is_model(project)) {
			// Project v1 documents go through project.load after start, so that the caller validates them first
			// (services/project/validate.mjs; app/host/lib/project.mjs) and passes the pathRef bases.
			hlog::error("project: --project takes the host test format only; load project v1 with project.load");
			rc = 3;
		}
		if (!rc) {
			try {
				app.studio->load(project, false);
			} catch (const std::exception &e) {
				hlog::error("project load failed: %s", e.what());
				rc = 3;
			}
		}
		if (!rc && !outputs_path.empty()) {
			json::Value op;
			if (!read_json_file(outputs_path, op, err)) {
				hlog::error("outputs: %s", err.c_str());
				rc = 4;
			} else {
				try {
					app.outputs->configure(op);
				} catch (const std::exception &e) {
					hlog::error("outputs configure failed: %s", e.what());
					rc = 4;
				}
			}
		}
		if (!rc && !preview.empty()) {
			std::stringstream ps(preview);
			std::string c;
			while (std::getline(ps, c, ',')) {
				Previews::OpenArgs a;
				a.canvas = Studio::norm_canvas(c);
				if (a.canvas.empty())
					continue;
				try {
					app.previews->open(a);
				} catch (const std::exception &e) {
					hlog::warn("preview %s: %s", a.canvas.c_str(), e.what());
				}
			}
		}

		if (!rc && app.config.replay_autostart) {
			try {
				app.outputs->replay_start(0);
			} catch (const std::exception &e) {
				hlog::warn("replay buffer: %s", e.what());
			}
		}

		std::unique_ptr<rpc::Server> server;
		if (!rc) {
			server = std::make_unique<rpc::Server>(rpc::Limits{}, api_token, sys_token, make_methods(app), markers_token,
							       clips_token);
			hlog::info("rpc markers role: %s", markers_token.empty() ? "off" : "on (marker.add, mixer.list)");
			hlog::info("rpc clips role: %s",
				   clips_token.empty() ? "off" : "on (frames.grab, replay.save, replay.status, marker.add, host.status)");
			if (!server->start((uint16_t)port, err)) {
				hlog::error("rpc listen failed: %s", err.c_str());
				rc = 5;
			}
		}
		if (!rc) {
			json::Value d = json::Value::object();
			d.set("port", (int)server->port());
			d.set("pid", (int64_t)GetCurrentProcessId());
			d.set("startedAt", app.started_at);
			d.set("token", api_from_env ? json::Value() : json::Value(api_token));
			d.set("systemToken", sys_from_env ? json::Value() : json::Value(sys_token));
			d.set("path", "/rpc");
			d.set("apiVersion", 1);
			d.set("version", app.version);
			if (!discovery::write_secret_file(app.discovery_path, d.dump() + "\n", err)) {
				hlog::error("discovery write refused: %s", err.c_str());
				rc = 6;
			}
		}
		api_token.assign(api_token.size(), '0');
		sys_token.assign(sys_token.size(), '0');
		markers_token.assign(markers_token.size(), '0');
		clips_token.assign(clips_token.size(), '0');
		if (!crash::reassert())
			hlog::warn("crash reporter: a module had replaced the unhandled-exception filter; ours is back on top");
		if (!rc) {
			// Global hotkeys last: every handler's target exists. A binding that fails is reported, never fatal.
			app.hotkeys->start(app.config.hotkeys,
					   [&app](const std::string &name, const char *via) { on_hotkey(app, name, via); },
					   app.config.hotkeys_enabled);
			hlog::info("ready: rpc on 127.0.0.1:%u, discovery %s, log %s", (unsigned)server->port(),
				   app.discovery_path.c_str(), app.log_path.c_str());
			// Parent pipe (D234): started by the studio launcher with stdin as a pipe and UJWALAM_PARENT_PIPE=1.
			// The pipe closes when the launcher dies, even by a hard kill that sends no signal. The host then shuts
			// down cleanly, but only while no stream or recording runs: a supervisor crash never stops the stream
			// or a recording (AGENTS.md), so it waits for them to end. The reader thread only signals an event; the
			// outputs are checked here, on the main thread, before any teardown. The event is never closed: the
			// detached reader may still hold it.
			HANDLE parent_gone = nullptr;
			{
				char pv[4] = {};
				if (GetEnvironmentVariableA("UJWALAM_PARENT_PIPE", pv, sizeof pv) == 1 && pv[0] == '1') {
					parent_gone = CreateEventW(nullptr, TRUE, FALSE, nullptr);
					HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
					if (parent_gone && in && in != INVALID_HANDLE_VALUE) {
						std::thread([in, ev = parent_gone]() {
							char b[64];
							DWORD n = 0;
							while (ReadFile(in, b, sizeof b, &n, nullptr) && n > 0) {
							}
							SetEvent(ev);
						}).detach();
						hlog::info("parent pipe: on (the host stops when the launcher is gone and nothing is live)");
					}
				}
			}
			bool gone = false;
			for (;;) {
				HANDLE hs[2] = {g_shutdown, parent_gone};
				DWORD w = WaitForMultipleObjects(parent_gone ? 2 : 1, hs, FALSE, gone ? 5000 : INFINITE);
				if (w == WAIT_OBJECT_0)
					break;
				if (w == WAIT_OBJECT_0 + 1) {
					ResetEvent(parent_gone); // seen once; from now on a 5 s re-check
					gone = true;
				}
				if (!gone)
					continue;
				if (!app.outputs->live() && !app.outputs->recording()) {
					if (!app.shutting_down.exchange(true))
						app.shutdown_reason = "launcher gone";
					break;
				}
				static bool told = false;
				if (!told) {
					hlog::warn("launcher gone (parent pipe closed) while a stream or recording runs: kept running; "
						   "the host stops when they end");
					told = true;
				}
			}
			hlog::info("shutdown (%s)", app.shutdown_reason.empty() ? "event" : app.shutdown_reason.c_str());
			Sleep(150); // let the host.shutdown response reach the caller
		}

		// Order: hotkeys off, API off, feedback worker and panic sender done, outputs stopped and released, previews
		// closed, scenes removed, discovery removed.
		app.hotkeys->stop();
		if (server)
			server->stop();
		if (app.device_watch)
			app.device_watch->stop(); // no pass runs after this (the studio goes away below)
		if (app.studio)
			app.studio->set_check_scheduler(nullptr);
		app.moments->stop();
		app.panic->stop();
		app.outputs->stop_all(5000);
		app.outputs.reset();
		app.frames.reset(); // tick callback off and GPU objects freed while libobs runs (no grab in flight: API is off)
		app.previews.reset();
		app.hotkeys.reset();
		app.moments.reset();
		app.panic.reset();
		if (app.overlay)
			app.overlay->set_mic_level(nullptr); // the mic pump stops reading the studio before it goes
		app.audio_watch.reset(); // the watchdog stops touching the studio before it goes
		app.studio->teardown();
		app.studio.reset();
		face::set(nullptr); // no face filter is left; then tick callback off and mapping freed while libobs runs
		app.face.reset();
		if (app.overlay)
			app.overlay->stop(3000);
		app.overlay.reset();
		if (app.allow_browser)
			Sleep(1000); // let CEF finish closing the removed browser sources before obs_shutdown (P1a spike)
		if (!rc)
			discovery::remove_if_ours(app.discovery_path, GetCurrentProcessId());
	}
	stats::shutdown();
	obsrt::shutdown(app.config.audio_health.shutdown_guard_ms);
	hlog::info("exit %d", rc);
	hlog::close_file();
	CloseHandle(g_shutdown);
	g_shutdown = nullptr;
	return rc;
}
