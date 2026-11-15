import './helpers.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { emptyEnvironment, type NotificationWebhook, type StepConfig, type Workflow } from '../src/types.js';

const engine = await import('../src/engine/engine.js');
const runs = await import('../src/store/runs.js');
const { createWorkflow } = await import('../src/store/workflows.js');
const { setSecret } = await import('../src/store/secrets.js');

function workflowWith(steps: StepConfig[], environment = emptyEnvironment(), notifications: NotificationWebhook[] = []): Workflow {
  return createWorkflow({ name: `test-${Math.random()}`, definition: { trigger: { type: 'manual', with: {} }, environment, notifications, steps } });
}

async function runToRest(workflow: Workflow, trigger = {}) {
  const run = engine.startRun(workflow, trigger);
  await engine.waitForIdle();
  return runs.getRun(run.id)!;
}

const eventTypes = (runId: string) => runs.listEvents(runId).map((event) => event.type);

test('runs steps in order and passes outputs between them', async () => {
  const workflow = workflowWith([
    { id: 'hello', type: 'shell', with: { command: 'echo "task={{trigger.task.name}}"' } },
    { id: 'again', type: 'shell', with: { command: 'echo "exit was {{steps.hello.output.exitCode}}"' } },
  ]);
  const run = await runToRest(workflow, { task: { name: 'Fix login' } });

  assert.equal(run.status, 'succeeded');
  assert.match((run.context.steps.hello.output as any).output, /task=Fix login/);
  assert.match((run.context.steps.again.output as any).output, /exit was 0/);
  assert.deepEqual(eventTypes(run.id).filter((type) => type.startsWith('step_')), ['step_started', 'step_finished', 'step_started', 'step_finished']);
});

test('a failing step fails the run, and retry continues from that step', async () => {
  const marker = path.join(process.env.AUTOWORKER_DATA_DIR!, 'retry-marker');
  const workflow = workflowWith([
    { id: 'once', type: 'shell', with: { command: 'echo ran >> count.txt' } },
    { id: 'flaky', type: 'shell', with: { command: `test -e ${marker}` } },
  ]);
  const failed = await runToRest(workflow);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.stepIndex, 1);
  assert.match(failed.error!, /exit code 1/);

  await import('node:fs').then((fs) => fs.writeFileSync(marker, ''));
  engine.retryRun(failed.id);
  await engine.waitForIdle();
  const retried = runs.getRun(failed.id)!;
  assert.equal(retried.status, 'succeeded');
  assert.equal(readFileSync(path.join(retried.workspace, 'count.txt'), 'utf8'), 'ran\n', 'the first step must not run again');
});

test('Claude output is recorded and the session continues across steps', async () => {
  const workflow = workflowWith([
    { id: 'implement', type: 'claude', with: { prompt: 'Implement {{trigger.task.name}}' } },
    { id: 'polish', type: 'claude', with: { prompt: 'Polish it' } },
  ]);
  const run = await runToRest(workflow, { task: { name: 'dark mode' } });

  assert.equal(run.status, 'succeeded');
  assert.equal(run.context.claudeSessionId, 'session-1');
  assert.equal((run.context.steps.implement.output as any).result, 'Done');
  assert.equal((run.context.steps.polish.output as any).result, 'Done (resumed)');
  const types = eventTypes(run.id);
  for (const expected of ['claude_prompt', 'claude_text', 'claude_tool', 'claude_tool_result']) assert.ok(types.includes(expected), expected);
});

test('a Claude error fails the run with its message', async () => {
  const run = await runToRest(workflowWith([{ id: 'c', type: 'claude', with: { prompt: 'FAIL please' } }]));
  assert.equal(run.status, 'failed');
  assert.equal(run.error, 'Claude could not do it');
});

