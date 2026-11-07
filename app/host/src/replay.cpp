// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: replay buffer per canvas (A0 day 2). See the replay section of outputs.h.
//
// libobs replay_buffer (plugins/obs-ffmpeg/obs-ffmpeg-mux.c, OBS 32.1.2): keeps encoded packets in memory for
// max_time_sec (plus up to one GOP, it never cuts below two keyframes) and max_size_mb. The "save" proc marks the
// current time; the next packet past it copies the buffer and a mux thread writes <directory>/<format>.<extension>
// through obs-ffmpeg-mux; the "saved" signal fires when the file is written (not on failure), and
// get_last_replay returns its path. The file name is generated at save time from the output settings, so a save
// into a given folder updates "directory" and "format" first; saves on one replay are serialised.
//
// Locking: attach/detach run with op_m_ held (graph changes). replay_save never takes op_m_: it holds a strong
// libobs reference to the output while it waits, so a detach meanwhile only ends the wait ("replay stopped").
#include "log.h"
#include "obs_runtime.h"
#include "outputs.h"
#include "rpc_server.h"
#include "studio.h"

#include <util/platform.h>

#include <windows.h>

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <filesystem>
#include <mutex>

namespace fs = std::filesystem;
using rpc::Error;

struct Outputs::Replay {
	std::string canvas, rung_id, encoder_id;
	uint32_t bitrate = 0, w = 0, h = 0;
	bool fallback = false;
	obs_output_t *out = nullptr;
	obs_encoder_t *own_enc = nullptr; // fallback rung only
	std::string error;                // start failure
	int64_t started_ms = 0;

	std::mutex m; // attached, saved_count, last_path, stop_code
	std::condition_variable cv;
	bool attached = false;
	uint64_t saved_count = 0;
	int stop_code = 0;
	bool stopped = false; // libobs stopped it on its own (encoder error)
	std::string last_path;

	std::mutex save_m; // one save at a time on this replay
};

namespace {

int64_t mono_ms()
{
	return (int64_t)(os_gettime_ns() / 1000000ULL);
}

void on_replay_saved(void *data, calldata_t *)
{
	auto *r = static_cast<Outputs::Replay *>(data);
	std::lock_guard<std::mutex> l(r->m);
	r->saved_count++;
	r->cv.notify_all();
}

void on_replay_stop(void *data, calldata_t *cd)
{
	auto *r = static_cast<Outputs::Replay *>(data);
	int code = (int)calldata_int(cd, "code");
	{
		std::lock_guard<std::mutex> l(r->m);
		r->stop_code = code;
		r->stopped = true;
		r->cv.notify_all();
	}
	if (code != OBS_OUTPUT_SUCCESS)
		hlog::warn("replay %s stopped by libobs (code %d)", r->canvas.c_str(), code);
}

std::string replace_all(std::string s, const std::string &from, const std::string &to)
{
	for (size_t p = s.find(from); p != std::string::npos; p = s.find(from, p + to.size()))
		s.replace(p, from.size(), to);
	return s;
}

// libobs's replay save OVERWRITES a file of the same name (obs-ffmpeg-mux.c replay_buffer_save -> generate_filename
// with overwrite = true), and the default name has one-second resolution, so two saves within one second (live
// clipping, D226) would leave one file. The name is resolved here with the formatter libobs uses, gets "-2", "-3" ...
// while <dir>/<name>.mkv exists, and goes to libobs as a literal ("%" escaped). Called with the replay's save_m held,
// so an earlier save of the same replay has finished writing its file.
std::string unique_literal_name(const std::string &dir, const std::string &fmt)
{
	char *fn = os_generate_formatted_filename("mkv", false, fmt.c_str());
	std::string stem = fn ? fn : fmt;
	bfree(fn);
	if (stem.size() > 4 && stem.compare(stem.size() - 4, 4, ".mkv") == 0)
		stem.resize(stem.size() - 4);
	std::string name = stem;
	std::error_code ec;
	for (int n = 2; n < 1000 && fs::exists(fs::u8path(dir) / fs::u8path(name + ".mkv"), ec); n++)
		name = stem + "-" + std::to_string(n);
	return replace_all(name, "%", "%%");
}

} // namespace

std::string Outputs::replay_dir() const
{
	return (fs::u8path(rec_dir_) / "replay").generic_u8string();
}

void Outputs::set_replay_config(const ReplayConfig &c)
{
	std::lock_guard<std::mutex> op(op_m_);
	rcfg_ = c;
}

