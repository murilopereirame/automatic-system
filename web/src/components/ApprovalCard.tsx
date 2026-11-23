/**
 * A pending question to the user. Two kinds (see ApprovalKind on the server):
 *  - approval: a "Wait for approval" block, answered with approve or reject
 *  - before_step: the run paused before a block with "Pause before this block runs".
 *    For a "Run Claude" block the prompt it is about to send can be edited here.
 */
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

/** Why the prompt shown at a pause is not the workflow's, in words. */
const PROMPT_SOURCE: Record<string, string> = {
  'reviewer feedback': 'This is the feedback from a rejected approval, which Claude gets instead of the workflow prompt.',
  'edited for this run': 'This is the prompt you set for this block on the run page.',
  'edited before run': 'This is the prompt you confirmed the last time the run paused here.',
};

export function ApprovalCard({ approval, title, runLink, rejectHint, onResolved }: Props) {
  const beforeStep = approval.kind === 'before_step';
  const shownPrompt = typeof approval.data?.prompt === 'string' ? approval.data.prompt : undefined;
  const [comment, setComment] = useState('');
  const [prompt, setPrompt] = useState(shownPrompt ?? '');
  const [error, setError] = useState<string>();

  const resolve = (decision: 'approved' | 'rejected') =>
    api.resolveApproval(approval.id, decision, comment, shownPrompt !== undefined && decision === 'approved' ? prompt : undefined).then(onResolved, (reason: Error) => setError(reason.message));

  const source = PROMPT_SOURCE[String(approval.data?.source ?? '')];
  return (
    <section className="card approval">
      <header>
        <strong>{title}</strong>
        <span className="muted">
          {beforeStep ? 'paused' : 'asked'} <TimeAgo time={approval.createdAt} />
        </span>
      </header>
      <p className="approval-message">{approval.message}</p>
      {shownPrompt !== undefined && (
        <div className="field">
          <span>Prompt for Claude{prompt !== shownPrompt && ' (edited)'}</span>
          <textarea className="prompt-editor" rows={8} value={prompt} onChange={(event) => setPrompt(event.target.value)} />
          <small>
            {source ? `${source} ` : ''}Your edit is sent as written, for this start of the block only.
            {prompt !== shownPrompt && (
              <>
                {' '}
                <button className="ghost" onClick={() => setPrompt(shownPrompt)}>
                  Undo my changes
                </button>
              </>
            )}
          </small>
        </div>
      )}
      {!beforeStep && <textarea placeholder="Comment (optional). When you reject, this is handed to Claude as feedback." rows={2} value={comment} onChange={(event) => setComment(event.target.value)} />}
      <ErrorNote message={error} />
      <div className="actions">
        <button className="primary" onClick={() => resolve('approved')}>
          {beforeStep ? 'Run block' : 'Approve'}
        </button>
        <button className="danger" onClick={() => resolve('rejected')}>
          {beforeStep ? 'Stop run' : 'Reject'}
        </button>
        {!beforeStep && rejectHint && <span className="muted">{rejectHint}</span>}
        {runLink && (
          <a className="button" href={`#/runs/${approval.runId}`}>
            Open run and shell
          </a>
        )}
      </div>
    </section>
  );
}
