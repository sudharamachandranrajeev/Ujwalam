// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: graphics watchdog and GPU device-loss report. See gfx_watch.h.
#include "gfx_watch.h"
#include "log.h"

#include <obs.h>

#include <windows.h>

namespace gfxwatch {

namespace {

// Device-loss counters: process-static, so the libobs callbacks never point at freed memory (gfx_watch.h).
std::atomic<uint32_t> g_losses{0}, g_rebuilds{0};
std::mutex g_loss_m;
std::string g_last_loss_at, g_last_rebuild_at;
std::atomic<bool> g_registered{false};

void on_device_loss(void *)
{
	const uint32_t n = g_losses.fetch_add(1) + 1;
	{
		std::lock_guard<std::mutex> l(g_loss_m);
		g_last_loss_at = hlog::utc_now();
	}
	hlog::error("graphics device lost (%u since start): the GPU driver reset or the GPU was removed; libobs is "
		    "rebuilding its graphics objects. Encoders are not rebuilt: a stream or recording may stop until the "
		    "host is restarted",
		    n);
}

void on_device_rebuilt(void *, void *)
{
	const uint32_t n = g_rebuilds.fetch_add(1) + 1;
	{
		std::lock_guard<std::mutex> l(g_loss_m);
		g_last_rebuild_at = hlog::utc_now();
	}
	hlog::warn("graphics device rebuilt by libobs (%u since start)", n);
}

} // namespace

int Stall::observe(uint64_t now_ms, uint64_t last_tick_ms)
{
	const uint64_t age = now_ms > last_tick_ms ? now_ms - last_tick_ms : 0;
	if (!stalled) {
		if (stall_ms && age >= stall_ms) {
			stalled = true;
			since_ms = last_tick_ms;
			count++;
			return +1;
		}
		return 0;
	}
	if (last_tick_ms != since_ms) { // a frame came after the stall began
		last_ms = last_tick_ms - since_ms;
		if (last_ms > longest_ms)
			longest_ms = last_ms;
		stalled = false;
		return -1;
	}
	return 0;
}

Watch::Watch(const Config &c) : cfg_(c)
{
	last_tick_ms_.store(GetTickCount64());
	stall_.stall_ms = c.stall_ms;
	obs_add_tick_callback(tick_cb, this);
	if (!g_registered.exchange(true)) {
		gs_device_loss cb = {};
		cb.device_loss_release = on_device_loss;
		cb.device_loss_rebuild = on_device_rebuilt;
		cb.data = nullptr;
		obs_enter_graphics();
		gs_register_loss_callbacks(&cb);
		obs_leave_graphics();
	}
	if (c.stall_ms && c.check_interval_ms) {
		HANDLE ev = CreateEventW(nullptr, TRUE, FALSE, nullptr);
		ev_ = ev;
		if (ev) {
			const uint32_t every = c.check_interval_ms;
			th_ = std::thread([this, ev, every]() {
				SetThreadDescription(GetCurrentThread(), L"ujw: graphics watchdog");
				while (WaitForSingleObject(ev, every) == WAIT_TIMEOUT)
					check();
			});
		}
	}
	hlog::info("graphics watchdog: %s (stall after %u ms, check every %u ms); device-loss report on",
		   th_.joinable() ? "on" : "off", c.stall_ms, c.check_interval_ms);
}

Watch::~Watch()
{
	stop_checker();
	// After obs_remove_tick_callback returns no tick of ours runs (libobs calls tick callbacks under its mutex).
	obs_remove_tick_callback(tick_cb, this);
	if (ev_)
		CloseHandle((HANDLE)ev_);
}

void Watch::stop_checker()
{
	if (ev_)
		SetEvent((HANDLE)ev_);
	if (th_.joinable())
		th_.join();
}

void Watch::tick_cb(void *param, float)
{
	auto *w = static_cast<Watch *>(param);
	if (const uint32_t ms = w->test_stall_ms_.exchange(0))
		Sleep(ms); // --test-hooks: a stuck graphics thread
	w->last_tick_ms_.store(GetTickCount64());
	w->ticks_.fetch_add(1);
}

void Watch::check()
{
	const uint64_t now = GetTickCount64(), last = last_tick_ms_.load();
	std::lock_guard<std::mutex> l(m_);
	const int ev = stall_.observe(now, last);
	if (ev > 0) {
		last_stall_at_ = hlog::utc_now();
		hlog::error("graphics stalled: no video frame for %llu ms (stall %u since start); the picture, the "
			    "recording and the streams are frozen until it recovers",
			    (unsigned long long)(now - last), stall_.count);
	} else if (ev < 0) {
		hlog::warn("graphics recovered: video frames are back after %llu ms", (unsigned long long)stall_.last_ms);
	}
}

json::Value Watch::status() const
{
	const uint64_t now = GetTickCount64(), last = last_tick_ms_.load();
	json::Value r = json::Value::object();
	r.set("watch", th_.joinable());
	r.set("stallMs", (int64_t)cfg_.stall_ms);
	r.set("lastFrameAgeMs", (int64_t)(now > last ? now - last : 0));
	r.set("frames", (int64_t)ticks_.load());
	{
		std::lock_guard<std::mutex> l(m_);
		r.set("stalled", stall_.stalled);
		r.set("stalledMs", stall_.stalled ? (int64_t)(now > stall_.since_ms ? now - stall_.since_ms : 0) : (int64_t)0);
		r.set("stalls", (int64_t)stall_.count);
		r.set("longestStallMs", (int64_t)stall_.longest_ms);
		r.set("lastStallAt", last_stall_at_.empty() ? json::Value() : json::Value(last_stall_at_));
	}
	r.set("deviceLosses", (int64_t)g_losses.load());
	r.set("deviceRebuilds", (int64_t)g_rebuilds.load());
	{
		std::lock_guard<std::mutex> l(g_loss_m);
		r.set("lastDeviceLossAt", g_last_loss_at.empty() ? json::Value() : json::Value(g_last_loss_at));
		r.set("lastDeviceRebuildAt", g_last_rebuild_at.empty() ? json::Value() : json::Value(g_last_rebuild_at));
	}
	return r;
}

} // namespace gfxwatch
