// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: graphics watchdog and GPU device-loss report. See gfx_watch.h.
#include "gfx_watch.h"
#include "log.h"

#include <obs.h>

#include <cstdio>

#include <windows.h>

namespace gfxwatch {

namespace {

// Device-loss counters: process-static, so the libobs callbacks never point at freed memory (gfx_watch.h). Times are
// FILETIME values in atomics (0 = never), so status() reads them without a lock.
std::atomic<uint32_t> g_losses{0}, g_rebuilds{0};
std::atomic<uint64_t> g_last_loss_ft{0}, g_last_rebuild_ft{0};
std::atomic<bool> g_registered{false};

uint64_t filetime_now()
{
	FILETIME ft;
	GetSystemTimePreciseAsFileTime(&ft);
	return (uint64_t(ft.dwHighDateTime) << 32) | ft.dwLowDateTime;
}

// FILETIME -> ISO-8601 UTC with milliseconds (the hlog::utc_now format); null for 0 (never).
json::Value iso(uint64_t v)
{
	if (!v)
		return json::Value();
	FILETIME ft;
	ft.dwLowDateTime = (DWORD)(v & 0xffffffffu);
	ft.dwHighDateTime = (DWORD)(v >> 32);
	SYSTEMTIME st;
	if (!FileTimeToSystemTime(&ft, &st))
		return json::Value();
	char buf[64];
	snprintf(buf, sizeof(buf), "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ", st.wYear, st.wMonth, st.wDay, st.wHour,
		 st.wMinute, st.wSecond, st.wMilliseconds);
	return json::Value(std::string(buf));
}

void on_device_loss(void *)
{
	const uint32_t n = g_losses.fetch_add(1) + 1;
	g_last_loss_ft.store(filetime_now());
	hlog::error("graphics device lost (%u since start): the GPU driver reset or the GPU was removed; libobs is "
		    "rebuilding its graphics objects. Encoders are not rebuilt: a stream or recording may stop until the "
		    "host is restarted",
		    n);
}

void on_device_rebuilt(void *, void *)
{
	const uint32_t n = g_rebuilds.fetch_add(1) + 1;
	g_last_rebuild_ft.store(filetime_now());
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

void Published::publish(const Snapshot &s)
{
	const uint32_t g = gen_.load(std::memory_order_relaxed);
	gen_.store(g + 1, std::memory_order_relaxed); // odd: a write is in progress
	std::atomic_thread_fence(std::memory_order_release); // the odd gen is visible before any field changes
	stalled_.store(s.stalled, std::memory_order_relaxed);
	since_ms_.store(s.since_ms, std::memory_order_relaxed);
	longest_ms_.store(s.longest_ms, std::memory_order_relaxed);
	count_.store(s.count, std::memory_order_relaxed);
	stall_ft_.store(s.stall_ft, std::memory_order_relaxed);
	gen_.store(g + 2, std::memory_order_release); // even: the fields above are complete
}

Snapshot Published::read(bool *ok) const
{
	Snapshot s;
	for (int i = 0; i < 4096; i++) {
		const uint32_t g1 = gen_.load(std::memory_order_acquire);
		if (!(g1 & 1)) {
			s.stalled = stalled_.load(std::memory_order_relaxed);
			s.since_ms = since_ms_.load(std::memory_order_relaxed);
			s.longest_ms = longest_ms_.load(std::memory_order_relaxed);
			s.count = count_.load(std::memory_order_relaxed);
			s.stall_ft = stall_ft_.load(std::memory_order_relaxed);
			std::atomic_thread_fence(std::memory_order_acquire); // the field loads complete before gen is read again
			if (gen_.load(std::memory_order_relaxed) == g1) {
				if (ok)
					*ok = true;
				return s;
			}
		}
		if (i < 64)
			YieldProcessor();
		else
			SwitchToThread();
	}
	if (ok)
		*ok = false;
	return s;
}

SeqlockProbe seqlock_probe(uint64_t writes, uint64_t reads)
{
	// Every field derives from one counter k, so a snapshot that mixes two writes is detectable.
	auto make = [](uint64_t k) {
		Snapshot s;
		s.stalled = (k & 1) != 0;
		s.since_ms = k * 3;
		s.longest_ms = k * 5;
		s.count = (uint32_t)k;
		s.stall_ft = k * 7;
		return s;
	};
	Published p;
	p.publish(make(0));
	std::atomic<bool> done{false};
	std::thread w([&]() {
		for (uint64_t k = 1; k <= writes; k++)
			p.publish(make(k));
		done.store(true);
	});
	SeqlockProbe r;
	r.writes = writes;
	uint64_t last_k = 0;
	while (r.reads < reads || !done.load()) {
		bool ok = false;
		const Snapshot s = p.read(&ok);
		r.reads++;
		if (!ok) {
			r.retried_out++;
			continue;
		}
		const uint64_t k = s.count;
		if (k != last_k && !done.load())
			r.changes++; // a read while the writer ran saw a new write: the two threads overlapped
		last_k = k;
		if (s.stalled != ((k & 1) != 0) || s.since_ms != k * 3 || s.longest_ms != k * 5 || s.stall_ft != k * 7)
			r.torn++;
	}
	w.join();
	return r;
}

// Checker thread only: stall_ has one writer and no reader elsewhere. The result is published (seqlock) BEFORE the
// log line, and no lock is held while logging (Codex review): status() / host.alive never wait on a slow log write.
void Watch::check()
{
	const uint64_t now = GetTickCount64(), last = last_tick_ms_.load();
	const int ev = stall_.observe(now, last);
	if (ev != 0) {
		if (ev > 0)
			last_stall_ft_ = filetime_now();
		Snapshot s;
		s.stalled = stall_.stalled;
		s.since_ms = stall_.since_ms;
		s.longest_ms = stall_.longest_ms;
		s.count = stall_.count;
		s.stall_ft = last_stall_ft_;
		pub_.publish(s);
	}
	if (ev > 0) {
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
	// Lock-free, consistent snapshot (seqlock): host.alive answers even while the checker is logging.
	bool ok = false;
	const Snapshot s = pub_.read(&ok);
	// An unvalidated snapshot is never reported (Codex re-review): after the bounded retries the stall fields are left
	// out and "snapshot" says "busy"; lastFrameAgeMs above (one atomic, what the launcher decides on) is always there.
	if (!ok || test_busy_.load()) {
		r.set("snapshot", "busy");
	} else {
		r.set("snapshot", "ok");
		r.set("stalled", s.stalled);
		r.set("stalledMs", s.stalled ? (int64_t)(now > s.since_ms ? now - s.since_ms : 0) : (int64_t)0);
		r.set("stalls", (int64_t)s.count);
		r.set("longestStallMs", (int64_t)s.longest_ms);
		r.set("lastStallAt", iso(s.stall_ft));
	}
	r.set("deviceLosses", (int64_t)g_losses.load());
	r.set("deviceRebuilds", (int64_t)g_rebuilds.load());
	r.set("lastDeviceLossAt", iso(g_last_loss_ft.load()));
	r.set("lastDeviceRebuildAt", iso(g_last_rebuild_ft.load()));
	return r;
}

} // namespace gfxwatch
