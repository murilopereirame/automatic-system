/**
 * All runtime configuration comes from environment variables and is read once
 * here. Nothing else in the code base touches `process.env` directly.
 */
import { randomBytes } from 'node:crypto';
import path from 'node:path';

const env = process.env;
const dataDir = path.resolve(env.AUTOWORKER_DATA_DIR ?? './data');

function optionalInt(value: string | undefined): number | undefined {
  return value === undefined || value === '' ? undefined : Number(value);
}

export const config = {
  host: env.AUTOWORKER_HOST ?? '0.0.0.0',
  port: Number(env.AUTOWORKER_PORT ?? 8080),

  /** Private to the server: database and encrypted secrets. Never visible to the agent user. */
  dataDir,
  /** One sub directory per run. Owned by the agent user. */
  workspacesDir: path.resolve(env.AUTOWORKER_WORKSPACES_DIR ?? path.join(dataDir, 'workspaces')),
  /** Home of the agent user: Claude config, memory and installed runtimes. */
  agentHome: path.resolve(env.AUTOWORKER_AGENT_HOME ?? path.join(dataDir, 'agent-home')),
  /** Formula files in this directory are imported at startup. */
  formulasDir: env.AUTOWORKER_FORMULAS_DIR ? path.resolve(env.AUTOWORKER_FORMULAS_DIR) : undefined,
  /** Built web UI. */
  webDir: path.resolve(env.AUTOWORKER_WEB_DIR ?? path.join(import.meta.dirname, '../../web/dist')),

  /**
   * When set, Claude and the web shell run as this unprivileged user instead of
   * the server's own user. The container image always sets both.
   */
  agentUid: optionalInt(env.AUTOWORKER_AGENT_UID),
  agentGid: optionalInt(env.AUTOWORKER_AGENT_GID),

  claudeBin: env.AUTOWORKER_CLAUDE_BIN ?? 'claude',

  /** Login token for the web UI and API. Generated at startup when not provided. */
  token: env.AUTOWORKER_TOKEN || randomBytes(24).toString('hex'),
  tokenWasGenerated: !env.AUTOWORKER_TOKEN,
  /** Passphrase used to encrypt stored secrets. Falls back to the login token. */
  secretKey: env.AUTOWORKER_SECRET_KEY || env.AUTOWORKER_TOKEN || '',
  /** Base URL used in notification links, e.g. https://autoworker.example.com */
  publicUrl: (env.AUTOWORKER_PUBLIC_URL ?? '').replace(/\/$/, ''),

  clickupApiUrl: env.CLICKUP_API_URL ?? 'https://api.clickup.com/api/v2',
  githubApiUrl: env.GITHUB_API_URL ?? 'https://api.github.com',
};
