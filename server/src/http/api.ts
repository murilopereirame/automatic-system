/** JSON API used by the web UI. Every route here requires authentication. */
import type { FastifyInstance } from 'fastify';
import { planApply } from '../engine/apply-definition.js';
import { applyDefinition, cancelRun, resolveApproval, retryRun, skipStep, startRun } from '../engine/engine.js';
import { HttpError } from '../errors.js';
import { applyInputs } from '../inputs.js';
import { parseDefinition, parseFormula, toFormula } from '../formula.js';
import { config } from '../config.js';
import { recentlyBlocked } from '../egress.js';
import { checkMounts, checkServices, readMemory, readSkills, writeMemory } from '../sandbox/environment.js';
import * as runs from '../store/runs.js';
import { deleteSecret, listSecretNames, setSecret } from '../store/secrets.js';
import { getSettings, saveSettings } from '../store/settings.js';
import * as workflows from '../store/workflows.js';
import { stepTypes } from '../steps/index.js';
import { syncTriggers, triggerTypes } from '../triggers/index.js';
import type { Run, RunEvent, Settings, Workflow } from '../types.js';
import { requireAuth } from './auth.js';

type IdParams = { Params: { id: string } };

function workflowOr404(id: string): Workflow {
  const workflow = workflows.getWorkflow(id);
  if (!workflow) throw new HttpError(404, 'Workflow not found');
  return workflow;
}

function workflowInput(body: any): workflows.WorkflowInput {
  if (!body?.name || typeof body.name !== 'string') throw new HttpError(400, 'A workflow needs a name');
  return {
    name: body.name.trim(),
    description: String(body.description ?? ''),
    enabled: body.enabled !== false,
    definition: parseDefinition(body.definition),
  };
}

/** Applies the side effects of a changed workflow: memory files on disk and the trigger watchers. */
async function afterWorkflowChange(workflow: Workflow): Promise<void> {
  await writeMemory(workflow, { overwrite: true });
  syncTriggers(workflow.id);
}

/**
 * Creates the workflow described by a formula, or updates the workflow with
 * the same name. Used by the import endpoint and by the startup import.
 */
export async function importFormula(source: string): Promise<Workflow> {
  const input = parseFormula(source);
  const existing = workflows.findWorkflowByName(input.name);
  const workflow = existing ? workflows.updateWorkflow(existing.id, input)! : workflows.createWorkflow(input);
  await afterWorkflowChange(workflow);
  return workflow;
}

function runOr404(id: string): Run {
  const run = runs.getRun(id);
  if (!run) throw new HttpError(404, 'Run not found');
  return run;
}

/** Runs that can still pick up workflow edits: every run that has not succeeded. */
const OPEN_STATUSES = new Set<Run['status']>(['queued', 'running', 'waiting', 'failed', 'cancelled']);

/** Events per page of a run's log. Small enough to render at once, large enough that most runs fit in one. */
const EVENT_PAGE_SIZE = 300;
const MAX_EVENT_PAGE_SIZE = 1000;

/** True when the workflow was edited since the run took (or last applied) its copy of the definition. */
function isOutdated(run: Run, workflow: Workflow | undefined): boolean {
  return workflow !== undefined && JSON.stringify(run.definition) !== JSON.stringify(workflow.definition);
}

/** Open runs of a workflow that use an older definition than the saved one. */
function outdatedRuns(workflow: Workflow): Run[] {
  return runs.listRuns({ workflowId: workflow.id, limit: 1000 }).filter((run) => OPEN_STATUSES.has(run.status) && isOutdated(run, workflow));
}

/** Runs `action`, turning the engine's "not possible right now" errors into 409 answers. */
function conflictOnError<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    throw new HttpError(409, (error as Error).message);
  }
}

