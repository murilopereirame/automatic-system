/**
 * Runs processes as the unprivileged agent user.
 *
 * Everything Claude, workflow commands and the web shell execute goes through
 * this module. Two rules keep the server's own secrets away from the agent:
 *  1. Processes get a clean environment built here, never `process.env`.
 *  2. Processes run with the agent uid/gid when the container provides one.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { config } from '../config.js';
import { getSecret } from '../store/secrets.js';
import type { Workflow } from '../types.js';

/** Per-workflow directory inside the agent home: Claude config, memory, MCP and runtime files. */
export function workflowHome(workflowId: string): string {
  return path.join(config.agentHome, 'workflows', workflowId);
}

export function claudeConfigDir(workflowId: string): string {
  return path.join(workflowHome(workflowId), 'claude');
}

/** uid/gid options for `spawn`. Empty in development, where no separate agent user exists. */
export function agentIdentity(): { uid?: number; gid?: number } {
  return config.agentUid === undefined ? {} : { uid: config.agentUid, gid: config.agentGid ?? config.agentUid };
}

/** Environment without any workflow specifics. Used for housekeeping commands. */
export function baseEnv(): Record<string, string> {
  const miseShims = path.join(config.agentHome, '.local/share/mise/shims');
  return {
    HOME: config.agentHome,
    USER: 'agent',
    SHELL: '/bin/bash',
    LANG: 'C.UTF-8',
    TERM: 'xterm-256color',
    PATH: [miseShims, path.join(config.agentHome, '.local/bin'), process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'].join(':'),
  };
}

/**
 * The environment Claude, commands and the web shell see for a workflow:
 * the formula's variables plus the secrets the formula explicitly exposes.
 */
export function workflowEnv(workflow: Workflow): Record<string, string> {
  const { env, secrets } = workflow.definition.environment;
  const exposedSecrets: Record<string, string> = {};
  for (const name of secrets) {
    const value = getSecret(name);
    if (value !== undefined) exposedSecrets[name] = value;
  }
  return {
    ...baseEnv(),
    CLAUDE_CONFIG_DIR: claudeConfigDir(workflow.id),
    MISE_GLOBAL_CONFIG_FILE: path.join(workflowHome(workflow.id), 'mise.toml'),
    MISE_YES: '1',
    ...env,
    ...exposedSecrets,
  };
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Written to the process's stdin. */
  input?: string;
  /** Called with each chunk of stdout or stderr as it arrives. */
  onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  signal?: AbortSignal;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Keeps memory bounded when a command is very chatty. */
const MAX_CAPTURE = 2_000_000;

/** Runs a command as the agent user and resolves when it exits. Never rejects on a non-zero exit code. */
export function agentExec(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? config.agentHome,
      env: options.env ?? baseEnv(),
      ...agentIdentity(),
      // Own process group, so cancelling a run also stops everything the command started.
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      if (stdout.length < MAX_CAPTURE) stdout += chunk;
      options.onOutput?.(chunk, 'stdout');
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      if (stderr.length < MAX_CAPTURE) stderr += chunk;
      options.onOutput?.(chunk, 'stderr');
    });

    const kill = () => {
      try {
        process.kill(-child.pid!, 'SIGTERM');
      } catch {
        // The process group is already gone.
      }
    };
    options.signal?.addEventListener('abort', kill, { once: true });
    if (options.signal?.aborted) kill();

    child.on('error', reject);
    child.on('close', (code, killedBy) => {
      options.signal?.removeEventListener('abort', kill);
      resolve({ code: code ?? (killedBy ? 128 : 1), stdout, stderr });
    });

    child.stdin.on('error', () => {});
    child.stdin.end(options.input ?? '');
  });
}

/** Like `agentExec` but throws with the command's error output when it fails. */
export async function agentExecOrThrow(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
  const result = await agentExec(command, args, options);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().slice(-2000);
    throw new Error(`${command} ${args[0] ?? ''} failed with exit code ${result.code}: ${detail}`);
  }
  return result;
}

/** Creates a directory owned by the agent user. */
export async function agentMkdir(dir: string): Promise<void> {
  await agentExecOrThrow('mkdir', ['-p', dir], { cwd: '/' });
}

/** Writes a file owned by the agent user, creating parent directories. */
export async function agentWriteFile(file: string, content: string): Promise<void> {
  await agentExecOrThrow('sh', ['-c', 'mkdir -p "$(dirname "$1")" && cat > "$1"', 'sh', file], { cwd: '/', input: content });
}

/** Reads a file with the agent user's permissions. Returns undefined when it does not exist. */
export async function agentReadFile(file: string): Promise<string | undefined> {
  const result = await agentExec('cat', [file], { cwd: '/' });
  return result.code === 0 ? result.stdout : undefined;
}
