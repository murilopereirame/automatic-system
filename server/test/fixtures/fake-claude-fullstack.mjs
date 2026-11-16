#!/usr/bin/env node
/**
 * Stand-in for the `claude` CLI when the full-stack example formula runs end
 * to end in tests. It recognises each block of that formula by its prompt and
 * does what a real agent would leave behind: commits in backend/ or frontend/,
 * a handoff note, a plan that ends with the KIND/BACKEND/FRONTEND lines, a
 * staging verdict. Every prompt is appended to prompts.log in the workspace.
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
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

const plan = (process.env.FAKE_PLAN ?? 'KIND: feature\nBACKEND: yes\nFRONTEND: yes\nBLOCKERS: none').replaceAll('\\n', '\n');
let result;
if (prompt.startsWith('You are planning a change') || prompt.startsWith('A human reviewed your work')) {
  result = `Plan: change the API, then the screen.\n${plan}`;
} else if (prompt.startsWith('Before fixing anything')) {
  writeFileSync('backend/repro.test.txt', 'fails before the fix\n');
  result = 'Reproduced with a failing test.';
} else if (prompt.startsWith('Implement the backend part')) {
  commit('backend', 'api.txt', 'feat: api change');
  result = 'Backend done.';
} else if (prompt.startsWith('Use the frontend-handoff skill')) {
  mkdirSync('handoff', { recursive: true });
  writeFileSync('handoff/frontend-contract.md', 'GET /api/thing\n');
  result = 'Contract written.';
} else if (prompt.startsWith('Implement the frontend part')) {
  if (!existsSync('handoff/frontend-contract.md') && plan.includes('BACKEND: yes')) throw new Error('the contract is missing');
  commit('frontend', 'screen.txt', 'feat: screen change');
  result = 'Frontend done.';
} else if (prompt.startsWith('Review your own change')) {
  result = 'Reviewed: looks fine.';
} else if (prompt.startsWith('The backend checks failed')) {
  commit('backend', 'fixed.txt', 'fix: make the checks pass');
  result = 'Fixed the backend checks.';
} else if (prompt.startsWith('The frontend checks failed')) {
  commit('frontend', 'fixed.txt', 'fix: make the checks pass');
  result = 'Fixed the frontend checks.';
} else if (prompt.startsWith('The change is deployed to staging')) {
  // With FAKE_STAGING_FIX the first verification finds a problem and fixes it.
  if (process.env.FAKE_STAGING_FIX && !existsSync('handoff/staging-fixed')) {
    mkdirSync('handoff', { recursive: true });
    writeFileSync('handoff/staging-fixed', 'yes\n');
    commit('frontend', 'staging-fix.txt', 'fix: label on staging');
    result = 'The label was wrong on staging; fixed it.\nVERDICT: fixed';
  } else {
    result = 'All requirements checked on staging.\nVERDICT: pass';
  }
} else if (prompt.includes('pull request title only')) {
  result = 'feat: show the balance on invoices\n';
} else if (prompt.includes('backend pull request')) {
  result = 'Backend summary.';
} else if (prompt.includes('frontend pull request')) {
  result = 'Frontend summary.';
} else {
  result = 'Done';
}

emit({ type: 'system', subtype: 'init', session_id: sessionId });
emit({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'text', text: result }] } });
emit({ type: 'result', subtype: 'success', is_error: false, result, total_cost_usd: 0.01, num_turns: 1, session_id: sessionId });
