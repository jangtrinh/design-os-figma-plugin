import { describe, expect, it } from 'vitest';
import { PayloadValidationError, validateImportPayload } from '../shared/figma-payload-validation.ts';

const valid = () => ({
  version: 1 as const,
  name: 'Card',
  width: 100,
  height: 50,
  tokens: { colors: [], typography: [], spacing: [], radii: [], shadows: [] },
  rootNode: {
    type: 'FRAME', name: 'Card',
    children: [{ type: 'TEXT', name: 'Title', characters: 'Hello' }],
  },
});

function rejected(input: unknown, limits: Parameters<typeof validateImportPayload>[1]): void {
  expect(() => validateImportPayload(input, limits)).toThrow(PayloadValidationError);
}

describe('IMPORT_PAYLOAD bounded work', () => {
  it('refuses depth and node-count excess with small injected limits', () => {
    rejected(valid(), { depth: 0 });
    rejected(valid(), { nodes: 1 });
  });

  it('refuses ordinary strings, arrays, dynamic records, record keys, and aggregate entries', () => {
    rejected(valid(), { textChars: 4 });
    rejected(valid(), { arrayEntries: 0 });
    rejected({
      ...valid(), rootNode: { type: 'FRAME', name: 'Card', keyedBindings: { fills: { key: 'k' } } },
    }, { recordEntries: 0 });
    rejected({
      ...valid(), rootNode: { type: 'FRAME', name: 'Card', keyedBindings: { 'long-key-123': { key: 'k' } } },
    }, { recordKeyChars: 10 });
    rejected(valid(), { totalEntries: 1 });
  });

  it('refuses token and motion excess through their independent ceilings', () => {
    rejected({
      ...valid(), tokens: {
        colors: [{ name: 'c', hex: '#000', color: { r: 0, g: 0, b: 0, a: 1 } }],
      },
    }, { tokenGroup: 0 });
    rejected({
      ...valid(), rootNode: {
        type: 'FRAME', name: 'Card',
        motion: {
          durationSec: 1,
          steps: [{ offset: 0, style: {} }, { offset: 1, style: {} }],
        },
      },
    }, { motionSteps: 1 });
  });

  it('budgets imageUrl and backgroundImageUrl as images and SVG separately', () => {
    for (const field of ['imageUrl', 'backgroundImageUrl']) rejected({
      ...valid(), rootNode: { type: 'IMAGE', name: 'asset', [field]: '12345' },
    }, { imageChars: 4 });
    rejected({
      ...valid(), rootNode: { type: 'IMAGE', name: 'asset', svgContent: '<svg/>' },
    }, { svgChars: 4 });
  });

  it('refuses aggregate bytes incrementally without calling JSON.stringify', () => {
    rejected(valid(), { aggregateBytes: 64 });
    const original = JSON.stringify;
    let calls = 0;
    JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
      calls += 1;
      return original(...args);
    }) as typeof JSON.stringify;
    try {
      validateImportPayload(valid());
      expect(calls).toBe(0);
    } finally {
      JSON.stringify = original;
    }
  });

  it('counts JSON escape expansion in the incremental aggregate budget', () => {
    const plain = { ...valid(), rootNode: { type: 'TEXT', name: 'text', characters: 'a'.repeat(50) } };
    const escaped = { ...valid(), rootNode: { type: 'TEXT', name: 'text', characters: '\0'.repeat(50) } };
    expect(() => validateImportPayload(plain, { aggregateBytes: 500 })).not.toThrow();
    rejected(escaped, { aggregateBytes: 500 });
  });

  it('refuses enumerable non-index array sidecars before structured-clone forwarding', () => {
    const children: unknown[] & { unvalidatedSidecar?: string } = [];
    children.unvalidatedSidecar = 'x'.repeat(1_000_000);
    const input = structuredClone({
      ...valid(), rootNode: { type: 'FRAME', name: 'root', children },
    });
    expect((input.rootNode.children as typeof children).unvalidatedSidecar).toHaveLength(1_000_000);
    rejected(input, { aggregateBytes: 1024 });
  });

  it('allows repeated aliases, rejects active cycles, and bounds repeated work', () => {
    const color = { r: 0, g: 0, b: 0, a: 1 };
    expect(() => validateImportPayload({
      ...valid(), rootNode: {
        type: 'FRAME', name: 'Card', textColor: color,
        fills: [{ type: 'SOLID', color }],
      },
    })).not.toThrow();

    const cyclic = { type: 'FRAME', name: 'cycle', children: [] as unknown[] };
    cyclic.children.push(cyclic);
    expect(() => validateImportPayload({ ...valid(), rootNode: cyclic })).toThrow(PayloadValidationError);

    const shared = { type: 'FRAME', name: 'shared' };
    rejected({ ...valid(), rootNode: { type: 'FRAME', name: 'root', children: [shared, shared] } }, { nodes: 2 });
  });
});
