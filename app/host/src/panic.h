// SPDX-License-Identifier: GPL-2.0-or-later
// ujwalam-host: panic (A0 day 2), following the call contract in services/event-core/api/panic.mjs:
//
//   1. In-process first, no IPC: the host hides every visible browser layer (overlays and effect pages) on every
//      scene of both canvases and refuses effect.fire until panic is cleared. Outputs (stream, recording, replay)
//      and audio are NOT touched: panic stops what chat and rules put on screen; it never takes the stream down or
//      mutes the streamer. This step never waits on event-core.
//   2. Then event-core is told, on a separate sender thread, so chat- and rule-driven actions stop too:
//      actions.panic over the system pipe named in event-core's system.json (path from the host config), with the
//      event-core system token (UJWALAM_EVENT_CORE_SYSTEM_TOKEN, read and removed from the environment at start):
//      one line {"auth":"<token>"}, then {"jsonrpc":"2.0","id":n,"method":"actions.panic","params":{"reason":r}}.
//      At most 5 tries, 50 / 100 / 200 / 400 ms apart, retried only when the pipe is not there or busy (the
//      ECONNREFUSED equivalent) or breaks before the answer (ECONNRESET). Success = result.ok === true; the host
//      keeps its own panic state whatever event-core answers.
//   3. The pipe client checks, before it sends the token, that the pipe's server process is the pid in system.json,
//      and connects with SECURITY_IDENTIFICATION (the server cannot impersonate the host).
//   Clearing: panic.clear restores the layers panic hid and allows effect.fire again. It does not clear event-core's
//   panic (that stays a confirmed action there: actions.request panic.clear). The UI gates panic.clear.
#pragma once

#include "json.h"
#include "studio.h"

#include <condition_variable>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

class Panic {
public:
	struct Config {
		std::string system_file; // event-core <dataDir>/system.json; empty = event-core not told
		std::string token;       // event-core system token (64 hex); wiped on destruction
	};
	Panic(Studio &studio, Config c);
	~Panic();
	Panic(const Panic &) = delete;
	Panic &operator=(const Panic &) = delete;

	json::Value engage(const std::string &source); // source: hotkey | rpc | ... (also the reason sent to event-core)
	json::Value clear();
	json::Value status() const;
	bool engaged() const;
	void stop(); // ends the sender thread (after an in-flight send)

	// One panic notification to event-core with the contract's retries. Public for the result shape only.
	json::Value notify_core(const std::string &reason);

private:
	Studio &studio_;
	Config cfg_;
	mutable std::mutex m_;
	std::condition_variable cv_;
	std::thread sender_;
	bool stop_ = false, pending_ = false;
	std::string pending_reason_;
	bool engaged_ = false;
	std::string since_, last_source_;
	int count_ = 0;
	std::vector<Studio::LayerRef> hidden_;
	json::Value core_;           // last notify result
	std::string core_state_ = "idle"; // idle | sending | done
	void run();
};
