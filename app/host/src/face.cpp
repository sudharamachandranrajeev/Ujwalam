// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: face link. See face.h.
#include "face.h"

#include "log.h"

#include <graphics/vec4.h>

#include <windows.h>
#include <sddl.h>

#include <algorithm>
#include <chrono>
#include <cstring>

namespace face {

namespace {

std::atomic<Link *> g_link{nullptr};

int64_t epoch_ms()
{
	FILETIME ft;
	GetSystemTimeAsFileTime(&ft);
	ULARGE_INTEGER u;
	u.LowPart = ft.dwLowDateTime;
	u.HighPart = ft.dwHighDateTime;
	return (int64_t)(u.QuadPart / 10000ULL) - 11644473600000LL;
}

template <typename T> T rd(const uint8_t *v, size_t off)
{
	T x;
	std::memcpy(&x, v + off, sizeof x);
	return x;
}
template <typename T> void wr(uint8_t *v, size_t off, T x)
{
	std::memcpy(v + off, &x, sizeof x);
}
volatile LONG *lock_at(uint8_t *v, size_t off)
{
	return reinterpret_cast<volatile LONG *>(v + off);
}

// "D:P(A;;GA;;;<current user SID>)": only this user, no inherited entries (same rule as the discovery file).
bool owner_only_sa(SECURITY_ATTRIBUTES &sa, PSECURITY_DESCRIPTOR &sd)
{
	HANDLE tok = nullptr;
	if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &tok))
		return false;
	DWORD n = 0;
	GetTokenInformation(tok, TokenUser, nullptr, 0, &n);
	std::vector<uint8_t> buf(n);
	bool ok = n && GetTokenInformation(tok, TokenUser, buf.data(), n, &n);
	CloseHandle(tok);
	if (!ok)
		return false;
	LPWSTR sid = nullptr;
	if (!ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER *>(buf.data())->User.Sid, &sid))
		return false;
	std::wstring sddl = L"D:P(A;;GA;;;" + std::wstring(sid) + L")";
	LocalFree(sid);
	if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &sd, nullptr))
		return false;
	sa.nLength = sizeof sa;
	sa.lpSecurityDescriptor = sd;
	sa.bInheritHandle = FALSE;
	return true;
}

} // namespace

Link *get()
{
	return g_link.load();
}

void set(Link *l)
{
	g_link.store(l);
}

Link::Link(unsigned long pid)
{
	name_ = "Local\\ujwalam-face-" + std::to_string(pid);
	SECURITY_ATTRIBUTES sa{};
	PSECURITY_DESCRIPTOR sd = nullptr;
	if (!owner_only_sa(sa, sd)) {
		hlog::error("face link: owner-only security descriptor failed (%lu); face effects show the plain camera",
			    GetLastError());
		return;
	}
	std::wstring wname(name_.begin(), name_.end());
	HANDLE h = CreateFileMappingW(INVALID_HANDLE_VALUE, &sa, PAGE_READWRITE, 0, (DWORD)kTotal, wname.c_str());
	const DWORD err = GetLastError();
	LocalFree(sd);
	if (!h) {
		hlog::error("face link: CreateFileMapping failed (%lu)", err);
		return;
	}
	if (err == ERROR_ALREADY_EXISTS) { // someone made it first: never use a mapping we did not create
		CloseHandle(h);
		hlog::error("face link: %s already exists (not ours); face link off", name_.c_str());
		return;
	}
	void *v = MapViewOfFile(h, FILE_MAP_READ | FILE_MAP_WRITE, 0, 0, kTotal);
	if (!v) {
		hlog::error("face link: MapViewOfFile failed (%lu)", GetLastError());
		CloseHandle(h);
		return;
	}
	map_ = h;
	view_ = static_cast<uint8_t *>(v);
	wr<uint32_t>(view_, 8, (uint32_t)kTotal);
	wr<uint32_t>(view_, 72, (uint32_t)pid);
	wr<int64_t>(view_, 64, epoch_ms());
	wr<uint32_t>(view_, 4, kVersion);
	MemoryBarrier();
	wr<uint32_t>(view_, 0, kMagic); // last: the worker checks it before anything else
	obs_add_tick_callback(tick_cb, this);
	hlog::info("face link: %s ready (%zu bytes, owner-only)", name_.c_str(), kTotal);
}

Link::~Link()
{
	if (!view_)
		return;
	obs_remove_tick_callback(tick_cb, this); // no tick of ours runs after this returns
	obs_enter_graphics();
	for (auto &s : stages_)
		if (s.ss)
			gs_stagesurface_destroy(s.ss);
	if (tr_)
		gs_texrender_destroy(tr_);
	if (mask_tex_)
		gs_texture_destroy(mask_tex_);
	obs_leave_graphics();
	obs_weak_source_release(target_);
	wr<uint32_t>(view_, 0, 0); // a worker that still has it open sees the link gone
	UnmapViewOfFile(view_);
	CloseHandle(map_);
}

