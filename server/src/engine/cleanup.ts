/**
 * Deleting the files of a run once nobody needs them any more.
 *
 * A run leaves files in two places:
 *  1. its workspace, `<workspaces>/<run id>`: the cloned repositories, task
 *     attachments and everything Claude and the commands wrote there
 *  2. the workflow's Claude config directory: Claude Code keeps the
 *     conversation of every folder it worked in under `projects/<folder>`,
 *     and per-conversation files (todos, file history, session environment)
 *     named after the session id
 *
 * `removeRunFiles` deletes both. It only ever deletes inside the workspaces
 * directory and the workflow's Claude config directory, and it deletes as the
 * agent user, which owns all of these files.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { agentExecOrThrow, claudeConfigDir } from '../sandbox/agent.js';
import { cleanupPolicy, type Run, type RunStatus } from '../types.js';

/** True when `child` is strictly inside `parent`. */
function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * The name Claude Code gives the folder that holds the conversations of a
 * working directory: the path with every character that is not a letter or
 * digit replaced by "-", e.g. `/data/workspaces/abc/repo` -> `-data-workspaces-abc-repo`.
 */
export function claudeProjectName(dir: string): string {
  return dir.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Entries of a directory, or none when it does not exist. */
async function entries(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/** Every file and folder that belongs to the run and is still on disk. */
export async function runFiles(run: Run): Promise<string[]> {
  const workspace = path.resolve(run.workspace);
  if (!isInside(config.workspacesDir, workspace)) throw new Error(`The workspace ${run.workspace} is not inside ${config.workspacesDir}; not deleting it`);

  const files: string[] = [];
  if ((await entries(path.dirname(workspace))).includes(path.basename(workspace))) files.push(workspace);

  // Conversations of the workspace and of every folder inside it (each cloned repository).
  const claudeDir = claudeConfigDir(run.workflowId);
  const projectsDir = path.join(claudeDir, 'projects');
  const prefix = claudeProjectName(workspace);
  for (const name of await entries(projectsDir)) {
    if (name === prefix || name.startsWith(`${prefix}-`)) files.push(path.join(projectsDir, name));
  }

  // Files Claude Code names after the conversation. Session ids are UUIDs; anything else is not used in a path.
  const sessionId = run.context.claudeSessionId;
  if (sessionId && /^[\w-]+$/.test(sessionId)) {
    for (const folder of ['todos', 'file-history', 'session-env']) {
      const dir = path.join(claudeDir, folder);
      for (const name of await entries(dir)) if (name.startsWith(sessionId)) files.push(path.join(dir, name));
    }
  }
  return files.filter((file) => isInside(config.workspacesDir, file) || isInside(claudeDir, file));
}

/**
 * Deletes the run's files and returns what was deleted. Folders a command made
 * read-only (for example the Go module cache) are made writable first, so they
 * can be deleted too.
 */
export async function removeRunFiles(run: Run): Promise<string[]> {
  const files = await runFiles(run);
  if (files.length === 0) return [];
  await agentExecOrThrow('sh', ['-c', 'chmod -R u+w -- "$@" 2>/dev/null; rm -rf -- "$@"', 'sh', ...files], { cwd: '/' });
  return files;
}

/** Whether the workflow's cleanup setting deletes the files of a run that just ended with `status`. */
export function cleansUpAutomatically(run: Run, status: RunStatus): boolean {
  const { when } = cleanupPolicy(run.definition);
  if (when === 'succeeded') return status === 'succeeded';
  if (when === 'finished') return status === 'succeeded' || status === 'failed' || status === 'cancelled';
  return false;
}