void Outputs::replay_attach_locked()
{
	if (!replay_want_)
		return;
	for (const char *cv : {"H", "V"}) {
		std::string canvas = cv;
		{
			std::lock_guard<std::mutex> l(rp_m_);
			bool have = false;
			for (auto &r : replays_)
				if (r->canvas == canvas)
					have = true;
			if (have)
				continue;
		}
		uint32_t cw = 0, ch = 0, cfps = 0;
		video_t *video = studio_.canvas_video(canvas);
		if (!video || !studio_.canvas_size(canvas, cw, ch, cfps))
			continue; // no such canvas in the loaded project
		auto r = std::make_shared<Replay>();
		r->canvas = canvas;
		obs_encoder_t *venc = nullptr, *aenc = nullptr;
		{
			std::lock_guard<std::mutex> l(m_);
			const Rung *best = nullptr;
			for (auto &x : rungs_) {
				if (!x->enc || x->canvas != canvas)
					continue;
				uint64_t a = (uint64_t)x->w * x->h, b = best ? (uint64_t)best->w * best->h : 0;
				if (!best || a > b || (a == b && x->bitrate > best->bitrate))
					best = x.get();
			}
			if (best) {
				venc = best->enc;
				r->rung_id = best->id;
				r->encoder_id = best->encoder_id;
				r->bitrate = best->bitrate;
				r->w = obs_encoder_get_width(best->enc);
				r->h = obs_encoder_get_height(best->enc);
			}
			aenc = aac_;
		}
		if (!venc) {
			// Fallback rung: record-less, canvas size, H.264 CBR. NVENC first (D1), x264 if NVENC is missing.
			r->fallback = true;
			r->rung_id = "replay-" + canvas;
			r->encoder_id = obsrt::has_encoder("obs_nvenc_h264_tex") ? "obs_nvenc_h264_tex" : "obs_x264";
			r->bitrate = canvas == "H" ? rcfg_.fallback_kbps_h : rcfg_.fallback_kbps_v;
			r->w = cw;
			r->h = ch;
			bool nv = r->encoder_id != "obs_x264";
			obs_data_t *es = obs_data_create();
			obs_data_set_string(es, "rate_control", nv ? "cbr" : "CBR");
			obs_data_set_int(es, "bitrate", r->bitrate);
			obs_data_set_int(es, "keyint_sec", 2);
			obs_data_set_string(es, "profile", "high");
			if (nv) {
				obs_data_set_string(es, "preset", "p5");
				obs_data_set_string(es, "tune", "hq");
				obs_data_set_string(es, "multipass", "qres");
				obs_data_set_int(es, "bf", 2);
			} else {
				obs_data_set_string(es, "preset", "veryfast");
			}
			std::string name = "ujw:enc:replay-" + canvas;
			r->own_enc = obs_video_encoder_create(r->encoder_id.c_str(), name.c_str(), es, nullptr);
			obs_data_release(es);
			if (!r->own_enc) {
				r->error = "could not create the fallback encoder " + r->encoder_id;
				hlog::warn("replay %s: %s", canvas.c_str(), r->error.c_str());
				std::lock_guard<std::mutex> l(rp_m_);
				replays_.push_back(r);
				continue;
			}
			obs_encoder_set_video(r->own_enc, video);
			venc = r->own_enc;
		}
		if (!aenc) {
			if (!replay_aac_) {
				obs_data_t *as = obs_data_create();
				obs_data_set_int(as, "bitrate", 160);
				replay_aac_ = obs_audio_encoder_create("ffmpeg_aac", "ujw:enc:replay-audio", as, 0, nullptr);
				obs_data_release(as);
				if (replay_aac_)
					obs_encoder_set_audio(replay_aac_, obs_get_audio());
			}
			aenc = replay_aac_;
		}
		if (!aenc) {
			r->error = "could not create the AAC encoder";
		} else {
			// Size cap: twice the nominal size of the buffered seconds (CBR) plus room for audio, at least 64 MB.
			int64_t mb = std::max<int64_t>(64, (int64_t)(r->bitrate + 320) * rcfg_.seconds * 2 / 8 / 1024 + 16);
			obs_data_t *os = obs_data_create();
			obs_data_set_int(os, "max_time_sec", rcfg_.seconds);
			obs_data_set_int(os, "max_size_mb", mb);
			obs_data_set_string(os, "directory", replay_dir().c_str());
			obs_data_set_string(os, "format", ("replay-" + canvas + "-%CCYY%MM%DD-%hh%mm%ss").c_str());
			obs_data_set_string(os, "extension", "mkv");
			obs_data_set_bool(os, "allow_spaces", false);
			std::string on = "ujw:replay:" + canvas;
			r->out = obs_output_create("replay_buffer", on.c_str(), os, nullptr);
			obs_data_release(os);
			if (!r->out) {
				r->error = "could not create the replay_buffer output";
			} else {
				obs_output_set_video_encoder(r->out, venc);
				obs_output_set_audio_encoder(r->out, aenc, 0);
				signal_handler_t *sh = obs_output_get_signal_handler(r->out);
				signal_handler_connect(sh, "saved", on_replay_saved, r.get());
				signal_handler_connect(sh, "stop", on_replay_stop, r.get());
				{
					std::lock_guard<std::mutex> l(r->m);
					r->attached = true;
				}
				if (obs_output_start(r->out)) {
					r->started_ms = mono_ms();
				} else {
					const char *le = obs_output_get_last_error(r->out);
					const char *ee = obs_encoder_get_last_error(venc);
					r->error = le && *le ? le : ee && *ee ? ee : "start failed";
				}
			}
		}
		if (r->error.empty())
			hlog::info("replay %s: %d s on %s rung %s (%s, %u kbps, %ux%u)", canvas.c_str(), rcfg_.seconds,
				   r->fallback ? "fallback" : "shared", r->rung_id.c_str(), r->encoder_id.c_str(), r->bitrate,
				   r->w, r->h);
		else
			hlog::warn("replay %s did not start: %s", canvas.c_str(), r->error.c_str());
		std::lock_guard<std::mutex> l(rp_m_);
		replays_.push_back(r);
	}
}

