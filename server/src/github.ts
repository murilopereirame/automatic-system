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

export function createPullRequest(token: string, input: PullRequestInput): Promise<PullRequest> {
  const { owner, repo, ...body } = input;
  return githubRequest(token, 'POST', `/repos/${owner}/${repo}/pulls`, body);
}

export interface PullRequest {
  number: number;
  html_url: string;
  node_id: string;
  draft?: boolean;
}

/** The open pull request from `head` (a branch of the same repository), if there is one. */
export async function findOpenPullRequest(token: string, owner: string, repo: string, head: string): Promise<PullRequest | undefined> {
  const query = new URLSearchParams({ head: `${owner}:${head}`, state: 'open' });
  const found = await githubRequest<PullRequest[]>(token, 'GET', `/repos/${owner}/${repo}/pulls?${query}`);
  return Array.isArray(found) ? found[0] : undefined;
}

export function updatePullRequest(token: string, owner: string, repo: string, number: number, changes: { title?: string; body?: string }): Promise<PullRequest> {
  return githubRequest(token, 'PATCH', `/repos/${owner}/${repo}/pulls/${number}`, changes);
}

/** A draft can only be turned into a ready pull request through the GraphQL API. */
export async function markPullRequestReady(token: string, pullRequestNodeId: string): Promise<void> {
  const result = await githubRequest<{ errors?: { message: string }[] }>(token, 'POST', '/graphql', {
    query: 'mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }',
    variables: { id: pullRequestNodeId },
  });
  if (result.errors?.length) throw new Error(`GitHub could not mark the pull request ready: ${result.errors.map((error) => error.message).join('; ')}`);
}
