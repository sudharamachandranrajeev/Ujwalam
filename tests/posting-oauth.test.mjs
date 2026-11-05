// SPDX-License-Identifier: GPL-3.0-or-later
// P16b step 1 tests: services/posting/oauth.mjs. No test touches Google (plan rule) — a fake credential store
// and an injected `request` seam replace Credential Manager and the real token endpoint.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createYoutubeAuth, loopbackListener, makePkce, authUrl, OAuthError, SCOPE } from '../services/posting/oauth.mjs';

function fakeStore(initial = null) {
  let v = initial;
  return { get: async () => v, set: async (s) => { v = s; }, delete: async () => { const had = v !== null; v = null; return had; } };
}

test('makePkce: verifier/challenge/state are distinct, URL-safe, no padding', () => {
  const { verifier, challenge, state } = makePkce();
  for (const s of [verifier, challenge, state]) {
    assert.match(s, /^[A-Za-z0-9_-]+$/);
    assert.ok(!s.includes('='));
  }
  assert.notEqual(verifier, challenge);
  assert.notEqual(verifier, state);
  // deterministic source: same bytes -> same verifier and state
  let n = 0;
  const src = () => Buffer.alloc(32, ++n);
  const a = makePkce(src);
  n = 0;
  const b = makePkce(src);
  assert.equal(a.verifier, b.verifier);
  assert.equal(a.state, b.state);
});

test('authUrl: carries PKCE S256, offline access, consent prompt, and the given scope', () => {
  const u = new URL(authUrl({ clientId: 'c1', redirectUri: 'http://127.0.0.1:1/', challenge: 'ch', state: 'st' }));
  assert.equal(u.searchParams.get('client_id'), 'c1');
  assert.equal(u.searchParams.get('redirect_uri'), 'http://127.0.0.1:1/');
  assert.equal(u.searchParams.get('code_challenge'), 'ch');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('state'), 'st');
  assert.equal(u.searchParams.get('access_type'), 'offline');
  assert.equal(u.searchParams.get('scope'), SCOPE);
});

test('loopbackListener: binds 127.0.0.1 on a free port, resolves code+state from the redirect', async () => {
  const { port, redirectUri, result } = await loopbackListener({ timeoutMs: 5000 });
  assert.ok(port > 0);
  assert.equal(redirectUri, `http://127.0.0.1:${port}/`);
  const res = await fetch(`${redirectUri}?code=abc&state=xyz`);
  assert.equal(res.status, 200);
  const r = await result;
  assert.deepEqual(r, { code: 'abc', state: 'xyz' });
});

test('loopbackListener: an error redirect rejects with oauth-denied, never resolves', async () => {
  const { redirectUri, result } = await loopbackListener({ timeoutMs: 5000 });
  const p = result.catch((e) => e);
  await fetch(`${redirectUri}?error=access_denied`);
  const e = await p;
  assert.ok(e instanceof OAuthError);
  assert.equal(e.code, 'oauth-denied');
});

test('loopbackListener: times out if nothing arrives', async () => {
  const { result } = await loopbackListener({ timeoutMs: 30 });
  await assert.rejects(result, (e) => e.code === 'oauth-timeout');
});

test('signIn: full round trip with a mocked browser + token endpoint; refresh token goes to the store', async () => {
  const refreshStore = fakeStore();
  let openedUrl = null;
  let tokenCall = null;
  const auth = createYoutubeAuth({
    clientIdStore: fakeStore('client-123'),
    clientSecretStore: fakeStore('secret-abc'),
    refreshStore,
    now: () => 1_000_000,
    browserOpen: async (url) => {
      openedUrl = url;
      // Simulate the user completing consent: hit the loopback redirect with the matching state.
      const u = new URL(url);
      setTimeout(() => { fetch(`${u.searchParams.get('redirect_uri')}?code=authcode1&state=${u.searchParams.get('state')}`); }, 0);
    },
    request: async (url, form) => {
      tokenCall = { url, form };
      assert.equal(form.grant_type, 'authorization_code');
      assert.equal(form.code, 'authcode1');
      return { access_token: 'acc1', refresh_token: 'ref1', expires_in: 3600, scope: SCOPE };
    },
  });
  const r = await auth.signIn();
  assert.equal(r.scope, SCOPE);
  assert.match(openedUrl, /^https:\/\/accounts\.google\.com/);
  assert.equal(tokenCall.form.client_id, 'client-123');
  assert.equal(await refreshStore.get(), 'ref1');
  assert.equal(await auth.accessToken(), 'acc1'); // cached, no second token call needed
});

