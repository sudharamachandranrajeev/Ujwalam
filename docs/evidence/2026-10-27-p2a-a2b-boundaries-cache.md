# 2026-10-27 — P2a A2b: session boundaries file, name-time check from audio, analysis cache

Follow-up to `docs/evidence/2026-10-27-p2a-a2-session-index.md`; supersedes its name-time finding.

The corpus folder `<clips-corpus>` was only read: listed, probed with ffprobe and decoded by ffmpeg as an input. Nothing in it was written, moved, renamed or deleted. The concat lists, logs and all outputs are outside it, and every tool refuses an output path inside it. Nothing was installed or downloaded. No chat logs or engage logs were opened. No commit was made.

Tools: Python 3.14.7 (stdlib only, run with `python -I`); ffmpeg/ffprobe `N-126374-g089a48eb36-20260831`; Node 26.12.1 for `npm test`.

## 1. Session boundaries file

- `data/sessions.json`, schema `data/sessions.schema.json` (JSON Schema 2020-12). It is written by `services/clip/session_index.py --sessions-file data/sessions.json`.
- Each entry has `id`, `source` (`rule` | `manual`), `firstClip`, `lastClip`, an optional `note`, and for rule entries `startLocal`, `startUtc`, `endLocal`, `endUtc` and `clipCount`. It holds only file names and times.
- Rule: a gap greater than `gapThresholdSec` between one clip's end and the next clip's start begins a new session. `--gap-threshold` overrides the threshold. With no flag, the tool uses `defaults.gapThresholdSec` from the file (120), or 120 when there is no file.
- Manual entries win. Each one claims its clips (`firstClip` .. `lastClip`) before the rule groups the rest. A rerun keeps every manual entry exactly as written, never drops one (an entry whose clips are missing is kept and reported as a warning), and regenerates only the rule entries.
- An existing file that fails validation stops the run, and the file is not changed (exit 2). A sessions file inside the corpus is refused.
- Current content: 18 rule entries, 0 manual. `rule: {gapThresholdSec: 120, nameTime: "end"}`. 27 Sep 17:53–19:57 is one session (`s-2026-09-27-1753`, 242 clips).
- Validation: `tests/sessions-schema.test.mjs` (ajv 2020, strict) validates the real file plus negative cases. It runs in `npm test`.

## 2. Name time = clip END: audio check

### Method (`services/clip/boundary_xcorr.py`, METHOD_VERSION 8)

1. Decode A's last W s and B's first W s to 8 kHz mono s16 with `aresample=async=1:min_hard_comp=0.01:first_pts=0`. W is at least 8 s and covers the largest overlap either hypothesis predicts. Every Meld clip's first AAC packet is followed by a timestamp gap of about 0.10–0.15 s. The fill makes the sample index equal the clip timeline, and B's leading fill is skipped when comparing.
2. Compute a 10 ms energy envelope (dB) of both sides.
3. Correlate the envelopes for every candidate overlap n (0.25 s .. W): Pearson r of A's last n frames against B's first n frames. Keep the 5 best candidates by significance (Fisher z·√n) and the 5 best by r.
4. Refine each candidate on raw samples in 1-sample steps within ±15 ms over the first 0.25 s of the overlap. Re-score the winner (±2 samples) over up to 2 s. That r is the confidence.
5. Accept only when the compared audio is louder than −70 dBFS, r ≥ 0.90 and at least 0.25 s is compared. Otherwise the result is `rejected-silent` or `rejected-low-confidence`. A gap (no shared audio) can never be measured.

Per boundary: `trimInSec = overlap + (A.duration − A.audioEnd)`, which is the in-point of B on the virtual timeline. `startToStartSec = A.duration − trim`.
- Under name = end, the name delta should be ≈ `B.duration − trim`.
- Under name = start, the name delta should be ≈ `A.duration − trim`.
- Residual = name delta − predicted delta. Names have 1 s resolution, so under the right hypothesis every residual lies in about (−1, +1) s.
- A hypothesis fits when ≥ 95 % of residuals satisfy |residual| ≤ 1.1 s. This must hold for all measured boundaries and for the discriminating subset (|A.duration − B.duration| ≥ 1.5 s), where the two predictions differ by more than the name resolution.

Null test: 200 pairs clip i → clip i+2 (no shared audio) measured with the same rule. Earlier versions of the method accepted 3 of 100 at r ≥ 0.8 with very short compares. That is why the thresholds are 0.90 and 0.25 s.

Synthetic accuracy (tests): the envelope xcorr recovers 0.73 / 1.5 / 2.004 / 4.25 s within 10 ms. The sample-level result recovers 0.6125 / 1.9871 / 3.3333 s within 1 sample (0.125 ms) at r > 0.99.

### Commands

```
sh run-sample.sh        # scratchpad helper; the command it runs:
python -I services/clip/boundary_xcorr.py --index C:/AI/Claude/_data/Ujwalam/index/index.json \
  --corpus "<clips-corpus>" \
  --out C:/AI/Claude/_data/Ujwalam/index/boundaries-sample.json \
  --sample-sessions s-2026-10-20-1214,s-2026-10-18-1221,s-2026-09-24-1830,s-2026-09-27-1051,s-2026-10-14-1949,s-2026-10-17-1656,s-2026-10-22-2002,s-2026-09-26-1554,s-2026-09-30-1743,s-2026-10-13-2000,s-2026-10-15-2014,s-2026-10-16-1953,s-2026-10-21-1916 \
  --sample-per-session 10 --seed 20261027 --short-first --workers 8 --null-pairs 200 \
  --pairs <A,B> x 8   # the special pairs in the table below (full file names)

python -I services/clip/boundary_xcorr.py --index C:/AI/Claude/_data/Ujwalam/index/index.json \
  --corpus "<clips-corpus>" \
  --out C:/AI/Claude/_data/Ujwalam/index/boundaries.json \
  --sessions s-2026-10-20-1214,s-2026-10-18-1221 --workers 6
# then the sample command again with --out .../boundaries.json and no --null-pairs (adds the sample pairs)
```

### Result: sample (146 boundaries, 18 sessions)

130 random boundaries (10 per sampled session, seed 20261027), 8 boundaries after a short (< 25 s) first clip, and 8 special pairs.

| | n | ok | rejected-silent | rejected-low-confidence |
|---|---|---|---|---|
| all | 146 | 69 | 22 | 55 |

The 69 measured boundaries come from 15 sessions.

`verdict` (from `boundaries-sample.json`):

| Subset | n | name = END: within ±1.1 s | name = START: within ±1.1 s |
|---|---|---|---|
| all measured | 69 | **69 (100 %)**, residuals −0.208 .. +0.900 | 51 (73.9 %), −0.035 .. +15.918 |
| discriminating | 18 | **18 (100 %)**, −0.187 .. +0.900 | 0 (0 %), +1.971 .. +15.918 |

**Verdict (sample): END fits; START does not fit.**

Null test: 200 pairs; **0 accepted**. The highest r was 0.844; then 0.695, 0.472. Status: 173 low-confidence, 26 silent, 1 no-data.

Distribution of the 69 measured boundaries:
- END residuals (0.1 s bins): −0.2: 13, −0.1: 42, +0.1: 1, +0.2: 1, +0.8: 6, +0.9: 6.
  - This is bimodal. Residuals of −0.21 .. −0.08 go with a name delta of 30 s, and +0.81 .. +0.90 go with 31 s.
  - The two +0.1/+0.2 values are the special pairs 09-28 11.01.00 (+0.125) and 10-17 4.56.56 (+0.232).
