import { existsSync } from 'node:fs';
import { gitAuthEnv, parseRepo } from './git.js';
import { text, workspacePath, type StepType } from './types.js';

export const gitCloneStep: StepType = {
  type: 'git_clone',
  title: 'Clone repository',
  description:
    'Clones a GitHub repository into the run workspace and creates a working branch. Later steps run inside the first clone; clone more repositories into other folders to work on several at once.',
  fields: [
    { key: 'repo', label: 'Repository', type: 'text', placeholder: 'owner/name' },
    { key: 'baseBranch', label: 'Base branch', type: 'text', placeholder: 'Repository default' },
    { key: 'branch', label: 'Working branch', type: 'text', default: 'autoworker/{{run.id}}' },
    {
      key: 'path',
      label: 'Folder',
      type: 'text',
      default: 'repo',
      help: 'Folder in the run workspace to clone into. Give each repository its own folder, e.g. "backend" and "frontend". Other blocks refer to the clone by this name.',
    },
    { key: 'tokenSecret', label: 'GitHub token secret', type: 'secret', default: 'GITHUB_TOKEN', help: 'Needed for private repositories.' },
  ],
  async execute({ params, exec, run, context }) {
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
    const branch = text(params, 'branch', `autoworker/${run.id}`);
    const checkout = await exec('git', ['checkout', '-b', branch], { cwd: target });
    if (checkout.code !== 0) throw new Error(`Could not create branch ${branch}`);

    const cloned = { ...repo, baseBranch: baseBranch || head.stdout.trim(), branch };
    context.repos = { ...context.repos, [folder]: { ...cloned, dir: target } };
    // The first clone is where later steps work unless they name another folder.
    if (!context.repo) {
      context.workdir = target;
      context.repo = cloned;
    }
    return { output: { ...cloned, path: folder } };
  },
};
