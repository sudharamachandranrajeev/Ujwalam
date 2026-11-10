// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: device hot-plug watcher (D329).
//
// Windows tells the host when a device interface arrives or leaves (CM_Register_Notification; no window of any kind,
// the callbacks run on a system thread pool). Watched interface classes: KSCATEGORY_CAPTURE, KSCATEGORY_VIDEO,
// KSCATEGORY_VIDEO_CAMERA (cameras and capture cards; DirectShow video devices are kernel-streaming interfaces of these
// classes), KSCATEGORY_AUDIO and the MMDevice audio capture / render interfaces. A callback only notes the time; it
// never lists or opens anything. One plugged device arrives as several interfaces, so the watcher waits for a quiet
// period (quiet_ms after the last notification, at most max_wait_ms after the first) and then calls on_change once, on
// its own thread. on_change lists devices (list-only, devices.h) and reconciles the capture layers (studio.h
// devices_changed). Nothing here touches encoders or outputs.
// A removal's interface path (the CM symbolic link) is kept through the quiet period and handed to on_change, so a
// device that leaves and returns inside it is still seen as removed (its source is reactivated, devices.h reconcile).
// check_after(ms) asks for a pass without a device event (capture sources still connecting: retry with backoff,
// studio.h devices_changed); on_change gets device_event = false then.
//
// Started only with --allow-devices (D38: listing is a device feature) or --test-hooks (then the list comes from
// devices.testSet; a real notification still only triggers a pass over the fake list).
#pragma once

#include "json.h"

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace devwatch {

class Watcher {
public:
	using OnChange = std::function<void(const std::vector<std::string> &removed, bool device_event)>;
	Watcher(OnChange on_change, uint32_t quiet_ms = 700, uint32_t max_wait_ms = 3000);
	~Watcher();
	void stop(); // unregisters, then joins the thread (a running pass finishes first)
	void poke(const std::string &removed = std::string()); // an interface arrived, or left (its path; CM callback)
	void check_after(uint32_t ms); // a pass in ms at the latest, without a device event (earliest request wins)
	json::Value status() const; // {watching, filters, notifications, passes, error}

private:
	void run();
	OnChange on_change_;
	uint32_t quiet_ms_, max_wait_ms_;
	std::vector<void *> regs_; // HCMNOTIFICATION
	std::string error_;
	mutable std::mutex m_;
	std::condition_variable cv_;
	bool quit_ = false, pending_ = false;
	uint64_t first_ms_ = 0, last_ms_ = 0, check_ms_ = 0; // check_ms_: 0 = no check asked
	std::vector<std::string> removed_;
	std::atomic<uint64_t> notifications_{0}, passes_{0};
	std::thread th_;
};

// --test-hooks only: registers source type "ujw_test_capture", an async video source standing in for dshow_input. It
// takes the same "video_device_id" setting and sends 64 x 36 BGRA frames at 20 fps only while that id is one of the
// connected fake video devices (set_test_present; the devices.testSet list). It opens nothing.
// Like a DirectShow graph, a fake source whose device was removed (test_remove) stays dead, even when the device is
// back, until its settings are updated (obs_source_update = reactivation). test_fail_activations(id, n): the next n
// activations of that id deliver no frames (driver busy, device held by another app). test_frames: frames sent per id.
void register_test_capture_type();
void set_test_present(const std::vector<std::string> &obs_ids);
void test_remove(const std::vector<std::string> &obs_ids);
void test_fail_activations(const std::string &obs_id, int n);
json::Value test_frames();

} // namespace devwatch