- START residuals (1 s bins): 0: 42, 1: 9, 2: 10, 3: 5, 6: 1, 8: 1, 16: 1.
- Start-to-start spacing is close to an integer: 30.0 s (50), 28.0 s (14), 24.0 s (2), plus singles at 6.0, 14.1 and 22.1 s.
- End-to-end spacing is constant. Over the 67 normal boundaries (name delta 30/31 s) the median is 30.123 s and the range 30.079–30.208 s. Over all 700 such boundaries in `boundaries.json` the median is 30.124 s and the range 30.059–30.230 s.
  - So a clip is saved every ≈ 30.12 s, and each clip starts on a keyframe 28 or 30 s before the next. This explains why the name delta is 30 s or 31 s.
- Rejections agree with END too.
  - There are 52 non-special low-confidence rejections. Under END, only 3 of them should share ≥ 0.5 s of audio; under START, 27 should.
  - Most rejections therefore sit at boundaries that END predicts are gaps or tiny overlaps.

#### Per-boundary table (sample)

Name-time gap = B start − A end under END (negative = overlap). Measured overlap is shown only for status ok. dn = name delta (s). Res. = residual under each hypothesis (s). r and dB: confidence and level of the compared audio.

| # | Session | A -> B | Why | dn | aDur | bDur | Name-time gap (end) | Measured overlap | r | dB | Res. end | Res. start | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | s-2026-09-25-1852 | 09-25 6.52.46pm -> 6.53.16pm | short-first | 30 | 24.531 | 30.683 | -0.683 | 0.538 | 0.986 | -51.7 | -0.145 | 6.007 | ok |
| 2 | s-2026-09-28-1829 | 09-28 6.30.17pm -> 6.30.47pm | short-first | 30 | 23.262 | 31.352 | -1.352 | 1.166 | 1.000 | -67.5 | -0.187 | 7.903 | ok |
| 3 | s-2026-09-29-2001 | 09-29 8.02.08pm -> 8.02.38pm | short-first | 30 | 14.559 | 31.241 | -1.241 |  | 1.000 | -77.8 |  |  | rejected-silent |
| 4 | s-2026-10-01-1944 | 10-01 7.44.16pm -> 7.44.47pm | short-first | 31 | 14.640 | 30.488 | 0.512 |  | 0.109 | -75.3 |  |  | rejected-silent |
| 5 | s-2026-10-13-2000 | 10-13 8.00.32pm -> 8.01.02pm | short-first | 30 | 18.539 | 28.325 | 1.675 |  | 0.062 | -59.1 |  |  | rejected-low-confidence |
| 6 | s-2026-10-16-1953 | 10-16 7.54.04pm -> 7.54.34pm | short-first | 30 | 18.551 | 28.556 | 1.444 |  | 0.069 | -69.3 |  |  | rejected-low-confidence |
| 7 | s-2026-10-21-1916 | 10-21 7.17.12pm -> 7.17.42pm | short-first | 30 | 15.658 | 31.699 | -1.699 | 1.577 | 0.987 | -46.0 | -0.123 | 15.918 | ok |
| 8 | s-2026-10-22-2002 | 10-22 8.03.05pm -> 8.03.35pm | short-first | 30 | 15.354 | 28.823 | 1.177 |  | 0.206 | -60.4 |  |  | rejected-low-confidence |
| 9 | s-2026-09-24-1830 | 09-24 6.53.23pm -> 6.53.53pm | random-sample | 30 | 31.993 | 32.099 | -2.099 | 1.998 | 0.980 | -29.7 | -0.101 | 0.005 | ok |
| 10 | s-2026-09-24-1830 | 09-24 6.56.54pm -> 6.57.24pm | random-sample | 30 | 30.856 | 31.029 | -1.029 | 0.864 | 0.992 | -30.7 | -0.165 | 0.008 | ok |
| 11 | s-2026-09-24-1830 | 09-24 6.57.54pm -> 6.58.24pm | random-sample | 30 | 29.194 | 29.313 | 0.687 |  | 0.051 | -20.9 |  |  | rejected-low-confidence |
| 12 | s-2026-09-24-1830 | 09-24 7.00.55pm -> 7.01.25pm | random-sample | 30 | 31.957 | 30.035 | -0.035 |  | -0.003 | -49.0 |  |  | rejected-low-confidence |
| 13 | s-2026-09-24-1830 | 09-24 7.03.56pm -> 7.04.26pm | random-sample | 30 | 30.661 | 30.841 | -0.841 | 0.676 | 0.995 | -39.7 | -0.165 | 0.015 | ok |
| 14 | s-2026-09-24-1830 | 09-24 7.12.58pm -> 7.13.28pm | random-sample | 30 | 31.166 | 31.315 | -1.315 | 1.171 | 0.993 | -43.9 | -0.144 | 0.005 | ok |
| 15 | s-2026-09-24-1830 | 09-24 7.20.30pm -> 7.21.00pm | random-sample | 30 | 31.002 | 29.168 | 0.832 |  | 0.046 | -74.5 |  |  | rejected-silent |
| 16 | s-2026-09-24-1830 | 09-24 7.23.31pm -> 7.24.01pm | random-sample | 30 | 31.876 | 31.994 | -1.994 | 1.871 | 1.000 | -50.5 | -0.122 | -0.005 | ok |
| 17 | s-2026-09-24-1830 | 09-24 7.33.33pm -> 7.34.03pm | random-sample | 30 | 30.544 | 30.620 | -0.620 | 0.540 | 1.000 | -46.2 | -0.079 | -0.003 | ok |
| 18 | s-2026-09-24-1830 | 09-24 7.34.34pm -> 7.35.04pm | random-sample | 30 | 30.750 | 28.850 | 1.150 |  | 0.009 | -69.6 |  |  | rejected-low-confidence |
| 19 | s-2026-09-26-1554 | 09-26 4.09.38pm -> 4.10.09pm | random-sample | 31 | 30.960 | 29.110 | 1.890 |  | 0.077 | -42.6 |  |  | rejected-low-confidence |
| 20 | s-2026-09-26-1554 | 09-26 4.44.49pm -> 4.45.19pm | random-sample | 30 | 31.660 | 31.824 | -1.824 | 1.659 | 0.995 | -46.0 | -0.165 | -0.001 | ok |
| 21 | s-2026-09-26-1554 | 09-26 5.11.26pm -> 5.11.56pm | random-sample | 30 | 31.041 | 31.143 | -1.143 | 1.042 | 0.995 | -63.8 | -0.101 | 0.001 | ok |
| 22 | s-2026-09-26-1554 | 09-26 5.20.59pm -> 5.21.29pm | random-sample | 30 | 29.731 | 31.912 | -1.912 | 1.747 | 0.993 | -45.8 | -0.165 | 2.016 | ok |
| 23 | s-2026-09-26-1554 | 09-26 6.09.41pm -> 6.10.11pm | random-sample | 30 | 28.202 | 30.325 | -0.325 |  | 0.204 | -69.8 |  |  | rejected-low-confidence |
| 24 | s-2026-09-26-1554 | 09-26 6.31.47pm -> 6.32.17pm | random-sample | 30 | 31.928 | 30.088 | -0.088 |  | 0.095 | -43.4 |  |  | rejected-low-confidence |
| 25 | s-2026-09-26-1554 | 09-26 6.37.18pm -> 6.37.49pm | random-sample | 31 | 29.291 | 31.475 | -0.475 | 1.288 | 1.000 | -35.6 | 0.813 | 2.997 | ok |
| 26 | s-2026-09-26-1554 | 09-26 7.18.59pm -> 7.19.29pm | random-sample | 30 | 30.006 | 30.133 | -0.133 |  | 0.105 | -55.1 |  |  | rejected-low-confidence |
| 27 | s-2026-09-26-1554 | 09-26 7.21.00pm -> 7.21.30pm | random-sample | 30 | 30.501 | 30.608 | -0.608 | 0.506 | 0.993 | -57.9 | -0.102 | 0.005 | ok |
| 28 | s-2026-09-26-1554 | 09-26 7.28.32pm -> 7.29.02pm | random-sample | 30 | 30.442 | 30.595 | -0.595 | 0.452 | 0.987 | -58.0 | -0.143 | 0.010 | ok |
| 29 | s-2026-09-27-1051 | 09-27 10.57.35am -> 10.58.06am | random-sample | 31 | 30.404 | 30.596 | 0.404 | 0.410 | 1.000 | -67.4 | 0.814 | 1.006 | ok |
| 30 | s-2026-09-27-1051 | 09-27 11.36.47am -> 11.37.18am | random-sample | 31 | 30.447 | 30.631 | 0.369 | 0.445 | 0.995 | -42.6 | 0.813 | 0.997 | ok |
| 31 | s-2026-09-27-1051 | 09-27 11.52.22am -> 11.52.52am | random-sample | 30 | 31.353 | 29.493 | 0.507 |  | 0.006 | -55.1 |  |  | rejected-low-confidence |
| 32 | s-2026-09-27-1051 | 09-27 11.58.24am -> 11.58.54am | random-sample | 30 | 31.138 | 29.266 | 0.734 |  | 0.013 | -29.7 |  |  | rejected-low-confidence |
| 33 | s-2026-09-27-1051 | 09-27 12.42.07pm -> 12.42.38pm | random-sample | 31 | 30.561 | 30.757 | 0.243 | 0.570 | 0.964 | -59.8 | 0.813 | 1.009 | ok |
| 34 | s-2026-09-27-1051 | 09-27 1.05.14pm -> 1.05.45pm | random-sample | 31 | 31.597 | 31.767 | -0.767 | 1.602 | 0.980 | -62.5 | 0.835 | 1.005 | ok |
| 35 | s-2026-09-27-1051 | 09-27 1.08.46pm -> 1.09.16pm | random-sample | 30 | 30.830 | 30.972 | -0.972 |  | 0.635 | -81.9 |  |  | rejected-silent |
| 36 | s-2026-09-27-1051 | 09-27 1.35.54pm -> 1.36.24pm | random-sample | 30 | 29.044 | 31.143 | -1.143 | 1.042 | 0.969 | -24.2 | -0.101 | 1.998 | ok |
| 37 | s-2026-09-27-1051 | 09-27 2.01.30pm -> 2.02.01pm | random-sample | 31 | 29.723 | 31.822 | -0.822 | 1.721 | 0.972 | -53.5 | 0.900 | 2.999 | ok |
| 38 | s-2026-09-27-1051 | 09-27 4.30.10pm -> 4.30.40pm | random-sample | 30 | 30.921 | 31.015 | -1.015 | 0.914 | 0.947 | -56.3 | -0.101 | -0.007 | ok |
| 39 | s-2026-09-30-1743 | 09-30 5.46.50pm -> 5.47.20pm | random-sample | 30 | 31.257 | 31.431 | -1.431 | 1.266 | 0.983 | -33.9 | -0.166 | 0.008 | ok |
| 40 | s-2026-09-30-1743 | 09-30 5.51.22pm -> 5.51.52pm | random-sample | 30 | 30.610 | 30.754 | -0.754 | 0.610 | 0.973 | -62.2 | -0.144 | 0.000 | ok |
| 41 | s-2026-09-30-1743 | 09-30 6.00.24pm -> 6.00.54pm | random-sample | 30 | 31.270 | 31.462 | -1.462 | 1.276 | 0.994 | -54.1 | -0.186 | 0.006 | ok |
| 42 | s-2026-09-30-1743 | 09-30 6.11.58pm -> 6.12.28pm | random-sample | 30 | 30.802 | 28.952 | 1.048 |  | -0.001 | -19.6 |  |  | rejected-low-confidence |
| 43 | s-2026-09-30-1743 | 09-30 6.44.38pm -> 6.45.08pm | random-sample | 30 | 31.227 | 29.309 | 0.691 |  | 0.036 | -59.6 |  |  | rejected-low-confidence |
| 44 | s-2026-09-30-1743 | 09-30 6.50.40pm -> 6.51.10pm | random-sample | 30 | 28.952 | 29.123 | 0.877 |  | -0.007 | -43.5 |  |  | rejected-low-confidence |
| 45 | s-2026-09-30-1743 | 09-30 6.53.41pm -> 6.54.11pm | random-sample | 30 | 31.895 | 30.044 | -0.044 |  | 0.224 | -46.5 |  |  | rejected-low-confidence |
| 46 | s-2026-09-30-1743 | 09-30 7.03.14pm -> 7.03.44pm | random-sample | 30 | 30.827 | 28.991 | 1.009 |  | 0.054 | -51.5 |  |  | rejected-low-confidence |
| 47 | s-2026-09-30-1743 | 09-30 7.15.48pm -> 7.16.18pm | random-sample | 30 | 30.635 | 28.782 | 1.218 |  | 0.060 | -45.8 |  |  | rejected-low-confidence |
| 48 | s-2026-09-30-1743 | 09-30 7.26.51pm -> 7.27.21pm | random-sample | 30 | 30.236 | 28.381 | 1.619 |  | 0.002 | -64.4 |  |  | rejected-low-confidence |
| 49 | s-2026-10-13-2000 | 10-13 8.08.34pm -> 8.09.04pm | random-sample | 30 | 28.552 | 28.715 | 1.285 |  | 0.197 | -19.5 |  |  | rejected-low-confidence |
| 50 | s-2026-10-13-2000 | 10-13 8.12.35pm -> 8.13.05pm | random-sample | 30 | 31.679 | 31.804 | -1.804 | 1.681 | 0.985 | -38.2 | -0.123 | 0.002 | ok |
| 51 | s-2026-10-13-2000 | 10-13 8.16.06pm -> 8.16.36pm | random-sample | 30 | 30.610 | 28.755 | 1.245 |  | 0.046 | -31.2 |  |  | rejected-low-confidence |
| 52 | s-2026-10-13-2000 | 10-13 8.17.36pm -> 8.18.07pm | random-sample | 31 | 30.942 | 31.104 | -0.104 | 0.939 | 0.993 | -39.3 | 0.836 | 0.997 | ok |
| 53 | s-2026-10-13-2000 | 10-13 8.19.37pm -> 8.20.07pm | random-sample | 30 | 29.517 | 31.619 | -1.619 | 1.517 | 0.994 | -37.9 | -0.102 | 2.000 | ok |
| 54 | s-2026-10-13-2000 | 10-13 8.37.12pm -> 8.37.42pm | random-sample | 30 | 30.324 | 30.473 | -0.473 |  | 0.075 | -33.0 |  |  | rejected-low-confidence |
| 55 | s-2026-10-13-2000 | 10-13 8.37.42pm -> 8.38.12pm | random-sample | 30 | 30.473 | 28.593 | 1.407 |  | -0.002 | -29.4 |  |  | rejected-low-confidence |
| 56 | s-2026-10-13-2000 | 10-13 8.43.43pm -> 8.44.13pm | random-sample | 30 | 31.868 | 32.015 | -2.015 | 1.871 | 1.000 | -33.1 | -0.144 | 0.003 | ok |
| 57 | s-2026-10-13-2000 | 10-13 9.00.48pm -> 9.01.18pm | random-sample | 30 | 30.625 | 29.117 | 0.883 |  | 0.090 | -36.7 |  |  | rejected-low-confidence |
| 58 | s-2026-10-13-2000 | 10-13 9.01.18pm -> 9.01.48pm | random-sample | 30 | 29.117 | 29.166 | 0.834 |  | 0.011 | -76.1 |  |  | rejected-silent |
| 59 | s-2026-10-14-1949 | 10-14 8.01.02pm -> 8.01.32pm | random-sample | 30 | 31.941 | 30.106 | -0.106 |  | 0.044 | -38.2 |  |  | rejected-low-confidence |
| 60 | s-2026-10-14-1949 | 10-14 8.09.34pm -> 8.10.04pm | random-sample | 30 | 31.847 | 31.957 | -1.957 | 1.855 | 0.997 | -28.2 | -0.102 | 0.008 | ok |
| 61 | s-2026-10-14-1949 | 10-14 8.14.36pm -> 8.15.06pm | random-sample | 30 | 31.115 | 31.260 | -1.260 | 1.116 | 0.989 | -30.7 | -0.144 | 0.001 | ok |
| 62 | s-2026-10-14-1949 | 10-14 8.25.08pm -> 8.25.38pm | random-sample | 30 | 31.624 | 29.744 | 0.256 |  | 0.084 | -77.9 |  |  | rejected-silent |
| 63 | s-2026-10-14-1949 | 10-14 8.29.09pm -> 8.29.39pm | random-sample | 30 | 30.513 | 30.632 | -0.632 | 0.509 | 1.000 | -27.0 | -0.123 | -0.004 | ok |
| 64 | s-2026-10-14-1949 | 10-14 8.29.39pm -> 8.30.09pm | random-sample | 30 | 30.632 | 30.732 | -0.732 | 0.631 | 0.971 | -20.2 | -0.101 | -0.001 | ok |
| 65 | s-2026-10-14-1949 | 10-14 8.59.47pm -> 9.00.17pm | random-sample | 30 | 28.317 | 30.462 | -0.462 |  | 0.003 | -50.5 |  |  | rejected-low-confidence |
| 66 | s-2026-10-14-1949 | 10-14 9.02.48pm -> 9.03.18pm | random-sample | 30 | 31.046 | 31.143 | -1.143 | 1.042 | 0.997 | -39.9 | -0.102 | -0.005 | ok |
| 67 | s-2026-10-14-1949 | 10-14 9.10.50pm -> 9.11.20pm | random-sample | 30 | 30.977 | 31.128 | -1.128 | 0.984 | 0.998 | -33.9 | -0.144 | 0.007 | ok |
| 68 | s-2026-10-14-1949 | 10-14 9.13.20pm -> 9.13.50pm | random-sample | 30 | 29.529 | 31.626 | -1.626 | 1.524 | 0.987 | -38.3 | -0.102 | 1.996 | ok |
| 69 | s-2026-10-15-2014 | 10-15 8.25.33pm -> 8.26.04pm | random-sample | 31 | 30.476 | 30.601 | 0.399 | 0.478 | 0.987 | -35.1 | 0.877 | 1.002 | ok |
| 70 | s-2026-10-15-2014 | 10-15 8.29.34pm -> 8.30.05pm | random-sample | 31 | 31.513 | 29.661 | 1.339 |  | 0.056 | -62.4 |  |  | rejected-low-confidence |
| 71 | s-2026-10-15-2014 | 10-15 8.43.38pm -> 8.44.08pm | random-sample | 30 | 31.266 | 31.363 | -1.363 | 1.262 | 0.967 | -47.5 | -0.102 | -0.005 | ok |
| 72 | s-2026-10-15-2014 | 10-15 8.56.11pm -> 8.56.42pm | random-sample | 31 | 30.597 | 28.703 | 2.297 |  | -0.004 | -40.9 |  |  | rejected-low-confidence |
| 73 | s-2026-10-15-2014 | 10-15 8.58.42pm -> 8.59.12pm | random-sample | 30 | 29.216 | 31.384 | -1.384 | 1.219 | 0.992 | -47.2 | -0.165 | 2.003 | ok |
| 74 | s-2026-10-15-2014 | 10-15 8.59.42pm -> 9.00.13pm | random-sample | 31 | 29.548 | 31.649 | -0.649 |  | 0.836 | -101.7 |  |  | rejected-silent |
| 75 | s-2026-10-15-2014 | 10-15 9.04.14pm -> 9.04.44pm | random-sample | 30 | 30.771 | 28.942 | 1.058 |  | 0.135 | -66.9 |  |  | rejected-low-confidence |
| 76 | s-2026-10-15-2014 | 10-15 9.06.14pm -> 9.06.44pm | random-sample | 30 | 31.322 | 29.506 | 0.494 |  | 0.101 | -46.3 |  |  | rejected-low-confidence |
| 77 | s-2026-10-15-2014 | 10-15 9.06.44pm -> 9.07.15pm | random-sample | 31 | 29.506 | 31.631 | -0.631 | 1.508 | 1.000 | -58.2 | 0.877 | 3.002 | ok |
| 78 | s-2026-10-15-2014 | 10-15 9.14.46pm -> 9.15.16pm | random-sample | 30 | 31.513 | 31.585 | -1.585 |  | 0.978 | -73.9 |  |  | rejected-silent |
| 79 | s-2026-10-16-1953 | 10-16 7.54.34pm -> 7.55.04pm | random-sample | 30 | 28.556 | 30.672 | -0.672 |  | 0.869 | -78.0 |  |  | rejected-silent |
| 80 | s-2026-10-16-1953 | 10-16 8.03.37pm -> 8.04.07pm | random-sample | 30 | 31.531 | 31.696 | -1.696 |  | 0.948 | -74.1 |  |  | rejected-silent |
| 81 | s-2026-10-16-1953 | 10-16 8.08.39pm -> 8.09.09pm | random-sample | 30 | 29.104 | 31.276 | -1.276 |  | 0.836 | -70.6 |  |  | rejected-silent |
| 82 | s-2026-10-16-1953 | 10-16 8.22.43pm -> 8.23.13pm | random-sample | 30 | 31.403 | 31.540 | -1.540 | 1.396 | 0.998 | -54.9 | -0.144 | -0.007 | ok |
| 83 | s-2026-10-16-1953 | 10-16 8.30.15pm -> 8.30.45pm | random-sample | 30 | 31.389 | 29.593 | 0.407 |  | -0.033 | -67.8 |  |  | rejected-low-confidence |
| 84 | s-2026-10-16-1953 | 10-16 8.56.53pm -> 8.57.23pm | random-sample | 30 | 31.387 | 31.512 | -1.512 | 1.389 | 0.989 | -35.8 | -0.123 | 0.002 | ok |
| 85 | s-2026-10-16-1953 | 10-16 8.59.24pm -> 8.59.54pm | random-sample | 30 | 32.051 | 28.196 | 1.804 |  | 0.027 | -29.7 |  |  | rejected-low-confidence |
| 86 | s-2026-10-16-1953 | 10-16 9.00.24pm -> 9.00.54pm | random-sample | 30 | 30.342 | 30.482 | -0.482 |  | 0.435 | -61.9 |  |  | rejected-low-confidence |
| 87 | s-2026-10-16-1953 | 10-16 9.00.54pm -> 9.01.24pm | random-sample | 30 | 30.482 | 30.675 | -0.675 | 0.488 | 1.000 | -59.0 | -0.187 | 0.006 | ok |
| 88 | s-2026-10-16-1953 | 10-16 9.01.54pm -> 9.02.25pm | random-sample | 31 | 30.841 | 30.946 | 0.054 | 0.845 | 1.000 | -24.3 | 0.898 | 1.003 | ok |
| 89 | s-2026-10-17-1656 | 10-17 5.21.28pm -> 5.21.58pm | random-sample | 30 | 30.649 | 30.867 | -0.867 | 0.659 | 0.982 | -38.8 | -0.208 | 0.010 | ok |
| 90 | s-2026-10-17-1656 | 10-17 6.19.46pm -> 6.20.16pm | random-sample | 30 | 30.265 | 30.434 | -0.434 |  | 0.019 | -29.3 |  |  | rejected-low-confidence |
| 91 | s-2026-10-17-1656 | 10-17 6.30.49pm -> 6.31.19pm | random-sample | 30 | 31.479 | 31.567 | -1.567 | 1.444 | 0.910 | -27.1 | -0.123 | -0.035 | ok |
| 92 | s-2026-10-17-1656 | 10-17 6.35.20pm -> 6.35.50pm | random-sample | 30 | 30.542 | 30.691 | -0.691 | 0.547 | 0.999 | -35.0 | -0.144 | 0.004 | ok |
| 93 | s-2026-10-17-1656 | 10-17 6.36.50pm -> 6.37.20pm | random-sample | 30 | 30.938 | 29.083 | 0.917 |  | 0.073 | -62.3 |  |  | rejected-low-confidence |
| 94 | s-2026-10-17-1656 | 10-17 7.11.29pm -> 7.11.59pm | random-sample | 30 | 29.704 | 31.848 | -1.848 | 1.704 | 0.968 | -49.0 | -0.144 | 2.000 | ok |
| 95 | s-2026-10-17-1656 | 10-17 7.22.32pm -> 7.23.02pm | random-sample | 30 | 30.454 | 28.561 | 1.439 |  | 0.029 | -22.2 |  |  | rejected-low-confidence |
| 96 | s-2026-10-17-1656 | 10-17 7.27.03pm -> 7.27.33pm | random-sample | 30 | 31.571 | 29.742 | 0.258 |  | 0.045 | -37.8 |  |  | rejected-low-confidence |
| 97 | s-2026-10-17-1656 | 10-17 7.59.11pm -> 7.59.42pm | random-sample | 31 | 29.982 | 32.107 | -1.107 | 1.984 | 0.948 | -57.2 | 0.877 | 3.002 | ok |
| 98 | s-2026-10-17-1656 | 10-17 8.09.44pm -> 8.10.14pm | random-sample | 30 | 30.638 | 30.831 | -0.831 |  | 0.838 | -53.0 |  |  | rejected-low-confidence |
| 99 | s-2026-10-18-1221 | 10-18 12.34.45pm -> 12.35.15pm | random-sample | 30 | 28.365 | 30.472 | -0.472 |  | 0.182 | -32.3 |  |  | rejected-low-confidence |
| 100 | s-2026-10-18-1221 | 10-18 12.35.46pm -> 12.36.16pm | random-sample | 30 | 30.591 | 30.717 | -0.717 | 0.594 | 0.987 | -32.2 | -0.123 | 0.002 | ok |
| 101 | s-2026-10-18-1221 | 10-18 12.42.17pm -> 12.42.47pm | random-sample | 30 | 30.307 | 28.431 | 1.569 |  | 0.234 | -23.9 |  |  | rejected-low-confidence |
| 102 | s-2026-10-18-1221 | 10-18 1.01.53pm -> 1.02.23pm | random-sample | 30 | 30.666 | 30.777 | -0.777 | 0.675 | 0.982 | -25.7 | -0.101 | 0.010 | ok |
| 103 | s-2026-10-18-1221 | 10-18 3.58.09pm -> 3.58.39pm | random-sample | 30 | 30.368 | 30.511 | -0.511 |  | 0.014 | -58.5 |  |  | rejected-low-confidence |
| 104 | s-2026-10-18-1221 | 10-18 3.58.39pm -> 3.59.09pm | random-sample | 30 | 30.511 | 30.640 | -0.640 | 0.518 | 0.976 | -57.0 | -0.122 | 0.007 | ok |
| 105 | s-2026-10-18-1221 | 10-18 4.04.40pm -> 4.05.10pm | random-sample | 30 | 32.046 | 30.190 | -0.190 |  | 0.007 | -31.4 |  |  | rejected-low-confidence |
| 106 | s-2026-10-18-1221 | 10-18 4.35.18pm -> 4.35.48pm | random-sample | 30 | 31.874 | 32.006 | -2.006 | 1.884 | 0.967 | -57.6 | -0.122 | 0.010 | ok |
| 107 | s-2026-10-18-1221 | 10-18 5.06.56pm -> 5.07.26pm | random-sample | 30 | 32.072 | 30.195 | -0.195 |  | 0.094 | -69.1 |  |  | rejected-low-confidence |
| 108 | s-2026-10-18-1221 | 10-18 6.36.50pm -> 6.37.20pm | random-sample | 30 | 29.345 | 31.444 | -1.444 | 1.343 | 0.983 | -25.4 | -0.101 | 1.998 | ok |
| 109 | s-2026-10-20-1214 | 10-20 12.40.46pm -> 12.41.17pm | random-sample | 31 | 29.079 | 31.176 | -0.176 |  | 0.912 | -71.0 |  |  | rejected-silent |
| 110 | s-2026-10-20-1214 | 10-20 1.06.53pm -> 1.07.24pm | random-sample | 31 | 28.191 | 28.287 | 2.713 |  | 0.051 | -69.3 |  |  | rejected-low-confidence |
| 111 | s-2026-10-20-1214 | 10-20 1.21.27pm -> 1.21.58pm | random-sample | 31 | 28.186 | 30.284 | 0.716 |  | 0.144 | -73.7 |  |  | rejected-silent |
| 112 | s-2026-10-20-1214 | 10-20 1.33.31pm -> 1.34.01pm | random-sample | 30 | 28.981 | 29.096 | 0.904 |  | 0.027 | -73.6 |  |  | rejected-silent |
| 113 | s-2026-10-20-1214 | 10-20 1.51.35pm -> 1.52.06pm | random-sample | 31 | 31.725 | 31.851 | -0.851 |  | 0.844 | -70.7 |  |  | rejected-silent |
| 114 | s-2026-10-20-1214 | 10-20 1.53.06pm -> 1.53.36pm | random-sample | 30 | 30.095 | 28.221 | 1.779 |  | 0.023 | -60.3 |  |  | rejected-low-confidence |
| 115 | s-2026-10-20-1214 | 10-20 2.11.40pm -> 2.12.11pm | random-sample | 31 | 30.580 | 30.706 | 0.294 | 0.583 | 0.986 | -66.9 | 0.877 | 1.003 | ok |
| 116 | s-2026-10-20-1214 | 10-20 3.45.05pm -> 3.45.35pm | random-sample | 30 | 31.227 | 31.351 | -1.351 | 1.229 | 0.918 | -70.0 | -0.122 | 0.002 | ok |
| 117 | s-2026-10-20-1214 | 10-20 5.22.31pm -> 5.23.02pm | random-sample | 31 | 31.922 | 30.108 | 0.892 |  | 0.260 | -36.0 |  |  | rejected-low-confidence |
| 118 | s-2026-10-20-1214 | 10-20 7.10.31pm -> 7.11.01pm | random-sample | 30 | 30.581 | 30.693 | -0.693 | 0.570 | 0.999 | -35.9 | -0.124 | -0.011 | ok |
| 119 | s-2026-10-21-1916 | 10-21 7.21.13pm -> 7.21.43pm | random-sample | 30 | 30.606 | 28.734 | 1.266 |  | 0.852 | -58.1 |  |  | rejected-low-confidence |
| 120 | s-2026-10-21-1916 | 10-21 7.24.43pm -> 7.25.14pm | random-sample | 31 | 31.442 | 29.631 | 1.369 |  | 0.055 | -28.1 |  |  | rejected-low-confidence |
| 121 | s-2026-10-21-1916 | 10-21 7.38.17pm -> 7.38.47pm | random-sample | 30 | 30.966 | 31.087 | -1.087 |  | 0.501 | -61.5 |  |  | rejected-low-confidence |
| 122 | s-2026-10-21-1916 | 10-21 7.54.51pm -> 7.55.21pm | random-sample | 30 | 31.377 | 31.492 | -1.492 | 1.369 | 0.996 | -28.4 | -0.122 | -0.007 | ok |
| 123 | s-2026-10-21-1916 | 10-21 8.00.23pm -> 8.00.53pm | random-sample | 30 | 30.755 | 30.882 | -0.882 | 0.759 | 0.983 | -40.6 | -0.123 | 0.004 | ok |
| 124 | s-2026-10-21-1916 | 10-21 8.02.53pm -> 8.03.24pm | random-sample | 31 | 29.395 | 29.526 | 1.474 |  | 0.046 | -37.2 |  |  | rejected-low-confidence |
| 125 | s-2026-10-21-1916 | 10-21 8.16.57pm -> 8.17.27pm | random-sample | 30 | 31.029 | 31.149 | -1.149 | 1.027 | 0.999 | -26.2 | -0.122 | -0.002 | ok |
| 126 | s-2026-10-21-1916 | 10-21 8.17.57pm -> 8.18.27pm | random-sample | 30 | 29.257 | 31.425 | -1.425 | 1.260 | 0.999 | -52.3 | -0.165 | 2.003 | ok |
| 127 | s-2026-10-21-1916 | 10-21 8.31.31pm -> 8.32.01pm | random-sample | 30 | 30.807 | 30.957 | -0.957 | 0.813 | 1.000 | -40.3 | -0.144 | 0.006 | ok |
| 128 | s-2026-10-21-1916 | 10-21 8.44.34pm -> 8.45.04pm | random-sample | 30 | 30.239 | 28.372 | 1.628 |  | 0.087 | -72.0 |  |  | rejected-silent |
| 129 | s-2026-10-22-2002 | 10-22 8.07.37pm -> 8.08.07pm | random-sample | 30 | 32.054 | 30.223 | -0.223 |  | 0.225 | -71.2 |  |  | rejected-silent |
| 130 | s-2026-10-22-2002 | 10-22 8.21.11pm -> 8.21.41pm | random-sample | 30 | 29.648 | 31.749 | -1.749 | 1.627 | 1.000 | -58.1 | -0.122 | 1.979 | ok |
| 131 | s-2026-10-22-2002 | 10-22 8.34.14pm -> 8.34.44pm | random-sample | 30 | 31.042 | 29.163 | 0.837 |  | 0.025 | -66.6 |  |  | rejected-low-confidence |
| 132 | s-2026-10-22-2002 | 10-22 8.39.46pm -> 8.40.16pm | random-sample | 30 | 28.513 | 30.649 | -0.649 | 0.483 | 1.000 | -44.5 | -0.165 | 1.971 | ok |
| 133 | s-2026-10-22-2002 | 10-22 8.44.47pm -> 8.45.17pm | random-sample | 30 | 31.833 | 29.953 | 0.047 |  | -0.004 | -71.3 |  |  | rejected-silent |
| 134 | s-2026-10-22-2002 | 10-22 8.48.18pm -> 8.48.48pm | random-sample | 30 | 30.826 | 30.987 | -0.987 |  | 0.976 | -74.4 |  |  | rejected-silent |
| 135 | s-2026-10-22-2002 | 10-22 8.51.19pm -> 8.51.49pm | random-sample | 30 | 31.594 | 31.698 | -1.698 | 1.597 | 0.999 | -25.0 | -0.101 | 0.003 | ok |
| 136 | s-2026-10-22-2002 | 10-22 8.52.19pm -> 8.52.49pm | random-sample | 30 | 31.800 | 31.962 | -1.962 | 1.797 | 0.938 | -37.8 | -0.166 | -0.004 | ok |
| 137 | s-2026-10-22-2002 | 10-22 8.58.51pm -> 8.59.21pm | random-sample | 30 | 30.876 | 31.004 | -1.004 | 0.881 | 0.998 | -36.8 | -0.122 | 0.006 | ok |
| 138 | s-2026-10-22-2002 | 10-22 9.08.53pm -> 9.09.23pm | random-sample | 30 | 29.259 | 29.330 | 0.670 |  | 0.436 | -42.5 |  |  | rejected-low-confidence |
| 139 | s-2026-09-27-1753 | 09-27 6.23.07pm -> 6.25.29pm | special | 142 | 31.920 | 30.767 | 111.233 |  | 0.144 | -76.8 |  |  | rejected-silent |
| 140 | s-2026-09-28-1829 | 09-28 9.11.31pm -> 9.12.36pm | special | 65 | 30.905 | 29.804 | 35.196 |  | 0.021 | -74.1 |  |  | rejected-silent |
| 141 | s-2026-09-28-1829 | 09-28 11.00.39pm -> 11.01.00pm | special | 21 | 31.220 | 28.488 | -7.488 |  | 0.983 | -70.2 |  |  | rejected-silent |
| 142 | s-2026-09-28-1829 | 09-28 11.01.00pm -> 11.01.09pm | special | 9 | 28.488 | 31.369 | -22.369 | 22.494 | 0.990 | -56.0 | 0.125 | 3.006 | ok |
| 143 | s-2026-09-29-2001 | 09-29 9.02.26pm -> 9.03.27pm | special | 61 | 29.506 | 10.634 | 50.366 |  | 0.073 | -67.4 |  |  | rejected-low-confidence |
| 144 | s-2026-09-30-1743 | 09-30 5.43.49pm -> 5.44.20pm | special | 31 | 28.354 | 30.510 | 0.490 |  | 0.060 | -43.5 |  |  | rejected-low-confidence |
| 145 | s-2026-10-17-1656 | 10-17 4.56.56pm -> 4.57.21pm | special | 25 | 30.354 | 31.131 | -6.131 | 6.363 | 0.978 | -48.8 | 0.232 | 1.009 | ok |
| 146 | s-2026-10-18-1221 | 10-18 1.16.26pm -> 1.17.27pm | special | 61 | 30.604 | 30.821 | 30.179 |  | 0.032 | -35.4 |  |  | rejected-low-confidence |


