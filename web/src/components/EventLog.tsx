/** Renders the event log of a run: what was triggered, what Claude said and did, command output, approvals. */
import type { ReactNode } from 'react';
import type { RunEvent } from '../api.ts';

/** Joins consecutive output chunks of the same block into one entry, so logs read as text instead of fragments. */
export function mergeOutput(events: RunEvent[]): RunEvent[] {
  const merged: RunEvent[] = [];
  for (const event of events) {
    const previous = merged[merged.length - 1];
    if (event.type === 'output' && previous?.type === 'output' && previous.stepId === event.stepId) {
      merged[merged.length - 1] = { ...previous, data: { ...previous.data, text: `${previous.data.text}${event.data.text}` } };
    } else {
      merged.push(event);
    }
  }
  return merged;
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

function Collapsible({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  return (
    <details>
      <summary>{summary}</summary>
      {children}
    </details>
  );
}

/** Label and body for each kind of event. Unknown kinds fall back to their raw data. */
function describe(event: RunEvent): { label: string; tone?: string; body: ReactNode } {
  const data = event.data as Record<string, any>;
  switch (event.type) {
    case 'triggered':
      return { label: 'Triggered', body: <Collapsible summary={`by ${data.trigger}`}><pre>{json(data.payload)}</pre></Collapsible> };
    case 'step_started':
      return { label: 'Block started', tone: 'heading', body: data.name };
    case 'step_finished':
      return { label: 'Block finished', body: <Collapsible summary="Output"><pre>{json(data.output)}</pre></Collapsible> };
    case 'claude_prompt':
      return { label: 'Prompt', body: <div className="prose">{data.prompt}</div> };
    case 'claude_text':
      return { label: 'Claude', tone: 'claude', body: <div className="prose">{data.text}</div> };
    case 'claude_tool':
      return { label: 'Tool call', body: <Collapsible summary={<code>{data.tool}</code>}><pre>{json(data.input)}</pre></Collapsible> };
    case 'claude_tool_result':
      return { label: data.isError ? 'Tool error' : 'Tool result', tone: data.isError ? 'bad' : undefined, body: <Collapsible summary={String(data.output).split('\n')[0].slice(0, 120)}><pre>{data.output}</pre></Collapsible> };
    case 'command':
      return { label: 'Command', body: <pre>$ {data.command}</pre> };
    case 'output':
      return { label: 'Output', body: <pre>{data.text}</pre> };
    case 'log':
      return { label: 'Info', body: data.message };
    case 'notification':
      return { label: 'Notification', body: `${data.message} (${data.delivered?.length ? `sent to ${data.delivered.join(', ')}` : 'no webhook reached'})` };
    case 'approval_requested':
      return { label: 'Waiting for you', tone: 'attention', body: data.message };
    case 'approval_resolved':
      return { label: data.decision === 'approved' ? 'Approved' : 'Rejected', tone: data.decision === 'approved' ? 'good' : 'bad', body: data.comment || 'No comment' };
    case 'pull_request':
      return { label: 'Pull request', tone: 'good', body: <a href={data.url} target="_blank" rel="noreferrer">{data.url}</a> };
    case 'retried':
      return { label: 'Retried', body: `from block ${data.fromStep}` };
    case 'run_finished':
      return { label: `Run ${data.status}`, tone: data.status === 'succeeded' ? 'good' : 'bad', body: data.error ?? '' };
    default:
      return { label: event.type, body: <pre>{json(data)}</pre> };
  }
}

export function EventLog({ events }: { events: RunEvent[] }) {
  return (
    <ol className="event-log">
      {mergeOutput(events).map((event) => {
        const { label, tone, body } = describe(event);
        return (
          <li key={event.id} className={`event ${tone ? `event-${tone}` : ''}`}>
            <span className="event-meta">
              <time>{new Date(event.createdAt).toLocaleTimeString()}</time>
              <span className="event-label">{label}</span>
            </span>
            <div className="event-body">{body}</div>
          </li>
        );
      })}
    </ol>
  );
}
