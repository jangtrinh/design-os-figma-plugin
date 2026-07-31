// `ui.componentSet(...)` — variant-matrix / combine-existing component-set builder
// (absorption phase-01, Basket B). Covers: happy path (both modes), failed-verification
// throw, bad-input throws, cartesian-order determinism, `=`/`,` rejection, and the
// over-cap rejection (plan §8 Definition of Done).
import { describe, it, expect } from 'vitest';
import { installMockFigma, setMockComponents, type FakeNode } from './helpers/mock-figma.ts';
import { createExecStdlibComponentSet } from '../plugin/src/main/exec-stdlib-component-set.ts';
import {
  cartesianProduct, comboName, assertCleanToken, parseComboName, sameAxisMap,
} from '../plugin/src/main/exec-stdlib-component-matrix.ts';

let keySeq = 0;
function makeComponent(name: string): FakeNode {
  const figma = (globalThis as unknown as { figma: { createComponent(): FakeNode } }).figma;
  const c = figma.createComponent();
  c.name = name;
  c.key = `key:${keySeq++}`; // every real COMPONENT carries a publish key
  return c;
}

describe('componentSet — mode selection', () => {
  it('throws E_INVALID_ARGS when neither base nor components is given', async () => {
    installMockFigma();
    await expect(createExecStdlibComponentSet().componentSet({}))
      .rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
  });

  it('throws E_INVALID_ARGS when both base and components are given', async () => {
    installMockFigma();
    await expect(createExecStdlibComponentSet().componentSet({ base: '1:1', components: ['1:2'] }))
      .rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
  });

  it('throws E_INVALID_ARGS when base is given without axes', async () => {
    installMockFigma();
    const base = makeComponent('Base');
    setMockComponents([base]);
    await expect(createExecStdlibComponentSet().componentSet({ base: base.id }))
      .rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
  });
});

