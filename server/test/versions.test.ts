import { TOKEN } from './helpers.js';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';

const { buildServer } = await import('../src/http/server.js');
const { waitForIdle } = await import('../src/engine/engine.js');
const { diff, diffLines } = await import('../src/diff.js');
const { db } = await import('../src/db.js');
const { startHistoryOfOlderWorkflows, getWorkflow } = await import('../src/store/workflows.js');
const { listVersions } = await import('../src/store/versions.js');

let app: FastifyInstance;
const auth = { authorization: `Bearer ${TOKEN}` };
const yaml = { ...auth, 'content-type': 'application/yaml' };

const definition = (command: string) => ({ steps: [{ id: 'echo', type: 'shell', with: { command } }] });

before(async () => {
  app = await buildServer();
});
after(() => app.close());

async function call(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, headers: Record<string, string> = auth) {
  const response = await app.inject({ method, url: `/api${url}`, headers, payload: payload as any });
  assert.ok(response.statusCode < 300, `${method} ${url}: ${response.statusCode} ${response.body}`);
  return response.headers['content-type']?.includes('json') ? response.json() : response.body;
}

test('the line diff keeps shared lines and marks the rest', () => {
  assert.deepEqual(
    diffLines('a\nb\nc\n', 'a\nx\nc\nd\n').map((line) => `${line.kind[0]} ${line.text}`),
    ['s a', 'r b', 'a x', 's c', 'a d'],
  );
  const long = Array.from({ length: 40 }, (_, index) => `line ${index}`);
  const changed = [...long];
  changed[5] = 'changed 5';
  changed[30] = 'changed 30';
  const result = diff(long.join('\n'), changed.join('\n'));
  assert.equal(result.added, 2);
  assert.equal(result.removed, 2);
  assert.equal(result.hunks.length, 2, 'changes far apart are separate hunks');
  assert.equal(result.hunks[0].lines.length, 8, 'three lines of context on each side');
  assert.deepEqual(diff('same', 'same').hunks, []);
});

test('every save that changes a workflow adds a version, and runs record theirs', async () => {
  const created = await call('POST', '/workflows', { name: 'Versioned', definition: definition('echo one'), message: 'First draft' });
  assert.equal(created.version, 1);

  const run1 = await call('POST', `/workflows/${created.id}/run`, {});
  await waitForIdle();
  assert.equal(run1.workflowVersion, 1);

  const second = await call('PUT', `/workflows/${created.id}`, { name: 'Versioned', definition: definition('echo two'), message: 'Say two' });
  assert.equal(second.version, 2);
  const unchanged = await call('PUT', `/workflows/${created.id}`, { name: 'Versioned', definition: definition('echo two') });
  assert.equal(unchanged.version, 2, 'a save without changes keeps the version');

  await call('POST', `/workflows/${created.id}/run`, {});
  await call('POST', `/workflows/${created.id}/run`, {});
  await waitForIdle();
  assert.equal((await call('GET', `/runs?workflowId=${created.id}`))[0].workflowVersion, 2);

  const history = await call('GET', `/workflows/${created.id}/versions`);
  assert.deepEqual(
    history.map((version: any) => [version.version, version.source, version.message, version.runs]),
    [
      [2, 'edited', 'Say two', 2],
      [1, 'created', 'First draft', 1],
    ],
  );
  assert.equal(history[0].definition, undefined, 'the list leaves out definitions');

  const one = await call('GET', `/workflows/${created.id}/versions/1`);
  assert.equal(one.definition.steps[0].with.command, 'echo one');
  assert.match(await call('GET', `/workflows/${created.id}/versions/1/formula`), /echo one/);

  const changes = await call('GET', `/workflows/${created.id}/versions/2/diff`);
  assert.equal(changes.from, 1);
  assert.equal(changes.to, 2);
  const changed = changes.hunks.flatMap((hunk: any) => hunk.lines).filter((line: any) => line.kind !== 'same');
  assert.deepEqual(
    changed.map((line: any) => `${line.kind} ${line.text.trim()}`),
    ['removed command: echo one', 'added command: echo two'],
  );
  const first = await call('GET', `/workflows/${created.id}/versions/1/diff`);
  assert.equal(first.from, 0, 'the first version is compared with nothing');
  assert.equal(first.removed, 0);
});

