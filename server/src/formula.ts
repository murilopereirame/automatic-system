/**
 * Formulas: the portable YAML form of a workflow.
 *
 * A formula contains the triggers, the inputs of a manual run, the blocks and the whole environment
 * (runtimes, MCP servers, Claude memory, environment variables, mounts) and
 * the notification webhooks.
 * Secret values are never part of a formula, only their names.
 */
import YAML from 'yaml';
import { errorMessage, HttpError } from './errors.js';
import { checkExpression } from './expression.js';
import { END_OF_RUN } from './steps/condition.js';
import { parseInputs } from './inputs.js';
import { getStepType } from './steps/index.js';
import type { WorkflowInput } from './store/workflows.js';
import { getTriggerType } from './triggers/index.js';
import { emptyEnvironment, SCOPE_NAMES, type Environment, type MemoryFile, type NotificationWebhook, type SkillSpec, type StepConfig, type TriggerConfig, type Workflow, type WorkflowDefinition } from './types.js';

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
  environment.skills = asArray(raw.skills, 'environment.skills').map((item) => {
    const skill = asObject(item, 'a skill');
    const name = String(skill.name ?? '');
    if (!/^[\w-]+$/.test(name)) invalid(`skill name "${name}" may only contain letters, digits, "_" and "-"`);
    return { name, content: String(skill.content ?? '') };
  });
  environment.services = asArray(raw.services, 'environment.services').map((item) => {
    const service = asObject(item, 'a service');
    const name = String(service.name ?? '');
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) invalid(`service name "${name}" must be a lowercase host name`);
    if (!service.image) invalid(`service "${name}" needs an image`);
    const ports = asArray(service.ports, `ports of service "${name}"`).map(Number);
    if (ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) invalid(`service "${name}" has an invalid port`);
    const env = Object.entries(asObject(service.env, `env of service "${name}"`)).map(([key, value]) => [key, String(value)]);
    return { name, image: String(service.image), ports, env: Object.fromEntries(env), command: service.command ? String(service.command) : undefined };
  });
  environment.network = { allow: asArray(asObject(raw.network, 'environment.network').allow, 'environment.network.allow').map(String) };
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

function checkCondition(expression: string, where: string): void {
  try {
    checkExpression(expression, SCOPE_NAMES);
  } catch (error) {
    invalid(`${where}: ${errorMessage(error)}`);
  }
}

/** Checks the settings that only make sense once all blocks are known: expressions and the blocks a condition continues with. */
function checkStepSettings(step: StepConfig, ids: Set<string>): void {
  if (step.if !== undefined) checkCondition(step.if, `"if" of step "${step.id}"`);
  for (const field of getStepType(step.type)!.fields) {
    const value = step.with[field.key];
    if (value === undefined || value === null || value === '') continue;
    if (field.type === 'expression') checkCondition(String(value), `"${field.key}" of step "${step.id}"`);
    if (field.type === 'target' && value !== END_OF_RUN) {
      if (value === step.id) invalid(`"${field.key}" of step "${step.id}" points at the step itself`);
      if (!ids.has(String(value))) invalid(`"${field.key}" of step "${step.id}" names "${value}", which is not a step. Use a step id or "${END_OF_RUN}"`);
    }
  }
}

function parseSteps(input: unknown): StepConfig[] {
  const ids = new Set<string>();
  const steps = asArray(input, 'steps').map((item, index): StepConfig => {
    const raw = asObject(item, `step ${index + 1}`);
    const type = String(raw.type ?? '');
    if (!getStepType(type)) invalid(`step ${index + 1} has unknown type "${type}"`);
    const id = String(raw.id ?? `${type}_${index + 1}`);
    if (!/^[\w-]+$/.test(id)) invalid(`step id "${id}" may only contain letters, digits, "_" and "-"`);
    if (ids.has(id)) invalid(`step id "${id}" is used more than once`);
    ids.add(id);
    const condition = raw.if === undefined || raw.if === null || String(raw.if).trim() === '' ? undefined : String(raw.if);
    return { id, type, name: raw.name ? String(raw.name) : undefined, ...(condition !== undefined && { if: condition }), with: asObject(raw.with, `settings of step "${id}"`) };
  });
  for (const step of steps) checkStepSettings(step, ids);
  return steps;
}

/**
 * Reads the `triggers` list. Formulas written before a workflow could have
 * several triggers have a single `trigger` object instead, which is read as a
 * list of one. The old `manual` type is dropped: "Run now" always works.
 */
function parseTriggers(raw: Record<string, unknown>): TriggerConfig[] {
  const items = raw.triggers !== undefined ? asArray(raw.triggers, 'triggers') : raw.trigger ? [raw.trigger] : [];
  const triggers: TriggerConfig[] = [];
  const ids = new Set<string>();
  for (const item of items) {
    const trigger = asObject(item, 'a trigger');
    const type = String(trigger.type ?? 'manual');
    if (type === 'manual') continue;
    if (!getTriggerType(type)) invalid(`unknown trigger type "${type}"`);
    const id = String(trigger.id ?? (ids.has(type) ? `${type}_${triggers.length + 1}` : type));
    if (!/^[\w-]+$/.test(id)) invalid(`trigger id "${id}" may only contain letters, digits, "_" and "-"`);
    if (ids.has(id)) invalid(`trigger id "${id}" is used more than once`);
    ids.add(id);
    triggers.push({ id, type, with: asObject(trigger.with, `settings of trigger "${id}"`) });
  }
  return triggers;
}

/** Validates untrusted input (API body or parsed YAML) and returns a clean definition. */
export function parseDefinition(input: unknown): WorkflowDefinition {
  const raw = asObject(input, 'the workflow');
  return {
    triggers: parseTriggers(raw),
    inputs: parseInputs(raw.inputs),
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

/** Serialises a workflow as a formula. `snapshot` lets the caller pass memory and skills as they are on disk right now. */
export function toFormula(workflow: Workflow, snapshot: { memory?: MemoryFile[]; skills?: SkillSpec[] } = {}): string {
  const { triggers, inputs = [], environment, notifications, steps } = workflow.definition;
  const document = {
    apiVersion: FORMULA_API_VERSION,
    kind: 'Formula',
    metadata: { name: workflow.name, description: workflow.description, enabled: workflow.enabled },
    triggers,
    inputs,
    environment: { ...environment, memory: snapshot.memory ?? environment.memory, skills: snapshot.skills ?? environment.skills },
    notifications,
    steps,
  };
  return YAML.stringify(document, { lineWidth: 0 });
}
