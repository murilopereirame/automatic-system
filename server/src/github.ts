/** The few GitHub REST calls the app needs. */
import { config } from './config.js';

async function githubRequest<T>(token: string, method: string, route: string, body?: unknown): Promise<T> {
  const response = await fetch(`${config.githubApiUrl}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'autoworker',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = (await response.json().catch(() => ({}))) as any;
  if (!response.ok) {
    const details = (payload.errors ?? []).map((error: any) => error.message).filter(Boolean).join('; ');
    throw new Error(`GitHub ${method} ${route} failed (${response.status}): ${payload.message ?? ''} ${details}`.trim());
  }
  return payload as T;
}

export interface GithubUser {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
}

/** The owner of the token. Commits and the pull request are made in this user's name. */
export function getAuthenticatedUser(token: string): Promise<GithubUser> {
  return githubRequest<GithubUser>(token, 'GET', '/user');
}

export interface PullRequestInput {
  owner: string;
  repo: string;
  title: string;
  body: string;
  head: string;
  base: string;
  draft: boolean;
}

export function createPullRequest(token: string, input: PullRequestInput): Promise<{ number: number; html_url: string }> {
  const { owner, repo, ...body } = input;
  return githubRequest(token, 'POST', `/repos/${owner}/${repo}/pulls`, body);
}
