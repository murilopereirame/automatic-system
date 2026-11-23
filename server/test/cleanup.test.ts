import './helpers.js';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { emptyEnvironment, type CleanupWhen, type StepConfig, type Workflow } from '../src/types.js';

const engine = await import('../src/engine/engine.js');
const runs = await import('../src/store/runs.js');
const { createWorkflow } = await import('../src/store/workflows.js');
const { claudeConfigDir } = await import('../src/sandbox/agent.js');
const { claudeProjectName } = await import('../src/engine/cleanup.js');
const { parseFormula, toFormula } = await import('../src/formula.js');

function workflowWith(steps: StepConfig[], when?: CleanupWhen): Workflow {
  return createWorkflow({
    name: `cleanup-${Math.random()}`,
    definition: { triggers: [], environment: emptyEnvironment(), notifications: [], steps, ...(when && { cleanup: { when } }) },
  });
}

async function runToRest(workflow: Workflow) {
  const run = engine.startRun(workflow, {});
  await engine.waitForIdle();
  return runs.getRun(run.id)!;
}

/** Puts conversation files where Claude Code would keep them for the run's workspace, a repository in it, and another folder. */
function fakeClaudeFiles(workflowId: string, workspace: string) {
  const projects = path.join(claudeConfigDir(workflowId), 'projects');
  const own = [workspace, path.join(workspace, 'repo')].map((dir) => path.join(projects, claudeProjectName(dir)));
  const other = path.join(projects, claudeProjectName('/somewhere/else'));
  for (const dir of [...own, other]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'session-1.jsonl'), '{}\n');
  }
  const todo = path.join(claudeConfigDir(workflowId), 'todos', 'session-1-agent-session-1.json');
  mkdirSync(path.dirname(todo), { recursive: true });
  writeFileSync(todo, '[]');
  return { own: [...own, todo], other };
}

const writesFiles: StepConfig[] = [
  { id: 'files', type: 'shell', with: { command: 'mkdir -p repo/locked && echo hi > repo/locked/file && chmod a-w repo/locked' } },
  { id: 'claude', type: 'claude', with: { prompt: 'Work' } },
];

test('a workflow set to clean up after success deletes the workspace and the Claude conversation of the run', async () => {
  const workflow = workflowWith(writesFiles, 'succeeded');
  // The Claude config directory of the workflow is known before the run, so the files can be put there first.
  const run = engine.startRun(workflow, {});
  const claude = fakeClaudeFiles(workflow.id, run.workspace);
  await engine.waitForIdle();

  const cleaned = runs.getRun(run.id)!;
  assert.equal(cleaned.status, 'succeeded');
  assert.ok(cleaned.cleanedAt, 'the run records when it was cleaned');
  assert.ok(!existsSync(run.workspace), 'the workspace, including the read-only folder, is gone');
  for (const file of claude.own) assert.ok(!existsSync(file), `${file} is gone`);
  assert.ok(existsSync(claude.other), 'conversations of other folders stay');

  const event = runs.listEvents(run.id).find((candidate) => candidate.type === 'workspace_cleaned')!;
  assert.equal(event.data.reason, 'automatic');
  assert.ok((event.data.removed as string[]).includes(run.workspace));
});

test('"succeeded" keeps the files of a failed run, so it can be retried', async () => {
  const run = await runToRest(workflowWith([{ id: 'fail', type: 'shell', with: { command: 'touch kept && exit 1' } }], 'succeeded'));
  assert.equal(run.status, 'failed');
  assert.equal(run.cleanedAt, undefined);
  assert.ok(existsSync(path.join(run.workspace, 'kept')));
});

test('"finished" also cleans up failed runs, which then cannot be retried', async () => {
  const run = await runToRest(workflowWith([{ id: 'fail', type: 'shell', with: { command: 'touch gone && exit 1' } }], 'finished'));
  assert.equal(run.status, 'failed');
  assert.ok(run.cleanedAt);
  assert.ok(!existsSync(run.workspace));
  assert.throws(() => engine.retryRun(run.id), /cleaned up/);
  assert.throws(() => engine.skipStep(run.id), /cleaned up/);
});

test('without a cleanup setting the files stay until someone cleans up by hand', async () => {
  const run = await runToRest(workflowWith([{ id: 'touch', type: 'shell', with: { command: 'touch result' } }]));
  assert.equal(run.cleanedAt, undefined);
  assert.ok(existsSync(path.join(run.workspace, 'result')));

  await engine.cleanUpRun(run.id, 'manual');
  assert.ok(!existsSync(run.workspace));
  assert.ok(runs.getRun(run.id)!.cleanedAt);
  assert.equal(runs.listEvents(run.id).find((event) => event.type === 'workspace_cleaned')!.data.reason, 'manual');
  // Cleaning again is harmless.
  await engine.cleanUpRun(run.id, 'manual');
});

test('a run that is waiting for a person cannot be cleaned up', async () => {
  const run = await runToRest(workflowWith([{ id: 'review', type: 'approval', with: { message: 'Look' } }], 'finished'));
  assert.equal(run.status, 'waiting');
  await assert.rejects(engine.cleanUpRun(run.id, 'manual'), /has ended/);
  assert.ok(existsSync(run.workspace));

  // Cancelling ends it, and the "finished" setting then cleans it up.
  engine.cancelRun(run.id);
  await engine.waitForIdle();
  assert.ok(runs.getRun(run.id)!.cleanedAt);
  assert.ok(!existsSync(run.workspace));
});

test('cleaning up ended runs in bulk skips the ones still going and the ones already clean', async () => {
  const done = await runToRest(workflowWith([{ id: 'touch', type: 'shell', with: { command: 'touch x' } }]));
  const waiting = await runToRest(workflowWith([{ id: 'review', type: 'approval', with: { message: 'Look' } }]));
  const cleaned = await engine.cleanUpEndedRuns();
  assert.ok(cleaned >= 1);
  assert.ok(runs.getRun(done.id)!.cleanedAt);
  assert.equal(runs.getRun(waiting.id)!.cleanedAt, undefined);
  assert.equal(await engine.cleanUpEndedRuns(), 0);
  engine.cancelRun(waiting.id);
});

test('the cleanup setting is part of the formula', () => {
  const workflow = workflowWith([], 'succeeded');
  const formula = toFormula(workflow);
  assert.match(formula, /cleanup:\n {2}when: succeeded/);
  assert.deepEqual(parseFormula(formula).definition.cleanup, { when: 'succeeded' });

  // Formulas from before the setting existed keep their files.
  const old = formula.replace(/cleanup:\n {2}when: succeeded\n/, '');
  assert.deepEqual(parseFormula(old).definition.cleanup, { when: 'never' });
  assert.throws(() => parseFormula(formula.replace('when: succeeded', 'when: sometimes')), /cleanup.when must be one of never, succeeded, finished/);
});

test('cleanup refuses a workspace outside the workspaces directory', async () => {
  const run = await runToRest(workflowWith([]));
  const { removeRunFiles } = await import('../src/engine/cleanup.js');
  await assert.rejects(removeRunFiles({ ...run, workspace: '/' }), /not inside/);
  await assert.rejects(removeRunFiles({ ...run, workspace: path.join(run.workspace, '../..') }), /not inside/);
});
