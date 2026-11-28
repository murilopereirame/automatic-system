/** The notification preview (web/src/notifications/preview.ts) and code highlighting (web/src/code/highlight.ts). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NotificationWebhook } from '../src/api.ts';
import { highlightTree } from '../src/code/highlight.ts';
import { matchOptions } from '../src/components/MultiSelect.tsx';
import { previewWebhook, splitSecrets } from '../src/notifications/preview.ts';

const options = { workflowName: 'Deploy', event: 'approval' as const, origin: 'https://worker.example', inputs: [{ name: 'task.priority', type: 'text' as const, label: 'Priority' }] };
const webhook = (changes: Partial<NotificationWebhook>): NotificationWebhook => ({ name: 'ntfy', url: '', method: 'POST', headers: {}, body: '', ...changes });

test('fills in the default body with example values, as the server would send it', () => {
  const result = previewWebhook(webhook({ url: 'https://ntfy.sh/alerts' }), options);
  assert.ok('request' in result);
  assert.equal(result.request.method, 'POST');
  assert.deepEqual(JSON.parse(result.request.body!), { title: 'Deploy: your action is needed', message: 'The implementation is ready. Deploy the branch to staging, then approve.', url: 'https://worker.example/#/runs/3f2a9c1e-example' });
  assert.equal(result.bodyIsJson, true);
});

test('uses the run inputs as trigger values and never puts secret values in', () => {
  const result = previewWebhook(webhook({ url: 'https://ntfy.sh/{{secrets.NTFY_TOPIC | url}}', headers: { Authorization: 'Bearer {{secrets.TOKEN}}' }, body: '{{trigger.task.name}} ({{trigger.task.priority}})' }), options);
  assert.ok('request' in result);
  assert.deepEqual(splitSecrets(result.request.url), [{ text: 'https://ntfy.sh/' }, { secret: 'NTFY_TOPIC' }]);
  assert.deepEqual(splitSecrets(result.request.headers.Authorization), [{ text: 'Bearer ' }, { secret: 'TOKEN' }]);
  assert.equal(result.request.body, 'Example task (<Priority>)');
  assert.equal(result.bodyIsJson, false, 'a JSON content type with a body that is not JSON is flagged');
});

test('GET sends no body, and a template error is reported instead of thrown', () => {
  const get = previewWebhook(webhook({ method: 'GET', url: 'https://x.example/?m={{message | url}}' }), { ...options, event: 'failed' });
  assert.ok('request' in get);
  assert.equal(get.request.body, undefined);
  assert.match(get.request.url, /m=Command%20failed/);
  const broken = previewWebhook(webhook({ body: '{{message | nope}}' }), options);
  assert.ok('error' in broken);
  assert.match(broken.error, /Unknown template filter/);
});

test('highlights known languages and leaves unknown or huge text plain', () => {
  const tree = highlightTree('{"a": 1}', 'json');
  assert.ok(tree && JSON.stringify(tree).includes('hl-attr'));
  assert.ok(highlightTree('name: x', 'yml'), 'aliases work');
  assert.equal(highlightTree('x', 'brainfuck'), undefined);
  assert.equal(highlightTree('x', undefined), undefined);
  assert.equal(highlightTree('a'.repeat(60_000), 'json'), undefined);
});

test('the multiselect search matches anywhere in the name, ignoring case', () => {
  const all = [{ value: 'GITHUB_TOKEN' }, { value: 'CLICKUP_TOKEN' }, { value: 'NTFY_TOPIC' }];
  assert.deepEqual(matchOptions(all, ' token').map((option) => option.value), ['GITHUB_TOKEN', 'CLICKUP_TOKEN']);
  assert.equal(matchOptions(all, '').length, 3);
});
