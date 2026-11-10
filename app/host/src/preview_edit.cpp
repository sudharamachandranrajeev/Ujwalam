// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: mouse editing on the preview. See preview_edit.h.
#include "preview_edit.h"

#include <algorithm>
#include <cmath>

namespace pedit {

namespace {

const double kPi = 3.14159265358979323846;
const size_t kKeepEdits = 64;
const double kRotateOff = 24; // screen px from the top edge to the rotate handle (preview.cpp draws it there)
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

// Canvas edges and centre first (a tie goes to the canvas), then the other layers' guides.
std::vector<double> snap_targets(double size, const std::vector<double> &extra)
{
	std::vector<double> t{0, size / 2, size};
	t.insert(t.end(), extra.begin(), extra.end());
	return t;
}

// The shift that moves the closest of vals onto a target within tol (0 when none is close enough); *line = that
// target.
double snap_shift(const double *vals, int n, const std::vector<double> &targets, double tol, double *line)
{
	double best = 0, bestd = tol + 1;
	for (int i = 0; i < n; i++)
		for (double t : targets) {
			double d = t - vals[i];
			if (std::fabs(d) <= tol && std::fabs(d) < bestd) {
				bestd = std::fabs(d);
				best = d;
				if (line)
					*line = t;
			}
		}
	return best;
}

double snap_value(double v, const std::vector<double> &targets, double tol, double *line)
{
	double s[1] = {v};
	return v + snap_shift(s, 1, targets, tol, line);
}

void bbox(const Rect &r, double &l, double &t, double &rt, double &b)
{
	double c[4][2];
	corners(r, c);
	l = rt = c[0][0];
	t = b = c[0][1];
	for (auto &p : c) {
		l = std::min(l, p[0]);
		rt = std::max(rt, p[0]);
		t = std::min(t, p[1]);
		b = std::max(b, p[1]);
	}
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
	return a.x == b.x && a.y == b.y && a.w == b.w && a.h == b.h && a.rot == b.rot && a.cl == b.cl && a.ct == b.ct &&
	       a.cr == b.cr && a.cb == b.cb;
}

} // namespace

void guides(const std::vector<Item> &items, const std::string &skip, std::vector<double> &gx, std::vector<double> &gy)
{
	gx.clear();
	gy.clear();
	for (auto &it : items) {
		if (it.id == skip || it.r.w <= 0 || it.r.h <= 0)
			continue;
		double l, t, rt, b;
		bbox(it.r, l, t, rt, b);
		gx.insert(gx.end(), {l, rt, (l + rt) / 2});
		gy.insert(gy.end(), {t, b, (t + b) / 2});
	}
}

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

void rotate_handle(const Rect &r, double off, double &x, double &y)
{
	double wx, wy;
	rot_fwd(r.rot, 0, -r.h / 2 - off, wx, wy);
	x = r.x + r.w / 2 + wx;
	y = r.y + r.h / 2 + wy;
}

bool hit_rotate(const Rect &r, double cx, double cy, double off, double tol)
{
	double hx, hy;
	rotate_handle(r, off, hx, hy);
	return std::hypot(cx - hx, cy - hy) <= tol;
}

int hit_edge(const Rect &r, double cx, double cy, double tol)
{
	double lx, ly;
	rot_inv(r.rot, cx - (r.x + r.w / 2), cy - (r.y + r.h / 2), lx, ly);
	const double hw = r.w / 2, hh = r.h / 2;
	const double dist[4] = {lx + hw, ly + hh, lx - hw, ly - hh};
	const bool along[4] = {std::fabs(ly) <= hh, std::fabs(lx) <= hw, std::fabs(ly) <= hh, std::fabs(lx) <= hw};
	int best = -1;
	double bd = tol;
	for (int e = 0; e < 4; e++)
		if (along[e] && std::fabs(dist[e]) <= bd) {
			bd = std::fabs(dist[e]);
			best = e;
		}
	return best;
}

Rect drag(const DragIn &d, double *line_x, double *line_y)
{
	if (line_x)
		*line_x = NAN;
	if (line_y)
		*line_y = NAN;
	Rect r = d.start;
	double dx = d.cx - d.sx, dy = d.cy - d.sy;
	if (d.mode == Mode::Rotate) { // the angle the cursor swept about the centre; position and size stay
		double mx = r.x + r.w / 2, my = r.y + r.h / 2;
		double a0 = std::atan2(d.sy - my, d.sx - mx), a1 = std::atan2(d.cy - my, d.cx - mx);
		double deg = r.rot + (a1 - a0) * 180 / kPi;
		if (d.free_aspect)
			deg = std::round(deg / 15) * 15;
		deg = std::remainder(deg, 360.0); // -180..180
		deg = std::round(deg * 10) / 10;
		r.rot = deg == -180 ? 180 : (deg == 0 ? 0 : deg); // no -0
		return r;
	}
	if (d.mode == Mode::Move) {
		r.x += dx;
		r.y += dy;
		if (d.snap) { // the turned box's bounding box: its edges and centre to the nearest target
			double l, t, rt, b;
			bbox(r, l, t, rt, b);
			const double vx[3] = {l, rt, (l + rt) / 2}, vy[3] = {t, b, (t + b) / 2};
			r.x += snap_shift(vx, 3, snap_targets(d.cw, d.gx), d.snap_tol, line_x);
			r.y += snap_shift(vy, 3, snap_targets(d.ch, d.gy), d.snap_tol, line_y);
		}
		return clamp_round(r);
	}
	if (d.mode == Mode::Crop) {
		const Rect &s = d.start;
		const int e = d.corner;
		const bool horiz = e == 0 || e == 2;
		const double vis = horiz ? s.sw - s.cl - s.cr : s.sh - s.ct - s.cb; // shown source px on that axis
		const double size = horiz ? s.w : s.h;
		if (e < 0 || e > 3 || s.sw <= 0 || s.sh <= 0 || vis < 1 || size <= 0)
			return r;
		const double k = vis / size; // source px per canvas px: kept, so the picture never stretches
		double lx, ly;
		rot_inv(s.rot, dx, dy, lx, ly);
		double in = e == 0 ? lx : e == 1 ? ly : e == 2 ? -lx : -ly; // inward, canvas px
		in = std::clamp(in, -1e9, size - 1);                       // the box keeps at least 1 px
		double &c = e == 0 ? r.cl : e == 1 ? r.ct : e == 2 ? r.cr : r.cb;
		const double c0 = c;
		c = std::clamp(std::round(c0 + in * k), 0.0, c0 + vis - 1); // whole source px; at least 1 px stays
		in = (c - c0) / k;                                           // the box edge goes where the cut is
		const double hx = e == 0 ? in / 2 : e == 2 ? -in / 2 : 0, hy = e == 1 ? in / 2 : e == 3 ? -in / 2 : 0;
		double wx, wy;
		rot_fwd(s.rot, hx, hy, wx, wy);
		if (horiz)
			r.w = s.w - in;
		else
			r.h = s.h - in;
		r.x = s.x + s.w / 2 + wx - r.w / 2;
		r.y = s.y + s.h / 2 + wy - r.h / 2;
		return clamp_round(r);
	}
	if (d.mode != Mode::Resize || d.corner < 0 || d.corner > 7)
		return r;
	const Rect &s = d.start;
	bool upright = std::fabs(std::remainder(s.rot, 360.0)) < 0.01;
	if (d.corner >= 4) { // an edge handle (D330): that side follows the cursor, the opposite side stays, aspect free
		const int e = d.corner - 4;
		const bool horiz = e == 0 || e == 2;
		double lx, ly;
		rot_inv(s.rot, dx, dy, lx, ly);
		double out = e == 0 ? -lx : e == 1 ? -ly : e == 2 ? lx : ly; // outward growth, canvas px
		const double size0 = horiz ? s.w : s.h;
		if (d.snap && upright) { // the moving edge to the nearest canvas or layer guide
			const double pos = e == 0 ? s.x - out : e == 1 ? s.y - out : e == 2 ? s.x + s.w + out : s.y + s.h + out;
			const double snapped = snap_value(pos, snap_targets(horiz ? d.cw : d.ch, horiz ? d.gx : d.gy), d.snap_tol, horiz ? line_x : line_y);
			out += (e == 0 || e == 1) ? pos - snapped : snapped - pos;
		}
		const double ns = std::max(1.0, size0 + out);
		out = ns - size0;
		const double hx = e == 0 ? -out / 2 : e == 2 ? out / 2 : 0, hy = e == 1 ? -out / 2 : e == 3 ? out / 2 : 0;
		double wx, wy;
		rot_fwd(s.rot, hx, hy, wx, wy);
		if (horiz)
			r.w = ns;
		else
			r.h = ns;
		r.x = s.x + s.w / 2 + wx - r.w / 2;
		r.y = s.y + s.h / 2 + wy - r.h / 2;
		return clamp_round(r);
	}
	int k = d.corner, o = (k + 2) % 4;
	double c[4][2];
	corners(s, c);
	double mx = c[k][0] + dx, my = c[k][1] + dy; // where the dragged corner is now
	if (d.snap && upright) {
		mx = snap_value(mx, snap_targets(d.cw, d.gx), d.snap_tol, line_x);
		my = snap_value(my, snap_targets(d.ch, d.gy), d.snap_tol, line_y);
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

json::Value patch_json(const Rect &r, Mode mode)
{
	if (mode == Mode::Crop) {
		json::Value o = rect_json(r), c = json::Value::object();
		c.set("left", (int64_t)std::llround(r.cl));
		c.set("top", (int64_t)std::llround(r.ct));
		c.set("right", (int64_t)std::llround(r.cr));
		c.set("bottom", (int64_t)std::llround(r.cb));
		o.set("crop", std::move(c));
		return o;
	}
	if (mode != Mode::Rotate)
		return rect_json(r);
	json::Value o = json::Value::object();
	o.set("rotation", r.rot);
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

bool Editor::down(const std::string &canvas, const View &v, double sx, double sy, Mods m)
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
				bool turn = hit_rotate(it.r, cx, cy, kRotateOff * v.canvas_per_px(), tol);
				int k = turn ? -1 : hit_corner(it.r, cx, cy, tol);
				// An edge: Alt crops that side (needs the source size); without Alt the edge handle stretches that
				// side alone (D330, OBS/Meld edge handles).
				int edge = !turn && k < 0 ? hit_edge(it.r, cx, cy, tol) : -1;
				const bool crop = edge >= 0 && m.alt;
				if (crop && (it.r.sw <= 0 || it.r.sh <= 0))
					edge = -1; // no crop gesture without the source size: the press is a move
				if (turn || k >= 0 || edge >= 0 || contains(it.r, cx, cy)) {
					next.has = true;
					next.scene = scene;
					next.layer = it.id;
					next.r = it.r;
					next.mode = turn ? Mode::Rotate : k >= 0 ? Mode::Resize : edge >= 0 ? (crop ? Mode::Crop : Mode::Resize) : Mode::Move;
					next.corner = k >= 0 ? k : edge >= 0 && !crop ? 4 + edge : edge;
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
	if (next.has)
		guides(items, next.layer, next.gx, next.gy);
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
		d.gx = s.gx;
		d.gy = s.gy;
		scene = s.scene;
		layer = s.layer;
	}
	to_canvas(v, sx, sy, d.cx, d.cy);
	d.free_aspect = m.shift;
	d.snap = !m.alt;
	d.snap_tol = 8 * v.canvas_per_px();
	d.cw = v.cw;
	d.ch = v.ch;
	double lx, ly;
	Rect r = drag(d, &lx, &ly);
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
	std::string err = be_.apply ? be_.apply(canvas, scene, layer, patch_json(r, d.mode)) : "no backend";
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
	it->second.lx = lx;
	it->second.ly = ly;
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
	Mode mode = s.mode;
	s.mode = Mode::None;
	s.corner = -1;
	s.moved = false;
	s.lx = s.ly = NAN;
	if (moved) { // one edit per gesture; a plain click, or a drag back to the start, only selects
		Edit e;
		e.seq = ++seq_;
		e.canvas = canvas;
		e.scene = s.scene;
		e.layer = s.layer;
		e.r = s.r;
		e.before = s.start;
		e.mode = mode;
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
	Mode mode;
	{
		std::lock_guard<std::mutex> l(m_);
		auto it = sel_.find(canvas);
		if (it == sel_.end() || it->second.mode == Mode::None)
			return;
		Sel &s = it->second;
		bool moved = s.moved;
		mode = s.mode;
		s.mode = Mode::None;
		s.moved = false;
		s.lx = s.ly = NAN;
		if (!moved)
			return;
		s.r = s.start;
		scene = s.scene;
		layer = s.layer;
		start = s.start;
	}
	if (be_.apply)
		be_.apply(canvas, scene, layer, patch_json(start, mode));
}

bool Editor::dragging(const std::string &canvas) const
{
	std::lock_guard<std::mutex> l(m_);
	auto it = sel_.find(canvas);
	return it != sel_.end() && it->second.has && it->second.mode != Mode::None;
}

const char *cursor_name(Cursor c)
{
	switch (c) {
	case Cursor::Move: return "move";
	case Cursor::SizeNWSE: return "nwse";
	case Cursor::SizeNESW: return "nesw";
	case Cursor::SizeWE: return "we";
	case Cursor::SizeNS: return "ns";
	case Cursor::Rotate: return "rotate";
	default: return "arrow";
	}
}

Cursor Editor::hover(const std::string &canvas, const View &v, double sx, double sy, Mods m) const
{
	Rect r;
	{
		std::lock_guard<std::mutex> l(m_);
		auto it = sel_.find(canvas);
		if (!enabled_ || v.vw <= 0 || v.vh <= 0 || it == sel_.end() || !it->second.has)
			return Cursor::Arrow;
		r = it->second.r;
	}
	if (be_.locked && be_.locked())
		return Cursor::Arrow;
	double cx, cy;
	to_canvas(v, sx, sy, cx, cy);
	const double tol = 8 * v.canvas_per_px();
	if (hit_rotate(r, cx, cy, kRotateOff * v.canvas_per_px(), tol))
		return Cursor::Rotate;
	// The arrows follow the handle as drawn on an unturned box; a turned box keeps them (close enough to read).
	const int k = hit_corner(r, cx, cy, tol);
	if (k >= 0)
		return k == 0 || k == 2 ? Cursor::SizeNWSE : Cursor::SizeNESW;
	const int e = hit_edge(r, cx, cy, tol);
	if (e >= 0 && (!m.alt || (r.sw > 0 && r.sh > 0)))
		return e == 0 || e == 2 ? Cursor::SizeWE : Cursor::SizeNS;
	return contains(r, cx, cy) ? Cursor::Move : Cursor::Arrow;
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
	o.set("mode", s.mode == Mode::Move     ? "move"
		      : s.mode == Mode::Resize ? "resize"
		      : s.mode == Mode::Rotate ? "rotate"
		      : s.mode == Mode::Crop   ? "crop"
					       : "none");
	if (s.mode != Mode::None && (!std::isnan(s.lx) || !std::isnan(s.ly))) {
		json::Value g = json::Value::object();
		g.set("x", std::isnan(s.lx) ? json::Value() : json::Value(s.lx));
		g.set("y", std::isnan(s.ly) ? json::Value() : json::Value(s.ly));
		o.set("snap", g);
	}
	return o;
}

bool Editor::snap_lines(const std::string &canvas, double &x, double &y) const
{
	std::lock_guard<std::mutex> l(m_);
	auto it = sel_.find(canvas);
	if (!enabled_ || it == sel_.end() || !it->second.has || it->second.mode == Mode::None)
		return false;
	x = it->second.lx;
	y = it->second.ly;
	return !std::isnan(x) || !std::isnan(y);
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
		o.set("placement", patch_json(e.r, e.mode));
		o.set("before", patch_json(e.before, e.mode));
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
