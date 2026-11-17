/** Persistence for runs, their event log and approval requests. */
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { db, now } from '../db.js';
import { upgradeDefinition, type Approval, type Run, type RunContext, type RunEvent, type RunStatus, type Workflow } from '../types.js';

/** Emits `event` (RunEvent) and `run` (Run) whenever something changes, for live UI updates. */
export const runUpdates = new EventEmitter();
runUpdates.setMaxListeners(0);

interface RunRow {
  id: string;
  workflow_id: string;
  workflow_name: string;
  status: RunStatus;
  step_index: number;
  definition: string;
  context: string;
  workspace: string;
  workflow_version: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

function runFromRow(row: RunRow): Run {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    workflowName: row.workflow_name,
    status: row.status,
    stepIndex: row.step_index,
    definition: upgradeDefinition(JSON.parse(row.definition)),
    ...(row.workflow_version !== null && { workflowVersion: row.workflow_version }),
    context: JSON.parse(row.context),
    workspace: row.workspace,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Creates a queued run. Its workspace is `<workspaceRoot>/<run id>`. */
export function createRun(workflow: Workflow, workspaceRoot: string, context: RunContext): Run {
  const id = randomUUID();
  const timestamp = now();
  db.prepare(
    `INSERT INTO runs (id, workflow_id, workflow_name, status, step_index, definition, workflow_version, context, workspace, created_at, updated_at)
     VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?)`,
  ).run(id, workflow.id, workflow.name, JSON.stringify(workflow.definition), workflow.version, JSON.stringify(context), path.join(workspaceRoot, id), timestamp, timestamp);
  return getRun(id)!;
}

export function getRun(id: string): Run | undefined {
  const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
  return row && runFromRow(row);
}

export function listRuns(filter: { workflowId?: string; limit?: number } = {}): Run[] {
  const rows = filter.workflowId
    ? db.prepare('SELECT * FROM runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT ?').all(filter.workflowId, filter.limit ?? 100)
    : db.prepare('SELECT * FROM runs ORDER BY created_at DESC LIMIT ?').all(filter.limit ?? 100);
  return (rows as unknown as RunRow[]).map(runFromRow);
}

/** How many runs each version of a workflow started (or was applied to). */
export function countRunsByVersion(workflowId: string): Record<number, number> {
  const rows = db.prepare('SELECT workflow_version AS version, COUNT(*) AS count FROM runs WHERE workflow_id = ? AND workflow_version IS NOT NULL GROUP BY workflow_version').all(workflowId) as { version: number; count: number }[];
  return Object.fromEntries(rows.map((row) => [row.version, row.count]));
}

export function listRunsByStatus(status: RunStatus): Run[] {
  return (db.prepare('SELECT * FROM runs WHERE status = ?').all(status) as unknown as RunRow[]).map(runFromRow);
}

/** Saves the mutable parts of a run and tells listeners about it. The definition changes only when newer workflow edits are applied to the run. */
export function saveRun(run: Run): void {
  run.updatedAt = now();
  db.prepare('UPDATE runs SET status = ?, step_index = ?, definition = ?, workflow_version = ?, context = ?, error = ?, updated_at = ? WHERE id = ?').run(
    run.status,
    run.stepIndex,
    JSON.stringify(run.definition),
    run.workflowVersion ?? null,
    JSON.stringify(run.context),
    run.error ?? null,
    run.updatedAt,
    run.id,
  );
  runUpdates.emit('run', run);
}

interface EventRow {
  id: number;
  run_id: string;
  step_id: string | null;
  type: string;
  data: string;
  created_at: string;
}

function eventFromRow(row: EventRow): RunEvent {
  return { id: row.id, runId: row.run_id, stepId: row.step_id, type: row.type, data: JSON.parse(row.data), createdAt: row.created_at };
}

export function addEvent(runId: string, stepId: string | null, type: string, data: Record<string, unknown> = {}): RunEvent {
  const createdAt = now();
  const result = db
    .prepare('INSERT INTO events (run_id, step_id, type, data, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(runId, stepId, type, JSON.stringify(data), createdAt);
  const event: RunEvent = { id: Number(result.lastInsertRowid), runId, stepId, type, data, createdAt };
  runUpdates.emit('event', event);
  return event;
}

export function listEvents(runId: string, afterId = 0): RunEvent[] {
  const rows = db.prepare('SELECT * FROM events WHERE run_id = ? AND id > ? ORDER BY id').all(runId, afterId);
  return (rows as unknown as EventRow[]).map(eventFromRow);
}

interface ApprovalRow {
  id: string;
  run_id: string;
  step_id: string;
  message: string;
  status: Approval['status'];
  comment: string | null;
  created_at: string;
  resolved_at: string | null;
}

function approvalFromRow(row: ApprovalRow): Approval {
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id,
    message: row.message,
    status: row.status,
    comment: row.comment ?? undefined,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at ?? undefined,
  };
}

export function createApproval(runId: string, stepId: string, message: string): Approval {
  const id = randomUUID();
  db.prepare("INSERT INTO approvals (id, run_id, step_id, message, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)").run(
    id,
    runId,
    stepId,
    message,
    now(),
  );
  return getApproval(id)!;
}

export function getApproval(id: string): Approval | undefined {
  const row = db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as ApprovalRow | undefined;
  return row && approvalFromRow(row);
}

export function listApprovals(filter: { runId?: string; status?: Approval['status'] } = {}): Approval[] {
  const rows = db
    .prepare('SELECT * FROM approvals WHERE (?1 IS NULL OR run_id = ?1) AND (?2 IS NULL OR status = ?2) ORDER BY created_at DESC')
    .all(filter.runId ?? null, filter.status ?? null);
  return (rows as unknown as ApprovalRow[]).map(approvalFromRow);
}

export function resolveApproval(id: string, status: 'approved' | 'rejected', comment: string): void {
  db.prepare('UPDATE approvals SET status = ?, comment = ?, resolved_at = ? WHERE id = ?').run(status, comment, now(), id);
}

/** Pending approvals of a run stop making sense once the run is cancelled or retried. */
export function dismissPendingApprovals(runId: string): void {
  db.prepare("UPDATE approvals SET status = 'rejected', comment = 'Run was cancelled', resolved_at = ? WHERE run_id = ? AND status = 'pending'").run(
    now(),
    runId,
  );
}
