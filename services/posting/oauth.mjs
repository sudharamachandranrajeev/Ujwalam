// SPDX-License-Identifier: GPL-3.0-or-later
// P16b step 1: YouTube OAuth 2.0 for installed apps (PKCE, loopback redirect), token storage and refresh.
// Node stdlib only (`http`/`https`). Nothing here uploads a video (that's youtube.mjs). No googleapis package.
//
// Flow (docs/plan/2026-11-03-p16b-youtube-private-upload-plan.md, step 1):
//   1. signIn(): starts a one-shot loopback HTTP listener on 127.0.0.1:<random free port>, opens the system
//      browser at Google's consent page with PKCE (S256) and a random `state`, waits for the redirect, checks
//      `state`, exchanges the authorization `code` for tokens (access + refresh) at the token endpoint.
//   2. The refresh token goes to Windows Credential Manager (target REFRESH_TARGET) via createCredentialStore
//      (services/event-core/streamerbot/credential.mjs) — reused, not reimplemented. The access token stays in
//      memory only (accessToken()), never written to a file, log or argv.
//   3. accessToken() returns a cached access token, refreshing it first if missing or expired (opts.now is a
//      test seam). A refresh failure (revoked/expired refresh token) throws 'oauth-reauth-needed': the caller
//      tells the user to sign in again.
//   4. signOut() deletes the stored refresh token and clears the in-memory access token.
//
// Scope requested: https://www.googleapis.com/auth/youtube.upload only (plan step 1); plus youtube.readonly when the
// caller passes opts.scope = SCHEDULE_SCOPES (flag post-schedule on, D310 proposed). Client id/secret are read
// from Credential Manager (CLIENT_ID_TARGET/CLIENT_SECRET_TARGET) — set once by the user (plan "Needs from the
// user"), never hardcoded, never in this repo.
//
// Tests inject `endpoints` (authUrl/tokenUrl base) and a fake `browserOpen`/`httpRequest`, per the plan's rule
// "no test touches Google". See tests/posting-oauth.test.mjs.

import { randomBytes, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createCredentialStore } from '../event-core/streamerbot/credential.mjs';

export const SCOPE = 'https://www.googleapis.com/auth/youtube.upload';
// Optional second scope for scheduled posting (flag post-schedule, D310 proposed): read the channel's scheduled posts.
// Requested only when that flag is on (opts.scope = SCHEDULE_SCOPES); without it the default stays upload-only.
export const READONLY_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
export const SCHEDULE_SCOPES = `${SCOPE} ${READONLY_SCOPE}`;
export const REFRESH_TARGET = 'Ujwalam/posting/youtube-refresh';
export const CLIENT_ID_TARGET = 'Ujwalam/posting/youtube-client-id';
export const CLIENT_SECRET_TARGET = 'Ujwalam/posting/youtube-client-secret';
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const LOOPBACK_TIMEOUT_MS = 180_000; // 3 minutes to complete the browser consent flow
const EXPIRY_SKEW_MS = 60_000; // refresh 1 minute before the token's own expiry

export class OAuthError extends Error {
  constructor(code, message) { super(message ?? code); this.name = 'OAuthError'; this.code = code; }
}

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** PKCE S256 pair + a random state. Pure (given a random source), exported for tests. */
export function makePkce(randomSource = randomBytes) {
  const verifier = b64url(randomSource(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomSource(16));
  return { verifier, challenge, state };
}

/** Builds the Google consent URL. Pure. */
export function authUrl({ clientId, redirectUri, challenge, state, scope = SCOPE, base = GOOGLE_AUTH_URL }) {
  const q = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope,
    code_challenge: challenge, code_challenge_method: 'S256', state, access_type: 'offline', prompt: 'consent',
  });
  return `${base}?${q}`;
}

/** Minimal HTTPS JSON POST (form-encoded body), stdlib only. Test seam: opts.request replaces this. */
function tokenRequest(url, form, { request } = {}) {
  if (typeof request === 'function') return request(url, form);
  return new Promise((resolve, reject) => {
    import('node:https').then(({ request: httpsRequest }) => {
      const u = new URL(url);
      const body = new URLSearchParams(form).toString();
      const req = httpsRequest({
        hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let json; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { json = null; }
          if (res.statusCode !== 200 || !json) { reject(new OAuthError('token-endpoint-failed', `HTTP ${res.statusCode}`)); return; }
          resolve(json);
        });
      });
      req.on('error', (e) => reject(new OAuthError('token-endpoint-failed', e.message)));
      req.end(body);
    }, reject);
  });
}

/** One-shot loopback listener: resolves { code, state } from the redirect, or rejects on timeout/error/cancel.
 *  Serves a tiny HTML page so the browser tab shows something, then closes. Binds 127.0.0.1 only. */
