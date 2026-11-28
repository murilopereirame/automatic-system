/**
 * What the run page shows about each block of a run: its state, how long it took, and the log
 * split into sections per block. Plain functions without React, so they can be tested on their
 * own (see web/test/run-steps.test.ts). The page itself is described in docs/RUN_VIEW.md.
 */
import type { Run, RunEvent, RunStatus, StepConfig } from '../api.ts';

/** `done` and `skipped` are blocks the run is past; the block the run is at mirrors the run; later ones are `pending`. */
export type StepState = 'done' | 'skipped' | 'pending' | RunStatus;

export const STATE_LABEL: Record<StepState, string> = {
  done: 'Done',
  skipped: 'Skipped',
  pending: 'Pending',
  queued: 'Queued',
  running: 'Running',
  waiting: 'Needs you',
  succeeded: 'Done',
  failed: 'Failed',
  cancelled: 'Stopped',
};

export function stepState(run: Run, index: number): StepState {
  if (run.status !== 'succeeded' && index >= run.stepIndex) return index === run.stepIndex ? run.status : 'pending';
  return run.context.steps[run.definition.steps[index].id]?.skipped ? 'skipped' : 'done';
}

/** What a finished condition block decided, e.g. "False → Report". Shown instead of "Done". */
export function conditionOutcome(run: Run, step: StepConfig): string | undefined {
  const output = run.context.steps[step.id]?.output as { result?: boolean; goTo?: string | null } | null | undefined;
  if (step.type !== 'condition' || typeof output?.result !== 'boolean') return undefined;
  const target = output.goTo === '$end' ? 'end of run' : run.definition.steps.find((candidate) => candidate.id === output.goTo)?.name || output.goTo;
  return `${output.result ? 'True' : 'False'}${target ? ` → ${target}` : ''}`;
}

/** How many blocks the run is past (done or skipped), for the progress line. */
export function progress(run: Run): { passed: number; total: number } {
  const total = run.definition.steps.length;
  const passed = run.definition.steps.filter((_, index) => {
    const state = stepState(run, index);
    return state === 'done' || state === 'skipped';
  }).length;
  return { passed, total };
}

/** "<1s", "42s", "3m 05s", "1h 12m". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return '<1s';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/**
 * How long a block took, or has been going for while it runs or waits. `now` is passed in so a
 * ticking clock can drive it. Undefined for blocks that never started, and for runs from before
 * blocks recorded their timing.
 */
export function stepDuration(run: Run, step: StepConfig, now: number): number | undefined {
  const timing = run.context.timing?.[step.id];
  if (!timing) return undefined;
  const end = timing.endedAt ? Date.parse(timing.endedAt) : now;
  return Math.max(0, end - Date.parse(timing.startedAt));
}

/** How long the whole run took: until its last update when it has ended, until `now` while it is open. */
export function runDuration(run: Run, now: number): number {
  const ended = run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled';
  return Math.max(0, (ended ? Date.parse(run.updatedAt) : now) - Date.parse(run.createdAt));
}

/** A stretch of the log that belongs to one block, or to the run itself (`stepId` null: triggered, finished, retried). */
export interface LogSection {
  /** Stable across renders: the id of the section's first event. */
  key: number;
  stepId: string | null;
  /** When the section begins, including the "Block started" event that is left out of `events`. */
  at: string;
  events: RunEvent[];
}

/**
 * Splits the log into sections: consecutive events of the same block form one section. A block that
 * runs again later (a condition going back, a retry) gets a new section there, so the log keeps its
 * order. "Block started" events are left out: the section header says the same.
 */
export function sectionsOf(events: RunEvent[]): LogSection[] {
  const sections: LogSection[] = [];
  let current: LogSection | undefined;
  for (const event of events) {
    const starts = event.type === 'step_started';
    if (!current || current.stepId !== event.stepId || (starts && current.events.length > 0)) {
      current = { key: event.id, stepId: event.stepId, at: event.createdAt, events: [] };
      sections.push(current);
    }
    if (!starts) current.events.push(event);
  }
  return sections;
}