test('restoring an old version adds a new version with its content', async () => {
  const workflow = await call('POST', '/workflows', { name: 'Rollback', definition: definition('echo good') });
  await call('PUT', `/workflows/${workflow.id}`, { name: 'Rollback', definition: definition('echo broken') });

  const restored = await call('POST', `/workflows/${workflow.id}/versions/1/restore`, {});
  assert.equal(restored.version, 3);
  assert.equal(restored.definition.steps[0].with.command, 'echo good');
  const [latest] = await call('GET', `/workflows/${workflow.id}/versions`);
  assert.deepEqual([latest.source, latest.restoredFrom, latest.message], ['restored', 1, 'Restored version 1']);

  const again = await app.inject({ method: 'POST', url: `/api/workflows/${workflow.id}/versions/3/restore`, headers: auth, payload: {} });
  assert.equal(again.statusCode, 409, 'the current version cannot be restored onto itself');
  assert.equal((await app.inject({ url: `/api/workflows/${workflow.id}/versions/99`, headers: auth })).statusCode, 404);
});

test('a formula with history recreates the versions on a fresh import', async () => {
  const workflow = await call('POST', '/workflows', { name: 'Travels', definition: definition('echo v1'), message: 'Start' });
  await call('PUT', `/workflows/${workflow.id}`, { name: 'Travels', definition: definition('echo v2'), message: 'Second' });
  await call('PUT', `/workflows/${workflow.id}`, { name: 'Travels', definition: definition('echo v3') });

  const plain = await call('GET', `/workflows/${workflow.id}/formula`);
  assert.match(plain, /version: 3/);
  assert.doesNotMatch(plain, /history:/);

  const formula: string = await call('GET', `/workflows/${workflow.id}/formula?history=true`);
  assert.match(formula, /history:/);
  // Import it as a different workflow, as if on a new deployment.
  const copy = await call('POST', '/formulas/import', formula.replaceAll('name: Travels', 'name: Travels copy'), yaml);
  assert.equal(copy.version, 3);
  assert.equal(copy.definition.steps[0].with.command, 'echo v3');
  const history = await call('GET', `/workflows/${copy.id}/versions`);
  assert.deepEqual(
    history.map((version: any) => [version.version, version.source, version.message]),
    [
      [3, 'imported', 'Imported from a formula'],
      [2, 'edited', 'Second'],
      [1, 'created', 'Start'],
    ],
  );
  assert.equal((await call('GET', `/workflows/${copy.id}/versions/1`)).definition.steps[0].with.command, 'echo v1');

  // Importing into an existing workflow keeps its own history and adds one version.
  const changed = formula.replace('echo v3', 'echo v4');
  const updated = await call('POST', '/formulas/import', changed, yaml);
  assert.equal(updated.id, workflow.id);
  assert.equal(updated.version, 4);
  assert.equal((await call('GET', `/workflows/${workflow.id}/versions`)).length, 4);

  const parsed = await call('POST', '/formulas/parse', { formula });
  assert.equal(parsed.history, undefined, 'the editor gets the workflow only');
});

test('workflows from before versions existed get their current state as version 1', async () => {
  const workflow = await call('POST', '/workflows', { name: 'Older', definition: definition('echo old') });
  db.prepare('UPDATE workflows SET version = 0 WHERE id = ?').run(workflow.id);
  db.prepare('DELETE FROM workflow_versions WHERE workflow_id = ?').run(workflow.id);

  startHistoryOfOlderWorkflows();
  assert.equal(getWorkflow(workflow.id)!.version, 1);
  assert.deepEqual(
    listVersions(workflow.id).map((version) => [version.version, version.source]),
    [[1, 'created']],
  );
});
