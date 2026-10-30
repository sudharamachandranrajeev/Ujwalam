// SPDX-License-Identifier: GPL-2.0-or-later
// ujwalam-host: JSON-RPC over HTTP on 127.0.0.1. See rpc_server.h for the rules and check order.
#include "rpc_server.h"
#include "log.h"

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <bcrypt.h>

#include <algorithm>
#include <chrono>
#include <cstring>
#include <regex>

namespace rpc {

namespace {

int64_t now_ms()
{
	return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch())
		.count();
}

std::string lower(std::string s)
{
	for (auto &c : s)
		c = (char)tolower((unsigned char)c);
	return s;
}

std::string trim(const std::string &s)
{
	size_t a = 0, b = s.size();
	while (a < b && (s[a] == ' ' || s[a] == '\t'))
		a++;
	while (b > a && (s[b - 1] == ' ' || s[b - 1] == '\t'))
		b--;
	return s.substr(a, b - a);
}

bool is_tchar(char c)
{
	return isalnum((unsigned char)c) || strchr("!#$%&'*+-.^_`|~", c) != nullptr;
}

const char *reason(int status)
{
	switch (status) {
	case 200: return "OK";
	case 400: return "Bad Request";
	case 401: return "Unauthorized";
	case 403: return "Forbidden";
	case 404: return "Not Found";
	case 405: return "Method Not Allowed";
	case 408: return "Request Timeout";
	case 409: return "Conflict";
	case 411: return "Length Required";
	case 413: return "Payload Too Large";
	case 415: return "Unsupported Media Type";
	case 429: return "Too Many Requests";
	case 431: return "Request Header Fields Too Large";
	case 500: return "Internal Server Error";
	case 503: return "Service Unavailable";
	default: return "Error";
	}
}

void close_graceful(SOCKET s)
{
	shutdown(s, SD_SEND);
	// Drain briefly so the peer reads the response instead of an RST (unread request bytes).
	u_long nb = 1;
	ioctlsocket(s, FIONBIO, &nb);
	char tmp[4096];
	int64_t until = now_ms() + 200;
	while (now_ms() < until) {
		int r = recv(s, tmp, sizeof(tmp), 0);
		if (r == 0)
			break;
		if (r < 0) {
			if (WSAGetLastError() == WSAEWOULDBLOCK) {
				Sleep(5);
				continue;
			}
			break;
		}
	}
	closesocket(s);
}

const std::regex &bearer_re()
{
	static const std::regex re("^Bearer ([A-Za-z0-9._~+/=-]{1,256})$");
	return re;
}

} // namespace

const char *role_name(Role r)
{
	return r == Role::System ? "system" : "api";
}

bool sha256(const std::string &data, uint8_t out[32])
{
	NTSTATUS st = BCryptHash(BCRYPT_SHA256_ALG_HANDLE, nullptr, 0, (PUCHAR)data.data(), (ULONG)data.size(), out, 32);
	return BCRYPT_SUCCESS(st);
}

bool digest_equal(const uint8_t *a, const uint8_t *b)
{
	volatile uint8_t d = 0;
	for (int i = 0; i < 32; i++)
		d |= (uint8_t)(a[i] ^ b[i]);
	return d == 0;
}

std::string new_token()
{
	uint8_t b[32];
	if (!BCRYPT_SUCCESS(BCryptGenRandom(nullptr, b, sizeof(b), BCRYPT_USE_SYSTEM_PREFERRED_RNG)))
		return "";
	static const char *hex = "0123456789abcdef";
	std::string s;
	for (uint8_t x : b) {
		s.push_back(hex[x >> 4]);
		s.push_back(hex[x & 15]);
	}
	SecureZeroMemory(b, sizeof(b));
	return s;
}

bool is_token(const std::string &s)
{
	if (s.size() != 64)
		return false;
	for (char c : s)
		if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')))
			return false;
	return true;
}

// ---------------------------------------------------------------------------------------------------------------
struct Server::Conn {
	SOCKET s = INVALID_SOCKET;
	int64_t accepted = 0;
	std::string buf;
	bool headers_done = false;
	size_t body_start = 0;
	size_t content_length = 0;
	Role role = Role::Api;
	bool closed = false;
};

struct Server::Job {
	SOCKET s = INVALID_SOCKET;
	Role role = Role::Api;
	std::string body;
};

