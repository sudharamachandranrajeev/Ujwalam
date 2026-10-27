# 2026-10-27 — P2a A2: clip corpus session index and analysis-cache estimate

> Superseded in part by `docs/evidence/2026-10-27-p2a-a2b-boundaries-cache.md`. The name-time question is settled there: the name is the clip END, measured from audio. `--name-time` now defaults to `end`, the index was regenerated and `data/sessions.json` was added.

Read only. The corpus folder `<clips-corpus>` was only listed and probed with ffprobe. Nothing in it was written, moved, renamed, re-encoded or deleted. Nothing was installed or downloaded. No chat logs or engage logs were opened.

Requirements: `docs/plan/2026-10-26-open-question-answers.md` §2.

## Tool

- `services/clip/session_index.py`: Python 3.14 stdlib only, run with `python -I`. The corpus folder and the output folder are CLI arguments; the tool refuses an output folder inside the corpus folder.
- ffprobe runs on 4 threads. Results are cached in `<out>/probe-cache.json`, keyed by filename + size + mtime (ns). A rerun probes only new or changed files. Failed probes are not cached, so they are retried.
- Sessions: clips are sorted by start time. A gap **greater than** 120 s between the previous clip's end (start + duration) and the next clip's start begins a new session (exactly 120 s stays in the session). Per clip: `file, startLocal, startUtc, duration, gapBeforeSec, trimInSec, sessionOffsetSec, wallOffsetSec`. `trimInSec` skips the overlap with the previous clip. `sessionOffsetSec` is the clip's in-point on the virtual concatenation (gaps are dropped). `wallOffsetSec` is its wall-clock position from the session start.
- Anomalies: unparseable names, probe failures, format different from the majority (nominal fps, because `avg_frame_rate` varies in the last digits, e.g. 60.002), duration more than 3 s from the corpus median, fully overlapped clips, duplicate start times, and local times outside the UTC-offset window.
- Output (outside the repo): `C:\AI\Claude\_data\Ujwalam\index\index.json`, `sessions.md`, `probe-cache.json`.

### Timezone assumption

Filename timestamps are local wall-clock time. The whole corpus is before 25 Oct 2026, so it is all BST (UTC+01:00). Both local time and UTC are stored. The tool checks that every local time lies in the window `2026-03-29T02:00` to `2026-10-25T01:00`. All 5,923 clips do (0 `outsideUtcOffsetWindow` anomalies).

## Commands and real output

```
> npm run test:py   (see Tests below)

> python -I services/clip/session_index.py --corpus "<clips-corpus>" --out "C:\AI\Claude\_data\Ujwalam\index"
probed 250/5923 ... probed 5750/5923
{ "probeRun": { "cacheHits": 0, "probed": 5923, "probeFailed": 0 },
  "files": 5923, "parsed": 5923, "probed": 5923, "sessions": 18,
  "totalTrimmedHours": 49.089, "corpusAnomalies": 0, "sessionAnomalies": 22 }
elapsed: 00:02:54
```

Incremental rerun (same command):

```
{ "probeRun": { "cacheHits": 5923, "probed": 0, "probeFailed": 0 }, ... "sessions": 18, "totalTrimmedHours": 49.089 }
```

Corpus unchanged (PowerShell, before and after both runs):

```
dir mtime before: 2026-10-22T21:18:55.9610961+01:00
dir mtime after:  2026-10-22T21:18:55.9610961+01:00
5923 files, 173586214642 bytes
```

## Summary

| Item | Value |
|---|---|
| Files | 5,923 (all `.mp4`), 173,586,214,642 bytes (161.7 GiB) |
| Parsed names | 5,923 (0 unparseable) |
| Probed | 5,923 (0 failures) |
| Sessions | **18** |
| Trimmed media (virtual concatenation) | 176,719.3 s = **49.09 h** |
| Wall time (sum of session spans) | 178,670.7 s = 49.63 h |
| Untrimmed media (sum of clip durations) | 181,196.9 s = 50.33 h |
| Clip duration | median 30.779 s, min 10.634 s, max 32.133 s |
| Format | 5,910 × 1080×1920 60 fps H.264 / AAC 48 kHz 2 ch, 1 audio track; 9 × 59 fps, 3 × 58 fps, 1 × 57 fps (same otherwise) |
| Boundaries (5,905) | 4,228 overlaps, 1,676 gaps, 1 exact; min −19.488 s, max +110.080 s, median −0.646 s; 1st–99th percentile −2.091 to +2.430 s |
| Start-to-start spacing | 30 s: 5,087; 31 s: 811; 61 s: 2; others (9, 21, 25, 65, 142 s): 1 each |
| Distinct dates | 17 |

