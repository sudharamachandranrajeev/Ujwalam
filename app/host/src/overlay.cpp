// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: overlay server child supervisor (see overlay.h).
#include "overlay.h"

#include "log.h"
#include "rpc_server.h"

#include <windows.h>
#include <winternl.h>

#include <chrono>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <random>
#include <regex>
#include <vector>

namespace fs = std::filesystem;

namespace {

constexpr uint16_t kStreamerbotPort = 8093; // the real Streamer.bot keeps it
constexpr int kBackoffBaseMs = 500, kBackoffCapMs = 15000, kStableMs = 30000, kReplyMs = 2000;
constexpr DWORD kExitBadArgs = 64;
constexpr int kMicPeriodMs = 50;       // legacy polled the mic every 50 ms (legacy/tools/cam-pop.mjs)
constexpr size_t kWriteReserve = 1024; // stdin pipe bytes the mic feed leaves free for effect/stats calls

// Free bytes in the child's stdin pipe buffer (FILE_PIPE_LOCAL_INFORMATION.WriteQuotaAvailable on our write end;
// the same query libuv uses). false when it cannot be read: the caller then drops its line rather than risk a
// blocking WriteFile.
struct PipeLocalInfo {
	ULONG NamedPipeType, NamedPipeConfiguration, MaximumInstances, CurrentInstances, InboundQuota, ReadDataAvailable,
		OutboundQuota, WriteQuotaAvailable, NamedPipeState, NamedPipeEnd;
};
using NtQueryInformationFileFn = LONG(NTAPI *)(HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, ULONG);
constexpr ULONG kFilePipeLocalInformation = 24;

bool pipe_room(HANDLE h, size_t need)
{
	static const auto fn = reinterpret_cast<NtQueryInformationFileFn>(
		reinterpret_cast<void *>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryInformationFile")));
	if (!fn)
		return false;
	IO_STATUS_BLOCK io = {};
	PipeLocalInfo info = {};
	if (fn(h, &io, &info, sizeof(info), kFilePipeLocalInformation) < 0)
		return false;
	return info.WriteQuotaAvailable >= need;
}

bool valid_audio_id(const std::string &s)
{
	static const std::regex re("^[a-z][a-z0-9_-]{0,63}$"); // project audio source id (project.schema.json $defs.id)
	return std::regex_match(s, re);
}

std::wstring widen(const std::string &s)
{
	if (s.empty())
		return {};
	int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
	std::wstring w((size_t)n, L'\0');
	MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), w.data(), n);
	return w;
}

// Quotes one argument for CommandLineToArgvW / the MSVC CRT.
void append_arg(std::wstring &cmd, const std::wstring &a)
{
	if (!cmd.empty())
		cmd += L' ';
	if (!a.empty() && a.find_first_of(L" \t\n\v\"") == std::wstring::npos) {
		cmd += a;
		return;
	}
	cmd += L'"';
	for (size_t i = 0;; i++) {
		size_t bs = 0;
		while (i < a.size() && a[i] == L'\\') {
			i++;
			bs++;
		}
		if (i == a.size()) {
			cmd.append(bs * 2, L'\\');
			break;
		}
		if (a[i] == L'"') {
			cmd.append(bs * 2 + 1, L'\\');
			cmd += L'"';
		} else {
			cmd.append(bs, L'\\');
			cmd += a[i];
		}
	}
	cmd += L'"';
}

// The child's whole environment: system variables node needs, nothing else (no tokens, no NODE_OPTIONS).
std::wstring env_block(const std::string &token)
{
	static const wchar_t *const keep[] = {L"SystemRoot", L"SystemDrive", L"windir", L"PATH", L"PATHEXT", L"TEMP",
					      L"TMP", L"ComSpec", L"NUMBER_OF_PROCESSORS", L"PROCESSOR_ARCHITECTURE",
					      L"USERPROFILE", L"LOCALAPPDATA", L"APPDATA", L"HOMEDRIVE", L"HOMEPATH"};
	std::wstring block;
	for (const wchar_t *k : keep) {
		DWORD n = GetEnvironmentVariableW(k, nullptr, 0);
		if (!n)
			continue;
		std::wstring v(n, L'\0');
		n = GetEnvironmentVariableW(k, v.data(), n);
		v.resize(n);
		block += k;
		block += L'=';
		block += v;
		block += L'\0';
	}
	if (!token.empty()) {
		block += L"UJWALAM_EVENT_CORE_API_TOKEN=";
		block += widen(token);
		block += L'\0';
	}
	block += L'\0';
	return block;
}

