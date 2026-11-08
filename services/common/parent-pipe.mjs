// SPDX-License-Identifier: GPL-3.0-or-later
// Parent pipe (D234): the studio launcher starts its children with stdin as a pipe and UJWALAM_PARENT_PIPE=1. When the
// launcher dies, even by a hard kill (TerminateProcess on Windows, where no signal reaches the children), the pipe
// closes and the child sees end-of-file on stdin. watchParent then calls onGone once, so the child shuts down cleanly
// instead of running on as an orphan. Without the env marker (a child started by hand in a terminal) stdin is left
// alone and nothing happens.
export const PARENT_PIPE_ENV = 'UJWALAM_PARENT_PIPE';

export function watchParent(onGone, { env = process.env, stdin = process.stdin } = {}) {
  if (env[PARENT_PIPE_ENV] !== '1') return false;
  let fired = false;
  const gone = () => { if (!fired) { fired = true; onGone(); } };
  stdin.on('data', () => {}); // ignored here; the UI server alone reads its control lines (studio-ui/cli.mjs controlLine)
  stdin.once('end', gone);
  stdin.once('close', gone);
  stdin.once('error', gone);
  stdin.resume();
  return true;
}
