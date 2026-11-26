/** Localhost forwards for service containers: parsing, reconciliation and the TCP proxy (docs/FORWARDS.md). */
import { TOKEN } from './helpers.js';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { Workflow } from '../src/types.js';

const { parseDefinition, parseFormula, toFormula } = await import('../src/formula.js');
const { closeAllForwards, desiredForwards, ensureForwards, forwardStatus, reconcileForwards } = await import('../src/sandbox/forwards.js');
const { buildServer } = await import('../src/http/server.js');

const auth = { authorization: `Bearer ${TOKEN}` };
let app: FastifyInstance;

before(async () => {
  app = await buildServer();
});
after(async () => {
  await closeAllForwards();
  await app.close();
});

/** A port nothing listens on right now. */
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function connects(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

/** Sends `text` through a connection and resolves with everything received until the other side closes. */
function roundTrip(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = '';
    const socket = net.connect({ host: '127.0.0.1', port }, () => socket.end(text));
    socket.on('data', (chunk) => (received += chunk));
    socket.once('close', () => resolve(received));
    socket.once('error', reject);
  });
}

const service = (name: string, ports: number[], forwardToLocalhost?: boolean) => ({ name, image: 'mongo:8.0.1', ports, env: {}, ...(forwardToLocalhost !== undefined && { forwardToLocalhost }) });
const definitionWith = (services: unknown[]) => ({ triggers: [], environment: { services }, steps: [{ id: 'noop', type: 'shell', with: { command: 'true' } }] });
const asWorkflow = (name: string, enabled: boolean, services: unknown[]) => ({ name, enabled, definition: parseDefinition(definitionWith(services)) }) as Workflow;

// ---- Parsing --------------------------------------------------------------

test('forwardToLocalhost is parsed, left out when not set, and survives export', () => {
  const definition = parseDefinition(definitionWith([service('mongo', [27017], true), service('redis', [6379])]));
  assert.equal(definition.environment.services[0].forwardToLocalhost, true);
  assert.ok(!('forwardToLocalhost' in definition.environment.services[1]), 'services without the field stay as they were');

  const workflow = { id: 'w', name: 'Forwards', description: '', enabled: true, version: 1, definition } as Workflow;
  const exported = toFormula(workflow);
  assert.match(exported, /forwardToLocalhost: true/);
  assert.equal(exported.match(/forwardToLocalhost/g)?.length, 1);
  assert.deepEqual(parseFormula(exported).definition.environment.services, definition.environment.services);

  // `false` is the same as leaving it out.
  assert.ok(!('forwardToLocalhost' in parseDefinition(definitionWith([service('mongo', [27017], false)])).environment.services[0]));
});

test('forwards with a wrong value or a clashing port are rejected', () => {
  assert.throws(() => parseDefinition(definitionWith([{ ...service('mongo', [27017]), forwardToLocalhost: 'yes' }])), /must be true or false/);
  assert.throws(() => parseDefinition(definitionWith([service('web', [8080], true)])), /server listens there/);
  assert.throws(() => parseDefinition(definitionWith([service('mongo', [27017], true), service('mongo2', [27017], true)])), /both forward port 27017/);
  // Ports are only claimed when forwarded: the same port on two services is fine otherwise.
  assert.doesNotThrow(() => parseDefinition(definitionWith([service('mongo', [27017], true), service('mongo2', [27017])])));
  assert.doesNotThrow(() => parseDefinition(definitionWith([service('web', [8080])])));
});

// ---- Union over workflows ------------------------------------------------

test('the wanted forwards are the union over enabled workflows, with conflicts reported', () => {
  const { forwards, conflicts } = desiredForwards([
    asWorkflow('A', true, [service('mongo', [27017], true)]),
    asWorkflow('B', true, [service('mongo', [27017], true), service('postgres', [5432], true)]),
    asWorkflow('C', true, [service('other-mongo', [27017], true)]),
    asWorkflow('D', false, [service('redis', [6379], true)]),
    asWorkflow('E', true, [service('plain', [3000])]),
  ]);
  assert.deepEqual(forwards, [
    { localPort: 27017, host: 'mongo', port: 27017 },
    { localPort: 5432, host: 'postgres', port: 5432 },
  ]);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].host, 'other-mongo');
  assert.match(conflicts[0].error, /already forwarded to mongo:27017 for workflow "A"/);
});

// ---- Reconciliation when workflows change --------------------------------

