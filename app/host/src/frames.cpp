// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: frames.grab. See frames.h.
#include "frames.h"

#include "discovery.h"
#include "log.h"
#include "rpc_server.h"

#include <graphics/vec4.h>

#include <windows.h>

#include <chrono>
#include <cstring>
#include <filesystem>

namespace fs = std::filesystem;
using rpc::Error;

namespace {

int64_t steady_ms()
{
	return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch())
		.count();
}

int64_t epoch_ms()
{
	FILETIME ft;
	GetSystemTimeAsFileTime(&ft);
	ULARGE_INTEGER u;
	u.LowPart = ft.dwLowDateTime;
	u.HighPart = ft.dwHighDateTime;
	return (int64_t)((u.QuadPart - 116444736000000000ULL) / 10000ULL);
}

void put16(uint8_t *p, uint16_t v)
{
	p[0] = (uint8_t)v;
	p[1] = (uint8_t)(v >> 8);
}

void put32(uint8_t *p, uint32_t v)
{
	for (int i = 0; i < 4; i++)
		p[i] = (uint8_t)(v >> (8 * i));
}

// 54-byte header: BITMAPFILEHEADER + BITMAPINFOHEADER, 32 bpp, BI_RGB, top-down (negative height).
void bmp_header(uint8_t h[54], uint32_t w, uint32_t ht)
{
	memset(h, 0, 54);
	uint32_t data = w * ht * 4;
	h[0] = 'B';
	h[1] = 'M';
	put32(h + 2, 54 + data);
	put32(h + 10, 54);
	put32(h + 14, 40);
	put32(h + 18, w);
	put32(h + 22, (uint32_t)(-(int32_t)ht));
	put16(h + 26, 1);
	put16(h + 28, 32);
	put32(h + 30, 0); // BI_RGB
	put32(h + 34, data);
	put32(h + 38, 2835); // 72 dpi
	put32(h + 42, 2835);
}

std::string safe_name(const std::string &id)
{
	std::string s;
	for (char c : id)
		s.push_back((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-' ? c
															 : '_');
	return s.empty() ? "_" : s;
}

} // namespace

Frames::Frames(std::string live_dir) : dir_(std::move(live_dir))
{
	obs_add_tick_callback(tick_cb, this);
}

Frames::~Frames()
{
	// After obs_remove_tick_callback returns no tick of ours runs (libobs calls tick callbacks under the same mutex).
	obs_remove_tick_callback(tick_cb, this);
	obs_enter_graphics();
	if (ss_)
		gs_stagesurface_destroy(ss_);
	if (tr_)
		gs_texrender_destroy(tr_);
	obs_leave_graphics();
}

void Frames::tick_cb(void *param, float)
{
	static_cast<Frames *>(param)->on_tick();
}

// Graphics thread, once per video frame. Cheap when idle (one uncontended lock).
void Frames::on_tick()
{
	std::lock_guard<std::mutex> l(m_);
	if (st_ == St::Idle || st_ == St::Done || st_ == St::Failed)
		return;
	auto t0 = std::chrono::steady_clock::now();
	if (st_ == St::Render) {
		ts_ = epoch_ms();
		bool ok = false;
		obs_enter_graphics();
		if (!tr_)
			tr_ = gs_texrender_create(GS_BGRA, GS_ZS_NONE);
		if (ss_ && (ssw_ != tw_ || ssh_ != th_)) {
			gs_stagesurface_destroy(ss_);
			ss_ = nullptr;
		}
		if (!ss_) {
			ss_ = gs_stagesurface_create(tw_, th_, GS_BGRA);
			ssw_ = ss_ ? tw_ : 0;
			ssh_ = ss_ ? th_ : 0;
		}
		if (tr_ && ss_) {
			gs_texrender_reset(tr_);
			if (gs_texrender_begin_with_color_space(tr_, tw_, th_, GS_CS_SRGB)) {
				vec4 zero;
				vec4_zero(&zero);
				gs_clear(GS_CLEAR_COLOR, &zero, 0.0f, 0);
				gs_ortho(0.0f, (float)cx_, 0.0f, (float)cy_, -100.0f, 100.0f); // source space -> target size
				gs_blend_state_push();
				gs_blend_function(GS_BLEND_ONE, GS_BLEND_ZERO);
				obs_source_video_render(src_);
				gs_blend_state_pop();
				gs_texrender_end(tr_);
				gs_stage_texture(ss_, gs_texrender_get_texture(tr_)); // queued GPU copy; mapped two ticks later
				ok = true;
			}
		}
		obs_leave_graphics();
		st_ = ok ? St::Wait1 : St::Failed;
	} else if (st_ == St::Wait1) {
		st_ = St::Wait2;
		return; // nothing done on this tick: no cost counted
	} else if (st_ == St::Wait2) {
		bool ok = false;
		obs_enter_graphics();
		uint8_t *data = nullptr;
		uint32_t ls = 0;
		if (gs_stagesurface_map(ss_, &data, &ls)) {
			const size_t row = (size_t)tw_ * 4;
			px_.resize(row * th_);
			for (uint32_t y = 0; y < th_; y++)
				memcpy(px_.data() + row * y, data + (size_t)ls * y, row);
			gs_stagesurface_unmap(ss_);
			ok = true;
		}
		obs_leave_graphics();
		st_ = ok ? St::Done : St::Failed;
	}
	gfx_ms_ += std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
	if (st_ == St::Done || st_ == St::Failed)
		cv_.notify_all();
}

