// The route is chosen by INTENT, never by a caller-supplied mode: a flow edge is an
// orthogonal elbow, an annotation pointer is a straight line. Both are deterministic and
// obstacle-free by design — these flows sit on an even grid, and routing around obstacles is
// explicitly out of scope for this version. Pure, no `figma` global.
import { describe, it, expect } from 'vitest';
import { route, DEFAULT_CLEARANCE } from '../shared/connector-route.ts';
import type { Rect } from '../shared/connector-types.ts';

const box = (x: number, y: number): Rect => ({ x, y, width: 100, height: 100 });

const isAxisAligned = (points: readonly { x: number; y: number }[]): boolean =>
  points.slice(1).every((p, i) => p.x === points[i].x || p.y === points[i].y);

describe('annotation intent — a straight pointer', () => {
  it('is exactly the two anchor points', () => {
    const points = route({ source: box(0, 0), target: box(400, 0), intent: 'annotation' });
    expect(points).toEqual([{ x: 100, y: 50 }, { x: 400, y: 50 }]);
  });

  it('stays two points even on a diagonal, where an elbow would have jogged', () => {
    expect(route({ source: box(0, 0), target: box(400, 300), intent: 'annotation' })).toHaveLength(2);
  });
});

describe('flow intent — an orthogonal elbow', () => {
  it('starts and ends exactly on the anchors', () => {
    const points = route({ source: box(0, 0), target: box(400, 300), intent: 'flow' });
    expect(points[0]).toEqual({ x: 100, y: 50 });
    expect(points[points.length - 1]).toEqual({ x: 400, y: 350 });
  });

  it('turns no closer to an anchor than the clearance', () => {
    // The clearance is a guarantee about WHERE the turn may happen, not an extra vertex:
    // a point that sits on the straight run between the anchor and the turn is redundant
    // geometry, and emitting it would make the stored route brittle for no gain.
    const points = route({ source: box(0, 0), target: box(400, 300), intent: 'flow' });
    expect(points.length).toBeGreaterThan(2);
    expect(points[1].x - points[0].x).toBeGreaterThanOrEqual(DEFAULT_CLEARANCE);
    expect(points[points.length - 1].x - points[points.length - 2].x).toBeGreaterThanOrEqual(DEFAULT_CLEARANCE);
  });

  it('turns only on axis-aligned segments', () => {
    for (const target of [box(400, 300), box(-400, 300), box(300, 400), box(-300, -400)]) {
      expect(isAxisAligned(route({ source: box(0, 0), target, intent: 'flow' }))).toBe(true);
    }
  });

  it('collapses to a straight run when the two anchors already line up', () => {
    // Nothing to jog around: an aligned pair must not emit a zero-width dogleg.
    const points = route({ source: box(0, 0), target: box(400, 0), intent: 'flow' });
    expect(points).toEqual([{ x: 100, y: 50 }, { x: 400, y: 50 }]);
  });

  it('honours an explicit clearance — a large one pushes the turn further out', () => {
    // With a small clearance the turn falls at the midpoint between the two anchors; a
    // clearance larger than that half-gap has to win, or the guarantee is decorative.
    const small = route({ source: box(0, 0), target: box(400, 300), intent: 'flow', clearance: 24 });
    const large = route({ source: box(0, 0), target: box(400, 300), intent: 'flow', clearance: 200 });
    expect(small[1].x).toBe(250);
    expect(large[1].x).toBe(300);
    expect(large[1].x - large[0].x).toBe(200);
  });

  it('emits no zero-length segment for any of the 8 relative positions', () => {
    const targets = [box(400, 0), box(-400, 0), box(0, 400), box(0, -400),
      box(400, -300), box(300, 400), box(-400, 300), box(-300, -400)];
    for (const target of targets) {
      const points = route({ source: box(0, 0), target, intent: 'flow' });
      for (let i = 1; i < points.length; i += 1) {
        expect(points[i]).not.toEqual(points[i - 1]);
      }
    }
  });
});

describe('degenerate inputs stay finite and deterministic', () => {
  const DEGENERATE: Array<[string, Rect, Rect]> = [
    ['identical rects', box(0, 0), box(0, 0)],
    ['overlapping rects', box(0, 0), box(50, 20)],
    ['a zero-size target', box(0, 0), { x: 400, y: 0, width: 0, height: 0 }],
    ['a zero-size source', { x: 0, y: 0, width: 0, height: 0 }, box(400, 0)],
  ];

  for (const [name, source, target] of DEGENERATE) {
    it(`${name}: finite coordinates, at least two points, both intents`, () => {
      for (const intent of ['flow', 'annotation'] as const) {
        const points = route({ source, target, intent });
        expect(points.length).toBeGreaterThanOrEqual(2);
        for (const p of points) {
          expect(Number.isFinite(p.x)).toBe(true);
          expect(Number.isFinite(p.y)).toBe(true);
        }
      }
    });
  }
});

describe('determinism — the linter downstream compares against a stored route', () => {
  it('returns byte-identical JSON for the same input, twice', () => {
    const input = { source: box(0, 0), target: box(437, 291), intent: 'flow' as const };
    expect(JSON.stringify(route(input))).toBe(JSON.stringify(route(input)));
  });

  it('rounds to a tenth of a pixel so float noise cannot drift the stored route', () => {
    const points = route({ source: { x: 0, y: 0, width: 100, height: 33 }, target: box(400, 0), intent: 'flow' });
    for (const p of points) {
      expect(Math.round(p.x * 10) / 10).toBe(p.x);
      expect(Math.round(p.y * 10) / 10).toBe(p.y);
    }
  });
});
