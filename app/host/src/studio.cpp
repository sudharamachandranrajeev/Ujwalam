// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: scene model on libobs. See studio.h.
#include "studio.h"
#include "checks.h"
#include "log.h"
#include "obs_runtime.h"
#include "rpc_server.h"

#include <obs-audio-controls.h>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <filesystem>
#include <regex>
#include <set>

namespace fs = std::filesystem;
using rpc::Error;
using chk::get_bool;
using chk::get_int;
using chk::get_num;
using chk::get_str;
using chk::only_keys;

namespace {

const char *TEST_FORMAT = "ujwalam-host-test";

const std::regex &id_re()
{
	static const std::regex re("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$");
	return re;
}

std::string check_id(const json::Value *v, const char *what)
{
	if (!v || !v->is_string() || !std::regex_match(v->as_string(), id_re()))
		throw Error(rpc::INVALID_PARAMS, std::string("bad ") + what + " id");
	return v->as_string();
}

// Host test format colours: "#RRGGBB" or "#AARRGGBB" (alpha first) -> libobs ABGR
uint32_t parse_color(const std::string &s)
{
	static const std::regex re("^#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$");
	if (!std::regex_match(s, re))
		throw Error(rpc::INVALID_PARAMS, "color must be #RRGGBB or #AARRGGBB");
	uint32_t v = (uint32_t)std::stoul(s.substr(1), nullptr, 16);
	uint32_t a = s.size() == 9 ? (v >> 24) & 0xFF : 0xFF;
	uint32_t r = (v >> 16) & 0xFF, g = (v >> 8) & 0xFF, b = v & 0xFF;
	return (a << 24) | (b << 16) | (g << 8) | r;
}

std::string existing_file(const json::Value &o, const char *k, const char *what)
{
	std::string f = get_str(o, k, "", 1024, what);
	if (f.empty())
		throw Error(rpc::INVALID_PARAMS, std::string(what) + ": missing " + k);
	fs::path p = fs::u8path(f);
	std::error_code ec;
	if (!p.is_absolute() || !fs::is_regular_file(p, ec))
		throw Error(rpc::INVALID_PARAMS, std::string(what) + ": " + k + " must be an absolute path to an existing file");
	return p.generic_u8string();
}

enum obs_monitoring_type monitoring_type(const std::string &m)
{
	if (m == "monitor-only")
		return OBS_MONITORING_TYPE_MONITOR_ONLY;
	if (m == "monitor-and-output")
		return OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT;
	return OBS_MONITORING_TYPE_NONE;
}

} // namespace

// Per-source audio meter (libobs volmeter, log fader). Values in dBFS, max over channels.
struct Studio::Meter {
	obs_volmeter_t *vm = nullptr;
	std::atomic<float> peak{-INFINITY}, magnitude{-INFINITY};
	static void cb(void *p, const float mag[MAX_AUDIO_CHANNELS], const float pk[MAX_AUDIO_CHANNELS],
		       const float[MAX_AUDIO_CHANNELS])
	{
		auto *m = static_cast<Meter *>(p);
		float a = -INFINITY, b = -INFINITY;
		for (int i = 0; i < MAX_AUDIO_CHANNELS; i++) {
			a = std::max(a, mag[i]);
			b = std::max(b, pk[i]);
		}
		m->magnitude = a;
		m->peak = b;
	}
	explicit Meter(obs_source_t *src)
	{
		vm = obs_volmeter_create(OBS_FADER_LOG);
		obs_volmeter_attach_source(vm, src);
		obs_volmeter_add_callback(vm, cb, this);
	}
	~Meter()
	{
		obs_volmeter_remove_callback(vm, cb, this);
		obs_volmeter_detach_source(vm);
		obs_volmeter_destroy(vm);
	}
};

Studio::Src::~Src()
{
	meter.reset(); // detach the volmeter before the source goes
	if (src) {
		obs_source_remove(src);
		obs_source_release(src);
	}
}

std::string Studio::norm_canvas(const std::string &c)
{
	if (c == "H" || c == "h")
		return "H";
	if (c == "V" || c == "v")
		return "V";
	return "";
}

Studio::~Studio()
{
	teardown();
}

Studio::Canvas *Studio::canvas(const std::string &id)
{
	std::string n = norm_canvas(id);
	for (auto &c : canvases_)
		if (c.id == n)
			return &c;
	return nullptr;
}

const Studio::Canvas *Studio::canvas(const std::string &id) const
{
	return const_cast<Studio *>(this)->canvas(id);
}

Studio::Scene *Studio::scene(const std::string &id, const std::string &cv)
{
	for (auto &s : scenes_)
		if (s.id == id && s.canvas == cv)
			return &s;
	return nullptr;
}

const Studio::Scene *Studio::scene(const std::string &id, const std::string &cv) const
{
	return const_cast<Studio *>(this)->scene(id, cv);
}

std::vector<Studio::Scene *> Studio::scenes_named(const std::string &id, const std::string &cv)
{
	std::string n = norm_canvas(cv);
	if (!cv.empty() && n.empty())
		throw Error(rpc::INVALID_PARAMS, "canvas must be H or V");
	std::vector<Scene *> r;
	for (auto &s : scenes_)
		if (s.id == id && (n.empty() || s.canvas == n))
			r.push_back(&s);
	if (r.empty())
		throw Error(rpc::INVALID_PARAMS, "no such scene");
	return r;
}

Studio::Scene *Studio::one_scene(const std::string &id, const std::string &cv)
{
	auto v = scenes_named(id, cv);
	if (v.size() > 1)
		throw Error(rpc::INVALID_PARAMS, "scene is on H and V: pass canvas");
	return v.front();
}

void Studio::set_channel(Canvas &c, Scene *s)
{
	obs_source_t *src = s ? obs_scene_get_source(s->scene) : nullptr;
	if (c.id == "H")
		obs_set_output_source(0, src);
	else if (c.vc)
		obs_canvas_set_channel(c.vc, 0, src);
	c.active = s ? s->id : "";
}

void Studio::destroy_layer(Layer &l)
{
	if (l.item) {
		obs_sceneitem_remove(l.item);
		l.item = nullptr;
	}
	l.src.reset(); // the source goes with its last item
}

void Studio::destroy_scene(Scene &s)
{
	for (auto &l : s.layers)
		destroy_layer(l);
	s.layers.clear();
	if (s.scene) {
		// Canvases with SCENE_REF (the main canvas) hold their own reference on scenes: remove, then release
		// (P1a shutdown finding).
		obs_source_remove(obs_scene_get_source(s.scene));
		obs_scene_release(s.scene);
		s.scene = nullptr;
	}
}

