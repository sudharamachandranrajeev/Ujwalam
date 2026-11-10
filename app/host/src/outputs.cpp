// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: output graph (O1). See outputs.h.
//
// configure params (built by app/host/lib/outputs-plan.mjs from an O0 output config that passed
// services/outputs/validate.mjs against data/platforms/*.json):
//   { "rungs": [ { "id", "canvas": "H"|"V", "codec": "h264"|"hevc"|"av1", "encoder": "nvenc"|"x264",
//                  "rc": "cbr"|"vbr"|"cqp", "w", "h", "fps", "bitrate" (kbps), "gopSec",
//                  "options": { "preset", "tune", "profile", "bf", "multipass", "lookahead" } } ],
//     "audio": { "bitrate" (kbps), "sampleRate": 48000 },
//     "sinks": [ { "id", "rung", "platform", "proto", "priority",
//                  "target": { "transport": "rtmp", "port", "app", "stream" | "keyRef" }          (loopback)
//                          | { "transport": "rtmp"|"rtmps", "url" | "urlRef", "keyRef" }      (real; --allow-live)
//                          | { "transport": "srt", "port", "latencyMs" }
//                          | { "transport": "file", "name": "<base>.mkv", "unsafeContainer"?: true for .mp4|.flv|.ts } } ],
//     "policy": { "dropThresholdMs", "pframeDropThresholdMs", "retryBaseMs", "retryCapMs", "retryMax",
//                 "retryResetLiveMs" } }
//
// Locking: op_m_ serialises everything that calls into libobs outputs (configure, start, stop, supervisor
// retries, probe). m_ guards sink state and is the only lock the libobs signal handlers take. obs_output_start,
// obs_output_stop and releases are never called with m_ held, and never from a signal handler.
#include "outputs.h"
#include "log.h"
#include "obs_runtime.h"
#include "rpc_server.h"
#include "stats.h"
#include "stream_keys.h"
#include "studio.h"

#include <util/platform.h>

#include <windows.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstring>
#include <ctime>
#include <functional>
#include <filesystem>
#include <random>
#include <regex>
#include <set>

namespace fs = std::filesystem;
using rpc::Error;

enum class SinkState { Idle, Starting, Live, Retrying, Stopping, Stopped, Failed };

static const char *state_name(SinkState s)
{
	switch (s) {
	case SinkState::Idle:
		return "idle";
	case SinkState::Starting:
		return "starting";
	case SinkState::Live:
		return "live";
	case SinkState::Retrying:
		return "retrying";
	case SinkState::Stopping:
		return "stopping";
	case SinkState::Stopped:
		return "stopped";
	case SinkState::Failed:
		return "failed";
	}
	return "?";
}

struct Outputs::Sink {
	Outputs *owner = nullptr;
	std::string id, kind, platform, proto, rung_id, transport;
	int priority = 0;
	std::string url;          // loopback: 127.0.0.1, built here; live: the validated ingest URL (public data)
	std::string stream_name;  // rtmp stream path segment (loopback only; not a secret)
	bool live_target = false; // a real ingest (--allow-live only)
	std::string key_ref;      // Credential Manager target holding the stream key (never the key)
	std::string url_ref;      // Credential Manager target holding a per-account ingest URL (live only)
	bool bandwidth_test = false; // twitch + keyRef + --twitch-bandwidth-test: key gets ?bandwidthtest=true at connect
	bool key_present = false, url_present = false; // last presence check (configure, each start attempt)
	std::string file_base, file_ext, path;
	Rung *rung = nullptr;
	obs_output_t *out = nullptr;
	obs_service_t *svc = nullptr;

	SinkState state = SinkState::Idle;
	bool want = false;        // the user asked for it to run
	bool stop_pending = false; // went live after a stop request: the supervisor stops it
	int attempts = 0;         // starts since configure
	int fails = 0;            // consecutive failures (backoff exponent)
	int retries = 0;          // retries since configure
	int last_code = 0;
	std::string last_error;
	int64_t live_since_ms = 0, next_retry_ms = 0, last_change_ms = 0;
	// bitrate sampling for status (guarded by m_)
	mutable uint64_t sample_bytes = 0;
	mutable int64_t sample_ms = 0;
	mutable double kbps = 0;
};

namespace {

int64_t now_ms()
{
	return (int64_t)(os_gettime_ns() / 1000000ULL);
}

const std::regex &id_re()
{
	static const std::regex re("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$");
	return re;
}

void only_keys(const json::Value &o, std::initializer_list<const char *> keys, const std::string &what)
{
	if (!o.is_object())
		throw Error(rpc::INVALID_PARAMS, what + " must be an object");
	for (auto &m : o.members()) {
		bool ok = false;
		for (const char *k : keys)
			if (m.first == k)
				ok = true;
		if (!ok)
			throw Error(rpc::INVALID_PARAMS, what + ": unknown field " + json::Value(m.first.substr(0, 32)).dump());
	}
}

std::string req_str(const json::Value &o, const char *k, const std::string &what, size_t max = 64)
{
	const json::Value *v = o.find(k);
	if (!v || !v->is_string() || v->as_string().empty() || v->as_string().size() > max)
		throw Error(rpc::INVALID_PARAMS, what + ": bad or missing " + k);
	return v->as_string();
}

std::string req_id(const json::Value &o, const char *k, const std::string &what)
{
	std::string s = req_str(o, k, what);
	if (!std::regex_match(s, id_re()))
		throw Error(rpc::INVALID_PARAMS, what + ": bad " + k);
	return s;
}

int64_t req_int(const json::Value &o, const char *k, int64_t lo, int64_t hi, const std::string &what)
{
	const json::Value *v = o.find(k);
	if (!v || !v->is_int() || v->as_int() < lo || v->as_int() > hi)
		throw Error(rpc::INVALID_PARAMS, what + ": bad or missing " + k);
	return v->as_int();
}

int64_t opt_int(const json::Value &o, const char *k, int64_t def, int64_t lo, int64_t hi, const std::string &what)
{
	if (!o.find(k))
		return def;
	return req_int(o, k, lo, hi, what);
}

std::string one_of(const std::string &v, std::initializer_list<const char *> allowed, const std::string &what)
{
	for (const char *a : allowed)
		if (v == a)
			return v;
	throw Error(rpc::INVALID_PARAMS, what + ": unsupported value");
}

std::string nvenc_id(const std::string &codec)
{
	if (codec == "h264")
		return "obs_nvenc_h264_tex";
	if (codec == "hevc")
		return "obs_nvenc_hevc_tex";
	return "obs_nvenc_av1_tex";
}

bool is_nvenc(const std::string &encoder_id)
{
	return encoder_id.rfind("obs_nvenc_", 0) == 0;
}

std::string stamp()
{
	SYSTEMTIME t;
	GetLocalTime(&t);
	char b[32];
	snprintf(b, sizeof(b), "%04u%02u%02u-%02u%02u%02u", t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond);
	return b;
}

// ---- delivery services -----------------------------------------------------------------------------------
// Private libobs services; rtmp-services (which fetches from obsproject.com) stays disabled.
//   ujwalam_loopback: only ever hands out the URL the host built (127.0.0.1).
//   ujwalam_live:     a real ingest (rtmp:// or rtmps://), only when the host runs with --allow-live (A0).
// A stream key never enters obs_data settings: the service holds only the Credential Manager target name (keyRef,
// and urlRef for a per-account ingest URL). rtmp_output asks for the connect info on its connect thread
// (rtmp-stream.c init_connect); the service reads the credential into its own fixed buffer then, rtmp_output copies
// it, and the host wipes the buffer when the attempt ends (start or stop signal) or fails to start (svc_wipe).
std::atomic<bool> g_allow_live{false};

struct Svc {
	bool live = false;
	bool bw_test = false; // append kBwSuffix to the key on the connect thread (Twitch bandwidth test)
	std::string protocol, url, stream, key_ref, url_ref;
	std::mutex m;
	char key[streamkeys::kCap] = {};
	char rurl[streamkeys::kCap] = {};
};

void svc_wipe(Svc *s)
{
	if (!s)
		return;
	std::lock_guard<std::mutex> l(s->m);
	streamkeys::wipe(s->key, sizeof(s->key));
	streamkeys::wipe(s->rurl, sizeof(s->rurl));
}

const char *svc_name_loop(void *)
{
	return "Ujwalam loopback";
}

const char *svc_name_live(void *)
{
	return "Ujwalam live";
}

// Twitch bandwidth-test mode: appended to the stream key at connect time only (runtime, never stored).
constexpr char kBwSuffix[] = "?bandwidthtest=true";

// Appends kBwSuffix to key[0..len) in place. False (the caller wipes the key) when the key already carries a query or
// the result would not fit: never guess how to merge, never truncate.
bool append_bw_suffix(char *key, size_t cap, size_t len)
{
	constexpr size_t n = sizeof(kBwSuffix) - 1;
	if (len == 0 || memchr(key, '?', len) || len + n >= cap)
		return false;
	memcpy(key + len, kBwSuffix, n + 1);
	return true;
}

void svc_apply(Svc *s, obs_data_t *settings)
{
	s->protocol = obs_data_get_string(settings, "protocol");
	s->url = obs_data_get_string(settings, "server");
	s->stream = obs_data_get_string(settings, "stream");
	s->key_ref = obs_data_get_string(settings, "key_ref");
	s->url_ref = obs_data_get_string(settings, "url_ref");
	s->bw_test = obs_data_get_bool(settings, "bandwidth_test");
}

void *svc_create_loop(obs_data_t *settings, obs_service_t *)
{
	auto *s = new Svc;
	svc_apply(s, settings);
	return s;
}

void *svc_create_live(obs_data_t *settings, obs_service_t *)
{
	auto *s = new Svc;
	s->live = true;
	svc_apply(s, settings);
	return s;
}

void svc_destroy(void *d)
{
	auto *s = static_cast<Svc *>(d);
	svc_wipe(s);
	delete s;
}

void svc_update(void *d, obs_data_t *settings)
{
	auto *s = static_cast<Svc *>(d);
	std::lock_guard<std::mutex> l(s->m);
	svc_apply(s, settings);
}

const char *svc_protocol(void *d)
{
	return static_cast<Svc *>(d)->protocol.c_str();
}

const char *svc_output_type(void *d)
{
	return static_cast<Svc *>(d)->protocol == "SRT" ? "ffmpeg_mpegts_muxer" : "rtmp_output";
}

const char *svc_connect_info(void *d, uint32_t type)
{
	auto *s = static_cast<Svc *>(d);
	std::lock_guard<std::mutex> l(s->m);
	size_t len = 0;
	switch ((enum obs_service_connect_info)type) {
	case OBS_SERVICE_CONNECT_INFO_SERVER_URL:
		if (s->url_ref.empty())
			return s->url.c_str();
		// Per-account ingest URL (Kick): read now, checked again here (it is user data).
		if (streamkeys::read(s->url_ref, s->rurl, sizeof(s->rurl), len) != streamkeys::Read::Ok ||
		    !Outputs::valid_live_url(s->rurl, s->protocol == "RTMPS" ? "rtmps" : "rtmp")) {
			streamkeys::wipe(s->rurl, sizeof(s->rurl));
			return ""; // rtmp_output: "URL is empty", OBS_OUTPUT_BAD_PATH
		}
		return s->rurl;
	case OBS_SERVICE_CONNECT_INFO_STREAM_KEY: // rtmp stream path; for SRT this is the stream id (empty)
		if (s->protocol == "SRT")
			return "";
		if (s->key_ref.empty())
			return s->stream.c_str(); // loopback stream name (not a secret)
		if (streamkeys::read(s->key_ref, s->key, sizeof(s->key), len) != streamkeys::Read::Ok ||
		    (s->bw_test && !append_bw_suffix(s->key, sizeof(s->key), len)))
			streamkeys::wipe(s->key, sizeof(s->key)); // empty key: the connect fails (never a key without the suffix)
		return s->key;
	default:
		return nullptr;
	}
}

bool svc_can_connect_loop(void *d)
{
	auto *s = static_cast<Svc *>(d);
	// Belt and braces: whatever the settings say, only 127.0.0.1 URLs connect.
	return s->url.rfind("rtmp://127.0.0.1:", 0) == 0 || s->url.rfind("srt://127.0.0.1:", 0) == 0;
}

bool svc_can_connect_live(void *d)
{
	auto *s = static_cast<Svc *>(d);
	if (!g_allow_live.load() || s->key_ref.empty())
		return false;
	if (!s->url_ref.empty())
		return true; // read and checked on the connect thread
	return Outputs::valid_live_url(s->url, s->protocol == "RTMPS" ? "rtmps" : "rtmp");
}

const char *video_codecs[] = {"h264", "hevc", "av1", nullptr};
const char *audio_codecs[] = {"aac", nullptr};

const char **svc_video_codecs(void *)
{
	return video_codecs;
}

const char **svc_audio_codecs(void *)
{
	return audio_codecs;
}

} // namespace

