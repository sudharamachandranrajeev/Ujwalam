#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// hostctl: call one ujwalam-host JSON-RPC method and print the result.
//   node app/host/tools/hostctl.mjs [--discovery <host.json>] <method> [params-json]
// The discovery file defaults to the one app/host/lib/config.mjs resolves. The token comes from the discovery
// file, or from UJWALAM_HOST_TOKEN when the launcher passed it by environment.
import { HostClient } from '../lib/client.mjs';
import { resolveConfig } from '../lib/config.mjs';

const argv = process.argv.slice(2);
let discovery;
const rest = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--discovery') discovery = argv[++i];
  else rest.push(argv[i]);
}
const [method, paramsText] = rest;
if (!method) {
  console.error('usage: hostctl [--discovery <host.json>] <method> [params-json]');
  process.exit(64);
}
const cfg = resolveConfig({ discovery });
const client = HostClient.fromDiscovery(cfg.discovery, process.env.UJWALAM_HOST_TOKEN || undefined);
try {
  const result = await client.call(method, paramsText ? JSON.parse(paramsText) : {});
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  console.error(`error ${e.code ?? ''}: ${e.message}`);
  process.exit(1);
}
