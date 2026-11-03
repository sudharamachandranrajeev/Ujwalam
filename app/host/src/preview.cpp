// SPDX-License-Identifier: GPL-2.0-or-later
// ujwalam-host: native preview windows. See preview.h.
//
// Threading: windows are created and pumped on one UI thread. obs_display draws on the libobs graphics thread
// through draw_cb; it looks the canvas up by name on every frame (a strong ref held only for that frame), so a
// canvas that is reset or removed by a project load never dangles here.
#include "preview.h"
#include "log.h"
#include "rpc_server.h"

#include <obs.h>

#include <windows.h>

#include <algorithm>
#include <future>
#include <vector>

static const wchar_t *kClass = L"UjwalamPreview";
static const UINT WM_APP_RUN = WM_APP + 1;

struct Previews::Win {
	std::string canvas;
	HWND hwnd = nullptr;
	obs_display_t *display = nullptr;
	Previews *owner = nullptr;
	std::string screen; // where it opened: "laptop display" | "second display", plus the GDI device name
};

namespace {

void canvas_base(const std::string &canvas, uint32_t &w, uint32_t &h, obs_canvas_t **out)
{
	*out = nullptr;
	struct obs_video_info ovi = {};
	if (canvas == "H") {
		obs_get_video_info(&ovi);
	} else {
		obs_canvas_t *c = obs_get_canvas_by_name(canvas.c_str());
		if (c && obs_canvas_get_video_info(c, &ovi))
			*out = c;
		else if (c)
			obs_canvas_release(c);
	}
	w = ovi.base_width;
	h = ovi.base_height;
}

void draw_cb(void *param, uint32_t cx, uint32_t cy)
{
	auto *w = static_cast<Previews::Win *>(param);
	uint32_t bw = 0, bh = 0;
	obs_canvas_t *c = nullptr;
	canvas_base(w->canvas, bw, bh, &c);
	if (!bw || !bh || !cx || !cy || (w->canvas != "H" && !c)) {
		if (c)
			obs_canvas_release(c);
		return;
	}
	double scale = std::min((double)cx / bw, (double)cy / bh);
	int vw = (int)(bw * scale), vh = (int)(bh * scale);
	int vx = ((int)cx - vw) / 2, vy = ((int)cy - vh) / 2;
	gs_viewport_push();
	gs_projection_push();
	gs_ortho(0.0f, (float)bw, 0.0f, (float)bh, -100.0f, 100.0f);
	gs_set_viewport(vx, vy, vw, vh);
	if (w->canvas == "H")
		obs_render_main_texture();
	else
		obs_render_canvas_texture(c);
	gs_projection_pop();
	gs_viewport_pop();
	if (c)
		obs_canvas_release(c);
}

LRESULT CALLBACK wnd_proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp)
{
	auto *w = reinterpret_cast<Previews::Win *>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
	switch (msg) {
	case WM_SIZE:
		if (w && w->display) {
			RECT r;
			GetClientRect(hwnd, &r);
			if (r.right > 0 && r.bottom > 0)
				obs_display_resize(w->display, (uint32_t)r.right, (uint32_t)r.bottom);
		}
		return 0;
	case WM_ERASEBKGND:
		return 1;
	case WM_MOUSEACTIVATE: // a click never activates the window or takes focus (D191)
		return MA_NOACTIVATE;
	case WM_CLOSE:
		if (w && w->display) {
			obs_display_remove_draw_callback(w->display, draw_cb, w);
			obs_display_destroy(w->display);
			w->display = nullptr;
		}
		DestroyWindow(hwnd);
		return 0;
	case WM_NCDESTROY:
		if (w) {
			w->hwnd = nullptr;
			SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
		}
		break;
	}
	return DefWindowProcW(hwnd, msg, wp, lp);
}

struct Display {
	std::wstring device; // \\.\DISPLAYn
	RECT work = {};
	bool primary = false;
	bool internal = false;
};

BOOL CALLBACK enum_monitor(HMONITOR mon, HDC, LPRECT, LPARAM lp)
{
	MONITORINFOEXW mi = {};
	mi.cbSize = sizeof(mi);
	if (GetMonitorInfoW(mon, &mi)) {
		Display d;
		d.device = mi.szDevice;
		d.work = mi.rcWork;
		d.primary = (mi.dwFlags & MONITORINFOF_PRIMARY) != 0;
		reinterpret_cast<std::vector<Display> *>(lp)->push_back(d);
	}
	return TRUE;
}

