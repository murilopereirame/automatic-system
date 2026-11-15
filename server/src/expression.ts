/**
 * The expression language used by conditions: `if` on a block, the condition
 * block, and `{{= ... }}` in templates.
 *
 *   steps.tests.output.passed && trigger.task.priority != 'low'
 *   contains(lower(trigger.task.name), 'hotfix') ? 'main' : 'develop'
 *
 * An expression is parsed into a small tree and that tree is interpreted
 * here. Nothing is ever handed to JavaScript's `eval`, and an expression can
 * only read the values it is given and call the functions listed below, so
 * text that arrives from a trigger cannot make the server do anything.
 *
 * See docs/EXPRESSIONS.md for the user-facing reference.
 */

export class ExpressionError extends Error {}

/** Longer or more deeply nested expressions are refused, so parsing stays cheap. */
const MAX_LENGTH = 2000;
const MAX_DEPTH = 50;

// ---------------------------------------------------------------- tokens

interface Token {
  kind: 'number' | 'string' | 'name' | 'operator' | 'end';
  text: string;
  position: number;
}

const TOKEN = /\s*(?:(\d+(?:\.\d+)?)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|([A-Za-z_]\w*)|(==|!=|<=|>=|&&|\|\||[<>!+\-*/%?:.,()[\]]))/y;

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let position = 0;
  while (source.slice(position).trim() !== '') {
    TOKEN.lastIndex = position;
    const match = TOKEN.exec(source);
    if (!match) {
      const at = position + source.slice(position).search(/\S/);
      const hint = source[at] === '=' ? ' (use "==" to compare)' : '';
      throw new ExpressionError(`Unexpected "${source[at]}" at position ${at + 1}${hint}`);
    }
    const [whole, number, string, name, operator] = match;
    const start = TOKEN.lastIndex - whole.trimStart().length;
    if (number !== undefined) tokens.push({ kind: 'number', text: number, position: start });
    else if (string !== undefined) tokens.push({ kind: 'string', text: string, position: start });
    else if (name !== undefined) tokens.push({ kind: 'name', text: name, position: start });
    else tokens.push({ kind: 'operator', text: operator, position: start });
    position = TOKEN.lastIndex;
  }
  tokens.push({ kind: 'end', text: 'end of expression', position: source.length });
  return tokens;
}

/** Turns a quoted string token into its value: `\n` and `\t` are understood, any other escaped character stands for itself. */
function unquote(literal: string): string {
  return literal.slice(1, -1).replace(/\\(.)/g, (_match, char: string) => (char === 'n' ? '\n' : char === 't' ? '\t' : char));
}

// ---------------------------------------------------------------- parser

export type Expression =
  | { kind: 'literal'; value: unknown }
  | { kind: 'name'; name: string }
  | { kind: 'list'; items: Expression[] }
  | { kind: 'member'; object: Expression; property: Expression }
  | { kind: 'call'; name: string; args: Expression[] }
  | { kind: 'unary'; operator: string; operand: Expression }
  | { kind: 'binary'; operator: string; left: Expression; right: Expression }
  | { kind: 'choice'; test: Expression; then: Expression; otherwise: Expression };

const KEYWORDS: Record<string, unknown> = { true: true, false: false, null: null };

/** Binary operators from loosest to tightest binding. */
const PRECEDENCE = [['||'], ['&&'], ['==', '!='], ['<', '<=', '>', '>='], ['+', '-'], ['*', '/', '%']];

