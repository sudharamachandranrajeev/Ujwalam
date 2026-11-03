// SPDX-License-Identifier: GPL-2.0-or-later
// ujwalam-host: output graph (docs/plan/2026-10-26-output-graph.md, O1).
//
//   compositor (canvases H, V) -> encoder pool (rungs; audio encoded once) -> delivery pool (sinks bound to rungs)
//
// Sinks never own encoders: every sink is a libobs output bound to a shared rung encoder and the one shared AAC
// encoder. The graph arrives already resolved and validated against data/platforms/*.json by the caller
// (app/host/lib/outputs-plan.mjs uses services/outputs/validate.mjs); the host holds no platform limits.
//
// Delivery targets:
//   loopback (default): the host builds every URL itself from a port number, always 127.0.0.1
//     (rtmp://127.0.0.1:<port>/<app>/<stream | key from keyRef>, srt://127.0.0.1:<port>?mode=caller).
//   real (A0): { transport: rtmp|rtmps, url | urlRef, keyRef }. Refused (rpc FORBIDDEN) unless the host was started
//     with --allow-live. The url comes from data/platforms ingest data via the plan; urlRef/keyRef name Windows
//     Credential Manager targets (^Ujwalam/stream/[a-z0-9-]{1,32}$) the host reads in-process (stream_keys.h).
//     No field ever takes a stream key; outputs.status shows keyRef and keyPresent only.
//   file: only inside the recordings dir; .mkv unless the target sets unsafeContainer: true (crash safety).
//
// Per sink: libobs keeps a per-output packet buffer; the drop policy is explicit (rtmp drop_threshold_ms /
// pframe_drop_threshold_ms). Reconnect is owned by the host supervisor (libobs reconnect is off): exponential
// backoff with jitter, for both connect failures and disconnects, and one sink's failure never stops another.
//
// Replay buffer (A0 day 2, replay.cpp): one libobs replay_buffer output per canvas (H, V), memory only until saved.
// It binds to an existing rung of that canvas like a sink (no extra encoder; the largest created rung, then the
// highest bitrate) and to the shared AAC encoder. When a canvas has no created rung (outputs not configured, or no
// rung on that canvas) the replay gets its own record-less fallback rung: one NVENC (x264 if NVENC is missing) H.264
// CBR encoder at the canvas size, plus one fallback AAC shared by the fallback replays. Every graph change
// (configure, clear, project load) detaches the replays first and re-attaches them after, so a replay always
// follows the current graph; the memory buffer restarts empty then. Saves write .mkv (crash-safe container).
#pragma once

#include "json.h"

#include <obs.h>

#include <atomic>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

class Studio;

class Outputs {
public:
	Outputs(Studio &studio, std::string recordings_dir, bool allow_live = false);
	~Outputs();

	json::Value configure(const json::Value &params); // refused while any sink is active
	json::Value clear();                              // releases the graph; refused while active
	// Encoders bind to a canvas video_t on creation; a project load recreates canvases. Call release_for_reload()
	// before Studio::load and reconfigure() after it: the graph is rebuilt from the last configure params.
	bool release_for_reload(); // false if active (caller refuses the load)
	json::Value reconfigure(); // null if nothing was configured; throws rpc::Error on failure
	json::Value start(const std::vector<std::string> &sinks, const std::string &kind); // kind: "", "stream", "record"
	json::Value stop(const std::vector<std::string> &sinks, const std::string &kind);
	json::Value status() const;
	json::Value probe_sessions(const std::string &codec, int max);
	void stop_all(int wait_ms);

	bool any_active() const;
	bool idle_soon(int wait_ms) const; // true once nothing is active (waits only if nothing is meant to run)
	bool configured() const;
	bool live() const;      // any network sink starting/live/retrying
	bool recording() const; // any file sink live
	void totals(uint64_t &frames, uint64_t &dropped) const;

	// Clocks for markers: ms since the first stream sink went live in the current streaming period (any stream sink
	// wanted or running), and since the current recording started; -1 when not streaming / not recording.
	void clocks(int64_t &stream_ms, int64_t &record_ms) const;

