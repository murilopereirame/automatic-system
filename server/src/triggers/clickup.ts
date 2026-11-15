/**
 * ClickUp trigger: starts a run when a task is assigned to a user.
 *
 * Two modes:
 *  - poll (default): asks ClickUp for the user's tasks at an interval. Works
 *    behind a firewall because only outgoing requests are needed.
 *  - webhook: ClickUp calls `/hooks/<workflow id>`. Instant, but the app must
 *    be reachable from the internet.
 */
import { createHmac } from 'node:crypto';
import { getCurrentUserId, getFirstTeamId, getTask, listAssignedTasks, type ClickupTask } from '../clickup.js';
import { errorMessage, HttpError } from '../errors.js';
import { getSecret, requireSecret } from '../store/secrets.js';
import { hasSeenAnything, markSeen } from '../store/workflows.js';
import type { Workflow } from '../types.js';
import type { Fire, TriggerType } from './types.js';
import { safeEqual } from './webhook.js';

interface Settings {
  mode: string;
  token: () => string;
  teamId: string;
  assigneeId: string;
  pollSeconds: number;
  includeExisting: boolean;
  webhookSecret: string;
}

function readSettings(workflow: Workflow): Settings {
  const raw = workflow.definition.trigger.with;
  const value = (key: string, fallback: string) => (raw[key] === undefined || raw[key] === '' ? fallback : String(raw[key]));
  return {
    mode: value('mode', 'poll'),
    token: () => requireSecret(value('tokenSecret', 'CLICKUP_TOKEN')),
    teamId: value('teamId', ''),
    assigneeId: value('assigneeId', ''),
    pollSeconds: Math.max(15, Number(value('pollSeconds', '60'))),
    includeExisting: raw.includeExisting === true,
    webhookSecret: value('webhookSecret', 'CLICKUP_WEBHOOK_SECRET'),
  };
}

function taskPayload(task: ClickupTask): Record<string, unknown> {
  return { source: 'clickup', task };
}

/**
 * One polling pass. Tasks that are already assigned when the workflow is first
 * enabled only start runs when "includeExisting" is on, so enabling a workflow
 * does not flood the queue with old work.
 */
export async function pollOnce(workflow: Workflow, fire: Fire): Promise<void> {
  const settings = readSettings(workflow);
  const token = settings.token();
  const assigneeId = settings.assigneeId || (await getCurrentUserId(token));
  const teamId = settings.teamId || (await getFirstTeamId(token));
  const tasks = await listAssignedTasks(token, teamId, assigneeId);

  const firstPoll = !hasSeenAnything(workflow.id);
  markSeen(workflow.id, 'baseline');
  for (const task of tasks) {
    if (firstPoll && !settings.includeExisting) markSeen(workflow.id, `task:${task.id}`);
    else fire(taskPayload(task), `task:${task.id}`);
  }
}

export const clickupTrigger: TriggerType = {
  type: 'clickup',
  title: 'ClickUp task assigned',
  description: 'Starts a run when a ClickUp task is assigned to you. The task is available as {{trigger.task.id}}, .name, .description and .url.',
  fields: [
    { key: 'mode', label: 'Mode', type: 'select', options: ['poll', 'webhook'], default: 'poll', help: 'Poll needs no inbound access. Webhook is instant but ClickUp must be able to reach this app.' },
    { key: 'tokenSecret', label: 'ClickUp token secret', type: 'secret', default: 'CLICKUP_TOKEN' },
    { key: 'assigneeId', label: 'Assignee user id', type: 'text', placeholder: 'The owner of the token' },
    { key: 'teamId', label: 'Workspace (team) id', type: 'text', placeholder: 'First workspace of the token' },
    { key: 'pollSeconds', label: 'Poll interval in seconds', type: 'number', default: 60 },
    { key: 'includeExisting', label: 'Also run for tasks that are already assigned', type: 'boolean', default: false },
    { key: 'webhookSecret', label: 'Webhook signing secret', type: 'secret', default: 'CLICKUP_WEBHOOK_SECRET', help: 'Webhook mode only: the secret ClickUp returned when the webhook was created.' },
  ],

  start(workflow, fire) {
    const settings = readSettings(workflow);
    if (settings.mode !== 'poll') return () => {};

    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    const tick = async () => {
      try {
        await pollOnce(workflow, fire);
      } catch (error) {
        console.warn(`ClickUp poll for "${workflow.name}" failed: ${errorMessage(error)}`);
      }
      if (!stopped) timer = setTimeout(tick, settings.pollSeconds * 1000);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  },

  async handleWebhook(workflow, request, fire) {
    const settings = readSettings(workflow);
    const signingSecret = getSecret(settings.webhookSecret);
    if (!signingSecret) throw new HttpError(401, `Secret "${settings.webhookSecret}" is not set`);
    const expected = createHmac('sha256', signingSecret).update(request.rawBody).digest('hex');
    if (!safeEqual(String(request.headers['x-signature'] ?? ''), expected)) throw new HttpError(401, 'Wrong signature');

    const event = request.body as { event?: string; task_id?: string };
    if (!event.task_id || !['taskAssigneeUpdated', 'taskCreated'].includes(event.event ?? '')) return;

    // The webhook body does not say who the task is assigned to now, so ask ClickUp.
    const token = settings.token();
    const assigneeId = settings.assigneeId || (await getCurrentUserId(token));
    const task = await getTask(token, event.task_id);
    if (task.assignees.some((assignee) => String(assignee.id) === assigneeId)) fire(taskPayload(task), `task:${task.id}`);
  },
};
