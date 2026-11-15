import { addTaskComment, getTask } from '../clickup.js';
import { requireSecret } from '../store/secrets.js';
import { text, type StepType } from './types.js';

const tokenField = { key: 'tokenSecret', label: 'ClickUp token secret', type: 'secret', default: 'CLICKUP_TOKEN' } as const;
const taskField = { key: 'taskId', label: 'Task id', type: 'text', default: '{{trigger.task.id}}' } as const;

export const clickupFetchTaskStep: StepType = {
  type: 'clickup_fetch_task',
  title: 'Fetch ClickUp task',
  description: 'Loads the latest name, description, status and link of a ClickUp task.',
  fields: [taskField, tokenField],
  async execute({ params, log }) {
    const task = await getTask(requireSecret(text(params, 'tokenSecret', 'CLICKUP_TOKEN')), text(params, 'taskId'));
    log('log', { message: `Fetched ClickUp task "${task.name}" (${task.url})` });
    return { output: task };
  },
};

export const clickupCommentStep: StepType = {
  type: 'clickup_comment',
  title: 'Comment on ClickUp task',
  description: 'Posts a comment on a ClickUp task, e.g. the link to the pull request.',
  fields: [taskField, { key: 'comment', label: 'Comment', type: 'textarea', default: 'Pull request: {{steps.pull_request.output.url}}' }, tokenField],
  async execute({ params }) {
    const comment = text(params, 'comment');
    await addTaskComment(requireSecret(text(params, 'tokenSecret', 'CLICKUP_TOKEN')), text(params, 'taskId'), comment);
    return { output: { comment } };
  },
};