void Outputs::replay_detach_locked()
{
	std::vector<std::shared_ptr<Replay>> old;
	{
		std::lock_guard<std::mutex> l(rp_m_);
		old.swap(replays_);
	}
	for (auto &r : old) {
		{
			std::lock_guard<std::mutex> l(r->m);
			r->attached = false;
			r->cv.notify_all();
		}
		if (r->out) {
			signal_handler_t *sh = obs_output_get_signal_handler(r->out);
			signal_handler_disconnect(sh, "saved", on_replay_saved, r.get());
			signal_handler_disconnect(sh, "stop", on_replay_stop, r.get());
			if (obs_output_active(r->out)) {
				obs_output_stop(r->out);
				int64_t until = mono_ms() + 3000;
				while (obs_output_active(r->out) && mono_ms() < until)
					Sleep(20);
				if (obs_output_active(r->out))
					obs_output_force_stop(r->out);
			}
			obs_output_release(r->out); // a save in progress holds its own reference
			r->out = nullptr;
		}
		if (r->own_enc) {
			obs_encoder_release(r->own_enc);
			r->own_enc = nullptr;
		}
		hlog::info("replay %s detached", r->canvas.c_str());
	}
	if (replay_aac_) {
		obs_encoder_release(replay_aac_);
		replay_aac_ = nullptr;
	}
}

json::Value Outputs::replay_start(int seconds)
{
	std::lock_guard<std::mutex> op(op_m_);
	if (seconds && (seconds < 5 || seconds > 600))
		throw Error(rpc::INVALID_PARAMS, "seconds must be 5..600");
	bool changed = seconds && seconds != rcfg_.seconds;
	if (seconds)
		rcfg_.seconds = seconds;
	if (changed || !replay_want_)
		replay_detach_locked(); // max_time_sec is read at start: restart for a new length
	replay_want_ = true;
	replay_attach_locked();
	return replay_status();
}

json::Value Outputs::replay_stop()
{
	std::lock_guard<std::mutex> op(op_m_);
	replay_want_ = false;
	replay_detach_locked();
	return replay_status();
}

void Outputs::replay_resume()
{
	std::lock_guard<std::mutex> op(op_m_);
	replay_attach_locked();
}

bool Outputs::replay_running(const std::string &canvas) const
{
	std::lock_guard<std::mutex> l(rp_m_);
	for (auto &r : replays_)
		if (r->canvas == canvas && r->out && obs_output_active(r->out))
			return true;
	return false;
}

json::Value Outputs::replay_status() const
{
	std::lock_guard<std::mutex> l(rp_m_);
	json::Value o = json::Value::object();
	o.set("wanted", replay_want_.load());
	o.set("seconds", rcfg_.seconds);
	o.set("dir", replay_dir());
	json::Value fb = json::Value::object();
	fb.set("H", rcfg_.fallback_kbps_h);
	fb.set("V", rcfg_.fallback_kbps_v);
	o.set("fallbackKbps", std::move(fb));
	json::Value a = json::Value::array();
	int64_t now = mono_ms();
	for (auto &r : replays_) {
		json::Value x = json::Value::object();
		x.set("canvas", r->canvas);
		bool active = r->out && obs_output_active(r->out);
		x.set("state", active ? "running" : r->error.empty() ? "stopped" : "failed");
		x.set("rung", r->rung_id);
		x.set("fallback", r->fallback);
		x.set("encoderId", r->encoder_id);
		x.set("bitrate", r->bitrate);
		x.set("w", r->w);
		x.set("h", r->h);
		x.set("bufferedForMs", active && r->started_ms ? json::Value(now - r->started_ms) : json::Value());
		x.set("bytes", r->out ? json::Value((uint64_t)obs_output_get_total_bytes(r->out)) : json::Value());
		x.set("error", r->error.empty() ? json::Value() : json::Value(r->error));
		std::lock_guard<std::mutex> rl(r->m);
		x.set("saves", r->saved_count);
		x.set("lastPath", r->last_path.empty() ? json::Value() : json::Value(r->last_path));
		a.push(std::move(x));
	}
	o.set("canvases", std::move(a));
	return o;
}