// GDI device names (\\.\DISPLAYn) of built-in panels (laptop screens), from the display configuration.
std::vector<std::wstring> internal_devices()
{
	std::vector<std::wstring> out;
	UINT32 np = 0, nm = 0;
	if (GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &np, &nm) != ERROR_SUCCESS)
		return out;
	std::vector<DISPLAYCONFIG_PATH_INFO> paths(np);
	std::vector<DISPLAYCONFIG_MODE_INFO> modes(nm);
	if (QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, &np, paths.data(), &nm, modes.data(), nullptr) != ERROR_SUCCESS)
		return out;
	for (UINT32 i = 0; i < np; i++) {
		DISPLAYCONFIG_TARGET_DEVICE_NAME tn = {};
		tn.header.type = DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME;
		tn.header.size = sizeof(tn);
		tn.header.adapterId = paths[i].targetInfo.adapterId;
		tn.header.id = paths[i].targetInfo.id;
		if (DisplayConfigGetDeviceInfo(&tn.header) != ERROR_SUCCESS)
			continue;
		if (tn.outputTechnology != DISPLAYCONFIG_OUTPUT_TECHNOLOGY_INTERNAL)
			continue;
		DISPLAYCONFIG_SOURCE_DEVICE_NAME sn = {};
		sn.header.type = DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME;
		sn.header.size = sizeof(sn);
		sn.header.adapterId = paths[i].sourceInfo.adapterId;
		sn.header.id = paths[i].sourceInfo.id;
		if (DisplayConfigGetDeviceInfo(&sn.header) == ERROR_SUCCESS)
			out.push_back(sn.viewGdiDeviceName);
	}
	return out;
}

// The display previews may use (D191): the built-in panel if it is not the main display, else the first non-main
// display. One display -> none (the caller refuses; a preview must never cover the main screen).
bool pick_display(Display &out, std::string &why)
{
	std::vector<Display> all;
	EnumDisplayMonitors(nullptr, nullptr, enum_monitor, reinterpret_cast<LPARAM>(&all));
	if (all.size() < 2) {
		why = "one display";
		return false;
	}
	auto internal = internal_devices();
	for (auto &d : all)
		d.internal = std::find(internal.begin(), internal.end(), d.device) != internal.end();
	for (auto &d : all)
		if (d.internal && !d.primary) {
			out = d;
			why = "laptop display";
			return true;
		}
	for (auto &d : all)
		if (!d.primary) {
			out = d;
			why = "second display";
			return true;
		}
	why = "no non-main display";
	return false;
}

std::string narrow(const std::wstring &w)
{
	std::string s;
	for (wchar_t c : w)
		s += (c < 128) ? (char)c : '?';
	return s;
}

// Brings a preview above other windows without activating it or taking focus (D191). Restores it if minimised.
void raise_no_activate(HWND hwnd)
{
	if (IsIconic(hwnd))
		ShowWindow(hwnd, SW_SHOWNOACTIVATE);
	SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
}

} // namespace

Previews::Previews(bool headless) : headless_(headless)
{
	ui_ = std::thread([this] { ui_loop(); });
	std::unique_lock<std::mutex> l(m_);
	cv_.wait(l, [this] { return ready_; });
}

Previews::~Previews()
{
	close_all();
	if (ui_tid_)
		PostThreadMessageW(ui_tid_, WM_QUIT, 0, 0);
	if (ui_.joinable())
		ui_.join();
	for (auto &kv : wins_)
		delete kv.second;
}

void Previews::ui_loop()
{
	SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
	WNDCLASSEXW wc = {sizeof(wc)};
	wc.lpfnWndProc = wnd_proc;
	wc.hInstance = GetModuleHandleW(nullptr);
	wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
	wc.hbrBackground = (HBRUSH)GetStockObject(BLACK_BRUSH);
	wc.lpszClassName = kClass;
	RegisterClassExW(&wc);
	MSG msg;
	PeekMessageW(&msg, nullptr, WM_USER, WM_USER, PM_NOREMOVE); // create the thread message queue
	{
		std::lock_guard<std::mutex> l(m_);
		ui_tid_ = GetCurrentThreadId();
		ready_ = true;
	}
	cv_.notify_all();
	while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
		if (msg.hwnd == nullptr && msg.message == WM_APP_RUN) {
			auto *fn = reinterpret_cast<std::function<void()> *>(msg.lParam);
			(*fn)();
			delete fn;
			continue;
		}
		TranslateMessage(&msg);
		DispatchMessageW(&msg);
	}
}