void Link::tick_cb(void *param, float)
{
	static_cast<Link *>(param)->on_tick();
}

bool Link::is_target(obs_source_t *src) const
{
	return src && src == target_raw_;
}

void Link::use(obs_source_t *src, uint32_t want, float smoothing)
{
	if (!view_ || !src)
		return;
	const int64_t now = epoch_ms();
	if (!target_ || now - target_used_ms_ > kTargetIdleMs) {
		if (target_raw_ != src) {
			obs_weak_source_release(target_);
			target_ = obs_source_get_weak_source(src);
			target_raw_ = src;
			target_first_seq_ = frame_seq_; // results for frames before this are for another camera
			mask_valid_ = false;
			face_ = Face();
			std::lock_guard<std::mutex> g(sm_);
			target_name_ = obs_source_get_name(src) ? obs_source_get_name(src) : "";
		}
	}
	if (src != target_raw_)
		return; // one camera at a time
	target_used_ms_ = now;
	want_accum_ |= want;
	smooth_accum_ = std::max(smooth_accum_, smoothing);
}

gs_texture_t *Link::mask(obs_source_t *src, float &weight) const
{
	weight = 0;
	if (!is_target(src) || !mask_valid_ || !mask_tex_)
		return nullptr;
	const int64_t age = epoch_ms() - result_ts_;
	weight = age <= kHoldMs ? 1.0f : std::max(0.0f, 1.0f - (float)(age - kHoldMs) / (float)kFadeMs);
	return mask_tex_;
}

bool Link::face(obs_source_t *src, Face &out) const
{
	if (!is_target(src) || !face_.found)
		return false;
	const int64_t age = epoch_ms() - result_ts_;
	if (age > kHoldMs)
		return false;
	out = face_;
	out.age_ms = age;
	return true;
}

void Link::on_tick()
{
	const int64_t now = epoch_ms();
	wr<int64_t>(view_, 64, now);
	// want / smoothing gathered by the filters during the last frame's render
	want_ = want_accum_;
	wr<uint32_t>(view_, 56, want_);
	wr<float>(view_, 60, std::clamp(smooth_accum_, 0.0f, 0.95f));
	want_accum_ = 0;
	smooth_accum_ = 0;
	if (target_ && now - target_used_ms_ > kTargetIdleMs) { // no face effect drew it for a second
		obs_weak_source_release(target_);
		target_ = nullptr;
		target_raw_ = nullptr;
		mask_valid_ = false;
		face_ = Face();
	}
	const bool alive = now - rd<int64_t>(view_, 168) <= kWorkerDeadMs;
	{
		std::lock_guard<std::mutex> g(sm_);
		worker_alive_ = alive;
	}
	read_result();
	if (!alive || !target_ || !want_) {
		for (auto &s : stages_)
			s.pending = false;
		return;
	}
	obs_source_t *src = obs_weak_source_get_source(target_);
	if (!src)
		return;
	capture(src);
	obs_source_release(src);
}

// Ticks: render + stage into a free surface every kMinIntervalMs; map a surface 2 ticks after it was staged.
void Link::capture(obs_source_t *src)
{
	const int64_t now = epoch_ms();
	obs_enter_graphics();
	for (auto &s : stages_) {
		if (!s.pending || ++s.ticks < 2)
			continue;
		uint8_t *data = nullptr;
		uint32_t ls = 0;
		if (gs_stagesurface_map(s.ss, &data, &ls)) {
			volatile LONG *lk = lock_at(view_, 16);
			InterlockedIncrement(lk); // odd: writing
			const size_t row = (size_t)s.w * 4;
			for (uint32_t y = 0; y < s.h; y++)
				std::memcpy(view_ + kFrameOff + row * y, data + (size_t)ls * y, row);
			gs_stagesurface_unmap(s.ss);
			wr<uint32_t>(view_, 20, s.w);
			wr<uint32_t>(view_, 24, s.h);
			wr<uint32_t>(view_, 28, s.w * 4);
			wr<uint64_t>(view_, 32, ++frame_seq_);
			wr<int64_t>(view_, 40, s.ts);
			wr<uint32_t>(view_, 48, s.src_w);
			wr<uint32_t>(view_, 52, s.src_h);
			InterlockedIncrement(lk); // even: done
			std::lock_guard<std::mutex> g(sm_);
			frames_sent_++;
		}
		s.pending = false;
	}
	const uint32_t cx = obs_source_get_width(src), cy = obs_source_get_height(src);
	Stage *free_s = nullptr;
	for (auto &s : stages_)
		if (!s.pending) {
			free_s = &s;
			break;
		}
	if (cx && cy && free_s && now - last_capture_ms_ >= kMinIntervalMs) {
		const double k = std::min({1.0, (double)kFrameMaxW / cx, (double)kFrameMaxH / cy});
		const uint32_t tw = std::max(1u, (uint32_t)(cx * k + 0.5)), th = std::max(1u, (uint32_t)(cy * k + 0.5));
		if (!tr_)
			tr_ = gs_texrender_create(GS_BGRA, GS_ZS_NONE);
		if (free_s->ss && (free_s->w != tw || free_s->h != th)) {
			gs_stagesurface_destroy(free_s->ss);
			free_s->ss = nullptr;
		}
		if (!free_s->ss) {
			free_s->ss = gs_stagesurface_create(tw, th, GS_BGRA);
			free_s->w = tw;
			free_s->h = th;
		}
		if (tr_ && free_s->ss) {
			gs_texrender_reset(tr_);
			if (gs_texrender_begin_with_color_space(tr_, tw, th, GS_CS_SRGB)) {
				vec4 zero;
				vec4_zero(&zero);
				gs_clear(GS_CLEAR_COLOR, &zero, 0.0f, 0);
				gs_ortho(0.0f, (float)cx, 0.0f, (float)cy, -100.0f, 100.0f);
				gs_blend_state_push();
				gs_blend_function(GS_BLEND_ONE, GS_BLEND_ZERO);
				obs_source_video_render(src);
				gs_blend_state_pop();
				gs_texrender_end(tr_);
				gs_stage_texture(free_s->ss, gs_texrender_get_texture(tr_));
				free_s->pending = true;
				free_s->ticks = 0;
				free_s->ts = now;
				free_s->src_w = cx;
				free_s->src_h = cy;
				last_capture_ms_ = now;
			}
		}
	}
	obs_leave_graphics();
}

