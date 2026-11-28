/** Editor for the notification webhooks of a workflow. */
import { useState } from 'react';
import type { NotificationWebhook, RunInput } from '../api.ts';
import { NotificationPreview } from '../notifications/NotificationPreview.tsx';
import { PREVIEW_EVENTS, type PreviewEvent } from '../notifications/preview.ts';
import { ListEditor } from './ListEditor.tsx';

interface Props {
  notifications: NotificationWebhook[];
  onChange: (notifications: NotificationWebhook[]) => void;
  /** For the preview: the workflow's name and the inputs of "Run now", which fill `{{trigger...}}`. */
  workflowName: string;
  inputs?: RunInput[];
}

const headersToText = (headers: Record<string, string> = {}) =>
  Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n');

function textToHeaders(text: string): Record<string, string> {
  const pairs = text
    .split('\n')
    .map((line) => line.match(/^\s*([^:]+?)\s*:\s?(.*)$/))
    .filter((match) => match !== null)
    .map((match) => [match[1], match[2]]);
  return Object.fromEntries(pairs);
}

export function NotificationsEditor({ notifications, onChange, workflowName, inputs }: Props) {
  const [event, setEvent] = useState<PreviewEvent>('approval');
  const previewOptions = { workflowName, inputs, event, origin: window.location.origin };
  return (
    <div className="sections">
      <section className="card">
        <h2>Notification webhooks</h2>
        <p className="muted">
          Each notification is an HTTP call. They are sent by "Send notification" blocks, and automatically when a run needs your approval or fails. URL, headers and body may contain variables:
        </p>
        <ul className="muted compact">
          <li>
            <code>{'{{title}}'}</code>, <code>{'{{message}}'}</code>, <code>{'{{run.url}}'}</code>, <code>{'{{run.id}}'}</code>, <code>{'{{workflow.name}}'}</code>
          </li>
          <li>
            <code>{'{{trigger...}}'}</code>, <code>{'{{triggeredBy.id}}'}</code> and <code>{'{{steps.<id>.output...}}'}</code>, as in blocks
          </li>
          <li>
            <code>{'{{secrets.NAME}}'}</code> for tokens, so they stay out of the formula
          </li>
          <li>
            Add <code>| json</code> inside JSON bodies and <code>| url</code> inside URLs, for example <code>{'{{message | json}}'}</code>
          </li>
        </ul>

        {notifications.length > 0 && (
          <div className="notification-toolbar">
            <span className="muted">Previews below use example values, as sent when</span>
            <select value={event} onChange={(change) => setEvent(change.target.value as PreviewEvent)} aria-label="Situation to preview">
              {Object.entries(PREVIEW_EVENTS).map(([key, value]) => (
                <option key={key} value={key}>
                  {value.label}
                </option>
              ))}
            </select>
          </div>
        )}

        <ListEditor
          items={notifications}
          onChange={onChange}
          blank={() => ({ name: `webhook_${notifications.length + 1}`, url: '', method: 'POST', headers: {}, body: '' })}
          addLabel="Add webhook"
        >
          {(webhook, update) => (
            <div className="stack">
              <div className="field-pair">
                <label className="field">
                  <span>Name</span>
                  <input value={webhook.name} onChange={(event) => update({ name: event.target.value })} />
                </label>
                <label className="field narrow">
                  <span>Method</span>
                  <select value={webhook.method ?? 'POST'} onChange={(event) => update({ method: event.target.value })}>
                    {['POST', 'GET', 'PUT', 'PATCH'].map((method) => (
                      <option key={method}>{method}</option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="field">
                <span>URL</span>
                <input className="mono" placeholder="https://ntfy.sh/{{secrets.NTFY_TOPIC | url}}" value={webhook.url} onChange={(event) => update({ url: event.target.value })} />
              </label>
              <label className="field">
                <span>Headers, one per line</span>
                <textarea className="mono" rows={3} placeholder={'Title: {{title}}'} defaultValue={headersToText(webhook.headers)} onChange={(event) => update({ headers: textToHeaders(event.target.value) })} />
              </label>
              <label className="field">
                <span>Body</span>
                <textarea className="mono" rows={3} placeholder={'{"title": {{title | json}}, "message": {{message | json}}, "url": {{run.url | json}}}'} value={webhook.body ?? ''} onChange={(event) => update({ body: event.target.value })} />
                <small>Leave empty to send the JSON shown as placeholder.</small>
              </label>
              <details className="notification-preview-toggle" open>
                <summary>Preview</summary>
                <NotificationPreview webhook={webhook} options={previewOptions} />
              </details>
            </div>
          )}
        </ListEditor>
      </section>
    </div>
  );
}
