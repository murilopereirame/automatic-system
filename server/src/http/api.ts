/** JSON API used by the web UI. Every route here requires authentication. */
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { planApply } from '../engine/apply-definition.js';
import { applyDefinition, cancelRun, cleanUpEndedRuns, cleanUpRun, resolveApproval, retryRun, skipStep, startRun } from '../engine/engine.js';
import { HttpError } from '../errors.js';
import { applyInputs } from '../inputs.js';
import { parseDefinition, parseFormula, toFormula } from '../formula.js';
import { config } from '../config.js';
import { recentlyBlocked } from '../egress.js';
import { checkMounts, checkServices, readMemory, readSkills, writeMemory } from '../sandbox/environment.js';
import { archiveOutputs, listOutputs, readOutput } from '../sandbox/outputs.js';
import * as runs from '../store/runs.js';
import { deleteSecret, listSecretNames, setSecret } from '../store/secrets.js';
import { getSettings, saveSettings } from '../store/settings.js';
import * as versions from '../store/versions.js';
import * as workflows from '../store/workflows.js';
import { diff } from '../diff.js';
import { stepTypes } from '../steps/index.js';
import { syncTriggers, triggerTypes } from '../triggers/index.js';
import type { Run, RunEvent, Settings, Workflow, WorkflowVersion } from '../types.js';
import { requireAuth } from './auth.js';

type IdParams = { Params: { id: string } };
type VersionParams = { Params: { id: string; version: string } };

function versionOr404(workflowId: string, number: string): WorkflowVersion {
  const version = versions.getVersion(workflowId, Number(number));
  if (!version) throw new HttpError(404, `Version ${number} not found`);
  return version;
}

/** A version as a workflow, so it can be written as a formula. */
function asWorkflow(workflow: Workflow, version: WorkflowVersion): Workflow {
  const { name, description, enabled, definition } = version;
  return { ...workflow, name, description, enabled, definition, version: version.version };
}

/** The optional description of a change that the editor sends along with a save. */
function changeMessage(body: any): string {
  return typeof body?.message === 'string' ? body.message : '';
}

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
  const { history, ...input } = parseFormula(source);
  const existing = workflows.findWorkflowByName(input.name);
  // A new workflow gets the history the formula carries. An existing one keeps its own and gains one version.
  const note = { source: 'imported' as const, message: 'Imported from a formula' };
  const workflow = existing ? workflows.updateWorkflow(existing.id, input, note)! : workflows.createWorkflow(input, note, history);
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

