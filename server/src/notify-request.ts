/**
 * Turns a notification webhook and its template values into the HTTP request that is sent.
 * Shared by the server (notify.ts) and the preview in the web UI's Notifications tab, so the
 * preview shows exactly what would go out. No I/O here.
 */
import { renderString } from './template.js';
import type { NotificationWebhook } from './types.js';

/** Used when a webhook does not define its own body. */
export const DEFAULT_BODY = '{"title": {{title | json}}, "message": {{message | json}}, "url": {{run.url | json}}}';

export interface WebhookRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** Missing for GET, which sends no body. */
  body?: string;
}

export function renderWebhook(webhook: NotificationWebhook, scope: Record<string, unknown>): WebhookRequest {
  const method = (webhook.method || 'POST').toUpperCase();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  for (const [name, value] of Object.entries(webhook.headers ?? {})) headers[name] = renderString(value, scope);
  return {
    method,
    url: renderString(webhook.url, scope),
    headers,
    body: method === 'GET' ? undefined : renderString(webhook.body || DEFAULT_BODY, scope),
  };
}
