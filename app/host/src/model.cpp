// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: project v1 -> build plan. See model.h.
#include "model.h"
#include "checks.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <regex>
#include <set>

namespace fs = std::filesystem;
using rpc::Error;

namespace model {

namespace {

const std::regex &id_re()
{
	static const std::regex re("^[a-z][a-z0-9_-]{0,63}$");
	return re;
}

std::string mid(const json::Value *v, const std::string &what)
{
	if (!v || !v->is_string() || !std::regex_match(v->as_string(), id_re()))
		throw Error(rpc::INVALID_PARAMS, what + ": bad id");
	return v->as_string();
}

std::string label(const json::Value &o, const char *k, const std::string &what)
{
	const json::Value *v = o.find(k);
	if (!v || !v->is_string() || v->as_string().empty() || v->as_string().size() > 120)
		throw Error(rpc::INVALID_PARAMS, what + ": bad " + k);
	return v->as_string();
}

const json::Value &arr(const json::Value &o, const char *k, size_t max, const std::string &what)
{
	const json::Value *v = o.find(k);
	if (!v || !v->is_array() || v->size() > max)
		throw Error(rpc::INVALID_PARAMS, what + ": " + k + " must be an array (max " + std::to_string(max) + ")");
	return *v;
}

// Project colours are "#RRGGBB" or "#RRGGBBAA" (alpha last). Returns libobs ABGR.
uint32_t color_abgr(const std::string &s, const std::string &what)
{
	static const std::regex re("^#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$");
	if (!std::regex_match(s, re))
		throw Error(rpc::INVALID_PARAMS, what + ": color must be #RRGGBB or #RRGGBBAA");
	uint32_t v = (uint32_t)std::stoul(s.substr(1), nullptr, 16);
	uint32_t r, g, b, a;
	if (s.size() == 9) {
		r = (v >> 24) & 0xFF;
		g = (v >> 16) & 0xFF;
		b = (v >> 8) & 0xFF;
		a = v & 0xFF;
	} else {
		r = (v >> 16) & 0xFF;
		g = (v >> 8) & 0xFF;
		b = v & 0xFF;
		a = 0xFF;
	}
	return (a << 24) | (b << 16) | (g << 8) | r;
}

std::string canvas_of(const std::string &c)
{
	return c == "h" ? "H" : c == "v" ? "V" : "";
}

struct Unavail {
	std::string code, reason;
};

void check_rel(const std::string &rel, const std::string &what)
{
	if (rel.empty() || std::any_of(rel.begin(), rel.end(), [](char c) { return (unsigned char)c < 0x20; }) ||
	    (rel.size() > 1 && rel[1] == ':') || rel[0] == '/' || rel[0] == '\\')
		throw Error(rpc::INVALID_PARAMS, what + ": rel must be a relative path");
	for (auto &seg : fs::u8path(rel))
		if (seg == "..")
			throw Error(rpc::INVALID_PARAMS, what + ": rel must not contain ..");
}

// encodeURIComponent per path segment ('/' and '\' separate segments), as app/host/lib/project.mjs builds it.
std::string url_path(const std::string &rel)
{
	static const char *hex = "0123456789ABCDEF";
	std::string r;
	for (unsigned char c : rel) {
		if (c == '/' || c == '\\')
			r += '/';
		else if (std::isalnum(c) || std::strchr("-_.!~*'()", c))
			r += (char)c;
		else {
			r += '%';
			r += hex[c >> 4];
			r += hex[c & 15];
		}
	}
	return r;
}

// pathRef {base, rel} -> absolute existing file under the base directory, or a reason.
std::string resolve_file(const json::Value &ref, const Options &o, const std::string &what, Unavail &u)
{
	chk::only_keys(ref, {"base", "rel"}, what + ".file");
	chk::require(ref, {"base", "rel"}, what + ".file");
	std::string base = chk::get_str(ref, "base", "", 16, what + ".file");
	std::string rel = chk::get_str(ref, "rel", "", 260, what + ".file");
	static const std::set<std::string> bases = {"data", "media", "overlays", "profile"};
	if (!bases.count(base))
		throw Error(rpc::INVALID_PARAMS, what + ".file: bad base");
	check_rel(rel, what + ".file");
	auto it = o.bases.find(base);
	if (it == o.bases.end()) {
		u = {"unavailable", "no directory given for base " + base};
		return "";
	}
	std::error_code ec;
	fs::path root = fs::canonical(fs::u8path(it->second), ec);
	if (ec || !fs::is_directory(root, ec)) {
		u = {"unavailable", "base " + base + " is not a directory"};
		return "";
	}
	fs::path p = fs::weakly_canonical(root / fs::u8path(rel), ec);
	if (ec) {
		u = {"unavailable", "file not found"};
		return "";
	}
	// Symlinks are resolved by canonical(): the result must still be inside the base directory.
	auto r = root.begin(), q = p.begin();
	for (; r != root.end(); ++r, ++q)
		if (q == p.end() || *q != *r) {
			u = {"unavailable", "file resolves outside its base directory"};
			return "";
		}
	if (!fs::is_regular_file(p, ec)) {
		u = {"unavailable", "file not found"};
		return "";
	}
	return p.generic_u8string();
}

bool local_url(const std::string &url)
{
	static const std::regex re("^http://(127\\.0\\.0\\.1|localhost)(:[0-9]{1,5})?/[^\\s]*$");
	return std::regex_match(url, re);
}

void check_placement(const json::Value &pl, const std::string &what)
{
	chk::only_keys(pl, {"visible", "x", "y", "width", "height", "rotation", "opacity", "crop"}, what);
	chk::require(pl, {"visible", "x", "y", "width", "height"}, what);
	chk::get_bool(pl, "visible", true, what);
	chk::get_num(pl, "x", 0, -16384, 16384, what);
	chk::get_num(pl, "y", 0, -16384, 16384, what);
	chk::get_num(pl, "width", 0, 0, 16384, what);
	chk::get_num(pl, "height", 0, 0, 16384, what);
	chk::get_num(pl, "rotation", 0, -360, 360, what);
	chk::get_num(pl, "opacity", 1, 0, 1, what);
	if (const json::Value *c = pl.find("crop")) {
		chk::only_keys(*c, {"left", "top", "right", "bottom"}, what + ".crop");
		for (const char *k : {"left", "top", "right", "bottom"})
			chk::get_num(*c, k, 0, 0, 16384, what + ".crop");
	}
}

} // namespace

std::vector<Effect> parse_effects(const json::Value *e, const std::string &what)
{
	std::vector<Effect> r;
	if (!e)
		return r;
	if (!e->is_array() || e->size() > 6)
		throw Error(rpc::INVALID_PARAMS, what + ": effects must be an array (max 6)");
	for (auto &x : e->as_array()) {
		const std::string w = what + ".effects";
		if (!x.is_object())
			throw Error(rpc::INVALID_PARAMS, w + ": each effect must be an object");
		Effect fx;
		fx.type = chk::get_str(x, "type", "", 16, w);
		if (fx.type == "blur") {
			chk::only_keys(x, {"type", "strength"}, w);
			chk::require(x, {"strength"}, w);
			fx.value = chk::get_num(x, "strength", 0, 1, 100, w);
		} else if (fx.type == "rounded") {
			chk::only_keys(x, {"type", "radius"}, w);
			chk::require(x, {"radius"}, w);
			fx.value = chk::get_num(x, "radius", 0, 0, 500, w);
		} else if (fx.type == "chromaKey") {
			chk::only_keys(x, {"type", "color", "similarity", "smoothness"}, w);
			chk::require(x, {"color", "similarity", "smoothness"}, w);
			const std::string c = chk::get_str(x, "color", "", 7, w);
			if (c.size() != 7 || c[0] != '#' || c.find_first_not_of("0123456789abcdefABCDEF", 1) != std::string::npos)
				throw Error(rpc::INVALID_PARAMS, w + ": color must be #RRGGBB");
			fx.color = (uint32_t)std::stoul(c.substr(1), nullptr, 16);
			fx.similarity = chk::get_int(x, "similarity", 0, 1, 1000, w);
			fx.smoothness = chk::get_int(x, "smoothness", 0, 1, 1000, w);
		} else if (fx.type == "shadow" || fx.type == "glow") { // D257
			const bool shadow = fx.type == "shadow";
			if (shadow) {
				chk::only_keys(x, {"type", "color", "opacity", "size", "distance", "angle"}, w);
				chk::require(x, {"color", "opacity", "size", "distance", "angle"}, w);
				fx.distance = chk::get_num(x, "distance", 0, 0, 200, w);
				fx.angle = chk::get_num(x, "angle", 0, -360, 360, w);
			} else {
				chk::only_keys(x, {"type", "color", "opacity", "size", "spread"}, w);
				chk::require(x, {"color", "opacity", "size", "spread"}, w);
				fx.spread = chk::get_num(x, "spread", 0, 0, 1, w);
			}
			const std::string c = chk::get_str(x, "color", "", 7, w);
			if (c.size() != 7 || c[0] != '#' || c.find_first_not_of("0123456789abcdefABCDEF", 1) != std::string::npos)
				throw Error(rpc::INVALID_PARAMS, w + ": color must be #RRGGBB");
			fx.color = (uint32_t)std::stoul(c.substr(1), nullptr, 16);
			fx.opacity = chk::get_num(x, "opacity", 1, 0, 1, w);
			fx.size = chk::get_num(x, "size", 0, 0, 200, w);
		} else if (fx.type == "color") { // D258
			chk::only_keys(x, {"type", "brightness", "contrast", "saturation", "hue"}, w);
			chk::require(x, {"brightness", "contrast", "saturation", "hue"}, w);
			fx.brightness = chk::get_num(x, "brightness", 0, -1, 1, w);
			fx.contrast = chk::get_num(x, "contrast", 0, -1, 1, w);
			fx.saturation = chk::get_num(x, "saturation", 0, -1, 1, w);
			fx.hue = chk::get_num(x, "hue", 0, -180, 180, w);
		} else if (fx.type == "cornerPin") { // D259
			const char *keys[8] = {"topLeftX", "topLeftY", "topRightX", "topRightY", "bottomRightX", "bottomRightY", "bottomLeftX", "bottomLeftY"};
			chk::only_keys(x, {"type", "topLeftX", "topLeftY", "topRightX", "topRightY", "bottomRightX", "bottomRightY",
					    "bottomLeftX", "bottomLeftY"}, w);
			chk::require(x, {"topLeftX", "topLeftY", "topRightX", "topRightY", "bottomRightX", "bottomRightY", "bottomLeftX",
					  "bottomLeftY"}, w);
			for (int i = 0; i < 8; i++)
				fx.pin[i] = chk::get_num(x, keys[i], fx.pin[i], 0, 1, w);
			// One projective map draws a convex quad only; a bow-tie, a dent or a collapsed corner is refused
			// (Codex review D260). Every corner must turn the same way, each by a cross product of at least 1e-6.
			int turn = 0;
			for (int i = 0; i < 4; i++) {
				const double *a = fx.pin + 2 * i, *b = fx.pin + 2 * ((i + 1) % 4), *c = fx.pin + 2 * ((i + 2) % 4);
				const double cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
				const int sgn = cr > 1e-6 ? 1 : cr < -1e-6 ? -1 : 0;
				if (sgn == 0 || (turn && sgn != turn))
					throw Error(rpc::INVALID_PARAMS, w + ": cornerPin corners must form a convex quad");
				turn = sgn;
			}
		} else if (fx.type == "toner") { // D258
			chk::only_keys(x, {"type", "shadows", "darktones", "midtones", "brights", "highlights", "amount"}, w);
			chk::require(x, {"shadows", "darktones", "midtones", "brights", "highlights", "amount"}, w);
			const char *keys[5] = {"shadows", "darktones", "midtones", "brights", "highlights"};
			for (int i = 0; i < 5; i++) {
				const std::string c = chk::get_str(x, keys[i], "", 7, w);
				if (c.size() != 7 || c[0] != '#' || c.find_first_not_of("0123456789abcdefABCDEF", 1) != std::string::npos)
					throw Error(rpc::INVALID_PARAMS, w + ": " + keys[i] + " must be #RRGGBB");
				fx.tones[i] = (uint32_t)std::stoul(c.substr(1), nullptr, 16);
			}
			fx.amount = chk::get_num(x, "amount", 1, 0, 1, w);
		} else {
			throw Error(rpc::INVALID_PARAMS, w + ": type must be blur, rounded, chromaKey, shadow, glow, color, toner or cornerPin");
		}
		r.push_back(fx);
	}
	return r;
}

json::Value effects_json(const std::vector<Effect> &e)
{
	json::Value a = json::Value::array();
	for (auto &fx : e) {
		json::Value o = json::Value::object();
		o.set("type", fx.type);
		if (fx.type == "chromaKey") {
			char hex[8];
			snprintf(hex, sizeof hex, "#%06x", (unsigned)(fx.color & 0xffffff));
			o.set("color", std::string(hex));
			o.set("similarity", fx.similarity);
			o.set("smoothness", fx.smoothness);
		} else if (fx.type == "shadow" || fx.type == "glow") {
			char hex[8];
			snprintf(hex, sizeof hex, "#%06x", (unsigned)(fx.color & 0xffffff));
			o.set("color", std::string(hex));
			o.set("opacity", fx.opacity);
			o.set("size", fx.size);
			if (fx.type == "shadow") {
				o.set("distance", fx.distance);
				o.set("angle", fx.angle);
			} else {
				o.set("spread", fx.spread);
			}
		} else if (fx.type == "color") {
			o.set("brightness", fx.brightness);
			o.set("contrast", fx.contrast);
			o.set("saturation", fx.saturation);
			o.set("hue", fx.hue);
		} else if (fx.type == "cornerPin") {
			const char *keys[8] = {"topLeftX", "topLeftY", "topRightX", "topRightY", "bottomRightX", "bottomRightY", "bottomLeftX", "bottomLeftY"};
			for (int i = 0; i < 8; i++)
				o.set(keys[i], fx.pin[i]);
		} else if (fx.type == "toner") {
			const char *keys[5] = {"shadows", "darktones", "midtones", "brights", "highlights"};
			for (int i = 0; i < 5; i++) {
				char hex[8];
				snprintf(hex, sizeof hex, "#%06x", (unsigned)(fx.tones[i] & 0xffffff));
				o.set(keys[i], std::string(hex));
			}
			o.set("amount", fx.amount);
		} else {
			o.set(fx.type == "blur" ? "strength" : "radius", fx.value);
		}
		a.push(std::move(o));
	}
	return a;
}

bool is_model(const json::Value &doc)
{
	return doc.is_object() && !doc.find("format");
}

Plan build(const json::Value &doc, const Options &o)
{
	Plan plan;
	chk::only_keys(doc, {"version", "id", "name", "activeScene", "origin", "canvases", "devices", "scenes", "audio",
			     "outputs", "overlays"},
		       "project");
	chk::require(doc, {"version", "id", "name", "canvases", "devices", "scenes", "audio", "outputs", "overlays"}, "project");
	const json::Value *ver = doc.find("version");
	if (!ver->is_int() || ver->as_int() != 1)
		throw Error(rpc::INVALID_PARAMS, "project: version must be 1");
	mid(doc.find("id"), "project");
	label(doc, "name", "project");

	// canvases
	for (auto &c : arr(doc, "canvases", 2, "project").as_array()) {
		// "transition" (D239/D242/D244) is not built here: the UI server applies it with transitions.set while the
		// transitions flag is on (services/project validates it).
		chk::only_keys(c, {"id", "width", "height", "fps", "transition"}, "canvas");
		chk::require(c, {"id", "width", "height", "fps"}, "canvas");
		const json::Value *id = c.find("id");
		Canvas cv;
		cv.id = id->is_string() ? canvas_of(id->as_string()) : "";
		if (cv.id.empty())
			throw Error(rpc::INVALID_PARAMS, "canvas id must be h or v");
		for (auto &x : plan.canvases)
			if (x.id == cv.id)
				throw Error(rpc::INVALID_PARAMS, "duplicate canvas " + cv.id);
		cv.w = (uint32_t)chk::get_int(c, "width", 0, 16, 8192, "canvas");
		cv.h = (uint32_t)chk::get_int(c, "height", 0, 16, 8192, "canvas");
		cv.fps = (uint32_t)chk::get_int(c, "fps", 0, 1, 240, "canvas");
		plan.canvases.push_back(cv);
	}
	auto has_canvas = [&](const std::string &c) {
		return std::any_of(plan.canvases.begin(), plan.canvases.end(), [&](const Canvas &x) { return x.id == c; });
	};
	if (!has_canvas("H"))
		throw Error(rpc::INVALID_PARAMS, "project: the host needs canvas h (it is the libobs main canvas)");

	// devices
	std::map<std::string, const json::Value *> devs;
	for (auto &d : arr(doc, "devices", 64, "project").as_array()) {
		chk::only_keys(d, {"id", "kind", "name", "match", "format", "origin"}, "device");
		chk::require(d, {"id", "kind", "name", "match"}, "device");
		std::string id = mid(d.find("id"), "device");
		if (devs.count(id))
			throw Error(rpc::INVALID_PARAMS, "duplicate device id " + id);
		std::string kind = chk::get_str(d, "kind", "", 16, "device " + id);
		if (kind != "capture-card" && kind != "camera" && kind != "microphone" && kind != "audio-output")
			throw Error(rpc::INVALID_PARAMS, "device " + id + ": bad kind");
		chk::only_keys(*d.find("match"), {"deviceId", "directShowId", "name"}, "device " + id + ".match");
		chk::get_str(*d.find("match"), "deviceId", "", 512, "device " + id + ".match");
		chk::get_str(*d.find("match"), "directShowId", "", 512, "device " + id + ".match");
		chk::get_str(*d.find("match"), "name", "", 256, "device " + id + ".match");
		if (const json::Value *f = d.find("format")) {
			chk::only_keys(*f, {"width", "height", "fps"}, "device " + id + ".format");
			chk::get_int(*f, "width", 0, 16, 8192, "device format");
			chk::get_int(*f, "height", 0, 16, 8192, "device format");
			chk::get_int(*f, "fps", 0, 1, 240, "device format");
		}
		devs[id] = &d;
	}
	std::map<std::string, std::string> overlays; // id -> rel under the overlays base
	for (auto &ov : arr(doc, "overlays", 256, "project").as_array()) {
		chk::only_keys(ov, {"id", "name", "file"}, "overlay");
		chk::require(ov, {"id", "name", "file"}, "overlay");
		std::string id = mid(ov.find("id"), "overlay");
		label(ov, "name", "overlay " + id);
		const json::Value &f = *ov.find("file");
		chk::only_keys(f, {"base", "rel"}, "overlay " + id + ".file");
		chk::require(f, {"base", "rel"}, "overlay " + id + ".file");
		if (chk::get_str(f, "base", "", 16, "overlay " + id) != "overlays")
			throw Error(rpc::INVALID_PARAMS, "overlay " + id + ": file.base must be overlays");
		std::string rel = chk::get_str(f, "rel", "", 260, "overlay " + id);
		check_rel(rel, "overlay " + id + ".file");
		if (!overlays.emplace(id, rel).second)
			throw Error(rpc::INVALID_PARAMS, "duplicate overlay id " + id);
	}
	uint32_t max_fps = 1;
	for (auto &c : plan.canvases)
		max_fps = std::max(max_fps, c.fps);
	arr(doc, "outputs", 64, "project"); // references only; the output graph is configured separately

	// pass 1: every layer (any scene) by id, so duplicates may point forward
	struct LayerRef {
		const json::Value *def;
		std::string type;
	};
	std::map<std::string, LayerRef> layers;
	const json::Value &scenes = arr(doc, "scenes", 256, "project");
	for (auto &sc : scenes.as_array()) {
		chk::only_keys(sc, {"id", "name", "layers", "origin"}, "scene");
		std::string sid = mid(sc.find("id"), "scene");
		for (auto &l : arr(sc, "layers", 256, "scene " + sid).as_array()) {
			chk::only_keys(l, {"id", "type", "name", "visible", "locked", "source", "placements", "effects", "origin"},
				       "layer");
			chk::require(l, {"id", "type", "name", "source", "placements"}, "layer");
			std::string lid = mid(l.find("id"), "layer");
			if (layers.count(lid))
				throw Error(rpc::INVALID_PARAMS, "duplicate layer id " + lid);
			layers[lid] = {&l, chk::get_str(l, "type", "", 16, "layer " + lid)};
		}
	}

	// sources for non-duplicate layers
	std::map<std::string, Unavail> unavailable; // layer id -> why its source is not built
	for (auto &[lid, ref] : layers) {
		const json::Value &l = *ref.def;
		const json::Value &s = *l.find("source");
		std::string what = "layer " + lid;
		if (!s.is_object())
			throw Error(rpc::INVALID_PARAMS, what + ": source must be an object");
		if (ref.type == "duplicate")
			continue;
		Source src;
		src.layer = lid;
		src.type = ref.type;
		json::Value st = json::Value::object();
		Unavail u;
		double pw = 1, ph = 1; // largest placement size (colour sources)
		if (const json::Value *pls = l.find("placements"); pls && pls->is_object())
			for (auto &m : pls->members()) {
				pw = std::max(pw, chk::get_num(m.second, "width", 1, 0, 16384, what));
				ph = std::max(ph, chk::get_num(m.second, "height", 1, 0, 16384, what));
			}
		if (ref.type == "color") {
			chk::only_keys(s, {"color"}, what + ".source");
			chk::require(s, {"color"}, what + ".source");
			src.obs_type = "color_source_v3";
			st.set("color", (int64_t)color_abgr(chk::get_str(s, "color", "", 16, what), what));
			st.set("width", (int64_t)std::ceil(pw));
			st.set("height", (int64_t)std::ceil(ph));
		} else if (ref.type == "image") {
			chk::only_keys(s, {"file"}, what + ".source");
			chk::require(s, {"file"}, what + ".source");
			src.obs_type = "image_source";
			std::string f = resolve_file(*s.find("file"), o, what, u);
			st.set("file", f);
		} else if (ref.type == "media") {
			chk::only_keys(s, {"file", "loop"}, what + ".source");
			chk::require(s, {"file"}, what + ".source");
			src.obs_type = "ffmpeg_source";
			std::string f = resolve_file(*s.find("file"), o, what, u);
			st.set("is_local_file", true);
			st.set("local_file", f);
			st.set("looping", chk::get_bool(s, "loop", false, what));
			st.set("hw_decode", false);
			st.set("close_when_inactive", false);
			st.set("restart_on_activate", false);
		} else if (ref.type == "text") {
			chk::only_keys(s, {"text", "font", "size", "color"}, what + ".source");
			chk::require(s, {"text"}, what + ".source");
			src.obs_type = "text_gdiplus_v3";
			st.set("text", chk::get_str(s, "text", "", 2000, what));
			json::Value font = json::Value::object();
			font.set("face", chk::get_str(s, "font", "Arial", 120, what));
			font.set("size", (int64_t)std::lround(chk::get_num(s, "size", 256, 1, 2000, what)));
			st.set("font", std::move(font));
			uint32_t abgr = color_abgr(chk::get_str(s, "color", "#FFFFFF", 16, what), what);
			st.set("color", (int64_t)(abgr & 0xFFFFFF));
			st.set("opacity", (int64_t)std::lround(((abgr >> 24) & 0xFF) * 100.0 / 255.0));
		} else if (ref.type == "browser") {
			chk::only_keys(s, {"overlay", "query", "url", "width", "height"}, what + ".source");
			chk::require(s, {"width", "height"}, what + ".source");
			src.obs_type = "browser_source";
			std::string url = chk::get_str(s, "url", "", 2048, what);
			chk::get_str(s, "query", "", 1024, what); // goes into the overlay URL (Node side)
			st.set("width", chk::get_int(s, "width", 0, 1, 8192, what));
			st.set("height", chk::get_int(s, "height", 0, 1, 8192, what));
			if (const json::Value *ov = s.find("overlay")) {
				std::string oid = mid(ov, what + ".source.overlay");
				auto oi = overlays.find(oid);
				if (oi == overlays.end())
					throw Error(rpc::INVALID_PARAMS, what + ": unknown overlay " + oid);
				src.overlay = true;
				url.clear();
				auto bu = o.browser_urls.find(lid);
				std::string want = "http://127.0.0.1:" + std::to_string(o.overlay_port) + "/overlays/" +
						   url_path(oi->second);
				if (!o.allow_browser)
					u = {"forbidden", "browser layers are disabled (host started without --allow-browser)"};
				else if (!o.overlay_port)
					u = {"unavailable", "the overlay server is not running (host started without --overlay-root, or it is restarting)"};
				else if (bu == o.browser_urls.end())
					u = {"unavailable", "no overlay URL for this layer (load the project through app/host/lib/project.mjs)"};
				else if (bu->second.size() > 2048 ||
					 (bu->second != want && bu->second.compare(0, want.size() + 1, want + "?") != 0) ||
					 std::any_of(bu->second.begin(), bu->second.end(),
						     [](char c) { return (unsigned char)c <= 0x20 || c == '#'; }))
					u = {"unavailable", "the overlay URL does not point at this layer's overlay on the host's overlay server"};
				else
					url = bu->second;
			} else if (!o.allow_browser) {
				u = {"forbidden", "browser layers are disabled (host started without --allow-browser)"};
			} else if (!local_url(url)) {
				u = {"unavailable", "the host loads only http://127.0.0.1 or http://localhost pages"};
			}
			st.set("url", url.empty() ? std::string("about:blank") : url); // obs-browser's default is a web page
			st.set("is_local_file", false);
			st.set("fps_custom", true);
			st.set("fps", (int64_t)max_fps);
			st.set("webpage_control_level", 0); // no studio access from the page
			st.set("reroute_audio", false);
			st.set("shutdown", false);
			st.set("restart_when_active", false);
		} else if (ref.type == "capture") {
			chk::only_keys(s, {"device"}, what + ".source");
			std::string did = mid(s.find("device"), what + ".source.device");
			auto d = devs.find(did);
			if (d == devs.end())
				throw Error(rpc::INVALID_PARAMS, what + ": unknown device " + did);
			std::string kind = d->second->find("kind")->as_string();
			if (kind != "capture-card" && kind != "camera")
				throw Error(rpc::INVALID_PARAMS, what + ": capture layers need a capture-card or camera device");
			src.obs_type = "dshow_input";
			src.device = did;
			if (o.devices) {
				devices::Match m = devices::resolve(*d->second, *o.devices);
				if (m.entry) {
					src.matched_by = m.matched_by;
					st.set("video_device_id", m.entry->obs_id);
				} else {
					u = {"unavailable", "device " + did + ": " + m.problem};
				}
			} else {
				u = {"unavailable", "device " + did + ": devices were not listed"};
			}
			if (!o.allow_devices) // after resolving, so a dry plan still shows the match (or why it failed)
				u = {"forbidden", "capture devices are disabled (host started without --allow-devices)" +
							  (u.code.empty() ? std::string() : "; also " + u.reason)};
			st.set("active", true);
			st.set("deactivate_when_not_showing", false);
			st.set("use_custom_audio_device", false);
			st.set("audio_output_mode", 0); // capture the device's own audio into the mix
			if (const json::Value *f = d->second->find("format")) {
				int64_t w = chk::get_int(*f, "width", 0, 0, 8192, "device format");
				int64_t h = chk::get_int(*f, "height", 0, 0, 8192, "device format");
				int64_t fps = chk::get_int(*f, "fps", 0, 0, 240, "device format");
				if (w && h) {
					st.set("res_type", 1);
					st.set("resolution", std::to_string(w) + "x" + std::to_string(h));
					st.set("video_format", 0); // any
					if (fps)
						st.set("frame_interval", (int64_t)std::llround(10000000.0 / (double)fps));
				}
			} else {
				st.set("res_type", 0); // device default
			}
		} else {
			throw Error(rpc::INVALID_PARAMS, what + ": unknown type");
		}
		src.settings = std::move(st);
		if (!u.code.empty())
			unavailable[lid] = u;
		plan.sources[lid] = std::move(src);
	}

	// pass 2: scenes and items
	std::set<std::string> scene_ids;
	for (auto &sc : scenes.as_array()) {
		Scene s;
		s.id = sc.find("id")->as_string();
		if (!scene_ids.insert(s.id).second)
			throw Error(rpc::INVALID_PARAMS, "duplicate scene id " + s.id);
		s.name = label(sc, "name", "scene " + s.id);
		for (auto &c : plan.canvases)
			s.items[c.id];
		for (auto &l : sc.find("layers")->as_array()) {
			Item it;
			it.layer = l.find("id")->as_string();
			it.type = layers[it.layer].type;
			it.name = label(l, "name", "layer " + it.layer);
			bool lvis = chk::get_bool(l, "visible", true, "layer " + it.layer);
			chk::get_bool(l, "locked", false, "layer " + it.layer);
			it.source_layer = it.layer;
			it.effects = parse_effects(l.find("effects"), "layer " + it.layer);
			if (it.type == "duplicate") {
				const json::Value &s2 = *l.find("source");
				chk::only_keys(s2, {"layer"}, "layer " + it.layer + ".source");
				std::string t = mid(s2.find("layer"), "layer " + it.layer + ".source.layer");
				auto tl = layers.find(t);
				if (tl == layers.end())
					throw Error(rpc::INVALID_PARAMS, "layer " + it.layer + ": duplicate of unknown layer " + t);
				if (tl->second.type == "duplicate")
					throw Error(rpc::INVALID_PARAMS, "layer " + it.layer + ": a duplicate must point at a real layer");
				it.source_layer = t;
			}
			const json::Value *pls = l.find("placements");
			if (!pls->is_object() || pls->size() < 1)
				throw Error(rpc::INVALID_PARAMS, "layer " + it.layer + ": placements must name at least one canvas");
			for (auto &m : pls->members()) {
				std::string c = canvas_of(m.first);
				if (c.empty() || !has_canvas(c))
					throw Error(rpc::INVALID_PARAMS, "layer " + it.layer + ": placement canvas is not defined");
				check_placement(m.second, "layer " + it.layer + ".placements." + m.first);
				Item x = it;
				x.placement = m.second;
				x.visible = lvis && m.second.find("visible")->as_bool();
				double op = chk::get_num(m.second, "opacity", 1, 0, 1, "placement");
				if (op < 1) {
					json::Value w = json::Value::object();
					w.set("layer", it.layer);
					w.set("canvas", c);
					w.set("warning", "opacity is not applied (libobs scene items have no opacity)");
					plan.warnings.push(std::move(w));
				}
				s.items[c].push_back(std::move(x));
			}
		}
		plan.scenes.push_back(std::move(s));
	}

	// layers (and duplicates) whose source is not built
	for (auto &[lid, ref] : layers) {
		std::string src = lid;
		if (ref.type == "duplicate")
			src = ref.def->find("source")->find("layer")->as_string();
		auto u = unavailable.find(src);
		if (u == unavailable.end())
			continue;
		json::Value e = json::Value::object();
		e.set("layer", lid);
		e.set("type", ref.type);
		if (src != lid)
			e.set("duplicateOf", src);
		e.set("code", u->second.code);
		e.set("reason", u->second.reason);
		const Source &s = plan.sources[src];
		if (!s.device.empty()) {
			e.set("device", s.device);
			e.set("matchedBy", s.matched_by.empty() ? json::Value() : json::Value(s.matched_by));
		}
		plan.unavailable.push(std::move(e));
	}

	// audio
	const json::Value *au = doc.find("audio");
	chk::only_keys(*au, {"tracks", "masterVolumeDb", "sources"}, "audio");
	std::vector<std::string> tracks;
	for (auto &t : arr(*au, "tracks", 6, "audio").as_array()) {
		chk::only_keys(t, {"id", "name"}, "audio track");
		tracks.push_back(mid(t.find("id"), "audio track"));
	}
	if (au->find("masterVolumeDb")) {
		chk::get_num(*au, "masterVolumeDb", 0, -100, 12, "audio");
		json::Value w = json::Value::object();
		w.set("warning", "audio.masterVolumeDb is not applied (no master fader in libobs)");
		plan.warnings.push(std::move(w));
	}
	std::set<std::string> bound; // layer sources that already have an audio entry
	for (auto &a : arr(*au, "sources", 256, "audio").as_array()) { // D245: one per video layer in a Meld session
		chk::only_keys(a, {"id", "name", "device", "layer", "volumeDb", "muted", "monitoring", "tracks", "origin"}, "audio source");
		chk::require(a, {"id", "name", "volumeDb", "muted", "monitoring", "tracks"}, "audio source");
		Audio x;
		x.id = mid(a.find("id"), "audio source");
		std::string what = "audio source " + x.id;
		x.name = label(a, "name", what);
		x.volume_db = chk::get_num(a, "volumeDb", 0, -100, 12, what);
		x.muted = chk::get_bool(a, "muted", false, what);
		x.monitoring = chk::get_str(a, "monitoring", "off", 24, what);
		if (x.monitoring != "off" && x.monitoring != "monitor-only" && x.monitoring != "monitor-and-output")
			throw Error(rpc::INVALID_PARAMS, what + ": bad monitoring");
		const json::Value *tl = a.find("tracks");
		if (!tl->is_array() || tl->size() > 6)
			throw Error(rpc::INVALID_PARAMS, what + ": bad tracks");
		for (auto &t : tl->as_array()) {
			std::string tid = mid(&t, what + ".tracks");
			auto k = std::find(tracks.begin(), tracks.end(), tid);
			if (k == tracks.end())
				throw Error(rpc::INVALID_PARAMS, what + ": unknown track " + tid);
			x.mixers |= 1u << (uint32_t)(k - tracks.begin());
		}
		bool hd = a.find("device") != nullptr, hl = a.find("layer") != nullptr;
		if (hd == hl)
			throw Error(rpc::INVALID_PARAMS, what + ": needs exactly one of device or layer");
		Unavail u;
		if (hl) {
			std::string lid = mid(a.find("layer"), what + ".layer");
			auto l = layers.find(lid);
			if (l == layers.end())
				throw Error(rpc::INVALID_PARAMS, what + ": unknown layer " + lid);
			x.layer = l->second.type == "duplicate" ? l->second.def->find("source")->find("layer")->as_string() : lid;
		} else {
			x.device = mid(a.find("device"), what + ".device");
			auto d = devs.find(x.device);
			if (d == devs.end())
				throw Error(rpc::INVALID_PARAMS, what + ": unknown device " + x.device);
			std::string kind = d->second->find("kind")->as_string();
			if (kind == "capture-card" || kind == "camera") {
				// The device's audio comes with its capture layer's source (one device open).
				for (auto &[sid, s] : plan.sources)
					if (s.type == "capture" && s.device == x.device) {
						x.layer = sid;
						break;
					}
				if (x.layer.empty())
					u = {"unavailable", "audio of a video device needs a capture layer for that device"};
			} else {
				x.obs_type = kind == "microphone" ? "wasapi_input_capture" : "wasapi_output_capture";
				json::Value st = json::Value::object();
				if (o.devices) {
					devices::Match m = devices::resolve(*d->second, *o.devices);
					if (m.entry) {
						x.matched_by = m.matched_by;
						st.set("device_id", m.entry->obs_id);
					} else {
						u = {"unavailable", "device " + x.device + ": " + m.problem};
					}
				} else {
					u = {"unavailable", "device " + x.device + ": devices were not listed"};
				}
				if (!o.allow_devices)
					u = {"forbidden", "audio devices are disabled (host started without --allow-devices)" +
								  (u.code.empty() ? std::string() : "; also " + u.reason)};
				st.set("use_device_timing", false);
				x.settings = std::move(st);
			}
		}
		if (!x.layer.empty()) {
			if (!bound.insert(x.layer).second)
				throw Error(rpc::INVALID_PARAMS, what + ": layer " + x.layer + " already has an audio entry");
			auto lu = unavailable.find(x.layer);
			if (lu != unavailable.end())
				u = {lu->second.code, "its layer is not built: " + lu->second.reason};
			const std::string &ty = layers[x.layer].type;
			if (ty == "color" || ty == "image" || ty == "text") {
				json::Value w = json::Value::object();
				w.set("audio", x.id);
				w.set("warning", "bound to a layer type without audio");
				plan.warnings.push(std::move(w));
			}
		}
		if (x.monitoring != "off" && !o.allow_devices) {
			json::Value w = json::Value::object();
			w.set("audio", x.id);
			w.set("warning", "monitoring is not applied without --allow-devices (it opens an audio output device)");
			plan.warnings.push(std::move(w));
		}
		if (!u.code.empty()) {
			json::Value e = json::Value::object();
			e.set("audio", x.id);
			e.set("code", u.code);
			e.set("reason", u.reason);
			if (!x.device.empty()) {
				e.set("device", x.device);
				e.set("matchedBy", x.matched_by.empty() ? json::Value() : json::Value(x.matched_by));
			}
			plan.unavailable.push(std::move(e));
			continue;
		}
		plan.audio.push_back(std::move(x));
	}

	// unavailable sources are not built; drop them (and their items) from the plan
	for (auto &[lid, u] : unavailable)
		plan.sources.erase(lid);
	for (auto &s : plan.scenes)
		for (auto &[c, items] : s.items)
			items.erase(std::remove_if(items.begin(), items.end(),
						   [&](const Item &i) { return unavailable.count(i.source_layer) > 0; }),
				    items.end());

	if (const json::Value *as = doc.find("activeScene")) {
		plan.active = mid(as, "project.activeScene");
		if (!scene_ids.count(plan.active))
			throw Error(rpc::INVALID_PARAMS, "project: activeScene names no scene");
	} else if (!plan.scenes.empty()) {
		plan.active = plan.scenes.front().id;
	}
	return plan;
}

json::Value to_json(const Plan &p)
{
	json::Value r = json::Value::object();
	json::Value cv = json::Value::array();
	for (auto &c : p.canvases) {
		json::Value o = json::Value::object();
		o.set("id", c.id);
		o.set("w", c.w);
		o.set("h", c.h);
		o.set("fps", c.fps);
		cv.push(std::move(o));
	}
	r.set("canvases", std::move(cv));
	json::Value sc = json::Value::array();
	for (auto &s : p.scenes) {
		json::Value o = json::Value::object();
		o.set("id", s.id);
		o.set("name", s.name);
		json::Value items = json::Value::object();
		for (auto &[c, list] : s.items) {
			json::Value a = json::Value::array();
			for (auto &i : list) {
				json::Value x = json::Value::object();
				x.set("layer", i.layer);
				x.set("type", i.type);
				x.set("source", i.source_layer);
				x.set("visible", i.visible);
				if (!i.effects.empty())
					x.set("effects", effects_json(i.effects));
				a.push(std::move(x));
			}
			items.set(c, std::move(a));
		}
		o.set("items", std::move(items));
		sc.push(std::move(o));
	}
	r.set("scenes", std::move(sc));
	json::Value src = json::Value::array();
	for (auto &[id, s] : p.sources) {
		json::Value o = json::Value::object();
		o.set("layer", id);
		o.set("type", s.type);
		o.set("obsType", s.obs_type);
		if (!s.device.empty()) {
			o.set("device", s.device);
			o.set("matchedBy", s.matched_by);
		}
		if (s.obs_type == "browser_source") { // page URLs carry ports and the feed query only, never a token
			o.set("url", *s.settings.find("url"));
			o.set("overlay", s.overlay);
		}
		src.push(std::move(o));
	}
	r.set("sources", std::move(src));
	json::Value au = json::Value::array();
	for (auto &a : p.audio) {
		json::Value o = json::Value::object();
		o.set("id", a.id);
		o.set("layer", a.layer.empty() ? json::Value() : json::Value(a.layer));
		o.set("obsType", a.obs_type.empty() ? json::Value() : json::Value(a.obs_type));
		o.set("volumeDb", a.volume_db);
		o.set("muted", a.muted);
		o.set("mixers", a.mixers);
		o.set("monitoring", a.monitoring);
		au.push(std::move(o));
	}
	r.set("audio", std::move(au));
	r.set("active", p.active.empty() ? json::Value() : json::Value(p.active));
	r.set("unavailable", p.unavailable);
	r.set("warnings", p.warnings);
	return r;
}

std::string resolve_path_ref(const json::Value &ref, const std::map<std::string, std::string> &bases, const std::string &what)
{
	Options o;
	o.bases = bases;
	Unavail u;
	std::string f = resolve_file(ref, o, what, u);
	if (f.empty())
		throw Error(rpc::UNAVAILABLE, what + ": " + u.reason);
	return f;
}

} // namespace model
