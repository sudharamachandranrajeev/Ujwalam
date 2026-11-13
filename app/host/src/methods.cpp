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

#include <chrono>
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
	// D374: last video frame age, stalls and GPU device losses (gfx_watch.h); the launcher's host watchdog reads it.
	r.set("graphics", a.gfx_watch ? a.gfx_watch->status() : json::Value());
	json::Value rp = json::Value::object();
	rp.set("H", a.outputs->replay_running("H"));
	rp.set("V", a.outputs->replay_running("V"));
	r.set("replayRunning", std::move(rp));
	r.set("panic", a.panic ? a.panic->engaged() : false);
	// Preview mouse editing (D230): the UI server compares previewEditing with flag preview-edit and reads
	// preview.edits when previewEditSeq moves (autosave + inspector refresh).
	r.set("previewEditing", a.previews ? a.previews->editor().enabled() : false);
	r.set("previewEditSeq", a.previews ? (int64_t)a.previews->editor().seq() : (int64_t)0);
	// D335: snapping on or off (the UI server keeps it equal to settings.json ui.snap) and the preview selection per
	// canvas; previewSelection.seq moves when a press on the preview picked another layer (the studio's list follows).
	r.set("previewSnap", a.previews ? a.previews->editor().snap() : false);
	if (a.previews)
		r.set("previewSelection", a.previews->editor().selection_status());
	r.set("transitions", a.studio ? a.studio->transitions() : json::Value::object());
	// Audio readiness (D297 proposed): each project device audio source receiving or not, the "<Name> audio missing"
	// warnings and the watchdog's events. rtwqHeld: the host holds the RTWQ platform (obs_runtime.h).
	json::Value ah = a.studio ? a.studio->audio_health() : json::Value::object();
	ah.set("rtwqHeld", obsrt::rtwq_held());
	r.set("audioHealth", std::move(ah));
	// Device hot-plug (D329): the UI server and the studio refresh device pickers and layer lists when seq moves.
	// Never lists devices here (the newest list of a build or watcher pass is used).
	json::Value dv = a.studio ? a.studio->devices_status() : json::Value::object();
	dv.set("watcher", a.device_watch ? a.device_watch->status() : json::Value());
	r.set("devices", std::move(dv));
	return r;
}

