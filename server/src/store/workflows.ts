import { randomBytes, randomUUID } from 'node:crypto';
import { db, now } from '../db.js';
import type { Workflow, WorkflowDefinition } from '../types.js';

interface Row {
  id: string;
  name: string;
  description: string;
  enabled: number;
  hook_secret: string;
  definition: string;
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
    definition: JSON.parse(row.definition),
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

export function createWorkflow(input: WorkflowInput): Workflow {
  const id = randomUUID();
  const timestamp = now();
  db.prepare(
    `INSERT INTO workflows (id, name, description, enabled, hook_secret, definition, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.name,
    input.description ?? '',
    input.enabled === false ? 0 : 1,
    randomBytes(20).toString('hex'),
    JSON.stringify(input.definition),
    timestamp,
    timestamp,
  );
  return getWorkflow(id)!;
}

export function updateWorkflow(id: string, input: WorkflowInput): Workflow | undefined {
  db.prepare(
    'UPDATE workflows SET name = ?, description = ?, enabled = ?, definition = ?, updated_at = ? WHERE id = ?',
  ).run(input.name, input.description ?? '', input.enabled === false ? 0 : 1, JSON.stringify(input.definition), now(), id);
  return getWorkflow(id);
}

export function deleteWorkflow(id: string): void {
  db.prepare('DELETE FROM workflows WHERE id = ?').run(id);
  db.prepare('DELETE FROM trigger_seen WHERE workflow_id = ?').run(id);
}

/** Records an external item for a workflow. Returns false when it was already recorded. */
export function markSeen(workflowId: string, key: string): boolean {
  const result = db.prepare('INSERT OR IGNORE INTO trigger_seen (workflow_id, key) VALUES (?, ?)').run(workflowId, key);
  return result.changes > 0;
}

export function hasSeenAnything(workflowId: string): boolean {
  return db.prepare('SELECT 1 FROM trigger_seen WHERE workflow_id = ? LIMIT 1').get(workflowId) !== undefined;
}
