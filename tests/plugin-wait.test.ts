// waitForPlugin's poll/timeout logic, with an injected fake clock + sleep so this
// runs instantly instead of stepping real 500ms ticks.
import { describe, expect, it } from 'vitest';
import { waitForPlugin } from '../cli/src/transport/plugin-wait.ts';

/** A fake clock that advances by `stepMs` every time `sleep` is awaited — deterministic,
 *  no real timers, no flake. */
function fakeClock(stepMs: number): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = 0;
  return {
    now: () => t,
    sleep: async () => { t += stepMs; },
  };
}

describe('waitForPlugin', () => {
  it('resolves immediately when a plugin is already registered, no filter', async () => {
    const { now, sleep } = fakeClock(500);
    const fetchHello = async () => ({ plugins: [{ instanceId: 'p_1', fileName: 'F' }] });
    const result = await waitForPlugin({ port: 1, timeoutMs: 5_000, now, sleep, fetchHello });
    expect(result).toEqual({ registered: true, waitedMs: 0, hello: { plugins: [{ instanceId: 'p_1', fileName: 'F' }] } });
  });

  it('polls until a matching plugin appears, then returns registered:true with the elapsed waitedMs', async () => {
    const { now, sleep } = fakeClock(500);
    let calls = 0;
    const fetchHello = async () => {
      calls += 1;
      return calls < 3 ? { plugins: [] } : { plugins: [{ instanceId: 'p_1', fileName: 'F' }] };
    };
    const result = await waitForPlugin({ port: 1, timeoutMs: 5_000, now, sleep, fetchHello });
    expect(result.registered).toBe(true);
    expect(result.waitedMs).toBe(1_000); // two sleeps of 500ms before the 3rd poll matched
    expect(calls).toBe(3);
  });

  it('respects --file: an unrelated plugin registering does not satisfy the wait', async () => {
    const { now, sleep } = fakeClock(500);
    const fetchHello = async () => ({ plugins: [{ instanceId: 'p_1', fileName: 'Other File' }] });
    const result = await waitForPlugin({ port: 1, timeoutMs: 1_000, fileFilter: 'My File', now, sleep, fetchHello });
    expect(result.registered).toBe(false);
  });

  it('fix round: --file matching uses the SAME identity normalization as the bind-lookup (figma-deep-link\'s findBoundEntry), not a plain trim+lowercase equality — so the wait and the deep link can never disagree about which file was meant', async () => {
    const { now, sleep } = fakeClock(500);
    // A double space vs a single space: fileIdentity/safeSlug collapses BOTH to the
    // same "my-file" slug (matching how project-bind.ts's fileNameSlug is derived at
    // bind time), while a plain fileMatches(..., true) trim+lowercase equality would
    // NOT consider these the same string. This is the exact divergence the review
    // reproduced between waitForPlugin's old fileMatches-based filter and
    // findBoundEntry's fileIdentity-based one.
    const fetchHello = async () => ({ plugins: [{ instanceId: 'p_1', fileName: 'My File' }] });
    const result = await waitForPlugin({ port: 1, timeoutMs: 1_000, fileFilter: 'My  File', now, sleep, fetchHello });
    expect(result.registered).toBe(true);
  });

  it('respects --instance: matches by exact instanceId, ignoring fileFilter when both somehow set', async () => {
    const { now, sleep } = fakeClock(500);
    const fetchHello = async () => ({ plugins: [{ instanceId: 'p_2', fileName: 'Anything' }] });
    const result = await waitForPlugin({
      port: 1, timeoutMs: 1_000, fileFilter: 'nonmatching', instanceFilter: 'p_2', now, sleep, fetchHello,
    });
    expect(result.registered).toBe(true);
  });

  it('times out honestly when nothing ever matches — registered:false, waitedMs at the deadline', async () => {
    const { now, sleep } = fakeClock(500);
    const fetchHello = async () => ({ plugins: [] });
    const result = await waitForPlugin({ port: 1, timeoutMs: 1_200, now, sleep, fetchHello });
    expect(result.registered).toBe(false);
    expect(result.waitedMs).toBeGreaterThanOrEqual(1_200);
  });

  it('a broker hiccup mid-wait (fetchHello throws) does not abort the wait — it just tries again', async () => {
    const { now, sleep } = fakeClock(500);
    let calls = 0;
    const fetchHello = async () => {
      calls += 1;
      if (calls === 1) throw new Error('ECONNRESET');
      return { plugins: [{ instanceId: 'p_1', fileName: 'F' }] };
    };
    const result = await waitForPlugin({ port: 1, timeoutMs: 5_000, now, sleep, fetchHello });
    expect(result.registered).toBe(true);
    expect(calls).toBe(2);
  });
});
