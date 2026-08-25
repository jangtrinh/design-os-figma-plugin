import { describe, expect, it } from 'vitest';
import { makeRequestId } from '../shared/protocol.ts';

describe('request ids — unique across CLI processes', () => {
  it('does not collide when two client namespaces mint counter one in the same millisecond', () => {
    expect(makeRequestId(1, 'client-a', 1_787_651_128_422))
      .not.toBe(makeRequestId(1, 'client-b', 1_787_651_128_422));
  });

  it('stays deterministic for one namespace, counter, and clock value', () => {
    expect(makeRequestId(7, 'client-a', 1_000)).toBe('c_client-a_7_1000');
  });
});