json::Value Outputs::replay_save(const std::string &canvas, const std::string &dir, const std::string &name_fmt,
				 int timeout_ms)
{
	std::vector<std::shared_ptr<Replay>> sel;
	{
		std::lock_guard<std::mutex> l(rp_m_);
		for (auto &r : replays_)
			if (canvas.empty() || r->canvas == canvas)
				sel.push_back(r);
	}
	json::Value saved = json::Value::array(), errors = json::Value::array();
	auto err = [&](const std::string &cv, const std::string &e) {
		json::Value x = json::Value::object();
		x.set("canvas", cv);
		x.set("error", e);
		errors.push(std::move(x));
	};
	if (sel.empty())
		err(canvas.empty() ? "*" : canvas, "replay buffer not running (replay.start)");

	struct Pending {
		std::shared_ptr<Replay> r;
		obs_output_t *ref = nullptr;
		std::unique_lock<std::mutex> save_lock;
		uint64_t before = 0;
	};
	std::vector<Pending> pend;
	// 1. Mark every save first (H then V, a fixed order), so both files cover the same moment.
	for (auto &r : sel) {
		Pending p;
		p.r = r;
		p.save_lock = std::unique_lock<std::mutex>(r->save_m);
		{
			std::lock_guard<std::mutex> l(r->m);
			if (r->attached && r->out)
				p.ref = obs_output_get_ref(r->out);
			p.before = r->saved_count;
		}
		if (!p.ref || !obs_output_active(p.ref)) {
			err(r->canvas, r->error.empty() ? "replay buffer not running" : r->error);
			if (p.ref)
				obs_output_release(p.ref);
			continue;
		}
		obs_data_t *os = obs_data_create();
		obs_data_set_string(os, "directory", dir.c_str());
		obs_data_set_string(os, "format", unique_literal_name(dir, replace_all(name_fmt, "{canvas}", r->canvas)).c_str());
		obs_output_update(p.ref, os);
		obs_data_release(os);
		calldata_t cd = {};
		proc_handler_call(obs_output_get_proc_handler(p.ref), "save", &cd);
		calldata_free(&cd);
		pend.push_back(std::move(p));
	}
	// 2. Wait for each "saved" signal, then read the path libobs wrote.
	for (auto &p : pend) {
		Replay &r = *p.r;
		bool ok = false, gone = false, stopped = false;
		{
			std::unique_lock<std::mutex> l(r.m);
			ok = r.cv.wait_for(l, std::chrono::milliseconds(timeout_ms), [&] {
				return r.saved_count > p.before || !r.attached || r.stopped;
			}) && r.saved_count > p.before;
			gone = !r.attached;
			stopped = r.stopped;
		}
		if (!ok) {
			err(r.canvas, gone ? "replay stopped during the save" : stopped ? "replay stopped by libobs" :
				"no saved signal within " + std::to_string(timeout_ms) + " ms (see the host log)");
			obs_output_release(p.ref);
			continue;
		}
		calldata_t cd = {};
		proc_handler_call(obs_output_get_proc_handler(p.ref), "get_last_replay", &cd);
		const char *path = calldata_string(&cd, "path");
		std::string sp = path ? path : "";
		calldata_free(&cd);
		obs_output_release(p.ref);
		if (sp.empty()) {
			err(r.canvas, "saved, but libobs did not report the path");
			continue;
		}
		{
			std::lock_guard<std::mutex> l(r.m);
			r.last_path = sp;
		}
		std::error_code ec;
		uintmax_t bytes = fs::file_size(fs::u8path(sp), ec);
		json::Value x = json::Value::object();
		x.set("canvas", r.canvas);
		x.set("path", sp);
		x.set("bytes", ec ? json::Value() : json::Value((uint64_t)bytes));
		x.set("rung", r.rung_id);
		x.set("fallback", r.fallback);
		saved.push(std::move(x));
		hlog::info("replay %s saved (%llu bytes)", r.canvas.c_str(), ec ? 0ULL : (unsigned long long)bytes);
	}
	json::Value o = json::Value::object();
	o.set("saved", std::move(saved));
	o.set("errors", std::move(errors));
	return o;
}
