// IMPORT_GRADIENT executor tests.
//
// The Figma mock below encodes REFUSALS, not just the happy path — a permissive mock is a
// green light that means nothing. Specifically: a PAGE/DOCUMENT carries no fills, a node
// without a fills property must be rejected rather than silently skipped, and
// getNodeByIdAsync resolves null for an id that no longer exists.

import { describe, expect, it, beforeEach, vi } from 'vitest';

import { importGradient, toBytes, GRADIENT_DATA_KEY } from '../plugin/src/main/executor-gradient';
import { PNG_DATA_URL } from './gradient-png-fixture';
import { makeNode, type FakeNode } from './gradient-node-fixture';

let nodes: Record<string, FakeNode>;
let selection: FakeNode[];
let createdBytes: Uint8Array[];
let getNodeByIdAsync: ReturnType<typeof vi.fn>;

const PNG = Uint8Array.from(Buffer.from(PNG_DATA_URL.split(',')[1]!, 'base64'));

beforeEach(() => {
  nodes = {};
  selection = [];
  createdBytes = [];
  getNodeByIdAsync = vi.fn(async (id: string) => nodes[id] ?? null);
  (globalThis as Record<string, unknown>).figma = {
    getNodeByIdAsync,
    currentPage: { get selection() { return selection; } },
    createImage: (bytes: Uint8Array) => {
      // Model the native decoder refusal instead of accepting every non-empty array.
      if (!Buffer.from(bytes).equals(Buffer.from(PNG))) throw new Error('Image data is invalid');
      createdBytes.push(bytes);
      return { hash: `hash_${bytes.length}` };
    },
  };
});

describe('toBytes — supported Figma message representations', () => {
  it('passes a real Uint8Array through', () => {
    expect(toBytes(PNG)).toEqual(PNG);
  });

  it('reconstructs from a plain array', () => {
    expect(toBytes(Array.from(PNG))).toEqual(PNG);
  });

  it('retains compatibility with a contiguous numeric-keyed object', () => {
    const object = Object.fromEntries(Array.from(PNG, (byte, index) => [String(index), byte]));
    expect(toBytes(object)).toEqual(PNG);
  });

  it('throws on data that carries no image bytes', () => {
    expect(() => toBytes(undefined)).toThrow(/must be a Uint8Array/);
    expect(() => toBytes('nope')).toThrow(/must be a Uint8Array/);
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
  it('refuses empty image data before resolving a target or calling createImage', async () => {
    nodes['1:2'] = makeNode();
    await expect(importGradient({ bytes: [], nodeId: '1:2' })).rejects.toMatchObject({
      code: 'E_INVALID_ARGS', message: expect.stringMatching(/33-/),
    });
    expect(getNodeByIdAsync).not.toHaveBeenCalled();
    expect(createdBytes).toHaveLength(0);
  });

  it.each([
    ['sparse array', (() => { const value = Array.from(PNG); delete value[4]; return value; })()],
    ['out-of-range byte', Array.from(PNG, (byte, index) => index === 4 ? 256 : byte)],
    ['non-canonical object', { ...Object.fromEntries(Array.from(PNG, (byte, index) => [String(index), byte])), extra: 0 }],
    ['non-PNG bytes', new Uint8Array(PNG.length)],
  ])('refuses %s before any scene or image API call', async (_label, bytes) => {
    nodes['1:2'] = makeNode();
    await expect(importGradient({ bytes, nodeId: '1:2' })).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
    expect(getNodeByIdAsync).not.toHaveBeenCalled();
    expect(createdBytes).toHaveLength(0);
    expect(nodes['1:2']!.fills).toEqual([]);
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

  it('leaves final decodability to Figma after bounded PNG header admission', async () => {
    nodes['1:2'] = makeNode({ fills: [{ type: 'SOLID' }] });
    const headerOnly = PNG.slice(0, 33);
    await expect(importGradient({ bytes: headerOnly, nodeId: '1:2', config: 'a=1' }))
      .rejects.toThrow('Image data is invalid');
    expect(nodes['1:2']!.fills).toEqual([{ type: 'SOLID' }]);
    expect(nodes['1:2']!.pluginData[GRADIENT_DATA_KEY]).toBeUndefined();
  });
});