void Studio::make_relay(const LoadOptions &o)
{
	if (o.relay_scope.empty())
		return;
	if (o.relay_scope != "effects" && o.relay_scope != "display")
		throw Error(rpc::INVALID_PARAMS, "relayScope must be effects or display");
	if (!flags_.allow_browser)
		throw Error(rpc::FORBIDDEN, "browser layers are disabled (start the host with --allow-browser)");
	if (!o.overlay_port || !o.overlay_feed_port) {
		hlog::warn("overlay relay not created: the overlay server is not running");
		return;
	}
	// A's relay page (services/overlay-server/relay): ?feed=<feed port>[&scope=display]. It holds no token.
	std::string url = "http://127.0.0.1:" + std::to_string(o.overlay_port) +
			  "/_ujwalam/relay.html?feed=" + std::to_string(o.overlay_feed_port) +
			  (o.relay_scope == "display" ? "&scope=display" : "");
	obs_data_t *d = obs_data_create();
	obs_data_set_string(d, "url", url.c_str());
	obs_data_set_bool(d, "is_local_file", false);
	obs_data_set_int(d, "width", 16);
	obs_data_set_int(d, "height", 16);
	obs_data_set_bool(d, "fps_custom", true);
	obs_data_set_int(d, "fps", 10);
	obs_data_set_int(d, "webpage_control_level", 0);
	obs_data_set_bool(d, "reroute_audio", false);
	obs_data_set_bool(d, "shutdown", false);
	obs_data_set_bool(d, "restart_when_active", false);
	relay_ = obs_source_create_private("browser_source", "ujw:overlay-relay", d);
	obs_data_release(d);
	if (!relay_)
		throw Error(rpc::INTERNAL, "overlay relay: browser source create failed");
	obs_source_inc_showing(relay_);
	obs_source_inc_active(relay_);
	relay_scope_ = o.relay_scope;
	hlog::info("overlay relay created (scope %s)", relay_scope_.c_str());
}

void Studio::drop_relay()
{
	if (!relay_)
		return;
	obs_source_dec_active(relay_);
	obs_source_dec_showing(relay_);
	obs_source_remove(relay_);
	obs_source_release(relay_);
	relay_ = nullptr;
	relay_scope_.clear();
}

void Studio::teardown()
{
	std::lock_guard<std::recursive_mutex> l(m_);
	drop_relay();
	for (auto &c : canvases_)
		set_channel(c, nullptr);
	for (auto &g : globals_)
		obs_set_output_source(g.channel, nullptr);
	globals_.clear();
	for (auto &s : scenes_)
		destroy_scene(s);
	scenes_.clear();
	for (auto &c : canvases_) {
		if (c.vc) {
			obs_canvas_remove(c.vc);
			obs_canvas_release(c.vc);
			c.vc = nullptr;
		}
	}
	canvases_.clear();
	format_.clear();
	model_doc_ = json::Value();
	dirty_ = false;
}

std::shared_ptr<Studio::Src> Studio::wrap(obs_source_t *src, const std::string &owner)
{
	auto s = std::make_shared<Src>();
	s->src = src;
	s->owner = owner;
	if (obs_source_get_output_flags(src) & OBS_SOURCE_AUDIO)
		s->meter = std::make_shared<Meter>(src);
	return s;
}

obs_source_t *Studio::create_source(const Scene &s, const std::string &layer_id, const std::string &type,
				    const json::Value &st)
{
	const Canvas *c = canvas(s.canvas);
	uint32_t cw = c ? c->w : 1920, ch = c ? c->h : 1080, cfps = c ? c->fps : 60;
	std::string name = "ujw:" + s.canvas + ":" + s.id + ":" + layer_id;
	obs_data_t *d = obs_data_create();
	const char *id = nullptr;
	const char *what = "layer settings";
	try {
		if (type == "color") {
			only_keys(st, {"color", "width", "height"}, what);
			id = "color_source_v3";
			obs_data_set_int(d, "color", parse_color(get_str(st, "color", "#202020", 16, what)));
			obs_data_set_int(d, "width", get_int(st, "width", cw, 1, 16384, what));
			obs_data_set_int(d, "height", get_int(st, "height", ch, 1, 16384, what));
		} else if (type == "test_pattern") {
			// Built from allowlisted values only; a raw lavfi graph is never accepted (movie/amovie filters read files).
			only_keys(st, {"pattern", "toneHz", "width", "height", "fps"}, what);
			std::string pat = get_str(st, "pattern", "testsrc2", 32, what);
			static const std::set<std::string> pats = {"testsrc2", "testsrc", "smptebars", "smptehdbars",
								   "rgbtestsrc", "yuvtestsrc", "pal75bars"};
			if (!pats.count(pat))
				throw Error(rpc::INVALID_PARAMS, "test_pattern: pattern must be one of testsrc2, testsrc, smptebars, smptehdbars, rgbtestsrc, yuvtestsrc, pal75bars");
			int64_t w = get_int(st, "width", cw, 16, 8192, what), h = get_int(st, "height", ch, 16, 8192, what);
			int64_t fps = get_int(st, "fps", cfps, 1, 240, what);
			int64_t tone = get_int(st, "toneHz", 0, 0, 20000, what);
			std::string graph = pat + "=size=" + std::to_string(w) + "x" + std::to_string(h) +
					    ":rate=" + std::to_string(fps) + ",realtime[out0]";
			if (tone > 0)
				graph += ";sine=frequency=" + std::to_string(tone) + ":sample_rate=48000,arealtime[out1]";
			id = "ffmpeg_source";
			obs_data_set_bool(d, "is_local_file", false);
			obs_data_set_string(d, "input", graph.c_str());
			obs_data_set_string(d, "input_format", "lavfi");
			obs_data_set_bool(d, "hw_decode", false);
			obs_data_set_bool(d, "close_when_inactive", false);
			obs_data_set_bool(d, "restart_on_activate", false);
			obs_data_set_int(d, "buffering_mb", 2);
		} else if (type == "media") {
			only_keys(st, {"file", "loop", "hwDecode"}, what);
			id = "ffmpeg_source";
			obs_data_set_bool(d, "is_local_file", true);
			obs_data_set_string(d, "local_file", existing_file(st, "file", what).c_str());
			obs_data_set_bool(d, "looping", get_bool(st, "loop", true, what));
			obs_data_set_bool(d, "hw_decode", get_bool(st, "hwDecode", false, what));
			obs_data_set_bool(d, "close_when_inactive", false);
			obs_data_set_bool(d, "restart_on_activate", false);
		} else if (type == "image") {
			only_keys(st, {"file"}, what);
			id = "image_source";
			obs_data_set_string(d, "file", existing_file(st, "file", what).c_str());
		} else if (type == "dshow_video" || type == "wasapi_input") {
			if (!flags_.allow_devices)
				throw Error(rpc::FORBIDDEN, "devices are disabled (start the host with --allow-devices after the user says devices ready)");
			if (type == "dshow_video") {
				only_keys(st, {"deviceId", "audioDeviceId", "resolution", "fps"}, what);
				id = "dshow_input";
				obs_data_set_string(d, "video_device_id", get_str(st, "deviceId", "", 1024, what).c_str());
				std::string res = get_str(st, "resolution", "", 16, what);
				if (res.empty()) {
					obs_data_set_int(d, "res_type", 0); // device default format
				} else {
					obs_data_set_int(d, "res_type", 1);
					obs_data_set_string(d, "resolution", res.c_str());
					double f = get_num(st, "fps", 30, 1, 240, what);
					obs_data_set_int(d, "frame_interval", (long long)(10000000.0 / f + 0.5));
					obs_data_set_int(d, "video_format", 0);
				}
				obs_data_set_bool(d, "active", true);
				obs_data_set_bool(d, "deactivate_when_not_showing", false);
				std::string ad = get_str(st, "audioDeviceId", "", 1024, what);
				if (!ad.empty()) {
					obs_data_set_bool(d, "use_custom_audio_device", true);
					obs_data_set_string(d, "audio_device_id", ad.c_str());
					obs_data_set_int(d, "audio_output_mode", 0);
				}
			} else {
				only_keys(st, {"deviceId"}, what);
				id = "wasapi_input_capture";
				obs_data_set_string(d, "device_id", get_str(st, "deviceId", "", 1024, what).c_str());
				obs_data_set_bool(d, "use_device_timing", false);
			}
		} else if (type == "browser") {
			if (!flags_.allow_browser)
				throw Error(rpc::FORBIDDEN, "browser layers are disabled (start the host with --allow-browser)");
			only_keys(st, {"url", "width", "height", "fps"}, what);
			std::string url = get_str(st, "url", "", 2048, what);
			static const std::regex local_url("^http://(127\\.0\\.0\\.1|localhost)(:[0-9]{1,5})?/[^\\s]*$");
			if (!std::regex_match(url, local_url))
				throw Error(rpc::INVALID_PARAMS, "browser: url must be http://127.0.0.1 or http://localhost");
			id = "browser_source";
			obs_data_set_string(d, "url", url.c_str());
			obs_data_set_bool(d, "is_local_file", false);
			obs_data_set_int(d, "width", get_int(st, "width", cw, 1, 8192, what));
			obs_data_set_int(d, "height", get_int(st, "height", ch, 1, 8192, what));
			obs_data_set_bool(d, "fps_custom", true);
			obs_data_set_int(d, "fps", get_int(st, "fps", cfps, 1, 240, what));
			obs_data_set_bool(d, "reroute_audio", false);
			obs_data_set_bool(d, "shutdown", false);
			obs_data_set_bool(d, "restart_when_active", false);
			obs_data_set_int(d, "webpage_control_level", 0); // no studio access from the page
		} else {
			throw Error(rpc::INVALID_PARAMS, "unknown layer type " + json::Value(type.substr(0, 32)).dump());
		}
	} catch (...) {
		obs_data_release(d);
		throw;
	}
	obs_source_t *src = obs_source_create(id, name.c_str(), d, nullptr);
	obs_data_release(d);
	if (!src)
		throw Error(rpc::INTERNAL, "source create failed for type " + type);
	return src;
}

