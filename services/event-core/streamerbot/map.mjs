// SPDX-License-Identifier: GPL-2.0-or-later
// Streamer.bot payload -> event-core ingest input (P3 E2). Node stdlib only.
//
// Chat mapping is ported from the proven legacy source: every field is read the new way first and the old
// way second (the chat shape changed between Streamer.bot versions). Do not "tidy" the fallback order.
//
// Alert mappings are UNVERIFIED: the event names come from docs.streamer.bot (read 2026-10-28) and the
// field names from its auto-generated example payloads, not from a real payload. A wrong guess is dropped
// (counted as `unmapped`), never turned into an event with made-up fields.
//
// The raw payload is never returned; only fields the E1 model knows are copied out.

const str = (v) => (v == null ? '' : String(v));
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const firstStr = (...vs) => { for (const v of vs) if (typeof v === 'string' && v !== '') return v; return ''; };

/** platform -> Streamer.bot source name -> events to subscribe, with the E1 kind each maps to.
 *  Every alert row is UNVERIFIED until a real payload has been seen (see the E2 evidence file). */
export const EVENT_TABLE = [
  // chat (proven in legacy against a real install)
  { source: 'Twitch', type: 'ChatMessage', platform: 'twitch', kind: 'chat.message', verified: true },
  { source: 'YouTube', type: 'Message', platform: 'youtube', kind: 'chat.message', verified: true },
  { source: 'Kick', type: 'ChatMessage', platform: 'kick', kind: 'chat.message', verified: true },
  // alerts: names from the docs index, UNVERIFIED
  { source: 'Twitch', type: 'Follow', platform: 'twitch', kind: 'alert.follow', verified: false },
  { source: 'Twitch', type: 'Sub', platform: 'twitch', kind: 'alert.sub', verified: false },
  { source: 'Twitch', type: 'ReSub', platform: 'twitch', kind: 'alert.resub', verified: false },
  { source: 'Twitch', type: 'GiftSub', platform: 'twitch', kind: 'alert.giftsub', verified: false },
  { source: 'Twitch', type: 'GiftBomb', platform: 'twitch', kind: 'alert.giftsub', verified: false },
  { source: 'Twitch', type: 'Raid', platform: 'twitch', kind: 'alert.raid', verified: false },
  { source: 'Twitch', type: 'Cheer', platform: 'twitch', kind: 'alert.bits', verified: false },
  { source: 'Twitch', type: 'RewardRedemption', platform: 'twitch', kind: 'alert.redemption', verified: false },
  { source: 'YouTube', type: 'SuperChat', platform: 'youtube', kind: 'alert.superchat', verified: false },
  { source: 'YouTube', type: 'NewSponsor', platform: 'youtube', kind: 'alert.membership', verified: false },
  { source: 'YouTube', type: 'MemberMilestone', platform: 'youtube', kind: 'alert.membership', verified: false },
  { source: 'Kick', type: 'Follow', platform: 'kick', kind: 'alert.follow', verified: false },
  { source: 'Kick', type: 'Subscription', platform: 'kick', kind: 'alert.sub', verified: false },
  { source: 'Kick', type: 'Resubscription', platform: 'kick', kind: 'alert.resub', verified: false },
  { source: 'Kick', type: 'GiftSubscription', platform: 'kick', kind: 'alert.giftsub', verified: false },
  { source: 'Kick', type: 'MassGiftSubscription', platform: 'kick', kind: 'alert.giftsub', verified: false },
  { source: 'Kick', type: 'RewardRedemption', platform: 'kick', kind: 'alert.redemption', verified: false },
];

/** The Subscribe `events` object: { Twitch: [...], YouTube: [...], Kick: [...] }. */
export function subscribeEvents(table = EVENT_TABLE) {
  const out = {};
  for (const r of table) (out[r.source] ??= []).push(r.type);
  return out;
}

const lookup = new Map(EVENT_TABLE.map((r) => [`${r.source}.${r.type}`, r]));
export const findRow = (source, type) => lookup.get(`${source}.${type}`) ?? null;

// ---- roles -----------------------------------------------------------------------------------------------

