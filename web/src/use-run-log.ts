/**
 * The live log of one run (or one block of it) for the run page.
 *
 * - Loads only the newest page from the server; older pages on request.
 * - Live events are collected and applied together every FLUSH_MS, so a chatty
 *   Claude block causes a few renders a second instead of one per line.
 * - Keeps at most MAX_KEPT_EVENTS events (see run-log.ts).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type RunEvent } from './api.ts';
import { useLive } from './live.ts';
import { appendEvents, emptyWindow, prependOlder, type LogWindow } from './run-log.ts';

/** How long live events are collected before the log re-renders. */
const FLUSH_MS = 250;

export interface RunLog {
  log: LogWindow;
  loading: boolean;
  error?: string;
  loadOlder: () => void;
}

export function useRunLog(runId: string, stepId?: string): RunLog {
  const [log, setLog] = useState<LogWindow>(emptyWindow);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  // Live events not rendered yet. Until the first page has arrived they wait here, so none is lost.
  const buffered = useRef<RunEvent[]>([]);
  const loaded = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const flush = useCallback(() => {
    timer.current = undefined;
    if (!loaded.current || buffered.current.length === 0) return;
    const incoming = buffered.current;
    buffered.current = [];
    setLog((current) => appendEvents(current, incoming, stepId));
  }, [stepId]);

  useEffect(() => {
    let current = true;
    loaded.current = false;
    buffered.current = [];
    setLog(emptyWindow());
    setLoading(true);
    api.runEvents(runId, { stepId }).then(
      (page) => {
        if (!current) return;
        loaded.current = true;
        setLog(appendEvents({ ...emptyWindow(), hasOlder: page.hasOlder }, page.events));
        setLoading(false);
        flush();
      },
      (reason: Error) => current && (setError(reason.message), setLoading(false)),
    );
    return () => {
      current = false;
      clearTimeout(timer.current);
      timer.current = undefined;
    };
  }, [runId, stepId, flush]);

  useLive({
    onEvent: (event) => {
      if (event.runId !== runId || (stepId && event.stepId !== stepId)) return;
      buffered.current.push(event);
      timer.current ??= setTimeout(flush, FLUSH_MS);
    },
  });

  const loadOlder = () => {
    const first = log.events[0];
    if (!first) return;
    api.runEvents(runId, { stepId, before: first.id }).then(
      (page) => setLog((current) => prependOlder(current, page)),
      (reason: Error) => setError(reason.message),
    );
  };

  return { log, loading, error, loadOlder };
}
