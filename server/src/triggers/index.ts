/**
 * Trigger registry and manager. The manager keeps exactly one active watcher
 * per enabled workflow and restarts it whenever the workflow changes.
 */
import { startRun } from '../engine/engine.js';
import { getWorkflow, listWorkflows, markSeen } from '../store/workflows.js';
import type { Workflow } from '../types.js';
import { clickupTrigger } from './clickup.js';
import { manualTrigger } from './manual.js';
import type { Fire, TriggerType } from './types.js';
import { webhookTrigger } from './webhook.js';

export const triggerTypes: TriggerType[] = [manualTrigger, clickupTrigger, webhookTrigger];

export function getTriggerType(type: string): TriggerType | undefined {
  return triggerTypes.find((candidate) => candidate.type === type);
}

/** Stop functions of the running watchers, by workflow id. */
const watchers = new Map<string, () => void>();

/** Builds the callback a trigger uses to start runs of one workflow. */
export function fireFor(workflowId: string): Fire {
  return (payload, dedupeKey) => {
    const workflow = getWorkflow(workflowId);
    if (!workflow?.enabled) return;
    if (dedupeKey && !markSeen(workflowId, dedupeKey)) return;
    startRun(workflow, payload);
  };
}

/** (Re)starts or stops the watcher of a workflow so it matches the stored workflow. Call after every change. */
export function syncTrigger(workflowId: string): void {
  watchers.get(workflowId)?.();
  watchers.delete(workflowId);

  const workflow: Workflow | undefined = getWorkflow(workflowId);
  if (!workflow?.enabled) return;
  const stop = getTriggerType(workflow.definition.trigger.type)?.start?.(workflow, fireFor(workflowId));
  if (stop) watchers.set(workflowId, stop);
}

export function startAllTriggers(): void {
  for (const workflow of listWorkflows()) syncTrigger(workflow.id);
}

export function stopAllTriggers(): void {
  for (const stop of watchers.values()) stop();
  watchers.clear();
}
