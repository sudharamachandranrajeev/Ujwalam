// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: host config file parsing. See host_config.h.
#include "host_config.h"

#include <filesystem>

namespace {

bool only(const json::Value &o, std::initializer_list<const char *> keys, const char *what, std::string &err)
{
	if (!o.is_object()) {
		err = std::string(what) + " must be an object";
		return false;
	}
	for (auto &m : o.members()) {
		bool ok = false;
		for (const char *k : keys)
			ok = ok || m.first == k;
		if (!ok) {
			err = std::string(what) + ": unknown key " + json::Value(m.first.substr(0, 32)).dump();
			return false;
		}
	}
	return true;
}

bool abs_path(const json::Value *v, std::string &dst, const char *what, std::string &err)
{
	if (!v)
		return true;
	if (!v->is_string() || v->as_string().empty() || v->as_string().size() > 1024 ||
	    !std::filesystem::u8path(v->as_string()).is_absolute()) {
		err = std::string(what) + " must be an absolute path";
		return false;
	}
	dst = v->as_string();
	return true;
}

bool int_in(const json::Value *v, int64_t lo, int64_t hi, int64_t &dst, const char *what, std::string &err)
{
	if (!v)
		return true;
	if (!v->is_int() || v->as_int() < lo || v->as_int() > hi) {
		err = std::string(what) + " must be an integer " + std::to_string(lo) + ".." + std::to_string(hi);
		return false;
	}
	dst = v->as_int();
	return true;
}

} // namespace

bool parse_host_config(const json::Value &doc, HostConfig &cfg, std::string &err)
{
	if (!only(doc, {"$comment", "replay", "hotkeys", "feedbackDir", "markersDir", "eventCore", "monitoringDevice", "audio", "audioHealth"}, "host config", err))
		return false;
	if (const json::Value *h = doc.find("audioHealth")) {
		if (!only(*h, {"enabled", "noDataMs", "checkIntervalMs", "maxRecreates", "maxParked", "shutdownGuardMs"}, "audioHealth", err))
			return false;
		auto &ah = cfg.audio_health;
		if (const json::Value *e = h->find("enabled")) {
			if (!e->is_bool()) {
				err = "audioHealth.enabled must be true or false";
				return false;
			}
			ah.enabled = e->as_bool();
		}
		// Required when enabled: the values come from the data file, the host has no built-in numbers.
		for (const char *k : {"noDataMs", "checkIntervalMs", "maxRecreates", "maxParked"})
			if (ah.enabled && !h->find(k)) {
				err = std::string("audioHealth.") + k + " is required when enabled";
				return false;
			}
		int64_t nd = 0, ci = 0, mr = 0, mp = 0, sg = 0;
		if (!int_in(h->find("noDataMs"), 500, 600000, nd, "audioHealth.noDataMs", err) ||
		    !int_in(h->find("checkIntervalMs"), 100, 60000, ci, "audioHealth.checkIntervalMs", err) ||
		    !int_in(h->find("maxRecreates"), 0, 100, mr, "audioHealth.maxRecreates", err) ||
		    !int_in(h->find("maxParked"), 1, 1000, mp, "audioHealth.maxParked", err) ||
		    !int_in(h->find("shutdownGuardMs"), 0, 600000, sg, "audioHealth.shutdownGuardMs", err))
			return false;
		if (sg && sg < 1000) {
			err = "audioHealth.shutdownGuardMs must be 0 (off) or at least 1000";
			return false;
		}
		ah.no_data_ms = (uint32_t)nd;
		ah.check_interval_ms = (uint32_t)ci;
		ah.max_recreates = (uint32_t)mr;
		ah.max_parked = (uint32_t)mp;
		ah.shutdown_guard_ms = (uint32_t)sg;
	}
	if (const json::Value *r = doc.find("replay")) {
		if (!only(*r, {"seconds", "autoStart", "fallbackKbps"}, "replay", err))
			return false;
		int64_t s = cfg.replay.seconds;
		if (!int_in(r->find("seconds"), 5, 600, s, "replay.seconds", err))
			return false;
		cfg.replay.seconds = (int)s;
		if (const json::Value *a = r->find("autoStart")) {
			if (!a->is_bool()) {
				err = "replay.autoStart must be true or false";
				return false;
			}
			cfg.replay_autostart = a->as_bool();
		}
		if (const json::Value *f = r->find("fallbackKbps")) {
			if (!only(*f, {"H", "V"}, "replay.fallbackKbps", err))
				return false;
			int64_t h = cfg.replay.fallback_kbps_h, v = cfg.replay.fallback_kbps_v;
			if (!int_in(f->find("H"), 500, 100000, h, "replay.fallbackKbps.H", err) ||
			    !int_in(f->find("V"), 500, 100000, v, "replay.fallbackKbps.V", err))
				return false;
			cfg.replay.fallback_kbps_h = (uint32_t)h;
			cfg.replay.fallback_kbps_v = (uint32_t)v;
		}
	}
	if (const json::Value *h = doc.find("hotkeys")) {
		if (!only(*h, {"enabled", "panic", "feedback", "marker"}, "hotkeys", err))
			return false;
		if (const json::Value *e = h->find("enabled")) {
			if (!e->is_bool()) {
				err = "hotkeys.enabled must be true or false";
				return false;
			}
			cfg.hotkeys_enabled = e->as_bool();
		}
		for (auto &b : cfg.hotkeys) {
			const json::Value *v = h->find(b.first);
			if (!v)
				continue;
			if (v->is_null()) {
				b.second.clear(); // binding off
			} else if (v->is_string() && !v->as_string().empty() && v->as_string().size() <= 40) {
				b.second = v->as_string(); // checked when registered (an invalid combo is reported, not fatal)
			} else {
				err = "hotkeys." + b.first + " must be a combo string like \"Ctrl+Alt+P\" or null";
				return false;
			}
		}
	}
	if (!abs_path(doc.find("feedbackDir"), cfg.feedback_dir, "feedbackDir", err) ||
	    !abs_path(doc.find("markersDir"), cfg.markers_dir, "markersDir", err))
		return false;
	if (const json::Value *e = doc.find("eventCore")) {
		if (!only(*e, {"systemFile"}, "eventCore", err) ||
		    !abs_path(e->find("systemFile"), cfg.core_system_file, "eventCore.systemFile", err))
			return false;
	}
	if (const json::Value *a = doc.find("audio")) {
		if (!only(*a, {"lowLatency"}, "audio", err))
			return false;
		if (const json::Value *l = a->find("lowLatency")) {
			if (!l->is_bool()) {
				err = "audio.lowLatency must be true or false";
				return false;
			}
			cfg.low_latency_audio = l->as_bool();
		}
	}
	if (const json::Value *m = doc.find("monitoringDevice")) {
		if (!m->is_string() || m->as_string().empty() || m->as_string().size() > 200) {
			err = "monitoringDevice must be a device name (1-200 characters)";
			return false;
		}
		cfg.monitoring_device = m->as_string();
	}
	return true;
}
