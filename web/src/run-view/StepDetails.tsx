/**
 * The top of the activity panel when one block is selected: its icon, name and type, its state and
 * timing, what a condition decided, and the output the block produced (what later blocks read as
 * `steps.<id>.output`).
 */
import { useState, type CSSProperties } from 'react';
import type { Run, StepConfig } from '../api.ts';
import { NodeIcon, nodeStyle } from '../flow/node-style.tsx';
import { conditionOutcome, formatDuration, STATE_LABEL, stepDuration, type StepState } from './run-steps.ts';

interface Props {
  run: Run;
  step: StepConfig;
  state: StepState;
  now: number;
}

export function StepDetails({ run, step, state, now }: Props) {
  const [showOutput, setShowOutput] = useState(false);
  const timing = run.context.timing?.[step.id];
  const duration = state === 'pending' ? undefined : stepDuration(run, step, now);
  const result = run.context.steps[step.id];
  const outcome = conditionOutcome(run, step);

  return (
    <div className="step-details" style={{ '--node-color': nodeStyle(step.type).color } as CSSProperties}>
      <span className="flow-node-icon step-details-icon">
        <NodeIcon type={step.type} />
      </span>
      <div className="step-details-text">
        <h2>{step.name || step.id}</h2>
        <p className="muted">
          <code>{step.id}</code> · {step.type}
        </p>
      </div>
      <dl className="step-details-facts">
        <div>
          <dt>State</dt>
          <dd className={`step-details-state state-${state}`}>{outcome && state === 'done' ? outcome : STATE_LABEL[state]}</dd>
        </div>
        {timing && (
          <div>
            <dt>Started</dt>
            <dd title={new Date(timing.startedAt).toLocaleString()}>{new Date(timing.startedAt).toLocaleTimeString()}</dd>
          </div>
        )}
        {duration !== undefined && (
          <div>
            <dt>{timing?.endedAt ? 'Took' : 'For'}</dt>
            <dd>{formatDuration(duration)}</dd>
          </div>
        )}
        {timing && timing.attempts > 1 && (
          <div>
            <dt>Attempts</dt>
            <dd>{timing.attempts}</dd>
          </div>
        )}
      </dl>
      {result && !result.skipped && result.output !== null && (
        <div className="step-details-output">
          <button className="ghost" onClick={() => setShowOutput(!showOutput)} aria-expanded={showOutput}>
            {showOutput ? 'Hide output' : 'Show output'}
          </button>
          {showOutput && <pre>{JSON.stringify(result.output, null, 2)}</pre>}
        </div>
      )}
    </div>
  );
}
