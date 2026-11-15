/**
 * Notifications are webhook calls defined in the workflow (and therefore in
 * its formula). URL, headers and body are templates, so any service with an
 * HTTP API can be targeted: ntfy, Slack, Telegram, a custom endpoint, ...
 *
 * Template values available in a notification webhook:
 *   {{title}} {{message}}        what is being announced
 *   {{run.id}} {{run.url}} {{run.status}}
 *   {{workflow.name}}
 *   {{trigger...}} {{steps.<id>.output...}}   same as in blocks
 *   {{secrets.NAME}}             stored secrets, so tokens stay out of the formula
 */
import { config } from './config.js';
import { errorMessage } from './errors.js';
import { getSecret, listSecretNames } from './store/secrets.js';
import { renderString } from './template.js';
import type { NotificationWebhook, Run } from './types.js';

export interface Notification {
  title: string;
  message: string;
  /** Restricts delivery to the webhook with this name. */
  channel?: string;
}

/** Used when a webhook does not define its own body. */
const DEFAULT_BODY = '{"title": {{title | json}}, "message": {{message | json}}, "url": {{run.url | json}}}';

function templateScope(run: Run, notification: Notification): Record<string, unknown> {
  return {
    title: notification.title,
    message: notification.message,
    run: { id: run.id, status: run.status, url: config.publicUrl ? `${config.publicUrl}/#/runs/${run.id}` : '' },
    workflow: { name: run.workflowName },
    trigger: run.context.trigger,
    steps: run.context.steps,
    secrets: Object.fromEntries(listSecretNames().map((name) => [name, getSecret(name)])),
  };
}

async function callWebhook(webhook: NotificationWebhook, scope: Record<string, unknown>): Promise<void> {
  const method = (webhook.method || 'POST').toUpperCase();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  for (const [name, value] of Object.entries(webhook.headers ?? {})) headers[name] = renderString(value, scope);

  const response = await fetch(renderString(webhook.url, scope), {
    method,
    headers,
    body: method === 'GET' ? undefined : renderString(webhook.body || DEFAULT_BODY, scope),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`answered ${response.status}`);
}

/**
 * Calls the notification webhooks of the run's workflow.
 * Never throws: a broken webhook must not fail a run. Returns the names of the webhooks that were reached.
 */
export async function sendNotification(run: Run, notification: Notification): Promise<string[]> {
  const webhooks = run.definition.notifications.filter((webhook) => !notification.channel || webhook.name === notification.channel);
  if (webhooks.length === 0) return [];

  const scope = templateScope(run, notification);
  const delivered: string[] = [];
  for (const webhook of webhooks) {
    try {
      await callWebhook(webhook, scope);
      delivered.push(webhook.name);
    } catch (error) {
      console.warn(`Notification webhook "${webhook.name}" of "${run.workflowName}" failed: ${errorMessage(error)}`);
    }
  }
  return delivered;
}
