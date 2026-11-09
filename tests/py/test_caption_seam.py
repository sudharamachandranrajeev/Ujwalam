# SPDX-License-Identifier: GPL-3.0-or-later
"""Caption seam: synthetic speech through the real caption path, no microphone or device (D312).

Fixture: synthetic speech from the Windows built-in synthesizer, generated at test time by
tests/fixtures/captions/make-fixture.ps1 (hidden, no console window) from the recipe in speech-en.json, and cached in
out/caption-seam/ (gitignored). The wav is never committed. Synthesis can differ between Windows builds, so the tests
check the transcript and the timing, never bytes. Without System.Speech (or the voice) everything here is skipped
with the reason. Two layers:

  FixtureTests     the generated wav is 16 kHz mono 16-bit PCM of a plausible length.
  WhisperSeamTests the real path: the clipper (services/clip/clipper.py) runs `candidates` and then
                   `render --captions faster-whisper` on a generated recording whose audio track carries the fixture
                   speech at a known offset. The clipper extracts the clip audio (clip_captions.extract_wav),
                   transcribes it with faster-whisper on the CPU (int8, 4 threads) and writes captions.ass, which is
                   burned into the rendered video. The test checks render.json, the ASS words and timing, the
                   safe-zone margins and the video. A direct transcription of the wav must contain every key word.

The whisper layer needs ffmpeg + ffprobe on PATH, a project venv (.venv-gpu or .venv, the order the studio uses)
whose Python imports faster_whisper, and the local model folder (D176, never in the repo): UJWALAM_WHISPER_MODEL,
else models/faster-whisper-small beside the clipper's own data dir (clip_common.resolve_data_dir: the
paths.event_core_data folder of data/profile.local.json). The clipper has no default model path of its own (it takes
--whisper-model only). Without these the layer is skipped with the reason. Nothing here is reachable from the shipped
app: it is a test file and drives only the clipper's existing command line. Media goes to a temp folder outside the
repository; only the cached fixture wav lands in out/caption-seam/.
Run: python -I -m unittest discover -s tests/py -t tests/py -p test_caption_seam.py
"""

import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
import unittest
import wave

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.normpath(os.path.join(_HERE, "..", ".."))
_CLIP = os.path.join(_REPO, "services", "clip")
if _CLIP not in sys.path:
    sys.path.insert(0, _CLIP)

import clip_captions as caps  # noqa: E402
import clip_common as cc  # noqa: E402

FIX_DIR = os.path.join(_REPO, "tests", "fixtures", "captions")
MANIFEST = os.path.join(FIX_DIR, "speech-en.json")
GENERATOR = os.path.join(FIX_DIR, "make-fixture.ps1")
CACHE_DIR = os.path.join(_REPO, "out", "caption-seam")  # gitignored (out/)
MODEL_NAME = "faster-whisper-small"
SPEECH_AT = 6.0      # seconds into the generated recording where the fixture speech starts
REC_SECONDS = 20     # recording length; the marker window (ranking.json) covers all of it
MARKER_MS = 12000
TIMING_TOL = 1.0     # seconds: whisper segment edges vs the known speech offset
HAVE_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))
_FIXTURE = {}        # memo: one generation per test run


def _manifest():
    with open(MANIFEST, encoding="utf-8") as f:
        return json.load(f)


def _words(text):
    return re.findall(r"[a-z0-9']+", text.lower())


def _wav_ok(path, m):
    try:
        with wave.open(path, "rb") as w:
            return (w.getframerate() == m["sampleRate"] and w.getnchannels() == m["channels"]
                    and w.getsampwidth() * 8 == m["bits"] and w.getnframes() > 0)
    except (OSError, EOFError, wave.Error):
        return False


