/**
 * The workflow engine: executes the steps of a run one after another.
 *
 * A run is a small state machine persisted in the database:
 *
 *   queued -> running -> succeeded | failed | cancelled
 *                 |  ^
 *                 v  |   (approval block)
 *               waiting
 *
 * `run.stepIndex` always points at the step that is running, waiting for a
 * human, or that failed. That is what makes "retry" and "resume after
 * approval" simple: execution just continues from `stepIndex`.
 *
 * Steps normally run in list order. Conditions change that in two ways: a
 * step whose `if` is false is skipped, and a condition block can name the
 * step the run continues with (see `jump`).
 *
 * A run keeps its own copy of the workflow definition. `applyDefinition`
 * switches that copy to a newer one (see apply-definition.ts).
 */
import { config } from '../config.js';
import { errorMessage } from '../errors.js';
import { sendNotification } from '../notify.js';
import { agentExec, agentMkdir, workflowEnv } from '../sandbox/agent.js';
import { prepareEnvironment } from '../sandbox/environment.js';
import * as runs from '../store/runs.js';
import { getWorkflow } from '../store/workflows.js';
import { evaluate, truthy } from '../expression.js';
import { END_OF_RUN } from '../steps/condition.js';
import { getStepType } from '../steps/index.js';
import { planApply, type ApplyPlan } from './apply-definition.js';
import { text, type StepRuntime } from '../steps/types.js';
import { renderDeep } from '../template.js';
import { MANUAL_TRIGGER, type Run, type SCOPE_NAMES, type StepConfig, type TriggerRef, type Workflow, type WorkflowDefinition } from '../types.js';

/**
 * A run that is executing right now: how to stop its current step, whether
 * that stop is a "skip this block", and a definition to switch to as soon as
 * the current step is done (a step is never changed while it runs).
 */
interface ActiveRun {
  controller: AbortController;
  skipRequested: boolean;
  pendingDefinition?: WorkflowDefinition;
}

const activeRuns = new Map<string, ActiveRun>();

const SKIPPED_BY_HAND = 'skipped by hand';

/** Creates a run for a workflow and starts executing it in the background. */
export function startRun(workflow: Workflow, payload: Record<string, unknown>, triggeredBy: TriggerRef = MANUAL_TRIGGER): Run {
  const run = runs.createRun(workflow, config.workspacesDir, { trigger: payload, triggeredBy, steps: {} });
  runs.addEvent(run.id, null, 'triggered', { trigger: triggeredBy.type, triggerId: triggeredBy.id, payload });
  void executeRun(run.id);
  return run;
}

/** Runs steps from `run.stepIndex` until the run finishes, fails or has to wait for a human. */
export async function executeRun(runId: string): Promise<void> {
  const run = runs.getRun(runId);
  if (!run || activeRuns.has(runId)) return;

  const controller = new AbortController();
  const active: ActiveRun = { controller, skipRequested: false };
  activeRuns.set(runId, active);
  run.status = 'running';
  run.error = undefined;
  runs.saveRun(run);

  const prepare = (workflow: Workflow) => prepareEnvironment(workflow, (chunk) => runs.addEvent(run.id, null, 'output', { text: chunk }), controller.signal);
  try {
    let workflow = workflowForRun(run);
    await agentMkdir(run.workspace);
    await prepare(workflow);

    while (run.stepIndex < run.definition.steps.length) {
      const step = run.definition.steps[run.stepIndex];
      const next = await executeStep(run, workflow, step, controller.signal);
      if (next === 'paused') return;
      run.stepIndex = next;
      if (active.pendingDefinition) {
        const plan = switchDefinition(run, active.pendingDefinition);
        active.pendingDefinition = undefined;
        workflow = workflowForRun(run);
        if (plan.sections.includes('environment')) await prepare(workflow);
      }
      runs.saveRun(run);
    }
    finish(run, 'succeeded');
  } catch (error) {
    if (active.skipRequested) {
      skipCurrentStep(run);
    } else if (controller.signal.aborted) {
      finish(run, 'cancelled', 'Cancelled');
    } else {
      finish(run, 'failed', errorMessage(error));
      void sendNotification(run, { title: `${run.workflowName}: run failed`, message: run.error ?? 'Run failed' });
    }
  } finally {
    activeRuns.delete(runId);
  }
  // The run stopped (waiting, failed, cancelled) before it could switch to a newer definition: switch now.
  if (active.pendingDefinition) applyToStoppedRun(run, active.pendingDefinition);
  // The step that was running has been stopped and passed over: carry on with the next one.
  if (active.skipRequested) await executeRun(runId);
}

