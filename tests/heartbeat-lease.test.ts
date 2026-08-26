import { describe, expect, it } from 'vitest';
import {
  reduceHeartbeatLease,
  startHeartbeatLease,
  type HeartbeatLeaseDecision,
} from '../plugin/src/ui/heartbeat-lease.ts';

const config = { intervalMs: 10_000, timeoutMs: 25_000 };

function tick(decision: HeartbeatLeaseDecision, now: number, nextProbeId: string) {
  return reduceHeartbeatLease(decision.state, { type: 'tick', now, nextProbeId }, config);
}

describe('heartbeat lease', () => {
  it('starts with one correlated challenge and accepts only its response', () => {
    const started = startHeartbeatLease('correlated', 0, 'probe-1', config);
    expect(started.effects).toEqual([{ type: 'send-challenge', probeId: 'probe-1' }]);

    const mismatched = reduceHeartbeatLease(started.state, {
      type: 'pong', now: 1, probeId: 'probe-old',
    }, config);
    expect(mismatched.effects).toEqual([]);
    expect(mismatched.state.phase).toBe('probing');

    const accepted = reduceHeartbeatLease(started.state, {
      type: 'pong', now: 2, probeId: 'probe-1',
    }, config);
    expect(accepted.effects).toEqual([{ type: 'accepted-current' }]);
    expect(accepted.state.phase).toBe('ready');
    expect(accepted.state.currentProbeId).toBeNull();
  });

  it('issues a fresh suspect challenge before closing after a normal missed deadline', () => {
    let decision = startHeartbeatLease('correlated', 0, 'probe-1', config);
    decision = tick(decision, 10_000, 'unused-1');
    decision = tick(decision, 20_000, 'unused-2');
    decision = tick(decision, 30_000, 'probe-2');
    expect(decision.effects).toEqual([{ type: 'send-challenge', probeId: 'probe-2' }]);
    expect(decision.state.phase).toBe('suspect');

    decision = tick(decision, 40_000, 'unused-3');
    decision = tick(decision, 50_000, 'unused-4');
    decision = tick(decision, 60_000, 'unused-5');
    expect(decision.effects).toEqual([{ type: 'teardown' }]);
  });

  it('treats a delayed scheduler callback as suspension and refreshes the challenge', () => {
    let decision = startHeartbeatLease('correlated', 0, 'probe-1', config);
    decision = tick(decision, 26_000, 'probe-2');
    expect(decision.effects).toEqual([{ type: 'send-challenge', probeId: 'probe-2' }]);
    expect(decision.state.deadline).toBe(51_000);

    const stale = reduceHeartbeatLease(decision.state, {
      type: 'pong', now: 27_000, probeId: 'probe-1',
    }, config);
    expect(stale.effects).toEqual([]);
    expect(stale.state.phase).toBe('suspect');

    decision = tick(stale, 36_000, 'unused-1');
    decision = tick(decision, 46_000, 'unused-2');
    decision = tick(decision, 56_000, 'unused-3');
    expect(decision.effects).toEqual([{ type: 'teardown' }]);
  });

  it('accepts an uncorrelated response only in explicit legacy mode', () => {
    const legacy = startHeartbeatLease('legacy', 0, 'legacy-probe', config);
    expect(reduceHeartbeatLease(legacy.state, { type: 'pong', now: 1 }, config).effects)
      .toEqual([{ type: 'accepted-current' }]);
    expect(reduceHeartbeatLease(legacy.state, {
      type: 'pong', now: 1, probeId: 'mismatched',
    }, config).effects).toEqual([]);

    const correlated = startHeartbeatLease('correlated', 0, 'correlated-probe', config);
    expect(reduceHeartbeatLease(correlated.state, { type: 'pong', now: 1 }, config).effects)
      .toEqual([]);
  });
});
