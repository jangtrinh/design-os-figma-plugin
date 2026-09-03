import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  isDesignerCorrectionCandidate, readEdgeCorrections, readEvictedUnresolvedCount, writeEdgeCorrections,
  recordAgentMutationBatch, recordDesignerCorrection,
  beginCorrectionBatch, flushCorrectionBatch, recordDesignerCorrectionInBatch,
} from '../plugin/src/main/correction-edge-store';
import { buildCorrectionEvent, type CorrectionEvent } from '../shared/supervised-memory';

describe('designer correction classification', () => {
  it('accepts focused property changes', () => {
    expect(isDesignerCorrectionCandidate('PROPERTY_CHANGE', ['fills'])).toBe(true);
    expect(isDesignerCorrectionCandidate('PROPERTY_CHANGE', ['itemSpacing', 'paddingTop'])).toBe(true);
  });

  it('rejects creation, deletion, and structural creation batches', () => {
    expect(isDesignerCorrectionCandidate('CREATE', [])).toBe(false);
    expect(isDesignerCorrectionCandidate('DELETE', [])).toBe(false);
    expect(isDesignerCorrectionCandidate('PROPERTY_CHANGE', ['fills', 'parent', 'relativeTransform']))
      .toBe(false);
  });
});

// Registry-integrity phase 04 (5.4), §3 — chunked sharedPluginData with byte accounting.
// A minimal `figma.root` mock (a Map-backed key/value store implementing just the two
// methods this module calls) — no live plugin runtime needed, this is pure storage-shape
// logic, not anything Figma-specific.
interface MockFigmaRoot {
  getSharedPluginData: (ns: string, key: string) => string;
  setSharedPluginData: (ns: string, key: string, value: string) => void;
  /** Every call this root has served — the store's only I/O surface, so these ARE the
   *  document reads and writes, not a proxy for them. */
  counts: { get: number; set: number };
}

function mockFigmaRoot(): MockFigmaRoot {
  const store = new Map<string, string>();
  const counts = { get: 0, set: 0 };
  return {
    counts,
    getSharedPluginData: (ns, key) => {
      counts.get += 1;
      return store.get(`${ns}:${key}`) ?? '';
    },
    setSharedPluginData: (ns, key, value) => {
      counts.set += 1;
      if (value === '') store.delete(`${ns}:${key}`);
      else store.set(`${ns}:${key}`, value);
    },
  };
}

function event(eventId: string, timestamp: string, over: Partial<CorrectionEvent> = {}): CorrectionEvent {
  return buildCorrectionEvent({
    eventId, fileKey: 'file-1', nodeId: '1:2', source: 'designer', kind: 'designer-correction',
    timestamp, traits: { spacing: { from: 8, to: 12 } }, ...over,
  });
}

/** A resolved event's timestamp must be within `RAW_RETENTION_DAYS` of the REAL system
 *  clock (`writeEdgeCorrections` calls `retainCorrectionEvents(events, new Date(), …)`
 *  internally — not injectable) or it is unconditionally age-expired regardless of the
 *  hard cap. `minutesAgo` keeps fixtures ordered relative to each other while staying
 *  safely inside the retention window. */
function recentIso(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).figma = { root: mockFigmaRoot(), fileKey: 'test-file-key' };
});

describe('writeEdgeCorrections / readEdgeCorrections — chunked storage round-trip', () => {
  it('round-trips a small set (fits in one chunk) exactly', () => {
    const events = [event('a', recentIso(2)), event('b', recentIso(1))];
    writeEdgeCorrections(events);
    expect(readEdgeCorrections().map((e) => e.eventId)).toEqual(['a', 'b']);
  });

  it('splits across multiple chunks when the payload exceeds the per-chunk budget, and reassembles in order', () => {
    // Each event's `traits.blob` is ~2 KB — enough that a few hundred easily cross the
    // 64 KB per-chunk budget, forcing a real multi-chunk write.
    const blob = 'x'.repeat(2_000);
    const events = Array.from({ length: 100 }, (_, i) => event(`e${i}`, recentIso(100 - i), { traits: { blob } }));
    writeEdgeCorrections(events);
    const back = readEdgeCorrections();
    expect(back).toHaveLength(100);
    expect(back.map((e) => e.eventId)).toEqual(events.map((e) => e.eventId));
  });

  it('a write with fewer chunks than the prior write clears the stale trailing chunk keys', () => {
    const blob = 'x'.repeat(2_000);
    const many = Array.from({ length: 100 }, (_, i) => event(`e${i}`, recentIso(100 - i), { traits: { blob } }));
    writeEdgeCorrections(many); // several chunks
    writeEdgeCorrections([event('solo', recentIso(1))]); // one chunk
    expect(readEdgeCorrections().map((e) => e.eventId)).toEqual(['solo']); // no leftover ghosts from the old chunks
  });
});

