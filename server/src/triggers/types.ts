import type { FieldSpec, Workflow } from '../types.js';

/** Starts a run. `dedupeKey` makes sure the same external item starts a run only once per workflow. */
export type Fire = (payload: Record<string, unknown>, dedupeKey?: string) => void;

export interface WebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string | undefined>;
  rawBody: string;
  body: unknown;
}

/**
 * A trigger type. A trigger can be active (it implements `start`, e.g. to
 * poll an API), passive (it implements `handleWebhook`), or both.
 */
export interface TriggerType {
  type: string;
  title: string;
  description: string;
  fields: FieldSpec[];
  /** Begins watching for events. Returns a function that stops watching. */
  start?(workflow: Workflow, fire: Fire): () => void;
  /** Handles a call to `/hooks/<workflow id>`. Throws HttpError to reject the caller. */
  handleWebhook?(workflow: Workflow, request: WebhookRequest, fire: Fire): Promise<void> | void;
}