// Printable ASCII only, truncated: child stderr may echo page or feed text.
std::string clean_line(const std::string &s)
{
	std::string r;
	for (char c : s) {
		if (r.size() >= 300)
			break;
		r += (c >= 0x20 && c < 0x7f) ? c : '?';
	}
	return r;
}

void close_h(void *&h)
{
	if (h) {
		CloseHandle((HANDLE)h);
		h = nullptr;
	}
}

} // namespace

Overlay::Overlay(Config c) : cfg_(std::move(c))
{
	if (cfg_.port == kStreamerbotPort || cfg_.feed_port == kStreamerbotPort)
		throw std::runtime_error("overlay ports must not be 8093 (Streamer.bot)");
}

Overlay::~Overlay()
{
	stop();
}

void Overlay::start()
{
	std::lock_guard<std::mutex> lk(m_);
	if (sup_.joinable())
		return;
	job_ = CreateJobObjectW(nullptr, nullptr);
	if (job_) {
		JOBOBJECT_EXTENDED_LIMIT_INFORMATION li = {};
		li.BasicLimitInformation.LimitFlags =
			JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
		SetInformationJobObject((HANDLE)job_, JobObjectExtendedLimitInformation, &li, sizeof(li));
	}
	state_ = "starting";
	sup_ = std::thread([this] { run(); });
	mic_ = std::thread([this] { mic_pump(); });
}

void Overlay::stop(int timeout_ms)
{
	{
		std::lock_guard<std::mutex> lk(m_);
		stopping_ = true;
		stop_timeout_ms_ = timeout_ms;
		std::lock_guard<std::mutex> wl(write_m_);
		close_h(in_w_); // the child stops its servers and exits 0 when stdin closes
	}
	cv_.notify_all();
	if (sup_.joinable())
		sup_.join();
	if (mic_.joinable())
		mic_.join();
	std::lock_guard<std::mutex> lk(m_);
	close_h(job_);
	if (state_ != "failed")
		state_ = "stopped";
}

bool Overlay::wait_ready(int timeout_ms)
{
	std::unique_lock<std::mutex> lk(m_);
	cv_.wait_for(lk, std::chrono::milliseconds(timeout_ms),
		     [&] { return state_ == "running" || state_ == "failed" || stopping_; });
	return state_ == "running";
}

bool Overlay::ports(uint16_t &static_port, uint16_t &feed_port) const
{
	std::lock_guard<std::mutex> lk(m_);
	static_port = static_port_;
	feed_port = feed_port_;
	return state_ == "running";
}

json::Value Overlay::status() const
{
	std::lock_guard<std::mutex> lk(m_);
	json::Value s = json::Value::object();
	s.set("state", state_);
	s.set("pid", pid_ ? json::Value((int64_t)pid_) : json::Value());
	s.set("staticPort", static_port_ ? json::Value((int)static_port_) : json::Value());
	s.set("feedPort", feed_port_ ? json::Value((int)feed_port_) : json::Value());
	s.set("restarts", restarts_);
	s.set("failures", failures_);
	s.set("lastExit", last_exit_ >= 0 ? json::Value((int64_t)last_exit_) : json::Value());
	s.set("lastError", last_error_.empty() ? json::Value() : json::Value(last_error_));
	s.set("eventFeed", !cfg_.events_url.empty());
	s.set("childEnvKeys", child_env_);
	s.set("childHasEventToken", child_token_);
	json::Value mic = json::Value::object();
	mic.set("source", mic_source_.empty() ? json::Value() : json::Value(mic_source_));
	mic.set("found", mic_found_.load());
	mic.set("sent", (int64_t)mic_sent_.load());
	mic.set("skipped", (int64_t)mic_skipped_.load());
	s.set("mic", std::move(mic));
	return s;
}

