import { describe, expect, it, vi } from 'vitest';
import {
  assertGradientPngBase64Length,
  assertGradientPngByteLength,
  decodeGradientPngDataUrl,
  decodedLengthOfCanonicalBase64,
  gradientBytesFromUnknown,
  MAX_GRADIENT_PNG_BASE64_CHARS,
  MAX_GRADIENT_PNG_BYTES,
  validateGradientDimensions,
  validateGradientPngHeader,
} from '../shared/gradient-image-admission';
import { PNG_DATA_URL } from './gradient-png-fixture';

const PNG = Uint8Array.from(Buffer.from(PNG_DATA_URL.split(',')[1]!, 'base64'));

describe('gradient dimensions', () => {
  it('returns the integer canvas dimensions used by the renderer', () => {
    expect(validateGradientDimensions(480, 300, 2)).toEqual({ width: 960, height: 600 });
    expect(validateGradientDimensions(0.6, 0.6, 1)).toEqual({ width: 1, height: 1 });
  });

  it.each([
    [0, 10, 1], [10, -1, 1], [10, 10, 0], [Number.NaN, 10, 1],
    [10, Number.POSITIVE_INFINITY, 1], [4097, 1, 1], [2048, 1, 2.001],
  ])('refuses invalid or unsupported dimensions (%s, %s, %s)', (width, height, scale) => {
    expect(() => validateGradientDimensions(width, height, scale)).toThrow();
  });
});

describe('gradient PNG limits and data URL admission', () => {
  it('derives a cap above the worst-case 4096² RGBA zlib envelope', () => {
    const filteredRgba = 4096 * 4096 * 4 + 4096;
    const zlibBound = filteredRgba
      + (filteredRgba >>> 12) + (filteredRgba >>> 14) + (filteredRgba >>> 25) + 13;
    const pngEnvelope = zlibBound + 57;
    expect(MAX_GRADIENT_PNG_BYTES).toBeGreaterThan(pngEnvelope);
    expect(MAX_GRADIENT_PNG_BYTES).toBe(68 * 1024 * 1024);
    expect(MAX_GRADIENT_PNG_BASE64_CHARS).toBe(4 * Math.ceil(MAX_GRADIENT_PNG_BYTES / 3));
  });

  it('refuses impossible lengths before allocating encoded or decoded storage', () => {
    expect(() => assertGradientPngBase64Length(MAX_GRADIENT_PNG_BASE64_CHARS + 4)).toThrow(/length/);
    expect(() => assertGradientPngByteLength(MAX_GRADIENT_PNG_BYTES + 1)).toThrow(/bytes/);
  });

  it('rejects prefix, length, and alphabet before invoking atob', () => {
    const decode = vi.spyOn(globalThis, 'atob');
    try {
      expect(() => decodeGradientPngDataUrl('image/png;base64,AAAA', { width: 1, height: 1 })).toThrow(/exact/);
      expect(() => decodeGradientPngDataUrl('data:image/png;base64,AAA', { width: 1, height: 1 })).toThrow(/length/);
      expect(() => decodeGradientPngDataUrl(`data:image/png;base64,${'!'.repeat(PNG_DATA_URL.split(',')[1]!.length)}`, { width: 1, height: 1 })).toThrow(/canonical/);
      expect(decode).not.toHaveBeenCalled();
    } finally { decode.mockRestore(); }
  });

  it('accepts only the exact canonical PNG data URL and expected dimensions', () => {
    expect(decodeGradientPngDataUrl(PNG_DATA_URL, { width: 1, height: 1 })).toEqual(PNG);
    expect(() => decodeGradientPngDataUrl(PNG_DATA_URL, { width: 2, height: 1 })).toThrow(/do not match/);
    expect(() => decodeGradientPngDataUrl(PNG_DATA_URL.replace('data:image/png;base64,', 'data:image/png;charset=utf-8;base64,'), { width: 1, height: 1 })).toThrow(/exact/);
    expect(() => decodeGradientPngDataUrl(`${PNG_DATA_URL}\n`, { width: 1, height: 1 })).toThrow(/length|canonical/);
    expect(() => decodeGradientPngDataUrl(`${PNG_DATA_URL.slice(0, -2)}J=`, { width: 1, height: 1 })).toThrow(/padding bits/);
  });

  it('computes canonical decoded length without decoding', () => {
    const base64 = PNG_DATA_URL.split(',')[1]!;
    expect(decodedLengthOfCanonicalBase64(base64)).toBe(PNG.length);
    expect(() => decodedLengthOfCanonicalBase64(`${base64.slice(0, -1)}!`)).toThrow(/canonical/);
  });

  it('checks signature, IHDR, and bounded header dimensions', () => {
    expect(validateGradientPngHeader(PNG)).toEqual({ width: 1, height: 1 });
    const wrongSignature = PNG.slice();
    wrongSignature[0] = 0;
    expect(() => validateGradientPngHeader(wrongSignature)).toThrow(/signature/);
    const oversized = PNG.slice();
    new DataView(oversized.buffer).setUint32(16, 4097);
    expect(() => validateGradientPngHeader(oversized)).toThrow(/dimensions/);
  });
});

describe('legacy byte representation admission', () => {
  it('accepts Uint8Array, dense arrays, and contiguous numeric objects', () => {
    expect(gradientBytesFromUnknown(PNG)).toBe(PNG);
    expect(gradientBytesFromUnknown(Array.from(PNG))).toEqual(PNG);
    expect(gradientBytesFromUnknown(Object.fromEntries(Array.from(PNG, (byte, index) => [String(index), byte])))).toEqual(PNG);
  });

  it('refuses holes, extra keys, gaps, and invalid byte values before conversion', () => {
    const sparse = Array.from(PNG) as Array<number | undefined>;
    delete sparse[4];
    expect(() => gradientBytesFromUnknown(sparse)).toThrow(/dense/);
    const extra = Array.from(PNG) as number[] & { extra?: number };
    extra.extra = 1;
    expect(() => gradientBytesFromUnknown(extra)).toThrow(/dense/);
    expect(() => gradientBytesFromUnknown(Array.from(PNG, (byte, index) => index === 4 ? Number.NaN : byte))).toThrow(/integer/);
    expect(() => gradientBytesFromUnknown(Array.from(PNG, (byte, index) => index === 4 ? 1.5 : byte))).toThrow(/integer/);
    const gap = Object.fromEntries(Array.from(PNG, (byte, index) => [String(index), byte]));
    delete gap['4'];
    expect(() => gradientBytesFromUnknown(gap)).toThrow(/contiguous/);
    expect(() => gradientBytesFromUnknown({ ...Object.fromEntries(Array.from(PNG, (byte, index) => [String(index), byte])), name: 1 })).toThrow(/canonical/);
  });
});