Server::Server(Limits limits, const std::string &api_token, const std::string &system_token,
	       std::map<std::string, Method> methods)
	: L_(limits),
	  methods_(std::move(methods))
{
	sha256(api_token, api_digest_);
	sha256(system_token, sys_digest_);
}

Server::~Server()
{
	stop();
}

bool Server::start(uint16_t port, std::string &err)
{
	WSADATA wsa;
	if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
		err = "WSAStartup failed";
		return false;
	}
	SOCKET ls = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
	if (ls == INVALID_SOCKET) {
		err = "socket failed";
		return false;
	}
	BOOL excl = TRUE; // no other process may bind the same address/port while we hold it
	setsockopt(ls, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, (const char *)&excl, sizeof(excl));
	sockaddr_in a = {};
	a.sin_family = AF_INET;
	a.sin_port = htons(port);
	inet_pton(AF_INET, "127.0.0.1", &a.sin_addr);
	if (bind(ls, (sockaddr *)&a, sizeof(a)) != 0 || listen(ls, SOMAXCONN) != 0) {
		err = "bind/listen on 127.0.0.1 failed (WSA " + std::to_string(WSAGetLastError()) + ")";
		closesocket(ls);
		return false;
	}
	sockaddr_in got = {};
	int gl = sizeof(got);
	getsockname(ls, (sockaddr *)&got, &gl);
	char ip[32] = {};
	inet_ntop(AF_INET, &got.sin_addr, ip, sizeof(ip));
	if (strcmp(ip, "127.0.0.1") != 0) {
		err = "bound a non-loopback address";
		closesocket(ls);
		return false;
	}
	u_long nb = 1;
	ioctlsocket(ls, FIONBIO, &nb);
	listen_sock_ = (uintptr_t)ls;
	port_ = ntohs(got.sin_port);
	allowed_host_a_ = "127.0.0.1:" + std::to_string(port_);
	allowed_host_b_ = "localhost:" + std::to_string(port_);
	stopping_ = false;
	io_ = std::thread([this] { io_loop(); });
	for (int i = 0; i < L_.workers; i++)
		workers_.emplace_back([this] { worker_loop(); });
	return true;
}

void Server::stop()
{
	if (stopping_.exchange(true))
		return;
	qcv_.notify_all();
	if (io_.joinable())
		io_.join();
	for (auto &w : workers_)
		if (w.joinable())
			w.join();
	workers_.clear();
	{
		std::lock_guard<std::mutex> l(qm_);
		for (Job *j : queue_) {
			closesocket(j->s);
			delete j;
		}
		queue_.clear();
	}
	if (listen_sock_ != ~(uintptr_t)0) {
		closesocket((SOCKET)listen_sock_);
		listen_sock_ = ~(uintptr_t)0;
	}
	WSACleanup();
}

json::Value Server::stats() const
{
	json::Value v = json::Value::object();
	v.set("requests", (uint64_t)requests_);
	v.set("rpcOk", (uint64_t)rpc_ok_);
	v.set("rpcErrors", (uint64_t)rpc_errors_);
	v.set("refused", (uint64_t)refused_);
	v.set("authFailures", (uint64_t)auth_failures_);
	v.set("rateLimited", (uint64_t)rate_limited_);
	v.set("pendingEvicted", (uint64_t)pending_evicted_);
	v.set("timedOut", (uint64_t)timed_out_);
	v.set("busy", (uint64_t)busy_);
	v.set("pending", (int)pending_now_);
	return v;
}

void Server::respond(uintptr_t sock, int status, const std::string &body, const char *extra)
{
	std::string h = "HTTP/1.1 " + std::to_string(status) + " " + reason(status) + "\r\n";
	h += "Content-Type: application/json; charset=utf-8\r\n";
	h += "Content-Length: " + std::to_string(body.size()) + "\r\n";
	h += "Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n";
	h += extra;
	h += "\r\n";
	h += body;
	SOCKET s = (SOCKET)sock;
	u_long nb = 0; // blocking with a send timeout
	ioctlsocket(s, FIONBIO, &nb);
	DWORD to = (DWORD)L_.send_timeout_ms;
	setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, (const char *)&to, sizeof(to));
	size_t off = 0;
	while (off < h.size()) {
		int n = send(s, h.data() + off, (int)std::min<size_t>(h.size() - off, 1 << 20), 0);
		if (n <= 0)
			break;
		off += (size_t)n;
	}
}

void Server::refuse(uintptr_t sock, int status, const char *code, const char *extra)
{
	refused_++;
	respond(sock, status, std::string("{\"error\":{\"code\":\"") + code + "\"}}", extra);
}