void Outputs::register_loopback_service()
{
	struct obs_service_info si = {};
	si.id = "ujwalam_loopback";
	si.get_name = svc_name_loop;
	si.create = svc_create_loop;
	si.destroy = svc_destroy;
	si.update = svc_update;
	si.get_protocol = svc_protocol;
	si.get_output_type = svc_output_type;
	si.get_connect_info = svc_connect_info;
	si.can_try_to_connect = svc_can_connect_loop;
	si.get_supported_video_codecs = svc_video_codecs;
	si.get_supported_audio_codecs = svc_audio_codecs;
	obs_register_service(&si);

	struct obs_service_info li = si;
	li.id = "ujwalam_live";
	li.get_name = svc_name_live;
	li.create = svc_create_live;
	li.can_try_to_connect = svc_can_connect_live;
	obs_register_service(&li);
}

// rtmp[s]://<dns name with a dot, not an IP literal, not localhost>[:port][/path] -- no userinfo, query or fragment,
// so a key can never ride in the URL. The scheme must equal the target's transport.
bool Outputs::valid_live_url(const std::string &url, const std::string &transport)
{
	if (url.size() > 256)
		return false;
	static const std::regex re("^(rtmps?)://(([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+([a-z][a-z0-9-]{0,61}[a-z0-9]))"
				   "(:([0-9]{1,5}))?((/[A-Za-z0-9._~-]+)*/?)$",
				   std::regex::icase);
	std::smatch m;
	if (!std::regex_match(url, m, re))
		return false;
	std::string scheme = m[1];
	for (char &c : scheme)
		c = (char)tolower((unsigned char)c);
	if (scheme != transport)
		return false;
	if (m[7].matched) {
		long p = std::stol(m[7].str());
		if (p < 1 || p > 65535)
			return false;
	}
	return true;
}

// A per-account ingest URL stored in Credential Manager: present and well-formed (read into a scratch buffer, wiped).
static bool check_url_ref(const std::string &ref, const std::string &transport)
{
	char buf[streamkeys::kCap];
	size_t len = 0;
	bool ok = streamkeys::read(ref, buf, sizeof(buf), len) == streamkeys::Read::Ok &&
		  Outputs::valid_live_url(std::string(buf, len), transport);
	streamkeys::wipe(buf, sizeof(buf));
	return ok;
}

// ---- signals ---------------------------------------------------------------------------------------------

void on_sink_start(void *data, calldata_t *)
{
	auto *s = static_cast<Outputs::Sink *>(data);
	s->owner->on_start(*s);
}

void on_sink_stop(void *data, calldata_t *cd)
{
	auto *s = static_cast<Outputs::Sink *>(data);
	int code = (int)calldata_int(cd, "code");
	const char *err = calldata_string(cd, "last_error");
	s->owner->on_stop(*s, code, err);
}

// The connect attempt is over (rtmp_output copied the connect info before connecting): wipe the service's buffers.
static void wipe_sink_secrets(Outputs::Sink &s)
{
	if (s.svc)
		svc_wipe(static_cast<Svc *>(obs_obj_get_data(s.svc)));
}

void Outputs::on_start(Sink &s)
{
	wipe_sink_secrets(s);
	std::lock_guard<std::mutex> l(m_);
	int64_t now = now_ms();
	s.state = SinkState::Live;
	s.live_since_ms = now;
	s.last_change_ms = now;
	s.sample_bytes = 0;
	s.sample_ms = now;
	s.kbps = 0;
	if (!s.want) // stop was requested while it was still connecting
		s.stop_pending = true;
	update_clocks_locked(now);
	hlog::info("sink %s live (attempt %d)", s.id.c_str(), s.attempts);
	sup_cv_.notify_all();
}

// libobs's last_error can carry text a server sent back. If it ever contains the stream key, it is withheld from
// outputs.status (the key is read into a scratch buffer for the comparison and wiped).
static bool error_has_key(const Outputs::Sink &s, const char *err)
{
	if (!err || !*err || s.key_ref.empty())
		return false;
	char buf[streamkeys::kCap];
	size_t len = 0;
	bool hit = streamkeys::read(s.key_ref, buf, sizeof(buf), len) == streamkeys::Read::Ok && len >= 4 &&
		   strstr(err, buf) != nullptr;
	streamkeys::wipe(buf, sizeof(buf));
	return hit;
}

