// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: per-layer visual effects. See effects.h.
#include "effects.h"
#include "log.h"
#include "rpc_server.h"
#include "ujw_effects.h" // generated: ujw_gaussian_blur_effect, ujw_rounded_corners_effect, ujw_shadow_effect, ujw_toner_effect, ujw_corner_pin_effect, ujw_blinds_effect

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

namespace fx {

namespace {

const char *WRAP_ID = "ujw_effects_wrap";
const char *BLUR_ID = "ujw_gaussian_blur";
const char *ROUND_ID = "ujw_rounded_corners";
const char *SHADOW_ID = "ujw_shadow";
const char *TONER_ID = "ujw_toner";
const char *PIN_ID = "ujw_corner_pin";
const char *BLINDS_ID = "ujw_blinds";

// Canvas px a shadow or glow reaches past the layer's box on every side: its offset plus its blur (size = 3 sigma).
double outset_of(const model::Effect &e)
{
	if (e.type == "shadow")
		return std::ceil(e.distance + e.size);
	if (e.type == "glow")
		return std::ceil(e.size);
	return 0;
}

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
	std::vector<obs_source_t *> outsets; // ujw_shadow filters in chain order (owned by the filter list; never removed)
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

constexpr int MAX_HALVINGS = 6; // factor up to 64 (a big shadow on a high-resolution source shown small)
constexpr int MAX_TAPS = 20;    // per side; must match the loop bound in ujw_gaussian_blur.effect

// Separable Gaussian on a texture: halves it 0-3 times (sigma / factor <= 6.5), then two passes of at most MAX_TAPS
// per side. Used by the blur filter (on the layer) and the shadow filter (on its offset copy). Graphics thread only.
struct Gauss {
	gs_effect_t *effect = nullptr;
	gs_eparam_t *p_image = nullptr, *p_texel = nullptr, *p_inv2s2 = nullptr, *p_radius = nullptr;
	gs_texrender_t *levels[MAX_HALVINGS + 1] = {}; // [k] 1/2^k ([0] unused)
	gs_texrender_t *ping = nullptr, *pong = nullptr;
};

void gauss_create(Gauss &g)
{
	g.effect = make_effect(ujw_gaussian_blur_effect, "ujw_gaussian_blur.effect");
	if (g.effect) {
		g.p_image = gs_effect_get_param_by_name(g.effect, "image");
		g.p_texel = gs_effect_get_param_by_name(g.effect, "texel");
		g.p_inv2s2 = gs_effect_get_param_by_name(g.effect, "inv2s2");
		g.p_radius = gs_effect_get_param_by_name(g.effect, "radius");
	}
	obs_enter_graphics();
	for (auto &t : g.levels)
		t = gs_texrender_create(GS_RGBA, GS_ZS_NONE);
	g.ping = gs_texrender_create(GS_RGBA, GS_ZS_NONE);
	g.pong = gs_texrender_create(GS_RGBA, GS_ZS_NONE);
	obs_leave_graphics();
}

void gauss_destroy(Gauss &g)
{
	obs_enter_graphics();
	for (auto &t : g.levels)
		gs_texrender_destroy(t);
	gs_texrender_destroy(g.ping);
	gs_texrender_destroy(g.pong);
	gs_effect_destroy(g.effect);
	obs_leave_graphics();
}

// One pass: draw `src` stretched to w x h into `tr` with technique `tech`. Framebuffer sRGB is on (caller), so the
// sRGB texture views make the averaging happen in linear light.
gs_texture_t *gauss_pass(Gauss &g, gs_texrender_t *tr, gs_texture_t *src, uint32_t w, uint32_t h, const char *tech,
			 float tx, float ty, float inv2s2, float radius)
{
	gs_texrender_reset(tr);
	if (!src || !gs_texrender_begin(tr, w, h))
		return nullptr;
	gs_ortho(0.0f, (float)w, 0.0f, (float)h, -100.0f, 100.0f);
	gs_effect_set_texture_srgb(g.p_image, src);
	struct vec2 texel;
	vec2_set(&texel, tx, ty);
	gs_effect_set_vec2(g.p_texel, &texel);
	gs_effect_set_float(g.p_inv2s2, inv2s2);
	gs_effect_set_float(g.p_radius, radius);
	while (gs_effect_loop(g.effect, tech))
		gs_draw_sprite(src, 0, w, h);
	gs_texrender_end(tr);
	return gs_texrender_get_texture(tr);
}

// Blurs tex (w x h) with sigma_x / sigma_y in texels of tex. The caller has set blend ONE/ZERO. Returns the blurred
// texture (at the reduced size; draw it stretched) or tex itself when both sigmas are < 0.5.
gs_texture_t *gauss_run(Gauss &g, gs_texture_t *tex, uint32_t w, uint32_t h, double sigma_x, double sigma_y)
{
	const double sigma = std::max(sigma_x, sigma_y);
	if (!tex || !g.effect || sigma < 0.5)
		return tex;
	int halvings = 0;
	while (halvings < MAX_HALVINGS && sigma / (double)(1 << halvings) > 6.5)
		halvings++;
	const double sx = sigma_x / (double)(1 << halvings), sy = sigma_y / (double)(1 << halvings); // texels at blur size
	const bool prev_srgb = gs_framebuffer_srgb_enabled();
	gs_enable_framebuffer_srgb(true);
	for (int k = 1; k <= halvings && tex; k++) {
		w = std::max(1u, w / 2);
		h = std::max(1u, h / 2);
		tex = gauss_pass(g, g.levels[k], tex, w, h, "Draw", 0, 0, 0, 0);
	}
	const int rx = std::min(MAX_TAPS, (int)std::ceil(3.0 * sx)), ry = std::min(MAX_TAPS, (int)std::ceil(3.0 * sy));
	if (tex && rx >= 1 && sx > 0)
		tex = gauss_pass(g, g.ping, tex, w, h, "Blur", 1.0f / (float)w, 0.0f, (float)(1.0 / (2.0 * sx * sx)), (float)rx);
	if (tex && ry >= 1 && sy > 0)
		tex = gauss_pass(g, g.pong, tex, w, h, "Blur", 0.0f, 1.0f / (float)h, (float)(1.0 / (2.0 * sy * sy)), (float)ry);
	gs_enable_framebuffer_srgb(prev_srgb);
	return tex;
}

// Draws the filter's target (the wrapper and the filters before this one) into tr at cx x cy, cleared to transparent.
// The caller has set blend ONE/ZERO.
gs_texture_t *render_target(gs_texrender_t *tr, obs_source_t *target, obs_source_t *parent, uint32_t cx, uint32_t cy)
{
	gs_texrender_reset(tr);
	if (!gs_texrender_begin(tr, cx, cy))
		return nullptr;
	struct vec4 clear;
	vec4_zero(&clear);
	gs_clear(GS_CLEAR_COLOR, &clear, 0.0f, 0);
	gs_ortho(0.0f, (float)cx, 0.0f, (float)cy, -100.0f, 100.0f);
	uint32_t pf = obs_source_get_output_flags(target);
	if (target == parent && !(pf & OBS_SOURCE_CUSTOM_DRAW) && !(pf & OBS_SOURCE_ASYNC))
		obs_source_default_render(target);
	else
		obs_source_video_render(target);
	gs_texrender_end(tr);
	return gs_texrender_get_texture(tr);
}

// Draws tex at w x h with the blur effect's plain copy (sRGB-correct).
void draw_copy(Gauss &g, gs_texture_t *tex, uint32_t w, uint32_t h)
{
	const bool prev_srgb = gs_framebuffer_srgb_enabled();
	gs_enable_framebuffer_srgb(true);
	gs_effect_set_texture_srgb(g.p_image, tex);
	while (gs_effect_loop(g.effect, "Draw"))
		gs_draw_sprite(tex, 0, w, h);
	gs_enable_framebuffer_srgb(prev_srgb);
}

struct Blur {
	obs_source_t *ctx = nullptr;
	Gauss g;
	gs_texrender_t *base = nullptr;
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
	gauss_create(b->g);
	obs_enter_graphics();
	b->base = gs_texrender_create(GS_RGBA, GS_ZS_NONE);
	obs_leave_graphics();
	blur_update(b, s);
	return b;
}

void blur_destroy(void *data)
{
	auto *b = static_cast<Blur *>(data);
	gauss_destroy(b->g);
	obs_enter_graphics();
	gs_texrender_destroy(b->base);
	obs_leave_graphics();
	delete b;
}

void blur_tick(void *data, float)
{
	static_cast<Blur *>(data)->processed = false;
}

void blur_render(void *data, gs_effect_t *)
{
	auto *b = static_cast<Blur *>(data);
	obs_source_t *target = obs_filter_get_target(b->ctx), *parent = obs_filter_get_parent(b->ctx);
	uint32_t cx = target ? obs_source_get_base_width(target) : 0, cy = target ? obs_source_get_base_height(target) : 0;
	if (!b->g.effect || !target || !parent || !cx || !cy) {
		obs_source_skip_video_filter(b->ctx);
		return;
	}
	if (!b->processed) { // once per frame, however many times the item is drawn
		gs_blend_state_push();
		gs_blend_function(GS_BLEND_ONE, GS_BLEND_ZERO);
		gs_texture_t *tex = render_target(b->base, target, parent, cx, cy);
		b->result = gauss_run(b->g, tex, cx, cy, b->strength * 0.5, b->strength * 0.5); // sigma in source pixels
		gs_blend_state_pop();
		b->processed = true;
	}
	if (b->result)
		draw_copy(b->g, b->result, cx, cy);
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

// --- ujw_shadow ---------------------------------------------------------------------------------------------------
// Drop shadow and outer glow (D257): a blurred copy of the layer's alpha in one colour, offset, under the layer. The
// filter's output is larger than its input by `pad` on every side, so the shadow is not cut at the layer's edge.
// Settings are in canvas pixels of the layer as placed (box_w x box_h, set by Studio through set_box): the filter
// turns them into its input's pixels each frame, so a shadow looks the same whatever the source resolution.

struct Shadow {
	obs_source_t *ctx = nullptr;
	Gauss g;
	gs_effect_t *effect = nullptr;
	gs_eparam_t *p_image = nullptr, *p_pic = nullptr, *p_color = nullptr, *p_spread = nullptr, *p_picmap = nullptr;
	gs_texrender_t *base = nullptr, *moved = nullptr, *out = nullptr;
	// written by update / set_box (any thread), read by get_width and render (graphics thread)
	std::atomic<float> r{0}, gr{0}, b{0}, opacity{1}, sigma{0}, dx{0}, dy{0}, spread{0}, pad{0}, box_w{0}, box_h{0};
	bool processed = false;
	gs_texture_t *result = nullptr; // shadow and picture composed at the padded size
};

float srgb_to_linear(float c)
{
	return c <= 0.04045f ? c / 12.92f : std::pow((c + 0.055f) / 1.055f, 2.4f);
}

void shadow_update(void *data, obs_data_t *s)
{
	auto *sh = static_cast<Shadow *>(data);
	const uint32_t c = (uint32_t)obs_data_get_int(s, "color");
	sh->r = srgb_to_linear((float)((c >> 16) & 0xff) / 255.0f);
	sh->gr = srgb_to_linear((float)((c >> 8) & 0xff) / 255.0f);
	sh->b = srgb_to_linear((float)(c & 0xff) / 255.0f);
	sh->opacity = (float)std::clamp(obs_data_get_double(s, "opacity"), 0.0, 1.0);
	sh->sigma = (float)std::clamp(obs_data_get_double(s, "sigma"), 0.0, 100.0);
	sh->dx = (float)std::clamp(obs_data_get_double(s, "dx"), -400.0, 400.0);
	sh->dy = (float)std::clamp(obs_data_get_double(s, "dy"), -400.0, 400.0);
	sh->spread = (float)std::clamp(obs_data_get_double(s, "spread"), 0.0, 1.0);
	sh->pad = (float)std::clamp(obs_data_get_double(s, "pad"), 0.0, 800.0);
}

void *shadow_create(obs_data_t *s, obs_source_t *src)
{
	auto *sh = new Shadow();
	sh->ctx = src;
	gauss_create(sh->g);
	sh->effect = make_effect(ujw_shadow_effect, "ujw_shadow.effect");
	if (sh->effect) {
		sh->p_image = gs_effect_get_param_by_name(sh->effect, "image");
		sh->p_color = gs_effect_get_param_by_name(sh->effect, "color");
		sh->p_spread = gs_effect_get_param_by_name(sh->effect, "spread");
		sh->p_pic = gs_effect_get_param_by_name(sh->effect, "pic");
		sh->p_picmap = gs_effect_get_param_by_name(sh->effect, "picmap");
	}
	obs_enter_graphics();
	sh->base = gs_texrender_create(GS_RGBA, GS_ZS_NONE);
	sh->moved = gs_texrender_create(GS_RGBA, GS_ZS_NONE);
	sh->out = gs_texrender_create(GS_RGBA, GS_ZS_NONE);
	obs_leave_graphics();
	shadow_update(sh, s);
	return sh;
}

void shadow_destroy(void *data)
{
	auto *sh = static_cast<Shadow *>(data);
	gauss_destroy(sh->g);
	obs_enter_graphics();
	gs_texrender_destroy(sh->base);
	gs_texrender_destroy(sh->moved);
	gs_texrender_destroy(sh->out);
	gs_effect_destroy(sh->effect);
	obs_leave_graphics();
	delete sh;
}

void shadow_tick(void *data, float)
{
	static_cast<Shadow *>(data)->processed = false;
}

// Input size, input px per canvas px on each axis, and the padding in input px.
struct ShadowGeom {
	uint32_t tw = 0, th = 0, padx = 0, pady = 0;
	double kx = 1, ky = 1;
};

ShadowGeom shadow_geom(Shadow *sh)
{
	ShadowGeom g;
	obs_source_t *target = obs_filter_get_target(sh->ctx);
	g.tw = target ? obs_source_get_base_width(target) : 0;
	g.th = target ? obs_source_get_base_height(target) : 0;
	const double bw = sh->box_w, bh = sh->box_h;
	g.kx = bw > 0 && g.tw ? (double)g.tw / bw : 1;
	g.ky = bh > 0 && g.th ? (double)g.th / bh : 1;
	g.padx = (uint32_t)std::ceil(sh->pad * g.kx);
	g.pady = (uint32_t)std::ceil(sh->pad * g.ky);
	return g;
}

uint32_t shadow_width(void *data)
{
	ShadowGeom g = shadow_geom(static_cast<Shadow *>(data));
	return g.tw ? g.tw + 2 * g.padx : 0;
}

uint32_t shadow_height(void *data)
{
	ShadowGeom g = shadow_geom(static_cast<Shadow *>(data));
	return g.th ? g.th + 2 * g.pady : 0;
}

void shadow_render(void *data, gs_effect_t *)
{
	auto *sh = static_cast<Shadow *>(data);
	obs_source_t *target = obs_filter_get_target(sh->ctx), *parent = obs_filter_get_parent(sh->ctx);
	const ShadowGeom geo = shadow_geom(sh);
	if (!sh->effect || !sh->g.effect || !target || !parent || !geo.tw || !geo.th) {
		obs_source_skip_video_filter(sh->ctx);
		return;
	}
	const uint32_t W = geo.tw + 2 * geo.padx, H = geo.th + 2 * geo.pady;
	if (!sh->processed) { // once per frame, however many times the item is drawn
		// Everything is composed into `out` here with explicit blend states, so the result does not depend on the
		// blend state of whoever draws this filter (a later filter captures it with ONE/ZERO; Codex review D257).
		gs_blend_state_push();
		gs_blend_function(GS_BLEND_ONE, GS_BLEND_ZERO);
		sh->result = nullptr;
		gs_texture_t *pic = render_target(sh->base, target, parent, geo.tw, geo.th), *mask = nullptr;
		gs_texrender_reset(sh->moved);
		if (pic && gs_texrender_begin(sh->moved, W, H)) { // the layer moved by the offset inside the padded size
			struct vec4 clear;
			vec4_zero(&clear);
			gs_clear(GS_CLEAR_COLOR, &clear, 0.0f, 0);
			gs_ortho(0.0f, (float)W, 0.0f, (float)H, -100.0f, 100.0f);
			gs_matrix_push();
			gs_matrix_translate3f((float)(geo.padx + sh->dx * geo.kx), (float)(geo.pady + sh->dy * geo.ky), 0.0f);
			draw_copy(sh->g, pic, geo.tw, geo.th);
			gs_matrix_pop();
			gs_texrender_end(sh->moved);
			mask = gauss_run(sh->g, gs_texrender_get_texture(sh->moved), W, H, sh->sigma * geo.kx, sh->sigma * geo.ky);
		}
		gs_texrender_reset(sh->out);
		if (mask && gs_texrender_begin(sh->out, W, H)) { // shadow under the picture, straight alpha, in the shader
			gs_ortho(0.0f, (float)W, 0.0f, (float)H, -100.0f, 100.0f);
			const bool prev_srgb = gs_framebuffer_srgb_enabled();
			gs_enable_framebuffer_srgb(true);
			struct vec4 col, map;
			vec4_set(&col, sh->r, sh->gr, sh->b, sh->opacity);
			// picture uv = uv * (W / tw, H / th) - (padx / tw, pady / th)
			vec4_set(&map, (float)W / (float)geo.tw, (float)H / (float)geo.th, (float)geo.padx / (float)geo.tw,
				 (float)geo.pady / (float)geo.th);
			gs_effect_set_texture(sh->p_image, mask);
			gs_effect_set_texture_srgb(sh->p_pic, pic);
			gs_effect_set_vec4(sh->p_color, &col);
			gs_effect_set_vec4(sh->p_picmap, &map);
			gs_effect_set_float(sh->p_spread, sh->spread);
			while (gs_effect_loop(sh->effect, "Draw"))
				gs_draw_sprite(mask, 0, W, H);
			gs_enable_framebuffer_srgb(prev_srgb);
			gs_texrender_end(sh->out);
			sh->result = gs_texrender_get_texture(sh->out);
		}
		gs_blend_state_pop();
		sh->processed = true;
	}
	if (sh->result)
		draw_copy(sh->g, sh->result, W, H); // like the blur filter: one sprite, in the caller's blend state
}

const char *shadow_name(void *)
{
	return "Ujwalam shadow / glow";
}

// --- ujw_toner -----------------------------------------------------------------------------------------------------
// Five-tone colour map (D258), see ujw_toner.effect.

struct Toner {
	obs_source_t *ctx = nullptr;
	gs_effect_t *effect = nullptr;
	gs_eparam_t *p_tone[5] = {}, *p_amount = nullptr;
	std::atomic<uint32_t> tone[5] = {};
	std::atomic<float> amount{1};
};

const char *const TONE_KEYS[5] = {"shadows", "darktones", "midtones", "brights", "highlights"};

void toner_update(void *data, obs_data_t *s)
{
	auto *t = static_cast<Toner *>(data);
	for (int i = 0; i < 5; i++)
		t->tone[i] = (uint32_t)obs_data_get_int(s, TONE_KEYS[i]) & 0xffffff;
	t->amount = (float)std::clamp(obs_data_get_double(s, "amount"), 0.0, 1.0);
}

void *toner_create(obs_data_t *s, obs_source_t *src)
{
	auto *t = new Toner();
	t->ctx = src;
	t->effect = make_effect(ujw_toner_effect, "ujw_toner.effect");
	if (t->effect) {
		for (int i = 0; i < 5; i++)
			t->p_tone[i] = gs_effect_get_param_by_name(t->effect, ("tone" + std::to_string(i)).c_str());
		t->p_amount = gs_effect_get_param_by_name(t->effect, "amount");
	}
	toner_update(t, s);
	return t;
}

void toner_destroy(void *data)
{
	auto *t = static_cast<Toner *>(data);
	obs_enter_graphics();
	gs_effect_destroy(t->effect);
	obs_leave_graphics();
	delete t;
}

void toner_render(void *data, gs_effect_t *)
{
	auto *t = static_cast<Toner *>(data);
	if (!t->effect) {
		obs_source_skip_video_filter(t->ctx);
		return;
	}
	if (!obs_source_process_filter_begin(t->ctx, GS_RGBA, OBS_NO_DIRECT_RENDERING))
		return;
	for (int i = 0; i < 5; i++) {
		const uint32_t c = t->tone[i];
		struct vec4 v;
		vec4_set(&v, (float)((c >> 16) & 0xff) / 255.0f, (float)((c >> 8) & 0xff) / 255.0f, (float)(c & 0xff) / 255.0f,
			 1.0f);
		gs_effect_set_vec4(t->p_tone[i], &v);
	}
	gs_effect_set_float(t->p_amount, t->amount);
	obs_source_process_filter_end(t->ctx, t->effect, 0, 0);
}

const char *toner_name(void *)
{
	return "Ujwalam toner";
}

// --- ujw_corner_pin ------------------------------------------------------------------------------------------------
// Corner pin (D259), see ujw_corner_pin.effect. Corners in the order top-left, top-right, bottom-right, bottom-left,
// each 0..1 of the layer's frame (y down).

struct Pin {
	obs_source_t *ctx = nullptr;
	gs_effect_t *effect = nullptr;
	gs_eparam_t *p_row[3] = {};
	std::mutex lock;
	double inv[9] = {1, 0, 0, 0, 1, 0, 0, 0, 1};
	bool degenerate = false;
};

const char *const PIN_KEYS[8] = {"topLeftX", "topLeftY", "topRightX", "topRightY", "bottomRightX", "bottomRightY",
				 "bottomLeftX", "bottomLeftY"};

// Unit square -> quad (Heckbert, "Fundamentals of Texture Mapping", 1989): (u, v) = (0,0), (1,0), (1,1), (0,1) go to
// p[0..3]. Returns the 3x3 matrix row-major in m.
void square_to_quad(const double *p, double *m)
{
	const double x0 = p[0], y0 = p[1], x1 = p[2], y1 = p[3], x2 = p[4], y2 = p[5], x3 = p[6], y3 = p[7];
	const double dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
	const double dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
	double g = 0, h = 0;
	const double den = dx1 * dy2 - dx2 * dy1;
	if ((std::fabs(dx3) > 1e-12 || std::fabs(dy3) > 1e-12) && std::fabs(den) > 1e-12) {
		g = (dx3 * dy2 - dx2 * dy3) / den;
		h = (dx1 * dy3 - dx3 * dy1) / den;
	}
	m[0] = x1 - x0 + g * x1;
	m[1] = x3 - x0 + h * x3;
	m[2] = x0;
	m[3] = y1 - y0 + g * y1;
	m[4] = y3 - y0 + h * y3;
	m[5] = y0;
	m[6] = g;
	m[7] = h;
	m[8] = 1;
}

void pin_update(void *data, obs_data_t *s)
{
	auto *t = static_cast<Pin *>(data);
	double p[8], m[9], a[9];
	for (int i = 0; i < 8; i++)
		p[i] = obs_data_get_double(s, PIN_KEYS[i]);
	square_to_quad(p, m);
	// adjugate = det * inverse; scaled by sign(det) so w stays positive inside the quad
	a[0] = m[4] * m[8] - m[5] * m[7];
	a[1] = m[2] * m[7] - m[1] * m[8];
	a[2] = m[1] * m[5] - m[2] * m[4];
	a[3] = m[5] * m[6] - m[3] * m[8];
	a[4] = m[0] * m[8] - m[2] * m[6];
	a[5] = m[2] * m[3] - m[0] * m[5];
	a[6] = m[3] * m[7] - m[4] * m[6];
	a[7] = m[1] * m[6] - m[0] * m[7];
	a[8] = m[0] * m[4] - m[1] * m[3];
	const double det = m[0] * a[0] + m[1] * a[3] + m[2] * a[6];
	// Scaled so the largest entry is 1 (the map does not change; the shader's w test stays scale-free).
	double big = 0;
	for (double v : a)
		big = std::max(big, std::fabs(v));
	std::lock_guard<std::mutex> g(t->lock);
	t->degenerate = det == 0 || big == 0 || !std::isfinite(det);
	if (t->degenerate)
		return;
	for (int i = 0; i < 9; i++)
		t->inv[i] = (det < 0 ? -a[i] : a[i]) / big;
}

void *pin_create(obs_data_t *s, obs_source_t *src)
{
	auto *t = new Pin();
	t->ctx = src;
	t->effect = make_effect(ujw_corner_pin_effect, "ujw_corner_pin.effect");
	if (t->effect)
		for (int i = 0; i < 3; i++)
			t->p_row[i] = gs_effect_get_param_by_name(t->effect, ("row" + std::to_string(i)).c_str());
	pin_update(t, s);
	return t;
}

void pin_destroy(void *data)
{
	auto *t = static_cast<Pin *>(data);
	obs_enter_graphics();
	gs_effect_destroy(t->effect);
	obs_leave_graphics();
	delete t;
}

void pin_render(void *data, gs_effect_t *)
{
	auto *t = static_cast<Pin *>(data);
	double inv[9];
	bool degenerate;
	{
		std::lock_guard<std::mutex> g(t->lock);
		std::memcpy(inv, t->inv, sizeof inv);
		degenerate = t->degenerate;
	}
	if (!t->effect || degenerate) { // a collapsed quad shows nothing rather than a broken picture
		if (!t->effect)
			obs_source_skip_video_filter(t->ctx);
		return;
	}
	if (!obs_source_process_filter_begin(t->ctx, GS_RGBA, OBS_NO_DIRECT_RENDERING))
		return;
	for (int i = 0; i < 3; i++) {
		struct vec4 v;
		vec4_set(&v, (float)inv[i * 3], (float)inv[i * 3 + 1], (float)inv[i * 3 + 2], 0.0f);
		gs_effect_set_vec4(t->p_row[i], &v);
	}
	obs_source_process_filter_end(t->ctx, t->effect, 0, 0);
}

const char *pin_name(void *)
{
	return "Ujwalam corner pin";
}

// --- ujw_blinds ----------------------------------------------------------------------------------------------------
// Venetian blinds (D262), see ujw_blinds.effect. Settings: completion 0..1 (hidden share of each slat), angle
// (degrees, the direction the slats are stacked along, y down), width (slat width, % of the layer's larger side),
// feather (source px).

struct Blinds {
	obs_source_t *ctx = nullptr;
	gs_effect_t *effect = nullptr;
	gs_eparam_t *p_size = nullptr, *p_dir = nullptr, *p_slat = nullptr, *p_hide = nullptr, *p_feather = nullptr;
	std::atomic<float> completion{0}, angle{0}, width{10}, feather{0};
};

void blinds_update(void *data, obs_data_t *s)
{
	auto *t = static_cast<Blinds *>(data);
	t->completion = (float)std::clamp(obs_data_get_double(s, "completion"), 0.0, 1.0);
	t->angle = (float)obs_data_get_double(s, "angle");
	t->width = (float)std::clamp(obs_data_get_double(s, "width"), 0.1, 100.0);
	t->feather = (float)std::clamp(obs_data_get_double(s, "feather"), 0.0, 1000.0);
}

void *blinds_create(obs_data_t *s, obs_source_t *src)
{
	auto *t = new Blinds();
	t->ctx = src;
	t->effect = make_effect(ujw_blinds_effect, "ujw_blinds.effect");
	if (t->effect) {
		t->p_size = gs_effect_get_param_by_name(t->effect, "size");
		t->p_dir = gs_effect_get_param_by_name(t->effect, "dir");
		t->p_slat = gs_effect_get_param_by_name(t->effect, "slat");
		t->p_hide = gs_effect_get_param_by_name(t->effect, "hide");
		t->p_feather = gs_effect_get_param_by_name(t->effect, "feather");
	}
	blinds_update(t, s);
	return t;
}

void blinds_destroy(void *data)
{
	auto *t = static_cast<Blinds *>(data);
	obs_enter_graphics();
	gs_effect_destroy(t->effect);
	obs_leave_graphics();
	delete t;
}

void blinds_render(void *data, gs_effect_t *)
{
	auto *t = static_cast<Blinds *>(data);
	obs_source_t *target = obs_filter_get_target(t->ctx);
	const uint32_t w = target ? obs_source_get_base_width(target) : 0, h = target ? obs_source_get_base_height(target) : 0;
	if (!t->effect || !w || !h) {
		obs_source_skip_video_filter(t->ctx);
		return;
	}
	if (!obs_source_process_filter_begin(t->ctx, GS_RGBA, OBS_NO_DIRECT_RENDERING))
		return;
	const double a = (double)t->angle * 3.14159265358979323846 / 180.0;
	struct vec2 size, dir;
	vec2_set(&size, (float)w, (float)h);
	vec2_set(&dir, (float)std::cos(a), (float)std::sin(a));
	gs_effect_set_vec2(t->p_size, &size);
	gs_effect_set_vec2(t->p_dir, &dir);
	gs_effect_set_float(t->p_slat, std::max(1.0f, (float)std::max(w, h) * t->width / 100.0f));
	gs_effect_set_float(t->p_hide, t->completion);
	gs_effect_set_float(t->p_feather, t->feather);
	obs_source_process_filter_end(t->ctx, t->effect, 0, 0);
}

const char *blinds_name(void *)
{
	return "Ujwalam blinds";
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

	struct obs_source_info sh = {};
	sh.id = SHADOW_ID;
	sh.type = OBS_SOURCE_TYPE_FILTER;
	sh.output_flags = OBS_SOURCE_VIDEO | OBS_SOURCE_SRGB;
	sh.get_name = shadow_name;
	sh.create = shadow_create;
	sh.destroy = shadow_destroy;
	sh.update = shadow_update;
	sh.get_width = shadow_width;
	sh.get_height = shadow_height;
	sh.video_tick = shadow_tick;
	sh.video_render = shadow_render;
	obs_register_source(&sh);

	struct obs_source_info tn = {};
	tn.id = TONER_ID;
	tn.type = OBS_SOURCE_TYPE_FILTER;
	tn.output_flags = OBS_SOURCE_VIDEO;
	tn.get_name = toner_name;
	tn.create = toner_create;
	tn.destroy = toner_destroy;
	tn.update = toner_update;
	tn.video_render = toner_render;
	obs_register_source(&tn);

	struct obs_source_info pn = {};
	pn.id = PIN_ID;
	pn.type = OBS_SOURCE_TYPE_FILTER;
	pn.output_flags = OBS_SOURCE_VIDEO;
	pn.get_name = pin_name;
	pn.create = pin_create;
	pn.destroy = pin_destroy;
	pn.update = pin_update;
	pn.video_render = pin_render;
	obs_register_source(&pn);

	struct obs_source_info bl = {};
	bl.id = BLINDS_ID;
	bl.type = OBS_SOURCE_TYPE_FILTER;
	bl.output_flags = OBS_SOURCE_VIDEO;
	bl.get_name = blinds_name;
	bl.create = blinds_create;
	bl.destroy = blinds_destroy;
	bl.update = blinds_update;
	bl.video_render = blinds_render;
	obs_register_source(&bl);
	hlog::info("effect source types registered: %s, %s, %s, %s, %s, %s", WRAP_ID, BLUR_ID, ROUND_ID, SHADOW_ID, TONER_ID,
		   PIN_ID);
	hlog::info("effect source type registered: %s", BLINDS_ID);
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
		} else if (e.type == "color") { // D258: OBS's own colour correction (obs-filters), all -1..1 except hue
			id = "color_filter_v2";
			obs_data_set_double(s, "brightness", e.brightness);
			obs_data_set_double(s, "contrast", e.contrast);
			obs_data_set_double(s, "saturation", e.saturation);
			obs_data_set_double(s, "hue_shift", e.hue);
		} else if (e.type == "blinds") { // D262
			id = BLINDS_ID;
			obs_data_set_double(s, "completion", e.completion);
			obs_data_set_double(s, "angle", e.angle);
			obs_data_set_double(s, "width", e.value);
			obs_data_set_double(s, "feather", e.size);
		} else if (e.type == "cornerPin") { // D259
			id = PIN_ID;
			for (int i = 0; i < 8; i++)
				obs_data_set_double(s, PIN_KEYS[i], e.pin[i]);
		} else if (e.type == "toner") { // D258
			id = TONER_ID;
			for (int i = 0; i < 5; i++)
				obs_data_set_int(s, TONE_KEYS[i], (long long)e.tones[i]);
			obs_data_set_double(s, "amount", e.amount);
		} else if (e.type == "shadow" || e.type == "glow") { // D257; canvas px, see ujw_shadow above
			id = SHADOW_ID;
			obs_data_set_int(s, "color", (long long)e.color);
			obs_data_set_double(s, "opacity", e.opacity);
			obs_data_set_double(s, "sigma", e.size / 3.0);
			obs_data_set_double(s, "spread", e.type == "glow" ? e.spread : 0.0);
			if (e.type == "shadow") { // angle: where the light comes from (0 = from the right, 90 = from above)
				const double a = e.angle * 3.14159265358979323846 / 180.0;
				obs_data_set_double(s, "dx", -std::cos(a) * e.distance);
				obs_data_set_double(s, "dy", std::sin(a) * e.distance);
			}
			obs_data_set_double(s, "pad", outset_of(e));
		}
		std::string fname = name + ":" + e.type + ":" + std::to_string(n++);
		obs_source_t *f = id ? obs_source_create_private(id, fname.c_str(), s) : nullptr;
		obs_data_release(s);
		if (!f) {
			obs_source_release(wrap);
			throw rpc::Error(rpc::INTERNAL, "effect filter create failed (" + e.type + ") for " + name);
		}
		obs_source_filter_add(wrap, f); // takes its own reference
		if (id == SHADOW_ID)
			static_cast<Wrap *>(obs_obj_get_data(wrap))->outsets.push_back(f);
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

double outset(const std::vector<model::Effect> &effects)
{
	double p = 0;
	for (auto &e : effects)
		p += outset_of(e);
	return p;
}

void set_box(obs_source_t *wrap, double w, double h, const std::vector<model::Effect> &effects)
{
	auto *wr = wrap ? static_cast<Wrap *>(obs_obj_get_data(wrap)) : nullptr;
	if (!wr)
		return;
	size_t i = 0;
	for (auto &e : effects) {
		if (e.type != "shadow" && e.type != "glow")
			continue;
		if (i < wr->outsets.size()) // each shadow sees the box grown by the shadows before it
			if (auto *sh = static_cast<Shadow *>(obs_obj_get_data(wr->outsets[i++]))) {
				sh->box_w = (float)w;
				sh->box_h = (float)h;
			}
		const double p = outset_of(e);
		w += 2 * p;
		h += 2 * p;
	}
}

} // namespace fx
