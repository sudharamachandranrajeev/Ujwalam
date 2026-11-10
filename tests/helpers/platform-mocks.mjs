// SPDX-License-Identifier: GPL-3.0-or-later
// Loopback mocks of Google OAuth + YouTube Live Streaming API and of Twitch (device flow, validate, Helix streams/key,
// ingests, revoke) for the platform sign-in tests (D327). 127.0.0.1 only; nothing reaches a real platform.
// Every secret value here is a made-up test marker; the leak tests search for them in responses, files and logs.
import { createHash } from 'node:crypto';
import http from 'node:http';

export const SECRETS = Object.freeze({
  ytKeyH: 'zq7h-yt01-mock-hkey-0001',
  ytKeyNew: 'zq7h-yt02-mock-nkey-0002',
  googleRefresh: '1//0mockGoogleRefreshTokenZZ9xx',
  googleAccess: 'ya29.mockGoogleAccessTokenZZ9',
  googleClientSecret: 'GOCSPX-mockClientSecretZZ9', // lint-allow: secret (a made-up test marker, not a credential)
  twitchKey: 'live_123456789_MockTwitchStreamKeyZZ9',
  twitchAccess: 'mocktwitchaccesstokenzz9a1b2cd',
  twitchRefresh: 'mocktwitchrefreshtokenzz9q8w7',
  twitchRefresh2: 'mocktwitchrefreshrotatedzz9k5',
  deviceCode: 'mockDeviceCodeZZ9secret',
  kickKey: 'sk_us-west-2_MockKickKeyZZ9abcdef',
  kickServer: 'rtmps://zz9-mock-ingest.example.net:443/app',
});