### Result: every boundary of the two labelled sessions (1,623)

| Session | boundaries | ok | rejected-silent | rejected-low-confidence |
|---|---|---|---|---|
| s-2026-10-20-1214 | 863 | 255 | 381 | 227 |
| s-2026-10-18-1221 | 760 | 390 | 89 | 281 |

| Subset | n | END within ±1.1 s | START within ±1.1 s |
|---|---|---|---|
| all measured | 645 | **642 (99.5 %)** | 447 (69.3 %) |
| discriminating | 199 | **196 (98.5 %)** | 1 (0.5 %) |

**Verdict (full sessions): END fits; START does not fit.**

- END residual bins: −0.7: 1, −0.2: 120, −0.1: 441, +0.8: 20, +0.9: 60, +2.1: 1, +4.2: 2.
- Start-to-start: 30.0 s 442, 28.0 s 181, and a few between 27.7 and 30.5 s.
- Low-confidence rejections: there are 508. Under END, 38 of them should share ≥ 0.5 s of audio; under START, 245 should.
- After the sample pairs were merged in, `boundaries.json` holds 1,748 boundaries: 706 ok, END 703/706 within limit and START 491/706.

**4 measured matches do not agree with the name times.** They are probably matches of repeated identical game audio (for example the same sound effect twice), not the true overlap (UNVERIFIED). All 4 have a start-to-start spacing that is not near 28.0 or 30.0 s.

