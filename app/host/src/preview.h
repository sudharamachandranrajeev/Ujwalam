// SPDX-License-Identifier: GPL-2.0-or-later
// ujwalam-host: native preview windows (Win32 + obs_display_create), one per canvas (H, V). D1: the web control
// UI drives the studio, previews are native libobs windows. Windows are resizable; the canvas is drawn letterboxed
// at its own aspect ratio. Closing a window only closes the preview.
#pragma once

#include "json.h"

#include <condition_variable>
#include <functional>
#include <map>
#include <mutex>
#include <string>
#include <thread>

class Previews {
public:
	Previews();
	~Previews();

	struct OpenArgs {
		std::string canvas; // "H" | "V"
		int x = -1, y = -1, width = 0, height = 0; // client size; 0 = default for the canvas aspect
		bool topmost = false;
	};
	// Opens (or focuses, if open) the window for a canvas. Returns {canvas, open, hwnd, width, height}.
	json::Value open(const OpenArgs &a);
	json::Value focus(const std::string &canvas);
	json::Value close(const std::string &canvas);
	json::Value list();
	void close_all();

	struct Win; // internal (public for the window procedure)

private:
	std::thread ui_;
	unsigned long ui_tid_ = 0;
	std::mutex m_;
	std::condition_variable cv_;
	bool ready_ = false;
	std::map<std::string, Win *> wins_;
	void ui_loop();
	json::Value run_on_ui(std::function<json::Value()> fn);
};
