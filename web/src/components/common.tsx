/** Small presentational pieces used across pages. */
import type { ReactNode } from 'react';
import type { RunStatus } from '../api.ts';

const STATUS_LABEL: Record<RunStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  waiting: 'Needs you',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export function StatusBadge({ status }: { status: RunStatus }) {
  return <span className={`status status-${status}`}>{STATUS_LABEL[status]}</span>;
}

export function PageHeader({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-header">
      <h1>{title}</h1>
      <div className="actions">{children}</div>
    </div>
  );
}

export function ErrorNote({ message }: { message?: string }) {
  return message ? <p className="error">{message}</p> : null;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

/** "3 minutes ago" style timestamps, with the exact time as a tooltip. */
export function TimeAgo({ time }: { time: string }) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(time).getTime()) / 1000));
  const units: [number, string][] = [
    [86400, 'day'],
    [3600, 'hour'],
    [60, 'minute'],
  ];
  let label = 'just now';
  for (const [size, name] of units) {
    if (seconds >= size) {
      const count = Math.floor(seconds / size);
      label = `${count} ${name}${count === 1 ? '' : 's'} ago`;
      break;
    }
  }
  return <time title={new Date(time).toLocaleString()}>{label}</time>;
}
