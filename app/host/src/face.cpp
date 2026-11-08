// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: face link. See face.h.
#include "face.h"

#include "log.h"

#include <graphics/vec4.h>

#include <windows.h>
#include <d3d11.h>
#include <sddl.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
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

// Host-only freshness clock: never jumps with the wall clock and is never written by the worker.
int64_t steady_ms()
{
	return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch())
		.count();
}

double since_ms(std::chrono::steady_clock::time_point t0)
{
	return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
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
// Seqlock reader: an acquire load of the lock word (aligned 32-bit loads are atomic on x64; the fence keeps every later
// read of the payload after it).
LONG load_acquire(volatile LONG *p)
{
	const LONG v = *p;
	std::atomic_thread_fence(std::memory_order_acquire);
	return v;
}

bool finite_in(float v, float lo, float hi)
{
	return std::isfinite(v) && v >= lo && v <= hi;
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

// The D3D11 device and immediate context behind libobs (graphics thread, inside obs_enter_graphics), or null for
// another renderer. The context is AddRef'd: release it.
ID3D11Device *d3d_device()
{
	return gs_get_device_type() == GS_DEVICE_DIRECT3D_11 ? static_cast<ID3D11Device *>(gs_get_device_obj()) : nullptr;
}

} // namespace

bool validate(const Raw &r, uint32_t frame_w, uint32_t frame_h, Face &out, const char *&why)
{
	why = nullptr;
	if (r.found > 1 || (r.n != 0 && r.n != kLmkMax) || (r.found == 1) != (r.n == kLmkMax)) {
		why = "landmark count";
		return false;
	}
	if (!finite_in(r.infer, 0.0f, kInferMaxMs)) {
		why = "inference time";
		return false;
	}
	if (r.mask_valid > 1 ||
	    (r.mask_valid && (r.mw == 0 || r.mh == 0 || r.mw != frame_w || r.mh != frame_h || r.mw > kFrameMaxW || r.mh > kFrameMaxH))) {
		why = "mask size";
		return false;
	}
	out = Face();
	if (!r.found)
		return true; // a valid "no face" answer: nothing else of it is used
	const Face &f = r.face;
	for (uint32_t i = 0; i < kLmkMax; i++) {
		if (!finite_in(f.pts[i * 3], kCoordMin, kCoordMax) || !finite_in(f.pts[i * 3 + 1], kCoordMin, kCoordMax) ||
		    !finite_in(f.pts[i * 3 + 2], -kZAbsMax, kZAbsMax)) {
			why = "landmark value";
			return false;
		}
	}
	if (!finite_in(f.box[0], kCoordMin, kCoordMax) || !finite_in(f.box[1], kCoordMin, kCoordMax) ||
	    !finite_in(f.box[2], 0.0f, kBoxMaxSize) || !finite_in(f.box[3], 0.0f, kBoxMaxSize) || f.box[2] <= 0 || f.box[3] <= 0) {
		why = "face box";
		return false;
	}
	if (!finite_in(f.roll, -180.0f, 180.0f) || !finite_in(f.yaw, -1.0f, 1.0f) || !finite_in(f.pitch, -1.0f, 1.0f) ||
	    !finite_in(f.blink_r, 0.0f, 1.0f) || !finite_in(f.blink_l, 0.0f, 1.0f) || !finite_in(f.mouth, 0.0f, 1.0f) ||
	    !finite_in(f.brows, 0.0f, 1.0f)) {
		why = "face features";
		return false;
	}
	out = f;
	out.found = true;
	out.n = kLmkMax;
	out.age_ms = 0;
	return true;
}

Link *get()
{
	return g_link.load();
}

void set(Link *l)
{
	g_link.store(l);
}

Link::Link(unsigned long pid, const std::array<uint8_t, kKeyBytes> &key)
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
	std::memcpy(view_ + kKeyOff, key.data(), kKeyBytes);
	MemoryBarrier();
	wr<uint32_t>(view_, 0, kMagic); // last: the worker checks it before anything else
	obs_add_tick_callback(tick_cb, this);
	hlog::info("face link: %s ready (%zu bytes, owner-only, keyed)", name_.c_str(), kTotal);
}