test('forwards open and close as workflows are created, edited, toggled and deleted', async () => {
  const port = await freePort();
  const body = (services: unknown[], enabled = true) => ({ name: 'Forwarding workflow', enabled, definition: definitionWith(services) });
  const requirements = async (id: string) => (await app.inject({ url: `/api/workflows/${id}/requirements`, headers: auth })).json().forwards;

  const created = (await app.inject({ method: 'POST', url: '/api/workflows', headers: auth, payload: body([service('mongo', [port], true)]) })).json();
  assert.ok(await connects(port), 'listening after create');
  assert.deepEqual(await requirements(created.id), [{ localPort: port, host: 'mongo', port, listening: true }]);

  await app.inject({ method: 'PUT', url: `/api/workflows/${created.id}`, headers: auth, payload: body([service('mongo', [port], true)], false) });
  assert.ok(!(await connects(port)), 'closed when the workflow is disabled');
  assert.match((await requirements(created.id))[0].error, /enabled workflows only/);

  await app.inject({ method: 'PUT', url: `/api/workflows/${created.id}`, headers: auth, payload: body([service('mongo', [port], true)]) });
  assert.ok(await connects(port), 'open again when enabled');

  await app.inject({ method: 'PUT', url: `/api/workflows/${created.id}`, headers: auth, payload: body([service('mongo', [port])]) });
  assert.ok(!(await connects(port)), 'closed when the field is removed');
  assert.deepEqual(await requirements(created.id), []);

  await app.inject({ method: 'PUT', url: `/api/workflows/${created.id}`, headers: auth, payload: body([service('mongo', [port], true)]) });
  assert.ok(await connects(port));
  await app.inject({ method: 'DELETE', url: `/api/workflows/${created.id}`, headers: auth });
  assert.ok(!(await connects(port)), 'closed when the workflow is deleted');
});

test('a forward whose port is taken fails the run with a clear message', async () => {
  const squatter = net.createServer();
  await new Promise<void>((resolve) => squatter.listen(0, '127.0.0.1', resolve));
  const { port } = squatter.address() as AddressInfo;
  try {
    const created = (await app.inject({ method: 'POST', url: '/api/workflows', headers: auth, payload: { name: 'Taken port', definition: definitionWith([service('mongo', [port], true)]) } })).json();
    const workflow = asWorkflow('Taken port', true, [service('mongo', [port], true)]);
    assert.deepEqual(forwardStatus([{ localPort: port, host: 'mongo', port }]), [{ localPort: port, host: 'mongo', port, listening: false, error: `port ${port} is already in use inside the container` }]);
    await assert.rejects(ensureForwards(workflow), new RegExp(`Localhost forward not listening: localhost:${port} → mongo:${port} \\(port ${port} is already in use`));
    await app.inject({ method: 'DELETE', url: `/api/workflows/${created.id}`, headers: auth });
  } finally {
    await new Promise((resolve) => squatter.close(resolve));
  }
  // Workflows without forwards never look at them.
  await ensureForwards(asWorkflow('Plain', true, [service('mongo', [port])]));
});

// ---- The proxy -----------------------------------------------------------

test('the proxy pipes both ways and survives resets on either side', async () => {
  // The "service": echoes upper-cased, except `reset` which it answers by resetting the connection.
  const upstream = net.createServer((socket) => {
    socket.on('data', (chunk) => {
      if (String(chunk).startsWith('reset')) socket.resetAndDestroy();
      else socket.write(String(chunk).toUpperCase());
    });
    socket.on('end', () => socket.end());
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const servicePort = (upstream.address() as AddressInfo).port;
  const localPort = await freePort();
  await reconcileForwards([{ localPort, host: '127.0.0.1', port: servicePort }]);

  try {
    assert.equal(await roundTrip(localPort, 'hello'), 'HELLO');

    // The service resets: the client is closed, the listener keeps working.
    assert.equal(await roundTrip(localPort, 'reset').catch(() => ''), '');
    assert.equal(await roundTrip(localPort, 'still there'), 'STILL THERE');

    // The client resets mid-connection.
    await new Promise<void>((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port: localPort }, () => {
        socket.write('half');
        socket.resetAndDestroy();
        resolve();
      });
    });
    assert.equal(await roundTrip(localPort, 'after client reset'), 'AFTER CLIENT RESET');

    // The service is gone: connections are refused upstream and closed, the listener stays.
    await new Promise((resolve) => upstream.close(resolve));
    assert.equal(await roundTrip(localPort, 'nobody').catch(() => ''), '');
    assert.ok(await connects(localPort));
  } finally {
    upstream.close();
    await closeAllForwards();
  }
  assert.ok(!(await connects(localPort)));
});
