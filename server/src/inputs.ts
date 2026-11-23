/**
 * Inputs of a manual run.
 *
 * A workflow can declare values that "Run now" asks for. The answers become
 * the trigger payload of the run, so blocks read them like the payload of any
 * other trigger: an input named `task.id` is `{{trigger.task.id}}`.
 *
 * Two jobs live here: checking the declarations when a workflow is saved or
 * imported (`parseInputs`), and checking the values when a run is started
 * (`applyInputs`).
 */
import { HttpError } from './errors.js';
import type { RunInput, RunInputType } from './types.js';

export const RUN_INPUT_TYPES: RunInputType[] = ['text', 'textarea', 'number', 'boolean', 'select', 'json'];

/** A name is a path into the trigger payload: identifiers joined by dots. */
export const NAME_PATTERN = /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/;
/** Path segments that would reach into the prototype of the payload object. */
export const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

function fail(message: string): never {
  throw new HttpError(400, message);
}

export const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Nothing was given for an input: it is absent, null or an empty text. */
const isMissing = (value: unknown) => value === undefined || value === null || value === '';

function readPath(source: Record<string, unknown>, path: string): unknown {
  let current: unknown = source;
  for (const segment of path.split('.')) {
    if (!isPlainObject(current) || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

export function writePath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  const last = segments.pop()!;
  let current = target;
  for (const segment of segments) {
    if (!isPlainObject(current[segment])) current[segment] = {};
    current = current[segment] as Record<string, unknown>;
  }
  current[last] = value;
}

/** Brings one value to the type of its input, or explains why it does not fit. */
function coerce(input: RunInput, value: unknown): unknown {
  const wrong = (expected: string) => fail(`Input "${input.name}" must be ${expected}`);
  switch (input.type) {
    case 'number': {
      const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      return typeof number === 'number' && Number.isFinite(number) ? number : wrong('a number');
    }
    case 'boolean':
      if (value === true || value === 'true') return true;
      if (value === false || value === 'false') return false;
      return wrong('true or false');
    case 'select':
      return input.options?.includes(String(value)) ? String(value) : wrong(`one of: ${(input.options ?? []).join(', ')}`);
    case 'json':
      return value;
    default:
      return isPlainObject(value) || Array.isArray(value) ? wrong('text') : String(value);
  }
}

/** Validates the `inputs` list of a workflow definition. */
export function parseInputs(raw: unknown): RunInput[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) fail('Invalid workflow: inputs must be a list');

  const inputs: RunInput[] = [];
  for (const item of raw) {
    if (!isPlainObject(item)) fail('Invalid workflow: every input must be an object');
    const name = String(item.name ?? '');
    const invalid = (message: string) => fail(`Invalid workflow: input "${name}" ${message}`);

    if (!NAME_PATTERN.test(name)) invalid('needs a name made of letters, digits and "_", with dots for nesting, e.g. "task.id"');
    if (name.split('.').some((segment) => FORBIDDEN_SEGMENTS.has(segment))) invalid('uses a reserved name');
    for (const other of inputs) {
      if (other.name === name) invalid('is declared more than once');
      if (name.startsWith(`${other.name}.`) || other.name.startsWith(`${name}.`)) invalid(`overlaps with input "${other.name}"`);
    }

    const type = String(item.type ?? 'text') as RunInputType;
    if (!RUN_INPUT_TYPES.includes(type)) invalid(`has unknown type "${type}". Use one of: ${RUN_INPUT_TYPES.join(', ')}`);

    const input: RunInput = { name, type };
    if (item.label) input.label = String(item.label);
    if (item.help) input.help = String(item.help);
    if (item.required === true) input.required = true;
    if (type === 'select') {
      const options = Array.isArray(item.options) ? item.options.map((option) => String(option).trim()).filter((option) => option !== '') : [];
      if (options.length === 0) invalid('needs a list of options');
      input.options = options;
    }
    if (!isMissing(item.default)) {
      try {
        input.default = coerce(input, item.default);
      } catch {
        invalid(`has a default that does not fit its type "${type}"`);
      }
    }
    inputs.push(input);
  }
  return inputs;
}

/**
 * Checks the payload of a manual run against the declared inputs and returns
 * the payload the run starts with: values brought to their type, defaults
 * filled in. Anything in the payload that is not a declared input is kept, so
 * API callers can still send more than the form asks for.
 */
export function applyInputs(inputs: RunInput[], payload: Record<string, unknown>): Record<string, unknown> {
  const result = structuredClone(payload);
  for (const input of inputs) {
    const given = readPath(result, input.name);
    const value = isMissing(given) ? input.default : given;
    if (isMissing(value)) {
      if (input.required) fail(`Input "${input.name}" is required`);
      continue;
    }
    writePath(result, input.name, coerce(input, value));
  }
  return result;
}
