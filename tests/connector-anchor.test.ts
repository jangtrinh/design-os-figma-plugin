// Anchor selection is AUTO-only by design: the manual drawing tool that would have needed
// per-side ports was dropped, so a caller can never pick a side and these tests pin the one
// rule that decides it — the dominant axis of the centre-to-centre delta. Pure, no `figma`
// global (see shared/mutating-commands.ts's header for why that matters in this repo).
import { describe, it, expect } from 'vitest';
import { resolveAnchors } from '../shared/connector-anchor.ts';
import type { Rect } from '../shared/connector-types.ts';

const box = (x: number, y: number): Rect => ({ x, y, width: 100, height: 100 });
const ORIGIN = box(0, 0);

describe('AUTO anchor selection — the dominant axis of the centre delta picks the sides', () => {
  // The 8 compass positions of a target around a fixed source. Diagonals resolve on the
  // dominant axis; a perfect 45° diagonal is a tie and resolves horizontally (below).
  const CASES: Array<[string, Rect, string, string]> = [
    ['due east', box(400, 0), 'RIGHT', 'LEFT'],
    ['due west', box(-400, 0), 'LEFT', 'RIGHT'],
    ['due south', box(0, 400), 'BOTTOM', 'TOP'],
    ['due north', box(0, -400), 'TOP', 'BOTTOM'],
    ['north-east, wider than tall', box(400, -100), 'RIGHT', 'LEFT'],
    ['south-east, taller than wide', box(100, 400), 'BOTTOM', 'TOP'],
    ['south-west, wider than tall', box(-400, 100), 'LEFT', 'RIGHT'],
    ['north-west, taller than wide', box(-100, -400), 'TOP', 'BOTTOM'],
  ];

  for (const [name, target, sourceSide, targetSide] of CASES) {
    it(`${name}: source ${sourceSide} -> target ${targetSide}`, () => {
      const anchors = resolveAnchors(ORIGIN, target);
      expect(anchors.source.side).toBe(sourceSide);
      expect(anchors.target.side).toBe(targetSide);
    });
  }

  it('always picks opposing sides, so a route never has to turn a corner at an anchor', () => {
    const OPPOSITE: Record<string, string> = { TOP: 'BOTTOM', BOTTOM: 'TOP', LEFT: 'RIGHT', RIGHT: 'LEFT' };
    for (const [, target] of CASES) {
      const anchors = resolveAnchors(ORIGIN, target);
      expect(OPPOSITE[anchors.source.side]).toBe(anchors.target.side);
    }
  });

  it('anchors sit on the side midpoint with an outward unit normal', () => {
    const anchors = resolveAnchors(ORIGIN, box(400, 0));
    expect(anchors.source.point).toEqual({ x: 100, y: 50 });
    expect(anchors.source.normal).toEqual({ x: 1, y: 0 });
    expect(anchors.target.point).toEqual({ x: 400, y: 50 });
    expect(anchors.target.normal).toEqual({ x: -1, y: 0 });
  });
});

describe('degenerate inputs resolve deterministically instead of throwing', () => {
  it('identical rects fall to the horizontal tie-break rather than NaN', () => {
    const anchors = resolveAnchors(ORIGIN, box(0, 0));
    expect(anchors.source.side).toBe('RIGHT');
    expect(anchors.target.side).toBe('LEFT');
    expect(Number.isFinite(anchors.source.point.x)).toBe(true);
    expect(Number.isFinite(anchors.target.point.y)).toBe(true);
  });

  it('a perfect 45 degree diagonal is a tie and resolves horizontally', () => {
    const anchors = resolveAnchors(ORIGIN, box(300, 300));
    expect(anchors.source.side).toBe('RIGHT');
  });

  it('a zero-size rect still yields a finite anchor at its own position', () => {
    const anchors = resolveAnchors(ORIGIN, { x: 400, y: 0, width: 0, height: 0 });
    expect(anchors.target.point).toEqual({ x: 400, y: 0 });
    expect(Number.isFinite(anchors.target.point.x)).toBe(true);
  });

  it('overlapping rects still produce opposing sides', () => {
    const anchors = resolveAnchors(ORIGIN, box(50, 20));
    expect(anchors.source.side).toBe('RIGHT');
    expect(anchors.target.side).toBe('LEFT');
  });
});
