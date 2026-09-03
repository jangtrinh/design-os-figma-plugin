// The plugin's pre-connect drop tally reaches the broker log as its OWN event
// (PLUGIN_RELAY_STATS), sent right after the handshake and only once something was
// actually lost — the panel is the only other witness and it dies with the iframe.
//
// It is deliberately NOT a PLUGIN_HELLO field. A broker predating this change strips a
// fixed set of protocol keys out of the hello payload and treats the REST as scene
// identity, so a growing tally riding the hello would have made every reconnect look
// like a scene change and silently reset the flapper streak the zombie watchdog counts
// on — a regression landing exactly when the plugin has been dropping frames. An
// unknown event type costs that same older broker nothing.
//
// The tally the plugin sends is session-cumulative and re-sent on every reconnect (the
// plugin gets no acknowledgement, so its report has to stay idempotent). The broker
// therefore logs the DELTA it has not already recorded for that instance — otherwise
// five reconnects after one loss print the same total five times and a reader summing
// the log over-counts.
import { describe, expect, it } from 'vitest';
import { readPreOpenDropped } from '../shared/protocol.ts';
import { PluginRegistry, WS_OPEN, extractScene, type RegistrySocket } from '../cli/src/transport/plugin-registry.ts';

describe('readPreOpenDropped — a loss is reported, everything else reads as no loss', () => {
  it('reads a real report', () => {
    expect(readPreOpenDropped({ preOpenDropped: { frames: 4, chars: 900 } })).toEqual({ frames: 4, chars: 900 });
  });

  it('an event carrying no report at all is not a loss', () => {
    expect(readPreOpenDropped({ instanceId: 'i1', fileName: 'F' })).toBeNull();
    expect(readPreOpenDropped(undefined)).toBeNull();
    expect(readPreOpenDropped(null)).toBeNull();
  });

  it('a zero, negative, non-numeric or non-object report is never logged as a loss', () => {
    expect(readPreOpenDropped({ preOpenDropped: { frames: 0, chars: 0 } })).toBeNull();
    expect(readPreOpenDropped({ preOpenDropped: { frames: -2, chars: 10 } })).toBeNull();
    expect(readPreOpenDropped({ preOpenDropped: { frames: 'lots' } })).toBeNull();
    expect(readPreOpenDropped({ preOpenDropped: 7 })).toBeNull();
  });

  it('a report with a missing or broken size still reports the frames it lost', () => {
    expect(readPreOpenDropped({ preOpenDropped: { frames: 2 } })).toEqual({ frames: 2, chars: 0 });
    expect(readPreOpenDropped({ preOpenDropped: { frames: 2, chars: Number.NaN } })).toEqual({ frames: 2, chars: 0 });
  });
});

function fakeSocket(): RegistrySocket {
  return { readyState: WS_OPEN };
}

describe('PLUGIN_HELLO scene identity is untouched by the drop report', () => {
  it('the hello payload keeps its 3 stripped protocol keys and nothing more', () => {
    expect(extractScene({ instanceId: 'i1', pluginVersion: '0.1.0', protocolV: 1, fileName: 'F', page: 'P' }))
      .toEqual({ fileName: 'F', page: 'P' });
  });
});

describe('PluginRegistry.reportPreOpenDropped — log the increment, not the total again', () => {
  it('the first report is the whole tally', () => {
    const registry = new PluginRegistry(() => 1_000);
    const ws = fakeSocket();
    registry.register(ws, { instanceId: 'i1', fileName: 'F' });

    expect(registry.reportPreOpenDropped(ws, { frames: 5, chars: 40 })).toEqual({ frames: 5, chars: 40 });
  });

  it('a second report logs only what is new', () => {
    const registry = new PluginRegistry(() => 1_000);
    const ws = fakeSocket();
    registry.register(ws, { instanceId: 'i1', fileName: 'F' });
    registry.reportPreOpenDropped(ws, { frames: 5, chars: 40 });

    expect(registry.reportPreOpenDropped(ws, { frames: 9, chars: 100 })).toEqual({ frames: 4, chars: 60 });
  });

  it('a repeat of a tally already recorded reports nothing — the plugin re-sends it on every reconnect', () => {
    const registry = new PluginRegistry(() => 1_000);
    const ws = fakeSocket();
    registry.register(ws, { instanceId: 'i1', fileName: 'F' });
    registry.reportPreOpenDropped(ws, { frames: 5, chars: 40 });

    expect(registry.reportPreOpenDropped(ws, { frames: 5, chars: 40 })).toBeNull();
    expect(registry.reportPreOpenDropped(ws, { frames: 3, chars: 10 }), 'a tally that went backwards is not new loss').toBeNull();
  });

  it('a reconnect of the SAME instance keeps its recorded position — the tally is cumulative per iframe', () => {
    const registry = new PluginRegistry(() => 1_000);
    const first = fakeSocket();
    registry.register(first, { instanceId: 'i1', fileName: 'F' });
    registry.reportPreOpenDropped(first, { frames: 5, chars: 40 });

    const second = fakeSocket();
    registry.register(second, { instanceId: 'i1', fileName: 'F' });

    expect(registry.reportPreOpenDropped(second, { frames: 5, chars: 40 })).toBeNull();
    expect(registry.reportPreOpenDropped(second, { frames: 6, chars: 50 })).toEqual({ frames: 1, chars: 10 });
  });

  it('a fresh instance starts from zero — its tally is its own', () => {
    const registry = new PluginRegistry(() => 1_000);
    const a = fakeSocket();
    const b = fakeSocket();
    registry.register(a, { instanceId: 'i1', fileName: 'A' });
    registry.register(b, { instanceId: 'i2', fileName: 'B' });
    registry.reportPreOpenDropped(a, { frames: 5, chars: 40 });

    expect(registry.reportPreOpenDropped(b, { frames: 2, chars: 20 })).toEqual({ frames: 2, chars: 20 });
  });

  it('a socket that is not a registered plugin reports nothing', () => {
    const registry = new PluginRegistry(() => 1_000);
    expect(registry.reportPreOpenDropped(fakeSocket(), { frames: 5, chars: 40 })).toBeNull();
  });
});