void Overlay::set_mic_level(MicLevelFn fn)
{
	std::lock_guard<std::mutex> lk(mic_m_);
	mic_fn_ = std::move(fn);
}

bool Overlay::post_line_locked(const std::string &line)
{
	if (state_ != "running" || !in_w_)
		return false;
	std::lock_guard<std::mutex> wl(write_m_);
	if (!in_w_ || !pipe_room((HANDLE)in_w_, line.size() + kWriteReserve))
		return false;
	DWORD w = 0;
	return WriteFile((HANDLE)in_w_, line.data(), (DWORD)line.size(), &w, nullptr) && w == line.size();
}

// Mic feed pump (see overlay.h). Its own thread: libobs's audio thread only stores the meter atomics (Studio::Meter),
// and the RPC thread is never involved. Cost per tick: one map-free scan of the project sources and one ~30-byte write.
void Overlay::mic_pump()
{
	using clock = std::chrono::steady_clock;
	auto next = clock::now();
	for (;;) {
		next += std::chrono::milliseconds(kMicPeriodMs);
		std::string id;
		{
			std::unique_lock<std::mutex> lk(m_);
			if (cv_.wait_until(lk, next, [&] { return stopping_; }))
				break;
			if (state_ == "running" && in_w_)
				id = mic_source_;
		}
		if (clock::now() - next > std::chrono::seconds(1))
			next = clock::now(); // stalled (machine asleep, long lock): do not burst to catch up
		if (id.empty()) {
			mic_found_ = false;
			continue;
		}
		float db = -INFINITY;
		int r = 0;
		{
			std::lock_guard<std::mutex> lk(mic_m_);
			if (mic_fn_)
				r = mic_fn_(id, db);
		}
		if (r <= 0) {
			if (r < 0)
				mic_skipped_++;
			else
				mic_found_ = false;
			continue;
		}
		mic_found_ = true;
		double level = std::isfinite(db) ? std::pow(10.0, (double)db / 20.0) : 0.0;
		if (!std::isfinite(level) || level < 0)
			level = 0;
		if (level > 1)
			level = 1;
		// Fixed-point by hand: %f follows the C locale's decimal point, which a library may change.
		long micro = std::lround(level * 1e6);
		char line[64];
		int n = std::snprintf(line, sizeof(line), "{\"op\":\"mic\",\"level\":%ld.%06ld}\n", micro / 1000000, micro % 1000000);
		bool ok;
		{
			std::lock_guard<std::mutex> lk(m_);
			ok = n > 0 && post_line_locked(std::string(line, (size_t)n));
		}
		if (ok)
			mic_sent_++;
		else
			mic_skipped_++;
	}
}

json::Value Overlay::effect(const std::string &name, const json::Value &meta)
{
	json::Value x = json::Value::object();
	x.set("name", name);
	x.set("meta", meta);
	return call("effect", x);
}

json::Value Overlay::stats()
{
	return call("stats", json::Value::object());
}

