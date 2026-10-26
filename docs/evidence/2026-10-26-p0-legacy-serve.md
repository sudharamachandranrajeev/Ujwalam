# 2026-10-26 P0 legacy overlays serve

Date: 2026-10-26. Result: PASS.

`legacy/tools/serve.ps1` has a `-Port` parameter, so the copy was served unmodified on 8797 (8787 is the live Meld setup's port). `tools/serve-legacy.mjs` was therefore not needed and not created.

## Commands

```
Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','legacy\tools\serve.ps1','-Port','8797' -PassThru -WindowStyle Hidden
Invoke-WebRequest http://localhost:8797<path> -UseBasicParsing     # for each path below
Stop-Process -Id <server pid> -Force
```

## Output (HTTP status, path, size)

```
200 /overlays/_template/index.html (1732 bytes)
200 /overlays/alert-box/index.html (5105 bytes)
200 /overlays/atmos-frame/index.html (13134 bytes)
200 /overlays/blood-moon-hud/index.html (8787 bytes)
200 /overlays/cam-pop-frame/index.html (14891 bytes)
200 /overlays/chat-charge/index.html (18221 bytes)
200 /overlays/chat-engage/index.html (10933 bytes)
200 /overlays/chat-list/index.html (4789 bytes)
200 /overlays/chat-storm/index.html (56448 bytes)
200 /overlays/gg-burst/index.html (6335 bytes)
200 /overlays/social-ticker/index.html (2617 bytes)
200 /overlays/voice-callout/index.html (12101 bytes)
200 /tools/preview.html (9912 bytes)
200 /tools/spark-preview.html (7505 bytes)
200 /tools/scene-check.html (4134 bytes)
200 /tools/meld-inspector.html (7548 bytes)
200 /spark/chat-spotlight.html (38241 bytes)
200 /spark/comic-pop.html (34963 bytes)
200 /kit/rp-kit.js (11907 bytes)
200 /brand/tokens.css (4814 bytes)
```

## Cleanup check

```
leftover listeners on 8797: 0
powershell processes running serve.ps1: 0
```

## Limits

Only HTTP 200 and file served were checked. Overlays were not rendered in a browser or Meld in P0 (that is P1: Chat Charge in a recording).
