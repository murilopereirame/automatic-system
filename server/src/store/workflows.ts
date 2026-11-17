import { randomBytes, randomUUID } from 'node:crypto';
import { db, now, transaction } from '../db.js';
import { upgradeDefinition, type VersionSource, type Workflow, type WorkflowDefinition, type WorkflowVersion } from '../types.js';
import { contentOf, deleteVersions, insertVersion } from './versions.js';

interface Row {
  id: string;
  name: string;
  description: string;
  enabled: number;
  hook_secret: string;
  definition: string;
  version: number;
  created_at: string;
  updated_at: string;
}

function fromRow(row: Row): Workflow {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    enabled: row.enabled === 1,
    hookSecret: row.hook_secret,
    definition: upgradeDefinition(JSON.parse(row.definition)),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface WorkflowInput {
  name: string;
  description?: string;
  enabled?: boolean;
  definition: WorkflowDefinition;
}

/** Why a workflow is being saved. Recorded on the version the save creates. */
export interface ChangeNote {
  source?: VersionSource;
  message?: string;
  /** Set when an old version is being restored. */
  restoredFrom?: number;
}

/** A version read from a formula's `history`, to recreate on import. */
export type HistoryEntry = Omit<WorkflowVersion, 'workflowId'>;

function versionOf(workflow: Workflow, note: ChangeNote, fallback: VersionSource): WorkflowVersion {
  return {
    workflowId: workflow.id,
    version: workflow.version,
    name: workflow.name,
    description: workflow.description,
    enabled: workflow.enabled,
    definition: workflow.definition,
    message: note.message?.trim() ?? '',
    source: note.source ?? fallback,
    ...(note.restoredFrom !== undefined && { restoredFrom: note.restoredFrom }),
    createdAt: workflow.updatedAt,
  };
}

export function listWorkflows(): Workflow[] {
  return (db.prepare('SELECT * FROM workflows ORDER BY name').all() as unknown as Row[]).map(fromRow);
}

export function getWorkflow(id: string): Workflow | undefined {
  const row = db.prepare('SELECT * FROM workflows WHERE id = ?').get(id) as Row | undefined;
  return row && fromRow(row);
}

export function findWorkflowByName(name: string): Workflow | undefined {
  const row = db.prepare('SELECT * FROM workflows WHERE name = ?').get(name) as Row | undefined;
  return row && fromRow(row);
}

/**
 * Creates a workflow as version 1. `history` (from an imported formula) puts
 * older versions in front of it; the workflow then continues after the last one.
 */
export function createWorkflow(input: WorkflowInput, note: ChangeNote = {}, history: HistoryEntry[] = []): Workflow {
  const id = randomUUID();
  const timestamp = now();
  const version = Math.max(0, ...history.map((entry) => entry.version)) + 1;
  return transaction(() => {
    db.prepare(
      `INSERT INTO workflows (id, name, description, enabled, hook_secret, definition, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.name,
      input.description ?? '',
      input.enabled === false ? 0 : 1,
      randomBytes(20).toString('hex'),
      JSON.stringify(input.definition),
      version,
      history[0]?.createdAt ?? timestamp,
      timestamp,
    );
    for (const entry of history) insertVersion({ ...entry, workflowId: id });
    const workflow = getWorkflow(id)!;
    insertVersion(versionOf(workflow, note, 'created'));
    return workflow;
  });
}

/**
 * Saves a new state of a workflow as the next version. A save that changes
 * nothing keeps the current version, so the history only shows real changes.
 */
export function updateWorkflow(id: string, input: WorkflowInput, note: ChangeNote = {}): Workflow | undefined {
  const current = getWorkflow(id);
  if (!current) return undefined;
  const next = { name: input.name, description: input.description ?? '', enabled: input.enabled !== false, definition: input.definition };
  if (contentOf(next) === contentOf(current)) return current;
  return transaction(() => {
    db.prepare('UPDATE workflows SET name = ?, description = ?, enabled = ?, definition = ?, version = ?, updated_at = ? WHERE id = ?').run(
      next.name,
      next.description,
      next.enabled ? 1 : 0,
      JSON.stringify(next.definition),
      current.version + 1,
      now(),
      id,
    );
    const workflow = getWorkflow(id)!;
    insertVersion(versionOf(workflow, note, 'edited'));
    return workflow;
  });
}

export function deleteWorkflow(id: string): void {
  db.prepare('DELETE FROM workflows WHERE id = ?').run(id);
  deleteVersions(id);
  db.prepare('DELETE FROM trigger_seen WHERE workflow_id = ?').run(id);
}

/** Records an external item for a workflow. Returns false when it was already recorded. */
export function markSeen(workflowId: string, key: string): boolean {
  const result = db.prepare('INSERT OR IGNORE INTO trigger_seen (workflow_id, key) VALUES (?, ?)').run(workflowId, key);
  return result.changes > 0;
}

/**
 * Workflows saved before versions existed have version 0 and no history.
 * Their current state becomes version 1, so they can be compared and restored like any other.
 */
export function startHistoryOfOlderWorkflows(): void {
  const older = (db.prepare('SELECT * FROM workflows WHERE version = 0').all() as unknown as Row[]).map(fromRow);
  for (const workflow of older) {
    transaction(() => {
      db.prepare('UPDATE workflows SET version = 1 WHERE id = ?').run(workflow.id);
      insertVersion(versionOf({ ...workflow, version: 1 }, { message: 'State when version history was turned on' }, 'created'));
    });
  }
}

startHistoryOfOlderWorkflows();
