// Reverse editor-guard: design-file-only `ui.*` capabilities (components, variants,
// instances, slots) must refuse cleanly outside the Figma design editor, BEFORE any
// arg validation or node lookup — the forward guards (`ui.figjam.*`/`ui.slides.*`)
// already refuse cleanly in the wrong editor; this is the missing reverse direction.
//
// Classification is by ACTUAL API dependency, verified against `@figma/plugin-typings`
// and this repo's own prior reverse-guard audits (knowledge/figjam.md, knowledge/
// slides.md), not assumed:
//
// GATED (design-file concepts with a documented or type-level Figma-Design-only
// dependency): `ui.componentSet` (figma.combineAsVariants — typings say "only
// available in Figma Design"), `ui.slot.*` (createSlot/resetSlot/
// addComponentProperty only exist on a COMPONENT/COMPONENT_SET/SLOT node, which no
// FigJam or Slides node type can ever be), `ui.setProps`/`ui.swapInstance`
// (componentProperties/swapComponent — INSTANCE-only, and no FigJam/Slides node
// type is ever INSTANCE).
//
// DELIBERATELY LEFT UNGATED (checked, not assumed): `ui.vars.*`, `ui.boundFill`, and
// `ui.annotate.*` all resolve to `figma.variables.*` / `node.setBoundVariable` /
// `figma.annotations.*` — none of these carry a "only available in Figma Design"
// note anywhere in the typings (unlike `combineAsVariants`/`createComponent`, which
// do), and `AnnotationsMixin` is implemented by base shape/text node types that also
// exist in FigJam and Slides. Gating an API with no documented editor restriction
// would be exactly the over-gating regression this task exists to avoid; this suite
// locks that decision in so a future change cannot silently narrow it without a
// failing test naming why.
import { describe, it, expect } from 'vitest';
import {
  installMockFigma, setMockEditorType, setMockComponents, makeMockComponent,
  setMockLocalVariables, makeMockVariable, setMockAnnotationCategories, type FakeNode,
} from './helpers/mock-figma.ts';
import { requireDesignFile } from '../plugin/src/main/exec-stdlib-editor.ts';
import { createExecStdlibComponentSet } from '../plugin/src/main/exec-stdlib-component-set.ts';
import { createExecStdlibSlot } from '../plugin/src/main/exec-stdlib-slot.ts';
import { setProps, swapInstance } from '../plugin/src/main/exec-stdlib-instance.ts';
import { createExecStdlib } from '../plugin/src/main/exec-stdlib.ts';
import { createExecStdlibVars } from '../plugin/src/main/exec-stdlib-variables.ts';
import { createExecStdlibAnnotate } from '../plugin/src/main/exec-stdlib-annotate.ts';

function refusalAssertions(err: unknown, capability: string): void {
  expect((err as { code?: string }).code).toBe('E_INVALID_ARGS');
  const message = (err as Error).message;
  expect(message).toContain(capability);
  expect(message).toContain('Figma design file');
  expect(message).toContain('FigJam board');
}

describe('requireDesignFile (shared helper)', () => {
  it('allows a capability when a Figma design file is open', () => {
    installMockFigma();
    setMockEditorType('figma');
    expect(() => requireDesignFile('ui.componentSet')).not.toThrow();
  });

  it('refuses naming the capability, the wrong editor, and the fix, when FigJam is open', () => {
    installMockFigma();
    setMockEditorType('figjam');
    try {
      requireDesignFile('ui.componentSet');
      expect.fail('expected requireDesignFile to throw');
    } catch (err) {
      refusalAssertions(err, 'ui.componentSet');
    }
  });

  it('refuses when Slides is open', () => {
    installMockFigma();
    setMockEditorType('slides');
    expect(() => requireDesignFile('ui.componentSet')).toThrow(/Figma design file/);
  });
});

describe('ui.componentSet — refuses outside a Figma design file before arg validation', () => {
  it('refuses in FigJam with the editor message, never the "needs exactly one of" arg error', async () => {
    installMockFigma();
    setMockEditorType('figjam');
    try {
      // Deliberately invalid args (neither base nor components) — if the gate did
      // not fire FIRST, this would throw the arg-validation error instead.
      await createExecStdlibComponentSet().componentSet({});
      expect.fail('expected componentSet to throw');
    } catch (err) {
      refusalAssertions(err, 'ui.componentSet');
    }
  });

  it('runs (past the gate) in a Figma design file', async () => {
    installMockFigma();
    setMockEditorType('figma');
    const base = makeMockComponent('Base');
    setMockComponents([base]);
    await expect(createExecStdlibComponentSet().componentSet({ base: base.id, axes: { State: ['default'] } }))
      .resolves.toMatchObject({ variantCount: 1 });
  });
});

