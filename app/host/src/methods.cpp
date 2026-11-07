// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: JSON-RPC method table. The contract (names, params, results) is listed in
// docs/evidence/2026-10-29-v1-host-o1.md, with the day-2 changes (devices.list, project.plan, project v1 load,
// optional canvas) in docs/evidence/2026-10-30-v1-host-devices-project.md. Canvas ids are "H"/"V" and accepted case-insensitively ("h", "v").
//
// stream.* and record.* are the UI's names for outputs.start/stop on network or file sinks. The UI server asks for
// a typed human confirmation before it calls them; the host does not gate them again (one gate, in one place).
// Both roles (api: UI server, system: supervisor) may call every method. The least-privilege roles (rpc_server.h)
// may call only the methods marked for them: markers (event core) and clips (live clipper, D226).
#include "app.h"
#include "devices.h"
#include "log.h"
#include "obs_runtime.h"
#include "stats.h"

#include <obs.h>

#include <windows.h>

#include <filesystem>
#include <regex>

using rpc::Error;
using rpc::Params;

namespace {

std::string canvas_param(const Params &p, const char *k = "canvas")
{
	std::string c = Studio::norm_canvas(p.str(k, 8));
	if (c.empty())
		throw Error(rpc::INVALID_PARAMS, "canvas must be H or V");
	return c;
}

std::vector<std::string> sink_ids(const Params &p)
{
	std::vector<std::string> ids;
	if (const json::Value *a = p.arr_opt("sinks")) {
		if (a->size() > 32)
			throw Error(rpc::INVALID_PARAMS, "too many sinks");
		for (auto &v : a->as_array()) {
			if (!v.is_string() || v.as_string().empty() || v.as_string().size() > 64)
				throw Error(rpc::INVALID_PARAMS, "sinks must be sink ids");
			ids.push_back(v.as_string());
		}
	}
	return ids;
}

std::string canvas_opt(const Params &p)
{
	return p.has("canvas") ? canvas_param(p) : "";
}

// project.load / project.plan options. bases: pathRef base -> absolute directory (checked again by the planner).
// browserUrls: layer id -> overlay page URL (app/host/lib/project.mjs builds them with feedQuery); relayScope:
// effects | display. The overlay ports come from the host's own overlay server, never from the caller.
Studio::LoadOptions load_options(App &a, const Params &q)
{
	Studio::LoadOptions o;
	if (const json::Value *b = q.obj_opt("browserUrls")) {
		if (b->size() > 256)
			throw Error(rpc::INVALID_PARAMS, "browserUrls: too many entries");
		for (auto &m : b->members()) {
			if (m.first.empty() || m.first.size() > 64 || !m.second.is_string() || m.second.as_string().size() > 2048)
				throw Error(rpc::INVALID_PARAMS, "browserUrls: layer id -> URL string (max 2048)");
			o.browser_urls[m.first] = m.second.as_string();
		}
	}
	o.relay_scope = q.str_or("relayScope", "", 16);
	if (!o.relay_scope.empty() && o.relay_scope != "effects" && o.relay_scope != "display")
		throw Error(rpc::INVALID_PARAMS, "relayScope must be effects or display");
	if (!a.overlay || !a.overlay->ports(o.overlay_port, o.overlay_feed_port))
		o.overlay_port = o.overlay_feed_port = 0; // not running: overlay layers are listed as unavailable
	if (const json::Value *b = q.obj_opt("bases")) {
		for (auto &m : b->members()) {
			if (m.first != "data" && m.first != "media" && m.first != "overlays" && m.first != "profile")
				throw Error(rpc::INVALID_PARAMS, "bases: keys are data, media, overlays, profile");
			if (!m.second.is_string() || m.second.as_string().empty() || m.second.as_string().size() > 1024 ||
			    !std::filesystem::u8path(m.second.as_string()).is_absolute())
				throw Error(rpc::INVALID_PARAMS, "bases: values are absolute directory paths");
			o.bases[m.first] = m.second.as_string();
		}
	}
	o.skip_unavailable = q.bool_or("skipUnavailable", false);
	return o;
}

json::Value ready(App &a)
{
	json::Value st = a.outputs->status();
	bool stream = false, record = false;
	if (const json::Value *s = st.find("sinks"))
		for (auto &x : s->as_array()) {
			const json::Value *k = x.find("kind");
			if (k && k->as_string() == "stream")
				stream = true;
			if (k && k->as_string() == "record")
				record = true;
		}
	json::Value r = json::Value::object();
	r.set("stream", stream);
	r.set("record", record);
	return r;
}

} // namespace

