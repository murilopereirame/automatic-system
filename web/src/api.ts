/** Typed access to the server API. The domain types are shared with the server. */
import type { Approval, FieldSpec, Run, RunEvent, Settings, Workflow, WorkflowDefinition, WorkflowVersion } from '../../server/src/types.ts';
import type { Diff } from '../../server/src/diff.ts';

export type { Diff, DiffLine } from '../../server/src/diff.ts';

export type * from '../../server/src/types.ts';

export interface BlockType {
  type: string;
  title: string;
  description: string;
  fields: FieldSpec[];
}

export interface Meta {
  stepTypes: BlockType[];
  triggerTypes: BlockType[];
}

/** What the editor sends when saving a workflow. */
export interface WorkflowDraft {
  name: string;
  description: string;
  enabled: boolean;
  definition: WorkflowDefinition;
}

/** A row of the version history: a version without its definition, and how many runs used it. */
export type VersionSummary = Omit<WorkflowVersion, 'definition'> & { runs: number };

export interface VersionDiff extends Diff {
  /** 0 when `to` is the first version. */
  from: number;
  to: number;
}

export interface PendingApproval extends Approval {
  workflowName: string;
}

/** Which of the things a workflow expects from the deployment are actually there. */
export interface Requirements {
  mounts: { target: string; present: boolean }[];
  services: { name: string; port: number; reachable: boolean }[];
}

export interface SandboxStatus {
  egressEnforced: boolean;
  alwaysAllowed: string[];
  separateAgentUser: boolean;
  recentlyBlocked: { host: string; at: string }[];
}

export interface RunDetail {
  run: Run;
  events: RunEvent[];
  approvals: Approval[];
  /** The workflow was edited after this run took its copy of the definition. */
  outdated: boolean;
}

export type { ApplyPlan, BlockChange } from '../../server/src/engine/apply-definition.ts';
import type { ApplyPlan } from '../../server/src/engine/apply-definition.ts';

/** Raised for any non-2xx answer, with the server's error message. */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Called when the server says the session is gone, so the app can show the login page. */
let onSignedOut = () => {};
export function setSignedOutHandler(handler: () => void): void {
  onSignedOut = handler;
}

async function request<T>(method: string, path: string, body?: unknown, contentType = 'application/json'): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': contentType },
    body: body === undefined ? undefined : contentType === 'application/json' ? JSON.stringify(body) : String(body),
  });
  if (response.status === 401 && path !== '/login') onSignedOut();
  const isJson = response.headers.get('content-type')?.includes('json');
  const payload = isJson ? await response.json() : await response.text();
  if (!response.ok) throw new ApiError(response.status, payload?.error ?? `Request failed (${response.status})`);
  return payload as T;
}

export const api = {
  session: () => request<{ authenticated: boolean }>('GET', '/session'),
  login: (token: string) => request('POST', '/login', { token }),
  logout: () => request('POST', '/logout', {}),
  meta: () => request<Meta>('GET', '/meta'),

  workflows: () => request<Workflow[]>('GET', '/workflows'),
  workflow: (id: string) => request<Workflow>('GET', `/workflows/${id}`),
  createWorkflow: (draft: WorkflowDraft) => request<Workflow>('POST', '/workflows', draft),
  /** `message` describes the change; it is kept with the version the save creates. */
  updateWorkflow: (id: string, draft: WorkflowDraft, message = '') => request<Workflow>('PUT', `/workflows/${id}`, { ...draft, message }),
  deleteWorkflow: (id: string) => request('DELETE', `/workflows/${id}`),
  runWorkflow: (id: string, payload: unknown = {}) => request<Run>('POST', `/workflows/${id}/run`, payload),
  requirements: (id: string) => request<Requirements>('GET', `/workflows/${id}/requirements`),

  versions: (id: string) => request<VersionSummary[]>('GET', `/workflows/${id}/versions`),
  versionDiff: (id: string, version: number, against?: number) =>
    request<VersionDiff>('GET', `/workflows/${id}/versions/${version}/diff${against === undefined ? '' : `?against=${against}`}`),
  restoreVersion: (id: string, version: number) => request<Workflow>('POST', `/workflows/${id}/versions/${version}/restore`, {}),

  exportFormula: (id: string, withHistory = false) => request<string>('GET', `/workflows/${id}/formula${withHistory ? '?history=true' : ''}`),
  importFormula: (yaml: string) => request<Workflow>('POST', '/formulas/import', yaml, 'application/yaml'),
  renderFormula: (draft: WorkflowDraft) => request<{ formula: string }>('POST', '/formulas/render', draft),
  parseFormula: (formula: string) => request<WorkflowDraft>('POST', '/formulas/parse', { formula }),

  runs: (workflowId?: string) => request<Run[]>('GET', `/runs${workflowId ? `?workflowId=${workflowId}` : ''}`),
  run: (id: string) => request<RunDetail>('GET', `/runs/${id}`),
  cancelRun: (id: string) => request('POST', `/runs/${id}/cancel`, {}),
  retryRun: (id: string) => request('POST', `/runs/${id}/retry`, {}),
  skipStep: (id: string) => request('POST', `/runs/${id}/skip`, {}),
  applyLatestPlan: (id: string) => request<ApplyPlan>('GET', `/runs/${id}/apply-latest`),
  applyLatest: (id: string) => request<{ plan: ApplyPlan; deferred: boolean }>('POST', `/runs/${id}/apply-latest`, {}),
  outdatedRuns: (workflowId: string) => request<Pick<Run, 'id' | 'status' | 'createdAt'>[]>('GET', `/workflows/${workflowId}/outdated-runs`),
  applyToRuns: (workflowId: string) => request<{ runId: string; deferred: boolean }[]>('POST', `/workflows/${workflowId}/apply-to-runs`, {}),

  pendingApprovals: () => request<PendingApproval[]>('GET', '/approvals?status=pending'),
  resolveApproval: (id: string, decision: 'approved' | 'rejected', comment: string) =>
    request('POST', `/approvals/${id}/resolve`, { decision, comment }),

  secrets: () => request<string[]>('GET', '/secrets'),
  setSecret: (name: string, value: string) => request('PUT', `/secrets/${name}`, { value }),
  deleteSecret: (name: string) => request('DELETE', `/secrets/${name}`),
  sandbox: () => request<SandboxStatus>('GET', '/sandbox'),
  settings: () => request<Settings>('GET', '/settings'),
  saveSettings: (settings: Settings) => request<Settings>('PUT', '/settings', settings),
};