/** A Content-Disposition header that makes the browser save the file under `filename`, whatever characters it has. */
function attachment(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
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
    const workflow = workflows.createWorkflow(workflowInput(request.body), { message: changeMessage(request.body) });
    await afterWorkflowChange(workflow);
    return workflow;
  });

  app.put<IdParams>('/workflows/:id', async (request) => {
    workflowOr404(request.params.id);
    const workflow = workflows.updateWorkflow(request.params.id, workflowInput(request.body), { message: changeMessage(request.body) })!;
    await afterWorkflowChange(workflow);
    return workflow;
  });

  // ---- Versions (see docs/VERSIONING.md) ------------------------------------

  /** Newest first, without the definitions, which the history list does not need. */
  app.get<IdParams>('/workflows/:id/versions', async (request) => {
    workflowOr404(request.params.id);
    const counts = runs.countRunsByVersion(request.params.id);
    return versions.listVersions(request.params.id).map(({ definition: _definition, ...summary }) => ({ ...summary, runs: counts[summary.version] ?? 0 }));
  });

  app.get<VersionParams>('/workflows/:id/versions/:version', async (request) => {
    workflowOr404(request.params.id);
    return versionOr404(request.params.id, request.params.version);
  });

  /** A version as a formula, as it was saved. */
  app.get<VersionParams>('/workflows/:id/versions/:version/formula', async (request, reply) => {
    const workflow = workflowOr404(request.params.id);
    reply.type('application/yaml');
    return toFormula(asWorkflow(workflow, versionOr404(workflow.id, request.params.version)));
  });

  /** What changed between two versions, as a line diff of their formulas. `against` defaults to the version before. */
  app.get<VersionParams & { Querystring: { against?: string } }>('/workflows/:id/versions/:version/diff', async (request) => {
    const workflow = workflowOr404(request.params.id);
    const newer = versionOr404(workflow.id, request.params.version);
    const against = request.query.against ?? String(newer.version - 1);
    const older = Number(against) >= 1 ? versionOr404(workflow.id, against) : undefined;
    // Version 0 leaves `metadata.version` out, which would otherwise show up as a change in every diff.
    const text = (version: WorkflowVersion) => toFormula({ ...asWorkflow(workflow, version), version: 0 });
    return { from: older?.version ?? 0, to: newer.version, ...diff(older ? text(older) : '', text(newer)) };
  });

  /** Rollback: brings back an old version by saving its content as a new version. Nothing is lost. */
  app.post<VersionParams>('/workflows/:id/versions/:version/restore', async (request) => {
    const current = workflowOr404(request.params.id);
    const old = versionOr404(current.id, request.params.version);
    if (old.version === current.version) throw new HttpError(409, `Version ${old.version} is already the current version`);
    const { name, description, enabled, definition } = old;
    const message = changeMessage(request.body) || `Restored version ${old.version}`;
    const workflow = workflows.updateWorkflow(current.id, { name, description, enabled, definition }, { source: 'restored', message, restoredFrom: old.version })!;
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
    return outdatedRuns(workflow).map((run) => ({ runId: run.id, deferred: applyDefinition(run.id, workflow.definition, workflow.version).deferred }));
  });

  /** Which of the things a workflow expects from the deployment are actually there. */
  app.get<IdParams>('/workflows/:id/requirements', async (request) => {
    const { mounts, services } = workflowOr404(request.params.id).definition.environment;
    return { mounts: await checkMounts(mounts), services: await checkServices(services) };
  });

  // ---- Formulas ------------------------------------------------------------

  /** `?history=true` adds the earlier versions, so importing the file on a fresh deployment brings the history back. */
  app.get<IdParams & { Querystring: { history?: string } }>('/workflows/:id/formula', async (request, reply) => {
    const workflow = workflowOr404(request.params.id);
    const history = request.query.history === 'true' ? versions.listVersions(workflow.id).filter((version) => version.version < workflow.version) : undefined;
    reply.type('application/yaml');
    return toFormula(workflow, { memory: await readMemory(workflow), skills: await readSkills(workflow), history });
  });

  app.post('/formulas/import', async (request) => {
    const source = typeof request.body === 'string' ? request.body : (request.body as any)?.formula;
    if (typeof source !== 'string') throw new HttpError(400, 'Send the formula as YAML text');
    return importFormula(source);
  });

  /** Converts between the block form and YAML without saving, for the code view of the editor. */
  app.post('/formulas/render', async (request) => {
    const body = request.body as any;
    const workflow = { ...workflowInput(body), id: '', hookSecret: '', version: 0, createdAt: '', updatedAt: '' } as Workflow;
    return { formula: toFormula(workflow) };
  });

  app.post('/formulas/parse', async (request) => {
    const { history: _history, ...draft } = parseFormula(String((request.body as any)?.formula ?? ''));
    return draft;
  });

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
    return conflictOnError(() => applyDefinition(run.id, workflow.definition, workflow.version));
  });

  // ---- Output files ----------------------------------------------------------
  // What a run put in its output folder (see sandbox/outputs.ts). Downloads are
  // always attachments with nosniff, so a file such as an HTML report can never
  // run as a page of this app.

  app.get<IdParams>('/runs/:id/outputs', async (request) => listOutputs(runOr404(request.params.id).id));

  app.get<IdParams & { Querystring: { path?: string } }>('/runs/:id/outputs/file', async (request, reply) => {
    const run = runOr404(request.params.id);
    const found = await readOutput(run.id, String(request.query.path ?? ''));
    if (!found) throw new HttpError(404, 'No such file in the output folder');
    return reply
      .type('application/octet-stream')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Disposition', attachment(path.posix.basename(found.file.path)))
      .send(found.stream);
  });

  app.get<IdParams>('/runs/:id/outputs/archive', async (request, reply) => {
    const run = runOr404(request.params.id);
    return reply
      .type('application/gzip')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Disposition', attachment(`run-${run.id.slice(0, 8)}-outputs.tar.gz`))
      .send(archiveOutputs(run.id));
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

  /** Deletes the run's workspace and Claude conversation files. Only for runs that have ended; the run and its log stay. */
  app.post<IdParams>('/runs/:id/cleanup', async (request) => {
    const run = runOr404(request.params.id);
    try {
      await cleanUpRun(run.id, 'manual');
    } catch (error) {
      throw new HttpError(409, (error as Error).message);
    }
    return runs.getRun(run.id);
  });

  /** Cleans up every ended run whose files are still there. `{ workflowId }` limits it to one workflow. */
  app.post('/runs/cleanup', async (request) => {
    const workflowId = (request.body as any)?.workflowId;
    return { cleaned: await cleanUpEndedRuns(typeof workflowId === 'string' && workflowId ? workflowId : undefined) };
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
