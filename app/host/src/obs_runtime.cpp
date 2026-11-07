// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: libobs startup and shutdown. Startup sequence and host facts from P1a
// (docs/evidence/2026-10-27-p1a-build.md): PATH (not SetDllDirectory) for the runtime bin dir, helper exes next to
// the host exe, module config under the host data dir.
#include "obs_runtime.h"
#include "effects.h"
#include "log.h"

#include <windows.h>

#include <filesystem>

namespace fs = std::filesystem;

namespace obsrt {

static std::vector<std::string> g_disabled;
static uint32_t g_adapter = 0;

static std::string slash(const fs::path &p)
{
	std::string s = p.generic_string();
	if (!s.empty() && s.back() != '/')
		s += '/';
	return s;
}

// Modules not loaded by default, and why:
//   frontend-tools, decklink-output-ui, aja-output-ui: need the Qt OBS frontend.
//   obs-websocket: P15 (own API is used instead).
//   rtmp-services, win-capture: contact obsproject.com at startup (P1a); the host registers its own loopback service.
//   obs-webrtc: WHIP output, not used in v1.
//   decklink, decklink-captions, aja: capture hardware. win-dshow, win-wasapi: devices (only with --allow-devices).
//   vlc-video: needs a VLC install. nv-filters: NVIDIA effects SDK, not used. obs-vst: not used.
//   obs-browser: CEF, only with --allow-browser.
static std::vector<std::string> disabled_for(const Options &o)
{
	std::vector<std::string> d = {"frontend-tools", "decklink-output-ui", "aja-output-ui", "obs-websocket",
				      "rtmp-services",  "win-capture",        "obs-webrtc",    "decklink",
				      "decklink-captions", "aja",             "vlc-video",     "nv-filters",
				      "obs-vst"};
	if (!o.allow_devices) {
		d.push_back("win-dshow");
		d.push_back("win-wasapi");
	}
	if (!o.allow_browser)
		d.push_back("obs-browser");
	return d;
}

bool start(const Options &o, std::string &err)
{
	fs::path runtime = fs::absolute(fs::u8path(o.runtime));
	fs::path bin = runtime / "bin" / "64bit";
	if (!fs::exists(bin / "obs.dll")) {
		err = "obs.dll not found under <runtime>/bin/64bit";
		return false;
	}
	// libobs, its graphics module and plugin dependencies live in <runtime>/bin/64bit. os_dlopen resets
	// SetDllDirectory after each module, so the process PATH is used instead.
	std::wstring path = bin.wstring() + L";";
	std::vector<wchar_t> old(32767);
	DWORD n = GetEnvironmentVariableW(L"PATH", old.data(), (DWORD)old.size());
	if (n && n < old.size())
		path += old.data();
	SetEnvironmentVariableW(L"PATH", path.c_str());

	hlog::install_obs_handler(); // first libobs call: triggers the delay-load of obs.dll
	fs::create_directories(fs::u8path(o.config_dir));
	hlog::info("ujwalam-host | libobs %s | runtime=%s module-config=%s", obs_get_version_string(),
		   runtime.generic_string().c_str(), fs::u8path(o.config_dir).generic_string().c_str());

	if (!obs_startup("en-US", fs::u8path(o.config_dir).generic_string().c_str(), nullptr)) {
		err = "obs_startup failed";
		return false;
	}
	obs_add_data_path(slash(runtime / "data" / "libobs").c_str());
	obs_add_module_path(slash(runtime / "obs-plugins" / "64bit").c_str(),
			    (slash(runtime / "data" / "obs-plugins") + "%module%").c_str());
	for (auto &root : o.plugin_roots) {
		std::string r = fs::absolute(fs::u8path(root)).generic_string();
		obs_add_module_path((r + "/%module%/bin/64bit").c_str(), (r + "/%module%/data").c_str());
	}
	g_disabled = disabled_for(o);
	for (auto &m : g_disabled) {
		obs_add_disabled_module(m.c_str());
		hlog::info("module disabled for this run: %s", m.c_str());
	}

	struct obs_video_info ovi = {};
	ovi.graphics_module = "libobs-d3d11";
	ovi.fps_num = o.fps;
	ovi.fps_den = 1;
	ovi.base_width = ovi.output_width = o.width;
	ovi.base_height = ovi.output_height = o.height;
	ovi.output_format = VIDEO_FORMAT_NV12;
	ovi.adapter = o.adapter;
	ovi.gpu_conversion = true;
	ovi.colorspace = VIDEO_CS_709;
	ovi.range = VIDEO_RANGE_PARTIAL;
	ovi.scale_type = OBS_SCALE_BICUBIC;
	g_adapter = o.adapter;
	int rc = obs_reset_video(&ovi);
	if (rc != OBS_VIDEO_SUCCESS) {
		err = "obs_reset_video failed rc=" + std::to_string(rc);
		return false;
	}
	struct obs_audio_info2 oai = {};
	oai.samples_per_sec = 48000;
	oai.speakers = SPEAKERS_STEREO;
	oai.max_buffering_ms = o.low_latency_audio ? 20 : 1000; // the values OBS uses for its low-latency mode
	oai.fixed_buffering = o.low_latency_audio;
	if (!obs_reset_audio2(&oai)) {
		err = "obs_reset_audio2 failed";
		return false;
	}
	hlog::info("audio buffering: %s", o.low_latency_audio ? "low latency (fixed 20 ms)" : "default (grows up to 1 s)");
	struct obs_module_failure_info mfi = {};
	obs_load_all_modules2(&mfi);
	for (size_t i = 0; i < mfi.count; i++)
		hlog::warn("MODULE LOAD FAILURE: %s", mfi.failed_modules[i]);
	obs_module_failure_info_free(&mfi);
	obs_post_load_modules();
	obs_log_loaded_modules();
	fx::register_types(); // host-owned effect sources (effects.h)
	hlog::info("main video %ux%u@%u NV12 709 partial; audio 48000 Hz stereo; adapter %s", o.width, o.height, o.fps,
		   adapter_name().c_str());
	return true;
}

void shutdown()
{
	obs_set_output_source(0, nullptr);
	hlog::info("obs_shutdown begin");
	obs_shutdown();
	hlog::info("obs_shutdown returned; leaks=%ld", bnum_allocs());
}

bool reset_main_video(uint32_t w, uint32_t h, uint32_t fps, std::string &err)
{
	struct obs_video_info ovi = {};
	obs_get_video_info(&ovi);
	if (ovi.base_width == w && ovi.base_height == h && ovi.fps_num == fps && ovi.fps_den == 1)
		return true;
	ovi.base_width = ovi.output_width = w;
	ovi.base_height = ovi.output_height = h;
	ovi.fps_num = fps;
	ovi.fps_den = 1;
	int rc = obs_reset_video(&ovi);
	if (rc != OBS_VIDEO_SUCCESS) {
		err = rc == OBS_VIDEO_CURRENTLY_ACTIVE ? "outputs active" : "obs_reset_video rc=" + std::to_string(rc);
		return false;
	}
	return true;
}

void main_video_info(uint32_t &w, uint32_t &h, uint32_t &fps_num, uint32_t &fps_den)
{
	struct obs_video_info ovi = {};
	obs_get_video_info(&ovi);
	w = ovi.base_width;
	h = ovi.base_height;
	fps_num = ovi.fps_num;
	fps_den = ovi.fps_den;
}

std::string adapter_name()
{
	struct Find {
		uint32_t want;
		std::string name;
	} f = {g_adapter, ""};
	obs_enter_graphics();
	gs_enum_adapters(
		[](void *p, const char *name, uint32_t id) {
			auto *f = static_cast<Find *>(p);
			if (id == f->want)
				f->name = name;
			return true;
		},
		&f);
	obs_leave_graphics();
	return f.name;
}

const std::vector<std::string> &disabled_modules()
{
	return g_disabled;
}

std::vector<std::string> loaded_modules()
{
	std::vector<std::string> v;
	obs_enum_modules(
		[](void *p, obs_module_t *m) { static_cast<std::vector<std::string> *>(p)->push_back(obs_get_module_file_name(m)); },
		&v);
	return v;
}

std::vector<std::string> encoder_types()
{
	std::vector<std::string> v;
	const char *id;
	for (size_t i = 0; obs_enum_encoder_types(i, &id); i++)
		v.push_back(id);
	return v;
}

bool has_encoder(const char *id)
{
	const char *t;
	for (size_t i = 0; obs_enum_encoder_types(i, &t); i++)
		if (strcmp(t, id) == 0)
			return true;
	return false;
}

uint32_t sample_rate()
{
	struct obs_audio_info oai = {};
	obs_get_audio_info(&oai);
	return oai.samples_per_sec;
}

} // namespace obsrt
