// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: native preview windows. See preview.h.
//
// Threading: windows are created and pumped on one UI thread. obs_display draws on the libobs graphics thread
// through draw_cb; it looks the canvas up by name on every frame (a strong ref held only for that frame), so a
// canvas that is reset or removed by a project load never dangles here.
#include "preview.h"
#include "log.h"
#include "rpc_server.h"

#include <obs.h>
#include <graphics/vec4.h>

#include <windows.h>
#include <windowsx.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <future>
#include <vector>

static const wchar_t *kClass = L"UjwalamPreview";
static const UINT WM_APP_RUN = WM_APP + 1;
static const UINT_PTR kRefreshTimer = 1; // re-reads the selected layer's placement (inspector edits, scene switches)
static const UINT_PTR kDragTimer = 2;    // while dragging: applies a rectangle that waits for the apply interval (D335)

struct Previews::Win {
	std::string canvas;
	mutable std::atomic<double> dpi{1.0}; // window DPI / 96, set on the UI thread (view_of), read by draw_cb
	HWND hwnd = nullptr;
	obs_display_t *display = nullptr;
	Previews *owner = nullptr;
	std::string screen; // where it opened: "main display" or "embedded", plus the GDI device name
	HWND parent = nullptr; // embedded: the studio shell window it is a child of
	// Headless embedded (LU4 tests, Codex review of D346): the child window never gets WS_VISIBLE, so it stays unseen
	// whatever later happens to the parent (a child is visible only with its own WS_VISIBLE). Show requests are
	// stripped in WM_WINDOWPOSCHANGING and WM_STYLECHANGING; one that gets past both is undone by the refresh timer.
	bool never_show = false;
	// Selection boxes drawn (graphics thread); preview.list shows it so a test knows the box was really drawn.
	std::atomic<uint64_t> selection_draws{0};
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

// libobs's immediate vertex buffer holds IMMEDIATE_COUNT (512) vertices; gs_vertex2f past it would grow the array that
// buffer owns. Each solid_pass resets the count; a quad that does not fit is left out (a selection box needs 60).
constexpr int kImmediateMax = 512;
thread_local int g_verts = 0;

// Immediate-mode triangles (two per quad) in canvas coordinates; the caller has the solid effect's pass open.
void quad(float ax, float ay, float bx, float by, float cx, float cy, float dx, float dy) // a b c d around
{
	if (g_verts + 6 > kImmediateMax)
		return;
	g_verts += 6;
	gs_vertex2f(ax, ay);
	gs_vertex2f(bx, by);
	gs_vertex2f(cx, cy);
	gs_vertex2f(ax, ay);
	gs_vertex2f(cx, cy);
	gs_vertex2f(dx, dy);
}

// A line of thickness t from p to q, extended by t/2 at both ends so that box corners close.
void line(double px, double py, double qx, double qy, double t)
{
	double dx = qx - px, dy = qy - py, len = std::hypot(dx, dy);
	if (len <= 0)
		return;
	double ux = dx / len * t / 2, uy = dy / len * t / 2; // along
	double nx = -uy, ny = ux;                            // across
	px -= ux;
	py -= uy;
	qx += ux;
	qy += uy;
	quad((float)(px + nx), (float)(py + ny), (float)(qx + nx), (float)(qy + ny), (float)(qx - nx), (float)(qy - ny),
	     (float)(px - nx), (float)(py - ny));
}

void solid_pass(const vec4 &col, const std::function<void()> &emit)
{
	gs_effect_t *solid = obs_get_base_effect(OBS_EFFECT_SOLID);
	gs_eparam_t *color = gs_effect_get_param_by_name(solid, "color");
	gs_effect_set_vec4(color, &col);
	gs_technique_t *tech = gs_effect_get_technique(solid, "Solid");
	gs_technique_begin(tech);
	gs_technique_begin_pass(tech, 0);
	// Immediate mode (false): libobs's own persistent vertex buffer. gs_render_start(true) + gs_render_stop makes a
	// buffer, draws it and destroys it while the d3d11 device still has it loaded as the current vertex buffer; the next
	// draw that does not load its own buffer then reads freed memory ("This vertex shader requires a point buffer", then
	// an access violation in d3d11: host crash 2026-11-11, a shadow switched on while a selection box was drawn).
	g_verts = 0;
	gs_render_start(false);
	emit();
	gs_render_stop(GS_TRIS);
	gs_load_vertexbuffer(nullptr); // leave no buffer of ours loaded for the draws that follow in this frame
	gs_technique_end_pass(tech);
	gs_technique_end(tech);
}

// Selection box, corner handles and the rotate handle (24 screen px above the top edge, preview_edit.cpp), in canvas coordinates (the caller's ortho), sized in screen px (k = canvas px
// per screen px) so they look the same at any preview size. A dark rim under a light line reads on any picture.
void draw_selection(const pedit::Rect &r, double k)
{
	double c[4][2];
	pedit::corners(r, c);
	double tx = (c[0][0] + c[1][0]) / 2, ty = (c[0][1] + c[1][1]) / 2, hx, hy;
	pedit::rotate_handle(r, 24 * k, hx, hy);
	auto box = [&](double t, double hs) {
		for (int i = 0; i < 4; i++)
			line(c[i][0], c[i][1], c[(i + 1) % 4][0], c[(i + 1) % 4][1], t);
		line(tx, ty, hx, hy, t);
		quad((float)hx, (float)(hy - hs), (float)(hx + hs), (float)hy, (float)hx, (float)(hy + hs), (float)(hx - hs),
		     (float)hy); // a diamond: the rotate handle
		for (auto &p : c)
			quad((float)(p[0] - hs), (float)(p[1] - hs), (float)(p[0] + hs), (float)(p[1] - hs), (float)(p[0] + hs),
			     (float)(p[1] + hs), (float)(p[0] - hs), (float)(p[1] + hs));
		const double es = hs * 0.75; // edge handles (D330): smaller squares at the middle of each side
		for (int i = 0; i < 4; i++) {
			const double ex = (c[i][0] + c[(i + 1) % 4][0]) / 2, ey = (c[i][1] + c[(i + 1) % 4][1]) / 2;
			quad((float)(ex - es), (float)(ey - es), (float)(ex + es), (float)(ey - es), (float)(ex + es), (float)(ey + es),
			     (float)(ex - es), (float)(ey + es));
		}
	};
	vec4 rim, fg;
	vec4_set(&rim, 0.0f, 0.0f, 0.0f, 1.0f);
	vec4_set(&fg, 0.36f, 0.75f, 1.0f, 1.0f);
	solid_pass(rim, [&] { box(4 * k, 6 * k); });
	solid_pass(fg, [&] { box(2 * k, 5 * k); });
}

// Snap guide lines (D272) across the whole canvas, sized in screen px like the selection box.
void draw_guides(double x, double y, double cw, double ch, double k)
{
	auto lines = [&](double t) {
		if (!std::isnan(x))
			line(x, 0, x, ch, t);
		if (!std::isnan(y))
			line(0, y, cw, y, t);
	};
	vec4 rim, fg;
	vec4_set(&rim, 0.0f, 0.0f, 0.0f, 1.0f);
	vec4_set(&fg, 1.0f, 0.3f, 0.75f, 1.0f);
	solid_pass(rim, [&] { lines(3 * k); });
	solid_pass(fg, [&] { lines(1 * k); });
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
	pedit::Rect sel; // copied under the editor's lock; drawn with no lock held
	const double k = vw > 0 ? (double)bw / vw * w->dpi.load() : 1; // canvas px per logical px (D335: DPI-scaled handles)
	if (w->owner && vw > 0 && w->owner->editor().selection(w->canvas, sel)) {
		draw_selection(sel, k);
		w->selection_draws++;
	}
	double gx, gy;
	if (w->owner && vw > 0 && w->owner->editor().snap_lines(w->canvas, gx, gy))
		draw_guides(gx, gy, bw, bh, k);
	gs_projection_pop();
	gs_viewport_pop();
	if (c)
		obs_canvas_release(c);
}

// The letterbox of a preview window right now (draw_cb's math, from the client size and the canvas size).
pedit::View view_of(const Previews::Win *w)
{
	RECT r;
	GetClientRect(w->hwnd, &r);
	uint32_t bw = 0, bh = 0;
	obs_canvas_t *c = nullptr;
	canvas_base(w->canvas, bw, bh, &c);
	if (c)
		obs_canvas_release(c);
	pedit::View v = pedit::fit_view(r.right, r.bottom, bw, bh);
	const UINT dpi = GetDpiForWindow(w->hwnd);
	v.dpi = dpi ? dpi / 96.0 : 1.0;
	w->dpi.store(v.dpi);
	return v;
}

pedit::Mods mods_of(WPARAM wp)
{
	pedit::Mods m;
	m.shift = (wp & MK_SHIFT) != 0;
	m.alt = GetKeyState(VK_MENU) < 0;
	return m;
}

LRESULT CALLBACK wnd_proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp)
{
	auto *w = reinterpret_cast<Previews::Win *>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
	// Mouse editing (preview_edit.h). The editor ignores every event while flag preview-edit is off. Capture keeps
	// the drag going outside the window.
	switch (msg) {
	case WM_LBUTTONDOWN:
		if (w && w->owner && w->owner->editor().down(w->canvas, view_of(w), GET_X_LPARAM(lp), GET_Y_LPARAM(lp), mods_of(wp))) {
			if (w->owner->editor().dragging(w->canvas)) {
				SetCapture(hwnd);
				SetTimer(hwnd, kDragTimer, 16, nullptr); // the newest drag point reaches libobs even when the mouse rests
			}
			return 0;
		}
		break;
	case WM_MOUSEMOVE:
		if (w && w->owner && (wp & MK_LBUTTON) && w->owner->editor().dragging(w->canvas)) {
			w->owner->editor().move(w->canvas, view_of(w), GET_X_LPARAM(lp), GET_Y_LPARAM(lp), mods_of(wp));
			return 0;
		}
		break;
	case WM_LBUTTONUP: {
		bool used = w && w->owner && w->owner->editor().up(w->canvas, view_of(w), GET_X_LPARAM(lp), GET_Y_LPARAM(lp), mods_of(wp));
		KillTimer(hwnd, kDragTimer);
		if (GetCapture() == hwnd)
			ReleaseCapture(); // after up(): the WM_CAPTURECHANGED it sends finds no drag to cancel
		if (used)
			return 0;
		break;
	}
	case WM_SETCURSOR: // over the selected layer: move / size / rotate cursors like OBS and Meld (D330)
		if (w && w->owner && LOWORD(lp) == HTCLIENT) {
			POINT pt;
			if (GetCursorPos(&pt) && ScreenToClient(hwnd, &pt)) {
				pedit::Mods m;
				m.shift = GetKeyState(VK_SHIFT) < 0;
				m.alt = GetKeyState(VK_MENU) < 0;
				LPCWSTR id = nullptr;
				switch (w->owner->editor().hover(w->canvas, view_of(w), pt.x, pt.y, m)) {
				case pedit::Cursor::Move: id = IDC_SIZEALL; break;
				case pedit::Cursor::SizeNWSE: id = IDC_SIZENWSE; break;
				case pedit::Cursor::SizeNESW: id = IDC_SIZENESW; break;
				case pedit::Cursor::SizeWE: id = IDC_SIZEWE; break;
				case pedit::Cursor::SizeNS: id = IDC_SIZENS; break;
				case pedit::Cursor::Rotate: id = IDC_HAND; break;
				default: break;
				}
				if (id) {
					SetCursor(LoadCursorW(nullptr, id));
					return TRUE;
				}
			}
		}
		break;
	case WM_CAPTURECHANGED: // capture taken away mid-drag: the layer goes back to where the drag began
		KillTimer(hwnd, kDragTimer);
		if (w && w->owner)
			w->owner->editor().cancel(w->canvas);
		return 0;
	case WM_TIMER:
		if (wp == kRefreshTimer && w && w->owner) {
			if (w->never_show && (GetWindowLongPtrW(hwnd, GWL_STYLE) & WS_VISIBLE)) {
				ShowWindow(hwnd, SW_HIDE);
				hlog::warn("preview %s: headless, an embedded preview was made visible; hidden again", w->canvas.c_str());
			}
			w->owner->editor().refresh(w->canvas);
			return 0;
		}
		if (wp == kDragTimer) {
			if (w && w->owner && w->owner->editor().dragging(w->canvas))
				w->owner->editor().flush(w->canvas);
			else
				KillTimer(hwnd, kDragTimer);
			return 0;
		}
		break;
	}
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
	case WM_WINDOWPOSCHANGING: // headless embedded: SetWindowPos(SWP_SHOWWINDOW) is dropped (ShowWindow under a hidden
				   // parent sets WS_VISIBLE without it: the refresh timer takes that away, measured 2026-11-11)
		if (w && w->never_show)
			reinterpret_cast<WINDOWPOS *>(lp)->flags &= ~SWP_SHOWWINDOW;
		break;
	case WM_STYLECHANGING: // and WS_VISIBLE set through SetWindowLongPtr (the refresh timer is the last resort)
		if (w && w->never_show && wp == (WPARAM)GWL_STYLE)
			reinterpret_cast<STYLESTRUCT *>(lp)->styleNew &= ~WS_VISIBLE;
		break;
	case WM_MOUSEACTIVATE: // embedded child (studio slot): a click leaves activation to the studio window, as before
		if (w && w->parent)
			return MA_NOACTIVATE;
		break; // a stand-alone preview is a normal window and activates on a click (D316)
	case WM_CLOSE:
		if (w && w->display) {
			obs_display_remove_draw_callback(w->display, draw_cb, w);
			obs_display_destroy(w->display);
			w->display = nullptr;
		}
		DestroyWindow(hwnd);
		return 0;
	case WM_DESTROY: // also reached when an embedding parent window (the studio shell) is destroyed
		if (w && w->owner)
			w->owner->editor().cancel(w->canvas);
		if (w && w->display) {
			obs_display_remove_draw_callback(w->display, draw_cb, w);
			obs_display_destroy(w->display);
			w->display = nullptr;
		}
		break;
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
};