export async function registerApi(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (request) => requireAuth(request));

  /** Block and trigger catalogue. The UI renders its palette and forms from this. */
  app.get('/meta', async () => ({
    stepTypes: stepTypes.map(({ execute: _execute, ...described }) => described),
    triggerTypes: triggerTypes.map(({ type, title, description, fields }) => ({ type, title, description, fields })),
  }));

  // ---- Workflows -----------------------------------------------------------

  app.get('/workflows', async () => workflows.listWorkflows());

  app.get<IdParams>('/workflows/:id', async (request) => workflowOr404(request.params.id));

  app.post('/workflows', async (request) => {
    const workflow = workflows.createWorkflow(workflowInput(request.body));
    await afterWorkflowChange(workflow);
    return workflow;
  });

  app.put<IdParams>('/workflows/:id', async (request) => {
    workflowOr404(request.params.id);
    const workflow = workflows.updateWorkflow(request.params.id, workflowInput(request.body))!;
    await afterWorkflowChange(workflow);
    return workflow;
  });

  app.delete<IdParams>('/workflows/:id', async (request) => {
    workflows.deleteWorkflow(request.params.id);
    syncTriggers(request.params.id);
    return { ok: true };
  });

  app.post<IdParams>('/workflows/:id/run', async (request) => {
    const workflow = workflowOr404(request.params.id);
    const body = request.body ?? {};
    if (typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Send the payload of the run as a JSON object');
    const payload = applyInputs(workflow.definition.inputs ?? [], body as Record<string, unknown>);
    return startRun(workflow, { source: 'manual', ...payload });
  });

  /** Open runs that still use an older definition of this workflow, for the "apply to runs" prompt of the editor. */
  app.get<IdParams>('/workflows/:id/outdated-runs', async (request) =>
    outdatedRuns(workflowOr404(request.params.id)).map(({ id, status, createdAt }) => ({ id, status, createdAt })),
  );

  /** Applies the saved definition to every open run that uses an older one. */
  app.post<IdParams>('/workflows/:id/apply-to-runs', async (request) => {
    const workflow = workflowOr404(request.params.id);
    return outdatedRuns(workflow).map((run) => ({ runId: run.id, deferred: applyDefinition(run.id, workflow.definition).deferred }));
  });

  /** Which of the things a workflow expects from the deployment are actually there. */
  app.get<IdParams>('/workflows/:id/requirements', async (request) => {
    const { mounts, services } = workflowOr404(request.params.id).definition.environment;
    return { mounts: await checkMounts(mounts), services: await checkServices(services) };
  });

  // ---- Formulas ------------------------------------------------------------

  app.get<IdParams>('/workflows/:id/formula', async (request, reply) => {
    const workflow = workflowOr404(request.params.id);
    reply.type('application/yaml');
    return toFormula(workflow, { memory: await readMemory(workflow), skills: await readSkills(workflow) });
  });

  app.post('/formulas/import', async (request) => {
    const source = typeof request.body === 'string' ? request.body : (request.body as any)?.formula;
    if (typeof source !== 'string') throw new HttpError(400, 'Send the formula as YAML text');
    return importFormula(source);
  });

  /** Converts between the block form and YAML without saving, for the code view of the editor. */
  app.post('/formulas/render', async (request) => {
    const body = request.body as any;
    const workflow = { ...workflowInput(body), id: '', hookSecret: '', createdAt: '', updatedAt: '' } as Workflow;
    return { formula: toFormula(workflow) };
  });

  app.post('/formulas/parse', async (request) => parseFormula(String((request.body as any)?.formula ?? '')));

  // ---- Runs ----------------------------------------------------------------

  app.get<{ Querystring: { workflowId?: string } }>('/runs', async (request) => runs.listRuns({ workflowId: request.query.workflowId }));

  app.get<IdParams>('/runs/:id', async (request) => {
    const run = runOr404(request.params.id);
    const outdated = OPEN_STATUSES.has(run.status) && isOutdated(run, workflows.getWorkflow(run.workflowId));
    return { run, approvals: runs.listApprovals({ runId: run.id }), outdated };
  });

  /**
   * The run's log, newest page first: `?before=<event id>` pages back, `?stepId=` keeps one block's events.
   * Kept apart from the run so the page can refresh the run's state without downloading the whole log again.
   */
  app.get<IdParams & { Querystring: { before?: string; stepId?: string; limit?: string } }>('/runs/:id/events', async (request) => {
    const run = runOr404(request.params.id);
    const limit = Math.min(Math.max(Number(request.query.limit) || EVENT_PAGE_SIZE, 1), MAX_EVENT_PAGE_SIZE);
    const before = Number(request.query.before) || undefined;
    return runs.listEventPage(run.id, { before, stepId: request.query.stepId || undefined, limit });
  });

  /** What applying the saved workflow to this run would change, without changing anything. */
  app.get<IdParams>('/runs/:id/apply-latest', async (request) => {
    const run = runOr404(request.params.id);
    const workflow = workflows.getWorkflow(run.workflowId);
    if (!workflow) throw new HttpError(409, 'The workflow of this run was deleted');
    return planApply(run.definition, workflow.definition, run.stepIndex);
  });

  /** Switches the run to the saved workflow definition. Finished blocks keep their results. */
  app.post<IdParams>('/runs/:id/apply-latest', async (request) => {
    const run = runOr404(request.params.id);
    const workflow = workflows.getWorkflow(run.workflowId);
    if (!workflow) throw new HttpError(409, 'The workflow of this run was deleted');
    return conflictOnError(() => applyDefinition(run.id, workflow.definition));
  });

  app.post<IdParams>('/runs/:id/cancel', async (request) => {
    cancelRun(request.params.id);
    return { ok: true };
  });

  app.post<IdParams>('/runs/:id/retry', async (request) => {
    try {
      retryRun(request.params.id);
    } catch (error) {
      throw new HttpError(409, (error as Error).message);
    }
    return { ok: true };
  });

  app.post<IdParams>('/runs/:id/skip', async (request) => {
    try {
      skipStep(request.params.id);
    } catch (error) {
      throw new HttpError(409, (error as Error).message);
    }
    return { ok: true };
  });

  /** Server-sent events: everything that happens in any run, for live updates. */
  app.get('/stream', (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const send = (name: string, payload: unknown) => reply.raw.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
    const onEvent = (event: RunEvent) => send('event', event);
    const onRun = (run: unknown) => send('run', run);
    const keepAlive = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
    runs.runUpdates.on('event', onEvent).on('run', onRun);
    request.raw.on('close', () => {
      clearInterval(keepAlive);
      runs.runUpdates.off('event', onEvent).off('run', onRun);
    });
  });

  // ---- Approvals -----------------------------------------------------------

  app.get<{ Querystring: { status?: 'pending' } }>('/approvals', async (request) => {
    const approvals = runs.listApprovals({ status: request.query.status });
    return approvals.map((approval) => ({ ...approval, workflowName: runs.getRun(approval.runId)?.workflowName ?? '' }));
  });

  app.post<IdParams>('/approvals/:id/resolve', async (request) => {
    const { decision, comment } = (request.body ?? {}) as { decision?: string; comment?: string };
    if (decision !== 'approved' && decision !== 'rejected') throw new HttpError(400, 'decision must be "approved" or "rejected"');
    try {
      resolveApproval(request.params.id, decision, String(comment ?? ''));
    } catch (error) {
      throw new HttpError(409, (error as Error).message);
    }
    return { ok: true };
  });

  // ---- Secrets and settings ------------------------------------------------

  app.get('/secrets', async () => listSecretNames());

  app.put<{ Params: { name: string } }>('/secrets/:name', async (request) => {
    const { name } = request.params;
    const value = (request.body as any)?.value;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new HttpError(400, 'Secret names look like environment variable names');
    if (typeof value !== 'string' || value === '') throw new HttpError(400, 'A secret needs a value');
    setSecret(name, value);
    return { ok: true };
  });

  app.delete<{ Params: { name: string } }>('/secrets/:name', async (request) => {
    deleteSecret(request.params.name);
    return { ok: true };
  });

  /** State of the sandbox, for the Settings page. */
  app.get('/sandbox', async () => ({
    egressEnforced: config.egressProxy !== undefined,
    alwaysAllowed: config.egressAlwaysAllow,
    separateAgentUser: config.agentUid !== undefined,
    recentlyBlocked: recentlyBlocked(),
  }));

  app.get('/settings', async () => getSettings());

  app.put('/settings', async (request) => {
    const body = (request.body ?? {}) as Partial<Settings>;
    const settings: Settings = {
      git: { name: String(body.git?.name ?? ''), email: String(body.git?.email ?? '') },
    };
    saveSettings(settings);
    return settings;
  });
}