json::Value Frames::grab(obs_source_t *src, const std::string &layer, const std::string &type, uint32_t max_width)
{
	uint32_t cx = obs_source_get_width(src), cy = obs_source_get_height(src);
	if (!cx || !cy)
		throw Error(rpc::UNAVAILABLE, "the layer's source has no video yet (0x0)");
	if (cx > kMaxSide || cy > kMaxSide)
		throw Error(rpc::INVALID_PARAMS, "the layer's source is larger than 8192 px");
	uint32_t tw = cx, th = cy;
	if (max_width && cx > max_width) {
		tw = max_width;
		th = (uint32_t)(((uint64_t)cy * max_width + cx / 2) / cx);
		if (!th)
			th = 1;
	}
	std::vector<uint8_t> px;
	int64_t ts = 0;
	double gfx = 0;
	{
		std::unique_lock<std::mutex> l(m_);
		if (busy_) {
			refused_++;
			throw Error(rpc::UNAVAILABLE, "frames.grab busy: one grab at a time");
		}
		int64_t now = steady_ms();
		if (last_start_ && now - last_start_ < kMinIntervalMs) {
			refused_++;
			throw Error(rpc::UNAVAILABLE, "frames.grab rate limit: at most 4 per second (retry in " +
							      std::to_string(kMinIntervalMs - (now - last_start_)) + " ms)");
		}
		last_start_ = now;
		busy_ = true;
		src_ = src;
		cx_ = cx;
		cy_ = cy;
		tw_ = tw;
		th_ = th;
		gfx_ms_ = 0;
		st_ = St::Render;
		bool done = cv_.wait_for(l, std::chrono::milliseconds(kTimeoutMs),
					 [&] { return st_ == St::Done || st_ == St::Failed; });
		St st = st_;
		st_ = St::Idle; // the tick callback no longer touches src_ after this (it runs under m_)
		src_ = nullptr;
		busy_ = false;
		if (!done || st != St::Done) {
			failed_++;
			throw Error(rpc::UNAVAILABLE, done ? "the frame could not be rendered or read back"
							   : "no frame from the graphics thread within 2000 ms");
		}
		px.swap(px_);
		ts = ts_;
		gfx = gfx_ms_;
		grabs_++;
	}

	// File (this RPC worker thread, never the graphics thread).
	std::string err;
	if (!discovery::ensure_dir(dir_, err))
		throw Error(rpc::INTERNAL, "live frames dir: " + err);
	fs::path dst = fs::u8path(dir_) / fs::u8path("frame-" + safe_name(layer) + ".bmp");
	fs::path tmp = dst;
	tmp += ".tmp";
	uint8_t hdr[54];
	bmp_header(hdr, tw, th);
	HANDLE f = CreateFileW(tmp.wstring().c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
	if (f == INVALID_HANDLE_VALUE)
		throw Error(rpc::INTERNAL, "cannot create the frame file");
	DWORD n1 = 0, n2 = 0;
	bool ok = WriteFile(f, hdr, 54, &n1, nullptr) && n1 == 54 &&
		  WriteFile(f, px.data(), (DWORD)px.size(), &n2, nullptr) && n2 == (DWORD)px.size();
	CloseHandle(f);
	if (!ok) {
		DeleteFileW(tmp.wstring().c_str());
		throw Error(rpc::INTERNAL, "frame file write failed");
	}
	// A reader that still holds the previous frame open (without FILE_SHARE_DELETE) blocks the rename for a moment.
	bool moved = false;
	for (int i = 0; i < 20 && !moved; i++) {
		moved = MoveFileExW(tmp.wstring().c_str(), dst.wstring().c_str(), MOVEFILE_REPLACE_EXISTING) != 0;
		if (!moved)
			Sleep(5);
	}
	if (!moved) {
		DeleteFileW(tmp.wstring().c_str());
		throw Error(rpc::UNAVAILABLE, "frame file busy: the reader holds the previous frame open");
	}
	json::Value r = json::Value::object();
	r.set("path", dst.generic_u8string());
	r.set("width", tw);
	r.set("height", th);
	r.set("ts", ts);
	r.set("layer", layer);
	r.set("type", type);
	r.set("sourceWidth", cx);
	r.set("sourceHeight", cy);
	r.set("gfxMs", (double)((int64_t)(gfx * 100 + 0.5)) / 100.0);
	r.set("bytes", (uint64_t)(54 + px.size()));
	return r;
}

json::Value Frames::stats() const
{
	std::lock_guard<std::mutex> l(m_);
	json::Value r = json::Value::object();
	r.set("grabs", grabs_);
	r.set("refused", refused_);
	r.set("failed", failed_);
	r.set("dir", dir_);
	return r;
}
