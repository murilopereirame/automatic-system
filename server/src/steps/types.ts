import type { ExecOptions, ExecResult } from '../sandbox/agent.js';
import type { FieldSpec, Run, RunContext, StepConfig, Workflow } from '../types.js';

/** What a step gets to work with. Built by the engine for every step execution. */
export interface StepRuntime {
  run: Run;
  workflow: Workflow;
  step: StepConfig;
  /** Shared, mutable run state. Changes are persisted when the step finishes. */
  context: RunContext;
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
 */
export type StepResult = { output?: unknown } | { pause: { message: string } };

/** A block type. To add a new block, create a file like the others and register it in `steps/index.ts`. */
export interface StepType {
  type: string;
  title: string;
  description: string;
  fields: FieldSpec[];
  execute(runtime: StepRuntime): Promise<StepResult>;
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
