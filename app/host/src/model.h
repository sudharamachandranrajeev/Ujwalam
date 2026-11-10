// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: project v1 (data/schemas/project.schema.json, services/project/) -> host build plan.
//
// The plan is pure data: no libobs object is created and no device is opened. Studio::load builds the libobs graph
// from it; project.plan returns it as JSON (dry run).
//
// Mapping:
//   one project scene            -> one libobs scene per project canvas (same scene id on H and V)
//   one project layer            -> one libobs source (created once) + one scene item per placement canvas
//   layer type "duplicate"       -> another scene item on the target layer's source (no new source)
//   placement {x,y,width,height} -> item bounds STRETCH to width x height, centre alignment at the rectangle centre,
//                                   so rotation turns about the centre (UNVERIFIED against Meld)
//   placement.crop               -> item crop in source pixels (UNVERIFIED against Meld)
//   placement.opacity != 1       -> not applied (libobs items have no opacity); listed in warnings
//   layer.effects                -> per-item effect chain (studio.cpp: a private ujw_effects_wrap source over the shared
//                                   source, so a duplicate's effects never reach the original and no device opens twice)
//   browser layer                -> browser_source at the largest canvas fps, page control level 0 (no access to
//                                   the studio), no audio reroute; source.overlay pages come from the host's overlay
//                                   server (see Options), source.url pages only from 127.0.0.1 / localhost
//   audio.sources                -> volume, mute, track mixers (bit n = audio.tracks[n]) on the bound source;
//                                   a source with audio but no audio.sources entry gets no tracks
// Validation: Node callers run services/project/validate.mjs first (authoritative, cross-references included);
// the host re-checks everything it consumes and refuses what it cannot use safely.
#pragma once

#include "devices.h"
#include "json.h"

#include <map>
#include <string>
#include <vector>

