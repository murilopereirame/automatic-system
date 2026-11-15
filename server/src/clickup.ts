/** The few ClickUp REST calls the app needs. */
import { config } from './config.js';

export interface ClickupTask {
  id: string;
  name: string;
  description: string;
  url: string;
  status: string;
  assignees: { id: number; username: string }[];
}

async function clickupRequest<T>(token: string, method: string, route: string, body?: unknown): Promise<T> {
  const response = await fetch(`${config.clickupApiUrl}${route}`, {
    method,
    headers: { Authorization: token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = (await response.json().catch(() => ({}))) as any;
  if (!response.ok) throw new Error(`ClickUp ${method} ${route} failed (${response.status}): ${payload.err ?? ''}`.trim());
  return payload as T;
}

function toTask(raw: any): ClickupTask {
  return {
    id: String(raw.id),
    name: raw.name ?? '',
    description: raw.markdown_description ?? raw.text_content ?? raw.description ?? '',
    url: raw.url ?? `https://app.clickup.com/t/${raw.id}`,
    status: raw.status?.status ?? '',
    assignees: (raw.assignees ?? []).map((assignee: any) => ({ id: assignee.id, username: assignee.username })),
  };
}

export async function getCurrentUserId(token: string): Promise<string> {
  const { user } = await clickupRequest<{ user: { id: number } }>(token, 'GET', '/user');
  return String(user.id);
}

export async function getFirstTeamId(token: string): Promise<string> {
  const { teams } = await clickupRequest<{ teams: { id: string }[] }>(token, 'GET', '/team');
  if (teams.length === 0) throw new Error('The ClickUp token has no workspace');
  return teams[0].id;
}

export async function getTask(token: string, taskId: string): Promise<ClickupTask> {
  return toTask(await clickupRequest(token, 'GET', `/task/${encodeURIComponent(taskId)}?include_markdown_description=true`));
}

/** Open tasks assigned to a user, most recently updated first (first page, up to 100 tasks). */
export async function listAssignedTasks(token: string, teamId: string, assigneeId: string): Promise<ClickupTask[]> {
  const query = `assignees[]=${encodeURIComponent(assigneeId)}&subtasks=true&order_by=updated&include_markdown_description=true`;
  const { tasks } = await clickupRequest<{ tasks: unknown[] }>(token, 'GET', `/team/${teamId}/task?${query}`);
  return tasks.map(toTask);
}

export async function addTaskComment(token: string, taskId: string, comment: string): Promise<void> {
  await clickupRequest(token, 'POST', `/task/${encodeURIComponent(taskId)}/comment`, { comment_text: comment });
}
