/**
 * Version history of workflows, kept like the commits of a git repository.
 *
 * Every save that changes a workflow stores a full copy of it under the next
 * version number. Versions are never edited. Restoring an old version copies
 * it into a new one, so the history only grows and every step can be undone.
 * See docs/VERSIONING.md.
 */
import { db } from '../db.js';
import { upgradeDefinition, type VersionSource, type Workflow, type WorkflowVersion } from '../types.js';

interface Row {
  workflow_id: string;
  version: number;
  name: string;
  description: string;
  enabled: number;
  definition: string;
  message: string;
  source: VersionSource;
  restored_from: number | null;
  created_at: string;
}

function fromRow(row: Row): WorkflowVersion {
  return {
    workflowId: row.workflow_id,
    version: row.version,
    name: row.name,
    description: row.description,
    enabled: row.enabled === 1,
    definition: upgradeDefinition(JSON.parse(row.definition)),
    message: row.message,
    source: row.source,
    ...(row.restored_from !== null && { restoredFrom: row.restored_from }),
    createdAt: row.created_at,
  };
}

/** Newest first. */
export function listVersions(workflowId: string): WorkflowVersion[] {
  const rows = db.prepare('SELECT * FROM workflow_versions WHERE workflow_id = ? ORDER BY version DESC').all(workflowId);
  return (rows as unknown as Row[]).map(fromRow);
}

export function getVersion(workflowId: string, version: number): WorkflowVersion | undefined {
  const row = db.prepare('SELECT * FROM workflow_versions WHERE workflow_id = ? AND version = ?').get(workflowId, version) as Row | undefined;
  return row && fromRow(row);
}

/** Stores a version. Only the workflow store calls this, inside the transaction that saves the workflow itself. */
export function insertVersion(version: WorkflowVersion): void {
  db.prepare(
    `INSERT INTO workflow_versions (workflow_id, version, name, description, enabled, definition, message, source, restored_from, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    version.workflowId,
    version.version,
    version.name,
    version.description,
    version.enabled ? 1 : 0,
    JSON.stringify(version.definition),
    version.message,
    version.source,
    version.restoredFrom ?? null,
    version.createdAt,
  );
}

export function deleteVersions(workflowId: string): void {
  db.prepare('DELETE FROM workflow_versions WHERE workflow_id = ?').run(workflowId);
}

/** The parts of a workflow a version records. Two saves with the same content are the same version. */
export function contentOf(workflow: Pick<Workflow, 'name' | 'description' | 'enabled' | 'definition'>): string {
  const { name, description, enabled, definition } = workflow;
  return JSON.stringify({ name, description, enabled, definition });
}
