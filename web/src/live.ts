/**
 * Live updates. One server-sent-events connection is shared by the whole app;
 * components subscribe to the kinds of update they care about.
 */
import { useEffect, useRef } from 'react';
import type { Run, RunEvent } from './api.ts';

interface Listener {
  onRun?: (run: Run) => void;
  onEvent?: (event: RunEvent) => void;
}

const listeners = new Set<Listener>();
let source: EventSource | undefined;

function connect(): void {
  if (source) return;
  source = new EventSource('/api/stream');
  source.addEventListener('run', (message) => {
    const run = JSON.parse((message as MessageEvent).data) as Run;
    listeners.forEach((listener) => listener.onRun?.(run));
  });
  source.addEventListener('event', (message) => {
    const event = JSON.parse((message as MessageEvent).data) as RunEvent;
    listeners.forEach((listener) => listener.onEvent?.(event));
  });
}

function disconnect(): void {
  source?.close();
  source = undefined;
}

/** Subscribes the calling component for as long as it is mounted. */
export function useLive(listener: Listener): void {
  // Keep the latest callbacks without re-subscribing on every render.
  const latest = useRef(listener);
  latest.current = listener;

  useEffect(() => {
    const stable: Listener = {
      onRun: (run) => latest.current.onRun?.(run),
      onEvent: (event) => latest.current.onEvent?.(event),
    };
    listeners.add(stable);
    connect();
    return () => {
      listeners.delete(stable);
      if (listeners.size === 0) disconnect();
    };
  }, []);
}
