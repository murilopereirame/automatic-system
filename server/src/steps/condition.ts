import { evaluate, truthy } from '../expression.js';
import { text, type StepType } from './types.js';

/** Value of `then` and `else` that ends the run instead of naming a block. */
export const END_OF_RUN = '$end';

/**
 * An if/else: evaluates an expression and tells the engine where the run
 * continues. Without a target for the outcome the run simply goes on with the
 * next block, so later blocks can also read `steps.<id>.output.result`.
 *
 * The jump itself, including the limit on going back, is done by the engine
 * (see `jump` in engine/engine.ts).
 */
export const conditionStep: StepType = {
  type: 'condition',
  title: 'Condition',
  description: 'Checks an expression and decides which block runs next. Use it to branch, to skip blocks, to end the run early, or to go back and try again.',
  fields: [
    {
      key: 'expression',
      label: 'If',
      type: 'expression',
      placeholder: 'steps.tests.output.passed',
      help: "Can read trigger, steps.<id>.output and previous.output, e.g. steps.tests.output.exitCode == 0 && trigger.task.status != 'done'",
    },
    { key: 'then', label: 'When true, continue with', type: 'target' },
    { key: 'else', label: 'When false, continue with', type: 'target' },
    {
      key: 'maxRepeats',
      label: 'Go back at most',
      type: 'number',
      default: 3,
      help: 'Only matters when a target is an earlier block. After this many times the run fails instead of looping forever.',
    },
  ],
  async execute({ step, scope, log }) {
    // The raw setting on purpose: the expression is never built from rendered templates.
    const expression = text(step.with, 'expression');
    if (!expression) throw new Error('No expression configured');
    const result = truthy(evaluate(expression, scope));
    const goTo = text(step.with, result ? 'then' : 'else') || undefined;
    log('condition', { expression, result, goTo });
    return { output: { result, branch: result ? 'then' : 'else', goTo: goTo ?? null }, goTo };
  },
};
