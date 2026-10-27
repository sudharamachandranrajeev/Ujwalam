// SPDX-License-Identifier: GPL-2.0-or-later
// ujwalam-spike: P1 test scenarios. Each builds a scene graph, records, and logs evidence.
#include "host.h"
#include "scenes.h"

#include <chrono>
#include <cmath>
#include <memory>
#include <mutex>
#include <thread>

using host::logf;

namespace {

void sleep_s(double s)
{
	std::this_thread::sleep_for(std::chrono::milliseconds((int)(s * 1000)));
}

// Per-source audio level (peak and RMS over all samples seen), from the source's own audio
// before mixing, so each device can be shown non-silent on its own.
struct Meter {
	obs_source_t *src = nullptr;
	std::string name;
	std::mutex m;
	double peak = 0, sumsq = 0;
	uint64_t n = 0;
	static void cb(void *p, obs_source_t *, const struct audio_data *d, bool muted)
	{
		auto *me = static_cast<Meter *>(p);
		if (muted || !d->data[0])
			return;
		std::lock_guard<std::mutex> l(me->m);
		const float *f = reinterpret_cast<const float *>(d->data[0]); // planar float, channel 0
		for (uint32_t i = 0; i < d->frames; i++) {
			double v = std::fabs(f[i]);
			if (v > me->peak)
				me->peak = v;
			me->sumsq += v * v;
		}
		me->n += d->frames;
	}
	void report()
	{
		std::lock_guard<std::mutex> l(m);
		double rms = n ? std::sqrt(sumsq / n) : 0;
		auto db = [](double x) { return x > 0 ? 20 * std::log10(x) : -INFINITY; };
		logf("audio meter %s: samples=%llu (%.1fs @48k) peak=%.1f dBFS rms=%.1f dBFS", name.c_str(),
		     (unsigned long long)n, n / 48000.0, db(peak), db(rms));
	}
};

// RAII-free bag of objects released in reverse order at the end of a scenario.
struct Bag {
	std::vector<obs_output_t *> outputs;
	std::vector<obs_encoder_t *> encoders;
	std::vector<obs_source_t *> sources;
	std::vector<obs_scene_t *> scenes;
	std::vector<obs_canvas_t *> canvases;
	std::vector<std::unique_ptr<Meter>> meters;
	void meter(obs_source_t *src, const char *name)
	{
		if (!src)
			return;
		auto m = std::make_unique<Meter>();
		m->src = src;
		m->name = name;
		obs_source_add_audio_capture_callback(src, Meter::cb, m.get());
		meters.push_back(std::move(m));
	}
	~Bag()
	{
		for (auto &m : meters) {
			obs_source_remove_audio_capture_callback(m->src, Meter::cb, m.get());
			m->report();
		}
		for (auto *o : outputs)
			obs_output_release(o);
		for (auto *e : encoders)
			obs_encoder_release(e);
		obs_set_output_source(0, nullptr);
		for (auto *c : canvases)
			obs_canvas_set_channel(c, 0, nullptr);
		// Canvases with SCENE_REF (the main canvas included) hold their own reference on scenes,
		// so a release alone leaves scenes, and the browser sources inside them, alive until
		// obs_shutdown, which then unloads CEF with live browsers. Remove first, then release.
		for (auto *s : scenes) {
			obs_source_remove(obs_scene_get_source(s));
			obs_scene_release(s);
		}
		for (auto *s : sources) {
			obs_source_remove(s);
			obs_source_release(s);
		}
		for (auto *c : canvases) {
			obs_canvas_remove(c);
			obs_canvas_release(c);
		}
	}
};

obs_source_t *make_source(Bag &bag, const char *id, const char *name, obs_data_t *s)
{
	obs_source_t *src = obs_source_create(id, name, s, nullptr);
	obs_data_release(s);
	if (!src) {
		logf("FAIL create source %s (%s)", name, id);
		return nullptr;
	}
	bag.sources.push_back(src);
	logf("source created: %s (%s) %ux%u", name, id, obs_source_get_width(src), obs_source_get_height(src));
	return src;
}

obs_source_t *make_color(Bag &bag, const char *name, uint32_t abgr, Size sz)
{
	obs_data_t *s = obs_data_create();
	obs_data_set_int(s, "color", abgr);
	obs_data_set_int(s, "width", sz.w);
	obs_data_set_int(s, "height", sz.h);
	return make_source(bag, "color_source_v3", name, s);
}

obs_source_t *make_image(Bag &bag, const char *name, const std::string &file)
{
	obs_data_t *s = obs_data_create();
	obs_data_set_string(s, "file", file.c_str());
	return make_source(bag, "image_source", name, s);
}

obs_source_t *make_media(Bag &bag, const char *name, const std::string &file)
{
	obs_data_t *s = obs_data_create();
	obs_data_set_bool(s, "is_local_file", true);
	obs_data_set_string(s, "local_file", file.c_str());
	obs_data_set_bool(s, "looping", true);
	obs_data_set_bool(s, "hw_decode", false);
	return make_source(bag, "ffmpeg_source", name, s);
}

obs_source_t *make_browser(Bag &bag, const char *name, const std::string &url, Size sz, uint32_t fps)
{
	obs_data_t *s = obs_data_create();
	obs_data_set_string(s, "url", url.c_str());
	obs_data_set_bool(s, "is_local_file", false);
	obs_data_set_int(s, "width", sz.w);
	obs_data_set_int(s, "height", sz.h);
	obs_data_set_bool(s, "fps_custom", true);
	obs_data_set_int(s, "fps", fps);
	obs_data_set_bool(s, "reroute_audio", false);
	obs_data_set_bool(s, "shutdown", false);
	logf("browser source %s url=%s size=%ux%u fps=%u", name, url.c_str(), sz.w, sz.h, fps);
	return make_source(bag, "browser_source", name, s);
}

// dshow video device. The device id format is "<friendly name>:<device path>"; win-dshow also
// accepts a bare "<friendly name>:" and resolves it by name (see win-dshow DecodeDeviceId).
obs_source_t *make_dshow(Bag &bag, const char *name, const std::string &device, const std::string &audio_device)
{
	obs_data_t *s = obs_data_create();
	obs_data_set_string(s, "video_device_id", device.c_str());
	obs_data_set_int(s, "res_type", 0); // device default (no change to the device's configured mode)
	obs_data_set_bool(s, "active", true);
	obs_data_set_bool(s, "deactivate_when_not_showing", false);
	if (!audio_device.empty()) {
		obs_data_set_bool(s, "use_custom_audio_device", true);
		obs_data_set_string(s, "audio_device_id", audio_device.c_str());
		obs_data_set_int(s, "audio_output_mode", 0); // capture audio only (into the mix)
	}
	logf("dshow source %s video=%s audio=%s", name, device.c_str(), audio_device.c_str());
	return make_source(bag, "dshow_input", name, s);
}

obs_source_t *make_wasapi_input(Bag &bag, const char *name, const std::string &device)
{
	obs_data_t *s = obs_data_create();
	obs_data_set_string(s, "device_id", device.c_str());
	obs_data_set_bool(s, "use_device_timing", false);
	logf("wasapi input %s device=%s", name, device.c_str());
	return make_source(bag, "wasapi_input_capture", name, s);
}

obs_sceneitem_t *add_full(obs_scene_t *scene, obs_source_t *src, Size canvas)
{
	if (!src)
		return nullptr;
	obs_sceneitem_t *item = obs_scene_add(scene, src);
	obs_sceneitem_set_bounds_type(item, OBS_BOUNDS_SCALE_INNER);
	struct vec2 b;
	vec2_set(&b, (float)canvas.w, (float)canvas.h);
	obs_sceneitem_set_bounds(item, &b);
	obs_sceneitem_set_bounds_alignment(item, 0); // centre
	struct vec2 p;
	vec2_set(&p, 0.0f, 0.0f);
	obs_sceneitem_set_pos(item, &p);
	return item;
}

obs_source_t *make_bg(Bag &bag, const Args &a, const char *name, const std::string &key, Size canvas)
{
	std::string spec = a.get(key, "color");
	if (spec.rfind("image:", 0) == 0)
		return make_image(bag, name, spec.substr(6));
	if (spec.rfind("media:", 0) == 0)
		return make_media(bag, name, spec.substr(6));
	// default: dark slate background (0xAABBGGRR)
	return make_color(bag, name, 0xFF2A2420, canvas);
}

obs_source_t *add_filter(Bag &bag, obs_source_t *target, const std::string &id, const std::string &json)
{
	obs_data_t *s = host::data_from_json_arg(json);
	obs_source_t *f = obs_source_create_private(id.c_str(), ("filter-" + id).c_str(), s);
	obs_data_release(s);
	if (!f) {
		logf("FAIL create filter %s", id.c_str());
		return nullptr;
	}
	obs_source_filter_add(target, f);
	bag.sources.push_back(f);
	logf("filter added: %s on %s", id.c_str(), obs_source_get_name(target));
	return f;
}

bool encode_allowed()
{
	std::string which;
	if (host::live_app_running(which)) {
		logf("BLOCKED: Meld/OBS running (%s); encode tests skipped", which.c_str());
		return false;
	}
	return true;
}

obs_canvas_t *make_v_canvas(Bag &bag, Size sz, uint32_t fps)
{
	struct obs_video_info ovi = {};
	obs_get_video_info(&ovi); // same graphics module/adapter/format as the main mix
	ovi.base_width = ovi.output_width = sz.w;
	ovi.base_height = ovi.output_height = sz.h;
	ovi.fps_num = fps;
	ovi.fps_den = 1;
	obs_canvas_t *c = obs_canvas_create("V", &ovi, ACTIVATE | EPHEMERAL);
	if (!c || !obs_canvas_has_video(c)) {
		logf("FAIL obs_canvas_create V %ux%u", sz.w, sz.h);
		return nullptr;
	}
	bag.canvases.push_back(c);
	struct obs_video_info got = {};
	obs_canvas_get_video_info(c, &got);
	logf("canvas V created: base %ux%u output %ux%u @%u/%u flags=0x%x uuid=%s", got.base_width, got.base_height,
	     got.output_width, got.output_height, got.fps_num, got.fps_den, obs_canvas_get_flags(c),
	     obs_canvas_get_uuid(c));
	return c;
}

void log_video_info(const char *tag, video_t *v)
{
	const struct video_output_info *i = video_output_get_info(v);
	logf("%s video: %ux%u fps %u/%u format %d skipped=%u total=%u", tag, i->width, i->height, i->fps_num,
	     i->fps_den, (int)i->format, video_output_get_skipped_frames(v), video_output_get_total_frames(v));
}

} // namespace