/** Parses an expression. Throws an `ExpressionError` that says what is wrong and where. */
export function parseExpression(source: string): Expression {
  if (source.trim() === '') throw new ExpressionError('The expression is empty');
  if (source.length > MAX_LENGTH) throw new ExpressionError(`The expression is longer than ${MAX_LENGTH} characters`);

  const tokens = tokenize(source);
  let index = 0;
  let depth = 0;

  const peek = () => tokens[index];
  const isOperator = (text: string) => peek().kind === 'operator' && peek().text === text;
  const unexpected = (expected: string): never => {
    throw new ExpressionError(`Expected ${expected} but found "${peek().text}" at position ${peek().position + 1}`);
  };
  const expect = (text: string) => (isOperator(text) ? tokens[index++] : unexpected(`"${text}"`));

  /** `test ? then : otherwise`, the loosest construct, and the entry point for every nested expression. */
  function choice(): Expression {
    if (++depth > MAX_DEPTH) throw new ExpressionError('The expression is nested too deeply');
    const test = binary(0);
    let result = test;
    if (isOperator('?')) {
      index += 1;
      const then = choice();
      expect(':');
      result = { kind: 'choice', test, then, otherwise: choice() };
    }
    depth -= 1;
    return result;
  }

  function binary(level: number): Expression {
    if (level === PRECEDENCE.length) return unary();
    let left = binary(level + 1);
    while (peek().kind === 'operator' && PRECEDENCE[level].includes(peek().text)) {
      const operator = tokens[index++].text;
      left = { kind: 'binary', operator, left, right: binary(level + 1) };
    }
    return left;
  }

  function unary(): Expression {
    if (isOperator('!') || isOperator('-')) {
      if (++depth > MAX_DEPTH) throw new ExpressionError('The expression is nested too deeply');
      const operator = tokens[index++].text;
      const operand = unary();
      depth -= 1;
      return { kind: 'unary', operator, operand };
    }
    return postfix();
  }

  /** A value followed by any number of `.name` and `[index]` accesses. */
  function postfix(): Expression {
    let value = primary();
    for (;;) {
      if (isOperator('.')) {
        index += 1;
        // `steps.0` and `steps.name` both work, like in `{{ }}` placeholders.
        if (peek().kind !== 'name' && peek().kind !== 'number') unexpected('a name after "."');
        value = { kind: 'member', object: value, property: { kind: 'literal', value: tokens[index++].text } };
      } else if (isOperator('[')) {
        index += 1;
        value = { kind: 'member', object: value, property: choice() };
        expect(']');
      } else {
        return value;
      }
    }
  }

  function list(closing: string): Expression[] {
    const items: Expression[] = [];
    while (!isOperator(closing)) {
      items.push(choice());
      if (!isOperator(closing)) expect(',');
    }
    index += 1;
    return items;
  }

  function primary(): Expression {
    const token = tokens[index++];
    if (token.kind === 'number') return { kind: 'literal', value: Number(token.text) };
    if (token.kind === 'string') return { kind: 'literal', value: unquote(token.text) };
    if (token.kind === 'name') {
      if (Object.hasOwn(KEYWORDS, token.text)) return { kind: 'literal', value: KEYWORDS[token.text] };
      if (!isOperator('(')) return { kind: 'name', name: token.text };
      index += 1;
      return { kind: 'call', name: token.text, args: list(')') };
    }
    if (token.text === '(') {
      const inner = choice();
      expect(')');
      return inner;
    }
    if (token.text === '[') return { kind: 'list', items: list(']') };
    index -= 1;
    return unexpected('a value');
  }

  const expression = choice();
  if (peek().kind !== 'end') unexpected('an operator');
  return expression;
}

// ---------------------------------------------------------------- values

/** What counts as "true" for a condition: everything except false, null, 0 and empty text. */
export function truthy(value: unknown): boolean {
  return !(value === false || value === null || value === undefined || value === 0 || value === '' || Number.isNaN(value));
}

/** The number a value stands for, or undefined. `"42"` counts as a number, because command output and payloads are often text. */
function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isNaN(value) ? undefined : value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === 'object' && Object.keys(value).length === 0;
}

function equal(left: unknown, right: unknown): boolean {
  if (left === null || left === undefined || right === null || right === undefined) return (left ?? null) === (right ?? null);
  const [leftNumber, rightNumber] = [asNumber(left), asNumber(right)];
  if (typeof left !== 'boolean' && typeof right !== 'boolean' && leftNumber !== undefined && rightNumber !== undefined) return leftNumber === rightNumber;
  if (typeof left === 'object' || typeof right === 'object') return JSON.stringify(left) === JSON.stringify(right);
  return left === right;
}

