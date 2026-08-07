// Where a connector meets its two nodes. Selection is AUTO and only AUTO: the manual
// drawing tool that would have let a designer pick a side is not built, so exposing a port
// argument would be an API with no caller. Pure — no `figma` access.

import type { Anchor, Point, Rect, Side } from './connector-types';

const OPPOSITE: Record<Side, Side> = { TOP: 'BOTTOM', BOTTOM: 'TOP', LEFT: 'RIGHT', RIGHT: 'LEFT' };

const NORMAL: Record<Side, Point> = {
  TOP: { x: 0, y: -1 },
  BOTTOM: { x: 0, y: 1 },
  LEFT: { x: -1, y: 0 },
  RIGHT: { x: 1, y: 0 },
};

function centre(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/** The midpoint of one side of a box. A zero-size box collapses to its own position. */
function sideMidpoint(rect: Rect, side: Side): Point {
  switch (side) {
    case 'TOP': return { x: rect.x + rect.width / 2, y: rect.y };
    case 'BOTTOM': return { x: rect.x + rect.width / 2, y: rect.y + rect.height };
    case 'LEFT': return { x: rect.x, y: rect.y + rect.height / 2 };
    case 'RIGHT': return { x: rect.x + rect.width, y: rect.y + rect.height / 2 };
  }
}

function anchorOn(rect: Rect, side: Side): Anchor {
  return { side, point: sideMidpoint(rect, side), normal: NORMAL[side] };
}

/**
 * Pick both anchors from the two boxes alone.
 *
 * The dominant axis of the centre-to-centre delta decides: a target mostly to the side
 * leaves through a vertical edge, a target mostly above or below leaves through a
 * horizontal one. A perfect diagonal — and the fully degenerate case of two boxes sharing
 * a centre — is a tie, and ties resolve horizontally. That is arbitrary but it must be
 * SOMETHING fixed: a tie broken by float noise would redraw the same flow differently on
 * different runs, and the linter compares a redraw against the stored route.
 *
 * The target's side is always the source side's opposite, so a route never has to turn a
 * corner at an anchor — every elbow this produces leaves and arrives along the same axis.
 */
export function resolveAnchors(source: Rect, target: Rect): { source: Anchor; target: Anchor } {
  const from = centre(source);
  const to = centre(target);
  const dx = to.x - from.x;
  const dy = to.y - from.y;

  const horizontal = Math.abs(dx) >= Math.abs(dy);
  const sourceSide: Side = horizontal
    ? (dx >= 0 ? 'RIGHT' : 'LEFT')
    : (dy >= 0 ? 'BOTTOM' : 'TOP');

  return { source: anchorOn(source, sourceSide), target: anchorOn(target, OPPOSITE[sourceSide]) };
}
