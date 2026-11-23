import { TOKEN } from './helpers.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { emptyEnvironment, type StepConfig, type Workflow } from '../src/types.js';

const engine = await import('../src/engine/engine.js');
const runs = await import('../src/store/runs.js');
const { createWorkflow } = await import('../src/store/workflows.js');
const { buildServer } = await import('../src/http/server.js');

function workflowWith(steps: StepConfig[]): Workflow {
  return createWorkflow({ name: `pause-${Math.random()}`, definition: { triggers: [], environment: emptyEnvironment(), notifications: [], steps } });
}

async function startAndWait(workflow: Workflow, trigger = {}) {
  const run = engine.startRun(workflow, trigger);
  await engine.waitForIdle();
  return runs.getRun(run.id)!;
}

const pendingOf = (runId: string) => runs.listApprovals({ runId, status: 'pending' });
const promptsSent = (workspace: string) => readFileSync(path.join(workspace, 'claude-output.txt'), 'utf8').trim().split('\n');

test('a block with pauseBefore waits before it starts and shows the rendered prompt', async () => {
  const workflow = workflowWith([
    { id: 'first', type: 'shell', with: { command: 'echo hi' } },
    { id: 'implement', type: 'claude', pauseBefore: true, with: { prompt: 'Implement {{trigger.task}}' } },
  ]);
  const run = await startAndWait(workflow, { task: 'dark mode' });

  assert.equal(run.status, 'waiting');
  assert.equal(run.stepIndex, 1);
  assert.ok(run.context.steps.first, 'the block before it ran');
  assert.equal(run.context.steps.implement, undefined, 'the paused block has not started');
  const [approval] = pendingOf(run.id);
  assert.equal(approval.kind, 'before_step');
  assert.equal(approval.data.prompt, 'Implement dark mode');
  assert.equal(approval.data.source, 'workflow');
});

test('running the paused block with an edited prompt sends that prompt once', async () => {
  const workflow = workflowWith([
    { id: 'implement', type: 'claude', pauseBefore: true, with: { prompt: 'Original prompt' } },
    { id: 'check', type: 'condition', with: { expression: 'run.id == "never"', then: '', else: 'implement', maxRepeats: '1' } },
  ]);
  let run = await startAndWait(workflow);
  let [approval] = pendingOf(run.id);
  engine.resolveApproval(approval.id, 'approved', '', { prompt: 'Edited prompt' });
  await engine.waitForIdle();

  run = runs.getRun(run.id)!;
  assert.equal(run.status, 'waiting', 'the condition went back and the block paused again');
  assert.deepEqual(promptsSent(run.workspace), ['Edited prompt']);
  assert.equal(run.context.promptOnce?.implement, undefined, 'the edited prompt was used up');
  [approval] = pendingOf(run.id);
  assert.equal(approval.data.prompt, 'Original prompt', 'the second start shows the workflow prompt again');

  engine.resolveApproval(approval.id, 'approved', '');
  await engine.waitForIdle();
  run = runs.getRun(run.id)!;
  assert.equal(run.status, 'failed', 'the condition ran out of repeats');
  assert.deepEqual(promptsSent(run.workspace), ['Edited prompt', 'Original prompt']);
  const logged = runs.listEvents(run.id).filter((event) => event.type === 'claude_prompt').map((event) => event.data.source);
  assert.deepEqual(logged, ['edited before run', 'workflow']);
});

test('rejecting the pause stops the run, and an empty edited prompt is refused', async () => {
  const run = await startAndWait(workflowWith([{ id: 'implement', type: 'claude', pauseBefore: true, with: { prompt: 'Go' } }]));
  const [approval] = pendingOf(run.id);
  assert.throws(() => engine.resolveApproval(approval.id, 'approved', '', { prompt: '  ' }), /cannot be empty/);
  assert.equal(pendingOf(run.id).length, 1, 'a refused answer leaves the pause open');

  engine.resolveApproval(approval.id, 'rejected', 'not now');
  const stopped = runs.getRun(run.id)!;
  assert.equal(stopped.status, 'cancelled');
  assert.match(stopped.error!, /Stopped before "implement": not now/);
});

test('pauseBefore works on any block, and retry pauses again', async () => {
  const workflow = workflowWith([{ id: 'deploy', type: 'shell', pauseBefore: true, with: { command: 'exit 1' } }]);
  let run = await startAndWait(workflow);
  let [approval] = pendingOf(run.id);
  assert.deepEqual(approval.data, {});
  engine.resolveApproval(approval.id, 'approved', '');
  await engine.waitForIdle();
  run = runs.getRun(run.id)!;
  assert.equal(run.status, 'failed');

  engine.retryRun(run.id);
  await engine.waitForIdle();
  run = runs.getRun(run.id)!;
  assert.equal(run.status, 'waiting', 'a retry asks again before the block runs');
});

