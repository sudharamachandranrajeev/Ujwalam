// SPDX-License-Identifier: GPL-2.0-or-later
// ujwalam-host: the process-wide objects the RPC methods act on.
#pragma once

#include "host_config.h"
#include "hotkeys.h"
#include "moments.h"
#include "outputs.h"
#include "overlay.h"
#include "panic.h"
#include "preview.h"
#include "rpc_server.h"
#include "studio.h"

#include <atomic>
#include <map>
#include <memory>
#include <string>

struct App {
	std::string version = "0.1.0";
	std::string started_at;
	uint64_t start_tick = 0; // GetTickCount64 at start
	std::string data_dir, recordings_dir, discovery_path, log_path;
	std::wstring exe_path;
	bool allow_devices = false, allow_browser = false;
	bool allow_live = false; // --allow-live: real (non-loopback) stream targets (A0)
	bool test_hooks = false; // --test-hooks: hotkeys.trigger (tests only; never passed by the launchers)
	uint32_t adapter = 0;
	std::string session;      // host start, local time YYYYMMDD-HHMMSS (markers file name)
	std::string config_path;  // --host-config (empty = defaults)
	HostConfig config;

	std::unique_ptr<Studio> studio;
	std::unique_ptr<Outputs> outputs;
	std::unique_ptr<Previews> previews;
	std::unique_ptr<Overlay> overlay; // overlay server child; only with --allow-browser and --overlay-root
	std::unique_ptr<Panic> panic;     // A0 day 2: in-process panic + event-core notification (panic.h)
	std::unique_ptr<Moments> moments; // markers and feedback captures (moments.h)
	std::unique_ptr<Hotkeys> hotkeys; // global hotkeys (hotkeys.h)

	void *shutdown_event = nullptr; // HANDLE; set by host.shutdown or Ctrl+C
	std::atomic<bool> shutting_down{false};
	std::string shutdown_reason;
};

std::map<std::string, rpc::Method> make_methods(App &app);
json::Value host_status_json(App &app); // host.status (methods.cpp); also the feedback moment's stats
// Runs a hotkey's action (panic, feedback, marker); the hotkey thread and hotkeys.trigger call it.
void on_hotkey(App &app, const std::string &name, const char *via);
