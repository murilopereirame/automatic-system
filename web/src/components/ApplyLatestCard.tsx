/**
 * Shown on a run whose workflow was edited after the run took its copy. Lists
 * what switching to the saved workflow changes for this run, and applies it.
 * The rules are in server/src/engine/apply-definition.ts.
 */
import { useState } from 'react';
import { api, type ApplyPlan, type BlockChange, type Run } from '../api.ts';
import { ErrorNote } from './common.tsx';

const SECTION_LABEL: Record<string, string> = {
  triggers: 'Triggers',
  inputs: 'Run now inputs',
  environment: 'Environment',
  notifications: 'Notifications',
};

/** One line per block: what changed, and whether this run will notice. */
function describeChange(change: BlockChange): string {
  if (change.where === 'behind') {
    if (change.kind === 'added') return 'added before where the run is, so it does not run in this run';
    if (change.kind === 'removed') return 'removed, its result stays in this run';
    return 'already done, keeps its result';
  }
  if (change.kind === 'added') return 'added, will run';
  if (change.kind === 'removed') return 'removed, will not run';
  return 'will run with the new settings';
}

export function ApplyLatestCard({ run, onApplied }: { run: Run; onApplied: () => void }) {
  const [plan, setPlan] = useState<ApplyPlan>();
  const [error, setError] = useState<string>();
  const fail = (reason: Error) => setError(reason.message);

  const review = () => api.applyLatestPlan(run.id).then(setPlan, fail);
  const apply = () => api.applyLatest(run.id).then(() => (setPlan(undefined), onApplied()), fail);

  return (
    <section className="card apply-latest">
      <header>
        <strong>This workflow was edited after this run started</strong>
        {!plan && <button onClick={review}>Review changes</button>}
      </header>
      {plan && (
        <>
          {plan.blocks.length > 0 && (
            <ul className="apply-changes">
              {plan.blocks.map((change) => (
                <li key={`${change.kind}-${change.id}`} className={`apply-${change.where}`}>
                  <span className={`apply-kind apply-kind-${change.kind}`}>{change.kind}</span> <strong>{change.name}</strong>: {describeChange(change)}
                </li>
              ))}
            </ul>
          )}
          {plan.sections.length > 0 && <p>Also changed: {plan.sections.map((section) => SECTION_LABEL[section] ?? section).join(', ')}.</p>}
          <p className="muted">
            {run.status === 'running'
              ? 'The block that is running now finishes as it is. The changes apply from the block after it.'
              : `The run continues with ${plan.continueName ? `"${plan.continueName}"` : 'the end of the run'}${run.status === 'failed' || run.status === 'cancelled' ? ' when you retry it' : ''}.`}
            {plan.currentRemoved && run.status === 'waiting' && ' The block it is waiting at was removed, so the run stops waiting and goes on.'}
          </p>
          <div className="actions">
            <button className="primary" onClick={apply}>
              Apply latest workflow
            </button>
            <button onClick={() => setPlan(undefined)}>Not now</button>
          </div>
        </>
      )}
      <ErrorNote message={error} />
    </section>
  );
}
