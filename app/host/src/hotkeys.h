// SPDX-License-Identifier: GPL-2.0-or-later
// ujwalam-host: global hotkeys (A0 day 2). RegisterHotKey on a dedicated message-loop thread (the hotkeys belong to
// that thread's queue, no window). A binding that cannot be registered (bad combo, taken by another program or by
// another binding) is logged and reported in host.info.hotkeys; it is never fatal.
//
// The handler runs on the hotkey thread and must return quickly (panic and marker do; feedback queues its work).
// trigger(name) runs the same handler on the caller's thread (RPC hotkeys.trigger, only with --test-hooks).
#pragma once

#include "json.h"

#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

class Hotkeys {
public:
	using Handler = std::function<void(const std::string &name, const char *via)>;
	Hotkeys() = default;
	~Hotkeys();
	Hotkeys(const Hotkeys &) = delete;
	Hotkeys &operator=(const Hotkeys &) = delete;

	// bindings: name -> combo ("" = binding off). With register_keys, registers on a new thread and returns once
	// registration is done; without, only the handler table is kept (hotkeys.trigger works, no key is taken).
	void start(const std::vector<std::pair<std::string, std::string>> &bindings, Handler h, bool register_keys);
	void stop();
	json::Value status() const; // {enabled, bindings: [{name, combo, registered, error}]}
	bool trigger(const std::string &name); // false if no binding has that name

	// "Ctrl+Alt+P" -> MOD_* flags and a virtual key. false for anything else.
	static bool parse_combo(const std::string &combo, unsigned &mods, unsigned &vk);

private:
	struct Binding {
		std::string name, combo, error;
		unsigned mods = 0, vk = 0;
		bool registered = false;
		int presses = 0;
	};
	mutable std::mutex m_;
	std::vector<Binding> b_;
	Handler handler_;
	std::thread t_;
	unsigned long tid_ = 0;
	bool started_ = false;
	void run(std::vector<Binding> *init, void *ready_event);
	void dispatch(size_t index, const char *via);
};
