# 2026-10-27 — P2b J0: TypeSafe AI Jev docs and terms check

Read-only check before first use. No API key was used and no request was sent. Pages fetched on 2026-10-27.

## 1. Model and pin

Source: https://docs.typesafe.ai/go/models.md (fetched 2026-10-27).

- Listed models: `jev-1.14.0` and `jev-1.13.0`. "Jev 1.14 is the newest Jev release, available from October 14, 2026."
- `jev-latest` and `jev-preview` both point to `jev-1.14.0`.
- Pinned versions are supported: "Versioned IDs such as `jev-1.14.0` are accepted by the `model` field whether or not they appear in the list."
- The page gives no deprecation policy, so how long `jev-1.13.0` stays served is UNVERIFIED.
- Context: 64k per request and 32k per question by default. Long context (262k) needs an opt-in header, and the page calls it slower and less accurate. Ujwalam does not use it.
- Rate limits are set per organisation, in tokens/s and requests/s, and shown in the developer console. Over the limit, the API returns `429`. Our limits are UNVERIFIED until we have an account.
- Price: $42 per billion input tokens ($0.042 per million). "Output tokens are free."

**Pin decision (user, 2026-10-27): `jev-1.13.0`.** `jev-1.14.0` is newer, which the user did not know when pinning. Proposal: J2 evaluates both pinned versions and the user picks one. Each decision records the `model` value the response returns.

## 2. API shape

Source: https://docs.typesafe.ai/api/system-one.md (fetched 2026-10-27).

- `POST https://api.typesafe.ai/v1/systemone`, header `Authorization: Bearer <key>`, body `application/json`.
- Request: `model`, `state` (string, object or array), `questions` (keyed by name; each has a `type`).
- Question types:
  - `noul`: optional `instructions`, optional `criteria` with `true` and `false`.
  - `choice`: `criteria` with 1–255 named options.
  - `score`: 1–10 ordered levels.
  - `box`: needs an image and a "danger zone" header. **Ujwalam never uses it**, because it needs images.
- Response: `model`, `answers`, `usage.input_tokens`, `usage.output_tokens`.
  - `noul` returns a probability.
  - `choice` returns `choice`, `confidence` and `probabilities`.
  - `score` returns `score`, `confidence`, `legend` and `probabilities`.
- SDKs exist for Python and JavaScript, but plain HTTP is enough: stdlib `urllib` in the Python worker, `fetch` in Node. **No install needed.**

Mapping to the requested interface `decide(schema, state, question) → {choice, probability, confidence}`:
- **choice:** `choice`, `probabilities[choice]`, `confidence`.
- **noul:** `choice` is `true` or `false` against code thresholds, `probability` is `noul`, and `confidence` is null, because Jev returns none for a noul.

Vendor guidance (`typesafe-ai` skill and docs, "Confidence is rarely the gate"): `confidence` measures how concentrated the distribution is, not how likely the answer is to be correct. Code should gate on the probabilities and thresholds, not on `confidence`.

## 3. Terms: data retention and training

| Topic | Finding | Source |
|---|---|---|
| Training on inputs | "We will not train or fine tune any artificial intelligence or machine learning models on your prompts or other Input." | Privacy Policy, https://typesafe.ai/legal/privacy-policy, "Last updated Nov 19, 2025" (fetched 2026-10-27) |
| Input collected | "We collect the personal data you provide when you use the Services, including your prompts, data, instructions" | Privacy Policy |
| Retention | No fixed period. The Privacy Policy keeps data "for as long as reasonably necessary to provide you with the Services" and deletes it on request when no longer needed. The DPA (Schedule I §8) keeps it "as long as necessary taking into account the purpose of the Processing". | Privacy Policy; DPA, https://typesafe.ai/legal/data-processing, "Last updated Apr 24, 2026" (fetched 2026-10-27) |
| Zero data retention | Enterprise customers only, on request. | https://docs.typesafe.ai/legal.md |
| Location | Hosted in the United States; non-US users transfer data to the US. | Privacy Policy |
| Sharing | Input goes to no third parties except service providers. Subprocessors are listed at https://trust.typesafe.ai/subprocessors (not opened; UNVERIFIED). No sale of personal data. | Privacy Policy; DPA §3.2 |
| Security | "reasonable and appropriate technical and organization security measures"; details on https://trust.typesafe.ai/ (not opened). | DPA §5.1 |
| Deletion | No explicit deletion right in the DPA; the Privacy Policy deletes on request. | DPA §4.1; Privacy Policy |

**Consequence for Ujwalam.** Inputs may be kept for an unspecified period, in the US, and not used for training. That makes the user's redaction rule load-bearing:
- Send only derived text, with names swapped for placeholders.
- Never send media, IGN, brand or channel names, viewer names or raw chat.
- Log every payload locally (gitignored) exactly as it was sent.

The Master Customer Agreement (https://typesafe.ai/legal/mca) was not read; its terms are UNVERIFIED.

## 4. Relevant vendor material for later steps

- The Twitch chat filter cookbook (`/cookbooks/twitch_chat_filter.md`) is relevant to chat intent (P8). Its redaction must still apply: no raw chat is sent.
- "Judgments from Jev, decisions in code": ask atomic judgments (for example "does this OCR text show an MVP end screen?") and keep the decision (clip or not, weights) in code. Clip-worthiness then becomes several judgments combined by the fusion code (G3), not one "is this worth clipping?" question.
- Jaggedness page for 1.13: `/model-jaggedness/jev-1.13.md` (to read at J1).

## Files created or changed

- Created: `docs/evidence/2026-10-27-p2b-j0-jev-terms.md`
