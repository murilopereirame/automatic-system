/** Helpers shared by the git based steps. */
import { settingsIdentity, tokenOwnerIdentity } from '../git-identity.js';
import { getSecret } from '../store/secrets.js';
import type { StepRuntime } from './types.js';

export interface RepoRef {
  url: string;
  owner: string;
  name: string;
}

/** Accepts `owner/name` or a full GitHub HTTPS URL. */
export function parseRepo(input: string): RepoRef {
  const match = input.trim().match(/^(?:https:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  if (!match) throw new Error(`"${input}" is not a GitHub repository. Use owner/name or https://github.com/owner/name`);
  const [, owner, name] = match;
  return { url: `https://github.com/${owner}/${name}.git`, owner, name };
}

/**
 * Environment that authenticates one git command against GitHub.
 *
 * The token is passed as an HTTP header through git's environment based
 * config. It is never written to `.git/config` or to the remote URL, so it
 * does not stay behind in the workspace where Claude could read it.
 */
export function gitAuthEnv(tokenSecret: string): Record<string, string> {
  const token = getSecret(tokenSecret);
  if (!token) return {};
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    GIT_TERMINAL_PROMPT: '0',
  };
}

/**
 * Makes sure commits made inside a fresh clone have an author, whoever makes
 * them: Claude, a command block or the user in the web shell.
 *
 * The commit author from Settings is already in the environment of every
 * sandbox process, and an identity the user set with `git config` is left
 * alone. What is still missing is filled in from the owner of the GitHub
 * token and written to the clone's own git config. Without this, git refuses
 * to commit and Claude works around it with an identity of its own.
 */
export async function ensureCommitAuthor(runtime: Pick<StepRuntime, 'exec' | 'log'>, cloneDir: string, tokenSecret: string): Promise<void> {
  const { exec, log } = runtime;
  const fromSettings = settingsIdentity();
  const configured = async (key: 'name' | 'email') => fromSettings[key] || (await exec('git', ['config', `user.${key}`], { cwd: cloneDir, quiet: true })).stdout.trim();
  const missing: ('name' | 'email')[] = [];
  for (const key of ['name', 'email'] as const) if (!(await configured(key))) missing.push(key);
  if (missing.length === 0) return;

  const token = getSecret(tokenSecret);
  if (!token) {
    log('log', { message: 'No commit author is configured. Set one under Settings, otherwise commits made in this run have no proper author.' });
    return;
  }
  try {
    const owner = await tokenOwnerIdentity(token);
    for (const key of missing) await exec('git', ['config', `user.${key}`, owner[key]], { cwd: cloneDir, quiet: true });
    log('log', { message: `Commits in this clone are made as ${owner.name} <${owner.email}>, the owner of the GitHub token. Set a commit author under Settings to change that.` });
  } catch (error) {
    log('log', { message: `Could not look up the owner of the GitHub token to use as commit author: ${(error as Error).message}` });
  }
}
