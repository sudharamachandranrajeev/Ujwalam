// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: per-layer visual effects (project v1 layer.effects; model.h Effect).
//
// Source types registered by the host (register_types, once after obs_startup):
//   ujw_effects_wrap     private input that draws another source (strong ref, never a second open of it) with an
//                        optional crop. Filters go on the wrapper, so an effect on one item (a duplicate, or one canvas)
//                        never reaches the shared source or its other items. Audio passes through (D246): the item
//                        mixes the shared source's own audio (its volume, mute, tracks); the source keeps its mixer
//                        row and meter.
//   ujw_gaussian_blur    filter: renders its target once per frame, halves it 0-3 times (sigma / factor <= 6.5),
//                        runs a separable two-pass Gaussian at that size (<= 20 taps per side) and draws the result
//                        upscaled (bilinear). sigma = strength * 0.5 source pixels.
//   ujw_rounded_corners  filter: alpha mask outside a rounded rectangle, radius in source pixels.
//   ujw_shadow           filter (D257): drop shadow / outer glow under the layer, in canvas pixels; its output is
//                        larger than its input by the shadow's reach (outset), so nothing is cut at the box edge.
//   ujw_toner            filter (D258): five-tone colour map by luma, mixed by amount. The `color` effect uses
//                        OBS's own color_filter_v2 (obs-filters).
// Shaders: app/host/data/effects/*.effect, embedded into the exe by CMakeLists.txt (no runtime file lookup).
#pragma once

#include "model.h"

#include <obs.h>

#include <string>
#include <vector>

namespace fx {

struct Crop {
	int left = 0, top = 0, right = 0, bottom = 0;
};

void register_types();

// New private wrapper over `target` with the effect chain applied in order. Returns a new reference (the caller
// releases it); throws rpc::Error(INTERNAL) if a source or filter cannot be created.
obs_source_t *create_chain(obs_source_t *target, const std::string &name, const std::vector<model::Effect> &effects,
			   const Crop &crop);

// Crop of the wrapper's target (source pixels); applied on the next video tick.
void set_crop(obs_source_t *wrap, const Crop &crop);

// Shadow / glow (D257): canvas px the effects reach past the layer's box on every side (0 without them). The item's
// bounds grow by this much so the picture keeps its place and size.
double outset(const std::vector<model::Effect> &effects);
// The layer's box in canvas px (placement width x height), for the shadow filters' unit conversion.
void set_box(obs_source_t *wrap, double w, double h, const std::vector<model::Effect> &effects);

} // namespace fx
