// The boot sequence's own control flow, lifted out of main.ts so it can be tested without
// a sandbox: which step's failure disables what.
//
// The distinction that matters: gap-fill is ONE report about the window the plugin was
// closed, while the `documentchange` subscription is the whole session's live capture. A
// single page that refuses to walk must not cost the session the second one.
import { describe, it, expect } from 'vitest';
import { runBootCapture } from '../plugin/src/main/boot-capture.ts';

function recorder(): { calls: string[]; notices: string[] } {
  return { calls: [], notices: [] };
}

describe('runBootCapture — a failed gap-fill never costs the session its live capture', () => {
  it('subscribes to documentchange even when the gap-fill diff REJECTS, and says what failed', async () => {
    const log = recorder();

    await runBootCapture({
      loadAllPages: async () => { log.calls.push('load'); },
      gapfill: async () => { throw new Error('page not loaded'); },
      subscribe: () => { log.calls.push('subscribe'); },
      notify: (m) => log.notices.push(m),
    });

    expect(log.calls).toEqual(['load', 'subscribe']);
    expect(log.notices).toHaveLength(1);
    expect(log.notices[0]).toContain('page not loaded');
    // Honest wording: capture is NOT disabled here, only the closed-window report is.
    expect(log.notices[0]).not.toContain('capture disabled');
  });

  it('does NOT subscribe when loadAllPages fails — the dynamic-page precondition is unmet', async () => {
    const log = recorder();

    await runBootCapture({
      loadAllPages: async () => { throw new Error('load refused'); },
      gapfill: async () => { log.calls.push('gapfill'); },
      subscribe: () => { log.calls.push('subscribe'); },
      notify: (m) => log.notices.push(m),
    });

    expect(log.calls).toEqual([]);
    expect(log.notices).toEqual(['live-sync capture disabled: load refused']);
  });

  it('the healthy path runs load → gapfill → subscribe, once each, and notifies nothing', async () => {
    const log = recorder();

    await runBootCapture({
      loadAllPages: async () => { log.calls.push('load'); },
      gapfill: async () => { log.calls.push('gapfill'); },
      subscribe: () => { log.calls.push('subscribe'); },
      notify: (m) => log.notices.push(m),
    });

    expect(log.calls).toEqual(['load', 'gapfill', 'subscribe']);
    expect(log.notices).toEqual([]);
  });

  it('a subscribe that itself throws is reported as capture disabled, not swallowed', async () => {
    const log = recorder();

    await runBootCapture({
      loadAllPages: async () => {},
      gapfill: async () => {},
      subscribe: () => { throw new Error('on() unavailable'); },
      notify: (m) => log.notices.push(m),
    });

    expect(log.notices).toEqual(['live-sync capture disabled: on() unavailable']);
  });
});
