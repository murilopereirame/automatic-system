/**
 * The loaded part of a run's log, split into one section per block (see `sectionsOf`). Each section
 * has a header with the block's icon, name, state and time, and can be folded away. Events of the
 * run itself (triggered, retried, finished) sit between the sections without a header.
 */
import { useMemo, useState, type CSSProperties } from 'react';
import type { Run, RunEvent, StepConfig } from '../api.ts';
import { EventLog } from '../components/EventLog.tsx';
import { NodeIcon, nodeStyle } from '../flow/node-style.tsx';
import { formatDuration, sectionsOf, STATE_LABEL, stepDuration, stepState, type LogSection, type StepState } from './run-steps.ts';

interface Props {
  run: Run;
  events: RunEvent[];
  now: number;
  /** One block is selected: its name is already in the panel header, so sections only say which attempt they are. */
  single: boolean;
  onSelect: (stepId: string) => void;
}

const time = (iso: string) => new Date(iso).toLocaleTimeString();

export function ActivityLog({ run, events, now, single, onSelect }: Props) {
  const sections = useMemo(() => sectionsOf(events), [events]);
  const [folded, setFolded] = useState<ReadonlySet<number>>(new Set());
  const toggle = (key: number) =>
    setFolded((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  // Only the newest section of a block shows its live state; earlier ones are attempts that ended.
  const latest = new Map<string, number>();
  for (const section of sections) if (section.stepId) latest.set(section.stepId, section.key);

  return (
    <div className="activity">
      {sections.map((section) => {
        const index = section.stepId ? run.definition.steps.findIndex((step) => step.id === section.stepId) : -1;
        const step = run.definition.steps[index];
        if (!step) return <EventLog key={section.key} events={section.events} />;
        const isLatest = latest.get(step.id) === section.key;
        return (
          <Section
            key={section.key}
            section={section}
            step={step}
            state={isLatest ? stepState(run, index) : 'done'}
            duration={isLatest ? stepDuration(run, step, now) : spanOf(section)}
            single={single}
            folded={folded.has(section.key)}
            onToggle={() => toggle(section.key)}
            onSelect={() => onSelect(step.id)}
          />
        );
      })}
    </div>
  );
}

/** How long an earlier attempt of a block took, judged by its log: from its start to its last event. */
function spanOf(section: LogSection): number | undefined {
  const last = section.events[section.events.length - 1];
  return last ? Date.parse(last.createdAt) - Date.parse(section.at) : undefined;
}

interface SectionProps {
  section: LogSection;
  step: StepConfig;
  state: StepState;
  duration?: number;
  single: boolean;
  folded: boolean;
  onToggle: () => void;
  onSelect: () => void;
}

function Section({ section, step, state, duration, single, folded, onToggle, onSelect }: SectionProps) {
  const name = step.name || step.id;
  const live = state === 'running' || state === 'waiting' || state === 'queued';
  return (
    <section className={`activity-section state-${state}`} style={{ '--node-color': nodeStyle(step.type).color } as CSSProperties}>
      <header className="activity-header">
        <button className="ghost activity-fold" onClick={onToggle} aria-expanded={!folded} aria-label={folded ? `Show the activity of ${name}` : `Hide the activity of ${name}`}>
          <span className="activity-chevron" aria-hidden="true" />
        </button>
        <span className="activity-icon">
          <NodeIcon type={step.type} size={16} />
        </span>
        {single ? (
          <span className="activity-title">Started {time(section.at)}</span>
        ) : (
          <button className="link activity-title" onClick={onSelect} title="Show only this block">
            {name}
          </button>
        )}
        <span className="activity-state">
          {STATE_LABEL[state]}
          {duration !== undefined && ` · ${formatDuration(duration)}`}
        </span>
        {!single && <time className="activity-time">{time(section.at)}</time>}
      </header>
      {!folded &&
        (section.events.length > 0 ? (
          <EventLog events={section.events} />
        ) : (
          <p className="activity-empty">{live ? 'Started. Nothing to show yet.' : 'No activity recorded.'}</p>
        ))}
    </section>
  );
}