void Studio::add_item(Scene &s, Layer &l)
{
	l.item = obs_scene_add(s.scene, l.src->src);
	if (!l.item)
		throw Error(rpc::INTERNAL, "scene add failed");
}

void Studio::apply_transform(const Scene &s, Layer &l)
{
	const Canvas *c = canvas(s.canvas);
	const json::Value &t = l.transform;
	const char *what = "transform";
	if (!t.is_null())
		only_keys(t, {"fit", "x", "y", "w", "h", "scale"}, what);
	json::Value empty = json::Value::object();
	const json::Value &tt = t.is_null() ? empty : t;
	std::string fit = get_str(tt, "fit", "inner", 16, what);
	double x = get_num(tt, "x", 0, -16384, 16384, what), y = get_num(tt, "y", 0, -16384, 16384, what);
	double w = get_num(tt, "w", c ? c->w : 1920, 1, 16384, what), h = get_num(tt, "h", c ? c->h : 1080, 1, 16384, what);
	double scale = get_num(tt, "scale", 1, 0.01, 100, what);
	obs_sceneitem_set_alignment(l.item, OBS_ALIGN_LEFT | OBS_ALIGN_TOP);
	struct vec2 pos;
	vec2_set(&pos, (float)x, (float)y);
	if (fit == "inner" || fit == "outer" || fit == "stretch") {
		obs_sceneitem_set_bounds_type(l.item, fit == "inner"   ? OBS_BOUNDS_SCALE_INNER
						      : fit == "outer" ? OBS_BOUNDS_SCALE_OUTER
								       : OBS_BOUNDS_STRETCH);
		struct vec2 b;
		vec2_set(&b, (float)w, (float)h);
		obs_sceneitem_set_bounds(l.item, &b);
		obs_sceneitem_set_bounds_alignment(l.item, 0); // centre in the bounds
		obs_sceneitem_set_bounds_crop(l.item, fit == "outer");
	} else if (fit == "none") {
		obs_sceneitem_set_bounds_type(l.item, OBS_BOUNDS_NONE);
		struct vec2 sc;
		vec2_set(&sc, (float)scale, (float)scale);
		obs_sceneitem_set_scale(l.item, &sc);
	} else {
		throw Error(rpc::INVALID_PARAMS, "transform: fit must be inner, outer, stretch or none");
	}
	obs_sceneitem_set_pos(l.item, &pos);
}

// Project v1 placement: the final displayed rectangle. Stretch bounds to it, centre alignment so rotation turns
// about the centre (UNVERIFIED against Meld), crop in source pixels (UNVERIFIED against Meld).
void Studio::apply_placement(Layer &l)
{
	const json::Value &p = l.placement;
	double x = get_num(p, "x", 0, -16384, 16384, "placement"), y = get_num(p, "y", 0, -16384, 16384, "placement");
	double w = get_num(p, "width", 0, 0, 16384, "placement"), h = get_num(p, "height", 0, 0, 16384, "placement");
	obs_sceneitem_set_alignment(l.item, 0); // OBS_ALIGN_CENTER
	obs_sceneitem_set_bounds_type(l.item, OBS_BOUNDS_STRETCH);
	struct vec2 b;
	vec2_set(&b, (float)std::max(w, 1.0), (float)std::max(h, 1.0));
	obs_sceneitem_set_bounds(l.item, &b);
	obs_sceneitem_set_bounds_alignment(l.item, 0);
	struct vec2 pos;
	vec2_set(&pos, (float)(x + w / 2), (float)(y + h / 2));
	obs_sceneitem_set_pos(l.item, &pos);
	obs_sceneitem_set_rot(l.item, (float)get_num(p, "rotation", 0, -360, 360, "placement"));
	if (const json::Value *c = p.find("crop")) {
		struct obs_sceneitem_crop cr = {};
		cr.left = (int)std::lround(get_num(*c, "left", 0, 0, 16384, "crop"));
		cr.top = (int)std::lround(get_num(*c, "top", 0, 0, 16384, "crop"));
		cr.right = (int)std::lround(get_num(*c, "right", 0, 0, 16384, "crop"));
		cr.bottom = (int)std::lround(get_num(*c, "bottom", 0, 0, 16384, "crop"));
		obs_sceneitem_set_crop(l.item, &cr);
	}
	if (w <= 0 || h <= 0)
		l.visible = false; // a zero-size rectangle shows nothing
}

