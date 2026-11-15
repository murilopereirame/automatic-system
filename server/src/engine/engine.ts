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
 */
import { config } from '../config.js';
import { errorMessage } from '../errors.js';
import { sendNotification } from '../notify.js';
import { agentExec, agentMkdir, workflowEnv } from '../sandbox/agent.js';
import { prepareEnvironment } from '../sandbox/environment.js';
import * as runs from '../store/runs.js';
import { getWorkflow } from '../store/workflows.js';
import { getStepType } from '../steps/index.js';
import type { StepRuntime } from '../steps/types.js';
import { renderDeep } from '../template.js';
import { MANUAL_TRIGGER, type Run, type StepConfig, type TriggerRef, type Workflow } from '../types.js';

/** Abort handles of the runs that are executing right now, by run id. */
const activeRuns = new Map<string, AbortController>();

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
  activeRuns.set(runId, controller);
  run.status = 'running';
  run.error = undefined;
  runs.saveRun(run);

  try {
    const workflow = workflowForRun(run);
    await agentMkdir(run.workspace);
    await prepareEnvironment(workflow, (chunk) => runs.addEvent(run.id, null, 'output', { text: chunk }), controller.signal);

    while (run.stepIndex < run.definition.steps.length) {
      const step = run.definition.steps[run.stepIndex];
      const paused = await executeStep(run, workflow, step, controller.signal);
      if (paused) return;
      run.stepIndex += 1;
      runs.saveRun(run);
    }
    finish(run, 'succeeded');
  } catch (error) {
    if (controller.signal.aborted) {
      finish(run, 'cancelled', 'Cancelled');
    } else {
      finish(run, 'failed', errorMessage(error));
      void sendNotification(run, { title: `${run.workflowName}: run failed`, message: run.error ?? 'Run failed' });
    }
  } finally {
    activeRuns.delete(runId);
  }
}

/** Executes one step. Returns true when the run is now waiting for a human. */
async function executeStep(run: Run, workflow: Workflow, step: StepConfig, signal: AbortSignal): Promise<boolean> {
  const stepType = getStepType(step.type);
  if (!stepType) throw new Error(`Unknown block type "${step.type}"`);

  runs.addEvent(run.id, step.id, 'step_started', { type: step.type, name: step.name ?? stepType.title });
  const result = await stepType.execute(buildRuntime(run, workflow, step, signal));
  signal.throwIfAborted();

  if ('pause' in result) {
    const approval = runs.createApproval(run.id, step.id, result.pause.message);
    run.status = 'waiting';
    runs.saveRun(run);
    runs.addEvent(run.id, step.id, 'approval_requested', { approvalId: approval.id, message: approval.message });
    void sendNotification(run, { title: `${run.workflowName}: your action is needed`, message: approval.message });
    return true;
  }

  run.context.steps[step.id] = { output: result.output ?? null };
  runs.addEvent(run.id, step.id, 'step_finished', { output: result.output ?? null });
  return false;
}

function buildRuntime(run: Run, workflow: Workflow, step: StepConfig, signal: AbortSignal): StepRuntime {
  const context = run.context;
  const log = (type: string, data: Record<string, unknown> = {}) => void runs.addEvent(run.id, step.id, type, data);
  const templateScope = { trigger: context.trigger, triggeredBy: context.triggeredBy, steps: context.steps, run: { id: run.id }, repo: context.repo };

  return {
    run,
    workflow,
    step,
    context,
    params: renderDeep(step.with, templateScope),
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
  const controller = activeRuns.get(runId);
  if (controller) return controller.abort();

  const run = runs.getRun(runId);
  if (!run || !['queued', 'waiting'].includes(run.status)) return;
  runs.dismissPendingApprovals(runId);
  finish(run, 'cancelled', 'Cancelled');
}

/** Continues a failed or cancelled run from the step it stopped at. */
export function retryRun(runId: string): void {
  const run = runs.getRun(runId);
  if (!run || !['failed', 'cancelled'].includes(run.status)) throw new Error('Only failed or cancelled runs can be retried');
  runs.dismissPendingApprovals(runId);
  runs.addEvent(run.id, null, 'retried', { fromStep: run.definition.steps[run.stepIndex]?.id });
  void executeRun(runId);
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
