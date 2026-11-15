/** Notifications: webhook calls defined in the workflow, with templated URL, headers and body. */
import { mockApi } from './helpers.js';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { emptyEnvironment, type NotificationWebhook, type StepConfig } from '../src/types.js';

const receiver = await mockApi(() => ({}));
after(() => receiver.close());

const engine = await import('../src/engine/engine.js');
const runs = await import('../src/store/runs.js');
const { createWorkflow } = await import('../src/store/workflows.js');
const { setSecret } = await import('../src/store/secrets.js');
const { parseFormula, toFormula } = await import('../src/formula.js');

setSecret('CHAT_TOKEN', 'tok/123');

async function run(notifications: NotificationWebhook[], steps: StepConfig[], trigger = {}) {
  const definition = { trigger: { type: 'manual', with: {} }, environment: emptyEnvironment(), notifications, steps };
  const workflow = createWorkflow({ name: `notify-${Math.random()}`, definition });
  const started = engine.startRun(workflow, trigger);
  await engine.waitForIdle();
  await new Promise((resolve) => setTimeout(resolve, 100)); // Automatic notifications are sent in the background.
  return { workflow, run: runs.getRun(started.id)! };
}

test('variables can be used in the URL, the headers and the body', async () => {
  receiver.requests.length = 0;
  const webhook: NotificationWebhook = {
    name: 'chat',
    url: `${receiver.url}/bot{{secrets.CHAT_TOKEN | url}}/send?task={{trigger.task.id}}`,
    headers: { 'X-Workflow': '{{workflow.name}}' },
    body: '{"text": {{message | json}}, "run": "{{run.id}}"}',
  };
  const { run: finished, workflow } = await run(
    [webhook],
    [{ id: 'tell', type: 'notify', with: { message: 'Picked up "{{trigger.task.name}}"' } }],
    { task: { id: 't1', name: 'Fix login' } },
  );

  assert.equal(finished.status, 'succeeded');
  assert.deepEqual((finished.context.steps.tell.output as any).delivered, ['chat']);
  const [request] = receiver.requests;
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/bottok%2F123/send?task=t1');
  assert.equal(request.headers['x-workflow'], workflow.name);
  assert.deepEqual(request.body, { text: 'Picked up "Fix login"', run: finished.id });
});

test('approvals and failures notify automatically, with a default body', async () => {
  receiver.requests.length = 0;
  const webhooks = [{ name: 'default', url: `${receiver.url}/default` }];
  await run(webhooks, [{ id: 'gate', type: 'approval', with: { message: 'Deploy to staging please' } }]);
  await run(webhooks, [{ id: 'boom', type: 'shell', with: { command: 'exit 3' } }]);

  const [approval, failure] = receiver.requests.map((request) => request.body);
  assert.match(approval.title, /your action is needed/);
  assert.equal(approval.message, 'Deploy to staging please');
  assert.match(failure.title, /run failed/);
});

test('a notify block can target one webhook, and a broken webhook does not fail the run', async () => {
  receiver.requests.length = 0;
  const webhooks = [
    { name: 'a', url: `${receiver.url}/a` },
    { name: 'b', url: `${receiver.url}/b` },
    { name: 'down', url: 'http://127.0.0.1:1/unreachable' },
  ];
  const { run: finished } = await run(webhooks, [
    { id: 'one', type: 'notify', with: { message: 'only b', channel: 'b' } },
    { id: 'all', type: 'notify', with: { message: 'everyone' } },
  ]);

  assert.equal(finished.status, 'succeeded');
  assert.deepEqual(receiver.requests.map((request) => request.url), ['/b', '/a', '/b']);
  assert.deepEqual((finished.context.steps.all.output as any).delivered, ['a', 'b']);
});

test('notification webhooks are part of the formula', async () => {
  const webhook = { name: 'chat', url: 'https://example.com/{{secrets.CHAT_TOKEN}}', method: 'PUT', headers: { A: 'b' }, body: '{{message}}' };
  const { workflow } = await run([webhook], []);
  const formula = toFormula(workflow);
  assert.ok(!formula.includes('tok/123'), 'secret values stay out of the formula');
  assert.deepEqual(parseFormula(formula).definition.notifications, [webhook]);
});