void Studio::apply_order(Scene &s)
{
	std::vector<obs_sceneitem_t *> order;
	for (auto &l : s.layers)
		order.push_back(l.item);
	if (order.size() > 1)
		obs_scene_reorder_items(s.scene, order.data(), order.size());
}

Studio::Layer Studio::make_layer(Scene &s, const json::Value &def)
{
	only_keys(def, {"id", "type", "name", "visible", "settings", "transform"}, "layer");
	Layer l;
	l.id = check_id(def.find("id"), "layer");
	for (auto &x : s.layers)
		if (x.id == l.id)
			throw Error(rpc::INVALID_PARAMS, "duplicate layer id " + l.id);
	const json::Value *ty = def.find("type");
	if (!ty || !ty->is_string())
		throw Error(rpc::INVALID_PARAMS, "layer " + l.id + ": missing type");
	l.type = ty->as_string();
	l.name = get_str(def, "name", l.id, 128, "layer");
	l.visible = get_bool(def, "visible", true, "layer");
	const json::Value *st = def.find("settings");
	json::Value empty = json::Value::object();
	l.settings = st ? *st : empty;
	const json::Value *tr = def.find("transform");
	if (tr)
		l.transform = *tr;
	l.src = wrap(create_source(s, l.id, l.type, l.settings), l.id);
	try {
		add_item(s, l);
		apply_transform(s, l);
	} catch (...) {
		destroy_layer(l);
		throw;
	}
	obs_sceneitem_set_visible(l.item, l.visible);
	return l;
}

Studio::Scene &Studio::new_scene(const std::string &id, const std::string &name, const std::string &cv)
{
	Canvas *c = canvas(cv);
	if (!c)
		throw Error(rpc::INVALID_PARAMS, "scene " + id + ": canvas must be H or V (and exist in the project)");
	if (scene(id, c->id))
		throw Error(rpc::INVALID_PARAMS, "duplicate scene id " + id + " on canvas " + c->id);
	Scene s;
	s.id = id;
	s.name = name;
	s.canvas = c->id;
	std::string oname = "ujw:" + c->id + ":" + id;
	s.scene = c->id == "H" ? obs_scene_create(oname.c_str()) : obs_canvas_scene_create(c->vc, oname.c_str());
	if (!s.scene)
		throw Error(rpc::INTERNAL, "scene create failed");
	scenes_.push_back(std::move(s));
	return scenes_.back();
}

Studio::Scene &Studio::make_scene(const json::Value &def)
{
	only_keys(def, {"id", "canvas", "name", "layers"}, "scene");
	std::string id = check_id(def.find("id"), "scene");
	const json::Value *cv = def.find("canvas");
	std::string cn = cv && cv->is_string() ? norm_canvas(cv->as_string()) : "";
	Scene &ref = new_scene(id, get_str(def, "name", id, 128, "scene"), cn);
	const json::Value *layers = def.find("layers");
	if (layers) {
		if (!layers->is_array() || layers->size() > 64)
			throw Error(rpc::INVALID_PARAMS, "scene " + ref.id + ": layers must be an array (max 64)");
		for (auto &ld : layers->as_array())
			ref.layers.push_back(make_layer(ref, ld));
		apply_order(ref);
	}
	return ref;
}

void Studio::make_canvases(const std::vector<model::Canvas> &defs, const std::map<std::string, bool> &mix)
{
	for (auto &d : defs) {
		Canvas c;
		c.id = d.id;
		c.w = d.w;
		c.h = d.h;
		c.fps = d.fps;
		if (d.id == "H") {
			std::string err;
			if (!obsrt::reset_main_video(d.w, d.h, d.fps, err))
				throw Error(rpc::CONFLICT, "canvas H reset failed: " + err);
		} else {
			struct obs_video_info ovi = {};
			obs_get_video_info(&ovi); // same graphics module/adapter/format as the main mix
			ovi.base_width = ovi.output_width = d.w;
			ovi.base_height = ovi.output_height = d.h;
			ovi.fps_num = d.fps;
			ovi.fps_den = 1;
			auto m = mix.find(d.id);
			uint32_t flags = ACTIVATE | EPHEMERAL | (m != mix.end() && m->second ? MIX_AUDIO : 0);
			c.vc = obs_canvas_create("V", &ovi, flags);
			if (!c.vc || !obs_canvas_has_video(c.vc))
				throw Error(rpc::INTERNAL, "V canvas create failed");
		}
		canvases_.push_back(c);
	}
}

json::Value Studio::load(const json::Value &project, bool outputs_active, const LoadOptions &o)
{
	std::lock_guard<std::recursive_mutex> lk(m_);
	if (outputs_active)
		throw Error(rpc::CONFLICT, "outputs are active: stop them before loading a project");
	if (!project.is_object())
		throw Error(rpc::INVALID_PARAMS, "project must be an object");
	return model::is_model(project) ? load_model(project, o) : load_test_format(project, o);
}

