/**
 * Formulas: the portable YAML form of a workflow.
 *
 * A formula contains the trigger, the blocks and the whole environment
 * (runtimes, MCP servers, Claude memory, environment variables, mounts) and
 * the notification webhooks.
 * Secret values are never part of a formula, only their names.
 */
import YAML from 'yaml';
import { HttpError } from './errors.js';
import { getStepType } from './steps/index.js';
import type { WorkflowInput } from './store/workflows.js';
import { getTriggerType } from './triggers/index.js';
import { emptyEnvironment, type Environment, type MemoryFile, type NotificationWebhook, type StepConfig, type Workflow, type WorkflowDefinition } from './types.js';

export const FORMULA_API_VERSION = 'autoworker/v1';

function invalid(message: string): never {
  throw new HttpError(400, `Invalid workflow: ${message}`);
}

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) invalid(`${what} must be an object`);
  return value as Record<string, unknown>;
}

function asArray(value: unknown, what: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) invalid(`${what} must be a list`);
  return value;
}

function parseEnvironment(input: unknown): Environment {
  const raw = asObject(input, 'environment');
  const environment = emptyEnvironment();

  environment.runtimes = asArray(raw.runtimes, 'environment.runtimes').map((item) => {
    const runtime = asObject(item, 'a runtime');
    if (!runtime.name) invalid('every runtime needs a name');
    return { name: String(runtime.name), version: String(runtime.version ?? 'latest') };
  });
  environment.mcpServers = asObject(raw.mcpServers, 'environment.mcpServers');
  environment.memory = asArray(raw.memory, 'environment.memory').map((item) => {
    const file = asObject(item, 'a memory file');
    if (!file.path) invalid('every memory file needs a path');
    return { path: String(file.path), content: String(file.content ?? '') };
  });
  environment.env = Object.fromEntries(Object.entries(asObject(raw.env, 'environment.env')).map(([key, value]) => [key, String(value)]));
  environment.secrets = asArray(raw.secrets, 'environment.secrets').map(String);
  environment.mounts = asArray(raw.mounts, 'environment.mounts').map((item) => {
    const mount = asObject(item, 'a mount');
    if (!mount.source || !mount.target) invalid('every mount needs a source and a target');
    return { source: String(mount.source), target: String(mount.target), readOnly: mount.readOnly === true };
  });
  return environment;
}

function parseNotifications(input: unknown): NotificationWebhook[] {
  return asArray(input, 'notifications').map((item, index) => {
    const raw = asObject(item, 'a notification webhook');
    if (!raw.url) invalid('every notification webhook needs a url');
    const headers = Object.entries(asObject(raw.headers, 'notification headers')).map(([key, value]) => [key, String(value)]);
    return {
      name: String(raw.name ?? `webhook_${index + 1}`),
      url: String(raw.url),
      method: String(raw.method ?? 'POST').toUpperCase(),
      headers: Object.fromEntries(headers),
      body: String(raw.body ?? ''),
    };
  });
}

function parseSteps(input: unknown): StepConfig[] {
  const ids = new Set<string>();
  return asArray(input, 'steps').map((item, index) => {
    const raw = asObject(item, `step ${index + 1}`);
    const type = String(raw.type ?? '');
    if (!getStepType(type)) invalid(`step ${index + 1} has unknown type "${type}"`);
    const id = String(raw.id ?? `${type}_${index + 1}`);
    if (!/^[\w-]+$/.test(id)) invalid(`step id "${id}" may only contain letters, digits, "_" and "-"`);
    if (ids.has(id)) invalid(`step id "${id}" is used more than once`);
    ids.add(id);
    return { id, type, name: raw.name ? String(raw.name) : undefined, with: asObject(raw.with, `settings of step "${id}"`) };
  });
}

/** Validates untrusted input (API body or parsed YAML) and returns a clean definition. */
export function parseDefinition(input: unknown): WorkflowDefinition {
  const raw = asObject(input, 'the workflow');
  const trigger = asObject(raw.trigger, 'trigger');
  const triggerType = String(trigger.type ?? 'manual');
  if (!getTriggerType(triggerType)) invalid(`unknown trigger type "${triggerType}"`);
  return {
    trigger: { type: triggerType, with: asObject(trigger.with, 'trigger settings') },
    environment: parseEnvironment(raw.environment),
    notifications: parseNotifications(raw.notifications),
    steps: parseSteps(raw.steps),
  };
}

/** Parses a formula YAML document into what is needed to create or update a workflow. */
export function parseFormula(source: string): WorkflowInput {
  let document: unknown;
  try {
    document = YAML.parse(source);
  } catch (error) {
    throw new HttpError(400, `The formula is not valid YAML: ${(error as Error).message}`);
  }
  const raw = asObject(document, 'the formula');
  if (raw.apiVersion !== FORMULA_API_VERSION || raw.kind !== 'Formula') {
    throw new HttpError(400, `Not a formula: expected apiVersion "${FORMULA_API_VERSION}" and kind "Formula"`);
  }
  const metadata = asObject(raw.metadata, 'metadata');
  if (!metadata.name) invalid('metadata.name is required');
  return {
    name: String(metadata.name),
    description: String(metadata.description ?? ''),
    enabled: metadata.enabled !== false,
    definition: parseDefinition(raw),
  };
}

/** Serialises a workflow as a formula. `memory` lets the caller pass a fresh snapshot from disk. */
export function toFormula(workflow: Workflow, memory: MemoryFile[] = workflow.definition.environment.memory): string {
  const { trigger, environment, notifications, steps } = workflow.definition;
  const document = {
    apiVersion: FORMULA_API_VERSION,
    kind: 'Formula',
    metadata: { name: workflow.name, description: workflow.description, enabled: workflow.enabled },
    trigger,
    environment: { ...environment, memory },
    notifications,
    steps,
  };
  return YAML.stringify(document, { lineWidth: 0 });
}
