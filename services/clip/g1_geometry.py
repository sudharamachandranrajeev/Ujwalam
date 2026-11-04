# SPDX-License-Identifier: GPL-3.0-or-later
"""G1 geometry: detector ROIs (fractions of the game area) to frame pixels. Stdlib only.

A layout describes where the game area sits in a frame and which part of the frame
actually shows it:

  {"frame": [W, H],
   "game":  [x, y, w, h],        game area in frame pixels; may extend past the frame
   "visible": [x0, y0, x1, y1]}  the part of the frame that shows the game (the
                                  vertical cutout; the whole game area for a
                                  full-screen H frame)

Full-screen reference frames (1920x1080 capture card): game = cropdetect box,
visible = the same box. Vertical Meld clips (1080x1920): the game is scaled and
cropped into a rounded cutout; see g1_scan.py calibrate.
"""

from __future__ import annotations


def roi_box(roi, game):
    """ROI dict with x0..y1 fractions -> (x0, y0, x1, y1) in frame pixels (floats)."""
    gx, gy, gw, gh = game
    return (gx + roi["x0"] * gw, gy + roi["y0"] * gh, gx + roi["x1"] * gw, gy + roi["y1"] * gh)


def intersect(a, b):
    x0, y0 = max(a[0], b[0]), max(a[1], b[1])
    x1, y1 = min(a[2], b[2]), min(a[3], b[3])
    if x1 <= x0 or y1 <= y0:
        return None
    return (x0, y0, x1, y1)


def area(box) -> float:
    return 0.0 if box is None else max(0.0, box[2] - box[0]) * max(0.0, box[3] - box[1])


def roi_visibility(roi, layout) -> float:
    """Fraction (0..1) of the ROI area that falls inside the visible part of the frame."""
    box = roi_box(roi, layout["game"])
    a = area(box)
    if a <= 0:
        return 0.0
    return round(area(intersect(box, tuple(layout["visible"]))) / a, 4)


def roi_crop_px(roi, layout):
    """Integer pixel box of the visible part of the ROI, or None when nothing is visible."""
    box = intersect(roi_box(roi, layout["game"]), tuple(layout["visible"]))
    if box is None:
        return None
    x0, y0, x1, y1 = (int(round(v)) for v in box)
    if x1 - x0 < 2 or y1 - y0 < 2:
        return None
    return (x0, y0, x1, y1)


def visible_game_fraction(layout):
    """The visible window expressed as game-area fractions (x0, y0, x1, y1), clamped to 0..1."""
    gx, gy, gw, gh = layout["game"]
    v = layout["visible"]
    f = ((v[0] - gx) / gw, (v[1] - gy) / gh, (v[2] - gx) / gw, (v[3] - gy) / gh)
    return tuple(round(min(1.0, max(0.0, c)), 4) for c in f)


def point_to_game(x, y, game):
    """Frame pixel -> game-area fraction (unclamped)."""
    gx, gy, gw, gh = game
    return ((x - gx) / gw, (y - gy) / gh)


def game_from_landmarks(ref_a, frame_a, ref_b, frame_b, ref_game, aspect=None):
    """Solve the game-area box in a frame from two landmarks.

    ref_a/ref_b: landmark centres (x, y) in a full-screen reference frame whose game
    area is ref_game (x, y, w, h). frame_a/frame_b: the same landmarks found in the
    target frame. Scale comes from the horizontal distance between the landmarks
    (they must differ in x); the vertical scale is the same (uniform scaling).
    Returns (x, y, w, h) of the game area in the target frame."""
    dx_ref = ref_b[0] - ref_a[0]
    if abs(dx_ref) < 1e-6:
        raise ValueError("landmarks must differ in x")
    s = (frame_b[0] - frame_a[0]) / dx_ref
    gx = frame_a[0] - s * (ref_a[0] - ref_game[0])
    gy = frame_a[1] - s * (ref_a[1] - ref_game[1])
    return (gx, gy, s * ref_game[2], s * ref_game[3])


def game_from_scale(scale, frame_pt, ref_pt, ref_game):
    """Game-area box from a known scale and one landmark (frame_pt <-> ref_pt)."""
    gx = frame_pt[0] - scale * (ref_pt[0] - ref_game[0])
    gy = frame_pt[1] - scale * (ref_pt[1] - ref_game[1])
    return (gx, gy, scale * ref_game[2], scale * ref_game[3])
