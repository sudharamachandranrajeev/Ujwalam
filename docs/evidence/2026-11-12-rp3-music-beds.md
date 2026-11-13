# RP3 music beds (procedural) — evidence (2026-11-12)

Plan: `docs/plan/2026-11-12-reel-polish-music-learning.md` (RP3a, RP3), decisions D363, D370. User request 2026-11-11:
calm lofi music at the start and end of reels, made locally. User choice 2026-11-12 after the RP3a comparison:
"procedural now, ACE-Step later".

Status: **built behind flag `reel-music` (off by default); not yet used on a real stream.** Tempo, keys, chords,
levels and lengths are proposed (`data/clip/music.json`, status proposed). The second generator, ACE-Step 1.5, is
not installed (it needs the user's yes for the install and a benchmark on this laptop).

## RP3a — model comparison (research only, nothing installed)

Licence is the gate: the reels are posted on monetised channels.

| Generator | Licence of weights | Monetised posting | Fits 6 GB | Note |
|---|---|---|---|---|
| ACE-Step 1.5 (2B turbo) | MIT (model card: "Commercial-Ready") | yes | yes (under 4 GB, INT8 + CPU offload) | needs a project-local Python 3.12 venv; at least 10 s per run; first pick for later |
| Stable Audio Open Small | Stability AI Community License | conditional (under USD 1M a year in revenue) | yes (UNVERIFIED) | at most 11 s; Windows UNVERIFIED |
| MusicGen (all sizes, fine-tunes) | CC-BY-NC 4.0 | no | yes | ruled out |
| YuE | CC-BY-NC plus a creator permission | conditional | no (24 GB) | ruled out |
| DiffRhythm | Apache-2.0 (VAE UNVERIFIED) | yes (UNVERIFIED) | no (8 GB) | ruled out |
| Magenta RealTime | CC-BY 4.0 | yes (attribution) | UNVERIFIED | JAX/TPU focus; Windows UNVERIFIED |
| AudioLDM 2, Riffusion | non-commercial / OpenRAIL (UNVERIFIED) | no / limited | yes | weak music quality |
| Procedural (own code) | none (own code) | yes | CPU only | built now |

Sources (checked 2026-11-12): huggingface.co/ACE-Step/Ace-Step1.5, github.com/ace-step/ACE-Step-1.5,
huggingface.co/stabilityai/stable-audio-open-small, stability.ai/license, huggingface.co/facebook/musicgen-small,
huggingface.co/google/magenta-realtime, github.com/multimodal-art-projection/YuE, github.com/ASLP-lab/DiffRhythm.
Rows marked UNVERIFIED were not stated on the official page.

## What was built

- `data/clip/music.json`: 72–86 BPM, six keys, four seventh-chord progressions, swing 0.58, 3.2 kHz warm low-pass,
  voice levels, bed level −20 dBFS peak, start bed (ends with the RP4 title, else after 3 s; fade in 0.4 s, out
  0.9 s), end bed (last 4 s; fade in 1 s, out 1.5 s), sidechain duck, no music under 8 s.
- `services/clip/reel_music.py` (standard library only): `plan` (the start bed never more than half the reel; no end
  bed without 1 s of room), `seed_for` (reel id + source: the same reel always gets the same bed, another reel another
  one), `synth` (electric-piano chords with a soft strum and tremolo, bass on 1 and 3, kick, snare, swung hats, vinyl
  crackle, low-pass; one 16-bit stereo WAV as long as the reel, silence between the beds), `prepare`/`cleanup`.
- `services/clip/clip_montage.py` `render_argv(music=)`: the WAV is mixed under audio track 1 (the studio mix) with
  `sidechaincompress` keyed by that track, so loud game sound and speech push the bed down; other tracks are untouched;
  the length does not change; a picture-only render gets no music; the RP6 start frame's one-frame delay still applies.
- `services/clip/clipper.py`: montages, match reels, impact-play reels and live clips (with audio); the row has
  `music {seed, total, intro, outro, bpm, key, progression}`; render.json has `reelMusic {flag, on, version, generator}`;
  Captions again keeps the same bed (same seed) laid out on the captioned reel's timeline. A failure while making the
  bed renders the reel without it.
- `data/flags.json`: `reel-music`, default false.

## Tests

| Command | Result |
|---|---|
| `python -I -m unittest discover -s tests/py -t tests/py` | Ran 649 tests, OK (skipped=51) |
| `tests/py/test_reel_music.py` (in the suite) | 12 tests: flag off by default; bad config refused (another generator, a bed louder than −6 dB, a wrong tempo range, an unknown chord); start bed ends with the title or after introSec, never more than half the reel, end bed only with room, no music under 8 s; seed stable per reel; WAV as long as the reel, 48 kHz stereo, bed present at start and end, digital silence between, peak never above the bed level, fades to the end; same seed gives the same bytes, another seed another bed; filter graph (track 1 only, input index moves with the start frame, picture-only has none); real renders: a silent source gets an audible bed (above −45 dB) where the bed is, silence between the beds stays silent (below −60 dB), under a loud tone the ducked bed changes the level by under 1 dB, the length does not change |
| `npm run lint` | 0 findings |

Synthesis time: a 22.75 s reel's bed (two beds, 8.35 s of music) in 1.4 s on this laptop (CPU, one thread).

## Real footage check (local, not committed)

The same story montage of the 2026-11-11 session as RP6/RP4 (cross fade, start frame, title card, music): 38.717 s,
the same length as without music. Bed 78 BPM, I-vi-ii-V. Mean level of track 1 (ffmpeg volumedetect), without → with
music: 0.5–4.5 s −36.5 → −33.1 dB (the start bed under the teaser and title), 15–25 s −31.1 → −31.1 dB (untouched),
35–38.5 s −33.9 → −32.4 dB (the end bed). The video holds the face and channel names, so it stays in the agent's
scratch folder. Not checked by ear by the agent: how it sounds is for the user to judge.

## Review

Codex (medium) on the diff: no findings (static review).

## Open

- The user listens and approves or changes the sound (tempo, chords, level −20 dB, lengths).
- ACE-Step 1.5 as a second generator: needs the user's yes for the install (Python 3.12 venv, about 5 GB), then a
  benchmark on the RTX 4050 Laptop and a check that no vocals appear.
