// SPDX-License-Identifier: GPL-2.0-or-later
// ujwalam-host: supervisor for the overlay server child (app/host/overlay/child.mjs, which runs Agent A's
// services/overlay-server). Started only with --allow-browser and --overlay-root.
//
//   - One child process: node <script> --root <dir> --port <p> --feed-port <f> [--events-url <url>], in a job object
//     that kills it with the host. No window. Only its three pipe handles are inherited.
//   - Environment: an allowlist of system variables only (no host token, no stream key, no profile values). The
//     event-core token (UJWALAM_EVENT_CORE_API_TOKEN, read and removed from the host's own environment at start, so
//     neither CEF nor any other child inherits it) is added only when --overlay-events-url is set.
//   - Restart on exit with backoff min(cap, base*2^(n-1))*(0.5+0.5*rand), base 500 ms, cap 15 s, reset after 30 s up.
//     After the first start the ports are pinned, so browser layer URLs stay valid across restarts.
//   - Control: JSON lines on the child's stdin/stdout (effect, stats). A child crash never stops the host, its
//     outputs or its scenes; effect.fire answers UNAVAILABLE until the child is back.
//   - Port 8093 (the real Streamer.bot) is refused for both servers.
#pragma once

#include "json.h"

#include <condition_variable>
#include <cstdint>
#include <map>
#include <mutex>
#include <string>
#include <thread>

class Overlay {
public:
	struct Config {
		std::string node, script, root, events_url, events_token;
		uint16_t port = 0, feed_port = 0;
	};
	explicit Overlay(Config c);
	~Overlay();
	Overlay(const Overlay &) = delete;
	Overlay &operator=(const Overlay &) = delete;

	void start();
	void stop(int timeout_ms = 3000);
	bool wait_ready(int timeout_ms);
	bool ports(uint16_t &static_port, uint16_t &feed_port) const; // true while the child is running
	json::Value status() const;
	// bridge.publishEffect(name, meta) in the child. Throws rpc::Error (UNAVAILABLE if the child is not running).
	json::Value effect(const std::string &name, const json::Value &meta);
	json::Value stats();

private:
	Config cfg_;
	mutable std::mutex m_;
	std::condition_variable cv_;
	std::thread sup_;
	bool stopping_ = false;
	std::string state_ = "off"; // off | starting | running | backoff | stopped | failed
	uint16_t static_port_ = 0, feed_port_ = 0;
	unsigned long pid_ = 0;
	int restarts_ = 0, failures_ = 0;
	long last_exit_ = -1;
	std::string last_error_;
	json::Value child_env_ = json::Value::array(); // variable NAMES the child reported (never values)
	bool child_token_ = false;                     // the child reported an event-core token
	void *job_ = nullptr, *proc_ = nullptr, *in_w_ = nullptr; // HANDLEs
	int64_t next_id_ = 0;
	std::map<int64_t, json::Value> replies_;
	uint64_t generation_ = 0;
	int stop_timeout_ms_ = 3000;
	std::mutex write_m_; // one writer on the child's stdin at a time

	void run();
	// Starts one child; on success fills the out-pipe read handles (closed by the caller after the readers end).
	bool spawn(void *&out_r, void *&err_r, std::string &err);
	void read_stdout(void *h, uint64_t gen);
	void read_stderr(void *h);
	json::Value call(const std::string &op, const json::Value &extra);
};
