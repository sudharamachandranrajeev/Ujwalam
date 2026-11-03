// SPDX-License-Identifier: GPL-2.0-or-later
// Repo lint (P3 E0). Stdlib only. Usage: node tools/lint.mjs [--root dir] [--rules a,b] [file ...]
// Scope: `git ls-files` plus untracked-not-ignored files, so gitignored paths (legacy/, node_modules/,
// out/) are never linted. Files that .gitattributes marks binary (or that hold a NUL byte) are skipped.
// Finding format: "path:line: rule: message". Exit 1 if any finding.
//
// Rules: syntax-js, syntax-py, eol, trailing-ws, spdx, secret, user-path, hidden-window.
// An allow marker (the word lint-allow, a colon, then a rule id) on a line silences that rule on that line.
// Only secret and user-path honour markers. A bare marker, an unknown rule id, or a rule that does not
// support markers is itself a finding (rule "lint-allow"). The secret marker is accepted only in test
// files (under tests/). Every marker found is returned and printed, even when lint passes.
// The machine's own user name (data/profile.local.json paths.windows_user, os.userInfo()) is never
// allowed in a path, marker or not, and is never printed.
//
// Line endings: .gitattributes decides. A file whose pattern has eol=crlf must be all CRLF, one with
// eol=lf (the default rule here) all LF. Because those attributes are explicit, git ignores
// core.autocrlf for them, so the working-tree bytes are checked as they are on disk. If a root has
// no eol attribute for a file, either ending is accepted as long as the file is not mixed.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RULES = ['syntax-js', 'syntax-py', 'eol', 'trailing-ws', 'spdx', 'secret', 'user-path', 'hidden-window'];
// Rules whose findings an allow marker can silence.
const MARKER_RULES = new Set(['secret', 'user-path']);
// SELF-EXEMPTION (the only one): the pattern definition below contains the marker text itself, so the
// linter skips marker detection on that one line of tools/lint.mjs (see selfExempt). Nothing else is
// exempt. Each use is returned as lintReport().exemptions and printed on every run.
const MARKER_RE = /lint-allow:[ \t]*([A-Za-z][\w-]*)?/g;
const SELF_EXEMPT_FILE = 'tools/lint.mjs';
const SELF_EXEMPT_LINE_START = 'const MARKER_RE = ';
// EXPLICIT EXCLUSIONS: files the linter skips entirely. Each one is returned as lintReport().exclusions and
// printed on every run. Add one only with the user's yes.
export const LINT_EXCLUSIONS = [
  { path: 'tests/fixtures/lint/markers.txt', reason: 'invalid allow-marker samples (bare, unknown rule, unsupported rule) for tests/lint.test.mjs; written plainly, each is a finding by design' },
];
const selfExempt = (rel, line) => rel === SELF_EXEMPT_FILE && line.startsWith(SELF_EXEMPT_LINE_START);

const SPDX_ID = 'SPDX-License-Identifier: GPL-2.0-or-later';
const HASH = `# ${SPDX_ID}`;
const SLASH = `// ${SPDX_ID}`;
const SPDX_BY_EXT = {
  '.js': SLASH, '.mjs': SLASH, '.cjs': SLASH, '.ts': SLASH, '.c': SLASH, '.cpp': SLASH,
  '.h': SLASH, '.hpp': SLASH, '.qml': SLASH,
  '.py': HASH, '.sh': HASH, '.yaml': HASH, '.yml': HASH, '.toml': HASH, '.ps1': HASH, '.cmake': HASH,
  '.html': `<!-- ${SPDX_ID} -->`, '.xml': `<!-- ${SPDX_ID} -->`,
  '.css': `/* ${SPDX_ID} */`,
};
// CMakeLists.txt has no .cmake extension but is source.
const SPDX_BY_NAME = { 'CMakeLists.txt': HASH };
// The header must be within the first lines, after an optional shebang / doctype / xml prolog.
const SPDX_MAX_LINE = 3;

