/** Shared domain types. The same shapes travel over the API to the web UI. */

/** Describes one configurable input of a block, so the UI can render a form for it. */
export interface FieldSpec {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'number' | 'boolean' | 'select' | 'secret' | 'step';
  options?: string[];
  default?: unknown;
  placeholder?: string;
  help?: string;
}

export interface TriggerConfig {
  type: string;
  with: Record<string, unknown>;
}

export interface StepConfig {
  id: string;
  type: string;
  name?: string;
  with: Record<string, unknown>;
}

export interface RuntimeSpec {
  name: string;
  version: string;
}

export interface MemoryFile {
  /** Path relative to the workflow's Claude config directory, e.g. `CLAUDE.md`. */
  path: string;
  content: string;
}

export interface MountSpec {
  source: string;
  target: string;
  readOnly?: boolean;
}

/** Everything a workflow needs around it. This is what makes a formula portable. */
export interface Environment {
  runtimes: RuntimeSpec[];
  /** Same shape as the `mcpServers` object of a Claude Code `.mcp.json` file. */
  mcpServers: Record<string, unknown>;
  memory: MemoryFile[];
  /** Plain environment variables given to Claude, commands and the web shell. */
  env: Record<string, string>;
  /** Names of stored secrets that are also exposed as environment variables. */
  secrets: string[];
  mounts: MountSpec[];
}

/**
 * A notification is a webhook call. `url`, header values and `body` are
 * templates; see notify.ts for the values they can use.
 */
export interface NotificationWebhook {
  name: string;
  url: string;
  /** Defaults to POST. */
  method?: string;
  headers?: Record<string, string>;
  /** Request body template. Defaults to a JSON object with title, message and run URL. */
  body?: string;
}

export interface WorkflowDefinition {
  trigger: TriggerConfig;
  environment: Environment;
  notifications: NotificationWebhook[];
  steps: StepConfig[];
}

export interface Workflow {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  /** Random value that webhook callers must present. Never exported. */
  hookSecret: string;
  definition: WorkflowDefinition;
  createdAt: string;
  updatedAt: string;
}

export type RunStatus = 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled';

/** Mutable state carried from step to step. Templates read from it. */
export interface RunContext {
  trigger: Record<string, unknown>;
  steps: Record<string, { output: unknown }>;
  /** Directory later steps run in. Set by the "Clone repository" step. */
  workdir?: string;
  repo?: { url: string; owner: string; name: string; baseBranch: string; branch: string };
  claudeSessionId?: string;
  /** Reviewer comment from a rejected approval, consumed by the next Claude step. */
  feedback?: string;
}

export interface Run {
  id: string;
  workflowId: string;
  workflowName: string;
  status: RunStatus;
  /** Index of the step that is running, waiting, or that failed. */
  stepIndex: number;
  /** Copy of the workflow definition taken when the run started, so later edits do not affect it. */
  definition: WorkflowDefinition;
  context: RunContext;
  workspace: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RunEvent {
  id: number;
  runId: string;
  stepId: string | null;
  type: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface Approval {
  id: string;
  runId: string;
  stepId: string;
  message: string;
  status: 'pending' | 'approved' | 'rejected';
  comment?: string;
  createdAt: string;
  resolvedAt?: string;
}

export interface Settings {
  /** Commit author used by the pull request block. Empty values fall back to the owner of the GitHub token. */
  git: { name: string; email: string };
}

export function emptyEnvironment(): Environment {
  return { runtimes: [], mcpServers: {}, memory: [], env: {}, secrets: [], mounts: [] };
}
