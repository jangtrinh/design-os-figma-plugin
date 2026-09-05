import { describe, expect, it } from 'vitest';
import { PayloadValidationError, validateImportPayload } from '../shared/figma-payload-validation.ts';

const valid = () => ({
  version: 1 as const,
  name: 'Card',
  width: 320,
  height: 200,
  tokens: { colors: [], typography: [], spacing: [], radii: [], shadows: [] },
  rootNode: { type: 'FRAME', name: 'Card', children: [{ type: 'TEXT', name: 'Title', characters: 'Hello' }] },
});

describe('IMPORT_PAYLOAD admission', () => {
  it('accepts both wire envelopes and keeps placement separate', () => {
    expect(validateImportPayload({ ...valid(), x: 11 })).toMatchObject({ payload: valid(), placement: { x: 11 } });
    expect(validateImportPayload({ payload: valid(), x: 12, y: 13, parentId: '1:2' })).toMatchObject({
      payload: valid(), placement: { x: 12, y: 13, parentId: '1:2' },
    });
  });

  it('normalizes omitted token groups', () => {
    const input = valid();
    delete (input as Partial<typeof input>).tokens;
    expect(validateImportPayload(input).payload.tokens).toEqual({ colors: [], typography: [], spacing: [], radii: [], shadows: [] });
  });

  it('normalizes every omitted token group independently', () => {
    const input = valid();
    input.tokens = { colors: [] } as typeof input.tokens;
    expect(validateImportPayload(input).payload.tokens).toEqual({
      colors: [], typography: [], spacing: [], radii: [], shadows: [],
    });
  });

  it('canonicalizes legacy null token values without forwarding null groups', () => {
    const empty = { colors: [], typography: [], spacing: [], radii: [], shadows: [] };
    const legacyValues = [null, ...Object.keys(empty).map((key) => ({ [key]: null }))];
    for (const tokens of legacyValues) {
      const payload = { ...valid(), tokens };
      for (const params of [payload, { payload }]) {
        expect(validateImportPayload(params).payload.tokens).toEqual(empty);
      }
    }
  });

  it('rejects non-null malformed token objects and groups in either envelope', () => {
    const groups = ['colors', 'typography', 'spacing', 'radii', 'shadows'];
    const malformed = [0, false, 'x', [], ...groups.flatMap((key) => (
      [0, false, 'x', {}].map((value) => ({ [key]: value }))
    ))];
    for (const tokens of malformed) {
      const payload = { ...valid(), tokens };
      for (const params of [payload, { payload }]) {
        expect(() => validateImportPayload(params)).toThrow(PayloadValidationError);
      }
    }
  });

  it('rejects malformed typed node fields instead of only checking their broad primitive kind', () => {
    expect(() => validateImportPayload({
      ...valid(), rootNode: { type: 'FRAME', name: 'bad', counterAxisSpacing: {} },
    })).toThrow(PayloadValidationError);
    expect(() => validateImportPayload({
      ...valid(), rootNode: { type: 'FRAME', name: 'bad', layoutMode: 'NOT_A_LAYOUT' },
    })).toThrow(PayloadValidationError);
    expect(() => validateImportPayload({
      ...valid(),
      rootNode: {
        type: 'TEXT', name: 'bad',
        textSegments: [{ characters: 'x', fontSize: 'bad', fontFamily: 5 }],
      },
    })).toThrow(PayloadValidationError);
  });

  it('permits a valid repeated-reference alias while still rejecting active cycles', () => {
    const sharedColor = { r: 0.1, g: 0.2, b: 0.3, a: 1 };
    const input = valid();
    input.rootNode = {
      type: 'FRAME', name: 'alias', textColor: sharedColor,
      fills: [{ type: 'SOLID', color: sharedColor }],
    } as typeof input.rootNode;
    expect(() => validateImportPayload(input)).not.toThrow();
  });

  it('accepts the existing 8 MiB image producer boundary after base64 expansion', () => {
    const encodedLength = 4 * Math.ceil((8 * 1024 * 1024) / 3);
    const input = valid();
    input.rootNode = {
      type: 'FRAME', name: 'image',
      backgroundImageUrl: `data:image/png;base64,${'A'.repeat(encodedLength)}`,
    } as typeof input.rootNode;
    expect(() => validateImportPayload(input)).not.toThrow();
  });

  it('returns the established E_INVALID_ARGS wire code and never serializes the whole payload', () => {
    try {
      validateImportPayload({ ...valid(), rootNode: { type: 'FRAME', name: 'bad', layoutMode: 'NOPE' } });
      throw new Error('expected validation to fail');
    } catch (error) {
      expect(error).toMatchObject({ code: 'E_INVALID_ARGS' });
    }

    const stringify = JSON.stringify;
    let calls = 0;
    JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
      calls += 1;
      return stringify(...args);
    }) as typeof JSON.stringify;
    try {
      validateImportPayload(valid());
      expect(calls).toBe(0);
    } finally {
      JSON.stringify = stringify;
    }
  });

  it('rejects unknown fields, invalid tags, non-finite numbers, cycles, and excess depth', () => {
    expect(() => validateImportPayload({ ...valid(), unexpected: true })).toThrow(PayloadValidationError);
    expect(() => validateImportPayload({ ...valid(), rootNode: { type: 'ALIEN', name: 'bad' } })).toThrow(PayloadValidationError);
    expect(() => validateImportPayload({ ...valid(), width: Number.NaN })).toThrow(PayloadValidationError);
    const cyclic = valid(); cyclic.rootNode.children = [cyclic.rootNode];
    expect(() => validateImportPayload(cyclic)).toThrow(PayloadValidationError);
    let child: Record<string, unknown> = { type: 'FRAME', name: 'end' };
    for (let i = 0; i < 65; i++) child = { type: 'FRAME', name: 'deep', children: [child] };
    expect(() => validateImportPayload({ ...valid(), rootNode: child }, { depth: 64 })).toThrow(PayloadValidationError);
  });
});
