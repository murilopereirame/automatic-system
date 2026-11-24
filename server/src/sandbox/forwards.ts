/**
 * Localhost forwards for service containers (see docs/FORWARDS.md).
 *
 * Some projects only accept loopback addresses for their test databases, e.g.
 * `mongodb://localhost/app-test`. A service with `forwardToLocalhost: true`
 * gets a small TCP proxy owned by the server: it listens on the container's
 * loopback interface and pipes every connection to `<service name>:<port>`.
 *
 * Runs and the web shell share one container and one loopback interface, so
 * forwards are container-wide: the union over enabled workflows, reconciled
 * whenever a workflow changes, the same way the egress allow list is built.
 */
import net from 'node:net';
import { errorMessage } from '../errors.js';
import { listWorkflows } from '../store/workflows.js';
import type { Workflow } from '../types.js';

/** Only the loopback interface. IPv6 is opened as well when the container has it, because `localhost` may resolve to `::1`. */
const LOOPBACK_ADDRESSES = ['127.0.0.1', '::1'];
const CONNECT_TIMEOUT_MS = 10_000;

export interface Forward {
  localPort: number;
  /** Always the name of a declared service, never an arbitrary host. */
  host: string;
  port: number;
}

export interface ForwardStatus extends Forward {
  listening: boolean;
  error?: string;
}

const target = (forward: Pick<Forward, 'host' | 'port'>) => `${forward.host}:${forward.port}`;

/** What one workflow asks for: each port of each service that has `forwardToLocalhost` set. */
export function forwardsOf(workflow: Pick<Workflow, 'definition'>): Forward[] {
  return workflow.definition.environment.services
    .filter((service) => service.forwardToLocalhost)
    .flatMap((service) => service.ports.map((port) => ({ localPort: port, host: service.name, port })));
}

/**
 * The forwards the container should have: the union over enabled workflows.
 * A local port can only point at one target. When two workflows want the same
 * port for different services, the first one (by name) gets it and the other
 * is reported as a conflict, so its runs fail with a clear message.
 */
export function desiredForwards(workflows: Workflow[]): { forwards: Forward[]; conflicts: (Forward & { error: string })[] } {
  const byPort = new Map<number, Forward & { workflow: string }>();
  const conflicts: (Forward & { error: string })[] = [];
  for (const workflow of workflows.filter((entry) => entry.enabled)) {
    for (const forward of forwardsOf(workflow)) {
      const taken = byPort.get(forward.localPort);
      if (!taken) byPort.set(forward.localPort, { ...forward, workflow: workflow.name });
      else if (target(taken) !== target(forward)) {
        conflicts.push({ ...forward, error: `port ${forward.localPort} is already forwarded to ${target(taken)} for workflow "${taken.workflow}"` });
      }
    }
  }
  return { forwards: [...byPort.values()].map(({ workflow: _workflow, ...forward }) => forward), conflicts };
}

/**
 * Pipes one accepted connection to the service. An end is passed on (`pipe`),
 * and an error or full close on either side destroys both sockets; nothing
 * here can throw into the listener.
 */
function pipeToService(client: net.Socket, forward: Forward): void {
  // Half-open on both sides, so a client that sends and then shuts down its writing side still gets the answer.
  const upstream = net.connect({ host: forward.host, port: forward.port, allowHalfOpen: true });
  upstream.setTimeout(CONNECT_TIMEOUT_MS, () => upstream.destroy());
  upstream.once('connect', () => upstream.setTimeout(0));
  const closeBoth = () => {
    client.destroy();
    upstream.destroy();
  };
  for (const socket of [client, upstream]) socket.on('error', closeBoth).on('close', closeBoth);
  client.pipe(upstream);
  upstream.pipe(client);
}

interface Listener {
  forward: Forward;
  servers: net.Server[];
  error?: string;
}

function listen(server: net.Server, address: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: address, port }, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

const closeServer = (server: net.Server) => new Promise<void>((resolve) => server.close(() => resolve()));

