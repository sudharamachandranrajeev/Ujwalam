// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-spike: headless libobs host helpers (startup, logging, encoders, outputs, stats).
#pragma once

#include <obs.h>

#include <cstdint>
#include <map>
#include <string>
#include <vector>

struct Args {
	std::string cmd;
	std::map<std::string, std::vector<std::string>> kv;

	bool has(const std::string &k) const { return kv.count(k) != 0; }
	std::string get(const std::string &k, const std::string &def = "") const
	{
		auto it = kv.find(k);
		return it == kv.end() || it->second.empty() ? def : it->second.back();
	}
	std::vector<std::string> all(const std::string &k) const
	{
		auto it = kv.find(k);
		return it == kv.end() ? std::vector<std::string>{} : it->second;
	}
	int geti(const std::string &k, int def) const { return has(k) ? std::stoi(get(k)) : def; }
	double getd(const std::string &k, double def) const { return has(k) ? std::stod(get(k)) : def; }
};

struct Size {
	uint32_t w = 0, h = 0;
};
Size parse_size(const std::string &s, Size def);

namespace host {

// Prints to stdout and to <out>/<cmd>.log via the libobs log handler.
void logf(const char *fmt, ...);
std::string utc_now(); // ISO-8601 UTC with milliseconds

// Startup: DLL search path from --runtime, log file, obs_startup with a module config dir
// under --out (never %APPDATA%), module paths (runtime + each --plugin-root), disabled modules,
// obs_load_all_modules2 + obs_post_load_modules, main video (D3D11) and audio reset.
bool start(const Args &a, Size base, Size output, uint32_t fps);
void shutdown();

std::string out_dir();
std::string out_path(const std::string &file);

// Logs the D3D11 adapter in use and returns its name.
std::string adapter_name();
void log_modules();
void log_types();

obs_encoder_t *make_video_encoder(const Args &a, const char *name, video_t *video, uint32_t scaled_w = 0,
				  uint32_t scaled_h = 0, bool gpu_scale = true);
obs_encoder_t *make_audio_encoder(const char *name, size_t mixer_idx = 0);
obs_output_t *make_file_output(const char *name, const std::string &path, obs_encoder_t *venc, obs_encoder_t *aenc);
void log_encoder(obs_encoder_t *enc);

bool start_output(obs_output_t *out);
void stop_output(obs_output_t *out);
void log_output_stats(obs_output_t *out);

// Sleeps while logging render/lag stats once per second; returns false if any output stopped early.
bool run_for(double seconds, const std::vector<obs_output_t *> &outs, const char *tag);

// Encode safety: true if MeldStudio or obs64 is running (the GPU may be live).
bool live_app_running(std::string &which);

// CPU usage sampler (libobs os_cpu_usage_info), percent of all cores.
struct CpuSampler {
	void *info = nullptr;
	void begin();
	double query();
	~CpuSampler();
};

obs_data_t *data_from_json_arg(const std::string &json);

} // namespace host
