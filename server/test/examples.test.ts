/** Runs the full-stack example formula end to end, against local stand-ins for GitHub, ClickUp and Claude. */
import { mockApi, tempDir, waitFor } from './helpers.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';

process.env.AUTOWORKER_CLAUDE_BIN = path.join(import.meta.dirname, 'fixtures/fake-claude-fullstack.mjs');

const pulls: { repo: string; number: number; head: string; base: string; draft: boolean; title: string; body: string; node_id: string; html_url: string }[] = [];
const github = await mockApi(({ method, url, body }) => {
  if (url === '/user') return { id: 42, login: 'octo', name: 'Octo Cat', email: null };
  const list = url.match(/^\/repos\/your-org\/(\w+)\/pulls\?(.*)$/);
  if (method === 'GET' && list) return pulls.filter((pr) => pr.repo === list[1] && `your-org:${pr.head}` === new URLSearchParams(list[2]).get('head'));
  const create = url.match(/^\/repos\/your-org\/(\w+)\/pulls$/);
  if (method === 'POST' && create) {
    const number = pulls.length + 1;
    const pr = { ...body, repo: create[1], number, node_id: `PR_${number}`, html_url: `https://github.com/your-org/${create[1]}/pull/${number}` };
    pulls.push(pr);
    return pr;
  }
  const update = url.match(/^\/repos\/your-org\/(\w+)\/pulls\/(\d+)$/);
  if (method === 'PATCH' && update) {
    const pr = pulls.find((candidate) => candidate.number === Number(update[2]))!;
    Object.assign(pr, body);
    return pr;
  }
  if (method === 'POST' && url === '/graphql') {
    pulls.find((pr) => pr.node_id === body.variables.id)!.draft = false;
    return { data: {} };
  }
  return undefined;
});
const clickup = await mockApi(({ method, url }) => {
  if (method === 'GET' && url === '/task/cu1/comment') return { comments: [{ comment_text: 'Only the lawfirm app', date: '1', user: { username: 'pm' } }] };
  if (method === 'GET' && url.startsWith('/task/cu1')) {
    return { id: 'cu1', name: 'Show the balance on invoices', markdown_description: 'Users need the balance.', url: 'https://app.clickup.com/t/cu1', status: { status: 'open' }, attachments: [] };
  }
  if (method === 'POST' && url === '/task/cu1/comment') return {};
  return undefined;
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
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
for (const name of ['backend', 'frontend']) {
  const bare = path.join(remotes, `your-org/${name}.git`);
  const seed = path.join(tempDir, `seed-${name}`);
  mkdirSync(path.dirname(bare), { recursive: true });
  git(tempDir, 'init', '--quiet', '--bare', '--initial-branch=main', bare);
  git(tempDir, 'init', '--quiet', '--initial-branch=main', seed);
  writeFileSync(path.join(seed, 'README.md'), `${name}\n`);
  git(seed, 'add', '.');
  git(seed, '-c', 'user.name=Seed', '-c', 'user.email=seed@example.com', 'commit', '--quiet', '-m', 'init');
  git(seed, 'push', '--quiet', bare, 'main');
}
const gitConfig = path.join(tempDir, 'gitconfig');
writeFileSync(gitConfig, `[url "file://${remotes}/"]\n\tinsteadOf = https://github.com/\n`);

/** The example as shipped, with the commands that need real projects replaced and nothing that would leave the machine. */
function exampleWorkflow(name: string, plan: string, extraEnv: Record<string, string> = {}) {
  const input = parseFormula(readFileSync(path.join(import.meta.dirname, '../../examples/task-to-pull-requests.formula.yaml'), 'utf8'));
  const commands: Record<string, string> = {
    install: 'true',
    // Fails until the fix block committed fixed.txt, so the fix loop runs once.
    backend_checks: 'test -f fixed.txt',
    frontend_checks: 'true',
  };
  const steps = input.definition.steps.map((step) => (commands[step.id] ? { ...step, with: { ...step.with, command: commands[step.id] } } : step));
  return createWorkflow({
    name,
    definition: {
      ...input.definition,
      triggers: [],
      notifications: [],
      environment: { ...input.definition.environment, runtimes: [], services: [], env: { GIT_CONFIG_GLOBAL: gitConfig, FAKE_PLAN: plan, ...extraEnv } },
      steps,
    },
  });
}

/** Answers every approval the run stops at, rejecting the first plan once with a comment. Returns the gates in order. */
async function drive(runId: string): Promise<string[]> {
  const gates: string[] = [];
  let rejectedPlan = false;
  for (;;) {
    await engine.waitForIdle();
    const run = runs.getRun(runId)!;
    if (run.status !== 'waiting') return gates;
    const [approval] = runs.listApprovals({ runId, status: 'pending' });
    gates.push(approval.stepId);
    if (approval.stepId === 'plan_review' && !rejectedPlan) {
      rejectedPlan = true;
      engine.resolveApproval(approval.id, 'rejected', 'Keep the change to the lawfirm app.');
    } else {
      engine.resolveApproval(approval.id, 'approved', '');
    }
  }
}

test('the full-stack example takes a ClickUp task through both repositories to two ready pull requests', async () => {
  const workflow = exampleWorkflow('full-stack-both', 'KIND: bug\\nBACKEND: yes\\nFRONTEND: yes\\nBLOCKERS: none');
  const run = engine.startRun(workflow, { task: { id: 'cu1', name: 'Show the balance on invoices' } });
  const gates = await drive(run.id);
  const finished = runs.getRun(run.id)!;
  assert.equal(finished.error, undefined);
  assert.equal(finished.status, 'succeeded');
  assert.deepEqual(gates, ['plan_review', 'plan_review', 'code_review', 'staging', 'final_approval']);

  const branch = 'cu1-show-the-balance-on-invoices';
  const steps = finished.context.steps;
  assert.equal(steps.reproduce.skipped, undefined, 'a bug is reproduced first');
  // The backend check failed once, was fixed, and passed on the second pass (which skips the fix block).
  const finishedBlocks = runs.listEvents(run.id).filter((event) => event.type === 'step_finished').map((event) => event.stepId);
  assert.equal(finishedBlocks.filter((id) => id === 'backend_checks').length, 2);
  assert.equal(finishedBlocks.filter((id) => id === 'backend_fix').length, 1);
  assert.equal((steps.backend_checks.output as any).passed, true);
  assert.equal(finishedBlocks.includes('frontend_fix'), false);

  // The plan rejection went back to the plan, with the comment as its prompt.
  const prompts = readFileSync(path.join(finished.workspace, 'prompts.log'), 'utf8');
  assert.match(prompts, /Address this feedback:\n\nKeep the change to the lawfirm app\./);
  assert.match(prompts, /Comments: .*Only the lawfirm app/s);

  // One branch name in both repositories, each with its own pull request, made ready at the end.
  assert.equal(git(path.join(remotes, 'your-org/backend.git'), 'log', '-1', '--format=%s', branch).trim(), 'fix: make the checks pass');
  assert.equal(git(path.join(remotes, 'your-org/frontend.git'), 'log', '-1', '--format=%s', branch).trim(), 'feat: screen change');
  assert.equal(pulls.length, 2);
  const [backend, frontend] = pulls;
  assert.deepEqual([backend.repo, backend.head, backend.draft, backend.title], ['backend', branch, false, 'feat: show the balance on invoices']);
  assert.deepEqual([frontend.repo, frontend.head, frontend.draft, frontend.title], ['frontend', branch, false, 'feat: show the balance on invoices']);
  assert.match(backend.body, /Backend summary\.[\s\S]*Frontend: https:\/\/github\.com\/your-org\/frontend\/pull\/2/);
  assert.match(frontend.body, /Frontend summary\.[\s\S]*Backend: https:\/\/github\.com\/your-org\/backend\/pull\/1/);

  const comment = await waitFor(() => clickup.requests.find((request) => request.method === 'POST' && request.url === '/task/cu1/comment'));
  assert.match(comment.body.comment_text ?? comment.body.comment ?? JSON.stringify(comment.body), /backend\/pull\/1[\s\S]*frontend\/pull\/2/);
});

test('a backend-only change from a plain webhook request opens one pull request and touches nothing else', async () => {
  pulls.length = 0;
  const workflow = exampleWorkflow('backend-only', 'KIND: feature\\nBACKEND: yes\\nFRONTEND: no\\nBLOCKERS: none');
  const run = engine.startRun(workflow, { title: 'Add an export endpoint', request: 'CSV export of invoices', kind: 'feature' });
  await drive(run.id);
  const finished = runs.getRun(run.id)!;
  assert.equal(finished.error, undefined);
  assert.equal(finished.status, 'succeeded');

  const steps = finished.context.steps;
  for (const skipped of ['task', 'reproduce', 'handoff', 'implement_frontend', 'frontend_checks', 'draft_frontend', 'pr_frontend', 'link_back']) {
    assert.equal(steps[skipped].skipped, true, `${skipped} is skipped`);
  }
  assert.equal(pulls.length, 1);
  assert.equal(pulls[0].repo, 'backend');
  assert.match(pulls[0].head, /^req-[0-9a-f-]+-add-an-export-endpoint$/);
  assert.equal(git(path.join(remotes, 'your-org/frontend.git'), 'branch', '--list', pulls[0].head).trim(), '', 'the frontend branch is never pushed');
});

test('a fix found on staging goes back through the checks, your review and staging, and updates the same pull requests', async () => {
  pulls.length = 0;
  const workflow = exampleWorkflow('staging-fix', 'KIND: feature\\nBACKEND: yes\\nFRONTEND: yes\\nBLOCKERS: none', { FAKE_STAGING_FIX: '1' });
  const run = engine.startRun(workflow, { title: 'Show the balance', request: 'On the invoice screen' });
  const gates = await drive(run.id);
  const finished = runs.getRun(run.id)!;
  assert.equal(finished.error, undefined);
  assert.equal(finished.status, 'succeeded');
  assert.deepEqual(gates, ['plan_review', 'plan_review', 'code_review', 'staging', 'code_review', 'staging', 'final_approval']);

  // Still one pull request per repository: the second push updated the drafts.
  assert.deepEqual(pulls.map((pr) => [pr.repo, pr.draft]), [['backend', false], ['frontend', false]]);
  const frontendBranch = pulls[1].head;
  assert.equal(git(path.join(remotes, 'your-org/frontend.git'), 'log', '-1', '--format=%s', frontendBranch).trim(), 'fix: label on staging');
});
