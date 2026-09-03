// The broker's per-instance session tallies — the two coverage facts only the broker
// witnesses: frames the relay lost before it could connect, and batches that arrived
// stamped as replayed after an outage.
//
// They deliberately do NOT live on the registry entry. A reconnect closes the socket
// first and the daemon deletes that entry before the new PLUGIN_HELLO lands, so a tally
// kept there would be erased by exactly the event it exists to survive — and the relay
// re-reports only when it has NEW loss to declare, so nothing would refill it. A session
// that dropped frames would then read as `complete: true`, which is the one failure this
// whole statement exists to prevent.
import { describe, expect, it, vi } from 'vitest';
import { createSessionTallies } from '../cli/src/transport/session-tallies.ts';

describe('createSessionTallies', () => {
  it('an unseen instance has no tally at all — never a fabricated zero row', () => {
    expect(createSessionTallies().get('i1')).toBeNull();
  });

  it('a relay report REPLACES the tally; the frame already carries the whole session total', () => {
    const tallies = createSessionTallies();
    tallies.recordRelayDrops('i1', 5);
    expect(tallies.get('i1')).toEqual({ relayDroppedFrames: 5, replayedBatches: 0 });
    // A second report after a reconnect restates the SESSION total. Summing it would
    // double-count the five frames the first report already declared.
    tallies.recordRelayDrops('i1', 9);
    expect(tallies.get('i1')?.relayDroppedFrames).toBe(9);
  });

  it('replayed batches accumulate, one per BATCH, per instance', () => {
    const tallies = createSessionTallies();
    tallies.countReplayedBatch('i1');
    tallies.countReplayedBatch('i1');
    tallies.countReplayedBatch('i2');
    expect(tallies.get('i1')?.replayedBatches).toBe(2);
    expect(tallies.get('i2')).toEqual({ relayDroppedFrames: 0, replayedBatches: 1 });
  });

  it('survives the disconnect that deletes the registry entry — the same id reads its tally back', () => {
    const tallies = createSessionTallies();
    tallies.recordRelayDrops('i1', 4);
    // (no removal hook exists on purpose — a close must not erase the session's record)
    expect(tallies.get('i1')?.relayDroppedFrames).toBe(4);
  });

  it('past the cap the OLDEST tally is evicted, and the eviction is reported, never silent', () => {
    const onEvict = vi.fn();
    const tallies = createSessionTallies({ max: 2, onEvict });
    tallies.recordRelayDrops('i1', 1);
    tallies.recordRelayDrops('i2', 2);
    tallies.recordRelayDrops('i3', 3);
    expect(tallies.get('i1')).toBeNull();
    expect(tallies.get('i3')?.relayDroppedFrames).toBe(3);
    expect(onEvict).toHaveBeenCalledWith('i1', { relayDroppedFrames: 1, replayedBatches: 0 });
  });

  it('a malformed or negative report is refused rather than stored as a number nobody measured', () => {
    const tallies = createSessionTallies();
    tallies.recordRelayDrops('i1', -3);
    tallies.recordRelayDrops('i1', Number.NaN);
    expect(tallies.get('i1')).toBeNull();
  });
});
