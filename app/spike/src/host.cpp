// SPDX-License-Identifier: GPL-2.0-or-later
// ujwalam-spike: headless libobs host helpers.
#include "host.h"

#include <util/base.h>
#include <util/platform.h>

#include <windows.h>
#include <tlhelp32.h>

#include <algorithm>
#include <chrono>
#include <cstdarg>
#include <cstdio>
#include <filesystem>
#include <mutex>
#include <thread>

namespace fs = std::filesystem;

Size parse_size(const std::string &s, Size def)
{
	unsigned w = 0, h = 0;
	if (sscanf(s.c_str(), "%ux%u", &w, &h) == 2 && w && h)
		return {w, h};
	return def;
}

namespace host {

static FILE *g_log = nullptr;
static std::mutex g_log_mutex;
static std::string g_out;
static double g_shutdown_wait = 0;

std::string utc_now()
{
	FILETIME ft;
	GetSystemTimePreciseAsFileTime(&ft);
	SYSTEMTIME st;
	FileTimeToSystemTime(&ft, &st);
	char buf[64];
	snprintf(buf, sizeof(buf), "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ", st.wYear, st.wMonth, st.wDay, st.wHour,
		 st.wMinute, st.wSecond, st.wMilliseconds);
	return buf;
}

static void log_handler(int lvl, const char *msg, va_list args, void *)
{
	char buf[8192];
	vsnprintf(buf, sizeof(buf), msg, args);
	const char *tag = lvl <= LOG_ERROR ? "error" : lvl <= LOG_WARNING ? "warn" : lvl <= LOG_INFO ? "info" : "debug";
	std::lock_guard<std::mutex> lock(g_log_mutex);
	std::string ts = utc_now();
	if (lvl <= LOG_INFO)
		fprintf(stdout, "%s %s: %s\n", ts.c_str(), tag, buf);
	if (g_log) {
		fprintf(g_log, "%s %s: %s\n", ts.c_str(), tag, buf);
		fflush(g_log);
	}
}

void logf(const char *fmt, ...)
{
	char buf[8192];
	va_list args;
	va_start(args, fmt);
	vsnprintf(buf, sizeof(buf), fmt, args);
	va_end(args);
	blog(LOG_INFO, "[spike] %s", buf);
}

std::string out_dir()
{
	return g_out;
}

std::string out_path(const std::string &file)
{
	return (fs::path(g_out) / file).generic_string();
}

static std::string slash(const fs::path &p)
{
	std::string s = p.generic_string();
	if (!s.empty() && s.back() != '/')
		s += '/';
	return s;
}

// Default disabled modules. Frontend UI plugins need the Qt OBS frontend; device plugins are
// only allowed with --allow-devices (stage A never opens a capture device or microphone).
static std::vector<std::string> default_disabled(const Args &a)
{
	std::vector<std::string> d = {"frontend-tools", "decklink-output-ui", "aja-output-ui", "obs-websocket"};
	if (!a.has("allow-devices")) {
		d.push_back("win-dshow");
		d.push_back("win-wasapi");
	}
	for (auto &e : a.all("enable"))
		d.erase(std::remove(d.begin(), d.end(), e), d.end());
	for (auto &x : a.all("disable"))
		d.push_back(x);
	return d;
}

// Logs the exception code and the module that raised it, so a crash names its module.
static LONG WINAPI on_exception(EXCEPTION_POINTERS *ep)
{
	void *addr = ep->ExceptionRecord->ExceptionAddress;
	HMODULE mod = nullptr;
	char name[MAX_PATH] = "?";
	if (GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
			       (LPCSTR)addr, &mod))
		GetModuleFileNameA(mod, name, MAX_PATH);
	if (g_log) {
		fprintf(g_log, "%s CRASH: exception 0x%08lx at %p in %s (+0x%llx) thread %lu\n", utc_now().c_str(),
			ep->ExceptionRecord->ExceptionCode, addr, name,
			(unsigned long long)((char *)addr - (char *)mod), GetCurrentThreadId());
		fflush(g_log);
	}
	return EXCEPTION_CONTINUE_SEARCH;
}