## Sessions (`sessions.md`, filename time = clip start)

Gap columns: seconds from the previous clip's end to the next clip's start (negative = overlap). Counts are overlaps / gaps / exact.

| Session | Start (local) | End (local) | Wall | Clips | Trimmed media | Overlap/gap/exact | Min | Max | Anomalies |
|---|---|---|---|---:|---|---|---:|---:|---:|
| s-2026-09-24-1831 | 2026-09-24 18:31:17 | 2026-09-24 19:42:35 | 1:11:19 | 142 | 1:10:45 | 107/34/0 | -2.099 | 2.445 | 0 |
| s-2026-09-25-1852 | 2026-09-25 18:52:46 | 2026-09-25 20:54:48 | 2:02:02 | 243 | 2:00:52 | 180/62/0 | -2.108 | 5.469 | 1 |
| s-2026-09-26-1554 | 2026-09-26 15:54:33 | 2026-09-26 19:56:10 | 4:01:38 | 481 | 3:59:36 | 362/118/0 | -2.120 | 2.860 | 0 |
| s-2026-09-27-1052 | 2026-09-27 10:52:04 | 2026-09-27 16:33:11 | 5:41:08 | 679 | 5:38:16 | 489/188/1 | -2.121 | 2.502 | 3 |
| s-2026-09-27-1754 | 2026-09-27 17:54:29 | 2026-09-27 19:57:59 | 2:03:30 | 242 | 2:00:33 | 171/70/0 | -2.121 | 110.080 | 0 |
| s-2026-09-28-1830 | 2026-09-28 18:30:17 | 2026-09-28 23:56:26 | 5:26:09 | 649 | 5:22:22 | 456/192/0 | -19.488 | 34.095 | 9 |
| s-2026-09-29-2002 | 2026-09-29 20:02:08 | 2026-09-29 21:03:37 | 1:01:30 | 122 | 1:00:04 | 79/42/0 | -2.116 | 31.494 | 2 |
| s-2026-09-30-1743 | 2026-09-30 17:43:49 | 2026-09-30 19:30:53 | 1:47:04 | 213 | 1:46:12 | 156/56/0 | -2.112 | 2.646 | 0 |
| s-2026-10-01-1944 | 2026-10-01 19:44:16 | 2026-10-01 20:34:01 | 0:49:46 | 99 | 0:48:59 | 71/27/0 | -2.083 | 16.360 | 1 |
| s-2026-10-13-2000 | 2026-10-13 20:00:32 | 2026-10-13 21:03:18 | 1:02:46 | 125 | 1:02:00 | 87/37/0 | -2.111 | 11.461 | 2 |
| s-2026-10-14-1950 | 2026-10-14 19:50:30 | 2026-10-14 21:19:53 | 1:29:23 | 178 | 1:28:24 | 115/62/0 | -2.101 | 2.143 | 0 |
| s-2026-10-15-2015 | 2026-10-15 20:15:01 | 2026-10-15 21:22:17 | 1:07:16 | 134 | 1:06:40 | 95/38/0 | -2.114 | 2.536 | 0 |
| s-2026-10-16-1954 | 2026-10-16 19:54:04 | 2026-10-16 21:38:04 | 1:44:01 | 207 | 1:42:43 | 139/67/0 | -2.096 | 11.449 | 1 |
| s-2026-10-17-1656 | 2026-10-17 16:56:56 | 2026-10-17 20:45:54 | 3:48:59 | 456 | 3:47:09 | 346/109/0 | -5.354 | 2.096 | 0 |
| s-2026-10-18-1221 | 2026-10-18 12:21:41 | 2026-10-18 18:44:22 | 6:22:41 | 761 | 6:18:19 | 535/225/0 | -2.117 | 30.396 | 0 |
| s-2026-10-20-1215 | 2026-10-20 12:15:10 | 2026-10-20 19:29:07 | 7:13:57 | 864 | 7:09:43 | 612/251/0 | -2.133 | 2.814 | 1 |
| s-2026-10-21-1917 | 2026-10-21 19:17:12 | 2026-10-21 20:45:32 | 1:28:20 | 176 | 1:27:28 | 133/42/0 | -2.099 | 14.342 | 1 |
| s-2026-10-22-2003 | 2026-10-22 20:03:05 | 2026-10-22 21:19:26 | 1:16:22 | 152 | 1:15:14 | 95/56/0 | -2.130 | 14.646 | 1 |

