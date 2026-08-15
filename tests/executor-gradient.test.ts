// IMPORT_GRADIENT executor tests.
//
// The Figma mock below encodes REFUSALS, not just the happy path — a permissive mock is a
// green light that means nothing. Specifically: a PAGE/DOCUMENT carries no fills, a node
// without a fills property must be rejected rather than silently skipped, and
// getNodeByIdAsync resolves null for an id that no longer exists.

import { describe, expect, it, beforeEach, vi } from 'vitest';

import { importGradient, toBytes, GRADIENT_DATA_KEY } from '../plugin/src/main/executor-gradient';

interface FakeNode {
  id: string;
  name: string;
  type: string;
  fills?: unknown;
  pluginData: Record<string, string>;
  setPluginData(k: string, v: string): void;
}

function makeNode(over: Partial<FakeNode> = {}): FakeNode {
  const node: FakeNode = {
    id: over.id ?? '1:2',
    name: over.name ?? 'Hero',
    type: over.type ?? 'RECTANGLE',
    fills: 'fills' in over ? over.fills : [],
    pluginData: {},
    setPluginData(k, v) { this.pluginData[k] = v; },
  };
  if (!('fills' in over)) node.fills = [];
  else if (over.fills === undefined) delete (node as Partial<FakeNode>).fills;
  return node;
}

let nodes: Record<string, FakeNode>;
let selection: FakeNode[];
let createdBytes: Uint8Array[];

beforeEach(() => {
  nodes = {};
  selection = [];
  createdBytes = [];
  (globalThis as Record<string, unknown>).figma = {
    getNodeByIdAsync: vi.fn(async (id: string) => nodes[id] ?? null),
    currentPage: { get selection() { return selection; } },
    createImage: (bytes: Uint8Array) => {
      // Figma throws on empty/invalid image data rather than returning a null hash.
      if (!bytes || bytes.length === 0) throw new Error('Image data is empty');
      createdBytes.push(bytes);
      return { hash: `hash_${bytes.length}` };
    },
  };
});

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

