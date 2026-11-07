// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: scene model on libobs. Canvases H (libobs main canvas) and V (obs_canvas_create), scenes per canvas,
// layers (one scene item each, on a source that may be shared), active scene per canvas, mixer state.
//
// Two input formats for project.load:
//   1. Project v1 (data/schemas/project.schema.json; Agent A's model). Mapped by model.h: one project scene becomes
//      one libobs scene on every project canvas, with the same scene id; one project layer becomes one source and
//      one item per placement; "duplicate" layers are extra items on the target's source.
//   2. Host test format, marked "format": "ujwalam-host-test" (generated test cards; no files, no devices):
//      { "format": "ujwalam-host-test", "version": 1, "name": "...",
//        "canvases": [ { "id": "H", "w": 1920, "h": 1080, "fps": 60 }, { "id": "V", "w": 1080, "h": 1920, "fps": 60 } ],
//        "scenes": [ { "id": "main", "canvas": "H", "name": "Main",
//                      "layers": [ { "id": "bars", "type": "test_pattern", "name": "Bars", "visible": true,
//                                    "settings": { ... }, "transform": { "fit": "inner", "x": 0, "y": 0, "w": 1920, "h": 1080 } } ] } ],
//        "active": { "H": "main", "V": "main-v" } }
//      Layer types: color, test_pattern, media, image; with --allow-devices also dshow_video, wasapi_input;
//      with --allow-browser also browser.
// Layers are listed bottom to top. Canvas ids are H and V (case-insensitive on input). A scene id may exist on both
// canvases; methods take an optional canvas and act on every canvas that has the scene when it is omitted (layers.list
// and layers.add need it when the scene is on both).
#pragma once

#include "json.h"
#include "model.h"
#include "preview_edit.h"

#include <obs.h>

#include <atomic>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

class Studio {
public:
	struct Flags {
		bool allow_devices = false;
		bool allow_browser = false;
	};
	struct LoadOptions {
		std::map<std::string, std::string> bases; // project v1 pathRef bases -> absolute directories
		bool skip_unavailable = false;            // build the rest when some layers cannot be built
		// Overlay browser layers: page URL per layer id (project v1 source.overlay; built by the Node caller with
		// feedQuery) and the relay page scope ("" none, "effects", "display"). The relay is one hidden browser
		// source (ujw:overlay-relay) that re-posts the overlay feed on BroadcastChannel 'rp-events' for pages such
		// as gg-burst. The ports are the host's own overlay server (set by the RPC layer, never by the caller).
		std::map<std::string, std::string> browser_urls;
		std::string relay_scope;
		uint16_t overlay_port = 0, overlay_feed_port = 0;
	};
	explicit Studio(Flags f) : flags_(f) {}
	~Studio();

	// Replaces the whole model. Refused (CONFLICT) while outputs_active. Throws rpc::Error.
	json::Value load(const json::Value &project, bool outputs_active, const LoadOptions &o = {});
	// Dry run for project v1: the build plan, device matches and what cannot be built. Creates nothing and opens no
	// device. Devices are listed (list-only; see devices.h) only with --allow-devices (D38).
	json::Value plan(const json::Value &project, const LoadOptions &o) const;
	json::Value get() const;
	void teardown();

	json::Value scenes_list(const std::string &canvas) const; // canvas "" = all
	json::Value scene_create(const json::Value &scene);
	json::Value scene_remove(const std::string &scene, const std::string &canvas);
	json::Value scene_activate(const std::string &scene, const std::string &canvas);

	json::Value layers_list(const std::string &scene, const std::string &canvas) const;
	json::Value layer_add(const std::string &scene, const std::string &canvas, const json::Value &layer, int64_t index);
	json::Value layer_remove(const std::string &scene, const std::string &canvas, const std::string &layer);
	json::Value layer_set_visible(const std::string &scene, const std::string &canvas, const std::string &layer, bool visible);
	json::Value layer_set_placement(const std::string &scene, const std::string &canvas, const std::string &layer,
					const json::Value &patch);
	json::Value layer_move(const std::string &scene, const std::string &canvas, const std::string &layer, int64_t index,
			       const std::string &dir);
	// Preview mouse editing (preview_edit.h): the visible layers of the canvas's active scene that have a project v1
	// placement, topmost first, as rectangles. false: no such canvas / scene, or not a project v1 model.
	bool preview_items(const std::string &canvas, std::string &scene, std::vector<pedit::Item> &top_first) const;

	// Panic (panic.h): hides every visible browser layer (overlays and effect pages) on every scene of every canvas
	// and returns what it hid; restore_layers shows those again (skipping layers that no longer exist or were shown
	// meanwhile). The overlay relay is not a scene item and is left alone.
	struct LayerRef {
		std::string canvas, scene, layer;
	};
	std::vector<LayerRef> hide_browser_layers();
	size_t restore_layers(const std::vector<LayerRef> &refs);

