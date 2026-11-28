/**
 * The HTTP request a notification webhook would send, with example values filled in. Secrets show
 * as placeholders: their values never leave the server. See preview.ts.
 */
import type { ReactNode } from 'react';
import type { NotificationWebhook } from '../api.ts';
import { CodeBlock } from '../components/CodeBlock.tsx';
import { previewWebhook, splitSecrets, type PreviewOptions } from './preview.ts';

/** Rendered text with each secret replaced by a placeholder chip. */
function WithSecrets({ text }: { text: string }): ReactNode {
  return splitSecrets(text).map((part, index) =>
    'secret' in part ? (
      <span key={index} className="secret-placeholder" title="Filled in from the stored secret when the notification is sent">
        secret {part.secret}
      </span>
    ) : (
      <span key={index}>{part.text}</span>
    ),
  );
}

/** The body as it goes out, indented when it is JSON so it is easier to read. */
function prettyBody(body: string, isJson: boolean | undefined): string {
  if (!isJson || /__SECRET_/.test(body)) return body;
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

export function NotificationPreview({ webhook, options }: { webhook: NotificationWebhook; options: PreviewOptions }) {
  const result = previewWebhook(webhook, options);
  if ('error' in result) return <p className="error">The preview cannot be built: {result.error}</p>;
  const { request, bodyIsJson } = result;
  const hasSecrets = /__SECRET_/.test(request.body ?? '');
  return (
    <div className="notification-preview">
      <div className="notification-request">
        <span className="method">{request.method}</span>
        <code className="notification-url">{request.url ? <WithSecrets text={request.url} /> : <span className="muted">no URL yet</span>}</code>
      </div>
      <dl className="notification-headers">
        {Object.entries(request.headers).map(([name, value]) => (
          <div key={name}>
            <dt>{name}:</dt>
            <dd>
              <WithSecrets text={value} />
            </dd>
          </div>
        ))}
      </dl>
      {request.body !== undefined &&
        (hasSecrets ? (
          <pre className="code-block">
            <WithSecrets text={request.body} />
          </pre>
        ) : (
          <CodeBlock code={prettyBody(request.body, bodyIsJson)} language={bodyIsJson ? 'json' : undefined} />
        ))}
      {bodyIsJson === false && <p className="warning">The body is sent as JSON but is not valid JSON. Did a value miss <code>| json</code>?</p>}
    </div>
  );
}