json::Value Overlay::call(const std::string &op, const json::Value &extra)
{
	std::unique_lock<std::mutex> lk(m_);
	if (state_ != "running" || !in_w_)
		throw rpc::Error(rpc::UNAVAILABLE, "overlay server is not running (" + state_ + ")");
	int64_t id = ++next_id_;
	uint64_t gen = generation_;
	json::Value msg = json::Value::object();
	msg.set("id", id);
	msg.set("op", op);
	for (const auto &m : extra.members())
		msg.set(m.first, m.second);
	std::string line = msg.dump() + "\n";
	{
		std::lock_guard<std::mutex> wl(write_m_);
		DWORD w = 0;
		if (!in_w_ || !WriteFile((HANDLE)in_w_, line.data(), (DWORD)line.size(), &w, nullptr) || w != line.size())
			throw rpc::Error(rpc::UNAVAILABLE, "overlay server is not reachable");
	}
	bool got = cv_.wait_for(lk, std::chrono::milliseconds(kReplyMs),
				[&] { return replies_.count(id) || generation_ != gen || stopping_; });
	auto it = replies_.find(id);
	if (!got || it == replies_.end())
		throw rpc::Error(rpc::UNAVAILABLE, "overlay server did not answer");
	json::Value r = std::move(it->second);
	replies_.erase(it);
	const json::Value *ok = r.find("ok");
	if (ok && ok->is_bool() && ok->as_bool()) {
		const json::Value *res = r.find("result");
		return res ? *res : json::Value::object();
	}
	const json::Value *e = r.find("error");
	throw rpc::Error(rpc::INTERNAL, "overlay: " + (e && e->is_string() ? clean_line(e->as_string()) : "error"));
}

bool Overlay::spawn(void *&out_r, void *&err_r, std::string &err)
{
	SECURITY_ATTRIBUTES sa = {sizeof(sa), nullptr, TRUE};
	HANDLE in_r = nullptr, in_w = nullptr, o_r = nullptr, o_w = nullptr, e_r = nullptr, e_w = nullptr;
	auto close_all = [&] {
		for (HANDLE h : {in_r, in_w, o_r, o_w, e_r, e_w})
			if (h)
				CloseHandle(h);
	};
	if (!CreatePipe(&in_r, &in_w, &sa, 0) || !CreatePipe(&o_r, &o_w, &sa, 0) || !CreatePipe(&e_r, &e_w, &sa, 0)) {
		close_all();
		err = "CreatePipe failed";
		return false;
	}
	// Our ends are not inheritable; the handle list below limits inheritance to the child's three ends anyway.
	SetHandleInformation(in_w, HANDLE_FLAG_INHERIT, 0);
	SetHandleInformation(o_r, HANDLE_FLAG_INHERIT, 0);
	SetHandleInformation(e_r, HANDLE_FLAG_INHERIT, 0);

	SIZE_T attr_size = 0;
	InitializeProcThreadAttributeList(nullptr, 1, 0, &attr_size);
	std::vector<unsigned char> attr_buf(attr_size);
	auto *attrs = (LPPROC_THREAD_ATTRIBUTE_LIST)attr_buf.data();
	HANDLE inherit[3] = {in_r, o_w, e_w};
	if (!InitializeProcThreadAttributeList(attrs, 1, 0, &attr_size) ||
	    !UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherit, sizeof(inherit), nullptr,
				       nullptr)) {
		close_all();
		err = "handle list setup failed";
		return false;
	}
	STARTUPINFOEXW si = {};
	si.StartupInfo.cb = sizeof(si);
	si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
	si.StartupInfo.hStdInput = in_r;
	si.StartupInfo.hStdOutput = o_w;
	si.StartupInfo.hStdError = e_w;
	si.lpAttributeList = attrs;

	std::wstring node = widen(cfg_.node), script = widen(cfg_.script);
	std::wstring cmd;
	append_arg(cmd, node);
	append_arg(cmd, script);
	append_arg(cmd, L"--root");
	append_arg(cmd, widen(cfg_.root));
	append_arg(cmd, L"--port");
	append_arg(cmd, std::to_wstring(cfg_.port));
	append_arg(cmd, L"--feed-port");
	append_arg(cmd, std::to_wstring(cfg_.feed_port));
	if (!cfg_.events_url.empty()) {
		append_arg(cmd, L"--events-url");
		append_arg(cmd, widen(cfg_.events_url));
	}
	std::wstring envb = env_block(cfg_.events_url.empty() ? std::string() : cfg_.events_token);
	std::wstring cwd = fs::u8path(cfg_.script).parent_path().wstring();
	PROCESS_INFORMATION pi = {};
	BOOL ok = CreateProcessW(node.c_str(), cmd.data(), nullptr, nullptr, TRUE,
				 CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT |
					 EXTENDED_STARTUPINFO_PRESENT,
				 envb.data(), cwd.empty() ? nullptr : cwd.c_str(), &si.StartupInfo, &pi);
	DWORD ce = ok ? 0 : GetLastError();
	SecureZeroMemory(envb.data(), envb.size() * sizeof(wchar_t));
	DeleteProcThreadAttributeList(attrs);
	CloseHandle(in_r);
	CloseHandle(o_w);
	CloseHandle(e_w);
	in_r = o_w = e_w = nullptr;
	if (!ok) {
		close_all();
		err = "CreateProcess failed (" + std::to_string(ce) + ")";
		return false;
	}
	if (!job_ || !AssignProcessToJobObject((HANDLE)job_, pi.hProcess)) {
		TerminateProcess(pi.hProcess, 1);
		CloseHandle(pi.hThread);
		CloseHandle(pi.hProcess);
		close_all();
		err = "cannot put the child in a job object";
		return false;
	}
	ResumeThread(pi.hThread);
	CloseHandle(pi.hThread);
	std::lock_guard<std::mutex> lk(m_);
	proc_ = pi.hProcess;
	pid_ = pi.dwProcessId;
	{
		std::lock_guard<std::mutex> wl(write_m_);
		in_w_ = in_w;
	}
	out_r = o_r;
	err_r = e_r;
	return true;
}

