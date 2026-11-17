import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunEvent } from '../src/api.ts';
import { appendEvents, clipText, emptyWindow, mergeOutput, prependOlder } from '../src/run-log.ts';

const event = (id: number, type = 'log', stepId: string | null = 'a', data: Record<string, unknown> = {}): RunEvent => ({
  id,
  runId: 'run',
  stepId,
  type,
  data,
  createdAt: '2026-11-17T00:00:00Z',
});
const ids = (events: RunEvent[]) => events.map((item) => item.id);

test('live events are appended once, in order, and only for the shown block', () => {
  let window = appendEvents(emptyWindow(), [event(1), event(2)]);
  window = appendEvents(window, [event(2), event(3, 'log', 'b'), event(4)], 'a');
  assert.deepEqual(ids(window.events), [1, 2, 4]);
  assert.equal(appendEvents(window, [event(4)]), window, 'nothing new keeps the same window, so React skips the render');
});

test('the oldest events are dropped past the limit and can be loaded again', () => {
  let window = { ...emptyWindow(), limit: 3 };
  window = appendEvents(window, [event(1), event(2), event(3), event(4), event(5)]);
  assert.deepEqual(ids(window.events), [3, 4, 5]);
  assert.equal(window.hasOlder, true);

  window = prependOlder(window, { events: [event(1), event(2), event(3)], hasOlder: false });
  assert.deepEqual(ids(window.events), [1, 2, 3, 4, 5], 'the overlap is not duplicated');
  assert.equal(window.hasOlder, false);

  window = appendEvents(window, [event(6)]);
  assert.deepEqual(ids(window.events), [1, 2, 3, 4, 5, 6], 'what the person loaded on purpose is not dropped right away');
});

test('consecutive output of one block is merged into one entry', () => {
  const merged = mergeOutput([
    event(1, 'output', 'a', { text: 'one\n' }),
    event(2, 'output', 'a', { text: 'two\n' }),
    event(3, 'output', 'b', { text: 'other\n' }),
    event(4, 'log', 'b', { message: 'hi' }),
    event(5, 'output', 'b', { text: 'three' }),
  ]);
  assert.deepEqual(ids(merged), [1, 3, 4, 5]);
  assert.equal(merged[0].data.text, 'one\ntwo\n');
  assert.equal(merged[1].data.text, 'other\n');
});

test('long texts are clipped at the start or the end', () => {
  assert.deepEqual(clipText('short', 10, 'start'), { shown: 'short', hidden: 0 });
  assert.deepEqual(clipText('abcdefgh', 3, 'start'), { shown: 'abc', hidden: 5 });
  assert.deepEqual(clipText('abcdefgh', 3, 'end'), { shown: 'fgh', hidden: 5 });
});