/** Opens a forward on every loopback address the container has. Fails only when IPv4 loopback cannot be bound. */
async function open(forward: Forward): Promise<Listener> {
  const listener: Listener = { forward, servers: [] };
  for (const address of LOOPBACK_ADDRESSES) {
    // The handler reads `listener.forward`, so a changed target applies to new connections without reopening the port.
    const server = net.createServer({ allowHalfOpen: true }, (client) => pipeToService(client, listener.forward));
    try {
      await listen(server, address, forward.localPort);
      // A listening server only reports errors of accepted sockets here, which `pipeToService` handles. Never crash on one.
      server.on('error', (error) => console.warn(`Forward on ${address}:${forward.localPort}: ${errorMessage(error)}`));
      listener.servers.push(server);
    } catch (error) {
      if (address === '127.0.0.1') {
        await Promise.all(listener.servers.map(closeServer));
        return { forward, servers: [], error: bindError(error, forward.localPort) };
      }
      // No IPv6 loopback in this container: IPv4 alone is fine.
    }
  }
  return listener;
}

function bindError(error: unknown, port: number): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'EADDRINUSE') return `port ${port} is already in use inside the container`;
  if (code === 'EACCES') return `port ${port} needs a capability the container does not have (use a port above 1024)`;
  return errorMessage(error);
}

const listeners = new Map<number, Listener>();
const conflicts = new Map<number, ForwardStatus[]>();
/** Reconciliations run one after another, so two changes in a row never race over the same port. */
let queue: Promise<void> = Promise.resolve();

/**
 * Brings the open listeners in line with `wanted`: closes what is no longer
 * needed, retargets ports whose service changed, opens new ones and retries
 * ports that could not be bound last time.
 */
export function reconcileForwards(wanted: Forward[], conflicting: (Forward & { error: string })[] = []): Promise<void> {
  queue = queue.then(async () => {
    const wantedByPort = new Map(wanted.map((forward) => [forward.localPort, forward]));
    for (const [port, listener] of listeners) {
      if (wantedByPort.has(port) && !listener.error) continue;
      listeners.delete(port);
      await Promise.all(listener.servers.map(closeServer));
    }
    for (const forward of wanted) {
      const current = listeners.get(forward.localPort);
      if (current) current.forward = forward;
      else listeners.set(forward.localPort, await open(forward));
    }
    conflicts.clear();
    for (const forward of conflicting) conflicts.set(forward.localPort, [...(conflicts.get(forward.localPort) ?? []), { ...forward, listening: false }]);
  });
  return queue;
}

/** Reconciles against the saved workflows. Called at startup and after every workflow change. */
export function syncForwards(): Promise<void> {
  const { forwards, conflicts: conflicting } = desiredForwards(listWorkflows());
  return reconcileForwards(forwards, conflicting);
}

/** State of the given forwards, for the Environment tab and the check before a run. */
export function forwardStatus(forwards: Forward[]): ForwardStatus[] {
  return forwards.map((forward) => {
    const listener = listeners.get(forward.localPort);
    if (listener && target(listener.forward) === target(forward)) {
      return { ...forward, listening: !listener.error, ...(listener.error && { error: listener.error }) };
    }
    const conflict = conflicts.get(forward.localPort)?.find((entry) => target(entry) === target(forward));
    if (conflict) return { ...forward, listening: false, error: conflict.error };
    if (listener) return { ...forward, listening: false, error: `port ${forward.localPort} is forwarded to ${target(listener.forward)}` };
    return { ...forward, listening: false, error: 'not opened, forwards are opened for enabled workflows only' };
  });
}

/**
 * Before a run: makes sure the listeners match the saved workflows, then
 * fails when one of this workflow's forwards is not listening.
 */
export async function ensureForwards(workflow: Pick<Workflow, 'definition'>): Promise<void> {
  const wanted = forwardsOf(workflow);
  if (wanted.length === 0) return;
  await syncForwards();
  const down = forwardStatus(wanted).filter((status) => !status.listening);
  if (down.length === 0) return;
  const list = down.map((status) => `localhost:${status.localPort} → ${target(status)} (${status.error})`).join(', ');
  throw new Error(`Localhost forward not listening: ${list}. See the Environment tab.`);
}

export async function closeAllForwards(): Promise<void> {
  await reconcileForwards([]);
}
