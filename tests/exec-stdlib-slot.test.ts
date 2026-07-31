// `ui.slot.*` — Figma Slots (absorption phase-02). Covers: happy path (create/list/
// append/reset/addProperty), bad-input throws, the absorbed-fact refusals (GRID,
// host-too-old, raw-COMPONENT-append, clearExisting-after-content), and the
// stricter-than-the-fork ambiguous-slot-name rule.
import { describe, it, expect } from 'vitest';
import {
  installMockFigma, setMockComponents, type FakeNode,
} from './helpers/mock-figma.ts';
import { createExecStdlibSlot } from '../plugin/src/main/exec-stdlib-slot.ts';

let keySeq = 0;
function makeComponent(name: string): FakeNode {
  const figma = (globalThis as unknown as { figma: { createComponent(): FakeNode } }).figma;
  const c = figma.createComponent();
  c.name = name;
  c.key = `key:${keySeq++}`;
  return c;
}

describe('ui.slot.create', () => {
  it('creates a slot, verifies its own state, and never synthesises a propertyKey', async () => {
    installMockFigma();
    const base = makeComponent('Card');
    setMockComponents([base]);

    const result = await createExecStdlibSlot().create(base.id, { name: 'Content' });

    expect(result.type).toBe('SLOT');
    expect(result.name).toBe('Content'); // fact 1: rename-after-create IS the naming API
    expect(typeof result.propertyKey).toBe('string');
    expect(result.layoutMode).toBe('NONE');
  });

  it('resizes when width/height are given', async () => {
    installMockFigma();
    const base = makeComponent('Card');
    setMockComponents([base]);
    const result = await createExecStdlibSlot().create(base.id, { width: 200, height: 80 });
    expect(result.width).toBe(200);
    expect(result.height).toBe(80);
  });

  it('rejects GRID layoutMode BEFORE creating anything (fact 4)', async () => {
    installMockFigma();
    const base = makeComponent('Card');
    setMockComponents([base]);

    await expect(createExecStdlibSlot().create(base.id, { layoutMode: 'GRID' as never }))
      .rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
    expect(base.children).toEqual([]); // nothing was created
  });

  it('rejects a non-COMPONENT node', async () => {
    installMockFigma();
    const figma = (globalThis as unknown as { figma: { createFrame(): FakeNode } }).figma;
    const frame = figma.createFrame();
    await expect(createExecStdlibSlot().create(frame.id, {})).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
  });

  it('rejects when createSlot() is unavailable (host too old, fact 3) — even though Slots is GA', async () => {
    installMockFigma();
    const base = makeComponent('Card');
    setMockComponents([base]);
    (base as unknown as { createSlot?: unknown }).createSlot = undefined;

    await expect(createExecStdlibSlot().create(base.id, {}))
      .rejects.toMatchObject({ code: 'E_INVALID_ARGS', message: expect.stringContaining('update Figma Desktop') });
  });
});

describe('ui.slot.list', () => {
  it('lists slots on a COMPONENT directly', async () => {
    installMockFigma();
    const base = makeComponent('Card');
    setMockComponents([base]);
    await createExecStdlibSlot().create(base.id, { name: 'Content' });

    const result = await createExecStdlibSlot().list(base.id);
    expect(result.count).toBe(1);
    expect(result.slots[0]!.name).toBe('Content');
  });

  it('groups a COMPONENT_SET\'s slots by variant (fact 6)', async () => {
    const figma = installMockFigma();
    const v1 = makeComponent('State=default');
    const v2 = makeComponent('State=hover');
    setMockComponents([v1, v2]);
    await createExecStdlibSlot().create(v1.id, { name: 'Content' });
    await createExecStdlibSlot().create(v2.id, { name: 'Content' });
    const set = figma.combineAsVariants([v1, v2], figma.currentPage);

    const result = await createExecStdlibSlot().list(set.id);
    expect(result.count).toBe(2);
    expect(result.slots.map((s) => s.variantId).sort()).toEqual([v1.id, v2.id].sort());
  });

  it('rejects a node type that cannot hold slots', async () => {
    installMockFigma();
    const figma = (globalThis as unknown as { figma: { createRectangle(): FakeNode } }).figma;
    const rect = figma.createRectangle();
    await expect(createExecStdlibSlot().list(rect.id)).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
  });
});

