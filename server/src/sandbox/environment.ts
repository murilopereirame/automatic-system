/**
 * Turns the `environment` section of a workflow into files on disk:
 * language runtimes (installed with mise), Claude memory files and the MCP
 * configuration. Also reads memory back so an exported formula carries what
 * Claude has learned since.
 */
import path from 'node:path';
import net from 'node:net';
import type { MemoryFile, MountSpec, ServiceSpec, SkillSpec, Workflow } from '../types.js';
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

const skillFile = (name: string) => path.posix.join('skills', name, 'SKILL.md');

/**
 * Writes memory files and skills into the workflow's Claude config directory.
 * With `overwrite: false` existing files (possibly edited by Claude) are kept.
 */
export async function writeMemory(workflow: Workflow, options: { overwrite: boolean }): Promise<void> {
  const dir = claudeConfigDir(workflow.id);
  const { memory, skills } = workflow.definition.environment;
  const files = [...memory, ...skills.map((skill) => ({ path: skillFile(skill.name), content: skill.content }))];
  await agentMkdir(dir);
  for (const file of files) {
    const target = path.join(dir, safeRelativePath(file.path));
    if (!options.overwrite && (await agentReadFile(target)) !== undefined) continue;
    await agentWriteFile(target, file.content);
  }
}

/** Snapshot of the memory on disk: CLAUDE.md, rules and auto-memory markdown files. Skills are read separately. */
export async function readMemory(workflow: Workflow): Promise<MemoryFile[]> {
  const dir = claudeConfigDir(workflow.id);
  const isMemoryFile = ['(', '-path', `${dir}/CLAUDE.md`, '-o', '-path', `${dir}/rules/*`, '-o', '-path', '*/memory/*', ')'];
  const found = await agentExec('find', [dir, '-maxdepth', '5', '-type', 'f', '-name', '*.md', '-size', '-256k', ...isMemoryFile], { cwd: '/' });
  if (found.code !== 0) return workflow.definition.environment.memory;

  const files: MemoryFile[] = [];
  for (const line of found.stdout.split('\n').filter(Boolean).sort()) {
    const content = await agentReadFile(line);
    if (content !== undefined) files.push({ path: path.relative(dir, line), content });
  }
  return files.length > 0 ? files : workflow.definition.environment.memory;
}

/** Snapshot of the skills on disk, so skills Claude or the user added in the shell are exported too. */
export async function readSkills(workflow: Workflow): Promise<SkillSpec[]> {
  const dir = path.join(claudeConfigDir(workflow.id), 'skills');
  // `find` is given the directory as an argument, so a workflow that has no skills directory yet is simply "nothing found".
  const found = await agentExec('find', [dir, '-mindepth', '2', '-maxdepth', '2', '-type', 'f', '-name', 'SKILL.md', '-size', '-256k'], { cwd: '/' });
  if (found.code !== 0) return workflow.definition.environment.skills;

  const skills: SkillSpec[] = [];
  for (const line of found.stdout.split('\n').filter(Boolean).sort()) {
    const name = path.basename(path.dirname(line));
    const content = await agentReadFile(line);
    if (content !== undefined) skills.push({ name, content });
  }
  return skills.length > 0 ? skills : workflow.definition.environment.skills;
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
  await waitForServices(workflow.definition.environment.services, signal);
  await installRuntimes(workflow, onOutput, signal);
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: 2000 });
    const finish = (reachable: boolean) => {
      socket.destroy();
      resolve(reachable);
    };
    socket.once('connect', () => finish(true)).once('error', () => finish(false)).once('timeout', () => finish(false));
  });
}

/** Which ports of the declared service containers answer right now. */
export async function checkServices(services: ServiceSpec[]): Promise<{ name: string; port: number; reachable: boolean }[]> {
  const probes = services.flatMap((service) => service.ports.map(async (port) => ({ name: service.name, port, reachable: await canConnect(service.name, port) })));
  return Promise.all(probes);
}

/**
 * Service containers are started by compose, not by the app (the sandbox has
 * no access to Docker). A run waits a moment for them and fails with a clear
 * message when one is missing from the deployment.
 */
async function waitForServices(services: ServiceSpec[], signal?: AbortSignal, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const down = (await checkServices(services)).filter((probe) => !probe.reachable);
    if (down.length === 0) return;
    signal?.throwIfAborted();
    if (Date.now() > deadline) {
      const list = down.map((probe) => `${probe.name}:${probe.port}`).join(', ');
      throw new Error(`Service not reachable: ${list}. Add the services of this workflow to your compose file (see the Environment tab).`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
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