json::Value Studio::load_test_format(const json::Value &project, const LoadOptions &o)
{
	only_keys(project, {"format", "version", "name", "canvases", "scenes", "active", "note"}, "project");
	const json::Value *fmt = project.find("format");
	if (!fmt || !fmt->is_string() || fmt->as_string() != TEST_FORMAT)
		throw Error(rpc::INVALID_PARAMS, std::string("project: format must be \"") + TEST_FORMAT + "\" (or omit it for a project v1 document)");
	const json::Value *ver = project.find("version");
	if (ver && (!ver->is_int() || ver->as_int() != 1))
		throw Error(rpc::INVALID_PARAMS, "project: version must be 1");
	const json::Value *cvs = project.find("canvases");
	if (!cvs || !cvs->is_array() || cvs->size() < 1 || cvs->size() > 2)
		throw Error(rpc::INVALID_PARAMS, "project: canvases must list H and optionally V");
	std::vector<model::Canvas> defs;
	std::map<std::string, bool> mix;
	for (auto &c : cvs->as_array()) {
		only_keys(c, {"id", "w", "h", "fps", "mixAudio"}, "canvas");
		const json::Value *id = c.find("id");
		std::string n = id && id->is_string() ? norm_canvas(id->as_string()) : "";
		if (n.empty())
			throw Error(rpc::INVALID_PARAMS, "canvas id must be H or V");
		for (auto &d : defs)
			if (d.id == n)
				throw Error(rpc::INVALID_PARAMS, "duplicate canvas " + n);
		model::Canvas d;
		d.id = n;
		d.w = (uint32_t)get_int(c, "w", 0, 16, 8192, "canvas");
		d.h = (uint32_t)get_int(c, "h", 0, 16, 8192, "canvas");
		d.fps = (uint32_t)get_int(c, "fps", 60, 1, 240, "canvas");
		if (!d.w || !d.h)
			throw Error(rpc::INVALID_PARAMS, "canvas " + n + ": w and h are required");
		mix[n] = get_bool(c, "mixAudio", n == "H", "canvas");
		defs.push_back(d);
	}
	if (std::none_of(defs.begin(), defs.end(), [](const model::Canvas &d) { return d.id == "H"; }))
		throw Error(rpc::INVALID_PARAMS, "project: canvas H is required");

	// Replace the model: old scenes go first, then canvases are reset, then the new graph is built.
	teardown();
	try {
		make_canvases(defs, mix);
		const json::Value *scs = project.find("scenes");
		if (scs) {
			if (!scs->is_array() || scs->size() > 64)
				throw Error(rpc::INVALID_PARAMS, "project: scenes must be an array (max 64)");
			for (auto &sd : scs->as_array())
				make_scene(sd);
		}
		const json::Value *act = project.find("active");
		if (act) {
			if (!act->is_object())
				throw Error(rpc::INVALID_PARAMS, "project: active must be an object");
			for (auto &m : act->members()) {
				Canvas *c = canvas(m.first);
				Scene *s = c && m.second.is_string() ? scene(m.second.as_string(), c->id) : nullptr;
				if (!s)
					throw Error(rpc::INVALID_PARAMS, "project: active." + m.first.substr(0, 8) + " must name a scene on that canvas");
				set_channel(*c, s);
			}
		}
		for (auto &c : canvases_) { // default: the first scene of each canvas
			if (!c.active.empty())
				continue;
			for (auto &s : scenes_)
				if (s.canvas == c.id) {
					set_channel(c, &s);
					break;
				}
		}
		make_relay(o);
	} catch (...) {
		teardown();
		throw;
	}
	format_ = TEST_FORMAT;
	hlog::info("project loaded (host test format): %zu canvases, %zu scenes", canvases_.size(), scenes_.size());
	return get();
}

model::Options Studio::model_options(const json::Value &doc, const LoadOptions &o, devices::List &list,
				     bool list_devices) const
{
	model::Options mo;
	mo.bases = o.bases;
	mo.allow_devices = flags_.allow_devices;
	mo.allow_browser = flags_.allow_browser;
	mo.browser_urls = o.browser_urls;
	mo.overlay_port = o.overlay_port;
	const json::Value *d = doc.find("devices");
	if (list_devices && d && d->is_array() && d->size() > 0) {
		list = devices::enumerate(); // list-only (see devices.h)
		mo.devices = &list;
	}
	return mo;
}

json::Value Studio::plan(const json::Value &project, const LoadOptions &o) const
{
	if (!model::is_model(project))
		throw Error(rpc::INVALID_PARAMS, "project.plan takes a project v1 document");
	devices::List list;
	model::Options mo = model_options(project, o, list, flags_.allow_devices); // listing is a device feature (D38)
	model::Plan p = model::build(project, mo);
	json::Value r = model::to_json(p);
	r.set("devicesListed", mo.devices != nullptr);
	r.set("flags", [&] {
		json::Value f = json::Value::object();
		f.set("allowDevices", flags_.allow_devices);
		f.set("allowBrowser", flags_.allow_browser);
		return f;
	}());
	return r;
}

json::Value Studio::load_model(const json::Value &doc, const LoadOptions &o)
{
	devices::List list;
	// Devices are listed only when they could be used (list-only either way).
	model::Options mo = model_options(doc, o, list, flags_.allow_devices);
	model::Plan p = model::build(doc, mo);
	if (p.unavailable.size() > 0 && !o.skip_unavailable) {
		bool forbidden = false;
		for (auto &u : p.unavailable.as_array())
			if (u.find("code")->as_string() == "forbidden")
				forbidden = true;
		const json::Value &u0 = p.unavailable.as_array().front();
		const json::Value *who = u0.find("layer") ? u0.find("layer") : u0.find("audio");
		throw Error(forbidden ? rpc::FORBIDDEN : rpc::UNAVAILABLE,
			    std::to_string(p.unavailable.size()) + " layer or audio entr" + (p.unavailable.size() == 1 ? "y" : "ies") +
				    " cannot be built (first: " + who->as_string() + ": " + u0.find("reason")->as_string() +
				    "); pass skipUnavailable to load the rest, or project.plan to see all");
	}

	teardown();
	size_t items = 0;
	try {
		make_canvases(p.canvases, {{"V", false}}); // V outputs use the main mix (one audio encoder)
		std::map<std::string, std::shared_ptr<Src>> srcs;
		auto get_src = [&](const std::string &layer) {
			auto it = srcs.find(layer);
			if (it != srcs.end())
				return it->second;
			const model::Source &spec = p.sources.at(layer);
			obs_data_t *d = obs_data_create_from_json(spec.settings.dump().c_str());
			std::string name = "ujw:" + layer;
			obs_source_t *src = obs_source_create(spec.obs_type.c_str(), name.c_str(), d, nullptr);
			obs_data_release(d);
			if (!src)
				throw Error(rpc::INTERNAL, "source create failed for layer " + layer + " (" + spec.obs_type + ")");
			if (obs_source_get_output_flags(src) & OBS_SOURCE_AUDIO)
				obs_source_set_audio_mixers(src, 0); // no audio.sources entry: no tracks
			auto w = wrap(src, layer);
			srcs[layer] = w;
			return w;
		};
		for (auto &ps : p.scenes) {
			for (auto &pc : p.canvases) {
				Scene &s = new_scene(ps.id, ps.name, pc.id);
				auto it = ps.items.find(pc.id);
				if (it == ps.items.end())
					continue;
				for (auto &pi : it->second) {
					Layer l;
					l.id = pi.layer;
					l.name = pi.name;
					l.type = pi.type;
					l.placement = pi.placement;
					l.visible = pi.visible;
					if (pi.type == "duplicate")
						l.dup_of = pi.source_layer;
					l.src = get_src(pi.source_layer);
					try {
						add_item(s, l);
						apply_placement(l);
					} catch (...) {
						destroy_layer(l);
						throw;
					}
					obs_sceneitem_set_visible(l.item, l.visible);
					s.layers.push_back(std::move(l));
					items++;
				}
				apply_order(s);
			}
		}
		uint32_t channel = 1; // channel 0 is the active scene
		for (auto &a : p.audio) {
			std::shared_ptr<Src> target;
			if (!a.obs_type.empty()) {
				if (channel >= MAX_CHANNELS)
					throw Error(rpc::INVALID_PARAMS, "too many audio device sources");
				obs_data_t *d = obs_data_create_from_json(a.settings.dump().c_str());
				std::string name = "ujw:audio:" + a.id;
				obs_source_t *src = obs_source_create(a.obs_type.c_str(), name.c_str(), d, nullptr);
				obs_data_release(d);
				if (!src)
					throw Error(rpc::INTERNAL, "source create failed for audio " + a.id);
				target = wrap(src, "");
				obs_set_output_source(channel, src);
				globals_.push_back({target, channel++});
			} else {
				auto it = srcs.find(a.layer);
				if (it == srcs.end())
					continue; // the layer has no item on any canvas
				target = it->second;
			}
			target->audio_id = a.id;
			target->audio_name = a.name.empty() ? a.id : a.name;
			obs_source_set_volume(target->src, obs_db_to_mul((float)a.volume_db));
			obs_source_set_muted(target->src, a.muted);
			obs_source_set_audio_mixers(target->src, a.mixers);
			if (flags_.allow_devices) // monitoring opens an audio output device
				obs_source_set_monitoring_type(target->src, monitoring_type(a.monitoring));
		}
		for (auto &c : canvases_) {
			Scene *s = p.active.empty() ? nullptr : scene(p.active, c.id);
			if (s)
				set_channel(c, s);
		}
		size_t overlay_layers = 0;
		for (auto &kv : srcs)
			overlay_layers += p.sources.at(kv.first).overlay ? 1 : 0;
		if (overlay_layers)
			make_relay(o); // only when an overlay page was built
		hlog::info("project loaded (project v1):%zu canvases, %zu scenes, %zu sources, %zu items, %zu audio, %zu not built",
			   canvases_.size(), p.scenes.size(), srcs.size(), items, p.audio.size(), p.unavailable.size());
		format_ = "project-v1";
		model_doc_ = doc;
		dirty_ = false;
		json::Value r = get();
		json::Value counts = json::Value::object();
		counts.set("scenes", (uint64_t)p.scenes.size());
		counts.set("sources", (uint64_t)srcs.size());
		counts.set("items", (uint64_t)items);
		counts.set("audio", (uint64_t)p.audio.size());
		counts.set("overlayLayers", (uint64_t)overlay_layers);
		counts.set("relay", relay_ ? json::Value(relay_scope_) : json::Value());
		r.set("built", std::move(counts));
		r.set("unavailable", p.unavailable);
		r.set("warnings", p.warnings);
		return r;
	} catch (...) {
		teardown();
		throw;
	}
}