void Outputs::on_stop(Sink &s, int code, const char *err)
{
	wipe_sink_secrets(s);
	if (error_has_key(s, err))
		err = "output error text withheld (it contained the stream key)";
	std::lock_guard<std::mutex> l(m_);
	int64_t now = now_ms();
	int64_t live_for = s.state == SinkState::Live && s.live_since_ms ? now - s.live_since_ms : 0;
	if (live_for >= policy_.retry_reset_live_ms)
		s.fails = 0;
	s.last_code = code;
	if (err && *err)
		s.last_error = err;
	else if (code != OBS_OUTPUT_SUCCESS)
		s.last_error = "output stopped with code " + std::to_string(code);
	s.live_since_ms = 0;
	s.last_change_ms = now;
	s.stop_pending = false;
	if (!s.want) {
		s.state = SinkState::Stopped;
		hlog::info("sink %s stopped (code %d)", s.id.c_str(), code);
	} else if (s.kind == "record") {
		// A recording that stops on its own is not retried: a new file would hide the gap.
		s.want = false;
		s.state = code == OBS_OUTPUT_SUCCESS ? SinkState::Stopped : SinkState::Failed;
		hlog::warn("record sink %s stopped unexpectedly (code %d)", s.id.c_str(), code);
	} else {
		hlog::warn("sink %s dropped (code %d, live %lld ms)", s.id.c_str(), code, (long long)live_for);
		schedule_retry_locked(s, now);
	}
	update_clocks_locked(now);
	sup_cv_.notify_all();
}

// Marker clocks. Streaming period: from the first stream sink going live while any stream sink is wanted or
// running (a reconnect keeps the clock), until none is. Recording: from a record sink going live until none runs.
void Outputs::update_clocks_locked(int64_t now)
{
	bool s_live = false, s_on = false, r_live = false, r_on = false;
	for (auto &x : sinks_) {
		bool live = x->state == SinkState::Live;
		bool on = x->want || live || x->state == SinkState::Starting || x->state == SinkState::Retrying;
		if (x->kind == "stream") {
			s_live = s_live || live;
			s_on = s_on || on;
		} else {
			r_live = r_live || live;
			r_on = r_on || on;
		}
	}
	if (s_live && !stream_since_ms_)
		stream_since_ms_ = now;
	if (!s_on)
		stream_since_ms_ = 0;
	if (r_live && !record_since_ms_)
		record_since_ms_ = now;
	if (!r_on)
		record_since_ms_ = 0;
}

void Outputs::clocks(int64_t &stream_ms, int64_t &record_ms) const
{
	std::lock_guard<std::mutex> l(m_);
	int64_t now = now_ms();
	stream_ms = stream_since_ms_ ? now - stream_since_ms_ : -1;
	record_ms = record_since_ms_ ? now - record_since_ms_ : -1;
}

void Outputs::schedule_retry_locked(Sink &s, int64_t now)
{
	static std::mt19937 rng{std::random_device{}()};
	s.fails++;
	if (policy_.retry_max > 0 && s.fails > policy_.retry_max) {
		s.state = SinkState::Failed;
		s.want = false;
		hlog::warn("sink %s failed after %d consecutive attempts", s.id.c_str(), s.fails);
		return;
	}
	double exp = std::min(30, s.fails - 1);
	double base = std::min((double)policy_.retry_cap_ms, policy_.retry_base_ms * std::pow(2.0, exp));
	double jitter = 0.5 + 0.5 * std::uniform_real_distribution<double>(0.0, 1.0)(rng);
	int64_t delay = std::max<int64_t>(100, (int64_t)(base * jitter));
	s.state = SinkState::Retrying;
	s.next_retry_ms = now + delay;
	s.last_change_ms = now;
	hlog::info("sink %s retry %d in %lld ms", s.id.c_str(), s.fails, (long long)delay);
}

// ---- lifecycle -------------------------------------------------------------------------------------------

Outputs::Outputs(Studio &studio, std::string recordings_dir, bool allow_live, bool twitch_bandwidth_test)
	: studio_(studio), rec_dir_(std::move(recordings_dir)), allow_live_(allow_live),
	  twitch_bw_test_(twitch_bandwidth_test)
{
	g_allow_live = allow_live;
	sup_ = std::thread([this] { supervise(); });
}

Outputs::~Outputs()
{
	stop_all(5000);
	sup_stop_ = true;
	{
		std::lock_guard<std::mutex> l(m_);
		sup_cv_.notify_all();
	}
	if (sup_.joinable())
		sup_.join();
	std::lock_guard<std::mutex> op(op_m_);
	release_graph();
}

void Outputs::supervise()
{
	while (!sup_stop_) {
		std::vector<std::string> due_start, due_stop;
		{
			std::unique_lock<std::mutex> l(m_);
			int64_t now = now_ms();
			int64_t wake = now + 1000;
			for (auto &s : sinks_) {
				if (s->state == SinkState::Retrying && s->want) {
					if (s->next_retry_ms <= now)
						due_start.push_back(s->id);
					else
						wake = std::min(wake, s->next_retry_ms);
				}
				if (s->stop_pending)
					due_stop.push_back(s->id);
			}
			if (due_start.empty() && due_stop.empty()) {
				sup_cv_.wait_for(l, std::chrono::milliseconds(std::max<int64_t>(10, wake - now)));
				continue;
			}
		}
		std::lock_guard<std::mutex> op(op_m_);
		for (auto &id : due_stop) {
			Sink *s = find(id);
			if (!s)
				continue;
			{
				std::lock_guard<std::mutex> l(m_);
				if (!s->stop_pending)
					continue;
				s->stop_pending = false;
				s->state = SinkState::Stopping;
			}
			obs_output_stop(s->out);
		}
		for (auto &id : due_start) {
			Sink *s = find(id);
			if (!s)
				continue;
			{
				std::lock_guard<std::mutex> l(m_);
				if (s->state != SinkState::Retrying || !s->want || s->next_retry_ms > now_ms())
					continue;
				s->retries++;
			}
			start_sink(*s);
		}
	}
}

Outputs::Sink *Outputs::find(const std::string &id)
{
	for (auto &s : sinks_)
		if (s->id == id)
			return s.get();
	return nullptr;
}

void Outputs::release_graph()
{
	replay_detach_locked(); // replays bind to the rungs and the AAC encoder released below
	std::vector<std::unique_ptr<Sink>> old;
	std::vector<std::unique_ptr<Rung>> old_rungs;
	obs_encoder_t *aac = nullptr;
	{
		std::lock_guard<std::mutex> l(m_);
		old.swap(sinks_);
		old_rungs.swap(rungs_);
		aac = aac_;
		aac_ = nullptr;
		audio_kbps_ = 0;
	}
	for (auto &s : old) {
		if (s->out) {
			signal_handler_t *sh = obs_output_get_signal_handler(s->out);
			signal_handler_disconnect(sh, "start", on_sink_start, s.get());
			signal_handler_disconnect(sh, "stop", on_sink_stop, s.get());
			if (obs_output_active(s->out))
				obs_output_force_stop(s->out);
			obs_output_release(s->out);
		}
		if (s->svc)
			obs_service_release(s->svc);
	}
	for (auto &r : old_rungs)
		if (r->enc)
			obs_encoder_release(r->enc);
	if (aac)
		obs_encoder_release(aac);
}

bool Outputs::any_active() const
{
	std::lock_guard<std::mutex> l(m_);
	for (auto &s : sinks_)
		if (s->want || s->state == SinkState::Starting || s->state == SinkState::Live ||
		    s->state == SinkState::Stopping || s->state == SinkState::Retrying || obs_output_active(s->out))
			return true;
	return false;
}

// libobs emits the "stop" signal before its end-capture thread clears the active flag, so a sink can read
// "stopped" for a few ms while obs_output_active() is still true. Calls that need an idle graph wait for that
// (only when nothing is meant to run) instead of failing.
bool Outputs::idle_soon(int wait_ms) const
{
	int64_t until = now_ms() + wait_ms;
	for (;;) {
		bool wanted = false;
		{
			std::lock_guard<std::mutex> l(m_);
			for (auto &s : sinks_)
				if (s->want || s->state == SinkState::Starting || s->state == SinkState::Live ||
				    s->state == SinkState::Retrying)
					wanted = true;
		}
		if (wanted)
			return false;
		if (!any_active())
			return true;
		if (now_ms() >= until)
			return false;
		Sleep(20);
	}
}

bool Outputs::configured() const
{
	std::lock_guard<std::mutex> l(m_);
	return !sinks_.empty();
}

bool Outputs::live() const
{
	std::lock_guard<std::mutex> l(m_);
	for (auto &s : sinks_)
		if (s->kind == "stream" && (s->state == SinkState::Starting || s->state == SinkState::Live ||
					    s->state == SinkState::Retrying))
			return true;
	return false;
}

bool Outputs::recording() const
{
	std::lock_guard<std::mutex> l(m_);
	for (auto &s : sinks_)
		if (s->kind == "record" && (s->state == SinkState::Starting || s->state == SinkState::Live))
			return true;
	return false;
}