// ---------------------------------------------------------------------------------------------
int cmd_probe(const Args &a)
{
	host::adapter_name();
	host::log_modules();
	host::log_types();
	// --list-dshow (needs --allow-devices): log win-dshow's device ids. This is the same
	// enumeration win-dshow runs when a dshow source activates; no device is streamed.
	if (a.has("list-dshow")) {
		obs_properties_t *props = obs_get_source_properties("dshow_input");
		for (const char *key : {"video_device_id", "audio_device_id"}) {
			obs_property_t *p = props ? obs_properties_get(props, key) : nullptr;
			size_t n = p ? obs_property_list_item_count(p) : 0;
			for (size_t i = 0; i < n; i++)
				logf("dshow %s [%zu] name=\"%s\" id=\"%s\"", key, i, obs_property_list_item_name(p, i),
				     obs_property_list_item_string(p, i));
		}
		obs_properties_destroy(props);
	}
	double hold = a.getd("hold", 0);
	if (hold > 0) {
		logf("holding %.1fs (e.g. to check obs-websocket listening)", hold);
		sleep_s(hold);
	}
	return 0;
}

// a. Chat Charge on the H canvas, one NVENC recording.
int cmd_chat_charge(const Args &a)
{
	host::adapter_name();
	Bag bag;
	Size H = {1920, 1080};
	obs_scene_t *scene = obs_scene_create("H");
	bag.scenes.push_back(scene);
	add_full(scene, make_bg(bag, a, "bg", "bg", H), H);
	add_full(scene, make_browser(bag, "chat-charge", a.get("url"), H, 60), H);
	obs_set_output_source(0, obs_scene_get_source(scene));

	double preroll = a.getd("preroll", 4);
	logf("preroll %.1fs (page load + Streamer.bot socket connect)", preroll);
	sleep_s(preroll);
	if (!encode_allowed())
		return 3;

	obs_encoder_t *venc = host::make_video_encoder(a, "h-video", obs_get_video());
	obs_encoder_t *aenc = host::make_audio_encoder("aac");
	if (!venc || !aenc)
		return 2;
	bag.encoders = {venc, aenc};
	std::string name = a.get("name", "chat-charge-h");
	obs_output_t *out = host::make_file_output(name.c_str(), host::out_path(name + ".mkv"), venc, aenc);
	bag.outputs = {out};
	if (!host::start_output(out))
		return 2;
	host::log_encoder(venc);
	bool ok = host::run_for(a.getd("seconds", 20), bag.outputs, name.c_str());
	host::stop_output(out);
	log_video_info("H", obs_get_video());
	return ok ? 0 : 2;
}