Link::~Link()
{
	if (!view_)
		return;
	obs_remove_tick_callback(tick_cb, this); // no tick of ours runs after this returns
	obs_enter_graphics();
	for (auto &s : stages_) {
		if (s.ss)
			gs_stagesurface_destroy(s.ss);
		if (s.query)
			static_cast<ID3D11Query *>(s.query)->Release();
	}
	if (tr_)
		gs_texrender_destroy(tr_);
	if (mask_tex_)
		gs_texture_destroy(mask_tex_);
	obs_leave_graphics();
	obs_weak_source_release(target_);
	wr<uint32_t>(view_, 0, 0); // a worker that still has it open sees the link gone
	SecureZeroMemory(view_ + kKeyOff, kKeyBytes);
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

// A new target (or none): a new generation, so frames staged and results computed for the old one are never used.
void Link::new_target(obs_source_t *src)
{
	if (++gen_ == 0)
		gen_ = 1;
	for (auto &s : stages_)
		s.pending = false;
	mask_valid_ = false;
	face_ = Face();
	obs_weak_source_release(target_);
	target_ = src ? obs_source_get_weak_source(src) : nullptr;
	target_raw_ = src;
	std::lock_guard<std::mutex> g(sm_);
	target_name_ = src && obs_source_get_name(src) ? obs_source_get_name(src) : "";
	gen_stat_ = gen_;
}

void Link::use(obs_source_t *src, uint32_t want, float smoothing)
{
	if (!view_ || !src)
		return;
	const int64_t now = steady_ms();
	if ((!target_ || now - target_used_ms_ > kTargetIdleMs) && target_raw_ != src)
		new_target(src);
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
	const int64_t age = std::max<int64_t>(0, steady_ms() - mask_mono_);
	weight = age <= kHoldMs ? 1.0f : std::max(0.0f, 1.0f - (float)(age - kHoldMs) / (float)kFadeMs);
	return mask_tex_;
}

bool Link::face(obs_source_t *src, Face &out) const
{
	if (!is_target(src) || !face_.found)
		return false;
	const int64_t age = std::max<int64_t>(0, steady_ms() - face_mono_);
	if (age > kHoldMs)
		return false;
	out = face_;
	out.age_ms = age;
	return true;
}

void Link::on_tick()
{
	const int64_t now = epoch_ms(), mono = steady_ms();
	wr<int64_t>(view_, 64, now);
	// want / smoothing gathered by the filters during the last frame's render
	want_ = want_accum_;
	wr<uint32_t>(view_, 56, want_);
	wr<float>(view_, 60, std::clamp(smooth_accum_, 0.0f, 0.95f));
	want_accum_ = 0;
	smooth_accum_ = 0;
	if (target_ && mono - target_used_ms_ > kTargetIdleMs) // no face effect drew it for a second
		new_target(nullptr);
	// Overflow-safe: no subtraction involves the worker's value (now +/- a constant cannot overflow).
	const int64_t hb = rd<int64_t>(view_, 168);
	const bool alive = hb >= now - kWorkerDeadMs && hb <= now + kClockSkewMs;
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

// Ticks: render + stage into a free surface every kMinIntervalMs (an event query marks the end of the copy); map a
// surface only once its copy is done, so gs_stagesurface_map never waits for the GPU.
void Link::capture(obs_source_t *src)
{
	const int64_t now = epoch_ms(), mono = steady_ms();
	obs_enter_graphics();
	ID3D11Device *dev = d3d_device();
	ID3D11DeviceContext *ctx = nullptr;
	if (dev)
		dev->GetImmediateContext(&ctx);
	for (auto &s : stages_) {
		if (!s.pending)
			continue;
		++s.ticks;
		bool ready;
		if (s.query && ctx)
			ready = ctx->GetData(static_cast<ID3D11Query *>(s.query), nullptr, 0, 0) == S_OK;
		else
			ready = s.ticks >= 2; // no query (another renderer): the old 2-tick delay
		if (!ready) {
			if (s.ticks >= kStageMaxTicks) { // the GPU is far behind: give this frame up
				s.pending = false;
				std::lock_guard<std::mutex> g(sm_);
				map_dropped_++;
			} else {
				std::lock_guard<std::mutex> g(sm_);
				map_not_ready_++;
			}
			continue;
		}
		const auto t0 = std::chrono::steady_clock::now();
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
			wr<uint32_t>(view_, 76, s.gen);
			InterlockedIncrement(lk); // even: done
			sent_[sent_next_] = Sent{frame_seq_, s.gen, s.w, s.h, s.mono};
			sent_next_ = (sent_next_ + 1) % kSentRing;
			const double ms = since_ms(t0);
			std::lock_guard<std::mutex> g(sm_);
			frames_sent_++;
			maps_++;
			map_total_ms_ += ms;
			map_max_ms_ = std::max(map_max_ms_, ms);
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
	if (cx && cy && free_s && mono - last_capture_ms_ >= kMinIntervalMs) {
		const double k = std::min({1.0, (double)kFrameMaxW / cx, (double)kFrameMaxH / cy});
		const uint32_t tw = std::clamp((uint32_t)(cx * k + 0.5), 1u, kFrameMaxW),
			       th = std::clamp((uint32_t)(cy * k + 0.5), 1u, kFrameMaxH);
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
		if (dev && !free_s->query) {
			D3D11_QUERY_DESC qd{D3D11_QUERY_EVENT, 0};
			ID3D11Query *q = nullptr;
			if (SUCCEEDED(dev->CreateQuery(&qd, &q)))
				free_s->query = q;
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
				if (free_s->query && ctx)
					ctx->End(static_cast<ID3D11Query *>(free_s->query)); // signalled once the copy is done
				free_s->pending = true;
				free_s->ticks = 0;
				free_s->ts = now;
				free_s->mono = mono;
				free_s->gen = gen_;
				free_s->src_w = cx;
				free_s->src_h = cy;
				last_capture_ms_ = mono;
			}
		}
	}
	if (ctx)
		ctx->Release();
	obs_leave_graphics();
}

// A new result: seqlock read (acquire), a snapshot taken while the worker writes is skipped (the next tick tries
// again); then provenance (a frame we sent, newer than the last used, current generation) and validation.
void Link::read_result()
{
	volatile LONG *lk = lock_at(view_, 128);
	const LONG s1 = load_acquire(lk);
	if (s1 & 1) {
		std::lock_guard<std::mutex> g(sm_);
		contended_++;
		return;
	}
	const uint64_t rs = rd<uint64_t>(view_, 144);
	if (rs == result_seq_)
		return; // nothing new (an unchanged seq read under an even lock)
	Raw r;
	const uint64_t fseq = rd<uint64_t>(view_, 152);
	const uint64_t mseq = rd<uint64_t>(view_, 248);
	const uint32_t gen = rd<uint32_t>(view_, 244);
	r.mask_valid = rd<uint32_t>(view_, 240);
	r.mw = rd<uint32_t>(view_, 132);
	r.mh = rd<uint32_t>(view_, 136);
	const bool want_mask = (want_ & kWantMask) != 0;
	const bool copy_mask = want_mask && r.mask_valid == 1 && mseq != last_mask_seq_ && r.mw && r.mh &&
			       r.mw <= kFrameMaxW && r.mh <= kFrameMaxH;
	if (copy_mask) {
		mask_buf_.resize((size_t)r.mw * r.mh);
		std::memcpy(mask_buf_.data(), view_ + kMaskOff, mask_buf_.size());
	}
	r.found = rd<uint32_t>(view_, 140);
	r.n = rd<uint32_t>(view_, 180);
	if (r.n == kLmkMax)
		std::memcpy(r.face.pts.data(), view_ + kLmkOff, kLmkBytes);
	for (int i = 0; i < 4; i++)
		r.face.box[i] = rd<float>(view_, 188 + 4 * i);
	r.face.roll = rd<float>(view_, 208);
	r.face.yaw = rd<float>(view_, 212);
	r.face.pitch = rd<float>(view_, 216);
	r.face.blink_r = rd<float>(view_, 220);
	r.face.blink_l = rd<float>(view_, 224);
	r.face.mouth = rd<float>(view_, 228);
	r.face.brows = rd<float>(view_, 232);
	r.infer = rd<float>(view_, 184);
	std::atomic_thread_fence(std::memory_order_acquire);
	if (*lk != s1) { // the worker wrote meanwhile: a torn snapshot, never used
		std::lock_guard<std::mutex> g(sm_);
		torn_++;
		return;
	}
	result_seq_ = rs; // this snapshot is consistent; judge it once
	const Sent *sent = nullptr;
	for (const auto &s : sent_)
		if (s.seq && s.seq == fseq) {
			sent = &s;
			break;
		}
	auto reject = [&](uint64_t &counter, const char *why) {
		std::lock_guard<std::mutex> g(sm_);
		counter++;
		last_reject_ = why;
	};
	if (!sent || fseq <= last_fseq_)
		return reject(rej_unsent_, !sent ? "frame not sent" : "older than the last result");
	if (gen != gen_ || sent->gen != gen_)
		return reject(rej_gen_, "previous target");
	Face f;
	const char *why = nullptr;
	if (!validate(r, sent->w, sent->h, f, why))
		return reject(rej_invalid_, why);
	last_fseq_ = fseq;
	face_ = f;
	face_mono_ = sent->mono;
	bool mask_new = false;
	if (copy_mask) {
		obs_enter_graphics();
		if (mask_tex_ && (mask_w_ != r.mw || mask_h_ != r.mh)) {
			gs_texture_destroy(mask_tex_);
			mask_tex_ = nullptr;
		}
		if (!mask_tex_) {
			mask_tex_ = gs_texture_create(r.mw, r.mh, GS_R8, 1, nullptr, GS_DYNAMIC);
			mask_w_ = r.mw;
			mask_h_ = r.mh;
		}
		if (mask_tex_)
			gs_texture_set_image(mask_tex_, mask_buf_.data(), r.mw, false);
		obs_leave_graphics();
		mask_valid_ = mask_tex_ != nullptr;
		mask_mono_ = sent->mono; // freshness moves only with a new valid mask
		last_mask_seq_ = mseq;
		mask_new = true;
	}
	const double latency = (double)std::max<int64_t>(0, steady_ms() - sent->mono);
	std::lock_guard<std::mutex> g(sm_);
	results_++;
	mask_updates_ += mask_new ? 1 : 0;
	last_infer_ms_ = r.infer;
	last_latency_ms_ = latency;
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
	r.set("generation", (uint64_t)gen_stat_);
	r.set("framesSent", frames_sent_);
	r.set("results", results_);
	r.set("maskUpdates", mask_updates_);
	json::Value rej = json::Value::object();
	rej.set("invalid", rej_invalid_);
	rej.set("unsent", rej_unsent_);
	rej.set("generation", rej_gen_);
	rej.set("torn", torn_);
	rej.set("contended", contended_);
	rej.set("last", last_reject_);
	r.set("rejected", rej);
	json::Value rb = json::Value::object();
	rb.set("maps", maps_);
	rb.set("notReady", map_not_ready_);
	rb.set("dropped", map_dropped_);
	rb.set("maxMs", (double)((int64_t)(map_max_ms_ * 1000 + 0.5)) / 1000.0);
	rb.set("avgMs", maps_ ? (double)((int64_t)(map_total_ms_ / (double)maps_ * 1000 + 0.5)) / 1000.0 : 0.0);
	r.set("readback", rb);
	r.set("inferMs", (double)((int64_t)(last_infer_ms_ * 100 + 0.5)) / 100.0);
	r.set("latencyMs", (double)((int64_t)(last_latency_ms_ * 10 + 0.5)) / 10.0);
	return r;
}

} // namespace face
