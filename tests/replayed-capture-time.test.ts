// The two halves of one contract: the relay stamps a capture with the time it HAPPENED
// the moment it goes into the pre-connect buffer, and the broker reads that stamp back
// instead of dating the whole outage to the instant of reconnect.
//
// Before this, `appendEditFrames`/`appendChangeFrames` stamped `Date.now()` at broker
// append time — true while an unsendable frame was destroyed, false the moment the relay
// started replaying a 40-minute gap: `figma-agent changes --since 1m` would report forty
// minutes of work as if it had all happened in the last second. Absent data became WRONG
// data, which this repo's house rules rank as the worse of the two.
//
// The broker still refuses to trust the stamp blindly: a plugin clock running ahead (or a
// malformed frame) must not park an edit in the future where `--since` will never surface
// it again, so an out-of-range stamp falls back to broker-now and is COUNTED, never
// silently accepted.
import { describe, expect, it } from 'vitest';
import { CAPTURED_AT_MAX_SKEW_MS, readCapturedAt, readReplayed } from '../shared/protocol.ts';
import { stampCapturedFrame } from '../plugin/src/ui/outbound-buffer.ts';

const NOW = 1_700_000_000_000;

describe('stampCapturedFrame — the relay records WHEN, at the moment it captures', () => {
  it('stamps the capture time and marks the frame a replay', () => {
    const json = stampCapturedFrame({ type: 'EDIT_FEED', data: { edits: [], fileName: 'F' } }, NOW);
    expect(JSON.parse(json)).toEqual({
      type: 'EDIT_FEED',
      data: { edits: [], fileName: 'F', capturedAt: NOW, replayed: true },
    });
  });

  it('a frame that arrives with no data at all still carries the stamp', () => {
    expect(JSON.parse(stampCapturedFrame({ type: 'DOC_CHANGE' }, NOW))).toEqual({
      type: 'DOC_CHANGE',
      data: { capturedAt: NOW, replayed: true },
    });
  });

  // Every frame in the buffer is there BECAUSE no socket was open, and the only way out
  // of the buffer is the reconnect flush — so "buffered" and "replayed" are the same
  // fact, known at enqueue time. Marking it later would mean re-parsing every frame.
  it('never overwrites the batch fields it is stamping alongside', () => {
    const json = stampCapturedFrame({ type: 'EDIT_FEED', data: { source: 'gapfill', edits: [1] } }, NOW);
    expect(JSON.parse(json).data).toMatchObject({ source: 'gapfill', edits: [1] });
  });
});

describe('readCapturedAt — trust the plugin\'s clock, but only within reach', () => {
  it('uses the capture time when the frame carries one', () => {
    expect(readCapturedAt({ capturedAt: NOW - 40 * 60_000 }, NOW)).toEqual({ ts: NOW - 40 * 60_000, rejected: false });
  });

  it('an older plugin that sends no stamp is dated at broker-now, and is NOT a rejection', () => {
    expect(readCapturedAt({ edits: [] }, NOW)).toEqual({ ts: NOW, rejected: false });
    expect(readCapturedAt(undefined, NOW)).toEqual({ ts: NOW, rejected: false });
    expect(readCapturedAt(null, NOW)).toEqual({ ts: NOW, rejected: false });
  });

  it('a stamp beyond the skew allowance falls back to now and is counted', () => {
    expect(readCapturedAt({ capturedAt: NOW + CAPTURED_AT_MAX_SKEW_MS + 1 }, NOW))
      .toEqual({ ts: NOW, rejected: true });
  });

  it('a small clock skew is tolerated rather than counted', () => {
    const slightlyAhead = NOW + CAPTURED_AT_MAX_SKEW_MS;
    expect(readCapturedAt({ capturedAt: slightlyAhead }, NOW)).toEqual({ ts: slightlyAhead, rejected: false });
  });

  it('a malformed, non-finite or non-positive stamp falls back to now and is counted', () => {
    for (const capturedAt of ['yesterday', Number.NaN, Number.POSITIVE_INFINITY, 0, -5, null]) {
      expect(readCapturedAt({ capturedAt }, NOW), String(capturedAt)).toEqual({ ts: NOW, rejected: true });
    }
  });
});

describe('readReplayed — only an explicit marker counts as history', () => {
  it('reads the relay\'s own marker', () => {
    expect(readReplayed({ replayed: true })).toBe(true);
  });

  it('everything else is live traffic', () => {
    expect(readReplayed({ replayed: 'true' })).toBe(false);
    expect(readReplayed({ replayed: 1 })).toBe(false);
    expect(readReplayed({ edits: [] })).toBe(false);
    expect(readReplayed(undefined)).toBe(false);
    expect(readReplayed(null)).toBe(false);
  });
});