json::Value host_status_json(App &a)
{
	uint64_t frames = 0, dropped = 0;
	a.outputs->totals(frames, dropped);
	json::Value render = stats::render();
	json::Value gpu = stats::gpu();
	double cpu = stats::cpu_pct();
	json::Value r = json::Value::object();
	// UI contract fields (Agent B)
	r.set("live", a.outputs->live());
	r.set("recording", a.outputs->recording());
	r.set("droppedFrames", dropped);
	r.set("totalFrames", frames);
	r.set("fps", *render.find("fps"));
	r.set("cpuPct", cpu >= 0 ? json::Value(cpu) : json::Value());
	const json::Value *gp = gpu.find("gpuPct");
	r.set("gpuPct", gp ? *gp : json::Value());
	r.set("outputsReady", ready(a));
	// details
	r.set("render", std::move(render));
	r.set("gpu", std::move(gpu));
	r.set("memory", stats::memory());
	r.set("canvases", a.studio->canvases_json());
	json::Value st = a.outputs->status();
	json::Value sinks = json::Value::array();
	if (const json::Value *s = st.find("sinks"))
		for (auto &x : s->as_array()) {
			json::Value o = json::Value::object();
			for (const char *k : {"id", "kind", "state", "droppedFrames", "totalFrames", "kbps", "retries"})
				if (const json::Value *v = x.find(k))
					o.set(k, *v);
			sinks.push(std::move(o));
		}
	r.set("sinks", std::move(sinks));
	r.set("uptimeMs", (int64_t)(GetTickCount64() - a.start_tick));
	json::Value rp = json::Value::object();
	rp.set("H", a.outputs->replay_running("H"));
	rp.set("V", a.outputs->replay_running("V"));
	r.set("replayRunning", std::move(rp));
	r.set("panic", a.panic ? a.panic->engaged() : false);
	return r;
}

void on_hotkey(App &a, const std::string &name, const char *via)
{
	if (a.shutting_down)
		return;
	if (name == "panic") {
		if (a.panic)
			a.panic->engage("hotkey");
	} else if (name == "marker") {
		if (a.moments)
			a.moments->marker_add("hotkey", "");
	} else if (name == "feedback") {
		if (a.moments)
			a.moments->feedback_capture("hotkey", "");
	} else {
		hlog::warn("hotkey %s (%s): no action", name.c_str(), via);
	}
}

