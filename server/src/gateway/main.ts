/**
 * Entry point of the gateway container, the only container with a route to
 * the outside. It does two things:
 *
 *  1. Ingress: relays the published port to the Auto Worker server, which
 *     sits on an internal network and cannot publish a port itself.
 *  2. Egress: runs the allow-list proxy for everything the sandbox sends out.
 *
 * The allow list lives in the server (it comes from the workflows). The
 * gateway fetches it every few seconds and reports what it blocked.
 */
import net from 'node:net';
import { createEgressProxy } from './proxy.js';

const env = process.env;
const upstream = { host: env.GATEWAY_UPSTREAM_HOST ?? 'autoworker', port: Number(env.GATEWAY_UPSTREAM_PORT ?? 8080) };
const ingressPort = Number(env.GATEWAY_INGRESS_PORT ?? 8080);
const proxyPort = Number(env.GATEWAY_PROXY_PORT ?? 3128);
const secret = env.AUTOWORKER_GATEWAY_SECRET;
const SYNC_INTERVAL_MS = 5000;

if (!secret) {
  console.error('AUTOWORKER_GATEWAY_SECRET is required');
  process.exit(1);
}

/** Until the first successful sync nothing is allowed. */
let allowList: string[] = [];
let blockedSinceSync: { host: string; at: string }[] = [];

async function sync(): Promise<void> {
  const reporting = blockedSinceSync;
  blockedSinceSync = [];
  try {
    const response = await fetch(`http://${upstream.host}:${upstream.port}/internal/egress`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocked: reporting }),
    });
    if (!response.ok) throw new Error(`the server answered ${response.status}`);
    allowList = ((await response.json()) as { allow: string[] }).allow;
  } catch (error) {
    blockedSinceSync.unshift(...reporting);
    console.warn(`Could not sync the allow list: ${(error as Error).message}`);
  }
}

const proxy = createEgressProxy({
  allowList: () => allowList,
  privilegedAuthorization: `Basic ${Buffer.from(`server:${secret}`).toString('base64')}`,
  onBlocked: (host) => {
    console.log(`blocked ${host}`);
    blockedSinceSync.push({ host, at: new Date().toISOString() });
  },
});
proxy.listen(proxyPort, () => console.log(`Egress proxy listening on :${proxyPort}`));

// Ingress is a plain TCP relay, so HTTP, server-sent events and WebSockets all pass through untouched.
const ingress = net.createServer((client) => {
  const target = net.connect(upstream.port, upstream.host);
  client.pipe(target).pipe(client);
  const close = () => {
    client.destroy();
    target.destroy();
  };
  client.on('error', close).on('close', close);
  target.on('error', close).on('close', close);
});
ingress.listen(ingressPort, () => console.log(`Ingress relay :${ingressPort} -> ${upstream.host}:${upstream.port}`));

void sync();
setInterval(sync, SYNC_INTERVAL_MS);

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
