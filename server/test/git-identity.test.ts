/**
 * Commits made inside the sandbox (by Claude, a command block or the web
 * shell) carry the user's identity, not whatever git or Claude would make up.
 * A command block that runs `git commit` stands in for Claude here.
 */
import { mockApi, tempDir } from './helpers.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { emptyEnvironment, type WorkflowDefinition } from '../src/types.js';

const github = await mockApi(({ url }) => (url === '/user' ? { id: 42, login: 'octo', name: 'Octo Cat', email: null } : undefined));
process.env.GITHUB_API_URL = github.url;
after(() => github.close());

const engine = await import('../src/engine/engine.js');
const runs = await import('../src/store/runs.js');
const { createWorkflow } = await import('../src/store/workflows.js');
const { setSecret } = await import('../src/store/secrets.js');
const { saveSettings } = await import('../src/store/settings.js');
const { baseEnv, workflowEnv } = await import('../src/sandbox/agent.js');

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });

// A local bare repository stands in for github.com/acme/identity.
const remotes = path.join(tempDir, 'identity-remotes');
const bare = path.join(remotes, 'acme/identity.git');
const seed = path.join(tempDir, 'identity-seed');
mkdirSync(path.dirname(bare), { recursive: true });
git(tempDir, 'init', '--quiet', '--bare', '--initial-branch=main', bare);
git(tempDir, 'init', '--quiet', '--initial-branch=main', seed);
writeFileSync(path.join(seed, 'README.md'), 'identity\n');
git(seed, 'add', '.');
git(seed, '-c', 'user.name=Seed', '-c', 'user.email=seed@example.com', 'commit', '--quiet', '-m', 'init');
git(seed, 'push', '--quiet', bare, 'main');

/** The sandbox's global git config. `identity` is what the user would set with `git config --global` in the web shell. */
function globalGitConfig(name: string, identity = ''): string {
  const file = path.join(tempDir, name);
  // useConfigOnly: git must not guess an author from the machine's user and host name.
  writeFileSync(file, `[url "file://${remotes}/"]\n\tinsteadOf = https://github.com/\n[user]\n\tuseConfigOnly = true\n${identity}`);
  return file;
}

/** Clones the repository and commits the way Claude would: a plain `git commit`. Returns "name <email>" of that commit. */
async function authorOfSandboxCommit(name: string, options: { gitConfig?: string; tokenSecret?: string } = {}): Promise<{ author: string; status: string; messages: string[] }> {
  const definition: WorkflowDefinition = {
    triggers: [],
    environment: { ...emptyEnvironment(), env: { GIT_CONFIG_GLOBAL: options.gitConfig ?? globalGitConfig(`gitconfig-${name}`) } },
    notifications: [],
    steps: [
      { id: 'clone', type: 'git_clone', with: { repo: 'acme/identity', tokenSecret: options.tokenSecret ?? 'IDENTITY_TOKEN' } },
      { id: 'commit', type: 'shell', with: { command: 'echo change > change.txt && git add . && git commit --quiet -m change' } },
    ],
  };
  const run = engine.startRun(createWorkflow({ name, definition }), {});
  await engine.waitForIdle();
  const finished = runs.getRun(run.id)!;
  const messages = runs.listEvents(run.id).map((event) => String(event.data.message ?? event.data.text ?? ''));
  const author = finished.status === 'succeeded' ? git(path.join(finished.workspace, 'repo'), 'log', '-1', '--format=%an <%ae> / %cn <%ce>').trim() : '';
  return { author, status: finished.status, messages };
}

setSecret('IDENTITY_TOKEN', 'ghp_identity');

test('without a commit author in Settings, sandbox commits are made as the owner of the GitHub token', async () => {
  const { author, status, messages } = await authorOfSandboxCommit('token-owner');
  assert.equal(status, 'succeeded', messages.join('\n'));
  assert.equal(author, 'Octo Cat <42+octo@users.noreply.github.com> / Octo Cat <42+octo@users.noreply.github.com>');
  assert.ok(messages.some((message) => /made as Octo Cat/.test(message)), 'the run log says whose name is used');
});

test('an identity the user set with git config is left alone', async () => {
  const gitConfig = globalGitConfig('gitconfig-own', '\tname = Shell User\n\temail = shell@example.com\n');
  const { author } = await authorOfSandboxCommit('own-config', { gitConfig });
  assert.equal(author, 'Shell User <shell@example.com> / Shell User <shell@example.com>');
});

test('without a token and without settings the run log says that no commit author is configured', async () => {
  const { status, messages } = await authorOfSandboxCommit('nobody', { tokenSecret: 'NOT_STORED' });
  assert.equal(status, 'failed', 'git refuses to commit without an author');
  assert.ok(messages.some((message) => /No commit author is configured/.test(message)));
});

test('the commit author from Settings is used for every commit in the sandbox', async () => {
  saveSettings({ git: { name: 'Mr M', email: 'm@example.com' } });
  try {
    const identity = { GIT_AUTHOR_NAME: 'Mr M', GIT_AUTHOR_EMAIL: 'm@example.com', GIT_COMMITTER_NAME: 'Mr M', GIT_COMMITTER_EMAIL: 'm@example.com' };
    // The web shell outside a run uses baseEnv, Claude and the web shell of a run use workflowEnv.
    assert.deepEqual({ ...baseEnv(), ...identity }, baseEnv());
    const workflow = createWorkflow({ name: 'env', definition: { triggers: [], environment: emptyEnvironment(), notifications: [], steps: [] } });
    assert.deepEqual({ ...workflowEnv(workflow), ...identity }, workflowEnv(workflow));

    // Settings win over the user's git config and over the token owner.
    const gitConfig = globalGitConfig('gitconfig-settings', '\tname = Shell User\n\temail = shell@example.com\n');
    const { author } = await authorOfSandboxCommit('settings', { gitConfig });
    assert.equal(author, 'Mr M <m@example.com> / Mr M <m@example.com>');
  } finally {
    saveSettings({ git: { name: '', email: '' } });
  }
});

test('with only a name in Settings, the email comes from the owner of the token', async () => {
  saveSettings({ git: { name: 'Mr M', email: '' } });
  try {
    const { author } = await authorOfSandboxCommit('name-only');
    assert.equal(author, 'Mr M <42+octo@users.noreply.github.com> / Mr M <42+octo@users.noreply.github.com>');
  } finally {
    saveSettings({ git: { name: '', email: '' } });
  }
});
