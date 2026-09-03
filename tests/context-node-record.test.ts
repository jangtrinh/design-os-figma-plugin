// One node → one `context` record. The fixtures here are deliberately HOSTILE, and every
// refusal in them is a refusal the live Figma sandbox actually performs under
// `documentAccess: "dynamic-page"`:
//   · the SYNC `mainComponent` getter THROWS ("Use node.getMainComponentAsync instead"),
//     so only the async twin can name an instance's main;
//   · `fontName` reads back `figma.mixed` on style-linked text even when one font covers
//     every character — only the segments tell the truth;
//   · `componentProperties` THROWS on a COMPONENT_SET (it exists on instances only);
//   · `getCSSAsync()` can reject, and a rejection must keep the node;
//   · a PAGE's `children` getter THROWS ("Cannot access children of an unloaded page") until
//     that page is loaded — the refusal that must never read as "this page is empty".
// A permissive mock here would be a green light that means nothing.
import { describe, expect, it, vi } from 'vitest';
import { buildContextRecord, countCollapsed } from '../plugin/src/main/context-node-record.ts';

const MIXED = Symbol('figma.mixed');

function withThrowingGetter(node: Record<string, unknown>, field: string, message: string): Record<string, unknown> {
  Object.defineProperty(node, field, { get() { throw new Error(message); }, enumerable: true });
  return node;
}

function frame(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '1:1', name: 'Card', type: 'FRAME', visible: true,
    layoutMode: 'VERTICAL', layoutSizingHorizontal: 'FILL', layoutSizingVertical: 'HUG',
    itemSpacing: 8, paddingTop: 4, paddingRight: 5, paddingBottom: 6, paddingLeft: 7,
    width: 100.005, height: 40, x: 12.3456, y: 0,
    getCSSAsync: async () => ({ display: 'flex', gap: '8px' }),
    ...over,
  };
}

describe('context record — identity, layout, css', () => {
  it('carries identity, parent, depth, child count and a rounded layout summary', async () => {
    const out = await buildContextRecord(frame({ children: [{ id: '1:2', name: 'a', type: 'TEXT' }] }), {
      depth: 0, parentId: null, includeCss: true,
    });
    expect(out.record).toMatchObject({
      id: '1:1', name: 'Card', type: 'FRAME', visible: true, depth: 0, parentId: null, childCount: 1,
      layout: {
        layoutMode: 'VERTICAL', sizingH: 'FILL', sizingV: 'HUG', gap: 8,
        padding: [4, 5, 6, 7], w: 100.01, h: 40, x: 12.35, y: 0,
      },
    });
    expect(out.incomplete).toBe(false);
  });

  it('passes the CSS declarations through VERBATIM — never rewriting a var() fallback', async () => {
    const declarations = {
      color: 'var(--color-global-purple-purple-60, #9333EA)',
      'line-height': '36px /* 120% */',
    };
    const out = await buildContextRecord(frame({ getCSSAsync: async () => declarations }), {
      depth: 0, parentId: null, includeCss: true,
    });
    expect(out.record.css).toEqual(declarations);
  });

  it('skips getCSSAsync entirely when css is not requested', async () => {
    const getCSSAsync = vi.fn(async () => ({ display: 'flex' }));
    const out = await buildContextRecord(frame({ getCSSAsync }), {
      depth: 0, parentId: null, includeCss: false,
    });
    expect(getCSSAsync).toHaveBeenCalledTimes(0);
    expect(out.record.css).toBeUndefined();
  });

  it('a rejecting getCSSAsync KEEPS the node, records the first message, and reports incomplete', async () => {
    const out = await buildContextRecord(frame({
      getCSSAsync: async () => { throw new Error('css read refused'); },
    }), { depth: 1, parentId: '1:0', includeCss: true });
    expect(out.record.id).toBe('1:1');
    expect(out.record.cssError).toBe('css read refused');
    expect(out.record.css).toBeUndefined();
    expect(out.incomplete).toBe(true);
  });

  it('a node with no getCSSAsync at all (older host) is not an error', async () => {
    const out = await buildContextRecord({ id: '9:9', name: 'n', type: 'RECTANGLE' }, {
      depth: 0, parentId: null, includeCss: true,
    });
    expect(out.record.cssError).toBeUndefined();
    expect(out.incomplete).toBe(false);
  });
});

