/**
 * Edits the prompt a "Run Claude" block of this run uses, without pausing the
 * run. The prompt is a template like the workflow's and is used every time the
 * block starts from now on, until "Use the workflow prompt" clears it.
 * See docs/PAUSE_BEFORE.md.
 */
import { useEffect, useState } from 'react';
import { api, type Run, type StepConfig } from '../api.ts';
import { ErrorNote } from './common.tsx';

interface Props {
  run: Run;
  step: StepConfig;
  onSaved: () => void;
}

/** When the edited prompt takes effect, given where the run is. */
function timingNote(run: Run, step: StepConfig): string {
  const index = run.definition.steps.findIndex((candidate) => candidate.id === step.id);
  if (index === run.stepIndex && run.status === 'running') return 'Claude is working on this block with the prompt it started with. Your change applies the next time the block starts.';
  if (index < run.stepIndex) return 'This block already ran. Your change applies if the run comes back to it, for example through a condition or a rejected approval.';
  return 'Your change applies when this block starts.';
}

export function RunPromptCard({ run, step, onSaved }: Props) {
  const override = run.context.promptOverrides?.[step.id];
  const configured = String(step.with.prompt ?? '');
  const current = override ?? configured;
  const [draft, setDraft] = useState(current);
  const [error, setError] = useState<string>();
  // Follow the run when another tab, or the server, changes the prompt.
  useEffect(() => setDraft(current), [step.id, current]);

  const act = (action: Promise<unknown>) => action.then(() => (setError(undefined), onSaved()), (reason: Error) => setError(reason.message));
  return (
    <details className="card run-prompt" open={override !== undefined || undefined}>
      <summary>
        <strong>Prompt for this run</strong>
        <span className="muted">{override !== undefined ? 'edited for this run' : 'from the workflow'}</span>
      </summary>
      <textarea className="prompt-editor" rows={6} value={draft} onChange={(event) => setDraft(event.target.value)} />
      <p className="muted">
        {timingNote(run, step)} Use <code>{'{{trigger...}}'}</code> and <code>{'{{steps.<id>.output...}}'}</code> like in the workflow. Only this run changes.
      </p>
      <ErrorNote message={error} />
      <div className="actions">
        <button className="primary" disabled={draft === current || !draft.trim()} onClick={() => act(api.setRunPrompt(run.id, step.id, draft))}>
          Save prompt
        </button>
        {override !== undefined && <button onClick={() => act(api.clearRunPrompt(run.id, step.id))}>Use the workflow prompt</button>}
        {draft !== current && <button className="ghost" onClick={() => setDraft(current)}>Discard changes</button>}
      </div>
    </details>
  );
}