| A -> B (10-18) | measured overlap | r | END residual | start-to-start |
|---|---|---|---|---|
| 1.08.54pm -> 1.09.24pm | 2.708 | 0.999 | +4.176 | 27.726 |
| 2.33.47pm -> 2.34.17pm | 3.109 | 0.914 | +4.155 | 27.722 |
| 3.03.54pm -> 3.04.24pm | 0.610 | 0.938 | +2.084 | 29.765 |
| 3.15.27pm -> 3.15.57pm | 0.830 | 0.979 | −0.695 | 30.546 |

`session_index.py` therefore uses a measured trim only when its residual under the active `--name-time` lies in [−0.30, +1.00] s (`NAME_RESIDUAL_RANGE`). The range comes from this data: 641 of 645 in −0.23 .. +0.92. All 4 boundaries above fall back to the name-time trim and are listed in `index.json` → `measuredTrimsNotUsed`.

### Applied to the index

```
python -I services/clip/session_index.py --corpus "<clips-corpus>" \
  --out "C:\AI\Claude\_data\Ujwalam\index" --sessions-file data/sessions.json \
  --boundaries "C:\AI\Claude\_data\Ujwalam\index\boundaries.json"
```

Output (excerpt): `files 5923, probed 5923 (cacheHits 5923, probed 0, failed 0), sessions 18, boundaries 5905, boundariesMeasured 702, nameTime end, gapThresholdSec 120.0, sessionAnomalies 22, totalTrimmedHours 49.096`.