describe('context record — bindings, styles', () => {
  it('reads node-level and paint-level variable bindings, and named style ids', async () => {
    const out = await buildContextRecord(frame({
      boundVariables: { itemSpacing: { id: 'VariableID:1' } },
      fills: [{ type: 'SOLID', boundVariables: { color: { id: 'VariableID:2' } } }],
      fillStyleId: 'S:fill', textStyleId: MIXED, effectStyleId: 'S:effect',
    }), { depth: 0, parentId: null, includeCss: true });
    expect(out.record.bindings).toEqual({ itemSpacing: 'VariableID:1', fills: 'VariableID:2' });
    // A mixed textStyleId is not a style id — it is "several", and inventing one would be a
    // wrong fact. It is absent, and `fill`/`effect` still report.
    expect(out.record.styles).toEqual({ fill: 'S:fill', effect: 'S:effect' });
  });

  it('omits bindings and styles entirely when the node has none', async () => {
    const out = await buildContextRecord(frame(), { depth: 0, parentId: null, includeCss: true });
    expect(out.record.bindings).toBeUndefined();
    expect(out.record.styles).toBeUndefined();
  });
});

describe('context record — TEXT', () => {
  it('emits characters, and segments ONLY when fontName reads back mixed', async () => {
    const segments = [{ characters: 'Hi', fontName: { family: 'Inter', style: 'Bold' }, fontSize: 12 }];
    const plain = await buildContextRecord({
      id: '2:1', name: 'label', type: 'TEXT', characters: 'Hi', fontName: { family: 'Inter', style: 'Bold' },
      getStyledTextSegments: () => segments,
    }, { depth: 0, parentId: null, includeCss: false });
    expect(plain.record.characters).toBe('Hi');
    expect(plain.record.segments).toBeUndefined();

    const mixed = await buildContextRecord({
      id: '2:2', name: 'label', type: 'TEXT', characters: 'Hi', fontName: MIXED,
      getStyledTextSegments: () => segments,
    }, { depth: 0, parentId: null, includeCss: false });
    expect(mixed.record.segments).toEqual(segments);
  });
});

describe('context record — component API', () => {
  it('names an INSTANCE main through the ASYNC getter, never the throwing sync one', async () => {
    const instance = withThrowingGetter({
      id: '3:1', name: 'Button', type: 'INSTANCE',
      componentProperties: { Size: { type: 'VARIANT', value: 'md' } },
      getMainComponentAsync: async () => ({ key: 'abc123', name: 'Button' }),
    }, 'mainComponent', 'in get_mainComponent: Cannot call with documentAccess: dynamic-page. Use node.getMainComponentAsync instead');
    const out = await buildContextRecord(instance, { depth: 0, parentId: null, includeCss: false });
    expect(out.record.mainComponent).toEqual({ key: 'abc123', name: 'Button' });
    expect(out.record.componentProperties).toEqual({ Size: { type: 'VARIANT', value: 'md' } });
    expect(out.incomplete).toBe(false);
  });

  it('an instance whose main cannot be resolved says so instead of guessing', async () => {
    const out = await buildContextRecord({
      id: '3:2', name: 'Button', type: 'INSTANCE',
      getMainComponentAsync: async () => { throw new Error('main unavailable'); },
    }, { depth: 0, parentId: null, includeCss: false });
    expect(out.record.mainComponent).toBeUndefined();
    expect(out.record.mainComponentError).toBe('main unavailable');
    expect(out.incomplete).toBe(true);
  });

  it('a COMPONENT_SET reports its property DEFINITIONS and never touches componentProperties', async () => {
    const set = withThrowingGetter({
      id: '4:1', name: 'Button', type: 'COMPONENT_SET',
      componentPropertyDefinitions: { Size: { type: 'VARIANT', variantOptions: ['sm', 'md'] } },
    }, 'componentProperties', 'componentProperties is not available on a COMPONENT_SET');
    const out = await buildContextRecord(set, { depth: 0, parentId: null, includeCss: false });
    expect(out.record.componentPropertyDefinitions).toEqual({ Size: { type: 'VARIANT', variantOptions: ['sm', 'md'] } });
    expect(out.record.componentProperties).toBeUndefined();
    expect(out.incomplete).toBe(false);
  });
});

