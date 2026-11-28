/**
 * The canvas of the flow editor: draws the nodes and edges of a graph built by graph.ts on a dotted
 * background that can be panned and zoomed, and lets nodes be dragged anywhere on it.
 *
 * - Drag the background (or two fingers on a touch screen) to pan. Scroll to pan, Ctrl/⌘ + scroll
 *   or pinch to zoom. The toolbar zooms and fits the whole workflow in view.
 * - Click a node to select it. Drag it to move it anywhere; it snaps to the dots of the grid.
 * - The "+" between two columns inserts a block there.
 *
 * What a node looks like and what selecting does is up to the caller (FlowEditor).
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { snap, type Graph, type GraphNode } from './graph.ts';
import type { NodePosition } from '../api.ts';
import { fitView, initialView, zoomAround, type View } from './viewport.ts';

interface Props {
  graph: Graph;
  selectedKey?: string;
  renderNode: (node: GraphNode) => ReactNode;
  onSelect: (key: string | undefined) => void;
  onInsert: (index: number) => void;
  /** Called while a node is dragged, with where it is now, so edges can follow it. */
  onNodeDrag: (key: string, position: NodePosition) => void;
  /** Called when a node is let go after dragging, with where it ends up. */
  onNodeDrop: (key: string, position: NodePosition) => void;
  /** Buttons shown at the top left of the canvas. */
  toolbar?: ReactNode;
  /** The side panel, when one is open. */
  panel?: ReactNode;
}

/** A node being pressed or dragged: where the pointer and the node started, and where the node is now. */
interface Drag {
  key: string;
  startX: number;
  startY: number;
  nodeX: number;
  nodeY: number;
  position: NodePosition;
  moved: boolean;
}

/** How far a pointer may move before a press becomes a drag instead of a click. */
const CLICK_SLOP = 4;