namespace {

json::Value host_info(App &a)
{
	json::Value r = json::Value::object();
	r.set("name", "ujwalam-host");
	r.set("version", a.version);
	r.set("apiVersion", 1);
	r.set("pid", (int64_t)GetCurrentProcessId());
	r.set("startedAt", a.started_at);
	r.set("obsVersion", obs_get_version_string());
	r.set("adapterIndex", a.adapter);
	r.set("adapter", obsrt::adapter_name());
	json::Value flags = json::Value::object();
	flags.set("allowDevices", a.allow_devices);
	flags.set("allowBrowser", a.allow_browser);
	flags.set("allowLive", a.allow_live);
	flags.set("twitchBandwidthTest", a.twitch_bandwidth_test);
	flags.set("testHooks", a.test_hooks);
	r.set("flags", std::move(flags));
	json::Value dis = json::Value::array();
	for (auto &m : obsrt::disabled_modules())
		dis.push(m);
	r.set("disabledModules", std::move(dis));
	json::Value mods = json::Value::array();
	for (auto &m : obsrt::loaded_modules())
		mods.push(m);
	r.set("loadedModules", std::move(mods));
	json::Value enc = json::Value::array();
	for (auto &e : obsrt::encoder_types())
		enc.push(e);
	r.set("encoders", std::move(enc));
	r.set("sampleRate", obsrt::sample_rate());
	r.set("recordingsDir", a.recordings_dir);
	r.set("gpuPreference", stats::gpu_preference(a.exe_path));
	// Device module proof: these DLLs are mapped only with --allow-devices (obs_runtime.cpp disabled_for).
	json::Value dm = json::Value::object();
	dm.set("win-dshow.dll", devices::module_mapped(L"win-dshow.dll"));
	dm.set("win-wasapi.dll", devices::module_mapped(L"win-wasapi.dll"));
	r.set("deviceModules", std::move(dm));
	r.set("overlay", a.overlay ? a.overlay->status() : json::Value());
	r.set("hotkeys", a.hotkeys ? a.hotkeys->status() : json::Value());
	r.set("hostConfig", a.config_path.empty() ? json::Value() : json::Value(a.config_path));
	r.set("session", a.session);
	r.set("moments", a.moments ? a.moments->status() : json::Value());
	json::Value types = json::Value::array();
	const char *t = nullptr;
	for (size_t i = 0; obs_enum_input_types(i, &t); i++)
		types.push(t);
	r.set("sourceTypes", std::move(types));
	return r;
}

} // namespace