/** Executes one step. Returns the index of the step to continue with, or 'paused' when the run is now waiting for a human. */
async function executeStep(run: Run, workflow: Workflow, step: StepConfig, signal: AbortSignal): Promise<number | 'paused'> {
  const stepType = getStepType(step.type);
  if (!stepType) throw new Error(`Unknown block type "${step.type}"`);
  const scope = scopeFor(run);

  if (step.if && !truthy(evaluate(step.if, scope))) {
    skip(run, step, `its condition is false: ${step.if}`);
    return run.stepIndex + 1;
  }

  runs.addEvent(run.id, step.id, 'step_started', { type: step.type, name: step.name ?? stepType.title });
  const result = await stepType.execute(buildRuntime(run, workflow, step, scope, signal));
  signal.throwIfAborted();

  if ('pause' in result) {
    const approval = runs.createApproval(run.id, step.id, result.pause.message);
    run.status = 'waiting';
    runs.saveRun(run);
    runs.addEvent(run.id, step.id, 'approval_requested', { approvalId: approval.id, message: approval.message });
    void sendNotification(run, { title: `${run.workflowName}: your action is needed`, message: approval.message });
    return 'paused';
  }

  run.context.steps[step.id] = { output: result.output ?? null };
  runs.addEvent(run.id, step.id, 'step_finished', { output: result.output ?? null });
  return result.goTo ? jump(run, step, result.goTo) : run.stepIndex + 1;
}

/** The values the current step can read. `previous` is the block right above it in the list. */
function scopeFor(run: Run): Record<(typeof SCOPE_NAMES)[number], unknown> {
  const context = run.context;
  const above = run.definition.steps[run.stepIndex - 1];
  return {
    trigger: context.trigger,
    triggeredBy: context.triggeredBy,
    steps: context.steps,
    previous: (above && context.steps[above.id]) ?? { output: null },
    run: { id: run.id },
    repo: context.repo,
    repos: context.repos,
  };
}

/** Records that the run passed over a step. Its output reads as empty from then on. */
function skip(run: Run, step: StepConfig, reason: string): void {
  run.context.steps[step.id] = { output: null, skipped: true };
  runs.addEvent(run.id, step.id, 'step_skipped', { name: step.name ?? step.id, reason });
}

/**
 * Works out where the run continues after `step` asked to go to `target`: a
 * block id, or END_OF_RUN. Blocks that are jumped over are marked as skipped.
 * Going back to an earlier block is counted per step and limited by its
 * `maxRepeats` setting, so a condition that never becomes true fails the run
 * instead of looping forever.
 */
function jump(run: Run, step: StepConfig, target: string): number {
  const steps = run.definition.steps;
  const from = run.stepIndex;
  const to = target === END_OF_RUN ? steps.length : steps.findIndex((candidate) => candidate.id === target);
  if (to === -1) throw new Error(`Block "${target}" does not exist`);

  if (to <= from) {
    const limit = Number(text(step.with, 'maxRepeats', '3'));
    const repeats = (run.context.repeats ??= {});
    if ((repeats[step.id] ?? 0) >= limit) throw new Error(`"${step.name ?? step.id}" already went back ${limit} times. Giving up instead of looping forever.`);
    repeats[step.id] = (repeats[step.id] ?? 0) + 1;
  }
  for (const passed of steps.slice(from + 1, to)) skip(run, passed, `"${step.name ?? step.id}" continued with ${target === END_OF_RUN ? 'the end of the run' : `"${target}"`}`);
  return to;
}