void Outputs::totals(uint64_t &frames, uint64_t &dropped) const
{
	std::lock_guard<std::mutex> l(m_);
	frames = dropped = 0;
	for (auto &s : sinks_) {
		if (s->kind != "stream" || !s->out)
			continue;
		frames += (uint64_t)std::max(0, obs_output_get_total_frames(s->out));
		dropped += (uint64_t)std::max(0, obs_output_get_frames_dropped(s->out));
	}
}

// ---- configure -------------------------------------------------------------------------------------------

namespace {
// Re-attaches the replay buffers (if wanted) when a graph change ends, whether it succeeded or threw.
struct ReplayReattach {
	std::function<void()> fn;
	~ReplayReattach()
	{
		try {
			fn();
		} catch (...) {
		}
	}
};
} // namespace

json::Value Outputs::configure(const json::Value &params)
{
	std::lock_guard<std::mutex> op(op_m_);
	if (!idle_soon(3000))
		throw Error(rpc::CONFLICT, "outputs are active; stop them before configuring");
	ReplayReattach g{[this] { replay_attach_locked(); }};
	json::Value r = build(params);
	return r;
}

json::Value Outputs::clear()
{
	std::lock_guard<std::mutex> op(op_m_);
	if (!idle_soon(3000))
		throw Error(rpc::CONFLICT, "outputs are active; stop them before clearing");
	release_graph();
	config_ = json::Value();
	configured_at_.clear();
	replay_attach_locked(); // fallback rungs now
	json::Value r = json::Value::object();
	r.set("configured", false);
	return r;
}

bool Outputs::release_for_reload()
{
	std::lock_guard<std::mutex> op(op_m_);
	if (!idle_soon(3000))
		return false;
	release_graph(); // config_ is kept for reconfigure()
	return true;
}

json::Value Outputs::reconfigure()
{
	std::lock_guard<std::mutex> op(op_m_);
	ReplayReattach g{[this] { replay_attach_locked(); }}; // after a project load: the new canvases
	if (config_.is_null())
		return json::Value();
	json::Value p = config_;
	return build(p);
}