bool Server::auth(const std::string &header, Role &role) const
{
	std::smatch m;
	bool ok = std::regex_match(header, m, bearer_re());
	uint8_t d[32];
	sha256(ok ? m[1].str() : std::string(), d); // same work whether or not a token was presented
	bool is_api = digest_equal(d, api_digest_);
	bool is_sys = digest_equal(d, sys_digest_);
	if (!ok)
		return false;
	if (is_api) {
		role = Role::Api;
		return true;
	}
	if (is_sys) {
		role = Role::System;
		return true;
	}
	return false;
}

bool Server::note_auth_failure()
{
	auth_failures_++;
	std::lock_guard<std::mutex> l(am_);
	int64_t t = now_ms();
	if (t - auth_window_start_ > L_.auth_window_ms) {
		auth_window_start_ = t;
		auth_window_n_ = 0;
	}
	return ++auth_window_n_ > L_.auth_fail_per_window;
}

// Parses the header block of c.buf (up to body_start). Either refuses (c.closed = true) or sets headers_done.
void Server::handle_headers(Conn &c)
{
	SOCKET s = c.s;
	auto refuse_close = [&](int st, const char *code, const char *extra = "") {
		refuse((uintptr_t)s, st, code, extra);
		defer_close(s);
		c.closed = true;
	};
	std::string head = c.buf.substr(0, c.body_start - 4);
	std::vector<std::string> lines;
	size_t p = 0;
	while (true) {
		size_t e = head.find("\r\n", p);
		lines.push_back(head.substr(p, e == std::string::npos ? std::string::npos : e - p));
		if (e == std::string::npos)
			break;
		p = e + 2;
	}
	if (lines.empty() || lines.size() > 65)
		return refuse_close(400, "bad-request");
	// request line
	const std::string &rl = lines[0];
	size_t s1 = rl.find(' '), s2 = s1 == std::string::npos ? s1 : rl.find(' ', s1 + 1);
	if (s1 == std::string::npos || s2 == std::string::npos || rl.find(' ', s2 + 1) != std::string::npos)
		return refuse_close(400, "bad-request");
	std::string method = rl.substr(0, s1), target = rl.substr(s1 + 1, s2 - s1 - 1), version = rl.substr(s2 + 1);
	if (version != "HTTP/1.1" && version != "HTTP/1.0")
		return refuse_close(400, "bad-version");
	std::map<std::string, std::string> h;
	bool any_sec_fetch = false;
	for (size_t i = 1; i < lines.size(); i++) {
		const std::string &l = lines[i];
		if (l.empty() || l[0] == ' ' || l[0] == '\t')
			return refuse_close(400, "bad-header");
		size_t colon = l.find(':');
		if (colon == std::string::npos || colon == 0)
			return refuse_close(400, "bad-header");
		std::string name = lower(l.substr(0, colon));
		for (char ch : name)
			if (!is_tchar(ch))
				return refuse_close(400, "bad-header");
		std::string val = trim(l.substr(colon + 1));
		if (name.rfind("sec-fetch-", 0) == 0)
			any_sec_fetch = true;
		if (h.count(name)) {
			if (name == "host" || name == "authorization" || name == "content-length" || name == "content-type" ||
			    name == "origin")
				return refuse_close(400, "duplicate-header");
			h[name] += "," + val;
		} else {
			h[name] = val;
		}
	}
	auto hit = h.find("host");
	if (hit == h.end() || (lower(hit->second) != allowed_host_a_ && lower(hit->second) != allowed_host_b_))
		return refuse_close(403, "bad-host");
	if (h.count("origin"))
		return refuse_close(403, "origin-refused");
	if (any_sec_fetch)
		return refuse_close(403, "browser-request-refused");
	if (target.empty() || target[0] != '/')
		return refuse_close(400, "bad-url");
	std::string path = target.substr(0, target.find('?'));
	if (path != "/rpc")
		return refuse_close(404, "not-found");
	if (method != "POST")
		return refuse_close(405, "method-not-allowed", "Allow: POST\r\n");
	if (target.find('?') != std::string::npos)
		return refuse_close(400, "bad-query"); // never a token (or anything) in the query
	auto ait = h.find("authorization");
	Role role;
	if (ait == h.end() || !auth(ait->second, role)) {
		if (ait == h.end()) {
			uint8_t d[32]; // keep the work equal for a missing header
			sha256(std::string(), d);
		}
		if (note_auth_failure()) {
			rate_limited_++;
			std::string ra = "Retry-After: " + std::to_string(L_.auth_window_ms / 1000) + "\r\n";
			return refuse_close(429, "too-many-failures", ra.c_str());
		}
		return refuse_close(401, "unauthorized", "WWW-Authenticate: Bearer\r\n");
	}
	if (h.count("transfer-encoding"))
		return refuse_close(400, "transfer-encoding-refused");
	auto ct = h.find("content-type");
	static const std::regex ct_re("^application/json(\\s*;\\s*charset=utf-8)?$", std::regex::icase);
	if (ct == h.end() || !std::regex_match(ct->second, ct_re))
		return refuse_close(415, "content-type must be application/json");
	auto cl = h.find("content-length");
	if (cl == h.end())
		return refuse_close(411, "length-required");
	if (cl->second.empty() || cl->second.size() > 10 ||
	    !std::all_of(cl->second.begin(), cl->second.end(), [](char ch) { return ch >= '0' && ch <= '9'; }))
		return refuse_close(400, "bad-content-length");
	unsigned long long n = std::stoull(cl->second);
	if (n > (unsigned long long)L_.max_body_bytes)
		return refuse_close(413, "body-too-large");
	c.content_length = (size_t)n;
	c.role = role;
	c.headers_done = true;
}

