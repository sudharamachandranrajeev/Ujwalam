// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: mouse editing on the preview. See preview_edit.h.
#include "preview_edit.h"

#include <algorithm>
#include <cmath>

namespace pedit {

namespace {

const double kPi = 3.14159265358979323846;
const size_t kKeepEdits = 64;
// Corner signs in the layer's own frame: top-left, top-right, bottom-right, bottom-left (y down).
const int kSx[4] = {-1, 1, 1, -1};
const int kSy[4] = {-1, -1, 1, 1};

void rot_fwd(double rot, double lx, double ly, double &wx, double &wy) // layer frame -> canvas (clockwise, y down)
{
	double a = rot * kPi / 180, c = std::cos(a), s = std::sin(a);
	wx = c * lx - s * ly;
	wy = s * lx + c * ly;
}

void rot_inv(double rot, double wx, double wy, double &lx, double &ly)
{
	double a = rot * kPi / 180, c = std::cos(a), s = std::sin(a);
	lx = c * wx + s * wy;
	ly = -s * wx + c * wy;
}

// Moves v to the nearest target within tol; returns the shift applied (0 when none is close enough).
double snap_shift(const double *vals, const double *targets, int n, double tol)
{
	double best = 0, bestd = tol + 1;
	for (int i = 0; i < n; i++) {
		double d = targets[i] - vals[i];
		if (std::fabs(d) <= tol && std::fabs(d) < bestd) {
			bestd = std::fabs(d);
			best = d;
		}
	}
	return best;
}

double snap_value(double v, double size, double tol)
{
	const double t[3] = {0, size / 2, size};
	double best = v, bestd = tol + 1;
	for (double x : t)
		if (std::fabs(x - v) <= tol && std::fabs(x - v) < bestd) {
			bestd = std::fabs(x - v);
			best = x;
		}
	return best;
}

// Whole pixels, rounded per edge so that the edge a resize holds still stays exactly where it was.
Rect clamp_round(Rect r)
{
	double x0 = std::round(r.x), y0 = std::round(r.y), x1 = std::round(r.x + r.w), y1 = std::round(r.y + r.h);
	r.w = std::clamp(x1 - x0, 1.0, 16384.0);
	r.h = std::clamp(y1 - y0, 1.0, 16384.0);
	r.x = std::clamp(x0, -16384.0, 16384.0);
	r.y = std::clamp(y0, -16384.0, 16384.0);
	return r;
}

bool same(const Rect &a, const Rect &b)
{
	return a.x == b.x && a.y == b.y && a.w == b.w && a.h == b.h && a.rot == b.rot;
}

} // namespace

View fit_view(double client_w, double client_h, double canvas_w, double canvas_h)
{
	View v;
	v.cw = canvas_w;
	v.ch = canvas_h;
	if (client_w <= 0 || client_h <= 0 || canvas_w <= 0 || canvas_h <= 0)
		return v;
	// Same integer math as draw_cb, so a click maps onto exactly the pixels drawn.
	double scale = std::min(client_w / canvas_w, client_h / canvas_h);
	int vw = (int)(canvas_w * scale), vh = (int)(canvas_h * scale);
	v.vw = vw;
	v.vh = vh;
	v.vx = (double)(((int)client_w - vw) / 2);
	v.vy = (double)(((int)client_h - vh) / 2);
	return v;
}

void to_canvas(const View &v, double sx, double sy, double &cx, double &cy)
{
	cx = v.vw > 0 ? (sx - v.vx) * v.cw / v.vw : 0;
	cy = v.vh > 0 ? (sy - v.vy) * v.ch / v.vh : 0;
}

bool contains(const Rect &r, double cx, double cy)
{
	double lx, ly;
	rot_inv(r.rot, cx - (r.x + r.w / 2), cy - (r.y + r.h / 2), lx, ly);
	return std::fabs(lx) <= r.w / 2 && std::fabs(ly) <= r.h / 2;
}

void corners(const Rect &r, double out[4][2])
{
	double mx = r.x + r.w / 2, my = r.y + r.h / 2;
	for (int i = 0; i < 4; i++) {
		double wx, wy;
		rot_fwd(r.rot, kSx[i] * r.w / 2, kSy[i] * r.h / 2, wx, wy);
		out[i][0] = mx + wx;
		out[i][1] = my + wy;
	}
}

int hit_corner(const Rect &r, double cx, double cy, double tol)
{
	double c[4][2];
	corners(r, c);
	int best = -1;
	double bestd = tol;
	for (int i = 0; i < 4; i++) {
		double d = std::hypot(cx - c[i][0], cy - c[i][1]);
		if (d <= bestd) {
			bestd = d;
			best = i;
		}
	}
	return best;
}

int hit_item(const std::vector<Item> &top_first, double cx, double cy)
{
	for (size_t i = 0; i < top_first.size(); i++)
		if (top_first[i].r.w > 0 && top_first[i].r.h > 0 && contains(top_first[i].r, cx, cy))
			return (int)i;
	return -1;
}

Rect drag(const DragIn &d)
{
	Rect r = d.start;
	double dx = d.cx - d.sx, dy = d.cy - d.sy;
	if (d.mode == Mode::Move) {
		r.x += dx;
		r.y += dy;
		if (d.snap) { // the turned box's bounding box: edges to the canvas edges, centre to the centre
			double c[4][2];
			corners(r, c);
			double l = c[0][0], rt = c[0][0], t = c[0][1], b = c[0][1];
			for (auto &p : c) {
				l = std::min(l, p[0]);
				rt = std::max(rt, p[0]);
				t = std::min(t, p[1]);
				b = std::max(b, p[1]);
			}
			const double vx[3] = {l, rt, (l + rt) / 2}, tx[3] = {0, d.cw, d.cw / 2};
			const double vy[3] = {t, b, (t + b) / 2}, ty[3] = {0, d.ch, d.ch / 2};
			r.x += snap_shift(vx, tx, 3, d.snap_tol);
			r.y += snap_shift(vy, ty, 3, d.snap_tol);
		}
		return clamp_round(r);
	}
	if (d.mode != Mode::Resize || d.corner < 0 || d.corner > 3)
		return r;
	const Rect &s = d.start;
	int k = d.corner, o = (k + 2) % 4;
	double c[4][2];
	corners(s, c);
	double mx = c[k][0] + dx, my = c[k][1] + dy; // where the dragged corner is now
	bool upright = std::fabs(std::remainder(s.rot, 360.0)) < 0.01;
	if (d.snap && upright) {
		mx = snap_value(mx, d.cw, d.snap_tol);
		my = snap_value(my, d.ch, d.snap_tol);
	}
	double ax = c[o][0], ay = c[o][1]; // the opposite corner stays where it is
	double lx, ly;
	rot_inv(s.rot, mx - ax, my - ay, lx, ly);
	double nw = std::max(1.0, kSx[k] * lx), nh = std::max(1.0, kSy[k] * ly);
	if (!d.free_aspect && s.w > 0 && s.h > 0) {
		double f = std::max(nw / s.w, nh / s.h);
		nw = std::max(1.0, s.w * f);
		nh = std::max(1.0, s.h * f);
	}
	double wx, wy;
	rot_fwd(s.rot, kSx[k] * nw / 2, kSy[k] * nh / 2, wx, wy);
	double ncx = ax + wx, ncy = ay + wy; // new centre
	r.w = nw;
	r.h = nh;
	r.x = ncx - nw / 2;
	r.y = ncy - nh / 2;
	return clamp_round(r);
}

json::Value rect_json(const Rect &r)
{
	// Whole canvas pixels (drag() rounds); integers keep the project file tidy.
	json::Value o = json::Value::object();
	o.set("x", (int64_t)std::llround(r.x));
	o.set("y", (int64_t)std::llround(r.y));
	o.set("width", (int64_t)std::llround(r.w));
	o.set("height", (int64_t)std::llround(r.h));
	return o;
}

// ---- Editor ----------------------------------------------------------------------------------------------

void Editor::set_enabled(bool on)
{
	std::lock_guard<std::mutex> l(m_);
	enabled_ = on;
	if (!on)
		sel_.clear();
}

bool Editor::enabled() const
{
	std::lock_guard<std::mutex> l(m_);
	return enabled_;
}

bool Editor::down(const std::string &canvas, const View &v, double sx, double sy, Mods)
{
	Sel cur;
	{
		std::lock_guard<std::mutex> l(m_);
		if (!enabled_ || v.vw <= 0 || v.vh <= 0)
			return false;
		cur = sel_[canvas];
	}
	if (be_.locked && be_.locked()) {
		std::lock_guard<std::mutex> l(m_);
		sel_[canvas] = Sel(); // live: nothing selected, nothing moves
		return true;
	}
	std::string scene;
	std::vector<Item> items;
	if (!be_.layers || !be_.layers(canvas, scene, items))
		items.clear();
	double cx, cy;
	to_canvas(v, sx, sy, cx, cy);
	const double tol = 8 * v.canvas_per_px();
	Sel next;
	if (cur.has && cur.scene == scene) { // the selected layer first: its handles, then its box (even under others)
		for (auto &it : items)
			if (it.id == cur.layer) {
				int k = hit_corner(it.r, cx, cy, tol);
				if (k >= 0 || contains(it.r, cx, cy)) {
					next.has = true;
					next.scene = scene;
					next.layer = it.id;
					next.r = it.r;
					next.mode = k >= 0 ? Mode::Resize : Mode::Move;
					next.corner = k;
				}
				break;
			}
	}
	if (!next.has) {
		int i = hit_item(items, cx, cy);
		if (i >= 0) {
			next.has = true;
			next.scene = scene;
			next.layer = items[(size_t)i].id;
			next.r = items[(size_t)i].r;
			next.mode = Mode::Move;
		}
	}
	next.start = next.r;
	next.sx = cx;
	next.sy = cy;
	std::lock_guard<std::mutex> l(m_);
	if (!enabled_)
		return false;
	sel_[canvas] = next; // empty canvas: the selection is cleared
	return true;
}

bool Editor::move(const std::string &canvas, const View &v, double sx, double sy, Mods m)
{
	DragIn d;
	std::string scene, layer;
	{
		std::lock_guard<std::mutex> l(m_);
		auto it = sel_.find(canvas);
		if (!enabled_ || it == sel_.end() || !it->second.has || it->second.mode == Mode::None)
			return false;
		const Sel &s = it->second;
		d.start = s.start;
		d.mode = s.mode;
		d.corner = s.corner;
		d.sx = s.sx;
		d.sy = s.sy;
		scene = s.scene;
		layer = s.layer;
	}
	to_canvas(v, sx, sy, d.cx, d.cy);
	d.free_aspect = m.shift;
	d.snap = !m.alt;
	d.snap_tol = 8 * v.canvas_per_px();
	d.cw = v.cw;
	d.ch = v.ch;
	Rect r = drag(d);
	{
		std::lock_guard<std::mutex> l(m_);
		auto it = sel_.find(canvas);
		if (it == sel_.end() || !it->second.has)
			return false;
		// Drag threshold (3 screen px): a click that wobbles a little, or a release on the press point, never
		// moves or snaps the layer.
		if (!it->second.moved && same(it->second.r, it->second.start) &&
		    std::hypot(d.cx - d.sx, d.cy - d.sy) < 3 * v.canvas_per_px())
			return true;
		if (same(it->second.r, r))
			return true; // nothing changed since the last move: no setPlacement call
	}
	std::string err = be_.apply ? be_.apply(canvas, scene, layer, r) : "no backend";
	std::lock_guard<std::mutex> l(m_);
	auto it = sel_.find(canvas);
	if (it == sel_.end() || !it->second.has || it->second.layer != layer || it->second.mode == Mode::None)
		return false; // switched off or cancelled meanwhile
	if (!err.empty()) { // the layer went away (project load): drop the selection
		it->second = Sel();
		return false;
	}
	it->second.r = r;
	it->second.moved = !same(r, it->second.start);
	return true;
}

bool Editor::up(const std::string &canvas, const View &v, double sx, double sy, Mods m)
{
	bool was_drag = dragging(canvas);
	if (!was_drag)
		return false;
	bool moved_now = move(canvas, v, sx, sy, m); // the release point is the final placement
	std::lock_guard<std::mutex> l(m_);
	auto it = sel_.find(canvas);
	if (it == sel_.end() || !it->second.has)
		return moved_now;
	Sel &s = it->second;
	bool moved = s.moved;
	s.mode = Mode::None;
	s.corner = -1;
	s.moved = false;
	if (moved) { // one edit per gesture; a plain click, or a drag back to the start, only selects
		Edit e;
		e.seq = ++seq_;
		e.canvas = canvas;
		e.scene = s.scene;
		e.layer = s.layer;
		e.r = s.r;
		edits_.push_back(e);
		while (edits_.size() > kKeepEdits)
			edits_.pop_front();
	}
	return true;
}

void Editor::cancel(const std::string &canvas)
{
	std::string scene, layer;
	Rect start;
	{
		std::lock_guard<std::mutex> l(m_);
		auto it = sel_.find(canvas);
		if (it == sel_.end() || it->second.mode == Mode::None)
			return;
		Sel &s = it->second;
		bool moved = s.moved;
		s.mode = Mode::None;
		s.moved = false;
		if (!moved)
			return;
		s.r = s.start;
		scene = s.scene;
		layer = s.layer;
		start = s.start;
	}
	if (be_.apply)
		be_.apply(canvas, scene, layer, start);
}

bool Editor::dragging(const std::string &canvas) const
{
	std::lock_guard<std::mutex> l(m_);
	auto it = sel_.find(canvas);
	return it != sel_.end() && it->second.has && it->second.mode != Mode::None;
}

void Editor::refresh(const std::string &canvas)
{
	std::string want_scene, want_layer;
	{
		std::lock_guard<std::mutex> l(m_);
		auto it = sel_.find(canvas);
		if (it == sel_.end() || !it->second.has || it->second.mode != Mode::None)
			return;
		want_scene = it->second.scene;
		want_layer = it->second.layer;
	}
	std::string scene;
	std::vector<Item> items;
	bool ok = be_.layers && be_.layers(canvas, scene, items);
	if (!ok && scene == "busy")
		return; // model busy (project load): try again next time
	const Item *found = nullptr;
	if (ok && scene == want_scene)
		for (auto &x : items)
			if (x.id == want_layer)
				found = &x;
	std::lock_guard<std::mutex> l(m_);
	auto it = sel_.find(canvas);
	if (it == sel_.end() || !it->second.has || it->second.mode != Mode::None || it->second.layer != want_layer)
		return;
	if (found)
		it->second.r = found->r;
	else
		it->second = Sel(); // layer removed, hidden, or another scene is shown
}

bool Editor::selection(const std::string &canvas, Rect &r) const
{
	std::lock_guard<std::mutex> l(m_);
	auto it = sel_.find(canvas);
	if (!enabled_ || it == sel_.end() || !it->second.has)
		return false;
	r = it->second.r;
	return true;
}

json::Value Editor::selection_json(const std::string &canvas) const
{
	std::lock_guard<std::mutex> l(m_);
	json::Value o = json::Value::object();
	auto it = sel_.find(canvas);
	if (it == sel_.end() || !it->second.has) {
		o.set("layer", json::Value());
		return o;
	}
	const Sel &s = it->second;
	o.set("scene", s.scene);
	o.set("layer", s.layer);
	o.set("placement", rect_json(s.r));
	o.set("rotation", s.r.rot);
	o.set("mode", s.mode == Mode::Move ? "move" : s.mode == Mode::Resize ? "resize" : "none");
	return o;
}

uint64_t Editor::seq() const
{
	std::lock_guard<std::mutex> l(m_);
	return seq_;
}

json::Value Editor::edits(uint64_t since) const
{
	std::lock_guard<std::mutex> l(m_);
	json::Value a = json::Value::array();
	for (auto &e : edits_) {
		if (e.seq <= since)
			continue;
		json::Value o = json::Value::object();
		o.set("seq", (int64_t)e.seq);
		o.set("canvas", e.canvas);
		o.set("scene", e.scene);
		o.set("layer", e.layer);
		o.set("placement", rect_json(e.r));
		a.push(std::move(o));
	}
	uint64_t oldest = edits_.empty() ? seq_ + 1 : edits_.front().seq;
	json::Value r = json::Value::object();
	r.set("seq", (int64_t)seq_);
	r.set("truncated", since < seq_ && since + 1 < oldest);
	r.set("edits", std::move(a));
	return r;
}

} // namespace pedit