// Streamer.bot numeric role: 1 viewer, 2 vip, 3 moderator, 4 broadcaster. UNVERIFIED (from memory of the
// docs; not seen in a real payload by this project).
const ROLE_NUM = { 2: 'vip', 3: 'moderator', 4: 'broadcaster' };

function badgeNames(list) {
  if (!Array.isArray(list)) return [];
  return list.map((b) => str((b && (b.name || b.id)) || b).toLowerCase()).filter(Boolean);
}

function rolesFrom(u, m) {
  const roles = new Set();
  const names = [...badgeNames(u.badges), ...badgeNames(m.badges)];
  for (const n of names) {
    if (n === 'broadcaster') roles.add('broadcaster');
    else if (n === 'moderator') roles.add('moderator');
    else if (n === 'vip') roles.add('vip');
    else if (n === 'subscriber' || n === 'founder') roles.add('subscriber');
  }
  const r = num(u.role) ?? num(m.role);
  if (r != null && ROLE_NUM[r]) roles.add(ROLE_NUM[r]);
  if (u.subscribed === true || u.isSubscribed === true || m.subscribed === true) roles.add('subscriber');
  if (u.isSponsor === true) roles.add('member');
  if (u.isModerator === true) roles.add('moderator');
  if (u.isOwner === true) roles.add('broadcaster');
  return roles.size ? [...roles] : ['viewer'];
}

// ---- user ------------------------------------------------------------------------------------------------

/** Chat user, legacy order: user.name, user.displayName, user.login, message.displayName, message.username. */
function chatUser(d) {
  const u = isObj(d.user) ? d.user : {};
  const m = isObj(d.message) ? d.message : {};
  const displayName = firstStr(u.name, u.displayName, u.login, m.displayName, m.username);
  const id = u.id ?? m.userId ?? null;
  return { platformUserId: id == null || id === '' ? null : String(id), displayName, roles: rolesFrom(u, m) };
}

/** Alert user: the acting user, from the first object that carries a name. Falls back to "anonymous". */
function alertUser(...candidates) {
  for (const c of candidates) {
    if (!isObj(c)) continue;
    const displayName = firstStr(c.name, c.displayName, c.login, c.userName, c.username);
    if (displayName) {
      const id = c.id ?? c.userId ?? null;
      return { platformUserId: id == null || id === '' ? null : String(id), displayName, roles: rolesFrom(c, {}) };
    }
  }
  return { platformUserId: null, displayName: 'anonymous', roles: ['viewer'] };
}

// ---- chat ------------------------------------------------------------------------------------------------

function chatFields(d) {
  const m = isObj(d.message) ? d.message : {};
  const text = typeof d.message === 'string' ? d.message : firstStr(d.text, m.message, m.text);
  const out = { text };
  const rawEmotes = Array.isArray(d.emotes) ? d.emotes : Array.isArray(m.emotes) ? m.emotes : null;
  if (rawEmotes) {
    const emotes = rawEmotes
      .filter((e) => isObj(e) && (e.id != null || e.name != null))
      .map((e) => ({ id: str(e.id ?? e.name), name: str(e.name ?? e.id) }));
    if (emotes.length) out.emotes = emotes; // shape {id, name} UNVERIFIED
  }
  return out;
}

function chatMessageId(d) {
  const m = isObj(d.message) ? d.message : {};
  // new: messageId; YouTube: eventId; old: message.msgId / message.messageId
  const id = d.messageId ?? d.eventId ?? m.msgId ?? m.messageId ?? null;
  return id == null || id === '' ? null : String(id);
}

// ---- alerts (all UNVERIFIED) -----------------------------------------------------------------------------

const TIERS = new Set(['1000', '2000', '3000']);
function tierOf(d) {
  if (d.isPrime === true) return 'prime';
  const t = d.subTier ?? d.tier ?? d.subscriptionTier;
  if (typeof t === 'string') {
    const s = t.toLowerCase();
    if (s === 'prime') return 'prime';
    if (TIERS.has(s)) return s;
    const m = /^tier\s*([123])$/.exec(s); // "Tier 1" style, in case a version sends it
    if (m) return `${m[1]}000`;
  }
  if (typeof t === 'number' && TIERS.has(String(t))) return String(t);
  return '1000'; // Kick has no tiers; absent Twitch tier is treated as tier 1
}
const intOrNull = (v, min) => { const n = num(v); return n != null && Number.isInteger(n) && n >= min ? n : null; };
const msgOf = (d) => { const s = firstStr(d.text, d.message, d.userInput); return s || undefined; };