def fixture_wav():
    """(path, None) for the generated speech wav, or (None, skip reason). Cached by recipe + generator hash."""
    if "v" in _FIXTURE:
        return _FIXTURE["v"]
    m = _manifest()
    h = hashlib.sha256()
    for p in (MANIFEST, GENERATOR):
        with open(p, "rb") as f:
            h.update(f.read())
    path = os.path.join(CACHE_DIR, f"speech-en-{h.hexdigest()[:12]}.wav")
    if _wav_ok(path, m):
        res = (path, None)
    else:
        ps = shutil.which("powershell.exe") if os.name == "nt" else None
        if not ps:
            res = (None, "System.Speech needs Windows PowerShell (powershell.exe); not available")
        else:
            r = cc.run_tool([ps, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", GENERATOR,
                             "-Out", path], timeout=180)
            if r.returncode == 0 and _wav_ok(path, m):
                res = (path, None)
            elif r.returncode == 3:
                res = (None, f"System.Speech or its voice is not available: {r.stderr.strip()[-200:]}")
            else:
                res = (None, f"fixture generation failed (exit {r.returncode}): {r.stderr.strip()[-200:]}")
    _FIXTURE["v"] = res
    return res


def _venv_python():
    """First project venv Python that imports faster_whisper (same order as services/studio-ui/record-clips.mjs)."""
    for name in (".venv-gpu", ".venv"):
        py = os.path.join(_REPO, name, "Scripts", "python.exe")
        if not os.path.isfile(py):
            py = os.path.join(_REPO, name, "bin", "python")
        if not os.path.isfile(py):
            continue
        r = cc.run_tool([py, "-I", "-c", "import faster_whisper"], timeout=120)
        if r.returncode == 0:
            return py
    return None


def model_dir(env=None, data_dir=None):
    """UJWALAM_WHISPER_MODEL, else <parent of the clipper's data dir>/models/faster-whisper-small, else None."""
    env = os.environ if env is None else env
    cands = []
    if env.get("UJWALAM_WHISPER_MODEL"):
        cands.append(env["UJWALAM_WHISPER_MODEL"])
    d = data_dir if data_dir is not None else cc.resolve_data_dir()
    if d:
        cands.append(os.path.join(os.path.dirname(os.path.normpath(d)), "models", MODEL_NAME))
    return next((c for c in cands if os.path.isfile(os.path.join(c, "model.bin"))), None)


def _seconds(ts):
    h, m, s = ts.split(":")
    return int(h) * 3600 + int(m) * 60 + float(s)


def _dialogues(ass_text):
    """[(start, end, text)] from the Dialogue lines; \\N joins become spaces."""
    out = []
    for line in ass_text.splitlines():
        if line.startswith("Dialogue:"):
            f = line[len("Dialogue:"):].split(",", 9)
            out.append((_seconds(f[1].strip()), _seconds(f[2].strip()), f[9].replace("\\N", " ")))
    return out


class ModelLookupTests(unittest.TestCase):
    def test_env_then_data_dir_sibling(self):
        with tempfile.TemporaryDirectory(prefix="ujw-capseam-model-") as d:
            env_m = os.path.join(d, "env-model")
            data = os.path.join(d, "root", "event-core")
            side = os.path.join(d, "root", "models", MODEL_NAME)
            for x in (env_m, side, data):
                os.makedirs(x)
            self.assertIsNone(model_dir({}, data))  # no model.bin anywhere
            open(os.path.join(side, "model.bin"), "wb").close()
            self.assertEqual(model_dir({}, data), side)
            self.assertEqual(model_dir({"UJWALAM_WHISPER_MODEL": env_m}, data), side)  # env without model.bin
            open(os.path.join(env_m, "model.bin"), "wb").close()
            self.assertEqual(model_dir({"UJWALAM_WHISPER_MODEL": env_m}, data), env_m)


class FixtureTests(unittest.TestCase):
    def test_generated_wav_format(self):
        path, why = fixture_wav()
        if not path:
            self.skipTest(why)
        m = _manifest()
        self.assertTrue(_wav_ok(path, m))
        with wave.open(path, "rb") as w:
            dur = w.getnframes() / w.getframerate()
        self.assertGreater(dur, 2.0)
        self.assertLess(dur, REC_SECONDS - SPEECH_AT - 2)  # fits in the recording after the offset
        self.assertTrue(set(m["keyWords"]) <= set(_words(m["text"])))