bool start(const Args &a, Size base, Size output, uint32_t fps)
{
	fs::path runtime = fs::absolute(a.get("runtime"));
	g_out = fs::absolute(a.get("out")).generic_string();
	fs::create_directories(g_out);

	// libobs, its graphics module and plugin dependencies live in <runtime>/bin/64bit. os_dlopen
	// resets SetDllDirectory after each module, so the process PATH is used instead.
	fs::path bin = runtime / "bin" / "64bit";
	std::wstring path = bin.wstring() + L";";
	wchar_t old[32767];
	DWORD n = GetEnvironmentVariableW(L"PATH", old, 32767);
	if (n && n < 32767)
		path += old;
	SetEnvironmentVariableW(L"PATH", path.c_str());

	// First-chance handler for fatal codes only (breakpoint, access violation, stack buffer overrun).
	AddVectoredExceptionHandler(1, [](EXCEPTION_POINTERS *ep) -> LONG {
		DWORD code = ep->ExceptionRecord->ExceptionCode;
		if (code == 0x80000003 || code == 0xC0000005 || code == 0xC0000409)
			on_exception(ep);
		return EXCEPTION_CONTINUE_SEARCH;
	});

	g_shutdown_wait = a.getd("shutdown-wait", 0);
	std::string log_name = a.get("log", a.cmd + ".log");
	g_log = fopen(out_path(log_name).c_str(), "w");
	base_set_log_handler(log_handler, nullptr); // first libobs call: triggers the delay-load of obs.dll

	std::string config = fs::absolute(a.get("config", out_path("module-config"))).generic_string();
	fs::create_directories(config);
	logf("ujwalam-spike %s | libobs %s | started %s", a.cmd.c_str(), obs_get_version_string(), utc_now().c_str());
	logf("runtime=%s out=%s module-config=%s", runtime.generic_string().c_str(), g_out.c_str(), config.c_str());

	if (!obs_startup("en-US", config.c_str(), nullptr)) {
		logf("FAIL obs_startup");
		return false;
	}

	obs_add_data_path(slash(runtime / "data" / "libobs").c_str());
	obs_add_module_path(slash(runtime / "obs-plugins" / "64bit").c_str(),
			    (slash(runtime / "data" / "obs-plugins") + "%module%").c_str());
	for (auto &root : a.all("plugin-root")) {
		fs::path r = fs::absolute(root);
		std::string b = (r.generic_string() + "/%module%/bin/64bit");
		std::string d = (r.generic_string() + "/%module%/data");
		obs_add_module_path(b.c_str(), d.c_str());
		logf("plugin module path: bin=%s data=%s", b.c_str(), d.c_str());
	}
	for (auto &m : default_disabled(a)) {
		obs_add_disabled_module(m.c_str());
		logf("module disabled for this run: %s", m.c_str());
	}

	struct obs_video_info ovi = {};
	ovi.graphics_module = "libobs-d3d11";
	ovi.fps_num = fps;
	ovi.fps_den = 1;
	ovi.base_width = base.w;
	ovi.base_height = base.h;
	ovi.output_width = output.w;
	ovi.output_height = output.h;
	ovi.output_format = VIDEO_FORMAT_NV12;
	ovi.adapter = (uint32_t)a.geti("adapter", 0);
	ovi.gpu_conversion = true;
	ovi.colorspace = VIDEO_CS_709;
	ovi.range = VIDEO_RANGE_PARTIAL;
	ovi.scale_type = OBS_SCALE_BICUBIC;
	int rc = obs_reset_video(&ovi);
	if (rc != OBS_VIDEO_SUCCESS) {
		logf("FAIL obs_reset_video rc=%d", rc);
		return false;
	}
	logf("main video: base %ux%u output %ux%u @%u NV12 709 partial", base.w, base.h, output.w, output.h, fps);

	struct obs_audio_info oai = {};
	oai.samples_per_sec = 48000;
	oai.speakers = SPEAKERS_STEREO;
	if (!obs_reset_audio(&oai)) {
		logf("FAIL obs_reset_audio");
		return false;
	}
	logf("audio: 48000 Hz stereo");

	struct obs_module_failure_info mfi = {};
	obs_load_all_modules2(&mfi);
	for (size_t i = 0; i < mfi.count; i++)
		logf("MODULE LOAD FAILURE: %s", mfi.failed_modules[i]);
	logf("module load failures: %zu", mfi.count);
	obs_module_failure_info_free(&mfi);
	obs_post_load_modules();
	obs_log_loaded_modules();
	return true;
}

void shutdown()
{
	obs_set_output_source(0, nullptr);
	if (g_shutdown_wait > 0) {
		// Released sources are destroyed on libobs' destruction thread; give browser sources
		// time to close their CEF browsers before the module (and CEF) is unloaded.
		logf("waiting %.1fs before obs_shutdown", g_shutdown_wait);
		std::this_thread::sleep_for(std::chrono::milliseconds((int)(g_shutdown_wait * 1000)));
	}
	logf("obs_shutdown begin %s", utc_now().c_str());
	obs_shutdown();
	if (g_log) {
		fprintf(g_log, "%s info: [spike] obs_shutdown returned\n", utc_now().c_str());
		fflush(g_log);
	}
	blog(LOG_INFO, "[spike] memory leaks: %ld", bnum_allocs());
	if (g_log) {
		fclose(g_log);
		g_log = nullptr;
	}
}

