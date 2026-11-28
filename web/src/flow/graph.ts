/**
 * Turns a workflow definition into what the flow canvas draws: positioned nodes, edges with SVG
 * paths, and the points where a block can be inserted. Pure functions, no React, so the layout is
 * easy to test (web/test/flow-graph.test.ts).
 *
 * Layout, left to right (see docs/FLOW_EDITOR.md):
 *
 *   column 0        column 1   column 2   ...   column n+1
 *   [Run now]  ┐
 *   [trigger]  ├──▶ [block 1] ─▶ [block 2] ─▶ ... ─▶ (End)
 *   [trigger]  ┘
 *
 * Untouched, blocks sit on one line in the order they run. Jumps (condition outcomes, "go back
 * to" after a rejected approval) are drawn as arcs above or below that line, so the order stays
 * readable however a workflow branches.
 *
 * Any node can be dragged elsewhere. Its position is then saved in the workflow's `layout` and
 * used instead of the automatic one; edges touching a moved node are routed from where it is.
 */
import type { NodePosition, StepConfig, TriggerConfig } from '../api.ts';

export const NODE_WIDTH = 240;
export const NODE_HEIGHT = 76;
export const COLUMN_GAP = 96;
export const ROW_GAP = 20;
/** Distance between the left edges of two neighbouring columns. */
export const COLUMN_STEP = NODE_WIDTH + COLUMN_GAP;
/** Target of a condition outcome that ends the run. The server knows it as END_OF_RUN. */
export const END_OF_RUN = '$end';

export type NodeKind = 'manual' | 'trigger' | 'step' | 'end' | 'placeholder';

export interface GraphNode {
  /** Stable key: `manual`, `trigger:<id>`, `step:<id>`, `end` or `placeholder`. */
  key: string;
  kind: NodeKind;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Position in `triggers` or `steps`, for trigger and step nodes. */
  index?: number;
  /** True when the node is at a position someone dragged it to, not the automatic one. */
  moved?: boolean;
}

/**
 * How an edge is drawn. `entry` leads from a trigger into the first block, `next` is plain order,
 * `true`/`false` are condition outcomes, `approved`/`rejected` approval outcomes, `order` a faint
 * line kept where no run actually goes from one block to the next (a condition that always jumps).
 */
export type EdgeTone = 'entry' | 'next' | 'true' | 'false' | 'rejected' | 'order';

export interface GraphEdge {
  key: string;
  from: string;
  to: string;
  tone: EdgeTone;
  path: string;
  label?: string;
  labelX: number;
  labelY: number;
}

/** A "+" between two columns: a new block inserted there gets position `index` in `steps`. */
export interface InsertPoint {
  index: number;
  x: number;
  y: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  inserts: InsertPoint[];
  bounds: Bounds;
}

export const columnX = (column: number) => column * COLUMN_STEP;

/** The column a step at `index` sits in. Column 0 holds "Run now" and the triggers. */
export const stepColumn = (index: number) => index + 1;

/** Positions are snapped to this grid (the canvas dots), so moved nodes line up easily. */
export const GRID = 20;
export const snap = (value: number) => Math.round(value / GRID) * GRID;

/**
 * Where an outcome of a block continues, as a column: '' means the next block, '$end' the end,
 * an id that block. Undefined when the id names no block.
 */
function targetColumn(target: unknown, index: number, steps: StepConfig[]): number | undefined {
  if (!target) return stepColumn(index + 1);
  if (target === END_OF_RUN) return stepColumn(steps.length);
  const found = steps.findIndex((step) => step.id === target);
  return found === -1 ? undefined : stepColumn(found);
}

/** SVG path through `points`, with the corners rounded. */
export function roundedPath(points: [number, number][], radius = 12): string {
  let path = `M ${points[0][0]} ${points[0][1]}`;
  for (let at = 1; at < points.length - 1; at += 1) {
    const [px, py] = points[at - 1];
    const [cx, cy] = points[at];
    const [nx, ny] = points[at + 1];
    const before = Math.hypot(cx - px, cy - py);
    const after = Math.hypot(nx - cx, ny - cy);
    const r = Math.min(radius, before / 2, after / 2);
    if (r === 0) {
      path += ` L ${cx} ${cy}`;
      continue;
    }
    const startX = cx - ((cx - px) / before) * r;
    const startY = cy - ((cy - py) / before) * r;
    const endX = cx + ((nx - cx) / after) * r;
    const endY = cy + ((ny - cy) / after) * r;
    path += ` L ${startX} ${startY} Q ${cx} ${cy} ${endX} ${endY}`;
  }
  const [lastX, lastY] = points[points.length - 1];
  return `${path} L ${lastX} ${lastY}`;
}

/** A smooth horizontal S-curve between two handles. */
function curve(sx: number, sy: number, tx: number, ty: number): string {
  const bend = Math.max(32, Math.abs(tx - sx) / 2);
  return `M ${sx} ${sy} C ${sx + bend} ${sy}, ${tx - bend} ${ty}, ${tx} ${ty}`;
}

