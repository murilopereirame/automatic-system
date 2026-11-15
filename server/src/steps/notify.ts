import { sendNotification } from '../notify.js';
import { text, type StepType } from './types.js';

export const notifyStep: StepType = {
  type: 'notify',
  title: 'Send notification',
  description: 'Calls the notification webhooks of this workflow with a message.',
  fields: [
    { key: 'message', label: 'Message', type: 'textarea', default: 'Run started for {{trigger.task.name}}' },
    { key: 'channel', label: 'Webhook', type: 'text', help: 'Name of one notification webhook. Leave empty to call all of them.' },
  ],
  async execute({ params, run, log }) {
    const message = text(params, 'message');
    const delivered = await sendNotification(run, { title: run.workflowName, message, channel: text(params, 'channel') || undefined });
    log('notification', { message, delivered });
    return { output: { message, delivered } };
  },
};