void Overlay::run()
{
	std::mt19937 rng{std::random_device{}()};
	std::uniform_real_distribution<double> jitter(0.5, 1.0);
	int streak = 0; // consecutive short-lived or failed starts
	for (bool first = true;; first = false) {
		{
			std::lock_guard<std::mutex> lk(m_);
			if (stopping_)
				break;
			state_ = "starting";
			if (!first)
				restarts_++;
		}
		void *out_r = nullptr, *err_r = nullptr;
		std::string err;
		uint64_t gen;
		{
			std::lock_guard<std::mutex> lk(m_);
			gen = generation_;
		}
		auto t0 = std::chrono::steady_clock::now();
		DWORD code = (DWORD)-1;
		if (spawn(out_r, err_r, err)) {
			hlog::info("overlay: child started (pid %lu)", pid_);
			std::thread ro([this, out_r, gen] { read_stdout(out_r, gen); });
			std::thread re([this, err_r] { read_stderr(err_r); });
			auto stop_seen = std::chrono::steady_clock::time_point{};
			for (;;) {
				if (WaitForSingleObject((HANDLE)proc_, 100) == WAIT_OBJECT_0)
					break;
				std::lock_guard<std::mutex> lk(m_);
				if (!stopping_)
					continue;
				auto now = std::chrono::steady_clock::now();
				if (stop_seen == std::chrono::steady_clock::time_point{})
					stop_seen = now;
				if (now - stop_seen > std::chrono::milliseconds(stop_timeout_ms_))
					TerminateJobObject((HANDLE)job_, 1);
			}
			GetExitCodeProcess((HANDLE)proc_, &code);
			ro.join();
			re.join();
			close_h(out_r);
			close_h(err_r);
			std::lock_guard<std::mutex> lk(m_);
			close_h(proc_);
			{
				std::lock_guard<std::mutex> wl(write_m_);
				close_h(in_w_);
			}
			pid_ = 0;
			last_exit_ = (long)code;
			generation_++;
			replies_.clear();
		} else {
			std::lock_guard<std::mutex> lk(m_);
			last_error_ = err;
		}
		cv_.notify_all();
		std::unique_lock<std::mutex> lk(m_);
		if (stopping_)
			break;
		if (code == kExitBadArgs) {
			state_ = "failed";
			last_error_ = "the overlay child refused its arguments (exit 64)";
			hlog::error("overlay: %s; not restarting", last_error_.c_str());
			cv_.notify_all();
			break;
		}
		failures_++;
		if (std::chrono::steady_clock::now() - t0 > std::chrono::milliseconds(kStableMs))
			streak = 0;
		streak++;
		double base = kBackoffBaseMs * (double)(1u << (streak > 6 ? 5 : streak - 1));
		int delay = (int)((base > kBackoffCapMs ? kBackoffCapMs : base) * jitter(rng));
		state_ = "backoff";
		hlog::warn("overlay: child %s (exit %ld); restart in %d ms", err.empty() ? "exited" : err.c_str(),
			   last_exit_, delay);
		cv_.wait_for(lk, std::chrono::milliseconds(delay), [&] { return stopping_; });
	}
	std::lock_guard<std::mutex> lk(m_);
	if (state_ != "failed")
		state_ = "stopped";
	cv_.notify_all();
}