// c. Two canvases (H main + V via obs_canvas_create), each with its own video encoder; one
// shared AAC encoder (audio encoded once). Optional devices with --allow-devices.
int cmd_two_canvas(const Args &a)
{
	host::adapter_name();
	Bag bag;
	Size H = {1920, 1080};
	Size V = parse_size(a.get("v-size"), {1080, 1920});
	obs_canvas_t *vc = make_v_canvas(bag, V, 60);
	if (!vc)
		return 2;

	obs_scene_t *hs = obs_scene_create("H");
	bag.scenes.push_back(hs);
	if (a.has("h-device")) {
		obs_source_t *cap = make_dshow(bag, "h-capture", a.get("h-device"), a.get("h-device-audio"));
		add_full(hs, cap, H);
		bag.meter(cap, "h-capture");
	} else {
		add_full(hs, make_bg(bag, a, "h-bg", "bg", H), H);
	}
	if (a.has("mic")) {
		obs_source_t *mic = make_wasapi_input(bag, "mic", a.get("mic"));
		if (mic)
			obs_scene_add(hs, mic);
		bag.meter(mic, "mic");
	}
	if (a.has("url-h"))
		add_full(hs, make_browser(bag, "h-overlay", a.get("url-h"), H, 60), H);
	obs_set_output_source(0, obs_scene_get_source(hs));

	obs_scene_t *vs = obs_canvas_scene_create(vc, "V");
	if (!vs) {
		logf("FAIL obs_canvas_scene_create V");
		return 2;
	}
	bag.scenes.push_back(vs);
	obs_source_t *vsrc = nullptr;
	if (a.has("v-device"))
		vsrc = make_dshow(bag, "v-camera", a.get("v-device"), "");
	else
		vsrc = make_bg(bag, a, "v-bg", "v-bg", V);
	if (vsrc && a.has("v-filter"))
		add_filter(bag, vsrc, a.get("v-filter"), a.get("v-filter-settings"));
	add_full(vs, vsrc, V);
	if (a.has("url-v"))
		add_full(vs, make_browser(bag, "v-overlay", a.get("url-v"), V, 60), V);
	obs_canvas_set_channel(vc, 0, obs_scene_get_source(vs));

	double preroll = a.getd("preroll", 4);
	logf("preroll %.1fs", preroll);
	sleep_s(preroll);
	if (!encode_allowed())
		return 3;

	obs_encoder_t *ench = host::make_video_encoder(a, "h-video", obs_get_video());
	obs_encoder_t *encv = host::make_video_encoder(a, "v-video", obs_canvas_get_video(vc));
	obs_encoder_t *aac = host::make_audio_encoder("aac");
	if (!ench || !encv || !aac)
		return 2;
	bag.encoders = {ench, encv, aac};
	std::string prefix = a.get("name", "two-canvas");
	obs_output_t *oh = host::make_file_output("rec-h", host::out_path(prefix + "-h.mkv"), ench, aac);
	obs_output_t *ov = host::make_file_output("rec-v", host::out_path(prefix + "-v.mkv"), encv, aac);
	bag.outputs = {oh, ov};
	host::CpuSampler cpu;
	cpu.begin();
	if (!host::start_output(oh) || !host::start_output(ov))
		return 2;
	host::log_encoder(ench);
	host::log_encoder(encv);
	host::log_encoder(aac);
	bool ok = host::run_for(a.getd("seconds", 20), bag.outputs, prefix.c_str());
	logf("process CPU during recording: %.1f%%", cpu.query());
	host::stop_output(oh);
	host::stop_output(ov);
	log_video_info("H", obs_get_video());
	log_video_info("V", obs_canvas_get_video(vc));
	return ok ? 0 : 2;
}