const SECRET_PATTERNS = [
  ['PEM private key', /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/],
  ['AWS access key id', /AKIA[0-9A-Z]{16}/],
  ['GitHub token', /gh[pousr]_[A-Za-z0-9]{36,}/],
  ['API key (sk-)', /sk-[A-Za-z0-9_-]{20,}/],
  ['Slack token', /xox[abpr]-[A-Za-z0-9-]{10,}/],
  ['Twitch oauth token', /oauth:[a-z0-9]{30}/],
  ['Bearer token', /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/],
  ['secret assignment',
    /(?:api[_-]?key|token|secret|password|client[_-]?secret)["']?\s*[:=]\s*["']([A-Za-z0-9_\-./+=]{16,})["']/i],
];
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{2,}$/;

// Placeholder user names that are not real profile folders.
const PLACEHOLDER_USERS = new Set(['user', 'username', 'name', 'you', 'me', 'example', 'public', 'default', 'all users']);
const USER_PATH_PATTERNS = [
  /[A-Za-z]:[\\/]+Users[\\/]+([^\\/\s<>%"'`:*?|]+)/gi,
  /(?<![\w.-])\/Users\/([^\\/\s<>%"'`:*?|]+)/g,
  /(?<![\w.-])\/home\/([^\\/\s<>%"'`:*?|]+)/g,
];

// ---- .gitattributes ----
function parseAttributes(root) {
  const file = path.join(root, '.gitattributes');
  const rules = [];
  if (!existsSync(file)) return rules;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [pattern, ...attrs] = line.split(/\s+/);
    rules.push({ pattern, attrs });
  }
  return rules;
}

function patternMatches(pattern, rel) {
  const base = rel.split('/').pop();
  if (pattern === '*') return true;
  if (pattern.startsWith('*.')) return base.toLowerCase().endsWith(pattern.slice(1).toLowerCase());
  if (!pattern.includes('/')) return base === pattern;
  return rel === pattern.replace(/^\//, '');
}

// Last matching rule wins per attribute, like git.
export function attributesFor(rules, rel) {
  let binary = false;
  let eol = null;
  for (const { pattern, attrs } of rules) {
    if (!patternMatches(pattern, rel)) continue;
    for (const a of attrs) {
      if (a === 'binary' || a === '-text') binary = true;
      else if (a === 'text' || a === 'text=auto') binary = false;
      else if (a.startsWith('eol=')) eol = a.slice(4);
    }
  }
  return { binary, eol };
}

// ---- file list ----
function gitList(root, args) {
  const r = spawnSync('git', ['-C', root, ...args, '-z'], { encoding: 'buffer', maxBuffer: 1 << 28, windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${String(r.stderr).trim()}`);
  return r.stdout.toString('utf8').split('\0').filter(Boolean);
}

export function listFiles(root) {
  const all = new Set([...gitList(root, ['ls-files']), ...gitList(root, ['ls-files', '--others', '--exclude-standard'])]);
  return [...all].filter((f) => existsSync(path.join(root, f))).sort();
}

// ---- line-based rules ----
function lineOf(text, index) {
  let n = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < index; i = text.indexOf('\n', i + 1)) n++;
  return n;
}

function checkEol(rel, buf, eolAttr, out) {
  let lf = 0, crlf = 0, firstBad = 0;
  let line = 1;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      const isCrlf = i > 0 && buf[i - 1] === 0x0d;
      if (isCrlf) crlf++; else lf++;
      const bad = eolAttr === 'crlf' ? !isCrlf : eolAttr === 'lf' ? isCrlf : false;
      if (bad && !firstBad) firstBad = line;
      line++;
    }
  }
  if (eolAttr === 'crlf' && lf) out.push([rel, firstBad, 'eol', `expected CRLF (.gitattributes), found ${lf} LF-only line(s)`]);
  else if (eolAttr === 'lf' && crlf) out.push([rel, firstBad, 'eol', `expected LF (.gitattributes), found ${crlf} CRLF line(s)`]);
  else if (!eolAttr && lf && crlf) out.push([rel, 1, 'eol', `mixed line endings (${lf} LF, ${crlf} CRLF)`]);
}

// Markers on one line: [{ rule: string|null }].
function markersIn(line) {
  return [...line.matchAll(MARKER_RE)].map((m) => ({ rule: m[1] ?? null }));
}

const escapeRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Names that must never appear in a path: injected names, data/profile.local.json paths.windows_user
 * (or top-level windowsUser), and the OS user running the lint. Returns a lowercase Set.
 */
export function forbiddenUserNames(root, opts = {}) {
  const names = new Set();
  const add = (n) => {
    if (typeof n !== 'string') return;
    const t = n.trim().toLowerCase();
    if (t.length >= 2 && !t.startsWith('<')) names.add(t);
  };
  (opts.userNames ?? []).forEach(add);
  const profile = opts.profilePath ?? path.join(root, 'data', 'profile.local.json');
  try {
    const j = JSON.parse(readFileSync(profile, 'utf8'));
    add(j?.paths?.windows_user);
    add(j?.windowsUser);
  } catch { /* no profile: nothing to add */ }
  if (opts.osUser !== null) {
    try { add(opts.osUser ?? os.userInfo().username); } catch { /* no user info */ }
  }
  return names;
}

function checkSpdx(rel, lines, out) {
  const base = rel.split('/').pop();
  const ext = path.extname(base).toLowerCase();
  const expected = SPDX_BY_NAME[base] ?? SPDX_BY_EXT[ext];
  if (!expected) return;
  let first = 0;
  const head = lines.slice(0, SPDX_MAX_LINE + 2);
  // skip shebang, doctype and xml prolog
  while (first < head.length && (/^#!/.test(head[first]) || /^<!doctype html>/i.test(head[first]) || /^<\?xml/.test(head[first]))) first++;
  const window = lines.slice(first, first + SPDX_MAX_LINE);
  if (!window.some((l) => l.trim() === expected)) out.push([rel, 1, 'spdx', `missing header "${expected}" in first lines`]);
}

function forbiddenPathRegex(names) {
  if (!names.size) return null;
  const alt = [...names].map(escapeRe).join('|');
  return new RegExp(`[\\\\/](?:Users|home)[\\\\/]+(?:${alt})(?![\\w.-])`, 'i');
}

// ctx: { markers: [], exemptions: [], forbidden: RegExp|null }
function checkText(rel, text, lines, out, wanted, ctx) {
  const isTest = rel.startsWith('tests/') || rel.includes('/tests/');
  if (wanted('trailing-ws')) {
    lines.forEach((l, i) => {
      if (/[ \t]+$/.test(l)) out.push([rel, i + 1, 'trailing-ws', 'trailing whitespace']);
    });
  }
  if (wanted('spdx')) checkSpdx(rel, lines, out);
  lines.forEach((l, i) => {
    const honoured = new Set();
    const exempt = selfExempt(rel, l);
    if (exempt) ctx.exemptions.push({ path: rel, line: i + 1, what: 'marker pattern definition' });
    for (const m of exempt ? [] : markersIn(l)) {
      ctx.markers.push({ path: rel, line: i + 1, rule: m.rule ?? '(none)' });
      if (!m.rule || !RULES.includes(m.rule)) {
        out.push([rel, i + 1, 'lint-allow', `marker must name a known rule (${RULES.join(', ')})`]);
      } else if (!MARKER_RULES.has(m.rule)) {
        out.push([rel, i + 1, 'lint-allow', `rule ${m.rule} does not support allow markers`]);
      } else if (m.rule === 'secret' && !isTest) {
        out.push([rel, i + 1, 'lint-allow', 'the secret marker is accepted only in test files (tests/)']);
      } else {
        honoured.add(m.rule);
      }
    }
    if (wanted('secret') && !honoured.has('secret')) {
      for (const [label, re] of SECRET_PATTERNS) {
        const m = re.exec(l);
        if (!m) continue;
        // A value that is only an environment-variable-shaped name (UPPER_SNAKE) is a name, not a secret.
        if (label === 'secret assignment' && ENV_NAME_RE.test(m[1] ?? '')) continue;
        out.push([rel, i + 1, 'secret', `looks like a secret: ${label}`]);
        break;
      }
    }
    if (wanted('user-path')) {
      // The machine's own user name is refused even with a marker; it is never echoed.
      if (ctx.forbidden?.test(l)) {
        out.push([rel, i + 1, 'user-path', 'path contains this machine\'s user name (never allowed, not even with a marker)']);
      } else if (!honoured.has('user-path')) {
        for (const re of USER_PATH_PATTERNS) {
          re.lastIndex = 0;
          const hit = [...l.matchAll(re)].find((m) => {
            const who = m[1].toLowerCase();
            return !PLACEHOLDER_USERS.has(who) && !/^[.…]+$/.test(who);
          });
          if (hit) {
            out.push([rel, i + 1, 'user-path', 'absolute user path (use a placeholder such as <user> or %USERPROFILE%)']);
            break;
          }
        }
      }
    }
  });
}


// ---- hidden-window: no child process may open a console window (user, 2026-11-03, D191) ----
// A console program (cmd, powershell, python, ffmpeg, git, node) started from a process without a visible console
// gets a NEW console window on Windows: it pops up and takes focus. Every call must ask for no window:
//   JS: a child_process function (spawn, spawnSync, exec, execSync, execFile, execFileSync, fork) called with
//       `windowsHide: true` inside the call's parentheses (options in a variable: spread them, then add it);
//   Python: a subprocess function (run, Popen, call, check_call, check_output) called with `creationflags`
//       (or the module's NO_WINDOW kwargs) inside the parentheses.
// The only exception is a GUI program the user asked to see (e.g. explorer.exe for "Open folder"): JS
// `windowsHide: false` followed on the same line by `// GUI window: <reason>`. Never for a console program.
const CP_FUNCS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];
const PY_FUNCS = ['run', 'Popen', 'call', 'check_call', 'check_output'];

/** Text of the call starting at the '(' at index open, up to its matching ')'. Skips strings and comments. */
export function callText(src, open, lang) {
  let depth = 0;
  let q = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || (c === '`' && lang === 'js')) { q = c; continue; }
    const lineComment = lang === 'js' ? c === '/' && src[i + 1] === '/' : c === '#';
    if (lineComment) { const n = src.indexOf('\n', i); i = n < 0 ? src.length : n; continue; }
    if (lang === 'js' && c === '/' && src[i + 1] === '*') { const n = src.indexOf('*/', i + 2); i = n < 0 ? src.length : n + 1; continue; }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

/** Call sites (index of the name, index of '(') of the child-process functions this file imports. */
function childProcessCalls(text, lang) {
  const sites = [];
  const inComment = (idx) => {
    const ls = text.lastIndexOf('\n', idx - 1) + 1;
    const before = text.slice(ls, idx);
    return lang === 'js' ? /\/\/|^\s*\*/.test(before) : before.includes('#');
  };
  const scan = (re) => {
    for (const m of text.matchAll(re)) {
      const open = m.index + m[0].length - 1;
      if (!inComment(m.index)) sites.push({ at: m.index, open });
    }
  };
  if (lang === 'js') {
    const names = new Set();
    const spaces = new Set();
    const mod = String.raw`['"](?:node:)?child_process['"]`;
    for (const m of text.matchAll(new RegExp(String.raw`(?:import\s*\{([^}]*)\}\s*from\s*${mod}|\{([^}]*)\}\s*=\s*(?:await\s+import\(\s*${mod}\s*\)|require\(\s*${mod}\s*\)))`, 'g'))) {
      for (const part of (m[1] ?? m[2]).split(',')) {
        const [orig, alias] = part.trim().split(/\s+as\s+|\s*:\s*/).map((s) => s.trim());
        if (CP_FUNCS.includes(orig)) names.add(alias || orig);
      }
    }
    for (const m of text.matchAll(new RegExp(String.raw`import\s+(?:\*\s+as\s+)?(\w+)\s+from\s*${mod}|(\w+)\s*=\s*(?:await\s+import|require)\(\s*${mod}\s*\)`, 'g'))) spaces.add(m[1] ?? m[2]);
    if (names.size) scan(new RegExp(String.raw`(?<![\w.$])(?:${[...names].join('|')})\s*\(`, 'g'));
    for (const s of spaces) scan(new RegExp(String.raw`(?<![\w.$])${s}\.(?:${CP_FUNCS.join('|')})\s*\(`, 'g'));
  } else {
    if (/^\s*import\s+subprocess\b/m.test(text)) scan(new RegExp(String.raw`(?<![\w.])subprocess\.(?:${PY_FUNCS.join('|')})\s*\(`, 'g'));
    const from = /^\s*from\s+subprocess\s+import\s+\(?([^)\n]*)\)?/m.exec(text);
    const names = from ? from[1].split(',').map((s) => s.trim().split(/\s+as\s+/)).filter(([o]) => PY_FUNCS.includes(o)).map(([o, a]) => a ?? o) : [];
    if (names.length) scan(new RegExp(String.raw`(?<![\w.])(?:${names.join('|')})\s*\(`, 'g'));
  }
  return sites;
}

export function checkHiddenWindow(rel, text, out) {
  const ext = path.extname(rel).toLowerCase();
  const lang = ['.js', '.mjs', '.cjs'].includes(ext) ? 'js' : ext === '.py' ? 'py' : null;
  if (!lang) return;
  const want = lang === 'js' ? /\bwindowsHide\s*:\s*true\b/ : /\bcreationflags\s*=|\*\*NO_WINDOW\b/;
  const gui = /\bwindowsHide\s*:\s*false\b[^\n]*\/\/\s*GUI window:\s*\S[^\n]{2,}/;
  for (const { at, open } of childProcessCalls(text, lang)) {
    const call = callText(text, open, lang);
    if (want.test(call) || (lang === 'js' && gui.test(call))) continue;
    out.push([rel, lineOf(text, at), 'hidden-window', lang === 'js'
      ? 'child process without `windowsHide: true` (opens a console window on Windows)'
      : 'subprocess call without `creationflags` / `**NO_WINDOW` (opens a console window on Windows)']);
  }
}

// ---- syntax rules (subprocesses) ----
function nodeCheck(root, rel) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--check', rel], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => resolve([[rel, 1, 'syntax-js', `cannot run node: ${e.message}`]]));
    p.on('close', (code) => {
      if (code === 0) return resolve([]);
      const lines = err.split(/\r?\n/);
      const loc = lines.find((l) => /:\d+$/.test(l.trim()));
      const line = loc ? Number(/:(\d+)$/.exec(loc.trim())[1]) : 1;
      const msg = lines.find((l) => /^\w*Error:/.test(l)) ?? lines.find(Boolean) ?? 'syntax error';
      resolve([[rel, line, 'syntax-js', msg.trim()]]);
    });
  });
}

async function checkJsSyntax(root, files, out, workers = 4) {
  const queue = [...files];
  const worker = async () => {
    for (let rel = queue.shift(); rel !== undefined; rel = queue.shift()) out.push(...(await nodeCheck(root, rel)));
  };
  await Promise.all(Array.from({ length: Math.min(workers, queue.length) }, worker));
}

const PY_SCRIPT = `
import ast, json, sys
files = json.loads(sys.stdin.read())
bad = []
for rel in files:
    try:
        with open(rel, 'rb') as fh:
            ast.parse(fh.read(), filename=rel)
    except SyntaxError as e:
        bad.append([rel, e.lineno or 1, e.msg])
    except Exception as e:
        bad.append([rel, 1, type(e).__name__ + ': ' + str(e)])
sys.stdout.write(json.dumps(bad))
`;

function checkPySyntax(root, files, out) {
  if (!files.length) return;
  const r = spawnSync('python', ['-I', '-c', PY_SCRIPT], {
    cwd: root, input: JSON.stringify(files), encoding: 'utf8', maxBuffer: 1 << 26,
    windowsHide: true,
  });
  if (r.error || r.status !== 0) {
    out.push([files[0], 1, 'syntax-py', `python parse failed to run: ${r.error?.message ?? r.stderr.trim()}`]);
    return;
  }
  for (const [rel, line, msg] of JSON.parse(r.stdout)) out.push([rel, line, 'syntax-py', msg]);
}

/**
 * Lint files under root. Returns findings sorted as [{path, line, rule, message}].
 * opts.files: explicit relative file list (default: git list). opts.rules: subset of RULES.
 */
export async function lintReport(root, opts = {}) {
  const wanted = (r) => !opts.rules || opts.rules.includes(r);
  const files = (opts.files ?? listFiles(root)).map((f) => f.split(path.sep).join('/'));
  const attrRules = parseAttributes(root);
  const out = [];
  const ctx = { markers: [], exemptions: [], forbidden: forbiddenPathRegex(forbiddenUserNames(root, opts)) };
  const jsFiles = [];
  const pyFiles = [];
  const exclusions = [];
  for (const rel of files) {
    const full = path.join(root, rel);
    if (!existsSync(full)) continue;
    const excluded = LINT_EXCLUSIONS.find((x) => x.path === rel);
    if (excluded) { exclusions.push({ path: rel, reason: excluded.reason }); continue; }
    const attrs = attributesFor(attrRules, rel);
    if (attrs.binary) continue;
    const buf = readFileSync(full);
    if (buf.includes(0)) continue;
    if (!buf.length) continue;
    const ext = path.extname(rel).toLowerCase();
    if (['.js', '.mjs', '.cjs'].includes(ext)) jsFiles.push(rel);
    if (ext === '.py') pyFiles.push(rel);
    if (wanted('eol')) checkEol(rel, buf, attrs.eol, out);
    const text = buf.toString('utf8');
    checkText(rel, text, text.split(/\r?\n/), out, wanted, ctx);
    if (wanted('hidden-window')) checkHiddenWindow(rel, text, out);
  }
  if (wanted('syntax-js')) await checkJsSyntax(root, jsFiles, out);
  if (wanted('syntax-py')) checkPySyntax(root, pyFiles, out);
  const findings = out
    .map(([p, line, rule, message]) => ({ path: p, line, rule, message }))
    .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.rule.localeCompare(b.rule));
  const markers = ctx.markers.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  const exemptions = ctx.exemptions.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  return { findings, markers, exemptions, exclusions };
}

/** Findings only. */
export async function lint(root, opts = {}) {
  return (await lintReport(root, opts)).findings;
}

export const formatFinding = (f) => `${f.path}:${f.line}: ${f.rule}: ${f.message}`;

async function main() {
  const argv = process.argv.slice(2);
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let rules;
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') root = path.resolve(argv[++i]);
    else if (argv[i] === '--rules') rules = argv[++i].split(',');
    else files.push(argv[i]);
  }
  const t0 = Date.now();
  const { findings, markers, exemptions, exclusions } = await lintReport(root, { files: files.length ? files : undefined, rules });
  for (const f of findings) console.log(formatFinding(f));
  for (const m of markers) console.log(`lint-allow in use: ${m.path}:${m.line}: ${m.rule}`);
  for (const x of exemptions) console.log(`lint self-exemption in use: ${x.path}:${x.line}: ${x.what}`);
  for (const x of exclusions) console.log(`lint exclusion in use: ${x.path}: ${x.reason}`);
  const counts = {};
  for (const f of findings) counts[f.rule] = (counts[f.rule] ?? 0) + 1;
  const summary = Object.entries(counts).map(([r, n]) => `${r}=${n}`).join(' ');
  console.log(`lint: ${findings.length} finding(s)${summary ? ` (${summary})` : ''}, ${markers.length} allow marker(s), in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(findings.length ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