// The display a stand-alone preview opens on (D316): the one under the given point, else the main display, like any
// normal window. The second-display preference and the "one display" refusal (D191 window part) are gone.
Display display_at(bool given, LONG x, LONG y)
{
	Display d;
	MONITORINFOEXW mi = {};
	mi.cbSize = sizeof(mi);
	const POINT at = given ? POINT{x, y} : POINT{0, 0};
	if (GetMonitorInfoW(MonitorFromPoint(at, MONITOR_DEFAULTTOPRIMARY), &mi)) {
		d.device = mi.szDevice;
		d.work = mi.rcWork;
	} else
		SystemParametersInfoW(SPI_GETWORKAREA, 0, &d.work, 0);
	return d;
}

std::string narrow(const std::wstring &w)
{
	std::string s;
	for (wchar_t c : w)
		s += (c < 128) ? (char)c : '?';
	return s;
}

// Brings a stand-alone preview to the front like a normal window (D316): restores it if minimised and asks Windows to
// make it the foreground window (Windows may refuse that from a background process; the window is raised anyway).
void raise_window(HWND hwnd)
{
	if (IsIconic(hwnd))
		ShowWindow(hwnd, SW_RESTORE);
	SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
	SetForegroundWindow(hwnd);
}

} // namespace

Previews::Previews(bool headless, pedit::Backend edit) : headless_(headless), editor_(std::move(edit))
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
		o.set("shown", (GetWindowLongPtrW(w->hwnd, GWL_STYLE) & WS_VISIBLE) != 0); // its own WS_VISIBLE
		o.set("visible", IsWindowVisible(w->hwnd) != FALSE);                      // and every parent's
		o.set("selectionDraws", (double)w->selection_draws.load());
	}
	return o;
}

