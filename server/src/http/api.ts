/** JSON API used by the web UI. Every route here requires authentication. */
import type { FastifyInstance } from 'fastify';
import { cancelRun, resolveApproval, retryRun, startRun } from '../engine/engine.js';
import { HttpError } from '../errors.js';
import { parseDefinition, parseFormula, toFormula } from '../formula.js';
import { checkMounts, readMemory, writeMemory } from '../sandbox/environment.js';
import * as runs from '../store/runs.js';
import { deleteSecret, listSecretNames, setSecret } from '../store/secrets.js';
import { getSettings, saveSettings } from '../store/settings.js';
import * as workflows from '../store/workflows.js';
import { stepTypes } from '../steps/index.js';
import { syncTrigger, triggerTypes } from '../triggers/index.js';
import type { RunEvent, Settings, Workflow } from '../types.js';
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

/** Applies the side effects of a changed workflow: memory files on disk and the trigger watcher. */
async function afterWorkflowChange(workflow: Workflow): Promise<void> {
  await writeMemory(workflow, { overwrite: true });
  syncTrigger(workflow.id);
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
    syncTrigger(request.params.id);
    return { ok: true };
  });

  app.post<IdParams>('/workflows/:id/run', async (request) => {
    const payload = (request.body ?? {}) as Record<string, unknown>;
    return startRun(workflowOr404(request.params.id), { source: 'manual', ...payload });
  });

  app.get<IdParams>('/workflows/:id/mounts', async (request) => checkMounts(workflowOr404(request.params.id).definition.environment.mounts));

  // ---- Formulas ------------------------------------------------------------

  app.get<IdParams>('/workflows/:id/formula', async (request, reply) => {
    const workflow = workflowOr404(request.params.id);
    reply.type('application/yaml');
    return toFormula(workflow, await readMemory(workflow));
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
    const run = runs.getRun(request.params.id);
    if (!run) throw new HttpError(404, 'Run not found');
    return { run, events: runs.listEvents(run.id), approvals: runs.listApprovals({ runId: run.id }) };
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
