// `ui.annotate.*` — Figma Annotations (absorption phase-02). Covers: get() happy
// path + includeChildren/depth walk + skippedChildren counting, categories(),
// set() replace mode, set() append mode's label/labelMarkdown merge (fact 2 —
// gets its own dedicated case per the phase spec), invalid property-type
// rejection with nearest-match suggestions, the verify-mismatch E_EVAL path, and
// the 'annotations' in node capability refusal (fact 1).
import { describe, it, expect } from 'vitest';
import { installMockFigma, setMockAnnotationCategories, type FakeNode } from './helpers/mock-figma.ts';
import { createExecStdlibAnnotate } from '../plugin/src/main/exec-stdlib-annotate.ts';

function getFigma(): { createFrame(): FakeNode; createRectangle(): FakeNode } {
  return (globalThis as unknown as { figma: { createFrame(): FakeNode; createRectangle(): FakeNode } }).figma;
}

describe('ui.annotate.get', () => {
  it('reads a node\'s own annotations', async () => {
    installMockFigma();
    const node = getFigma().createFrame();
    node.annotations = [{ label: 'Hello', properties: [{ type: 'fills' }] }];

    const result = await createExecStdlibAnnotate().get(node.id);
    expect(result.annotationCount).toBe(1);
    expect(result.annotations[0]).toMatchObject({ label: 'Hello', properties: [{ type: 'fills' }] });
  });

  it('rejects a node type that does not support annotations (fact 1)', async () => {
    installMockFigma();
    const node = getFigma().createFrame();
    delete (node as unknown as Record<string, unknown>).annotations;
    // Force `'annotations' in node` to be false by removing the own property AND
    // the class's index signature default — simulate a node type (e.g. PAGE) that
    // never carries the field by using a plain object with no such key.
    const bareNode = { id: node.id, type: 'PAGE', name: 'Page' };
    // Swap the registry entry the mock resolves so getNodeByIdAsync returns the bare object.
    const figma = (globalThis as unknown as { figma: { getNodeByIdAsync: (id: string) => Promise<unknown> } }).figma;
    const orig = figma.getNodeByIdAsync;
    figma.getNodeByIdAsync = async (id: string) => (id === node.id ? bareNode : orig(id));

    await expect(createExecStdlibAnnotate().get(node.id)).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
  });

  it('walks children up to depth and counts them', async () => {
    installMockFigma();
    const root = getFigma().createFrame();
    const child = getFigma().createFrame();
    child.annotations = [{ label: 'Child note' }];
    root.appendChild(child);

    const result = await createExecStdlibAnnotate().get(root.id, { includeChildren: true, depth: 1 });
    expect(result.children).toHaveLength(1);
    expect(result.children![0]!.annotations[0]).toMatchObject({ label: 'Child note' });
    expect(result.childAnnotationCount).toBe(1);
    expect(result.skippedChildren).toBe(0);
  });

  it('does not descend past the requested depth', async () => {
    installMockFigma();
    const root = getFigma().createFrame();
    const child = getFigma().createFrame();
    const grandchild = getFigma().createFrame();
    grandchild.annotations = [{ label: 'Too deep' }];
    child.appendChild(grandchild);
    root.appendChild(child);

    const result = await createExecStdlibAnnotate().get(root.id, { includeChildren: true, depth: 1 });
    expect(result.children).toHaveLength(0);
  });

  it('counts (never silently drops) a child that throws on property access (fact 5)', async () => {
    installMockFigma();
    const root = getFigma().createFrame();
    const child = getFigma().createFrame();
    // Simulate a slot-sublayer-style throw on annotation access via a getter.
    Object.defineProperty(child, 'annotations', {
      get() { throw new Error('property access refused on this node'); },
      configurable: true,
    });
    root.appendChild(child);

    const result = await createExecStdlibAnnotate().get(root.id, { includeChildren: true });
    expect(result.skippedChildren).toBe(1);
    expect(result.children).toHaveLength(0);
  });

  it('reports categoryName:null for an annotation whose categoryId matches nothing (fact 4)', async () => {
    installMockFigma();
    setMockAnnotationCategories([{ id: 'cat:1', label: 'Accessibility' }]);
    const node = getFigma().createFrame();
    node.annotations = [{ label: 'Orphaned', categoryId: 'cat:unknown' }];

    const result = await createExecStdlibAnnotate().get(node.id);
    expect(result.annotations[0]).toMatchObject({ categoryId: 'cat:unknown', categoryName: null });
  });
});

describe('ui.annotate.categories', () => {
  it('surfaces the host\'s annotation categories, mapping label to name', async () => {
    installMockFigma();
    setMockAnnotationCategories([{ id: 'cat:1', label: 'Accessibility' }, { id: 'cat:2', label: 'Content' }]);

    const result = await createExecStdlibAnnotate().categories();
    expect(result.categories).toEqual([{ id: 'cat:1', name: 'Accessibility' }, { id: 'cat:2', name: 'Content' }]);
  });
});

describe('ui.annotate.set', () => {
  it('rejects an invalid property type, naming the nearest valid ones (fact 3)', async () => {
    installMockFigma();
    const node = getFigma().createFrame();

    await expect(createExecStdlibAnnotate().set(node.id, [{ label: 'x', properties: [{ type: 'fillz' }] }]))
      .rejects.toMatchObject({ code: 'E_INVALID_ARGS', message: expect.stringContaining('fills') });
  });

  it('replace mode overwrites whatever annotations existed', async () => {
    installMockFigma();
    const node = getFigma().createFrame();
    node.annotations = [{ label: 'Old' }];

    const result = await createExecStdlibAnnotate().set(node.id, [{ label: 'New' }]);
    expect(result.mode).toBe('replace');
    expect(result.annotations).toEqual([{ label: 'New', labelMarkdown: null, properties: null, categoryId: null, categoryName: null }]);
  });

  it('append mode keeps existing annotations, preferring labelMarkdown over label when a stored entry carries both (fact 2)', async () => {
    installMockFigma();
    const node = getFigma().createFrame();
    // Figma auto-populates BOTH label and labelMarkdown on read — the merge must
    // pick labelMarkdown and drop the plain label, never write both back.
    node.annotations = [{ label: 'Rendered plain', labelMarkdown: '**Rendered plain**' }];

    const result = await createExecStdlibAnnotate().set(node.id, [{ label: 'New one' }], { mode: 'append' });
    expect(result.annotationCount).toBe(2);
    expect(result.annotations[0]).toMatchObject({ label: null, labelMarkdown: '**Rendered plain**' });
    expect(result.annotations[1]).toMatchObject({ label: 'New one' });
  });

  it('throws E_EVAL when the write does not read back the expected count', async () => {
    installMockFigma();
    const node = getFigma().createFrame();
    // Force a mismatch: the setter accepts the write but a hostile getter reports
    // fewer entries back than were just written — the verify-by-re-read must catch it.
    let stored: unknown[] = [];
    Object.defineProperty(node, 'annotations', {
      get: () => stored.slice(0, 0),
      set: (v: unknown[]) => { stored = v; },
      configurable: true,
    });

    await expect(createExecStdlibAnnotate().set(node.id, [{ label: 'A' }, { label: 'B' }]))
      .rejects.toMatchObject({ code: 'E_EVAL' });
  });
});
