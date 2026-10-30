// SPDX-License-Identifier: GPL-2.0-or-later
// ujwalam-host: health numbers. See stats.h.
#include "stats.h"
#include "log.h"

#include <obs.h>
#include <util/platform.h>

#include <windows.h>
#include <psapi.h>

#include <mutex>

namespace stats {

namespace {

// NVML subset (nvml.h is not vendored; these signatures are the stable public NVML C API).
typedef int nvmlReturn_t;
typedef struct nvmlDevice_st *nvmlDevice_t;
struct nvmlUtilization_t {
	unsigned int gpu;
	unsigned int memory;
};
struct nvmlMemory_t {
	unsigned long long total;
	unsigned long long free;
	unsigned long long used;
};

struct Nvml {
	HMODULE dll = nullptr;
	nvmlReturn_t (*Init)() = nullptr;
	nvmlReturn_t (*Shutdown)() = nullptr;
	nvmlReturn_t (*GetHandleByIndex)(unsigned int, nvmlDevice_t *) = nullptr;
	nvmlReturn_t (*GetName)(nvmlDevice_t, char *, unsigned int) = nullptr;
	nvmlReturn_t (*GetUtilization)(nvmlDevice_t, nvmlUtilization_t *) = nullptr;
	nvmlReturn_t (*GetEncoderUtilization)(nvmlDevice_t, unsigned int *, unsigned int *) = nullptr;
	nvmlReturn_t (*GetEncoderStats)(nvmlDevice_t, unsigned int *, unsigned int *, unsigned int *) = nullptr;
	nvmlReturn_t (*GetMemoryInfo)(nvmlDevice_t, nvmlMemory_t *) = nullptr;
	nvmlDevice_t dev = nullptr;
	std::string name;
	bool ok = false;
};

Nvml g_nvml;
std::mutex g_m;
os_cpu_usage_info_t *g_cpu = nullptr;
double g_cpu_last = -1;
uint64_t g_cpu_last_ns = 0;

template <class F> bool load_fn(HMODULE m, const char *name, F &out)
{
	out = reinterpret_cast<F>(GetProcAddress(m, name));
	return out != nullptr;
}

} // namespace

void init()
{
	std::lock_guard<std::mutex> l(g_m);
	if (!g_cpu)
		g_cpu = os_cpu_usage_info_start();
	if (g_nvml.dll)
		return;
	wchar_t sys[MAX_PATH];
	UINT n = GetSystemDirectoryW(sys, MAX_PATH);
	if (!n || n >= MAX_PATH)
		return;
	std::wstring path = std::wstring(sys) + L"\\nvml.dll"; // System32 only, never the search path
	HMODULE m = LoadLibraryExW(path.c_str(), nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
	if (!m) {
		hlog::info("stats: NVML not available (no nvml.dll in System32); GPU fields will be null");
		return;
	}
	Nvml &v = g_nvml;
	v.dll = m;
	bool ok = load_fn(m, "nvmlInit_v2", v.Init) && load_fn(m, "nvmlShutdown", v.Shutdown) &&
		  load_fn(m, "nvmlDeviceGetHandleByIndex_v2", v.GetHandleByIndex) &&
		  load_fn(m, "nvmlDeviceGetName", v.GetName) &&
		  load_fn(m, "nvmlDeviceGetUtilizationRates", v.GetUtilization) &&
		  load_fn(m, "nvmlDeviceGetEncoderUtilization", v.GetEncoderUtilization) &&
		  load_fn(m, "nvmlDeviceGetEncoderStats", v.GetEncoderStats) &&
		  load_fn(m, "nvmlDeviceGetMemoryInfo", v.GetMemoryInfo);
	if (!ok || v.Init() != 0 || v.GetHandleByIndex(0, &v.dev) != 0) {
		hlog::warn("stats: NVML present but could not be initialised; GPU fields will be null");
		v.dev = nullptr;
		return;
	}
	char name[96] = {};
	if (v.GetName(v.dev, name, sizeof(name)) == 0)
		v.name = name;
	v.ok = true;
	hlog::info("stats: NVML device 0: %s", v.name.c_str());
}

void shutdown()
{
	std::lock_guard<std::mutex> l(g_m);
	if (g_nvml.ok && g_nvml.Shutdown)
		g_nvml.Shutdown();
	g_nvml.ok = false;
	g_nvml.dev = nullptr;
	if (g_nvml.dll)
		FreeLibrary(g_nvml.dll);
	g_nvml.dll = nullptr;
	if (g_cpu)
		os_cpu_usage_info_destroy(g_cpu);
	g_cpu = nullptr;
}

json::Value render()
{
	json::Value o = json::Value::object();
	struct obs_video_info ovi = {};
	bool have = obs_get_video_info(&ovi);
	o.set("fps", obs_get_active_fps());
	o.set("targetFps", have && ovi.fps_den ? (double)ovi.fps_num / ovi.fps_den : 0.0);
	o.set("avgFrameTimeMs", (double)obs_get_average_frame_time_ns() / 1e6);
	o.set("renderLagged", (uint64_t)obs_get_lagged_frames());
	o.set("renderTotal", (uint64_t)obs_get_total_frames());
	video_t *v = obs_get_video();
	o.set("encodeSkipped", v ? (uint64_t)video_output_get_skipped_frames(v) : (uint64_t)0);
	o.set("encodeTotal", v ? (uint64_t)video_output_get_total_frames(v) : (uint64_t)0);
	return o;
}

double cpu_pct()
{
	std::lock_guard<std::mutex> l(g_m);
	if (!g_cpu)
		return -1;
	// os_cpu_usage_info_query measures since the previous call; sample at most every 500 ms so concurrent
	// status calls do not shrink the window to nothing.
	uint64_t now = os_gettime_ns();
	if (g_cpu_last < 0 || now - g_cpu_last_ns >= 500000000ULL) {
		g_cpu_last = os_cpu_usage_info_query(g_cpu);
		g_cpu_last_ns = now;
	}
	return g_cpu_last;
}

json::Value memory()
{
	json::Value o = json::Value::object();
	PROCESS_MEMORY_COUNTERS_EX pmc = {};
	pmc.cb = sizeof(pmc);
	if (GetProcessMemoryInfo(GetCurrentProcess(), (PROCESS_MEMORY_COUNTERS *)&pmc, sizeof(pmc))) {
		o.set("workingSetMB", (double)pmc.WorkingSetSize / (1024.0 * 1024.0));
		o.set("privateMB", (double)pmc.PrivateUsage / (1024.0 * 1024.0));
	}
	return o;
}

json::Value gpu()
{
	std::lock_guard<std::mutex> l(g_m);
	json::Value o = json::Value::object();
	Nvml &v = g_nvml;
	o.set("available", v.ok);
	if (!v.ok)
		return o;
	o.set("index", 0);
	o.set("name", v.name);
	nvmlUtilization_t u = {};
	if (v.GetUtilization(v.dev, &u) == 0) {
		o.set("gpuPct", (int)u.gpu);
		o.set("memPct", (int)u.memory);
	}
	unsigned int enc = 0, period = 0;
	if (v.GetEncoderUtilization(v.dev, &enc, &period) == 0)
		o.set("encoderPct", (int)enc);
	unsigned int sessions = 0, avg_fps = 0, avg_lat = 0;
	if (v.GetEncoderStats(v.dev, &sessions, &avg_fps, &avg_lat) == 0) {
		o.set("encoderSessions", (int)sessions);
		o.set("encoderAvgFps", (int)avg_fps);
		o.set("encoderAvgLatencyUs", (int)avg_lat);
	}
	nvmlMemory_t mem = {};
	if (v.GetMemoryInfo(v.dev, &mem) == 0) {
		o.set("memUsedMB", (double)mem.used / (1024.0 * 1024.0));
		o.set("memTotalMB", (double)mem.total / (1024.0 * 1024.0));
	}
	return o;
}

int encoder_sessions()
{
	std::lock_guard<std::mutex> l(g_m);
	if (!g_nvml.ok)
		return -1;
	unsigned int sessions = 0, avg_fps = 0, avg_lat = 0;
	if (g_nvml.GetEncoderStats(g_nvml.dev, &sessions, &avg_fps, &avg_lat) != 0)
		return -1;
	return (int)sessions;
}

static std::string narrow(const std::wstring &w)
{
	if (w.empty())
		return {};
	int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), nullptr, 0, nullptr, nullptr);
	std::string s((size_t)n, '\0');
	WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), s.data(), n, nullptr, nullptr);
	return s;
}

