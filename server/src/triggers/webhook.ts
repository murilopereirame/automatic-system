import { timingSafeEqual } from 'node:crypto';
import { HttpError } from '../errors.js';
import type { TriggerType } from './types.js';

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Any system that can send an HTTP POST can start a run. The JSON body becomes `{{trigger...}}`. */
export const webhookTrigger: TriggerType = {
  type: 'webhook',
  title: 'Webhook',
  description: 'Starts a run when the workflow URL receives a POST request. The JSON body is available as {{trigger...}}.',
  fields: [],
  handleWebhook(workflow, request, fire) {
    const presented = request.query.secret ?? String(request.headers['x-autoworker-secret'] ?? '');
    if (!safeEqual(presented, workflow.hookSecret)) throw new HttpError(401, 'Wrong webhook secret');
    const body = request.body !== null && typeof request.body === 'object' ? (request.body as Record<string, unknown>) : { body: request.body };
    fire(body);
  },
};
