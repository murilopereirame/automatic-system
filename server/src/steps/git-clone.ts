import { existsSync } from 'node:fs';
import { gitAuthEnv, parseRepo } from './git.js';
import { text, workspacePath, type StepRuntime, type StepType } from './types.js';

export const gitCloneStep: StepType = {
  type: 'git_clone',
  title: 'Clone repository',
  description:
    'Clones a GitHub repository into the run workspace and creates a working branch, or continues an existing one. Later steps run inside the first clone; clone more repositories into other folders to work on several at once.',
  fields: [
    { key: 'repo', label: 'Repository', type: 'text', placeholder: 'owner/name' },
    { key: 'baseBranch', label: 'Base branch', type: 'text', placeholder: 'Repository default' },
    { key: 'branch', label: 'Working branch', type: 'text', default: 'autoworker/{{run.id}}' },
    {
      key: 'reuseBranch',
      label: 'Continue an existing branch',
      type: 'text',
      placeholder: 'e.g. {{trigger.task.id}}-*',
      help: 'A branch name, or a pattern with *. When a branch on the remote matches, it is checked out and later commits go on top of it; with several matches the most recently updated one wins. When none matches, Working branch is created as usual.',
    },
    {
      key: 'path',
      label: 'Folder',
      type: 'text',
      default: 'repo',
      help: 'Folder in the run workspace to clone into. Give each repository its own folder, e.g. "backend" and "frontend". Other blocks refer to the clone by this name.',
    },
    { key: 'tokenSecret', label: 'GitHub token secret', type: 'secret', default: 'GITHUB_TOKEN', help: 'Needed for private repositories.' },
  ],
  async execute({ params, exec, run, context, log }) {
    const repo = parseRepo(text(params, 'repo'));
    const folder = text(params, 'path', 'repo');
    const target = workspacePath(run.workspace, folder);
    if (target === run.workspace) throw new Error('Clone into a folder of the run workspace, not into the workspace itself');
    if (existsSync(target)) throw new Error(`The folder "${folder}" already exists in this run. Give each repository its own folder.`);
    const baseBranch = text(params, 'baseBranch');
    const authEnv = gitAuthEnv(text(params, 'tokenSecret', 'GITHUB_TOKEN'));

    const cloneArgs = ['clone', ...(baseBranch ? ['--branch', baseBranch] : []), repo.url, target];
    const clone = await exec('git', cloneArgs, { cwd: run.workspace, env: authEnv });
    if (clone.code !== 0) throw new Error(`Could not clone ${repo.owner}/${repo.name}`);

    const head = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: target, quiet: true });
    const existing = await findRemoteBranch(exec, target, text(params, 'reuseBranch'), log);
    const branch = existing ?? text(params, 'branch', `autoworker/${run.id}`);
    const checkout = !existing
      ? await exec('git', ['checkout', '-b', branch], { cwd: target })
      : existing === head.stdout.trim()
        ? { code: 0 }
        : await exec('git', ['checkout', '-b', branch, '--track', `origin/${branch}`], { cwd: target });
    if (checkout.code !== 0) throw new Error(existing ? `Could not check out branch ${branch}` : `Could not create branch ${branch}`);
    // Where this run started, so later blocks can tell this run's commits from the branch's earlier ones.
    const start = await exec('git', ['rev-parse', 'HEAD'], { cwd: target, quiet: true });

    const cloned = { ...repo, baseBranch: baseBranch || head.stdout.trim(), branch };
    context.repos = { ...context.repos, [folder]: { ...cloned, dir: target } };
    // The first clone is where later steps work unless they name another folder.
    if (!context.repo) {
      context.workdir = target;
      context.repo = cloned;
    }
    return { output: { ...cloned, path: folder, reused: existing !== undefined, startCommit: start.stdout.trim() } };
  },
};

/**
 * The remote branch a `reuseBranch` name or pattern points at, if any. A clone
 * already has every remote branch under refs/remotes/origin, so this needs no
 * extra fetch. Several matches: the one with the newest commit.
 */
async function findRemoteBranch(exec: StepRuntime['exec'], cwd: string, pattern: string, log: StepRuntime['log']): Promise<string | undefined> {
  if (!pattern) return undefined;
  if (!/^[\w./*-]+$/.test(pattern) || pattern.includes('..')) throw new Error(`"${pattern}" is not a branch name or pattern`);
  const refs = await exec('git', ['for-each-ref', '--sort=-committerdate', '--format=%(refname:lstrip=3)', `refs/remotes/origin/${pattern}`], { cwd, quiet: true });
  const matches = refs.stdout.split('\n').map((line) => line.trim()).filter((name) => name && name !== 'HEAD');
  if (matches.length === 0) {
    log('log', { message: `No branch matches ${pattern} on the remote; creating a new one` });
    return undefined;
  }
  if (matches.length > 1) log('log', { message: `Several branches match ${pattern}: ${matches.join(', ')}. Continuing ${matches[0]}, the most recently updated` });
  else log('log', { message: `Continuing the existing branch ${matches[0]}` });
  return matches[0];
}
