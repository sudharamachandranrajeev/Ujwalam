// SPDX-License-Identifier: GPL-2.0-or-later
// Cam-pop rule (v1 F5): when to pop the camera. Port of the trigger logic of the legacy cam-pop tool, as data + a
// small state machine. It only DECIDES; the pop itself goes through the same effect gate as every other effect
// (`fire({ name: 'campop', source })`), so budget, region and flash guards apply and refusals are audited.
//
// Behaviour copied from the legacy tool (values in data/effects/guards.json under rules.campop, with file:line):
//   - every live chat message is a trigger (chatMessage.enabled)
//   - a burst of `messages` chat messages inside `windowSec` is a trigger; the window is emptied when it fires
//   - a mic level at or above spikeLevel for at least holdMs is a trigger, then the hold timer resets
//   - a random pop: every checkEveryMs, fire with chance 1 / meanMin
//   - minGapSec since the last ADMITTED pop (0 = none); a trigger while a pop is up is dropped, not queued
//     (the gate returns 'busy' for that, because the campop effect lasts holdSec)
// The rule never reads chat text: it counts messages only.
//
// Mic level: the host feeds onMicLevel() every 50 ms with the libobs meter peak (10^(dB/20), 0..1) of the project audio
// source named in rules.campop.voice.audioSource (app/host/src/overlay.h, op "mic" in app/host/overlay/child.mjs).
// UNVERIFIED: that meter is post-fader and post-filter, while the legacy spikeLevel 0.12 was measured on the raw
// device peak; confirm with a live measurement on the real mic. Without a host feed the voice trigger never fires.

export function createCamPopRule({ config, fire, now = Date.now, rng = Math.random, setInterval: si = setInterval, clearInterval: ci = clearInterval }) {
  if (typeof fire !== 'function') throw new TypeError('fire must be a function');
  const c = config;
  const chatTimes = [];
  let lastPopAt = -Infinity;
  let loudSince = 0;
  let timer = null;
  const counts = { triggers: 0, admitted: 0, refused: 0, gap: 0 };

  function maybePop(reason) {
    const t = now();
    counts.triggers++;
    if ((t - lastPopAt) / 1000 < c.minGapSec) { counts.gap++; return false; }
    const r = fire({ name: c.effect, source: `campop-${reason}` });
    const ok = r?.ok === true || r?.allow === true;
    if (ok) { lastPopAt = t; counts.admitted++; } else counts.refused++;
    return ok;
  }

  return {
    /** A live chat message arrived (any platform). Only the fact of a message is used. */
    onChat() {
      if (c.chatMessage.enabled) maybePop('chat-message');
      const t = now();
      chatTimes.push(t);
      while (chatTimes.length && t - chatTimes[0] > c.chatBurst.windowSec * 1000) chatTimes.shift();
      if (chatTimes.length >= c.chatBurst.messages) {
        chatTimes.length = 0; // one burst, one pop
        maybePop('chat-burst');
      }
    },
    /** One mic level reading (0..1). Call at the meter rate (legacy polled every 50 ms). */
    onMicLevel(level) {
      if (!c.voice.enabled) return;
      if (level >= c.voice.spikeLevel) {
        const t = now();
        loudSince ||= t;
        if (t - loudSince >= c.voice.holdMs) { loudSince = 0; maybePop('voice-spike'); }
      } else loudSince = 0;
    },
    /** One random check (legacy: once a minute). */
    tickRandom() {
      if (c.random.enabled && rng() < 1 / c.random.meanMin) maybePop('random');
    },
    start() { if (!timer && c.random.enabled) { timer = si(() => this.tickRandom(), c.random.checkEveryMs); timer.unref?.(); } },
    stop() { if (timer) ci(timer); timer = null; },
    stats: () => ({ ...counts }),
  };
}