json::Value Previews::open(const OpenArgs &a)
{
	// Headless: no window of our own. An embedded preview into a hidden studio window is allowed (LU4, D346: the
	// studio-swap tests re-embed previews with no window on screen); open_embedded refuses a visible parent.
	if (headless_ && !a.parent)
		throw rpc::Error(rpc::CONFLICT, "headless (--headless / UJWALAM_HEADLESS=1): no preview windows");
	return run_on_ui([this, a]() -> json::Value {
		if (a.parent)
			return open_embedded(a);
		auto found = wins_.find(a.canvas);
		if (found != wins_.end() && found->second->hwnd && IsWindow(found->second->hwnd)) {
			if (found->second->parent) // embedded one: a plain open replaces it with a window of its own
				SendMessageW(found->second->hwnd, WM_CLOSE, 0, 0);
			else {
				raise_window(found->second->hwnd);
				return win_json(found->second);
			}
		}
		const bool given = a.x >= 0 && a.y >= 0;
		const Display disp = display_at(given, a.x, a.y);
		Win *&w = wins_[a.canvas];
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
		DWORD ex = a.topmost ? WS_EX_TOPMOST : 0; // a normal window: taskbar entry, activates when shown (D316)
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
		// Default spot: H at the display's left edge, V at its right edge. A given x/y picks the display under it (a
		// window the user placed on another screen comes back there, else the main display); the whole window is then
		// kept inside that display's work area, so it never hangs off an edge or sits under the taskbar.
		LONG x = a.x >= 0 ? a.x : (a.canvas == "H" ? disp.work.left + 16 : disp.work.right - fw - 16);
		LONG y = a.y >= 0 ? a.y : disp.work.top + 16;
		const pplace::Rect placed = pplace::fit_in({disp.work.left, disp.work.top, ww, wh}, {x, y, fw, fh});
		x = placed.x;
		y = placed.y;
		fw = placed.w;
		fh = placed.h;
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
		SetTimer(hwnd, kRefreshTimer, 200, nullptr);
		HMONITOR on = MonitorFromWindow(hwnd, MONITOR_DEFAULTTOPRIMARY);
		MONITORINFOEXW omi = {};
		omi.cbSize = sizeof(omi);
		const bool onMain = GetMonitorInfoW(on, &omi) && (omi.dwFlags & MONITORINFOF_PRIMARY) != 0;
		w->screen = onMain ? "main display " + narrow(disp.device) : "display " + narrow(omi.szDevice);
		// The first ShowWindow in a process started with STARTF_USESHOWWINDOW (Node's windowsHide: true) may
		// take the parent's SW_HIDE instead of ours; this hide call absorbs that, then show as a normal window.
		ShowWindow(hwnd, SW_HIDE);
		ShowWindow(hwnd, SW_SHOWNORMAL);
		UpdateWindow(hwnd);
		SetForegroundWindow(hwnd);
		hlog::info("preview opened: %s %dx%d at %ld,%ld on the %s", a.canvas.c_str(), (int)cr.right,
			   (int)cr.bottom, (long)x, (long)y, w->screen.c_str());
		return win_json(w);
	});
}

