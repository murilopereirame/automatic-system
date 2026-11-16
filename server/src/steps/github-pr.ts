/**
 * Commits whatever is left uncommitted, pushes the working branch and opens a
 * pull request. All of it happens with the user's own GitHub token, so the
 * commit author and the pull request author are the user.
 *
 * Running the block again on the same branch pushes the new commits and
 * updates the pull request it opened before, instead of failing. That lets a
 * workflow open a draft early (e.g. to deploy the branch to staging) and make
 * it ready after a final approval.
 *
 * Claude never receives this token: it is read from the secret store here and
 * handed only to the `git push` process. Place an approval block before this
 * step to make pushing depend on a human decision.
 */
import { createPullRequest, findOpenPullRequest, getAuthenticatedUser, markPullRequestReady, updatePullRequest } from '../github.js';
import { requireSecret } from '../store/secrets.js';
import { getSettings } from '../store/settings.js';
import { gitAuthEnv } from './git.js';
import { flag, text, type StepType } from './types.js';

export const githubPrStep: StepType = {
  type: 'github_pr',
  title: 'Push and open pull request',
  description:
    'Commits remaining changes, pushes the working branch and opens a pull request as you, using your GitHub token. Run it again to push more commits and update the same pull request.',
  fields: [
    { key: 'title', label: 'Title', type: 'text', default: '{{trigger.task.name}}' },
    { key: 'body', label: 'Description', type: 'textarea', default: 'Implements {{trigger.task.url}}\n\n{{steps.implement.output.result}}' },
    { key: 'base', label: 'Target branch', type: 'text', placeholder: 'Base branch of the clone' },
    { key: 'draft', label: 'Open as draft', type: 'boolean', default: false, help: 'When the pull request already exists as a draft, turning this off marks it ready for review.' },
    {
      key: 'repo',
      label: 'Repository folder',
      type: 'text',
      placeholder: 'The first cloned repository',
      help: 'Folder a "Clone repository" block cloned into, e.g. "frontend". Needed only when the run cloned several repositories.',
    },
    { key: 'tokenSecret', label: 'GitHub token secret', type: 'secret', default: 'GITHUB_TOKEN' },
  ],
  async execute({ params, exec: execInWorkdir, context, log }) {
    const folder = text(params, 'repo');
    const clone = folder ? context.repos?.[folder] : undefined;
    if (folder && !clone) {
      const known = Object.keys(context.repos ?? {});
      throw new Error(`No repository was cloned into "${folder}" in this run.${known.length ? ` Cloned: ${known.join(', ')}.` : ''}`);
    }
    const repo = clone ?? context.repo;
    if (!repo) throw new Error('No repository in this run. Add a "Clone repository" block before this one.');
    const exec: typeof execInWorkdir = (command, args, options = {}) => execInWorkdir(command, args, { cwd: clone?.dir, ...options });

    const tokenSecret = text(params, 'tokenSecret', 'GITHUB_TOKEN');
    const token = requireSecret(tokenSecret);
    const title = text(params, 'title', `Changes from run on ${repo.branch}`);
    const body = text(params, 'body');
    const base = text(params, 'base', repo.baseBranch);
    const draft = flag(params, 'draft');

    // Author identity: explicit settings win, otherwise the owner of the token.
    const settings = getSettings();
    const user = await getAuthenticatedUser(token);
    const authorName = settings.git.name || user.name || user.login;
    const authorEmail = settings.git.email || user.email || `${user.id}+${user.login}@users.noreply.github.com`;
    const identityEnv = {
      GIT_AUTHOR_NAME: authorName,
      GIT_AUTHOR_EMAIL: authorEmail,
      GIT_COMMITTER_NAME: authorName,
      GIT_COMMITTER_EMAIL: authorEmail,
    };

    await exec('git', ['add', '--all']);
    const staged = await exec('git', ['diff', '--cached', '--quiet'], { quiet: true });
    if (staged.code !== 0) {
      const commit = await exec('git', ['commit', '--message', title], { env: identityEnv });
      if (commit.code !== 0) throw new Error('Could not commit the changes');
    }

    const ahead = await exec('git', ['rev-list', '--count', `origin/${base}..HEAD`], { quiet: true });
    if (ahead.code === 0 && ahead.stdout.trim() === '0') {
      throw new Error(`Nothing to push: the working branch has no commits on top of ${base}`);
    }

    const push = await exec('git', ['push', '--set-upstream', 'origin', `HEAD:refs/heads/${repo.branch}`], { env: gitAuthEnv(tokenSecret) });
    if (push.code !== 0) throw new Error(`Could not push branch ${repo.branch}`);

    const existing = await findOpenPullRequest(token, repo.owner, repo.name, repo.branch);
    if (existing) {
      await updatePullRequest(token, repo.owner, repo.name, existing.number, { title, ...(body ? { body } : {}) });
      if (existing.draft && !draft) await markPullRequestReady(token, existing.node_id);
      log('pull_request', { url: existing.html_url, number: existing.number, author: user.login, updated: true, ready: !draft });
      return { output: { url: existing.html_url, number: existing.number, branch: repo.branch, updated: true } };
    }

    const pullRequest = await createPullRequest(token, {
      owner: repo.owner,
      repo: repo.name,
      title,
      body,
      head: repo.branch,
      base,
      draft,
    });
    log('pull_request', { url: pullRequest.html_url, number: pullRequest.number, author: user.login });
    return { output: { url: pullRequest.html_url, number: pullRequest.number, branch: repo.branch, updated: false } };
  },
};
