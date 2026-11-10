// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: device hot-plug watcher and the test capture source. See device_watch.h.
#include "device_watch.h"
#include "log.h"

#include <windows.h>

#include <cfgmgr32.h>

#include <obs.h>
#include <util/platform.h>

#include <algorithm>
#include <set>

namespace devwatch {

namespace {

// Interface classes (ks.h / ksmedia.h / mmdeviceapi.h values, written out so no extra header is needed).
const GUID kClasses[] = {
	{0x65E8773D, 0x8F56, 0x11D0, {0xA3, 0xB9, 0x00, 0xA0, 0xC9, 0x22, 0x31, 0x96}}, // KSCATEGORY_CAPTURE
	{0x6994AD05, 0x93EF, 0x11D0, {0xA3, 0xCC, 0x00, 0xA0, 0xC9, 0x22, 0x31, 0x96}}, // KSCATEGORY_VIDEO
	{0xE5323777, 0xF976, 0x4F5B, {0x9B, 0x55, 0xB9, 0x46, 0x99, 0xC4, 0x6E, 0x44}}, // KSCATEGORY_VIDEO_CAMERA
	{0x6994AD04, 0x93EF, 0x11D0, {0xA3, 0xCC, 0x00, 0xA0, 0xC9, 0x22, 0x31, 0x96}}, // KSCATEGORY_AUDIO
	{0x2EEF81BE, 0x33FA, 0x4800, {0x96, 0x70, 0x1C, 0xD4, 0x74, 0x97, 0x2C, 0x3F}}, // DEVINTERFACE_AUDIO_CAPTURE
	{0xE6327CAD, 0xDCEC, 0x4949, {0xAE, 0x8A, 0x99, 0x1E, 0x97, 0x6A, 0x79, 0xD2}}, // DEVINTERFACE_AUDIO_RENDER
};

DWORD CALLBACK cm_callback(HCMNOTIFICATION, PVOID ctx, CM_NOTIFY_ACTION action, PCM_NOTIFY_EVENT_DATA, DWORD)
{
	// System thread pool: note the time and return. Never list, open or unregister here.
	if (action == CM_NOTIFY_ACTION_DEVICEINTERFACEARRIVAL || action == CM_NOTIFY_ACTION_DEVICEINTERFACEREMOVAL)
		static_cast<Watcher *>(ctx)->poke();
	return ERROR_SUCCESS;
}

uint64_t now_ms()
{
	return GetTickCount64();
}

} // namespace

Watcher::Watcher(std::function<void()> on_change, uint32_t quiet_ms, uint32_t max_wait_ms)
	: on_change_(std::move(on_change)), quiet_ms_(quiet_ms), max_wait_ms_(max_wait_ms)
{
	th_ = std::thread([this] { run(); });
	for (const GUID &g : kClasses) {
		CM_NOTIFY_FILTER f = {};
		f.cbSize = sizeof f;
		f.FilterType = CM_NOTIFY_FILTER_TYPE_DEVICEINTERFACE;
		f.u.DeviceInterface.ClassGuid = g;
		HCMNOTIFICATION h = nullptr;
		CONFIGRET cr = CM_Register_Notification(&f, this, cm_callback, &h);
		if (cr == CR_SUCCESS && h) {
			regs_.push_back(h);
		} else if (error_.empty()) {
			char b[64];
			snprintf(b, sizeof b, "CM_Register_Notification: CONFIGRET %lu", (unsigned long)cr);
			error_ = b;
		}
	}
	hlog::info("device watcher: %zu of %zu interface classes watched%s%s", regs_.size(), std::size(kClasses),
		   error_.empty() ? "" : "; ", error_.c_str());
}

Watcher::~Watcher()
{
	stop();
}

void Watcher::stop()
{
	// Unregister first (waits for running callbacks; they only poke), then end the thread.
	for (void *h : regs_)
		CM_Unregister_Notification((HCMNOTIFICATION)h);
	regs_.clear();
	{
		std::lock_guard<std::mutex> lk(m_);
		quit_ = true;
	}
	cv_.notify_all();
	if (th_.joinable())
		th_.join();
}

void Watcher::poke()
{
	notifications_++;
	{
		std::lock_guard<std::mutex> lk(m_);
		uint64_t t = now_ms();
		if (!pending_)
			first_ms_ = t;
		pending_ = true;
		last_ms_ = t;
	}
	cv_.notify_all();
}

void Watcher::run()
{
	SetThreadDescription(GetCurrentThread(), L"ujw: device watcher");
	std::unique_lock<std::mutex> lk(m_);
	for (;;) {
		cv_.wait(lk, [this] { return quit_ || pending_; });
		if (quit_)
			return;
		// Debounce: quiet_ms after the last notification, at most max_wait_ms after the first.
		for (;;) {
			uint64_t t = now_ms();
			uint64_t due = std::min(last_ms_ + quiet_ms_, first_ms_ + max_wait_ms_);
			if (t >= due)
				break;
			cv_.wait_for(lk, std::chrono::milliseconds(due - t), [this] { return quit_; });
			if (quit_)
				return;
		}
		pending_ = false;
		lk.unlock();
		try {
			on_change_();
		} catch (const std::exception &e) {
			hlog::warn("device watcher: pass failed: %s", e.what());
		} catch (...) {
			hlog::warn("device watcher: pass failed");
		}
		passes_++;
		lk.lock();
	}
}

json::Value Watcher::status() const
{
	json::Value r = json::Value::object();
	std::lock_guard<std::mutex> lk(m_);
	r.set("watching", !regs_.empty());
	r.set("filters", (uint64_t)regs_.size());
	r.set("notifications", notifications_.load());
	r.set("passes", passes_.load());
	r.set("error", error_.empty() ? json::Value() : json::Value(error_));
	return r;
}

// ---- test capture source (--test-hooks only) ----

namespace {

std::mutex g_present_m;
std::set<std::string> g_present; // obs_ids of the connected fake video devices

bool present(const std::string &id)
{
	std::lock_guard<std::mutex> lk(g_present_m);
	return g_present.count(id) > 0;
}

struct FakeCapture {
	obs_source_t *src = nullptr;
	std::mutex m;
	std::string id;
	std::atomic<bool> quit{false};
	std::thread th;
};

constexpr uint32_t kW = 64, kH = 36;

void *cap_create(obs_data_t *s, obs_source_t *src)
{
	auto *f = new FakeCapture();
	f->src = src;
	f->id = obs_data_get_string(s, "video_device_id");
	f->th = std::thread([f]() {
		SetThreadDescription(GetCurrentThread(), L"ujw: test capture");
		std::vector<uint8_t> px(kW * kH * 4, 0);
		for (size_t i = 0; i < px.size(); i += 4) { // opaque green
			px[i + 1] = 0xB0;
			px[i + 3] = 0xFF;
		}
		while (!f->quit) {
			std::string id;
			{
				std::lock_guard<std::mutex> lk(f->m);
				id = f->id;
			}
			if (!id.empty() && present(id)) {
				obs_source_frame fr = {};
				fr.data[0] = px.data();
				fr.linesize[0] = kW * 4;
				fr.width = kW;
				fr.height = kH;
				fr.format = VIDEO_FORMAT_BGRA;
				fr.timestamp = os_gettime_ns();
				fr.full_range = true;
				obs_source_output_video(f->src, &fr);
			}
			Sleep(50);
		}
	});
	return f;
}

void cap_destroy(void *p)
{
	auto *f = static_cast<FakeCapture *>(p);
	f->quit = true;
	if (f->th.joinable())
		f->th.join();
	delete f;
}

void cap_update(void *p, obs_data_t *s)
{
	auto *f = static_cast<FakeCapture *>(p);
	std::lock_guard<std::mutex> lk(f->m);
	f->id = obs_data_get_string(s, "video_device_id");
}

const char *cap_name(void *)
{
	return "Ujwalam test capture";
}

} // namespace

void set_test_present(const std::vector<std::string> &obs_ids)
{
	std::lock_guard<std::mutex> lk(g_present_m);
	g_present = std::set<std::string>(obs_ids.begin(), obs_ids.end());
}

void register_test_capture_type()
{
	static bool done = false;
	if (done)
		return;
	done = true;
	obs_source_info i = {};
	i.id = "ujw_test_capture";
	i.type = OBS_SOURCE_TYPE_INPUT;
	i.output_flags = OBS_SOURCE_ASYNC_VIDEO | OBS_SOURCE_AUDIO | OBS_SOURCE_DO_NOT_DUPLICATE; // as dshow_input
	i.get_name = cap_name;
	i.create = cap_create;
	i.destroy = cap_destroy;
	i.update = cap_update;
	obs_register_source(&i);
}

} // namespace devwatch