describe('componentSet — mode 1 (base + axes)', () => {
  it('builds the cartesian product, keeps the base id as the first variant, and reads back propertyDefinitions', async () => {
    installMockFigma();
    const base = makeComponent('Base');
    setMockComponents([base]);

    const result = await createExecStdlibComponentSet().componentSet({
      base: base.id,
      axes: { State: ['default', 'hover'], Size: ['sm', 'lg'] },
    });

    expect(result.variantCount).toBe(4);
    // Deterministic order: axis insertion order (State, then Size), values in given order.
    expect(result.variants.map((v) => v.name)).toEqual([
      'State=default, Size=sm', 'State=default, Size=lg',
      'State=hover, Size=sm', 'State=hover, Size=lg',
    ]);
    // The base's own node id is preserved as the FIRST variant.
    expect(result.variants[0]!.id).toBe(base.id);
    expect(result.variants.every((v) => typeof v.key === 'string')).toBe(true);
    expect(result.propertyDefinitions).toHaveProperty('State');
    expect(result.propertyDefinitions).toHaveProperty('Size');
  });

  it('rejects a base already inside a COMPONENT_SET', async () => {
    installMockFigma();
    const base = makeComponent('Base');
    const other = makeComponent('State=default');
    setMockComponents([base, other]);
    const figma = (globalThis as unknown as { figma: { combineAsVariants: (n: FakeNode[], p: FakeNode) => FakeNode; currentPage: FakeNode } }).figma;
    figma.combineAsVariants([other], figma.currentPage); // puts `other` inside a set

    await expect(createExecStdlibComponentSet().componentSet({ base: other.id, axes: { State: ['default'] } }))
      .rejects.toMatchObject({ code: 'E_INVALID_ARGS', message: expect.stringContaining('already a variant') });
  });

  it('rejects an axis or value containing "=" or ","', async () => {
    installMockFigma();
    const base = makeComponent('Base');
    setMockComponents([base]);
    await expect(createExecStdlibComponentSet().componentSet({ base: base.id, axes: { 'Sta=te': ['default'] } }))
      .rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
    await expect(createExecStdlibComponentSet().componentSet({ base: base.id, axes: { State: ['de,fault'] } }))
      .rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
  });

  it('rejects a matrix over the 100-combination cap', async () => {
    installMockFigma();
    const base = makeComponent('Base');
    setMockComponents([base]);
    const many = Array.from({ length: 11 }, (_, i) => `v${i}`); // 11 * 11 = 121 > 100
    await expect(createExecStdlibComponentSet().componentSet({ base: base.id, axes: { A: many, B: many } }))
      .rejects.toMatchObject({ code: 'E_INVALID_ARGS', message: expect.stringContaining('121') });
  });

  it('carries a sizeWarning above 40 variants, without rejecting', async () => {
    installMockFigma();
    const base = makeComponent('Base');
    setMockComponents([base]);
    const values = Array.from({ length: 41 }, (_, i) => `v${i}`);
    const result = await createExecStdlibComponentSet().componentSet({ base: base.id, axes: { A: values } });
    expect(result.variantCount).toBe(41);
    expect(result.sizeWarning).toContain('41 variants');
  });

  it('throws E_EVAL when the combined set disagrees with what we intended, AND self-cleans up: base name restored, its own clone removed', async () => {
    const figma = installMockFigma();
    const base = makeComponent('Base');
    setMockComponents([base]);
    const originalCombine = figma.combineAsVariants.bind(figma);
    // Force a broken combine: truncate the set's children after Figma "combines" them —
    // the exact shape a silent-trust implementation would wave through unverified.
    figma.combineAsVariants = ((nodes: FakeNode[], parent: FakeNode) => {
      const set = originalCombine(nodes, parent);
      set.children = set.children.slice(0, 1);
      return set;
    }) as typeof figma.combineAsVariants;

    await expect(createExecStdlibComponentSet().componentSet({ base: base.id, axes: { State: ['default', 'hover'] } }))
      .rejects.toMatchObject({ code: 'E_EVAL' });

    // Stage-4 review issue 2: the helper's OWN mutations (rename the base, clone it)
    // must not survive its OWN thrown failure — the base's NAME is restored. (The
    // base itself is still inside whatever `combineAsVariants` produced — cleanup is
    // bounded to what the helper created/renamed, not un-combining Figma's own
    // structure; that entanglement is exactly `--undo-group`'s job, not this helper's.)
    expect(base.name).toBe('Base');
  });

  it('restores the base name AND removes its own clone when the failure is UNRELATED to verification (e.g. combineAsVariants itself throws) — ruled independently of issue 2', async () => {
    const figma = installMockFigma();
    const frame = figma.createFrame(); // a real parent, so clone() actually attaches — proves removal
    const base = makeComponent('Base');
    frame.appendChild(base);
    setMockComponents([base]);
    figma.combineAsVariants = (() => { throw new Error('in combineAsVariants: boom'); }) as typeof figma.combineAsVariants;

    await expect(createExecStdlibComponentSet().componentSet({ base: base.id, axes: { State: ['default', 'hover'] } }))
      .rejects.toThrow(/boom/);

    expect(base.name).toBe('Base');
    // Exactly the base remains in the frame — the clone `buildModeA` created for the
    // second axis value was removed by cleanup(), not left orphaned on the canvas.
    expect(frame.children).toEqual([base]);
  });

  it('rejects a parent that cannot sensibly hold a component set (a COMPONENT, not PAGE/FRAME/SECTION/GROUP)', async () => {
    installMockFigma();
    const base = makeComponent('Base');
    const notAContainer = makeComponent('NotAContainer');
    setMockComponents([base, notAContainer]);

    await expect(createExecStdlibComponentSet().componentSet({
      base: base.id, axes: { State: ['default'] }, parent: notAContainer.id,
    })).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
  });
});