	// Latest meter peak (dBFS; -inf when silent or muted) of the source bound to project audio source `audio_id`
	// (a device global or a layer's audio). Never blocks: 1 found, 0 no such source, -1 the model is busy (another
	// thread holds it, e.g. project.load). For the cam-pop mic feed (overlay.h); any thread.
	int audio_peak_db(const std::string &audio_id, float &peak_db) const;
	// frames.grab (frames.h): a strong reference to the shared source behind layer `layer_id` (first match in any
	// scene on any canvas; a duplicate resolves to its target's source; a layer's effects wrapper is never returned).
	// The caller releases it. type = the layer type. Throws rpc::Error: no such layer, layer has no source / video.
	obs_source_t *layer_source_ref(const std::string &layer_id, std::string &type) const;
	json::Value mixer_list() const;
	json::Value mixer_set_volume(const std::string &id, const double *mul, const double *db);
	json::Value mixer_set_mute(const std::string &id, bool muted);
	json::Value mixer_set_cue(const std::string &id, bool cue);

	// Canvas video for encoders: "H" -> obs_get_video(), "V" -> V canvas video. nullptr if absent.
	video_t *canvas_video(const std::string &canvas) const;
	bool canvas_size(const std::string &canvas, uint32_t &w, uint32_t &h, uint32_t &fps) const;
	json::Value canvases_json() const;

	static std::string norm_canvas(const std::string &c); // "h" -> "H"; "" if not H/V

private:
	struct Meter;
	struct Src { // one libobs source; shared by every item that shows it (H, V, duplicates)
		obs_source_t *src = nullptr;
		std::shared_ptr<Meter> meter;
		std::string owner;    // layer id that owns it
		std::string audio_id; // project audio source id bound to it
		std::string audio_name; // its project name ("Mic", "Game"): the mixer row name
		~Src();
	};
	struct Layer {
		std::string id, name, type;
		json::Value settings, transform; // host test format
		json::Value placement;           // project v1
		std::string dup_of;              // project v1 duplicate: target layer id
		bool visible = true;
		std::shared_ptr<Src> src;
		// project v1 layer.effects: the item shows `fx` (a private ujw_effects_wrap over src->src, owned by this
		// layer, effects.h) instead of the shared source; the placement crop is applied by the wrapper.
		std::vector<model::Effect> effects;
		obs_source_t *fx = nullptr;
		obs_sceneitem_t *item = nullptr;
	};
	struct Scene {
		std::string id, name, canvas;
		obs_scene_t *scene = nullptr;
		std::vector<Layer> layers; // bottom to top
	};
	struct Canvas {
		std::string id;
		uint32_t w = 0, h = 0, fps = 0;
		obs_canvas_t *vc = nullptr; // V only; H is the main canvas
		std::string active;
	};
	struct Global { // project v1 audio device source on a main-canvas output channel
		std::shared_ptr<Src> src;
		uint32_t channel = 0;
	};

	Flags flags_;
	mutable std::recursive_mutex m_;
	std::vector<Canvas> canvases_;
	std::vector<Scene> scenes_;
	std::vector<Global> globals_;
	std::string format_; // "project-v1" or "ujwalam-host-test"
	json::Value model_doc_;
	bool dirty_ = false;
	obs_source_t *relay_ = nullptr; // overlay relay browser source (showing and active while it exists)
	std::string relay_scope_;
	void make_relay(const LoadOptions &o);
	void drop_relay();

	Canvas *canvas(const std::string &id);
	const Canvas *canvas(const std::string &id) const;
	Scene *scene(const std::string &id, const std::string &canvas);
	const Scene *scene(const std::string &id, const std::string &canvas) const;
	std::vector<Scene *> scenes_named(const std::string &id, const std::string &canvas);
	Scene *one_scene(const std::string &id, const std::string &canvas);
	void make_canvases(const std::vector<model::Canvas> &defs, const std::map<std::string, bool> &mix);
	Scene &new_scene(const std::string &id, const std::string &name, const std::string &canvas);
	Scene &make_scene(const json::Value &def);
	Layer make_layer(Scene &s, const json::Value &def);
	obs_source_t *create_source(const Scene &s, const std::string &layer_id, const std::string &type,
				    const json::Value &settings);
	std::shared_ptr<Src> wrap(obs_source_t *src, const std::string &owner);
	void add_item(Scene &s, Layer &l);
	void apply_transform(const Scene &s, Layer &l);
	void apply_placement(Layer &l);
	void apply_order(Scene &s);
	void destroy_layer(Layer &l);
	void destroy_scene(Scene &s);
	void set_channel(Canvas &c, Scene *s);
	json::Value load_model(const json::Value &doc, const LoadOptions &o);
	json::Value load_test_format(const json::Value &project, const LoadOptions &o);
	json::Value scene_json(const Scene &s) const;
	json::Value layer_json(const Scene &s, const Layer &l) const;
	std::shared_ptr<Src> find_audio(const std::string &id);
	model::Options model_options(const json::Value &doc, const LoadOptions &o, devices::List &list, bool list_devices) const;
};
