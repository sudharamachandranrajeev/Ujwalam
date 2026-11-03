// SPDX-License-Identifier: GPL-2.0-or-later
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
	if (!only(doc, {"$comment", "replay", "hotkeys", "feedbackDir", "markersDir", "eventCore"}, "host config", err))
		return false;
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
	return true;
}
