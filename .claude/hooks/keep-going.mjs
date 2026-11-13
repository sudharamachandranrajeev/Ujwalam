// SPDX-License-Identifier: GPL-3.0-or-later
// Claude Code Stop hook (user request 2026-11-13): the agent may not end its turn while plan work remains.
// It may stop only when its last message ends with a line "BLOCKED-ON-USER: <ask-list item>" (installs, devices or
// live streams, real posts, spending, privacy, files outside the project) or "WIND-UP COMPLETE".
// Escape hatch for the user: create .claude/allow-stop (gitignored) or remove the hook in /hooks.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

let input = {};
try {
	input = JSON.parse(readFileSync(0, 'utf8') || '{}');
} catch {}

const root = input.cwd || process.cwd();
if (existsSync(join(root, '.claude', 'allow-stop'))) process.exit(0);

function lastAssistantText() {
	if (typeof input.last_assistant_message === 'string') return input.last_assistant_message;
	try {
		const lines = readFileSync(input.transcript_path, 'utf8').trim().split('\n');
		for (let i = lines.length - 1; i >= 0; i--) {
			const e = JSON.parse(lines[i]);
			if (e.type !== 'assistant') continue;
			const c = e.message?.content;
			const text = Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : String(c ?? '');
			if (text.trim()) return text;
		}
	} catch {}
	return '';
}

const last = lastAssistantText();
if (/^\s*BLOCKED-ON-USER:\s*\S/m.test(last) || /WIND-UP COMPLETE/.test(last)) process.exit(0);

process.stdout.write(
	JSON.stringify({
		decision: 'block',
		reason:
			'Plan work remains (newest docs/plan/*-handover.md "Next"). Do not stop at a clean point: start the next step now. ' +
			'Stop only when every remaining step needs the user (ask-list: installs, devices/live streams, real posts, spending, ' +
			'privacy, files outside the project); then end the message with a line "BLOCKED-ON-USER: <item>".',
	}),
);