// On the UI thread. Child window of the shell's preview slot: no frame, no activation, no taskbar entry.
json::Value Previews::open_embedded(const OpenArgs &a)
{
	HWND parent = reinterpret_cast<HWND>(static_cast<uintptr_t>(a.parent));
	if (!IsWindow(parent))
		throw rpc::Error(rpc::INVALID_PARAMS, "parent is not a window");
	// Headless (tests, LU4): only into a parent whose top-level window is hidden, and the child itself is never shown
	// (Win::never_show), so it stays unseen even when that parent is shown later (Codex review of D346).
	if (headless_ && IsWindowVisible(GetAncestor(parent, GA_ROOT)))
		throw rpc::Error(rpc::CONFLICT, "headless (--headless / UJWALAM_HEADLESS=1): an embedded preview needs a hidden parent window");
	if (a.width <= 0 || a.height <= 0 || a.x < 0 || a.y < 0)
		throw rpc::Error(rpc::INVALID_PARAMS, "an embedded preview needs x, y, width and height");
	// Embedded previews are child windows of the studio's preview slot and follow the studio window wherever it is.
	HMONITOR mon = MonitorFromWindow(parent, MONITOR_DEFAULTTONEAREST);
	MONITORINFOEXW mi = {};
	mi.cbSize = sizeof(mi);
	GetMonitorInfoW(mon, &mi);
	uint32_t bw = 0, bh = 0;
	obs_canvas_t *c = nullptr;
	canvas_base(a.canvas, bw, bh, &c);
	if (c)
		obs_canvas_release(c);
	if (!bw || !bh)
		throw rpc::Error(rpc::CONFLICT, "canvas " + a.canvas + " does not exist (load a project with it first)");
	Win *&w = wins_[a.canvas];
	if (!w) {
		w = new Win;
		w->canvas = a.canvas;
		w->owner = this;
	}
	if (w->hwnd && IsWindow(w->hwnd) && w->parent == parent) { // same slot: move / resize only
		SetWindowPos(w->hwnd, nullptr, a.x, a.y, a.width, a.height, SWP_NOZORDER | SWP_NOACTIVATE);
		return win_json(w);
	}
	if (w->hwnd && IsWindow(w->hwnd))
		SendMessageW(w->hwnd, WM_CLOSE, 0, 0);
	HWND hwnd = CreateWindowExW(WS_EX_NOACTIVATE, kClass, L"", WS_CHILD | WS_CLIPSIBLINGS, a.x, a.y, a.width, a.height,
				    parent, nullptr, GetModuleHandleW(nullptr), nullptr);
	if (!hwnd)
		throw rpc::Error(rpc::INTERNAL, "CreateWindow (embedded) failed");
	SetWindowLongPtrW(hwnd, GWLP_USERDATA, (LONG_PTR)w);
	w->hwnd = hwnd;
	w->parent = parent;
	w->never_show = headless_;
	struct gs_init_data gid = {};
	gid.cx = (uint32_t)a.width;
	gid.cy = (uint32_t)a.height;
	gid.format = GS_BGRA;
	gid.zsformat = GS_ZS_NONE;
	gid.window.hwnd = hwnd;
	w->display = obs_display_create(&gid, 0xFF101010);
	if (!w->display) {
		DestroyWindow(hwnd);
		throw rpc::Error(rpc::INTERNAL, "obs_display_create failed");
	}
	obs_display_add_draw_callback(w->display, draw_cb, w);
	SetTimer(hwnd, kRefreshTimer, 200, nullptr);
	w->screen = "embedded " + narrow(mi.szDevice);
	if (!w->never_show)
		ShowWindow(hwnd, SW_SHOWNOACTIVATE);
	hlog::info("preview embedded: %s %dx%d in the studio window on %s (no focus)", a.canvas.c_str(), a.width, a.height,
		   narrow(mi.szDevice).c_str());
	return win_json(w);
}