void Server::finish(Conn &c)
{
	if (c.buf.size() - c.body_start != c.content_length) {
		refuse((uintptr_t)c.s, 400, "body-length-mismatch");
		defer_close(c.s);
		c.closed = true;
		return;
	}
	Job *j = new Job;
	j->s = c.s;
	j->role = c.role;
	j->body = c.buf.substr(c.body_start);
	{
		std::lock_guard<std::mutex> l(qm_);
		if ((int)queue_.size() >= L_.queue_max) {
			busy_++;
			delete j;
			refuse((uintptr_t)c.s, 503, "busy", "Retry-After: 1\r\n");
			defer_close(c.s);
			c.closed = true;
			return;
		}
		queue_.push_back(j);
	}
	qcv_.notify_one();
	c.s = INVALID_SOCKET; // owned by the job now
	c.closed = true;
}

void Server::defer_close(uintptr_t sock)
{
	SOCKET s = (SOCKET)sock;
	shutdown(s, SD_SEND);
	u_long nb = 1;
	ioctlsocket(s, FIONBIO, &nb);
	closing_.push_back({sock, now_ms() + 200});
}

void Server::io_loop()
{
	std::vector<Conn> conns;
	std::vector<WSAPOLLFD> fds;
	while (!stopping_) {
		// Refused connections: drain what the peer still sends (so it reads our response, not an RST), then close.
		for (auto &cl : closing_) {
			char tmp[4096];
			int n;
			while ((n = recv((SOCKET)cl.first, tmp, sizeof(tmp), 0)) > 0) {
			}
			if (n == 0 || (n < 0 && WSAGetLastError() != WSAEWOULDBLOCK) || now_ms() > cl.second) {
				closesocket((SOCKET)cl.first);
				cl.second = -1;
			}
		}
		closing_.erase(std::remove_if(closing_.begin(), closing_.end(), [](const auto &x) { return x.second < 0; }),
			       closing_.end());
		fds.clear();
		WSAPOLLFD lf = {};
		lf.fd = (SOCKET)listen_sock_;
		lf.events = POLLRDNORM;
		fds.push_back(lf);
		for (auto &c : conns) {
			WSAPOLLFD f = {};
			f.fd = c.s;
			f.events = POLLRDNORM;
			fds.push_back(f);
		}
		int r = WSAPoll(fds.data(), (ULONG)fds.size(), closing_.empty() ? 100 : 10);
		int64_t t = now_ms();
		if (r > 0 && (fds[0].revents & POLLRDNORM)) {
			while (true) {
				SOCKET s = accept((SOCKET)listen_sock_, nullptr, nullptr);
				if (s == INVALID_SOCKET)
					break;
				requests_++;
				u_long nb = 1;
				ioctlsocket(s, FIONBIO, &nb);
				Conn c;
				c.s = s;
				c.accepted = t;
				conns.push_back(std::move(c));
				if ((int)conns.size() > L_.max_pending) { // evict the oldest pending connection, never the new one
					pending_evicted_++;
					closesocket(conns.front().s);
					conns.erase(conns.begin());
				}
			}
		}
		if (r > 0) {
			for (size_t i = 1; i < fds.size(); i++) {
				if (!fds[i].revents)
					continue;
				Conn *c = nullptr;
				for (auto &x : conns)
					if (x.s == fds[i].fd)
						c = &x;
				if (!c || c->closed)
					continue;
				char buf[16384];
				int n = recv(c->s, buf, sizeof(buf), 0);
				if (n <= 0) {
					if (n < 0 && WSAGetLastError() == WSAEWOULDBLOCK)
						continue;
					closesocket(c->s);
					c->closed = true;
					continue;
				}
				c->buf.append(buf, (size_t)n);
				if (!c->headers_done) {
					size_t e = c->buf.find("\r\n\r\n");
					if (e == std::string::npos) {
						if ((int)c->buf.size() > L_.max_header_bytes) {
							refuse((uintptr_t)c->s, 431, "headers-too-large");
							defer_close(c->s);
							c->closed = true;
						}
						continue;
					}
					if ((int)e + 4 > L_.max_header_bytes) {
						refuse((uintptr_t)c->s, 431, "headers-too-large");
						defer_close(c->s);
						c->closed = true;
						continue;
					}
					c->body_start = e + 4;
					handle_headers(*c);
					if (c->closed)
						continue;
				}
				if (c->buf.size() - c->body_start > c->content_length) {
					refuse((uintptr_t)c->s, 400, "body-length-mismatch");
					defer_close(c->s);
					c->closed = true;
					continue;
				}
				if (c->buf.size() - c->body_start == c->content_length)
					finish(*c);
			}
		}
		for (auto &c : conns) {
			if (c.closed)
				continue;
			if ((!c.headers_done && t - c.accepted > L_.headers_timeout_ms) || t - c.accepted > L_.request_timeout_ms) {
				timed_out_++;
				closesocket(c.s);
				c.closed = true;
			}
		}
		conns.erase(std::remove_if(conns.begin(), conns.end(), [](const Conn &c) { return c.closed; }), conns.end());
		pending_now_ = (int)conns.size();
	}
	for (auto &c : conns)
		if (!c.closed)
			closesocket(c.s);
	for (auto &cl : closing_)
		closesocket((SOCKET)cl.first);
	closing_.clear();
}