json::Value Studio::canvases_json() const
{
	std::lock_guard<std::recursive_mutex> lk(m_);
	json::Value a = json::Value::array();
	for (auto &c : canvases_) {
		json::Value o = json::Value::object();
		o.set("id", c.id);
		o.set("w", c.w);
		o.set("h", c.h);
		o.set("fps", c.fps);
		o.set("active", c.active.empty() ? json::Value() : json::Value(c.active));
		video_t *v = c.vc ? obs_canvas_get_video(c.vc) : obs_get_video();
		o.set("totalFrames", v ? video_output_get_total_frames(v) : 0u);
		o.set("skippedFrames", v ? video_output_get_skipped_frames(v) : 0u);
		a.push(std::move(o));
	}
	return a;
}

json::Value Studio::layer_json(const Scene &s, const Layer &l) const
{
	json::Value o = json::Value::object();
	o.set("id", l.id);
	o.set("name", l.name);
	o.set("type", l.type);
	o.set("canvas", s.canvas);
	o.set("visible", l.item ? obs_sceneitem_visible(l.item) : l.visible);
	if (format_ == TEST_FORMAT || l.placement.is_null()) {
		o.set("settings", l.settings);
		if (!l.transform.is_null())
			o.set("transform", l.transform);
	} else {
		o.set("placement", l.placement);
	}
	o.set("source", l.src ? l.src->owner : "");
	if (!l.dup_of.empty())
		o.set("duplicateOf", l.dup_of);
	obs_source_t *src = l.src ? l.src->src : nullptr;
	o.set("width", src ? obs_source_get_width(src) : 0u);
	o.set("height", src ? obs_source_get_height(src) : 0u);
	o.set("audio", l.src && l.src->meter != nullptr);
	return o;
}

json::Value Studio::scene_json(const Scene &s) const
{
	json::Value o = json::Value::object();
	o.set("id", s.id);
	o.set("name", s.name);
	o.set("canvas", s.canvas);
	const Canvas *c = canvas(s.canvas);
	o.set("active", c && c->active == s.id);
	json::Value layers = json::Value::array();
	for (auto &l : s.layers)
		layers.push(layer_json(s, l));
	o.set("layers", std::move(layers));
	return o;
}

// {format, dirty, project}. Project v1: the document as loaded (services/project owns the model of record; host
// edits are live-only and set dirty). Host test format: the live state, which loads back with project.load.
json::Value Studio::get() const
{
	std::lock_guard<std::recursive_mutex> lk(m_);
	json::Value r = json::Value::object();
	r.set("format", format_.empty() ? json::Value() : json::Value(format_));
	r.set("dirty", dirty_);
	r.set("relay", relay_ ? json::Value(relay_scope_) : json::Value());
	if (format_ != TEST_FORMAT) {
		r.set("project", model_doc_);
		return r;
	}
	json::Value p = json::Value::object();
	p.set("format", TEST_FORMAT);
	p.set("version", 1);
	json::Value cv = json::Value::array();
	json::Value active = json::Value::object();
	for (auto &c : canvases_) {
		json::Value o = json::Value::object();
		o.set("id", c.id);
		o.set("w", c.w);
		o.set("h", c.h);
		o.set("fps", c.fps);
		if (c.vc)
			o.set("mixAudio", (obs_canvas_get_flags(c.vc) & MIX_AUDIO) != 0);
		cv.push(std::move(o));
		if (!c.active.empty())
			active.set(c.id, c.active);
	}
	p.set("canvases", std::move(cv));
	json::Value sc = json::Value::array();
	// Model fields only, so that the output loads back with project.load (live fields such as
	// active/width/height/audio are in scenes.list and layers.list).
	for (auto &s : scenes_) {
		json::Value o = json::Value::object();
		o.set("id", s.id);
		o.set("name", s.name);
		o.set("canvas", s.canvas);
		json::Value layers = json::Value::array();
		for (auto &l : s.layers) {
			json::Value lo = json::Value::object();
			lo.set("id", l.id);
			lo.set("name", l.name);
			lo.set("type", l.type);
			lo.set("visible", l.item ? obs_sceneitem_visible(l.item) : l.visible);
			lo.set("settings", l.settings);
			if (!l.transform.is_null())
				lo.set("transform", l.transform);
			layers.push(std::move(lo));
		}
		o.set("layers", std::move(layers));
		sc.push(std::move(o));
	}
	p.set("scenes", std::move(sc));
	p.set("active", std::move(active));
	r.set("project", std::move(p));
	return r;
}