export function loopbackListener({ timeoutMs = LOOPBACK_TIMEOUT_MS, signal } = {}) {
  let server;
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { try { server.close(); } catch { /* already closing */ } reject(new OAuthError('oauth-timeout', 'no redirect received in time')); }, timeoutMs);
    // signal (optional): the caller gave up (a cancelled sign-in); the listener closes at once instead of waiting.
    signal?.addEventListener('abort', () => { clearTimeout(timer); try { server.close(); } catch { /* already closing */ } reject(new OAuthError('oauth-cancelled', 'sign-in cancelled')); }, { once: true });
    server = createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/') { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      const err = u.searchParams.get('error');
      res.end(err ? '<html><body>Sign-in was not completed. You can close this tab.</body></html>'
        : '<html><body>Signed in. You can close this tab and return to Ujwalam.</body></html>');
      clearTimeout(timer);
      try { server.close(); } catch { /* best effort */ }
      if (err) { reject(new OAuthError('oauth-denied', err)); return; }
      const code = u.searchParams.get('code');
      const state = u.searchParams.get('state');
      if (!code || !state) { reject(new OAuthError('oauth-bad-redirect', 'missing code or state')); return; }
      resolve({ code, state });
    });
    server.on('error', (e) => { clearTimeout(timer); reject(new OAuthError('oauth-listener-failed', e.message)); });
  });
  result.catch(() => {}); // a cancel or time-out before the caller awaits it is not an unhandled rejection
  const ready = new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ port, redirectUri: `http://127.0.0.1:${port}/`, result });
    });
    server.once('error', reject);
  });
  return ready;
}

/**
 * opts: { clientIdStore?, clientSecretStore?, refreshStore?, browserOpen, now?, endpoints?: {authUrl, tokenUrl},
 *         request? } (test seams: *Store objects with get/set, browserOpen(url), now(), request(url, form))
 */
export function createYoutubeAuth(opts = {}) {
  const clientIdStore = opts.clientIdStore ?? createCredentialStore(CLIENT_ID_TARGET);
  const clientSecretStore = opts.clientSecretStore ?? createCredentialStore(CLIENT_SECRET_TARGET);
  const refreshStore = opts.refreshStore ?? createCredentialStore(REFRESH_TARGET);
  const now = opts.now ?? (() => Date.now());
  const endpoints = { authUrl: opts.endpoints?.authUrl ?? GOOGLE_AUTH_URL, tokenUrl: opts.endpoints?.tokenUrl ?? GOOGLE_TOKEN_URL };
  let access = null; // { token, expiresAt } — memory only, never persisted
  let granted = null; // the scopes Google says the token carries (token response `scope`), memory only
  const scope = typeof opts.scope === 'string' && opts.scope ? opts.scope : SCOPE;
  const noteScope = (tok) => { granted = typeof tok?.scope === 'string' && tok.scope.trim() ? tok.scope.trim().split(/\s+/) : null; };

  async function clientCreds() {
    const [id, secret] = await Promise.all([clientIdStore.get(), clientSecretStore.get()]);
    if (!id || !secret) throw new OAuthError('oauth-no-client', 'no OAuth client id/secret set (see the plan: "Needs from the user")');
    return { id, secret };
  }

  // signal (optional): aborting it closes the loopback listener and ends the sign-in (platform-connect cancel).
  async function signIn({ signal } = {}) {
    const { id: clientId, secret: clientSecret } = await clientCreds();
    if (signal?.aborted) throw new OAuthError('oauth-cancelled', 'sign-in cancelled');
    const { port, redirectUri, result } = await loopbackListener({ signal });
    const { verifier, challenge, state } = makePkce();
    const url = authUrl({ clientId, redirectUri, challenge, state, scope, base: endpoints.authUrl });
    if (typeof opts.browserOpen !== 'function') throw new OAuthError('oauth-no-browser-opener', 'opts.browserOpen is required');
    await opts.browserOpen(url);
    const { code, state: gotState } = await result;
    if (gotState !== state) throw new OAuthError('oauth-state-mismatch', 'the redirect state did not match (possible interference)');
    const tok = await tokenRequest(endpoints.tokenUrl, {
      client_id: clientId, client_secret: clientSecret, code, code_verifier: verifier, redirect_uri: redirectUri, grant_type: 'authorization_code',
    }, opts);
    if (!tok.refresh_token) throw new OAuthError('oauth-no-refresh-token', 'Google did not return a refresh token (try signing out of the OAuth app in Google Account settings, then sign in again)');
    await refreshStore.set(tok.refresh_token);
    access = { token: tok.access_token, expiresAt: now() + (Number(tok.expires_in) || 3600) * 1000 };
    noteScope(tok);
    return { port, scope: tok.scope ?? scope };
  }

  async function refresh() {
    const refreshToken = await refreshStore.get();
    if (!refreshToken) throw new OAuthError('oauth-reauth-needed', 'not signed in');
    const { id: clientId, secret: clientSecret } = await clientCreds();
    let tok;
    try {
      tok = await tokenRequest(endpoints.tokenUrl, { client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }, opts);
    } catch {
      throw new OAuthError('oauth-reauth-needed', 'the refresh token was rejected; sign in again');
    }
    access = { token: tok.access_token, expiresAt: now() + (Number(tok.expires_in) || 3600) * 1000 };
    noteScope(tok);
    return access.token;
  }

  /** The scopes the current token carries (array), or null when Google did not say (callers then fail closed).
   *  Refreshes first when needed, so this reflects the stored sign-in, not a guess. */
  async function grantedScopes() {
    await accessToken();
    return granted ? [...granted] : null;
  }

  async function accessToken() {
    if (access && access.expiresAt - EXPIRY_SKEW_MS > now()) return access.token;
    return refresh();
  }

  async function status() {
    const signedIn = (await refreshStore.get()) !== null;
    return { signedIn, hasClient: Boolean((await clientIdStore.get()) && (await clientSecretStore.get())) };
  }

  async function signOut() {
    access = null; granted = null;
    return refreshStore.delete();
  }

  return { signIn, accessToken, grantedScopes, status, signOut };
}
