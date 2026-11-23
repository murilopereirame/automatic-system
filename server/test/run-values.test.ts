import './helpers.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyEnvironment, type StepConfig } from '../src/types.js';

const engine = await import('../src/engine/engine.js');
const runs = await import('../src/store/runs.js');
const { createWorkflow } = await import('../src/store/workflows.js');
const { listValues, withoutValue, withValue } = await import('../src/run-values.js');

const workflowWith = (steps: StepConfig[]) => createWorkflow({ name: `values-${Math.random()}`, definition: { triggers: [], environment: emptyEnvironment(), notifications: [], steps } });
const outputOf = (runId: string, stepId: string) => (runs.getRun(runId)!.context.steps[stepId]?.output as any)?.output as string;

test('dotted names nest, and removing the last value of a group removes the group', () => {
  let vars = withValue(undefined, 'staging.url', 'https://staging.example.com');
  vars = withValue(vars, 'staging.user', 'qa');
  vars = withValue(vars, 'ticket', 42);
  assert.deepEqual(vars, { staging: { url: 'https://staging.example.com', user: 'qa' }, ticket: 42 });
  assert.deepEqual(listValues(vars), [
    ['staging.url', 'https://staging.example.com'],
    ['staging.user', 'qa'],
    ['ticket', 42],
  ]);

  const once = withoutValue(vars, 'staging.url');
  assert.deepEqual(once.vars, { staging: { user: 'qa' }, ticket: 42 });
  assert.equal(withoutValue(vars, 'missing.name').removed, false);
  assert.deepEqual(withoutValue(once.vars, 'staging.user').vars, { ticket: 42 });
  assert.deepEqual(vars.staging, { url: 'https://staging.example.com', user: 'qa' }, 'the object passed in is not changed');
});

test('names and values are checked', () => {
  assert.throws(() => withValue({}, 'bad-name', 1), /not a valid name/);
  assert.throws(() => withValue({}, 'a.__proto__', 1), /reserved/);
  assert.throws(() => withValue({}, 'ok', undefined), /value is required/);
  assert.throws(() => withValue({}, 'big', 'x'.repeat(70_000)), /larger than 64 KB/);
});

test('a value added while the run waits is read by the blocks after the approval', async () => {
  const workflow = workflowWith([
    { id: 'deploy', type: 'approval', with: { message: 'Deploy to staging, then add its URL' } },
    { id: 'check', type: 'shell', if: "vars.staging.url != null", with: { command: 'echo "testing {{vars.staging.url}} as {{vars.user}}"' } },
  ]);
  const run = engine.startRun(workflow, {});
  await engine.waitForIdle();
  assert.equal(runs.getRun(run.id)!.status, 'waiting');

  engine.setRunValue(run.id, 'staging.url', 'https://pr-12.staging.example.com');
  engine.setRunValue(run.id, 'user', 'first');
  engine.setRunValue(run.id, 'user', 'qa-bot');
  const [approval] = runs.listApprovals({ runId: run.id, status: 'pending' });
  engine.resolveApproval(approval.id, 'approved', '');
  await engine.waitForIdle();

  assert.equal(runs.getRun(run.id)!.status, 'succeeded');
  assert.match(outputOf(run.id, 'check'), /testing https:\/\/pr-12\.staging\.example\.com as qa-bot/);
  const events = runs.listEvents(run.id).filter((event) => event.type === 'value_set');
  assert.deepEqual(
    events.map((event) => [event.data.name, event.data.replaced, event.data.atStep]),
    [
      ['staging.url', false, 'deploy'],
      ['user', false, 'deploy'],
      ['user', true, 'deploy'],
    ],
  );
  assert.throws(() => engine.setRunValue(run.id, 'late', 1), /has finished/);
});

test('a value added while a block runs reaches the next block, not the running one', async () => {
  const workflow = workflowWith([
    { id: 'slow', type: 'shell', with: { command: 'sleep 0.5; echo "slow saw [{{vars.note}}]"' } },
    { id: 'next', type: 'shell', with: { command: 'echo "next saw [{{vars.note}}]"' } },
  ]);
  const run = engine.startRun(workflow, {});
  await new Promise((resolve) => setTimeout(resolve, 150));
  engine.setRunValue(run.id, 'note', 'hello');
  await engine.waitForIdle();

  const done = runs.getRun(run.id)!;
  assert.equal(done.status, 'succeeded');
  assert.match(outputOf(run.id, 'slow'), /slow saw \[\]/);
  assert.match(outputOf(run.id, 'next'), /next saw \[hello\]/);
  assert.deepEqual(done.context.vars, { note: 'hello' }, 'the loop saving the run kept the value');
});

test('a value can be removed again, and a failed run picks values up on retry', async () => {
  const workflow = workflowWith([{ id: 'needs', type: 'shell', with: { command: 'test -n "{{vars.token}}" && echo "got {{vars.token}}"' } }]);
  const run = engine.startRun(workflow, {});
  await engine.waitForIdle();
  assert.equal(runs.getRun(run.id)!.status, 'failed');

  engine.setRunValue(run.id, 'token', 'abc');
  engine.setRunValue(run.id, 'extra', true);
  engine.removeRunValue(run.id, 'extra');
  assert.throws(() => engine.removeRunValue(run.id, 'extra'), /no value named "extra"/);
  engine.retryRun(run.id);
  await engine.waitForIdle();

  assert.equal(runs.getRun(run.id)!.status, 'succeeded');
  assert.match(outputOf(run.id, 'needs'), /got abc/);
  assert.deepEqual(runs.getRun(run.id)!.context.vars, { token: 'abc' });
});

test('a cleaned-up run takes no more values', async () => {
  const run = engine.startRun(workflowWith([{ id: 'broken', type: 'shell', with: { command: 'exit 1' } }]), {});
  await engine.waitForIdle();
  await engine.cleanUpRun(run.id, 'manual');
  assert.throws(() => engine.setRunValue(run.id, 'late', 1), /cleaned up/);
});