void Server::worker_loop()
{
	while (true) {
		Job *j = nullptr;
		{
			std::unique_lock<std::mutex> l(qm_);
			qcv_.wait(l, [this] { return stopping_ || !queue_.empty(); });
			if (stopping_ && queue_.empty())
				return;
			j = queue_.front();
			queue_.pop_front();
		}
		run_job(*j);
		close_graceful(j->s);
		delete j;
	}
}

void Server::run_job(Job &j)
{
	auto rpc_err = [&](int http, const json::Value &id, int code, const std::string &msg) {
		rpc_errors_++;
		json::Value e = json::Value::object();
		e.set("code", code);
		e.set("message", msg);
		json::Value r = json::Value::object();
		r.set("jsonrpc", "2.0");
		r.set("id", id);
		r.set("error", std::move(e));
		respond((uintptr_t)j.s, http, r.dump());
	};
	json::ParseResult pr = json::parse(j.body, 32);
	if (!pr.ok)
		return rpc_err(400, json::Value(), PARSE, "parse-error");
	const json::Value &msg = pr.value;
	if (msg.is_array())
		return rpc_err(400, json::Value(), INVALID_REQUEST, "batch-not-supported");
	if (!msg.is_object())
		return rpc_err(400, json::Value(), INVALID_REQUEST, "invalid-request");
	const json::Value *idp = msg.find("id");
	bool id_ok = idp && ((idp->is_string() && !idp->as_string().empty() && idp->as_string().size() <= 64) ||
			     (idp->is_int() && idp->as_int() >= -9007199254740991LL && idp->as_int() <= 9007199254740991LL));
	if (!id_ok)
		return rpc_err(400, json::Value(), INVALID_REQUEST, "id must be a string (1..64) or an integer");
	json::Value id = *idp;
	for (auto &m : msg.members())
		if (m.first != "jsonrpc" && m.first != "method" && m.first != "params" && m.first != "id")
			return rpc_err(400, id, INVALID_REQUEST, "unknown-field");
	const json::Value *ver = msg.find("jsonrpc");
	const json::Value *meth = msg.find("method");
	if (!ver || !ver->is_string() || ver->as_string() != "2.0" || !meth || !meth->is_string() ||
	    meth->as_string().size() > 64)
		return rpc_err(400, id, INVALID_REQUEST, "invalid-request");
	auto it = methods_.find(meth->as_string());
	if (it == methods_.end())
		return rpc_err(200, id, METHOD_NOT_FOUND, "method-not-found");
	if ((j.role == Role::Api && !it->second.api) || (j.role == Role::System && !it->second.system))
		return rpc_err(403, id, FORBIDDEN, "forbidden");
	const json::Value *pp = msg.find("params");
	json::Value empty = json::Value::object();
	const json::Value &params = pp ? *pp : empty;
	if (!params.is_object())
		return rpc_err(200, id, INVALID_PARAMS, "params must be an object");
	auto t0 = std::chrono::steady_clock::now();
	try {
		json::Value result = it->second.run(params, j.role);
		rpc_ok_++;
		json::Value r = json::Value::object();
		r.set("jsonrpc", "2.0");
		r.set("id", id);
		r.set("result", std::move(result));
		respond((uintptr_t)j.s, 200, r.dump());
		double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
		const std::string &mn = meth->as_string(); // polled methods are not logged
		if (mn != "host.status" && mn != "mixer.list" && mn != "outputs.status" && mn != "preview.list")
			hlog::info("rpc %s role=%s ok %.1fms", meth->as_string().c_str(), role_name(j.role), ms);
	} catch (const Error &e) {
		hlog::info("rpc %s role=%s error %d %s", meth->as_string().c_str(), role_name(j.role), e.code, e.what());
		rpc_err(e.http, id, e.code, e.what());
	} catch (const std::exception &e) {
		hlog::warn("rpc %s internal error: %s", meth->as_string().c_str(), e.what());
		rpc_err(200, id, INTERNAL, "internal-error"); // never the message of an unexpected error
	}
}