// d. One video encoder + one audio encoder bound to two file outputs at once.
int cmd_shared_encoder(const Args &a)
{
	host::adapter_name();
	Bag bag;
	Size H = {1920, 1080};
	obs_scene_t *scene = obs_scene_create("H");
	bag.scenes.push_back(scene);
	add_full(scene, make_bg(bag, a, "bg", "bg", H), H);
	if (a.has("url"))
		add_full(scene, make_browser(bag, "overlay", a.get("url"), H, 60), H);
	obs_set_output_source(0, obs_scene_get_source(scene));
	sleep_s(a.getd("preroll", 3));
	if (!encode_allowed())
		return 3;

	obs_encoder_t *venc = host::make_video_encoder(a, "shared-video", obs_get_video());
	obs_encoder_t *aenc = host::make_audio_encoder("shared-aac");
	if (!venc || !aenc)
		return 2;
	bag.encoders = {venc, aenc};
	obs_output_t *o1 = host::make_file_output("sink-a", host::out_path("shared-a.mkv"), venc, aenc);
	obs_output_t *o2 = host::make_file_output("sink-b", host::out_path("shared-b.mkv"), venc, aenc);
	bag.outputs = {o1, o2};
	if (!host::start_output(o1) || !host::start_output(o2))
		return 2;
	logf("sink-a video encoder=%p sink-b video encoder=%p (same object: %s)",
	     (void *)obs_output_get_video_encoder(o1), (void *)obs_output_get_video_encoder(o2),
	     obs_output_get_video_encoder(o1) == obs_output_get_video_encoder(o2) ? "yes" : "no");
	logf("sink-a audio encoder=%p sink-b audio encoder=%p (same object: %s)",
	     (void *)obs_output_get_audio_encoder(o1, 0), (void *)obs_output_get_audio_encoder(o2, 0),
	     obs_output_get_audio_encoder(o1, 0) == obs_output_get_audio_encoder(o2, 0) ? "yes" : "no");
	host::log_encoder(venc);
	bool ok = host::run_for(a.getd("seconds", 15), bag.outputs, "shared");
	host::stop_output(o1);
	host::stop_output(o2);
	logf("encoder frames encoded: %u", obs_encoder_get_encoded_frames(venc));
	return ok ? 0 : 2;
}

