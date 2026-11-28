/** What the run page derives from a run (web/src/run-view/run-steps.ts): block states, durations and log sections. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Run, RunEvent, StepConfig } from '../src/api.ts';
import { formatDuration, progress, runDuration, sectionsOf, stepDuration, stepState } from '../src/run-view/run-steps.ts';

const step = (id: string): StepConfig => ({ id, type: 'shell', name: id, with: {} });

function runWith(overrides: Partial<Run> = {}): Run {
  return {
    id: 'r1',
    workflowId: 'w1',
    workflowName: 'Test',
    status: 'running',
    stepIndex: 2,
    definition: { triggers: [], environment: {} as Run['definition']['environment'], notifications: [], steps: [step('a'), step('b'), step('c'), step('d')] },
    context: { trigger: {}, steps: { a: { output: 1 }, b: { output: null, skipped: true } } },
    workspace: '/tmp/w',
    createdAt: '2026-01-01T10:00:00.000Z',
    updatedAt: '2026-01-01T10:05:00.000Z',
    ...overrides,
  };
}

let nextId = 1;
const event = (stepId: string | null, type: string, createdAt = '2026-01-01T10:00:00.000Z'): RunEvent => ({ id: nextId++, runId: 'r1', stepId, type, data: {}, createdAt });

test('blocks before the current one are done or skipped, the current one mirrors the run, later ones are pending', () => {
  const run = runWith();
  assert.deepEqual([0, 1, 2, 3].map((index) => stepState(run, index)), ['done', 'skipped', 'running', 'pending']);
  assert.deepEqual(progress(run), { passed: 2, total: 4 });
  const done = runWith({ status: 'succeeded', stepIndex: 4, context: { trigger: {}, steps: { a: { output: 1 }, b: { output: 1 }, c: { output: 1 }, d: { output: 1 } } } });
  assert.deepEqual(progress(done), { passed: 4, total: 4 });
});

test('durations come from the recorded timing, and count up while a block is open', () => {
  const run = runWith({
    context: {
      trigger: {},
      steps: {},
      timing: {
        a: { startedAt: '2026-01-01T10:00:00.000Z', endedAt: '2026-01-01T10:00:42.000Z', attempts: 1 },
        c: { startedAt: '2026-01-01T10:01:00.000Z', attempts: 2 },
      },
    },
  });
  const now = Date.parse('2026-01-01T10:04:05.000Z');
  assert.equal(stepDuration(run, step('a'), now), 42_000);
  assert.equal(stepDuration(run, step('c'), now), 185_000);
  assert.equal(stepDuration(run, step('d'), now), undefined, 'a block that never started has no duration');
  assert.equal(runDuration(run, now), 245_000, 'an open run counts until now');
  assert.equal(runDuration({ ...run, status: 'failed' }, now), 300_000, 'an ended run counts until its last update');
});

test('formats durations compactly', () => {
  assert.equal(formatDuration(400), '<1s');
  assert.equal(formatDuration(42_000), '42s');
  assert.equal(formatDuration(185_000), '3m 05s');
  assert.equal(formatDuration(4_320_000), '1h 12m');
});

test('splits the log into a section per block, with a new one each time a block starts again', () => {
  const events = [
    event(null, 'triggered'),
    event('a', 'step_started', '2026-01-01T10:00:01.000Z'),
    event('a', 'command'),
    event('a', 'step_finished'),
    event('b', 'step_started'),
    event('b', 'step_finished'),
    event('a', 'step_started', '2026-01-01T10:02:00.000Z'),
    event('a', 'output'),
    event(null, 'run_finished'),
  ];
  const sections = sectionsOf(events);
  assert.deepEqual(
    sections.map((section) => [section.stepId, section.events.map((entry) => entry.type)]),
    [
      [null, ['triggered']],
      ['a', ['command', 'step_finished']],
      ['b', ['step_finished']],
      ['a', ['output']],
      [null, ['run_finished']],
    ],
  );
  assert.equal(sections[1].at, '2026-01-01T10:00:01.000Z', 'a section starts when its block started');
  assert.equal(sections[3].at, '2026-01-01T10:02:00.000Z');
});

test('a log page that begins in the middle of a block still gets a section for it', () => {
  const sections = sectionsOf([event('c', 'output'), event('c', 'step_finished')]);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].events.length, 2);
});