function buildRuntime(run: Run, workflow: Workflow, step: StepConfig, scope: Record<string, unknown>, signal: AbortSignal): StepRuntime {
  const context = run.context;
  const log = (type: string, data: Record<string, unknown> = {}) => void runs.addEvent(run.id, step.id, type, data);

  return {
    run,
    workflow,
    step,
    context,
    scope,
    params: renderDeep(step.with, scope),
    workdir: context.workdir ?? run.workspace,
    signal,
    log,
    exec(command, args, options = {}) {
      if (!options.quiet) log('command', { command: [command, ...args].join(' ') });
      const logOutput = (text: string, stream: string) => log('output', { text, stream });
      return agentExec(command, args, {
        cwd: options.cwd ?? context.workdir ?? run.workspace,
        env: { ...workflowEnv(workflow), ...options.env },
        input: options.input,
        signal,
        onOutput: options.onOutput ?? (options.quiet ? undefined : logOutput),
      });
    },
  };
}

/** The workflow a run belongs to, pinned to the definition the run started with. */
function workflowForRun(run: Run): Workflow {
  const workflow = getWorkflow(run.workflowId);
  if (!workflow) throw new Error('The workflow of this run was deleted');
  return { ...workflow, definition: run.definition };
}

function finish(run: Run, status: 'succeeded' | 'failed' | 'cancelled', error?: string): void {
  run.status = status;
  run.error = error;
  runs.saveRun(run);
  runs.addEvent(run.id, null, 'run_finished', { status, error });
}

/**
 * Applies a human decision to a waiting run.
 *  - approved: continue with the next step
 *  - rejected with "On reject, go back to" configured: resume at that step, with the comment as feedback for Claude
 *  - rejected otherwise: the run ends as cancelled
 */
export function resolveApproval(approvalId: string, decision: 'approved' | 'rejected', comment: string): void {
  const approval = runs.getApproval(approvalId);
  if (!approval || approval.status !== 'pending') throw new Error('This approval is no longer pending');
  const run = runs.getRun(approval.runId);
  if (!run || run.status !== 'waiting') throw new Error('The run is not waiting for approval');

  const step = run.definition.steps[run.stepIndex];
  runs.resolveApproval(approvalId, decision, comment);
  run.context.steps[step.id] = { output: { decision, comment } };
  runs.addEvent(run.id, step.id, 'approval_resolved', { approvalId, decision, comment });

  if (decision === 'approved') {
    run.stepIndex += 1;
  } else {
    const goBackTo = run.definition.steps.findIndex((candidate) => candidate.id === step.with.onReject);
    if (goBackTo === -1) return finish(run, 'cancelled', `Rejected${comment ? `: ${comment}` : ''}`);
    run.stepIndex = goBackTo;
    run.context.feedback = comment || 'The reviewer rejected the result without a comment.';
  }
  runs.saveRun(run);
  void executeRun(run.id);
}

export function cancelRun(runId: string): void {
  const active = activeRuns.get(runId);
  if (active) return active.controller.abort();

  const run = runs.getRun(runId);
  if (!run || !['queued', 'waiting'].includes(run.status)) return;
  runs.dismissPendingApprovals(runId);
  finish(run, 'cancelled', 'Cancelled');
}

/**
 * Continues a failed or cancelled run from the step it stopped at.
 *
 * A retry is a person saying "try again", so the going-back counters of the
 * condition blocks start from zero. Without that, a run that failed because a
 * condition used up its `maxRepeats` would fail again right away: the
 * condition is still false and it would have no repeats left.
 */
export function retryRun(runId: string): void {
  const run = runs.getRun(runId);
  if (!run || !['failed', 'cancelled'].includes(run.status)) throw new Error('Only failed or cancelled runs can be retried');
  runs.dismissPendingApprovals(runId);
  run.context.repeats = {};
  runs.saveRun(run);
  runs.addEvent(run.id, null, 'retried', { fromStep: run.definition.steps[run.stepIndex]?.id });
  void executeRun(runId);
}

