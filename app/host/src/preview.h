// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: native preview windows (Win32 + obs_display_create), one per canvas (H, V). D1: the web control
// UI drives the studio, previews are native libobs windows. Windows are resizable; the canvas is drawn letterboxed
// at its own aspect ratio. Closing a window only closes the preview.
//
// Focus and placement (user, 2026-11-09, D316): a stand-alone preview is a normal window. It opens on the main
// display (also with one display), shows in the taskbar and activates when shown or clicked. A given x/y that lies
// on any display is kept; otherwise it is clamped into the main display's work area. Embedded previews (parent set)
// stay WS_CHILD windows of the studio's preview slot and leave activation to the studio window. Headless
// (--headless / UJWALAM_HEADLESS=1, used by every test run): open() refuses with CONFLICT and no window exists.
//
// Mouse editing (P5, D230, flag preview-edit): clicks in a preview select, move and resize layers (preview_edit.h).
// The window takes mouse capture while a drag runs.
#pragma once

#include "json.h"
#include "preview_edit.h"

#include <condition_variable>
#include <cstdint>
#include <functional>
#include <map>
#include <mutex>
#include <string>
#include <thread>

class Previews {
public:
	// edit: the studio hooks for mouse editing on the preview (preview_edit.h; off until set_enabled).
	explicit Previews(bool headless = false, pedit::Backend edit = {});
	~Previews();
	// Mouse editing (flag preview-edit). Usable headless too (preview.editSim drives it without a window).
	pedit::Editor &editor() { return editor_; }

	struct OpenArgs {
		std::string canvas; // "H" | "V"
		int x = -1, y = -1, width = 0, height = 0; // client size; 0 = default for the canvas aspect
		bool topmost = false;
		// Embedded (P5a step 4): a window handle of the studio shell. The preview becomes a child window of it at
		// x,y (parent client pixels) with width x height (both required); calling open again with the same parent
		// moves/resizes it. It follows the studio window wherever that is.
		uint64_t parent = 0;
	};
	// Opens (or raises, if open) the window for a canvas. Returns {canvas, open, width, height, x, y, display}.
	json::Value open(const OpenArgs &a);
	// Brings a stand-alone window to the front like a normal window (D316); an embedded one only moves to the top of
	// its siblings in the studio slot.
	json::Value focus(const std::string &canvas);
	json::Value close(const std::string &canvas);
	json::Value list();
	void close_all();

	struct Win; // internal (public for the window procedure)

private:
	bool headless_ = false;
	pedit::Editor editor_;
	std::thread ui_;
	unsigned long ui_tid_ = 0;
	std::mutex m_;
	std::condition_variable cv_;
	bool ready_ = false;
	std::map<std::string, Win *> wins_;
	void ui_loop();
	json::Value run_on_ui(std::function<json::Value()> fn);
	json::Value open_embedded(const OpenArgs &a);
};
