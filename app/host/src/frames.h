// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: frames.grab, one still frame of a layer's source for the live clipper's OCR (D226).
//
// What is grabbed: the layer's SHARED source (the capture card, media, image ...) at its native size, rendered on its
// own, never the composed canvas: no overlay, effect, placement crop or other layer reaches the frame. Optional
// maxWidth downscales (bilinear, aspect kept). SDR: rendered in sRGB (HDR sources are tone-mapped by libobs).
//
// Readback never stalls the render thread: the request is picked up by a libobs tick callback (graphics thread).
// Tick N renders the source into a texrender and queues the GPU copy into a staging surface; tick N+2 (two frames
// later, by then the copy is done) maps the staging surface and copies the rows out. This is the pattern OBS's own
// screenshot uses (frontend/utility/ScreenshotObj.cpp). The file is written by the RPC worker thread, not the
// graphics thread. At most one grab at a time and at most 4 per second (a new grab starts >= 250 ms after the last
// one started); extra calls get UNAVAILABLE (-32004) "busy" / "rate limit" at once, never queued.
//
// File: <dataDir>/live/frame-<layer>.bmp (layer id with every character outside [A-Za-z0-9_-] as "_"), written
// as frame-<layer>.bmp.tmp and renamed over the target (atomic for a reader that opens it after the call returns).
// The caller never names a path. Format: BMP, BITMAPINFOHEADER, 32 bits per pixel, BI_RGB, TOP-DOWN (negative
// height), no palette, pixel data at byte offset 54, rows of width*4 bytes (no padding), byte order B, G, R, A per
// pixel (A = 255 for opaque sources). numpy: np.fromfile(p, np.uint8, offset=54).reshape(h, w, 4).
// Result: { path, width, height, ts, layer, type, sourceWidth, sourceHeight, gfxMs, bytes }. ts = Unix epoch ms
// (UTC, GetSystemTimeAsFileTime) taken on the graphics thread when the frame was rendered; gfxMs = time spent on the
// graphics thread for this grab (render + stage + map/copy).
#pragma once

#include "json.h"

#include <obs.h>

#include <condition_variable>
#include <cstdint>
#include <mutex>
#include <string>
#include <vector>

class Frames {
public:
	static constexpr int kMinIntervalMs = 250;   // at most 4 grabs per second
	static constexpr int kTimeoutMs = 2000;      // no frame from the graphics thread within this -> UNAVAILABLE
	static constexpr uint32_t kMaxSide = 8192;   // larger sources are refused

	explicit Frames(std::string live_dir); // registers the tick callback (libobs must be started)
	~Frames();                             // removes it and frees the GPU objects (before obs_shutdown)
	Frames(const Frames &) = delete;
	Frames &operator=(const Frames &) = delete;

	// src: a strong reference the caller owns and releases after the call (Studio::layer_source_ref). max_width 0 =
	// native. Blocks the calling RPC worker up to kTimeoutMs. Throws rpc::Error.
	json::Value grab(obs_source_t *src, const std::string &layer, const std::string &type, uint32_t max_width);
	json::Value stats() const;

private:
	enum class St { Idle, Render, Wait1, Wait2, Done, Failed };
	static void tick_cb(void *param, float seconds);
	void on_tick();

	std::string dir_;
	mutable std::mutex m_; // all fields below; held by the tick callback while it uses src_
	std::condition_variable cv_;
	St st_ = St::Idle;
	obs_source_t *src_ = nullptr; // borrowed from the waiting grab() (which holds the reference)
	uint32_t cx_ = 0, cy_ = 0, tw_ = 0, th_ = 0;
	gs_texrender_t *tr_ = nullptr;
	gs_stagesurf_t *ss_ = nullptr;
	uint32_t ssw_ = 0, ssh_ = 0;
	std::vector<uint8_t> px_;
	int64_t ts_ = 0;
	double gfx_ms_ = 0;
	bool busy_ = false;
	int64_t last_start_ = 0; // steady ms
	uint64_t grabs_ = 0, refused_ = 0, failed_ = 0;
};
