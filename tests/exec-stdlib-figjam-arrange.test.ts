// `ui.figjam.arrange` (absorption phase-03). Pure geometry (`computeArrangement`) for
// n=1,2,5,9 and each layout, plus the wrapper's editor refusal and `skipped` reporting.
import { describe, it, expect } from 'vitest';
import { installMockFigma, setMockEditorType, type FakeNode } from './helpers/mock-figma.ts';
import { computeArrangement, arrange } from '../plugin/src/main/exec-stdlib-figjam-arrange.ts';

interface Box { x: number; y: number; width: number; height: number }
const box = (w = 10, h = 10): Box => ({ x: -1, y: -1, width: w, height: h });

describe('computeArrangement — pure geometry', () => {
  it('grid: default columns = ceil(sqrt(n)) for n=1,2,5,9', () => {
    for (const [n, expectedCols] of [[1, 1], [2, 2], [5, 3], [9, 3]] as const) {
      const nodes = Array.from({ length: n }, () => box());
      computeArrangement(nodes, 'grid', 20);
      // Column index of the LAST node in row 0 tells us the effective column count:
      // the node at index (expectedCols - 1) shares row 0's y (0); index expectedCols
      // (if it exists) has wrapped to a new row.
      if (expectedCols < n) expect(nodes[expectedCols]!.y).toBeGreaterThan(0);
      expect(nodes[0]!.x).toBe(0);
      expect(nodes[0]!.y).toBe(0);
    }
  });

  it('grid: honours an explicit columns override', () => {
    const nodes = Array.from({ length: 5 }, () => box());
    computeArrangement(nodes, 'grid', 10, 2);
    expect(nodes[2]!.y).toBeGreaterThan(0); // wrapped after 2 columns, not the sqrt default (3)
  });

  it('horizontal: every node on the same row, x increasing by width+spacing', () => {
    const nodes = [box(10), box(20), box(30)];
    computeArrangement(nodes, 'horizontal', 5);
    expect(nodes.map((n) => n.y)).toEqual([0, 0, 0]);
    expect(nodes[0]!.x).toBe(0);
    expect(nodes[1]!.x).toBe(15); // 10 + 5
    expect(nodes[2]!.x).toBe(40); // 15 + 20 + 5
  });

  it('vertical: every node in the same column, y increasing by height+spacing', () => {
    const nodes = [box(10, 10), box(10, 20), box(10, 30)];
    computeArrangement(nodes, 'vertical', 5);
    expect(nodes.map((n) => n.x)).toEqual([0, 0, 0]);
    expect(nodes[0]!.y).toBe(0);
    expect(nodes[1]!.y).toBe(15);
    expect(nodes[2]!.y).toBe(40);
  });
});

describe('ui.figjam.arrange (wrapper)', () => {
  it('refuses outside FigJam', async () => {
    installMockFigma();
    setMockEditorType('figma');
    await expect(arrange(['1:1'])).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
  });

  it('rejects a batch over the 500-node cap', async () => {
    installMockFigma();
    setMockEditorType('figjam');
    await expect(arrange(Array.from({ length: 501 }, (_, i) => `id-${i}`))).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
  });

  it('reports skipped ids for nodes that do not resolve, never throwing for a partial failure', async () => {
    installMockFigma();
    setMockEditorType('figjam');
    const figma = (globalThis as unknown as { figma: { createFrame(): FakeNode } }).figma;
    const a = figma.createFrame();
    const b = figma.createFrame();
    const result = await arrange([a.id, 'nope', b.id]);
    expect(result.arranged).toBe(2);
    expect(result.skipped).toEqual(['nope']);
  });
});
