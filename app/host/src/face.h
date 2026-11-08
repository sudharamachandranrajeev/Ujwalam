// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: face link, camera frames to the face AI worker and masks / face points back (D295 proposed,
// docs/plan/2026-11-08-face-ai-design.md). Layout mirror: services/face/face_link.py (keep both at the same version).
//
// Shared memory `Local\ujwalam-face-<host pid>`, created here with an owner-only DACL; if the name already exists
// (another process made it first) the link stays off (fail closed). The worker only opens it.
//
// Graphics thread only (tick callback and the face filters' video_render), except stats():
//   - a face filter calls use(source, want, smoothing) while it renders; the first source used becomes the link's
//     target (one camera at a time) and stays it while it is used at least once a second
//   - each tick: host heartbeat; if a target is set, the worker's heartbeat is < 2 s old and something is wanted, the
//     target source (its shared source at its own size, never the canvas) is drawn into a texture that fits 640 x 360
//     (aspect kept), copied to a staging surface and mapped 2 ticks later (no stall, the frames.grab pattern) into the
//     frame slot, at most 30 per second. Nothing is drawn while no worker is alive.
//   - a new result is copied out of the mapping (seqlock) and the mask uploaded into an R8 texture
// Failure behaviour: results older than kHoldMs (from the frame's render time) fade the mask's weight to 0 over
// kFadeMs, so personMask shows the plain camera; landmarks older than kHoldMs count as "no face" (autoFrame eases back
// to the whole picture, faceSticker hides). A dead or slow worker never blocks a tick.
#pragma once

#include "json.h"

#include <obs.h>

#include <array>
#include <atomic>
#include <cstdint>
#include <mutex>
#include <string>
#include <vector>

namespace face {

constexpr uint32_t kMagic = 0x41464A55; // 'UJFA'
constexpr uint32_t kVersion = 1;
constexpr uint32_t kFrameMaxW = 640, kFrameMaxH = 360;
constexpr size_t kHeader = 4096;
constexpr size_t kFrameOff = kHeader;
constexpr size_t kFrameBytes = (size_t)kFrameMaxW * kFrameMaxH * 4;
constexpr size_t kMaskOff = kFrameOff + kFrameBytes;
constexpr size_t kMaskBytes = (size_t)kFrameMaxW * kFrameMaxH;
constexpr size_t kLmkOff = kMaskOff + kMaskBytes;
constexpr uint32_t kLmkMax = 468;
constexpr size_t kLmkBytes = (size_t)kLmkMax * 3 * 4;
constexpr size_t kTotal = (kLmkOff + kLmkBytes + 4095) / 4096 * 4096;

constexpr uint32_t kWantMask = 1, kWantLandmarks = 2;
constexpr int kMinIntervalMs = 33;     // at most ~30 frames per second to the worker
constexpr int64_t kWorkerDeadMs = 2000; // no worker heartbeat for this long: nothing is captured
constexpr int64_t kHoldMs = 500;        // a result this old is still used as it is
constexpr int64_t kFadeMs = 300;        // then the mask fades out over this
constexpr int64_t kTargetIdleMs = 1000; // a target no filter used for this long is dropped

struct Face {
	bool found = false;
	uint32_t n = 0;                         // landmark count (468)
	std::array<float, kLmkMax * 3> pts{};   // x, y in 0..1 of the source, z in source-width units
	float box[4] = {};                      // x, y, w, h in 0..1
	float roll = 0, yaw = 0, pitch = 0;     // degrees, -1..1, -1..1
	float blink_r = 0, blink_l = 0, mouth = 0, brows = 0;
	int64_t age_ms = 0;                     // now - render time of the analysed frame
};

class Link {
public:
	explicit Link(unsigned long pid); // creates the mapping and registers the tick callback (libobs started)
	~Link();                          // tick callback off, mapping and textures freed
	Link(const Link &) = delete;
	Link &operator=(const Link &) = delete;

	bool ok() const { return view_ != nullptr; }

	// Graphics thread (filter video_render).
	void use(obs_source_t *src, uint32_t want, float smoothing);
	// The mask texture for src (R8, covers the whole source) and its weight 0..1 (1 fresh, fading to 0 when stale), or
	// null when there is none for src.
	gs_texture_t *mask(obs_source_t *src, float &weight) const;
	// Face points for src; false (out untouched) when there is no fresh face for it.
	bool face(obs_source_t *src, Face &out) const;

	json::Value stats() const; // any thread

private:
	static void tick_cb(void *param, float seconds);
	void on_tick();
	void capture(obs_source_t *src);
	void read_result();
	bool is_target(obs_source_t *src) const;

	void *map_ = nullptr; // HANDLE
	uint8_t *view_ = nullptr;
	std::string name_;

	// graphics thread
	obs_weak_source_t *target_ = nullptr;
	obs_source_t *target_raw_ = nullptr; // identity only (compared, never dereferenced)
	int64_t target_used_ms_ = 0;
	uint32_t want_accum_ = 0, want_ = 0;
	float smooth_accum_ = 0;
	uint64_t frame_seq_ = 0, target_first_seq_ = 0;
	int64_t last_capture_ms_ = 0;
	struct Stage {
		gs_stagesurf_t *ss = nullptr;
		uint32_t w = 0, h = 0, src_w = 0, src_h = 0;
		bool pending = false;
		int ticks = 0;
		int64_t ts = 0;
	};
	std::array<Stage, 3> stages_{};
	gs_texrender_t *tr_ = nullptr;
	uint64_t result_seq_ = 0;
	gs_texture_t *mask_tex_ = nullptr;
	uint32_t mask_w_ = 0, mask_h_ = 0;
	bool mask_valid_ = false;
	int64_t result_ts_ = 0; // render time (Unix ms) of the frame the latest result answers
	Face face_;
	std::vector<uint8_t> mask_buf_;

	// stats (any thread)
	mutable std::mutex sm_;
	uint64_t frames_sent_ = 0, results_ = 0;
	double last_infer_ms_ = 0, last_latency_ms_ = 0;
	bool worker_alive_ = false;
	std::string target_name_;
};

// The process-wide link (null when off). Set by main after libobs starts, cleared before the link is destroyed.
Link *get();
void set(Link *l);

} // namespace face