const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function startPlatformMock(opts = {}) {
  const st = {
    requests: [], // { method, path, auth, form, json }
    challenge: null, // the PKCE challenge seen on the consent URL (set by the test's browser)
    googleScope: opts.googleScope ?? 'https://www.googleapis.com/auth/youtube',
    googleRefreshValid: true,
    twitchPendingPolls: opts.twitchPendingPolls ?? 1,
    twitchRefreshValid: true,
    twitchDeny: false,
    streams: [
      { id: 'stream-h', snippet: { title: 'Default stream key' }, cdn: { ingestionType: 'rtmp', resolution: 'variable', frameRate: 'variable', ingestionInfo: { streamName: SECRETS.ytKeyH, rtmpsIngestionAddress: 'rtmps://a.rtmps.youtube.com/live2' } }, contentDetails: { isReusable: true } },
      { id: 'stream-hls', snippet: { title: 'HLS one' }, cdn: { ingestionType: 'hls', ingestionInfo: { streamName: 'hls-not-used-zz9' } } },
    ],
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const u = new URL(req.url, 'http://127.0.0.1');
      const ct = String(req.headers['content-type'] ?? '');
      const form = ct.startsWith('application/x-www-form-urlencoded') ? Object.fromEntries(new URLSearchParams(raw)) : null;
      let json = null; if (ct.startsWith('application/json')) { try { json = JSON.parse(raw); } catch { json = null; } }
      st.requests.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), auth: req.headers.authorization ?? null, clientId: req.headers['client-id'] ?? null, form, json });
      const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      // ---- Google ----
      if (u.pathname === '/google/token' && req.method === 'POST') {
        if (form.grant_type === 'authorization_code') {
          const ok = form.code === 'mock-auth-code' && st.challenge && b64url(createHash('sha256').update(form.code_verifier ?? '').digest()) === st.challenge && form.client_secret === SECRETS.googleClientSecret;
          if (!ok) return send(400, { error: 'invalid_grant' });
          return send(200, { access_token: SECRETS.googleAccess, refresh_token: SECRETS.googleRefresh, expires_in: 3600, scope: st.googleScope });
        }
        if (form.grant_type === 'refresh_token') {
          if (!st.googleRefreshValid || form.refresh_token !== SECRETS.googleRefresh) return send(400, { error: 'invalid_grant' });
          return send(200, { access_token: SECRETS.googleAccess, expires_in: 3600, scope: st.googleScope });
        }
        return send(400, { error: 'unsupported_grant_type' });
      }
      if (u.pathname === '/yt/liveStreams') {
        if (req.headers.authorization !== `Bearer ${SECRETS.googleAccess}`) return send(401, { error: { code: 401 } });
        if (req.method === 'GET') {
          const id = u.searchParams.get('id');
          return send(200, { items: id ? st.streams.filter((s) => s.id === id) : st.streams });
        }
        if (req.method === 'POST') {
          const s = { id: 'stream-new', snippet: json.snippet, cdn: { ...json.cdn, ingestionInfo: { streamName: SECRETS.ytKeyNew, rtmpsIngestionAddress: 'rtmps://a.rtmps.youtube.com/live2' } }, contentDetails: json.contentDetails };
          st.streams.push(s);
          return send(200, s);
        }
      }
      // ---- Twitch ----
      if (u.pathname === '/twitch/device' && req.method === 'POST') {
        if (form.client_id !== 'mocktwitchclientid0000000000zz') return send(400, { status: 400, message: 'invalid client' });
        return send(200, { device_code: SECRETS.deviceCode, user_code: 'ABCDEFGH', verification_uri: `http://127.0.0.1:${server.address().port}/activate?device-code=ABCDEFGH`, expires_in: 1800, interval: 1 });
      }
      if (u.pathname === '/twitch/token' && req.method === 'POST') {
        if (form.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
          if (form.device_code !== SECRETS.deviceCode) return send(400, { status: 400, message: 'invalid device code' });
          if (st.twitchDeny) return send(400, { status: 400, message: 'access_denied' });
          if (st.twitchPendingPolls > 0) { st.twitchPendingPolls--; return send(400, { status: 400, message: 'authorization_pending' }); }
          return send(200, { access_token: SECRETS.twitchAccess, refresh_token: SECRETS.twitchRefresh, expires_in: 14000, scope: ['channel:read:stream_key'], token_type: 'bearer' });
        }
        if (form.grant_type === 'refresh_token') {
          if (!st.twitchRefreshValid || ![SECRETS.twitchRefresh, SECRETS.twitchRefresh2].includes(form.refresh_token)) return send(400, { status: 400, message: 'Invalid refresh token' });
          return send(200, { access_token: SECRETS.twitchAccess, refresh_token: SECRETS.twitchRefresh2, expires_in: 14000, scope: ['channel:read:stream_key'] });
        }
      }
      if (u.pathname === '/twitch/validate') {
        if (req.headers.authorization !== `OAuth ${SECRETS.twitchAccess}`) return send(401, { status: 401 });
        return send(200, { client_id: 'mocktwitchclientid0000000000zz', login: 'placeholder', user_id: '424242', scopes: ['channel:read:stream_key'], expires_in: 14000 });
      }
      if (u.pathname === '/twitch/revoke') return send(200, {});
      if (u.pathname === '/helix/streams/key') {
        if (req.headers.authorization !== `Bearer ${SECRETS.twitchAccess}` || req.headers['client-id'] !== 'mocktwitchclientid0000000000zz' || u.searchParams.get('broadcaster_id') !== '424242') return send(401, { status: 401 });
        return send(200, { data: [{ stream_key: SECRETS.twitchKey }] });
      }
      if (u.pathname === '/ingests') return send(200, { ingests: [{ name: 'Other', default: false, url_template: 'rtmp://other.contribute.live-video.net/app/{stream_key}' }, { name: 'Default', default: true, url_template: 'rtmp://zz9.contribute.live-video.net/app/{stream_key}', url_template_secure: 'rtmps://zz9.contribute.live-video.net/app/{stream_key}' }] });
      return send(404, { error: 'not-found' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const endpoints = {
    googleAuth: `${base}/google/auth`, googleToken: `${base}/google/token`, youtubeApi: `${base}/yt`,
    twitchDevice: `${base}/twitch/device`, twitchToken: `${base}/twitch/token`, twitchValidate: `${base}/twitch/validate`,
    twitchRevoke: `${base}/twitch/revoke`, helix: `${base}/helix`, twitchIngests: `${base}/ingests`,
  };
  return { st, base, endpoints, close: () => new Promise((r) => server.close(r)) };
}

/** A "browser" for the Google loopback flow: records the consent URL's challenge, then calls the redirect. */
export function googleBrowser(mock, { state = null, code = 'mock-auth-code', deny = false } = {}) {
  const opened = [];
  const open = async (url) => {
    opened.push(url);
    const u = new URL(url);
    if (u.origin === mock.base && u.pathname === '/google/auth') {
      mock.st.challenge = u.searchParams.get('code_challenge');
      const redirect = new URL(u.searchParams.get('redirect_uri'));
      if (deny) redirect.searchParams.set('error', 'access_denied');
      else { redirect.searchParams.set('code', code); redirect.searchParams.set('state', state ?? u.searchParams.get('state')); }
      setImmediate(() => { http.get(redirect, (r) => r.resume()).on('error', () => {}); });
    }
  };
  open.opened = opened;
  return open;
}
