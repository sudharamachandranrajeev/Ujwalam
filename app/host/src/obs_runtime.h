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
	// Low-latency audio buffering (OBS "Low Latency Audio Buffering Mode"): fixed 20 ms instead of growing up to
	// 960 ms when a source is late. Cuts the delay of everything heard through monitoring (headphones); a source that
	// delivers late audio is cut short instead of delaying the whole mix.
	bool low_latency_audio = false;
	uint32_t width = 1920, height = 1080, fps = 60;
	std::vector<std::string> plugin_roots;
};

// Puts <runtime>/bin/64bit first on PATH (obs.dll is delay-loaded), then obs_startup, module paths, disabled
// modules, video (D3D11) and audio (48 kHz stereo) reset, module load. Logs every module disabled for this run.
// Also takes a process-lifetime reference on the Windows real-time work queue platform (RtwqStartup, as the OBS
// frontend does in obs-main.cpp): win-wasapi runs its capture on the shared RTWQ "Capture" queue whenever
// RTWorkQ.dll is loaded, and without a reference held by the process any other component's RtwqShutdown /
// MFShutdown can take the platform down under it (MF_E_SHUTDOWN 0xC00D3E85, MF_E_INVALID_WORKQUEUE 0xC00D36FF:
// the source stops for good; docs/evidence/2026-11-08-game-audio-loss.md).
bool start(const Options &o, std::string &err);
// guard_ms > 0: if obs_shutdown has not returned after guard_ms (a source's destroy is stuck, e.g. a WASAPI source
// whose work queue died), the reason is logged and the process ends with exit code kShutdownGuardExit. Outputs are
// already stopped and released by then.
void shutdown(uint32_t guard_ms = 0);
constexpr int kShutdownGuardExit = 9;
bool rtwq_held(); // the RtwqStartup reference above is held

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