const ALERT = {
  'alert.follow': (d) => ({ user: alertUser(d.user, d.targetUser) }),
  'alert.sub': (d) => ({ user: alertUser(d.user), tier: tierOf(d), message: msgOf(d) }),
  'alert.resub': (d) => {
    const months = intOrNull(d.cumulativeMonths ?? d.cumlativeTotal ?? d.durationMonths ?? d.months ?? d.duration, 1);
    return months == null ? null : { user: alertUser(d.user), tier: tierOf(d), months, message: msgOf(d) };
  },
  'alert.giftsub': (d, row) => {
    // A GiftBomb is followed by one GiftSub per recipient flagged fromCommunitySubGift: count only the bomb.
    if (row.type === 'GiftSub' && d.fromCommunitySubGift === true) return 'skip';
    const count = row.type === 'GiftSub' || row.type === 'GiftSubscription'
      ? 1
      : intOrNull(d.gifts ?? d.total ?? d.count ?? d.communitySubGiftCount ?? d.giftCount, 1);
    return count == null ? null : { user: alertUser(d.user, d.gifter), tier: tierOf(d), count };
  },
  'alert.raid': (d) => {
    const viewers = intOrNull(d.viewers, 0);
    return viewers == null ? null : { user: alertUser(d.raider, d.user, d.fromBroadcaster), viewers };
  },
  'alert.bits': (d) => {
    const amount = intOrNull(d.bits ?? d.amount, 1);
    return amount == null ? null : { user: alertUser(d.user), amount, message: msgOf(d) };
  },
  'alert.superchat': (d) => {
    const raw = d.amount ?? d.value;
    const amount = typeof raw === 'number' ? raw : num(String(raw ?? '').replace(/[^0-9.]/g, ''));
    const currency = firstStr(d.currencyCode, d.currency).toUpperCase();
    if (amount == null || !(amount > 0) || !/^[A-Z]{3}$/.test(currency)) return null;
    return { user: alertUser(d.user), amount, currency, message: msgOf(d) };
  },
  'alert.membership': (d) => {
    const out = { user: alertUser(d.user) };
    const tier = firstStr(d.levelName, d.tier, d.level);
    if (tier) out.tier = tier;
    const months = intOrNull(d.months ?? d.milestoneMonths ?? d.monthsSubscribed, 1);
    if (months != null) out.months = months;
    return out;
  },
  'alert.redemption': (d) => {
    const r = isObj(d.reward) ? d.reward : {};
    const reward = firstStr(r.title, r.name, d.rewardName, typeof d.reward === 'string' ? d.reward : '');
    if (!reward) return null;
    const out = { user: alertUser(d.user), reward, message: msgOf(d) };
    const cost = intOrNull(r.cost ?? d.cost, 0);
    if (cost != null) out.cost = cost;
    return out;
  },
};

/**
 * Map one Streamer.bot event envelope ({ event: {source, type}, data }) to an ingest input.
 * Returns { input } | { skip: reason } . Never keeps `data`.
 */
export function mapEvent(envelope) {
  const source = envelope?.event?.source;
  const type = envelope?.event?.type;
  if (typeof source !== 'string' || typeof type !== 'string') return { skip: 'no-event' };
  const row = findRow(source, type);
  if (!row) return { skip: 'unsubscribed' };
  const d = isObj(envelope.data) ? envelope.data : {};
  const base = { kind: row.kind, platform: row.platform, source: 'streamerbot' };

  if (row.kind === 'chat.message') {
    const f = chatFields(d);
    if (f.text.trim() === '') return { skip: 'empty-text' }; // legacy: empty text never fires
    return { input: { ...base, platformMessageId: chatMessageId(d), user: chatUser(d), ...f } };
  }
  const built = ALERT[row.kind](d, row);
  if (built === 'skip') return { skip: 'duplicate-of-bomb' };
  if (built == null) return { skip: 'unmapped' };
  const input = { ...base, platformMessageId: chatMessageId(d), ...built };
  for (const k of Object.keys(input)) if (input[k] === undefined) delete input[k];
  return { input };
}