std::string adapter_name()
{
	struct obs_video_info ovi = {};
	obs_get_video_info(&ovi);
	struct Find {
		uint32_t want;
		std::string name;
	} f = {ovi.adapter, ""};
	obs_enter_graphics();
	const char *dev = gs_get_device_name();
	gs_enum_adapters(
		[](void *p, const char *name, uint32_t id) {
			auto *f = static_cast<Find *>(p);
			logf("adapter %u: %s", id, name);
			if (id == f->want)
				f->name = name;
			return true;
		},
		&f);
	obs_leave_graphics();
	logf("graphics device %s on adapter index %u: %s", dev ? dev : "?", ovi.adapter, f.name.c_str());
	return f.name;
}

void log_modules()
{
	obs_enum_modules(
		[](void *, obs_module_t *m) {
			const char *name = obs_get_module_name(m);
			logf("module loaded: %s (%s)", obs_get_module_file_name(m), name ? name : "");
		},
		nullptr);
}

void log_types()
{
	const char *id;
	for (size_t i = 0; obs_enum_encoder_types(i, &id); i++)
		logf("encoder type: %s (%s)", id, obs_encoder_get_display_name(id));
	for (size_t i = 0; obs_enum_input_types(i, &id); i++)
		logf("input type: %s", id);
	for (size_t i = 0; obs_enum_filter_types(i, &id); i++)
		logf("filter type: %s", id);
	for (size_t i = 0; obs_enum_transition_types(i, &id); i++)
		logf("transition type: %s", id);
	for (size_t i = 0; obs_enum_output_types(i, &id); i++)
		logf("output type: %s", id);
}

obs_data_t *data_from_json_arg(const std::string &json)
{
	if (json.empty())
		return obs_data_create();
	obs_data_t *d = obs_data_create_from_json(json.c_str());
	return d ? d : obs_data_create();
}

obs_encoder_t *make_video_encoder(const Args &a, const char *name, video_t *video, uint32_t scaled_w,
				  uint32_t scaled_h, bool gpu_scale)
{
	std::string id = a.get("encoder", "obs_nvenc_h264_tex");
	obs_data_t *s = obs_data_create();
	obs_data_set_string(s, "rate_control", "CBR");
	obs_data_set_int(s, "bitrate", a.geti("bitrate", 8000));
	obs_data_set_int(s, "keyint_sec", a.geti("keyint", 2));
	obs_data_set_string(s, "preset", "p5");
	obs_data_set_string(s, "tune", "hq");
	obs_data_set_string(s, "profile", "high");
	obs_data_set_int(s, "bf", 2);
	obs_encoder_t *enc = obs_video_encoder_create(id.c_str(), name, s, nullptr);
	obs_data_release(s);
	if (!enc) {
		logf("FAIL create video encoder %s", id.c_str());
		return nullptr;
	}
	obs_encoder_set_video(enc, video);
	if (scaled_w && scaled_h) {
		if (gpu_scale)
			obs_encoder_set_gpu_scale_type(enc, OBS_SCALE_BICUBIC);
		obs_encoder_set_scaled_size(enc, scaled_w, scaled_h);
	}
	return enc;
}

obs_encoder_t *make_audio_encoder(const char *name, size_t mixer_idx)
{
	obs_data_t *s = obs_data_create();
	obs_data_set_int(s, "bitrate", 160);
	obs_encoder_t *enc = obs_audio_encoder_create("ffmpeg_aac", name, s, mixer_idx, nullptr);
	obs_data_release(s);
	if (!enc) {
		logf("FAIL create audio encoder ffmpeg_aac");
		return nullptr;
	}
	obs_encoder_set_audio(enc, obs_get_audio());
	return enc;
}

static void on_output_signal(void *param, calldata_t *cd)
{
	const char *what = static_cast<const char *>(param);
	obs_output_t *out = static_cast<obs_output_t *>(calldata_ptr(cd, "output"));
	long long code = 0;
	calldata_get_int(cd, "code", &code);
	logf("output '%s' signal %s at %s (code %lld)", out ? obs_output_get_name(out) : "?", what, utc_now().c_str(),
	     code);
}

obs_output_t *make_file_output(const char *name, const std::string &path, obs_encoder_t *venc, obs_encoder_t *aenc)
{
	obs_data_t *s = obs_data_create();
	obs_data_set_string(s, "path", path.c_str());
	obs_output_t *out = obs_output_create("ffmpeg_muxer", name, s, nullptr);
	obs_data_release(s);
	if (!out) {
		logf("FAIL create output ffmpeg_muxer %s", name);
		return nullptr;
	}
	obs_output_set_video_encoder(out, venc);
	if (aenc)
		obs_output_set_audio_encoder(out, aenc, 0);
	signal_handler_t *sh = obs_output_get_signal_handler(out);
	signal_handler_connect(sh, "start", on_output_signal, (void *)"start");
	signal_handler_connect(sh, "stop", on_output_signal, (void *)"stop");
	logf("output %s -> %s", name, path.c_str());
	return out;
}

