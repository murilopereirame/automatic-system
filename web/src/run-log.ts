/**
 * The part of a run's log the run page keeps in memory, and how it changes.
 * Plain functions without React, so they can be tested on their own (see web/test/run-log.test.ts).
 *
 * The page never holds the whole log: it starts with the newest page from the server,
 * appends live events in batches, drops the oldest ones past a limit, and loads older
 * pages only when asked. See docs/UI.md, "How the run page stays light".
 */
import type { RunEvent } from './api.ts';

/** Events kept in memory while a run is live. Older ones are dropped and can be loaded again. */
export const MAX_KEPT_EVENTS = 2000;

/** Characters of a single text shown before the rest is hidden behind "Show all". */
export const TEXT_PREVIEW_CHARS = 20_000;

export interface LogWindow {
  /** Oldest first, ids strictly increasing. */
  events: RunEvent[];
  /** The server has events before the first one here. */
  hasOlder: boolean;
  /** How many events to keep. Grows when the person loads older pages, so those are not dropped right away. */
  limit: number;
}

export const emptyWindow = (): LogWindow => ({ events: [], hasOlder: false, limit: MAX_KEPT_EVENTS });

/**
 * Adds live events to the end. Ignores events already known (ids not past the last one) and,
 * when `stepId` is set, events of other blocks. Drops the oldest events past the limit.
 */
export function appendEvents(window: LogWindow, incoming: RunEvent[], stepId?: string): LogWindow {
  let lastId = window.events[window.events.length - 1]?.id ?? 0;
  const fresh: RunEvent[] = [];
  for (const event of incoming) {
    if (event.id <= lastId || (stepId && event.stepId !== stepId)) continue;
    fresh.push(event);
    lastId = event.id;
  }
  if (fresh.length === 0) return window;
  const events = window.events.concat(fresh);
  const overflow = events.length - window.limit;
  if (overflow <= 0) return { ...window, events };
  return { ...window, events: events.slice(overflow), hasOlder: true };
}

/** Puts an older page in front, as loaded with "Load older activity". */
export function prependOlder(window: LogWindow, page: { events: RunEvent[]; hasOlder: boolean }): LogWindow {
  const firstId = window.events[0]?.id ?? Infinity;
  const older = page.events.filter((event) => event.id < firstId);
  const events = older.concat(window.events);
  // Room for another MAX_KEPT_EVENTS live events before the loaded ones would be dropped again.
  return { events, hasOlder: page.hasOlder, limit: events.length + MAX_KEPT_EVENTS };
}

/** Joins consecutive output chunks of the same block into one entry, so logs read as text instead of fragments. */
export function mergeOutput(events: RunEvent[]): RunEvent[] {
  const merged: RunEvent[] = [];
  // Collect the chunks of a group and join them once, instead of re-concatenating the growing text per chunk.
  let chunks: string[] = [];
  const flush = () => {
    const last = merged[merged.length - 1];
    if (chunks.length > 1) merged[merged.length - 1] = { ...last, data: { ...last.data, text: chunks.join('') } };
    chunks = [];
  };
  for (const event of events) {
    const previous = merged[merged.length - 1];
    if (event.type === 'output' && previous?.type === 'output' && previous.stepId === event.stepId) {
      chunks.push(String(event.data.text ?? ''));
      continue;
    }
    flush();
    merged.push(event);
    if (event.type === 'output') chunks = [String(event.data.text ?? '')];
  }
  flush();
  return merged;
}

/**
 * Shortens a long text to `limit` characters, keeping its start (`keep: 'start'`) or,
 * for command output where the latest lines matter most, its end.
 */
export function clipText(text: string, limit: number, keep: 'start' | 'end'): { shown: string; hidden: number } {
  if (text.length <= limit) return { shown: text, hidden: 0 };
  return { shown: keep === 'start' ? text.slice(0, limit) : text.slice(text.length - limit), hidden: text.length - limit };
}
