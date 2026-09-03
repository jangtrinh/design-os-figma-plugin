// The `documentchange` pass — the hottest loop in the plugin, now testable on its own
// (main.ts calls `figma.showUI` at module load, so it can never be imported here).
//
// Two facts drive these tests, both verified on the live canvas:
//   1. the plugin's OWN `figma.root.setSharedPluginData` write (correction store, connector
//      index, relaunch data) comes back as a `documentchange`: PROPERTY_CHANGE on node
//      `0:0`, type DOCUMENT, `properties: ['pluginData']`, origin LOCAL. Unfiltered it
//      entered the edit feed as an "updated" edit, armed the idle timer, and was offered to
//      the correction store as a designer edit;
//   2. `documentchange` is BATCHED and delivered asynchronously, so a "the plugin is writing
//      right now" flag is already cleared when its own echo lands — only a stateless
//      predicate on the change itself can filter it.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createDocumentChangeCapture } from '../plugin/src/main/document-change-capture.ts';
import { createEditIdentityCache } from '../plugin/src/main/change-node-identity.ts';
import type { ActorState } from '../plugin/src/main/edit-actor.ts';
import {
  beginCorrectionBatch, flushCorrectionBatch,
  recordAgentMutationBatch, recordDesignerCorrectionInBatch, type CorrectionBatch,
} from '../plugin/src/main/correction-edge-store.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface FakeNode { id: string; name: string; type: string; parent: FakeNode | null; removed?: boolean }

const PAGE: FakeNode = { id: 'p1', name: 'Page 1', type: 'PAGE', parent: null };
const FRAME: FakeNode = { id: 'f1', name: 'Card', type: 'FRAME', parent: PAGE };
const ROOT_DOCUMENT: FakeNode = { id: '0:0', name: 'Document', type: 'DOCUMENT', parent: null };

const text = (id: string): FakeNode => ({ id, name: `Label ${id}`, type: 'TEXT', parent: FRAME });

/** A live node `depth` containers below its OWN page. `documentchange` is document-wide, so
 *  a batch routinely carries edits from a page the designer is not looking at; the page in
 *  the feed has to come from the node's own chain, however deep, never from the viewport. */
function deepUnderPage(depth: number, pageName: string): FakeNode {
  const page: FakeNode = { id: 'p-deep', name: pageName, type: 'PAGE', parent: null };
  let current: FakeNode = page;
  for (let i = 0; i < depth; i++) current = { id: `d${i}`, name: `Frame ${i}`, type: 'FRAME', parent: current };
  return { id: 'deep-text', name: 'Deep label', type: 'TEXT', parent: current };
}

function change(node: FakeNode, type: string, properties: string[] = []): any {
  return { type, node, properties, origin: 'LOCAL' };
}

/** A counting `figma.root` — the store's only I/O surface, so a call here is a real read
 *  or write of `sharedPluginData`, not a proxy for one. */
function countingFigma(): { counts: { get: number; set: number } } {
  const store = new Map<string, string>();
  const counts = { get: 0, set: 0 };
  (globalThis as any).figma = {
    fileKey: 'test-file-key',
    // Deliberately NOT the page any fixture node lives on: every `page` assertion below
    // would pass on the current-page fallback alone if these two names matched, which is
    // exactly how a wrong page reached the feed unnoticed.
    currentPage: { name: 'Cover' },
    root: {
      name: 'Test File',
      getSharedPluginData: (ns: string, key: string) => {
        counts.get += 1;
        return store.get(`${ns}:${key}`) ?? '';
      },
      setSharedPluginData: (ns: string, key: string, value: string) => {
        counts.set += 1;
        if (value === '') store.delete(`${ns}:${key}`);
        else store.set(`${ns}:${key}`, value);
      },
    },
  };
  return { counts };
}

const idleActor = (): ActorState =>
  ({ activeCount: 0, lastDrainAt: 0, declared: new Map(), lastAgentAt: new Map() });

interface Log {
  posted: Array<{ type: string; data: any }>;
  corrections: string[];
  begins: number;
  flushes: number;
  connector: string[][];
  componentChanges: number[];
  edits: number;
  idleArmed: number;
}