describe('writeEdgeCorrections — the hard cap applies here too (EDGE_RAW_LIMIT)', () => {
  it('caps the STORED set even when unresolved events alone would have exceeded it', () => {
    const unresolved = Array.from({ length: 260 }, (_, i) => event(`u${i}`, recentIso(260 - i), { unresolved: true }));
    const kept = writeEdgeCorrections(unresolved);
    expect(kept.length).toBeLessThanOrEqual(250); // EDGE_RAW_LIMIT
    expect(readEdgeCorrections()).toHaveLength(kept.length);
  });
});

// Stage-4 MAJOR7 — an unresolved event evicted here (no filesystem to archive it to) was
// previously discarded with zero trace; the eviction count must survive as a running
// total in the v2 manifest, readable independent of any specific write call.
describe('writeEdgeCorrections — MAJOR7: evicted-unresolved count is carried, never silently discarded', () => {
  it('a write with 0 evictions leaves the count at 0', () => {
    writeEdgeCorrections([event('a', recentIso(1))]);
    expect(readEvictedUnresolvedCount()).toBe(0);
  });

  it('260 unresolved events > EDGE_RAW_LIMIT (250) records exactly 10 evicted', () => {
    const unresolved = Array.from({ length: 260 }, (_, i) => event(`u${i}`, recentIso(260 - i), { unresolved: true }));
    writeEdgeCorrections(unresolved);
    expect(readEvictedUnresolvedCount()).toBe(10);
  });

  it('the count is a RUNNING TOTAL across multiple writes, never reset or overwritten', () => {
    const firstBatch = Array.from({ length: 260 }, (_, i) => event(`u${i}`, recentIso(260 - i), { unresolved: true }));
    writeEdgeCorrections(firstBatch); // evicts 10
    expect(readEvictedUnresolvedCount()).toBe(10);

    // A second over-cap write (fresh event IDs) evicts 5 more — the total accumulates.
    const secondBatch = Array.from({ length: 255 }, (_, i) => event(`v${i}`, recentIso(255 - i), { unresolved: true }));
    writeEdgeCorrections(secondBatch);
    expect(readEvictedUnresolvedCount()).toBe(15);
  });

  it('a pre-MAJOR7 manifest (no evictedUnresolved field) reads as 0, never a crash', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const root = (globalThis as any).figma.root;
    root.setSharedPluginData('ease_design', 'figma-corrections-v2-manifest', JSON.stringify({ v: 2, chunks: 0 }));
    expect(readEvictedUnresolvedCount()).toBe(0);
  });
});

describe('v1 → v2 migration — lazy, write-triggered, always lossless', () => {
  it('reads a legacy v1 single-key value correctly before any v2 write has happened', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).figma.root.setSharedPluginData('ease_design', 'figma-corrections-v1', JSON.stringify([event('legacy', '2026-01-01T00:00:00.000Z')]));
    expect(readEdgeCorrections().map((e) => e.eventId)).toEqual(['legacy']);
  });

  it('the first write after upgrade migrates to v2 chunks + manifest and clears the v1 key', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const root = (globalThis as any).figma.root;
    const legacy = event('legacy', recentIso(2));
    root.setSharedPluginData('ease_design', 'figma-corrections-v1', JSON.stringify([legacy]));
    writeEdgeCorrections([legacy, event('new', recentIso(1))]);
    expect(root.getSharedPluginData('ease_design', 'figma-corrections-v1')).toBe(''); // cleared
    expect(root.getSharedPluginData('ease_design', 'figma-corrections-v2-manifest')).not.toBe(''); // v2 present
    expect(readEdgeCorrections().map((e) => e.eventId)).toEqual(['legacy', 'new']); // lossless
  });
});

