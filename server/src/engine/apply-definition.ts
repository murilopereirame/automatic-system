/**
 * Works out what happens when a run that already exists switches to another
 * definition of its workflow, usually the one just saved in the editor.
 *
 * Blocks are matched by id. The rule is simple:
 *  - blocks the run has already passed keep their results and do not run again
 *  - the block the run is at, and everything after it, come from the new definition
 *
 * So a block added before the run's position never runs in this run, and a
 * change to a finished block only affects later runs (or this one, if a
 * condition or a rejected approval sends the run back to it).
 *
 * Nothing here touches the database: `planApply` is a pure function, which
 * keeps it easy to test and lets the UI show the plan before it is applied.
 */
import type { StepConfig, WorkflowDefinition } from '../types.js';

/** How one block differs between the run's definition and the new one. */
export type BlockChangeKind = 'added' | 'removed' | 'changed';

export interface BlockChange {
  id: string;
  name: string;
  kind: BlockChangeKind;
  /**
   * `ahead`: the run has not got there yet, so the change takes effect.
   * `behind`: the run already passed this place, so this run is not affected.
   */
  where: 'ahead' | 'behind';
}

export interface ApplyPlan {
  /** True when the new definition is the one the run already uses. */
  upToDate: boolean;
  blocks: BlockChange[];
  /** Other parts of the definition that differ, e.g. `environment`. */
  sections: string[];
  /** Id of the block the run continues with, or null when no block is left. */
  continueAt: string | null;
  /** Its name, for people. */
  continueName: string | null;
  /** Index of that block in the new definition (equal to its length when no block is left). */
  continueIndex: number;
  /** True when the block the run is at was removed, so the run moves on to another one. */
  currentRemoved: boolean;
}

const SECTIONS = ['triggers', 'inputs', 'environment', 'notifications'] as const;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const label = (step: StepConfig) => step.name || step.id;

/**
 * Where a run at `position` of `oldSteps` continues in `newSteps`:
 *  1. the block it is at, if it still exists
 *  2. otherwise the next later block that still exists
 *  3. otherwise right after the last earlier block that still exists
 *  4. otherwise at the start of the new definition
 */
export function mapPosition(oldSteps: StepConfig[], newSteps: StepConfig[], position: number): number {
  const indexIn = (id: string) => newSteps.findIndex((step) => step.id === id);
  for (const step of oldSteps.slice(position)) {
    const found = indexIn(step.id);
    if (found !== -1) return found;
  }
  for (const step of oldSteps.slice(0, position).reverse()) {
    const found = indexIn(step.id);
    if (found !== -1) return found + 1;
  }
  return 0;
}

/** Describes switching a run at `position` (its `stepIndex`) from `current` to `next`. */
export function planApply(current: WorkflowDefinition, next: WorkflowDefinition, position: number): ApplyPlan {
  const continueIndex = mapPosition(current.steps, next.steps, position);
  const oldById = new Map(current.steps.map((step, index) => [step.id, { step, index }]));
  const newIds = new Set(next.steps.map((step) => step.id));
  const blocks: BlockChange[] = [];

  next.steps.forEach((step, index) => {
    const before = oldById.get(step.id);
    const where = index >= continueIndex ? 'ahead' : 'behind';
    if (!before) blocks.push({ id: step.id, name: label(step), kind: 'added', where });
    else if (!same(before.step, step)) blocks.push({ id: step.id, name: label(step), kind: 'changed', where });
  });
  for (const { step, index } of oldById.values()) {
    if (!newIds.has(step.id)) blocks.push({ id: step.id, name: label(step), kind: 'removed', where: index >= position ? 'ahead' : 'behind' });
  }

  const sections = SECTIONS.filter((section) => !same(current[section], next[section]));
  const currentStep = current.steps[position];
  return {
    upToDate: same(current, next),
    blocks,
    sections,
    continueAt: next.steps[continueIndex]?.id ?? null,
    continueName: next.steps[continueIndex] ? label(next.steps[continueIndex]) : null,
    continueIndex,
    currentRemoved: currentStep !== undefined && !newIds.has(currentStep.id),
  };
}