describe('componentSet — mode 2 (combine existing components)', () => {
  it('renames each component via variantProps before combining', async () => {
    installMockFigma();
    const a = makeComponent('CompA');
    const b = makeComponent('CompB');
    setMockComponents([a, b]);

    const result = await createExecStdlibComponentSet().componentSet({
      components: [a.id, b.id],
      variantProps: [{ State: 'default' }, { State: 'hover' }],
    });

    expect(result.variantCount).toBe(2);
    expect(result.variants.map((v) => v.name)).toEqual(['State=default', 'State=hover']);
  });

  it('warns (never rejects) when a component name lacks "=" and no variantProps is given', async () => {
    installMockFigma();
    const a = makeComponent('Plain Name');
    setMockComponents([a]);

    const result = await createExecStdlibComponentSet().componentSet({ components: [a.id] });
    expect(result.warnings?.[0]).toContain('Property 1=Plain Name');
  });

  it('rejects a component already inside a COMPONENT_SET', async () => {
    const figma = installMockFigma();
    const a = makeComponent('State=default');
    setMockComponents([a]);
    figma.combineAsVariants([a], figma.currentPage);

    await expect(createExecStdlibComponentSet().componentSet({ components: [a.id] }))
      .rejects.toMatchObject({ code: 'E_INVALID_ARGS', message: expect.stringContaining('already a variant') });
  });

  it('rejects a variantProps length mismatch', async () => {
    installMockFigma();
    const a = makeComponent('CompA');
    setMockComponents([a]);
    await expect(createExecStdlibComponentSet().componentSet({ components: [a.id], variantProps: [] }))
      .rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
  });

  it('restores each component\'s original name when a later step throws — mode 2\'s own rollback', async () => {
    const figma = installMockFigma();
    const a = makeComponent('CompA');
    const b = makeComponent('CompB');
    setMockComponents([a, b]);
    figma.combineAsVariants = (() => { throw new Error('in combineAsVariants: boom'); }) as typeof figma.combineAsVariants;

    await expect(createExecStdlibComponentSet().componentSet({
      components: [a.id, b.id],
      variantProps: [{ State: 'default' }, { State: 'hover' }],
    })).rejects.toThrow(/boom/);

    expect(a.name).toBe('CompA');
    expect(b.name).toBe('CompB');
  });
});

describe('exec-stdlib-component-matrix — pure helpers', () => {
  it('cartesianProduct is deterministic: axis insertion order, values in given order', () => {
    const combos = cartesianProduct({ State: ['default', 'hover'], Size: ['sm', 'lg'] });
    expect(combos).toEqual([
      { State: 'default', Size: 'sm' }, { State: 'default', Size: 'lg' },
      { State: 'hover', Size: 'sm' }, { State: 'hover', Size: 'lg' },
    ]);
  });

  it('comboName / parseComboName round-trip', () => {
    const combo = { State: 'hover', Size: 'lg' };
    const name = comboName(combo, ['State', 'Size']);
    expect(name).toBe('State=hover, Size=lg');
    expect(parseComboName(name)).toEqual(combo);
  });

  it('assertCleanToken throws on "=" or ","', () => {
    expect(() => assertCleanToken('axis', 'a=b')).toThrow(/must not contain/);
    expect(() => assertCleanToken('value', 'a,b')).toThrow(/must not contain/);
    expect(() => assertCleanToken('axis', 'clean')).not.toThrow();
  });

  it('sameAxisMap compares by content, not key order', () => {
    expect(sameAxisMap({ State: 'hover', Size: 'lg' }, { Size: 'lg', State: 'hover' })).toBe(true);
    expect(sameAxisMap({ State: 'hover' }, { State: 'default' })).toBe(false);
  });
});

// Stage-4 review, PR #10 minor 3 — the mock must encode the refusals real Figma
// gives, independent of any caller's own pre-checks, or it is not trustworthy.
describe('mock-figma — figma.combineAsVariants refusals', () => {
  it('refuses an empty node list', () => {
    const figma = installMockFigma();
    expect(() => figma.combineAsVariants([], figma.currentPage)).toThrow(/at least one node/);
  });

  it('refuses a non-COMPONENT node', () => {
    const figma = installMockFigma();
    const frame = figma.createFrame();
    expect(() => figma.combineAsVariants([frame], figma.currentPage)).toThrow(/not a COMPONENT/);
  });

  it('refuses a component already inside a COMPONENT_SET', () => {
    const figma = installMockFigma();
    const a = makeComponent('State=default');
    figma.combineAsVariants([a], figma.currentPage);
    const b = makeComponent('State=hover');
    expect(() => figma.combineAsVariants([a, b], figma.currentPage)).toThrow(/already belongs to a component set/);
  });
});
