// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: clip markers and feedback captures (A0 day 2; alpha plan Part A item 8 and Part B).
//
// Markers: marker.add {source: hotkey|chat|audio|api, note?} appends one JSON line to
//   <markersDir>/<session>.jsonl (session = the host start, local time YYYYMMDD-HHMMSS):
//   {"v":1,"at":ISO UTC,"source":...,"note":...|absent,"hostMs":n,"streamMs":n|null,"recordMs":n|null,
//    "scenes":{"H":id|null,"V":id|null}}
//   streamMs / recordMs are relative to the current streaming period / recording (Outputs::clocks). A note is at
//   most 500 bytes; control characters become spaces (chat notes are untrusted text, stored, never executed).
//   Only the hotkey source is wired now; chat and audio are API entry points for later callers.
//
// Feedback (D136, Ctrl+Alt+F): capture() makes <feedbackDir>/<YYYY-MM-DD>/<HHMMSS>/ (local time; "-2", "-3" if the
//   folder exists) and writes, at once: moment.json (time, version, active scene per canvas, host.status with CPU,
//   GPU, dropped and lagged frames) and log.txt (the last 200 lines of the D144 ring, already token-redacted). A
//   worker then saves the replay buffers H and V into the folder (replay-H.mkv, replay-V.mkv) and rewrites
//   moment.json with the result. File names only in moment.json, never absolute paths. Voice note: not done.
#pragma once

#include "json.h"

#include <condition_variable>
#include <deque>
#include <mutex>
#include <string>
#include <thread>

struct App;

class Moments {
public:
	struct Config {
		std::string markers_dir, feedback_dir, session;
	};
	Moments(App &app, Config c);
	~Moments();
	Moments(const Moments &) = delete;
	Moments &operator=(const Moments &) = delete;

	json::Value marker_add(const std::string &source, const std::string &note); // throws rpc::Error
	json::Value feedback_capture(const std::string &trigger, const std::string &note); // throws rpc::Error
	json::Value status() const;
	void stop(); // finishes queued captures (bounded by the replay save timeout), then ends the worker

private:
	struct Job {
		std::string dir;
		json::Value moment;
	};
	App &app_;
	Config cfg_;
	mutable std::mutex m_;      // markers file, counters
	std::mutex qm_;
	std::condition_variable qcv_;
	std::deque<Job> q_;
	bool stop_ = false;
	int busy_ = 0;
	std::thread worker_;
	uint64_t markers_ = 0, captures_ = 0;
	std::string last_capture_;
	void run();
};
