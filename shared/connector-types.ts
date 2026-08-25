// Shapes for connector geometry. Pure data — no `figma` access, for the same reason
// mutating-commands.ts is pure: main.ts calls `figma.showUI` at module load and cannot be
// imported outside a live plugin sandbox, so the geometry worth trusting has to be testable
// without one. The CLI needs these shapes too (a route is stored on the connection record
// and re-checked later), and shared/ has no boundary to cross to reach either side.

export interface Point { x: number; y: number }

/** An absolute canvas box, as `absoluteBoundingBox` reports one. */
export interface Rect { x: number; y: number; width: number; height: number }

/**
 * What the connector is FOR. Intent picks the route shape — there is deliberately no
 * caller-supplied mode: a per-side port/mode API is residue of the manual drawing tool this
 * work does not build, and two ways to ask for the same line is one way too many.
 */
export type ConnectorIntent = 'flow' | 'annotation';

export type Side = 'TOP' | 'RIGHT' | 'BOTTOM' | 'LEFT';

/** Where a connector meets a node: the point, and the unit vector pointing away from it. */
export interface Anchor { side: Side; point: Point; normal: Point }

/**
 * Only the two caps this work emits. Figma's StrokeCap has more; narrowing here means an
 * unsupported value cannot reach the renderer by way of a widened type.
 */
export type StrokeCapSpec = 'NONE' | 'ARROW_LINES';

export interface VectorVertexSpec { x: number; y: number; strokeCap: StrokeCapSpec }

export interface VectorSegmentSpec { start: number; end: number }

/**
 * A VectorNetwork ready for `setVectorNetworkAsync`, plus the absolute origin the caller
 * must write to the node's x/y. Vertices are node-relative (measured on a live canvas:
 * the node auto-resizes to the network's bounding box but does NOT move), so the network
 * alone cannot say where on the canvas the connector belongs.
 */
export interface VectorNetworkSpec {
  vertices: VectorVertexSpec[];
  segments: VectorSegmentSpec[];
  origin: Point;
}

/**
 * Bump when a change to anchoring or routing would move an already-drawn connector. The
 * linter reports a record behind the current version as stale so a redraw can repair it,
 * rather than reporting every older connector as drifted geometry.
 */
export const ROUTER_VERSION = 2;

/**
 * One connector, as persisted. `flow` is the provenance that makes the canvas a PROJECTION
 * of the linted graph rather than a second graph beside it: without the transition it
 * renders, an edge's geometry can be verified but its truth cannot. It is null only for an
 * annotation pointer, which answers to no transition.
 */
export interface ConnectionRecord {
  id: string;
  from: string;
  to: string;
  intent: ConnectorIntent;
  flow: { name: string; transitionId: string } | null;
  label: string | null;
  vectorNodeId: string;
  labelNodeId: string | null;
  /** Absolute, rounded to a tenth of a pixel — see connector-route.ts on why rounding. */
  routePoints: Point[];
  routerVersion: number;
}
