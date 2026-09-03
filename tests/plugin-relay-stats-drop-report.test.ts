// The plugin's pre-connect drop tally reaches the broker log as its OWN event
// (PLUGIN_RELAY_STATS), sent right after the handshake and only once something was
// actually lost — the panel is the only other witness and it dies with the iframe.
//
// It is deliberately NOT a PLUGIN_HELLO field. A broker predating this change strips a
// fixed set of protocol keys out of the hello payload and treats the REST as scene
// identity, so a growing tally riding the hello would have made every reconnect look
// like a scene change and silently reset the flapper streak the zombie watchdog counts
// on — a regression landing exactly when the plugin has been dropping frames. That older
// broker instead falls through to its "any other plugin event" branch and re-broadcasts
// the frame to its CLI clients, which ignore event types they do not know.
//
// The DELTA is the relay's to compute, not the broker's: only the relay knows which
// drops it has already had acknowledged by a successful write, and that knowledge lives
// in the iframe, so it survives the socket close a reconnect starts with. The frame
// carries both halves — `dropped` (new since the last successful report) and
// `sessionTotal` — and the broker logs exactly what arrives.
import { describe, expect, it } from 'vitest';
import { readRelayDropStats } from '../shared/protocol.ts';
import { extractScene } from '../cli/src/transport/plugin-registry.ts';

describe('readRelayDropStats — a new loss is reported, everything else reads as no loss', () => {
  it('reads a real report, delta and session total both', () => {
    expect(readRelayDropStats({ dropped: { frames: 4, chars: 900 }, sessionTotal: { frames: 9, chars: 2_000 } }))
      .toEqual({ dropped: { frames: 4, chars: 900 }, sessionTotal: { frames: 9, chars: 2_000 } });
  });

  it('an event carrying no report at all is not a loss', () => {
    expect(readRelayDropStats({ instanceId: 'i1', fileName: 'F' })).toBeNull();
    expect(readRelayDropStats(undefined)).toBeNull();
    expect(readRelayDropStats(null)).toBeNull();
  });

  it('a zero, negative, non-numeric or non-object delta is never logged as a loss', () => {
    expect(readRelayDropStats({ dropped: { frames: 0, chars: 0 }, sessionTotal: { frames: 7, chars: 70 } })).toBeNull();
    expect(readRelayDropStats({ dropped: { frames: -2, chars: 10 } })).toBeNull();
    expect(readRelayDropStats({ dropped: { frames: 'lots' } })).toBeNull();
    expect(readRelayDropStats({ dropped: 7 })).toBeNull();
  });

  it('a delta with a missing or broken size still reports the frames it lost', () => {
    expect(readRelayDropStats({ dropped: { frames: 2 } }))
      .toEqual({ dropped: { frames: 2, chars: 0 }, sessionTotal: { frames: 2, chars: 0 } });
    expect(readRelayDropStats({ dropped: { frames: 2, chars: Number.NaN } }))
      .toEqual({ dropped: { frames: 2, chars: 0 }, sessionTotal: { frames: 2, chars: 0 } });
  });

  it('a missing or smaller-than-the-delta session total falls back to the delta itself', () => {
    // Never invented: the smallest total consistent with the delta IS the delta, so the
    // log states a number the frame actually supports rather than a prettier guess.
    expect(readRelayDropStats({ dropped: { frames: 3, chars: 30 } }))
      .toEqual({ dropped: { frames: 3, chars: 30 }, sessionTotal: { frames: 3, chars: 30 } });
    expect(readRelayDropStats({ dropped: { frames: 3, chars: 30 }, sessionTotal: { frames: 1, chars: 5 } }))
      .toEqual({ dropped: { frames: 3, chars: 30 }, sessionTotal: { frames: 3, chars: 30 } });
  });
});

describe('PLUGIN_HELLO scene identity is untouched by the drop report', () => {
  it('the hello payload keeps its 3 stripped protocol keys and nothing more', () => {
    expect(extractScene({ instanceId: 'i1', pluginVersion: '0.1.0', protocolV: 1, fileName: 'F', page: 'P' }))
      .toEqual({ fileName: 'F', page: 'P' });
  });
});
