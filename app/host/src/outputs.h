// SPDX-License-Identifier: GPL-2.0-or-later
// ujwalam-host: output graph (docs/plan/2026-10-26-output-graph.md, O1).
//
//   compositor (canvases H, V) -> encoder pool (rungs; audio encoded once) -> delivery pool (sinks bound to rungs)
//
// Sinks never own encoders: every sink is a libobs output bound to a shared rung encoder and the one shared AAC
// encoder. The graph arrives already resolved and validated against data/platforms/*.json by the caller
// (app/host/lib/outputs-plan.mjs uses services/outputs/validate.mjs); the host holds no platform limits.
//
// Delivery targets are LOOPBACK ONLY in this build: the host builds every URL itself from a port number, always
// 127.0.0.1 (rtmp://127.0.0.1:<port>/<app>/<stream>, srt://127.0.0.1:<port>?mode=caller), and file sinks write
// only inside the recordings dir. There is no field that takes a remote URL or a stream key.
//
// Per sink: libobs keeps a per-output packet buffer; the drop policy is explicit (rtmp drop_threshold_ms /
// pframe_drop_threshold_ms). Reconnect is owned by the host supervisor (libobs reconnect is off): exponential
// backoff with jitter, for both connect failures and disconnects, and one sink's failure never stops another.
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
	Outputs(Studio &studio, std::string recordings_dir);
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

	static void register_loopback_service(); // call once after module load

	struct Sink; // internal

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