json::Value Outputs::build(const json::Value &params)
{
	only_keys(params, {"rungs", "audio", "sinks", "policy", "name"}, "outputs.configure");
	const json::Value *rungs = params.find("rungs");
	const json::Value *audio = params.find("audio");
	const json::Value *sinks = params.find("sinks");
	if (!rungs || !rungs->is_array() || rungs->size() == 0 || rungs->size() > 16)
		throw Error(rpc::INVALID_PARAMS, "outputs.configure: rungs must be an array of 1..16");
	if (!sinks || !sinks->is_array() || sinks->size() == 0 || sinks->size() > 32)
		throw Error(rpc::INVALID_PARAMS, "outputs.configure: sinks must be an array of 1..32");
	if (!audio || !audio->is_object())
		throw Error(rpc::INVALID_PARAMS, "outputs.configure: audio is required");

	// -- policy
	Policy pol;
	if (const json::Value *p = params.find("policy")) {
		only_keys(*p,
			  {"dropThresholdMs", "pframeDropThresholdMs", "retryBaseMs", "retryCapMs", "retryMax",
			   "retryResetLiveMs"},
			  "policy");
		pol.drop_threshold_ms = (int)opt_int(*p, "dropThresholdMs", pol.drop_threshold_ms, 100, 10000, "policy");
		pol.pframe_drop_threshold_ms =
			(int)opt_int(*p, "pframeDropThresholdMs", pol.pframe_drop_threshold_ms, 100, 10000, "policy");
		pol.retry_base_ms = (int)opt_int(*p, "retryBaseMs", pol.retry_base_ms, 100, 60000, "policy");
		pol.retry_cap_ms = (int)opt_int(*p, "retryCapMs", pol.retry_cap_ms, 100, 600000, "policy");
		pol.retry_max = (int)opt_int(*p, "retryMax", pol.retry_max, 0, 1000, "policy");
		pol.retry_reset_live_ms = (int)opt_int(*p, "retryResetLiveMs", pol.retry_reset_live_ms, 1000, 600000, "policy");
		if (pol.pframe_drop_threshold_ms < pol.drop_threshold_ms)
			throw Error(rpc::INVALID_PARAMS, "policy: pframeDropThresholdMs must be >= dropThresholdMs");
		if (pol.retry_cap_ms < pol.retry_base_ms)
			throw Error(rpc::INVALID_PARAMS, "policy: retryCapMs must be >= retryBaseMs");
	}

	// -- audio: encoded once, shared by every sink
	only_keys(*audio, {"bitrate", "sampleRate"}, "audio");
	uint32_t a_kbps = (uint32_t)req_int(*audio, "bitrate", 32, 512, "audio");
	int64_t a_rate = req_int(*audio, "sampleRate", 8000, 192000, "audio");
	if ((uint32_t)a_rate != obsrt::sample_rate())
		throw Error(rpc::INVALID_PARAMS, "audio: sampleRate must equal the studio rate (" +
							 std::to_string(obsrt::sample_rate()) + ")");

	// -- rungs (parsed and checked before anything is created)
	std::vector<std::unique_ptr<Rung>> new_rungs;
	std::vector<json::Value> rung_opts;
	std::vector<std::string> warnings;
	std::set<std::string> ids;
	for (auto &rv : rungs->as_array()) {
		only_keys(rv, {"id", "canvas", "codec", "encoder", "rc", "w", "h", "fps", "bitrate", "gopSec", "options"}, "rung");
		auto r = std::make_unique<Rung>();
		r->id = req_id(rv, "id", "rung");
		std::string what = "rung " + r->id;
		if (!ids.insert("r:" + r->id).second)
			throw Error(rpc::INVALID_PARAMS, what + ": duplicate id");
		r->canvas = Studio::norm_canvas(req_str(rv, "canvas", what));
		if (r->canvas.empty())
			throw Error(rpc::INVALID_PARAMS, what + ": canvas must be H or V");
		uint32_t cw = 0, ch = 0, cfps = 0;
		if (!studio_.canvas_size(r->canvas, cw, ch, cfps) || !studio_.canvas_video(r->canvas))
			throw Error(rpc::CONFLICT, what + ": canvas " + r->canvas + " is not in the loaded project");
		r->codec = one_of(req_str(rv, "codec", what), {"h264", "hevc", "av1"}, what + " codec");
		std::string enc = rv.find("encoder") ? req_str(rv, "encoder", what) : "nvenc";
		one_of(enc, {"nvenc", "x264"}, what + " encoder");
		r->rc = one_of(req_str(rv, "rc", what), {"cbr", "vbr", "cqp"}, what + " rc");
		r->w = (uint32_t)req_int(rv, "w", 16, 7680, what);
		r->h = (uint32_t)req_int(rv, "h", 16, 7680, what);
		r->fps = (uint32_t)opt_int(rv, "fps", cfps, 1, 240, what);
		r->bitrate = (uint32_t)req_int(rv, "bitrate", 100, 200000, what);
		r->gop = (double)req_int(rv, "gopSec", 1, 10, what);
		if (r->w > cw || r->h > ch)
			throw Error(rpc::INVALID_PARAMS, what + ": larger than canvas " + r->canvas + " (no upscaling)");
		if ((r->w & 1) || (r->h & 1))
			throw Error(rpc::INVALID_PARAMS, what + ": width and height must be even");
		if (r->fps > cfps || cfps % r->fps != 0)
			throw Error(rpc::INVALID_PARAMS, what + ": fps must divide the canvas fps (" + std::to_string(cfps) + ")");
		if (enc == "x264") {
			if (r->codec != "h264")
				throw Error(rpc::INVALID_PARAMS, what + ": x264 encodes h264 only");
			r->encoder_id = "obs_x264";
		} else {
			r->encoder_id = nvenc_id(r->codec);
			if (!obsrt::has_encoder(r->encoder_id.c_str())) {
				if (r->codec != "h264")
					throw Error(rpc::CONFLICT, what + ": " + r->encoder_id + " is not available");
				warnings.push_back(what + ": NVENC not available, using x264 (D1 fallback)");
				r->encoder_id = "obs_x264";
			}
		}
		if (!obsrt::has_encoder(r->encoder_id.c_str()))
			throw Error(rpc::CONFLICT, what + ": encoder " + r->encoder_id + " is not available");
		json::Value opts = json::Value::object();
		if (const json::Value *o = rv.find("options")) {
			only_keys(*o, {"preset", "tune", "profile", "bf", "multipass", "lookahead"}, what + " options");
			bool nv = is_nvenc(r->encoder_id);
			if (o->find("preset")) {
				std::string p = req_str(*o, "preset", what);
				if (nv)
					one_of(p, {"p1", "p2", "p3", "p4", "p5", "p6", "p7"}, what + " preset");
				else
					one_of(p, {"ultrafast", "superfast", "veryfast", "faster", "fast", "medium"}, what + " preset");
				opts.set("preset", p);
			}
			if (o->find("tune")) {
				std::string t = req_str(*o, "tune", what);
				one_of(t, nv ? std::initializer_list<const char *>{"hq", "ll", "ull"}
					     : std::initializer_list<const char *>{"film", "animation", "zerolatency"},
				       what + " tune");
				opts.set("tune", t);
			}
			if (o->find("profile"))
				opts.set("profile", one_of(req_str(*o, "profile", what), {"baseline", "main", "high", "main10"},
							   what + " profile"));
			if (o->find("bf"))
				opts.set("bf", req_int(*o, "bf", 0, 4, what));
			if (o->find("multipass")) {
				if (!nv)
					throw Error(rpc::INVALID_PARAMS, what + ": multipass is an NVENC option");
				opts.set("multipass", one_of(req_str(*o, "multipass", what), {"disabled", "qres", "fullres"},
							     what + " multipass"));
			}
			if (o->find("lookahead")) {
				const json::Value *la = o->find("lookahead");
				if (!la->is_bool() || !nv)
					throw Error(rpc::INVALID_PARAMS, what + ": bad lookahead");
				opts.set("lookahead", la->as_bool());
			}
		}
		new_rungs.push_back(std::move(r));
		rung_opts.push_back(std::move(opts));
	}

	// -- sinks
	struct SinkDef {
		std::unique_ptr<Sink> s;
		int port = 0;
		std::string app;
		int latency_ms = 0;
	};
	std::vector<SinkDef> defs;
	std::set<std::string> rtmp_paths, files;
	for (auto &sv : sinks->as_array()) {
		only_keys(sv, {"id", "rung", "platform", "proto", "priority", "target"}, "sink");
		SinkDef d;
		d.s = std::make_unique<Sink>();
		Sink &s = *d.s;
		s.owner = this;
		s.id = req_id(sv, "id", "sink");
		std::string what = "sink " + s.id;
		if (!ids.insert("s:" + s.id).second)
			throw Error(rpc::INVALID_PARAMS, what + ": duplicate id");
		s.rung_id = req_id(sv, "rung", what);
		for (auto &r : new_rungs)
			if (r->id == s.rung_id)
				s.rung = r.get();
		if (!s.rung)
			throw Error(rpc::INVALID_PARAMS, what + ": unknown rung");
		s.platform = req_id(sv, "platform", what);
		s.proto = one_of(req_str(sv, "proto", what), {"rtmp", "rtmps", "srt", "whip", "file"}, what + " proto");
		s.priority = (int)opt_int(sv, "priority", 100, 0, 1000, what);
		const json::Value *t = sv.find("target");
		if (!t || !t->is_object())
			throw Error(rpc::INVALID_PARAMS, what + ": target is required");
		s.transport = one_of(req_str(*t, "transport", what), {"rtmp", "rtmps", "srt", "file"}, what + " transport");
		auto ref_field = [&](const char *k) {
			std::string v = req_str(*t, k, what, 64);
			if (!streamkeys::valid_ref(v))
				throw Error(rpc::INVALID_PARAMS, what + ": " + k + " must match ^Ujwalam/stream/[a-z0-9-]{1,32}$");
			return v;
		};
		bool live_form = t->find("url") || t->find("urlRef");
		if ((s.transport == "rtmp" || s.transport == "rtmps") && live_form) {
			// A0 real target: { transport, url | urlRef, keyRef }. The key itself is never a field.
			only_keys(*t, {"transport", "url", "urlRef", "keyRef"}, what + " target");
			if (t->find("url") && t->find("urlRef"))
				throw Error(rpc::INVALID_PARAMS, what + ": give url or urlRef, not both");
			if (!t->find("keyRef"))
				throw Error(rpc::INVALID_PARAMS, what + ": a real target needs keyRef (the key is read from the "
								 "Windows Credential Manager, never passed)");
			s.key_ref = ref_field("keyRef");
			if (t->find("url")) {
				s.url = req_str(*t, "url", what, 256);
				if (!valid_live_url(s.url, s.transport))
					throw Error(rpc::INVALID_PARAMS,
						    what + ": url must be " + s.transport +
							    "://<dns name>[:port][/path] (no IP, no localhost, no user, query or key)");
			} else {
				s.url_ref = ref_field("urlRef");
			}
			if (s.proto != s.transport)
				throw Error(rpc::INVALID_PARAMS, what + ": proto must equal the real target's transport");
			std::string dedupe = (s.url.empty() ? "ref:" + s.url_ref : s.url) + "#" + s.key_ref;
			if (!rtmp_paths.insert(dedupe).second)
				throw Error(rpc::INVALID_PARAMS, what + ": another sink uses the same ingest and key");
			s.live_target = true;
			s.kind = "stream";
		} else if (s.transport == "rtmps") {
			throw Error(rpc::INVALID_PARAMS, what + ": an rtmps target is a real target (url or urlRef, and keyRef)");
		} else if (s.transport == "rtmp") {
			// Loopback: { transport, port, app, stream | keyRef }. keyRef puts the stored key in the stream path
			// (tests the key path end to end without a real platform).
			only_keys(*t, {"transport", "port", "app", "stream", "keyRef"}, what + " target");
			d.port = (int)req_int(*t, "port", 1024, 65535, what);
			d.app = req_id(*t, "app", what);
			if (t->find("stream") && t->find("keyRef"))
				throw Error(rpc::INVALID_PARAMS, what + ": give stream or keyRef, not both");
			if (t->find("keyRef"))
				s.key_ref = ref_field("keyRef");
			else
				s.stream_name = req_id(*t, "stream", what);
			s.url = "rtmp://127.0.0.1:" + std::to_string(d.port) + "/" + d.app;
			if (!rtmp_paths.insert(s.url + "/" + (s.key_ref.empty() ? s.stream_name : "ref:" + s.key_ref)).second)
				throw Error(rpc::INVALID_PARAMS, what + ": another sink uses the same rtmp target");
			s.kind = "stream";
		} else if (s.transport == "srt") {
			only_keys(*t, {"transport", "port", "latencyMs"}, what + " target");
			d.port = (int)req_int(*t, "port", 1024, 65535, what);
			d.latency_ms = (int)opt_int(*t, "latencyMs", 120, 20, 8000, what);
			s.url = "srt://127.0.0.1:" + std::to_string(d.port) + "?mode=caller&latency=" +
				std::to_string((int64_t)d.latency_ms * 1000) + "&pkt_size=1316";
			s.kind = "stream";
		} else {
			only_keys(*t, {"transport", "name", "unsafeContainer"}, what + " target");
			std::string name = req_str(*t, "name", what, 80);
			static const std::regex fre("^([A-Za-z0-9][A-Za-z0-9_-]{0,63})\\.(mkv|mp4|flv|ts)$");
			std::smatch m;
			if (!std::regex_match(name, m, fre))
				throw Error(rpc::INVALID_PARAMS, what + ": file name must be <base>.mkv|.mp4|.flv|.ts (no paths)");
			s.file_base = m[1];
			s.file_ext = m[2];
			// A0: recordings are crash-safe by default. An .mp4 cut off by a crash or power loss has no index (moov)
			// and does not play; .mkv stays playable up to the last written cluster.
			const json::Value *unsafe = t->find("unsafeContainer");
			if (unsafe && !unsafe->is_bool())
				throw Error(rpc::INVALID_PARAMS, what + ": unsafeContainer must be true or false");
			if (s.file_ext != "mkv" && !(unsafe && unsafe->as_bool()))
				throw Error(rpc::INVALID_PARAMS,
					    what + ": ." + s.file_ext +
						    " is refused for recordings because it is not crash-safe (a file cut off by a crash or "
						    "power loss may not play); use .mkv, or set target.unsafeContainer: true to accept that");
			if (!files.insert(s.file_base).second)
				throw Error(rpc::INVALID_PARAMS, what + ": another sink uses the same file name");
			s.kind = "record";
		}
		if (s.kind == "record" && s.proto != "file")
			throw Error(rpc::INVALID_PARAMS, what + ": a file target needs proto \"file\"");
		s.bandwidth_test = twitch_bw_test_ && s.kind == "stream" && s.platform == "twitch" && !s.key_ref.empty();
		if (s.kind == "stream" && s.proto == "file")
			throw Error(rpc::INVALID_PARAMS, what + ": proto \"file\" needs a file target");
		if (s.kind == "stream" && s.rung->codec != "h264" && (s.transport == "rtmp" || s.transport == "rtmps"))
			throw Error(rpc::INVALID_PARAMS, what + ": rtmp/rtmps carries h264 only (enhanced RTMP is not wired)");
		s.rung->sinks.push_back(s.id);
		defs.push_back(std::move(d));
	}
	// -- A0 gate: real targets only when the host was started with --allow-live (checked after the shape checks).
	for (auto &d : defs)
		if (d.s->live_target && !allow_live_)
			throw Error(rpc::FORBIDDEN, "sink " + d.s->id +
							    ": real (non-loopback) targets are refused; the host must be started with "
							    "--allow-live (after the user's Start stream click)");
	for (auto &d : defs) {
		Sink &s = *d.s;
		if (!s.key_ref.empty()) {
			s.key_present = streamkeys::check(s.key_ref) == streamkeys::Read::Ok;
			if (!s.key_present)
				warnings.push_back("sink " + s.id + ": no usable stream key in Credential Manager target " + s.key_ref);
		}
		if (!s.url_ref.empty()) {
			s.url_present = check_url_ref(s.url_ref, s.transport);
			if (!s.url_present)
				warnings.push_back("sink " + s.id + ": no usable " + s.transport + " ingest URL in Credential Manager target " +
						   s.url_ref);
		}
	}
	for (auto &r : new_rungs)
		if (r->sinks.empty())
			warnings.push_back("rung " + r->id + " has no sinks (not created)");

	// -- NVENC sessions: probed now, never assumed (CLAUDE.md). One session per NVENC rung that has sinks.
	int need = 0;
	for (auto &r : new_rungs)
		if (is_nvenc(r->encoder_id) && !r->sinks.empty())
			need++;
	release_graph();
	if (need > 0) {
		json::Value pr = probe_locked("h264", need);
		last_probe_ = pr;
		const json::Value *st = pr.find("started");
		int started = st ? (int)st->as_int() : 0;
		if (started < need) {
			config_ = json::Value();
			Error e(rpc::CONFLICT, "NVENC sessions available: " + std::to_string(started) + ", needed: " +
						       std::to_string(need) + " (see encoders.probe)");
			throw e;
		}
	}

	// -- create: shared AAC, one encoder per rung, one output per sink
	try {
		obs_data_t *as = obs_data_create();
		obs_data_set_int(as, "bitrate", a_kbps);
		obs_encoder_t *aac = obs_audio_encoder_create("ffmpeg_aac", "ujw:enc:audio", as, 0, nullptr);
		obs_data_release(as);
		if (!aac)
			throw Error(rpc::INTERNAL, "could not create the AAC encoder");
		obs_encoder_set_audio(aac, obs_get_audio());
		{
			std::lock_guard<std::mutex> l(m_);
			aac_ = aac;
			audio_kbps_ = a_kbps;
		}
		for (size_t i = 0; i < new_rungs.size(); i++) {
			Rung &r = *new_rungs[i];
			if (r.sinks.empty())
				continue;
			const json::Value &o = rung_opts[i];
			bool nv = is_nvenc(r.encoder_id);
			obs_data_t *es = obs_data_create();
			std::string rc = r.rc;
			if (!nv)
				rc = r.rc == "cqp" ? "CRF" : r.rc == "vbr" ? "VBR" : "CBR";
			obs_data_set_string(es, "rate_control", rc.c_str());
			obs_data_set_int(es, "bitrate", r.bitrate);
			if (r.rc == "vbr")
				obs_data_set_int(es, "max_bitrate", r.bitrate);
			obs_data_set_int(es, "keyint_sec", (int64_t)r.gop);
			auto s_opt = [&](const char *k, const char *def) {
				const json::Value *v = o.find(k);
				obs_data_set_string(es, k, v ? v->as_string().c_str() : def);
			};
			if (nv) {
				s_opt("preset", "p5");
				s_opt("tune", "hq");
				s_opt("profile", r.codec == "h264" ? "high" : "main");
				s_opt("multipass", "qres");
				obs_data_set_int(es, "bf", o.find("bf") ? o.find("bf")->as_int() : 2);
				if (const json::Value *la = o.find("lookahead"))
					obs_data_set_bool(es, "lookahead", la->as_bool());
			} else {
				s_opt("preset", "veryfast");
				s_opt("profile", "high");
				if (const json::Value *t = o.find("tune"))
					obs_data_set_string(es, "tune", t->as_string().c_str());
				if (const json::Value *bf = o.find("bf"))
					obs_data_set_string(es, "x264opts", ("bframes=" + std::to_string(bf->as_int())).c_str());
			}
			std::string name = "ujw:enc:" + r.id;
			r.enc = obs_video_encoder_create(r.encoder_id.c_str(), name.c_str(), es, nullptr);
			obs_data_release(es);
			if (!r.enc)
				throw Error(rpc::INTERNAL, "rung " + r.id + ": could not create " + r.encoder_id);
			uint32_t cw = 0, ch = 0, cfps = 0;
			studio_.canvas_size(r.canvas, cw, ch, cfps);
			if (r.w != cw || r.h != ch) {
				obs_encoder_set_scaled_size(r.enc, r.w, r.h);
				obs_encoder_set_gpu_scale_type(r.enc, OBS_SCALE_LANCZOS);
			}
			if (r.fps != cfps)
				obs_encoder_set_frame_rate_divisor(r.enc, cfps / r.fps);
			obs_encoder_set_video(r.enc, studio_.canvas_video(r.canvas));
		}
		for (auto &d : defs) {
			Sink &s = *d.s;
			obs_data_t *os = obs_data_create();
			const char *type = nullptr;
			if (s.transport == "rtmp" || s.transport == "rtmps") {
				type = "rtmp_output";
				obs_data_set_int(os, "drop_threshold_ms", pol.drop_threshold_ms);
				obs_data_set_int(os, "pframe_drop_threshold_ms", pol.pframe_drop_threshold_ms);
			} else if (s.transport == "srt") {
				type = "ffmpeg_mpegts_muxer";
			} else {
				type = "ffmpeg_muxer";
				obs_data_set_string(os, "path", "");
				obs_data_set_string(os, "muxer_settings", "");
			}
			std::string name = "ujw:out:" + s.id;
			s.out = obs_output_create(type, name.c_str(), os, nullptr);
			obs_data_release(os);
			if (!s.out)
				throw Error(rpc::INTERNAL, "sink " + s.id + ": could not create " + type);
			if (s.kind == "stream") {
				// Settings hold target names only (key_ref/url_ref), never a key: see the service comment above.
				obs_data_t *ss = obs_data_create();
				obs_data_set_string(ss, "protocol",
						    s.transport == "srt" ? "SRT" : s.transport == "rtmps" ? "RTMPS" : "RTMP");
				obs_data_set_string(ss, "server", s.url.c_str());
				obs_data_set_string(ss, "stream", s.stream_name.c_str());
				obs_data_set_string(ss, "key_ref", s.key_ref.c_str());
				obs_data_set_string(ss, "url_ref", s.url_ref.c_str());
				obs_data_set_bool(ss, "bandwidth_test", s.bandwidth_test); // a flag only, never the suffixed key
				std::string sname = "ujw:svc:" + s.id;
				s.svc = obs_service_create_private(s.live_target ? "ujwalam_live" : "ujwalam_loopback",
								   sname.c_str(), ss);
				obs_data_release(ss);
				if (!s.svc)
					throw Error(rpc::INTERNAL, "sink " + s.id + ": could not create the delivery service");
				obs_output_set_service(s.out, s.svc);
				obs_output_set_reconnect_settings(s.out, 0, 0); // the host supervisor owns retries
			}
			obs_output_set_video_encoder(s.out, s.rung->enc);
			obs_output_set_audio_encoder(s.out, aac, 0);
			signal_handler_t *sh = obs_output_get_signal_handler(s.out);
			signal_handler_connect(sh, "start", on_sink_start, &s);
			signal_handler_connect(sh, "stop", on_sink_stop, &s);
		}
	} catch (...) {
		// Partially built: hand everything to the graph so release_graph frees it, then release.
		{
			std::lock_guard<std::mutex> l(m_);
			for (auto &r : new_rungs)
				rungs_.push_back(std::move(r));
			for (auto &d : defs)
				sinks_.push_back(std::move(d.s));
		}
		release_graph();
		throw;
	}
	{
		std::lock_guard<std::mutex> l(m_);
		policy_ = pol;
		for (auto &r : new_rungs)
			rungs_.push_back(std::move(r));
		for (auto &d : defs)
			sinks_.push_back(std::move(d.s));
	}
	config_ = params;
	configured_at_ = hlog::utc_now();
	hlog::info("outputs configured: %zu rungs, %zu sinks, audio %u kbps", rungs_.size(), sinks_.size(), a_kbps);
	json::Value r = status();
	json::Value w = json::Value::array();
	for (auto &s : warnings)
		w.push(s);
	r.set("warnings", std::move(w));
	return r;
}