describe('toBytes — the postMessage typed-array problem', () => {
  it('passes a real Uint8Array through', () => {
    expect(toBytes(PNG)).toEqual(PNG);
  });

  it('reconstructs from a plain array', () => {
    expect(toBytes([1, 2, 3])).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('reconstructs from the numeric-keyed object postMessage actually delivers', () => {
    // This is the real wire shape — a Uint8Array does not survive postMessage as one.
    expect(toBytes({ '0': 9, '1': 8 })).toEqual(new Uint8Array([9, 8]));
  });

  it('throws on data that carries no image bytes', () => {
    expect(() => toBytes(undefined)).toThrow(/did not carry image data/);
    expect(() => toBytes('nope')).toThrow(/did not carry image data/);
  });
});

describe('importGradient — target resolution', () => {
  it('bakes onto an explicit node id', async () => {
    nodes['1:2'] = makeNode();
    const r = await importGradient({ bytes: Array.from(PNG), nodeId: '1:2' });
    expect(r.nodeId).toBe('1:2');
    expect(r.name).toBe('Hero');
    expect(nodes['1:2']!.fills).toEqual([
      { type: 'IMAGE', scaleMode: 'FILL', imageHash: `hash_${PNG.length}` },
    ]);
  });

  it('falls back to a single selected node', async () => {
    const n = makeNode({ id: '3:4', name: 'Section' });
    selection = [n];
    const r = await importGradient({ bytes: Array.from(PNG) });
    expect(r.nodeId).toBe('3:4');
  });

  it('refuses an id that resolves to nothing', async () => {
    await expect(importGradient({ bytes: Array.from(PNG), nodeId: '9:9' })).rejects.toThrow(/no node with id/);
  });

  it('refuses an empty selection instead of guessing', async () => {
    await expect(importGradient({ bytes: Array.from(PNG) })).rejects.toThrow(/nothing selected/);
  });

  it('refuses a multi-node selection rather than baking N copies', async () => {
    selection = [makeNode({ id: 'a' }), makeNode({ id: 'b' })];
    await expect(importGradient({ bytes: Array.from(PNG) })).rejects.toThrow(/2 nodes selected/);
  });

  it('refuses a PAGE, which carries no fills', async () => {
    nodes['0:1'] = makeNode({ id: '0:1', type: 'PAGE' });
    await expect(importGradient({ bytes: Array.from(PNG), nodeId: '0:1' })).rejects.toThrow(/carries no fills/);
  });

  it('refuses a node type with no fills property', async () => {
    const n = makeNode({ id: '5:5', type: 'SLICE' });
    delete (n as Partial<FakeNode>).fills;
    nodes['5:5'] = n;
    await expect(importGradient({ bytes: Array.from(PNG), nodeId: '5:5' })).rejects.toThrow(/carries no fills/);
  });
});

describe('importGradient — the bake itself', () => {
  it('refuses empty image data before calling createImage', async () => {
    nodes['1:2'] = makeNode();
    await expect(importGradient({ bytes: [], nodeId: '1:2' })).rejects.toThrow(/empty image/);
    expect(createdBytes).toHaveLength(0);
  });

  it('replaces every existing paint rather than layering over it', async () => {
    nodes['1:2'] = makeNode({ fills: [{ type: 'SOLID' }, { type: 'GRADIENT_LINEAR' }] });
    await importGradient({ bytes: Array.from(PNG), nodeId: '1:2' });
    expect((nodes['1:2']!.fills as unknown[])).toHaveLength(1);
  });

  it('stores the config so the bake stays re-editable', async () => {
    nodes['1:2'] = makeNode();
    await importGradient({
      bytes: Array.from(PNG),
      nodeId: '1:2',
      config: 'animate=on&uSpeed=0.4',
      slug: 'halo',
      renderer: '@shadergradient/react@2.4.24',
    });
    const stored = JSON.parse(nodes['1:2']!.pluginData[GRADIENT_DATA_KEY]!) as Record<string, unknown>;
    expect(stored).toEqual({
      config: 'animate=on&uSpeed=0.4',
      slug: 'halo',
      renderer: '@shadergradient/react@2.4.24',
    });
  });

  it('records a null slug for a hand-configured field, never a fabricated one', async () => {
    nodes['1:2'] = makeNode();
    const r = await importGradient({ bytes: Array.from(PNG), nodeId: '1:2', config: 'a=1', slug: null });
    expect(r.slug).toBeNull();
    expect(JSON.parse(nodes['1:2']!.pluginData[GRADIENT_DATA_KEY]!).slug).toBeNull();
  });

  it('writes no plugin data when no config was supplied', async () => {
    nodes['1:2'] = makeNode();
    await importGradient({ bytes: Array.from(PNG), nodeId: '1:2' });
    expect(nodes['1:2']!.pluginData[GRADIENT_DATA_KEY]).toBeUndefined();
  });

  it('does not claim a config when the fill itself threw', async () => {
    // Ordering guard: plugin data is written AFTER the paint lands, so a node can
    // never advertise a config whose image never made it onto the canvas.
    nodes['1:2'] = makeNode();
    (globalThis as Record<string, unknown>).figma = {
      getNodeByIdAsync: async (id: string) => nodes[id] ?? null,
      currentPage: { get selection() { return selection; } },
      createImage: () => { throw new Error('Image data is invalid'); },
    };
    // Asserts the SPECIFIC message, so this cannot pass because some other call threw.
    await expect(
      importGradient({ bytes: Array.from(PNG), nodeId: '1:2', config: 'a=1' }),
    ).rejects.toThrow('Image data is invalid');
    expect(nodes['1:2']!.pluginData[GRADIENT_DATA_KEY]).toBeUndefined();
  });
});