describe('the byte-cap safety net — never wedges on a value it cannot store', () => {
  it('a pathologically oversized single event (alone exceeds the 100 kB Figma cap) is evicted, not left to wedge the write', () => {
    const hugeBlob = 'x'.repeat(150_000); // alone exceeds FIGMA_ENTRY_BYTE_CAP
    const oldestOversized = event('huge', recentIso(2), { traits: { blob: hugeBlob } });
    const normal = event('normal', recentIso(1));
    const kept = writeEdgeCorrections([oldestOversized, normal]);
    expect(kept.map((e) => e.eventId)).toEqual(['normal']); // the oversized (oldest) one evicted
    expect(readEdgeCorrections().map((e) => e.eventId)).toEqual(['normal']);
    // A resolved oversized drop does NOT count toward evictedUnresolved (not the
    // "immortal unresolved" concern this counter tracks).
    expect(readEvictedUnresolvedCount()).toBe(0);
  });

  // Stage-4 N5 — an UNRESOLVED event evicted by this safety net is the exact same class
  // of loss MAJOR7's evictedUnresolved counter exists to surface, just via a different
  // eviction path (the byte-cap, not the ordinary hard-cap retention pass).
  it('N5: an unresolved oversized event evicted here DOES increment evictedUnresolved', () => {
    const hugeBlob = 'x'.repeat(150_000);
    const oldestOversized = event('huge', recentIso(2), { unresolved: true, traits: { blob: hugeBlob } });
    const normal = event('normal', recentIso(1));
    const kept = writeEdgeCorrections([oldestOversized, normal]);
    expect(kept.map((e) => e.eventId)).toEqual(['normal']);
    expect(readEvictedUnresolvedCount()).toBe(1);
  });

  it('N5: the byte-cap count ACCUMULATES with the ordinary hard-cap evictedUnresolved count, never overwrites it', () => {
    // First write: an ordinary hard-cap eviction (260 unresolved > EDGE_RAW_LIMIT 250).
    const unresolvedBatch = Array.from({ length: 260 }, (_, i) => event(`u${i}`, recentIso(260 - i), { unresolved: true }));
    writeEdgeCorrections(unresolvedBatch);
    expect(readEvictedUnresolvedCount()).toBe(10);

    // Second write: a byte-cap eviction of an unresolved oversized event.
    const hugeBlob = 'x'.repeat(150_000);
    const oldestOversized = event('huge2', recentIso(2), { unresolved: true, traits: { blob: hugeBlob } });
    const normal = event('normal2', recentIso(1));
    writeEdgeCorrections([oldestOversized, normal]);
    expect(readEvictedUnresolvedCount()).toBe(11); // 10 (prior) + 1 (this byte-cap drop)
  });
});

// A node created through a typed creating command (frame, instance, imported subtree)
// has no id until the dispatch that creates it returns — the id exists only in the
// RESULT, never before. `recordAgentMutationBatch` is the single call every creating
// command's post-dispatch bookkeeping goes through: it must record that result id's
// provenance AND arm its trailing suppression window in the same call, because the
// node's own create-time property writes have not been observed yet — the
// `documentchange` batch for them is always delivered asynchronously, strictly after
// the dispatch promise has already resolved. Arming suppression only from ids known
// BEFORE dispatch started (an id a fresh create cannot have) leaves that async batch
// unsuppressed, so it would pass every check downstream and be recorded as though a
// human had corrected the agent's own write.
describe('recordAgentMutationBatch — provenance + suppression for ids only known after dispatch', () => {
  it('suppresses the fresh node\'s own create-time writes, delivered asynchronously after dispatch', async () => {
    const freshNodeId = 'fresh-node-1';

    recordAgentMutationBatch([freshNodeId], { command: 'CREATE_FRAME' });

    // The documentchange batch for a create arrives strictly after the dispatch that
    // created the node has already returned — modelled here as real microtask
    // boundaries, never a same-tick call.
    await Promise.resolve();
    await Promise.resolve();

    const correction = recordDesignerCorrection(freshNodeId, {
      changeType: 'PROPERTY_CHANGE',
      properties: ['name', 'width', 'height'],
    });
    expect(correction).toBeNull();

    const stored = readEdgeCorrections().filter((e) => e.nodeId === freshNodeId);
    expect(stored.filter((e) => e.kind === 'agent-operation')).toHaveLength(1);
    expect(stored.filter((e) => e.kind === 'designer-correction')).toHaveLength(0);
  });

  it('covers every id in the batch, matching a payload import that creates several nodes at once', async () => {
    const idA = 'fresh-node-a';
    const idB = 'fresh-node-b';

    recordAgentMutationBatch([idA, idB], { command: 'IMPORT_PAYLOAD' });
    await Promise.resolve();

    expect(recordDesignerCorrection(idA, { changeType: 'PROPERTY_CHANGE', properties: ['width'] })).toBeNull();
    expect(recordDesignerCorrection(idB, { changeType: 'PROPERTY_CHANGE', properties: ['height'] })).toBeNull();
  });

  it('does not silence a GENUINE designer edit made after the trailing window has elapsed', () => {
    const freshNodeId = 'fresh-node-2';
    vi.useFakeTimers();
    try {
      recordAgentMutationBatch([freshNodeId], { command: 'CREATE_FRAME' });
      vi.advanceTimersByTime(2_001); // past the trailing suppression window
      const correction = recordDesignerCorrection(freshNodeId, {
        changeType: 'PROPERTY_CHANGE',
        properties: ['fills'],
      });
      expect(correction).not.toBeNull();
      expect(correction?.kind).toBe('designer-correction');
    } finally {
      vi.useRealTimers();
    }
  });
});