@unittest.skipUnless(HAVE_FFMPEG, "ffmpeg/ffprobe not on PATH")
class WhisperSeamTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.wav, why = fixture_wav()
        if not cls.wav:
            raise unittest.SkipTest(why)
        cls.model = model_dir()
        if not cls.model:
            raise unittest.SkipTest(f"no local faster-whisper model: set UJWALAM_WHISPER_MODEL or put {MODEL_NAME} in "
                                    "models/ beside the clipper data dir (D176)")
        cls.py = _venv_python()
        if not cls.py:
            raise unittest.SkipTest("no project venv (.venv-gpu or .venv) imports faster_whisper")
        cls.m = _manifest()
        with wave.open(cls.wav, "rb") as w:
            cls.wav_seconds = w.getnframes() / w.getframerate()
        cls.td = tempfile.TemporaryDirectory(prefix="ujw-capseam-")
        d = cls.td.name
        cls.rec = os.path.join(d, "rec-h-20261109-120000.mkv")
        delay = int(SPEECH_AT * 1000)
        # 48 kHz stereo AAC like a real recording; the fixture speech starts at SPEECH_AT, silence elsewhere.
        r = cc.run_tool(["ffmpeg", "-v", "error", "-nostdin", "-y", "-threads", "4",
                         "-f", "lavfi", "-i", f"testsrc2=size=640x360:rate=30:duration={REC_SECONDS}",
                         "-i", cls.wav,
                         "-filter_complex", f"[1:a]aresample=48000,pan=stereo|c0=c0|c1=c0,adelay={delay}|{delay},"
                                            f"apad=whole_dur={REC_SECONDS}[a]",
                         "-map", "0:v", "-map", "[a]", "-t", str(REC_SECONDS),
                         "-c:v", "libopenh264", "-b:v", "800k", "-c:a", "aac", "-b:a", "128k", cls.rec], timeout=300)
        if r.returncode != 0:
            cls.td.cleanup()
            raise unittest.SkipTest(f"cannot generate test media: {r.stderr[-200:]}")
        cls.markers = os.path.join(d, "markers.jsonl")
        with open(cls.markers, "w", encoding="utf-8", newline="\n") as f:
            f.write(json.dumps({"v": 1, "at": "2026-11-09T12:00:12.000Z", "source": "hotkey",
                                "recordMs": MARKER_MS, "streamMs": None}) + "\n")
        cls.data = os.path.join(d, "app-data")
        os.makedirs(cls.data)
        with open(os.path.join(cls.data, cc.LOCAL_FLAGS), "w", encoding="utf-8", newline="\n") as f:
            json.dump({"flags": {"clip-pipeline": True}}, f)
        cls.out = os.path.join(d, "run")
        clipper = os.path.join(_CLIP, "clipper.py")
        common = [cls.py, "-I", clipper, "--data-dir", cls.data]
        cls.cand_run = cc.run_tool(common + ["candidates", "--recording", cls.rec, "--markers", cls.markers,
                                             "--record-start", "2026-11-09T12:00:00Z", "--out", cls.out],
                                   timeout=600)
        cls.render_run = None
        if cls.cand_run.returncode == 0:
            cls.render_run = cc.run_tool(common + ["render", "--recording", cls.rec, "--out", cls.out,
                                                   "--layouts", "full-crop", "--encoder", "libopenh264",
                                                   "--captions", "faster-whisper", "--whisper-model", cls.model,
                                                   "--language", cls.m["language"]], timeout=1800)

    @classmethod
    def tearDownClass(cls):
        cls.td.cleanup()

    def _render_doc(self):
        self.assertEqual(self.cand_run.returncode, 0, self.cand_run.stderr[-800:])
        self.assertIsNotNone(self.render_run)
        self.assertEqual(self.render_run.returncode, 0, self.render_run.stderr[-800:])
        doc = cc.load_json(os.path.join(self.out, "render.json"))
        self.assertEqual(len(doc["clips"]), 1, doc["clips"])
        return doc, doc["clips"][0]

    def test_direct_transcription_has_the_words(self):
        code = ("import json,sys; sys.path.insert(0, sys.argv[1]); import clip_captions as c; "
                "s, i = c.transcribe('faster-whisper', sys.argv[2], {'whisper_model': sys.argv[3], 'language': 'en'});"
                " print(json.dumps({'segments': s, 'info': i}))")
        r = cc.run_tool([self.py, "-I", "-c", code, _CLIP, self.wav, self.model], timeout=600)
        self.assertEqual(r.returncode, 0, r.stderr[-800:])
        got = json.loads(r.stdout.strip().splitlines()[-1])
        self.assertEqual(got["info"]["status"], "ok")
        words = _words(" ".join(s["text"] for s in got["segments"]))
        for k in self.m["keyWords"]:
            self.assertIn(k, words)
        self.assertLessEqual(abs(len(words) - len(_words(self.m["text"]))), 2, words)
        self.assertLessEqual(got["segments"][0]["start"], TIMING_TOL)
        self.assertLessEqual(got["segments"][-1]["end"], self.wav_seconds + TIMING_TOL)

    def test_render_reports_captions_ok(self):
        _, clip = self._render_doc()
        self.assertEqual(clip["captions"]["backend"], "faster-whisper")
        self.assertEqual(clip["captions"]["status"], "ok", clip["captions"])
        self.assertGreaterEqual(clip["captions"]["segments"], 1)
        self.assertEqual(clip["errors"], [])

    def test_ass_has_the_words_at_the_right_time(self):
        _, clip = self._render_doc()
        with open(os.path.join(self.out, "clips", clip["id"], "captions.ass"), encoding="utf-8") as f:
            ass = f.read()
        dl = _dialogues(ass)
        self.assertGreaterEqual(len(dl), 1, ass)
        words = _words(" ".join(t for _, _, t in dl))
        for k in self.m["keyWords"]:
            self.assertIn(k, words)
        speech_start = SPEECH_AT - float(clip["start"])  # clip-relative
        speech_end = speech_start + self.wav_seconds
        # Without the VAD filter the first caption started at 0.0, seconds before the speech (D312).
        self.assertAlmostEqual(dl[0][0], speech_start, delta=TIMING_TOL)
        self.assertLessEqual(dl[-1][1], speech_end + TIMING_TOL)
        self.assertTrue(all(b > a for a, b, _ in dl))
        # The caption style keeps inside the intersection of every target's safe zone (data/clip/targets.json).
        safe = caps.safe_area(cc.load_json(os.path.join(_REPO, "data", "clip", "targets.json")))
        style = next(x for x in ass.splitlines() if x.startswith("Style: Cap,"))
        self.assertTrue(style.endswith(f",{safe['left']},{safe['right']},{safe['bottom']},1"), style)

    def test_rendered_video_with_captions(self):
        # The burn-in filter itself (subtitles=captions.ass) is covered in test_clip_pipeline.py; here the render
        # that took the transcribed captions.ass must finish with video and audio.
        _, clip = self._render_doc()
        files = clip["files"]
        self.assertEqual([x["layout"] for x in files], ["full-crop"])
        mp4 = os.path.join(self.out, "clips", clip["id"], files[0]["file"])
        r = cc.run_tool(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,width,height", "-of", "json",
                         mp4], timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        streams = json.loads(r.stdout)["streams"]
        self.assertEqual(sorted(s["codec_type"] for s in streams), ["audio", "video"])
        v = next(s for s in streams if s["codec_type"] == "video")
        self.assertEqual((v["width"], v["height"]), (1080, 1920))


if __name__ == "__main__":
    unittest.main()
