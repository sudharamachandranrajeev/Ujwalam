// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: libobs startup and shutdown (from app/spike/src/host.cpp, P1a).
#pragma once

#include <obs.h>

#include <cstdint>
#include <string>
#include <vector>

namespace obsrt {

struct Options {
	std::string runtime;    // OBS runtime dir (bin/64bit, data, obs-plugins)
	std::string config_dir; // libobs module config (never %APPDATA%)
	bool allow_devices = false; // win-dshow / win-wasapi; off by default (a device session needs the user's go)
	bool allow_browser = false; // obs-browser (CEF)
	uint32_t adapter = 0;
	uint32_t width = 1920, height = 1080, fps = 60;
	std::vector<std::string> plugin_roots;
};

// Puts <runtime>/bin/64bit first on PATH (obs.dll is delay-loaded), then obs_startup, module paths, disabled
// modules, video (D3D11) and audio (48 kHz stereo) reset, module load. Logs every module disabled for this run.
bool start(const Options &o, std::string &err);
void shutdown();

// Resets the main (H) canvas. Fails while outputs are active.
bool reset_main_video(uint32_t w, uint32_t h, uint32_t fps, std::string &err);
void main_video_info(uint32_t &w, uint32_t &h, uint32_t &fps_num, uint32_t &fps_den);

std::string adapter_name();
const std::vector<std::string> &disabled_modules();
std::vector<std::string> loaded_modules();
std::vector<std::string> encoder_types();
bool has_encoder(const char *id);
uint32_t sample_rate();

} // namespace obsrt
