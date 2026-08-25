import { describe, expect, it } from 'vitest';
import { makeRequestFrame } from '../shared/protocol.ts';
import { durableFileKey, exactTargetFileKey } from '../cli/src/transport/file-identity.ts';

describe('durableFileKey', () => {
  it('preserves a nonempty raw file key verbatim', () => {
    expect(durableFileKey('AbC 123', 'Renamed design file')).toBe('AbC 123');
  });

  it('refuses absent or whitespace-only keys without falling back to a file name', () => {
    for (const key of [undefined, null, '', '   ']) {
      expect(durableFileKey(key, 'Renamed design file')).toBeNull();
    }
  });

  it('accepts only an unpadded raw target assertion and preserves it exactly on the wire', () => {
    expect(exactTargetFileKey('Raw/Key-9')).toBe('Raw/Key-9');
    for (const key of [undefined, null, '', '  ', ' Raw/Key-9', 'Raw/Key-9 ']) {
      expect(exactTargetFileKey(key)).toBeNull();
    }

    const withoutTarget = makeRequestFrame('id-none', 'STATUS', {});
    expect(withoutTarget).not.toHaveProperty('targetFileKey');
    expect(makeRequestFrame(
      'id-raw', 'SET_TEXT', { nodeId: '1:1', text: 'x' },
      undefined, undefined, undefined, undefined, undefined, undefined, 'Raw/Key-9',
    )).toMatchObject({ targetFileKey: 'Raw/Key-9' });
  });
});
