# SPDX-License-Identifier: GPL-3.0-or-later
"""Download the face AI models listed in data/models/face-ai.json and check each SHA-256.

Every file is fetched from its pinned URL into a new temporary folder, hashed, and only then moved into
data/models/face/ (gitignored). A file whose size or SHA-256 differs from the manifest is refused and deleted.
Files already present with the right hash are kept. Stdlib only (urllib, hashlib, zipfile).

  python -I services/face/fetch_models.py [--only id,id] [--check]

--check only verifies what is on disk (exit 1 if anything is missing or wrong).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import tempfile
import urllib.request
import zipfile

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MANIFEST = os.path.join(REPO, "data", "models", "face-ai.json")


def load_manifest(path=MANIFEST):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def models_dir(manifest, repo=REPO):
    return os.path.join(repo, *manifest["dir"].split("/"))


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def files_of(m):
    """[(file, bytes, sha256)] a model needs on disk."""
    out = [(m["file"], m["bytes"], m["sha256"])]
    for x in m.get("extra", []):
        out.append((x["file"], x["bytes"], x["sha256"]))
    return out


def ok_on_disk(dirpath, m):
    for name, size, sha in files_of(m):
        p = os.path.join(dirpath, name)
        if not os.path.isfile(p) or os.path.getsize(p) != size or sha256_of(p) != sha:
            return False
    return True


def download(url, dst, expect_bytes, expect_sha):
    req = urllib.request.Request(url, headers={"User-Agent": "ujwalam-fetch-models"})
    with urllib.request.urlopen(req, timeout=120) as r, open(dst, "wb") as f:
        shutil.copyfileobj(r, f, 1 << 20)
    size, sha = os.path.getsize(dst), sha256_of(dst)
    if size != expect_bytes or sha != expect_sha:
        os.remove(dst)
        raise ValueError(f"{url}: got {size} bytes sha256 {sha}, expected {expect_bytes} {expect_sha}")


def fetch(m, dirpath, log=print):
    if ok_on_disk(dirpath, m):
        log(f"{m['id']}: present, SHA-256 ok")
        return
    os.makedirs(dirpath, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="ujw-models-") as tmp:
        if "archive" in m:
            a = m["archive"]
            zpath = os.path.join(tmp, "archive.zip")
            download(a["url"], zpath, a["bytes"], a["sha256"])
            with zipfile.ZipFile(zpath) as z:
                for member, name in a["members"].items():
                    if os.path.basename(name) != name:
                        raise ValueError(f"bad member target {name}")
                    with z.open(member) as src, open(os.path.join(tmp, name), "wb") as dst:
                        shutil.copyfileobj(src, dst)
        else:
            download(m["url"], os.path.join(tmp, m["file"]), m["bytes"], m["sha256"])
        for name, size, sha in files_of(m):
            p = os.path.join(tmp, name)
            if not os.path.isfile(p) or os.path.getsize(p) != size or sha256_of(p) != sha:
                raise ValueError(f"{m['id']}: {name} does not match the manifest")
        for name, _, _ in files_of(m):
            os.replace(os.path.join(tmp, name), os.path.join(dirpath, name))
    log(f"{m['id']}: downloaded, SHA-256 ok")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--only", default="")
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args(argv)
    man = load_manifest()
    d = models_dir(man)
    want = {x for x in a.only.split(",") if x}
    bad = 0
    for m in man["models"]:
        if want and m["id"] not in want:
            continue
        if a.check:
            good = ok_on_disk(d, m)
            print(f"{m['id']}: {'ok' if good else 'MISSING or WRONG'}")
            bad += 0 if good else 1
        else:
            try:
                fetch(m, d)
            except Exception as e:  # noqa: BLE001 - report every model, then fail
                print(f"{m['id']}: FAILED: {e}", file=sys.stderr)
                bad += 1
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
