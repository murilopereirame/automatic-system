import path from 'node:path';
import { addTaskComment, downloadAttachment, getTask } from '../clickup.js';
import { errorMessage } from '../errors.js';
import { agentWriteFile } from '../sandbox/agent.js';
import { requireSecret } from '../store/secrets.js';
import { flag, text, type StepType } from './types.js';

const tokenField = { key: 'tokenSecret', label: 'ClickUp token secret', type: 'secret', default: 'CLICKUP_TOKEN' } as const;
const taskField = { key: 'taskId', label: 'Task id', type: 'text', default: '{{trigger.task.id}}' } as const;

export const clickupFetchTaskStep: StepType = {
  type: 'clickup_fetch_task',
  title: 'Fetch ClickUp task',
  description: 'Loads a ClickUp task: name, description, status and link, and optionally its comments, subtasks and attachments.',
  fields: [
    taskField,
    { key: 'includeComments', label: 'Include comments', type: 'boolean', default: true },
    { key: 'includeSubtasks', label: 'Include subtasks', type: 'boolean', default: true },
    {
      key: 'downloadAttachments',
      label: 'Download attachments into the workspace',
      type: 'boolean',
      default: true,
      help: 'Files are saved next to the repository, in the task-attachments folder of the run workspace. Their paths are in {{steps.<id>.output.attachmentFiles}}.',
    },
    tokenField,
  ],
  async execute({ params, log, run }) {
    const token = requireSecret(text(params, 'tokenSecret', 'CLICKUP_TOKEN'));
    const task = await getTask(token, text(params, 'taskId'), {
      comments: flag(params, 'includeComments', true),
      subtasks: flag(params, 'includeSubtasks', true),
    });
    log('log', { message: `Fetched ClickUp task "${task.name}" (${task.url})` });

    // Saved outside the cloned repository, so attachments are never committed by accident.
    const attachmentFiles: string[] = [];
    if (flag(params, 'downloadAttachments', true)) {
      for (const [index, attachment] of task.attachments.entries()) {
        const file = path.join(run.workspace, 'task-attachments', `${index + 1}-${path.basename(attachment.title)}`);
        try {
          await agentWriteFile(file, await downloadAttachment(attachment.url));
          attachmentFiles.push(file);
        } catch (error) {
          log('log', { message: `Attachment "${attachment.title}" was not downloaded: ${errorMessage(error)}` });
        }
      }
      if (attachmentFiles.length > 0) log('log', { message: `Downloaded ${attachmentFiles.length} attachment(s)` });
    }
    return { output: { ...task, attachmentFiles } };
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