json::Value Studio::scenes_list(const std::string &cv) const
{
	std::lock_guard<std::recursive_mutex> lk(m_);
	std::string n = cv.empty() ? "" : norm_canvas(cv);
	if (!cv.empty() && n.empty())
		throw Error(rpc::INVALID_PARAMS, "canvas must be H or V");
	json::Value a = json::Value::array();
	for (auto &s : scenes_) {
		if (!n.empty() && s.canvas != n)
			continue;
		json::Value o = json::Value::object();
		o.set("id", s.id);
		o.set("name", s.name);
		o.set("canvas", s.canvas);
		const Canvas *c = canvas(s.canvas);
		o.set("active", c && c->active == s.id);
		o.set("layers", (uint64_t)s.layers.size());
		a.push(std::move(o));
	}
	json::Value r = json::Value::object();
	r.set("scenes", std::move(a));
	return r;
}

json::Value Studio::scene_create(const json::Value &def)
{
	std::lock_guard<std::recursive_mutex> lk(m_);
	size_t before = scenes_.size();
	try {
		Scene &s = make_scene(def);
		dirty_ = true;
		return scene_json(s);
	} catch (...) {
		if (scenes_.size() > before) {
			destroy_scene(scenes_.back());
			scenes_.pop_back();
		}
		throw;
	}
}

json::Value Studio::scene_remove(const std::string &id, const std::string &cv)
{
	std::lock_guard<std::recursive_mutex> lk(m_);
	auto list = scenes_named(id, cv);
	for (Scene *s : list) {
		Canvas *c = canvas(s->canvas);
		if (c && c->active == id)
			throw Error(rpc::CONFLICT, "scene is active on canvas " + s->canvas + ": activate another scene first");
	}
	json::Value cvs = json::Value::array();
	for (Scene *s : list) {
		cvs.push(s->canvas);
		destroy_scene(*s);
	}
	scenes_.erase(std::remove_if(scenes_.begin(), scenes_.end(), [](const Scene &x) { return x.scene == nullptr; }),
		      scenes_.end());
	dirty_ = true;
	json::Value r = json::Value::object();
	r.set("removed", id);
	r.set("canvases", std::move(cvs));
	return r;
}

json::Value Studio::scene_activate(const std::string &id, const std::string &cv)
{
	std::lock_guard<std::recursive_mutex> lk(m_);
	json::Value cvs = json::Value::array();
	for (Scene *s : scenes_named(id, cv)) {
		Canvas *c = canvas(s->canvas);
		set_channel(*c, s);
		cvs.push(c->id);
		hlog::info("scene activated: %s on %s", id.c_str(), c->id.c_str());
	}
	json::Value r = json::Value::object();
	r.set("canvas", cvs.as_array().front()); // day-1 field: the first canvas
	r.set("canvases", std::move(cvs));
	r.set("active", id);
	return r;
}

json::Value Studio::layers_list(const std::string &id, const std::string &cv) const
{
	std::lock_guard<std::recursive_mutex> lk(m_);
	const Scene *s = const_cast<Studio *>(this)->one_scene(id, cv);
	json::Value a = json::Value::array();
	for (auto &l : s->layers)
		a.push(layer_json(*s, l));
	json::Value r = json::Value::object();
	r.set("scene", s->id);
	r.set("canvas", s->canvas);
	r.set("layers", std::move(a)); // bottom to top
	return r;
}

json::Value Studio::layer_add(const std::string &sid, const std::string &cv, const json::Value &def, int64_t index)
{
	std::lock_guard<std::recursive_mutex> lk(m_);
	Scene *s = one_scene(sid, cv);
	if (s->layers.size() >= 64)
		throw Error(rpc::CONFLICT, "scene has 64 layers");
	Layer l = make_layer(*s, def);
	size_t at = index < 0 || (size_t)index > s->layers.size() ? s->layers.size() : (size_t)index;
	s->layers.insert(s->layers.begin() + (ptrdiff_t)at, std::move(l));
	apply_order(*s);
	dirty_ = true;
	return layers_list(sid, s->canvas);
}

json::Value Studio::layer_remove(const std::string &sid, const std::string &cv, const std::string &lid)
{
	std::lock_guard<std::recursive_mutex> lk(m_);
	json::Value done = json::Value::array();
	for (Scene *s : scenes_named(sid, cv)) {
		auto it = std::find_if(s->layers.begin(), s->layers.end(), [&](const Layer &l) { return l.id == lid; });
		if (it == s->layers.end())
			continue;
		destroy_layer(*it);
		s->layers.erase(it);
		done.push(s->canvas);
	}
	if (done.size() == 0)
		throw Error(rpc::INVALID_PARAMS, "no such layer");
	dirty_ = true;
	if (done.size() == 1)
		return layers_list(sid, done.as_array().front().as_string());
	json::Value r = json::Value::object();
	r.set("scene", sid);
	r.set("layer", lid);
	r.set("removed", true);
	r.set("canvases", std::move(done));
	return r;
}

json::Value Studio::layer_set_visible(const std::string &sid, const std::string &cv, const std::string &lid, bool visible)
{
	std::lock_guard<std::recursive_mutex> lk(m_);
	json::Value done = json::Value::array();
	for (Scene *s : scenes_named(sid, cv))
		for (auto &l : s->layers)
			if (l.id == lid) {
				obs_sceneitem_set_visible(l.item, visible);
				l.visible = visible;
				done.push(s->canvas);
			}
	if (done.size() == 0)
		throw Error(rpc::INVALID_PARAMS, "no such layer");
	dirty_ = true;
	json::Value r = json::Value::object();
	r.set("scene", sid);
	r.set("layer", lid);
	r.set("visible", visible);
	r.set("canvases", std::move(done));
	return r;
}

std::vector<Studio::LayerRef> Studio::hide_browser_layers()
{
	std::lock_guard<std::recursive_mutex> lk(m_);
	std::vector<LayerRef> hid;
	for (auto &s : scenes_)
		for (auto &l : s.layers) {
			if (!l.item || !l.visible || !l.src || !l.src->src)
				continue;
			const char *id = obs_source_get_id(l.src->src);
			if (!id || strcmp(id, "browser_source") != 0)
				continue;
			obs_sceneitem_set_visible(l.item, false);
			l.visible = false;
			hid.push_back({s.canvas, s.id, l.id});
		}
	if (!hid.empty())
		dirty_ = true;
	return hid;
}

size_t Studio::restore_layers(const std::vector<LayerRef> &refs)
{
	std::lock_guard<std::recursive_mutex> lk(m_);
	size_t n = 0;
	for (auto &r : refs)
		for (auto &s : scenes_)
			if (s.id == r.scene && s.canvas == r.canvas)
				for (auto &l : s.layers)
					if (l.id == r.layer && l.item && !l.visible) {
						obs_sceneitem_set_visible(l.item, true);
						l.visible = true;
						n++;
					}
	if (n)
		dirty_ = true;
	return n;
}

