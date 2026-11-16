#!/usr/bin/env node
/**
 * Stand-in for the `claude` CLI when the act-on-comments example formula runs
 * end to end in tests. It recognises each block of that formula by its prompt
 * and leaves behind what a real agent would: a triage ending in the
 * BACKEND/FRONTEND lines (FAKE_TRIAGE), fix commits, a staging verdict, a
 * reply. Every prompt is appended to prompts.log in the workspace.
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1];
const resumed = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : null;
const sessionId = resumed ?? `session-${process.pid}`;
const emit = (message) => console.log(JSON.stringify(message));

appendFileSync('prompts.log', `---\n${prompt}\n`);

const commit = (repo, file, message) => {
  writeFileSync(`${repo}/${file}`, `${message}\n`);
  const git = (...gitArgs) => execFileSync('git', ['-C', repo, '-c', 'user.name=Claude', '-c', 'user.email=claude@example.com', ...gitArgs]);
  git('add', '--all');
  git('commit', '--quiet', '-m', message);
};

const triage = (process.env.FAKE_TRIAGE ?? 'BACKEND: yes\nFRONTEND: yes\nBLOCKERS: none').replaceAll('\\n', '\n');
let result;
if (prompt.includes('Mention the PDF too.')) {
  // The reply was sent back with this comment.
  result = 'pm asked for the total to round half up, on the screen and on the PDF: it does now, checked on staging.';
} else if (prompt.startsWith('You are triaging') || prompt.startsWith('A human reviewed your work')) {
  result = `1. pm, yesterday: the total is rounded wrong. Cause in the invoice service.\n${triage}`;
} else if (prompt.startsWith('Make the backend fixes')) {
  commit('backend', 'rounding.txt', 'fix: round the invoice total half up');
  result = 'Backend fixed.';
} else if (prompt.startsWith('Make the frontend fixes')) {
  commit('frontend', 'label.txt', 'fix: show the currency next to the total');
  result = 'Frontend fixed.';
} else if (prompt.startsWith('Review this run')) {
  result = '1. Rounding: fixed in the service, with a test.';
} else if (prompt.startsWith('The fixes are deployed to staging')) {
  result = 'Checked the invoice on staging.\nVERDICT: pass';
} else if (prompt.startsWith('Write the reply')) {
  result = 'pm asked for the total to round half up: it does now, checked on staging.';
} else {
  result = 'Done';
}

emit({ type: 'system', subtype: 'init', session_id: sessionId });
emit({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'text', text: result }] } });
emit({ type: 'result', subtype: 'success', is_error: false, result, total_cost_usd: 0.01, num_turns: 1, session_id: sessionId });
