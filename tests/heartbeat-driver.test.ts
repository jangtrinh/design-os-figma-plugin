import { describe, expect, it } from 'vitest';
import { createHeartbeatDriver } from '../plugin/src/ui/heartbeat-driver.ts';

describe('heartbeat driver effect ordering', () => {
  it('challenges before teardown when a scheduled callback resumes after the stale threshold', () => {
    let now = 0;
    let scheduled: (() => void) | undefined;
    const effects: string[] = [];
    let probeCounter = 0;
    const driver = createHeartbeatDriver({
      now: () => now,
      nextProbeId: () => `probe-${++probeCounter}`,
      schedule: (callback) => { scheduled = callback; return 'timer'; },
      cancel: () => { scheduled = undefined; },
      sendProbe: (probeId) => { effects.push(`send:${probeId}`); },
      teardown: () => { effects.push('teardown'); },
      emitConnected: () => { effects.push('connected'); },
    }, { intervalMs: 10_000, timeoutMs: 25_000 });

    driver.start('correlated');
    effects.length = 0;
    now = 26_000;
    scheduled?.();

    expect(effects).toEqual(['send:probe-2']);
    now = 36_000; scheduled?.();
    now = 46_000; scheduled?.();
    now = 56_000; scheduled?.();
    expect(effects).toEqual(['send:probe-2', 'teardown']);
  });

  it('emits connected once and only for the current correlated response', () => {
    let now = 0;
    let scheduled: (() => void) | undefined;
    const effects: string[] = [];
    let probeCounter = 0;
    const driver = createHeartbeatDriver({
      now: () => now,
      nextProbeId: () => `probe-${++probeCounter}`,
      schedule: (callback) => { scheduled = callback; return callback; },
      cancel: () => { scheduled = undefined; },
      sendProbe: (probeId) => { effects.push(`send:${probeId}`); },
      teardown: () => { effects.push('teardown'); },
      emitConnected: () => { effects.push('connected'); },
    }, { intervalMs: 10_000, timeoutMs: 25_000 });

    driver.start('correlated');
    expect(driver.receivePong('old-probe')).toBe(false);
    expect(driver.receivePong('probe-1')).toBe(true);
    expect(driver.receivePong('probe-1')).toBe(false);
    expect(effects).toEqual(['send:probe-1', 'connected']);
  });

  it('accepts an uncorrelated response in legacy mode after probing', () => {
    let scheduled: (() => void) | undefined;
    const effects: string[] = [];
    const driver = createHeartbeatDriver({
      now: () => 0,
      nextProbeId: () => 'legacy-probe',
      schedule: (callback) => { scheduled = callback; return callback; },
      cancel: () => { scheduled = undefined; },
      sendProbe: (_probeId, mode) => { effects.push(`send:${mode}`); },
      teardown: () => { effects.push('teardown'); },
      emitConnected: () => { effects.push('connected'); },
    }, { intervalMs: 10_000, timeoutMs: 25_000 });

    driver.start('legacy');
    expect(driver.receivePong()).toBe(true);
    expect(effects).toEqual(['send:legacy', 'connected']);
  });

  it('cancels the old schedule when a new socket generation is adopted', () => {
    let now = 0;
    const scheduled: Array<() => void> = [];
    const effects: string[] = [];
    let probeCounter = 0;
    const driver = createHeartbeatDriver({
      now: () => now,
      nextProbeId: () => `probe-${++probeCounter}`,
      schedule: (callback) => { scheduled.push(callback); return callback; },
      cancel: () => {},
      sendProbe: (probeId) => { effects.push(`send:${probeId}`); },
      teardown: () => { effects.push('teardown'); },
      emitConnected: () => { effects.push('connected'); },
    }, { intervalMs: 10_000, timeoutMs: 25_000 });

    driver.start('correlated');
    const staleCallback = scheduled[0];
    driver.start('correlated');
    effects.length = 0;
    now = 26_000;
    staleCallback?.();

    expect(effects).toEqual([]);
    expect(driver.receivePong('probe-1')).toBe(false);
    expect(driver.receivePong('probe-2')).toBe(true);
    expect(effects).toEqual(['connected']);
  });
});
