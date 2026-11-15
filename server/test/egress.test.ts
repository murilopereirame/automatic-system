/** Egress allow list: host matching, the proxy, and the sync endpoint the gateway uses. */
import './helpers.js';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import { after, before, test } from 'node:test';
import { emptyEnvironment } from '../src/types.js';

process.env.AUTOWORKER_GATEWAY_SECRET = 'gateway-secret';
process.env.AUTOWORKER_EGRESS_PROXY = 'http://gateway:3128';

const { recentlyBlocked } = await import('../src/egress.js');
const { hostMatches } = await import('../src/gateway/hosts.js');
const { connectToAny, createEgressProxy, isPrivateAddress } = await import('../src/gateway/proxy.js');
const { createWorkflow } = await import('../src/store/workflows.js');
const { buildServer } = await import('../src/http/server.js');
const engine = await import('../src/engine/engine.js');
const runs = await import('../src/store/runs.js');

test('host patterns: exact, wildcard and everything', () => {
  assert.ok(hostMatches('github.com', ['github.com']));
  assert.ok(hostMatches('API.GitHub.com', ['*.github.com']));
  assert.ok(hostMatches('github.com', ['*.github.com']), 'a wildcard covers the bare domain too');
  assert.ok(hostMatches('anything.example', ['*']));
  assert.ok(!hostMatches('evilgithub.com', ['*.github.com', 'github.com']));
  assert.ok(!hostMatches('github.com.evil.example', ['github.com']));
});

test('private, loopback and metadata addresses are recognised', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.17.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.0.0.1']) {
    assert.ok(isPrivateAddress(address), address);
  }
  for (const address of ['8.8.8.8', '172.32.0.1', '140.82.112.3', '2606:4700::1111']) assert.ok(!isPrivateAddress(address), address);
});

// A local web server plays "the internet". It is reached as `localhost`, a private address.
let target: http.Server;
let proxy: http.Server;
let allow: string[] = [];
const blocked: string[] = [];
const PRIVILEGED = `Basic ${Buffer.from('server:gateway-secret').toString('base64')}`;

before(async () => {
  target = http.createServer((_request, response) => response.end('hello from outside'));
  proxy = createEgressProxy({ allowList: () => allow, privilegedAuthorization: PRIVILEGED, onBlocked: (host) => blocked.push(host) });
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
});
after(() => {
  target.close();
  proxy.close();
});

const port = (server: http.Server) => (server.address() as AddressInfo).port;

/** Sends a plain HTTP request through the proxy. */
function viaProxy(host: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: port(proxy), path: `http://${host}:${port(target)}/`, headers }, (response) => {
      let body = '';
      response.on('data', (chunk) => (body += chunk)).on('end', () => resolve({ status: response.statusCode!, body }));
    });
    request.on('error', reject).end();
  });
}

/** Opens a CONNECT tunnel through the proxy and returns the proxy's status line. */
function connectVia(host: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect(port(proxy), '127.0.0.1', () => socket.write(`CONNECT ${host}:${port(target)} HTTP/1.1\r\nHost: ${host}\r\n\r\n`));
    socket.once('data', (data) => {
      resolve(data.toString().split('\r\n')[0]);
      socket.destroy();
    });
  });
}

test('the proxy refuses hosts that are not on the allow list and reports them', async () => {
  allow = ['github.com'];
  const refused = await viaProxy('localhost');
  assert.equal(refused.status, 403);
  assert.match(refused.body, /egress allow list/);
  assert.equal(await connectVia('localhost'), 'HTTP/1.1 403 Forbidden');
  assert.deepEqual(blocked, ['localhost', 'localhost']);
});

test('a host with several addresses is reached on the one that answers', async () => {
  // On many machines localhost is ::1 first, while the target only listens on IPv4.
  const socket = await connectToAny(['::1', '127.0.0.1'], port(target));
  assert.equal(socket.remoteAddress, '127.0.0.1');
  socket.destroy();
  await assert.rejects(connectToAny(['127.0.0.1'], 1));
});

test('an exactly listed host is reachable, by plain HTTP and by tunnel', async () => {
  allow = ['localhost'];
  assert.deepEqual(await viaProxy('localhost'), { status: 200, body: 'hello from outside' });
  assert.equal(await connectVia('localhost'), 'HTTP/1.1 200 Connection Established');
});

test('a wildcard never opens private addresses', async () => {
  allow = ['*'];
  assert.equal((await viaProxy('localhost')).status, 403, 'localhost resolves to a private address');
  assert.equal(await connectVia('127.0.0.1'), 'HTTP/1.1 403 Forbidden');
});

test('the server itself is not restricted when it presents the gateway secret', async () => {
  allow = [];
  assert.equal((await viaProxy('localhost', { 'Proxy-Authorization': PRIVILEGED })).status, 200);
  assert.equal((await viaProxy('localhost', { 'Proxy-Authorization': 'Basic d3Jvbmc6d3Jvbmc=' })).status, 403);
});

test('the sync endpoint serves the allow list of enabled workflows to the gateway only', async () => {
  const definition = (hosts: string[]) => ({
    triggers: [],
    environment: { ...emptyEnvironment(), network: { allow: hosts } },
    notifications: [],
    steps: [],
  });
  createWorkflow({ name: 'on', definition: definition(['github.com', '*.npmjs.org']) });
  createWorkflow({ name: 'off', enabled: false, definition: definition(['disabled.example']) });

  const app = await buildServer();
  const sync = (secret: string) =>
    app.inject({ method: 'POST', url: '/internal/egress', headers: { authorization: `Bearer ${secret}` }, payload: { blocked: [{ host: 'evil.example', at: '2026-01-01T00:00:00.000Z' }] } });

  assert.equal((await sync('wrong')).statusCode, 404);
  const answer = await sync('gateway-secret');
  assert.deepEqual(answer.json().allow.sort(), ['*.npmjs.org', 'api.anthropic.com', 'github.com']);
  assert.deepEqual(recentlyBlocked(), [{ host: 'evil.example', at: '2026-01-01T00:00:00.000Z' }]);
  await app.close();
});

test('sandbox processes are pointed at the proxy, except for the workflow services', async () => {
  const environment = { ...emptyEnvironment(), services: [{ name: 'localhost', image: 'mongo:7', ports: [port(target)], env: {} }] };
  const workflow = createWorkflow({
    name: 'proxied',
    definition: { triggers: [], environment, notifications: [], steps: [{ id: 'env', type: 'shell', with: { command: 'env | grep -i proxy | sort' } }] },
  });
  const run = engine.startRun(workflow, {});
  await engine.waitForIdle();

  const output = (runs.getRun(run.id)!.context.steps.env.output as any).output as string;
  assert.match(output, /^HTTPS_PROXY=http:\/\/gateway:3128$/m);
  assert.match(output, /^NO_PROXY=localhost,127\.0\.0\.1,localhost$/m);
  assert.doesNotMatch(output, /gateway-secret/);
});

test('a run fails with a clear message when a declared service is not deployed', async () => {
  const { checkServices } = await import('../src/sandbox/environment.js');
  const closed = { name: '127.0.0.1', image: 'mongo:7', ports: [1], env: {} };
  const open = { name: '127.0.0.1', image: 'redis:7', ports: [port(target)], env: {} };
  assert.deepEqual(await checkServices([closed, open]), [
    { name: '127.0.0.1', port: 1, reachable: false },
    { name: '127.0.0.1', port: port(target), reachable: true },
  ]);
});
