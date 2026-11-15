/** A pending question to the user, with approve and reject actions. */
import { useState } from 'react';
import { api, type Approval } from '../api.ts';
import { ErrorNote, TimeAgo } from './common.tsx';

interface Props {
  approval: Approval;
  title: string;
  /** Show a link to the run (used in the inbox, not on the run page itself). */
  runLink?: boolean;
  /** What rejecting does, shown next to the button. */
  rejectHint?: string;
  onResolved: () => void;
}

export function ApprovalCard({ approval, title, runLink, rejectHint, onResolved }: Props) {
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string>();

  const resolve = (decision: 'approved' | 'rejected') =>
    api.resolveApproval(approval.id, decision, comment).then(onResolved, (reason: Error) => setError(reason.message));

  return (
    <section className="card approval">
      <header>
        <strong>{title}</strong>
        <span className="muted">
          asked <TimeAgo time={approval.createdAt} />
        </span>
      </header>
      <p className="approval-message">{approval.message}</p>
      <textarea placeholder="Comment (optional). When you reject, this is handed to Claude as feedback." rows={2} value={comment} onChange={(event) => setComment(event.target.value)} />
      <ErrorNote message={error} />
      <div className="actions">
        <button className="primary" onClick={() => resolve('approved')}>
          Approve
        </button>
        <button className="danger" onClick={() => resolve('rejected')}>
          Reject
        </button>
        {rejectHint && <span className="muted">{rejectHint}</span>}
        {runLink && (
          <a className="button" href={`#/runs/${approval.runId}`}>
            Open run and shell
          </a>
        )}
      </div>
    </section>
  );
}
