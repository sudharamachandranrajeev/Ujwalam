// SPDX-License-Identifier: GPL-3.0-or-later
// Eased scene fades (D327 TR1). libobs's fade transition runs linearly in OBS_TRANSITION_MODE_AUTO; for an easing
// curve the fade starts in OBS_TRANSITION_MODE_MANUAL (torque 0: the position follows the set value at once) and a
// libobs tick callback drives obs_transition_set_manual_time(tr, ease(elapsed / duration)). At 1.0 libobs ends the
// transition itself (obs-source-transition.c). Every curve here is monotonic in 0..1 (no back/elastic/bounce), so a
// fade never overshoots or flashes.
//
// Thread model: begin/end/end_all run on RPC threads under the Studio lock; tick() runs on the libobs graphics thread.
// Both sides take only this class's own mutex, never the Studio lock, so neither waits on the other. The easer never
// owns a reference: Studio calls end() before it releases or replaces a transition.
#pragma once

#include <obs.h>

#include <cstdint>
#include <mutex>
#include <string>
#include <vector>

namespace ease {

// Position (0..1) of curve id at t (0..1). Unknown id: returns -1.
double value(const std::string &curve, double t);
// True when the host knows this curve id ("linear" included).
bool known(const std::string &curve);

class Easer {
public:
	Easer();
	~Easer();
	Easer(const Easer &) = delete;
	Easer &operator=(const Easer &) = delete;

	// Drives tr (already started in manual mode) along curve over ms; replaces a running ease of the same key.
	void begin(const std::string &key, obs_source_t *tr, uint32_t ms, const std::string &curve);
	// Stops driving key (the transition keeps whatever state it has). Returns true if one was running.
	bool end(const std::string &key);
	void end_all();
	bool running(const std::string &key) const;

private:
	struct Item {
		std::string key;
		obs_source_t *tr = nullptr;
		uint64_t start_ns = 0;
		uint32_t ms = 0;
		std::string curve;
	};
	static void tick_cb(void *param, float seconds);
	void tick();
	mutable std::mutex m_;
	std::vector<Item> items_;
};

} // namespace ease
