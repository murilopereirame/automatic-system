/**
 * Pan and zoom of the flow canvas, as plain math. A view maps a point of the graph to the screen:
 * screen = graph * zoom + (x, y).
 */
import type { Bounds } from './graph.ts';

export interface View {
  x: number;
  y: number;
  zoom: number;
}

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 1.75;

export const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

/** Zooms by `factor` while keeping the graph point under the screen point (px, py) where it is. */
export function zoomAround(view: View, factor: number, px: number, py: number): View {
  const zoom = clampZoom(view.zoom * factor);
  const scale = zoom / view.zoom;
  return { zoom, x: px - (px - view.x) * scale, y: py - (py - view.y) * scale };
}

/** The view that shows all of `bounds` in a `width` × `height` area, never zoomed in past 100 %. */
export function fitView(bounds: Bounds, width: number, height: number, padding = 48): View {
  const graphWidth = Math.max(1, bounds.maxX - bounds.minX);
  const graphHeight = Math.max(1, bounds.maxY - bounds.minY);
  const zoom = clampZoom(Math.min(1, (width - padding * 2) / graphWidth, (height - padding * 2) / graphHeight));
  return {
    zoom,
    x: (width - graphWidth * zoom) / 2 - bounds.minX * zoom,
    y: (height - graphHeight * zoom) / 2 - bounds.minY * zoom,
  };
}

/**
 * The view a workflow opens with: all of it when that is still readable, otherwise its start at
 * `minZoom`, centred vertically. A long workflow is then explored by panning, like a document.
 */
export function initialView(bounds: Bounds, width: number, height: number, minZoom = 0.7, padding = 48): View {
  const fitted = fitView(bounds, width, height, padding);
  if (fitted.zoom >= minZoom) return fitted;
  const zoom = Math.min(minZoom, Math.max(MIN_ZOOM, (height - padding * 2) / Math.max(1, bounds.maxY - bounds.minY)));
  return { zoom, x: padding - bounds.minX * zoom, y: (height - (bounds.maxY - bounds.minY) * zoom) / 2 - bounds.minY * zoom };
}
