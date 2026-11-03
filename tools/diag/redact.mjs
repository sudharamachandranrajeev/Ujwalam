// SPDX-License-Identifier: GPL-2.0-or-later
// Redaction for the diagnostics bundle (tools/diag/bundle.mjs). Applied to every text that goes into the bundle.
//   makeRedactor({ home, userName, profile }) -> (text) => text
// Rules, in order:
//   1. the user's home dir (any case, \ or / or JSON-escaped \\) -> %USERPROFILE%; the bare user name -> <user>
//   2. every string value of the profile (brand, channel names, IGN and variants, paths ...; placeholders skipped):
//      the literal value, then its letters/digits with up to one separator between them, -> <profile-term>
//   3. URLs: rtmp/rtmps/srt/rist -> scheme://<redacted>; any query string -> ?<redacted>; user:pass@ -> <redacted>@
//   4. secrets: Bearer values, key/token/secret/password/authorization assignments, Twitch live_ keys, Kick sk_
//      keys, YouTube-style dashed keys, hex runs of 32+ chars, base64-like runs of 40+ chars
//   5. chat and free text: JSON string fields named text/message/msg/note/body/content/comment/user/userName/
//      username/displayName/login/author/title -> "<redacted>"
export const RULES = Object.freeze([
  'home dir -> %USERPROFILE%; user name -> <user>',
  'profile string values (literal and separator variants) -> <profile-term>',
  'rtmp/rtmps/srt/rist URLs -> <redacted>; query strings and URL credentials -> <redacted>',
  'Bearer values, key/token/secret/password/authorization values, stream-key shapes, hex >= 32, base64-like >= 40 -> <redacted>',
  'JSON fields text/message/msg/note/body/content/comment/user/userName/username/displayName/login/author/title -> <redacted>',
]);

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function profileStrings(node, out = []) {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) for (const v of node) profileStrings(v, out);
  else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) { if (k !== '$comment' && k !== 'version') profileStrings(v, out); }
  return out;
}

function homeVariants(home) {
  const h = home.replace(/[\\/]+$/, '');
  const back = h.replace(/\//g, '\\');
  const fwd = back.replace(/\\/g, '/');
  return [...new Set([back.replace(/\\/g, '\\\\'), back, fwd])].sort((a, b) => b.length - a.length);
}

export function makeRedactor({ home, userName, profile } = {}) {
  const steps = [];
  if (home && home.length >= 4) for (const v of homeVariants(home)) steps.push([new RegExp(esc(v), 'gi'), '%USERPROFILE%']);
  const terms = profile ? profileStrings(profile).map((s) => s.trim()).filter((s) => s && !/^<.*>$/s.test(s)) : [];
  const literal = [...new Set(terms)].filter((s) => s.length >= 3).sort((a, b) => b.length - a.length);
  for (const t of literal) {
    steps.push([new RegExp(esc(t), 'gi'), '<profile-term>']);
    if (/[\\/]/.test(t)) for (const v of homeVariants(t)) steps.push([new RegExp(esc(v), 'gi'), '<profile-term>']);
  }
  for (const t of literal) {
    const core = [...t.normalize('NFKC').toLowerCase()].filter((c) => /[\p{L}\p{N}]/u.test(c));
    if (core.length < 3 || core.length > 64) continue;
    steps.push([new RegExp(`(?<![\\p{L}\\p{N}])${core.map(esc).join('[^\\p{L}\\p{N}\\s]?')}(?![\\p{L}\\p{N}])`, 'giu'), '<profile-term>']);
  }
  if (userName && userName.length >= 3) steps.push([new RegExp(`(?<![\\p{L}\\p{N}])${esc(userName)}(?![\\p{L}\\p{N}])`, 'giu'), '<user>']);
  steps.push(
    [/\b(rtmps?|srt|rist):\/\/[^\s"'<>]+/gi, '$1://<redacted>'],
    [/\b(https?:\/\/)[^\s/"'<>@]+@/gi, '$1<redacted>@'],
    [/(https?:\/\/[^\s"'<>?]+)\?[^\s"'<>]*/gi, '$1?<redacted>'],
    [/\bBearer\s+[^\s"',;]+/gi, 'Bearer <redacted>'],
    [/(?<![A-Za-z])((?:stream[_-]?key|api[_-]?key|key|token|secret|password|passwd|authorization|cookie)["']?\s*[:=]\s*["']?)[^"'\s,;}&]+/gi, '$1<redacted>'],
    [/\blive_\d+_[A-Za-z0-9]+/g, '<redacted-key>'],
    [/\bsk_[A-Za-z0-9_]{8,}/g, '<redacted-key>'],
    [/\b[a-z0-9]{4}(?:-[a-z0-9]{4}){3,4}\b/gi, '<redacted-key>'],
    [/\b[0-9a-f]{32,}\b/gi, '<hex>'],
    // Standard base64 includes '/'; a run with '/' is a blob only if it mixes digits and both cases (plain paths stay readable).
    [/[A-Za-z0-9+/_-]{40,}={0,2}/g, (m) => (!m.includes('/') || (/\d/.test(m) && /[A-Z]/.test(m) && /[a-z]/.test(m)) ? '<blob>' : m)],
    [/("(?:text|message|msg|note|body|content|comment|user|userName|username|displayName|login|author|title)"\s*:\s*)"(?:[^"\\]|\\.)*"/g, '$1"<redacted>"'],
  );
  return (text) => {
    let s = String(text);
    for (const [re, to] of steps) s = s.replace(re, to);
    return s;
  };
}
