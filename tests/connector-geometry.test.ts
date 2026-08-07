// A connector's geometry is emitted as a VECTOR NETWORK, never as an SVG path string.
// Measured on a live canvas: the arrowhead is a per-vertex strokeCap that survives a network
// write, and writing `vectorPaths` afterwards wipes every per-vertex cap — so the network is
// the only artifact a renderer may consume. Network coordinates are node-relative, hence the
// returned absolute `origin`. Pure, no `figma` global.
import { describe, it, expect } from 'vitest';
import { pointsToVectorNetwork } from '../shared/connector-geometry.ts';
import type { Point } from '../shared/connector-types.ts';

const ELBOW: Point[] = [{ x: 100, y: 50 }, { x: 124, y: 50 }, { x: 124, y: 350 }, { x: 400, y: 350 }];

describe('vertices and segments', () => {
  it('emits one vertex per point and one segment per gap', () => {
    const net = pointsToVectorNetwork(ELBOW, { arrowAtEnd: true });
    expect(net.vertices).toHaveLength(4);
    expect(net.segments).toHaveLength(3);
    expect(net.segments).toEqual([{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }]);
  });

  it('refuses fewer than two points instead of emitting a degenerate network', () => {
    expect(() => pointsToVectorNetwork([{ x: 0, y: 0 }], { arrowAtEnd: true })).toThrow();
    expect(() => pointsToVectorNetwork([], { arrowAtEnd: true })).toThrow();
  });
});

describe('the arrowhead is a per-vertex cap on the terminal vertex alone', () => {
  it('caps the last vertex and nothing else', () => {
    const net = pointsToVectorNetwork(ELBOW, { arrowAtEnd: true });
    expect(net.vertices.map((v) => v.strokeCap)).toEqual(['NONE', 'NONE', 'NONE', 'ARROW_LINES']);
  });

  it('leaves every vertex uncapped when no arrow was asked for', () => {
    const net = pointsToVectorNetwork(ELBOW, { arrowAtEnd: false });
    expect(net.vertices.every((v) => v.strokeCap === 'NONE')).toBe(true);
  });
});

describe('origin normalization — the node is positioned by origin, not by the path', () => {
  it('shifts the min corner to (0,0) and reports the absolute min as origin', () => {
    const net = pointsToVectorNetwork(ELBOW, { arrowAtEnd: true });
    expect(net.origin).toEqual({ x: 100, y: 50 });
    expect(Math.min(...net.vertices.map((v) => v.x))).toBe(0);
    expect(Math.min(...net.vertices.map((v) => v.y))).toBe(0);
  });

  it('preserves the shape — every vertex keeps its offset from the min corner', () => {
    const net = pointsToVectorNetwork(ELBOW, { arrowAtEnd: true });
    expect(net.vertices.map((v) => ({ x: v.x, y: v.y })))
      .toEqual([{ x: 0, y: 0 }, { x: 24, y: 0 }, { x: 24, y: 300 }, { x: 300, y: 300 }]);
  });

  it('handles negative canvas coordinates without emitting a negative vertex', () => {
    const net = pointsToVectorNetwork([{ x: -400, y: -120 }, { x: -100, y: -120 }], { arrowAtEnd: true });
    expect(net.origin).toEqual({ x: -400, y: -120 });
    expect(net.vertices.map((v) => ({ x: v.x, y: v.y }))).toEqual([{ x: 0, y: 0 }, { x: 300, y: 0 }]);
  });

  it('never emits a signed zero, which would serialize inconsistently', () => {
    const net = pointsToVectorNetwork([{ x: -0.04, y: 0 }, { x: 300, y: 0 }], { arrowAtEnd: true });
    for (const v of net.vertices) {
      expect(Object.is(v.x, -0)).toBe(false);
      expect(Object.is(v.y, -0)).toBe(false);
    }
  });
});

describe('the emitted network is plain JSON and deterministic', () => {
  it('survives a JSON round trip unchanged — no symbols, no class instances', () => {
    const net = pointsToVectorNetwork(ELBOW, { arrowAtEnd: true });
    expect(JSON.parse(JSON.stringify(net))).toEqual(net);
  });

  it('returns byte-identical JSON for the same input, twice', () => {
    expect(JSON.stringify(pointsToVectorNetwork(ELBOW, { arrowAtEnd: true })))
      .toBe(JSON.stringify(pointsToVectorNetwork(ELBOW, { arrowAtEnd: true })));
  });
});