namespace model {

struct Options {
	std::map<std::string, std::string> bases; // pathRef base -> absolute directory (media, overlays, data, profile)
	bool allow_devices = false;
	bool allow_browser = false;
	const devices::List *devices = nullptr; // null: devices were not listed (capture layers are unavailable)
	// Overlay browser layers (source.overlay): the page URL per layer id, built by the Node caller with
	// services/overlay-server feedQuery (app/host/lib/project.mjs), and the overlay server's static port (0: the
	// server is not running). A URL is used only if it is http://127.0.0.1:<port>/overlays/<that overlay's rel>[?...].
	std::map<std::string, std::string> browser_urls;
	uint16_t overlay_port = 0;
	// --test-hooks fake devices (devices.testSet, D329): capture layers are built on the host's test source type
	// ujw_test_capture (opens nothing) instead of dshow_input, and are allowed without --allow-devices.
	bool test_capture = false;
};

// A capture layer whose device is not connected (no match, or more than one by name) is not "unavailable": it is
// built "waiting" (D329), a dshow_input with an empty video_device_id that opens nothing, and the host's device
// watcher binds it when a matching device arrives. Disabled devices (no --allow-devices) stay "forbidden".
struct Source {
	std::string layer;    // owning layer id (project-wide unique)
	std::string type;     // project layer type
	std::string obs_type; // libobs source id
	json::Value settings; // libobs settings (obs_data_create_from_json)
	std::string device, matched_by;
	bool overlay = false; // browser layer showing a project overlay from the host's overlay server
	bool waiting = false; // capture layer built without a device (D329)
	std::string wait_problem; // devices::resolve problem while waiting
};

// Per-layer visual effect (project.schema.json $defs/effect), applied in list order.
//   blur:    value = strength 1..100 (Gaussian sigma = strength * 0.5 source pixels, after the placement crop)
//   rounded: value = corner radius 0..500 source pixels (after the placement crop); transparent outside
//   chromaKey (D246): color = 0xRRGGBB keyed out; similarity, smoothness 1..1000 (OBS chroma_key_filter_v2)
//   shadow (D257): color, opacity 0..1, size 0..200 (blur reach, canvas px; sigma = size / 3), distance 0..200 canvas
//           px, angle -360..360 degrees (where the light comes from: 0 right, 90 above; shadow on the other side)
//   glow (D257): color, opacity 0..1, size 0..200 canvas px, spread 0..1 (alpha lifted before the colour: harder edge)
//   color (D258): brightness, contrast, saturation -1..1 (0 = unchanged), hue -180..180 degrees (OBS color_filter_v2)
//   toner (D258): tones = shadows, darktones, midtones, brights, highlights (0xRRGGBB), amount 0..1
//   blinds (D262): completion 0..1 (hidden share of each slat), angle -360..360 (slats stacked along it, y down),
//                  width 1..100 (slat width, % of the layer's larger side; kept in value), feather 0..100 source px
//                  (kept in size)
//   cornerPin (D259): pin = topLeft, topRight, bottomRight, bottomLeft corners, x then y, each 0..1 of the layer frame
// D291 filters, camera and compositing (shares of the frame are of the layer after the placement crop):
//   sharpen: amount 0..1 (OBS sharpness_filter_v2)
//   vignette: amount 0..1, size 0..1 (where it starts: 0 centre, 1 corner), softness 0..1, color
//   grain: amount 0..1, size 1..10 source px (grain cell); seeded per layer, new pattern every frame, zero mean
//   pixelate: size 2..200 source px (cell)          posterize: levels 2..32 (kept in value)
//   lut: file (pathRef, .cube or 512 x 512 .png; resolved into path), amount 0..1 (OBS clut_filter)
//   mirror (left-right), flip (upside down): no settings
//   circleMask: ellipse filling the frame; roundMask: rounded rectangle, radius 0..50 % of the shorter side (value);
//               both feather 0..25 and borderWidth 0..25 (% of the shorter side), borderColor (kept in color)
//   opacity: opacity 0..1
//   blendAdd, blendSubtract, blendMultiply, blendScreen, blendLighten, blendDarken: opacity 0..1 and the scene item's
//               blending mode (at most one blend effect per layer)
//   gradientMask: angle -360..360 (direction of the fade, 0 = left to right, y down), start, end 0..1
//   imageMask: file (pathRef image), channel "luma" | "alpha", invert, feather 0..100 mask px
// Face AI (flag face-ai, D295 proposed; masks and face points come from the face link, face.h):
//   personMask: mode "remove" | "blur" | "replace" (default remove), threshold 0..1, feather 0..1 (edge width in
//               matte units), smoothing 0..0.95 (temporal, done by the worker), strength 1..100 (blur, as the blur
//               effect; default 20, kept in value), replace: color (default #00b140) or file (pathRef image)
//   autoFrame:  zoom 1..4, smoothing 0..5 s (ease time constant), deadzone 0..0.5 (share of the crop)
//   faceSticker: file (pathRef image), anchor "eyes" | "nose" | "forehead" | "mouth", scale 0.1..10 (width in eye
//               distances), offsetX / offsetY -5..5 (eye distances, in the face's own frame)
struct Effect {
	std::string type; // "blur" | "rounded" | "chromaKey" | "shadow" | "glow" | "color" | "toner" | "cornerPin" | "blinds"
	                  // | D291 types above
	double value = 0;
	uint32_t color = 0;
	int64_t similarity = 400, smoothness = 80;
	double opacity = 1, size = 0, distance = 0, angle = 0, spread = 0;
	double brightness = 0, contrast = 0, saturation = 0, hue = 0;
	uint32_t tones[5] = {};
	double amount = 1;
	double completion = 0;
	double pin[8] = {0, 0, 1, 0, 1, 1, 0, 1};
	double softness = 0, feather = 0, border = 0, start = 0, end = 1; // D291
	bool invert = false;
	std::string channel;    // imageMask: "luma" | "alpha"
	json::Value file;       // lut, imageMask: the pathRef as given (effects_json returns it, never the resolved path)
	std::string path;       // its absolute file, when parse_effects was given the bases
	// face AI (D295 proposed)
	std::string mode, anchor;
	double threshold = 0.5, smoothing = 0, zoom = 1.6, deadzone = 0.1, scale = 1, offset_x = 0, offset_y = 0;
};

// Face AI effect types (personMask, autoFrame, faceSticker).
bool is_face(const std::string &type);

// Blend effect types (D291), in the order of libobs's enum obs_blending_type after OBS_BLEND_NORMAL.
bool is_blend(const std::string &type);

struct Item {
	std::string layer, name, type;
	std::string source_layer; // == layer, or the duplicate's target
	bool visible = true;
	json::Value placement;
	std::vector<Effect> effects; // empty: the item shows the shared source directly
};

// Parses and checks a layer's "effects" array (absent: empty). Throws rpc::Error(INVALID_PARAMS).
// File effects (lut, imageMask, D291): with `bases` each file is resolved into Effect::path. A file that cannot be
// resolved throws rpc::Error(UNAVAILABLE), or, when `warnings` is given, drops that effect and adds a warning
// {layer, effect, reason} (a project load shows the layer without it). Without `bases` nothing is resolved (path
// stays empty) and fx::create_chain refuses the effect.
std::vector<Effect> parse_effects(const json::Value *effects, const std::string &what,
				  const std::map<std::string, std::string> *bases = nullptr, json::Value *warnings = nullptr);
json::Value effects_json(const std::vector<Effect> &e);

struct Scene {
	std::string id, name;
	std::map<std::string, std::vector<Item>> items; // "H"/"V" -> bottom to top
};

struct Canvas {
	std::string id; // "H" / "V"
	uint32_t w = 0, h = 0, fps = 0;
};

struct Audio {
	std::string id, name;
	std::string layer;    // bound to this layer's source (set for layer audio and for device audio via a capture layer)
	std::string obs_type; // non-empty: a separate global source (microphone / audio-output device)
	json::Value settings;
	std::string device, matched_by;
	double volume_db = 0;
	bool muted = false;
	uint32_t mixers = 0;
	std::string monitoring; // off | monitor-only | monitor-and-output
};

struct Plan {
	std::vector<Canvas> canvases;
	std::vector<Scene> scenes;
	std::map<std::string, Source> sources; // by layer id
	std::vector<Audio> audio;
	std::string active;
	json::Value unavailable = json::Value::array(); // [{layer|audio, reason, code}] not built
	json::Value waiting = json::Value::array();     // [{layer, device, reason, message}] built, waiting for a device (D329)
	json::Value warnings = json::Value::array();
};

// Throws rpc::Error(INVALID_PARAMS) for a malformed document. Layers and audio that need a disabled feature, a
// missing device or a missing file are listed in plan.unavailable (code "forbidden" or "unavailable") instead.
Plan build(const json::Value &doc, const Options &o);
json::Value to_json(const Plan &p);

// True if the document is a project v1 model (not the host test format).
bool is_model(const json::Value &doc);
// A pathRef {base, rel} as an absolute file inside its base directory (symlinks resolved, must stay inside).
// Throws rpc::Error: INVALID_PARAMS for a bad ref, UNAVAILABLE when the base is not given or the file is missing.
std::string resolve_path_ref(const json::Value &ref, const std::map<std::string, std::string> &bases, const std::string &what);

} // namespace model