/** Negative, zero or positive, like a sort comparator. Undefined when one side is missing, which makes every comparison false. */
function compare(left: unknown, right: unknown): number | undefined {
  if (left === null || left === undefined || right === null || right === undefined) return undefined;
  const [leftNumber, rightNumber] = [asNumber(left), asNumber(right)];
  if (leftNumber !== undefined && rightNumber !== undefined) return leftNumber - rightNumber;
  return asText(left).localeCompare(asText(right));
}

function arithmetic(operator: string, left: unknown, right: unknown): number {
  const [a, b] = [asNumber(left), asNumber(right)];
  if (a === undefined || b === undefined) throw new ExpressionError(`"${operator}" needs numbers, but got ${JSON.stringify(a === undefined ? left : right) ?? 'nothing'}`);
  if ((operator === '/' || operator === '%') && b === 0) throw new ExpressionError('Division by zero');
  if (operator === '-') return a - b;
  if (operator === '*') return a * b;
  return operator === '/' ? a / b : a % b;
}

// ---------------------------------------------------------------- functions

interface ExpressionFunction {
  /** How it is written, for the docs and for error messages. */
  usage: string;
  description: string;
  /** Fewest and most arguments it takes. */
  arity: [number, number];
  call(...args: unknown[]): unknown;
}

function numbers(name: string, args: unknown[]): number[] {
  return args.flat().map((value) => asNumber(value) ?? fail(`${name}() needs numbers, but got ${JSON.stringify(value) ?? 'nothing'}`));
}

function fail(message: string): never {
  throw new ExpressionError(message);
}

export const functions: Record<string, ExpressionFunction> = {
  contains: {
    usage: 'contains(value, part)',
    description: 'True when a text contains `part`, or when a list has `part` as an item.',
    arity: [2, 2],
    call: (value, part) => (Array.isArray(value) ? value.some((item) => equal(item, part)) : asText(value).includes(asText(part))),
  },
  startsWith: { usage: 'startsWith(text, start)', description: 'True when the text begins with `start`.', arity: [2, 2], call: (text, start) => asText(text).startsWith(asText(start)) },
  endsWith: { usage: 'endsWith(text, end)', description: 'True when the text ends with `end`.', arity: [2, 2], call: (text, end) => asText(text).endsWith(asText(end)) },
  lower: { usage: 'lower(text)', description: 'The text in lower case.', arity: [1, 1], call: (text) => asText(text).toLowerCase() },
  upper: { usage: 'upper(text)', description: 'The text in upper case.', arity: [1, 1], call: (text) => asText(text).toUpperCase() },
  trim: { usage: 'trim(text)', description: 'The text without spaces and line breaks around it.', arity: [1, 1], call: (text) => asText(text).trim() },
  length: {
    usage: 'length(value)',
    description: 'Number of characters of a text, items of a list or keys of an object.',
    arity: [1, 1],
    call: (value) => (Array.isArray(value) ? value.length : value !== null && typeof value === 'object' ? Object.keys(value).length : asText(value).length),
  },
  isEmpty: { usage: 'isEmpty(value)', description: 'True for a missing value, blank text, an empty list or an empty object.', arity: [1, 1], call: isEmpty },
  coalesce: { usage: 'coalesce(a, b, ...)', description: 'The first value that is not empty.', arity: [1, Infinity], call: (...values) => values.find((value) => !isEmpty(value)) ?? null },
  number: { usage: 'number(value)', description: 'The value as a number, or null when it is not one.', arity: [1, 1], call: (value) => asNumber(value) ?? null },
  string: { usage: 'string(value)', description: 'The value as text. Lists and objects become JSON.', arity: [1, 1], call: asText },
  round: { usage: 'round(number)', description: 'The nearest whole number.', arity: [1, 1], call: (value) => Math.round(numbers('round', [value])[0]) },
  min: { usage: 'min(a, b, ...)', description: 'The smallest of the numbers. Also takes a list.', arity: [1, Infinity], call: (...values) => Math.min(...numbers('min', values)) },
  max: { usage: 'max(a, b, ...)', description: 'The largest of the numbers. Also takes a list.', arity: [1, Infinity], call: (...values) => Math.max(...numbers('max', values)) },
};

