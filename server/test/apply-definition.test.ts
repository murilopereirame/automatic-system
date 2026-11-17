import { TOKEN } from './helpers.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { emptyEnvironment, type StepConfig, type Workflow, type WorkflowDefinition } from '../src/types.js';

const engine = await import('../src/engine/engine.js');
const runs = await import('../src/store/runs.js');
const { createWorkflow, updateWorkflow } = await import('../src/store/workflows.js');
const { mapPosition, planApply } = await import('../src/engine/apply-definition.js');
const { buildServer } = await import('../src/http/server.js');

const definitionWith = (steps: StepConfig[]): WorkflowDefinition => ({ triggers: [], environment: emptyEnvironment(), notifications: [], steps });
const shell = (id: string, command: string): StepConfig => ({ id, type: 'shell', with: { command } });
const workflowWith = (steps: StepConfig[]): Workflow => createWorkflow({ name: `apply-${Math.random()}`, definition: definitionWith(steps) });
const edit = (workflow: Workflow, steps: StepConfig[]) => updateWorkflow(workflow.id, { name: workflow.name, definition: definitionWith(steps) })!;
const outputOf = (runId: string, stepId: string) => String((runs.getRun(runId)!.context.steps[stepId]?.output as any)?.output ?? '');

// ---- The plan --------------------------------------------------------------

test('a run continues at the same block, or at the next one that still exists', () => {
  const ids = (...names: string[]) => names.map((id) => shell(id, 'true'));
  const before = ids('a', 'b', 'c', 'd');
  assert.equal(mapPosition(before, ids('x', 'a', 'b', 'c', 'd'), 2), 3, 'c moved one down');
  assert.equal(mapPosition(before, ids('a', 'b', 'd'), 2), 2, 'c was removed, d is next');
  assert.equal(mapPosition(before, ids('a', 'b', 'e'), 2), 2, 'c and d were removed: right after b');
  assert.equal(mapPosition(before, ids('a', 'b', 'c', 'd', 'e'), 4), 4, 'a finished run goes on with a block added at the end');
  assert.equal(mapPosition(before, ids('x', 'y'), 1), 0, 'nothing in common: from the start');
});

test('the plan says which changes the run will pick up and which it already passed', () => {
  const current = definitionWith([shell('a', 'echo a'), shell('b', 'echo b'), shell('c', 'echo c')]);
  const next = { ...definitionWith([shell('new-early', 'true'), shell('a', 'echo A'), shell('c', 'echo C'), shell('new-late', 'true')]), notifications: [{ name: 'chat', url: 'http://x' }] };
  const plan = planApply(current, next, 1);

  assert.equal(plan.upToDate, false);
  assert.equal(plan.continueAt, 'c');
  assert.equal(plan.currentRemoved, true);
  assert.deepEqual(plan.sections, ['notifications']);
  assert.deepEqual(
    plan.blocks.map(({ id, kind, where }) => `${id} ${kind} ${where}`),
    ['new-early added behind', 'a changed behind', 'c changed ahead', 'new-late added ahead', 'b removed ahead'],
  );
  assert.equal(planApply(current, current, 1).upToDate, true);
});

// ---- Runs ------------------------------------------------------------------

test('a failed run picks up the fixed block on retry, and finished blocks do not run again', async () => {
  const workflow = workflowWith([shell('setup', 'echo ran >> count.txt'), shell('broken', 'exit 1')]);
  const run = engine.startRun(workflow, {});
  await engine.waitForIdle();
  assert.equal(runs.getRun(run.id)!.status, 'failed');

  const fixed = edit(workflow, [shell('setup', 'echo changed >> count.txt'), shell('broken', 'echo fixed'), shell('extra', 'echo extra')]);
  const { plan, deferred } = engine.applyDefinition(run.id, fixed.definition);
  assert.equal(deferred, false);
  assert.equal(plan.continueAt, 'broken');
  assert.equal(runs.getRun(run.id)!.status, 'failed', 'applying does not restart the run on its own');

  engine.retryRun(run.id);
  await engine.waitForIdle();
  const done = runs.getRun(run.id)!;
  assert.equal(done.status, 'succeeded');
  assert.match(outputOf(run.id, 'broken'), /fixed/);
  assert.match(outputOf(run.id, 'extra'), /extra/);
  assert.equal(readFileSync(path.join(done.workspace, 'count.txt'), 'utf8'), 'ran\n', 'the finished block kept its result and did not run again');
  assert.ok(runs.listEvents(run.id).some((event) => event.type === 'definition_applied'));
});

