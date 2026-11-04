// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: panic. See panic.h (contract: services/event-core/api/panic.mjs).
#include "panic.h"
#include "log.h"
#include "rpc_server.h"

#include <windows.h>

#include <filesystem>
#include <fstream>
#include <regex>
#include <sstream>

namespace fs = std::filesystem;

namespace {

const int kDelaysMs[] = {50, 100, 200, 400}; // 4 waits = 5 tries (api/client.mjs RETRY_DELAYS_MS)

enum class Try { Ok, Refused, Reset, Fail };

std::wstring widen(const std::string &s)
{
	if (s.empty())
		return {};
	int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
	std::wstring w((size_t)n, L'\0');
	MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), w.data(), n);
	return w;
}

void wipe(std::string &s)
{
	if (!s.empty())
		SecureZeroMemory(s.data(), s.size());
	s.clear();
}

bool is_reset(DWORD e)
{
	return e == ERROR_BROKEN_PIPE || e == ERROR_NO_DATA || e == ERROR_PIPE_NOT_CONNECTED;
}

// Reads event-core's system.json: { pipe, pid, startedAt }. false if absent, unreadable or not the expected shape.
bool read_system_file(const std::string &file, std::string &pipe, unsigned long &pid, std::string &err)
{
	std::ifstream f(fs::u8path(file), std::ios::binary);
	if (!f) {
		err = "system.json not found (event-core not running?)";
		return false;
	}
	std::string text((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
	if (text.size() > 4096) {
		err = "system.json too large";
		return false;
	}
	json::ParseResult pr = json::parse(text, 8);
	const json::Value *p = pr.ok ? pr.value.find("pipe") : nullptr;
	const json::Value *d = pr.ok ? pr.value.find("pid") : nullptr;
	static const std::regex re("^\\\\\\\\\\.\\\\pipe\\\\ujwalam-core-system-[0-9a-f]{32}$");
	if (!p || !p->is_string() || !std::regex_match(p->as_string(), re) || !d || !d->is_int() || d->as_int() <= 0) {
		err = "system.json has no valid pipe and pid";
		return false;
	}
	pipe = p->as_string();
	pid = (unsigned long)d->as_int();
	return true;
}

// Waits for an overlapped operation on h. Returns false with *e set on failure or timeout (the I/O is cancelled).
bool wait_io(HANDLE h, OVERLAPPED &ov, BOOL started, DWORD &n, DWORD timeout_ms, DWORD &e)
{
	if (!started) {
		e = GetLastError();
		if (e != ERROR_IO_PENDING)
			return false;
		if (WaitForSingleObject(ov.hEvent, timeout_ms) != WAIT_OBJECT_0) {
			CancelIoEx(h, &ov);
			GetOverlappedResult(h, &ov, &n, TRUE);
			e = WAIT_TIMEOUT;
			return false;
		}
	}
	if (!GetOverlappedResult(h, &ov, &n, FALSE)) {
		e = GetLastError();
		return false;
	}
	e = 0;
	return true;
}

// One attempt: connect, check the server pid, send auth + request, read the two answer lines.
Try attempt(const std::string &pipe, unsigned long pid, const std::string &token, const std::string &reason, int64_t id,
	    json::Value &result, std::string &err)
{
	std::wstring wp = widen(pipe);
	HANDLE h = CreateFileW(wp.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
			       FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr);
	if (h == INVALID_HANDLE_VALUE) {
		DWORD e = GetLastError();
		if (e == ERROR_PIPE_BUSY) {
			WaitNamedPipeW(wp.c_str(), 250);
			err = "pipe busy";
			return Try::Refused;
		}
		if (e == ERROR_FILE_NOT_FOUND) {
			err = "pipe not found";
			return Try::Refused;
		}
		err = "pipe open failed (error " + std::to_string(e) + ")";
		return Try::Fail;
	}
	ULONG spid = 0;
	if (!GetNamedPipeServerProcessId(h, &spid) || spid != pid) {
		CloseHandle(h);
		err = "pipe server is not the event-core process named in system.json (token not sent)";
		return Try::Fail;
	}
	OVERLAPPED ov = {};
	ov.hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
	auto done = [&](Try t) {
		CloseHandle(ov.hEvent);
		CloseHandle(h);
		return t;
	};
	json::Value req = json::Value::object();
	req.set("jsonrpc", "2.0");
	req.set("id", id);
	req.set("method", "actions.panic");
	json::Value params = json::Value::object();
	params.set("reason", reason);
	req.set("params", std::move(params));
	std::string line = "{\"auth\":\"" + token + "\"}\n" + req.dump() + "\n";
	DWORD n = 0, e = 0;
	BOOL st = WriteFile(h, line.data(), (DWORD)line.size(), nullptr, &ov);
	bool wrote = wait_io(h, ov, st, n, 2000, e) && n == line.size();
	wipe(line);
	if (!wrote) {
		err = e == WAIT_TIMEOUT ? "write timed out" : "write failed (error " + std::to_string(e) + ")";
		return done(is_reset(e) ? Try::Reset : Try::Fail);
	}
	std::string buf;
	std::vector<std::string> lines;
	ULONGLONG until = GetTickCount64() + 5000;
	char chunk[4096];
	while (lines.size() < 2) {
		ULONGLONG now = GetTickCount64();
		if (now >= until) {
			err = "no answer within 5 s";
			return done(Try::Fail);
		}
		ResetEvent(ov.hEvent);
		st = ReadFile(h, chunk, sizeof(chunk), nullptr, &ov);
		if (!wait_io(h, ov, st, n, (DWORD)(until - now), e) || n == 0) {
			if (e == WAIT_TIMEOUT) {
				err = "no answer within 5 s";
				return done(Try::Fail);
			}
			// Closed before the full answer: after a refused handshake that is a refusal, else a reset.
			if (!lines.empty() && lines[0].find("\"ok\":true") == std::string::npos)
				break;
			err = "pipe closed before the answer";
			return done(Try::Reset);
		}
		buf.append(chunk, n);
		if (buf.size() > 65536) {
			err = "answer too large";
			return done(Try::Fail);
		}
		size_t p;
		while (lines.size() < 2 && (p = buf.find('\n')) != std::string::npos) {
			lines.push_back(buf.substr(0, p));
			buf.erase(0, p + 1);
		}
	}
	json::ParseResult hs = json::parse(lines.empty() ? "" : lines[0], 8);
	const json::Value *ok = hs.ok ? hs.value.find("ok") : nullptr;
	if (!ok || !ok->is_bool() || !ok->as_bool()) {
		const json::Value *er = hs.ok ? hs.value.find("error") : nullptr;
		err = er && er->is_string() && er->as_string() == "busy" ? "busy" : "unauthorized";
		return done(Try::Fail);
	}
	json::ParseResult rr = json::parse(lines.size() > 1 ? lines[1] : "", 16);
	const json::Value *rid = rr.ok ? rr.value.find("id") : nullptr;
	if (!rr.ok || !rid || !rid->is_int() || rid->as_int() != id) {
		err = "bad answer";
		return done(Try::Fail);
	}
	if (const json::Value *re = rr.value.find("error")) {
		const json::Value *c = re->find("code");
		err = "rpc error " + std::to_string(c && c->is_int() ? c->as_int() : 0);
		return done(Try::Fail);
	}
	const json::Value *res = rr.value.find("result");
	if (!res || !res->is_object()) {
		err = "bad answer";
		return done(Try::Fail);
	}
	result = *res;
	return done(Try::Ok);
}

} // namespace

Panic::Panic(Studio &studio, Config c) : studio_(studio), cfg_(std::move(c))
{
	sender_ = std::thread([this] { run(); });
}

Panic::~Panic()
{
	stop();
	wipe(cfg_.token);
}

void Panic::stop()
{
	{
		std::lock_guard<std::mutex> l(m_);
		stop_ = true;
		cv_.notify_all();
	}
	if (sender_.joinable())
		sender_.join();
}

json::Value Panic::engage(const std::string &source)
{
	// 1. In-process first. No IPC and no event-core dependency on this path.
	std::vector<Studio::LayerRef> hid = studio_.hide_browser_layers();
	json::Value r = json::Value::object();
	bool already;
	{
		std::lock_guard<std::mutex> l(m_);
		already = engaged_;
		if (!engaged_)
			since_ = hlog::utc_now();
		engaged_ = true;
		count_++;
		last_source_ = source;
		hidden_.insert(hidden_.end(), hid.begin(), hid.end());
		// 2. Then event-core, on the sender thread. A repeat while a send is queued keeps one send.
		pending_ = true;
		pending_reason_ = source == "hotkey" ? "hotkey" : "host " + source;
		core_state_ = "sending";
		cv_.notify_all();
		r.set("engaged", true);
		r.set("already", already);
		r.set("hiddenNow", (uint64_t)hid.size());
		r.set("hiddenTotal", (uint64_t)hidden_.size());
		r.set("core", core_state_);
	}
	hlog::warn("PANIC (%s): %zu browser layers hidden%s; effects refused; outputs and audio untouched", source.c_str(),
		   hid.size(), already ? " (already engaged)" : "");
	return r;
}

json::Value Panic::clear()
{
	std::vector<Studio::LayerRef> hid;
	bool was;
	{
		std::lock_guard<std::mutex> l(m_);
		was = engaged_;
		hid.swap(hidden_);
		engaged_ = false;
		since_.clear();
	}
	size_t n = studio_.restore_layers(hid);
	hlog::warn("panic cleared in the host: %zu layers shown again (event-core panic is cleared there)", n);
	json::Value r = json::Value::object();
	r.set("cleared", was);
	r.set("restored", (uint64_t)n);
	return r;
}

bool Panic::engaged() const
{
	std::lock_guard<std::mutex> l(m_);
	return engaged_;
}

json::Value Panic::status() const
{
	std::lock_guard<std::mutex> l(m_);
	json::Value o = json::Value::object();
	o.set("engaged", engaged_);
	o.set("since", since_.empty() ? json::Value() : json::Value(since_));
	o.set("count", count_);
	o.set("lastSource", last_source_.empty() ? json::Value() : json::Value(last_source_));
	json::Value a = json::Value::array();
	for (auto &h : hidden_) {
		json::Value x = json::Value::object();
		x.set("canvas", h.canvas);
		x.set("scene", h.scene);
		x.set("layer", h.layer);
		a.push(std::move(x));
	}
	o.set("hiddenLayers", std::move(a));
	o.set("coreConfigured", !cfg_.system_file.empty() && rpc::is_token(cfg_.token));
	json::Value c = core_.is_null() ? json::Value::object() : core_;
	c.set("state", core_state_);
	o.set("core", std::move(c));
	return o;
}

void Panic::run()
{
	for (;;) {
		std::string reason;
		{
			std::unique_lock<std::mutex> l(m_);
			cv_.wait(l, [&] { return stop_ || pending_; });
			if (!pending_ && stop_)
				return;
			pending_ = false;
			reason = pending_reason_;
		}
		json::Value r = notify_core(reason);
		std::lock_guard<std::mutex> l(m_);
		core_ = r;
		if (!pending_)
			core_state_ = "done";
		if (stop_ && !pending_)
			return;
	}
}

json::Value Panic::notify_core(const std::string &reason)
{
	static int64_t next_id = 1;
	json::Value r = json::Value::object();
	r.set("at", hlog::utc_now());
	if (cfg_.system_file.empty() || !rpc::is_token(cfg_.token)) {
		r.set("ok", false);
		r.set("reason", "not-configured");
		r.set("attempts", 0);
		hlog::warn("panic: event-core not told (no system file or system token in the host config)");
		return r;
	}
	int attempts = 0;
	std::string err;
	for (int i = 0; i < 5; i++) {
		attempts++;
		std::string pipe;
		unsigned long pid = 0;
		Try t;
		json::Value result;
		if (!read_system_file(cfg_.system_file, pipe, pid, err))
			t = Try::Refused; // no listener published: same as a refused connect
		else
			t = attempt(pipe, pid, cfg_.token, reason, next_id++, result, err);
		if (t == Try::Ok) {
			const json::Value *ok = result.find("ok");
			const json::Value *rs = result.find("reason");
			bool good = ok && ok->is_bool() && ok->as_bool();
			r.set("ok", good);
			r.set("reason", rs && rs->is_string() ? json::Value(rs->as_string().substr(0, 64)) : json::Value());
			r.set("attempts", attempts);
			hlog::info("panic: event-core answered %s (%s) after %d attempt(s)", good ? "ok" : "not ok",
				   rs && rs->is_string() ? rs->as_string().substr(0, 64).c_str() : "?", attempts);
			return r;
		}
		if (t == Try::Fail || i == 4)
			break;
		Sleep(kDelaysMs[i]);
	}
	r.set("ok", false);
	r.set("reason", "send-failed");
	r.set("error", err);
	r.set("attempts", attempts);
	hlog::warn("panic: event-core not reached after %d attempt(s): %s", attempts, err.c_str());
	return r;
}
