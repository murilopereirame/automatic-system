/**
 * Turns the `environment` section of a workflow into files on disk:
 * language runtimes (installed with mise), Claude memory files and the MCP
 * configuration. Also reads memory back so an exported formula carries what
 * Claude has learned since.
 */
import path from 'node:path';
import type { MemoryFile, MountSpec, Workflow } from '../types.js';
import { agentExec, agentExecOrThrow, agentMkdir, agentReadFile, agentWriteFile, claudeConfigDir, workflowEnv, workflowHome } from './agent.js';

export function mcpConfigPath(workflowId: string): string {
  return path.join(workflowHome(workflowId), 'mcp.json');
}

/** Rejects absolute paths and `..` so a formula cannot write outside its own directory. */
function safeRelativePath(relative: string): string {
  const normalized = path.posix.normalize(relative);
  if (normalized.startsWith('..') || path.posix.isAbsolute(normalized)) {
    throw new Error(`Memory path "${relative}" must stay inside the Claude config directory`);
  }
  return normalized;
}

/** Writes memory files. With `overwrite: false` existing files (possibly edited by Claude) are kept. */
export async function writeMemory(workflow: Workflow, options: { overwrite: boolean }): Promise<void> {
  const dir = claudeConfigDir(workflow.id);
  await agentMkdir(dir);
  for (const file of workflow.definition.environment.memory) {
    const target = path.join(dir, safeRelativePath(file.path));
    if (!options.overwrite && (await agentReadFile(target)) !== undefined) continue;
    await agentWriteFile(target, file.content);
  }
}

/** Snapshot of the memory on disk: CLAUDE.md, rules and auto-memory markdown files. */
export async function readMemory(workflow: Workflow): Promise<MemoryFile[]> {
  const dir = claudeConfigDir(workflow.id);
  const found = await agentExec(
    'find',
    ['.', '-maxdepth', '5', '-type', 'f', '-name', '*.md', '-size', '-256k', '(', '-path', './CLAUDE.md', '-o', '-path', './rules/*', '-o', '-path', '*/memory/*', ')'],
    { cwd: dir },
  );
  if (found.code !== 0) return workflow.definition.environment.memory;

  const files: MemoryFile[] = [];
  for (const line of found.stdout.split('\n').filter(Boolean).sort()) {
    const relative = line.replace(/^\.\//, '');
    const content = await agentReadFile(path.join(dir, relative));
    if (content !== undefined) files.push({ path: relative, content });
  }
  return files.length > 0 ? files : workflow.definition.environment.memory;
}

async function writeMcpConfig(workflow: Workflow): Promise<void> {
  const content = JSON.stringify({ mcpServers: workflow.definition.environment.mcpServers }, null, 2);
  await agentWriteFile(mcpConfigPath(workflow.id), content);
}

/** Installs the requested runtimes with mise. Already installed versions are skipped by mise itself. */
async function installRuntimes(workflow: Workflow, onOutput: (chunk: string) => void, signal?: AbortSignal): Promise<void> {
  const { runtimes } = workflow.definition.environment;
  const tools = runtimes.map((runtime) => `${JSON.stringify(runtime.name)} = ${JSON.stringify(runtime.version)}`);
  await agentWriteFile(path.join(workflowHome(workflow.id), 'mise.toml'), `[tools]\n${tools.join('\n')}\n`);
  if (runtimes.length === 0) return;
  await agentExecOrThrow('mise', ['install'], { env: workflowEnv(workflow), onOutput, signal });
}

/** Makes sure everything the workflow declares exists before its first step runs. */
export async function prepareEnvironment(workflow: Workflow, onOutput: (chunk: string) => void, signal?: AbortSignal): Promise<void> {
  await agentMkdir(workflowHome(workflow.id));
  await writeMemory(workflow, { overwrite: false });
  await writeMcpConfig(workflow);
  await installRuntimes(workflow, onOutput, signal);
}

/**
 * Volume mounts are decided when the container starts, so a workflow can only
 * declare what it expects. This reports which declared mount targets exist.
 */
export async function checkMounts(mounts: MountSpec[]): Promise<{ target: string; present: boolean }[]> {
  const results = [];
  for (const mount of mounts) {
    const probe = await agentExec('test', ['-e', mount.target], { cwd: '/' });
    results.push({ target: mount.target, present: probe.code === 0 });
  }
  return results;
}
