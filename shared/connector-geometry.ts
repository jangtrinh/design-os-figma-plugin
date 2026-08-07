// Route points -> a VectorNetwork ready for `setVectorNetworkAsync`. Pure — no `figma`.
//
// Three facts, all measured on a live canvas, decide this file's shape:
//   1. The sync `vectorNetwork` setter throws under documentAccess "dynamic-page"; only
//      `setVectorNetworkAsync` writes. There is no `setVectorPathsAsync` counterpart.
//   2. A per-vertex `strokeCap` survives a network write, so the arrowhead costs nothing —
//      no second node, no path baked into the geometry.
//   3. Writing `vectorPaths` afterwards WIPES every per-vertex cap. So the network is the
//      only artifact a renderer may consume, and this module deliberately emits no path
//      string for one to reach for by mistake.

import type { Point, VectorNetworkSpec, VectorVertexSpec } from './connector-types';

export interface NetworkOptions {
  /** Cap the terminal vertex with an arrowhead. A flow edge is directed; a plain rule is not. */
  arrowAtEnd: boolean;
}

function round(value: number): number {
  const rounded = Math.round(value * 10) / 10;
  return rounded === 0 ? 0 : rounded; // never -0: it serializes inconsistently
}

/**
 * Build the network, with vertices measured from the polyline's own top-left corner.
 *
 * VectorNetwork coordinates are node-relative, and a node auto-resizes to its network's
 * bounding box without moving — so the absolute position has to travel separately or the
 * connector lands wherever the node happened to be. `origin` is that position: write it to
 * the node's x/y and the drawn line falls exactly on the routed points.
 */
export function pointsToVectorNetwork(points: readonly Point[], options: NetworkOptions): VectorNetworkSpec {
  if (points.length < 2) {
    throw new Error(`a connector needs at least two points, got ${points.length}`);
  }

  const origin: Point = {
    x: round(Math.min(...points.map((p) => p.x))),
    y: round(Math.min(...points.map((p) => p.y))),
  };

  const lastIndex = points.length - 1;
  const vertices: VectorVertexSpec[] = points.map((point, index) => ({
    x: round(point.x - origin.x),
    y: round(point.y - origin.y),
    // The arrow marks the END of the edge and nothing else. Setting the node-level
    // strokeCap instead would cap BOTH open ends — the network reads `figma.mixed` once
    // vertices disagree, which is the tell that per-vertex is the real control.
    strokeCap: options.arrowAtEnd && index === lastIndex ? 'ARROW_LINES' : 'NONE',
  }));

  const segments = points.slice(1).map((_, index) => ({ start: index, end: index + 1 }));

  return { vertices, segments, origin };
}