- Each clip now has `trimMethod`: `measured` (702 boundaries) or `name-time` (the rest, from the name times under END). No 30 s assumption is used anywhere.
- s-2026-10-20-1214: 255 of 863 trims measured. s-2026-10-18-1221: 386 of 760 measured (390 ok − 4 not used).
- Measured trim minus the name-time trim at the same boundary: median −0.123 s, 5th percentile −0.186, 95th +0.856. This is the error of a name-time trim where no measurement exists.
- `data/sessions.json` was rewritten by this run, and its contents did not change (`diff` with the copy taken before: no differences). Boundaries depend only on the gap rule.

### Special pairs

| Pair | Name-time gap under END | Result |
|---|---|---|
| 09-30 5.43.49pm -> 5.44.20pm | +0.490 s (gap) | low-confidence (r 0.060 at −43.5 dBFS): no shared audio, consistent with a gap |
| 09-28 11.00.39pm -> 11.01.00pm | −7.488 (overlap) | r 0.983 at the predicted overlap, but the audio is −70.2 dBFS, so rejected as silent |
| 09-28 11.01.00pm -> 11.01.09pm | −22.369 (overlap) | **measured 22.494 s**, r 0.990; END residual +0.125, START +3.006 |
| 10-17 4.56.56pm -> 4.57.21pm | −6.131 | **measured 6.363 s**, r 0.978; END +0.232, START +1.009 |
| 09-28 9.11.31pm -> 9.12.36pm (missing-clip candidate) | +35.196 | silent (−74.1 dBFS); no shared audio expected |
| 09-29 9.02.26pm -> 9.03.27pm (missing-clip candidate) | +50.366 | low-confidence (r 0.073); no shared audio |
| 10-18 1.16.26pm -> 1.17.27pm (missing-clip candidate) | +30.179 | low-confidence (r 0.032) with loud audio (−35.4 dBFS): no shared audio, consistent with one missing clip |
| 09-27 6.23.07pm -> 6.25.29pm | +111.233 | silent (−76.8 dBFS); see below |

