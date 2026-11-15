import { TOKEN, waitFor } from './helpers.js';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';

const { buildServer } = await import('../src/http/server.js');
const { waitForIdle } = await import('../src/engine/engine.js');

let app: FastifyInstance;
const auth = { authorization: `Bearer ${TOKEN}` };

const definition = {
  trigger: { type: 'webhook', with: {} },
  environment: { env: { STAGE: 'test' }, secrets: ['API_KEY'] },
  steps: [{ id: 'echo', type: 'shell', with: { command: 'echo "ref={{trigger.ref}}"' } }],
};

before(async () => {
  app = await buildServer();
  await app.listen({ port: 0, host: '127.0.0.1' });
});
after(() => app.close());

test('the API requires authentication', async () => {
  assert.equal((await app.inject({ url: '/api/workflows' })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/workflows', headers: { authorization: 'Bearer wrong' } })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/workflows', headers: auth })).statusCode, 200);
});

test('login sets a session cookie that grants access', async () => {
  const denied = await app.inject({ method: 'POST', url: '/api/login', payload: { token: 'nope' } });
  assert.equal(denied.statusCode, 401);

  const granted = await app.inject({ method: 'POST', url: '/api/login', payload: { token: TOKEN } });
  const cookie = String(granted.headers['set-cookie']).split(';')[0];
  assert.match(String(granted.headers['set-cookie']), /HttpOnly; SameSite=Strict/);
  assert.equal((await app.inject({ url: '/api/workflows', headers: { cookie } })).statusCode, 200);
});

test('secret values can be written but never read back', async () => {
  await app.inject({ method: 'PUT', url: '/api/secrets/API_KEY', headers: auth, payload: { value: 'super-secret' } });
  const listed = await app.inject({ url: '/api/secrets', headers: auth });
  assert.deepEqual(listed.json(), ['API_KEY']);
  assert.ok(!listed.body.includes('super-secret'));
  assert.equal((await app.inject({ method: 'PUT', url: '/api/secrets/bad-name', headers: auth, payload: { value: 'x' } })).statusCode, 400);
});

test('a workflow can be created, exported as a formula and imported again', async () => {
  const created = await app.inject({ method: 'POST', url: '/api/workflows', headers: auth, payload: { name: 'Roundtrip', definition } });
  assert.equal(created.statusCode, 200);
  const workflow = created.json();

  const formula = await app.inject({ url: `/api/workflows/${workflow.id}/formula`, headers: auth });
  assert.match(formula.body, /apiVersion: autoworker\/v1/);
  assert.match(formula.body, /STAGE: test/);
  assert.ok(!formula.body.includes('super-secret') && !formula.body.includes(workflow.hookSecret));

  const renamed = formula.body.replace('name: Roundtrip', 'name: Imported copy');
  const imported = await app.inject({ method: 'POST', url: '/api/formulas/import', headers: { ...auth, 'content-type': 'application/yaml' }, payload: renamed });
  assert.equal(imported.statusCode, 200);
  assert.deepEqual(imported.json().definition, workflow.definition);

  // Importing the same formula again updates the workflow instead of duplicating it.
  await app.inject({ method: 'POST', url: '/api/formulas/import', headers: { ...auth, 'content-type': 'application/yaml' }, payload: renamed });
  const names = (await app.inject({ url: '/api/workflows', headers: auth })).json().map((item: any) => item.name);
  assert.deepEqual(names.sort(), ['Imported copy', 'Roundtrip']);
});

test('invalid workflows are rejected with a helpful message', async () => {
  const bad = { ...definition, steps: [{ id: 'x', type: 'does_not_exist', with: {} }] };
  const response = await app.inject({ method: 'POST', url: '/api/workflows', headers: auth, payload: { name: 'Bad', definition: bad } });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /unknown type "does_not_exist"/);
});

test('a webhook starts a run only with the right secret', async () => {
  const workflow = (await app.inject({ method: 'POST', url: '/api/workflows', headers: auth, payload: { name: 'Hooked', definition } })).json();

  const denied = await app.inject({ method: 'POST', url: `/hooks/${workflow.id}?secret=wrong`, payload: { ref: 'main' } });
  assert.equal(denied.statusCode, 401);

  const accepted = await app.inject({ method: 'POST', url: `/hooks/${workflow.id}?secret=${workflow.hookSecret}`, payload: { ref: 'main' } });
  assert.equal(accepted.statusCode, 200);
  await waitForIdle();

  const [run] = (await app.inject({ url: `/api/runs?workflowId=${workflow.id}`, headers: auth })).json();
  assert.equal(run.status, 'succeeded');
  const detail = (await app.inject({ url: `/api/runs/${run.id}`, headers: auth })).json();
  assert.ok(detail.events.some((event: any) => event.type === 'output' && /ref=main/.test(event.data.text)));
});

test('approvals show up as pending and can be resolved through the API', async () => {
  const gated = { ...definition, trigger: { type: 'manual', with: {} }, steps: [{ id: 'gate', type: 'approval', with: { message: 'Ship it?' } }] };
  const workflow = (await app.inject({ method: 'POST', url: '/api/workflows', headers: auth, payload: { name: 'Gated', definition: gated } })).json();
  const run = (await app.inject({ method: 'POST', url: `/api/workflows/${workflow.id}/run`, headers: auth, payload: {} })).json();
  await waitForIdle();

  const pending = (await app.inject({ url: '/api/approvals?status=pending', headers: auth })).json();
  const approval = pending.find((item: any) => item.runId === run.id);
  assert.equal(approval.message, 'Ship it?');
  assert.equal(approval.workflowName, 'Gated');

  const resolved = await app.inject({ method: 'POST', url: `/api/approvals/${approval.id}/resolve`, headers: auth, payload: { decision: 'approved' } });
  assert.equal(resolved.statusCode, 200);
  await waitForIdle();
  assert.equal((await app.inject({ url: `/api/runs/${run.id}`, headers: auth })).json().run.status, 'succeeded');
});

test('the web shell runs commands as the agent and refuses anonymous connections', async () => {
  const address = app.server.address() as { port: number };
  const url = `ws://127.0.0.1:${address.port}/api/shell`;

  const anonymous = new WebSocket(url);
  const closeCode = await new Promise((resolve) => anonymous.on('close', resolve));
  assert.equal(closeCode, 4401);

  const shell = new WebSocket(url, { headers: auth });
  let output = '';
  shell.on('message', (data) => (output += data.toString()));
  await new Promise((resolve) => shell.on('open', resolve));
  shell.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
  shell.send(JSON.stringify({ type: 'input', data: 'echo shell-$((40+2)); echo home=$HOME\r' }));
  await waitFor(() => /shell-42/.test(output) && /home=.*agent-home/.test(output));
  assert.doesNotMatch(output, new RegExp(TOKEN));
  shell.close();
});