function harness() {
  const log: Log = {
    posted: [], corrections: [], begins: 0, flushes: 0,
    connector: [], componentChanges: [], edits: 0, idleArmed: 0,
  };
  const capture = createDocumentChangeCapture<null>({
    now: () => 1_000,
    onBatchStart: () => {},
    actorState: idleActor,
    identity: createEditIdentityCache(),
    corrections: {
      begin: () => { log.begins += 1; return null; },
      record: (_b, nodeId) => { log.corrections.push(nodeId); },
      flush: () => { log.flushes += 1; },
    },
    noteChangedNodes: (ids) => log.connector.push([...ids]),
    post: (message) => log.posted.push(message as { type: string; data: any }),
    noteComponentChanges: (count) => log.componentChanges.push(count),
    noteEdits: () => { log.edits += 1; },
    armIdle: () => { log.idleArmed += 1; },
  });
  return { capture, log };
}

const feed = (log: Log) => log.posted.filter((m) => m.type === 'EDIT_FEED');

beforeEach(() => {
  countingFigma();
});

describe('the plugin\'s own bookkeeping write never becomes an owner edit', () => {
  it('a root pluginData change enters nothing, arms nothing, and is COUNTED', () => {
    const { capture, log } = harness();

    capture.onDocumentChange({
      documentChanges: [change(ROOT_DOCUMENT, 'PROPERTY_CHANGE', ['pluginData'])],
    } as any);

    expect(feed(log)).toHaveLength(0);      // not in the edit feed
    expect(log.idleArmed).toBe(0);          // the idle timer is not re-armed by our own write
    expect(log.edits).toBe(0);              // the gap-fill baseline is not marked dirty
    expect(log.corrections).toEqual([]);    // never offered to the correction store
    expect(log.connector).toEqual([]);      // never offered to the connector index
    expect(capture.stats.pluginDataChangesDropped).toBe(1); // dropped, never silently
  });

  it('counts every drop across batches — a filtered change still happened', () => {
    const { capture } = harness();
    const noise = { documentChanges: [change(ROOT_DOCUMENT, 'PROPERTY_CHANGE', ['pluginData'])] } as any;

    capture.onDocumentChange(noise);
    capture.onDocumentChange(noise);

    expect(capture.stats.pluginDataChangesDropped).toBe(2);
  });

  it('drops only the noise inside a MIXED batch — the designer edit beside it still lands', () => {
    const { capture, log } = harness();

    capture.onDocumentChange({
      documentChanges: [
        change(ROOT_DOCUMENT, 'PROPERTY_CHANGE', ['pluginData']),
        change(text('t1'), 'PROPERTY_CHANGE', ['characters']),
      ],
    } as any);

    expect(capture.stats.pluginDataChangesDropped).toBe(1);
    expect(feed(log)[0]?.data.edits.map((e: any) => e.nodeId)).toEqual(['t1']);
    expect(log.idleArmed).toBe(1);
  });
});