json::Value devices_pass(App &a, const char *why, const std::vector<std::string> &removed, bool event)
{
	if (!a.studio || a.shutting_down)
		return json::Value();
	bool has = false;
	devices::List l = a.studio->list_devices(has);
	if (!has)
		return json::Value();
	if (a.studio->device_loss_pending(l)) {
		// A bound capture device looks gone: list again after a pause, so one odd listing never unbinds a working
		// source. Ends early on shutdown.
		if (WaitForSingleObject((HANDLE)a.shutdown_event, 1000) == WAIT_OBJECT_0)
			return json::Value();
		l = a.studio->list_devices(has);
		if (!has)
			return json::Value();
	}
	return a.studio->devices_changed(l, why, removed, event);
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
	// host.alive {}: the launcher's liveness probe (D374, services/studio-ui/host-watch.mjs). Takes no studio or output
	// lock (a long project load never makes it wait), so "no answer" means the host itself is stuck.
	add("host.alive", [&a](const json::Value &p) {
		(void)Params(p, {});
		json::Value r = json::Value::object();
		r.set("pid", (int64_t)GetCurrentProcessId());
		r.set("uptimeMs", (int64_t)(GetTickCount64() - a.start_tick));
		r.set("graphics", a.gfx_watch ? a.gfx_watch->status() : json::Value());
		return r;
	});
	add("face.status", [&a](const json::Value &p) { // face AI link (face.h, D295 proposed); read-only
		(void)Params(p, {});
		if (!a.face) {
			json::Value r = json::Value::object();
			r.set("on", false);
			return r;
		}
		return a.face->stats();
	});
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
	// devices.testSet {devices: [{kind, name, path, fail?}] | null, removed?: [{kind?, name, path}], viaWatcher?, peek?}
	// (--test-hooks only, D329): replaces the device list the host sees with a fake one (null: back to the real list)
	// and runs one hot-plug pass at once, as a plug-in or unplug would. Capture layers then build on ujw_test_capture
	// (opens nothing). Returns the pass result plus `frames` (frames each fake device id sent).
	//   fail: n      the next n activations of that video device deliver no frames (busy driver, held by another app)
	//   removed      these video devices left (their fake sources die until reactivated) and are reported to the pass
	//                as removed interface paths, even when they are listed again (a quick unplug and re-plug)
	//   viaWatcher   the removals and one arrival go to the device watcher (debounce) instead of a pass at once;
	//                returns {queued: true}
	//   peek         changes nothing; returns {frames}
	add("devices.testSet", [&a](const json::Value &p) {
		Params q(p, {"devices", "removed", "viaWatcher", "peek"});
		if (!a.test_hooks)
			throw Error(rpc::FORBIDDEN, "devices.testSet needs a host started with --test-hooks");
		if (q.has("peek") && q.boolean("peek")) {
			json::Value r = json::Value::object();
			r.set("frames", devwatch::test_frames());
			return r;
		}
		std::vector<std::string> removed_paths, removed_ids;
		if (const json::Value *rm = q.raw().find("removed"); rm && !rm->is_null()) {
			if (!rm->is_array() || rm->size() > 64)
				throw Error(rpc::INVALID_PARAMS, "removed must be an array (at most 64)");
			for (auto &x : rm->as_array()) {
				Params e(x, {"kind", "name", "path"}); // kind: video only (as a devices[] entry)
				devices::Entry en = devices::make_entry("video", e.str("name", 256), e.str("path", 512));
				removed_paths.push_back(en.path);
				removed_ids.push_back(en.obs_id);
			}
		}
		const json::Value &dv = q.raw().find("devices") ? *q.raw().find("devices") : json::Value();
		std::vector<std::string> present;
		if (dv.is_null()) {
			a.studio->set_test_devices(nullptr);
		} else {
			if (!dv.is_array() || dv.size() > 64)
				throw Error(rpc::INVALID_PARAMS, "devices must be an array (at most 64) or null");
			devices::List l;
			for (auto &d : dv.as_array()) {
				Params e(d, {"kind", "name", "path", "error", "fail"});
				std::string kind = e.str("kind", 24);
				if (kind != "video" && kind != "dshow-audio" && kind != "audio-input" && kind != "audio-output")
					throw Error(rpc::INVALID_PARAMS, "devices[].kind: video | dshow-audio | audio-input | audio-output");
				if (e.has("error")) { // a category that failed to list: {"kind": "video", "error": true}
					if (e.boolean("error"))
						l.errors.push_back(kind + ": 0x80004005");
					continue;
				}
				l.entries.push_back(devices::make_entry(kind, e.str("name", 256), e.str_or("path", "", 512)));
				if (kind == "video")
					present.push_back(l.entries.back().obs_id);
				if (e.has("fail"))
					devwatch::test_fail_activations(l.entries.back().obs_id, (int)e.integer("fail", 0, 100));
			}
			a.studio->set_test_devices(&l);
		}
		devwatch::test_remove(removed_ids);
		devwatch::set_test_present(present);
		if (q.has("viaWatcher") && q.boolean("viaWatcher")) {
			if (!a.device_watch)
				throw Error(rpc::UNAVAILABLE, "no device watcher");
			for (auto &r : removed_paths)
				a.device_watch->poke(r);
			a.device_watch->poke();
			json::Value r = json::Value::object();
			r.set("queued", true);
			return r;
		}
		json::Value r = devices_pass(a, "devices.testSet", removed_paths);
		if (r.is_null())
			r = json::Value::object();
		r.set("frames", devwatch::test_frames());
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
	// Scene transitions (D239): per canvas, cut or fade (0-10000 ms). The UI server keeps them equal to flag
	// `transitions` and the project's canvases[].transition; host.status reports them.
	add("transitions.set", [&a](const json::Value &p) {
		// easing (D327 TR1): a fade's curve id (transition_ease.h); absent = linear.
		Params q(p, {"canvas", "type", "durationMs", "file", "pointMs", "audio", "easing"});
		const json::Value *file = q.has("file") ? &q.obj("file") : nullptr;
		return a.studio->transition_set(q.str("canvas", 8), q.str("type", 8), q.int_or("durationMs", 0, 0, 10000), file,
						q.int_or("pointMs", 0, 0, 10000), q.bool_or("audio", true), q.str_or("easing", "linear", 32));
	});
	add("transitions.get", [&a](const json::Value &) { return a.studio->transitions(); });
	// D327 TR1 "Force complete transition": a running transition on that canvas ends on its target scene now.
	add("transitions.forceComplete", [&a](const json::Value &p) {
		Params q(p, {"canvas"});
		return a.studio->transition_force_complete(q.str("canvas", 8));
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
	// D240: add a layer the UI server has put into the project document (project v1 only).
	add("layers.addFromProject", [&a](const json::Value &p) {
		Params q(p, {"project", "scene", "layer"});
		return a.studio->layer_add_model(q.obj("project"), q.str("scene", 64), q.str("layer", 64));
	});
	add("layers.orderFromProject", [&a](const json::Value &p) {
		Params q(p, {"project", "scene"});
		return a.studio->layer_order_model(q.obj("project"), q.str("scene", 64));
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
	// Effect editor (D260): every canvas of the scene; an empty list removes the effects. No live gate here: the
	// studio UI server applies it on the user's click while live (D332), as for layers.setPlacement.
	add("layers.setEffects", [&a](const json::Value &p) {
		Params q(p, {"scene", "layer", "effects"});
		return a.studio->layer_set_effects(q.str("scene", 64), q.str("layer", 64), q.arr("effects"));
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
	// preview.testParent {action, canvas?}: a hidden window to embed into, and attempts to show the embedded preview
	// (Previews::test_parent; headless guard, Codex review of D346). --test-hooks only.
	add("preview.testParent", [&a](const json::Value &p) {
		Params q(p, {"action", "canvas"});
		if (!a.test_hooks)
			throw Error(rpc::FORBIDDEN, "preview.testParent needs a host started with --test-hooks");
		const std::string action = q.str("action", 16);
		return a.previews->test_parent(action, q.has("canvas") ? canvas_param(q) : std::string());
	});
	// Mouse editing on the preview (P5, D230; preview_edit.h). preview.setEditing follows flag preview-edit (the UI
	// server calls it when the flag and host.status previewEditing differ; off is instant). preview.edits lists the
	// placements committed by mouse releases after `since` (they went through layer_set_placement already; the UI
	// server autosaves them like inspector edits). Live: no extra gate here, as for layers.setPlacement (D230).
	add("preview.setEditing", [&a](const json::Value &p) {
		Params q(p, {"enabled"});
		bool on = q.boolean("enabled");
		if (on != a.previews->editor().enabled())
			hlog::info("preview mouse editing %s", on ? "ON" : "off");
		a.previews->editor().set_enabled(on);
		json::Value r = json::Value::object();
		r.set("enabled", on);
		return r;
	});
	add("preview.edits", [&a](const json::Value &p) {
		Params q(p, {"since"});
		return a.previews->editor().edits((uint64_t)q.int_or("since", 0, 0, INT64_MAX));
	});
	// preview.setSnap {enabled} (D335 F10): snapping to the canvas edges and centre and the other layers (D272) while
	// dragging on the preview. Off by default; the UI server keeps it equal to settings.json ui.snap.
	add("preview.setSnap", [&a](const json::Value &p) {
		Params q(p, {"enabled"});
		bool on = q.boolean("enabled");
		if (on != a.previews->editor().snap())
			hlog::info("preview snapping %s", on ? "ON" : "off");
		a.previews->editor().set_snap(on);
		json::Value r = json::Value::object();
		r.set("enabled", on);
		return r;
	});
	// preview.select {canvas, layer | null} (D335 F8): the layer selected in the studio's layer list becomes the one the
	// mouse moves, resizes, turns and crops on that canvas's preview. layer null (or absent) clears it. Refused when
	// mouse editing is off, while live (live-lock, D233), during a drag, or when the layer is not a visible layer with a
	// placement in the canvas's active scene.
	add("preview.select", [&a](const json::Value &p) {
		Params q(p, {"canvas", "layer"});
		std::string canvas = canvas_param(q);
		std::string layer;
		if (const json::Value *l = p.find("layer"); l && !l->is_null())
			layer = q.str("layer", 64);
		const std::string err = a.previews->editor().select(canvas, layer);
		if (err == "missing")
			throw Error(rpc::INVALID_PARAMS, "layer " + layer + " is not a visible layer with a placement in the active scene of " + canvas);
		if (!err.empty())
			throw Error(rpc::CONFLICT, err == "off"	       ? std::string("preview mouse editing is off")
						   : err == "live"     ? std::string("live: the preview selects nothing while a stream runs")
						   : err == "dragging" ? std::string("a drag is running on that preview")
								       : std::string("busy: try again"));
		json::Value r = a.previews->editor().selection_json(canvas);
		return r;
	});
	// audio.status {}: the audio readiness view alone (same object as host.status.audioHealth): {ok, warnings,
	// sources: [{id, audioSource, name, type, state: ok|starting|missing|inactive|unknown, receiving, lastDataMs,
	// recreates}], watchdog, seq, events, rtwqHeld}. Read-only; consumed by services/studio-ui/readiness.mjs.
	add("audio.status", [&a](const json::Value &p) {
		(void)Params(p, {});
		json::Value ah = a.studio->audio_health();
		ah.set("rtwqHeld", obsrt::rtwq_held());
		return ah;
	});
	// audio.testAdd {id, name} / audio.testStall {id, stall}: a fake device audio source (audio_health.h
	// ujw_test_audio, opens no device) and a simulated dead device, for the audio watchdog tests. --test-hooks only.
	add("audio.testAdd", [&a](const json::Value &p) {
		Params q(p, {"id", "name"});
		if (!a.test_hooks)
			throw Error(rpc::FORBIDDEN, "audio.testAdd needs a host started with --test-hooks");
		return a.studio->test_audio_add(q.str("id", 64), q.str("name", 64));
	});
	add("audio.testStall", [&a](const json::Value &p) {
		Params q(p, {"id", "stall"});
		if (!a.test_hooks)
			throw Error(rpc::FORBIDDEN, "audio.testStall needs a host started with --test-hooks");
		return a.studio->test_audio_stall(q.str("id", 64), q.bool_or("stall", true));
	});
	// graphics.testStall {ms}: the next video frame's tick blocks the graphics thread for ms (a stuck GPU), for the
	// graphics watchdog test (gfx_watch.h, D374). --test-hooks only.
	add("graphics.testStall", [&a](const json::Value &p) {
		Params q(p, {"ms"});
		if (!a.test_hooks)
			throw Error(rpc::FORBIDDEN, "graphics.testStall needs a host started with --test-hooks");
		if (!a.gfx_watch)
			throw Error(rpc::INTERNAL, "the graphics watchdog is not running");
		const int64_t ms = q.integer("ms", 1, 30000);
		a.gfx_watch->test_stall((uint32_t)ms);
		json::Value r = json::Value::object();
		r.set("ms", ms);
		return r;
	});
	// graphics.testSnapshot {writes, reads}: stress the lock-free stall snapshot (gfx_watch.h Published, the seqlock
	// host.alive reads) with a writer thread against this reader; torn must be 0. --test-hooks only.
	add("graphics.testSnapshot", [&a](const json::Value &p) {
		Params q(p, {"writes", "reads"});
		if (!a.test_hooks)
			throw Error(rpc::FORBIDDEN, "graphics.testSnapshot needs a host started with --test-hooks");
		const auto pr = gfxwatch::seqlock_probe((uint64_t)q.integer("writes", 1, 20000000), (uint64_t)q.integer("reads", 1, 20000000));
		json::Value r = json::Value::object();
		r.set("writes", (int64_t)pr.writes);
		r.set("reads", (int64_t)pr.reads);
		r.set("torn", (int64_t)pr.torn);
		r.set("retriedOut", (int64_t)pr.retried_out);
		r.set("changes", (int64_t)pr.changes);
		return r;
	});
	// audio.testHangDestroy {id}: that fake source's destroy never returns (a stuck libobs destruction thread at
	// shutdown, as a WASAPI source on a dead work queue); proves the shutdown guard ends the host. --test-hooks only.
	add("audio.testHangDestroy", [&a](const json::Value &p) {
		Params q(p, {"id"});
		if (!a.test_hooks)
			throw Error(rpc::FORBIDDEN, "audio.testHangDestroy needs a host started with --test-hooks");
		return a.studio->test_audio_hang_destroy(q.str("id", 64));
	});
	// audio.testCreate {mode: ok|fail|silent}: what the next ujw_test_audio creates do (a restart whose create fails,
	// or a replacement that never sends). audio.testConfig {id, syncOffsetMs?, balance?, forceMono?, gainFilterDb?}:
	// sets source-level settings on a test global and returns them (the watchdog must carry them over). --test-hooks.
	add("audio.testCreate", [&a](const json::Value &p) {
		Params q(p, {"mode"});
		if (!a.test_hooks)
			throw Error(rpc::FORBIDDEN, "audio.testCreate needs a host started with --test-hooks");
		const std::string m = q.str("mode", 8);
		if (m != "ok" && m != "fail" && m != "silent")
			throw Error(rpc::INVALID_PARAMS, "mode must be ok, fail or silent");
		ahealth::set_test_create_mode(m == "fail" ? ahealth::TestCreate::Fail
					      : m == "silent" ? ahealth::TestCreate::Silent
							      : ahealth::TestCreate::Ok);
		json::Value r = json::Value::object();
		r.set("mode", m);
		return r;
	});
	add("audio.testConfig", [&a](const json::Value &p) {
		Params q(p, {"id", "syncOffsetMs", "balance", "forceMono", "gainFilterDb"});
		if (!a.test_hooks)
			throw Error(rpc::FORBIDDEN, "audio.testConfig needs a host started with --test-hooks");
		json::Value set = json::Value::object();
		if (q.has("syncOffsetMs"))
			set.set("syncOffsetMs", q.int_or("syncOffsetMs", 0, -10000, 10000));
		if (q.has("balance")) {
			const json::Value *b = p.find("balance");
			if (!b->is_number() || b->as_double() < 0 || b->as_double() > 1)
				throw Error(rpc::INVALID_PARAMS, "balance must be a number 0..1");
			set.set("balance", b->as_double());
		}
		if (q.has("forceMono"))
			set.set("forceMono", q.bool_or("forceMono", false));
		if (q.has("gainFilterDb")) {
			const json::Value *b = p.find("gainFilterDb");
			if (!b->is_number() || b->as_double() < -30 || b->as_double() > 30)
				throw Error(rpc::INVALID_PARAMS, "gainFilterDb must be a number -30..30");
			set.set("gainFilterDb", b->as_double());
		}
		return a.studio->test_audio_config(q.str("id", 64), set);
	});
	// preview.placeSim {work: {x, y, w, h}, want: {x, y, w, h}}: the stand-alone preview's placement maths
	// (pplace::fit_in, D316) without a window. --test-hooks only.
	add("preview.placeSim", [&a](const json::Value &p) {
		Params q(p, {"work", "want"});
		if (!a.test_hooks)
			throw Error(rpc::FORBIDDEN, "preview.placeSim needs a host started with --test-hooks");
		auto rect = [](const json::Value &o) {
			Params r(o, {"x", "y", "w", "h"});
			pplace::Rect out;
			out.x = (long)r.integer("x", -65536, 65536);
			out.y = (long)r.integer("y", -65536, 65536);
			out.w = (long)r.integer("w", 0, 65536);
			out.h = (long)r.integer("h", 0, 65536);
			return out;
		};
		const pplace::Rect got = pplace::fit_in(rect(q.obj("work")), rect(q.obj("want")));
		json::Value o = json::Value::object();
		o.set("x", (int)got.x);
		o.set("y", (int)got.y);
		o.set("w", (int)got.w);
		o.set("h", (int)got.h);
		return o;
	});
	// preview.editSim {canvas, width, height, steps: [{event: hover|down|move|up|cancel, x, y, shift?, alt?}]}: runs the
	// window procedure's editor calls for a preview of width x height client px, without a window (headless tests).
	// Returns the selection after each step and the edit seq. --test-hooks only.
	// D335: dpi (96..384, default 96) is the window's DPI (handle sizes in logical px); applyEveryMs (0..1000) sets the
	// drag apply interval for this call only (0: every move, as before D335); event "flush" is the window's drag timer.
	// The result adds applies (Backend::apply calls made by these steps) and elapsedMs (host time for all the steps).
	add("preview.editSim", [&a](const json::Value &p) {
		Params q(p, {"canvas", "width", "height", "steps", "dpi", "applyEveryMs"});
		if (!a.test_hooks)
			throw Error(rpc::FORBIDDEN, "preview.editSim needs a host started with --test-hooks");
		std::string canvas = canvas_param(q);
		uint32_t cw = 0, ch = 0, fps = 0;
		if (!a.studio->canvas_size(canvas, cw, ch, fps))
			throw Error(rpc::CONFLICT, "canvas " + canvas + " does not exist");
		pedit::View v = pedit::fit_view((double)q.integer("width", 16, 8192), (double)q.integer("height", 16, 8192), cw, ch);
		v.dpi = (double)q.int_or("dpi", 96, 96, 384) / 96.0;
		const json::Value &steps = q.arr("steps");
		if (steps.size() > 256)
			throw Error(rpc::INVALID_PARAMS, "too many steps");
		pedit::Editor &ed = a.previews->editor();
		const int interval0 = ed.apply_interval_ms();
		if (q.has("applyEveryMs"))
			ed.set_apply_interval_ms((int)q.int_or("applyEveryMs", interval0, 0, 1000));
		struct Restore {
			pedit::Editor &ed;
			int ms;
			~Restore() { ed.set_apply_interval_ms(ms); }
		} restore{ed, interval0};
		const uint64_t applies0 = ed.applies();
		const auto t0 = std::chrono::steady_clock::now();
		json::Value out = json::Value::array();
		for (auto &st : steps.as_array()) {
			Params s(st, {"event", "x", "y", "shift", "alt"});
			std::string ev = s.str("event", 8);
			double x = s.num_or("x", 0, -16384, 16384), y = s.num_or("y", 0, -16384, 16384);
			pedit::Mods m;
			m.shift = s.bool_or("shift", false);
			m.alt = s.bool_or("alt", false);
			bool used = false;
			const char *cursor = nullptr;
			if (ev == "hover") // the cursor the window shows over that point (D330), no state change
				cursor = pedit::cursor_name(ed.hover(canvas, v, x, y, m));
			else if (ev == "down")
				used = ed.down(canvas, v, x, y, m);
			else if (ev == "move")
				used = ed.move(canvas, v, x, y, m);
			else if (ev == "up")
				used = ed.up(canvas, v, x, y, m);
			else if (ev == "cancel")
				ed.cancel(canvas);
			else if (ev == "flush")
				used = ed.flush(canvas);
			else
				throw Error(rpc::INVALID_PARAMS, "event must be hover, down, move, up, cancel or flush");
			json::Value o = ed.selection_json(canvas);
			o.set("used", used);
			if (cursor)
				o.set("cursor", std::string(cursor));
			out.push(std::move(o));
		}
		const double elapsed = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
		json::Value r = json::Value::object();
		r.set("steps", std::move(out));
		r.set("seq", (int64_t)ed.seq());
		r.set("applies", (int64_t)(ed.applies() - applies0));
		r.set("elapsedMs", elapsed);
		json::Value view = json::Value::object();
		view.set("x", v.vx);
		view.set("y", v.vy);
		view.set("width", v.vw);
		view.set("height", v.vh);
		r.set("view", std::move(view));
		return r;
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
	// mixer.setTracks {id, tracks: [project track id]} (D273): the whole list; [] takes the source out of every track.
	add("mixer.setTracks", [&a](const json::Value &p) {
		Params q(p, {"id", "tracks"});
		const json::Value *t = q.arr_opt("tracks");
		if (!t || t->size() > 6)
			throw Error(rpc::INVALID_PARAMS, "tracks: up to 6 track ids");
		std::vector<std::string> ids;
		for (auto &v : t->as_array()) {
			if (!v.is_string() || v.as_string().empty() || v.as_string().size() > 64)
				throw Error(rpc::INVALID_PARAMS, "tracks: track id strings");
			if (std::find(ids.begin(), ids.end(), v.as_string()) != ids.end())
				throw Error(rpc::INVALID_PARAMS, "tracks: each track once");
			ids.push_back(v.as_string());
		}
		return a.studio->mixer_set_tracks(q.str("id", 130), ids);
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
