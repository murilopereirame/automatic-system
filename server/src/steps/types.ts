import path from 'node:path';
import type { ExecOptions, ExecResult } from '../sandbox/agent.js';
import type { FieldSpec, Run, RunContext, StepConfig, Workflow } from '../types.js';

/** What a step gets to work with. Built by the engine for every step execution. */
export interface StepRuntime {
  run: Run;
  workflow: Workflow;
  step: StepConfig;
  /** Shared, mutable run state. Changes are persisted when the step finishes. */
  context: RunContext;
  /** The values templates and expressions can read: trigger, steps, previous, run, repo, repos. */
  scope: Record<string, unknown>;
  /** The step's settings with `{{ templates }}` already rendered. */
  params: Record<string, unknown>;
  /** Directory commands run in: the cloned repository, or the empty run workspace. */
  workdir: string;
  signal: AbortSignal;
  /** Adds an entry to the run's event log, shown live in the UI. */
  log(type: string, data?: Record<string, unknown>): void;
  /**
   * Runs a command as the agent user. `options.env` is added on top of the
   * workflow's environment. Command and output are logged unless `quiet` is set.
   */
  exec(command: string, args: string[], options?: ExecOptions & { quiet?: boolean }): Promise<ExecResult>;
}

/**
 * Returning `pause` stops the run until a human answers in the UI.
 * Anything in `output` becomes available to later steps as `{{steps.<id>.output}}`.
 * `goTo` names the block the run continues with, instead of the next one.
 */
export type StepResult = { output?: unknown; goTo?: string } | { pause: { message: string } };

/** A block type. To add a new block, create a file like the others and register it in `steps/index.ts`. */
export interface StepType {
  type: string;
  title: string;
  description: string;
  fields: FieldSpec[];
  execute(runtime: StepRuntime): Promise<StepResult>;
  /**
   * What a person is shown when the run pauses before this block (`pauseBefore`),
   * e.g. the prompt of a Claude block. Must not change the run.
   */
  preview?(runtime: StepRuntime): Record<string, unknown>;
}

/** Small helpers to read rendered settings with a fallback. */
export function text(params: Record<string, unknown>, key: string, fallback = ''): string {
  const value = params[key];
  return value === undefined || value === null || value === '' ? fallback : String(value);
}

export function flag(params: Record<string, unknown>, key: string, fallback = false): boolean {
  const value = params[key];
  return value === undefined || value === null || value === '' ? fallback : value === true || value === 'true';
}

/**
 * Resolves a folder a block was told to use, relative to the run workspace.
 * Refuses absolute paths and anything that would leave the workspace, so a
 * setting (or a value templated into it) can never point a block elsewhere.
 */
export function workspacePath(workspace: string, relative: string): string {
  const value = relative.trim();
  if (path.isAbsolute(value)) throw new Error(`"${relative}" must be a folder inside the run workspace, not an absolute path`);
  const resolved = path.resolve(workspace, value);
  const inside = path.relative(workspace, resolved);
  if (inside.startsWith('..') || path.isAbsolute(inside)) throw new Error(`"${relative}" is outside the run workspace`);
  return resolved;
}

/** The directory a block's commands run in: its `cwd` setting when given, otherwise the default working directory. */
export function blockCwd(runtime: Pick<StepRuntime, 'params' | 'run' | 'workdir'>): string {
  const cwd = text(runtime.params, 'cwd');
  return cwd ? workspacePath(runtime.run.workspace, cwd) : runtime.workdir;
}

/** The `cwd` setting shared by blocks that run commands. */
export const cwdField: FieldSpec = {
  key: 'cwd',
  label: 'Folder',
  type: 'text',
  placeholder: 'The cloned repository',
  help: 'Relative to the run workspace, e.g. "frontend" for a repository cloned into that folder, or "." for the workspace itself.',
} as const;
