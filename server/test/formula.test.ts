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

test('the full-stack example is valid, and every template expression in it parses', async () => {
  const { checkExpression } = await import('../src/expression.js');
  const { renderDeep } = await import('../src/template.js');
  const { SCOPE_NAMES } = await import('../src/types.js');
  const source = readFileSync(path.join(import.meta.dirname, '../../examples/task-to-pull-requests.formula.yaml'), 'utf8');
  const { definition } = parseFormula(source);

  const clones = definition.steps.filter((step) => step.type === 'git_clone').map((step) => step.with.path);
  assert.deepEqual(clones, ['backend', 'frontend']);
  const pullRequests = definition.steps.filter((step) => step.type === 'github_pr').map((step) => step.with.repo);
  assert.deepEqual(pullRequests, ['backend', 'frontend', 'backend', 'frontend']);

  for (const step of definition.steps) {
    for (const value of Object.values(step.with)) {
      if (typeof value !== 'string') continue;
      for (const [, source] of value.matchAll(/\{\{=(.+?)\}\}/gs)) {
        const expression = source.replace(/(?<!\|)\|(?!\|)\s*\w+\s*$/, '');
        assert.doesNotThrow(() => checkExpression(expression, SCOPE_NAMES), `step ${step.id}: ${expression}`);
      }
    }
    // Renders against an empty run without unknown filters or errors.
    assert.doesNotThrow(() => renderDeep(step.with, { trigger: {}, steps: {}, run: { id: 'r1' } }), `step ${step.id}`);
  }
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

test('reads conditions and checks them on import', () => {
  const formula = (steps: string) => parseFormula(`apiVersion: autoworker/v1\nkind: Formula\nmetadata: { name: x }\nsteps:\n${steps}`).definition.steps;
  const steps = formula(`  - { id: tests, type: shell, with: { command: npm test, continueOnError: true } }
  - { id: check, type: condition, with: { expression: steps.tests.output.passed, then: done, else: $end } }
  - { id: done, type: notify, if: "trigger.task.priority == 'urgent'", with: { message: ok } }`);
  assert.equal(steps[2].if, "trigger.task.priority == 'urgent'");
  assert.equal('if' in steps[0], false, 'blocks without a condition have no "if" key');
  assert.deepEqual(steps[1].with, { expression: 'steps.tests.output.passed', then: 'done', else: '$end' });

  assert.throws(() => formula('  - { id: a, type: shell, if: "trigger.x ==" }'), /"if" of step "a": Expected a value/);
  assert.throws(() => formula('  - { id: a, type: shell, if: "task.name" }'), /Unknown name "task". Available: trigger, triggeredBy, steps, previous, run, repo/);
  assert.throws(() => formula('  - { id: a, type: condition, with: { expression: "steps.a = 1" } }'), /"expression" of step "a": Unexpected "="/);
  assert.throws(() => formula('  - { id: a, type: condition, with: { expression: "true", then: nowhere } }'), /names "nowhere", which is not a step/);
  assert.throws(() => formula('  - { id: a, type: condition, with: { expression: "true", else: a } }'), /points at the step itself/);
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