describe('real designer edits are untouched by the filter', () => {
  it('a PAGE rename lands in the feed, on its own page, and arms idle', () => {
    const { capture, log } = harness();

    capture.onDocumentChange({ documentChanges: [change(PAGE, 'PROPERTY_CHANGE', ['name'])] } as any);

    const edits = feed(log)[0]?.data.edits;
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ nodeId: 'p1', nodeType: 'PAGE', page: 'Page 1', changedProps: ['name'] });
    expect(capture.stats.pluginDataChangesDropped).toBe(0);
    expect(log.idleArmed).toBe(1);
  });

  it('a MIXED property list (name + pluginData) lands whole — it carries a real edit too', () => {
    const { capture, log } = harness();

    capture.onDocumentChange({
      documentChanges: [change(FRAME, 'PROPERTY_CHANGE', ['name', 'pluginData'])],
    } as any);

    expect(feed(log)[0]?.data.edits[0]).toMatchObject({ nodeId: 'f1', changedProps: ['name', 'pluginData'] });
    expect(capture.stats.pluginDataChangesDropped).toBe(0);
  });

  it('an ordinary edit still reaches every consumer: correction store, connector index, feed, idle', () => {
    const { capture, log } = harness();

    capture.onDocumentChange({ documentChanges: [change(text('t7'), 'PROPERTY_CHANGE', ['fills'])] } as any);

    expect(log.corrections).toEqual(['t7']);
    expect(log.connector).toEqual([['t7']]);
    expect(feed(log)[0]?.data.edits[0]).toMatchObject({
      nodeId: 't7', nodeType: 'TEXT', parentName: 'Card', page: 'Page 1', op: 'updated',
    });
    expect(log.idleArmed).toBe(1);
  });

  it('files a deeply nested node under ITS page, never the page the designer is looking at', () => {
    const { capture, log } = harness();

    capture.onDocumentChange({
      documentChanges: [change(deepUnderPage(26, 'Components'), 'PROPERTY_CHANGE', ['characters'])],
    } as any);

    expect(feed(log)[0]?.data.edits[0]).toMatchObject({ nodeId: 'deep-text', page: 'Components' });
    expect(capture.stats.pageFallbacks).toBe(0); // resolved outright — nothing was substituted
  });

  it('counts the current-page substitution when a live node has no page at all', () => {
    const { capture, log } = harness();
    const orphan: FakeNode = { id: 'orph', name: 'Detached', type: 'FRAME', parent: null };

    capture.onDocumentChange({ documentChanges: [change(orphan, 'PROPERTY_CHANGE', ['fills'])] } as any);

    expect(feed(log)[0]?.data.edits[0]).toMatchObject({ nodeId: 'orph', page: 'Cover' });
    expect(capture.stats.pageFallbacks).toBe(1); // a guessed page is never a silent one
  });

  it('a live node\'s OWN chain wins over what the identity cache remembers for it', () => {
    const { capture, log } = harness();
    const onPage1: FakeNode = { id: 'moved', name: 'Moved', type: 'TEXT', parent: FRAME };

    // First delivery remembers `page: 'Page 1'` in the identity cache.
    capture.onDocumentChange({ documentChanges: [change(onPage1, 'PROPERTY_CHANGE', ['fills'])] } as any);
    expect(feed(log)[0]?.data.edits[0]).toMatchObject({ page: 'Page 1' });

    // Second delivery: the SAME id, now reparented under a different page's chain. The
    // cache still says 'Page 1' from the delivery above — the node's own chain must win.
    const page2: FakeNode = { id: 'p2', name: 'Page 2', type: 'PAGE', parent: null };
    const frame2: FakeNode = { id: 'f2', name: 'Card 2', type: 'FRAME', parent: page2 };
    const onPage2: FakeNode = { id: 'moved', name: 'Moved', type: 'TEXT', parent: frame2 };
    capture.onDocumentChange({ documentChanges: [change(onPage2, 'PROPERTY_CHANGE', ['fills'])] } as any);

    expect(feed(log)[1]?.data.edits[0]).toMatchObject({ nodeId: 'moved', page: 'Page 2' });
    expect(capture.stats.pageFallbacks).toBe(0); // resolved outright via the chain — not a substitution
  });

  it('a component edit still posts DOC_CHANGE alongside the widened feed', () => {
    const { capture, log } = harness();
    const set: FakeNode = { id: 'cs1', name: 'Button', type: 'COMPONENT_SET', parent: PAGE };
    const variant: FakeNode = { id: 'c1', name: 'State=Default', type: 'COMPONENT', parent: set };

    capture.onDocumentChange({ documentChanges: [change(variant, 'PROPERTY_CHANGE', ['fills'])] } as any);

    const doc = log.posted.find((m) => m.type === 'DOC_CHANGE');
    expect(doc?.data.changes[0]).toMatchObject({ nodeId: 'cs1', nodeType: 'COMPONENT_SET', op: 'updated' });
    expect(log.componentChanges).toEqual([1]);
  });

  it('a STYLE_* change is filtered before any node dereference (its payload has no node)', () => {
    const { capture, log } = harness();

    capture.onDocumentChange({
      documentChanges: [{ type: 'STYLE_PROPERTY_CHANGE', style: {}, origin: 'LOCAL' }],
    } as any);

    expect(log.posted).toHaveLength(0);
    expect(log.idleArmed).toBe(0);
  });
});

