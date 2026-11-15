/** ClickUp trigger and the git/GitHub steps, against local stand-ins for the external services. */
import { mockApi, tempDir, waitFor } from './helpers.js';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { emptyEnvironment } from '../src/types.js';

const assignedTasks = [{ id: 't1', name: 'Old task', url: 'https://app.clickup.com/t/t1', assignees: [{ id: 7, username: 'me' }] }];
const clickup = await mockApi(({ method, url }) => {
  if (url === '/user') return { user: { id: 7 } };
  if (url === '/team') return { teams: [{ id: 'team1' }] };
  if (url.startsWith('/team/team1/task')) return { tasks: assignedTasks };
  if (method === 'GET' && url.startsWith('/task/t9')) return { id: 't9', name: 'From webhook', assignees: [{ id: 7, username: 'me' }] };
  if (method === 'GET' && url === '/task/t5/comment') {
    return { comments: [{ comment_text: 'Second', date: '2000', user: { username: 'ana' } }, { comment_text: 'First: split into PT I and PT II', date: '1000', user: { username: 'henrique' } }] };
  }
  if (method === 'GET' && url.startsWith('/task/t5')) {
    return {
      id: 't5',
      name: 'Reverse and repost',
      markdown_description: 'See the concept note.',
      status: { status: 'in progress' },
      subtasks: [{ id: 's1', name: 'PT I', status: { status: 'open' } }],
      attachments: [{ title: 'concept note.txt', url: `${clickup.url}/files/note` }, { title: 'gone.pdf', url: `${clickup.url}/files/missing` }],
    };
  }
  if (url === '/files/note') return { text: 'attachment body' };
  if (method === 'POST' && url === '/task/t2/comment') return {};
  return undefined;
});
const github = await mockApi(({ method, url, body }) => {
  if (url === '/user') return { id: 42, login: 'octo', name: 'Octo Cat', email: null };
  if (method === 'POST' && url === '/repos/acme/app/pulls') return { number: 5, html_url: `https://github.com/acme/app/pull/5`, title: body.title };
  return undefined;
});
process.env.CLICKUP_API_URL = clickup.url;
process.env.GITHUB_API_URL = github.url;
after(() => {
  clickup.close();
  github.close();
});

const engine = await import('../src/engine/engine.js');
const runs = await import('../src/store/runs.js');
const { createWorkflow } = await import('../src/store/workflows.js');
const { setSecret } = await import('../src/store/secrets.js');
const { pollOnce } = await import('../src/triggers/clickup.js');
const { fireFor } = await import('../src/triggers/index.js');
const { buildServer } = await import('../src/http/server.js');

setSecret('CLICKUP_TOKEN', 'pk_test');
setSecret('GITHUB_TOKEN', 'ghp_test');
setSecret('CLICKUP_WEBHOOK_SECRET', 'signing-secret');

const noSteps = { environment: emptyEnvironment(), notifications: [], steps: [] };

test('ClickUp polling ignores tasks that were already assigned and fires once for new ones', async () => {
  const workflow = createWorkflow({ name: 'poller', definition: { ...noSteps, triggers: [{ id: 'mine', type: 'clickup', with: {} }] } });
  const [trigger] = workflow.definition.triggers;
  const fire = fireFor(workflow.id, trigger.id);

  await pollOnce(workflow, trigger, fire);
  assert.equal(runs.listRuns({ workflowId: workflow.id }).length, 0, 'existing tasks only set the baseline');

  assignedTasks.push({ id: 't2', name: 'New task', url: 'https://app.clickup.com/t/t2', assignees: [{ id: 7, username: 'me' }] });
  await pollOnce(workflow, trigger, fire);
  await pollOnce(workflow, trigger, fire);
  await engine.waitForIdle();

  const started = runs.listRuns({ workflowId: workflow.id });
  assert.equal(started.length, 1, 'the new task starts exactly one run');
  assert.equal((started[0].context.trigger.task as any).name, 'New task');
  assert.deepEqual(started[0].context.triggeredBy, { id: 'mine', type: 'clickup' });
  assert.ok(clickup.requests.some((request) => request.url.includes('assignees[]=7') && request.headers.authorization === 'pk_test'));
});

test('ClickUp webhooks need a valid signature and an assignment to me', async () => {
  const app = await buildServer();
  const workflow = createWorkflow({ name: 'hooked', definition: { ...noSteps, triggers: [{ id: 'calls', type: 'webhook', with: {} }, { id: 'tasks', type: 'clickup', with: { mode: 'webhook' } }] } });
  const payload = JSON.stringify({ event: 'taskAssigneeUpdated', task_id: 't9' });
  const post = (signature: string) =>
    app.inject({ method: 'POST', url: `/hooks/${workflow.id}/tasks`, headers: { 'content-type': 'application/json', 'x-signature': signature }, payload });

  assert.equal((await post('forged')).statusCode, 401);
  const signature = createHmac('sha256', 'signing-secret').update(payload).digest('hex');
  assert.equal((await post(signature)).statusCode, 200);
  await engine.waitForIdle();

  const [run] = runs.listRuns({ workflowId: workflow.id });
  assert.equal((run.context.trigger.task as any).name, 'From webhook');
  await app.close();
});

