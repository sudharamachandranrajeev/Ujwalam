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

#include <future>

static const wchar_t *kClass = L"UjwalamPreview";
static const UINT WM_APP_RUN = WM_APP + 1;

struct Previews::Win {
	std::string canvas;
	HWND hwnd = nullptr;
	obs_display_t *display = nullptr;
	Previews *owner = nullptr;
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

} // namespace

Previews::Previews()
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
	}
	return o;
}

json::Value Previews::open(const OpenArgs &a)
{
	return run_on_ui([this, a]() -> json::Value {
		Win *&w = wins_[a.canvas];
		if (w && w->hwnd && IsWindow(w->hwnd)) {
			ShowWindow(w->hwnd, SW_RESTORE);
			SetForegroundWindow(w->hwnd);
			return win_json(w);
		}
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
		RECT r = {0, 0, cw, ch};
		DWORD style = WS_OVERLAPPEDWINDOW;
		AdjustWindowRectExForDpi(&r, style, FALSE, 0, GetDpiForSystem());
		std::wstring title = L"Ujwalam preview - " + std::wstring(a.canvas.begin(), a.canvas.end()) + L" (" +
				     std::to_wstring(bw) + L"x" + std::to_wstring(bh) + L")";
		HWND hwnd = CreateWindowExW(a.topmost ? WS_EX_TOPMOST : 0, kClass, title.c_str(), style,
					    a.x >= 0 ? a.x : CW_USEDEFAULT, a.y >= 0 ? a.y : CW_USEDEFAULT, r.right - r.left,
					    r.bottom - r.top, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
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
		ShowWindow(hwnd, SW_SHOWNORMAL);
		UpdateWindow(hwnd);
		hlog::info("preview opened: %s %dx%d", a.canvas.c_str(), (int)cr.right, (int)cr.bottom);
		return win_json(w);
	});
}

json::Value Previews::focus(const std::string &canvas)
{
	return run_on_ui([this, canvas]() -> json::Value {
		auto it = wins_.find(canvas);
		if (it == wins_.end() || !it->second->hwnd || !IsWindow(it->second->hwnd))
			throw rpc::Error(rpc::CONFLICT, "preview " + canvas + " is not open");
		ShowWindow(it->second->hwnd, SW_RESTORE);
		SetForegroundWindow(it->second->hwnd);
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