// ---------------------------------------------------------------- evaluation

/** Reads `object[key]`, but only values the data really has: never anything inherited, such as `constructor`. */
function member(object: unknown, key: unknown): unknown {
  if (object === null || typeof object !== 'object') return null;
  const name = asText(key);
  if (Array.isArray(object)) return /^\d+$/.test(name) ? (object[Number(name)] ?? null) : null;
  return Object.hasOwn(object, name) ? ((object as Record<string, unknown>)[name] ?? null) : null;
}

function evaluateNode(node: Expression, scope: Record<string, unknown>): unknown {
  const value = (child: Expression) => evaluateNode(child, scope);
  switch (node.kind) {
    case 'literal':
      return node.value;
    case 'name':
      if (!Object.hasOwn(scope, node.name)) throw new ExpressionError(`Unknown name "${node.name}". Available: ${Object.keys(scope).join(', ')}`);
      return scope[node.name] ?? null;
    case 'list':
      return node.items.map(value);
    case 'member':
      return member(value(node.object), value(node.property));
    case 'call': {
      const fn = Object.hasOwn(functions, node.name) ? functions[node.name] : fail(`Unknown function "${node.name}". Available: ${Object.keys(functions).join(', ')}`);
      if (node.args.length < fn.arity[0] || node.args.length > fn.arity[1]) fail(`Wrong number of values for ${fn.usage}`);
      return fn.call(...node.args.map(value));
    }
    case 'unary':
      return node.operator === '!' ? !truthy(value(node.operand)) : arithmetic('-', 0, value(node.operand));
    case 'choice':
      return truthy(value(node.test)) ? value(node.then) : value(node.otherwise);
    case 'binary': {
      // `&&` and `||` only look at the right side when they have to, and give back the deciding value.
      const left = value(node.left);
      if (node.operator === '&&') return truthy(left) ? value(node.right) : left;
      if (node.operator === '||') return truthy(left) ? left : value(node.right);
      const right = value(node.right);
      const order = () => compare(left, right);
      switch (node.operator) {
        case '==':
          return equal(left, right);
        case '!=':
          return !equal(left, right);
        case '<':
          return (order() ?? 0) < 0;
        case '<=':
          return (order() ?? 1) <= 0;
        case '>':
          return (order() ?? 0) > 0;
        case '>=':
          return (order() ?? -1) >= 0;
        case '+':
          // Two numbers are added, anything else is joined as text.
          return typeof left === 'number' && typeof right === 'number' ? left + right : asText(left) + asText(right);
        default:
          return arithmetic(node.operator, left, right);
      }
    }
  }
}

/** Evaluates an expression against the given values. Missing values are `null`; a name that is not in `scope` is an error. */
export function evaluate(source: string, scope: Record<string, unknown>): unknown {
  return evaluateNode(parseExpression(source), scope);
}

/**
 * Checks an expression without running it: that it parses, and that it only
 * uses known functions and the given top-level names. Used when a workflow is
 * saved, so mistakes show up in the editor instead of in the middle of a run.
 */
export function checkExpression(source: string, names: readonly string[]): void {
  const visit = (node: Expression): void => {
    if (node.kind === 'name' && !names.includes(node.name)) fail(`Unknown name "${node.name}". Available: ${names.join(', ')}`);
    if (node.kind === 'call' && !Object.hasOwn(functions, node.name)) fail(`Unknown function "${node.name}". Available: ${Object.keys(functions).join(', ')}`);
    for (const child of Object.values(node)) {
      for (const item of Array.isArray(child) ? child : [child]) {
        if (item !== null && typeof item === 'object' && 'kind' in item) visit(item as Expression);
      }
    }
  };
  visit(parseExpression(source));
}
