// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: face link, camera frames to the face AI worker and masks / face points back (D295 proposed,
// docs/plan/2026-11-08-face-ai-design.md). Layout mirror: services/face/face_link.py (keep both at the same version).
//
// Shared memory `Local\ujwalam-face-<host pid>`, created here with an owner-only DACL; if the name already exists
// (another process made it first) the link stays off (fail closed). The worker only opens it, and only when the link
// key in the header matches the one the launcher gave it (the host gets the same key by environment,
// UJWALAM_FACE_LINK_KEY, read and removed in main.cpp) and the mapping's owner is its own user.
//
// Graphics thread only (tick callback and the face filters' video_render), except stats():
//   - a face filter calls use(source, want, smoothing) while it renders; the first source used becomes the link's
//     target (one camera at a time) and stays it while it is used at least once a second. Every new target gets a
//     new target generation; it goes out with each frame and the worker echoes it (and resets its temporal state)
//   - each tick: host heartbeat; if a target is set, the worker's heartbeat is fresh and something is wanted, the
//     target source (its shared source at its own size, never the canvas) is drawn into a texture that fits 640 x 360
//     (aspect kept) and copied to one of kStages staging surfaces with a D3D11 event query behind the copy. A surface is
//     mapped only once its query says the copy is done (so the map never waits for the GPU); one still busy after
//     kStageMaxTicks ticks is dropped; with every surface busy no new frame is staged. At most 30 frames per second
//   - each published frame is remembered in a small ring (seq, generation, host capture time, size). A result is used
//     only when it answers a frame in that ring, newer than the last one used, of the current generation, and passes
//     validation (exact landmark count, finite and bounded numbers, mask size = that frame's size). Freshness is the
//     host's own capture time of that frame (steady clock), never a time the worker wrote
//   - the result seqlock is read with acquire loads; a snapshot taken while the worker writes is skipped, never
//     waited for
// Failure behaviour: a mask older than kHoldMs (from the frame's capture) fades its weight to 0 over kFadeMs, so
// personMask shows the plain camera; landmarks older than kHoldMs count as "no face" (autoFrame eases back to the
// whole picture, faceSticker hides). A dead, slow or misbehaving worker never blocks a tick.
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
constexpr uint32_t kVersion = 2;
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
constexpr size_t kKeyOff = 80, kKeyBytes = 32;

constexpr uint32_t kWantMask = 1, kWantLandmarks = 2;
constexpr int kMinIntervalMs = 33;     // at most ~30 frames per second to the worker
constexpr int64_t kWorkerDeadMs = 2000; // no worker heartbeat for this long: nothing is captured
constexpr int64_t kClockSkewMs = 1000;  // a heartbeat further in the future than this is not a live worker
constexpr int64_t kHoldMs = 500;        // a result this old is still used as it is
constexpr int64_t kFadeMs = 300;        // then the mask fades out over this
constexpr int64_t kTargetIdleMs = 1000; // a target no filter used for this long is dropped
constexpr size_t kStages = 4;           // staging surfaces (readback ring)
constexpr int kStageMaxTicks = 30;      // a copy still not done after this many ticks is dropped
constexpr size_t kSentRing = 32;        // published frames a result may answer (~1 s at 30 per second)

struct Face {
	bool found = false;
	uint32_t n = 0;                         // landmark count (468)
	std::array<float, kLmkMax * 3> pts{};   // x, y in 0..1 of the source, z in source-width units
	float box[4] = {};                      // x, y, w, h in 0..1
	float roll = 0, yaw = 0, pitch = 0;     // degrees, -1..1, -1..1
	float blink_r = 0, blink_l = 0, mouth = 0, brows = 0;
	int64_t age_ms = 0;                     // now - capture time of the analysed frame
};

// Bounds every result must keep (validate()). Landmarks and box may reach a little past the frame (a face at the
// edge); anything else is a broken or hostile worker.
constexpr float kCoordMin = -0.5f, kCoordMax = 1.5f, kZAbsMax = 4.0f, kBoxMaxSize = 2.0f, kInferMaxMs = 60000.0f;

// The result fields as copied out of the mapping (before any check).
struct Raw {
	uint32_t found = 0, n = 0;
	Face face;
	float infer = 0;
	uint32_t mask_valid = 0, mw = 0, mh = 0;
};

// Pure check of a copied result; on success `out` holds the face (pts zeroed when there is none). why: a short reason
// for the stats when it fails.
bool validate(const Raw &r, uint32_t frame_w, uint32_t frame_h, Face &out, const char *&why);

class Link {
public:
	// Creates the mapping (writing the 32-byte link key into its header) and registers the tick callback (libobs
	// started).
	Link(unsigned long pid, const std::array<uint8_t, kKeyBytes> &key);
	~Link(); // tick callback off, mapping, staging surfaces, queries and textures freed
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
	void new_target(obs_source_t *src);

	void *map_ = nullptr; // HANDLE
	uint8_t *view_ = nullptr;
	std::string name_;

	// graphics thread
	obs_weak_source_t *target_ = nullptr;
	obs_source_t *target_raw_ = nullptr; // identity only (compared, never dereferenced; only while target_ is not expired)
	int64_t target_used_ms_ = 0;
	uint32_t want_accum_ = 0, want_ = 0;
	float smooth_accum_ = 0;
	uint32_t gen_ = 1; // target generation (0 is never used, so a zeroed result never matches)
	uint64_t frame_seq_ = 0;
	int64_t last_capture_ms_ = 0;
	struct Stage {
		gs_stagesurf_t *ss = nullptr;
		void *query = nullptr; // ID3D11Query (event) issued right after the copy; null: map after 2 ticks
		uint32_t w = 0, h = 0, src_w = 0, src_h = 0, gen = 0;
		bool pending = false;
		int ticks = 0;
		int64_t ts = 0, mono = 0; // Unix ms (for the worker) and steady ms (host freshness) at capture
	};
	std::array<Stage, kStages> stages_{};
	gs_texrender_t *tr_ = nullptr;
	struct Sent {
		uint64_t seq = 0;
		uint32_t gen = 0, w = 0, h = 0;
		int64_t mono = 0;
	};
	std::array<Sent, kSentRing> sent_{};
	size_t sent_next_ = 0;
	uint64_t result_seq_ = 0, last_fseq_ = 0, last_mask_seq_ = 0;
	gs_texture_t *mask_tex_ = nullptr;
	uint32_t mask_w_ = 0, mask_h_ = 0;
	bool mask_valid_ = false;
	int64_t mask_mono_ = 0, face_mono_ = 0; // host capture time (steady ms) of the frames the mask / face answer
	Face face_;
	std::vector<uint8_t> mask_buf_;

	// stats (any thread)
	mutable std::mutex sm_;
	uint64_t frames_sent_ = 0, results_ = 0, mask_updates_ = 0;
	uint64_t rej_invalid_ = 0, rej_unsent_ = 0, rej_gen_ = 0, torn_ = 0, contended_ = 0;
	uint64_t map_not_ready_ = 0, map_dropped_ = 0, maps_ = 0;
	double map_max_ms_ = 0, map_total_ms_ = 0;
	double last_infer_ms_ = 0, last_latency_ms_ = 0;
	std::string last_reject_;
	bool worker_alive_ = false;
	std::string target_name_;
	uint32_t gen_stat_ = 1;
};

// The process-wide link (null when off). Set by main after libobs starts, cleared before the link is destroyed.
Link *get();
void set(Link *l);

} // namespace face
