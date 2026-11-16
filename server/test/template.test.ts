import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderDeep, renderString } from '../src/template.js';

const scope = { trigger: { task: { id: 'abc', name: 'Fix login' } }, steps: { build: { output: { passed: true, files: ['a'] } } } };

test('renders dotted paths', () => {
  assert.equal(renderString('Task {{trigger.task.name}} ({{ trigger.task.id }})', scope), 'Task Fix login (abc)');
});

test('renders missing values as empty text and objects as JSON', () => {
  assert.equal(renderString('[{{trigger.nope.deeper}}]', scope), '[]');
  assert.equal(renderString('{{steps.build.output}}', scope), '{"passed":true,"files":["a"]}');
});

test('renders strings nested in settings and leaves other values alone', () => {
  assert.deepEqual(renderDeep({ a: '{{trigger.task.id}}', b: 3, c: ['{{trigger.task.name}}'], d: true }, scope), {
    a: 'abc',
    b: 3,
    c: ['Fix login'],
    d: true,
  });
});

test('filters prepare values for JSON bodies and URLs', () => {
  const message = { message: 'He said "hi" & left\n' };
  assert.equal(renderString('{"text": {{message | json}}}', message), '{"text": "He said \\"hi\\" & left\\n"}');
  assert.equal(renderString('https://example.com/?q={{message|url}}', message), 'https://example.com/?q=He%20said%20%22hi%22%20%26%20left%0A');
  assert.equal(renderString('{{missing | json}}', message), '""');
  assert.throws(() => renderString('{{message | shout}}', message), /Unknown template filter "shout"/);
});

test('evaluates {{= expressions }} and leaves other braces alone', () => {
  assert.equal(renderString("Tests {{= steps.build.output.passed ? 'passed' : 'failed' }}, {{=1+1}} files", scope), 'Tests passed, 2 files');
  assert.equal(renderString("{{= trigger.nope || trigger.task.name | json }}", scope), '"Fix login"');
  assert.equal(renderString('{{= steps.build.output.files }} ${{ a b }} {{ a b }}', scope), '["a"] ${{ a b }} {{ a b }}');
  assert.throws(() => renderString('{{= trigger.task.name == }}', scope), /Expected a value/);
});

test('the slug filter makes text safe for a branch name', () => {
  const scope = { task: { id: '86a8y386n', name: "Bank Reconciliation: allow 'REVERSE & RE-POST' of transactions in a Saved Reconciliation" } };
  assert.equal(renderString('{{task.id}}-{{task.name | slug}}', scope), '86a8y386n-bank-reconciliation-allow-reverse-re-post-of');
  assert.equal(renderString('{{name | slug}}', { name: '  Ação rápida — já!  ' }), 'acao-rapida-ja');
  assert.equal(renderString('{{name | slug}}', { name: 'x'.repeat(60) }), 'x'.repeat(48));
  assert.equal(renderString('{{missing | slug}}', {}), '');
  assert.equal(renderString("{{= 'Fix the login page!' | slug }}", {}), 'fix-the-login-page');
});