json::Value gpu_preference(const std::wstring &exe_path)
{
	json::Value o = json::Value::object();
	o.set("key", "HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences");
	o.set("exe", narrow(exe_path));
	HKEY k = nullptr;
	if (RegOpenKeyExW(HKEY_CURRENT_USER, L"Software\\Microsoft\\DirectX\\UserGpuPreferences", 0, KEY_QUERY_VALUE,
			  &k) != ERROR_SUCCESS) {
		o.set("set", false);
		o.set("gpuPreference", nullptr);
		return o;
	}
	wchar_t buf[256] = {};
	DWORD type = 0, size = sizeof(buf) - sizeof(wchar_t);
	LSTATUS rc = RegQueryValueExW(k, exe_path.c_str(), nullptr, &type, (LPBYTE)buf, &size);
	RegCloseKey(k);
	if (rc != ERROR_SUCCESS || type != REG_SZ) {
		o.set("set", false);
		o.set("gpuPreference", nullptr);
		return o;
	}
	std::wstring val(buf);
	o.set("set", true);
	o.set("value", narrow(val));
	// Value format: "GpuPreference=N;" (other key=value pairs may follow).
	size_t p = val.find(L"GpuPreference=");
	if (p != std::wstring::npos && p + 14 < val.size() && iswdigit(val[p + 14]))
		o.set("gpuPreference", (int)(val[p + 14] - L'0'));
	else
		o.set("gpuPreference", nullptr);
	return o;
}

} // namespace stats
