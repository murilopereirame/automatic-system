import { TOKEN, waitFor } from './helpers.js';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';

const { applyInputs, parseInputs } = await import('../src/inputs.js');
const { parseFormula, toFormula } = await import('../src/formula.js');
const { buildServer } = await import('../src/http/server.js');
const { waitForIdle } = await import('../src/engine/engine.js');

const declared = [
  { name: 'task.id', label: 'Task id', type: 'text', required: true },
  { name: 'task.priority', type: 'select', options: ['low', 'high'], default: 'low' },
  { name: 'attempts', type: 'number', default: 2 },
  { name: 'dryRun', type: 'boolean' },
  { name: 'extra', type: 'json' },
];

test('input declarations are validated', () => {
  assert.deepEqual(parseInputs(undefined), []);
  assert.deepEqual(parseInputs(declared), declared);
  assert.deepEqual(parseInputs([{ name: 'branch' }]), [{ name: 'branch', type: 'text' }]);

  assert.throws(() => parseInputs([{ name: 'not a name' }]), /needs a name/);
  assert.throws(() => parseInputs([{ name: 'a.__proto__.b' }]), /reserved/);
  assert.throws(() => parseInputs([{ name: 'a' }, { name: 'a' }]), /more than once/);
  assert.throws(() => parseInputs([{ name: 'task' }, { name: 'task.id' }]), /overlaps/);
  assert.throws(() => parseInputs([{ name: 'a', type: 'date' }]), /unknown type/);
  assert.throws(() => parseInputs([{ name: 'a', type: 'select' }]), /options/);
  assert.throws(() => parseInputs([{ name: 'a', type: 'number', default: 'many' }]), /default/);
});

test('values become a nested payload, with types and defaults applied', () => {
  const inputs = parseInputs(declared);
  assert.deepEqual(applyInputs(inputs, { task: { id: 'abc' }, attempts: '5', dryRun: 'true', extra: { tags: ['x'] }, other: 1 }), {
    task: { id: 'abc', priority: 'low' },
    attempts: 5,
    dryRun: true,
    extra: { tags: ['x'] },
    other: 1,
  });
  assert.deepEqual(applyInputs(inputs, { task: { id: 7, priority: 'high' }, attempts: '' }), { task: { id: '7', priority: 'high' }, attempts: 2 });

  assert.throws(() => applyInputs(inputs, {}), /"task.id" is required/);
  assert.throws(() => applyInputs(inputs, { task: { id: '' } }), /"task.id" is required/);
  assert.throws(() => applyInputs(inputs, { task: { id: 'a', priority: 'urgent' } }), /one of: low, high/);
  assert.throws(() => applyInputs(inputs, { task: { id: 'a' }, attempts: 'x' }), /must be a number/);
  assert.throws(() => applyInputs(inputs, { task: { id: 'a' }, dryRun: 'maybe' }), /true or false/);
});

test('inputs are part of the formula, and formulas without them still import', () => {
  const formula = (inputs: string) => `apiVersion: autoworker/v1\nkind: Formula\nmetadata: { name: With inputs }\n${inputs}steps: []\n`;

  assert.deepEqual(parseFormula(formula('')).definition.inputs, []);

  const input = parseFormula(formula('inputs:\n  - { name: task.id, required: true }\n  - { name: env, type: select, options: [staging, production], default: staging }\n'));
  assert.deepEqual(input.definition.inputs, [
    { name: 'task.id', type: 'text', required: true },
    { name: 'env', type: 'select', options: ['staging', 'production'], default: 'staging' },
  ]);
  const exported = toFormula({ ...input, id: 'w', description: '', enabled: true, hookSecret: '', createdAt: '', updatedAt: '' });
  assert.deepEqual(parseFormula(exported).definition.inputs, input.definition.inputs);

  assert.throws(() => parseFormula(formula('inputs: [{ name: "1bad" }]\n')), /Invalid workflow: input "1bad"/);
});

let app: FastifyInstance;
const auth = { authorization: `Bearer ${TOKEN}` };
before(async () => {
  app = await buildServer();
});
after(() => app.close());

test('"Run now" checks the inputs and passes them to the run as the trigger payload', async () => {
  const definition = {
    inputs: [
      { name: 'task.id', required: true },
      { name: 'attempts', type: 'number', default: 3 },
    ],
    steps: [{ id: 'echo', type: 'shell', with: { command: 'echo "task={{trigger.task.id}} attempts={{= trigger.attempts + 1 }}"' } }],
  };
  const created = await app.inject({ method: 'POST', url: '/api/workflows', headers: auth, payload: { name: 'Asks for inputs', definition } });
  assert.equal(created.statusCode, 200);
  const runUrl = `/api/workflows/${created.json().id}/run`;

  const refused = await app.inject({ method: 'POST', url: runUrl, headers: auth, payload: {} });
  assert.equal(refused.statusCode, 400);
  assert.match(refused.json().error, /"task.id" is required/);

  const started = await app.inject({ method: 'POST', url: runUrl, headers: auth, payload: { task: { id: 'abc123' } } });
  assert.equal(started.statusCode, 200);
  assert.deepEqual(started.json().context.trigger, { source: 'manual', task: { id: 'abc123' }, attempts: 3 });

  await waitForIdle();
  const detail = await waitFor(() => {
    const report = app.inject({ url: `/api/runs/${started.json().id}`, headers: auth });
    return report;
  });
  const report = (await detail).json();
  assert.equal(report.run.status, 'succeeded');
  assert.match(JSON.stringify(report.run.context.steps.echo.output), /task=abc123 attempts=4/);
});