// ---------------------------------------------------------------------------------------------------------------
Params::Params(const json::Value &p, std::initializer_list<const char *> allowed) : p_(p)
{
	if (!p.is_object())
		throw Error(INVALID_PARAMS, "params must be an object");
	for (auto &m : p.members()) {
		bool ok = false;
		for (const char *a : allowed)
			if (m.first == a)
				ok = true;
		if (!ok)
			throw Error(INVALID_PARAMS, "unknown field " + json::Value(m.first.substr(0, 32)).dump());
	}
}

void Params::bad(const char *k) const
{
	throw Error(INVALID_PARAMS, std::string(has(k) ? "bad field " : "missing field ") + k);
}

std::string Params::str(const char *k, size_t max_len) const
{
	const json::Value *v = p_.find(k);
	if (!v || !v->is_string() || v->as_string().size() > max_len)
		bad(k);
	return v->as_string();
}

std::string Params::str_or(const char *k, const std::string &def, size_t max_len) const
{
	return has(k) ? str(k, max_len) : def;
}

int64_t Params::integer(const char *k, int64_t min, int64_t max) const
{
	const json::Value *v = p_.find(k);
	if (!v || !v->is_int() || v->as_int() < min || v->as_int() > max)
		bad(k);
	return v->as_int();
}

int64_t Params::int_or(const char *k, int64_t def, int64_t min, int64_t max) const
{
	return has(k) ? integer(k, min, max) : def;
}

double Params::num(const char *k, double min, double max) const
{
	const json::Value *v = p_.find(k);
	if (!v || !v->is_number() || v->as_double() < min || v->as_double() > max)
		bad(k);
	return v->as_double();
}

double Params::num_or(const char *k, double def, double min, double max) const
{
	return has(k) ? num(k, min, max) : def;
}

bool Params::boolean(const char *k) const
{
	const json::Value *v = p_.find(k);
	if (!v || !v->is_bool())
		bad(k);
	return v->as_bool();
}

bool Params::bool_or(const char *k, bool def) const
{
	return has(k) ? boolean(k) : def;
}

const json::Value &Params::obj(const char *k) const
{
	const json::Value *v = p_.find(k);
	if (!v || !v->is_object())
		bad(k);
	return *v;
}

const json::Value *Params::obj_opt(const char *k) const
{
	return has(k) ? &obj(k) : nullptr;
}

const json::Value &Params::arr(const char *k) const
{
	const json::Value *v = p_.find(k);
	if (!v || !v->is_array())
		bad(k);
	return *v;
}

const json::Value *Params::arr_opt(const char *k) const
{
	return has(k) ? &arr(k) : nullptr;
}

} // namespace rpc
