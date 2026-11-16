/**
 * Who the commits of a run are made as.
 *
 * Order of precedence:
 *  1. The commit author under Settings. It reaches every sandbox process
 *     (Claude, commands, the web shell) as git's own environment variables.
 *  2. An identity the user configured with `git config` in the web shell.
 *  3. The owner of the GitHub token. The clone block writes it into the
 *     clone's own git config, so nothing in the run commits anonymously.
 */
import { getAuthenticatedUser } from './github.js';
import { getSettings } from './store/settings.js';

export interface GitIdentity {
  name: string;
  email: string;
}

/** The commit author from Settings. Fields the user left empty are empty strings. */
export function settingsIdentity(): GitIdentity {
  const { name, email } = getSettings().git;
  return { name: name.trim(), email: email.trim() };
}

/** Git's environment variables for an identity. Empty fields are left out, so git falls back to its config for them. */
export function gitIdentityEnv(identity: Partial<GitIdentity> = settingsIdentity()): Record<string, string> {
  return {
    ...(identity.name ? { GIT_AUTHOR_NAME: identity.name, GIT_COMMITTER_NAME: identity.name } : {}),
    ...(identity.email ? { GIT_AUTHOR_EMAIL: identity.email, GIT_COMMITTER_EMAIL: identity.email } : {}),
  };
}

/** Name and no-reply address of the owner of a GitHub token. */
export async function tokenOwnerIdentity(token: string): Promise<GitIdentity & { login: string }> {
  const user = await getAuthenticatedUser(token);
  return {
    login: user.login,
    name: user.name || user.login,
    email: user.email || `${user.id}+${user.login}@users.noreply.github.com`,
  };
}
