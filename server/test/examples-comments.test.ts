/** Runs the act-on-comments example formula end to end, against local stand-ins for GitHub, ClickUp and Claude. */
import { mockApi, tempDir } from './helpers.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';

process.env.AUTOWORKER_CLAUDE_BIN = path.join(import.meta.dirname, 'fixtures/fake-claude-comments.mjs');

type Pull = { repo: string; number: number; head: string; base: string; draft: boolean; title: string; body: string; node_id: string; html_url: string };
const pulls: Pull[] = [];
const github = await mockApi(({ method, url, body }) => {
  if (url === '/user') return { id: 42, login: 'octo', name: 'Octo Cat', email: null };
  const list = url.match(/^\/repos\/your-org\/(\w+)\/pulls\?(.*)$/);
  if (method === 'GET' && list) return pulls.filter((pr) => pr.repo === list[1] && `your-org:${pr.head}` === new URLSearchParams(list[2]).get('head'));
  const create = url.match(/^\/repos\/your-org\/(\w+)\/pulls$/);
  if (method === 'POST' && create) return addPull({ ...body, repo: create[1] });
  return undefined;
});
function addPull(pr: Omit<Pull, 'number' | 'node_id' | 'html_url'>): Pull {
  const number = pulls.length + 1;
  const created = { ...pr, number, node_id: `PR_${number}`, html_url: `https://github.com/your-org/${pr.repo}/pull/${number}` };
  pulls.push(created);
  return created;
}

const day = (n: number) => String(Date.UTC(2026, 10, n));
const comment = (id: string, date: string, text: string, extra: Record<string, unknown> = {}) => ({
  id,
  date,
  comment_text: text,
  comment: [{ text }],
  user: { username: extra.author ?? 'pm' },
  reply_count: 0,
  ...extra,
});
const tasks: Record<string, { name: string; comments: any[]; replies?: Record<string, any[]> }> = {
  cu2: {
    name: 'Show the invoice total',
    // Newest first, like ClickUp.
    comments: [
      comment('c4', day(5), 'Typo in the header', { resolved: true }),
      comment('c3', day(4), 'The total is rounded wrong', {
        reply_count: 1,
        comment: [{ text: 'The total is rounded wrong ' }, { type: 'image', text: 'shot.png', image: { title: 'shot.png', url: 'FILES/shot.png' } }],
      }),
      comment('c2', day(3), '🤖 Auto Worker: review comments addressed\n\nDone.', { author: 'Octo Cat' }),
      comment('c1', day(2), 'Make the total bold'),
    ],
    replies: { c3: [comment('r1', String(Number(day(4)) + 1), 'Also on the PDF')] },
  },
  cu3: { name: 'Export invoices', comments: [comment('c5', day(6), 'The export button is missing on the list')] },
  cu4: { name: 'Nothing started', comments: [comment('c6', day(6), 'Any news?')] },
};
const clickup = await mockApi(({ method, url }) => {
  if (url === '/files/shot.png') return { png: true };
  const replies = url.match(/^\/comment\/(\w+)\/reply$/);
  if (method === 'GET' && replies) return { comments: Object.values(tasks).find((task) => task.replies?.[replies[1]])!.replies![replies[1]] };
  const route = url.match(/^\/task\/(\w+)(\/comment)?/);
  const task = route && tasks[route[1]];
  if (!task) return undefined;
  if (method === 'POST' && route[2]) return {};
  if (method === 'GET' && route[2]) {
    return { comments: JSON.parse(JSON.stringify(task.comments).replaceAll('FILES', `${clickup.url}/files`)) };
  }
  return { id: route[1], name: task.name, markdown_description: 'The invoice screen.', url: `https://app.clickup.com/t/${route[1]}`, status: { status: 'in review' }, attachments: [] };
});
process.env.GITHUB_API_URL = github.url;
process.env.CLICKUP_API_URL = clickup.url;
after(() => {
  github.close();
  clickup.close();
});

const engine = await import('../src/engine/engine.js');
const runs = await import('../src/store/runs.js');
const { createWorkflow } = await import('../src/store/workflows.js');
const { setSecret } = await import('../src/store/secrets.js');
const { parseFormula } = await import('../src/formula.js');
setSecret('GITHUB_TOKEN', 'ghp_test');
setSecret('CLICKUP_TOKEN', 'pk_test');