/** An outgoing edge of a block before it is given its path. */
interface Outgoing {
  tone: EdgeTone;
  label?: string;
  /** Where on the right side of the block it leaves, as a share of the block's height. */
  handle: number;
  toColumn: number;
}

/** What leaves a block: its outcomes and where each continues. */
function outgoing(step: StepConfig, index: number, steps: StepConfig[]): Outgoing[] {
  const next = stepColumn(index + 1);
  if (step.type === 'condition') {
    const whenTrue = targetColumn(step.with.then, index, steps);
    const whenFalse = targetColumn(step.with.else, index, steps);
    if (whenTrue !== undefined && whenTrue === whenFalse) return [{ tone: 'next', label: 'true · false', handle: 0.5, toColumn: whenTrue }];
    const edges: Outgoing[] = [];
    if (whenTrue !== undefined) edges.push({ tone: 'true', label: 'true', handle: 0.35, toColumn: whenTrue });
    if (whenFalse !== undefined) edges.push({ tone: 'false', label: 'false', handle: 0.65, toColumn: whenFalse });
    if (whenTrue !== next && whenFalse !== next) edges.push({ tone: 'order', handle: 0.5, toColumn: next });
    return edges;
  }
  if (step.type === 'approval' && step.with.onReject) {
    const back = targetColumn(step.with.onReject, index, steps);
    const edges: Outgoing[] = [{ tone: 'next', label: 'approved', handle: 0.35, toColumn: next }];
    if (back !== undefined) edges.push({ tone: 'rejected', label: 'rejected', handle: 0.65, toColumn: back });
    return edges;
  }
  return [{ tone: 'next', handle: 0.5, toColumn: next }];
}

/** Where an edge leaves a node (its right side) and enters one (its left side, in the middle). */
const outPoint = (node: GraphNode, share: number): [number, number] => [node.x + node.width, node.y + node.height * share];
const inPoint = (node: GraphNode): [number, number] => [node.x, node.y + node.height / 2];

/**
 * Path between two moved or freely placed nodes: a curve when the target is to the right (or only a
 * little to the left, where an S-curve still reads well), else a loop below both nodes so the edge
 * never runs back through them.
 */
function freePath(source: GraphNode, [sx, sy]: [number, number], target: GraphNode, [tx, ty]: [number, number]) {
  if (tx >= sx - 40) return { path: curve(sx, sy, tx, ty), labelX: (sx + tx) / 2, labelY: (sy + ty) / 2 - 14, laneY: undefined };
  const laneY = Math.max(source.y + source.height, target.y + target.height) + 30;
  const path = roundedPath([
    [sx, sy],
    [sx + 20, sy],
    [sx + 20, laneY],
    [tx - 20, laneY],
    [tx - 20, ty],
    [tx, ty],
  ]);
  return { path, labelX: (sx + tx) / 2, labelY: laneY, laneY };
}

/**
 * @param positions where nodes were dragged to, by node key (the workflow's `layout.positions`).
 *   Nodes without one, or all of them when it is missing, get the automatic layout.
 */
