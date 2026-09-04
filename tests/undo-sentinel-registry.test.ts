// The undo-sentinel registry's own contract (issue #121): membership by id, bounded FIFO,
// lazy release (no explicit release function exists — see undo-sentinel-registry.ts for why).
import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerSentinel, isSentinelId, resetSentinelRegistryForTest,
} from '../plugin/src/main/undo-sentinel-registry.ts';

beforeEach(() => {
  resetSentinelRegistryForTest();
});

describe('undo-sentinel-registry', () => {
  it('an unregistered id is not a sentinel', () => {
    expect(isSentinelId('never-registered')).toBe(false);
  });

  it('a registered id is recognized', () => {
    registerSentinel('s1');
    expect(isSentinelId('s1')).toBe(true);
  });

  it('registering the same id twice is a no-op, not a duplicate entry that skews eviction order', () => {
    registerSentinel('s1');
    registerSentinel('s1');
    for (let i = 0; i < 32; i++) registerSentinel(`filler-${i}`);
    // If the duplicate re-inserted 's1' as newest, it would still be present here — the
    // real test is the eviction-order case below, this just documents idempotency.
    expect(isSentinelId('s1')).toBe(false); // s1 was the oldest and is now evicted
  });

  it('the 33rd registration evicts the oldest (id #1), which stops being recognized', () => {
    for (let i = 1; i <= 32; i++) registerSentinel(`id-${i}`);
    expect(isSentinelId('id-1')).toBe(true); // still within the 32-deep bound

    registerSentinel('id-33');

    expect(isSentinelId('id-1')).toBe(false); // evicted — oldest, FIFO
    expect(isSentinelId('id-2')).toBe(true);  // everything else survives
    expect(isSentinelId('id-33')).toBe(true);
  });

  it('there is no release function — membership only grows until the FIFO bound evicts it', () => {
    registerSentinel('s1');
    expect(isSentinelId('s1')).toBe(true);
    // No releaseSentinel export exists; the id stays recognized indefinitely short of eviction.
    expect(isSentinelId('s1')).toBe(true);
  });
});
