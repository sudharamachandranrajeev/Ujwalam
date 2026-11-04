// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: clip markers and feedback captures. See moments.h.
#include "moments.h"
#include "app.h"
#include "discovery.h"
#include "log.h"

#include <windows.h>

#include <filesystem>
#include <fstream>

namespace fs = std::filesystem;
using rpc::Error;

namespace {

json::Value active_scenes(App &a)
{
	json::Value s = json::Value::object();
	s.set("H", json::Value());
	s.set("V", json::Value());
	json::Value cs = a.studio->canvases_json(); // keep the temporary alive for the loop
	for (auto &c : cs.as_array()) {
		const json::Value *id = c.find("id");
		const json::Value *act = c.find("active");
		if (id && id->is_string() && act)
			s.set(id->as_string(), *act);
	}
	return s;
}

std::string clean_note(const std::string &n)
{
	std::string s = n;
	for (char &c : s)
		if ((unsigned char)c < 0x20 || c == 0x7f)
			c = ' ';
	return s;
}

// Writes text to path through a temp file and a replace, so a reader never sees half a file.
bool write_atomic(const fs::path &path, const std::string &text, std::string &err)
{
	fs::path tmp = path;
	tmp += ".tmp";
	{
		std::ofstream f(tmp, std::ios::binary | std::ios::trunc);
		if (!f) {
			err = "cannot write " + tmp.filename().u8string();
			return false;
		}
		f << text;
		if (!f.good()) {
			err = "write failed";
			return false;
		}
	}
	if (!MoveFileExW(tmp.wstring().c_str(), path.wstring().c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
		err = "rename failed (error " + std::to_string(GetLastError()) + ")";
		return false;
	}
	return true;
}

} // namespace

Moments::Moments(App &app, Config c) : app_(app), cfg_(std::move(c))
{
	worker_ = std::thread([this] { run(); });
}

Moments::~Moments()
{
	stop();
}

void Moments::stop()
{
	{
		std::lock_guard<std::mutex> l(qm_);
		stop_ = true;
		qcv_.notify_all();
	}
	if (worker_.joinable())
		worker_.join();
}

json::Value Moments::marker_add(const std::string &source, const std::string &note)
{
	if (source != "hotkey" && source != "chat" && source != "audio" && source != "api")
		throw Error(rpc::INVALID_PARAMS, "source must be hotkey, chat, audio or api");
	if (note.size() > 500)
		throw Error(rpc::INVALID_PARAMS, "note: at most 500 bytes");
	int64_t stream_ms = -1, record_ms = -1;
	app_.outputs->clocks(stream_ms, record_ms);
	json::Value m = json::Value::object();
	m.set("v", 1);
	m.set("at", hlog::utc_now());
	m.set("source", source);
	if (!note.empty())
		m.set("note", clean_note(note));
	m.set("hostMs", (int64_t)(GetTickCount64() - app_.start_tick));
	m.set("streamMs", stream_ms >= 0 ? json::Value(stream_ms) : json::Value());
	m.set("recordMs", record_ms >= 0 ? json::Value(record_ms) : json::Value());
	m.set("scenes", active_scenes(app_));
	fs::path file = fs::u8path(cfg_.markers_dir) / fs::u8path(cfg_.session + ".jsonl");
	std::string err;
	{
		std::lock_guard<std::mutex> l(m_);
		if (!discovery::ensure_dir(cfg_.markers_dir, err))
			throw Error(rpc::INTERNAL, "markers dir: " + err);
		std::ofstream f(file, std::ios::binary | std::ios::app);
		if (!f)
			throw Error(rpc::INTERNAL, "cannot open the markers file");
		f << m.dump() << "\n";
		f.flush();
		if (!f.good())
			throw Error(rpc::INTERNAL, "markers file write failed");
		markers_++;
	}
	hlog::info("marker (%s) stream %lld ms, record %lld ms", source.c_str(), (long long)stream_ms, (long long)record_ms);
	json::Value r = json::Value::object();
	r.set("marker", std::move(m));
	r.set("file", file.generic_u8string());
	return r;
}

json::Value Moments::feedback_capture(const std::string &trigger, const std::string &note)
{
	if (note.size() > 2000)
		throw Error(rpc::INVALID_PARAMS, "note: at most 2000 bytes");
	{
		std::lock_guard<std::mutex> l(qm_);
		if (stop_)
			throw Error(rpc::UNAVAILABLE, "the host is shutting down");
		if (q_.size() >= 8)
			throw Error(rpc::CONFLICT, "8 feedback captures are already waiting for their replay saves");
	}
	SYSTEMTIME t;
	GetLocalTime(&t);
	char day[16], tod[16];
	snprintf(day, sizeof(day), "%04u-%02u-%02u", t.wYear, t.wMonth, t.wDay);
	snprintf(tod, sizeof(tod), "%02u%02u%02u", t.wHour, t.wMinute, t.wSecond);
	std::string err;
	fs::path base = fs::u8path(cfg_.feedback_dir) / day;
	if (!discovery::ensure_dir(base.generic_u8string(), err))
		throw Error(rpc::INTERNAL, "feedback dir: " + err);
	fs::path dir;
	{
		std::lock_guard<std::mutex> l(m_);
		for (int i = 1; i < 100; i++) {
			fs::path d = base / (i == 1 ? std::string(tod) : std::string(tod) + "-" + std::to_string(i));
			if (CreateDirectoryW(d.wstring().c_str(), nullptr)) {
				dir = d;
				break;
			}
			if (GetLastError() != ERROR_ALREADY_EXISTS)
				break;
		}
		if (dir.empty())
			throw Error(rpc::INTERNAL, "cannot create the feedback folder");
		captures_++;
		last_capture_ = dir.generic_u8string();
	}

	// log.txt: the newest 200 lines (token-shaped hex already redacted by the ring). One ring entry can hold a
	// multi-line libobs message, so entries are split and only the last 200 physical lines are kept.
	unsigned long long total = 0;
	std::vector<std::string> lines;
	for (auto &e : hlog::tail(200, &total)) {
		size_t at = 0;
		for (;;) {
			size_t nl = e.find('\n', at);
			std::string part = e.substr(at, nl == std::string::npos ? std::string::npos : nl - at);
			if (!part.empty() && part.back() == '\r')
				part.pop_back();
			lines.push_back(std::move(part));
			if (nl == std::string::npos)
				break;
			at = nl + 1;
		}
	}
	if (lines.size() > 200)
		lines.erase(lines.begin(), lines.end() - 200);
	std::string log;
	for (auto &l : lines)
		log += l + "\n";
	write_atomic(dir / "log.txt", log, err);

	json::Value status = host_status_json(app_);
	json::Value stats = json::Value::object();
	for (const char *k : {"cpuPct", "gpuPct", "droppedFrames", "totalFrames", "fps", "live", "recording"})
		if (const json::Value *v = status.find(k))
			stats.set(k, *v);
	if (const json::Value *r = status.find("render"))
		for (const char *k : {"renderLagged", "renderTotal", "encodeSkipped", "encodeTotal", "avgFrameTimeMs"})
			if (const json::Value *v = r->find(k))
				stats.set(k, *v);
	int64_t stream_ms = -1, record_ms = -1;
	app_.outputs->clocks(stream_ms, record_ms);
	stats.set("streamMs", stream_ms >= 0 ? json::Value(stream_ms) : json::Value());
	stats.set("recordMs", record_ms >= 0 ? json::Value(record_ms) : json::Value());

	json::Value m = json::Value::object();
	m.set("v", 1);
	m.set("kind", "feedback");
	m.set("at", hlog::utc_now());
	m.set("local", std::string(day) + " " + tod);
	m.set("trigger", trigger);
	m.set("version", app_.version);
	m.set("hostStartedAt", app_.started_at);
	m.set("session", cfg_.session);
	if (!note.empty())
		m.set("note", clean_note(note));
	m.set("scenes", active_scenes(app_));
	m.set("stats", std::move(stats));
	m.set("status", std::move(status));
	json::Value lg = json::Value::object();
	lg.set("file", "log.txt");
	lg.set("lines", (uint64_t)lines.size());
	lg.set("totalSinceStart", (uint64_t)total);
	m.set("log", std::move(lg));
	json::Value rp = json::Value::object();
	rp.set("state", "pending");
	m.set("replay", std::move(rp));
	json::Value vn = json::Value::object();
	vn.set("done", false);
	vn.set("reason", "voice note not implemented in Alpha 0 day 2");
	m.set("voiceNote", std::move(vn));
	write_atomic(dir / "moment.json", m.dump() + "\n", err);

	{
		std::lock_guard<std::mutex> l(qm_);
		q_.push_back({dir.generic_u8string(), m});
		qcv_.notify_all();
	}
	hlog::info("feedback capture (%s) started", trigger.c_str());
	json::Value r = json::Value::object();
	r.set("dir", dir.generic_u8string());
	r.set("replay", "pending");
	return r;
}

void Moments::run()
{
	for (;;) {
		Job j;
		{
			std::unique_lock<std::mutex> l(qm_);
			qcv_.wait(l, [&] { return stop_ || !q_.empty(); });
			if (q_.empty())
				return; // stop_ and nothing left
			j = std::move(q_.front());
			q_.pop_front();
			busy_++;
		}
		json::Value res = app_.outputs->replay_save("", j.dir, "replay-{canvas}", 15000);
		json::Value rp = json::Value::object();
		rp.set("state", "done");
		json::Value saved = json::Value::array();
		if (const json::Value *s = res.find("saved"))
			for (auto &x : s->as_array()) {
				json::Value y = json::Value::object();
				y.set("canvas", *x.find("canvas"));
				y.set("file", fs::u8path(x.find("path")->as_string()).filename().u8string());
				y.set("bytes", *x.find("bytes"));
				y.set("rung", *x.find("rung"));
				y.set("fallback", *x.find("fallback"));
				saved.push(std::move(y));
			}
		rp.set("saved", std::move(saved));
		rp.set("errors", res.find("errors") ? *res.find("errors") : json::Value::array());
		rp.set("seconds", *app_.outputs->replay_status().find("seconds"));
		j.moment.set("replay", std::move(rp));
		std::string err;
		if (!write_atomic(fs::u8path(j.dir) / "moment.json", j.moment.dump() + "\n", err))
			hlog::warn("feedback moment.json: %s", err.c_str());
		hlog::info("feedback capture done: %zu replay file(s), %zu error(s)", j.moment.find("replay")->find("saved")->size(),
			   j.moment.find("replay")->find("errors")->size());
		std::lock_guard<std::mutex> l(qm_);
		busy_--;
	}
}

json::Value Moments::status() const
{
	json::Value o = json::Value::object();
	{
		std::lock_guard<std::mutex> l(m_);
		o.set("markersDir", cfg_.markers_dir);
		o.set("markersFile", (fs::u8path(cfg_.markers_dir) / fs::u8path(cfg_.session + ".jsonl")).generic_u8string());
		o.set("feedbackDir", cfg_.feedback_dir);
		o.set("session", cfg_.session);
		o.set("markers", markers_);
		o.set("captures", captures_);
		o.set("lastCapture", last_capture_.empty() ? json::Value() : json::Value(last_capture_));
	}
	std::lock_guard<std::mutex> l(const_cast<std::mutex &>(qm_));
	o.set("queued", (uint64_t)q_.size());
	o.set("busy", busy_);
	return o;
}
