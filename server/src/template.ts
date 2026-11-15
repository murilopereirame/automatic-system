/**
 * Minimal `{{ path.to.value }}` templating used in block settings and
 * notification webhooks.
 *
 * Unknown paths render as an empty string so a missing optional value never
 * leaks template syntax into a prompt or a command.
 *
 * A value can be passed through a filter: `{{ message | json }}` renders a
 * JSON literal (strings come out quoted and escaped, ready for a JSON body)
 * and `{{ message | url }}` percent-encodes it for use inside a URL.
 */

const PLACEHOLDER = /\{\{\s*([\w.-]+)\s*(?:\|\s*(\w+)\s*)?\}\}/g;

const filters: Record<string, (value: unknown) => string> = {
  json: (value) => JSON.stringify(value ?? ''),
  url: (value) => encodeURIComponent(plain(value)),
};

function plain(value: unknown): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

export function lookup(scope: unknown, dottedPath: string): unknown {
  let value = scope;
  for (const key of dottedPath.split('.')) {
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

export function renderString(template: string, scope: unknown): string {
  return template.replace(PLACEHOLDER, (_match, dottedPath: string, filter?: string) => {
    const value = lookup(scope, dottedPath);
    if (!filter) return plain(value);
    if (!filters[filter]) throw new Error(`Unknown template filter "${filter}". Available: ${Object.keys(filters).join(', ')}`);
    return filters[filter](value);
  });
}

/** Renders every string found in a (possibly nested) settings object. */
export function renderDeep<T>(value: T, scope: unknown): T {
  if (typeof value === 'string') return renderString(value, scope) as T;
  if (Array.isArray(value)) return value.map((item) => renderDeep(item, scope)) as T;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).map(([key, item]) => [key, renderDeep(item, scope)]);
    return Object.fromEntries(entries) as T;
  }
  return value;
}
