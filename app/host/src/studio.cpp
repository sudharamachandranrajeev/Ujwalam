// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: scene model on libobs. See studio.h.
#include "studio.h"
#include "checks.h"
#include "effects.h"
#include "log.h"
#include "obs_runtime.h"
#include "rpc_server.h"

#include <obs-audio-controls.h>
#include <util/platform.h>

#include <algorithm>
#include <cctype>
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

// Project v1 audio.tracks as (id, name) in order: bit n of a source's mixers is track n. Empty for the test format.
std::vector<std::pair<std::string, std::string>> project_tracks(const json::Value &doc)
{
	std::vector<std::pair<std::string, std::string>> t;
	const json::Value *au = doc.find("audio");
	const json::Value *tr = au ? au->find("tracks") : nullptr;
	if (tr && tr->is_array())
		for (auto &x : tr->as_array()) {
			const json::Value *id = x.find("id"), *nm = x.find("name");
			if (id && id->is_string() && t.size() < 32)
				t.emplace_back(id->as_string(), nm && nm->is_string() ? nm->as_string() : id->as_string());
		}
	return t;
}

} // namespace

// Per-source audio meter (libobs volmeter, log fader). Values in dBFS, max over channels. last_ns: os_gettime_ns of
// the newest audio packet the source delivered (libobs calls capture callbacks for every packet, muted or not; a
// healthy WASAPI source sends packets, silent ones included, about every 10 ms). 0 = none yet.
struct Studio::Meter {
	obs_volmeter_t *vm = nullptr;
	obs_source_t *src = nullptr;
	std::atomic<float> peak{-INFINITY}, magnitude{-INFINITY};
	std::atomic<uint64_t> last_ns{0};
	static void on_audio(void *p, obs_source_t *, const struct audio_data *, bool)
	{
		static_cast<Meter *>(p)->last_ns = os_gettime_ns();
	}
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
	explicit Meter(obs_source_t *s) : src(s)
	{
		vm = obs_volmeter_create(OBS_FADER_LOG);
		obs_volmeter_attach_source(vm, src);
		obs_volmeter_add_callback(vm, cb, this);
		obs_source_add_audio_capture_callback(src, on_audio, this);
	}
	~Meter()
	{
		obs_source_remove_audio_capture_callback(src, on_audio, this);
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
	// Device audio sources replaced by the audio watchdog go last: the destroy of one whose capture died can block
	// libobs's destruction thread (obs_runtime.h shutdown guard).
	parked_.clear();
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

static void route_channel(const std::string &id, obs_canvas_t *vc, obs_source_t *src)
{
	if (id == "H")
		obs_set_output_source(0, src);
	else if (vc)
		obs_canvas_set_channel(vc, 0, src);
}

// Channel 0 of a canvas is its transition (created on first use, sized to the canvas); the scene is the transition's
// child. animate: a scene switch fades (fade with a duration) or plays the stinger (stinger); otherwise it cuts. The
// fade transition also does the cuts; while the type is stinger the stinger transition is on the channel instead
// (swapped with obs_transition_swap_begin/end, as the OBS frontend does). A transition that cannot be created (no
// obs-transitions module) falls back to routing the scene directly (cuts).
static void swap_to(const std::string &id, obs_canvas_t *vc, obs_source_t *&routed, obs_source_t *next)
{
	if (routed == next)
		return;
	if (routed && next) {
		obs_transition_swap_begin(next, routed);
		route_channel(id, vc, next);
		obs_transition_swap_end(next, routed);
	} else {
		route_channel(id, vc, next);
	}
	routed = next;
}

void Studio::set_channel(Canvas &c, Scene *s, bool animate)
{
	obs_source_t *src = s ? obs_scene_get_source(s->scene) : nullptr;
	if (!c.tr && src) {
		std::string name = "ujw:transition:" + c.id;
		c.tr = obs_source_create_private("fade_transition", name.c_str(), nullptr);
		if (c.tr)
			obs_transition_set_size(c.tr, c.w, c.h);
		else
			hlog::warn("canvas %s: fade_transition unavailable; scene switches cut", c.id.c_str());
	}
	if (!c.tr) {
		route_channel(c.id, c.vc, src);
		c.active = s ? s->id : "";
		return;
	}
	obs_source_t *want = c.tr_type == "stinger" && c.st ? c.st : c.tr;
	swap_to(c.id, c.vc, c.routed, want);
	bool change = animate && src && !c.active.empty() && (!s || c.active != s->id);
	if (change && want == c.st) {
		if (!obs_transition_start(c.st, OBS_TRANSITION_MODE_AUTO, 0, src))
			obs_transition_set(c.st, src);
	} else if (change && c.tr_type == "fade" && c.tr_ms > 0) {
		if (!obs_transition_start(c.tr, OBS_TRANSITION_MODE_AUTO, c.tr_ms, src))
			obs_transition_set(c.tr, src);
	} else {
		obs_transition_set(want, src);
	}
	c.active = s ? s->id : "";
}

json::Value Studio::transition_set(const std::string &cv, const std::string &type, int64_t ms, const json::Value *file,
				   int64_t point_ms, bool audio)
{
	std::lock_guard<std::recursive_mutex> lk(m_);
	if (type != "cut" && type != "fade" && type != "stinger")
		throw Error(rpc::INVALID_PARAMS, "type must be cut, fade or stinger");
	Canvas *c = canvas(norm_canvas(cv));
	if (!c)
		throw Error(rpc::INVALID_PARAMS, "unknown canvas");
	if (type == "stinger") {
		if (!file || !file->is_object())
			throw Error(rpc::INVALID_PARAMS, "a stinger needs file {base, rel}");
		std::string path = model::resolve_path_ref(*file, last_opts_.bases, "stinger");
		std::string ext = path.size() > 4 ? path.substr(path.find_last_of('.') == std::string::npos ? path.size() : path.find_last_of('.')) : "";
		std::transform(ext.begin(), ext.end(), ext.begin(), [](unsigned char ch) { return (char)std::tolower(ch); });
		if (ext != ".webm" && ext != ".mp4" && ext != ".mov" && ext != ".mkv")
			throw Error(rpc::INVALID_PARAMS, "stinger file must be .webm, .mp4, .mov or .mkv");
		std::string ref = file->find("base")->as_string() + ":" + file->find("rel")->as_string();
		obs_data_t *d = obs_data_create();
		obs_data_set_string(d, "path", path.c_str());
		obs_data_set_int(d, "tp_type", 0); // transition point in milliseconds
		obs_data_set_int(d, "transition_point", point_ms);
		obs_data_set_int(d, "audio_monitoring", 0); // stinger audio goes to the stream mix only
		obs_data_set_int(d, "audio_fade_style", 0); // scene audio fades out, then in
		if (!c->st) {
			std::string name = "ujw:stinger:" + c->id;
			c->st = obs_source_create_private("obs_stinger_transition", name.c_str(), d);
			if (c->st)
				obs_transition_set_size(c->st, c->w, c->h);
		} else if (ref != c->st_ref || (uint32_t)point_ms != c->st_point) {
			obs_source_update(c->st, d);
		}
		obs_data_release(d);
		if (!c->st)
			throw Error(rpc::UNAVAILABLE, "obs_stinger_transition unavailable (obs-transitions module)");
		obs_source_set_muted(c->st, !audio); // muted: the video plays, its sound stays out of the mix
		c->st_ref = ref;
		c->st_point = (uint32_t)point_ms;
		c->st_audio = audio;
		c->tr_ms = 0;
	} else {
		c->tr_ms = type == "fade" ? (uint32_t)ms : 0;
	}
	c->tr_type = type;
	if (c->tr && c->routed) { // put the right transition on the channel now, showing the same scene
		Scene *cur = c->active.empty() ? nullptr : scene(c->active, c->id);
		set_channel(*c, cur, false);
	}
	if (type != "stinger" && c->st) { // not needed any more (the call above took it off the channel)
		obs_source_release(c->st);
		c->st = nullptr;
		c->st_ref.clear();
		c->st_point = 0;
		c->st_audio = true;
	}
	hlog::info("transition %s: %s %u ms", c->id.c_str(), c->tr_type.c_str(), type == "stinger" ? c->st_point : c->tr_ms);
	return transitions();
}

json::Value Studio::transitions() const
{
	std::lock_guard<std::recursive_mutex> lk(m_);
	json::Value r = json::Value::object();
	for (auto &c : canvases_) {
		json::Value o = json::Value::object();
		o.set("type", c.tr_type);
		o.set("durationMs", (int64_t)c.tr_ms);
		if (c.tr_type == "stinger") {
			o.set("file", c.st_ref);
			o.set("pointMs", (int64_t)c.st_point);
			o.set("audio", c.st_audio);
		}
		o.set("available", c.tr != nullptr); // false before the first scene, or without obs-transitions
		r.set(c.id, std::move(o));
	}
	return r;
}

void Studio::destroy_layer(Layer &l)
{
	if (l.item) {
		obs_sceneitem_remove(l.item);
		l.item = nullptr;
	}
	if (l.fx) { // the wrapper (and its filters) first: it holds a reference on the shared source
		obs_source_release(l.fx);
		l.fx = nullptr;
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
	for (auto &c : canvases_) {
		set_channel(c, nullptr);
		if (c.tr || c.st) { // off the output before the release, then the transitions drop their scene references
			route_channel(c.id, c.vc, nullptr);
			c.routed = nullptr;
			if (c.tr)
				obs_source_release(c.tr);
			if (c.st)
				obs_source_release(c.st);
			c.tr = c.st = nullptr;
		}
	}
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
	s->created_ns = os_gettime_ns();
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
	l.item = obs_scene_add(s.scene, l.fx ? l.fx : l.src->src);
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
	// Shadow / glow (D257) draw past the box: the wrapper's output is larger by `out` canvas px on every side, so the
	// bounds grow by the same and the picture keeps its place and size (the centre does not move).
	const double out = l.fx ? fx::outset(l.effects) : 0;
	if (l.fx)
		fx::set_box(l.fx, std::max(w, 1.0), std::max(h, 1.0), l.effects);
	struct vec2 b;
	vec2_set(&b, (float)(std::max(w, 1.0) + 2 * out), (float)(std::max(h, 1.0) + 2 * out));
	obs_sceneitem_set_bounds(l.item, &b);
	obs_sceneitem_set_bounds_alignment(l.item, 0);
	struct vec2 pos;
	vec2_set(&pos, (float)(x + w / 2), (float)(y + h / 2));
	obs_sceneitem_set_pos(l.item, &pos);
	obs_sceneitem_set_rot(l.item, (float)get_num(p, "rotation", 0, -360, 360, "placement"));
	struct obs_sceneitem_crop cr = {};
	if (const json::Value *c = p.find("crop")) {
		cr.left = (int)std::lround(get_num(*c, "left", 0, 0, 16384, "crop"));
		cr.top = (int)std::lround(get_num(*c, "top", 0, 0, 16384, "crop"));
		cr.right = (int)std::lround(get_num(*c, "right", 0, 0, 16384, "crop"));
		cr.bottom = (int)std::lround(get_num(*c, "bottom", 0, 0, 16384, "crop"));
	}
	if (l.fx) {
		// Effects work on the cropped picture (rounded corners on the visible edge, blur clamped at the crop), so
		// the wrapper crops and the item does not.
		fx::set_crop(l.fx, {cr.left, cr.top, cr.right, cr.bottom});
		struct obs_sceneitem_crop none = {};
		obs_sceneitem_set_crop(l.item, &none);
	} else if (p.find("crop")) {
		obs_sceneitem_set_crop(l.item, &cr);
	}
	// Compositing (D291): a blend effect sets the item's blending mode (normal otherwise). The item is placed before it
	// is shown (load, layer add, setEffects staging), so the mode never changes on a visible picture.
	obs_sceneitem_set_blending_mode(l.item, fx::blending(l.effects));
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
	mo.test_capture = test_devices();
	const json::Value *d = doc.find("devices");
	if ((list_devices || mo.test_capture) && d && d->is_array() && d->size() > 0) {
		bool has = false;
		list = this->list_devices(has); // the parameter list_devices is the bool above
		if (has)
			mo.devices = &list;
	}
	return mo;
}

// ---- device hot-plug (D329) ----

devices::List Studio::list_devices(bool &has) const
{
	{
		std::lock_guard<std::mutex> lk(dev_m_);
		if (test_list_on_) {
			has = true;
			last_list_ = test_list_;
			have_list_ = true;
			return test_list_;
		}
	}
	has = flags_.allow_devices;
	if (!has)
		return {};
	devices::List l = devices::enumerate(); // list-only (see devices.h)
	note_list(l);
	return l;
}

void Studio::note_list(const devices::List &l) const
{
	std::lock_guard<std::mutex> lk(dev_m_);
	last_list_ = l;
	have_list_ = true;
}

void Studio::set_test_devices(const devices::List *l)
{
	std::lock_guard<std::mutex> lk(dev_m_);
	test_list_on_ = l != nullptr;
	test_list_ = l ? *l : devices::List{};
}

bool Studio::test_devices() const
{
	std::lock_guard<std::mutex> lk(dev_m_);
	return test_list_on_;
}

const json::Value *Studio::model_device(const std::string &id) const
{
	const json::Value *ds = format_ == "project-v1" ? model_doc_.find("devices") : nullptr;
	if (!ds || !ds->is_array())
		return nullptr;
	for (auto &d : ds->as_array())
		if (const json::Value *i = d.find("id"); i && i->is_string() && i->as_string() == id)
			return &d;
	return nullptr;
}

// Every capture source the scenes show, once (H, V and duplicates share one).
std::vector<std::shared_ptr<Studio::Src>> Studio::capture_srcs() const
{
	std::vector<std::shared_ptr<Src>> out;
	for (auto &s : scenes_)
		for (auto &l : s.layers)
			if (l.src && !l.src->device.empty() && std::find(out.begin(), out.end(), l.src) == out.end())
				out.push_back(l.src);
	return out;
}

bool Studio::device_loss_pending(const devices::List &l)
{
	std::lock_guard<std::recursive_mutex> lk(m_);
	for (auto &s : capture_srcs()) {
		const json::Value *spec = model_device(s->device);
		if (!spec)
			continue;
		devices::Binding b{s->bound_id, s->waiting};
		devices::Step st = devices::reconcile(*spec, b, l);
		if (st.act == devices::Step::Lose)
			return true;
	}
	return false;
}

// Seconds without a frame before attempt n + 1 (index n - 1); kConnectAttempts attempts in all.
static constexpr uint32_t kConnectDelaysMs[Studio::kConnectAttempts] = {3000, 6000, 12000, 24000, 30000};

void Studio::set_check_scheduler(std::function<void(uint32_t)> f)
{
	std::lock_guard<std::mutex> lk(dev_m_);
	check_ = std::move(f);
}

bool Studio::has_frame(const Src &s)
{
	// The last frame is cleared before every attempt (obs_source_output_video(nullptr): no size until a new frame),
	// so a size means this activation delivered a frame.
	return s.src && obs_source_get_width(s.src) > 0;
}

void Studio::connect_attempt(Src &s, const std::string &obs_id, bool update)
{
	if (update) {
		// Only this source re-activates (win-dshow queues the activation on its own thread); encoders, outputs
		// and every other source are untouched.
		obs_source_output_video(s.src, nullptr);
		obs_data_t *d = obs_data_create();
		obs_data_set_string(d, "video_device_id", obs_id.c_str());
		obs_source_update(s.src, d);
		obs_data_release(d);
	}
	s.connecting = true;
	s.attempts++;
	s.attempt_ns = os_gettime_ns();
}

void Studio::schedule_connect_check()
{
	uint64_t now = os_gettime_ns(), next = 0;
	for (auto &s : capture_srcs()) {
		if (s->waiting || !s->connecting || s->attempts == 0 || s->attempts > kConnectAttempts)
			continue;
		uint64_t due = s->attempt_ns + (uint64_t)kConnectDelaysMs[s->attempts - 1] * 1000000ull;
		uint64_t in = due > now ? due - now : 0;
		if (next == 0 || in < next)
			next = in == 0 ? 1 : in;
	}
	if (next == 0)
		return;
	std::lock_guard<std::mutex> lk(dev_m_);
	if (check_)
		check_((uint32_t)std::min<uint64_t>(next / 1000000ull + 50, 60000));
}

bool Studio::connect_checks(json::Value &changes, const char *why)
{
	uint64_t now = os_gettime_ns();
	bool moved = false;
	for (auto &s : capture_srcs()) {
		if (s->waiting || !s->connecting)
			continue;
		if (has_frame(*s)) {
			s->connecting = false;
			s->attempts = 0;
			moved = true;
			continue;
		}
		if (s->attempts == 0 || s->attempts >= kConnectAttempts)
			continue; // the last attempt failed: stay connecting with a message (a plug event starts over)
		if (now < s->attempt_ns + (uint64_t)kConnectDelaysMs[s->attempts - 1] * 1000000ull)
			continue;
		connect_attempt(*s, s->bound_id, true);
		json::Value c = json::Value::object();
		c.set("layer", s->owner);
		c.set("device", s->device);
		c.set("action", "retry");
		c.set("attempt", (uint64_t)s->attempts);
		hlog::warn("devices (%s): layer %s: no picture from device %s yet; activation attempt %u", why,
			   s->owner.c_str(), s->device.c_str(), s->attempts);
		changes.push(std::move(c));
		moved = true;
	}
	schedule_connect_check();
	return moved;
}

json::Value Studio::devices_changed(const devices::List &l, const char *why, const std::vector<std::string> &removed, bool event)
{
	note_list(l);
	json::Value changes = json::Value::array();
	{
		std::lock_guard<std::recursive_mutex> lk(m_);
		for (auto &s : capture_srcs()) {
			const json::Value *spec = model_device(s->device);
			if (!spec)
				continue;
			devices::Binding b{s->bound_id, s->waiting};
			devices::Step st = devices::reconcile(*spec, b, l, removed);
			json::Value c = json::Value::object();
			c.set("layer", s->owner);
			c.set("device", s->device);
			if (st.act == devices::Step::Bind) {
				s->attempts = 0; // a device event starts the attempts over
				connect_attempt(*s, st.obs_id, true);
				s->bound_id = st.obs_id;
				s->matched_by = st.matched_by;
				s->waiting = false;
				s->problem.clear();
				s->binds++;
				c.set("action", "bound");
				c.set("matchedBy", st.matched_by);
				hlog::info("devices (%s): layer %s bound to device %s (matched by %s)", why, s->owner.c_str(),
					   s->device.c_str(), st.matched_by.c_str());
			} else if (st.act == devices::Step::Lose) {
				// The device left: waiting. The last frame is cleared (async video); the device graph is left to
				// win-dshow, and a false alarm only costs one frame (the next frame paints again).
				obs_source_output_video(s->src, nullptr);
				s->waiting = true;
				s->connecting = false;
				s->attempts = 0;
				s->problem = st.problem;
				c.set("action", "lost");
				c.set("message", devices::waiting_message(*spec, st.problem));
				hlog::warn("devices (%s): layer %s lost device %s; waiting for it", why, s->owner.c_str(), s->device.c_str());
			} else {
				if (s->waiting)
					s->problem = st.problem;
				continue;
			}
			changes.push(std::move(c));
		}
		if (connect_checks(changes, why))
			event = true; // a source got its picture, or was retried: the pages refresh its state
	}
	uint64_t seq = event || changes.size() ? ++dev_seq_ : dev_seq_.load();
	json::Value r = json::Value::object();
	r.set("seq", seq);
	r.set("changes", std::move(changes));
	return r;
}

json::Value Studio::devices_status() const
{
	json::Value r = json::Value::object();
	r.set("seq", dev_seq_.load());
	devices::List l;
	bool have = false;
	{
		std::lock_guard<std::mutex> lk(dev_m_);
		have = have_list_;
		if (have)
			l = last_list_;
	}
	r.set("listed", have);
	json::Value waiting = json::Value::array(), connecting = json::Value::array();
	json::Value connected = json::Value::object();
	std::unique_lock<std::recursive_mutex> lk(m_, std::try_to_lock); // never wait on a load in host.status
	if (lk.owns_lock()) {
		for (auto &s : capture_srcs()) {
			if (!s->waiting && s->connecting && !has_frame(*s)) {
				const json::Value *spec = model_device(s->device);
				json::Value w = json::Value::object();
				w.set("layer", s->owner);
				w.set("device", s->device);
				w.set("attempt", (uint64_t)s->attempts);
				if (s->attempts > 1 && spec)
					w.set("message", devices::connecting_message(*spec, s->attempts >= kConnectAttempts));
				connecting.push(std::move(w));
				continue;
			}
			if (!s->waiting)
				continue;
			const json::Value *spec = model_device(s->device);
			json::Value w = json::Value::object();
			w.set("layer", s->owner);
			w.set("device", s->device);
			w.set("message", spec ? devices::waiting_message(*spec, s->problem) : std::string("Waiting for its device."));
			waiting.push(std::move(w));
		}
		const json::Value *ds = format_ == "project-v1" ? model_doc_.find("devices") : nullptr;
		if (have && ds && ds->is_array())
			for (auto &d : ds->as_array()) {
				const json::Value *id = d.find("id");
				if (id && id->is_string())
					connected.set(id->as_string(), devices::resolve(d, l).entry != nullptr);
			}
	}
	r.set("busy", !lk.owns_lock());
	r.set("waiting", std::move(waiting));
	r.set("connecting", std::move(connecting));
	r.set("connected", std::move(connected));
	return r;
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
			auto w = make_src(p.sources.at(layer), layer);
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
					l.effects = pi.effects;
					try {
						if (!l.effects.empty()) // one wrapper per item: effects never reach the shared source
							l.fx = fx::create_chain(l.src->src, "ujw:fx:" + pc.id + ":" + pi.layer, l.effects, {});
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
		last_opts_ = o;
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
		r.set("waiting", p.waiting);
		r.set("warnings", p.warnings);
		return r;
	} catch (...) {
		teardown();
		throw;
	}
}

std::shared_ptr<Studio::Src> Studio::make_src(const model::Source &spec, const std::string &layer)
{
	obs_data_t *d = obs_data_create_from_json(spec.settings.dump().c_str());
	std::string name = "ujw:" + layer;
	obs_source_t *src = obs_source_create(spec.obs_type.c_str(), name.c_str(), d, nullptr);
	obs_data_release(d);
	if (!src)
		throw Error(rpc::INTERNAL, "source create failed for layer " + layer + " (" + spec.obs_type + ")");
	if (obs_source_get_output_flags(src) & OBS_SOURCE_AUDIO)
		obs_source_set_audio_mixers(src, 0); // no audio.sources entry: no tracks
	auto w = wrap(src, layer);
	if (spec.type == "capture") { // D329: the watcher binds / rebinds it
		w->device = spec.device;
		const json::Value *id = spec.settings.find("video_device_id");
		w->bound_id = id && id->is_string() ? id->as_string() : "";
		w->waiting = spec.waiting;
		w->problem = spec.wait_problem;
		w->matched_by = spec.matched_by;
		if (!w->waiting && !w->bound_id.empty()) { // built with a device: connecting until its first frame
			connect_attempt(*w, w->bound_id, false);
			std::lock_guard<std::mutex> lk(dev_m_);
			if (check_)
				check_(kConnectDelaysMs[0] + 50);
		}
	}
	return w;
}

// The source a layer owns, when any scene on any canvas still shows it.
std::shared_ptr<Studio::Src> Studio::find_src(const std::string &owner)
{
	for (auto &s : scenes_)
		for (auto &l : s.layers)
			if (l.src && l.src->owner == owner)
				return l.src;
	return nullptr;
}

// A plan.unavailable entry as the sentence the studio shows (D329: what is missing, what to do).
static std::string plain_unavailable(const json::Value &u)
{
	std::string lid = u.find("layer") && u.find("layer")->is_string() ? u.find("layer")->as_string() : "?";
	std::string reason = u.find("reason")->as_string();
	if (u.find("code")->as_string() == "forbidden" && reason.find("capture devices are disabled") == 0)
		return "Layer " + lid + " cannot be added: this start of Ujwalam has capture devices switched off. Start Ujwalam "
		       "with devices allowed (the normal start does) and add the layer again. (" + reason + ")";
	if (u.find("code")->as_string() == "forbidden")
		return "Layer " + lid + " cannot be added: that feature is switched off in this start of Ujwalam (" + reason + ").";
	return "Layer " + lid + " cannot be added: " + reason + ".";
}

json::Value Studio::layer_add_model(const json::Value &doc, const std::string &sid, const std::string &lid)
{
	std::lock_guard<std::recursive_mutex> lk(m_);
	if (format_ != "project-v1")
		throw Error(rpc::CONFLICT, "no project v1 is loaded");
	if (!model::is_model(doc))
		throw Error(rpc::INVALID_PARAMS, "project must be a project v1 document");
	devices::List list;
	model::Options mo = model_options(doc, last_opts_, list, flags_.allow_devices);
	model::Plan p = model::build(doc, mo);
	for (auto &u : p.unavailable.as_array())
		if (const json::Value *l = u.find("layer"); l && l->is_string() && l->as_string() == lid)
			throw Error(u.find("code")->as_string() == "forbidden" ? rpc::FORBIDDEN : rpc::UNAVAILABLE,
				    plain_unavailable(u));
	auto ps = std::find_if(p.scenes.begin(), p.scenes.end(), [&](const model::Scene &x) { return x.id == sid; });
	if (ps == p.scenes.end())
		throw Error(rpc::INVALID_PARAMS, "no such scene in the project: " + sid);
	// Check every canvas first, so a refusal changes nothing.
	struct Todo {
		Scene *s;
		const model::Item *pi;
		size_t at;
	};
	std::vector<Todo> todo;
	for (auto &kv : ps->items) {
		size_t at = 0;
		for (auto &pi : kv.second) {
			if (pi.layer != lid) {
				at++;
				continue;
			}
			Scene *s = scene(sid, kv.first);
			if (!s)
				throw Error(rpc::CONFLICT, "scene " + sid + " is not on canvas " + kv.first + ": create it first");
			for (auto &x : s->layers)
				if (x.id == lid)
					throw Error(rpc::CONFLICT, "layer " + lid + " is already on canvas " + kv.first);
			if (s->layers.size() >= 64)
				throw Error(rpc::CONFLICT, "scene has 64 layers");
			todo.push_back({s, &pi, at});
		}
	}
	if (todo.empty())
		throw Error(rpc::INVALID_PARAMS, "layer " + lid + " is not in scene " + sid + " of the project");
	json::Value cvs = json::Value::array();
	bool overlay = false;
	for (auto &t : todo) {
		const model::Item &pi = *t.pi;
		Layer l;
		l.id = pi.layer;
		l.name = pi.name;
		l.type = pi.type;
		l.placement = pi.placement;
		l.visible = pi.visible;
		if (pi.type == "duplicate")
			l.dup_of = pi.source_layer;
		auto spec = p.sources.find(pi.source_layer);
		if (spec == p.sources.end())
			throw Error(rpc::UNAVAILABLE, "layer " + lid + ": source layer " + pi.source_layer + " is not built");
		l.src = find_src(pi.source_layer);
		if (!l.src)
			l.src = make_src(spec->second, pi.source_layer);
		overlay = overlay || spec->second.overlay;
		l.effects = pi.effects;
		try {
			if (!l.effects.empty())
				l.fx = fx::create_chain(l.src->src, "ujw:fx:" + t.s->canvas + ":" + pi.layer, l.effects, {});
			add_item(*t.s, l);
			apply_placement(l);
		} catch (...) {
			destroy_layer(l);
			throw;
		}
		obs_sceneitem_set_visible(l.item, l.visible);
		size_t at = std::min(t.at, t.s->layers.size());
		t.s->layers.insert(t.s->layers.begin() + (ptrdiff_t)at, std::move(l));
		apply_order(*t.s);
		cvs.push(t.s->canvas);
	}
	if (overlay && !relay_)
		make_relay(last_opts_);
	model_doc_ = doc;
	dirty_ = false;
	json::Value r = json::Value::object();
	r.set("scene", sid);
	r.set("layer", lid);
	r.set("canvases", std::move(cvs));
	// D329: a capture layer whose device is not connected is added waiting; the studio shows the message.
	std::string src_layer = lid;
	for (auto &t : todo)
		src_layer = t.pi->source_layer;
	json::Value wait;
	if (auto s = find_src(src_layer); s && s->waiting) { // the built source says (it may be shared and older)
		const json::Value *spec = model_device(s->device);
		wait = json::Value::object();
		wait.set("layer", src_layer);
		wait.set("device", s->device);
		wait.set("message", spec ? devices::waiting_message(*spec, s->problem) : std::string("Waiting for its device."));
	}
	r.set("waiting", wait);
	hlog::info("layer added from the project: %s in %s%s", lid.c_str(), sid.c_str(), wait.is_null() ? "" : " (waiting for its device)");
	return r;
}

// Layer order from the project (D243): each canvas's scene items take the order of the document's scene (bottom
// first; the plan lists only the layers on that canvas). Layers the host has but the plan lacks (skipped as
// unavailable at load) keep their place after the ordered ones. Nothing is added or removed.
json::Value Studio::layer_order_model(const json::Value &doc, const std::string &sid)
{
	std::lock_guard<std::recursive_mutex> lk(m_);
	if (format_ != "project-v1")
		throw Error(rpc::CONFLICT, "no project v1 is loaded");
	if (!model::is_model(doc))
		throw Error(rpc::INVALID_PARAMS, "project must be a project v1 document");
	devices::List list;
	model::Options mo = model_options(doc, last_opts_, list, flags_.allow_devices);
	model::Plan p = model::build(doc, mo);
	auto ps = std::find_if(p.scenes.begin(), p.scenes.end(), [&](const model::Scene &x) { return x.id == sid; });
	if (ps == p.scenes.end())
		throw Error(rpc::INVALID_PARAMS, "no such scene in the project: " + sid);
	json::Value cvs = json::Value::array();
	for (auto &kv : ps->items) {
		Scene *s = scene(sid, kv.first);
		if (!s)
			continue;
		std::map<std::string, size_t> rank;
		for (size_t i = 0; i < kv.second.size(); i++)
			rank[kv.second[i].layer] = i;
		auto key = [&](const Layer &l) {
			auto it = rank.find(l.id);
			return it == rank.end() ? kv.second.size() : it->second;
		};
		std::stable_sort(s->layers.begin(), s->layers.end(), [&](const Layer &a, const Layer &b) { return key(a) < key(b); });
		apply_order(*s);
		cvs.push(s->canvas);
	}
	if (cvs.as_array().empty())
		throw Error(rpc::CONFLICT, "scene " + sid + " is on no canvas of the host");
	model_doc_ = doc;
	dirty_ = false;
	hlog::info("layer order from the project: %s", sid.c_str());
	json::Value r = json::Value::object();
	r.set("scene", sid);
	r.set("canvases", std::move(cvs));
	return r;
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
	if (!l.effects.empty())
		o.set("effects", model::effects_json(l.effects));
	obs_source_t *src = l.src ? l.src->src : nullptr;
	o.set("width", src ? obs_source_get_width(src) : 0u);
	o.set("height", src ? obs_source_get_height(src) : 0u);
	o.set("audio", l.src && l.src->meter != nullptr);
	if (l.src && !l.src->device.empty()) { // capture layer (D329)
		json::Value d = json::Value::object();
		d.set("id", l.src->device);
		const bool connecting = !l.src->waiting && l.src->connecting && !has_frame(*l.src);
		d.set("state", l.src->waiting ? "waiting" : connecting ? "connecting" : "connected");
		const json::Value *spec = model_device(l.src->device);
		if (l.src->waiting) {
			d.set("message", spec ? devices::waiting_message(*spec, l.src->problem) : std::string("Waiting for its device."));
		} else if (connecting) {
			d.set("attempt", (uint64_t)l.src->attempts);
			if (l.src->attempts > 1 && spec)
				d.set("message", devices::connecting_message(*spec, l.src->attempts >= kConnectAttempts));
		}
		d.set("binds", (uint64_t)l.src->binds);
		o.set("device", std::move(d));
	}
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
		set_channel(*c, s, true);
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

// Inspector edit (P5a, 2026-11-06): merges `patch` (any of x, y, width, height, rotation, crop{left,top,right,bottom},
// canvas pixels / degrees / source pixels) into the project v1 placement of every item of layer `lid` and applies it.
// The whole patch is checked before anything changes; width/height stay >= 1 (hide a layer with setVisible instead).
// Host test-format layers (no project placement) are refused. In memory only, like setVisible/move (dirty).
json::Value Studio::layer_set_placement(const std::string &sid, const std::string &cv, const std::string &lid,
					const json::Value &patch)
{
	const std::string what = "placement";
	if (!patch.is_object() || patch.size() == 0)
		throw Error(rpc::INVALID_PARAMS, "placement: give at least one of x, y, width, height, rotation, crop");
	only_keys(patch, {"x", "y", "width", "height", "rotation", "crop"}, what);
	for (const char *k : {"x", "y"})
		get_num(patch, k, 0, -16384, 16384, what);
	for (const char *k : {"width", "height"})
		get_num(patch, k, 1, 1, 16384, what);
	get_num(patch, "rotation", 0, -360, 360, what);
	const json::Value *crop = patch.find("crop");
	if (crop) {
		if (!crop->is_object())
			throw Error(rpc::INVALID_PARAMS, "placement: crop must be an object");
		only_keys(*crop, {"left", "top", "right", "bottom"}, "crop");
		for (const char *k : {"left", "top", "right", "bottom"})
			get_num(*crop, k, 0, 0, 16384, "crop");
	}
	std::lock_guard<std::recursive_mutex> lk(m_);
	std::vector<Layer *> targets;
	std::vector<std::string> cvs;
	for (Scene *s : scenes_named(sid, cv))
		for (auto &l : s->layers)
			if (l.id == lid) {
				if (l.placement.is_null())
					throw Error(rpc::INVALID_PARAMS, "layer has no project placement");
				targets.push_back(&l);
				cvs.push_back(s->canvas);
			}
	if (targets.empty())
		throw Error(rpc::INVALID_PARAMS, "no such layer");
	json::Value done = json::Value::array();
	json::Value last;
	for (size_t i = 0; i < targets.size(); i++) {
		Layer &l = *targets[i];
		json::Value merged = l.placement;
		for (auto &kv : patch.members()) {
			if (kv.first != "crop") {
				merged.set(kv.first, kv.second);
				continue;
			}
			json::Value c = json::Value::object();
			if (const json::Value *old = merged.find("crop"))
				if (old->is_object())
					c = *old;
			for (auto &ck : kv.second.members())
				c.set(ck.first, ck.second);
			merged.set("crop", c);
		}
		l.placement = merged;
		apply_placement(l);
		done.push(cvs[i]);
		last = merged;
	}
	dirty_ = true;
	json::Value r = json::Value::object();
	r.set("scene", sid);
	r.set("layer", lid);
	r.set("placement", last);
	r.set("canvases", std::move(done));
	return r;
}

// Effect editor (D260): replaces the effects of layer `lid` in scene `sid` on every canvas (effects belong to the
// layer, not to a placement). Two steps, so the picture never shows a half-done change (Codex review D260):
//   stage:  per canvas a new wrapper chain (or none) and a new scene item over it, added hidden and placed. A failure
//           on any canvas removes every staged item: nothing visible has changed.
//   commit: per scene, inside obs_scene_atomic_update (the renderer waits on the scene's lock): the new item takes the
//           old one's place in the order and its visibility, the old one is hidden. Then the hidden old items are
//           removed and their wrappers released. Nothing in the commit can fail.
// The list is checked first (model.cpp). Project v1 layers only. In memory only (dirty), like setPlacement: the studio
// UI server saves it into the project file.
json::Value Studio::layer_set_effects(const std::string &sid, const std::string &lid, const json::Value &effects)
{
	std::lock_guard<std::recursive_mutex> lk(m_);
	// lut / imageMask files (D291) resolve against the bases of the last load; a missing file refuses the list
	const std::vector<model::Effect> fxs = model::parse_effects(&effects, "layer " + lid, &last_opts_.bases);
	struct Todo {
		Scene *s;
		Layer *l;
		Layer staged;
	};
	std::vector<Todo> todo;
	for (Scene *s : scenes_named(sid, ""))
		for (auto &l : s->layers)
			if (l.id == lid) {
				if (l.placement.is_null())
					throw Error(rpc::INVALID_PARAMS, "layer has no project placement");
				todo.push_back({s, &l, {}});
			}
	if (todo.empty())
		throw Error(rpc::INVALID_PARAMS, "no such layer");
	try {
		for (auto &t : todo) {
			t.staged = *t.l;
			t.staged.item = nullptr;
			t.staged.fx = nullptr;
			t.staged.effects = fxs;
			if (!fxs.empty())
				t.staged.fx = fx::create_chain(t.l->src->src, "ujw:fx:" + t.s->canvas + ":" + lid, fxs, {});
			add_item(*t.s, t.staged);
			obs_sceneitem_set_visible(t.staged.item, false);
			apply_placement(t.staged);
		}
	} catch (...) {
		for (auto &t : todo) {
			if (t.staged.item)
				obs_sceneitem_remove(t.staged.item);
			if (t.staged.fx)
				obs_source_release(t.staged.fx);
		}
		throw;
	}
	struct Swap {
		obs_sceneitem_t *old_item, *new_item;
		bool visible;
		std::vector<obs_sceneitem_t *> order; // bottom to top, the old item just under the new one
	};
	std::vector<obs_sceneitem_t *> old_items;
	std::vector<obs_source_t *> old_fx;
	json::Value done = json::Value::array();
	for (auto &t : todo) {
		Layer &l = *t.l;
		Swap sw{l.item, t.staged.item, t.staged.visible && l.visible, {}};
		for (auto &x : t.s->layers) {
			if (&x == &l)
				sw.order.push_back(l.item);
			sw.order.push_back(&x == &l ? t.staged.item : x.item);
		}
		obs_scene_atomic_update(
			t.s->scene,
			[](void *p, obs_scene_t *scene) {
				auto *w = static_cast<Swap *>(p);
				obs_scene_reorder_items(scene, w->order.data(), w->order.size());
				obs_sceneitem_set_visible(w->old_item, false);
				obs_sceneitem_set_visible(w->new_item, w->visible);
			},
			&sw);
		old_items.push_back(l.item);
		old_fx.push_back(l.fx);
		l.item = t.staged.item;
		l.fx = t.staged.fx;
		l.effects = fxs;
		l.visible = sw.visible;
		done.push(t.s->canvas);
	}
	for (obs_sceneitem_t *it : old_items)
		obs_sceneitem_remove(it);
	for (obs_source_t *f : old_fx)
		if (f)
			obs_source_release(f);
	dirty_ = true;
	json::Value r = json::Value::object();
	r.set("scene", sid);
	r.set("layer", lid);
	r.set("effects", model::effects_json(fxs));
	r.set("canvases", std::move(done));
	return r;
}

bool Studio::preview_items(const std::string &cv, std::string &sid, std::vector<pedit::Item> &top_first) const
{
	std::lock_guard<std::recursive_mutex> lk(m_);
	top_first.clear();
	sid.clear();
	const Canvas *c = canvas(cv);
	if (!c || c->active.empty() || format_ == TEST_FORMAT)
		return false;
	const Scene *s = scene(c->active, cv);
	if (!s)
		return false;
	sid = s->id;
	for (auto it = s->layers.rbegin(); it != s->layers.rend(); ++it) {
		const Layer &l = *it;
		if (l.placement.is_null() || !l.item || !obs_sceneitem_visible(l.item))
			continue;
		const json::Value &p = l.placement;
		auto num = [&p](const char *k) {
			const json::Value *v = p.find(k);
			return v && v->is_number() ? v->as_double() : 0.0;
		};
		pedit::Item item;
		item.id = l.id;
		item.r.x = num("x");
		item.r.y = num("y");
		item.r.w = num("width");
		item.r.h = num("height");
		item.r.rot = num("rotation");
		if (const json::Value *cr = p.find("crop"); cr && cr->is_object()) {
			auto side = [cr](const char *k) {
				const json::Value *v = cr->find(k);
				return v && v->is_number() ? v->as_double() : 0.0;
			};
			item.r.cl = side("left");
			item.r.ct = side("top");
			item.r.cr = side("right");
			item.r.cb = side("bottom");
		}
		if (l.src && l.src->src) { // the crop gesture needs the source size (D256); 0 x 0 (not loaded yet): none
			item.r.sw = obs_source_get_width(l.src->src);
			item.r.sh = obs_source_get_height(l.src->src);
		}
		if (item.r.w <= 0 || item.r.h <= 0)
			continue;
		// A browser page covering (nearly) the whole canvas is a transparent effect / atmosphere layer: a click
		// goes through it to the layers below (D233). It stays editable from the inspector.
		const char *sid_type = l.src && l.src->src ? obs_source_get_id(l.src->src) : nullptr;
		if (sid_type && strcmp(sid_type, "browser_source") == 0 && c->w > 0 && c->h > 0 &&
		    item.r.w * item.r.h >= 0.9 * (double)c->w * (double)c->h)
			continue;
		top_first.push_back(std::move(item));
	}
	return true;
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

obs_source_t *Studio::layer_source_ref(const std::string &layer_id, std::string &type) const
{
	std::lock_guard<std::recursive_mutex> lk(m_);
	bool found = false;
	for (auto &s : scenes_)
		for (auto &l : s.layers) {
			if (l.id != layer_id)
				continue;
			found = true;
			if (!l.src || !l.src->src)
				continue;
			// The shared source (a duplicate's points at its target's); never the layer's private effects wrapper,
			// so placement crop, effects and anything composed above the layer never reach the caller.
			if (!(obs_source_get_output_flags(l.src->src) & OBS_SOURCE_VIDEO))
				throw Error(rpc::INVALID_PARAMS, "layer has no video");
			type = l.type;
			obs_source_t *ref = obs_source_get_ref(l.src->src);
			if (!ref)
				throw Error(rpc::UNAVAILABLE, "layer source is being removed");
			return ref;
		}
	throw Error(rpc::INVALID_PARAMS, found ? "layer has no source" : "no such layer");
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

// ---- audio health (D297 proposed). Device audio globals only: a layer's audio (capture card dshow, media) is
// reported in mixer.list (receiving, lastDataMs) but never recreated here.
namespace {
constexpr size_t kAudioEvents = 32;

int64_t ms_since(uint64_t now, uint64_t then)
{
	return then && now > then ? (int64_t)((now - then) / 1000000) : 0;
}
} // namespace

void Studio::set_audio_health(const AudioHealthCfg &c)
{
	std::lock_guard<std::recursive_mutex> lk(m_);
	health_ = c;
}

// state: ok (a packet within no_data_ms), starting (none yet, still inside the start-up grace), missing, inactive
// (not on any output), unknown (no_data_ms not configured). last_ms: ms since the newest packet, -1 = never.
std::string Studio::audio_state(const Global &g, uint64_t now, int64_t &last_ms) const
{
	const uint64_t last = g.src->meter ? g.src->meter->last_ns.load() : 0;
	last_ms = last ? ms_since(now, last) : -1;
	if (!obs_source_active(g.src->src))
		return "inactive";
	if (!health_.no_data_ms)
		return "unknown";
	const uint64_t ref = std::max(last, g.src->created_ns);
	if (ms_since(now, ref) < (int64_t)health_.no_data_ms)
		return last ? "ok" : "starting";
	return "missing";
}

void Studio::audio_event(const char *kind, const Global &g, const std::string &text)
{
	json::Value e = json::Value::object();
	e.set("seq", ++audio_seq_);
	e.set("at", hlog::utc_now());
	e.set("kind", kind);
	e.set("id", "audio:" + g.src->audio_id);
	e.set("name", g.src->audio_name);
	e.set("text", text);
	audio_events_.push_back(std::move(e));
	if (audio_events_.size() > kAudioEvents)
		audio_events_.erase(audio_events_.begin());
}

bool Studio::recreate_global(Global &g)
{
	auto old = g.src;
	obs_source_t *o = old->src;
	const std::string type = obs_source_get_id(o), name = obs_source_get_name(o);
	obs_data_t *st = obs_source_get_settings(o);
	obs_source_t *n = obs_source_create(type.c_str(), (name + ":new").c_str(), st, nullptr);
	obs_data_release(st);
	// libobs returns a source even when the plugin's create failed (it keeps the user's data); such a source has no
	// plugin data and never sends anything. win-wasapi's create fails e.g. when CoCreateInstance does.
	if (!n || !obs_obj_get_data(n)) {
		hlog::error("audio watchdog: could not create a new %s for %s (the plugin could not start it); the old source "
			    "stays", type.c_str(), name.c_str());
		if (n)
			obs_source_release(n);
		return false;
	}
	// Source-level settings the project or the user may have set on the old one (they are not in its settings).
	obs_source_set_volume(n, obs_source_get_volume(o));
	obs_source_set_muted(n, obs_source_muted(o));
	obs_source_set_audio_mixers(n, obs_source_get_audio_mixers(o));
	obs_source_set_sync_offset(n, obs_source_get_sync_offset(o));
	obs_source_set_balance_value(n, obs_source_get_balance_value(o));
	obs_source_set_flags(n, obs_source_get_flags(o)); // e.g. OBS_SOURCE_FLAG_FORCE_MONO
	obs_source_copy_filters(n, o);                    // e.g. noise suppression on the mic; same names, enabled state
	const enum obs_monitoring_type mon = obs_source_get_monitoring_type(o);
	// Park the old source: off its channel, out of every track, monitoring off, renamed. It is not released here:
	// destroying a WASAPI source whose work queue died never returns and would block libobs's destruction thread.
	obs_set_output_source(g.channel, nullptr);
	obs_source_set_monitoring_type(o, OBS_MONITORING_TYPE_NONE);
	obs_source_set_audio_mixers(o, 0);
	obs_source_set_muted(o, true);
	obs_source_set_name(o, (name + ":stale-" + std::to_string(parked_.size() + 1)).c_str());
	old->meter.reset();
	parked_.push_back(old);
	obs_source_set_name(n, name.c_str());
	auto w = wrap(n, "");
	w->audio_id = old->audio_id;
	w->audio_name = old->audio_name;
	obs_source_set_monitoring_type(n, mon);
	obs_set_output_source(g.channel, n);
	g.src = w;
	return true;
}

void Studio::audio_watch_tick()
{
	std::lock_guard<std::recursive_mutex> lk(m_);
	if (!health_.no_data_ms)
		return;
	const uint64_t now = os_gettime_ns();
	for (auto &g : globals_) {
		int64_t last_ms = 0;
		const std::string state = audio_state(g, now, last_ms);
		if (state == "ok") {
			if (g.missing) {
				hlog::info("audio watchdog: %s audio is back (source %s)", g.src->audio_name.c_str(),
					   obs_source_get_name(g.src->src));
				audio_event("recovered", g, g.src->audio_name + " audio is back");
			}
			g.missing = g.gave_up = false;
			continue;
		}
		// "starting" after a restart: the new source has not sent a packet yet. It stays missing (audio_health) and
		// is not restarted again inside its start-up grace.
		if (state != "missing")
			continue;
		const std::string what = g.src->audio_name + " audio missing";
		if (!g.missing) {
			g.missing = true;
			hlog::warn("audio watchdog: %s: no audio data for %lld ms (source %s, last packet %s)", what.c_str(),
				   (long long)ms_since(now, std::max(g.src->meter ? g.src->meter->last_ns.load() : 0, g.src->created_ns)),
				   obs_source_get_name(g.src->src), last_ms < 0 ? "never" : (std::to_string(last_ms) + " ms ago").c_str());
			audio_event("missing", g, what);
		}
		if (!health_.recreate || g.gave_up)
			continue;
		if (g.attempt_ns && ms_since(now, g.attempt_ns) < (int64_t)health_.no_data_ms)
			continue; // one attempt per no_data_ms (a failed create leaves the old source, still missing)
		if (parked_full()) {
			g.gave_up = true;
			hlog::error("audio watchdog: %s; %zu replaced sources are parked (limit %u for this run): not restarting "
				    "any more; restart Ujwalam after the stream", what.c_str(), parked_.size(), health_.max_parked);
			audio_event("gave-up", g, what + ": too many restarts in this run; restart Ujwalam after the stream");
			continue;
		}
		if (g.recreates < health_.max_recreates) {
			const std::string old_name = obs_source_get_name(g.src->src);
			g.attempt_ns = now;
			g.recreates++;
			const std::string attempt = std::to_string(g.recreates) + " of " + std::to_string(health_.max_recreates);
			if (recreate_global(g)) {
				hlog::warn("audio watchdog: recreated %s (%s, attempt %s; the old source is parked)", old_name.c_str(),
					   obs_source_get_id(g.src->src), attempt.c_str());
				audio_event("recreated", g, what + ": restarted the source (attempt " + attempt + ")");
			} else {
				audio_event("recreate-failed", g, what + ": the restart failed (attempt " + attempt + ")");
			}
		} else {
			g.gave_up = true;
			hlog::error("audio watchdog: %s after %u restarts; not trying again until the project is loaded again",
				    what.c_str(), g.recreates);
			audio_event("gave-up", g, what + ": restarts did not help; check the device");
		}
	}
}

json::Value Studio::audio_health() const
{
	std::lock_guard<std::recursive_mutex> lk(m_);
	const uint64_t now = os_gettime_ns();
	json::Value srcs = json::Value::array(), warns = json::Value::array();
	bool ok = true;
	for (auto &g : globals_) {
		int64_t last_ms = 0;
		std::string state = audio_state(g, now, last_ms);
		if (state == "starting" && g.missing)
			state = "missing"; // restarted, but the new source has delivered nothing yet: not recovered
		json::Value o = json::Value::object();
		o.set("id", "audio:" + g.src->audio_id);
		o.set("audioSource", g.src->audio_id);
		o.set("name", g.src->audio_name);
		o.set("type", obs_source_get_id(g.src->src));
		o.set("state", state);
		o.set("receiving", state == "unknown" || state == "inactive" ? json::Value() : json::Value(state == "ok"));
		o.set("lastDataMs", last_ms < 0 ? json::Value() : json::Value(last_ms));
		o.set("recreates", (uint64_t)g.recreates);
		if (state == "missing") {
			ok = false;
			warns.push(g.src->audio_name + " audio missing");
		}
		srcs.push(std::move(o));
	}
	json::Value r = json::Value::object();
	r.set("ok", ok);
	r.set("sources", std::move(srcs));
	r.set("warnings", std::move(warns));
	json::Value w = json::Value::object();
	w.set("noDataMs", health_.no_data_ms ? json::Value((uint64_t)health_.no_data_ms) : json::Value());
	w.set("recreate", health_.recreate);
	w.set("maxRecreates", (uint64_t)health_.max_recreates);
	w.set("parked", (uint64_t)parked_.size());
	w.set("maxParked", (uint64_t)health_.max_parked);
	w.set("parkedFull", parked_full());
	r.set("watchdog", std::move(w));
	r.set("seq", audio_seq_);
	json::Value ev = json::Value::array();
	for (auto &e : audio_events_)
		ev.push(e);
	r.set("events", std::move(ev));
	return r;
}

json::Value Studio::test_audio_add(const std::string &id, const std::string &name)
{
	std::lock_guard<std::recursive_mutex> lk(m_);
	for (auto &g : globals_)
		if (g.src->audio_id == id)
			throw Error(rpc::CONFLICT, "audio source exists");
	uint32_t channel = 1;
	for (auto &g : globals_)
		channel = std::max(channel, g.channel + 1);
	if (channel >= MAX_CHANNELS)
		throw Error(rpc::CONFLICT, "no free output channel");
	obs_source_t *src = obs_source_create("ujw_test_audio", ("ujw:audio:" + id).c_str(), nullptr, nullptr);
	if (!src)
		throw Error(rpc::INTERNAL, "ujw_test_audio is not registered (--test-hooks)");
	auto w = wrap(src, "");
	w->audio_id = id;
	w->audio_name = name;
	obs_set_output_source(channel, src);
	globals_.push_back({w, channel});
	return audio_health();
}

json::Value Studio::test_audio_stall(const std::string &id, bool stall)
{
	std::lock_guard<std::recursive_mutex> lk(m_);
	for (auto &g : globals_)
		if (g.src->audio_id == id) {
			obs_data_t *d = obs_data_create();
			obs_data_set_bool(d, "stall", stall);
			obs_source_update(g.src->src, d);
			obs_data_release(d);
			json::Value r = json::Value::object();
			r.set("id", "audio:" + id);
			r.set("stall", stall);
			r.set("source", obs_source_get_name(g.src->src));
			return r;
		}
	throw Error(rpc::INVALID_PARAMS, "no such audio source");
}

json::Value Studio::test_audio_hang_destroy(const std::string &id)
{
	std::lock_guard<std::recursive_mutex> lk(m_);
	for (auto &g : globals_)
		if (g.src->audio_id == id) {
			if (strcmp(obs_source_get_id(g.src->src), "ujw_test_audio") != 0)
				throw Error(rpc::CONFLICT, "not a test audio source");
			obs_data_t *d = obs_data_create();
			obs_data_set_bool(d, "hangDestroy", true);
			obs_source_update(g.src->src, d);
			obs_data_release(d);
			json::Value r = json::Value::object();
			r.set("id", "audio:" + id);
			r.set("hangDestroy", true);
			r.set("source", obs_source_get_name(g.src->src));
			return r;
		}
	throw Error(rpc::INVALID_PARAMS, "no such audio source");
}

json::Value Studio::test_audio_config(const std::string &id, const json::Value &set)
{
	std::lock_guard<std::recursive_mutex> lk(m_);
	for (auto &g : globals_) {
		if (g.src->audio_id != id)
			continue;
		obs_source_t *s = g.src->src;
		if (const json::Value *v = set.find("syncOffsetMs"))
			obs_source_set_sync_offset(s, v->as_int() * 1000000);
		if (const json::Value *v = set.find("balance"))
			obs_source_set_balance_value(s, (float)v->as_double());
		if (const json::Value *v = set.find("forceMono")) {
			const uint32_t f = obs_source_get_flags(s);
			obs_source_set_flags(s, v->as_bool() ? (f | OBS_SOURCE_FLAG_FORCE_MONO) : (f & ~OBS_SOURCE_FLAG_FORCE_MONO));
		}
		if (const json::Value *v = set.find("gainFilterDb")) { // obs-filters "gain_filter", named "Gain"
			obs_data_t *d = obs_data_create();
			obs_data_set_double(d, "db", v->as_double());
			obs_source_t *f = obs_source_create_private("gain_filter", "Gain", d);
			obs_data_release(d);
			if (!f)
				throw Error(rpc::INTERNAL, "gain_filter is not available");
			obs_source_filter_add(s, f);
			obs_source_release(f);
		}
		json::Value r = json::Value::object();
		r.set("source", obs_source_get_name(s));
		r.set("syncOffsetMs", (int64_t)(obs_source_get_sync_offset(s) / 1000000));
		r.set("balance", (double)obs_source_get_balance_value(s));
		r.set("forceMono", (obs_source_get_flags(s) & OBS_SOURCE_FLAG_FORCE_MONO) != 0);
		json::Value fl = json::Value::array();
		obs_source_enum_filters(
			s,
			[](obs_source_t *, obs_source_t *f, void *p) {
				json::Value e = json::Value::object();
				e.set("name", obs_source_get_name(f));
				e.set("type", obs_source_get_id(f));
				obs_data_t *d = obs_source_get_settings(f);
				e.set("db", obs_data_get_double(d, "db"));
				obs_data_release(d);
				static_cast<json::Value *>(p)->push(std::move(e));
			},
			&fl);
		r.set("filters", std::move(fl));
		return r;
	}
	throw Error(rpc::INVALID_PARAMS, "no such audio source");
}

json::Value Studio::mixer_list() const
{
	std::lock_guard<std::recursive_mutex> lk(m_);
	const uint64_t now_ns = os_gettime_ns();
	json::Value a = json::Value::array();
	std::set<const Src *> seen;
	const auto tracks = project_tracks(model_doc_);
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
		const uint32_t mix = obs_source_get_audio_mixers(src.src);
		o.set("mixers", mix);
		json::Value ts = json::Value::array(); // the mixers as project track ids
		for (size_t n = 0; n < tracks.size(); n++)
			if (mix & (1u << n))
				ts.push(tracks[n].first);
		o.set("tracks", std::move(ts));
		o.set("cue", obs_source_get_monitoring_type(src.src) != OBS_MONITORING_TYPE_NONE);
		// libobs holds back monitoring of a source with video until its frame is shown: CUE on such a source is late.
		o.set("cueDelayed", (obs_source_get_output_flags(src.src) & OBS_SOURCE_VIDEO) != 0);
		o.set("active", obs_source_active(src.src));
		float pk = src.meter->peak, mg = src.meter->magnitude;
		o.set("peakDb", std::isfinite(pk) ? json::Value((double)pk) : json::Value());
		o.set("magnitudeDb", std::isfinite(mg) ? json::Value((double)mg) : json::Value());
		// Readiness (D297 proposed): is the source delivering audio packets at all (silence counts; a dead device
		// sends none). null when no audioHealth.noDataMs is configured.
		const uint64_t last = src.meter->last_ns.load();
		o.set("lastDataMs", last ? json::Value(ms_since(now_ns, last)) : json::Value());
		o.set("receiving", health_.no_data_ms
					   ? json::Value(last != 0 && ms_since(now_ns, last) < (int64_t)health_.no_data_ms)
					   : json::Value());
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
	json::Value tl = json::Value::array();
	for (auto &t : tracks) {
		json::Value o = json::Value::object();
		o.set("id", t.first);
		o.set("name", t.second);
		tl.push(std::move(o));
	}
	r.set("tracks", std::move(tl));
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

// CUE (Meld's per-channel headphone button): monitoring on or off, applied at once. A source in the stream mix is
// monitored and still output (monitor-and-output); a source on no track is monitor-only. The monitoring output is
// the host config's monitoringDevice (headphones). Opens an audio output, so it needs --allow-devices.
json::Value Studio::mixer_set_cue(const std::string &id, bool cue)
{
	std::lock_guard<std::recursive_mutex> lk(m_);
	if (cue && !flags_.allow_devices)
		throw Error(rpc::CONFLICT, "CUE opens the headphone output: start the host with --allow-devices");
	auto s = find_audio(id);
	enum obs_monitoring_type t = OBS_MONITORING_TYPE_NONE;
	if (cue)
		t = obs_source_get_audio_mixers(s->src) ? OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT
							  : OBS_MONITORING_TYPE_MONITOR_ONLY;
	obs_source_set_monitoring_type(s->src, t);
	dirty_ = true;
	json::Value r = json::Value::object();
	r.set("id", id);
	r.set("cue", obs_source_get_monitoring_type(s->src) != OBS_MONITORING_TYPE_NONE);
	r.set("cueDelayed", cue && (obs_source_get_output_flags(s->src) & OBS_SOURCE_VIDEO) != 0);
	return r;
}

// Track routing (D273). The project file is the record: the UI server saves the change into audio.sources[].tracks
// and .monitoring (keyed by the audioSource returned here). A CUE that is on follows the routing like mixer_set_cue
// sets it: monitor-and-output on a track, monitor-only on none (libobs: monitor-only is never in the output mix).
json::Value Studio::mixer_set_tracks(const std::string &id, const std::vector<std::string> &tracks)
{
	std::lock_guard<std::recursive_mutex> lk(m_);
	if (format_ != "project-v1")
		throw Error(rpc::CONFLICT, "track routing needs a project v1 model");
	auto s = find_audio(id);
	if (s->audio_id.empty())
		throw Error(rpc::INVALID_PARAMS, "this source has no project audio entry (layer sound off)");
	const auto defs = project_tracks(model_doc_);
	uint32_t mask = 0;
	for (auto &t : tracks) {
		size_t n = 0;
		while (n < defs.size() && defs[n].first != t)
			n++;
		if (n == defs.size())
			throw Error(rpc::INVALID_PARAMS, "unknown track " + t);
		mask |= 1u << n;
	}
	obs_source_set_audio_mixers(s->src, mask);
	if (obs_source_get_monitoring_type(s->src) != OBS_MONITORING_TYPE_NONE)
		obs_source_set_monitoring_type(s->src, mask ? OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT
							     : OBS_MONITORING_TYPE_MONITOR_ONLY);
	dirty_ = true;
	const uint32_t now = obs_source_get_audio_mixers(s->src);
	json::Value ts = json::Value::array();
	for (size_t n = 0; n < defs.size(); n++)
		if (now & (1u << n))
			ts.push(defs[n].first);
	json::Value r = json::Value::object();
	r.set("id", id);
	r.set("audioSource", s->audio_id);
	r.set("mixers", now);
	r.set("tracks", std::move(ts));
	const enum obs_monitoring_type mt = obs_source_get_monitoring_type(s->src);
	r.set("monitoring", mt == OBS_MONITORING_TYPE_MONITOR_ONLY		 ? "monitor-only"
			    : mt == OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT ? "monitor-and-output"
									     : "off");
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