json::Value Previews::run_on_ui(std::function<json::Value()> fn)
{
	auto prom = std::make_shared<std::promise<json::Value>>();
	auto fut = prom->get_future();
	auto *task = new std::function<void()>([fn, prom] {
		try {
			prom->set_value(fn());
		} catch (...) {
			prom->set_exception(std::current_exception());
		}
	});
	if (!PostThreadMessageW(ui_tid_, WM_APP_RUN, 0, (LPARAM)task)) {
		delete task;
		throw rpc::Error(rpc::INTERNAL, "preview thread unavailable");
	}
	if (fut.wait_for(std::chrono::seconds(10)) != std::future_status::ready)
		throw rpc::Error(rpc::UNAVAILABLE, "preview thread timeout");
	return fut.get();
}

static json::Value win_json(const Previews::Win *w)
{
	json::Value o = json::Value::object();
	o.set("canvas", w->canvas);
	bool open = w->hwnd && IsWindow(w->hwnd);
	o.set("open", open);
	if (open) {
		RECT r;
		GetClientRect(w->hwnd, &r);
		o.set("width", (int)r.right);
		o.set("height", (int)r.bottom);
		RECT wr;
		GetWindowRect(w->hwnd, &wr);
		o.set("x", (int)wr.left);
		o.set("y", (int)wr.top);
		o.set("display", w->screen);
	}
	return o;
}

