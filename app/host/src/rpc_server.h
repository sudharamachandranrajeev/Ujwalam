// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: JSON-RPC 2.0 over HTTP/1.1 on 127.0.0.1 (POST /rpc). Winsock + BCrypt only.
//
// Same rules as the event-core API (services/event-core/api/server.mjs, P3 E6): callers are native local processes,
// never browsers. Check order for a request (cheap, information-free refusals first):
//   Host -> Origin -> Sec-Fetch-* -> path/method -> Bearer token (role) -> Content-Type -> Content-Length/body size
//   -> UTF-8/JSON -> JSON-RPC shape -> method/role -> params (in the handler).
// The body is never read before authentication. One request per connection (Connection: close), so there is no
// keep-alive slot to hold. Unauthenticated connections have their own cap; when it is full the OLDEST pending
// connection is closed, never the new one.
#pragma once

#include "json.h"

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
#include <map>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace rpc {

enum Code {
	PARSE = -32700,
	INVALID_REQUEST = -32600,
	METHOD_NOT_FOUND = -32601,
	INVALID_PARAMS = -32602,
	INTERNAL = -32603,
	FORBIDDEN = -32001,
	UNAVAILABLE = -32004,
	CONFLICT = -32009, // state does not allow the call (e.g. outputs active)
};

struct Error : std::runtime_error {
	int code;
	int http;
	Error(int c, const std::string &m, int h = 200) : std::runtime_error(m), code(c), http(h) {}
};

// Markers: least-privilege role for the event core (F6 live markers; it processes untrusted chat). Its token can call
// only the methods that set Method::markers (marker.add and mixer.list); every other method answers FORBIDDEN.
// Clips: least-privilege role for the live clipper (D226; it reads game frames and saves the replay buffer). Its token
// can call only the methods that set Method::clips (frames.grab, replay.save, replay.status, marker.add with source
// "clip", host.status); every other method answers FORBIDDEN.
enum class Role { Api, System, Markers, Clips };
const char *role_name(Role r);

struct Method {
	bool api = true;
	bool system = true;
	bool markers = false; // opt-in only: a new method is never callable with the markers token
	bool clips = false;   // opt-in only: a new method is never callable with the clips token
	std::function<json::Value(const json::Value &params, Role role)> run;
};

struct Limits {
	int headers_timeout_ms = 2000; // whole header block from accept
	int request_timeout_ms = 5000; // whole request incl. body from accept
	int max_pending = 128;         // connections still being read (unauthenticated or body pending)
	int max_header_bytes = 8192;
	int max_body_bytes = 1 << 20; // 1 MiB: project v1 documents travel in project.load/plan
	int auth_fail_per_window = 20; // failed auth per window (all callers are 127.0.0.1) -> 429; valid tokens still pass
	int auth_window_ms = 60000;
	int workers = 4;
	int queue_max = 32; // authenticated requests waiting for a worker; beyond that 503
	int send_timeout_ms = 2000;
};

class Server {
public:
	// Tokens are 64 lowercase hex characters each and must differ. markers_token / clips_token empty = that role is
	// off (no token authenticates as it).
	Server(Limits limits, const std::string &api_token, const std::string &system_token,
	       std::map<std::string, Method> methods, const std::string &markers_token = std::string(),
	       const std::string &clips_token = std::string());
	~Server();

	bool start(uint16_t port, std::string &err); // binds 127.0.0.1 only; port 0 = random
	uint16_t port() const { return port_; }
	void stop();
	json::Value stats() const;

private:
	struct Conn;
	struct Job;
	void io_loop();
	void worker_loop();
	void handle_headers(Conn &c);
	void finish(Conn &c);
	bool auth(const std::string &header, Role &role) const;
	bool note_auth_failure();
	void respond(uintptr_t sock, int status, const std::string &body, const char *extra_headers = "");
	void refuse(uintptr_t sock, int status, const char *code, const char *extra_headers = "");
	void run_job(Job &j);
	void defer_close(uintptr_t sock);
	std::vector<std::pair<uintptr_t, int64_t>> closing_; // IO thread only

	Limits L_;
	uint8_t api_digest_[32] = {};
	uint8_t sys_digest_[32] = {};
	uint8_t markers_digest_[32] = {};
	bool has_markers_ = false;
	uint8_t clips_digest_[32] = {};
	bool has_clips_ = false;
	std::map<std::string, Method> methods_;
	uintptr_t listen_sock_ = ~(uintptr_t)0;
	uint16_t port_ = 0;
	std::string allowed_host_a_, allowed_host_b_;
	std::atomic<bool> stopping_{false};
	std::thread io_;
	std::vector<std::thread> workers_;
	std::mutex qm_;
	std::condition_variable qcv_;
	std::deque<Job *> queue_;
	// auth failure window
	mutable std::mutex am_;
	int64_t auth_window_start_ = 0;
	int auth_window_n_ = 0;
	// stats
	std::atomic<uint64_t> requests_{0}, rpc_ok_{0}, rpc_errors_{0}, refused_{0}, auth_failures_{0},
		rate_limited_{0}, pending_evicted_{0}, timed_out_{0}, busy_{0};
	std::atomic<int> pending_now_{0};
};

// Constant-time comparison of two 32-byte digests.
bool digest_equal(const uint8_t *a, const uint8_t *b);
bool sha256(const std::string &data, uint8_t out[32]);
// 32 random bytes as 64 lowercase hex (BCryptGenRandom). Empty on failure.
std::string new_token();
bool is_token(const std::string &s);

// Params helper: refuses unknown keys and wrong types with INVALID_PARAMS.
class Params {
public:
	Params(const json::Value &p, std::initializer_list<const char *> allowed);
	bool has(const char *k) const { return p_.find(k) != nullptr; }
	std::string str(const char *k, size_t max_len = 200) const;               // required
	std::string str_or(const char *k, const std::string &def, size_t max_len = 200) const;
	int64_t integer(const char *k, int64_t min, int64_t max) const;           // required
	int64_t int_or(const char *k, int64_t def, int64_t min, int64_t max) const;
	double num(const char *k, double min, double max) const;
	double num_or(const char *k, double def, double min, double max) const;
	bool boolean(const char *k) const;
	bool bool_or(const char *k, bool def) const;
	const json::Value &obj(const char *k) const;                               // required object
	const json::Value *obj_opt(const char *k) const;
	const json::Value &arr(const char *k) const;                               // required array
	const json::Value *arr_opt(const char *k) const;
	const json::Value &raw() const { return p_; }

private:
	const json::Value &p_;
	[[noreturn]] void bad(const char *k) const;
};

} // namespace rpc