describe('a DELETE\'s page fallback is a guess too, and is counted the same as a live one', () => {
  it('a DELETE of a node this session never saw guesses the current page and counts it', () => {
    const { capture, log } = harness();
    const gone: FakeNode = { id: 'gone', name: 'Ghost', type: 'TEXT', parent: null, removed: true };

    capture.onDocumentChange({ documentChanges: [change(gone, 'DELETE')] } as any);

    expect(feed(log)[0]?.data.edits[0]).toMatchObject({ nodeId: 'gone', page: 'Cover', nodeName: null });
    expect(capture.stats.pageFallbacks).toBe(1); // a guessed page on a delete is never silent either
  });

  it('a DELETE of a node this session already has in its identity cache uses the cached page, no guess', () => {
    const { capture, log } = harness();
    const seen: FakeNode = { id: 'seen', name: 'Seen', type: 'TEXT', parent: FRAME };

    // First delivery: a LIVE change remembers this node's page ('Page 1') in the cache.
    capture.onDocumentChange({ documentChanges: [change(seen, 'PROPERTY_CHANGE', ['fills'])] } as any);
    expect(capture.stats.pageFallbacks).toBe(0);

    // Second delivery: the SAME id, now delivered as a DELETE (RemovedNode: id + type only).
    const goneSeen: FakeNode = { id: 'seen', name: 'Seen', type: 'TEXT', parent: null, removed: true };
    capture.onDocumentChange({ documentChanges: [change(goneSeen, 'DELETE')] } as any);

    expect(feed(log)[1]?.data.edits[0]).toMatchObject({ nodeId: 'seen', page: 'Page 1' });
    expect(capture.stats.pageFallbacks).toBe(0); // the identity cache had it — no guess needed
  });
});

describe('a failing correction-store write never costs the batch its edits', () => {
  it('is counted, not thrown — the feed posts, idle arms, the write refusal is the first recorded error', () => {
    const { log } = harness();
    const capture = createDocumentChangeCapture<null>({
      now: () => 1_000,
      onBatchStart: () => {},
      actorState: idleActor,
      identity: createEditIdentityCache(),
      corrections: {
        begin: () => null,
        record: () => {},
        // Figma refuses a `sharedPluginData` write on a file the user cannot edit, and
        // throws on the per-entry byte cap. The edits in this batch are the design facts;
        // the correction store is bookkeeping about them, and its own failure must not
        // take the feed, the idle timer, or the handler's caller down with it.
        flush: () => { throw new Error('setSharedPluginData refused'); },
      },
      noteChangedNodes: () => {},
      post: (message) => log.posted.push(message as { type: string; data: any }),
      noteComponentChanges: () => {},
      noteEdits: () => { log.edits += 1; },
      armIdle: () => { log.idleArmed += 1; },
    });

    expect(() => capture.onDocumentChange({
      documentChanges: [change(text('t1'), 'PROPERTY_CHANGE', ['fills'])],
    } as any)).not.toThrow();

    expect(feed(log)[0]?.data.edits[0]).toMatchObject({ nodeId: 't1' });
    expect(log.idleArmed).toBe(1);
    // The batch's own corrections are lost with the throw (there is no scoped copy to
    // retry with — the next batch reads the document afresh), but the refusal itself is
    // never silent: it is the first counted capture error, verbatim.
    expect(capture.stats.errorCount).toBe(1);
    expect(capture.stats.firstError).toBe('setSharedPluginData refused');
  });
});

