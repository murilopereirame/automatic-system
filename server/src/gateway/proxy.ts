/**
 * The egress proxy: a small HTTP forward proxy that only connects to allowed
 * hosts. It supports CONNECT tunnels (HTTPS and anything else over TCP) and
 * plain HTTP requests.
 *
 * Two rules on top of the allow list:
 *  - Callers that present the gateway secret (the Auto Worker server itself)
 *    are not restricted. The sandboxed agent never has that secret.
 *  - A host that resolves to a private, loopback or link-local address is
 *    refused unless it is on the list by its exact name. This keeps the
 *    sandbox away from the Docker host, the local network and cloud metadata
 *    endpoints, even through a wildcard entry or a DNS trick.
 */
import { lookup } from 'node:dns/promises';
import http, { type IncomingMessage } from 'node:http';
import net from 'node:net';
import { hostMatches } from './hosts.js';

export interface EgressPolicy {
  /** Current allow list. Called for every connection, so it may change over time. */
  allowList(): string[];
  /** The value of the Proxy-Authorization header that lifts the restrictions. */
  privilegedAuthorization?: string;
  onBlocked?(host: string): void;
}

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^0\./];

export function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) return PRIVATE_V4.some((range) => range.test(address));
  const v6 = address.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

/**
 * Decides whether a connection may be made and to which addresses. Returns
 * undefined to refuse. A name can have several addresses (localhost is often
 * both ::1 and 127.0.0.1), so all of them are checked and returned.
 */
async function resolveTarget(host: string, request: IncomingMessage, policy: EgressPolicy): Promise<string[] | undefined> {
  const privileged = policy.privilegedAuthorization !== undefined && request.headers['proxy-authorization'] === policy.privilegedAuthorization;
  const patterns = policy.allowList();
  if (!privileged && !hostMatches(host, patterns)) return undefined;

  let addresses: string[];
  try {
    addresses = (await lookup(host, { all: true })).map((entry) => entry.address);
  } catch {
    return undefined;
  }
  if (addresses.length === 0) return undefined;
  const listedByExactName = patterns.some((pattern) => pattern.trim().toLowerCase() === host.toLowerCase());
  if (!privileged && addresses.some(isPrivateAddress) && !listedByExactName) return undefined;
  return addresses;
}

/** Connects to the first address that accepts the connection. */
export async function connectToAny(addresses: string[], port: number): Promise<net.Socket> {
  let failure: unknown;
  for (const address of addresses) {
    try {
      return await new Promise<net.Socket>((resolve, reject) => {
        const socket = net.connect(port, address);
        socket.once('connect', () => resolve(socket.off('error', reject)));
        socket.once('error', reject);
      });
    } catch (reason) {
      failure = reason;
    }
  }
  throw failure;
}

function splitHostPort(target: string, defaultPort: number): { host: string; port: number } {
  const match = target.match(/^\[?([^\]]+?)\]?(?::(\d+))?$/);
  return { host: match?.[1] ?? target, port: Number(match?.[2] ?? defaultPort) };
}

const REFUSAL = 'Blocked by the Auto Worker egress allow list. Add the host under Environment > Network in the workflow.';

export function createEgressProxy(policy: EgressPolicy): http.Server {
  const server = http.createServer();

  // HTTPS and other TCP protocols: "CONNECT host:port".
  server.on('connect', async (request, client, head) => {
    client.on('error', () => {});
    const { host, port } = splitHostPort(request.url ?? '', 443);
    const addresses = await resolveTarget(host, request, policy);
    if (!addresses) {
      policy.onBlocked?.(host);
      client.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${REFUSAL}\n`);
      return;
    }
    let upstream: net.Socket;
    try {
      upstream = await connectToAny(addresses, port);
    } catch {
      client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      return;
    }
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });

  // Plain HTTP: "GET http://host/path".
  server.on('request', async (request, response) => {
    let url: URL;
    try {
      url = new URL(request.url ?? '');
    } catch {
      response.writeHead(400).end('This is a forward proxy.\n');
      return;
    }
    const addresses = await resolveTarget(url.hostname, request, policy);
    if (!addresses) {
      policy.onBlocked?.(url.hostname);
      response.writeHead(403, { 'Content-Type': 'text/plain' }).end(`${REFUSAL}\n`);
      return;
    }
    let socket: net.Socket;
    try {
      socket = await connectToAny(addresses, Number(url.port || 80));
    } catch {
      response.writeHead(502).end();
      return;
    }
    const { 'proxy-authorization': _credentials, 'proxy-connection': _connection, ...headers } = request.headers;
    const upstream = http.request(
      { createConnection: () => socket, method: request.method, path: `${url.pathname}${url.search}`, headers: { ...headers, host: url.host, connection: 'close' } },
      (answer) => {
        response.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(response);
      },
    );
    upstream.on('error', () => (response.headersSent ? response.destroy() : response.writeHead(502).end()));
    request.pipe(upstream);
  });

  return server;
}
