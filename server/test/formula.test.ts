import './helpers.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const { parseFormula, toFormula } = await import('../src/formula.js');
const { createWorkflow, getWorkflow } = await import('../src/store/workflows.js');
const { db } = await import('../src/db.js');

const example = readFileSync(path.join(import.meta.dirname, '../../examples/clickup-to-pr.formula.yaml'), 'utf8');

test('the example formula is valid and survives an export/import round trip', () => {
  const input = parseFormula(example);
  assert.deepEqual(input.definition.triggers.map((trigger) => trigger.type), ['clickup', 'webhook']);
  assert.ok(input.definition.steps.length >= 6);

  const workflow = { ...input, id: 'w1', description: input.description ?? '', enabled: input.enabled ?? true, hookSecret: 'never-exported', createdAt: '', updatedAt: '' };
  const exported = toFormula(workflow);
  assert.ok(!exported.includes('never-exported'), 'the webhook secret must not be exported');
  assert.deepEqual(parseFormula(exported), input);
});

test('rejects documents that are not formulas', () => {
  assert.throws(() => parseFormula('kind: Deployment'), /Not a formula/);
  assert.throws(() => parseFormula('{ not yaml'), /not valid YAML/);
});

test('rejects unknown block types and duplicate ids', () => {
  const formula = (steps: string) => `apiVersion: autoworker/v1\nkind: Formula\nmetadata: { name: x }\nsteps:\n${steps}`;
  assert.throws(() => parseFormula(formula('  - { id: a, type: teleport }')), /unknown type "teleport"/);
  assert.throws(() => parseFormula(formula('  - { id: a, type: shell }\n  - { id: a, type: shell }')), /used more than once/);
});

const withTriggers = (yaml: string) => parseFormula(`apiVersion: autoworker/v1\nkind: Formula\nmetadata: { name: x }\n${yaml}`).definition.triggers;

test('reads several triggers and gives each an id', () => {
  const triggers = withTriggers('triggers:\n  - { type: clickup }\n  - { type: webhook }\n  - { type: clickup, with: { teamId: "9" } }\n  - { id: releases, type: webhook }');
  assert.deepEqual(triggers.map((trigger) => trigger.id), ['clickup', 'webhook', 'clickup_3', 'releases']);
  assert.throws(() => withTriggers('triggers:\n  - { id: a, type: webhook }\n  - { id: a, type: clickup }'), /trigger id "a" is used more than once/);
  assert.throws(() => withTriggers('triggers:\n  - { type: carrier_pigeon }'), /unknown trigger type/);
});

test('formulas with the older single trigger still import', () => {
  assert.deepEqual(withTriggers('trigger: { type: clickup, with: { mode: poll } }'), [{ id: 'clickup', type: 'clickup', with: { mode: 'poll' } }]);
  assert.deepEqual(withTriggers('trigger: { type: manual }'), [], 'manual meant "no trigger"');
  assert.deepEqual(withTriggers(''), []);
});

test('workflows stored with the older single trigger are read as a list', () => {
  const workflow = createWorkflow({ name: 'stored-old', definition: parseFormula(example).definition });
  const old = { ...workflow.definition, triggers: undefined, trigger: { type: 'webhook', with: {} } };
  db.prepare('UPDATE workflows SET definition = ? WHERE id = ?').run(JSON.stringify(old), workflow.id);
  assert.deepEqual(getWorkflow(workflow.id)!.definition.triggers, [{ id: 'webhook', type: 'webhook', with: {} }]);
});