test('signIn: a state mismatch on the redirect is rejected, never stores a refresh token', async () => {
  const refreshStore = fakeStore();
  const auth = createYoutubeAuth({
    clientIdStore: fakeStore('c'), clientSecretStore: fakeStore('s'), refreshStore,
    browserOpen: async (url) => {
      const u = new URL(url);
      setTimeout(() => { fetch(`${u.searchParams.get('redirect_uri')}?code=x&state=WRONG`); }, 0);
    },
    request: async () => { throw new Error('must not reach the token endpoint'); },
  });
  await assert.rejects(auth.signIn(), (e) => e.code === 'oauth-state-mismatch');
  assert.equal(await refreshStore.get(), null);
});

test('signIn: no client id/secret set throws oauth-no-client before opening a browser', async () => {
  const auth = createYoutubeAuth({ clientIdStore: fakeStore(null), clientSecretStore: fakeStore(null), refreshStore: fakeStore(), browserOpen: async () => { throw new Error('must not open a browser'); } });
  await assert.rejects(auth.signIn(), (e) => e.code === 'oauth-no-client');
});

test('signIn: Google returning no refresh_token is a clear, specific error', async () => {
  const refreshStore = fakeStore();
  const auth = createYoutubeAuth({
    clientIdStore: fakeStore('c'), clientSecretStore: fakeStore('s'), refreshStore,
    browserOpen: async (url) => { const u = new URL(url); setTimeout(() => { fetch(`${u.searchParams.get('redirect_uri')}?code=x&state=${u.searchParams.get('state')}`); }, 0); },
    request: async () => ({ access_token: 'acc', expires_in: 3600 }), // no refresh_token
  });
  await assert.rejects(auth.signIn(), (e) => e.code === 'oauth-no-refresh-token');
  assert.equal(await refreshStore.get(), null);
});

test('accessToken: refreshes automatically when expired, using the stored refresh token', async () => {
  let t = 0;
  let refreshCalls = 0;
  const auth = createYoutubeAuth({
    clientIdStore: fakeStore('c'), clientSecretStore: fakeStore('s'), refreshStore: fakeStore('ref1'),
    now: () => t,
    request: async (url, form) => {
      assert.equal(form.grant_type, 'refresh_token');
      assert.equal(form.refresh_token, 'ref1');
      refreshCalls++;
      return { access_token: `acc${refreshCalls}`, expires_in: 3600 };
    },
  });
  assert.equal(await auth.accessToken(), 'acc1');
  assert.equal(refreshCalls, 1);
  assert.equal(await auth.accessToken(), 'acc1'); // still valid, cached
  assert.equal(refreshCalls, 1);
  t += 3600 * 1000; // past expiry
  assert.equal(await auth.accessToken(), 'acc2');
  assert.equal(refreshCalls, 2);
});

test('accessToken: a rejected refresh token raises oauth-reauth-needed, never a raw token-endpoint error', async () => {
  const auth = createYoutubeAuth({
    clientIdStore: fakeStore('c'), clientSecretStore: fakeStore('s'), refreshStore: fakeStore('stale-ref'),
    request: async () => { throw new Error('invalid_grant'); },
  });
  await assert.rejects(auth.accessToken(), (e) => e.code === 'oauth-reauth-needed');
});

test('accessToken: not signed in raises oauth-reauth-needed', async () => {
  const auth = createYoutubeAuth({ clientIdStore: fakeStore('c'), clientSecretStore: fakeStore('s'), refreshStore: fakeStore(null) });
  await assert.rejects(auth.accessToken(), (e) => e.code === 'oauth-reauth-needed');
});

test('status: reports signed-in and client-configured flags without ever exposing a secret', async () => {
  const auth = createYoutubeAuth({ clientIdStore: fakeStore('c'), clientSecretStore: fakeStore('s'), refreshStore: fakeStore('ref1') });
  assert.deepEqual(await auth.status(), { signedIn: true, hasClient: true });
});

test('status: signed out and no client', async () => {
  const auth = createYoutubeAuth({ clientIdStore: fakeStore(null), clientSecretStore: fakeStore(null), refreshStore: fakeStore(null) });
  assert.deepEqual(await auth.status(), { signedIn: false, hasClient: false });
});

test('signOut: deletes the stored refresh token and clears the cached access token', async () => {
  const refreshStore = fakeStore('ref1');
  const auth = createYoutubeAuth({
    clientIdStore: fakeStore('c'), clientSecretStore: fakeStore('s'), refreshStore,
    request: async () => ({ access_token: 'acc1', expires_in: 3600 }),
  });
  assert.equal(await auth.accessToken(), 'acc1');
  assert.equal(await auth.signOut(), true);
  assert.equal(await refreshStore.get(), null);
  await assert.rejects(auth.accessToken(), (e) => e.code === 'oauth-reauth-needed'); // no cache survives sign-out
});