json::Value Studio::layer_move(const std::string &sid, const std::string &cv, const std::string &lid, int64_t index,
			       const std::string &dir)
{
	std::lock_guard<std::recursive_mutex> lk(m_);
	if (!dir.empty() && dir != "up" && dir != "down" && dir != "top" && dir != "bottom")
		throw Error(rpc::INVALID_PARAMS, "direction must be up, down, top or bottom");
	json::Value done = json::Value::array();
	for (Scene *s : scenes_named(sid, cv)) {
		auto it = std::find_if(s->layers.begin(), s->layers.end(), [&](const Layer &l) { return l.id == lid; });
		if (it == s->layers.end())
			continue;
		int64_t from = it - s->layers.begin(), n = (int64_t)s->layers.size(), to = from;
		if (dir == "up")
			to = std::min(n - 1, from + 1);
		else if (dir == "down")
			to = std::max<int64_t>(0, from - 1);
		else if (dir == "top")
			to = n - 1;
		else if (dir == "bottom")
			to = 0;
		else
			to = std::clamp<int64_t>(index, 0, n - 1);
		Layer l = std::move(*it);
		s->layers.erase(it);
		s->layers.insert(s->layers.begin() + (ptrdiff_t)to, std::move(l));
		apply_order(*s);
		done.push(s->canvas);
	}
	if (done.size() == 0)
		throw Error(rpc::INVALID_PARAMS, "no such layer");
	dirty_ = true;
	if (done.size() == 1)
		return layers_list(sid, done.as_array().front().as_string());
	json::Value r = json::Value::object();
	r.set("scene", sid);
	json::Value per = json::Value::array();
	for (auto &c : done.as_array())
		per.push(layers_list(sid, c.as_string()));
	r.set("canvases", std::move(per));
	return r;
}

// Mixer ids: "<scene>/<layer>" for a layer's source (the first item that shows it), "audio:<id>" for a project
// audio device source.
std::shared_ptr<Studio::Src> Studio::find_audio(const std::string &id)
{
	if (id.rfind("audio:", 0) == 0) {
		for (auto &g : globals_)
			if (g.src->audio_id == id.substr(6))
				return g.src;
		throw Error(rpc::INVALID_PARAMS, "no such audio source");
	}
	size_t slash = id.find('/');
	if (slash == std::string::npos)
		throw Error(rpc::INVALID_PARAMS, "mixer id is <scene>/<layer> or audio:<id>");
	for (Scene *s : scenes_named(id.substr(0, slash), "")) {
		for (auto &l : s->layers) {
			if (l.id == id.substr(slash + 1)) {
				if (!l.src || !l.src->meter)
					throw Error(rpc::INVALID_PARAMS, "layer has no audio");
				return l.src;
			}
		}
	}
	throw Error(rpc::INVALID_PARAMS, "no such layer");
}

int Studio::audio_peak_db(const std::string &audio_id, float &peak_db) const
{
	std::unique_lock<std::recursive_mutex> lk(m_, std::try_to_lock);
	if (!lk.owns_lock())
		return -1;
	if (audio_id.empty())
		return 0;
	for (auto &g : globals_)
		if (g.src && g.src->meter && g.src->audio_id == audio_id) {
			peak_db = g.src->meter->peak;
			return 1;
		}
	for (auto &s : scenes_)
		for (auto &l : s.layers)
			if (l.src && l.src->meter && l.src->audio_id == audio_id) {
				peak_db = l.src->meter->peak;
				return 1;
			}
	return 0;
}

json::Value Studio::mixer_list() const
{
	std::lock_guard<std::recursive_mutex> lk(m_);
	json::Value a = json::Value::array();
	std::set<const Src *> seen;
	auto entry = [&](const Src &src, const std::string &id, const std::string &scene, const std::string &layer,
			 const std::string &name, const std::string &cv) {
		json::Value o = json::Value::object();
		o.set("id", id);
		o.set("scene", scene.empty() ? json::Value() : json::Value(scene));
		o.set("layer", layer.empty() ? json::Value() : json::Value(layer));
		o.set("name", name);
		o.set("canvas", cv.empty() ? json::Value() : json::Value(cv));
		o.set("audioSource", src.audio_id.empty() ? json::Value() : json::Value(src.audio_id));
		float mul = obs_source_get_volume(src.src);
		o.set("volume", (double)mul);
		o.set("volumeDb", mul > 0 ? (double)obs_mul_to_db(mul) : json::Value());
		o.set("muted", obs_source_muted(src.src));
		o.set("mixers", obs_source_get_audio_mixers(src.src));
		o.set("active", obs_source_active(src.src));
		float pk = src.meter->peak, mg = src.meter->magnitude;
		o.set("peakDb", std::isfinite(pk) ? json::Value((double)pk) : json::Value());
		o.set("magnitudeDb", std::isfinite(mg) ? json::Value((double)mg) : json::Value());
		a.push(std::move(o));
	};
	// Project audio sources first (named by their project name, e.g. "Mic", "Game"), device sources before layer
	// audio; then layer sources with audio but no audio.sources entry (mixers 0: metered, not in any track).
	for (auto &g : globals_)
		if (g.src->meter && seen.insert(g.src.get()).second)
			entry(*g.src, "audio:" + g.src->audio_id, "", "", g.src->audio_name, "");
	for (int bound = 1; bound >= 0; bound--)
		for (auto &s : scenes_)
			for (auto &l : s.layers)
				if (l.src && l.src->meter && (l.src->audio_id.empty() != (bound == 1)) &&
				    seen.insert(l.src.get()).second)
					entry(*l.src, s.id + "/" + l.id, s.id, l.id,
					      l.src->audio_name.empty() ? l.name : l.src->audio_name, s.canvas);
	json::Value r = json::Value::object();
	r.set("sources", std::move(a));
	return r;
}

json::Value Studio::mixer_set_volume(const std::string &id, const double *mul, const double *db)
{
	std::lock_guard<std::recursive_mutex> lk(m_);
	auto s = find_audio(id);
	float v = mul ? (float)*mul : obs_db_to_mul((float)*db);
	obs_source_set_volume(s->src, v);
	dirty_ = true;
	json::Value r = json::Value::object();
	r.set("id", id);
	r.set("volume", (double)obs_source_get_volume(s->src));
	return r;
}

json::Value Studio::mixer_set_mute(const std::string &id, bool muted)
{
	std::lock_guard<std::recursive_mutex> lk(m_);
	auto s = find_audio(id);
	obs_source_set_muted(s->src, muted);
	dirty_ = true;
	json::Value r = json::Value::object();
	r.set("id", id);
	r.set("muted", obs_source_muted(s->src));
	return r;
}

video_t *Studio::canvas_video(const std::string &id) const
{
	std::lock_guard<std::recursive_mutex> lk(m_);
	const Canvas *c = canvas(id);
	if (!c)
		return nullptr;
	return c->id == "H" ? obs_get_video() : obs_canvas_get_video(c->vc);
}

bool Studio::canvas_size(const std::string &id, uint32_t &w, uint32_t &h, uint32_t &fps) const
{
	std::lock_guard<std::recursive_mutex> lk(m_);
	const Canvas *c = canvas(id);
	if (!c)
		return false;
	w = c->w;
	h = c->h;
	fps = c->fps;
	return true;
}
