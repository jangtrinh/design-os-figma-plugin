// The polyline a connector follows, chosen by INTENT. Pure — no `figma` access.
//
// No general obstacle avoidance: that is a search problem with its own failure modes, and
// nothing has measured a need for it. But ONE obstacle case is not incidental, it is
// structural — a flow laid out in reading order always has return edges, and a return edge
// drawn as a straight line runs through every screen between its two ends. That case gets a
// rule, not a search: it bows below the row, which is what a flow diagram does anyway.

import { resolveAnchors, resolveAnnotationAnchors } from './connector-anchor';
import type { Anchor, ConnectorIntent, Point, Rect } from './connector-types';

/** Half a 48px grid step — far enough to read as a deliberate exit, short enough to stay tidy. */
export const DEFAULT_CLEARANCE = 24;

/**
 * A tenth of a pixel. Routes are stored on the connection record and compared against a
 * fresh route later; rounding at the source keeps that comparison from drowning in float
 * noise, and keeps the emitted JSON byte-identical for identical input.
 */
function round(value: number): number {
  const rounded = Math.round(value * 10) / 10;
  return rounded === 0 ? 0 : rounded; // never -0: it serializes inconsistently
}

function roundPoint(point: Point): Point {
  return { x: round(point.x), y: round(point.y) };
}

function samePoint(a: Point, b: Point): boolean {
  return a.x === b.x && a.y === b.y;
}

/** Three points with a shared x (or a shared y) mean the middle one bends nothing. */
function isRedundant(previous: Point, current: Point, next: Point): boolean {
  const sharedX = previous.x === current.x && current.x === next.x;
  const sharedY = previous.y === current.y && current.y === next.y;
  return sharedX || sharedY;
}

/**
 * Drop points that carry no information: repeats, and any point sitting on the straight run
 * between its neighbours. Both appear naturally in the elbow construction below — an
 * already-aligned pair produces a zero-width jog, and the clearance step is collinear with
 * the turn whenever the turn is further out than the clearance. Emitting either would put
 * vertices in the network that no reader can distinguish from real corners.
 */
function simplify(points: readonly Point[]): Point[] {
  const deduped: Point[] = [];
  for (const point of points) {
    if (deduped.length === 0 || !samePoint(deduped[deduped.length - 1], point)) deduped.push(point);
  }
  const kept: Point[] = [];
  for (let i = 0; i < deduped.length; i += 1) {
    const isEnd = i === 0 || i === deduped.length - 1;
    if (isEnd || !isRedundant(deduped[i - 1], deduped[i], deduped[i + 1])) kept.push(deduped[i]);
  }
  return kept;
}

/**
 * Where the elbow turns, on the axis the two anchors face along.
 *
 * The midpoint between the two clearance points is the tidy answer, but it is only tidy
 * while the target actually lies ahead of the source. When the boxes overlap or the target
 * sits behind, that midpoint can land inside the source box — so the clearance wins: the
 * turn never happens nearer than `clearance` past the anchor, whatever the midpoint says.
 */
function turnCoordinate(from: number, to: number, direction: number): number {
  const midpoint = (from + to) / 2;
  return direction >= 0 ? Math.max(midpoint, from) : Math.min(midpoint, from);
}

function centre(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/**
 * Is this edge travelling against the reading order of a row of screens?
 *
 * Left-to-right is forward in every flow layout this draws into; an edge going the other way
 * is a return path. It only matters when the two boxes share vertical space — that is exactly
 * when a straight line between them would pass through whatever sits in the row between.
 * Two boxes on separate rows have clear space, and a straight line there is correct.
 */
function isBackEdge(source: Rect, target: Rect, intent: ConnectorIntent): boolean {
  if (intent !== 'flow') return false;
  const from = centre(source);
  const to = centre(target);
  if (Math.abs(to.x - from.x) < Math.abs(to.y - from.y)) return false; // a column, not a row
  if (to.x - from.x >= 0) return false; // forward
  const overlapTop = Math.max(source.y, target.y);
  const overlapBottom = Math.min(source.y + source.height, target.y + target.height);
  return overlapTop < overlapBottom;
}

/**
 * A return edge, bowed below both boxes.
 *
 * Both ends leave downward and meet on one horizontal run under the row, which reads as
 * "back to the start" at a glance and, more importantly, does not cross the screens in
 * between. The depth clears the LOWER of the two boxes, so the run stays clear of both.
 */
function backEdge(source: Rect, target: Rect, clearance: number): Point[] {
  const exit: Point = { x: source.x + source.width / 2, y: source.y + source.height };
  const entry: Point = { x: target.x + target.width / 2, y: target.y + target.height };
  const depth = Math.max(exit.y, entry.y) + clearance * 2;
  return [exit, { x: exit.x, y: depth }, { x: entry.x, y: depth }, entry];
}

function orthogonal(source: Anchor, target: Anchor, clearance: number): Point[] {
  const exit: Point = {
    x: source.point.x + source.normal.x * clearance,
    y: source.point.y + source.normal.y * clearance,
  };
  const entry: Point = {
    x: target.point.x + target.normal.x * clearance,
    y: target.point.y + target.normal.y * clearance,
  };

  // Anchors always oppose each other (see connector-anchor.ts), so both face the same axis
  // and a single mid-axis jog joins them — there is no perpendicular case to handle.
  if (source.normal.x !== 0) {
    const x = turnCoordinate(exit.x, entry.x, source.normal.x);
    return [source.point, exit, { x, y: exit.y }, { x, y: entry.y }, entry, target.point];
  }
  const y = turnCoordinate(exit.y, entry.y, source.normal.y);
  return [source.point, exit, { x: exit.x, y }, { x: entry.x, y }, entry, target.point];
}

export interface RouteInput {
  source: Rect;
  target: Rect;
  intent: ConnectorIntent;
  clearance?: number;
}

/**
 * The polyline from one node to another, in absolute canvas coordinates.
 *
 * A flow edge is an orthogonal elbow — a diagram reads as a diagram because its edges turn
 * squarely. An annotation pointer is a straight line, because a pointer that jogs reads as
 * a relationship rather than as "this label is about that thing".
 */
export function route(input: RouteInput): Point[] {
  const anchors = input.intent === 'annotation'
    ? resolveAnnotationAnchors(input.source, input.target)
    : resolveAnchors(input.source, input.target);
  const clearance = input.clearance ?? DEFAULT_CLEARANCE;
  let raw: Point[];
  if (input.intent === 'annotation') {
    raw = [anchors.source.point, anchors.target.point];
  } else if (isBackEdge(input.source, input.target, input.intent)) {
    raw = backEdge(input.source, input.target, clearance);
  } else {
    raw = orthogonal(anchors.source, anchors.target, clearance);
  }
  const simplified = simplify(raw.map(roundPoint));
  // Two coincident anchors (boxes sharing a centre and a size) would simplify to one point;
  // a connector needs two ends, so keep the pair rather than returning something no
  // renderer can consume.
  return simplified.length >= 2 ? simplified : [roundPoint(anchors.source.point), roundPoint(anchors.target.point)];
}
