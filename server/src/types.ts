/** Shared domain types. The same shapes travel over the API to the web UI. */

/** Describes one configurable input of a block, so the UI can render a form for it. */
export interface FieldSpec {
  key: string;
  label: string;
  /**
   * `step` picks an earlier block, `target` any other block or the end of the
   * run, and `expression` is a condition (see expression.ts).
   */
  type: 'text' | 'textarea' | 'number' | 'boolean' | 'select' | 'secret' | 'step' | 'expression' | 'target';
  options?: string[];
  default?: unknown;
  placeholder?: string;
  help?: string;
}

export interface TriggerConfig {
  /** Unique within the workflow. Names the trigger in webhook URLs and run reports. */
  id: string;
  type: string;
  with: Record<string, unknown>;
}

/** Identifies the trigger that started a run. */
export interface TriggerRef {
  id: string;
  type: string;
}

/** What "Run now" and `POST /api/workflows/:id/run` record as the trigger of a run. */
export const MANUAL_TRIGGER: TriggerRef = { id: 'manual', type: 'manual' };

export type RunInputType = 'text' | 'textarea' | 'number' | 'boolean' | 'select' | 'json';

/**
 * A value "Run now" asks for before it starts a run. The answers are the
 * trigger payload of the run (see inputs.ts).
 */
export interface RunInput {
  /** Where the value goes in the trigger payload. Dots nest: `task.id` is read as `{{trigger.task.id}}`. */
  name: string;
  type: RunInputType;
  /** Shown in the form instead of the name. */
  label?: string;
  help?: string;
  /** Used when the form field is left empty. */
  default?: unknown;
  required?: boolean;
  /** The choices of a `select` input. */
  options?: string[];
}

export interface StepConfig {
  id: string;
  type: string;
  name?: string;
  /** Expression. When it is set and false, the run skips this block. */
  if?: string;
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

/** A Claude Code skill: instructions Claude loads when a task matches its description. */
export interface SkillSpec {
  /** Directory name of the skill, e.g. `frontend-prompt`. */
  name: string;
  /** Content of the skill's SKILL.md, including its frontmatter. */
  content: string;
}

/**
 * A helper container the workflow needs next to the sandbox, such as a
 * database for tests. It runs as its own compose service; the sandbox reaches
 * it by name, e.g. `mongo:27017`.
 */
export interface ServiceSpec {
  name: string;
  image: string;
  ports: number[];
  env: Record<string, string>;
  command?: string;
}

export interface NetworkSpec {
  /**
   * Hosts the sandbox may connect to, e.g. `github.com` or `*.npmjs.org`.
   * `*` allows everything. Only enforced when the gateway is deployed.
   */
  allow: string[];
}

/** Everything a workflow needs around it. This is what makes a formula portable. */
export interface Environment {
  runtimes: RuntimeSpec[];
  /** Same shape as the `mcpServers` object of a Claude Code `.mcp.json` file. */
  mcpServers: Record<string, unknown>;
  memory: MemoryFile[];
  skills: SkillSpec[];
  services: ServiceSpec[];
  network: NetworkSpec;
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
  /** Any of these starts a run. Empty means runs only start from "Run now". */
  triggers: TriggerConfig[];
  /** What "Run now" asks for. Missing on workflows stored before inputs existed. */
  inputs?: RunInput[];
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
  /** Number of the current version. Every save that changes something adds one (see store/versions.ts). */
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** How a version came to be. */
export type VersionSource = 'created' | 'edited' | 'imported' | 'restored';

/**
 * One saved state of a workflow, like a commit. Versions are never changed or
 * deleted while the workflow exists: restoring an old one adds a new version.
 */
export interface WorkflowVersion {
  workflowId: string;
  version: number;
  name: string;
  description: string;
  enabled: boolean;
  definition: WorkflowDefinition;
  /** What changed, in the words of whoever saved it. May be empty. */
  message: string;
  source: VersionSource;
  /** For `restored` versions: the version whose content was brought back. */
  restoredFrom?: number;
  createdAt: string;
}

export type RunStatus = 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled';

/** Top-level names the templates and expressions of a block can use. The engine provides them (see `scopeFor` in engine/engine.ts). */
export const SCOPE_NAMES = ['trigger', 'triggeredBy', 'steps', 'previous', 'run', 'repo', 'repos'] as const;

export interface RepoContext {
  url: string;
  owner: string;
  name: string;
  baseBranch: string;
  branch: string;
}

/** Mutable state carried from step to step. Templates read from it. */
export interface RunContext {
  /** The payload of the trigger that started the run. */
  trigger: Record<string, unknown>;
  /** Which trigger started the run. Missing on runs from before workflows could have several triggers. */
  triggeredBy?: TriggerRef;
  /** What each block produced. `skipped` marks blocks the run passed over because of a condition. */
  steps: Record<string, { output: unknown; skipped?: boolean }>;
  /** How often each condition block has sent the run back to an earlier block. */
  repeats?: Record<string, number>;
  /** Directory later steps run in. Set by the first "Clone repository" step. */
  workdir?: string;
  /** The repository later steps work on by default: the first one cloned. */
  repo?: RepoContext;
  /** Every repository cloned in this run, by the folder it was cloned into (`repo` unless the block says otherwise). */
  repos?: Record<string, RepoContext & { dir: string }>;
  claudeSessionId?: string;
  /** Folder the Claude conversation belongs to. Claude Code can only resume a conversation from the folder it started in. */
  claudeSessionDir?: string;
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
  /** The workflow version `definition` was taken from. Missing on runs from before workflows had versions. */
  workflowVersion?: number;
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
  /** Commit author of everything a run commits. Empty values fall back to the owner of the GitHub token. */
  git: { name: string; email: string };
}

export function emptyEnvironment(): Environment {
  return { runtimes: [], mcpServers: {}, memory: [], skills: [], services: [], network: { allow: [] }, env: {}, secrets: [], mounts: [] };
}

/**
 * Definitions stored before a workflow could have several triggers hold one
 * `trigger` instead of the `triggers` list. This brings them to today's shape:
 * the single trigger keeps its type as id, and the old `manual` type, which
 * only meant "no trigger", becomes an empty list.
 */
export function upgradeDefinition(stored: WorkflowDefinition & { trigger?: Omit<TriggerConfig, 'id'> }): WorkflowDefinition {
  if (stored.triggers) return stored;
  const { trigger, ...rest } = stored;
  const triggers = trigger && trigger.type !== 'manual' ? [{ id: trigger.type, type: trigger.type, with: trigger.with ?? {} }] : [];
  return { ...rest, triggers };
}