/**
 * Passes over the step a run is at and continues with the next one. For a
 * step that is stuck, or that a person decides the run can do without.
 *  - running: the step's command or Claude session is stopped first
 *  - waiting: the approval is dismissed
 *  - failed or cancelled: like a retry, but starting after the step
 * The step is recorded like one skipped by a condition (`output: null`,
 * `skipped: true`), so later blocks can check `steps.<id>.skipped`.
 */
export function skipStep(runId: string): void {
  const run = runs.getRun(runId);
  if (!run || !['running', 'waiting', 'failed', 'cancelled'].includes(run.status)) throw new Error('Only a run that is running, waiting, failed or cancelled can skip a block');
  if (!run.definition.steps[run.stepIndex]) throw new Error('This run has no block left to skip');

  const active = activeRuns.get(runId);
  if (active) {
    // executeRun notices the flag when the stopped step throws, and continues from there.
    active.skipRequested = true;
    return active.controller.abort();
  }
  runs.dismissPendingApprovals(runId);
  run.context.repeats = {};
  skipCurrentStep(run);
  void executeRun(runId);
}

/** Marks the step at `run.stepIndex` as skipped by a person and moves the run to the next step. */
function skipCurrentStep(run: Run): void {
  skip(run, run.definition.steps[run.stepIndex], SKIPPED_BY_HAND);
  run.stepIndex += 1;
  runs.saveRun(run);
}

/**
 * Switches a run to another definition of its workflow, usually the latest one
 * after it was edited. Finished blocks keep their results; the block the run
 * is at and the blocks after it come from `definition` (see apply-definition.ts).
 *  - running: the step that runs now finishes as it is, the switch happens right after it
 *  - waiting, failed, cancelled: the switch happens now; a failed run then continues on Retry
 *  - waiting at a block that `definition` removed: its approval is dismissed and the run continues
 * Returns the plan, and whether the switch still has to wait for the running step.
 */
export function applyDefinition(runId: string, definition: WorkflowDefinition): { plan: ApplyPlan; deferred: boolean } {
  const run = runs.getRun(runId);
  if (!run) throw new Error('Run not found');
  if (run.status === 'succeeded') throw new Error('This run has finished. Start a new run to use the latest workflow.');

  const plan = planApply(run.definition, definition, run.stepIndex);
  if (plan.upToDate) return { plan, deferred: false };

  const active = activeRuns.get(runId);
  if (active) {
    active.pendingDefinition = definition;
    runs.addEvent(run.id, null, 'definition_queued', { reason: 'The workflow changes apply once the current block is done.' });
    return { plan, deferred: true };
  }
  applyToStoppedRun(run, definition);
  return { plan, deferred: false };
}

/** Switches a run that is not executing. A run waiting at a removed block has nothing left to wait for, so it continues. */
function applyToStoppedRun(run: Run, definition: WorkflowDefinition): void {
  const plan = switchDefinition(run, definition);
  runs.saveRun(run);
  if (run.status === 'waiting' && plan.currentRemoved) {
    runs.dismissPendingApprovals(run.id);
    void executeRun(run.id);
  }
}

/** Replaces the run's definition in memory and moves its position to the matching block. The caller saves the run. */
function switchDefinition(run: Run, definition: WorkflowDefinition): ApplyPlan {
  const plan = planApply(run.definition, definition, run.stepIndex);
  // Versioning: this is the one place, besides runs.createRun, where a run's definition is set.
  run.definition = definition;
  run.stepIndex = plan.continueIndex;
  runs.addEvent(run.id, null, 'definition_applied', { blocks: plan.blocks, sections: plan.sections, continueAt: plan.continueAt });
  return plan;
}

/** Called once at startup: runs that were executing when the server stopped cannot continue on their own. */
export function recoverInterruptedRuns(): void {
  for (const status of ['running', 'queued'] as const) {
    for (const run of runs.listRunsByStatus(status)) {
      finish(run, 'failed', 'Interrupted by a restart. Retry to continue from this step.');
    }
  }
}

/** Resolves when no run is executing. Used by tests. */
export async function waitForIdle(): Promise<void> {
  while (activeRuns.size > 0) await new Promise((resolve) => setTimeout(resolve, 20));
}