void Overlay::read_stdout(void *h, uint64_t gen)
{
	std::string buf;
	char chunk[4096];
	DWORD n = 0;
	while (ReadFile((HANDLE)h, chunk, sizeof(chunk), &n, nullptr) && n) {
		buf.append(chunk, n);
		if (buf.size() > (1 << 20)) // one line never gets this long; drop rather than grow
			buf.clear();
		size_t p;
		while ((p = buf.find('\n')) != std::string::npos) {
			std::string line = buf.substr(0, p);
			buf.erase(0, p + 1);
			json::ParseResult pr = json::parse(line, 16);
			if (!pr.ok || !pr.value.is_object())
				continue;
			const json::Value *t = pr.value.find("type");
			if (!t || !t->is_string())
				continue;
			std::lock_guard<std::mutex> lk(m_);
			if (generation_ != gen)
				continue;
			if (t->as_string() == "ready") {
				const json::Value *sp = pr.value.find("staticPort"), *fp = pr.value.find("feedPort");
				if (!sp || !fp || !sp->is_int() || !fp->is_int())
					continue;
				uint16_t s = (uint16_t)sp->as_int(), f = (uint16_t)fp->as_int();
				if (s == kStreamerbotPort || f == kStreamerbotPort)
					continue;
				static_port_ = s;
				feed_port_ = f;
				child_env_ = json::Value::array();
				if (const json::Value *ek = pr.value.find("envKeys"); ek && ek->is_array())
					for (auto &k : ek->as_array())
						if (k.is_string() && child_env_.size() < 64)
							child_env_.push(clean_line(k.as_string().substr(0, 64)));
				const json::Value *et = pr.value.find("eventToken");
				child_token_ = et && et->is_bool() && et->as_bool();
				const json::Value *ms = pr.value.find("micSource");
				mic_source_ = ms && ms->is_string() && valid_audio_id(ms->as_string()) ? ms->as_string() : "";
				cfg_.port = s; // pinned: browser layer URLs stay valid across restarts
				cfg_.feed_port = f;
				state_ = "running";
				last_error_.clear();
				hlog::info("overlay: ready (static 127.0.0.1:%u, feed 127.0.0.1:%u, mic feed %s)", s, f,
					   mic_source_.empty() ? "off" : ("audio:" + mic_source_).c_str());
				cv_.notify_all();
			} else if (t->as_string() == "reply") {
				const json::Value *id = pr.value.find("id");
				if (id && id->is_int()) {
					replies_[id->as_int()] = std::move(pr.value);
					cv_.notify_all();
				}
			}
		}
	}
}

void Overlay::read_stderr(void *h)
{
	std::string buf;
	char chunk[4096];
	DWORD n = 0;
	while (ReadFile((HANDLE)h, chunk, sizeof(chunk), &n, nullptr) && n) {
		buf.append(chunk, n);
		size_t p;
		while ((p = buf.find('\n')) != std::string::npos) {
			std::string line = buf.substr(0, p);
			buf.erase(0, p + 1);
			if (!line.empty() && line.back() == '\r')
				line.pop_back();
			if (!line.empty())
				hlog::info("overlay: %s", clean_line(line).c_str());
		}
		if (buf.size() > 4096) {
			hlog::info("overlay: %s", clean_line(buf).c_str());
			buf.clear();
		}
	}
}