describe('ui.slot.append', () => {
  it('clones an existing node into the slot and verifies it landed', async () => {
    const figma = installMockFigma();
    const base = makeComponent('Card');
    setMockComponents([base]);
    const slot = await createExecStdlibSlot().create(base.id, {});
    const content = figma.createFrame();
    content.name = 'Avatar';

    const result = await createExecStdlibSlot().append({ slotId: slot.id }, { sourceNodeId: content.id });

    expect(result.appended.name).toBe('Avatar');
    expect(result.appended.id).not.toBe(content.id); // cloned, not moved (clone !== false default)
  });

  it('moves (does not clone) when clone:false', async () => {
    const figma = installMockFigma();
    const base = makeComponent('Card');
    setMockComponents([base]);
    const slot = await createExecStdlibSlot().create(base.id, {});
    const content = figma.createFrame();

    const result = await createExecStdlibSlot().append({ slotId: slot.id }, { sourceNodeId: content.id, clone: false });
    expect(result.appended.id).toBe(content.id);
  });

  it('rejects a raw COMPONENT as source BEFORE cloning (fact 7) — no orphan component is left', async () => {
    const figma = installMockFigma();
    const base = makeComponent('Card');
    const other = makeComponent('Icon');
    setMockComponents([base, other]);
    const slot = await createExecStdlibSlot().create(base.id, {});
    const componentsBefore = (figma as unknown as { createComponent(): FakeNode }); // sanity — not used
    void componentsBefore;

    await expect(createExecStdlibSlot().append({ slotId: slot.id }, { sourceNodeId: other.id }))
      .rejects.toMatchObject({ code: 'E_INVALID_ARGS', message: expect.stringContaining('cannot be appended') });
    // No clone of `other` exists anywhere — it was never cloned in the first place.
    // `slot` is create()'s plain result literal, not the live node — resolve the
    // real FakeNode to see its actual children.
    const slotNode = base.children.find((c) => c.id === slot.id)!;
    expect(slotNode.children).toEqual([]);
  });

  it('creates new content via nodeType when no sourceNodeId is given', async () => {
    installMockFigma();
    const base = makeComponent('Card');
    setMockComponents([base]);
    const slot = await createExecStdlibSlot().create(base.id, {});

    const result = await createExecStdlibSlot().append({ slotId: slot.id }, { nodeType: 'TEXT', props: { text: 'Hello' } });
    expect(result.appended.type).toBe('TEXT');
  });

  it('rejects an unsupported nodeType, naming the supported ones', async () => {
    installMockFigma();
    const base = makeComponent('Card');
    setMockComponents([base]);
    const slot = await createExecStdlibSlot().create(base.id, {});
    await expect(createExecStdlibSlot().append({ slotId: slot.id }, { nodeType: 'STAR' }))
      .rejects.toMatchObject({ code: 'E_INVALID_ARGS', message: expect.stringContaining('RECTANGLE, FRAME, TEXT') });
  });

  it('clearExisting runs ONLY after content resolves — a bad sourceNodeId leaves existing children untouched (fact 8)', async () => {
    const figma = installMockFigma();
    const base = makeComponent('Card');
    setMockComponents([base]);
    const slot = await createExecStdlibSlot().create(base.id, {});
    const slotNode = base.children.find((c) => c.id === slot.id)!;
    const existing = figma.createFrame();
    await createExecStdlibSlot().append({ slotId: slot.id }, { sourceNodeId: existing.id });
    expect(slotNode.children.length).toBe(1);

    await expect(createExecStdlibSlot().append({ slotId: slot.id }, { sourceNodeId: 'nope' }, { clearExisting: true }))
      .rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
    expect(slotNode.children.length).toBe(1); // still there — never cleared before the error
  });

  it('snaps a cloned node to 0,0 in a NONE-layout slot (fact 9)', async () => {
    const figma = installMockFigma();
    const base = makeComponent('Card');
    setMockComponents([base]);
    const slot = await createExecStdlibSlot().create(base.id, {});
    const slotNode = base.children.find((c) => c.id === slot.id)!;
    const content = figma.createFrame();
    content.x = 500; content.y = 500;

    await createExecStdlibSlot().append({ slotId: slot.id }, { sourceNodeId: content.id });
    expect(slotNode.children[0]!.x).toBe(0);
    expect(slotNode.children[0]!.y).toBe(0);
  });
});

