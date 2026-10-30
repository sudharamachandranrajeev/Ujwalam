// SPDX-License-Identifier: GPL-2.0-or-later
// ujwalam-host: the process-wide objects the RPC methods act on.
#pragma once

#include "outputs.h"
#include "overlay.h"
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
	uint32_t adapter = 0;

	std::unique_ptr<Studio> studio;
	std::unique_ptr<Outputs> outputs;
	std::unique_ptr<Previews> previews;
	std::unique_ptr<Overlay> overlay; // overlay server child; only with --allow-browser and --overlay-root

	void *shutdown_event = nullptr; // HANDLE; set by host.shutdown or Ctrl+C
	std::atomic<bool> shutting_down{false};
	std::string shutdown_reason;
};

std::map<std::string, rpc::Method> make_methods(App &app);
