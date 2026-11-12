# 2026-11-11 — Reel editing, Instagram Live, analytics learning, topic videos, studio recording

Source: the user's message on 2026-11-11. Status: **draft; waiting for the user's approval** (CL1 and R1 have already started, see below).
Order follows AGENTS priority: live breakage > bugs > the user's direct asks > planned work. Gaming functions come before the studio recording section, as the user said.

## Phases

| Id | What | Approval needed | Status |
|---|---|---|---|
| CL1 | Montages, match reels and every joined clip are at most 60 s. Longer ones split at clip boundaries into "part N of M". Settings > Clips gets a maximum and minimum length per reel type (D350). | none (direct order) | building |
| R1 | Research: the editing and montage features rated highest for reach on YouTube Shorts and Instagram Reels; features creators most request from clip tools; how Instagram Live works from a PC; analytics APIs and their access. Output: `2026-11-11-reel-montage-feature-research.md`. | none | running |
| ED1–EDn | Reel and montage editing features, taken from R1's ranked list (for example hook first, captions, beat-synced cuts, punch-in zooms, kill counter, cover frame). Each one is a core function, a manifest and at least one preset, behind a flag. | the user picks from the R1 list | after R1 |
| IG1 | Instagram Live as an output: a 9:16 sink on the existing V rung (no new encoder if the limits match), with limits in `data/platforms/instagram.json`. Loopback ffprobe checks pass first. | first real Instagram test stream | after R1 confirms the facts |
| IG2 | Connect Instagram from the app (Settings > Connections). If Instagram gives a new key for each broadcast (UNVERIFIED), the app takes the pasted URL and key each time. An API flow only if Meta allows one for the account type. | the user's account type; any Meta developer app setup | after IG1 |
| AN1 | Growth section: its own window, opened from the menu bar and never needed while live or recording. It fetches the user's own analytics (YouTube Analytics and Data API with OAuth; Instagram insights if the account allows) into a local store. | creating the Google and Meta developer apps (the user's accounts) | AN1a (YouTube data, local store, CLI) built 2026-11-12 behind flag `growth`, waiting for the user's Google setup (`2026-11-12-growth-setup-notes.md`); AN1b Growth window (More menu, flag `growth`, D372) built 2026-11-12, tested with fakes; Instagram insights next |
| AN2 | Learning loop: link each posted reel to its retention, views and likes, and learn which edits, lengths, hooks, titles and posting times work. Feed this into auto-post rules and reel editing defaults as **proposals** that the user approves with one click. Never applies itself. Uses local models only. | none beyond AN1 | plan |
| BR | Battle Royale detector update. Needs new footage and labels if the HUD, map or result screens changed. | the user: what changed, and footage | question asked |
| TV1 | Topic projects: one project folder for each video inside a folder the user picks (sources, cuts, script, exports). | none | plan |
| TV2 | Topic finder: from the user's own lives, videos and clips (speech to text, on-screen text, chat questions), find moments that fit topics (how to play, best settings, new changes, a new mythic, ...). Learns from AN2 results which topics reach more people. | none | plan |
| TV3 | Video maker: from a topic, make a reel under 1 min or a full video of 6–15 min, as a project in TV1. Draft cut, chapters, title and description proposals; the user reviews before posting. | a voice-over choice (local TTS or the user's own voice) | plan |
| ST | Studio recording section (a professional reel and video recording setup). Built after all the gaming functions are done, as the user said. | — | later |

## The user's answers (2026-11-11)

- **BR:** the user is not sure what changed. Check the BR reads from the next stream that has BR matches, and ask for footage only if a detector fails.
- **Instagram:** Creator account. R1 found that the Live Producer key changes for each broadcast and that there is no official API to start a live. So IG2 means pasting the URL and key for each broadcast. Insights come through the Graph API (`instagram_manage_insights`, Facebook Page link).
- **Analytics:** yes, both. Write step-by-step setup notes for a Google Cloud project (YouTube Analytics and Data API, OAuth) and a Meta app (Instagram insights). The user does the sign-ins and approvals; the in-app connect flow stores tokens in Credential Manager.
- **Voice in topic videos:** no new narration. Use only what was said live, by the user and the fellow gamers on the stream, which is spoken mixed **Malayalam and English**. This needs speech to text that is properly trained for Malayalam-English code-mixing.
  - New phase **STT-ML**: measure the current local Whisper on real stream audio first, then fine-tune or adapt if it falls short.
  - Data needed (to ask at that phase's start): about 2–5 h of the user's stream audio with corrected transcripts, which can come from correcting Ujwalam's drafts in a review page.
  - Fellow gamers' voices are their personal data. Their audio and transcripts stay local, are never committed, and are not used in posted videos without the user's check.
- **R1 is done:** `2026-11-11-reel-montage-feature-research.md`.
  - Strong evidence: payoff-first hooks (both platforms measure the first-3-s skip), captions, the 9:16 reframe, and loopable 15–45 s clips.
  - Weak evidence: beat sync, punch-ins, speed ramps and kill counters.
  - YouTube Shorts can now be up to 3 min, but the user's 60 s cap (CL1) applies.

## Rules that apply

- Data, learning stores and analytics stay local and gitignored. Viewer names never appear in committed files. Platform tokens are kept in Windows Credential Manager only.
- No paid APIs (Jev for decisions only). Platform analytics APIs are free, but they need developer apps on the user's accounts, so that waits for the user's yes.
- Nothing posts, streams or changes the user's settings on its own. Learning gives proposals, and the user applies each one with a click.
- Instagram is never tested live until the loopback ffprobe checks pass, and never goes live without the user's words "start stream test".
