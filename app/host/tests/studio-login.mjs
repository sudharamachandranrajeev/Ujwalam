// SPDX-License-Identifier: GPL-3.0-or-later
// Scripted "browser" for host-studio-launch.test.mjs (not a test file itself). The launcher runs it, headless, as
// UJWALAM_BROWSER=<node> UJWALAM_BROWSER_ARGS="<this file> <out.json>" with the one-time login URL as the last argument.
// It does the same GET /login the browser does and writes { port, cookie, status } to <out.json> for the test.
// The session cookie lives only in that test temp file (deleted with the test data dir); nothing is printed.
import http from 'node:http';
import { writeFileSync } from 'node:fs';

const [outFile, url] = process.argv.slice(2);
const u = new URL(url);
http.get(url, (res) => {
  const set = res.headers['set-cookie'];
  const cookie = Array.isArray(set) && set[0] ? set[0].split(';')[0] : null;
  res.resume();
  writeFileSync(outFile, JSON.stringify({ port: Number(u.port), cookie, status: res.statusCode }));
}).on('error', (e) => writeFileSync(outFile, JSON.stringify({ port: Number(u.port), cookie: null, status: 0, error: e.code ?? 'error' })));
