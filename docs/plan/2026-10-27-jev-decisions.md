# 2026-10-27 — Jev for decisions (paid API exception)

User decision, 2026-10-27. TypeSafe AI Jev is the only exception to "local only, no paid APIs". Everything else stays local and free. Terms check: `docs/evidence/2026-10-27-p2b-j0-jev-terms.md`.

## 1. Interface

- `DecisionProvider.decide(schema, state, question) → {choice, probability, confidence}`.
- `JevProvider` is primary. `LocalProvider` (rules or ONNX) is the fallback when offline, over budget, on timeout or on error.
- The app runs fully with Jev unavailable. A failed call is a fallback, never an answer.
- Every decision records the provider, the model version as returned by the API, and the latency.

## 2. What goes to Jev

Allowed:
- Clip-worthiness and ranking of candidates, as atomic judgments combined in code (see the J0 evidence, §4).
- End-screen and screen-type classification from OCR text.
- Chat intent and when a scene suggestion fires.
- Effect-trigger and pool selection where the rules are ambiguous.

Never:
- Pixel or frame work, rendering, encoding, outputs, or anything that can stall the stream.
- Live calls are async with a short timeout, then the local fallback. Jev is never on the stream's critical path.

## 3. Model

Pinned `jev-1.13.0` (not `jev-latest` or `jev-preview`). `jev-1.14.0` has been out since 2026-10-14. J2 evaluates both pins and the user chooses. The response's `model` is recorded with each decision.

## 4. Privacy

- Send only derived text: event tags, scores, and OCR text with names swapped for placeholders.
- Never send video, audio, images, the IGN, brand or channel names, viewer names or raw chat.
- Redact before every call, using the terms in `data/profile.local.json` and every player or viewer name seen.
- Log exactly what was sent, locally and gitignored.
- Box questions and image assets are never used.

## 5. Key and spend

- The key is stored in the OS keychain only (Windows Credential Manager); never in a file, env file, log or repo.
- Daily spend and call limits are in config. They are `null` (no cap) until the user sets them (2026-10-27).
- Tokens and cost are logged per call. The monthly total is shown in the diagnostics view.

## 6. Before first use

1. Docs and terms recorded with source and date: done in J0.
2. Evaluate Jev against LocalProvider on held-out labelled sessions (accuracy, calibration, latency, cost) and show the user the report (J2). Jev is used in production only after the user approves.

## Phase placement

J0 and J1 in P2b; J2 with G3. Chat intent and scene suggestions are wired in P8, effect trigger and pool selection in P7.