// ---- start / stop ----------------------------------------------------------------------------------------

std::vector<Outputs::Sink *> Outputs::select(const std::vector<std::string> &ids, const std::string &kind)
{
	std::vector<Sink *> out;
	if (ids.empty()) {
		for (auto &s : sinks_)
			if (kind.empty() || s->kind == kind)
				out.push_back(s.get());
		return out;
	}
	for (auto &id : ids) {
		Sink *s = find(id);
		if (!s)
			throw Error(rpc::INVALID_PARAMS, "unknown sink " + json::Value(id.substr(0, 64)).dump());
		if (!kind.empty() && s->kind != kind)
			throw Error(rpc::INVALID_PARAMS, "sink " + id + " is not a " + kind + " sink");
		out.push_back(s);
	}
	return out;
}

void Outputs::start_sink(Sink &s)
{
	{
		std::lock_guard<std::mutex> l(m_);
		if (!s.want)
			return;
		s.state = SinkState::Starting;
		s.attempts++;
		s.last_change_ms = now_ms();
		if (s.kind == "record")
			s.path = (fs::u8path(rec_dir_) / fs::u8path(s.file_base + "-" + stamp() + "." + s.file_ext))
					 .generic_u8string();
	}
	if (s.kind == "record") {
		obs_data_t *os = obs_data_create();
		obs_data_set_string(os, "path", s.path.c_str());
		obs_data_set_string(os, "muxer_settings", "");
		obs_output_update(s.out, os);
		obs_data_release(os);
	}
	// Keyed sinks: the key (and a per-account URL) must be in Credential Manager now. Missing is not retried: the
	// user has to store it (the message names the target and the command, never a value).
	std::string missing;
	if (s.live_target && !allow_live_)
		missing = "real targets need the host started with --allow-live";
	bool kp = s.key_ref.empty() || streamkeys::check(s.key_ref) == streamkeys::Read::Ok;
	bool up = s.url_ref.empty() || check_url_ref(s.url_ref, s.transport);
	if (missing.empty() && !kp)
		missing = "no usable stream key in Windows Credential Manager target " + s.key_ref +
			  " (store it: node services/event-core/cli.mjs credential set --target " + s.key_ref + ")";
	if (missing.empty() && !up)
		missing = "no usable " + s.transport + " ingest URL in Windows Credential Manager target " + s.url_ref +
			  " (store it: node services/event-core/cli.mjs credential set --target " + s.url_ref + ")";
	{
		std::lock_guard<std::mutex> l(m_);
		if (!s.key_ref.empty())
			s.key_present = kp;
		if (!s.url_ref.empty())
			s.url_present = up;
		if (!missing.empty()) {
			s.want = false;
			s.state = SinkState::Failed;
			s.last_error = missing;
			s.last_change_ms = now_ms();
			hlog::warn("sink %s not started: %s", s.id.c_str(), missing.c_str());
			return;
		}
	}
	bool ok = obs_output_start(s.out);
	if (ok)
		return;
	wipe_sink_secrets(s); // no connect thread was started
	const char *e = obs_output_get_last_error(s.out);
	std::lock_guard<std::mutex> l(m_);
	if (s.state != SinkState::Starting)
		return; // a stop signal already handled it
	s.last_error = e && *e ? e : "start failed";
	if (s.kind == "record") {
		s.want = false;
		s.state = SinkState::Failed;
		hlog::warn("record sink %s did not start", s.id.c_str());
	} else {
		hlog::warn("sink %s did not start", s.id.c_str());
		schedule_retry_locked(s, now_ms());
	}
}

