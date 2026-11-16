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
 * `{{ task.name | slug }}` turns text into a short lowercase-and-hyphens
 * name that is safe in a git branch, e.g. `Fix the login page!` -> `fix-the-login-page`.
 *
 * `{{= ... }}` holds an expression instead of a path, e.g.
 * `{{= steps.tests.output.passed ? 'passed' : 'failed' }}`. Filters work the
 * same way. See expression.ts.
 */
import { evaluate } from './expression.js';

/** Either `{{= expression }}` or `{{ dotted.path }}`, each with an optional `| filter`. */
const PLACEHOLDER = /\{\{=(.+?)\}\}|\{\{\s*([\w.-]+)\s*(?:\|\s*(\w+)\s*)?\}\}/gs;
/** Splits `expression | filter`. A single `|` starts the filter; `||` is the "or" of the expression. */
const EXPRESSION_WITH_FILTER = /^(.*?)(?:(?<!\|)\|(?!\|)\s*(\w+)\s*)?$/s;

const filters: Record<string, (value: unknown) => string> = {
  json: (value) => JSON.stringify(value ?? ''),
  url: (value) => encodeURIComponent(plain(value)),
  slug: (value) => slugify(plain(value)),
};

const SLUG_MAX = 48;

/** Lowercase ASCII letters, digits and single hyphens, at most SLUG_MAX characters, cut at a word boundary when possible. */
export function slugify(text: string): string {
  const slug = text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length <= SLUG_MAX) return slug;
  const cut = slug.slice(0, SLUG_MAX + 1);
  const boundary = cut.lastIndexOf('-');
  return (boundary > SLUG_MAX / 2 ? cut.slice(0, boundary) : slug.slice(0, SLUG_MAX)).replace(/-+$/, '');
}

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

function applyFilter(value: unknown, filter: string | undefined): string {
  if (!filter) return plain(value);
  if (!filters[filter]) throw new Error(`Unknown template filter "${filter}". Available: ${Object.keys(filters).join(', ')}`);
  return filters[filter](value);
}

export function renderString(template: string, scope: unknown): string {
  return template.replace(PLACEHOLDER, (_match, expression: string | undefined, dottedPath: string, pathFilter?: string) => {
    if (expression === undefined) return applyFilter(lookup(scope, dottedPath), pathFilter);
    const [, source, filter] = EXPRESSION_WITH_FILTER.exec(expression)!;
    return applyFilter(evaluate(source, scope as Record<string, unknown>), filter);
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