export function FlowCanvas({ graph, selectedKey, renderNode, onSelect, onInsert, onNodeDrag, onNodeDrop, toolbar, panel }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 40, y: 200, zoom: 1 });
  const [size, setSize] = useState({ width: 0, height: 0 });
  /** True for a moment after a toolbar action, so the view eases to its new place instead of jumping. */
  const [easing, setEasing] = useState(false);
  const [drag, setDrag] = useState<Drag>();
  const [panning, setPanning] = useState(false);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pan = useRef<{ moved: boolean }>({ moved: false });
  const fitted = useRef(false);
  const lastPanel = useRef<ReactNode>(undefined);
  if (panel) lastPanel.current = panel;
  // Event listeners added outside React read the latest view from here.
  const viewRef = useRef(view);
  viewRef.current = view;

  const ease = (next: View) => {
    setEasing(true);
    setView(next);
    window.setTimeout(() => setEasing(false), 260);
  };
  const fit = () => size.width && ease(fitView(graph.bounds, size.width - panelWidth(), size.height));
  const zoomBy = (factor: number) => ease(zoomAround(view, factor, size.width / 2, size.height / 2));

  /** Width of the open side panel: the part of the canvas it covers is not counted as visible. */
  const panelWidth = () => {
    const element = container.current?.querySelector<HTMLElement>('.flow-panel.open');
    return element && size.width > 700 ? element.offsetWidth : 0;
  };

  // Track the size of the canvas, and fit the workflow into it the first time it is known.
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ width, height });
      if (!fitted.current && width > 0) {
        fitted.current = true;
        setView(initialView(graph.bounds, width, height));
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Scrolling pans, Ctrl/⌘ + scroll (and trackpad pinch, which browsers report the same way) zooms.
  // Added by hand because React's wheel listener is passive and could not stop the page scrolling.
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if ((event.target as HTMLElement).closest('.flow-panel')) return;
      event.preventDefault();
      const current = viewRef.current;
      if (event.ctrlKey || event.metaKey) {
        const rect = element.getBoundingClientRect();
        // Pinch gestures send small deltas, mouse wheels large ones: cap a single step at about 35 %.
        const delta = Math.max(-30, Math.min(30, event.deltaY));
        setView(zoomAround(current, Math.exp(-delta * 0.01), event.clientX - rect.left, event.clientY - rect.top));
      } else {
        setView({ ...current, x: current.x - event.deltaX, y: current.y - event.deltaY });
      }
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, []);

  // Bring a newly selected node into view when it is hidden, e.g. one just added off screen.
  useEffect(() => {
    const node = graph.nodes.find((candidate) => candidate.key === selectedKey);
    if (!node || !size.width) return;
    const left = node.x * view.zoom + view.x;
    const right = (node.x + node.width) * view.zoom + view.x;
    const top = node.y * view.zoom + view.y;
    const bottom = (node.y + node.height) * view.zoom + view.y;
    const visibleWidth = size.width - panelWidth();
    if (left >= 16 && right <= visibleWidth - 16 && top >= 16 && bottom <= size.height - 16) return;
    ease({ ...view, x: visibleWidth / 2 - (node.x + node.width / 2) * view.zoom, y: size.height / 2 - (node.y + node.height / 2) * view.zoom });
  }, [selectedKey, panel !== undefined]);

  // ---- Panning and pinching the background ----

  const onPointerDown = (event: ReactPointerEvent) => {
    if ((event.target as HTMLElement).closest('.flow-node, .flow-panel, button, input, select, textarea, a')) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    event.currentTarget.setPointerCapture(event.pointerId);
    pan.current.moved = false;
    setPanning(true);
  };

  const onPointerMove = (event: ReactPointerEvent) => {
    const previous = pointers.current.get(event.pointerId);
    if (!previous) return;
    const current = { x: event.clientX, y: event.clientY };
    if (pointers.current.size === 2) {
      // Two fingers: zoom by the change of their distance, around the point between them.
      const [other] = [...pointers.current.entries()].filter(([id]) => id !== event.pointerId).map(([, point]) => point);
      const before = Math.hypot(previous.x - other.x, previous.y - other.y);
      const after = Math.hypot(current.x - other.x, current.y - other.y);
      const rect = container.current!.getBoundingClientRect();
      if (before > 0) setView((old) => zoomAround(old, after / before, (current.x + other.x) / 2 - rect.left, (current.y + other.y) / 2 - rect.top));
    } else {
      setView((old) => ({ ...old, x: old.x + current.x - previous.x, y: old.y + current.y - previous.y }));
    }
    if (Math.abs(current.x - previous.x) + Math.abs(current.y - previous.y) > 0) pan.current.moved = true;
    pointers.current.set(event.pointerId, current);
  };

  const onPointerUp = (event: ReactPointerEvent) => {
    if (!pointers.current.delete(event.pointerId)) return;
    if (pointers.current.size > 0) return;
    setPanning(false);
    // A click on the empty canvas closes the panel.
    if (!pan.current.moved) onSelect(undefined);
  };

  // ---- Clicking and dragging nodes ----

  const onNodePointerDown = (event: ReactPointerEvent, node: GraphNode) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ key: node.key, startX: event.clientX, startY: event.clientY, nodeX: node.x, nodeY: node.y, position: { x: node.x, y: node.y }, moved: false });
  };

  const onNodePointerMove = (event: ReactPointerEvent, node: GraphNode) => {
    if (!drag || drag.key !== node.key) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    // The dashed "add the first block" card stays where it is.
    const moved = node.kind !== 'placeholder' && (drag.moved || Math.abs(dx) + Math.abs(dy) > CLICK_SLOP);
    if (!moved) return;
    const position = { x: snap(drag.nodeX + dx / view.zoom), y: snap(drag.nodeY + dy / view.zoom) };
    if (position.x !== drag.position.x || position.y !== drag.position.y || !drag.moved) onNodeDrag(node.key, position);
    setDrag({ ...drag, position, moved });
  };

  const onNodePointerUp = (node: GraphNode) => {
    if (!drag || drag.key !== node.key) return;
    setDrag(undefined);
    if (drag.moved) onNodeDrop(node.key, drag.position);
    else onSelect(node.key);
  };

  const layerStyle: CSSProperties = { transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` };
  const grid = 20 * view.zoom;
  const background: CSSProperties = { backgroundSize: `${grid}px ${grid}px`, backgroundPosition: `${view.x}px ${view.y}px` };
  const connected = (key: string) => key === selectedKey || key === drag?.key;

  return (
    <div
      ref={container}
      className={`flow-canvas${easing ? ' easing' : ''}${panning ? ' panning' : ''}${drag?.moved ? ' dragging' : ''}`}
      style={background}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div className="flow-layer" style={layerStyle}>
        <svg className="flow-edges" width="1" height="1" aria-hidden="true">
          <defs>
            {['entry', 'next', 'true', 'false', 'rejected', 'order', 'active'].map((tone) => (
              <marker key={tone} id={`flow-arrow-${tone}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 1 L 9 5 L 0 9 z" className={`flow-arrow flow-arrow-${tone}`} />
              </marker>
            ))}
          </defs>
          {graph.edges.map((edge) => {
            const active = connected(edge.from) || connected(edge.to);
            return <path key={edge.key} d={edge.path} className={`flow-edge flow-edge-${edge.tone}${active ? ' active' : ''}`} markerEnd={`url(#flow-arrow-${active ? 'active' : edge.tone})`} />;
          })}
        </svg>
        {graph.edges
          .filter((edge) => edge.label)
          .map((edge) => (
            <span key={edge.key} className={`flow-edge-label flow-edge-label-${edge.tone}`} style={{ left: edge.labelX, top: edge.labelY }}>
              {edge.label}
            </span>
          ))}

        {graph.nodes.map((node) => {
          const dragged = drag?.moved && drag.key === node.key;
          return (
            <div
              key={node.key}
              className={`flow-node flow-node-${node.kind}${node.key === selectedKey ? ' selected' : ''}${dragged ? ' lifted' : ''}`}
              style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
              tabIndex={0}
              role="button"
              aria-pressed={node.key === selectedKey}
              onPointerDown={(event) => onNodePointerDown(event, node)}
              onPointerMove={(event) => onNodePointerMove(event, node)}
              onPointerUp={() => onNodePointerUp(node)}
              onPointerCancel={() => onNodePointerUp(node)}
              onKeyDown={(event) => (event.key === 'Enter' || event.key === ' ') && event.target === event.currentTarget && (event.preventDefault(), onSelect(node.key))}
            >
              {renderNode(node)}
            </div>
          );
        })}

        {!drag?.moved &&
          graph.inserts.map((point) => (
            <button
              key={point.index}
              className="flow-insert"
              style={{ left: point.x, top: point.y }}
              onClick={() => onInsert(point.index)}
              title="Add a block here"
              aria-label={`Add a block at position ${point.index + 1}`}
            >
              +
            </button>
          ))}
      </div>

      {toolbar && <div className="flow-toolbar">{toolbar}</div>}
      <div className="flow-zoom">
        <button className="ghost icon-button" onClick={() => zoomBy(1 / 1.2)} title="Zoom out" aria-label="Zoom out">
          −
        </button>
        <button className="ghost flow-zoom-value" onClick={() => ease(zoomAround(view, 1 / view.zoom, size.width / 2, size.height / 2))} title="Reset to 100 %">
          {Math.round(view.zoom * 100)}%
        </button>
        <button className="ghost icon-button" onClick={() => zoomBy(1.2)} title="Zoom in" aria-label="Zoom in">
          +
        </button>
        <button className="ghost" onClick={fit} title="Show the whole workflow">
          Fit
        </button>
      </div>
      <p className="flow-hint">Drag to pan · Ctrl + scroll to zoom · drag nodes to move them</p>
      {/* Keeps showing the last content while it slides out; `inert` keeps it out of reach meanwhile. */}
      <aside className={`flow-panel${panel ? ' open' : ''}`} inert={!panel}>
        {panel ?? lastPanel.current}
      </aside>
    </div>
  );
}