### Anomalies (22, all inside sessions; 0 corpus-level)

- **Short clips (9 duration outliers).** 8 are the **first** clip of a session: 09-25 6.52.46pm (24.531 s), 09-28 6.30.17pm (23.262 s), 09-29 8.02.08pm (14.559 s), 10-01 7.44.16pm (14.640 s), 10-13 8.00.32pm (18.539 s), 10-16 7.54.04pm (18.551 s), 10-21 7.17.12pm (15.658 s), 10-22 8.03.05pm (15.354 s). One is the **last** clip of a session: 09-29 9.03.27pm (10.634 s).
- **Low frame rate (13 format anomalies).** Nominal 57–59 fps instead of 60: 09-27 3.26.23pm, 3.27.54pm, 3.28.24pm; 09-28 11.41.51pm to 11.55.56pm (8 clips); 10-13 9.00.48pm; 10-20 4.58.25pm. Same resolution and codecs. Likely dropped frames (UNVERIFIED).
- **Irregular boundaries** (not flagged as anomalies, listed for review): 09-27 6.23.07pm → 6.25.29pm, gap 110.08 s (start-to-start 142 s); 09-28 9.11.31pm → 9.12.36pm, gap 34.10 s; 09-28 11.00.39pm → 11.01.00pm → 11.01.09pm, overlaps 10.22 s and 19.49 s (start-to-start 21 s and 9 s); 09-29 9.02.26pm → 9.03.27pm, gap 31.49 s; 10-17 4.56.56pm → 4.57.21pm, overlap 5.35 s; 10-18 1.16.26pm → 1.17.27pm, gap 30.40 s (one clip likely missing).

## Comparison with the user's inventory