// e. Large canvas, encoder scaled to a smaller size on the GPU.
int cmd_gpu_scale(const Args &a)
{
	host::adapter_name();
	Bag bag;
	Size base = parse_size(a.get("base"), {3840, 2160});
	Size scaled = parse_size(a.get("scaled"), {1920, 1080});
	bool gpu = !a.has("cpu-scale");
	obs_scene_t *scene = obs_scene_create("H");
	bag.scenes.push_back(scene);
	add_full(scene, make_bg(bag, a, "bg", "bg", base), base);
	if (a.has("url"))
		add_full(scene, make_browser(bag, "overlay", a.get("url"), {1920, 1080}, 60), base);
	obs_set_output_source(0, obs_scene_get_source(scene));
	sleep_s(a.getd("preroll", 3));
	if (!encode_allowed())
		return 3;

	obs_encoder_t *venc = host::make_video_encoder(a, "scaled-video", obs_get_video(), scaled.w, scaled.h, gpu);
	obs_encoder_t *aenc = host::make_audio_encoder("aac");
	if (!venc || !aenc)
		return 2;
	bag.encoders = {venc, aenc};
	std::string name = a.get("name", gpu ? "gpu-scale" : "cpu-scale");
	obs_output_t *out = host::make_file_output(name.c_str(), host::out_path(name + ".mkv"), venc, aenc);
	bag.outputs = {out};
	host::log_encoder(venc);
	if (!host::start_output(out))
		return 2;
	host::log_encoder(venc); // after start: video_mix shows the mix the encoder is bound to
	logf("encoder bound to main mix: %s",
	     obs_encoder_video(venc) == obs_get_video() ? "yes (no GPU rescale mix)" : "no (separate GPU-scaled mix)");
	bool ok = host::run_for(a.getd("seconds", 10), bag.outputs, name.c_str());
	host::stop_output(out);
	log_video_info("main", obs_get_video());
	return ok ? 0 : 2;
}

