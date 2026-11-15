import './helpers.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const { parseFormula, toFormula } = await import('../src/formula.js');

const example = readFileSync(path.join(import.meta.dirname, '../../examples/clickup-to-pr.formula.yaml'), 'utf8');

test('the example formula is valid and survives an export/import round trip', () => {
  const input = parseFormula(example);
  assert.equal(input.definition.trigger.type, 'clickup');
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