// A new result (seqlock read; a torn read is skipped, the next tick tries again).
void Link::read_result()
{
	const uint64_t rs = rd<uint64_t>(view_, 144);
	if (rs == result_seq_)
		return;
	volatile LONG *lk = lock_at(view_, 128);
	const LONG s1 = *lk;
	if (s1 & 1)
		return;
	MemoryBarrier();
	const uint64_t fseq = rd<uint64_t>(view_, 152);
	const int64_t fts = rd<int64_t>(view_, 160);
	const uint32_t mw = rd<uint32_t>(view_, 132), mh = rd<uint32_t>(view_, 136);
	const bool want_mask = (want_ & kWantMask) != 0;
	const bool mask_ok = want_mask && mw && mh && mw <= kFrameMaxW && mh <= kFrameMaxH;
	if (mask_ok) {
		mask_buf_.resize((size_t)mw * mh);
		std::memcpy(mask_buf_.data(), view_ + kMaskOff, mask_buf_.size());
	}
	Face f;
	f.n = std::min(rd<uint32_t>(view_, 180), kLmkMax);
	f.found = rd<uint32_t>(view_, 140) != 0 && f.n == kLmkMax;
	if (f.found)
		std::memcpy(f.pts.data(), view_ + kLmkOff, (size_t)f.n * 3 * 4);
	for (int i = 0; i < 4; i++)
		f.box[i] = rd<float>(view_, 188 + 4 * i);
	f.roll = rd<float>(view_, 208);
	f.yaw = rd<float>(view_, 212);
	f.pitch = rd<float>(view_, 216);
	f.blink_r = rd<float>(view_, 220);
	f.blink_l = rd<float>(view_, 224);
	f.mouth = rd<float>(view_, 228);
	f.brows = rd<float>(view_, 232);
	const float infer = rd<float>(view_, 184);
	MemoryBarrier();
	if (*lk != s1)
		return; // the worker wrote meanwhile
	result_seq_ = rs;
	if (fseq <= target_first_seq_)
		return; // a frame of the previous target
	result_ts_ = fts;
	face_ = f;
	if (mask_ok) {
		obs_enter_graphics();
		if (mask_tex_ && (mask_w_ != mw || mask_h_ != mh)) {
			gs_texture_destroy(mask_tex_);
			mask_tex_ = nullptr;
		}
		if (!mask_tex_) {
			mask_tex_ = gs_texture_create(mw, mh, GS_R8, 1, nullptr, GS_DYNAMIC);
			mask_w_ = mw;
			mask_h_ = mh;
		}
		if (mask_tex_)
			gs_texture_set_image(mask_tex_, mask_buf_.data(), mw, false);
		obs_leave_graphics();
		mask_valid_ = mask_tex_ != nullptr;
	}
	std::lock_guard<std::mutex> g(sm_);
	results_++;
	last_infer_ms_ = infer;
	last_latency_ms_ = (double)(epoch_ms() - fts);
}

json::Value Link::stats() const
{
	json::Value r = json::Value::object();
	r.set("on", view_ != nullptr);
	if (!view_)
		return r;
	std::lock_guard<std::mutex> g(sm_);
	r.set("workerAlive", worker_alive_);
	r.set("target", target_name_);
	r.set("framesSent", frames_sent_);
	r.set("results", results_);
	r.set("inferMs", (double)((int64_t)(last_infer_ms_ * 100 + 0.5)) / 100.0);
	r.set("latencyMs", (double)((int64_t)(last_latency_ms_ * 10 + 0.5)) / 10.0);
	return r;
}

} // namespace face
