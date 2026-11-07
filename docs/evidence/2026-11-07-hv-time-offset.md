# 2026-11-07 H/V recording time offset

Question: montages and live clips cut the V canvas recording at times found on the H recording. Are the two timelines the same?

## Method

Practice recordings `practice-h-…mkv` and `practice-v-…mkv` from one start (2026-11-07, about 955 s each).

- `ffprobe`: both have video start 0.000 s, audio start 0.021 s. Durations 955.317 s (H) and 955.267 s (V).
- Audio cross-correlation (first audio track, mono, 8 kHz, 20 s windows, FFT): scratch script, not committed.

## Result

| Window start | Lag (H behind V) | Peak / RMS |
|---|---|---|
| 60 s | 85.4 ms | 82.8 |
| 400 s | 85.4 ms | 42.3 |
| 900 s | 85.4 ms | 68.0 |

The offset is 85 ms and constant: no drift over 15 min. It is far below the montage padding (3 s before, 1.5 s after a kill), so no correction is applied.

## Limits

- One recording. Audio only; the video offset of each file to its own audio is not measured.
- Status: measured on one session; recheck on the first real stream recording.
