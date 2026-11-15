import type { TriggerType } from './types.js';

/** Runs only start from the "Run now" button or `POST /api/workflows/:id/run`. */
export const manualTrigger: TriggerType = {
  type: 'manual',
  title: 'Manual',
  description: 'Runs start only when you press "Run now" in the UI.',
  fields: [],
};
