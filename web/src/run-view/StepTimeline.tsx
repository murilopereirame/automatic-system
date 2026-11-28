/**
 * The blocks of a run as a vertical timeline: each with the icon and colour it has on the flow
 * canvas, a badge for its state, and how long it took. Picking a block shows only its activity;
 * the first entry, the trigger, shows all of it.
 */
import type { CSSProperties } from 'react';
import type { Approval, Run, StepConfig } from '../api.ts';
import { NodeIcon, nodeStyle } from '../flow/node-style.tsx';
import { conditionOutcome, formatDuration, STATE_LABEL, stepDuration, stepState, type StepState } from './run-steps.ts';

interface Props {
  run: Run;
  pending: Approval[];
  selected?: string;
  onSelect: (stepId: string | undefined) => void;
  now: number;
  /** "Started manually", "Started by trigger …". */
  triggerText: string;
}

/** The glyph in the corner of a block's icon. Running has a spinning ring instead. */
const BADGE: Partial<Record<StepState, string>> = { done: '✓', succeeded: '✓', failed: '✕', cancelled: '■', waiting: '!', skipped: '–' };

const colorOf = (type: string) => ({ '--node-color': nodeStyle(type).color }) as CSSProperties;

export function StepTimeline({ run, pending, selected, onSelect, now, triggerText }: Props) {
  const pausedBefore = (step: StepConfig) => pending.some((approval) => approval.kind === 'before_step' && approval.stepId === step.id);
  const triggerType = run.context.triggeredBy?.type ?? 'manual';

  /** "Done · 42s", "Running · 1m 03s · attempt 2", "True → Report". */
  const meta = (step: StepConfig, state: StepState): string => {
    const label = (state === 'done' && conditionOutcome(run, step)) || (state === 'waiting' && pausedBefore(step) && 'Paused before start') || STATE_LABEL[state];
    const parts = [label];
    const timing = run.context.timing?.[step.id];
    const duration = state === 'pending' || state === 'skipped' ? undefined : stepDuration(run, step, now);
    if (duration !== undefined && !(state === 'waiting' && pausedBefore(step))) parts.push(formatDuration(duration));
    if (timing && timing.attempts > 1) parts.push(`attempt ${timing.attempts}`);
    return parts.join(' · ');
  };

  return (
    <nav className="card timeline" aria-label="Blocks of this run">
      <ol>
        <li className="timeline-step state-done">
          <button className={selected ? 'timeline-button' : 'timeline-button selected'} aria-current={selected ? undefined : 'true'} onClick={() => onSelect(undefined)}>
            <span className="timeline-icon" style={colorOf(triggerType)}>
              <NodeIcon type={triggerType} size={18} />
            </span>
            <span className="timeline-text">
              <span className="timeline-name">All activity</span>
              <span className="timeline-meta">{triggerText}</span>
            </span>
          </button>
        </li>
        {run.definition.steps.map((step, index) => {
          const state = stepState(run, index);
          const isSelected = selected === step.id;
          return (
            <li key={step.id} className={`timeline-step state-${state}`}>
              <button className={`timeline-button${isSelected ? ' selected' : ''}`} aria-current={isSelected ? 'true' : undefined} onClick={() => onSelect(step.id)} title={`${step.name || step.id} (${step.type})`}>
                <span className="timeline-icon" style={colorOf(step.type)}>
                  <NodeIcon type={step.type} size={18} />
                  {BADGE[state] && (
                    <span className="timeline-badge" aria-hidden="true">
                      {BADGE[state]}
                    </span>
                  )}
                </span>
                <span className="timeline-text">
                  <span className="timeline-name">{step.name || step.id}</span>
                  <span className="timeline-meta">{meta(step, state)}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