json::Value Outputs::start(const std::vector<std::string> &ids, const std::string &kind)
{
	std::lock_guard<std::mutex> op(op_m_);
	if (sinks_.empty())
		throw Error(rpc::CONFLICT, "outputs are not configured (outputs.configure)");
	std::vector<Sink *> sel = select(ids, kind);
	if (sel.empty())
		throw Error(rpc::CONFLICT, "no " + (kind.empty() ? std::string("") : kind + " ") + "sinks are configured");
	for (Sink *s : sel) {
		{
			std::lock_guard<std::mutex> l(m_);
			if (s->want || s->state == SinkState::Live || s->state == SinkState::Starting ||
			    s->state == SinkState::Stopping)
				continue; // already running or on its way
			s->want = true;
			s->fails = 0;
			s->stop_pending = false;
		}
		start_sink(*s);
	}
	json::Value r = json::Value::object();
	json::Value a = json::Value::array();
	{
		std::lock_guard<std::mutex> l(m_);
		for (Sink *s : sel)
			a.push(sink_json(*s));
	}
	r.set("sinks", std::move(a));
	return r;
}

json::Value Outputs::stop(const std::vector<std::string> &ids, const std::string &kind)
{
	std::lock_guard<std::mutex> op(op_m_);
	std::vector<Sink *> sel = select(ids, kind);
	for (Sink *s : sel) {
		bool call_stop = false;
		{
			std::lock_guard<std::mutex> l(m_);
			s->want = false;
			if (s->state == SinkState::Live) {
				s->state = SinkState::Stopping;
				call_stop = true;
			} else if (s->state == SinkState::Retrying || s->state == SinkState::Idle) {
				s->state = SinkState::Stopped;
			}
			// Starting: still connecting. It ends in a stop signal (connect failed) or a start signal, after which
			// the supervisor stops it (stop_pending).
			s->last_change_ms = now_ms();
			update_clocks_locked(s->last_change_ms);
		}
		if (call_stop)
			obs_output_stop(s->out);
	}
	json::Value r = json::Value::object();
	json::Value a = json::Value::array();
	{
		std::lock_guard<std::mutex> l(m_);
		for (Sink *s : sel)
			a.push(sink_json(*s));
	}
	r.set("sinks", std::move(a));
	return r;
}

void Outputs::stop_all(int wait_ms)
{
	try {
		stop({}, "");
	} catch (...) {
	}
	int64_t until = now_ms() + wait_ms;
	for (;;) {
		bool busy = false;
		{
			std::lock_guard<std::mutex> l(m_);
			for (auto &s : sinks_)
				if (obs_output_active(s->out) || s->state == SinkState::Starting ||
				    s->state == SinkState::Stopping)
					busy = true;
		}
		if (!busy || now_ms() >= until)
			break;
		Sleep(50);
	}
	std::lock_guard<std::mutex> op(op_m_);
	for (auto &s : sinks_) {
		if (s->out && obs_output_active(s->out)) {
			hlog::warn("sink %s did not stop in %d ms; forcing", s->id.c_str(), wait_ms);
			obs_output_force_stop(s->out);
		}
	}
}

// ---- status ----------------------------------------------------------------------------------------------

json::Value Outputs::sink_json(const Sink &s) const
{
	int64_t now = now_ms();
	json::Value o = json::Value::object();
	o.set("id", s.id);
	o.set("kind", s.kind);
	o.set("platform", s.platform);
	o.set("proto", s.proto);
	o.set("transport", s.transport);
	o.set("rung", s.rung_id);
	o.set("priority", s.priority);
	if (s.kind == "stream") {
		// Never a key: a keyed loopback path shows the app only; a per-account URL (urlRef) is not shown.
		if (s.live_target)
			o.set("url", s.url_ref.empty() ? json::Value(s.url) : json::Value());
		else if (s.transport == "rtmp")
			o.set("url", s.key_ref.empty() ? s.url + "/" + s.stream_name : s.url + "/");
		else
			o.set("url", s.url);
		o.set("target", s.live_target ? "live" : "loopback");
		o.set("keyRef", s.key_ref.empty() ? json::Value() : json::Value(s.key_ref));
		o.set("keyPresent", s.key_ref.empty() ? json::Value() : json::Value(s.key_present));
		o.set("bandwidthTest", s.bandwidth_test);
		if (!s.url_ref.empty()) {
			o.set("urlRef", s.url_ref);
			o.set("urlPresent", s.url_present);
		}
	} else {
		o.set("path", s.path.empty() ? json::Value() : json::Value(s.path));
		o.set("container", s.file_ext);
	}
	o.set("state", state_name(s.state));
	o.set("attempts", s.attempts);
	o.set("retries", s.retries);
	o.set("consecutiveFailures", s.fails);
	o.set("lastCode", s.last_code);
	o.set("lastError", s.last_error.empty() ? json::Value() : json::Value(s.last_error));
	o.set("nextRetryInMs", s.state == SinkState::Retrying ? json::Value(std::max<int64_t>(0, s.next_retry_ms - now))
							       : json::Value());
	o.set("liveForMs", s.live_since_ms ? json::Value(now - s.live_since_ms) : json::Value());
	if (s.out) {
		uint64_t bytes = obs_output_get_total_bytes(s.out);
		o.set("active", obs_output_active(s.out));
		o.set("totalFrames", obs_output_get_total_frames(s.out));
		o.set("droppedFrames", obs_output_get_frames_dropped(s.out));
		o.set("bytes", bytes);
		// Lost frames that never reach this output (live-test guard; cumulative, not reset per sink start):
		// encoder-skipped = the skipped-frame counter of the root video the sink's rung encodes from (libobs counts
		// frames the encoder could not take, including NVENC texture-encode skips, on the canvas root video); render-
		// lagged = compositor frames that missed their slot (host-wide).
		video_t *ev = s.rung && s.rung->enc ? obs_encoder_video(s.rung->enc) : nullptr;
		o.set("encoderSkippedFrames", ev ? json::Value((uint64_t)video_output_get_skipped_frames(ev)) : json::Value());
		o.set("encoderTotalFrames", ev ? json::Value((uint64_t)video_output_get_total_frames(ev)) : json::Value());
		o.set("renderLaggedFrames", (uint64_t)obs_get_lagged_frames());
		o.set("renderTotalFrames", (uint64_t)obs_get_total_frames());
		if (s.kind == "stream") {
			o.set("congestion", (double)obs_output_get_congestion(s.out));
			o.set("connectTimeMs", obs_output_get_connect_time_ms(s.out));
		}
		// Bitrate over the time since the previous status call (min 1 s window).
		if (s.state == SinkState::Live) {
			if (s.sample_ms && now - s.sample_ms >= 1000 && bytes >= s.sample_bytes) {
				s.kbps = (double)(bytes - s.sample_bytes) * 8.0 / (double)(now - s.sample_ms);
				s.sample_bytes = bytes;
				s.sample_ms = now;
			} else if (!s.sample_ms) {
				s.sample_bytes = bytes;
				s.sample_ms = now;
			}
			o.set("kbps", s.kbps);
		}
	}
	return o;
}