std::map<std::string, rpc::Method> make_methods(App &a)
{
	std::map<std::string, rpc::Method> m;
	auto add = [&](const char *name, std::function<json::Value(const json::Value &)> fn) {
		rpc::Method x;
		x.run = [fn](const json::Value &p, rpc::Role) { return fn(p); };
		m[name] = std::move(x);
	};

	// ---- host
	add("host.info", [&a](const json::Value &p) {
		(void)Params(p, {});
		return host_info(a);
	});
	add("host.status", [&a](const json::Value &p) {
		(void)Params(p, {});
		return host_status_json(a);
	});
	m["host.status"].clips = true; // the live clipper's health check
	add("host.shutdown", [&a](const json::Value &p) {
		(void)Params(p, {});
		if (!a.shutting_down.exchange(true)) {
			a.shutdown_reason = "rpc";
			SetEvent((HANDLE)a.shutdown_event);
		}
		json::Value r = json::Value::object();
		r.set("shuttingDown", true);
		return r;
	});
	// log.tail {lines?: 1..1000 (default 200)}: the newest host log lines from the in-memory ring (log.h), oldest
	// first; token-shaped hex runs are already redacted there. For the feedback hotkey (alpha plan Part B).
	add("log.tail", [](const json::Value &p) {
		Params q(p, {"lines"});
		size_t n = (size_t)q.int_or("lines", 200, 1, (int64_t)hlog::kRingLines);
		unsigned long long total = 0;
		std::vector<std::string> lines = hlog::tail(n, &total);
		json::Value a = json::Value::array();
		for (auto &l : lines)
			a.push(l);
		json::Value r = json::Value::object();
		r.set("lines", std::move(a));
		r.set("total", (uint64_t)total);
		r.set("capacity", (uint64_t)hlog::kRingLines);
		return r;
	});

	// ---- project
	add("project.load", [&a](const json::Value &p) {
		Params q(p, {"project", "bases", "skipUnavailable", "browserUrls", "relayScope"});
		const json::Value &proj = q.obj("project");
		Studio::LoadOptions lo = load_options(a, q);
		if (!a.outputs->release_for_reload())
			throw Error(rpc::CONFLICT, "outputs are active: stop them before loading a project");
		json::Value r;
		try {
			r = a.studio->load(proj, false, lo);
		} catch (...) {
			try {
				a.outputs->replay_resume(); // the replay buffers follow whatever canvases are left
			} catch (...) {
			}
			throw;
		}
		json::Value o = json::Value::object();
		try {
			json::Value re = a.outputs->reconfigure();
			o.set("reconfigured", !re.is_null());
		} catch (const Error &e) {
			o.set("reconfigured", false);
			o.set("error", e.what());
		}
		r.set("outputs", std::move(o));
		return r;
	});
	add("project.get", [&a](const json::Value &p) {
		(void)Params(p, {});
		return a.studio->get();
	});
	add("project.plan", [&a](const json::Value &p) {
		Params q(p, {"project", "bases", "skipUnavailable", "browserUrls", "relayScope"});
		return a.studio->plan(q.obj("project"), load_options(a, q));
	});

	// ---- devices (list-only: no device is opened or activated; see devices.h). Gated like every device feature:
	// nothing device-related runs before the user's "devices ready" (D38).
	add("devices.list", [&a](const json::Value &p) {
		(void)Params(p, {});
		if (!a.allow_devices)
			throw Error(rpc::FORBIDDEN, "devices are disabled (start the host with --allow-devices after the user says devices ready)");
		json::Value r = devices::to_json(devices::enumerate());
		r.set("devicesEnabled", a.allow_devices);
		return r;
	});

	// ---- overlays (the overlay server child, overlay.h). Browser layers never see a host or event-core token.
	add("overlay.status", [&a](const json::Value &p) {
		(void)Params(p, {});
		json::Value r = a.overlay ? a.overlay->status() : json::Value::object();
		if (!a.overlay)
			r.set("state", "off");
		r.set("browserAllowed", a.allow_browser);
		return r;
	});
	// overlay.stats: the overlay bridge counters (bridge.stats(): feed clients, chat/bus frames, effects; counts
	// only, no text). -32004 while the overlay server is not running.
	add("overlay.stats", [&a](const json::Value &p) {
		(void)Params(p, {});
		if (!a.overlay)
			throw Error(rpc::UNAVAILABLE, "the overlay server is off (start the host with --overlay-root)");
		return a.overlay->stats();
	});
	// effect.fire {name, meta?}: bridge.publishEffect(name, meta) in the overlay server (its guards decide; the
	// result says {ok:false, reason} when they refuse). One feed serves both canvases, so there is no canvas param.
	add("effect.fire", [&a](const json::Value &p) {
		Params q(p, {"name", "meta"});
		if (!a.allow_browser)
			throw Error(rpc::FORBIDDEN, "browser layers are disabled (start the host with --allow-browser)");
		std::string name = q.str("name", 32);
		static const std::regex name_re("^[a-z0-9][a-z0-9_-]{0,31}$");
		if (!std::regex_match(name, name_re))
			throw Error(rpc::INVALID_PARAMS, "name must match [a-z0-9][a-z0-9_-]{0,31}");
		if (a.panic && a.panic->engaged()) { // panic step 1 holds until panic.clear
			hlog::info("effect.fire %s: refused (panic)", name.c_str());
			json::Value r = json::Value::object();
			r.set("ok", false);
			r.set("reason", "panic");
			return r;
		}
		if (!a.overlay)
			throw Error(rpc::UNAVAILABLE, "the overlay server is off (start the host with --overlay-root)");
		json::Value meta = json::Value::object();
		if (const json::Value *m = q.obj_opt("meta")) {
			if (m->size() > 8)
				throw Error(rpc::INVALID_PARAMS, "meta: at most 8 keys");
			for (auto &kv : m->members()) {
				const json::Value &v = kv.second;
				if (kv.first.empty() || kv.first.size() > 32 || v.is_array() || v.is_object() ||
				    (v.is_string() && v.as_string().size() > 200))
					throw Error(rpc::INVALID_PARAMS, "meta: short keys with string (max 200), number, bool or null values");
				meta.set(kv.first, v);
			}
		}
		json::Value r = a.overlay->effect(name, meta);
		hlog::info("effect.fire %s: %s", name.c_str(), r.find("ok") && r.find("ok")->is_bool() && r.find("ok")->as_bool() ? "delivered" : "refused");
		return r;
	});

	// ---- scenes
	add("scenes.list", [&a](const json::Value &p) {
		Params q(p, {"canvas"});
		return a.studio->scenes_list(q.has("canvas") ? canvas_param(q) : "");
	});
	add("scenes.create", [&a](const json::Value &p) {
		Params q(p, {"scene"});
		return a.studio->scene_create(q.obj("scene"));
	});
	add("scenes.remove", [&a](const json::Value &p) {
		Params q(p, {"scene", "canvas"});
		return a.studio->scene_remove(q.str("scene", 64), canvas_opt(q));
	});
	add("scenes.activate", [&a](const json::Value &p) {
		Params q(p, {"scene", "canvas"});
		return a.studio->scene_activate(q.str("scene", 64), canvas_opt(q));
	});

	// ---- layers
	add("layers.list", [&a](const json::Value &p) {
		Params q(p, {"scene", "canvas"});
		return a.studio->layers_list(q.str("scene", 64), canvas_opt(q));
	});
	add("layers.add", [&a](const json::Value &p) {
		Params q(p, {"scene", "canvas", "layer", "index"});
		return a.studio->layer_add(q.str("scene", 64), canvas_opt(q), q.obj("layer"), q.int_or("index", -1, -1, 1000));
	});
	add("layers.remove", [&a](const json::Value &p) {
		Params q(p, {"scene", "canvas", "layer"});
		return a.studio->layer_remove(q.str("scene", 64), canvas_opt(q), q.str("layer", 64));
	});
	add("layers.setVisible", [&a](const json::Value &p) {
		Params q(p, {"scene", "canvas", "layer", "visible"});
		return a.studio->layer_set_visible(q.str("scene", 64), canvas_opt(q), q.str("layer", 64), q.boolean("visible"));
	});
	add("layers.setPlacement", [&a](const json::Value &p) {
		Params q(p, {"scene", "canvas", "layer", "placement"});
		return a.studio->layer_set_placement(q.str("scene", 64), canvas_opt(q), q.str("layer", 64), q.obj("placement"));
	});
	add("layers.move", [&a](const json::Value &p) {
		Params q(p, {"scene", "canvas", "layer", "index", "direction"});
		bool hi = q.has("index"), hd = q.has("direction");
		if (hi == hd)
			throw Error(rpc::INVALID_PARAMS, "give exactly one of index or direction");
		return a.studio->layer_move(q.str("scene", 64), canvas_opt(q), q.str("layer", 64), hi ? q.integer("index", 0, 1000) : 0,
					    hd ? q.str("direction", 8) : "");
	});

	// ---- previews
	add("preview.open", [&a](const json::Value &p) {
		Params q(p, {"canvas", "x", "y", "width", "height", "topmost", "parent"});
		Previews::OpenArgs o;
		if (q.has("parent")) { // decimal window handle of the studio shell's preview slot (P5a)
			const std::string ps = q.str("parent", 20);
			if (ps.empty() || ps.find_first_not_of("0123456789") != std::string::npos)
				throw Error(rpc::INVALID_PARAMS, "parent must be a decimal window handle");
			o.parent = std::stoull(ps);
			if (!o.parent)
				throw Error(rpc::INVALID_PARAMS, "parent must be a decimal window handle");
		}
		o.canvas = canvas_param(q);
		o.x = (int)q.int_or("x", -1, -1, 16384);
		o.y = (int)q.int_or("y", -1, -1, 16384);
		o.width = (int)q.int_or("width", 0, 0, 8192);
		o.height = (int)q.int_or("height", 0, 0, 8192);
		if ((o.width == 0) != (o.height == 0))
			throw Error(rpc::INVALID_PARAMS, "give both width and height, or neither");
		if (o.width && (o.width < 160 || o.height < 90))
			throw Error(rpc::INVALID_PARAMS, "preview must be at least 160x90");
		o.topmost = q.bool_or("topmost", false);
		return a.previews->open(o);
	});
	add("preview.focus", [&a](const json::Value &p) {
		Params q(p, {"canvas"});
		return a.previews->focus(canvas_param(q));
	});
	add("preview.close", [&a](const json::Value &p) {
		Params q(p, {"canvas"});
		return a.previews->close(canvas_param(q));
	});
	add("preview.list", [&a](const json::Value &p) {
		(void)Params(p, {});
		return a.previews->list();
	});

	// ---- mixer
	add("mixer.list", [&a](const json::Value &p) {
		(void)Params(p, {});
		return a.studio->mixer_list();
	});
	m["mixer.list"].markers = true; // read-only meter for the F6 audio-peak producer (markers role)
	add("mixer.setVolume", [&a](const json::Value &p) {
		Params q(p, {"id", "volume", "db"});
		bool hv = q.has("volume"), hd = q.has("db");
		if (hv == hd)
			throw Error(rpc::INVALID_PARAMS, "give exactly one of volume (0..1) or db (-100..0)");
		double v = hv ? q.num("volume", 0.0, 1.0) : q.num("db", -100.0, 0.0);
		return a.studio->mixer_set_volume(q.str("id", 130), hv ? &v : nullptr, hd ? &v : nullptr);
	});
	add("mixer.setMute", [&a](const json::Value &p) {
		Params q(p, {"id", "muted"});
		return a.studio->mixer_set_mute(q.str("id", 130), q.boolean("muted"));
	});
	add("mixer.setCue", [&a](const json::Value &p) {
		Params q(p, {"id", "cue"});
		return a.studio->mixer_set_cue(q.str("id", 130), q.boolean("cue"));
	});

	// ---- outputs (O1: loopback targets only)
	add("outputs.configure", [&a](const json::Value &p) { return a.outputs->configure(p); });
	add("outputs.clear", [&a](const json::Value &p) {
		(void)Params(p, {});
		return a.outputs->clear();
	});
	add("outputs.status", [&a](const json::Value &p) {
		(void)Params(p, {});
		return a.outputs->status();
	});
	add("outputs.start", [&a](const json::Value &p) {
		Params q(p, {"sinks"});
		return a.outputs->start(sink_ids(q), "");
	});
	add("outputs.stop", [&a](const json::Value &p) {
		Params q(p, {"sinks"});
		return a.outputs->stop(sink_ids(q), "");
	});
	add("stream.start", [&a](const json::Value &p) {
		Params q(p, {"sinks"});
		return a.outputs->start(sink_ids(q), "stream");
	});
	add("stream.stop", [&a](const json::Value &p) {
		Params q(p, {"sinks"});
		return a.outputs->stop(sink_ids(q), "stream");
	});
	add("record.start", [&a](const json::Value &p) {
		Params q(p, {"sinks"});
		return a.outputs->start(sink_ids(q), "record");
	});
	add("record.stop", [&a](const json::Value &p) {
		Params q(p, {"sinks"});
		return a.outputs->stop(sink_ids(q), "record");
	});
	// ---- replay buffer (outputs.h replay section; replay.cpp)
	add("replay.start", [&a](const json::Value &p) {
		Params q(p, {"seconds"});
		return a.outputs->replay_start((int)q.int_or("seconds", 0, 5, 600));
	});
	add("replay.stop", [&a](const json::Value &p) {
		(void)Params(p, {});
		return a.outputs->replay_stop();
	});
	add("replay.status", [&a](const json::Value &p) {
		(void)Params(p, {});
		return a.outputs->replay_status();
	});
	m["replay.status"].clips = true;
	// replay.save {canvas?}: <recordings>/replay/replay-<canvas>-<stamp>[-<n>].mkv for each running replay (or the one
	// canvas); -2, -3 ... only when a save in the same second already wrote that name. Returns after libobs's "saved"
	// signal, so each saved[].path exists when the call returns. The folder is fixed; feedback captures save into
	// their own folder in-process.
	add("replay.save", [&a](const json::Value &p) {
		Params q(p, {"canvas"});
		return a.outputs->replay_save(canvas_opt(q), a.outputs->replay_dir(), "replay-{canvas}-%CCYY%MM%DD-%hh%mm%ss",
					      10000);
	});
	m["replay.save"].clips = true; // the live clipper saves on a kill chain (D226)

	// ---- frames (frames.h): frames.grab {layer, maxWidth?} -> one still of the layer's shared source (never the
	// composed canvas) as <dataDir>/live/frame-<layer>.bmp. For the live clipper's OCR (clips role).
	add("frames.grab", [&a](const json::Value &p) {
		Params q(p, {"layer", "maxWidth"});
		std::string layer = q.str("layer", 64);
		if (layer.empty())
			throw Error(rpc::INVALID_PARAMS, "layer must be a layer id");
		uint32_t max_width = (uint32_t)q.int_or("maxWidth", 0, 16, (int64_t)Frames::kMaxSide);
		std::string type;
		obs_source_t *src = a.studio->layer_source_ref(layer, type);
		try {
			json::Value r = a.frames->grab(src, layer, type, max_width);
			obs_source_release(src);
			return r;
		} catch (...) {
			obs_source_release(src);
			throw;
		}
	});
	m["frames.grab"].clips = true;

	// ---- panic (panic.h). panic.now acts in-process at once and queues the event-core notification; the result is in
	// panic.status (core). panic.clear restores the hidden layers (the UI gates it); event-core's panic is cleared there.
	add("panic.now", [&a](const json::Value &p) {
		(void)Params(p, {});
		return a.panic->engage("rpc");
	});
	add("panic.status", [&a](const json::Value &p) {
		(void)Params(p, {});
		return a.panic->status();
	});
	add("panic.clear", [&a](const json::Value &p) {
		(void)Params(p, {});
		return a.panic->clear();
	});

	// ---- markers and feedback (moments.h)
	// marker.add is one of the two methods the markers role may call (the event core's F6 live markers); that role
	// writes chat and audio markers only. The clips role (live clipper) writes clip markers only.
	{
		rpc::Method x;
		x.markers = true;
		x.clips = true;
		x.run = [&a](const json::Value &p, rpc::Role role) {
			Params q(p, {"source", "note"});
			std::string source = q.str("source", 16);
			if (role == rpc::Role::Markers && source != "chat" && source != "audio")
				throw Error(rpc::FORBIDDEN, "the markers role writes chat or audio markers only");
			if (role == rpc::Role::Clips && source != "clip")
				throw Error(rpc::FORBIDDEN, "the clips role writes clip markers only");
			return a.moments->marker_add(source, q.str_or("note", "", 500));
		};
		m["marker.add"] = std::move(x);
	}
	add("feedback.capture", [&a](const json::Value &p) {
		Params q(p, {"note"});
		return a.moments->feedback_capture("api", q.str_or("note", "", 2000));
	});
	add("feedback.status", [&a](const json::Value &p) {
		(void)Params(p, {});
		return a.moments->status();
	});

	// ---- hotkeys (hotkeys.h). hotkeys.trigger runs a binding's handler exactly as the key press does; it exists
	// only with --test-hooks (tests), never in a launcher-started host.
	add("hotkeys.status", [&a](const json::Value &p) {
		(void)Params(p, {});
		return a.hotkeys->status();
	});
	add("hotkeys.trigger", [&a](const json::Value &p) {
		Params q(p, {"name"});
		if (!a.test_hooks)
			throw Error(rpc::FORBIDDEN, "hotkeys.trigger needs a host started with --test-hooks");
		std::string name = q.str("name", 32);
		if (!a.hotkeys->trigger(name))
			throw Error(rpc::INVALID_PARAMS, "no hotkey binding with that name");
		json::Value r = json::Value::object();
		r.set("triggered", name);
		return r;
	});

	add("encoders.probe", [&a](const json::Value &p) {
		Params q(p, {"codec", "max"});
		return a.outputs->probe_sessions(q.str_or("codec", "h264", 8), (int)q.int_or("max", 12, 1, 32));
	});
	return m;
}
