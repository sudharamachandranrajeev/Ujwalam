// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: the host config file (--host-config <file.json>; A0 day 2). Strict: unknown keys are refused.
//
//   { "replay":   { "seconds": 30, "autoStart": false, "fallbackKbps": { "H": 12000, "V": 8000 } },
//     "hotkeys":  { "enabled": false, "panic": "Ctrl+Alt+P", "feedback": "Ctrl+Alt+F", "marker": "Ctrl+Alt+Shift+M" },
//     "feedbackDir": "<absolute dir>",                 default <dataDir>/feedback
//     "markersDir":  "<absolute dir>",                 default <dataDir>/markers
//     "eventCore": { "systemFile": "<absolute path to event-core system.json>" },
//     "audio": { "lowLatency": true },                  fixed 20 ms audio buffering (obs_runtime.h); default off
//     "audioHealth": { "enabled": true, "noDataMs": 5000, "checkIntervalMs": 1000, "maxRecreates": 3,
//                      "maxParked": 12, "shutdownGuardMs": 20000 },   audio health watchdog (audio_health.h); the launcher copies the
//                                                    values from data/audio/health.json. Absent: watchdog and guard off.
//     "monitoringDevice": "<Windows output name>" }   friendly name as devices.list shows it; default: the
//                                                     Windows default output. Applied only with --allow-devices (it opens an output).
//
// Defaults keep a bare host (tests, tools) quiet: no global hotkeys and no replay buffer unless the config turns them
// on (npm run alpha does). A hotkey value of null disables that binding. Combos: modifiers Ctrl, Alt, Shift, Win
// (at least one of Ctrl, Alt, Win) plus one key A-Z, 0-9 or F1-F24.
#pragma once

#include "json.h"
#include "outputs.h"

#include <string>
#include <utility>
#include <vector>

struct HostConfig {
	Outputs::ReplayConfig replay;
	bool replay_autostart = false;
	bool hotkeys_enabled = false;
	std::vector<std::pair<std::string, std::string>> hotkeys = {
		{"panic", "Ctrl+Alt+P"}, {"feedback", "Ctrl+Alt+F"}, {"marker", "Ctrl+Alt+Shift+M"}};
	std::string feedback_dir, markers_dir, core_system_file;
	bool low_latency_audio = false;
	std::string monitoring_device; // audio monitoring output, by friendly name (empty: Windows default)
	struct AudioHealth {
		bool enabled = false;          // recreate a device audio source that delivers no data
		uint32_t no_data_ms = 0;       // no audio packet for this long = missing
		uint32_t check_interval_ms = 0;
		uint32_t max_recreates = 0;    // per source per load; then the warning stays and nothing more is tried
		uint32_t max_parked = 0;       // replaced sources parked per process (all loads); then no more restarts
		uint32_t shutdown_guard_ms = 0; // obs_runtime.h shutdown guard; 0 = off
	} audio_health;
};

// Fills cfg from a parsed config document. false + err on any unknown key or bad value.
bool parse_host_config(const json::Value &doc, HostConfig &cfg, std::string &err);
