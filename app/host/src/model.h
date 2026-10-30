// SPDX-License-Identifier: GPL-2.0-or-later
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
};

struct Source {
	std::string layer;    // owning layer id (project-wide unique)
	std::string type;     // project layer type
	std::string obs_type; // libobs source id
	json::Value settings; // libobs settings (obs_data_create_from_json)
	std::string device, matched_by;
	bool overlay = false; // browser layer showing a project overlay from the host's overlay server
};

struct Item {
	std::string layer, name, type;
	std::string source_layer; // == layer, or the duplicate's target
	bool visible = true;
	json::Value placement;
};

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
	json::Value warnings = json::Value::array();
};

// Throws rpc::Error(INVALID_PARAMS) for a malformed document. Layers and audio that need a disabled feature, a
// missing device or a missing file are listed in plan.unavailable (code "forbidden" or "unavailable") instead.
Plan build(const json::Value &doc, const Options &o);
json::Value to_json(const Plan &p);

// True if the document is a project v1 model (not the host test format).
bool is_model(const json::Value &doc);

} // namespace model