test('a prompt set for a later block is used every time it starts, as a template, until cleared', async () => {
  const workflow = workflowWith([
    { id: 'gate', type: 'approval', with: { message: 'ok?' } },
    { id: 'implement', type: 'claude', with: { prompt: 'Workflow prompt' } },
  ]);
  let run = await startAndWait(workflow, { task: 'search' });
  engine.setPromptOverride(run.id, 'implement', 'Build {{trigger.task}} instead');
  const [approval] = pendingOf(run.id);
  engine.resolveApproval(approval.id, 'approved', '');
  await engine.waitForIdle();

  run = runs.getRun(run.id)!;
  assert.equal(run.status, 'succeeded');
  assert.deepEqual(promptsSent(run.workspace), ['Build search instead']);
  assert.equal(run.context.promptOverrides?.implement, 'Build {{trigger.task}} instead');
  assert.throws(() => engine.setPromptOverride(run.id, 'implement', null), /finished/);
});

test('the pause shows a prompt set on the run page, and clearing it brings back the workflow prompt', async () => {
  const workflow = workflowWith([
    { id: 'gate', type: 'approval', with: { message: 'ok?' } },
    { id: 'implement', type: 'claude', pauseBefore: true, with: { prompt: 'Workflow prompt' } },
  ]);
  let run = await startAndWait(workflow);
  assert.throws(() => engine.setPromptOverride(run.id, 'gate', 'x'), /Only "Run Claude" blocks/);
  assert.throws(() => engine.setPromptOverride(run.id, 'missing', 'x'), /no block "missing"/);
  engine.setPromptOverride(run.id, 'implement', 'Run page prompt');
  engine.resolveApproval(pendingOf(run.id)[0].id, 'approved', '');
  await engine.waitForIdle();

  let [pause] = pendingOf(run.id);
  assert.equal(pause.data.prompt, 'Run page prompt');
  assert.equal(pause.data.source, 'edited for this run');

  engine.cancelRun(run.id);
  engine.setPromptOverride(run.id, 'implement', null);
  engine.retryRun(run.id);
  await engine.waitForIdle();
  [pause] = pendingOf(run.id);
  assert.equal(pause.data.prompt, 'Workflow prompt');
});

test('API: edit a prompt, and answer a pause with an edited prompt', async () => {
  const app = await buildServer();
  const headers = { authorization: `Bearer ${TOKEN}` };
  const run = await startAndWait(workflowWith([{ id: 'implement', type: 'claude', pauseBefore: true, with: { prompt: 'Go' } }]));

  const set = await app.inject({ method: 'PUT', url: `/api/runs/${run.id}/prompts/implement`, headers, payload: { prompt: 'From the API' } });
  assert.equal(set.statusCode, 200);
  assert.equal(set.json().context.promptOverrides.implement, 'From the API');
  const wrong = await app.inject({ method: 'PUT', url: `/api/runs/${run.id}/prompts/nope`, headers, payload: { prompt: 'x' } });
  assert.equal(wrong.statusCode, 409);
  const cleared = await app.inject({ method: 'DELETE', url: `/api/runs/${run.id}/prompts/implement`, headers });
  assert.equal(cleared.json().context.promptOverrides.implement, undefined);

  const [approval] = pendingOf(run.id);
  const detail = await app.inject({ method: 'GET', url: `/api/runs/${run.id}`, headers });
  assert.equal(detail.json().approvals[0].kind, 'before_step');
  const answered = await app.inject({ method: 'POST', url: `/api/approvals/${approval.id}/resolve`, headers, payload: { decision: 'approved', prompt: 'Answered prompt' } });
  assert.equal(answered.statusCode, 200);
  await engine.waitForIdle();
  const finished = runs.getRun(run.id)!;
  assert.equal(finished.status, 'succeeded');
  assert.deepEqual(promptsSent(finished.workspace), ['Answered prompt']);
  await app.close();
});

test('formulas keep pauseBefore', async () => {
  const { parseDefinition } = await import('../src/formula.js');
  const definition = parseDefinition({ steps: [{ id: 'a', type: 'claude', pauseBefore: true, with: { prompt: 'x' } }, { id: 'b', type: 'shell', with: { command: 'true' } }] });
  assert.equal(definition.steps[0].pauseBefore, true);
  assert.equal('pauseBefore' in definition.steps[1], false);
});

test('a prompt set while an earlier block runs is not lost when the engine saves the run', async () => {
  const workflow = workflowWith([
    { id: 'slow', type: 'shell', with: { command: 'sleep 0.5' } },
    { id: 'implement', type: 'claude', with: { prompt: 'Workflow prompt' } },
  ]);
  const started = engine.startRun(workflow, {});
  await new Promise((resolve) => setTimeout(resolve, 150));
  engine.setPromptOverride(started.id, 'implement', 'Set while running');
  await engine.waitForIdle();
  const run = runs.getRun(started.id)!;
  assert.equal(run.status, 'succeeded');
  assert.deepEqual(promptsSent(run.workspace), ['Set while running']);
});
