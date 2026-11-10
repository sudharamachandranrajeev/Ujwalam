// SPDX-License-Identifier: GPL-3.0-or-later
// Eased scene fades (D327 TR1): see transition_ease.h. Curves: Robert Penner's easing equations (BSD licence; the
// formulas only), the monotonic families. The curve ids match data/transitions/easing.json.
#include "transition_ease.h"

#include <util/platform.h>

#include <algorithm>
#include <cmath>

namespace ease {

namespace {
constexpr double kPi = 3.14159265358979323846;

double in_base(const std::string &fam, double t)
{
	if (fam == "sine")
		return 1.0 - std::cos(t * kPi / 2.0);
	if (fam == "quad")
		return t * t;
	if (fam == "cubic")
		return t * t * t;
	if (fam == "quart")
		return t * t * t * t;
	if (fam == "quint")
		return t * t * t * t * t;
	if (fam == "expo")
		return t <= 0.0 ? 0.0 : std::pow(2.0, 10.0 * t - 10.0);
	if (fam == "circ")
		return 1.0 - std::sqrt(std::max(0.0, 1.0 - t * t));
	return -1.0;
}
} // namespace

double value(const std::string &curve, double t)
{
	t = std::clamp(t, 0.0, 1.0);
	if (curve == "linear")
		return t;
	std::string fam;
	int kind = 0; // 0 in, 1 out, 2 in-out
	if (curve.rfind("in-out-", 0) == 0) {
		kind = 2;
		fam = curve.substr(7);
	} else if (curve.rfind("in-", 0) == 0) {
		kind = 0;
		fam = curve.substr(3);
	} else if (curve.rfind("out-", 0) == 0) {
		kind = 1;
		fam = curve.substr(4);
	} else {
		return -1.0;
	}
	if (in_base(fam, 0.5) < 0.0)
		return -1.0;
	double v;
	if (kind == 0)
		v = in_base(fam, t);
	else if (kind == 1)
		v = 1.0 - in_base(fam, 1.0 - t);
	else
		v = t < 0.5 ? in_base(fam, 2.0 * t) / 2.0 : 1.0 - in_base(fam, 2.0 - 2.0 * t) / 2.0;
	if (t >= 1.0)
		return 1.0; // expo in reaches 1 exactly at t = 1 only after rounding: end exactly
	return std::clamp(v, 0.0, 1.0);
}

bool known(const std::string &curve)
{
	return value(curve, 0.5) >= 0.0;
}

Easer::Easer()
{
	obs_add_tick_callback(&Easer::tick_cb, this);
}

Easer::~Easer()
{
	obs_remove_tick_callback(&Easer::tick_cb, this);
	end_all();
}

void Easer::tick_cb(void *param, float)
{
	static_cast<Easer *>(param)->tick();
}

void Easer::tick()
{
	std::lock_guard<std::mutex> l(m_);
	if (items_.empty())
		return;
	uint64_t now = os_gettime_ns();
	for (auto it = items_.begin(); it != items_.end();) {
		double t = it->ms ? (double)(now - it->start_ns) / (it->ms * 1e6) : 1.0;
		double v = value(it->curve, t);
		// Never exactly 0 (that cancels a manual transition, see begin); an unknown curve ends at once.
		obs_transition_set_manual_time(it->tr, (float)std::max(v < 0.0 ? 1.0 : v, 1e-4));
		if (t >= 1.0)
			it = items_.erase(it); // at 1.0 libobs finishes the transition
		else
			++it;
	}
}

void Easer::begin(const std::string &key, obs_source_t *tr, uint32_t ms, const std::string &curve)
{
	std::lock_guard<std::mutex> l(m_);
	items_.erase(std::remove_if(items_.begin(), items_.end(), [&](const Item &i) { return i.key == key; }), items_.end());
	// obs_transition_start already set the position to 0. Never set 0.0 in manual mode: libobs treats that as "back to
	// the start" and cancels the transition (obs_transition_set_manual_time).
	obs_transition_set_manual_torque(tr, 0.0f, 0.0f);
	items_.push_back(Item{key, tr, os_gettime_ns(), ms, curve});
}

bool Easer::end(const std::string &key)
{
	std::lock_guard<std::mutex> l(m_);
	auto n = items_.size();
	items_.erase(std::remove_if(items_.begin(), items_.end(), [&](const Item &i) { return i.key == key; }), items_.end());
	return items_.size() != n;
}

void Easer::end_all()
{
	std::lock_guard<std::mutex> l(m_);
	items_.clear();
}

bool Easer::running(const std::string &key) const
{
	std::lock_guard<std::mutex> l(m_);
	return std::any_of(items_.begin(), items_.end(), [&](const Item &i) { return i.key == key; });
}

} // namespace ease