describe('context record — isAsset collapse', () => {
  it('collapses an asset subtree to COUNTS BY TYPE, never a silent drop', async () => {
    const asset = frame({
      id: '5:1', name: 'icon+label', type: 'FRAME', isAsset: true,
      children: [
        { id: '5:2', type: 'TEXT', name: 'label', characters: 'Save' },
        {
          id: '5:3', type: 'FRAME', name: 'glyph',
          children: [
            { id: '5:4', type: 'VECTOR', name: 'v1' }, { id: '5:5', type: 'VECTOR', name: 'v2' },
            { id: '5:6', type: 'VECTOR', name: 'v3' }, { id: '5:7', type: 'VECTOR', name: 'v4' },
            { id: '5:8', type: 'VECTOR', name: 'v5' },
          ],
        },
      ],
    });
    const out = await buildContextRecord(asset, { depth: 0, parentId: null, includeCss: false });
    expect(out.record.collapsed).toEqual({
      descendants: 7, types: { TEXT: 1, FRAME: 1, VECTOR: 5 }, readErrors: 0,
    });
    // The whole point: a TEXT child inside an "asset" is still text an agent must render.
    expect((out.record.collapsed as { types: Record<string, number> }).types.TEXT).toBe(1);
    // Collapsed means the walker must not enqueue the children.
    expect(out.children).toEqual([]);
  });

  it('a non-asset node hands its children to the walker and reports no collapse', async () => {
    const out = await buildContextRecord(frame({ children: [{ id: '6:2', name: 'a', type: 'TEXT' }] }), {
      depth: 0, parentId: null, includeCss: false,
    });
    expect(out.record.collapsed).toBeUndefined();
    expect(out.children.map((c) => c.id)).toEqual(['6:2']);
  });
});

describe('context record — wire safety', () => {
  it('survives a host-shaped value JSON.stringify would refuse, instead of losing the reply', async () => {
    const circular: Record<string, unknown> = { type: 'VARIANT', value: 'md' };
    circular.self = circular;
    const out = await buildContextRecord({
      id: '7:1', name: 'Button', type: 'INSTANCE', componentProperties: { Size: circular },
      getMainComponentAsync: async () => ({ key: 'k', name: 'Button' }),
    }, { depth: 0, parentId: null, includeCss: false });
    // One node's odd shape must not take the whole subtree's answer down at the wire.
    expect(() => JSON.stringify(out.record)).not.toThrow();
    expect(out.record.mainComponent).toEqual({ key: 'k', name: 'Button' });
  });

  it('is the identity transform for the plain declaration block getCSSAsync really returns', async () => {
    const declarations = { color: 'var(--c, #9333EA)', 'line-height': '36px /* 120% */' };
    const out = await buildContextRecord(frame({ getCSSAsync: async () => declarations }), {
      depth: 0, parentId: null, includeCss: true,
    });
    expect(out.record.css).toEqual(declarations);
  });
});