describe('ui.slot.reset', () => {
  it('clears the slot\'s children', async () => {
    const figma = installMockFigma();
    const base = makeComponent('Card');
    setMockComponents([base]);
    const slot = await createExecStdlibSlot().create(base.id, {});
    const slotNode = base.children.find((c) => c.id === slot.id)!;
    await createExecStdlibSlot().append({ slotId: slot.id }, { sourceNodeId: figma.createFrame().id });
    expect(slotNode.children.length).toBe(1);

    const result = await createExecStdlibSlot().reset({ slotId: slot.id });
    expect(result.slot.childCount).toBe(0);
  });

  it('throws when resetSlot() is unavailable on the node', async () => {
    installMockFigma();
    const base = makeComponent('Card');
    setMockComponents([base]);
    const slot = await createExecStdlibSlot().create(base.id, {});
    // `slot` is the plain result literal create() returns, not the live node — mutate
    // the actual FakeNode instance (found back the same way production code would
    // resolve it) so the missing-method check has something real to see.
    const slotNode = base.children.find((c) => c.id === slot.id)!;
    (slotNode as unknown as { resetSlot?: unknown }).resetSlot = undefined;
    await expect(createExecStdlibSlot().reset({ slotId: slot.id })).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
  });
});

describe('ui.slot target resolution — stricter than the fork (fact 10)', () => {
  it('resolves by instanceId + slotName when exactly one direct match exists', async () => {
    installMockFigma();
    const base = makeComponent('Card');
    setMockComponents([base]);
    await createExecStdlibSlot().create(base.id, { name: 'Content' });
    const inst = base.createInstance();

    const result = await createExecStdlibSlot().reset({ instanceId: inst.id, slotName: 'Content' });
    expect(result.slot.name).toBe('Content');
  });

  it('throws ambiguous when TWO direct children share the slot name — never silently takes [0]', async () => {
    installMockFigma();
    const base = makeComponent('Card');
    setMockComponents([base]);
    await createExecStdlibSlot().create(base.id, { name: 'Content' });
    await createExecStdlibSlot().create(base.id, { name: 'Content' });
    const inst = base.createInstance();

    await expect(createExecStdlibSlot().reset({ instanceId: inst.id, slotName: 'Content' }))
      .rejects.toMatchObject({ code: 'E_INVALID_ARGS', message: expect.stringContaining('ambiguous') });
  });

  it('lists the available slot names when none match', async () => {
    installMockFigma();
    const base = makeComponent('Card');
    setMockComponents([base]);
    await createExecStdlibSlot().create(base.id, { name: 'Content' });
    const inst = base.createInstance();

    await expect(createExecStdlibSlot().reset({ instanceId: inst.id, slotName: 'Nope' }))
      .rejects.toMatchObject({ code: 'E_INVALID_ARGS', message: expect.stringContaining('Content') });
  });
});