const remotes = path.join(tempDir, 'remotes');
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.com', ...args], { cwd, encoding: 'utf8' });
const bare = (name: string) => path.join(remotes, `your-org/${name}.git`);
const seeds: Record<string, string> = {};
for (const name of ['backend', 'frontend']) {
  const seed = (seeds[name] = path.join(tempDir, `seed-${name}`));
  mkdirSync(path.dirname(bare(name)), { recursive: true });
  git(tempDir, 'init', '--quiet', '--bare', '--initial-branch=main', bare(name));
  git(tempDir, 'init', '--quiet', '--initial-branch=main', seed);
  writeFileSync(path.join(seed, 'README.md'), `${name}\n`);
  git(seed, 'add', '.');
  git(seed, 'commit', '--quiet', '-m', 'init');
  git(seed, 'push', '--quiet', bare(name), 'main');
}
/** Pushes a task branch with one commit, as if an earlier run (or a person) had done the work. */
function pushBranch(repo: string, branch: string): string {
  const seed = seeds[repo];
  git(seed, 'checkout', '--quiet', '-B', branch, 'main');
  writeFileSync(path.join(seed, `${branch.replaceAll('/', '-')}.txt`), 'earlier work\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '--quiet', '-m', 'feat: earlier work');
  git(seed, 'push', '--quiet', bare(repo), branch);
  return git(seed, 'rev-parse', 'HEAD').trim();
}
const gitConfig = path.join(tempDir, 'gitconfig');
writeFileSync(gitConfig, `[url "file://${remotes}/"]\n\tinsteadOf = https://github.com/\n`);

/** The example as shipped, with the commands that need real projects replaced and nothing that would leave the machine. */
function exampleWorkflow(name: string, triage: string) {
  const input = parseFormula(readFileSync(path.join(import.meta.dirname, '../../examples/act-on-comments.formula.yaml'), 'utf8'));
  const commands: Record<string, string> = { install: 'true', backend_checks: 'true', frontend_checks: 'true' };
  const steps = input.definition.steps.map((step) => (commands[step.id] ? { ...step, with: { ...step.with, command: commands[step.id] } } : step));
  return createWorkflow({
    name,
    definition: {
      ...input.definition,
      triggers: [],
      notifications: [],
      environment: { ...input.definition.environment, runtimes: [], services: [], env: { GIT_CONFIG_GLOBAL: gitConfig, FAKE_TRIAGE: triage } },
      steps,
    },
  });
}

/** Answers every approval, rejecting the first reply once with a comment. Returns the gates in order. */
async function drive(runId: string): Promise<string[]> {
  const gates: string[] = [];
  let rejectedReply = false;
  for (;;) {
    await engine.waitForIdle();
    const run = runs.getRun(runId)!;
    if (run.status !== 'waiting') return gates;
    const [approval] = runs.listApprovals({ runId, status: 'pending' });
    gates.push(approval.stepId);
    if (approval.stepId === 'reply_review' && !rejectedReply) {
      rejectedReply = true;
      engine.resolveApproval(approval.id, 'rejected', 'Mention the PDF too.');
    } else {
      engine.resolveApproval(approval.id, 'approved', '');
    }
  }
}

const log = (branch: string, repo: string) => git(bare(repo), 'log', '--format=%s', `main..${branch}`).trim().split('\n');

test('the comments example fixes the recent comments on the existing branches and leaves the pull requests as they are', async () => {
  // The branch names do not match the task's slug: they are found by the task id.
  const backendStart = pushBranch('backend', 'cu2-invoice-total');
  pushBranch('frontend', 'cu2-invoice-total');
  addPull({ repo: 'backend', head: 'cu2-invoice-total', base: 'main', draft: false, title: 'feat: show the invoice total', body: 'Written by a person.' });
  addPull({ repo: 'frontend', head: 'cu2-invoice-total', base: 'main', draft: true, title: 'feat: invoice total on the screen', body: 'Also by a person.' });
  const before = JSON.stringify(pulls);

  const run = engine.startRun(exampleWorkflow('comments-both', 'BACKEND: yes\\nFRONTEND: yes\\nBLOCKERS: none'), { task: { id: 'cu2' } });
  const gates = await drive(run.id);
  const finished = runs.getRun(run.id)!;
  assert.equal(finished.error, undefined);
  assert.equal(finished.status, 'succeeded');
  assert.deepEqual(gates, ['triage_review', 'code_review', 'staging', 'reply_review', 'reply_review']);

  const steps = finished.context.steps;
  assert.deepEqual((steps.clone_backend.output as any).reused, true);
  assert.equal((steps.clone_backend.output as any).branch, 'cu2-invoice-total');
  assert.equal((steps.clone_backend.output as any).startCommit, backendStart);

  // The triage saw the threads, the resolved flag and the screenshot, saved outside the repositories.
  const prompts = readFileSync(path.join(finished.workspace, 'prompts.log'), 'utf8');
  const triage = prompts.split('---\n').find((prompt) => prompt.startsWith('You are triaging'))!;
  assert.match(triage, /"text":"Also on the PDF"/);
  assert.match(triage, /"resolved":true/);
  const shot = path.join(finished.workspace, 'task-attachments/1-shot.png');
  assert.ok(triage.includes(`"files":["${shot}"]`), 'the comment lists its downloaded screenshot');
  assert.ok(existsSync(shot));
  assert.ok(triage.indexOf('Make the total bold') < triage.indexOf('🤖 Auto Worker') && triage.indexOf('🤖 Auto Worker') < triage.indexOf('rounded wrong'), 'comments oldest first');
  assert.match(prompts, /Address this feedback:\n\nMention the PDF too\./);

  // New commits on top of the branches, pushed; the pull requests were not touched.
  assert.deepEqual(log('cu2-invoice-total', 'backend'), ['fix: round the invoice total half up', 'feat: earlier work']);
  assert.deepEqual(log('cu2-invoice-total', 'frontend'), ['fix: show the currency next to the total', 'feat: earlier work']);
  assert.equal(JSON.stringify(pulls), before);
  assert.equal(github.requests.some((request) => request.method === 'PATCH' || request.url === '/graphql'), false);

  const reply = clickup.requests.find((request) => request.method === 'POST' && request.url === '/task/cu2/comment')!;
  assert.match(reply.body.comment_text, /^🤖 Auto Worker: review comments addressed\n\npm asked .*on the PDF/);
  assert.match(reply.body.comment_text, /Backend: https:\/\/github\.com\/your-org\/backend\/pull\/1\nFrontend: https:\/\/github\.com\/your-org\/frontend\/pull\/2/);
});

test('a branch named in the request is followed up, and a repository without it gets a draft under the same name', async () => {
  pulls.length = 0;
  // Not named after the task id, so the request names it.
  pushBranch('backend', 'feat/cu3-export');
  addPull({ repo: 'backend', head: 'feat/cu3-export', base: 'main', draft: false, title: 'feat: export invoices', body: 'By a person.' });

  const workflow = exampleWorkflow('comments-new-repo', 'BACKEND: no\\nFRONTEND: yes\\nBLOCKERS: none');
  const run = engine.startRun(workflow, { task: { id: 'cu3' }, branch: 'feat/cu3-export', staging: false });
  const gates = await drive(run.id);
  const finished = runs.getRun(run.id)!;
  assert.equal(finished.error, undefined);
  assert.equal(finished.status, 'succeeded');
  assert.deepEqual(gates, ['triage_review', 'code_review', 'reply_review', 'reply_review'], 'no staging gate');

  const steps = finished.context.steps;
  assert.equal((steps.clone_frontend.output as any).reused, false);
  for (const skipped of ['fix_backend', 'push_backend', 'staging', 'verify']) assert.equal(steps[skipped].skipped, true, `${skipped} is skipped`);
  assert.equal((steps.clone_backend.output as any).reused, true);
  assert.deepEqual(log('feat/cu3-export', 'frontend'), ['fix: show the currency next to the total']);
  assert.deepEqual(
    pulls.map((pr) => [pr.repo, pr.head, pr.draft, pr.title]),
    [
      ['backend', 'feat/cu3-export', false, 'feat: export invoices'],
      ['frontend', 'feat/cu3-export', true, 'fix: export invoices'],
    ],
  );
  const prompts = readFileSync(path.join(finished.workspace, 'prompts.log'), 'utf8');
  assert.match(prompts, /that it was not checked on staging/);
});

test('a task without a branch in either repository ends before Claude runs', async () => {
  const run = engine.startRun(exampleWorkflow('comments-no-branch', 'BACKEND: yes\\nFRONTEND: yes\\nBLOCKERS: none'), { task: { id: 'cu4' } });
  await drive(run.id);
  const finished = runs.getRun(run.id)!;
  assert.equal(finished.error, undefined);
  assert.equal(finished.status, 'succeeded');
  assert.equal(finished.context.steps.no_branch.skipped, undefined);
  assert.equal(finished.context.steps.triage.skipped, true);
  assert.equal(existsSync(path.join(finished.workspace, 'prompts.log')), false);
});