Short-first boundaries: 8 sampled.
- Measured (3):
  - 09-25 6.52.46pm: A 24.5 s, overlap 0.538. END residual −0.145; START +6.007.
  - 09-28 6.30.17pm: A 23.3 s, overlap 1.166. END −0.187; START +7.903.
  - 10-21 7.17.12pm: A 15.7 s, overlap 1.577. END −0.123; START +15.918.
- Rejected (5): 2 silent and 3 low-confidence. Name-time END predicts gaps of 1.2–1.7 s for the 3 low-confidence ones.

### 27 Sep 18:23 -> 18:25: continuous audio or a cut?

**Not decidable from the audio. UNVERIFIED; the user should say whether this was one stream or two.**
- Under END, 6.23.07pm covers 18:22:35–18:23:07 and 6.25.29pm covers 18:24:58–18:25:29. Between them is 111.2 s with no clip, so the two clips share no audio and cross-correlation cannot test continuity. The audio at the joint is near-silent (−76.8 dBFS).
- Side facts, neither of which decides it:
  - B is full length (30.767 s). After a fresh start the first clip is often short, but 10 of the 18 session-first clips are also full length, so this does not discriminate.
  - The duration sawtooth (31.34, 31.47, 31.65, 31.80, 31.92, then 30.77) also resets mid-session elsewhere, e.g. 10-20 12.17.40pm.
