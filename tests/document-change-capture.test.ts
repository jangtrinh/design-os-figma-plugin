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
import {
  registerSentinel, resetSentinelRegistryForTest,
} from '../plugin/src/main/undo-sentinel-registry.ts';
import { INTENT_PROPS, INTENT_TEXT_CAP, INTENT_ANNOTATION_CAP } from '../shared/edit-intent.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface FakeNode {
  id: string; name: string; type: string; parent: FakeNode | null; removed?: boolean;
  description?: string; descriptionMarkdown?: string; annotations?: unknown[];
}

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
    currentPage: { id: 'p-cover', name: 'Cover' },
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
  dirtyPages: string[];
  idleArmed: number;
}

function harness() {
  const log: Log = {
    posted: [], corrections: [], begins: 0, flushes: 0,
    connector: [], componentChanges: [], dirtyPages: [], idleArmed: 0,
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
    notePageDirty: (pageId) => log.dirtyPages.push(pageId),
    armIdle: () => { log.idleArmed += 1; },
  });
  return { capture, log };
}

const feed = (log: Log) => log.posted.filter((m) => m.type === 'EDIT_FEED');

beforeEach(() => {
  countingFigma();
  resetSentinelRegistryForTest();
});

describe('the undo sentinel\'s own lifecycle never enters the edit feed', () => {
  const SENTINEL_FRAME: FakeNode = { id: 'sentinel-1', name: '[figma-agent] undo sentinel', type: 'FRAME', parent: PAGE };

  it('a registered sentinel\'s CREATE+DELETE+PROPERTY_CHANGE post NOTHING for it, while another node in the same batch still lands', () => {
    registerSentinel('sentinel-1');
    const { capture, log } = harness();
    const removedSentinel: FakeNode = { ...SENTINEL_FRAME, parent: null, removed: true };

    capture.onDocumentChange({
      documentChanges: [
        change(SENTINEL_FRAME, 'CREATE'),
        change(SENTINEL_FRAME, 'PROPERTY_CHANGE', ['name']),
        change(removedSentinel, 'DELETE'),
        change(text('t1'), 'PROPERTY_CHANGE', ['characters']),
      ],
    } as any);

    const edits = feed(log)[0]?.data.edits ?? [];
    expect(edits.map((e: any) => e.nodeId)).toEqual(['t1']); // the sentinel never rides along
    expect(capture.stats.sentinelChangesDropped).toBe(3); // every raw change dropped, counted
    expect(log.idleArmed).toBe(1); // still armed — by the OTHER node's real edit
  });

  it('sentinelChangesDropped counts every raw change dropped, across a batch with only sentinel noise', () => {
    registerSentinel('sentinel-1');
    const { capture, log } = harness();
    const removedSentinel: FakeNode = { ...SENTINEL_FRAME, parent: null, removed: true };

    capture.onDocumentChange({
      documentChanges: [change(SENTINEL_FRAME, 'CREATE'), change(removedSentinel, 'DELETE')],
    } as any);

    expect(capture.stats.sentinelChangesDropped).toBe(2);
    expect(log.posted).toHaveLength(0); // nothing at all — the batch was pure sentinel noise
    expect(log.idleArmed).toBe(0);
  });

  it('an UNREGISTERED frame merely named like the sentinel is NOT dropped — name is not identity', () => {
    const { capture, log } = harness();
    const lookalike: FakeNode = { id: 'not-a-sentinel', name: '[figma-agent] undo sentinel', type: 'FRAME', parent: PAGE };

    capture.onDocumentChange({ documentChanges: [change(lookalike, 'CREATE')] } as any);

    expect(feed(log)[0]?.data.edits[0]).toMatchObject({ nodeId: 'not-a-sentinel', op: 'created' });
    expect(capture.stats.sentinelChangesDropped).toBe(0);
  });

  it('the correction store and connector index never see a registered sentinel\'s changes', () => {
    registerSentinel('sentinel-1');
    const { capture, log } = harness();

    capture.onDocumentChange({
      documentChanges: [change(SENTINEL_FRAME, 'PROPERTY_CHANGE', ['name'])],
    } as any);

    expect(log.corrections).toEqual([]);
    expect(log.connector).toEqual([]);
    expect(capture.stats.sentinelChangesDropped).toBe(1);
  });
});