// One `documentchange` batch used to read + parse the WHOLE correction store once per
// changed node (0.63 ms at 102 events — 50 times over in one drag delivery) and write it
// back per correction. The batch reads once, writes once, and the parsed copy never
// outlives the batch that read it: the same lifetime rule connector-store.ts pays for,
// because a second tab or another plugin instance can move the document underneath us.
describe('the correction store per documentchange batch — read once, write once', () => {
  /** The mock root installed by `beforeEach`, with its call counters. */
  const root = (): MockFigmaRoot => (globalThis as any).figma.root as MockFigmaRoot;

  const propertyChange = (properties: string[]) => ({ changeType: 'PROPERTY_CHANGE', properties });

  it('a batch whose changes are all non-candidates never touches the document at all', () => {
    const batch = beginCorrectionBatch();
    for (let i = 0; i < 50; i++) {
      // A drag: every change carries relativeTransform, so none is a correction candidate.
      recordDesignerCorrectionInBatch(batch, `n${i}`, propertyChange(['relativeTransform', 'x', 'y']));
    }
    flushCorrectionBatch(batch);

    expect(root().counts.get).toBe(0);
    expect(root().counts.set).toBe(0);
  });

  it('reads the store ONCE however many candidate changes the batch carries', () => {
    const batch = beginCorrectionBatch();
    for (let i = 0; i < 200; i++) recordDesignerCorrectionInBatch(batch, `n${i}`, propertyChange(['fills']));
    flushCorrectionBatch(batch);

    expect(root().counts.get).toBe(2); // the manifest, then the one chunk it names
    expect(root().counts.set).toBe(0); // no causal parent exists → no correction, no write
  });

  it('two corrections in ONE batch cost ONE write, and the second sees the first', () => {
    vi.useFakeTimers();
    try {
      recordAgentMutationBatch(['a1', 'a2'], { command: 'SET_TEXT' });
      vi.advanceTimersByTime(2_001); // past the trailing agent-echo suppression window
      root().counts.set = 0;

      const batch = beginCorrectionBatch();
      expect(recordDesignerCorrectionInBatch(batch, 'a1', propertyChange(['fills']))).not.toBeNull();
      expect(recordDesignerCorrectionInBatch(batch, 'a2', propertyChange(['fills']))).not.toBeNull();
      expect(batch.events?.filter((e) => e.kind === 'designer-correction')).toHaveLength(2);
      expect(root().counts.set).toBe(0); // nothing written until the flush
      flushCorrectionBatch(batch);

      expect(root().counts.set).toBe(2); // one chunk + its manifest = one write
      expect(readEdgeCorrections().filter((e) => e.kind === 'designer-correction')).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // No copy of the store outlives the read that produced it. A second Figma tab, another
  // plugin instance, or a direct edit to the blob can move the document at any moment, and
  // a held parse would be flushed back OVER whatever they appended. The batch's own
  // `events` already buys the whole read-once-per-batch win; a module-level copy bought
  // nothing on top of it and widened that clobber window across commands.
  it('a read never answers from an earlier read — the document is asked every time', () => {
    writeEdgeCorrections([event('a', recentIso(1))]);
    readEdgeCorrections();
    root().counts.get = 0;

    expect(readEdgeCorrections().map((e) => e.eventId)).toEqual(['a']);
    expect(root().counts.get).toBe(2); // the manifest, then the one chunk it names
  });

  it('a read after a write sees the WRITE, never a copy parsed before it', () => {
    writeEdgeCorrections([event('a', recentIso(1))]);
    readEdgeCorrections();
    writeEdgeCorrections([event('b', recentIso(1))]);

    expect(readEdgeCorrections().map((e) => e.eventId)).toEqual(['b']);
  });

  it('the returned events are a COPY — appending to them cannot corrupt the parsed copy', () => {
    writeEdgeCorrections([event('a', recentIso(1))]);
    const first = readEdgeCorrections();
    first.push(event('ghost', recentIso(0)));

    expect(readEdgeCorrections().map((e) => e.eventId)).toEqual(['a']);
  });
});