test('the fetch block loads comments and subtasks and saves attachments next to the repository', async () => {
  const workflow = createWorkflow({
    name: 'fetcher',
    definition: { ...noSteps, triggers: [], steps: [{ id: 'task', type: 'clickup_fetch_task', with: { taskId: '{{trigger.task.id}}' } }] },
  });
  const run = engine.startRun(workflow, { task: { id: 't5' } });
  await engine.waitForIdle();

  const finished = runs.getRun(run.id)!;
  assert.equal(finished.status, 'succeeded');
  const output = finished.context.steps.task.output as any;
  assert.equal(output.description, 'See the concept note.');
  assert.deepEqual(output.subtasks, [{ id: 's1', name: 'PT I', status: 'open', url: 'https://app.clickup.com/t/s1' }]);
  assert.deepEqual(output.comments.map((comment: any) => `${comment.author}: ${comment.text}`), ['henrique: First: split into PT I and PT II', 'ana: Second']);

  // One attachment exists, one cannot be downloaded: the run still succeeds and says so.
  const saved = path.join(finished.workspace, 'task-attachments', '1-concept note.txt');
  assert.deepEqual(output.attachmentFiles, [saved]);
  assert.equal(readFileSync(saved, 'utf8'), '{"text":"attachment body"}');
  assert.ok(runs.listEvents(run.id).some((event) => /gone\.pdf" was not downloaded/.test(String(event.data.message))));
});

test('clone, change, push and open a pull request as the token owner', async () => {
  // A local bare repository stands in for github.com/acme/app.
  const remotes = path.join(tempDir, 'remotes');
  const bare = path.join(remotes, 'acme/app.git');
  const seed = path.join(tempDir, 'seed');
  mkdirSync(path.dirname(bare), { recursive: true });
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  git(tempDir, 'init', '--quiet', '--bare', '--initial-branch=main', bare);
  git(tempDir, 'init', '--quiet', '--initial-branch=main', seed);
  writeFileSync(path.join(seed, 'README.md'), 'hello\n');
  git(seed, 'add', '.');
  git(seed, '-c', 'user.name=Seed', '-c', 'user.email=seed@example.com', 'commit', '--quiet', '-m', 'init');
  git(seed, 'push', '--quiet', bare, 'main');

  const gitConfig = path.join(tempDir, 'gitconfig');
  writeFileSync(gitConfig, `[url "file://${remotes}/"]\n\tinsteadOf = https://github.com/\n`);

  const workflow = createWorkflow({
    name: 'pr-flow',
    definition: {
      triggers: [],
      environment: { ...emptyEnvironment(), env: { GIT_CONFIG_GLOBAL: gitConfig } },
      notifications: [],
      steps: [
        { id: 'clone', type: 'git_clone', with: { repo: 'acme/app', branch: 'autoworker/{{trigger.task.id}}' } },
        { id: 'implement', type: 'claude', with: { prompt: 'Implement {{trigger.task.name}}' } },
        { id: 'gate', type: 'approval', with: { message: 'Open the PR?' } },
        { id: 'pull_request', type: 'github_pr', with: { title: '{{trigger.task.name}}', body: 'Summary: {{steps.implement.output.result}}' } },
        { id: 'link', type: 'clickup_comment', with: { taskId: '{{trigger.task.id}}', comment: 'PR: {{steps.pull_request.output.url}}' } },
      ],
    },
  });

  const run = engine.startRun(workflow, { task: { id: 't2', name: 'Add dark mode' } });
  await engine.waitForIdle();
  assert.equal(runs.getRun(run.id)!.status, 'waiting');
  assert.equal(git(bare, 'branch', '--list', 'autoworker/*').trim(), '', 'nothing is pushed before the approval');

  const [approval] = runs.listApprovals({ runId: run.id, status: 'pending' });
  engine.resolveApproval(approval.id, 'approved', '');
  await engine.waitForIdle();

  const finished = runs.getRun(run.id)!;
  assert.equal(finished.error, undefined);
  assert.equal(finished.status, 'succeeded');
  assert.deepEqual(finished.context.steps.pull_request.output, { url: 'https://github.com/acme/app/pull/5', number: 5, branch: 'autoworker/t2' });

  // The pushed commit is authored by the owner of the GitHub token.
  assert.equal(git(bare, 'log', '-1', '--format=%an <%ae> %s', 'autoworker/t2').trim(), 'Octo Cat <42+octo@users.noreply.github.com> Add dark mode');
  assert.match(git(bare, 'show', 'autoworker/t2:claude-output.txt'), /Implement Add dark mode/);

  const pullRequest = github.requests.find((request) => request.url === '/repos/acme/app/pulls')!;
  assert.deepEqual(pullRequest.body, { title: 'Add dark mode', body: 'Summary: Done', head: 'autoworker/t2', base: 'main', draft: false });
  assert.equal(pullRequest.headers.authorization, 'Bearer ghp_test');
  await waitFor(() => clickup.requests.find((request) => request.url === '/task/t2/comment'));

  // The token must not stay behind in the workspace.
  const leftovers = spawnSync('grep', ['-rl', 'ghp_test', finished.workspace], { encoding: 'utf8' }).stdout.trim();
  assert.equal(leftovers, '');
});