json::Value Previews::focus(const std::string &canvas)
{
	return run_on_ui([this, canvas]() -> json::Value {
		auto it = wins_.find(canvas);
		if (it == wins_.end() || !it->second->hwnd || !IsWindow(it->second->hwnd))
			throw rpc::Error(rpc::CONFLICT, "preview " + canvas + " is not open");
		if (it->second->parent) // embedded: a child of the studio window; only its z-order among siblings
			SetWindowPos(it->second->hwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
		else
			raise_window(it->second->hwnd);
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

json::Value Previews::test_parent(const std::string &action, const std::string &canvas)
{
	return run_on_ui([this, action, canvas]() -> json::Value {
		if (action == "create") {
			if (!test_parent_ || !IsWindow((HWND)test_parent_)) // WS_POPUP without WS_VISIBLE, off every display: never seen
				test_parent_ = CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, L"STATIC", L"", WS_POPUP, -32000, -32000,
							       640, 400, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
			if (!test_parent_)
				throw rpc::Error(rpc::INTERNAL, "CreateWindow (test parent) failed");
			json::Value o = json::Value::object();
			o.set("parent", std::to_string(reinterpret_cast<uintptr_t>(test_parent_)));
			return o;
		}
		if (action == "destroy") {
			if (test_parent_ && IsWindow((HWND)test_parent_))
				DestroyWindow((HWND)test_parent_);
			test_parent_ = nullptr;
			return json::Value::object();
		}
		auto it = wins_.find(canvas);
		if (it == wins_.end() || !it->second->hwnd || !IsWindow(it->second->hwnd))
			throw rpc::Error(rpc::CONFLICT, "no open preview for canvas " + canvas);
		HWND h = it->second->hwnd;
		if (action == "show-child")
			ShowWindow(h, SW_SHOWNOACTIVATE);
		else if (action == "setpos-child")
			SetWindowPos(h, nullptr, 0, 0, 0, 0, SWP_SHOWWINDOW | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
		else if (action == "style-child")
			SetWindowLongPtrW(h, GWL_STYLE, GetWindowLongPtrW(h, GWL_STYLE) | WS_VISIBLE);
		else
			throw rpc::Error(rpc::INVALID_PARAMS, "action must be create, destroy, show-child, setpos-child or style-child");
		return win_json(it->second);
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
			if (test_parent_ && IsWindow((HWND)test_parent_))
				DestroyWindow((HWND)test_parent_);
			test_parent_ = nullptr;
			return json::Value();
		});
	} catch (...) {
	}
}