describe('ui.slot.* — refuses outside a Figma design file before arg validation', () => {
  it('create() refuses in FigJam, never the "must be a COMPONENT" arg error', async () => {
    installMockFigma();
    setMockEditorType('figjam');
    try {
      await createExecStdlibSlot().create('not-a-real-id');
      expect.fail('expected slot.create to throw');
    } catch (err) {
      refusalAssertions(err, 'ui.slot.create');
    }
  });

  it('list() refuses in FigJam', async () => {
    installMockFigma();
    setMockEditorType('figjam');
    await expect(createExecStdlibSlot().list('not-a-real-id'))
      .rejects.toMatchObject({ code: 'E_INVALID_ARGS', message: expect.stringContaining('ui.slot.list') });
  });

  it('append() refuses in FigJam', async () => {
    installMockFigma();
    setMockEditorType('figjam');
    await expect(createExecStdlibSlot().append({ slotId: 'not-a-real-id' }, {}))
      .rejects.toMatchObject({ code: 'E_INVALID_ARGS', message: expect.stringContaining('ui.slot.append') });
  });

  it('reset() refuses in FigJam', async () => {
    installMockFigma();
    setMockEditorType('figjam');
    await expect(createExecStdlibSlot().reset({ slotId: 'not-a-real-id' }))
      .rejects.toMatchObject({ code: 'E_INVALID_ARGS', message: expect.stringContaining('ui.slot.reset') });
  });

  it('addProperty() refuses in FigJam', async () => {
    installMockFigma();
    setMockEditorType('figjam');
    await expect(createExecStdlibSlot().addProperty('not-a-real-id', 'Content', 'also-not-real'))
      .rejects.toMatchObject({ code: 'E_INVALID_ARGS', message: expect.stringContaining('ui.slot.addProperty') });
  });

  it('create() runs (past the gate) in a Figma design file', async () => {
    installMockFigma();
    setMockEditorType('figma');
    const base = makeMockComponent('Card');
    setMockComponents([base]);
    await expect(createExecStdlibSlot().create(base.id)).resolves.toMatchObject({ type: 'SLOT' });
  });
});

describe('ui.setProps / ui.swapInstance — refuse outside a Figma design file before arg validation', () => {
  it('setProps refuses in FigJam, never the "expects an INSTANCE" type error', async () => {
    installMockFigma();
    setMockEditorType('figjam');
    const notAnInstance = {} as unknown as InstanceNode;
    try {
      await setProps(notAnInstance, { Label: 'x' });
      expect.fail('expected setProps to throw');
    } catch (err) {
      refusalAssertions(err, 'ui.setProps');
    }
  });

  it('swapInstance refuses in FigJam, never the "expects an INSTANCE" type error', async () => {
    installMockFigma();
    setMockEditorType('figjam');
    const notAnInstance = {} as unknown as InstanceNode;
    try {
      await swapInstance(notAnInstance, 'not-a-real-ref');
      expect.fail('expected swapInstance to throw');
    } catch (err) {
      refusalAssertions(err, 'ui.swapInstance');
    }
  });

  it('setProps runs (past the gate) in a Figma design file', async () => {
    installMockFigma();
    setMockEditorType('figma');
    const main = makeMockComponent('Button');
    main.componentPropertyDefinitions = { Label: { type: 'TEXT' } };
    setMockComponents([main]);
    const inst = main.createInstance() as unknown as FakeNode & { componentProperties: unknown };
    inst.componentProperties = { Label: { type: 'TEXT', value: 'hi' } };
    await expect(setProps(inst as never, { Label: 'hello' })).resolves.toMatchObject({ Label: 'hello' });
  });
});

describe('regression guard — editor-agnostic node reads must NOT be gated', () => {
  it('byPath still executes in FigJam (no design-file gate on generic traversal)', async () => {
    installMockFigma();
    setMockEditorType('figjam');
    const figma = (globalThis as unknown as { figma: { createFrame(): FakeNode } }).figma;
    const root = figma.createFrame();
    const child = figma.createFrame();
    child.name = 'Child';
    root.appendChild(child as never);

    const result = await createExecStdlib().byPath(root.id, ['Child']);
    expect(result.id).toBe(child.id);
  });

  it('q still executes in FigJam (no design-file gate on generic serialization)', async () => {
    installMockFigma();
    setMockEditorType('figjam');
    const figma = (globalThis as unknown as { figma: { createFrame(): FakeNode } }).figma;
    const node = figma.createFrame();

    const result = await createExecStdlib().q(node.id) as { id: string };
    expect(result.id).toBe(node.id);
  });

  it('ui.vars.* still executes in FigJam — no documented editor restriction on figma.variables.*', async () => {
    installMockFigma();
    setMockEditorType('figjam');
    const variable = makeMockVariable('color/old');
    setMockLocalVariables([variable]);

    const result = await createExecStdlibVars().rename(variable.name, 'color/new');
    expect(result.name).toBe('color/new');
  });

  it('ui.boundFill still executes in FigJam — same undocumented-restriction reasoning as vars', async () => {
    const figma = installMockFigma();
    setMockEditorType('figjam');
    const variable = makeMockVariable('Brand/Primary', 'COLOR');
    setMockLocalVariables([variable]);
    const node = figma.createFrame() as unknown as FakeNode;

    const result = await createExecStdlib().boundFill(node as never, variable.name);
    expect(result.variable).toBe(variable.name);
  });

  it('ui.annotate.* still executes in FigJam — AnnotationsMixin covers base shape/text nodes there too', async () => {
    installMockFigma();
    setMockEditorType('figjam');
    setMockAnnotationCategories([]);
    const figma = (globalThis as unknown as { figma: { createFrame(): FakeNode } }).figma;
    const node = figma.createFrame();
    node.annotations = [{ label: 'Hello' }];

    const result = await createExecStdlibAnnotate().get(node.id);
    expect(result.annotationCount).toBe(1);
  });
});
