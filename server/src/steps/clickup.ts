import path from 'node:path';
import { addTaskComment, downloadAttachment, getTask, type ClickupComment } from '../clickup.js';
import { errorMessage } from '../errors.js';
import { agentWriteFile } from '../sandbox/agent.js';
import { requireSecret } from '../store/secrets.js';
import { flag, text, type StepType } from './types.js';

/** A comment as later blocks see it: `files` are the paths of its downloaded images and files (their names, when not downloaded). */
type CommentOutput = Omit<ClickupComment, 'attachments' | 'replies'> & { files: string[]; replies?: CommentOutput[] };

const tokenField = { key: 'tokenSecret', label: 'ClickUp token secret', type: 'secret', default: 'CLICKUP_TOKEN' } as const;
const taskField = { key: 'taskId', label: 'Task id', type: 'text', default: '{{trigger.task.id}}' } as const;

export const clickupFetchTaskStep: StepType = {
  type: 'clickup_fetch_task',
  title: 'Fetch ClickUp task',
  description: 'Loads a ClickUp task: name, description, status and link, and optionally its comments (with their threads), subtasks and attachments.',
  fields: [
    taskField,
    { key: 'includeComments', label: 'Include comments', type: 'boolean', default: true },
    { key: 'includeSubtasks', label: 'Include subtasks', type: 'boolean', default: true },
    {
      key: 'downloadAttachments',
      label: 'Download attachments into the workspace',
      type: 'boolean',
      default: true,
      help: 'Files are saved next to the repository, in the task-attachments folder of the run workspace. Their paths are in {{steps.<id>.output.attachmentFiles}}, and each comment lists the images and files pasted into it as files.',
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
    // Files pasted into comments are saved too, and each comment lists its own as `files`.
    const attachmentFiles: string[] = [];
    const saved = new Map<string, string>();
    const save = async (attachment: { title: string; url: string }): Promise<string | undefined> => {
      if (saved.has(attachment.url)) return saved.get(attachment.url);
      const file = path.join(run.workspace, 'task-attachments', `${saved.size + 1}-${path.basename(attachment.title)}`);
      try {
        await agentWriteFile(file, await downloadAttachment(attachment.url));
        saved.set(attachment.url, file);
        return file;
      } catch (error) {
        log('log', { message: `Attachment "${attachment.title}" was not downloaded: ${errorMessage(error)}` });
        return undefined;
      }
    };
    const download = flag(params, 'downloadAttachments', true);
    if (download) {
      for (const attachment of task.attachments) {
        const file = await save(attachment);
        if (file) attachmentFiles.push(file);
      }
    }
    const withFiles = async ({ attachments, replies, ...comment }: ClickupComment): Promise<CommentOutput> => {
      const files: string[] = [];
      for (const attachment of download ? attachments : []) {
        const file = await save(attachment);
        if (file) files.push(file);
      }
      const output: CommentOutput = { ...comment, files: download ? files : attachments.map((attachment) => attachment.title) };
      if (replies) output.replies = await Promise.all(replies.map(withFiles));
      return output;
    };
    const comments = task.comments ? await Promise.all(task.comments.map(withFiles)) : undefined;
    if (saved.size > 0) log('log', { message: `Downloaded ${saved.size} attachment(s)` });
    return { output: { ...task, ...(comments ? { comments } : {}), attachmentFiles } };
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
