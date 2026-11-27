/**
 * Layout of the flow editor (web/src/flow/graph.ts) and the pan/zoom math (viewport.ts): where nodes
 * go, which edges a workflow gets, where a dragged block lands, and that fitting keeps all in view.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StepConfig, TriggerConfig } from '../src/api.ts';
import { buildGraph, COLUMN_STEP, dropIndex, NODE_HEIGHT, roundedPath } from '../src/flow/graph.ts';
import { fitView, initialView, MAX_ZOOM, MIN_ZOOM, zoomAround } from '../src/flow/viewport.ts';

const step = (id: string, type = 'shell', settings: Record<string, unknown> = {}): StepConfig => ({ id, type, name: id, with: settings });
const trigger = (id: string): TriggerConfig => ({ id, type: 'webhook', with: {} });
const edge = (graph: ReturnType<typeof buildGraph>, from: string, to: string) => graph.edges.filter((candidate) => candidate.from === from && candidate.to === to);

test('places "Run now" and triggers in the first column and blocks on one line in order', () => {
  const graph = buildGraph([trigger('hook'), trigger('other')], [step('a'), step('b')]);
  const at = (key: string) => graph.nodes.find((node) => node.key === key)!;
  assert.equal(at('manual').x, 0);
  assert.equal(at('trigger:hook').x, 0);
  assert.ok(at('trigger:hook').y > at('manual').y);
  assert.equal(at('step:a').x, COLUMN_STEP);
  assert.equal(at('step:b').x, 2 * COLUMN_STEP);
  assert.equal(at('step:a').y, at('step:b').y);
  assert.equal(at('end').x, 3 * COLUMN_STEP);
  // The first column is centred on the line of the blocks.
  const entries = graph.nodes.filter((node) => node.x === 0);
  const middle = (entries[0].y + entries.at(-1)!.y + NODE_HEIGHT) / 2;
  assert.equal(middle, NODE_HEIGHT / 2);
});

test('every entry leads into the first block, and blocks follow each other to the end', () => {
  const graph = buildGraph([trigger('hook')], [step('a'), step('b')]);
  assert.equal(edge(graph, 'manual', 'step:a')[0].tone, 'entry');
  assert.equal(edge(graph, 'trigger:hook', 'step:a')[0].tone, 'entry');
  assert.equal(edge(graph, 'step:a', 'step:b')[0].tone, 'next');
  assert.equal(edge(graph, 'step:b', 'end')[0].tone, 'next');
});

test('an empty workflow shows a placeholder to add the first block', () => {
  const graph = buildGraph([], []);
  assert.deepEqual(
    graph.nodes.map((node) => node.kind),
    ['manual', 'placeholder'],
  );
  assert.deepEqual(
    graph.inserts.map((point) => point.index),
    [0],
  );
});

test('a condition gets a true and a false edge, jumps go around the line', () => {
  const steps = [step('check', 'condition', { expression: 'x', then: '', else: 'fix' }), step('next'), step('fix')];
  const graph = buildGraph([], steps);
  const [whenTrue] = edge(graph, 'step:check', 'step:next');
  const [whenFalse] = edge(graph, 'step:check', 'step:fix');
  assert.equal(whenTrue.tone, 'true');
  assert.equal(whenFalse.tone, 'false');
  // A forward "false" jump goes below the blocks.
  assert.ok(whenFalse.labelY > NODE_HEIGHT);
});

test('a condition whose outcomes go to the same place draws one edge', () => {
  const graph = buildGraph([], [step('check', 'condition', { expression: 'x' }), step('next')]);
  const edges = edge(graph, 'step:check', 'step:next');
  assert.equal(edges.length, 1);
  assert.equal(edges[0].label, 'true · false');
});

test('a condition that always jumps keeps a faint order line to the next block', () => {
  const steps = [step('first'), step('check', 'condition', { expression: 'x', then: 'first', else: '$end' }), step('after')];
  const graph = buildGraph([], steps);
  assert.equal(edge(graph, 'step:check', 'step:after')[0].tone, 'order');
  assert.equal(edge(graph, 'step:check', 'step:first')[0].tone, 'true');
  assert.equal(edge(graph, 'step:check', 'end')[0].tone, 'false');
});

test('an approval that goes back on rejection gets a rejected edge to that block', () => {
  const steps = [step('work'), step('ok', 'approval', { onReject: 'work' })];
  const graph = buildGraph([], steps);
  assert.equal(edge(graph, 'step:ok', 'step:work')[0].tone, 'rejected');
  assert.equal(edge(graph, 'step:ok', 'end')[0].label, 'approved');
});

test('targets that name no block are left out instead of breaking the layout', () => {
  const graph = buildGraph([], [step('check', 'condition', { expression: 'x', then: 'gone', else: '' })]);
  assert.deepEqual(
    edge(graph, 'step:check', 'end').map((found) => found.tone),
    ['false'],
  );
});

test('overlapping jumps on the same side get separate lanes', () => {
  const steps = [step('a'), step('b'), step('c'), step('x', 'condition', { expression: 'x', else: 'a' }), step('y', 'condition', { expression: 'y', else: 'b' })];
  const graph = buildGraph([], steps);
  const lanes = graph.edges.filter((found) => found.tone === 'false').map((found) => found.labelY);
  assert.equal(new Set(lanes).size, 2);
  assert.ok(graph.bounds.maxY >= Math.max(...lanes));
});

test('there is a "+" before every block and before the end', () => {
  const graph = buildGraph([], [step('a'), step('b')]);
  assert.deepEqual(
    graph.inserts.map((point) => point.index),
    [0, 1, 2],
  );
  assert.ok(graph.inserts[1].x > COLUMN_STEP && graph.inserts[1].x < 2 * COLUMN_STEP);
});

test('a dragged block lands on the nearest column, within the blocks', () => {
  assert.equal(dropIndex(COLUMN_STEP, 3), 0);
  assert.equal(dropIndex(COLUMN_STEP * 2.4, 3), 1);
  assert.equal(dropIndex(COLUMN_STEP * 2.6, 3), 2);
  assert.equal(dropIndex(-500, 3), 0);
  assert.equal(dropIndex(COLUMN_STEP * 40, 3), 2);
});

test('rounded paths start and end at the given points', () => {
  const path = roundedPath([
    [0, 0],
    [20, 0],
    [20, 50],
    [100, 50],
  ]);
  assert.match(path, /^M 0 0 /);
  assert.match(path, / L 100 50$/);
  assert.equal(path.match(/Q/g)?.length, 2);
});

test('zooming keeps the point under the cursor in place and stays within limits', () => {
  const view = { x: 10, y: 20, zoom: 1 };
  const zoomed = zoomAround(view, 1.5, 200, 100);
  assert.equal((200 - zoomed.x) / zoomed.zoom, (200 - view.x) / view.zoom);
  assert.equal((100 - zoomed.y) / zoomed.zoom, (100 - view.y) / view.zoom);
  assert.equal(zoomAround(view, 100, 0, 0).zoom, MAX_ZOOM);
  assert.equal(zoomAround(view, 0.001, 0, 0).zoom, MIN_ZOOM);
});

test('fitting shows the whole graph and never zooms in past 100 %', () => {
  const bounds = { minX: 0, minY: -50, maxX: 2000, maxY: 150 };
  const view = fitView(bounds, 1000, 600);
  assert.ok(bounds.minX * view.zoom + view.x >= 0);
  assert.ok(bounds.maxX * view.zoom + view.x <= 1000);
  assert.equal(fitView({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, 1000, 600).zoom, 1);
});

test('a long workflow opens at its start, readable, instead of fitted very small', () => {
  const bounds = { minX: 0, minY: 0, maxX: 10000, maxY: 100 };
  const view = initialView(bounds, 1000, 600);
  assert.equal(view.zoom, 0.7);
  assert.equal(view.x, 48);
});
