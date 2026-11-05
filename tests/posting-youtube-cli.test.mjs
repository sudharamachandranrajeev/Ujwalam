// SPDX-License-Identifier: GPL-3.0-or-later
// P16b step 3 tests: services/posting/cli.mjs `youtube` subcommands. Every network/browser/host dependency is
// injected via the `deps` param (main's 4th arg) -- no test touches Google, a browser, or a running host.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { main as cli, EXIT_FLAG_OFF } from '../services/posting/cli.mjs';
import { POSTING_FLAG, LEDGER_NAME, createLedger } from '../services/posting/index.mjs';

const tmp = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-yt-cli-')); tmp.push(d); return d; };
after(() => { for (const d of tmp) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });
const quiet = () => {};
function flagOn(data) { writeFileSync(path.join(data, 'flags.local.json'), JSON.stringify({ flags: { [POSTING_FLAG]: true } })); }

function fakeAuth(overrides = {}) {
  return { signIn: async () => ({ scope: 'x' }), status: async () => ({ signedIn: true, hasClient: true }), signOut: async () => true, accessToken: async () => 'tok', ...overrides };
}

test('youtube: unknown subcommand is a usage error (exit 2), posting-flag gate still applies first', async () => {
  const data = mk();
  const lines = [];
  assert.equal(await cli(['youtube', 'bogus'], quiet, (s) => lines.push(s), { createYoutubeAuth: () => fakeAuth(), outputsStatus: async () => ({ sinks: [] }) }), EXIT_FLAG_OFF);
  flagOn(data);
  const lines2 = [];
  assert.equal(await cli(['youtube', 'bogus', '--data-dir', data], quiet, (s) => lines2.push(s), { createYoutubeAuth: () => fakeAuth() }), 2);
});

test('youtube signin/status/signout: call through to the injected auth, print a plain confirmation', async () => {
  const data = mk(); flagOn(data);
  let signedIn = false, signedOut = false;
  const auth = fakeAuth({ signIn: async () => { signedIn = true; return { scope: 'upload' }; }, signOut: async () => { signedOut = true; return true; } });
  const lines = [];
  assert.equal(await cli(['youtube', 'signin', '--data-dir', data], (s) => lines.push(s), quiet, { createYoutubeAuth: () => auth }), 0);
  assert.ok(signedIn);
  assert.match(lines[0], /signed in/);
  assert.equal(await cli(['youtube', 'status', '--data-dir', data], (s) => lines.push(s), quiet, { createYoutubeAuth: () => auth }), 0);
  assert.match(lines[1], /signed in: true/);
  assert.equal(await cli(['youtube', 'signout', '--data-dir', data], (s) => lines.push(s), quiet, { createYoutubeAuth: () => auth }), 0);
  assert.ok(signedOut);
});

test('youtube signin: a missing OAuth client gives a clear one-line error, not a stack trace', async () => {
  const data = mk(); flagOn(data);
  const errs = [];
  const auth = fakeAuth({ signIn: async () => { const e = new Error('no client'); e.code = 'oauth-no-client'; throw e; } });
  assert.equal(await cli(['youtube', 'signin', '--data-dir', data], quiet, (s) => errs.push(s), { createYoutubeAuth: () => auth }), 1);
  assert.match(errs[0], /no OAuth client set/);
});

test('youtube upload: end-to-end with a fully injected upload (no network, no host)', async () => {
  const data = mk(); flagOn(data);
  const runDir = mk();
  mkdirSync(path.join(runDir, 'posts', 'c01', 'youtube-shorts'), { recursive: true });
  const videoFile = path.join(runDir, 'posts', 'c01', 'youtube-shorts', 'full-crop.mp4');
  writeFileSync(videoFile, Buffer.from('fake-mp4-bytes'));
  const sha = createHash('sha256').update(readFileSync(videoFile)).digest('hex');
  const postDir = path.dirname(videoFile);
  const post = { target: 'youtube-shorts', status: 'approved', title: 't', description: 'd', tags: [], hashtags: [], unresolved: [], video: { file: 'full-crop.mp4' }, source: { sha256: sha, clipId: 'c01' } };
  writeFileSync(path.join(postDir, 'post.json'), JSON.stringify(post));
  const ledgerFile = path.join(data, 'posting', LEDGER_NAME);
  mkdirSync(path.dirname(ledgerFile), { recursive: true });
  createLedger(ledgerFile).put({ sha256: sha, target: 'youtube-shorts', status: 'approved', dir: postDir, clipId: 'c01', createdAt: 't0', updatedAt: 't0' });
  const id = `${sha.slice(0, 16)}.youtube-shorts`;

  let uploadedWith = null;
  const auth = fakeAuth();
  const lines = [];
  const r = await cli(['youtube', 'upload', '--id', id, '--data-dir', data], (s) => lines.push(s), quiet, {
    createYoutubeAuth: () => auth,
    outputsStatus: async () => ({ sinks: [] }),
    fetchImpl: async (url, opts) => {
      uploadedWith = uploadedWith ?? { count: 0 };
      uploadedWith.count++;
      if (String(url).includes('uploadType=resumable')) return { ok: true, status: 200, headers: { get: (k) => (k.toLowerCase() === 'location' ? 'https://upload.example/s' : null) }, json: async () => ({}) };
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ id: 'VIDZZZ' }) };
    },
  });
  assert.equal(r, 0, lines.join('|'));
  assert.match(lines[0], /uploaded .* as VIDZZZ/);
  assert.equal(createLedger(ledgerFile).get(sha, 'youtube-shorts').status, 'uploaded');
});

test('youtube upload: unknown post id is a clear error, never touches the network', async () => {
  const data = mk(); flagOn(data);
  const errs = [];
  const r = await cli(['youtube', 'upload', '--id', '0000000000000000.youtube-shorts', '--data-dir', data], quiet, (s) => errs.push(s), {
    createYoutubeAuth: () => fakeAuth(), fetchImpl: async () => { throw new Error('must not call the network'); },
  });
  assert.equal(r, 1);
  assert.match(errs[0], /unknown post id/);
});