void log_encoder(obs_encoder_t *enc)
{
	if (!enc)
		return;
	video_t *v = obs_encoder_video(enc);
	const struct video_output_info *voi = v ? video_output_get_info(v) : nullptr;
	obs_data_t *s = obs_encoder_get_settings(enc);
	logf("encoder '%s' id=%s codec=%s size=%ux%u scaling=%d gpu_scaling=%d scale_type=%d "
	     "video_mix=%ux%u fps=%u/%u active=%d settings=%s",
	     obs_encoder_get_name(enc), obs_encoder_get_id(enc), obs_encoder_get_codec(enc),
	     obs_encoder_get_width(enc), obs_encoder_get_height(enc), (int)obs_encoder_scaling_enabled(enc),
	     (int)obs_encoder_gpu_scaling_enabled(enc), (int)obs_encoder_get_scale_type(enc), voi ? voi->width : 0,
	     voi ? voi->height : 0, voi ? voi->fps_num : 0, voi ? voi->fps_den : 0, (int)obs_encoder_active(enc),
	     obs_data_get_json(s));
	obs_data_release(s);
}

bool start_output(obs_output_t *out)
{
	logf("starting output '%s' at %s", obs_output_get_name(out), utc_now().c_str());
	if (!obs_output_start(out)) {
		const char *err = obs_output_get_last_error(out);
		logf("FAIL output start '%s': %s", obs_output_get_name(out), err ? err : "(no error text)");
		return false;
	}
	return true;
}

void stop_output(obs_output_t *out)
{
	if (!out)
		return;
	logf("stopping output '%s' at %s", obs_output_get_name(out), utc_now().c_str());
	obs_output_stop(out);
	for (int i = 0; i < 100 && obs_output_active(out); i++)
		std::this_thread::sleep_for(std::chrono::milliseconds(100));
	log_output_stats(out);
}

void log_output_stats(obs_output_t *out)
{
	logf("output '%s' total_frames=%d dropped=%d bytes=%llu active=%d", obs_output_get_name(out),
	     obs_output_get_total_frames(out), obs_output_get_frames_dropped(out),
	     (unsigned long long)obs_output_get_total_bytes(out), (int)obs_output_active(out));
}

bool run_for(double seconds, const std::vector<obs_output_t *> &outs, const char *tag)
{
	auto t0 = std::chrono::steady_clock::now();
	uint32_t lag0 = obs_get_lagged_frames(), tot0 = obs_get_total_frames();
	bool ok = true;
	int tick = 0;
	while (std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count() < seconds) {
		std::this_thread::sleep_for(std::chrono::milliseconds(250));
		if (++tick % 4 == 0)
			logf("[%s] t=%.1fs render_avg=%.2fms active_fps=%.2f lagged=%u/%u", tag,
			     std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count(),
			     obs_get_average_frame_time_ns() / 1e6, obs_get_active_fps(),
			     obs_get_lagged_frames() - lag0, obs_get_total_frames() - tot0);
		for (auto *o : outs) {
			if (o && !obs_output_active(o)) {
				logf("output '%s' stopped early", obs_output_get_name(o));
				ok = false;
			}
		}
		if (!ok)
			break;
	}
	return ok;
}

bool live_app_running(std::string &which)
{
	which.clear();
	HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
	if (snap == INVALID_HANDLE_VALUE)
		return false;
	PROCESSENTRY32W pe = {sizeof(pe)};
	for (BOOL ok = Process32FirstW(snap, &pe); ok; ok = Process32NextW(snap, &pe)) {
		std::wstring n = pe.szExeFile;
		std::transform(n.begin(), n.end(), n.begin(), ::towlower);
		if (n.rfind(L"meldstudio", 0) == 0 || n == L"obs64.exe") {
			which += std::string(n.begin(), n.end()) + " ";
		}
	}
	CloseHandle(snap);
	return !which.empty();
}

void CpuSampler::begin()
{
	if (info)
		os_cpu_usage_info_destroy((os_cpu_usage_info_t *)info);
	info = os_cpu_usage_info_start();
}

double CpuSampler::query()
{
	return info ? os_cpu_usage_info_query((os_cpu_usage_info_t *)info) : 0.0;
}

CpuSampler::~CpuSampler()
{
	if (info)
		os_cpu_usage_info_destroy((os_cpu_usage_info_t *)info);
}

} // namespace host
