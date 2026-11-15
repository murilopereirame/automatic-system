/**
 * Commits whatever is left uncommitted, pushes the working branch and opens a
 * pull request. All of it happens with the user's own GitHub token, so the
 * commit author and the pull request author are the user.
 *
 * Claude never receives this token: it is read from the secret store here and
 * handed only to the `git push` process. Place an approval block before this
 * step to make pushing depend on a human decision.
 */
import { createPullRequest, getAuthenticatedUser } from '../github.js';
import { requireSecret } from '../store/secrets.js';
import { getSettings } from '../store/settings.js';
import { gitAuthEnv } from './git.js';
import { flag, text, type StepType } from './types.js';

export const githubPrStep: StepType = {
  type: 'github_pr',
  title: 'Push and open pull request',
  description: 'Commits remaining changes, pushes the working branch and opens a pull request as you, using your GitHub token.',
  fields: [
    { key: 'title', label: 'Title', type: 'text', default: '{{trigger.task.name}}' },
    { key: 'body', label: 'Description', type: 'textarea', default: 'Implements {{trigger.task.url}}\n\n{{steps.implement.output.result}}' },
    { key: 'base', label: 'Target branch', type: 'text', placeholder: 'Base branch of the clone' },
    { key: 'draft', label: 'Open as draft', type: 'boolean', default: false },
    { key: 'tokenSecret', label: 'GitHub token secret', type: 'secret', default: 'GITHUB_TOKEN' },
  ],
  async execute({ params, exec, context, log }) {
    const repo = context.repo;
    if (!repo) throw new Error('No repository in this run. Add a "Clone repository" block before this one.');

    const tokenSecret = text(params, 'tokenSecret', 'GITHUB_TOKEN');
    const token = requireSecret(tokenSecret);
    const title = text(params, 'title', `Changes from run on ${repo.branch}`);
    const base = text(params, 'base', repo.baseBranch);

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

    const pullRequest = await createPullRequest(token, {
      owner: repo.owner,
      repo: repo.name,
      title,
      body: text(params, 'body'),
      head: repo.branch,
      base,
      draft: flag(params, 'draft'),
    });
    log('pull_request', { url: pullRequest.html_url, number: pullRequest.number, author: user.login });
    return { output: { url: pullRequest.html_url, number: pullRequest.number, branch: repo.branch } };
  },
};