test('a waiting run uses the edited blocks after the approval', async () => {
  const workflow = workflowWith([{ id: 'gate', type: 'approval', with: { message: 'ok?' } }, shell('after', 'echo old')]);
  const run = engine.startRun(workflow, {});
  await engine.waitForIdle();

  engine.applyDefinition(run.id, edit(workflow, [{ id: 'gate', type: 'approval', with: { message: 'ok?' } }, shell('after', 'echo new')]).definition);
  assert.equal(runs.getRun(run.id)!.status, 'waiting');
  const [approval] = runs.listApprovals({ runId: run.id, status: 'pending' });
  engine.resolveApproval(approval.id, 'approved', '');
  await engine.waitForIdle();
  assert.equal(runs.getRun(run.id)!.status, 'succeeded');
  assert.match(outputOf(run.id, 'after'), /new/);
});

test('a run waiting at a block that was removed stops waiting and continues', async () => {
  const workflow = workflowWith([{ id: 'gate', type: 'approval', with: { message: 'ok?' } }, shell('after', 'echo after')]);
  const run = engine.startRun(workflow, {});
  await engine.waitForIdle();

  engine.applyDefinition(run.id, edit(workflow, [shell('after', 'echo after')]).definition);
  await engine.waitForIdle();
  assert.equal(runs.getRun(run.id)!.status, 'succeeded');
  assert.deepEqual(runs.listApprovals({ runId: run.id, status: 'pending' }), []);
});

test('a running block finishes as it was, and the edits apply from the next block', async () => {
  const workflow = workflowWith([shell('slow', 'sleep 0.5; echo slow-old'), shell('next', 'echo next-old')]);
  const run = engine.startRun(workflow, {});
  await new Promise((resolve) => setTimeout(resolve, 200));

  const { deferred } = engine.applyDefinition(run.id, edit(workflow, [shell('slow', 'echo slow-new'), shell('next', 'echo next-new'), shell('added', 'echo added')]).definition);
  assert.equal(deferred, true);
  await engine.waitForIdle();
  assert.equal(runs.getRun(run.id)!.status, 'succeeded');
  assert.match(outputOf(run.id, 'slow'), /slow-old/);
  assert.match(outputOf(run.id, 'next'), /next-new/);
  assert.match(outputOf(run.id, 'added'), /added/);
});

test('a finished run cannot change its definition', async () => {
  const workflow = workflowWith([shell('only', 'true')]);
  const run = engine.startRun(workflow, {});
  await engine.waitForIdle();
  assert.throws(() => engine.applyDefinition(run.id, definitionWith([shell('other', 'true')])), /has finished/);
});

// ---- API -------------------------------------------------------------------

let app: FastifyInstance;
const auth = { authorization: `Bearer ${TOKEN}` };
before(async () => {
  app = await buildServer();
});
after(() => app.close());

test('the API reports outdated runs, previews the change and applies it to one or all runs', async () => {
  const steps = [{ id: 'gate', type: 'approval', with: { message: 'ok?' } }, shell('after', 'echo old')];
  const workflow = (await app.inject({ method: 'POST', url: '/api/workflows', headers: auth, payload: { name: 'Apply API', definition: { triggers: [], steps } } })).json();
  const start = async () => (await app.inject({ method: 'POST', url: `/api/workflows/${workflow.id}/run`, headers: auth, payload: {} })).json();
  const [first, second] = [await start(), await start()];
  await engine.waitForIdle();
  const detail = async (id: string) => (await app.inject({ url: `/api/runs/${id}`, headers: auth })).json();
  assert.equal((await detail(first.id)).outdated, false);

  const edited = { triggers: [], steps: [steps[0], shell('after', 'echo new')] };
  await app.inject({ method: 'PUT', url: `/api/workflows/${workflow.id}`, headers: auth, payload: { name: 'Apply API', definition: edited } });
  assert.equal((await detail(first.id)).outdated, true);
  assert.equal((await app.inject({ url: `/api/workflows/${workflow.id}/outdated-runs`, headers: auth })).json().length, 2);

  const preview = (await app.inject({ url: `/api/runs/${first.id}/apply-latest`, headers: auth })).json();
  assert.deepEqual(preview.blocks, [{ id: 'after', name: 'after', kind: 'changed', where: 'ahead' }]);
  assert.equal((await detail(first.id)).outdated, true, 'the preview changes nothing');

  assert.equal((await app.inject({ method: 'POST', url: `/api/runs/${first.id}/apply-latest`, headers: auth })).statusCode, 200);
  assert.equal((await detail(first.id)).outdated, false);
  assert.equal((await detail(first.id)).run.workflowVersion, 2, 'the run now records the version it was switched to');
  assert.equal((await detail(second.id)).run.workflowVersion, 1);
  const applied = (await app.inject({ method: 'POST', url: `/api/workflows/${workflow.id}/apply-to-runs`, headers: auth })).json();
  assert.deepEqual(applied, [{ runId: second.id, deferred: false }]);
  assert.equal((await app.inject({ url: `/api/workflows/${workflow.id}/outdated-runs`, headers: auth })).json().length, 0);
});
