/**
 * The facts of a run under its title (trigger, start, duration, workflow version, repository) and a
 * progress bar with one segment per block, coloured by its state. A segment selects its block.
 */
import type { ReactNode } from 'react';
import type { Run } from '../api.ts';
import { TimeAgo } from '../components/common.tsx';
import { formatDuration, progress, runDuration, STATE_LABEL, stepState } from './run-steps.ts';

interface Props {
  run: Run;
  triggerText: string;
  selected?: string;
  onSelect: (stepId: string) => void;
  now: number;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="run-fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function RunSummary({ run, triggerText, selected, onSelect, now }: Props) {
  const { passed, total } = progress(run);
  const open = run.status === 'running' || run.status === 'waiting' || run.status === 'queued';
  const repo = run.context.repo;

  return (
    <section className="card run-summary">
      <dl className="run-facts">
        <Fact label="Trigger">{triggerText}</Fact>
        <Fact label="Started">
          <TimeAgo time={run.createdAt} />
        </Fact>
        <Fact label={open ? 'Running for' : 'Took'}>{formatDuration(runDuration(run, now))}</Fact>
        {run.workflowVersion !== undefined && (
          <Fact label="Workflow">
            <a href={`#/workflows/${run.workflowId}`} title="The workflow version this run executes. Compare versions in the History tab of the workflow.">
              v{run.workflowVersion}
            </a>
          </Fact>
        )}
        {repo && (
          <Fact label="Repository">
            <code>
              {repo.owner}/{repo.name}
            </code>{' '}
            on <code>{repo.branch}</code>
          </Fact>
        )}
        {run.cleanedAt && (
          <Fact label="Files">
            cleaned up <TimeAgo time={run.cleanedAt} />
          </Fact>
        )}
      </dl>
      <div className="run-progress">
        <div className="run-progress-bar" role="list" aria-label="Blocks by state">
          {run.definition.steps.map((step, index) => {
            const state = stepState(run, index);
            const name = step.name || step.id;
            return (
              <button
                key={step.id}
                role="listitem"
                className={`run-progress-segment state-${state}${selected === step.id ? ' selected' : ''}`}
                title={`${name}: ${STATE_LABEL[state]}`}
                aria-label={`${name}: ${STATE_LABEL[state]}`}
                onClick={() => onSelect(step.id)}
              />
            );
          })}
        </div>
        <span className="run-progress-text">
          {passed} of {total} block{total === 1 ? '' : 's'}
        </span>
      </div>
    </section>
  );
}
