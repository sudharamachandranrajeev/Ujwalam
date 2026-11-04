# game-facecam geometry: data-consistency check (2026-11-05, partial)

Picked up "facecam rectangle" from waiting-on-user. Could not fully close
it — explaining exactly why, rather than claiming it's done.

## What was checked and confirmed
`data/clip/layouts.json`'s `game-facecam` layout claims its `facecam` and
`game` rects are "a read-only copy of ... `registry/presets/scene-default-h.json`".
Compared byte-for-byte:

| Layer | layouts.json | scene-default-h.json | Match |
|---|---|---|---|
| facecam | `[0.01397, 0.5652, 0.20165, 0.34522]` | `x:0.01397 y:0.5652 w:0.20165 h:0.34522` | exact |
| game | `[0.24373, 0.02887, 0.73844, 0.90541]` | `x:0.24373 y:0.02887 w:0.73844 h:0.90541` | exact |

No transcription error from the copy. `clip_render.py`'s `_rect()`/
`layout_graph()` treats these as the already-composited bounding box in
the recorded H frame — correct, since the preset's separate `crop` fields
(`facecam: left/right 399px`, `game: left/right 177px`) describe how OBS
crops the raw camera/game *source* before compositing, which is already
baked into the recorded H video by the time clip rendering runs. No code
change needed; the render math doesn't need to re-apply that crop.

## What's still genuinely open — needs a real recording, not more code
No actual stream recording exists on this machine right now (checked
`%LOCALAPPDATA%\Ujwalam` for `.mkv`/`.mp4`, found none) to render a real
frame through `layout_graph` and eyeball whether the rectangle lines up
with where the facecam visually sits. This is the one thing in this list
that genuinely cannot be faked or skipped with more code — it needs either
a real recorded clip, or the user to run the host live once and let the
system capture a frame.

**Conclusion: geometry status stays `unverified` in `layouts.json`** (not
changed) — the data-consistency half is now confirmed, but the visual
check still needs an actual recording, same blocker as before, just
narrowed down to exactly one remaining step.
