// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: per-layer visual effects. See effects.h.
#include "effects.h"
#include "log.h"
#include "rpc_server.h"
#include "ujw_effects.h" // generated: ujw_gaussian_blur_effect, ujw_rounded_corners_effect

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstring>

namespace fx {

namespace {

const char *WRAP_ID = "ujw_effects_wrap";
const char *BLUR_ID = "ujw_gaussian_blur";
const char *ROUND_ID = "ujw_rounded_corners";

gs_effect_t *make_effect(const char *src, const char *file)
{
	char *err = nullptr;
	obs_enter_graphics();
	gs_effect_t *e = gs_effect_create(src, file, &err);
	obs_leave_graphics();
	if (!e)
		hlog::error("effect %s did not compile: %s", file, err ? err : "(no message)");
	bfree(err);
	return e;
}

// --- ujw_effects_wrap -------------------------------------------------------------------------------------------

struct Wrap {
	obs_source_t *self = nullptr;
	obs_source_t *target = nullptr; // strong reference, set once by create_chain before the wrapper is shown
	std::atomic<int> l{0}, t{0}, r{0}, b{0};
};

void wrap_update(void *data, obs_data_t *s)
{
	auto *w = static_cast<Wrap *>(data);
	w->l = (int)std::clamp<long long>(obs_data_get_int(s, "crop_left"), 0, 16384);
	w->t = (int)std::clamp<long long>(obs_data_get_int(s, "crop_top"), 0, 16384);
	w->r = (int)std::clamp<long long>(obs_data_get_int(s, "crop_right"), 0, 16384);
	w->b = (int)std::clamp<long long>(obs_data_get_int(s, "crop_bottom"), 0, 16384);
}

void *wrap_create(obs_data_t *s, obs_source_t *src)
{
	auto *w = new Wrap();
	w->self = src;
	wrap_update(w, s);
	return w;
}

void wrap_destroy(void *data)
{
	auto *w = static_cast<Wrap *>(data);
	obs_source_release(w->target);
	delete w;
}

uint32_t wrap_width(void *data)
{
	auto *w = static_cast<Wrap *>(data);
	int tw = w->target ? (int)obs_source_get_width(w->target) : 0;
	return (uint32_t)std::max(0, tw - w->l - w->r);
}

uint32_t wrap_height(void *data)
{
	auto *w = static_cast<Wrap *>(data);
	int th = w->target ? (int)obs_source_get_height(w->target) : 0;
	return (uint32_t)std::max(0, th - w->t - w->b);
}

// The wrapper always carries at least one filter, and both filters draw it into a texture of the wrapper's size, so
// the part of the target outside the crop is clipped there.
void wrap_render(void *data, gs_effect_t *)
{
	auto *w = static_cast<Wrap *>(data);
	if (!w->target)
		return;
	gs_matrix_push();
	gs_matrix_translate3f(-(float)w->l, -(float)w->t, 0.0f);
	obs_source_video_render(w->target);
	gs_matrix_pop();
}

// Active/showing propagate to the target, so it keeps decoding while only the wrapper is visible.
void wrap_enum(void *data, obs_source_enum_proc_t cb, void *param)
{
	auto *w = static_cast<Wrap *>(data);
	if (w->target)
		cb(w->self, w->target, param);
}

// Audio passes through (D246): the wrapper hands its scene the target's own mix (already through the target's volume,
// mute and track mask), as an OBS scene does for its items. So an item with effects sounds like one without; the target
// keeps its mixer row and meter.
bool wrap_audio_render(void *data, uint64_t *ts_out, struct obs_source_audio_mix *out, uint32_t mixers, size_t channels,
		       size_t)
{
	auto *w = static_cast<Wrap *>(data);
	if (!w->target || obs_source_audio_pending(w->target))
		return false;
	const uint64_t ts = obs_source_get_audio_timestamp(w->target);
	if (!ts)
		return false;
	struct obs_source_audio_mix child = {};
	obs_source_get_audio_mix(w->target, &child);
	for (size_t mix = 0; mix < MAX_AUDIO_MIXES; mix++) {
		if ((mixers & (1u << mix)) == 0)
			continue;
		for (size_t ch = 0; ch < channels; ch++)
			memcpy(out->output[mix].data[ch], child.output[mix].data[ch], AUDIO_OUTPUT_FRAMES * sizeof(float));
	}
	*ts_out = ts;
	return true;
}

const char *wrap_name(void *)
{
	return "Ujwalam effects";
}

// --- ujw_gaussian_blur ------------------------------------------------------------------------------------------

constexpr int MAX_HALVINGS = 3; // factor up to 8
constexpr int MAX_TAPS = 20;    // per side; must match the loop bound in ujw_gaussian_blur.effect

struct Blur {
	obs_source_t *ctx = nullptr;
	gs_effect_t *effect = nullptr;
	gs_eparam_t *p_image = nullptr, *p_texel = nullptr, *p_inv2s2 = nullptr, *p_radius = nullptr;
	gs_texrender_t *levels[MAX_HALVINGS + 1] = {}; // [0] full size, [k] 1/2^k
	gs_texrender_t *ping = nullptr, *pong = nullptr;
	double strength = 10; // written by update (video thread, deferred), read by render (graphics thread)
	bool processed = false;
	gs_texture_t *result = nullptr;
};

void blur_update(void *data, obs_data_t *s)
{
	static_cast<Blur *>(data)->strength = std::clamp(obs_data_get_double(s, "strength"), 1.0, 100.0);
}

void *blur_create(obs_data_t *s, obs_source_t *src)
{
	auto *b = new Blur();
	b->ctx = src;
	b->effect = make_effect(ujw_gaussian_blur_effect, "ujw_gaussian_blur.effect");
	if (b->effect) {
		b->p_image = gs_effect_get_param_by_name(b->effect, "image");
		b->p_texel = gs_effect_get_param_by_name(b->effect, "texel");
		b->p_inv2s2 = gs_effect_get_param_by_name(b->effect, "inv2s2");
		b->p_radius = gs_effect_get_param_by_name(b->effect, "radius");
	}
	obs_enter_graphics();
	for (auto &t : b->levels)
		t = gs_texrender_create(GS_RGBA, GS_ZS_NONE);
	b->ping = gs_texrender_create(GS_RGBA, GS_ZS_NONE);
	b->pong = gs_texrender_create(GS_RGBA, GS_ZS_NONE);
	obs_leave_graphics();
	blur_update(b, s);
	return b;
}

void blur_destroy(void *data)
{
	auto *b = static_cast<Blur *>(data);
	obs_enter_graphics();
	for (auto &t : b->levels)
		gs_texrender_destroy(t);
	gs_texrender_destroy(b->ping);
	gs_texrender_destroy(b->pong);
	gs_effect_destroy(b->effect);
	obs_leave_graphics();
	delete b;
}

void blur_tick(void *data, float)
{
	static_cast<Blur *>(data)->processed = false;
}

// One pass: draw `src` stretched to w x h into `tr` with technique `tech`. Framebuffer sRGB is on (caller), so the
// sRGB texture views make the averaging happen in linear light.
gs_texture_t *blur_pass(Blur *b, gs_texrender_t *tr, gs_texture_t *src, uint32_t w, uint32_t h, const char *tech,
			float tx, float ty, float inv2s2, float radius)
{
	gs_texrender_reset(tr);
	if (!src || !gs_texrender_begin(tr, w, h))
		return nullptr;
	gs_ortho(0.0f, (float)w, 0.0f, (float)h, -100.0f, 100.0f);
	gs_effect_set_texture_srgb(b->p_image, src);
	struct vec2 texel;
	vec2_set(&texel, tx, ty);
	gs_effect_set_vec2(b->p_texel, &texel);
	gs_effect_set_float(b->p_inv2s2, inv2s2);
	gs_effect_set_float(b->p_radius, radius);
	while (gs_effect_loop(b->effect, tech))
		gs_draw_sprite(src, 0, w, h);
	gs_texrender_end(tr);
	return gs_texrender_get_texture(tr);
}

gs_texture_t *blur_process(Blur *b, obs_source_t *target, obs_source_t *parent, uint32_t cx, uint32_t cy)
{
	const double sigma = b->strength * 0.5; // source pixels
	int halvings = 0;
	while (halvings < MAX_HALVINGS && sigma / (double)(1 << halvings) > 6.5)
		halvings++;
	const double s = sigma / (double)(1 << halvings); // sigma in texels at the blur size
	const int radius = std::min(MAX_TAPS, (int)std::ceil(3.0 * s));

	gs_blend_state_push();
	gs_blend_function(GS_BLEND_ONE, GS_BLEND_ZERO);
	gs_texture_t *tex = nullptr;
	gs_texrender_reset(b->levels[0]);
	if (gs_texrender_begin(b->levels[0], cx, cy)) {
		struct vec4 clear;
		vec4_zero(&clear);
		gs_clear(GS_CLEAR_COLOR, &clear, 0.0f, 0);
		gs_ortho(0.0f, (float)cx, 0.0f, (float)cy, -100.0f, 100.0f);
		uint32_t pf = obs_source_get_output_flags(target);
		if (target == parent && !(pf & OBS_SOURCE_CUSTOM_DRAW) && !(pf & OBS_SOURCE_ASYNC))
			obs_source_default_render(target);
		else
			obs_source_video_render(target);
		gs_texrender_end(b->levels[0]);
		tex = gs_texrender_get_texture(b->levels[0]);
	}
	const bool prev_srgb = gs_framebuffer_srgb_enabled();
	gs_enable_framebuffer_srgb(true);
	uint32_t w = cx, h = cy;
	for (int k = 1; k <= halvings && tex; k++) {
		w = std::max(1u, w / 2);
		h = std::max(1u, h / 2);
		tex = blur_pass(b, b->levels[k], tex, w, h, "Draw", 0, 0, 0, 0);
	}
	if (tex && radius >= 1) {
		const float inv2s2 = (float)(1.0 / (2.0 * s * s));
		tex = blur_pass(b, b->ping, tex, w, h, "Blur", 1.0f / (float)w, 0.0f, inv2s2, (float)radius);
		tex = blur_pass(b, b->pong, tex, w, h, "Blur", 0.0f, 1.0f / (float)h, inv2s2, (float)radius);
	}
	gs_enable_framebuffer_srgb(prev_srgb);
	gs_blend_state_pop();
	return tex;
}

void blur_render(void *data, gs_effect_t *)
{
	auto *b = static_cast<Blur *>(data);
	obs_source_t *target = obs_filter_get_target(b->ctx), *parent = obs_filter_get_parent(b->ctx);
	uint32_t cx = target ? obs_source_get_base_width(target) : 0, cy = target ? obs_source_get_base_height(target) : 0;
	if (!b->effect || !target || !parent || !cx || !cy) {
		obs_source_skip_video_filter(b->ctx);
		return;
	}
	if (!b->processed) { // once per frame, however many times the item is drawn
		b->result = blur_process(b, target, parent, cx, cy);
		b->processed = true;
	}
	if (!b->result)
		return;
	const bool prev_srgb = gs_framebuffer_srgb_enabled();
	gs_enable_framebuffer_srgb(true);
	gs_effect_set_texture_srgb(b->p_image, b->result);
	while (gs_effect_loop(b->effect, "Draw"))
		gs_draw_sprite(b->result, 0, cx, cy);
	gs_enable_framebuffer_srgb(prev_srgb);
}

const char *blur_name(void *)
{
	return "Ujwalam Gaussian blur";
}

// --- ujw_rounded_corners ----------------------------------------------------------------------------------------

struct Round {
	obs_source_t *ctx = nullptr;
	gs_effect_t *effect = nullptr;
	gs_eparam_t *p_size = nullptr, *p_radius = nullptr;
	double radius = 0;
};

void round_update(void *data, obs_data_t *s)
{
	static_cast<Round *>(data)->radius = std::clamp(obs_data_get_double(s, "radius"), 0.0, 500.0);
}

void *round_create(obs_data_t *s, obs_source_t *src)
{
	auto *r = new Round();
	r->ctx = src;
	r->effect = make_effect(ujw_rounded_corners_effect, "ujw_rounded_corners.effect");
	if (r->effect) {
		r->p_size = gs_effect_get_param_by_name(r->effect, "size");
		r->p_radius = gs_effect_get_param_by_name(r->effect, "radius");
	}
	round_update(r, s);
	return r;
}

void round_destroy(void *data)
{
	auto *r = static_cast<Round *>(data);
	obs_enter_graphics();
	gs_effect_destroy(r->effect);
	obs_leave_graphics();
	delete r;
}

void round_render(void *data, gs_effect_t *)
{
	auto *r = static_cast<Round *>(data);
	obs_source_t *target = obs_filter_get_target(r->ctx);
	uint32_t cx = target ? obs_source_get_base_width(target) : 0, cy = target ? obs_source_get_base_height(target) : 0;
	if (!r->effect || !cx || !cy) {
		obs_source_skip_video_filter(r->ctx);
		return;
	}
	// Never direct rendering: the target is drawn into a texture of its size (this clips the wrapper's crop).
	if (!obs_source_process_filter_begin(r->ctx, GS_RGBA, OBS_NO_DIRECT_RENDERING))
		return;
	struct vec2 size;
	vec2_set(&size, (float)cx, (float)cy);
	gs_effect_set_vec2(r->p_size, &size);
	gs_effect_set_float(r->p_radius, (float)r->radius);
	obs_source_process_filter_end(r->ctx, r->effect, cx, cy);
}

const char *round_name(void *)
{
	return "Ujwalam rounded corners";
}

} // namespace

void register_types()
{
	struct obs_source_info w = {};
	w.id = WRAP_ID;
	w.type = OBS_SOURCE_TYPE_INPUT;
	w.output_flags = OBS_SOURCE_VIDEO | OBS_SOURCE_COMPOSITE | OBS_SOURCE_CUSTOM_DRAW | OBS_SOURCE_SRGB; // composite: audio_render, like a scene
	w.get_name = wrap_name;
	w.create = wrap_create;
	w.destroy = wrap_destroy;
	w.update = wrap_update;
	w.get_width = wrap_width;
	w.get_height = wrap_height;
	w.video_render = wrap_render;
	w.enum_active_sources = wrap_enum;
	w.enum_all_sources = wrap_enum;
	w.audio_render = wrap_audio_render;
	obs_register_source(&w);

	struct obs_source_info b = {};
	b.id = BLUR_ID;
	b.type = OBS_SOURCE_TYPE_FILTER;
	b.output_flags = OBS_SOURCE_VIDEO | OBS_SOURCE_SRGB;
	b.get_name = blur_name;
	b.create = blur_create;
	b.destroy = blur_destroy;
	b.update = blur_update;
	b.video_tick = blur_tick;
	b.video_render = blur_render;
	obs_register_source(&b);

	struct obs_source_info r = {};
	r.id = ROUND_ID;
	r.type = OBS_SOURCE_TYPE_FILTER;
	r.output_flags = OBS_SOURCE_VIDEO | OBS_SOURCE_SRGB;
	r.get_name = round_name;
	r.create = round_create;
	r.destroy = round_destroy;
	r.update = round_update;
	r.video_render = round_render;
	obs_register_source(&r);
	hlog::info("effect source types registered: %s, %s, %s", WRAP_ID, BLUR_ID, ROUND_ID);
}

obs_source_t *create_chain(obs_source_t *target, const std::string &name, const std::vector<model::Effect> &effects,
			   const Crop &crop)
{
	obs_data_t *d = obs_data_create();
	obs_data_set_int(d, "crop_left", crop.left);
	obs_data_set_int(d, "crop_top", crop.top);
	obs_data_set_int(d, "crop_right", crop.right);
	obs_data_set_int(d, "crop_bottom", crop.bottom);
	obs_source_t *wrap = obs_source_create_private(WRAP_ID, name.c_str(), d);
	obs_data_release(d);
	if (!wrap)
		throw rpc::Error(rpc::INTERNAL, "effects wrapper create failed for " + name);
	static_cast<Wrap *>(obs_obj_get_data(wrap))->target = obs_source_get_ref(target);
	int n = 0;
	for (auto &e : effects) {
		obs_data_t *s = obs_data_create();
		const char *id = nullptr;
		if (e.type == "blur") {
			id = BLUR_ID;
			obs_data_set_double(s, "strength", e.value);
		} else if (e.type == "rounded") {
			id = ROUND_ID;
			obs_data_set_double(s, "radius", e.value);
		} else if (e.type == "chromaKey") { // OBS's own filter (obs-filters module); key_color is 0xAABBGGRR
			id = "chroma_key_filter_v2";
			const uint32_t r = (e.color >> 16) & 0xff, g = (e.color >> 8) & 0xff, b = e.color & 0xff;
			obs_data_set_string(s, "key_color_type", "custom");
			obs_data_set_int(s, "key_color", (long long)(0xff000000u | (b << 16) | (g << 8) | r));
			obs_data_set_int(s, "similarity", e.similarity);
			obs_data_set_int(s, "smoothness", e.smoothness);
		}
		std::string fname = name + ":" + e.type + ":" + std::to_string(n++);
		obs_source_t *f = id ? obs_source_create_private(id, fname.c_str(), s) : nullptr;
		obs_data_release(s);
		if (!f) {
			obs_source_release(wrap);
			throw rpc::Error(rpc::INTERNAL, "effect filter create failed (" + e.type + ") for " + name);
		}
		obs_source_filter_add(wrap, f); // takes its own reference
		obs_source_release(f);
	}
	return wrap;
}

void set_crop(obs_source_t *wrap, const Crop &crop)
{
	obs_data_t *d = obs_data_create();
	obs_data_set_int(d, "crop_left", crop.left);
	obs_data_set_int(d, "crop_top", crop.top);
	obs_data_set_int(d, "crop_right", crop.right);
	obs_data_set_int(d, "crop_bottom", crop.bottom);
	obs_source_update(wrap, d);
	obs_data_release(d);
}

} // namespace fx