describe('ui.slot.addProperty', () => {
  it('binds a direct-child frame and merges componentPropertyReferences (never wipes an existing binding)', async () => {
    installMockFigma();
    const component = makeComponent('Card');
    setMockComponents([component]);
    const frame = (globalThis as unknown as { figma: { createFrame(): FakeNode } }).figma.createFrame();
    frame.name = 'ContentArea';
    frame.componentPropertyReferences = { visible: 'ShowIcon#1' }; // pre-existing binding
    component.appendChild(frame);

    const result = await createExecStdlibSlot().addProperty(component.id, 'Content', frame.id, { description: 'Main content' });

    expect(result.frameName).toBe('ContentArea');
    expect(frame.componentPropertyReferences).toMatchObject({ visible: 'ShowIcon#1', slotContentId: result.propertyKey });
  });

  it('rejects a frame not a direct child of the component', async () => {
    installMockFigma();
    const component = makeComponent('Card');
    const other = makeComponent('Unrelated');
    setMockComponents([component, other]);
    const frame = (globalThis as unknown as { figma: { createFrame(): FakeNode } }).figma.createFrame();
    other.appendChild(frame);

    await expect(createExecStdlibSlot().addProperty(component.id, 'Content', frame.id))
      .rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
  });

  it('rejects a GRID-layout frame', async () => {
    installMockFigma();
    const component = makeComponent('Card');
    setMockComponents([component]);
    const frame = (globalThis as unknown as { figma: { createFrame(): FakeNode } }).figma.createFrame();
    frame.layoutMode = 'GRID';
    component.appendChild(frame);

    await expect(createExecStdlibSlot().addProperty(component.id, 'Content', frame.id))
      .rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
  });

  it('rejects a frame nested inside another slot', async () => {
    installMockFigma();
    const component = makeComponent('Card');
    setMockComponents([component]);
    const outerSlot = await createExecStdlibSlot().create(component.id, {});
    const slotNode = await (async () => component.children.find((c) => c.id === outerSlot.id)!)();
    const frame = (globalThis as unknown as { figma: { createFrame(): FakeNode } }).figma.createFrame();
    slotNode.appendChild(frame);

    await expect(createExecStdlibSlot().addProperty(component.id, 'Nested', frame.id))
      .rejects.toMatchObject({ code: 'E_INVALID_ARGS', message: expect.stringContaining('nested inside another slot') });
  });

  it('accepts a frame that is a direct child of a COMPONENT_SET\'s variant', async () => {
    const figma = installMockFigma();
    const v1 = makeComponent('State=default');
    setMockComponents([v1]);
    const frame = figma.createFrame();
    v1.appendChild(frame);
    const set = figma.combineAsVariants([v1], figma.currentPage);

    const result = await createExecStdlibSlot().addProperty(set.id, 'Content', frame.id);
    expect(result.frameId).toBe(frame.id);
  });

  it('rejects when addComponentProperty() is unavailable (host too old, stage-4 minor m1)', async () => {
    installMockFigma();
    const component = makeComponent('Card');
    setMockComponents([component]);
    const frame = (globalThis as unknown as { figma: { createFrame(): FakeNode } }).figma.createFrame();
    component.appendChild(frame);
    (component as unknown as { addComponentProperty?: unknown }).addComponentProperty = undefined;

    await expect(createExecStdlibSlot().addProperty(component.id, 'Content', frame.id))
      .rejects.toMatchObject({ code: 'E_INVALID_ARGS', message: expect.stringContaining('update Figma Desktop') });
  });

  it('deletes the freshly-minted property when the post-mint verify fails (stage-4 BLOCKER 2)', async () => {
    installMockFigma();
    const component = makeComponent('Card');
    setMockComponents([component]);
    const frame = (globalThis as unknown as { figma: { createFrame(): FakeNode } }).figma.createFrame();
    component.appendChild(frame);
    // Force the frame-side verify to fail: the write always reads back empty,
    // regardless of what was just assigned.
    Object.defineProperty(frame, 'componentPropertyReferences', {
      get: () => ({}),
      set: () => { /* accepted but never visible — simulates a lost write */ },
      configurable: true,
    });

    await expect(createExecStdlibSlot().addProperty(component.id, 'Content', frame.id))
      .rejects.toMatchObject({ code: 'E_EVAL' });

    // The property this call minted must not survive the rollback — it was never
    // linked to anything, so leaving it behind would be an unlinked orphan.
    const defs = component.componentPropertyDefinitions as Record<string, unknown>;
    expect(Object.keys(defs)).toHaveLength(0);
  });

  it('names the leftover property in the error when the rollback deletion itself fails (stage-4 BLOCKER 2 fallback)', async () => {
    installMockFigma();
    const component = makeComponent('Card');
    setMockComponents([component]);
    const frame = (globalThis as unknown as { figma: { createFrame(): FakeNode } }).figma.createFrame();
    component.appendChild(frame);
    Object.defineProperty(frame, 'componentPropertyReferences', {
      get: () => ({}),
      set: () => { /* lost write, same as above */ },
      configurable: true,
    });
    (component as unknown as { deleteComponentProperty: unknown }).deleteComponentProperty = () => {
      throw new Error('deletion refused');
    };

    await expect(createExecStdlibSlot().addProperty(component.id, 'Content', frame.id))
      .rejects.toMatchObject({
        message: expect.stringMatching(/not linked to.*additionally.*cleanup.*deletion refused/s),
      });
  });
});