describe('a correction-store READ that throws never costs the batch its edits', () => {
  /** A `figma.root` that refuses every read. Figma throws on `getSharedPluginData` under
   *  the same conditions its comment already documents for writes (a file the user cannot
   *  edit, the per-entry byte cap), and the read happens INSIDE the per-node loop — before
   *  any post — so an uncaught one takes the whole delivered batch down with it, including
   *  the edits already processed before the throw. */
  function refusingFigma(message: string): void {
    (globalThis as any).figma = {
      fileKey: 'test-file-key',
      currentPage: { name: 'Cover' },
      root: {
        name: 'Test File',
        getSharedPluginData: () => { throw new Error(message); },
        setSharedPluginData: () => { throw new Error(message); },
      },
    };
  }

  it('still posts every edit, arms idle, and records the refusal as a counted error', () => {
    refusingFigma('getSharedPluginData refused');
    const log: Log = {
      posted: [], corrections: [], begins: 0, flushes: 0,
      connector: [], componentChanges: [], edits: 0, idleArmed: 0,
    };
    const capture = createDocumentChangeCapture<CorrectionBatch>({
      now: () => Date.now(),
      onBatchStart: () => {},
      actorState: idleActor,
      identity: createEditIdentityCache(),
      corrections: {
        begin: beginCorrectionBatch,
        record: recordDesignerCorrectionInBatch,
        flush: flushCorrectionBatch,
      },
      noteChangedNodes: () => {},
      post: (message) => log.posted.push(message as { type: string; data: any }),
      noteComponentChanges: () => {},
      noteEdits: () => { log.edits += 1; },
      armIdle: () => { log.idleArmed += 1; },
    });

    expect(() => capture.onDocumentChange({
      documentChanges: [
        change(text('t1'), 'PROPERTY_CHANGE', ['fills']),
        change(text('t2'), 'PROPERTY_CHANGE', ['fills']),
        change(text('t3'), 'PROPERTY_CHANGE', ['fills']),
      ],
    } as any)).not.toThrow();

    // Every edit in the batch — including the ones after the change that hit the refusal.
    expect(feed(log)[0]?.data.edits.map((e: any) => e.nodeId)).toEqual(['t1', 't2', 't3']);
    expect(log.idleArmed).toBe(1);
    // Correction bookkeeping is skipped for the batch, and says so: one error for the batch
    // (not one per node), first message verbatim.
    expect(capture.stats.errorCount).toBe(1);
    expect(capture.stats.firstError).toBe('getSharedPluginData refused');
  });
});

describe('the correction store is read ONCE per batch and written at most once', () => {
  /** The real store wiring, exactly as main.ts builds it. */
  function storeBackedHarness() {
    const capture = createDocumentChangeCapture<CorrectionBatch>({
      now: () => Date.now(),
      onBatchStart: () => {},
      actorState: idleActor,
      identity: createEditIdentityCache(),
      corrections: {
        begin: beginCorrectionBatch,
        record: recordDesignerCorrectionInBatch,
        flush: flushCorrectionBatch,
      },
      noteChangedNodes: () => {},
      post: () => {},
      noteComponentChanges: () => {},
      noteEdits: () => {},
      armIdle: () => {},
    });
    return capture;
  }

  const batchOf = (count: number) => ({
    documentChanges: Array.from({ length: count }, (_, i) => change(text(`n${i}`), 'PROPERTY_CHANGE', ['fills'])),
  }) as any;

  it('a 200-change batch touches sharedPluginData a fixed number of times, not once per node', () => {
    const { counts } = countingFigma();
    const capture = storeBackedHarness();

    capture.onDocumentChange(batchOf(200));

    // One read of the store for the whole batch (its manifest + its one chunk). No
    // correction can land — no node here has an agent-operation parent — so nothing is
    // written at all.
    expect(counts.get).toBe(2);
    expect(counts.set).toBe(0);
  });

  it('a batch that DOES produce a correction writes the store exactly once', () => {
    vi.useFakeTimers();
    try {
      const { counts } = countingFigma();
      const capture = storeBackedHarness();
      // An agent operation on n7 gives the batch's correction a causal parent to attach to.
      recordAgentMutationBatch(['n7'], { command: 'SET_TEXT' });
      vi.advanceTimersByTime(2_001); // past the trailing agent-echo suppression window
      counts.get = 0;
      counts.set = 0;

      capture.onDocumentChange(batchOf(200));

      // One write = the chunk plus its manifest, for the whole batch — never one per node.
      expect(counts.set).toBe(2);
      // Reads: the batch's own single read, plus the write's manifest + legacy-key checks.
      expect(counts.get).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('each batch reads the document afresh — no parse outlives the batch that made it', () => {
    vi.useFakeTimers();
    try {
      const { counts } = countingFigma();
      const capture = storeBackedHarness();
      recordAgentMutationBatch(['n7'], { command: 'SET_TEXT' });
      vi.advanceTimersByTime(2_001);

      capture.onDocumentChange(batchOf(10)); // writes one correction
      counts.get = 0;
      capture.onDocumentChange(batchOf(10)); // must see that write, not a copy parsed before it

      // 2 for the second batch's own fresh read (manifest + chunk), 2 more for the write
      // it then makes (its manifest + legacy-key checks). Anything less would mean a parse
      // had outlived its batch — and would be flushed back over whatever a second Figma tab
      // appended in the meantime.
      expect(counts.get).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });
});