- The A2 finding still stands: under the rule it stays inside `s-2026-09-27-1753`. It would split only under a threshold below 111 s, or through a manual entry in `data/sessions.json`, for example:
  - `{"id": "s-2026-09-27-1753", "source": "manual", "firstClip": "...5.54.29pm.mp4", "lastClip": "...6.23.07pm.mp4"}` plus a second entry from 6.25.29pm.

## 3. Analysis cache (lean option)

Location: `C:\AI\Claude\_data\Ujwalam\cache\<session id>\`. Built only for `s-2026-10-20-1214` and `s-2026-10-18-1221`. No other session has a cache.

Per session (`services/clip/build_cache.py`, TOOL_VERSION 1):
- `concat.ffconcat`: concat-demuxer list of the original clips with an `inpoint` per trimmed clip. The trims come from `index.json` (measured where available, name-time under END elsewhere).
- `audio-16k-mono.flac`: 16 kHz mono FLAC of the trimmed virtual concatenation.
- `proxy-540x960-30p.mp4`: 540x960 30 fps H.264 (`h264_nvenc` p5, VBR 1 Mbps, max 1.5 Mbps, GOP 60) plus AAC 64 kbps. Video decode on CPU.
- `manifest.json`: one segment per clip (`clip`, `clipInSec`, `clipOutSec`, `sessionStartSec`, `durationSec`, `trimMethod`, `wallStartUtc`). Cache time t in segment k maps to clip time `clipInSec + (t − sessionStartSec)`. FLAC and proxy share this one timeline. Gaps between clips are not in the cache; `wallStartUtc` gives wall-clock time. It also holds the ffprobe checks and the spot-check (`verify`).
- `build-state.json`: a key per output (SHA-256 of the tool version, the concat list and the ffmpeg command). A rerun skips an output whose key and byte size match; `--force` rebuilds.
- Crops are not cached. They are cut on the fly from the originals through the manifest.

### Recovery of the interrupted 18 Oct build

The previous run was stopped after the 18 Oct proxy was finished, before `manifest.json` was written. Found: audio 706,881,275 B and proxy 3,075,059,773 B present, `build-state.json` written at 05:36:32 with both keys, no manifest, a 0-byte stdout report.
- Both ffmpeg logs end with a final summary line at the full session length: `audio.log` `size= 690314KiB time=06:18:30.29`, `proxy.log` `frame=681306 ... Lsize= 3002988KiB time=06:18:30.29`.
- A dry run against the current `index.json` reported all four outputs `up to date` (keys and sizes match), so nothing was re-encoded.
- The finalising run (below) probed both files: their durations match the manifest's expected span within 3.4 ms (audio) and 96 ms (video, last frame). See the table.

Fix made during recovery: `--dry-run` used to rewrite `manifest.json` without the `outputs` checks. It now keeps the `outputs` and `verify` of the last real build (test `DryRunTests`).

### Command (finalise; also the rebuild command)

```
python -I services/clip/build_cache.py --index C:/AI/Claude/_data/Ujwalam/index/index.json \
  --corpus "<clips-corpus>" --cache C:/AI/Claude/_data/Ujwalam/cache \
  --session s-2026-10-20-1214 --session s-2026-10-18-1221 --verify 12 \
  > C:/AI/Claude/_data/Ujwalam/cache/build-report.json 2> C:/AI/Claude/_data/Ujwalam/cache/build-report.log
