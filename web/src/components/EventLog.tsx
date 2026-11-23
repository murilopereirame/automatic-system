/**
 * Renders the event log of a run: what was triggered, what Claude said and did, command output, approvals.
 * Built to stay fast with large logs: entries only re-render when they change, collapsed details are
 * not built until opened, and very long texts are clipped until the person asks for all of them.
 */
import { memo, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { RunEvent } from '../api.ts';
import { clipText, mergeOutput, TEXT_PREVIEW_CHARS } from '../run-log.ts';

const json = (value: unknown) => JSON.stringify(value, null, 2);

/** The first line of a text, short enough for a summary. Does not split the whole text into lines. */
function firstLine(text: string): string {
  const end = text.indexOf('\n');
  return (end === -1 ? text : text.slice(0, end)).slice(0, 120);
}

/** A <details> whose content is only built once opened: big JSON payloads cost nothing while collapsed. */
function Collapsible({ summary, children }: { summary: ReactNode; children: () => ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{summary}</summary>
      {open && children()}
    </details>
  );
}

/**
 * Text that may be huge (command output, tool results, payloads). Shows TEXT_PREVIEW_CHARS of it, the end
 * for output, and a button for the rest.
 */
function LongText({ text, keep = 'start', as = 'pre' }: { text: string; keep?: 'start' | 'end'; as?: 'pre' | 'prose' }) {
  const [full, setFull] = useState(false);
  const { shown, hidden } = full ? { shown: text, hidden: 0 } : clipText(text, TEXT_PREVIEW_CHARS, keep);
  // Output reads like a terminal: keep its box scrolled to the newest line unless the person scrolled up.
  const box = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    if (keep === 'end' && pinned.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [keep, shown]);
  const onScroll = () => {
    const element = box.current;
    if (element) pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
  };
  const more = hidden > 0 && (
    <button className="ghost show-all" onClick={() => setFull(true)}>
      {keep === 'end' ? 'Show earlier' : 'Show the rest'} ({Math.ceil(hidden / 1024)} KB more)
    </button>
  );
  const body =
    as === 'pre' ? (
      <pre ref={box} onScroll={keep === 'end' ? onScroll : undefined}>
        {shown}
      </pre>
    ) : (
      <div className="prose">{shown}</div>
    );
  return (
    <>
      {keep === 'end' && more}
      {body}
      {keep === 'start' && more}
    </>
  );
}

/** Label and body for each kind of event. Unknown kinds fall back to their raw data. */
function describe(event: RunEvent): { label: string; tone?: string; body: ReactNode } {
  const data = event.data as Record<string, any>;
  switch (event.type) {
    case 'triggered':
      return { label: 'Triggered', body: <Collapsible summary={data.triggerId && data.triggerId !== data.trigger ? `by ${data.triggerId} (${data.trigger})` : `by ${data.trigger}`}>{() => <LongText text={json(data.payload)} />}</Collapsible> };
    case 'step_started':
      return { label: 'Block started', tone: 'heading', body: data.name };
    case 'step_finished':
      return { label: 'Block finished', body: <Collapsible summary="Output">{() => <LongText text={json(data.output)} />}</Collapsible> };
    case 'step_skipped':
      return { label: 'Block skipped', tone: 'heading', body: `${data.name}: ${data.reason}` };
    case 'condition':
      return { label: data.result ? 'Condition true' : 'Condition false', tone: data.result ? 'good' : 'attention', body: <><code>{data.expression}</code>{data.goTo ? ` → continues with ${data.goTo === '$end' ? 'the end of the run' : data.goTo}` : ''}</> };
    case 'claude_prompt':
      return { label: 'Prompt', body: <LongText as="prose" text={String(data.prompt ?? '')} /> };
    case 'claude_text':
      return { label: 'Claude', tone: 'claude', body: <LongText as="prose" text={String(data.text ?? '')} /> };
    case 'claude_tool':
      return { label: 'Tool call', body: <Collapsible summary={<code>{data.tool}</code>}>{() => <LongText text={json(data.input)} />}</Collapsible> };
    case 'claude_tool_result':
      return { label: data.isError ? 'Tool error' : 'Tool result', tone: data.isError ? 'bad' : undefined, body: <Collapsible summary={firstLine(String(data.output))}>{() => <LongText text={String(data.output)} />}</Collapsible> };
    case 'command':
      return { label: 'Command', body: <pre>$ {data.command}</pre> };
    case 'output':
      return { label: 'Output', body: <LongText text={String(data.text ?? '')} keep="end" /> };
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
    case 'definition_queued':
      return { label: 'Workflow edits', body: data.reason };
    case 'definition_applied': {
      const blocks = (data.blocks ?? []) as { name: string; kind: string; where: string }[];
      const ahead = blocks.filter((block) => block.where === 'ahead');
      const summary = ahead.length ? ahead.map((block) => `${block.name} (${block.kind})`).join(', ') : 'no blocks ahead changed';
      const versions = typeof data.toVersion === 'number' ? ` (${typeof data.fromVersion === 'number' ? `v${data.fromVersion} → ` : ''}v${data.toVersion})` : '';
      return { label: `Workflow edits applied${versions}`, tone: 'heading', body: `${summary}. Continues with ${data.continueAt ?? 'the end of the run'}.` };
    }
    case 'value_set':
      return { label: data.replaced ? 'Value changed' : 'Value added', body: <><code>{`vars.${data.name}`}</code> = <LongText text={typeof data.value === 'string' ? data.value : json(data.value)} /></> };
    case 'value_removed':
      return { label: 'Value removed', body: <code>{`vars.${data.name}`}</code> };
    case 'retried':
      return { label: 'Retried', body: `from block ${data.fromStep}` };
    case 'run_finished':
      return { label: `Run ${data.status}`, tone: data.status === 'succeeded' ? 'good' : 'bad', body: data.error ?? '' };
    default:
      return { label: event.type, body: <LongText text={json(data)} /> };
  }
}

function EventEntry({ event }: { event: RunEvent }) {
  const { label, tone, body } = describe(event);
  return (
    <li className={`event ${tone ? `event-${tone}` : ''}`}>
      <span className="event-meta">
        <time>{new Date(event.createdAt).toLocaleTimeString()}</time>
        <span className="event-label">{label}</span>
      </span>
      <div className="event-body">{body}</div>
    </li>
  );
}

/**
 * Events never change once written, except merged output, which grows at its end. So an entry
 * only needs to re-render when its id or the length of its merged text changes.
 */
const MemoEntry = memo(
  EventEntry,
  (before, after) => before.event.id === after.event.id && String(before.event.data.text ?? '').length === String(after.event.data.text ?? '').length,
);

export function EventLog({ events }: { events: RunEvent[] }) {
  const merged = useMemo(() => mergeOutput(events), [events]);
  return (
    <ol className="event-log">
      {merged.map((event) => (
        <MemoEntry key={event.id} event={event} />
      ))}
    </ol>
  );
}