| Item | Inventory (26 Oct) | Index | Match |
|---|---|---|---|
| Files | 5,923 | 5,923 | yes |
| Size | 161.7 GB | 173,586,214,642 bytes = 161.7 GiB | yes (inventory's "GB" is GiB) |
| All names parse | yes | 5,923 / 5,923 | yes |
| Format | 1080×1920, 60 fps, H.264, AAC stereo 48 kHz, 1 track | yes; 13 clips at 57–59 fps | mostly |
| Coverage | 24 Sep – 22 Oct, 17 days | 24 Sep – 22 Oct, 17 dates | yes |
| Sessions | **19** | **18** | **no** |
| Shortest session | 29 min | 49 min 46 s (01 Oct) | **no** |
| Longest session | 7 h 13 min | 7 h 13 min 57 s (20 Oct) | yes |
| 20 Oct / 18 Oct / 17 Oct | 7 h 13 min / 6 h 22 min / 3 h 48 min | 7:13:57 / 6:22:41 / 3:48:59 wall | yes |
| Total | about 49 h | 49.09 h trimmed, 49.63 h wall | yes |

**The 19 vs 18 difference** is one boundary: 09-27 6.23.07pm → 6.25.29pm. The end-to-start gap is 110.08 s, so under the agreed rule (gap > 120 s) it stays in one session. The start-to-start spacing is 142 s, so a rule on start-to-start time (> 120 s) would split it. That split gives a first part of 17:54:29 to about 18:23:39 = **about 29 min**, which matches the inventory's shortest session. So the inventory probably used a start-to-start rule (UNVERIFIED). The data was not changed. Choosing the rule is the user's decision: keep 18 (current rule) or split here (19).

## Finding: the filename time is probably the clip's END (save) time — UNVERIFIED

The brief treats the filename time as the clip start. Two pieces of evidence suggest it is the moment the clip was saved, i.e. the clip end:

1. **File mtime minus filename time:** min 0.092 s, median 0.652 s, max 49.412 s. If the name were the start, mtime would be about +30 s (the file is finished after its last frame).
2. **Short first clips.** With name = start, the 8 short first clips leave gaps of 5.5–16.4 s before the next clip. With name = end, those gaps disappear.

The tool has a `--name-time start|end` option (default `start`, as briefed). A comparison run with `--name-time end` (output `C:\AI\Claude\_data\Ujwalam\index\name-as-end\`, probe cache copied, 5,923 cache hits):

| Measure | name = start | name = end |
|---|---|---|
| Sessions | 18 | 18 |
| Boundaries with \|gap\| > 3 s | 15 | 7 |
| Min / max gap | −19.488 / +110.080 s | −22.369 / +111.233 s |
| Total trimmed media | 176,719.3 s | 176,736.2 s |
| Session ids | e.g. s-2026-10-20-1215 | e.g. s-2026-10-20-1214 (start moves back by one clip duration) |

Under name = end, starts shift about 30 s earlier. This matters for chat alignment (P2 §2.3). It should be confirmed on footage, for example with a visible on-screen clock or a chat event that has a known time. Until then `index.json` uses the briefed default (`start`).

## Analysis-cache estimate (calculation only; nothing generated)

Durations: real trimmed media from the index (name = start). All sizes in decimal GB (10^9 bytes).

| Scope | Trimmed seconds | Hours |
|---|---:|---:|
| All 18 sessions | 176,719.3 | 49.09 |
| 20 Oct (s-2026-10-20-1215) | 25,782.5 | 7.16 |
| 18 Oct (s-2026-10-18-1221) | 22,698.9 | 6.31 |
| 17 Oct (s-2026-10-17-1656), example third only | 13,628.6 | 3.79 |

The third labelled session is TBD (it must have an engage log; 17 Oct has none). 17 Oct is shown only as an example of a mid-length session; for any other session, multiply its trimmed hours from the table above by the MB/h rates.

### Assumptions

- **a) Audio for STT:** 16 kHz mono 16-bit PCM = 32,000 B/s = 115.2 MB/h. FLAC is **estimated** at 50–60 % of PCM (not measured).
- **b) Proxy:** 540×960 H.264 30 fps at 1 Mbps video = 450 MB/h; optional AAC 64 kbps audio = 28.8 MB/h. Container overhead ignored (about 1 %).
- **c) ROI samples for G1/G2 OCR (UNVERIFIED):** 4 fps; 6 ROIs per sample. The vertical composite layout is not known. Assumed: the game area spans the full 1080 px width at the 1.45:1 aspect measured in `docs/evidence/2026-10-27-g1-live-reference.md`, so 1080×745 px. ROI fractions come from that file's MP and BR tables (themselves UNVERIFIED):

  | ROI | Fraction (w × h of game area) | Pixels |
  |---|---|---:|
  | M3 medal banner | 0.20 × 0.25 | 216 × 186 = 40,176 |
  | M3/M4 text stack | 0.32 × 0.14 | 346 × 104 = 35,984 |
  | Multi-kill card | 0.19 × 0.13 | 205 × 97 = 19,885 |
  | Kill feed (BR size, the larger of MP and BR) | 0.40 × 0.16 | 432 × 119 = 51,408 |
  | Own-event banner (BR) | 0.39 × 0.13 | 421 × 97 = 40,837 |
  | Own-kill counter (BR) | 0.16 × 0.07 | 173 × 52 = 8,996 |
  | **Total per sample** | | **197,286** |

  PNG bytes per pixel 1.1–1.4: derived from the G1 live PNG frames (MP 167.8 MB / 90 frames, BR 350.1 MB / 150 frames, over the 1566×1080 game area: 1.10 and 1.38 B/px). That was clean 1080p capture, not decoded 7.5 Mbps vertical video, and small crops compress differently (UNVERIFIED). JPEG q90 0.25–0.40 B/px is a rule-of-thumb assumption (UNVERIFIED).
- **d) Features and transcripts:** 64 float32 features per second (256 B/s) plus word-level transcript JSON at about 150 words/min × 80 B/word (200 B/s): 456 B/s = 1.6 MB/h. Assumed, small either way.

### Per item

| Item | MB/h | All 18 sessions (GB) | 20 Oct (GB) | 18 Oct (GB) | 17 Oct example (GB) |
|---|---:|---:|---:|---:|---:|
| a1 Audio, PCM WAV | 115.2 | 5.66 | 0.83 | 0.73 | 0.44 |
| a2 Audio, FLAC (estimated 50–60 %) | 57.6–69.1 | 2.83–3.39 | 0.41–0.50 | 0.36–0.44 | 0.22–0.26 |
| b1 Proxy video 1 Mbps | 450.0 | 22.09 | 3.22 | 2.84 | 1.70 |
| b2 Proxy audio 64 kbps (option) | 28.8 | 1.41 | 0.21 | 0.18 | 0.11 |
| c1 ROI samples, PNG (UNVERIFIED) | 3,125–3,977 | 153.4–195.2 | 22.4–28.5 | 19.7–25.1 | 11.8–15.1 |
| c2 ROI samples, JPEG q90 (UNVERIFIED) | 710–1,136 | 34.9–55.8 | 5.1–8.1 | 4.5–7.2 | 2.7–4.3 |
| d Features + transcripts | 1.6 | 0.08 | 0.01 | 0.01 | 0.01 |

### Totals

| Set | All 18 sessions | 20 + 18 Oct | 20 Oct | 18 Oct | 17 Oct example |
|---|---:|---:|---:|---:|---:|
| Lean: FLAC + proxy (video + audio) + ROI JPEG + d | 61.3–82.8 GB | 16.8–22.7 GB | 8.9–12.1 GB | 7.9–10.6 GB | 4.7–6.4 GB |
| Full: WAV + proxy (video + audio) + ROI PNG + d | 182.6–224.5 GB | 50.1–61.6 GB | 26.6–32.8 GB | 23.5–28.8 GB | 14.1–17.3 GB |

ROI samples dominate. If G2 crops ROIs from the proxy or the originals on the fly (gate first, OCR only when the gate fires, as in the game-event plan), the ROI cache can be skipped and the lean set drops to about 26.4–27.0 GB for all sessions.

### Free space

```
> Get-PSDrive -PSProvider FileSystem
Name  UsedGB FreeGB Root
----  ------ ------ ----
C    1445.70 416.40 C:\
Temp 1445.70 416.40 %TEMP%\
```

Only one physical drive (C:) is present; `Temp` is a PSDrive alias on C:. The corpus is also on C:. The cache folder is the user's choice.

## Tests

```
> npm run test:py
> python -I -m unittest discover -s tests/py -t tests/py -v

test_failures_not_cached (test_session_index.CacheTests.test_failures_not_cached) ... ok
test_incremental_reuse (test_session_index.CacheTests.test_incremental_reuse) ... ok
test_out_inside_corpus_refused (test_session_index.CacheTests.test_out_inside_corpus_refused) ... refusing: output folder is inside the corpus folder
ok
test_name_time_end (test_session_index.IndexTests.test_name_time_end) ... ok
test_offset_window (test_session_index.IndexTests.test_offset_window) ... ok
test_probe_failure_and_format_anomalies (test_session_index.IndexTests.test_probe_failure_and_format_anomalies) ... ok
test_unparseable_reported_not_crashing (test_session_index.IndexTests.test_unparseable_reported_not_crashing) ... ok
test_12am_is_midnight (test_session_index.ParseNameTests.test_12am_is_midnight) ... ok
test_12pm_is_noon (test_session_index.ParseNameTests.test_12pm_is_noon) ... ok
test_am_pm (test_session_index.ParseNameTests.test_am_pm) ... ok
test_unparseable (test_session_index.ParseNameTests.test_unparseable) ... ok
test_utc_conversion (test_session_index.ParseNameTests.test_utc_conversion) ... ok
test_gap_exactly_120_stays (test_session_index.SessionTests.test_gap_exactly_120_stays) ... ok
test_gap_over_120_splits (test_session_index.SessionTests.test_gap_over_120_splits) ... ok
test_overlap_trim (test_session_index.SessionTests.test_overlap_trim) ... ok
test_unsorted_input_is_sorted (test_session_index.SessionTests.test_unsorted_input_is_sorted) ... ok

Ran 16 tests
OK
```

```
> npm test
ℹ tests 90
ℹ pass 90
ℹ fail 0
ℹ skipped 0
```

The tests use synthetic filenames and fake probe records only; they never touch the corpus.

## UNVERIFIED / open

- Filename time = clip start vs end (evidence above favours end).
- Session rule: 18 sessions (end-to-start > 120 s, as agreed) vs the inventory's 19 (probably start-to-start).
- Cause of the 57–59 fps clips (likely dropped frames).
- ROI positions and sizes in the vertical composite; PNG/JPEG bytes per pixel; FLAC ratio.
- Filename times have 1 s resolution, so each gap/overlap value is only accurate to about ±1 s.

## Files

Created:
- `services/clip/session_index.py`
- `tests/py/test_session_index.py`
- `docs/evidence/2026-10-27-p2a-a2-session-index.md`
- Outside the repo: `C:\AI\Claude\_data\Ujwalam\index\{index.json, sessions.md, probe-cache.json}` and `C:\AI\Claude\_data\Ujwalam\index\name-as-end\{index.json, sessions.md, probe-cache.json}`

Changed:
- `package.json`: added the `test:py` script; existing scripts unchanged.
