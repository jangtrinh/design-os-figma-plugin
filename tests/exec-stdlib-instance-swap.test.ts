// `ui.swapInstance` — regression test for a general correctness gap found during the
// FigJam reverse-guard audit (phase-03): unlike `setProps`, `swapInstance` had NO
// `inst.type !== 'INSTANCE'` check at all before calling `inst.swapComponent(...)` —
// it trusted the TS type `InstanceNode`, which is zero protection once a caller (an
// exec-js script, or any wrong-type node reference) hands it a real non-instance
// node. This pre-dates FigJam (already reachable today in a design file by passing a
// FRAME) — FigJam just makes it far more likely, since every FigJam node is
// necessarily "the wrong type" for this helper. Fixed with a general type-check
// (never an editor guard — the same hole would stay open for a wrong-type node IN
// Figma itself).
import { describe, it, expect } from 'vitest';
import { installMockFigma, setMockComponents, type FakeNode } from './helpers/mock-figma.ts';
import { swapInstance } from '../plugin/src/main/exec-stdlib-instance.ts';

let keySeq = 0;
function makeComponent(name: string): FakeNode {
  const figma = (globalThis as unknown as { figma: { createComponent(): FakeNode } }).figma;
  const c = figma.createComponent();
  c.name = name;
  c.key = `key:${keySeq++}`;
  return c;
}

describe('ui.swapInstance', () => {
  it('rejects a non-INSTANCE node with a clear message naming expected vs. found — never a raw "swapComponent is not a function"', async () => {
    installMockFigma();
    const target = makeComponent('Target');
    setMockComponents([target]);
    const figma = (globalThis as unknown as { figma: { createFrame(): FakeNode } }).figma;
    const frame = figma.createFrame();

    await expect(swapInstance(frame as unknown as InstanceNode, target.id))
      .rejects.toMatchObject({
        code: 'E_EVAL',
        message: expect.stringContaining('INSTANCE'),
      });
  });

  it('the rejection names the ACTUAL type found, not a generic message', async () => {
    installMockFigma();
    const target = makeComponent('Target');
    setMockComponents([target]);
    const figma = (globalThis as unknown as { figma: { createRectangle(): FakeNode } }).figma;
    const rect = figma.createRectangle();

    await expect(swapInstance(rect as unknown as InstanceNode, target.id))
      .rejects.toMatchObject({ message: expect.stringContaining('RECTANGLE') });
  });

  it('never reaches swapComponent for a wrong-type node — the type check runs BEFORE ref resolution', async () => {
    installMockFigma();
    const figma = (globalThis as unknown as { figma: { createFrame(): FakeNode } }).figma;
    const frame = figma.createFrame();
    // A ref that would ALSO fail resolution (no components registered at all) — if the
    // type check didn't run first, this would throw "component not found" instead of
    // the type-mismatch message, proving the check ordering.
    await expect(swapInstance(frame as unknown as InstanceNode, 'nonexistent-ref'))
      .rejects.toMatchObject({ message: expect.stringContaining('expects an INSTANCE') });
  });
});
