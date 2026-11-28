/**
 * Markdown from Claude is untrusted: these tests render it to HTML the way the browser would get it
 * and check that formatting comes through while scripts, handlers, bad links and images do not.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown, safeUrl } from '../src/components/Markdown.tsx';

const render = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

test('renders headings, lists, code, tables and task lists', () => {
  const html = render(['## Plan', '', '1. **Read** the task', '2. Change `api.ts`', '', '- [x] done', '- [ ] todo', '', '| a | b |', '| - | - |', '| 1 | 2 |', '', '```ts', 'const x = 1;', '```'].join('\n'));
  assert.match(html, /<h2>Plan<\/h2>/);
  assert.match(html, /<ol>\s*<li><strong>Read<\/strong> the task<\/li>/);
  assert.match(html, /<code>api\.ts<\/code>/);
  assert.match(html, /<table>/);
  assert.match(html, /type="checkbox"[^>]*checked=""[^>]*disabled=""|type="checkbox"[^>]*disabled=""[^>]*checked=""/);
  assert.match(html, /<pre><code class="hl language-ts"><span class="hl-keyword">const<\/span> x = <span class="hl-number">1<\/span>;\n<\/code><\/pre>/);
});

test('code in a language that is not bundled stays plain, and highlighting adds no markup from the text', () => {
  const html = render(['```cobol', 'DISPLAY "<b>hi</b>".', '```', '', '```json', '{"a": "<img src=x onerror=alert(1)>"}', '```'].join('\n'));
  assert.match(html, /<code class="hl language-cobol">DISPLAY &quot;&lt;b&gt;hi&lt;\/b&gt;&quot;\.\n<\/code>/);
  assert.doesNotMatch(html, /<img|<b>/);
});

test('raw HTML is shown as text, never as elements', () => {
  const html = render('Hello <script>alert(1)</script> <img src=x onerror="alert(2)"> <a href="javascript:alert(3)">x</a>\n\n<iframe src="https://evil.example"></iframe>');
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<img/i);
  assert.doesNotMatch(html, /<iframe/i);
  assert.doesNotMatch(html, /<a [^>]*javascript:/i);
  assert.match(html, /&lt;script&gt;/);
});

test('links keep only safe schemes and open in a new tab without a referrer', () => {
  const html = render('[ok](https://example.com/a?b=1) [mail](mailto:me@example.com) [js](javascript:alert(1)) [JS](JaVaScRiPt:alert(1)) [data](data:text/html,<b>x</b>) [vb](vbscript:x) [rel](/api/secrets) [spaced]( javascript:alert(1))');
  assert.match(html, /<a href="https:\/\/example\.com\/a\?b=1" target="_blank" rel="noopener noreferrer nofollow">ok<\/a>/);
  assert.match(html, /href="mailto:me@example\.com"/);
  assert.doesNotMatch(html, /javascript:/i);
  assert.doesNotMatch(html, /href="data:/);
  assert.doesNotMatch(html, /vbscript:/);
  assert.doesNotMatch(html, /href="\/api/);
  // Refused links keep their words, so nothing the person should read goes missing.
  assert.match(html, /<span class="md-dead-link">js<\/span>/);
});

test('images are not loaded; they become links the person can choose to open', () => {
  const html = render('![diagram](https://tracker.example/pixel.png?secret=abc) ![bad](javascript:alert(1))');
  assert.doesNotMatch(html, /<img/i);
  assert.match(html, /<a class="md-image" href="https:\/\/tracker\.example\/pixel\.png\?secret=abc"[^>]*>\[image: diagram\]<\/a>/);
  assert.match(html, /<span class="md-image">\[bad\]<\/span>/);
});

test('safeUrl', () => {
  assert.equal(safeUrl('https://a.example'), 'https://a.example');
  assert.equal(safeUrl('#section'), '#section');
  assert.equal(safeUrl('java\tscript:alert(1)'), '');
  assert.equal(safeUrl('//evil.example'), '');
  assert.equal(safeUrl('relative/path'), '');
});
