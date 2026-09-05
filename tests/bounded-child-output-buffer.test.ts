import { describe, expect, it } from 'vitest';
import { BoundedOutputBuffer } from '../cli/src/transport/bounded-child-output-buffer.ts';

describe('bounded diagnostic UTF-8 output', () => {
  it('never joins disjoint byte fragments into an invented code point', () => {
    const output = new BoundedOutputBuffer(4, 'head-tail');
    output.push(Buffer.from('🙂€'));
    const result = output.snapshot();
    expect(result.text).toBe('');
    expect(result.totalBytes).toBe(7);
    expect(result.retainedBytes).toBe(4);
    expect(result.truncated).toBe(true);
  });

  it('retains complete characters on each side of a discarded middle', () => {
    const output = new BoundedOutputBuffer(8, 'head-tail');
    output.push(Buffer.from('é漢🙂a'));
    expect(output.snapshot().text).toBe('éa');
  });

  it('decodes an untruncated code point split across incoming chunks', () => {
    const output = new BoundedOutputBuffer(8, 'head-tail');
    const bytes = Buffer.from('🙂€');
    for (const byte of bytes) output.push(Buffer.from([byte]));
    expect(output.snapshot().text).toBe('🙂€');
  });

  it.each(['prefix', 'head-tail'] as const)('bounds decoded %s bytes even for malformed UTF-8', (mode) => {
    const output = new BoundedOutputBuffer(4, mode);
    output.push(Buffer.from([255, 255, 255, 255, 255]));
    const result = output.snapshot();
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(4);
    expect(result.retainedBytes).toBe(4);
    expect(result.totalBytes).toBe(5);
    expect(result.truncated).toBe(true);
  });

  it('reports truncation when decoding expansion requires clipping', () => {
    const output = new BoundedOutputBuffer(4, 'head-tail');
    output.push(Buffer.from([255, 255]));
    const result = output.snapshot();
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(4);
    expect(result.totalBytes).toBe(2);
    expect(result.truncated).toBe(true);
  });
});
