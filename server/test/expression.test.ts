import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkExpression, evaluate, parseExpression, truthy } from '../src/expression.js';

const scope = {
  trigger: { task: { name: 'Hotfix: login', priority: 'urgent', points: '8', tags: ['bug', 'backend'] } },
  steps: { tests: { output: { passed: false, exitCode: 2, output: '3 failed\n' } }, 'my-step': { output: 'x' } },
  previous: { output: { exitCode: 0 } },
  repo: undefined,
};
const value = (source: string) => evaluate(source, scope);

test('reads values from the trigger and from earlier blocks', () => {
  assert.equal(value('steps.tests.output.exitCode'), 2);
  assert.equal(value('previous.output.exitCode == 0'), true);
  assert.equal(value('trigger.task.tags[1]'), 'backend');
  assert.equal(value('trigger.task.tags.0'), 'bug');
  assert.equal(value('steps["my-step"].output'), 'x');
  assert.equal(value('trigger.nope.deeper'), null, 'missing values are null, not an error');
  assert.equal(value('repo.branch'), null, 'a name that is known but not set yet is null');
});

test('compares, with text that holds a number counting as that number', () => {
  assert.equal(value("trigger.task.priority == 'urgent'"), true);
  assert.equal(value('trigger.task.priority != "urgent"'), false);
  assert.equal(value('trigger.task.points > 5'), true);
  assert.equal(value("trigger.task.points == 8 && '10' > '9'"), true);
  assert.equal(value("'apple' < 'banana'"), true);
  assert.equal(value('trigger.nope == null'), true);
  assert.equal(value('trigger.nope > 1 || trigger.nope <= 1'), false, 'a missing value is neither bigger nor smaller');
  assert.equal(value("trigger.task.tags == ['bug', 'backend']"), true);
  assert.equal(value("true == 1 || false == ''"), false, 'true and false only equal themselves');
});

test('combines conditions and picks values', () => {
  assert.equal(value('!steps.tests.output.passed && steps.tests.output.exitCode >= 2'), true);
  assert.equal(value("steps.tests.output.passed ? 'ok' : 'failed'"), 'failed');
  assert.equal(value("trigger.nope || 'fallback'"), 'fallback');
  assert.equal(value('1 == 2 || 2 == 2 && !(3 < 2)'), true);
  assert.equal(value('steps.tests.output.passed && unknownFunction()'), false, 'the right side of && is not looked at when the left is false');
});

test('calculates', () => {
  assert.equal(value('1 + 2 * 3 - 4 / 2'), 5);
  assert.equal(value('(1 + 2) * -3 % 5'), -4);
  assert.equal(value("trigger.task.points * 2 + 'pt'"), '16pt');
  assert.throws(() => value("'abc' * 2"), /needs numbers/);
  assert.throws(() => value('1 / 0'), /Division by zero/);
});

test('has functions for text, lists and numbers', () => {
  assert.equal(value("contains(lower(trigger.task.name), 'hotfix')"), true);
  assert.equal(value("contains(trigger.task.tags, 'bug') && !contains(trigger.task.tags, 'ui')"), true);
  assert.equal(value("startsWith(trigger.task.name, 'Hotfix') && endsWith(upper(trigger.task.name), 'LOGIN')"), true);
  assert.equal(value('length(trigger.task.tags) + length(trim(steps.tests.output.output))'), 10);
  assert.equal(value("isEmpty(trigger.nope) && isEmpty('  ') && isEmpty([]) && !isEmpty(0)"), true);
  assert.equal(value("coalesce(trigger.nope, '', 'c')"), 'c');
  assert.equal(value("number('4.5') + round(2.5) + min(3, 1) + max([2, 9])"), 17.5);
  assert.equal(value('string(trigger.task.tags)'), '["bug","backend"]');
  assert.throws(() => value('lower()'), /Wrong number of values for lower\(text\)/);
  assert.throws(() => value('shout(1)'), /Unknown function "shout"/);
});

test('cannot reach anything but the values it is given', () => {
  assert.equal(value('trigger.constructor'), null);
  assert.equal(value('trigger.task.name.length'), null, 'text has no members; use length()');
  assert.equal(value('steps.__proto__'), null);
  assert.equal(value('trigger.task.tags.constructor'), null);
  assert.throws(() => value('process'), /Unknown name "process". Available: trigger, steps, previous, repo/);
  assert.throws(() => value('constructor'), /Unknown name/);
  assert.throws(() => value('toString()'), /Unknown function/);
  assert.throws(() => value('trigger.task.name()'), /Expected an operator but found "\("/);
});

test('says what is wrong with an expression and where', () => {
  assert.throws(() => parseExpression(''), /empty/);
  assert.throws(() => parseExpression('a = 1'), /Unexpected "=" at position 3 \(use "==" to compare\)/);
  assert.throws(() => parseExpression('a &&'), /Expected a value but found "end of expression"/);
  assert.throws(() => parseExpression('(a'), /Expected "\)"/);
  assert.throws(() => parseExpression('a b'), /Expected an operator but found "b" at position 3/);
  assert.throws(() => parseExpression("'open"), /Unexpected "'"/);
  assert.throws(() => parseExpression('a; b'), /Unexpected ";"/);
  assert.throws(() => parseExpression('('.repeat(60) + '1' + ')'.repeat(60)), /nested too deeply/);
  assert.throws(() => parseExpression('1 + '.repeat(600) + '1'), /longer than 2000/);
});

test('checks names and functions without running anything', () => {
  checkExpression("steps.a.output.x > 1 ? lower(trigger.name) : [previous.output, 'x']", ['trigger', 'steps', 'previous']);
  assert.throws(() => checkExpression('steps.my-step.output', ['steps']), /Unknown name "step"/, 'a hyphen in an id is read as minus');
  assert.throws(() => checkExpression('1 == 1 || nope(steps)', ['steps']), /Unknown function "nope"/);
});

test('decides what counts as true', () => {
  for (const no of [false, null, undefined, 0, '', Number.NaN]) assert.equal(truthy(no), false);
  for (const yes of [true, 1, 'false', [], {}]) assert.equal(truthy(yes), true);
});
