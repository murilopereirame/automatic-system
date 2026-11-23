/**
 * Values a person injects into a run while it is open.
 *
 * Some things only become known while a run is under way: the URL of the
 * staging deploy you just made, a ticket number, a test account. Instead of
 * editing the workflow, you add them to the run from the run page and the
 * blocks that have not run yet read them as `{{vars.<name>}}` (or `vars.<name>`
 * in an expression).
 *
 * Names follow the same rules as run inputs (see inputs.ts): identifiers
 * joined by dots, and dots nest. `staging.url` and `staging.user` both live
 * under `vars.staging`.
 *
 * This module only changes the `vars` object. The engine decides when a run
 * may be changed and saves it (see `setRunValue` in engine/engine.ts).
 */
import { HttpError } from './errors.js';
import { FORBIDDEN_SEGMENTS, isPlainObject, NAME_PATTERN, writePath } from './inputs.js';

/** Upper bound for one value, as JSON. Values end up in prompts and commands, not in files. */
export const MAX_VALUE_BYTES = 64 * 1024;

function fail(message: string): never {
  throw new HttpError(400, message);
}

export function checkValueName(name: string): void {
  if (!NAME_PATTERN.test(name)) fail(`"${name}" is not a valid name. Use letters, digits and "_", with dots for nesting, e.g. "staging.url"`);
  if (name.split('.').some((segment) => FORBIDDEN_SEGMENTS.has(segment))) fail(`"${name}" uses a reserved name`);
}

/** Sets `name` to `value`. Returns the new `vars` object; the one passed in is not changed. */
export function withValue(vars: Record<string, unknown> | undefined, name: string, value: unknown): Record<string, unknown> {
  checkValueName(name);
  if (value === undefined) fail('A value is required. Send {"value": ...}');
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_VALUE_BYTES) fail(`The value is larger than ${MAX_VALUE_BYTES / 1024} KB`);
  const result = structuredClone(vars ?? {});
  writePath(result, name, value);
  return result;
}

/** Removes `name`, and any group that is empty afterwards. Returns the new `vars` object and whether the name existed. */
export function withoutValue(vars: Record<string, unknown> | undefined, name: string): { vars: Record<string, unknown>; removed: boolean } {
  checkValueName(name);
  const result = structuredClone(vars ?? {});
  const segments = name.split('.');
  const parents: Record<string, unknown>[] = [result];
  for (const segment of segments.slice(0, -1)) {
    const next = parents.at(-1)![segment];
    if (!isPlainObject(next)) return { vars: result, removed: false };
    parents.push(next);
  }
  const last = segments.at(-1)!;
  if (!Object.hasOwn(parents.at(-1)!, last)) return { vars: result, removed: false };
  delete parents.at(-1)![last];
  // Drop groups that became empty, from the innermost out, so `vars.staging` disappears with its last value.
  for (let depth = parents.length - 1; depth > 0; depth--) {
    if (Object.keys(parents[depth]).length > 0) break;
    delete parents[depth - 1][segments[depth - 1]];
  }
  return { vars: result, removed: true };
}

/** Flattens `vars` to `[dotted name, value]` pairs, the way the run page lists them. Arrays are values, not groups. */
export function listValues(vars: Record<string, unknown> | undefined, prefix = ''): [string, unknown][] {
  return Object.entries(vars ?? {}).flatMap(([key, value]) => {
    const name = prefix ? `${prefix}.${key}` : key;
    return isPlainObject(value) && Object.keys(value).length > 0 ? listValues(value, name) : [[name, value] as [string, unknown]];
  });
}