	// ---- replay buffer (replay.cpp)
	struct ReplayConfig {
		int seconds = 30;                // 5..600
		uint32_t fallback_kbps_h = 12000; // fallback rung bitrate per canvas (local memory clip, not a platform limit)
		uint32_t fallback_kbps_v = 8000;
	};
	void set_replay_config(const ReplayConfig &c); // before replay_start; seconds can also come with replay_start
	json::Value replay_start(int seconds);          // 0 = keep the configured length
	json::Value replay_stop();
	void replay_resume(); // re-attaches after a failed project load (no-op unless wanted)
	json::Value replay_status() const;
	bool replay_running(const std::string &canvas) const;
	// Saves the buffered seconds of each running replay (canvas "" = every running one) into dir as
	// <name_fmt>.mkv (libobs os_generate_formatted_filename specifiers allowed; {canvas} is replaced by H or V).
	// Waits up to timeout_ms per save for libobs's "saved" signal. Never holds the graph lock while waiting.
	// {saved: [{canvas, path, bytes, rung, fallback}], errors: [{canvas, error}]}
	json::Value replay_save(const std::string &canvas, const std::string &dir, const std::string &name_fmt,
				int timeout_ms);
	std::string replay_dir() const;

	static void register_loopback_service(); // call once after module load (registers ujwalam_loopback + ujwalam_live)
	static bool valid_live_url(const std::string &url, const std::string &transport);
	bool allow_live() const { return allow_live_; }

	struct Sink;   // internal
	struct Replay; // internal (replay.cpp)

private:
	struct Rung {
		std::string id, canvas, codec, encoder_id, rc;
		uint32_t w = 0, h = 0, fps = 0, bitrate = 0;
		double gop = 2;
		obs_encoder_t *enc = nullptr;
		std::vector<std::string> sinks;
	};

	struct Policy {
		int drop_threshold_ms = 700;        // rtmp_output: drop B-frames past this buffer duration
		int pframe_drop_threshold_ms = 900; // rtmp_output: drop P-frames past this buffer duration
		int retry_base_ms = 1000;
		int retry_cap_ms = 30000;
		int retry_max = 0;           // consecutive failed attempts before "failed"; 0 = keep retrying
		int retry_reset_live_ms = 30000; // a sink live this long resets its backoff
	};

	Studio &studio_;
	std::string rec_dir_;
	bool allow_live_ = false; // --allow-live: real targets may be configured and started
	Policy policy_;
	std::mutex op_m_;  // serialises libobs output start/stop/configure; never taken in signal handlers
	mutable std::mutex m_; // sink state; taken in signal handlers; never held across obs_output_start/stop/release
	std::vector<std::unique_ptr<Rung>> rungs_;
	std::vector<std::unique_ptr<Sink>> sinks_;
	obs_encoder_t *aac_ = nullptr;
	uint32_t audio_kbps_ = 0;
	json::Value last_probe_;
	json::Value config_;    // last accepted configure params (for reconfigure after a project load)
	std::string configured_at_;
	std::thread sup_;
	std::atomic<bool> sup_stop_{false};
	std::condition_variable sup_cv_;
	int64_t stream_since_ms_ = 0, record_since_ms_ = 0; // guarded by m_ (clocks())

	// replay buffer. op_m_ held for attach/detach; rp_m_ guards replays_ for status and save lookups.
	mutable std::mutex rp_m_;
	std::vector<std::shared_ptr<Replay>> replays_;
	std::atomic<bool> replay_want_{false};
	ReplayConfig rcfg_;
	obs_encoder_t *replay_aac_ = nullptr; // fallback AAC, only while a fallback replay needs it
	void replay_attach_locked();          // op_m_ held: one replay per existing canvas, if wanted
	void replay_detach_locked();          // op_m_ held: stops and releases every replay (and fallback encoders)

	void update_clocks_locked(int64_t now); // m_ held
	void supervise();
	void release_graph(); // op_m_ held, nothing active
	json::Value build(const json::Value &params); // op_m_ held
	Sink *find(const std::string &id);
	void start_sink(Sink &s);
	void schedule_retry_locked(Sink &s, int64_t now);
	json::Value probe_locked(const std::string &codec, int max);
	json::Value sink_json(const Sink &s) const;
	std::vector<Sink *> select(const std::vector<std::string> &ids, const std::string &kind);
	void on_start(Sink &s);
	void on_stop(Sink &s, int code, const char *err);
	friend void on_sink_start(void *, calldata_t *);
	friend void on_sink_stop(void *, calldata_t *);
};
