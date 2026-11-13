// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: graphics watchdog and GPU device-loss report (D374; docs/evidence/2026-11-13-gpu-reset-recovery.md).
//
// Why: on 2026-11-12 the host's graphics thread stopped producing frames at 19:03 (frames.grab timed out, the face
// link heartbeat went stale for 3 hours) and nothing noticed; at 21:42 the NVIDIA driver reset (nvlddmkm 153) while
// live. libobs itself only rebuilds its D3D11 device when a swap chain Present returns DEVICE_REMOVED/RESET (an open
// preview window; libobs-d3d11 device_present -> gs_device::RebuildDevice); it does not restart encoders, and a host
// with no preview never rebuilds at all. The host had no signal for either case.
//
// What (report only; no behaviour change while frames flow, like the audio health watchdog):
// - A tick callback (the libobs graphics thread, once per frame) stamps the time of the last frame.
// - A checker thread, every check_interval_ms, compares that stamp with the clock: no frame for stall_ms is a stall.
//   It logs ONE line when a stall starts and one when frames come back (with how long it lasted), never per frame.
// - gs_register_loss_callbacks: libobs calls these from RebuildDevice. The host counts device losses and rebuilds and
//   logs each once. The callbacks' data is process-static and never freed, so they are never unregistered (an
//   unregister needs the graphics lock, which a stuck graphics thread may hold forever during shutdown).
// host.status "graphics" reports all of it; the launcher (services/studio-ui/host-watch.mjs) decides what to do.
// Config: host config "graphicsWatch": {"stallMs", "checkIntervalMs"} from data/live/host-watch.json. Absent: the
// tick stamp and the device-loss counters still run, the checker thread does not (stalled is always false).
#pragma once

#include "json.h"

#include <atomic>
#include <cstdint>
#include <mutex>
#include <string>
#include <thread>

namespace gfxwatch {

struct Config {
	uint32_t stall_ms = 0;          // no frame for this long = stalled; 0 = checker off
	uint32_t check_interval_ms = 0; // how often the checker looks
};

// Pure stall bookkeeping (no clock of its own; the checker passes the times). observe() -> +1 a stall started,
// -1 frames came back (last_ms = how long that stall lasted), 0 nothing new.
struct Stall {
	uint32_t stall_ms = 0;
	bool stalled = false;
	uint64_t since_ms = 0; // last frame time when the current stall began
	uint32_t count = 0;
	uint64_t longest_ms = 0, last_ms = 0;
	int observe(uint64_t now_ms, uint64_t last_tick_ms);
};

class Watch {
public:
	explicit Watch(const Config &c); // after libobs started: tick callback, device-loss callbacks, checker thread
	~Watch();                        // checker stopped, tick callback removed
	void stop_checker();             // first step of the host's shutdown: teardown stalls are not reported
	json::Value status() const;      // host.status "graphics"
	// --test-hooks only (graphics.testStall): the next tick blocks the graphics thread for ms (a stuck GPU).
	void test_stall(uint32_t ms) { test_stall_ms_.store(ms); }

private:
	static void tick_cb(void *param, float seconds);
	void check();

	Config cfg_;
	std::atomic<uint64_t> last_tick_ms_{0}; // GetTickCount64 at the last frame (start time before the first)
	std::atomic<uint64_t> ticks_{0};
	std::atomic<uint32_t> test_stall_ms_{0};
	Stall stall_; // the checker thread's own state (one writer, no other reader)
	// What status() reads, published by the checker without a lock (Codex review: host.alive must never wait on the
	// checker, which logs).
	std::atomic<bool> pub_stalled_{false};
	std::atomic<uint64_t> pub_since_ms_{0}, pub_longest_ms_{0};
	std::atomic<uint32_t> pub_count_{0};
	std::atomic<uint64_t> last_stall_ft_{0}; // FILETIME (UTC) the newest stall was detected (0 = none)
	void *ev_ = nullptr;        // HANDLE (manual reset; set = stop)
	std::thread th_;
};

} // namespace gfxwatch
