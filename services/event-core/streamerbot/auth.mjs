// SPDX-License-Identifier: GPL-3.0-or-later
// Streamer.bot WebSocket Authenticate handshake (P3 E2). Node stdlib only.
//
// Source: https://docs.streamer.bot/api/websocket/guide/authentication (read 2026-10-28).
//   secret = base64(SHA256(password + salt))
//   auth   = base64(SHA256(secret + challenge))
// salt and challenge arrive in the Hello message's `authentication` object. The hashes are over the UTF-8
// bytes of the concatenated strings (the docs say "SHA-256 binary hash"); UNVERIFIED against a real server
// with auth on, so the mock uses the same function and a real check is part of the user's stream step.

import { createHash } from 'node:crypto';

const sha256b64 = (s) => createHash('sha256').update(s, 'utf8').digest('base64');

export function computeAuth(password, salt, challenge) {
  return sha256b64(sha256b64(String(password) + String(salt)) + String(challenge));
}
