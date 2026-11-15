/**
 * Server side of the egress allow list.
 *
 * The gateway container enforces the list; this module decides what is on it
 * and remembers what the gateway recently blocked, so the UI can show it.
 */
import { listWorkflows } from './store/workflows.js';
import { config } from './config.js';

export interface BlockedConnection {
  host: string;
  at: string;
}

const MAX_REMEMBERED = 50;
let blocked: BlockedConnection[] = [];

/**
 * Hosts the sandbox may reach: the always-allowed ones plus what the enabled
 * workflows ask for. The gateway cannot tell runs apart, so the list is the
 * union over all enabled workflows.
 */
export function currentAllowList(): string[] {
  const fromWorkflows = listWorkflows()
    .filter((workflow) => workflow.enabled)
    .flatMap((workflow) => workflow.definition.environment.network.allow);
  return [...new Set([...config.egressAlwaysAllow, ...fromWorkflows])];
}

export function recordBlocked(entries: BlockedConnection[]): void {
  const known = new Map(blocked.map((entry) => [entry.host, entry]));
  for (const entry of entries) known.set(entry.host, entry);
  blocked = [...known.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, MAX_REMEMBERED);
}

/** Most recent first, one entry per host. */
export function recentlyBlocked(): BlockedConnection[] {
  return blocked;
}