describe('the plugin\'s own bookkeeping write never becomes an owner edit', () => {
  it('a root pluginData change enters nothing, arms nothing, and is COUNTED', () => {
    const { capture, log } = harness();

    capture.onDocumentChange({
      documentChanges: [change(ROOT_DOCUMENT, 'PROPERTY_CHANGE', ['pluginData'])],
    } as any);

    expect(feed(log)).toHaveLength(0);      // not in the edit feed
    expect(log.idleArmed).toBe(0);          // the idle timer is not re-armed by our own write
    expect(log.dirtyPages).toEqual([]);     // no page is marked dirty for the idle re-walk
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

  // Which frame carries EVERY batch matters outside this file: the broker counts a REPLAYED
  // capture batch once, on one of the two frames a batch travels as. DOC_CHANGE is
  // component-scoped (`raw` is pushed only when `resolveComponentIdentity` resolves), while
  // the widened `edits` push is unconditional — so EDIT_FEED is the superset and a
  // DOC_CHANGE never travels without one.
  it('a plain node edit posts EDIT_FEED and NO DOC_CHANGE — DOC_CHANGE is component-scoped', () => {
    const { capture, log } = harness();

    capture.onDocumentChange({ documentChanges: [change(text('t1'), 'PROPERTY_CHANGE', ['characters'])] } as any);

    expect(feed(log)).toHaveLength(1);
    expect(log.posted.filter((m) => m.type === 'DOC_CHANGE')).toHaveLength(0);
  });

  it('a component edit posts BOTH frames — a DOC_CHANGE batch always has an EDIT_FEED beside it', () => {
    const { capture, log } = harness();
    const set: FakeNode = { id: 'cs2', name: 'Chip', type: 'COMPONENT_SET', parent: PAGE };
    const variant: FakeNode = { id: 'c2', name: 'State=Hover', type: 'COMPONENT', parent: set };

    capture.onDocumentChange({ documentChanges: [change(variant, 'PROPERTY_CHANGE', ['fills'])] } as any);

    expect(log.posted.map((m) => m.type).sort()).toEqual(['DOC_CHANGE', 'EDIT_FEED']);
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
      notePageDirty: (pageId) => log.dirtyPages.push(pageId),
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
      currentPage: { id: 'p-cover', name: 'Cover' },
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
      connector: [], componentChanges: [], dirtyPages: [], idleArmed: 0,
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
      notePageDirty: (pageId) => log.dirtyPages.push(pageId),
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
      notePageDirty: () => {},
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

describe('the idle re-walk is told WHICH pages changed', () => {
  it('an edit marks its own page — not the page the designer happens to be looking at', () => {
    const { capture, log } = harness();

    capture.onDocumentChange({
      documentChanges: [change(deepUnderPage(6, 'Specs'), 'PROPERTY_CHANGE', ['x'])],
    } as any);

    expect(log.dirtyPages).toEqual(['p-deep']);
    expect(feed(log)[0]!.data.edits[0].page).toBe('Specs'); // the same resolution, one walk
  });

  it('two edits on two pages mark both', () => {
    const { capture, log } = harness();

    capture.onDocumentChange({
      documentChanges: [
        change(text('t1'), 'PROPERTY_CHANGE', ['characters']),
        change(deepUnderPage(2, 'Specs'), 'PROPERTY_CHANGE', ['x']),
      ],
    } as any);

    expect(new Set(log.dirtyPages)).toEqual(new Set(['p1', 'p-deep']));
  });

  it('a DELETE marks the page the identity cache remembers the node on', () => {
    const { capture, log } = harness();
    const doomed = text('t9');

    capture.onDocumentChange({ documentChanges: [change(doomed, 'PROPERTY_CHANGE', ['x'])] } as any);
    capture.onDocumentChange({
      documentChanges: [change({ ...doomed, removed: true }, 'DELETE')],
    } as any);

    expect(log.dirtyPages).toEqual(['p1', 'p1']); // the delete lands on the node's OWN page
    expect(capture.stats.pageFallbacks).toBe(0);
  });

  it('a node with no resolvable page falls back to the current page — the SAME guess the feed makes, counted once', () => {
    const { capture, log } = harness();
    const orphan: FakeNode = { id: 'x1', name: 'Orphan', type: 'TEXT', parent: null };

    capture.onDocumentChange({ documentChanges: [change(orphan, 'PROPERTY_CHANGE', ['x'])] } as any);

    expect(log.dirtyPages).toEqual(['p-cover']);
    expect(feed(log)[0]!.data.edits[0].page).toBe('Cover');
    expect(capture.stats.pageFallbacks).toBe(1); // one guess, one counter — not two
  });
});

// Designer intent — the words behind an edit. Figma names the property that changed
// (`description`, `annotations`) but never the new value, and the value is unreadable once
// the moment has passed: `figma.changes` has no history for it and REST answers
// `description: ""` at every version. So the value is read HERE, at capture time, or not
// at all. A refusal is reported as one; it never reads as "the designer cleared it".
describe('designer intent rides along with the property name', () => {
  const component = (over: Partial<FakeNode> = {}): FakeNode => ({
    id: 'c1', name: 'Button / Primary', type: 'COMPONENT', parent: FRAME, ...over,
  });

  const intentOf = (log: Log) => feed(log)[0]?.data.edits[0]?.intent;

  it('a description change carries the new words, and both forms of them', () => {
    const { capture, log } = harness();
    const node = component({ description: 'The primary action', descriptionMarkdown: '**The primary action**' });

    capture.onDocumentChange({ documentChanges: [change(node, 'PROPERTY_CHANGE', ['description'])] } as any);

    expect(feed(log)[0]?.data.edits[0]).toMatchObject({ nodeId: 'c1', changedProps: ['description'] });
    expect(intentOf(log)).toEqual({
      description: 'The primary action', descriptionMarkdown: '**The primary action**',
    });
  });

  it('an annotation change carries the annotations themselves', () => {
    const { capture, log } = harness();
    const node = component({ annotations: [{ label: 'Announce on focus', categoryId: 'a11y' }] });

    capture.onDocumentChange({ documentChanges: [change(node, 'PROPERTY_CHANGE', ['annotations'])] } as any);

    expect(intentOf(log)).toEqual({ annotations: [{ label: 'Announce on focus', categoryId: 'a11y' }] });
  });

  it('a cleared annotation list is a VALUE, not a missing read', () => {
    const { capture, log } = harness();

    capture.onDocumentChange({
      documentChanges: [change(component({ annotations: [] }), 'PROPERTY_CHANGE', ['annotations'])],
    } as any);

    expect(intentOf(log)).toEqual({ annotations: [] });
  });

  it('caps a long description and says it was cut', () => {
    const { capture, log } = harness();
    const node = component({ description: 'x'.repeat(INTENT_TEXT_CAP + 42) });

    capture.onDocumentChange({ documentChanges: [change(node, 'PROPERTY_CHANGE', ['description'])] } as any);

    expect(intentOf(log).description).toHaveLength(INTENT_TEXT_CAP);
    expect(intentOf(log).intentTruncated).toBe(true);
  });

  it('caps a long annotation list and keeps the real count', () => {
    const { capture, log } = harness();
    const many = Array.from({ length: INTENT_ANNOTATION_CAP + 5 }, (_, i) => ({ label: `note ${i}` }));

    capture.onDocumentChange({
      documentChanges: [change(component({ annotations: many }), 'PROPERTY_CHANGE', ['annotations'])],
    } as any);

    expect(intentOf(log).annotations).toHaveLength(INTENT_ANNOTATION_CAP);
    expect(intentOf(log).annotationsTotal).toBe(INTENT_ANNOTATION_CAP + 5);
  });

  // Figma's own getters refuse: a dynamic-page file throws on a getter for a node whose
  // page is not loaded, and an invalidated reference throws on everything. The property
  // NAME is still a fact the event carried; the value is not.
  it('a refused read reports the refusal and keeps the property name', () => {
    const { capture, log } = harness();
    const node = component();
    Object.defineProperty(node, 'description', {
      get() { throw new Error('Cannot read description: node is not loaded'); },
    });

    capture.onDocumentChange({ documentChanges: [change(node, 'PROPERTY_CHANGE', ['description'])] } as any);

    expect(feed(log)[0]?.data.edits[0].changedProps).toEqual(['description']);
    expect(intentOf(log)).toEqual({ intentReadError: 'description: Cannot read description: node is not loaded' });
    expect(intentOf(log).description).toBeUndefined();
  });

  it('a refused annotation read is reported the same way, and never crashes the batch', () => {
    const { capture, log } = harness();
    const node = component();
    Object.defineProperty(node, 'annotations', {
      get() { throw new Error('Cannot read annotations of a removed node'); },
    });

    capture.onDocumentChange({
      documentChanges: [
        change(node, 'PROPERTY_CHANGE', ['annotations']),
        change(text('t9'), 'PROPERTY_CHANGE', ['x']),
      ],
    } as any);

    const edits = feed(log)[0]?.data.edits;
    expect(edits).toHaveLength(2); // the rest of the batch survives the refusal
    expect(edits.find((e: any) => e.nodeId === 'c1').intent)
      .toEqual({ intentReadError: 'annotations: Cannot read annotations of a removed node' });
  });

  it('an ordinary edit gains no intent key at all', () => {
    const { capture, log } = harness();

    capture.onDocumentChange({ documentChanges: [change(text('t1'), 'PROPERTY_CHANGE', ['x'])] } as any);

    expect(feed(log)[0]?.data.edits[0]).not.toHaveProperty('intent');
  });

  it('a node with the property named but nothing readable on it says nothing', () => {
    const { capture, log } = harness();

    capture.onDocumentChange({
      documentChanges: [change(text('t1'), 'PROPERTY_CHANGE', ['description'])] } as any);

    expect(feed(log)[0]?.data.edits[0]).not.toHaveProperty('intent');
  });

  // Drift guard: the capture path must read EVERY prop the closed list names, or the feed
  // would list a property whose value nothing ever went and got.
  it('every prop in the closed trigger list is read by the capture pass', () => {
    for (const prop of INTENT_PROPS) {
      const { capture, log } = harness();
      const node = component({ description: 'words', annotations: [{ label: 'note' }] });

      capture.onDocumentChange({ documentChanges: [change(node, 'PROPERTY_CHANGE', [prop])] } as any);

      expect(feed(log)[0]?.data.edits[0].intent, `no intent read for "${prop}"`).toBeDefined();
    }
  });

  // A CLEARED description is a successful read of an empty string, and it must not look
  // like a refused read: the first says "the designer deleted these words", the second says
  // "nobody knows". They are different facts and they reach the wire differently.
  it('a cleared description is a VALUE, distinct from an unreadable one', () => {
    const { capture, log } = harness();

    capture.onDocumentChange({
      documentChanges: [change(component({ description: '', descriptionMarkdown: '' }), 'PROPERTY_CHANGE', ['description'])],
    } as any);

    expect(intentOf(log)).toEqual({ description: '' });
  });

  it('an empty description with markdown that still says something keeps both', () => {
    const { capture, log } = harness();
    const node = component({ description: '', descriptionMarkdown: '**still here**' });

    capture.onDocumentChange({ documentChanges: [change(node, 'PROPERTY_CHANGE', ['description'])] } as any);

    expect(intentOf(log)).toEqual({ description: '', descriptionMarkdown: '**still here**' });
  });

  // One refusing getter must not take a value that WAS read down with it.
  it('a refused markdown read keeps the description that succeeded', () => {
    const { capture, log } = harness();
    const node = component({ description: 'The primary action' });
    Object.defineProperty(node, 'descriptionMarkdown', {
      get() { throw new Error('not loaded'); },
    });

    capture.onDocumentChange({ documentChanges: [change(node, 'PROPERTY_CHANGE', ['description'])] } as any);

    expect(intentOf(log)).toEqual({
      description: 'The primary action', intentReadError: 'descriptionMarkdown: not loaded',
    });
  });

  it('caps the prose inside an annotation, not just how many there are', () => {
    const { capture, log } = harness();
    const node = component({ annotations: [{ label: 'x'.repeat(50_000), labelMarkdown: 'y'.repeat(50_000) }] });

    capture.onDocumentChange({ documentChanges: [change(node, 'PROPERTY_CHANGE', ['annotations'])] } as any);

    expect(intentOf(log).annotations[0].label).toHaveLength(INTENT_TEXT_CAP);
    expect(intentOf(log).intentTruncated).toBe(true);
    expect(JSON.stringify(feed(log)[0]?.data.edits[0]).length).toBeLessThan(4_800);
  });

  // "Cleared the annotations" is a claim about a node that CAN hold them. A TEXT node with
  // no annotations field never held any, so the honest answer is no answer.
  it('a node type with no annotations field gains no annotations key', () => {
    const { capture, log } = harness();

    capture.onDocumentChange({
      documentChanges: [change(text('t2'), 'PROPERTY_CHANGE', ['annotations'])] } as any);

    expect(feed(log)[0]?.data.edits[0]).not.toHaveProperty('intent');
  });

  // The cap is a bound on WORK as well as on bytes: a node with 500 annotations must not
  // pay to shape 500 records so that 480 can be thrown away. The list is cut first, and the
  // real count still travels with it.
  it('shapes only the annotations it keeps, and still reports the real total', () => {
    const { capture, log } = harness();
    let shapedBeyondTheCap = 0;
    const many = Array.from({ length: INTENT_ANNOTATION_CAP + 5 }, (_, i) => {
      if (i < INTENT_ANNOTATION_CAP) return { label: `note ${i}` };
      // Past the cap: reading this entry's label at all means it was shaped anyway.
      return { get label() { shapedBeyondTheCap += 1; return `note ${i}`; } };
    });

    capture.onDocumentChange({
      documentChanges: [change(component({ annotations: many }), 'PROPERTY_CHANGE', ['annotations'])],
    } as any);

    expect(shapedBeyondTheCap).toBe(0);
    expect(intentOf(log).annotations).toHaveLength(INTENT_ANNOTATION_CAP);
    expect(intentOf(log).annotationsTotal).toBe(INTENT_ANNOTATION_CAP + 5);
  });

  it('a deleted node carries no intent — a RemovedNode has nothing left to read', () => {
    const { capture, log } = harness();
    const node = component({ removed: true, description: 'stale' });

    capture.onDocumentChange({ documentChanges: [change(node, 'PROPERTY_CHANGE', ['description'])] } as any);

    expect(feed(log)[0]?.data.edits[0]).not.toHaveProperty('intent');
  });
});