json::Value Previews::open(const OpenArgs &a)
{
	if (headless_)
		throw rpc::Error(rpc::CONFLICT, "headless (--headless / UJWALAM_HEADLESS=1): no preview windows");
	return run_on_ui([this, a]() -> json::Value {
		auto found = wins_.find(a.canvas);
		if (found != wins_.end() && found->second->hwnd && IsWindow(found->second->hwnd)) {
			raise_no_activate(found->second->hwnd);
			return win_json(found->second);
		}
		Display disp;
		std::string why;
		if (!pick_display(disp, why))
			throw rpc::Error(rpc::CONFLICT, "no preview: " + why +
								  " (previews open only on a second display and never on the main one)");
		Win *&w = wins_[a.canvas]; // created only past the refusals: list() never sees a null entry
		if (!w) {
			w = new Win;
			w->canvas = a.canvas;
			w->owner = this;
		}
		uint32_t bw = 0, bh = 0;
		obs_canvas_t *c = nullptr;
		canvas_base(a.canvas, bw, bh, &c);
		if (c)
			obs_canvas_release(c);
		if (!bw || !bh)
			throw rpc::Error(rpc::CONFLICT, "canvas " + a.canvas + " does not exist (load a project with it first)");
		int cw = a.width, ch = a.height;
		if (cw <= 0 || ch <= 0) { // default: 540 px on the short side, canvas aspect
			double s = 540.0 / std::min(bw, bh);
			cw = (int)(bw * s);
			ch = (int)(bh * s);
		}
		DWORD style = WS_OVERLAPPEDWINDOW;
		DWORD ex = WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | (a.topmost ? WS_EX_TOPMOST : 0);
		const LONG ww = disp.work.right - disp.work.left, wh = disp.work.bottom - disp.work.top;
		RECT r = {0, 0, cw, ch};
		AdjustWindowRectExForDpi(&r, style, FALSE, ex, GetDpiForSystem());
		LONG fw = r.right - r.left, fh = r.bottom - r.top;
		if (fw > ww || fh > wh) { // shrink the client area (canvas aspect kept) until the frame fits the work area
			double s = std::min((double)ww / fw, (double)wh / fh);
			cw = std::max(1, (int)(cw * s) - 16);
			ch = std::max(1, (int)(ch * s) - 16);
			r = {0, 0, cw, ch};
			AdjustWindowRectExForDpi(&r, style, FALSE, ex, GetDpiForSystem());
			fw = r.right - r.left;
			fh = r.bottom - r.top;
		}
		// Default spot: H at the work area's left edge, V at its right edge. A given x/y is clamped into the
		// chosen display's work area, so a stale position can never put the window on the main display.
		LONG x = a.x >= 0 ? a.x : (a.canvas == "H" ? disp.work.left + 16 : disp.work.right - fw - 16);
		LONG y = a.y >= 0 ? a.y : disp.work.top + 16;
		x = std::clamp<LONG>(x, disp.work.left, std::max<LONG>(disp.work.left, disp.work.right - fw));
		y = std::clamp<LONG>(y, disp.work.top, std::max<LONG>(disp.work.top, disp.work.bottom - fh));
		std::wstring title = L"Ujwalam preview - " + std::wstring(a.canvas.begin(), a.canvas.end()) + L" (" +
				     std::to_wstring(bw) + L"x" + std::to_wstring(bh) + L")";
		HWND hwnd = CreateWindowExW(ex, kClass, title.c_str(), style, x, y, fw, fh, nullptr, nullptr,
					    GetModuleHandleW(nullptr), nullptr);
		if (!hwnd)
			throw rpc::Error(rpc::INTERNAL, "CreateWindow failed");
		SetWindowLongPtrW(hwnd, GWLP_USERDATA, (LONG_PTR)w);
		w->hwnd = hwnd;
		RECT cr;
		GetClientRect(hwnd, &cr);
		struct gs_init_data gid = {};
		gid.cx = (uint32_t)std::max<LONG>(1, cr.right);
		gid.cy = (uint32_t)std::max<LONG>(1, cr.bottom);
		gid.format = GS_BGRA;
		gid.zsformat = GS_ZS_NONE;
		gid.window.hwnd = hwnd;
		w->display = obs_display_create(&gid, 0xFF101010);
		if (!w->display) {
			DestroyWindow(hwnd);
			throw rpc::Error(rpc::INTERNAL, "obs_display_create failed");
		}
		obs_display_add_draw_callback(w->display, draw_cb, w);
		w->screen = why + " " + narrow(disp.device);
		// The first ShowWindow in a process started with STARTF_USESHOWWINDOW (Node's windowsHide: true) may
		// take the parent's SW_HIDE instead of ours; this hide call absorbs that, then show without activating.
		ShowWindow(hwnd, SW_HIDE);
		ShowWindow(hwnd, SW_SHOWNOACTIVATE);
		UpdateWindow(hwnd);
		hlog::info("preview opened: %s %dx%d at %ld,%ld on the %s (no focus)", a.canvas.c_str(), (int)cr.right,
			   (int)cr.bottom, (long)x, (long)y, w->screen.c_str());
		return win_json(w);
	});
}

json::Value Previews::focus(const std::string &canvas)
{
	return run_on_ui([this, canvas]() -> json::Value {
		auto it = wins_.find(canvas);
		if (it == wins_.end() || !it->second->hwnd || !IsWindow(it->second->hwnd))
			throw rpc::Error(rpc::CONFLICT, "preview " + canvas + " is not open");
		raise_no_activate(it->second->hwnd);
		return win_json(it->second);
	});
}

json::Value Previews::close(const std::string &canvas)
{
	return run_on_ui([this, canvas]() -> json::Value {
		auto it = wins_.find(canvas);
		if (it != wins_.end() && it->second->hwnd && IsWindow(it->second->hwnd))
			SendMessageW(it->second->hwnd, WM_CLOSE, 0, 0);
		json::Value o = json::Value::object();
		o.set("canvas", canvas);
		o.set("open", false);
		return o;
	});
}

json::Value Previews::list()
{
	return run_on_ui([this]() -> json::Value {
		json::Value a = json::Value::array();
		for (auto &kv : wins_)
			a.push(win_json(kv.second));
		json::Value r = json::Value::object();
		r.set("previews", std::move(a));
		return r;
	});
}

void Previews::close_all()
{
	if (!ui_tid_)
		return;
	try {
		run_on_ui([this]() -> json::Value {
			for (auto &kv : wins_)
				if (kv.second->hwnd && IsWindow(kv.second->hwnd))
					SendMessageW(kv.second->hwnd, WM_CLOSE, 0, 0);
			return json::Value();
		});
	} catch (...) {
	}
}
