import path from 'node:path';
import { gitAuthEnv, parseRepo } from './git.js';
import { text, type StepType } from './types.js';

export const gitCloneStep: StepType = {
  type: 'git_clone',
  title: 'Clone repository',
  description: 'Clones a GitHub repository into the run workspace and creates a working branch. Later steps run inside the clone.',
  fields: [
    { key: 'repo', label: 'Repository', type: 'text', placeholder: 'owner/name' },
    { key: 'baseBranch', label: 'Base branch', type: 'text', placeholder: 'Repository default' },
    { key: 'branch', label: 'Working branch', type: 'text', default: 'autoworker/{{run.id}}' },
    { key: 'tokenSecret', label: 'GitHub token secret', type: 'secret', default: 'GITHUB_TOKEN', help: 'Needed for private repositories.' },
  ],
  async execute({ params, exec, run, context }) {
    const repo = parseRepo(text(params, 'repo'));
    const target = path.join(run.workspace, 'repo');
    const baseBranch = text(params, 'baseBranch');
    const authEnv = gitAuthEnv(text(params, 'tokenSecret', 'GITHUB_TOKEN'));

    const cloneArgs = ['clone', ...(baseBranch ? ['--branch', baseBranch] : []), repo.url, target];
    const clone = await exec('git', cloneArgs, { cwd: run.workspace, env: authEnv });
    if (clone.code !== 0) throw new Error(`Could not clone ${repo.owner}/${repo.name}`);

    const head = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: target, quiet: true });
    const branch = text(params, 'branch', `autoworker/${run.id}`);
    const checkout = await exec('git', ['checkout', '-b', branch], { cwd: target });
    if (checkout.code !== 0) throw new Error(`Could not create branch ${branch}`);

    context.workdir = target;
    context.repo = { ...repo, baseBranch: baseBranch || head.stdout.trim(), branch };
    return { output: context.repo };
  },
};
