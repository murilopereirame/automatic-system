import { TOKEN } from './helpers.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';

const { buildServer } = await import('../src/http/server.js');
const { waitForIdle } = await import('../src/engine/engine.js');
const { config } = await import('../src/config.js');
const runs = await import('../src/store/runs.js');

let app: FastifyInstance;
const auth = { authorization: `Bearer ${TOKEN}` };

before(async () => {
  app = await buildServer();
  await app.listen({ port: 0, host: '127.0.0.1' });
});
after(() => app.close());

/** Creates a workflow from `steps` through the API, runs it and waits until it stops. */
async function runSteps(steps: unknown[]) {
  const definition = { triggers: [], steps };
  const workflow = (await app.inject({ method: 'POST', url: '/api/workflows', headers: auth, payload: { name: `outputs-${Math.random()}`, definition } })).json();
  const started = (await app.inject({ method: 'POST', url: `/api/workflows/${workflow.id}/run`, headers: auth, payload: {} })).json();
  await waitForIdle();
  return runs.getRun(started.id)!;
}

const listing = async (runId: string) => (await app.inject({ url: `/api/runs/${runId}/outputs`, headers: auth })).json();
const download = (runId: string, file: string) => app.inject({ url: `/api/runs/${runId}/outputs/file?path=${encodeURIComponent(file)}`, headers: auth });

test('commands and Claude write to an output folder outside the workspace, which survives removing the workspace', async () => {
  const run = await runSteps([
    { id: 'report', type: 'shell', with: { command: 'mkdir -p "$AUTOWORKER_OUTPUT_DIR/reports" && echo "all green" > "$AUTOWORKER_OUTPUT_DIR/reports/tests.txt"' } },
    { id: 'claude', type: 'claude', with: { prompt: 'Take a screenshot' } },
    { id: 'where', type: 'shell', with: { command: 'echo "dir={{run.outputDir}}"' } },
  ]);
  assert.equal(run.status, 'succeeded', run.error);

  const outputDir = path.join(config.outputsDir, run.id);
  assert.match((run.context.steps.where.output as any).output, new RegExp(`dir=${outputDir}`), 'templates can name the folder');
  assert.ok(!outputDir.startsWith(run.workspace + path.sep) && !outputDir.startsWith(config.workspacesDir), 'the output folder is not part of any workspace');

  const notes = readFileSync(path.join(outputDir, 'claude-notes.md'), 'utf8');
  assert.match(notes, new RegExp(`output folder ${outputDir}`), 'Claude is told where the output folder is');

  // What a workspace cleanup does: the outputs are still there afterwards.
  rmSync(run.workspace, { recursive: true, force: true });
  const { dir, files, truncated } = await listing(run.id);
  assert.equal(dir, outputDir);
  assert.equal(truncated, false);
  assert.deepEqual(files.map((file: any) => file.path).sort(), ['claude-notes.md', 'reports/tests.txt']);
  assert.equal(files.find((file: any) => file.path === 'reports/tests.txt').size, 'all green\n'.length);
});

test('a Claude block can leave the output folder out of its system prompt', async () => {
  const run = await runSteps([{ id: 'claude', type: 'claude', with: { prompt: 'Just code', mentionOutputDir: false } }]);
  assert.equal(run.status, 'succeeded', run.error);
  assert.deepEqual((await listing(run.id)).files, []);
});

test('output files download as attachments, and only files that are in the folder', async () => {
  const run = await runSteps([{ id: 'write', type: 'shell', with: { command: 'printf "<script>alert(1)</script>" > "$AUTOWORKER_OUTPUT_DIR/report é.html"' } }]);
  const response = await download(run.id, 'report é.html');
  assert.equal(response.statusCode, 200);
  assert.equal(response.body, '<script>alert(1)</script>');
  assert.equal(response.headers['content-type'], 'application/octet-stream', 'never rendered as a page of the app');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.match(String(response.headers['content-disposition']), /^attachment; filename="report _.html"; filename\*=UTF-8''report%20%C3%A9.html$/);

  for (const outside of ['../../data/autoworker.db', '/etc/passwd', '', 'missing.txt']) {
    assert.equal((await download(run.id, outside)).statusCode, 404, outside);
  }
  assert.equal((await app.inject({ url: '/api/runs/not-a-run/outputs', headers: auth })).statusCode, 404);
  assert.equal((await app.inject({ url: `/api/runs/${run.id}/outputs` })).statusCode, 401, 'downloads need a signed-in user');
});

test('a symbolic link in the output folder is neither listed nor followed', async () => {
  const secretDir = mkdtempSync(path.join(tmpdir(), 'outside-'));
  writeFileSync(path.join(secretDir, 'secret.txt'), 'top secret');
  const run = await runSteps([
    { id: 'link', type: 'shell', with: { command: `ln -s ${secretDir}/secret.txt "$AUTOWORKER_OUTPUT_DIR/secret.txt" && ln -s ${secretDir} "$AUTOWORKER_OUTPUT_DIR/dir" && echo ok > "$AUTOWORKER_OUTPUT_DIR/real.txt"` } },
  ]);
  assert.deepEqual((await listing(run.id)).files.map((file: any) => file.path), ['real.txt']);
  assert.equal((await download(run.id, 'secret.txt')).statusCode, 404);
  assert.equal((await download(run.id, 'dir/secret.txt')).statusCode, 404);
});

test('the whole output folder downloads as a tar.gz archive', async () => {
  const run = await runSteps([{ id: 'write', type: 'shell', with: { command: 'mkdir -p "$AUTOWORKER_OUTPUT_DIR/a" && echo one > "$AUTOWORKER_OUTPUT_DIR/a/one.txt"' } }]);
  const response = await app.inject({ url: `/api/runs/${run.id}/outputs/archive`, headers: auth });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-type'], 'application/gzip');
  assert.match(String(response.headers['content-disposition']), /attachment; filename="run-.{8}-outputs\.tar\.gz"/);

  const extracted = mkdtempSync(path.join(tmpdir(), 'archive-'));
  writeFileSync(path.join(extracted, 'outputs.tar.gz'), response.rawPayload);
  execFileSync('tar', ['-xzf', 'outputs.tar.gz'], { cwd: extracted });
  assert.equal(readFileSync(path.join(extracted, 'a/one.txt'), 'utf8'), 'one\n');
});

test('runs from before output folders existed list an empty folder', async () => {
  const run = await runSteps([{ id: 'noop', type: 'shell', with: { command: 'true' } }]);
  rmSync(path.join(config.outputsDir, run.id), { recursive: true });
  assert.ok(!existsSync(path.join(config.outputsDir, run.id)));
  assert.deepEqual((await listing(run.id)).files, []);
});

test('cleaning up a run deletes its workspace but keeps its output files', async () => {
  const { removeRunFiles } = await import('../src/engine/cleanup.js');
  const run = await runSteps([{ id: 'write', type: 'shell', with: { command: 'echo kept > "$AUTOWORKER_OUTPUT_DIR/kept.txt"' } }]);
  const removed = await removeRunFiles(run);
  assert.ok(removed.includes(run.workspace) && !existsSync(run.workspace), 'the workspace is gone');
  assert.ok(!removed.some((file) => file.startsWith(config.outputsDir)));
  assert.deepEqual((await listing(run.id)).files.map((file: any) => file.path), ['kept.txt']);
});
