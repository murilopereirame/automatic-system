/**
 * Trigger registry and manager. A workflow can have several triggers; the
 * manager keeps one watcher per trigger of every enabled workflow and
 * restarts them whenever the workflow changes.
 */
import { startRun } from '../engine/engine.js';
import { getWorkflow, listWorkflows, markSeen } from '../store/workflows.js';
import { clickupTrigger } from './clickup.js';
import type { Fire, TriggerType } from './types.js';
import { webhookTrigger } from './webhook.js';

export const triggerTypes: TriggerType[] = [clickupTrigger, webhookTrigger];

export function getTriggerType(type: string): TriggerType | undefined {
  return triggerTypes.find((candidate) => candidate.type === type);
}

/** Stop functions of the running watchers, by workflow id. */
const watchers = new Map<string, (() => void)[]>();

/**
 * Builds the callback one trigger of a workflow uses to start runs. The
 * dedupe key is shared by all triggers of the workflow, so an item that two
 * triggers both notice (say a ClickUp task seen by a poll and by a webhook)
 * still starts only one run.
 */
export function fireFor(workflowId: string, triggerId: string): Fire {
  return (payload, dedupeKey) => {
    const workflow = getWorkflow(workflowId);
    const trigger = workflow?.definition.triggers.find((candidate) => candidate.id === triggerId);
    if (!workflow?.enabled || !trigger) return;
    if (dedupeKey && !markSeen(workflowId, dedupeKey)) return;
    startRun(workflow, payload, { id: trigger.id, type: trigger.type });
  };
}

/** (Re)starts or stops the watchers of a workflow so they match the stored workflow. Call after every change. */
export function syncTriggers(workflowId: string): void {
  for (const stop of watchers.get(workflowId) ?? []) stop();
  watchers.delete(workflowId);

  const workflow = getWorkflow(workflowId);
  if (!workflow?.enabled) return;
  const stops = workflow.definition.triggers.flatMap((trigger) => {
    const stop = getTriggerType(trigger.type)?.start?.(workflow, trigger, fireFor(workflowId, trigger.id));
    return stop ? [stop] : [];
  });
  if (stops.length > 0) watchers.set(workflowId, stops);
}

export function startAllTriggers(): void {
  for (const workflow of listWorkflows()) syncTriggers(workflow.id);
}

export function stopAllTriggers(): void {
  for (const stops of watchers.values()) for (const stop of stops) stop();
  watchers.clear();
}