export function buildGraph(triggers: TriggerConfig[], steps: StepConfig[], positions: Record<string, NodePosition> = {}): Graph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const box = { width: NODE_WIDTH, height: NODE_HEIGHT };
  /** The node at its automatic position, or where it was moved to. */
  const place = (node: GraphNode): GraphNode => {
    const moved = positions[node.key];
    return moved && node.kind !== 'placeholder' ? { ...node, x: moved.x, y: moved.y, moved: true } : node;
  };

  // Column 0: "Run now" and the triggers, stacked and centred on the line of the blocks.
  const entryKeys = ['manual', ...triggers.map((trigger) => `trigger:${trigger.id}`)];
  const columnHeight = entryKeys.length * NODE_HEIGHT + (entryKeys.length - 1) * ROW_GAP;
  const top = NODE_HEIGHT / 2 - columnHeight / 2;
  entryKeys.forEach((key, row) => {
    nodes.push(place({ key, kind: row === 0 ? 'manual' : 'trigger', x: 0, y: top + row * (NODE_HEIGHT + ROW_GAP), ...box, index: row === 0 ? undefined : row - 1 }));
  });

  steps.forEach((step, index) => nodes.push(place({ key: `step:${step.id}`, kind: 'step', x: columnX(stepColumn(index)), y: 0, ...box, index })));

  // The end of the run, or a dashed "add the first block" card while there are none.
  const endColumn = stepColumn(steps.length);
  const end: GraphNode = place(
    steps.length === 0 ? { key: 'placeholder', kind: 'placeholder', x: columnX(endColumn), y: 0, ...box } : { key: 'end', kind: 'end', x: columnX(endColumn), y: NODE_HEIGHT / 2 - 22, width: 44, height: 44 },
  );
  nodes.push(end);

  /** The node in a column: column 0 is the entries, 1..n the blocks, n+1 the end. */
  const nodeAt = (column: number) => (column === endColumn ? end : nodes[entryKeys.length + column - 1]);
  let minLaneY = 0;
  let maxLaneY = 0;
  const addFree = (key: string, source: GraphNode, share: number, target: GraphNode, tone: EdgeTone, label?: string) => {
    const free = freePath(source, outPoint(source, share), target, inPoint(target));
    if (free.laneY !== undefined) maxLaneY = Math.max(maxLaneY, free.laneY);
    edges.push({ key, from: source.key, to: target.key, tone, label, path: free.path, labelX: free.labelX, labelY: free.labelY });
  };

  // Into the first block from every entry.
  const first = nodeAt(1);
  for (const entry of nodes.slice(0, entryKeys.length)) {
    const [sx, sy] = outPoint(entry, 0.5);
    const [tx, ty] = inPoint(first);
    if (entry.moved || first.moved) addFree(`${entry.key}->${first.key}`, entry, 0.5, first, 'entry');
    else edges.push({ key: `${entry.key}->${first.key}`, from: entry.key, to: first.key, tone: 'entry', path: curve(sx, sy, tx, ty), labelX: 0, labelY: 0 });
  }

  // Between blocks. Between unmoved blocks, edges to the next column are curves and jumps go
  // around the line in lanes; edges touching a moved block are routed from where it is.
  const jumps: (Outgoing & { from: number; sx: number; sy: number })[] = [];
  steps.forEach((step, index) => {
    const column = stepColumn(index);
    const source = nodeAt(column);
    for (const edge of outgoing(step, index, steps)) {
      const target = nodeAt(edge.toColumn);
      const key = `${source.key}->${target.key}:${edge.tone}`;
      if (source.moved || target.moved) {
        addFree(key, source, edge.handle, target, edge.tone, edge.label);
        continue;
      }
      const [sx, sy] = outPoint(source, edge.handle);
      if (edge.toColumn === column + 1) {
        const [tx, ty] = inPoint(target);
        // The label sits above the line, clear of the "+" in the middle of the gap.
        edges.push({ key, from: source.key, to: target.key, tone: edge.tone, label: edge.label, path: curve(sx, sy, tx, ty), labelX: (sx + tx) / 2, labelY: Math.min(sy, ty) - 14 });
      } else {
        jumps.push({ ...edge, from: column, sx, sy });
      }
    }
  });

  // Jumps forward on a "true" outcome go above the line, everything else below. Each takes the
  // closest lane on its side that no overlapping jump uses yet, shortest jumps first.
  const lanes: Record<'above' | 'below', [number, number][][]> = { above: [], below: [] };
  jumps.sort((a, b) => Math.abs(a.toColumn - a.from) - Math.abs(b.toColumn - b.from));
  for (const jump of jumps) {
    const side = jump.tone === 'true' && jump.toColumn > jump.from ? 'above' : 'below';
    const span: [number, number] = [Math.min(jump.from, jump.toColumn), Math.max(jump.from, jump.toColumn)];
    let lane = lanes[side].findIndex((taken) => taken.every(([start, stop]) => stop <= span[0] || start >= span[1]));
    if (lane === -1) lane = lanes[side].push([]) - 1;
    lanes[side][lane].push(span);
    const offset = 30 + lane * 22;
    const laneY = side === 'above' ? -offset : NODE_HEIGHT + offset;
    minLaneY = Math.min(minLaneY, laneY);
    maxLaneY = Math.max(maxLaneY, laneY);
    const source = nodeAt(jump.from);
    const target = nodeAt(jump.toColumn);
    const [tx, ty] = inPoint(target);
    const path = roundedPath([
      [jump.sx, jump.sy],
      [jump.sx + 20, jump.sy],
      [jump.sx + 20, laneY],
      [tx - 20, laneY],
      [tx - 20, ty],
      [tx, ty],
    ]);
    edges.push({ key: `${source.key}->${target.key}:${jump.tone}`, from: source.key, to: target.key, tone: jump.tone, label: jump.label, path, labelX: (jump.sx + tx) / 2, labelY: laneY });
  }

  // A "+" in front of every block and the end: halfway from the block before when that one is to
  // the left, otherwise just left of the node.
  const inserts: InsertPoint[] = [];
  for (let index = 0; index <= steps.length; index += 1) {
    const target = nodeAt(stepColumn(index));
    const [tx, ty] = inPoint(target);
    const previous = index > 0 ? nodeAt(stepColumn(index - 1)) : undefined;
    const [px, py] = previous ? outPoint(previous, 0.5) : [tx - COLUMN_GAP, ty];
    inserts.push(px < tx - 24 ? { index, x: (px + tx) / 2, y: (py + ty) / 2 } : { index, x: tx - COLUMN_GAP / 2, y: ty });
  }

  const bounds: Bounds = {
    minX: Math.min(...nodes.map((node) => node.x), ...inserts.map((point) => point.x)),
    minY: Math.min(...nodes.map((node) => node.y), minLaneY - 16),
    maxX: Math.max(...nodes.map((node) => node.x + node.width)),
    maxY: Math.max(...nodes.map((node) => node.y + node.height), maxLaneY + 16),
  };
  return { nodes, edges, inserts, bounds };
}
