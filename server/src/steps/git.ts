/** Helpers shared by the git based steps. */
import { getSecret } from '../store/secrets.js';

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