json::Value Outputs::status() const
{
	std::lock_guard<std::mutex> l(m_);
	json::Value r = json::Value::object();
	r.set("configured", !sinks_.empty());
	r.set("allowLive", allow_live_);
	r.set("twitchBandwidthTest", twitch_bw_test_);
	r.set("configuredAt", configured_at_.empty() ? json::Value() : json::Value(configured_at_));
	json::Value rungs = json::Value::array();
	for (auto &rp : rungs_) {
		const Rung &x = *rp;
		json::Value o = json::Value::object();
		o.set("id", x.id);
		o.set("canvas", x.canvas);
		o.set("codec", x.codec);
		o.set("encoderId", x.encoder_id);
		o.set("rc", x.rc);
		o.set("w", x.w);
		o.set("h", x.h);
		o.set("fps", x.fps);
		o.set("bitrate", x.bitrate);
		o.set("gopSec", x.gop);
		o.set("created", x.enc != nullptr);
		o.set("active", x.enc ? obs_encoder_active(x.enc) : false);
		// Scaled on the GPU from the canvas (O2: the Multi rung from a larger H canvas), never a decode.
		o.set("scaled", x.enc ? obs_encoder_scaling_enabled(x.enc) : false);
		o.set("gpuScaled", x.enc ? obs_encoder_gpu_scaling_enabled(x.enc) : false);
		o.set("encodeW", x.enc ? obs_encoder_get_width(x.enc) : 0u);
		o.set("encodeH", x.enc ? obs_encoder_get_height(x.enc) : 0u);
		json::Value sk = json::Value::array();
		for (auto &id : x.sinks)
			sk.push(id);
		o.set("sinks", std::move(sk));
		rungs.push(std::move(o));
	}
	r.set("rungs", std::move(rungs));
	json::Value audio = json::Value::object();
	audio.set("encoderId", aac_ ? json::Value("ffmpeg_aac") : json::Value());
	audio.set("bitrate", audio_kbps_);
	audio.set("sampleRate", obsrt::sample_rate());
	audio.set("encoders", aac_ ? 1 : 0);
	audio.set("active", aac_ ? obs_encoder_active(aac_) : false);
	r.set("audio", std::move(audio));
	json::Value sinks = json::Value::array();
	for (auto &s : sinks_)
		sinks.push(sink_json(*s));
	r.set("sinks", std::move(sinks));
	r.set("probe", last_probe_);
	json::Value pol = json::Value::object();
	pol.set("dropThresholdMs", policy_.drop_threshold_ms);
	pol.set("pframeDropThresholdMs", policy_.pframe_drop_threshold_ms);
	pol.set("retryBaseMs", policy_.retry_base_ms);
	pol.set("retryCapMs", policy_.retry_cap_ms);
	pol.set("retryMax", policy_.retry_max);
	pol.set("retryResetLiveMs", policy_.retry_reset_live_ms);
	r.set("policy", std::move(pol));
	return r;
}

// ---- NVENC session probe ---------------------------------------------------------------------------------
// Opens up to `max` NVENC encoders (each its own session) on the H canvas (fastest preset) inside replay_buffer
// outputs (memory only, nothing is written) and counts how many start. Compared with NVML's session count.

json::Value Outputs::probe_sessions(const std::string &codec, int max)
{
	std::lock_guard<std::mutex> op(op_m_);
	if (!idle_soon(3000))
		throw Error(rpc::CONFLICT, "outputs are active; the probe would compete for sessions");
	json::Value r = probe_locked(codec, max);
	last_probe_ = r;
	return r;
}

json::Value Outputs::probe_locked(const std::string &codec, int max)
{
	one_of(codec, {"h264", "hevc", "av1"}, "probe codec");
	if (max < 1 || max > 32)
		throw Error(rpc::INVALID_PARAMS, "probe max must be 1..32");
	std::string id = nvenc_id(codec);
	json::Value r = json::Value::object();
	r.set("codec", codec);
	r.set("encoderId", id);
	r.set("requested", max);
	r.set("at", hlog::utc_now());
	if (!obsrt::has_encoder(id.c_str())) {
		r.set("available", false);
		r.set("started", 0);
		return r;
	}
	r.set("available", true);
	if (!obs_get_video())
		throw Error(rpc::CONFLICT, "no video (load a project first)");
	int64_t t0 = now_ms();
	int before = stats::encoder_sessions();
	obs_data_t *as = obs_data_create();
	obs_data_set_int(as, "bitrate", 64);
	obs_encoder_t *aac = obs_audio_encoder_create("ffmpeg_aac", "ujw:probe:audio", as, 0, nullptr);
	obs_data_release(as);
	obs_encoder_set_audio(aac, obs_get_audio());
	std::vector<std::pair<obs_encoder_t *, obs_output_t *>> made;
	int started = 0;
	std::string fail;
	for (int i = 0; i < max; i++) {
		obs_data_t *es = obs_data_create();
		obs_data_set_string(es, "rate_control", "cbr");
		obs_data_set_int(es, "bitrate", 300);
		obs_data_set_int(es, "keyint_sec", 2);
		obs_data_set_string(es, "preset", "p1");
		obs_data_set_int(es, "bf", 0);
		std::string en = "ujw:probe:" + std::to_string(i);
		obs_encoder_t *e = obs_video_encoder_create(id.c_str(), en.c_str(), es, nullptr);
		obs_data_release(es);
		if (!e) {
			fail = "encoder create failed";
			break;
		}
		// Canvas size, no GPU scaling: a GPU-scaled encoder whose start fails (session limit) leaves its scaled
		// video mix behind in libobs 32.1.2 ("Number of remaining views: 1" at shutdown; evidence 2026-10-29).
		obs_encoder_set_video(e, obs_get_video());
		obs_data_t *os = obs_data_create();
		obs_data_set_int(os, "max_time_sec", 1);
		obs_data_set_int(os, "max_size_mb", 8);
		std::string on = "ujw:probe-out:" + std::to_string(i);
		obs_output_t *o = obs_output_create("replay_buffer", on.c_str(), os, nullptr);
		obs_data_release(os);
		if (!o) {
			obs_encoder_release(e);
			fail = "replay_buffer create failed";
			break;
		}
		obs_output_set_video_encoder(o, e);
		obs_output_set_audio_encoder(o, aac, 0);
		made.push_back({e, o});
		if (!obs_output_start(o)) {
			const char *le = obs_output_get_last_error(o);
			const char *ee = obs_encoder_get_last_error(e);
			fail = le && *le ? le : ee && *ee ? ee : "start failed";
			break;
		}
		started++;
	}
	Sleep(300);
	int during = stats::encoder_sessions();
	for (auto &m : made)
		if (obs_output_active(m.second))
			obs_output_stop(m.second);
	int64_t until = now_ms() + 5000;
	for (auto &m : made) {
		while (obs_output_active(m.second) && now_ms() < until)
			Sleep(20);
		if (obs_output_active(m.second))
			obs_output_force_stop(m.second);
		obs_output_release(m.second);
		obs_encoder_release(m.first);
	}
	obs_encoder_release(aac);
	r.set("started", started);
	r.set("limitReached", started < max);
	r.set("firstFailure", fail.empty() ? json::Value() : json::Value(fail));
	r.set("nvmlSessionsBefore", before >= 0 ? json::Value(before) : json::Value());
	r.set("nvmlSessionsDuring", during >= 0 ? json::Value(during) : json::Value());
	r.set("durationMs", now_ms() - t0);
	hlog::info("nvenc probe %s: %d of %d started (nvml before %d, during %d)", codec.c_str(), started, max, before,
		   during);
	return r;
}