describe('context record — a refused IDENTITY read leaves a trace', () => {
  // The same class as the children refusal, at the reader that names the node. Degrading a
  // refused `id` to '' shipped a record the caller cannot re-issue on, with no error field,
  // no counter, and `complete: true` — while the emitted docs tell agents that `complete:
  // false` is how they learn something is missing.
  it('a child whose id getter throws ships as a minimal LOCATED record, not as id ""', async () => {
    const ghost = withThrowingGetter(
      { name: 'ghost', type: 'FRAME' }, 'id', 'The node with id "9:9" does not exist',
    );
    const out = await buildContextRecord(ghost, {
      depth: 1, parentId: '1:1', childIndex: 2, includeCss: false,
    });
    expect(out.record).toEqual({
      id: '(unreadable child 2 of 1:1)',
      readError: 'The node with id "9:9" does not exist',
    });
    expect(out.incomplete).toBe(true);
    expect(out.children).toEqual([]);
  });

  it('a node whose type getter throws is minimal too — never type "UNKNOWN" with text skipped', async () => {
    const ghost = withThrowingGetter(
      { id: '2:9', name: 'label', characters: 'Save' }, 'type', 'node type refused',
    );
    const out = await buildContextRecord(ghost, { depth: 0, parentId: null, includeCss: false });
    // Degraded to UNKNOWN, this node skipped the TEXT branch and an agent rendered no string.
    expect(out.record).toEqual({ id: '2:9', readError: 'node type refused' });
    expect(out.record.type).toBeUndefined();
    expect(out.incomplete).toBe(true);
  });

  it('the requested root, unreadable, is located as the target rather than as a child', async () => {
    const ghost = withThrowingGetter({ name: 'x', type: 'FRAME' }, 'id', 'id refused');
    const out = await buildContextRecord(ghost, { depth: 0, parentId: null, includeCss: false });
    expect(out.record).toEqual({ id: '(unreadable target)', readError: 'id refused' });
  });

  it('a best-effort id is kept when only the NAME read refuses', async () => {
    const ghost = withThrowingGetter({ id: '3:9', type: 'FRAME' }, 'name', 'name refused');
    const out = await buildContextRecord(ghost, { depth: 0, parentId: null, includeCss: false });
    expect(out.record).toEqual({ id: '3:9', readError: 'name refused' });
  });
});

describe('context record — a refused structural read leaves a trace', () => {
  // The live refusal: boot's loadAllPagesAsync is fire-and-forget, so a context call that
  // lands before it resolves reads a page whose `children` getter throws. Reported as
  // childless, a 300-layer page answers `childCount: 0, complete: true` — the silent hole
  // this module exists to prevent.
  it('a throwing children getter is NOT a childless node', async () => {
    const page = withThrowingGetter(
      { id: '0:1', name: 'Page 1', type: 'PAGE' },
      'children', 'Cannot access children of an unloaded page',
    );
    const out = await buildContextRecord(page, { depth: 0, parentId: null, includeCss: false });
    expect(out.record.childrenError).toBe('Cannot access children of an unloaded page');
    // `null`, never 0: a frontier entry reading `childCount: 0` is a leaf the caller never
    // re-issues on.
    expect(out.record.childCount).toBeNull();
    expect(out.incomplete).toBe(true);
    expect(out.children).toEqual([]);
  });

  it('a node with no children FIELD at all is honestly childless', async () => {
    const out = await buildContextRecord({ id: '1:9', name: 'r', type: 'RECTANGLE' }, {
      depth: 0, parentId: null, includeCss: false,
    });
    expect(out.record.childCount).toBe(0);
    expect(out.record.childrenError).toBeUndefined();
    expect(out.incomplete).toBe(false);
  });

  it('an asset collapse counts the refusals it hit instead of undercounting silently', async () => {
    const glyph = withThrowingGetter(
      { id: '5:3', name: 'glyph', type: 'FRAME' }, 'children', 'children refused',
    );
    const asset = frame({
      id: '5:1', type: 'FRAME', isAsset: true,
      children: [{ id: '5:2', type: 'TEXT', name: 'label' }, glyph],
    });
    const out = await buildContextRecord(asset, { depth: 0, parentId: null, includeCss: false });
    // The counter IS the record here, so an undercount is the wrong fact itself.
    expect(out.record.collapsed).toEqual({
      descendants: 2, types: { TEXT: 1, FRAME: 1 }, readErrors: 1,
    });
    expect(out.incomplete).toBe(true);
  });

  it('countCollapsed reports zero readErrors on a clean subtree', () => {
    expect(countCollapsed([{ id: 'a', type: 'TEXT' }])).toEqual({
      descendants: 1, types: { TEXT: 1 }, readErrors: 0,
    });
  });
});
