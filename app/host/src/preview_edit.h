// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: mouse editing on the preview (P5, D230; design: docs/plan/2026-11-06-p5a-qt-shell-plan.md "Editing on
// the preview"). Behind feature flag `preview-edit` (off by default); the UI server switches it with
// preview.setEditing.
//
// Geometry (pure, no libobs): a project v1 placement is the displayed rectangle x, y, width, height in canvas pixels,
// rotated by `rotation` degrees about its centre (studio.cpp apply_placement; the crop is inside that rectangle).
// The hit test undoes the rotation, so a rotated layer is hit exactly on its turned box.
//
// Gestures (OBS/Meld conventions): click selects the topmost visible layer under the cursor on that canvas (empty
// canvas clears the selection; one selection per canvas). Drag inside the box moves it; a corner handle resizes it
// with the aspect ratio kept (Shift: free). Moves and unrotated resizes snap to the canvas edges and centre within
// 8 screen px (Alt: no snap).
//
// Edit path: while dragging, every mouse move applies the rectangle through Backend::apply, which is
// Studio::layer_set_placement, the code behind the RPC layers.setPlacement (no round trip to the UI per move). The
// release applies the final rectangle once more and records it as ONE edit (seq + placement), which the UI server
// reads with preview.edits (host.status carries previewEditSeq) and autosaves like an inspector edit.
//
// Threading: Editor state is touched by the preview UI thread (window procedure) and by the RPC threads
// (setEditing, editSim, edits) and read by draw_cb on the libobs graphics thread. One mutex guards it; it is never
// held across a Backend call or any libobs call (Backend calls take the Studio lock and libobs scene locks).
#pragma once

#include "json.h"

#include <cstdint>
#include <deque>
#include <functional>
#include <map>
#include <mutex>
#include <string>
#include <vector>

namespace pedit {

struct Rect {
	double x = 0, y = 0, w = 0, h = 0, rot = 0; // canvas px; degrees about the centre
};
struct Item {
	std::string id;
	Rect r;
};
// Where the canvas is drawn inside the preview's client area (letterboxed, draw_cb's math).
struct View {
	double vx = 0, vy = 0, vw = 0, vh = 0; // client px
	double cw = 0, ch = 0;                 // canvas px
	double canvas_per_px() const { return vw > 0 ? cw / vw : 1; }
};
View fit_view(double client_w, double client_h, double canvas_w, double canvas_h);
void to_canvas(const View &v, double sx, double sy, double &cx, double &cy);
bool contains(const Rect &r, double cx, double cy);
// Corner 0..3 (top-left, top-right, bottom-right, bottom-left, in the layer's own frame) within tol canvas px, or -1.
int hit_corner(const Rect &r, double cx, double cy, double tol);
// Index into top_first of the first item containing the point, or -1.
int hit_item(const std::vector<Item> &top_first, double cx, double cy);
void corners(const Rect &r, double out[4][2]); // canvas px, same order as hit_corner

enum class Mode { None, Move, Resize };
struct DragIn {
	Rect start;
	Mode mode = Mode::None;
	int corner = -1;           // Resize only
	double sx = 0, sy = 0;     // press point, canvas px
	double cx = 0, cy = 0;     // current point, canvas px
	bool free_aspect = false;  // Shift
	bool snap = true;          // !Alt
	double snap_tol = 8;       // canvas px (8 screen px)
	double cw = 0, ch = 0;     // canvas size
};
Rect drag(const DragIn &d);

// Mouse modifier keys for one event.
struct Mods {
	bool shift = false, alt = false;
};

// What the editor needs from the studio. Both run on the caller's thread with no Editor lock held.
struct Backend {
	// Visible layers of the canvas's active scene that have a project placement, topmost first. false: nothing
	// to edit (no project, test format, model busy).
	std::function<bool(const std::string &canvas, std::string &scene, std::vector<Item> &top_first)> layers;
	// Applies x, y, width, height to the layer on that canvas (Studio::layer_set_placement). Returns "" or the error.
	std::function<std::string(const std::string &canvas, const std::string &scene, const std::string &layer,
				  const Rect &r)>
		apply;
	// true while any stream output is live (live-lock, D233): a press then selects nothing and starts no drag.
	// Placement changes while live go through the control page's "yes, on air". Unset: never locked.
	std::function<bool()> locked;
};

class Editor {
public:
	explicit Editor(Backend b) : be_(std::move(b)) {}

	void set_enabled(bool on); // off clears every selection and cancels a drag (the layer stays where it is)
	bool enabled() const;

	// Mouse events in client px of a preview whose letterbox is v. Return true when the event was used.
	bool down(const std::string &canvas, const View &v, double sx, double sy, Mods m);
	bool move(const std::string &canvas, const View &v, double sx, double sy, Mods m);
	bool up(const std::string &canvas, const View &v, double sx, double sy, Mods m);
	void cancel(const std::string &canvas); // lost mouse capture: the layer goes back to where the drag began
	bool dragging(const std::string &canvas) const;
	// Re-reads the selected layer's rectangle (an inspector edit or a scene switch); clears a selection whose layer
	// is gone or hidden. UI thread, about 5 times a second while something is selected and no drag runs.
	void refresh(const std::string &canvas);

	// For draw_cb: the selected rectangle on a canvas (false: nothing to draw).
	bool selection(const std::string &canvas, Rect &r) const;
	json::Value selection_json(const std::string &canvas) const;

	struct Edit {
		uint64_t seq = 0;
		std::string canvas, scene, layer;
		Rect r;
		Rect before; // the rectangle when the gesture began (UI server undo, D238)
	};
	uint64_t seq() const;
	// Committed edits with seq > since (oldest first; the last 64 are kept). truncated: some were dropped.
	json::Value edits(uint64_t since) const;

private:
	struct Sel {
		std::string scene, layer;
		Rect r;
		bool has = false;
		Mode mode = Mode::None;
		int corner = -1;
		Rect start;
		double sx = 0, sy = 0;
		bool moved = false;
	};
	Backend be_;
	mutable std::mutex m_;
	bool enabled_ = false;
	std::map<std::string, Sel> sel_; // canvas -> selection
	std::deque<Edit> edits_;
	uint64_t seq_ = 0;
};

json::Value rect_json(const Rect &r);

} // namespace pedit
