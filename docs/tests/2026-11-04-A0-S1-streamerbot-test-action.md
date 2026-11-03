# A0-S1: Streamer.bot test-stream action (BM4) — setup steps for the user

Ujwalam never posts in chat (D192). The chat question and the spoken announcement are done by your own Streamer.bot,
with this one action. Set it up once before the first real stream (5 November). Menu names are from Streamer.bot's
usual layout and are UNVERIFIED on your version: if a name differs, pick the closest one and tell the agent.

## Texts (settled, bot manager plan)
- Chat question (posted every 15 min). It must start with the same words each time, because the feedback tool finds it
  by its start:
  `Test stream feedback: how do the video, sound and scenes look? Anything broken or laggy? Start your reply with fb:`
- Spoken announcement (Speaker.bot):
  `Test broadcast: we are trying new streaming software. Tell us in chat how the video, sound and scenes look.`

## Steps in Streamer.bot
1. **Actions** tab: right-click, **Add**. Name: `Ujwalam test stream`. Group: `Ujwalam`. Leave **Enabled** on.
2. In the action, add sub-actions (right-click in the Sub-Actions list):
   1. Twitch: **Chat > Send Message to Channel**, text = the chat question. Leave "send as bot" as you normally use it.
   2. YouTube: **Send Message to Broadcast** (all broadcasts), text = the chat question.
   3. Kick: **Kick > Send Message** (or the Kick chat sub-action your version has), text = the chat question.
   4. Speaker.bot speak step. On Streamer.bot 0.2.8 there is no "Integrations > Speaker.bot > Speak" entry (user,
      2026-11-03). Copy the Speaker.bot step from an action that already speaks (the user's TTS action has one:
      right-click it, **Copy**; in this action, right-click the Sub-Actions list, **Paste**), then change its message to
      the spoken announcement.
3. Timer. "Settings > Timed Actions" does not exist on 0.2.8 (user, 2026-11-03). Timers do exist (the saved settings
   hold a timed-actions list, and other actions use timer triggers): create the timer where the existing ones were
   made (location UNVERIFIED). Name `Ujwalam test stream`, interval `900` seconds, **Repeat** on, **Enabled OFF** (you
   turn it on at go-live). Do not reuse an existing 900 s timer: switching it on would also fire its own action.
4. Back in the action: add a timer trigger the same way the existing timer-driven actions have one, and pick
   `Ujwalam test stream`.
5. Private check before the day: run the action once by hand (right-click the action, **Test Trigger**) while signed in,
   ideally during a private or unlisted test. Check: the question shows on Twitch, YouTube and Kick chat; Speaker.bot
   says the announcement once (not twice). Tell the agent "BM4 works" or what failed.

## On the day
- At "start stream test", after "yes, on air": **enable** the timed action. It fires the first time after 15 minutes;
  run it once by hand right away if you want the question at the start.
- At "stop": **disable** the timed action before the streams end.
- After the stream the agent collects the replies:
  `node tools/collect-stream-feedback.mjs --date 2026-11-05 --question-prefix "Test stream feedback:"`
  (results go to `feedback/2026-11-05-stream-feedback.md`, local only).

## What Ujwalam does not do
It does not create, enable or fire this action. Its Streamer.bot connection only reads chat (D192). Starting
Streamer.bot and Speaker.bot from the Bots card is optional (flag `bot-manager`).