// Plugins: bgremoval | move | clone
int cmd_plugin(const Args &a)
{
	host::adapter_name();
	std::string test = a.get("test");
	Bag bag;
	Size H = {1920, 1080};
	double secs = a.getd("seconds", 10);

	if (test == "filter") {
		// A filter (e.g. background removal) on a media file source; measures render time and
		// process CPU without and then with the filter.
		obs_scene_t *scene = obs_scene_create("H");
		bag.scenes.push_back(scene);
		obs_source_t *media = make_media(bag, "media", a.get("media"));
		add_full(scene, media, H);
		obs_set_output_source(0, obs_scene_get_source(scene));
		sleep_s(2);
		host::CpuSampler cpu;
		cpu.begin();
		uint32_t lag0 = obs_get_lagged_frames();
		sleep_s(5);
		logf("baseline (no filter): process CPU %.1f%% render_avg %.2fms lagged %u", cpu.query(),
		     obs_get_average_frame_time_ns() / 1e6, obs_get_lagged_frames() - lag0);
		obs_source_t *f = add_filter(bag, media, a.get("filter-id"), a.get("filter-settings"));
		if (!f)
			return 2;
		sleep_s(a.getd("warmup", 5));
		if (!encode_allowed())
			return 3;
		obs_encoder_t *venc = host::make_video_encoder(a, "h-video", obs_get_video());
		obs_encoder_t *aenc = host::make_audio_encoder("aac");
		bag.encoders = {venc, aenc};
		std::string name = a.get("name", "plugin-filter");
		obs_output_t *out = host::make_file_output(name.c_str(), host::out_path(name + ".mkv"), venc, aenc);
		bag.outputs = {out};
		if (!host::start_output(out))
			return 2;
		cpu.begin();
		lag0 = obs_get_lagged_frames();
		bool ok = host::run_for(secs, bag.outputs, name.c_str());
		logf("with filter (recording): process CPU %.1f%% render_avg %.2fms lagged %u", cpu.query(),
		     obs_get_average_frame_time_ns() / 1e6, obs_get_lagged_frames() - lag0);
		host::stop_output(out);
		obs_data_t *fs = obs_source_get_settings(f);
		logf("filter settings in effect: %s", obs_data_get_json(fs));
		obs_data_release(fs);
		return ok ? 0 : 2;
	}

	if (test == "move") {
		// Move transition between two scenes sharing a source at different transforms.
		obs_source_t *box = make_media(bag, "box", a.get("media"));
		obs_scene_t *sa = obs_scene_create("A");
		obs_scene_t *sb = obs_scene_create("B");
		bag.scenes = {sa, sb};
		add_full(sa, make_color(bag, "bg-a", 0xFF2A2420, H), H);
		add_full(sb, make_color(bag, "bg-b", 0xFF2A2420, H), H);
		obs_sceneitem_t *ia = obs_scene_add(sa, box);
		obs_sceneitem_t *ib = obs_scene_add(sb, box);
		struct vec2 pos, scale;
		vec2_set(&pos, 80, 80);
		vec2_set(&scale, 0.25f, 0.25f);
		obs_sceneitem_set_pos(ia, &pos);
		obs_sceneitem_set_scale(ia, &scale);
		vec2_set(&pos, 900, 400);
		vec2_set(&scale, 0.5f, 0.5f);
		obs_sceneitem_set_pos(ib, &pos);
		obs_sceneitem_set_scale(ib, &scale);
		obs_data_t *ts = obs_data_create();
		obs_source_t *tr = obs_source_create("move_transition", "move", ts, nullptr);
		obs_data_release(ts);
		if (!tr) {
			logf("FAIL create move_transition");
			return 2;
		}
		bag.sources.push_back(tr);
		obs_transition_set(tr, obs_scene_get_source(sa));
		obs_set_output_source(0, tr);
		sleep_s(2);
		if (!encode_allowed())
			return 3;
		obs_encoder_t *venc = host::make_video_encoder(a, "h-video", obs_get_video());
		obs_encoder_t *aenc = host::make_audio_encoder("aac");
		bag.encoders = {venc, aenc};
		obs_output_t *out = host::make_file_output("plugin-move", host::out_path("plugin-move.mkv"), venc, aenc);
		bag.outputs = {out};
		if (!host::start_output(out))
			return 2;
		sleep_s(2);
		logf("move transition A->B start %s ok=%d", host::utc_now().c_str(),
		     (int)obs_transition_start(tr, OBS_TRANSITION_MODE_AUTO, 1500, obs_scene_get_source(sb)));
		sleep_s(3);
		logf("move transition B->A start %s ok=%d", host::utc_now().c_str(),
		     (int)obs_transition_start(tr, OBS_TRANSITION_MODE_AUTO, 1500, obs_scene_get_source(sa)));
		sleep_s(3);
		host::stop_output(out);
		return 0;
	}

	if (test == "clone") {
		// Source Clone on the V canvas mirroring a source that lives in the H scene.
		Size V = {1080, 1920};
		obs_canvas_t *vc = make_v_canvas(bag, V, 60);
		if (!vc)
			return 2;
		obs_scene_t *hs = obs_scene_create("H");
		bag.scenes.push_back(hs);
		obs_source_t *media = make_media(bag, "shared-media", a.get("media"));
		add_full(hs, media, H);
		obs_set_output_source(0, obs_scene_get_source(hs));
		obs_scene_t *vs = obs_canvas_scene_create(vc, "V");
		bag.scenes.push_back(vs);
		add_full(vs, make_color(bag, "v-bg", 0xFF402020, V), V);
		obs_data_t *cs = obs_data_create();
		obs_data_set_string(cs, "clone", "shared-media");
		obs_source_t *clone = make_source(bag, "source-clone", "clone-of-media", cs);
		if (!clone)
			return 2;
		obs_sceneitem_t *ci = obs_scene_add(vs, clone);
		struct vec2 pos;
		vec2_set(&pos, 0, 656);
		obs_sceneitem_set_pos(ci, &pos);
		struct vec2 scale;
		vec2_set(&scale, 1080.0f / 1920.0f, 1080.0f / 1920.0f);
		obs_sceneitem_set_scale(ci, &scale);
		obs_canvas_set_channel(vc, 0, obs_scene_get_source(vs));
		sleep_s(2);
		logf("clone size %ux%u (source %ux%u)", obs_source_get_width(clone), obs_source_get_height(clone),
		     obs_source_get_width(media), obs_source_get_height(media));
		if (!encode_allowed())
			return 3;
		obs_encoder_t *eh = host::make_video_encoder(a, "h-video", obs_get_video());
		obs_encoder_t *ev = host::make_video_encoder(a, "v-video", obs_canvas_get_video(vc));
		obs_encoder_t *aac = host::make_audio_encoder("aac");
		bag.encoders = {eh, ev, aac};
		obs_output_t *oh = host::make_file_output("clone-h", host::out_path("plugin-clone-h.mkv"), eh, aac);
		obs_output_t *ov = host::make_file_output("clone-v", host::out_path("plugin-clone-v.mkv"), ev, aac);
		bag.outputs = {oh, ov};
		if (!host::start_output(oh) || !host::start_output(ov))
			return 2;
		bool ok = host::run_for(secs, bag.outputs, "clone");
		host::stop_output(oh);
		host::stop_output(ov);
		return ok ? 0 : 2;
	}

	logf("unknown --test %s (filter | move | clone)", test.c_str());
	return 1;
}
