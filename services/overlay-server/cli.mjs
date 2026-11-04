// SPDX-License-Identifier: GPL-3.0-or-later
// Run the overlay server as its own process.
//   node services/overlay-server/cli.mjs [--no-guards] [--root <dir>] [--port 8787] [--feed-port 8788] [--events-url http://127.0.0.1:<port>/events]
// root defaults to ./legacy (the legacy overlay folder, read-only). The event-core API token comes from the
// environment (UJWALAM_EVENT_CORE_API_TOKEN) and is used only for the one request to --events-url. Without
// --events-url the server runs with no event source (static files and the feed only).
// No feature flags here: chat-fired effects and the cam-pop rule stay off (flag chat-effects, D204). The studio's
// overlay child (app/host/overlay/child.mjs) reads the flags live.
import path from 'node:path';
import { createOverlayServer, createRemoteBus } from './index.mjs';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : fallback; };
const root = path.resolve(arg('root', 'legacy'));
const eventsUrl = arg('events-url', '');
const token = process.env.UJWALAM_EVENT_CORE_API_TOKEN ?? '';

if (eventsUrl && !/^[0-9a-f]{64}$/.test(token)) {
  console.error('overlay-server: --events-url needs UJWALAM_EVENT_CORE_API_TOKEN (64 hex) in the environment');
  process.exit(2);
}
const bus = eventsUrl ? createRemoteBus({ url: eventsUrl, token, kinds: ['chat.', 'alert.'], log: (l) => console.warn(`overlay-server: ${l}`) }) : undefined;
const s = createOverlayServer({ root, bus, guards: !process.argv.includes('--no-guards'), staticPort: Number(arg('port', 8787)), feedPort: Number(arg('feed-port', 8788)) });
const { staticPort, feedPort } = await s.start();
console.log(`overlay-server: overlays at http://127.0.0.1:${staticPort}/overlays/<name>/index.html, feed ws://127.0.0.1:${feedPort}/ (effects) and /display`);
console.log(`overlay-server: relay page http://127.0.0.1:${staticPort}/_ujwalam/relay.html?feed=${feedPort}`);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { s.stop().finally(() => process.exit(0)); });
