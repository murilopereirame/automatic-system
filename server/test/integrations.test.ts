/** ClickUp trigger and the git/GitHub steps, against local stand-ins for the external services. */
import { mockApi, tempDir, waitFor } from './helpers.js';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
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
// Pull requests opened against the stand-in GitHub, so a second push finds the first one.
const openPullRequests: { repo: string; number: number; head: string; title: string; draft: boolean; node_id: string; html_url: string }[] = [];
const github = await mockApi(({ method, url, body }) => {
  if (url === '/user') return { id: 42, login: 'octo', name: 'Octo Cat', email: null };
  if (method === 'POST' && url === '/repos/acme/app/pulls') return { number: 5, html_url: `https://github.com/acme/app/pull/5`, title: body.title };
  const list = url.match(/^\/repos\/acme\/(\w+)\/pulls\?(.*)$/);
  if (method === 'GET' && list) {
    const head = new URLSearchParams(list[2]).get('head');
    return openPullRequests.filter((pr) => pr.repo === list[1] && `acme:${pr.head}` === head);
  }
  const create = url.match(/^\/repos\/acme\/(api|web|keep)\/pulls$/);
  if (method === 'POST' && create) {
    const number = 10 + openPullRequests.length;
    const pr = { repo: create[1], number, head: body.head, title: body.title, draft: body.draft, node_id: `PR_${create[1]}`, html_url: `https://github.com/acme/${create[1]}/pull/${number}` };
    openPullRequests.push(pr);
    return pr;
  }
  if (method === 'PATCH' && /^\/repos\/acme\/\w+\/pulls\/\d+$/.test(url)) return { ok: true };
  if (method === 'POST' && url === '/graphql') {
    const pr = openPullRequests.find((candidate) => candidate.node_id === body.variables.id);
    if (pr) pr.draft = false;
    return { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } };
  }
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
  assert.deepEqual(finished.context.steps.pull_request.output, { url: 'https://github.com/acme/app/pull/5', number: 5, branch: 'autoworker/t2', updated: false });

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

/** A local bare repository standing in for github.com/acme/<name>, with one commit on main. */
function bareRepository(name: string): string {
  const remotes = path.join(tempDir, 'remotes');
  const bare = path.join(remotes, `acme/${name}.git`);
  const seed = path.join(tempDir, `seed-${name}`);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  mkdirSync(path.dirname(bare), { recursive: true });
  git(tempDir, 'init', '--quiet', '--bare', '--initial-branch=main', bare);
  git(tempDir, 'init', '--quiet', '--initial-branch=main', seed);
  writeFileSync(path.join(seed, 'README.md'), `${name}\n`);
  git(seed, 'add', '.');
  git(seed, '-c', 'user.name=Seed', '-c', 'user.email=seed@example.com', 'commit', '--quiet', '-m', 'init');
  git(seed, 'push', '--quiet', bare, 'main');
  return bare;
}

test('one run works on two repositories and pushes each to its own pull request', async () => {
  const api = bareRepository('api');
  const web = bareRepository('web');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  const gitConfig = path.join(tempDir, 'gitconfig-two');
  writeFileSync(gitConfig, `[url "file://${path.join(tempDir, 'remotes')}/"]\n\tinsteadOf = https://github.com/\n`);
  const commit = (file: string) => `echo change > ${file} && git add . && git -c user.name=Bot -c user.email=bot@example.com commit --quiet -m ${file}`;

  const workflow = createWorkflow({
    name: 'full-stack',
    definition: {
      triggers: [],
      environment: { ...emptyEnvironment(), env: { GIT_CONFIG_GLOBAL: gitConfig } },
      notifications: [],
      steps: [
        { id: 'clone_api', type: 'git_clone', with: { repo: 'acme/api', path: 'backend', branch: '{{trigger.task.id}}-{{trigger.task.name | slug}}' } },
        { id: 'clone_web', type: 'git_clone', with: { repo: 'acme/web', path: 'frontend', branch: '{{repos.backend.branch}}' } },
        { id: 'plan', type: 'claude', with: { prompt: 'Plan {{trigger.task.name}}', cwd: '.' } },
        { id: 'build', type: 'claude', with: { prompt: 'Build it in {{repos.backend.name}} and {{repos.frontend.name}}', cwd: '.' } },
        { id: 'api_change', type: 'shell', with: { command: commit('api.txt'), cwd: 'backend' } },
        { id: 'web_change', type: 'shell', with: { command: commit('web.txt'), cwd: 'frontend' } },
        { id: 'where', type: 'shell', with: { command: 'pwd' } },
        { id: 'draft_api', type: 'github_pr', with: { repo: 'backend', title: 'feat: api', body: 'draft', draft: true } },
        { id: 'api_fix', type: 'shell', with: { command: commit('fix.txt'), cwd: 'backend' } },
        { id: 'ready_api', type: 'github_pr', with: { repo: 'backend', title: 'feat: api', body: 'final' } },
        { id: 'pr_web', type: 'github_pr', with: { repo: 'frontend', title: 'feat: web', body: 'Backend: {{steps.ready_api.output.url}}' } },
      ],
    },
  });

  const run = engine.startRun(workflow, { task: { id: 'abc123', name: 'Show the balance on invoices!' } });
  await engine.waitForIdle();
  const finished = runs.getRun(run.id)!;
  assert.equal(finished.error, undefined);
  assert.equal(finished.status, 'succeeded');

  // Both clones are known by folder; the first one stays the default working directory.
  const branch = 'abc123-show-the-balance-on-invoices';
  assert.equal(finished.context.repos?.backend.branch, branch);
  assert.equal(finished.context.repos?.frontend.branch, branch);
  assert.equal(finished.context.repo?.name, 'api');
  assert.equal(realpathSync((finished.context.steps.where.output as any).output.trim()), realpathSync(path.join(finished.workspace, 'backend')));

  // Claude ran in the workspace itself, and the second block continued the first conversation.
  assert.match(readFileSync(path.join(finished.workspace, 'claude-output.txt'), 'utf8'), /Build it in api and web/);
  assert.equal((finished.context.steps.build.output as any).result, 'Done (resumed)');

  // The second push to the same branch updated the draft and made it ready instead of failing.
  assert.equal((finished.context.steps.draft_api.output as any).updated, false);
  assert.deepEqual(finished.context.steps.ready_api.output, { url: 'https://github.com/acme/api/pull/10', number: 10, branch, updated: true });
  assert.equal(openPullRequests.find((pr) => pr.repo === 'api')!.draft, false);
  assert.equal(git(api, 'log', '-1', '--format=%s', branch).trim(), 'fix.txt');
  const patch = github.requests.find((request) => request.method === 'PATCH' && request.url === '/repos/acme/api/pulls/10')!;
  assert.deepEqual(patch.body, { title: 'feat: api', body: 'final' });

  // The frontend went to its own repository and pull request, linking the backend one.
  assert.equal(git(web, 'log', '-1', '--format=%s', branch).trim(), 'web.txt');
  const webPr = github.requests.find((request) => request.method === 'POST' && request.url === '/repos/acme/web/pulls')!;
  assert.equal(webPr.body.body, 'Backend: https://github.com/acme/api/pull/10');
  assert.equal(webPr.body.head, branch);
});

test('a block cannot be pointed outside the run workspace', async () => {
  const workflow = createWorkflow({
    name: 'escape',
    definition: { ...noSteps, triggers: [], steps: [{ id: 'escape', type: 'shell', with: { command: 'pwd', cwd: '../..' } }] },
  });
  const run = engine.startRun(workflow, {});
  await engine.waitForIdle();
  const finished = runs.getRun(run.id)!;
  assert.equal(finished.status, 'failed');
  assert.match(finished.error ?? '', /outside the run workspace/);
});

test('a second clone into the same folder is refused with a clear message', async () => {
  bareRepository('dup');
  const gitConfig = path.join(tempDir, 'gitconfig-dup');
  writeFileSync(gitConfig, `[url "file://${path.join(tempDir, 'remotes')}/"]\n\tinsteadOf = https://github.com/\n`);
  const workflow = createWorkflow({
    name: 'dup',
    definition: {
      ...noSteps,
      triggers: [],
      environment: { ...emptyEnvironment(), env: { GIT_CONFIG_GLOBAL: gitConfig } },
      steps: [
        { id: 'one', type: 'git_clone', with: { repo: 'acme/dup' } },
        { id: 'two', type: 'git_clone', with: { repo: 'acme/dup' } },
      ],
    },
  });
  const run = engine.startRun(workflow, {});
  await engine.waitForIdle();
  assert.match(runs.getRun(run.id)!.error ?? '', /folder "repo" already exists/);
});

test('a Claude block in another folder starts a new conversation instead of failing to resume', async () => {
  const workflow = createWorkflow({
    name: 'two-folders',
    definition: {
      ...noSteps,
      triggers: [],
      steps: [
        { id: 'mkdir', type: 'shell', with: { command: 'mkdir sub' } },
        { id: 'first', type: 'claude', with: { prompt: 'one', cwd: '.' } },
        { id: 'second', type: 'claude', with: { prompt: 'two', cwd: 'sub' } },
        { id: 'third', type: 'claude', with: { prompt: 'three', cwd: 'sub' } },
      ],
    },
  });
  const run = engine.startRun(workflow, {});
  await engine.waitForIdle();
  const finished = runs.getRun(run.id)!;
  assert.equal(finished.status, 'succeeded');
  assert.equal((finished.context.steps.second.output as any).result, 'Done');
  assert.equal((finished.context.steps.third.output as any).result, 'Done (resumed)');
  assert.ok(runs.listEvents(run.id).some((event) => event.stepId === 'second' && event.type === 'claude_new_session'));
});

test('a clone continues the most recently updated branch matching a pattern, or creates its own', async () => {
  const bare = bareRepository('cont');
  const seed = path.join(tempDir, 'seed-cont');
  const git = (cwd: string, env: Record<string, string>, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.com', ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  const heads: Record<string, string> = {};
  for (const [branch, date] of [['t9-newer', '2026-11-02T10:00:00Z'], ['t9-older', '2026-11-01T10:00:00Z']]) {
    git(seed, {}, 'checkout', '--quiet', '-B', branch, 'main');
    writeFileSync(path.join(seed, `${branch}.txt`), 'work\n');
    git(seed, {}, 'add', '.');
    git(seed, { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date }, 'commit', '--quiet', '-m', branch);
    git(seed, {}, 'push', '--quiet', bare, branch);
    heads[branch] = git(seed, {}, 'rev-parse', 'HEAD').trim();
  }
  const gitConfig = path.join(tempDir, 'gitconfig-cont');
  writeFileSync(gitConfig, `[url "file://${path.join(tempDir, 'remotes')}/"]\n\tinsteadOf = https://github.com/\n`);
  const workflow = createWorkflow({
    name: 'continue',
    definition: {
      ...noSteps,
      triggers: [],
      environment: { ...emptyEnvironment(), env: { GIT_CONFIG_GLOBAL: gitConfig } },
      steps: [
        { id: 'found', type: 'git_clone', with: { repo: 'acme/cont', path: 'found', reuseBranch: 't9-*', branch: 't9-unused' } },
        { id: 'missing', type: 'git_clone', with: { repo: 'acme/cont', path: 'missing', reuseBranch: 'zz1-*', branch: 'zz1-new' } },
        { id: 'where', type: 'shell', with: { cwd: 'found', command: 'git rev-parse --abbrev-ref HEAD; git rev-parse --abbrev-ref @{upstream}' } },
      ],
    },
  });
  const run = engine.startRun(workflow, {});
  await engine.waitForIdle();
  const finished = runs.getRun(run.id)!;
  assert.equal(finished.error, undefined);

  const found = finished.context.steps.found.output as any;
  assert.deepEqual([found.branch, found.reused, found.startCommit], ['t9-newer', true, heads['t9-newer']]);
  assert.equal((finished.context.steps.where.output as any).output.trim(), 't9-newer\norigin/t9-newer', 'tracks the remote branch');
  assert.ok(runs.listEvents(run.id).some((event) => /Several branches match t9-\*: t9-newer, t9-older/.test(String(event.data.message))));

  const missing = finished.context.steps.missing.output as any;
  assert.deepEqual([missing.branch, missing.reused, missing.startCommit], ['zz1-new', false, git(bare, {}, 'rev-parse', 'main').trim()]);
});

test('a pull request block set to keep pushes to an existing pull request without changing it', async () => {
  bareRepository('keep');
  const gitConfig = path.join(tempDir, 'gitconfig-keep');
  writeFileSync(gitConfig, `[url "file://${path.join(tempDir, 'remotes')}/"]\n\tinsteadOf = https://github.com/\n`);
  const commit = (file: string) => `echo change > ${file} && git add . && git -c user.name=Bot -c user.email=bot@example.com commit --quiet -m ${file}`;
  const workflow = createWorkflow({
    name: 'keep',
    definition: {
      ...noSteps,
      triggers: [],
      environment: { ...emptyEnvironment(), env: { GIT_CONFIG_GLOBAL: gitConfig } },
      steps: [
        { id: 'clone', type: 'git_clone', with: { repo: 'acme/keep', branch: 'keep-branch' } },
        { id: 'one', type: 'shell', with: { command: commit('one.txt') } },
        { id: 'open', type: 'github_pr', with: { title: 'feat: by a person', body: 'Written by a person.', draft: true } },
        { id: 'two', type: 'shell', with: { command: commit('two.txt') } },
        { id: 'follow_up', type: 'github_pr', with: { title: 'fix: from the comments', body: 'Would overwrite.', existing: 'keep' } },
      ],
    },
  });
  const requestsBefore = github.requests.length;
  const run = engine.startRun(workflow, {});
  await engine.waitForIdle();
  const finished = runs.getRun(run.id)!;
  assert.equal(finished.error, undefined);

  assert.equal((finished.context.steps.follow_up.output as any).updated, true);
  const ours = github.requests.slice(requestsBefore);
  assert.equal(ours.some((request) => request.method === 'PATCH' || request.url === '/graphql'), false, 'title, description and draft state are left alone');
  const pr = openPullRequests.find((candidate) => candidate.repo === 'keep')!;
  assert.deepEqual([pr.title, pr.draft], ['feat: by a person', true]);
});
