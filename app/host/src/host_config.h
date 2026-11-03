// SPDX-License-Identifier: GPL-2.0-or-later
// ujwalam-host: the host config file (--host-config <file.json>; A0 day 2). Strict: unknown keys are refused.
//
//   { "replay":   { "seconds": 30, "autoStart": false, "fallbackKbps": { "H": 12000, "V": 8000 } },
//     "hotkeys":  { "enabled": false, "panic": "Ctrl+Alt+P", "feedback": "Ctrl+Alt+F", "marker": "Ctrl+Alt+M" },
//     "feedbackDir": "<absolute dir>",                 default <dataDir>/feedback
//     "markersDir":  "<absolute dir>",                 default <dataDir>/markers
//     "eventCore": { "systemFile": "<absolute path to event-core system.json>" } }
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
		{"panic", "Ctrl+Alt+P"}, {"feedback", "Ctrl+Alt+F"}, {"marker", "Ctrl+Alt+M"}};
	std::string feedback_dir, markers_dir, core_system_file;
};

// Fills cfg from a parsed config document. false + err on any unknown key or bad value.
bool parse_host_config(const json::Value &doc, HostConfig &cfg, std::string &err);
