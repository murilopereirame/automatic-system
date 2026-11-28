/**
 * What a notification webhook would send, filled in with example values, for the preview in the
 * Notifications tab. Uses the server's own renderWebhook, so the preview and the real call match.
 * Secret values never reach the browser: each `{{secrets.NAME}}` renders as a marker the preview
 * shows as a placeholder. Tested in web/test/notification-preview.test.ts.
 */
import type { NotificationWebhook, RunInput } from '../api.ts';
import { renderWebhook, type WebhookRequest } from '../../../server/src/notify-request.ts';
import { writePath } from '../../../server/src/inputs.ts';

/** The situations the server sends notifications in (see notify.ts and the "Send notification" block). */
export const PREVIEW_EVENTS = {
  approval: { label: 'A run needs you', title: (workflow: string) => `${workflow}: your action is needed`, message: 'The implementation is ready. Deploy the branch to staging, then approve.' },
  failed: { label: 'A run failed', title: (workflow: string) => `${workflow}: run failed`, message: 'Command failed with exit code 1' },
  block: { label: '"Send notification" block', title: (workflow: string) => workflow, message: 'Picked up a task: Example task' },
} as const;

export type PreviewEvent = keyof typeof PREVIEW_EVENTS;

/** Letters, digits and underscores only, so `| url` and `| json` leave it as it is. */
const SECRET_MARK = /__SECRET_([A-Za-z0-9_]+?)__/g;
const secretMark = (name: string) => `__SECRET_${name}__`;

export interface PreviewOptions {
  workflowName: string;
  event: PreviewEvent;
  inputs?: RunInput[];
  /** Origin the run link points at; the server uses AUTOWORKER_PUBLIC_URL. */
  origin: string;
}

/** Template values like the server's, with example data: a task, the workflow's run inputs, a run link. */
export function exampleScope({ workflowName, event, inputs = [], origin }: PreviewOptions, webhook: NotificationWebhook): Record<string, unknown> {
  const name = workflowName || 'My workflow';
  const trigger: Record<string, unknown> = { task: { id: '86a8y386n', name: 'Example task', url: 'https://app.clickup.com/t/86a8y386n' } };
  for (const input of inputs) {
    try {
      writePath(trigger, input.name, input.default ?? `<${input.label || input.name}>`);
    } catch {
      // A name the server would refuse: leave it out of the example.
    }
  }
  const referenced = [webhook.url, webhook.body ?? '', ...Object.values(webhook.headers ?? {})].join('\n').matchAll(/secrets\.([A-Za-z0-9_]+)/g);
  const secrets = Object.fromEntries([...referenced].map(([, secret]) => [secret, secretMark(secret)]));
  return {
    title: PREVIEW_EVENTS[event].title(name),
    message: PREVIEW_EVENTS[event].message,
    run: { id: '3f2a9c1e-example', status: event === 'failed' ? 'failed' : event === 'approval' ? 'waiting' : 'running', url: `${origin}/#/runs/3f2a9c1e-example` },
    workflow: { name },
    trigger,
    triggeredBy: { id: 'manual', type: 'manual' },
    steps: {},
    secrets,
  };
}

export type PreviewResult = { request: WebhookRequest; bodyIsJson: boolean | undefined } | { error: string };

export function previewWebhook(webhook: NotificationWebhook, options: PreviewOptions): PreviewResult {
  try {
    const request = renderWebhook(webhook, exampleScope(options, webhook));
    let bodyIsJson: boolean | undefined;
    if (request.body !== undefined && request.headers['Content-Type']?.includes('json')) {
      try {
        JSON.parse(request.body.replace(SECRET_MARK, 'x'));
        bodyIsJson = true;
      } catch {
        bodyIsJson = false;
      }
    }
    return { request, bodyIsJson };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Splits rendered text into plain parts and secret names, so the preview can show secrets as placeholders. */
export function splitSecrets(text: string): ({ text: string } | { secret: string })[] {
  const parts: ({ text: string } | { secret: string })[] = [];
  let last = 0;
  for (const match of text.matchAll(SECRET_MARK)) {
    if (match.index > last) parts.push({ text: text.slice(last, match.index) });
    parts.push({ secret: match[1] });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}