test('approval pauses the run; reject sends feedback back to Claude; approve continues', async () => {
  const workflow = workflowWith([
    { id: 'implement', type: 'claude', with: { prompt: 'Build the feature' } },
    { id: 'review', type: 'approval', with: { message: 'Deploy to staging and check', onReject: 'implement' } },
    { id: 'after', type: 'shell', with: { command: 'echo "decision={{steps.review.output.decision}}"' } },
  ]);
  let run = await runToRest(workflow);
  assert.equal(run.status, 'waiting');
  let [approval] = runs.listApprovals({ runId: run.id, status: 'pending' });
  assert.equal(approval.message, 'Deploy to staging and check');

  engine.resolveApproval(approval.id, 'rejected', 'The button is misaligned');
  await engine.waitForIdle();
  run = runs.getRun(run.id)!;
  assert.equal(run.status, 'waiting', 'after the rework the run waits for approval again');
  assert.match(readFileSync(path.join(run.workspace, 'claude-output.txt'), 'utf8'), /The button is misaligned/);

  [approval] = runs.listApprovals({ runId: run.id, status: 'pending' });
  engine.resolveApproval(approval.id, 'approved', '');
  await engine.waitForIdle();
  run = runs.getRun(run.id)!;
  assert.equal(run.status, 'succeeded');
  assert.match((run.context.steps.after.output as any).output, /decision=approved/);
  assert.throws(() => engine.resolveApproval(approval.id, 'approved', ''), /no longer pending/);
});

test('rejecting without a go-back step cancels the run', async () => {
  const run = await runToRest(workflowWith([{ id: 'gate', type: 'approval', with: { message: 'ok?' } }]));
  const [approval] = runs.listApprovals({ runId: run.id, status: 'pending' });
  engine.resolveApproval(approval.id, 'rejected', 'no');
  assert.equal(runs.getRun(run.id)!.status, 'cancelled');
});

test('cancelling stops a running command', async () => {
  const workflow = workflowWith([{ id: 'slow', type: 'shell', with: { command: 'sleep 30' } }]);
  const run = engine.startRun(workflow, {});
  await new Promise((resolve) => setTimeout(resolve, 300));
  engine.cancelRun(run.id);
  await engine.waitForIdle();
  assert.equal(runs.getRun(run.id)!.status, 'cancelled');
});

test('commands see formula variables and exposed secrets, but not the server environment', async () => {
  setSecret('EXPOSED', 'visible');
  setSecret('PRIVATE', 'hidden');
  const environment = { ...emptyEnvironment(), env: { GREETING: 'hi' }, secrets: ['EXPOSED'] };
  const workflow = workflowWith([{ id: 'env', type: 'shell', with: { command: 'env' } }], environment);
  const run = await runToRest(workflow);

  const output = (run.context.steps.env.output as any).output as string;
  assert.match(output, /GREETING=hi/);
  assert.match(output, /EXPOSED=visible/);
  assert.doesNotMatch(output, /hidden/);
  assert.doesNotMatch(output, /AUTOWORKER_TOKEN/);
});

test('memory files are written for Claude and read back for export', async () => {
  const { readMemory } = await import('../src/sandbox/environment.js');
  const { claudeConfigDir } = await import('../src/sandbox/agent.js');
  const environment = { ...emptyEnvironment(), memory: [{ path: 'CLAUDE.md', content: 'Use pnpm.' }] };
  const workflow = workflowWith([{ id: 'learn', type: 'shell', with: { command: 'echo "Tests need Redis." >> "$CLAUDE_CONFIG_DIR/CLAUDE.md"' } }], environment);
  await runToRest(workflow);

  assert.equal(claudeConfigDir(workflow.id).startsWith(process.env.AUTOWORKER_DATA_DIR!), true);
  assert.deepEqual(await readMemory(workflow), [{ path: 'CLAUDE.md', content: 'Use pnpm.Tests need Redis.\n' }]);
});

test('skills are written as SKILL.md files and exported with what was added on disk', async () => {
  const { readSkills } = await import('../src/sandbox/environment.js');
  const environment = { ...emptyEnvironment(), skills: [{ name: 'frontend-prompt', content: '---\nname: frontend-prompt\n---\nWrite the handoff.' }] };
  const addSkill = 'mkdir -p "$CLAUDE_CONFIG_DIR/skills/learned" && echo "New skill" > "$CLAUDE_CONFIG_DIR/skills/learned/SKILL.md" && cat "$CLAUDE_CONFIG_DIR/skills/frontend-prompt/SKILL.md"';
  const workflow = workflowWith([{ id: 'use', type: 'shell', with: { command: addSkill } }], environment);
  const run = await runToRest(workflow);

  assert.match((run.context.steps.use.output as any).output, /Write the handoff\./);
  assert.deepEqual(await readSkills(workflow), [
    { name: 'frontend-prompt', content: '---\nname: frontend-prompt\n---\nWrite the handoff.' },
    { name: 'learned', content: 'New skill\n' },
  ]);
});
