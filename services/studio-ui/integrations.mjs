// SPDX-License-Identifier: GPL-3.0-or-later
// Settings > Integrations (D327 IN1): the Streamer.bot and Speaker.bot WebSocket ports and "Allow remote connections",
// kept in <dataDir>/integrations.json. Read by the UI server (page, Test button) and by launch.mjs at the next start
// (event core --url for Streamer.bot, --lan for remote connections). No secret is ever stored here: the remote pairing
// token is made fresh by the launcher for each run and lives only in the processes' memory.
//
//   { version: 1, bots: { streamerbot: { port }, speakerbot: { port } }, remote: { enabled: false, address: null } }
//
// Bots run on this PC: the address is always 127.0.0.1 (bots/index.mjs parseWs refuses anything else, and the
// Streamer.bot connector stays read-only). remote.address: null = the first private LAN address; otherwise one private
// IPv4 address of this machine (checked again when the listener starts, lan-remote.mjs).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BOTS, DEFAULT_WS } from '../bots/index.mjs';
import { isPrivateIPv4 } from '../common/lan-remote.mjs';

export const INTEGRATIONS_FILE = 'integrations.json';
export const BOT_ADDRESS = '127.0.0.1';

const portOf = (ws) => { try { return Number(new URL(ws).port); } catch { return null; } };

/** Defaults: the bot ports from the profile's bot config (loadBotConfig) or the bots' defaults; remote off. */
export function defaults(botConfig = {}) {
  const bots = {};
  for (const b of BOTS) bots[b] = { port: Number.isInteger(botConfig[b]?.port) ? botConfig[b].port : portOf(DEFAULT_WS[b]) };
  return { version: 1, bots, remote: { enabled: false, address: null } };
}

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

export function integrationsProblems(s) {
  const out = [];
  if (!isObj(s)) return [{ field: '', message: 'integrations must be an object' }];
  for (const k of Object.keys(s)) if (!['version', 'bots', 'remote'].includes(k)) out.push({ field: k, message: `unknown setting "${k}"` });
  if (s.version !== 1) out.push({ field: 'version', message: 'version must be 1' });
  if (!isObj(s.bots)) out.push({ field: 'bots', message: 'bots must be an object' });
  else {
    for (const k of Object.keys(s.bots)) if (!BOTS.includes(k)) out.push({ field: `bots.${k}`, message: `unknown bot "${k}"` });
    for (const b of BOTS) {
      const v = s.bots[b];
      if (!isObj(v) || Object.keys(v).some((k) => k !== 'port')) { out.push({ field: `bots.${b}`, message: `${b}: give the port only (the address is always ${BOT_ADDRESS}, this PC)` }); continue; }
      if (!Number.isInteger(v.port) || v.port < 1024 || v.port > 65535) out.push({ field: `bots.${b}.port`, message: `${b}: the port must be a whole number from 1024 to 65535` });
    }
    if (isObj(s.bots.streamerbot) && isObj(s.bots.speakerbot) && s.bots.streamerbot.port === s.bots.speakerbot.port) out.push({ field: 'bots', message: 'Streamer.bot and Speaker.bot need different ports' });
  }
  if (!isObj(s.remote)) out.push({ field: 'remote', message: 'remote must be an object' });
  else {
    for (const k of Object.keys(s.remote)) if (!['enabled', 'address'].includes(k)) out.push({ field: `remote.${k}`, message: `unknown setting "${k}"` });
    if (typeof s.remote.enabled !== 'boolean') out.push({ field: 'remote.enabled', message: 'remote connections must be on or off' });
    if (s.remote.address !== null && !isPrivateIPv4(s.remote.address)) out.push({ field: 'remote.address', message: 'the address must be a private LAN address of this PC (10.x, 172.16-31.x or 192.168.x), never 0.0.0.0 or a public address' });
  }
  return out;
}

/** The stored integrations (or the defaults; { exists }). A corrupt file falls back to the defaults with remote OFF. */
export function readIntegrations(dataDir, botConfig) {
  const f = path.join(dataDir, INTEGRATIONS_FILE);
  const d = defaults(botConfig);
  if (!existsSync(f)) return { exists: false, value: d };
  try {
    const { $comment, ...v } = JSON.parse(readFileSync(f, 'utf8'));
    if (integrationsProblems(v).length) return { exists: true, value: d, corrupt: true };
    return { exists: true, value: v };
  } catch { return { exists: true, value: d, corrupt: true }; }
}

export function writeIntegrations(dataDir, value) {
  const problems = integrationsProblems(value);
  if (problems.length) return { ok: false, problems };
  mkdirSync(dataDir, { recursive: true });
  const f = path.join(dataDir, INTEGRATIONS_FILE);
  writeFileSync(`${f}.tmp`, JSON.stringify({ $comment: 'Ujwalam integrations (Settings > Integrations, D327). Used at the next start. No secrets here.', ...value }, null, 2));
  renameSync(`${f}.tmp`, f);
  return { ok: true, problems: [], value };
}

export const botUrl = (port) => `ws://${BOT_ADDRESS}:${port}/`;

/** The settings a start uses: the stored ones with the `integrations` flag on, else the profile's bot ports and remote
 *  off (the behaviour before D327). */
export function integrationsInEffect(dataDir, botConfig, flagOn) {
  if (!flagOn || typeof dataDir !== 'string') return defaults(botConfig);
  return readIntegrations(dataDir, botConfig).value;
}