```

Output: exit 0 in 2 min 22 s (spot-check only). `build-report.log`:

```
s-2026-10-20-1214: audio-16k-mono.flac up to date
s-2026-10-20-1214: proxy-540x960-30p.mp4 up to date
s-2026-10-18-1221: audio-16k-mono.flac up to date
s-2026-10-18-1221: proxy-540x960-30p.mp4 up to date
```

**Full rebuild from nothing** (index first, then cache; add `--force` to the second command to re-encode over an existing cache):

```
python -I services/clip/session_index.py --corpus "<clips-corpus>" \
  --out "C:\AI\Claude\_data\Ujwalam\index" --sessions-file data/sessions.json \
  --boundaries "C:\AI\Claude\_data\Ujwalam\index\boundaries.json"
python -I services/clip/build_cache.py --index C:/AI/Claude/_data/Ujwalam/index/index.json \
  --corpus "<clips-corpus>" --cache C:/AI/Claude/_data/Ujwalam/cache \
  --session s-2026-10-20-1214 --session s-2026-10-18-1221 --verify 12
```

`boundaries.json` comes from the `boundary_xcorr.py` commands in section 2. `--video-encoder auto` (default) picks `h264_nvenc` when ffmpeg lists it, else `libx264`.

Build times (from `build-state.json`, NVENC, CPU decode): 20 Oct audio 192.2 s, proxy 1,886.9 s; 18 Oct audio 137.9 s, proxy 1,938.9 s.

### Result: durations (ffprobe vs manifest)

| Session | clips | trims measured / name-time | expected (manifest) | FLAC | proxy video | proxy audio |
|---|---|---|---|---|---|---|
| s-2026-10-20-1214 | 864 | 255 / 608 | 25,784.783 s (7 h 09 m 45 s) | 25,784.779 (−0.0039) | 25,784.700 (−0.0826), start 0.0333 | 25,784.779 (−0.0039) |
| s-2026-10-18-1221 | 761 | 386 / 374 | 22,710.296 s (6 h 18 m 30 s) | 22,710.293 (−0.0034) | 22,710.200 (−0.0963), start 0.0333 | 22,710.293 (−0.0034) |

FLAC: flac, 16000 Hz, 1 ch. Proxy: h264 540x960 30/1, aac 48000 Hz 2 ch.

### Result: spot-check (`--verify 12`, seed 1)

At 12 random cache times per session, the cache was cross-correlated with the original clip at the time the manifest maps it to. Lag 0 means the mapping is exact. Video lag is measured at 30 fps, so its resolution is one frame (33.3 ms).

| Session | FLAC lag (ms) | FLAC r | proxy audio lag (ms) | video lag (ms) | proxy A/V offset (ms) |
|---|---|---|---|---|---|
| s-2026-10-20-1214 | −8.25 .. +1.75 | 0.81 .. 1.00 | −8.25 .. +1.75 | 0 (5), −33.3 (7) | −33.4 .. +8.2 |
| s-2026-10-18-1221 | −12.25 .. +1.50 | 0.94 .. 1.00 | −12.25 .. +1.50 | 0 (10), +33.3 (2) | −1.5 .. +41.3 |

Every point maps to the right place within 12.25 ms (audio) and one frame (video). Video r is 0.54–0.86 at 9 of the 24 points (little motion), where the luma match is weaker; their lags are still 0 or ±1 frame.

### Size and disk

| Session | FLAC | proxy | session folder total |
|---|---|---|---|
| s-2026-10-20-1214 | 767,713,107 B | 3,493,904,217 B | 4,262,432,496 B (3.97 GiB) |
| s-2026-10-18-1221 | 706,881,275 B | 3,075,059,773 B | 3,782,718,629 B (3.52 GiB) |

The whole cache folder holds 8,045,173,167 B (7.49 GiB), including manifests, lists, logs and reports. Free space on C: after the build: 424,034,037,760 B (394.9 GiB).

Two stale stdout files from the interrupted run are still in the cache root and were not deleted: `s-2026-10-18-1221.report.json` (0 bytes) and `s-2026-10-20-1214.report.json`. `build-report.json` supersedes both. They can be removed with the user's approval.

## Tests

```
npm run test:py   ->  Ran 38 tests in 2.445s  OK
npm test          ->  tests 95, pass 95, fail 0 (includes tests/sessions-schema.test.mjs)
```

## UNVERIFIED / open

- Name time = clip END is now a measured result (sections 2 and "full sessions"), not an assumption. What Meld does internally is still UNVERIFIED: the inference that it saves a clip every ≈ 30.12 s, each starting on a keyframe, comes only from the spacing data.
- The 4 measured matches that disagree with the name times are probably repeated identical game audio (UNVERIFIED). They are excluded from the trims.
- 27 Sep 18:23 → 18:25: one stream or two is not decidable from the audio. The user should say. It stays one session under the 120 s rule.
- 608 of 863 trims (70 %) on 20 Oct and 374 of 760 (49 %) on 18 Oct are name-time trims, not measured (silence or low confidence). Their expected error is −0.19 .. +0.86 s (5th–95th percentile, section 2).

## Files created or changed

- `services/clip/session_index.py`, `services/clip/boundary_xcorr.py`, `services/clip/build_cache.py`
- `data/sessions.json`, `data/sessions.schema.json`
- `tests/py/test_session_index.py`, `tests/py/test_boundaries_cache.py`, `tests/sessions-schema.test.mjs`
- `package.json` (scripts)
- `docs/evidence/2026-10-27-p2a-a2b-boundaries-cache.md` (this file), `docs/evidence/2026-10-27-p2a-a2-session-index.md` (pointer)
- Outside the repo: `C:\AI\Claude\_data\Ujwalam\index\` (index, boundaries) and `C:\AI\Claude\_data\Ujwalam\cache\` (two sessions).
