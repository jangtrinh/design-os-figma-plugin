// Reconnect gap-fill, store-backed halves: the boot diff, the baseline write, the storage
// quota refusal, and the one-time legacy in-document cleanup.
//
// These used to be "untestable outside a live sandbox". They are not: the only real figma
// dependencies are a key/value store (now injected) and a page walk (now a fake page whose
// `children` are a fixture tree). What the live sandbox alone can still prove is the
// canvas walk itself — everything else is exercised here, including the refusal path that
// a permissive mock would have hidden.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearLegacyGapfillDocumentData, nodeStillExists, runGapfillDiff, snapshotPageBounded, writeBaseline,
  SNAPSHOT_NODE_CAP_PER_PAGE, SNAPSHOT_SLICE_BUDGET_MS, SNAPSHOT_SLICE_SIZE,
} from '../plugin/src/main/edit-gapfill.ts';
import type { NodeSnapshot } from '../plugin/src/main/page-walk-bounded.ts';
import { createPerfStats, markBootComplete, toPerfStatus } from '../plugin/src/main/perf-stats.ts';
import {
  BASELINE_KEY_PREFIX, baselineKeyFor, createMemoryBaselineStore, legacyBaselineKeyFor,
  type FileBaseline,
} from '../plugin/src/main/gapfill-baseline-store.ts';
import { createGapfillStats, toGapfillStatus } from '../plugin/src/main/gapfill-status.ts';
import { buildPluginCoverage } from '../plugin/src/main/session-coverage.ts';

interface FakeNode {
  id: string; name: string; type: string; x: number; y: number;
  width: number; height: number; children: FakeNode[];
}

function fakeNode(id: string, over: Partial<FakeNode> = {}): FakeNode {
  return { id, name: `Node ${id}`, type: 'FRAME', x: 0, y: 0, width: 10, height: 10, children: [], ...over };
}

/** A `PageNode`-shaped stub. The walk reads `children` and descends it itself — the page
 *  no longer hands over a pre-materialised `findAll` array, which is the whole point:
 *  the node cap now bounds the WORK, not just what is kept. */
function fakePage(id: string, name: string, nodes: FakeNode[]): PageNode {
  return { id, name, type: 'PAGE', children: nodes } as unknown as PageNode;
}

interface DocData { [key: string]: string }

function installFigma(opts: { pages?: PageNode[]; fileKey?: string | null; fileName?: string; doc?: DocData } = {}): DocData {
  const doc: DocData = opts.doc ?? {};
  const root = {
    name: opts.fileName ?? 'Test File',
    children: opts.pages ?? [],
    getSharedPluginData: (_ns: string, key: string) => doc[key] ?? '',
    setSharedPluginData: (_ns: string, key: string, value: string) => {
      if (value === '') delete doc[key];
      else doc[key] = value;
    },
    getSharedPluginDataKeys: () => Object.keys(doc),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).figma = {
    root,
    currentPage: { name: (opts.pages ?? [])[0]?.name ?? 'Page 1' },
    currentUser: { name: 'Owner' },
    fileKey: opts.fileKey === undefined ? 'FILEKEY1' : opts.fileKey,
  };
  return doc;
}

function storedBaseline(store: ReturnType<typeof createMemoryBaselineStore>, key: string): FileBaseline {
  return store.map.get(key) as FileBaseline;
}

beforeEach(() => { installFigma(); });

describe('baselineKeyFor — one key per file, fileKey first', () => {
  it('uses the raw fileKey when the host exposes one', () => {
    expect(baselineKeyFor('ABC123', 'VSF - PCP')).toBe(`${BASELINE_KEY_PREFIX}ABC123`);
  });

  it('falls back to a slug of the file NAME on a file with no key (Figma Free)', () => {
    expect(baselineKeyFor(null, 'VSF - PCP')).toBe(`${BASELINE_KEY_PREFIX}vsf-pcp`);
  });

  it('a nameless, keyless file still gets a stable key rather than an empty one', () => {
    expect(baselineKeyFor(null, null)).toBe(`${BASELINE_KEY_PREFIX}unknown`);
    expect(baselineKeyFor('', '')).toBe(`${BASELINE_KEY_PREFIX}unknown`);
  });
});

describe('runGapfillDiff — no baseline at all', () => {
  it('emits EXACTLY ONE baseline-missing notice and no per-node created/deleted frames', async () => {
    const pages = [fakePage('p1', 'Screens', [fakeNode('a'), fakeNode('b')]), fakePage('p2', 'Specs', [fakeNode('c')])];
    installFigma({ pages });
    const store = createMemoryBaselineStore();
    const stats = createGapfillStats();

    const edits = await runGapfillDiff(pages, store, stats);

    expect(edits).toHaveLength(1);
    expect(edits[0]!.changedProps).toEqual(['baseline-missing']);
    expect(edits.filter((e) => e.op === 'created')).toEqual([]);
    expect(edits.filter((e) => e.op === 'deleted')).toEqual([]);
  });

  it('still writes a baseline, so the NEXT session has something to diff against', async () => {
    const pages = [fakePage('p1', 'Screens', [fakeNode('a')])];
    installFigma({ pages });
    const store = createMemoryBaselineStore();
    const stats = createGapfillStats();

    await runGapfillDiff(pages, store, stats);

    const key = baselineKeyFor('FILEKEY1', 'Test File');
    expect(store.map.has(key)).toBe(true);
    expect(storedBaseline(store, key).writtenBy).toBe('Owner');
    expect(stats.baselineWrittenAt).toBe(storedBaseline(store, key).writtenAt);
    expect(stats.baselineBytes).toBeGreaterThan(0);
  });

  it('marks the session a FIRST RUN — a baseline now exists, but the window before it was never diffed', async () => {
    // The write below makes `baselineWrittenAt` non-null, which on its own reads exactly
    // like a healthy diffing session. The flag is what keeps the closed window before this
    // boot from disappearing into that.
    const pages = [fakePage('p1', 'Screens', [fakeNode('a')])];
    installFigma({ pages });
    const stats = createGapfillStats();

    await runGapfillDiff(pages, createMemoryBaselineStore(), stats);

    expect(stats.baselineFirstRun).toBe(true);
    expect(stats.baselineWrittenAt).not.toBeNull();
    expect(toGapfillStatus(stats).baselineFirstRun).toBe(true);
  });

  it('a session that DID diff a prior baseline is not a first run, and says nothing about one', async () => {
    const pages = [fakePage('p1', 'Screens', [fakeNode('a')])];
    installFigma({ pages });
    const store = createMemoryBaselineStore();
    await runGapfillDiff(pages, store, createGapfillStats()); // the first session

    const stats = createGapfillStats();
    await runGapfillDiff(pages, store, stats);

    expect(stats.baselineFirstRun).toBe(false);
    expect('baselineFirstRun' in toGapfillStatus(stats)).toBe(false);
  });

  it('an unparseable stored value is treated as MISSING, never as an empty baseline (which would fabricate a whole-file create storm)', async () => {
    const pages = [fakePage('p1', 'Screens', [fakeNode('a'), fakeNode('b')])];
    installFigma({ pages });
    const store = createMemoryBaselineStore();
    await store.set(baselineKeyFor('FILEKEY1', 'Test File'), { junk: true });

    const edits = await runGapfillDiff(pages, store, createGapfillStats());

    expect(edits.map((e) => e.changedProps)).toEqual([['baseline-missing']]);
  });
});

describe('runGapfillDiff — a real baseline round-trip through the store', () => {
  it('finds a renamed node, a moved node, and a deleted node from the PREVIOUS session', async () => {
    const before = [fakeNode('keep'), fakeNode('rename'), fakeNode('move'), fakeNode('gone')];
    const pages1 = [fakePage('p1', 'Screens', before)];
    installFigma({ pages: pages1 });
    const store = createMemoryBaselineStore();
    await runGapfillDiff(pages1, store, createGapfillStats()); // writes the baseline

    const after = [
      fakeNode('keep'),
      fakeNode('rename', { name: 'Renamed' }),
      fakeNode('move', { x: 120, y: 40 }),
      fakeNode('fresh'),
    ];
    const pages2 = [fakePage('p1', 'Screens', after)];
    installFigma({ pages: pages2 });
    const stats = createGapfillStats();

    const edits = await runGapfillDiff(pages2, store, stats);

    const byId = new Map(edits.map((e) => [e.nodeId, e]));
    expect(byId.get('fresh')!.op).toBe('created');
    expect(byId.get('gone')!.op).toBe('deleted');
    expect(byId.get('rename')!.changedProps).toEqual(['name']);
    expect(byId.get('move')!.changedProps).toEqual(['x', 'y']);
    expect(byId.has('keep')).toBe(false); // an unchanged node is never a frame
    expect(edits.every((e) => e.page === 'Screens')).toBe(true);
    expect(stats.pagesDiffed).toBe(1);
    expect(stats.pagesTruncated).toBe(0);
  });

  it('a page present in the baseline but gone from the file is ONE notice naming the page, not N node deletions', async () => {
    const pages1 = [fakePage('p1', 'Screens', [fakeNode('a'), fakeNode('b')]), fakePage('p2', 'Archive', [fakeNode('c')])];
    installFigma({ pages: pages1 });
    const store = createMemoryBaselineStore();
    await runGapfillDiff(pages1, store, createGapfillStats());

    const pages2 = [fakePage('p1', 'Screens', [fakeNode('a'), fakeNode('b')])];
    installFigma({ pages: pages2 });

    const edits = await runGapfillDiff(pages2, store, createGapfillStats());

    expect(edits).toHaveLength(1);
    expect(edits[0]!.changedProps).toEqual(['page-deleted']);
    expect(edits[0]!.nodeName).toBe('Archive (1 node(s))');
  });
});

describe('writeBaseline — a truncated page stores no records', () => {
  function oversizedPage(): PageNode {
    const nodes = Array.from({ length: SNAPSHOT_NODE_CAP_PER_PAGE + 1 }, (_, i) => fakeNode(`n${i}`));
    return fakePage('big', 'Everything', nodes);
  }

  it('records are omitted for the truncated page and kept for the small one', async () => {
    const pages = [oversizedPage(), fakePage('small', 'Cover', [fakeNode('a')])];
    installFigma({ pages });
    const store = createMemoryBaselineStore();

    await writeBaseline(pages, snapshotPageBounded, store, createGapfillStats());

    const baseline = storedBaseline(store, baselineKeyFor('FILEKEY1', 'Test File'));
    const big = baseline.pages.find((p) => p.id === 'big')!;
    const small = baseline.pages.find((p) => p.id === 'small')!;
    expect(big.truncated).toBe(true);
    expect('records' in big).toBe(false);
    expect(small.records).toHaveLength(1);
  });

  it('the diff reports the truncated page as a notice and suppresses its created/deleted facts', async () => {
    const pages = [oversizedPage()];
    installFigma({ pages });
    const store = createMemoryBaselineStore();
    await writeBaseline(pages, snapshotPageBounded, store, createGapfillStats());

    const stats = createGapfillStats();
    const edits = await runGapfillDiff(pages, store, stats);

    expect(edits).toHaveLength(1);
    expect(edits[0]!.changedProps).toEqual(['truncated']);
    expect(stats.pagesTruncated).toBe(1);
    expect(toGapfillStatus(stats).pagesTruncated).toBe(1);
  });
});

describe('the truncation notice names the side that is actually over the cap', () => {
  const CAP = SNAPSHOT_NODE_CAP_PER_PAGE;

  /** The same page, over or under the cap — the only two inputs the notice direction
   *  depends on. `hero` stays top-level in both so the fingerprint is comparable. */
  function pageOfSize(over: boolean): PageNode {
    const bulk = over
      ? [fakeNode('bulk', { children: Array.from({ length: CAP + 1 }, (_, i) => fakeNode(`f${i}`)) })]
      : [];
    return fakePage('big', 'Everything', [fakeNode('hero', { name: 'Hero' }), ...bulk]);
  }

  async function seedPrevSession(over: boolean): Promise<ReturnType<typeof createMemoryBaselineStore>> {
    const pages = [pageOfSize(over)];
    installFigma({ pages });
    const store = createMemoryBaselineStore();
    await writeBaseline(pages, snapshotPageBounded, store, createGapfillStats());
    return store;
  }

  const cases = [
    { prev: false, next: false, notice: null, truncated: 0, topLevelOnly: 0 },
    { prev: false, next: true, notice: 'truncated', truncated: 1, topLevelOnly: 1 },
    { prev: true, next: true, notice: 'truncated', truncated: 1, topLevelOnly: 1 },
    // The page SHRANK back under the cap. Its per-node diff stays suppressed — the previous
    // session stored no records to diff against — but "while it exceeds the scan cap" is a
    // statement about a page that no longer does, and `pagesTruncated` would carry that
    // wrong fact into STATUS as well.
    { prev: true, next: false, notice: 'prev-truncated', truncated: 0, topLevelOnly: 1 },
  ] as const;

  for (const { prev, next, notice, truncated, topLevelOnly } of cases) {
    it(`previously ${prev ? 'over' : 'under'} the cap, now ${next ? 'over' : 'under'} it → ${notice ?? 'no notice'}`, async () => {
      const store = await seedPrevSession(prev);
      const pages = [pageOfSize(next)];
      installFigma({ pages });
      const stats = createGapfillStats();

      const edits = await runGapfillDiff(pages, store, stats);

      const notices = edits.filter((e) => e.nodeType === 'PAGE').map((e) => e.changedProps);
      expect(notices).toEqual(notice === null ? [] : [[notice]]);
      expect(stats.pagesTruncated).toBe(truncated);
      expect(stats.pagesTopLevelOnly).toBe(topLevelOnly);
    });
  }

  it('a page that shrank still reports no per-NODE facts — the previous side stored none', async () => {
    const store = await seedPrevSession(true);
    const pages = [pageOfSize(false)];
    installFigma({ pages });

    const edits = await runGapfillDiff(pages, store, createGapfillStats());

    // `hero` is unchanged and `bulk` is genuinely gone: the TOP-LEVEL diff still runs and
    // states that. What must never appear is a per-node fact about the thousands of nodes
    // under `bulk`, which this session has no previous records for.
    expect(edits.filter((e) => e.op === 'deleted').map((e) => e.nodeId)).toEqual(['bulk']);
    expect(edits.some((e) => e.nodeId.startsWith('f'))).toBe(false);
  });
});

describe('writeBaseline — the storage quota REFUSAL', () => {
  function otherFileBaseline(writtenAt: string): FileBaseline {
    return { writtenAt, writtenBy: 'Owner', pages: [{ id: 'x', name: 'X', truncated: false, top: [], records: [] }] };
  }

  it('a refusal evicts the OLDEST other file\'s baseline, retries once, and succeeds', async () => {
    const pages = [fakePage('p1', 'Screens', [fakeNode('a'), fakeNode('b'), fakeNode('c')])];
    installFigma({ pages });
    const oldKey = `${BASELINE_KEY_PREFIX}old-file`;
    const newKey = `${BASELINE_KEY_PREFIX}new-file`;
    const neighbour = otherFileBaseline('2020-01-01T00:00:00.000Z');

    // Measure this file's own baseline instead of guessing a byte budget, then cap the
    // store at "one neighbour + us": with BOTH neighbours resident the write must be
    // refused, and it must fit the moment one of them is evicted.
    const probe = createMemoryBaselineStore();
    await writeBaseline(pages, snapshotPageBounded, probe, createGapfillStats());
    const ourBytes = JSON.stringify(probe.map.get(baselineKeyFor('FILEKEY1', 'Test File'))).length;
    const quotaBytes = JSON.stringify(neighbour).length + ourBytes;

    const seeded = createMemoryBaselineStore({ quotaBytes });
    seeded.map.set(oldKey, neighbour);
    seeded.map.set(newKey, otherFileBaseline('2030-01-01T00:00:00.000Z'));
    const stats = createGapfillStats();

    await writeBaseline(pages, snapshotPageBounded, seeded, stats);

    expect(seeded.map.has(oldKey)).toBe(false); // the oldest went
    expect(seeded.map.has(newKey)).toBe(true); // the newer one stayed
    expect(seeded.map.has(baselineKeyFor('FILEKEY1', 'Test File'))).toBe(true);
    expect(stats.baselineWrittenAt).not.toBeNull();
    expect(stats.errorCount).toBe(0);
    // An eviction is a deletion of real data — it is never off the record.
    expect(toGapfillStatus(stats).baselineEvicted).toEqual([oldKey]);
  });

  it('a refusal that survives the eviction records the error, writes nothing, and does NOT throw', async () => {
    const pages = [fakePage('p1', 'Screens', [fakeNode('a'), fakeNode('b')])];
    installFigma({ pages });
    const store = createMemoryBaselineStore({ quotaBytes: 10 }); // nothing of ours ever fits
    await store.map.set(`${BASELINE_KEY_PREFIX}old-file`, otherFileBaseline('2020-01-01T00:00:00.000Z'));
    const stats = createGapfillStats();

    await expect(writeBaseline(pages, snapshotPageBounded, store, stats)).resolves.toBeUndefined();

    expect(store.map.has(baselineKeyFor('FILEKEY1', 'Test File'))).toBe(false);
    expect(stats.baselineWrittenAt).toBeNull(); // never claims a write that did not land
    expect(stats.errorCount).toBe(1);
    const status = toGapfillStatus(stats);
    expect(status.errors![0]).toContain('baseline write failed');
    expect(status.errorCount).toBe(1);
  });

  it('a refusal with NO other file to evict is reported as exactly that', async () => {
    const pages = [fakePage('p1', 'Screens', [fakeNode('a')])];
    installFigma({ pages });
    const store = createMemoryBaselineStore({ quotaBytes: 10 });
    const stats = createGapfillStats();

    await writeBaseline(pages, snapshotPageBounded, store, stats);

    expect(stats.firstError).toContain('no other baseline to evict');
    expect(toGapfillStatus(stats).baselineEvicted).toBeUndefined();
  });

  it('the boot diff still returns its edits when the baseline write is refused', async () => {
    const pages1 = [fakePage('p1', 'Screens', [fakeNode('a'), fakeNode('gone')])];
    installFigma({ pages: pages1 });
    const store = createMemoryBaselineStore();
    await runGapfillDiff(pages1, store, createGapfillStats());

    const pages2 = [fakePage('p1', 'Screens', [fakeNode('a')])];
    installFigma({ pages: pages2 });
    const refusing = createMemoryBaselineStore({ quotaBytes: 10 });
    for (const [k, v] of store.map) refusing.map.set(k, v); // seed past the cap
    const stats = createGapfillStats();

    const edits = await runGapfillDiff(pages2, refusing, stats);

    expect(edits.map((e) => e.nodeId)).toEqual(['gone']);
    expect(stats.errorCount).toBe(1); // the failure is visible, the diff still shipped
  });
});

describe('clearLegacyGapfillDocumentData — the pre-clientStorage document keys, once', () => {
  it('clears the manifest and its chunk keys, counts them, and leaves unrelated keys alone', () => {
    const doc = installFigma({
      doc: {
        'figma-edit-snapshot-v1': '{"v":1,"pages":[]}',
        'figma-edit-snap-p1-0': '[]',
        'figma-edit-snap-p1-1': '[]',
        'figma-corrections-v2-manifest': '{"v":2}',
      },
    });
    const stats = createGapfillStats();

    expect(clearLegacyGapfillDocumentData(stats)).toBe(3);
    expect(Object.keys(doc)).toEqual(['figma-corrections-v2-manifest']);
    expect(toGapfillStatus(stats).legacyCleared).toBe(3);
  });

  it('an already-clean file pays no document write at all', () => {
    const doc = installFigma({ doc: { 'figma-corrections-v2-manifest': '{"v":2}' } });
    const stats = createGapfillStats();

    expect(clearLegacyGapfillDocumentData(stats)).toBe(0);
    expect(Object.keys(doc)).toEqual(['figma-corrections-v2-manifest']);
    expect(toGapfillStatus(stats).legacyCleared).toBeUndefined();
  });

  it('a host that refuses the key enumeration records the failure instead of crashing boot', () => {
    installFigma({ doc: { 'figma-edit-snapshot-v1': '{"v":1,"pages":[]}' } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).figma.root.getSharedPluginDataKeys = () => { throw new Error('not supported'); };
    const stats = createGapfillStats();

    expect(clearLegacyGapfillDocumentData(stats)).toBe(0);
    expect(stats.firstError).toContain('legacy gap-fill cleanup failed');
  });

  it('a legacy manifest is never used AS a baseline — a boot with only legacy data reports baseline-missing', async () => {
    const pages = [fakePage('p1', 'Screens', [fakeNode('a'), fakeNode('b')])];
    installFigma({ pages, doc: { 'figma-edit-snapshot-v1': '{"v":1,"pages":[{"pageId":"p1","pageName":"Screens","chunks":0,"truncated":false}]}' } });
    const store = createMemoryBaselineStore();

    const edits = await runGapfillDiff(pages, store, createGapfillStats());

    expect(edits.map((e) => e.changedProps)).toEqual([['baseline-missing']]);
  });
});

describe('snapshotPageBounded — the walk that feeds every record', () => {
  it('normalizes coordinates and carries the parent id taken from the DFS stack', async () => {
    const page = fakePage('p1', 'Screens', [fakeNode('child', { x: 10.26, y: 3.1 })]);
    const { records, truncated } = await snapshotPageBounded(page);
    expect(truncated).toBe(false);
    expect(records).toEqual<NodeSnapshot[]>([
      { id: 'child', name: 'Node child', type: 'FRAME', x: 10.5, y: 3, parent: 'p1' },
    ]);
  });

  it('stores a top-level fingerprint for EVERY page, cap or no cap', async () => {
    const page = fakePage('p1', 'Screens', [fakeNode('a', { width: 320, height: 200, children: [fakeNode('a1')] })]);
    const { top } = await snapshotPageBounded(page);
    expect(top).toEqual([['a', 'Node a', 'FRAME', 0, 0, 320, 200, 1]]);
  });

  it('times the walk into perf, including the per-page loadAsync experiment', async () => {
    const page = fakePage('p1', 'Screens', [fakeNode('a')]);
    let loads = 0;
    (page as unknown as { loadAsync: () => Promise<void> }).loadAsync = async () => { loads += 1; };
    const perf = createPerfStats();

    await snapshotPageBounded(page, perf, 'boot');

    expect(loads).toBe(1); // the experiment ran, once, before the walk
    expect(perf.bootSlices).toBe(1);
    expect(perf.bootWalkMs).toBeGreaterThanOrEqual(0);
    expect(perf.pageLoadAsyncMaxMs).toBeGreaterThanOrEqual(0);
  });

  it('a page with no loadAsync (an older host) still walks', async () => {
    const perf = createPerfStats();
    const walk = await snapshotPageBounded(fakePage('p1', 'Screens', [fakeNode('a')]), perf, 'boot');
    expect(walk.records).toHaveLength(1);
  });
});

describe('runGapfillDiff — the baseline must belong to THIS file', () => {
  it('a baseline stamped by ANOTHER file sharing the same storage key is treated as missing, never diffed against', async () => {
    // Two keyless files whose names slug to the same key ('vsf-pcp'). The stored value is
    // PRESENT and belongs to someone else — the one case that fabricates a whole scene of
    // created/deleted facts if the value's own identity is never checked.
    const pagesA = [fakePage('pA', 'Screens', [fakeNode('a1'), fakeNode('a2')])];
    installFigma({ pages: pagesA, fileKey: null, fileName: 'VSF - PCP' });
    const store = createMemoryBaselineStore();
    await runGapfillDiff(pagesA, store, createGapfillStats());

    const key = baselineKeyFor(null, 'VSF - PCP');
    expect(baselineKeyFor(null, 'VSF / PCP')).toBe(key); // same key, different file
    const pagesB = [fakePage('pB', 'Cover', [fakeNode('b1')])];
    installFigma({ pages: pagesB, fileKey: null, fileName: 'VSF / PCP' });
    const stats = createGapfillStats();

    const edits = await runGapfillDiff(pagesB, store, stats);

    expect(edits).toHaveLength(1);
    expect(edits[0]!.changedProps).toEqual(['baseline-missing']);
    expect(edits.filter((e) => e.op === 'created' || e.op === 'deleted')).toEqual([]);
    expect(toGapfillStatus(stats).errors![0]).toContain('another file');
    // The key collision itself is unchanged: B now owns the key and A will read
    // baseline-missing next boot. An honest under-report each way, never a wrong diff.
    expect(storedBaseline(store, key).fileName).toBe('VSF / PCP');
  });

  it('the coverage an agent sees for that case: two true rows, one cause', async () => {
    // A foreign baseline is `baseline: null` PLUS a recorded error, so the boot takes the
    // first-run path AND records a failure. Both rows are true — nothing was diffed, and
    // gap-fill did refuse a stored value — and this pins the shape so a later change cannot
    // quietly drop either one. The error COUNT is 1 for the one condition: the
    // write read-back re-reads the SAME refusal the boot already recorded and must not
    // record it again; the message itself stays in `status.plugin.gapfill.errors`.
    const pagesA = [fakePage('pA', 'Screens', [fakeNode('a1')])];
    installFigma({ pages: pagesA, fileKey: null, fileName: 'VSF - PCP' });
    const store = createMemoryBaselineStore();
    await runGapfillDiff(pagesA, store, createGapfillStats());

    installFigma({ pages: [fakePage('pB', 'Cover', [fakeNode('b1')])], fileKey: null, fileName: 'VSF / PCP' });
    const stats = createGapfillStats();
    await runGapfillDiff([fakePage('pB', 'Cover', [fakeNode('b1')])], store, stats);

    const perf = createPerfStats();
    markBootComplete(perf);
    const coverage = buildPluginCoverage({ gapfill: toGapfillStatus(stats), perf: toPerfStatus(perf) });
    expect(coverage).toEqual({
      complete: false,
      gaps: [
        { kind: 'baseline-missing', count: 1, see: 'status.plugin.gapfill' },
        { kind: 'gapfill-errors', count: 1, see: 'status.plugin.gapfill' },
      ],
    });
  });

  it('a GENUINE second failure on the write itself still counts 2 — not every re-read is a duplicate', async () => {
    // The boot refusal (foreign baseline) is suppressed on the write's read-back — but a
    // DIFFERENT, later failure in the SAME write (the `set` itself, not the read-back) is a
    // real second cause and must still be recorded on its own.
    const pagesA = [fakePage('pA', 'Screens', [fakeNode('a1')])];
    installFigma({ pages: pagesA, fileKey: null, fileName: 'VSF - PCP' });
    const backing = createMemoryBaselineStore();
    await runGapfillDiff(pagesA, backing, createGapfillStats()); // seeds the foreign baseline B will collide with

    installFigma({ pages: [fakePage('pB', 'Cover', [fakeNode('b1')])], fileKey: null, fileName: 'VSF / PCP' });
    const stats = createGapfillStats();
    // Reads delegate to the seeded store (so boot finds the SAME foreign value as above);
    // every `set` rejects, with no other file's baseline in the store to evict instead.
    const failingWriteStore = {
      get: (key: string) => backing.get(key),
      keys: () => backing.keys(),
      delete: (key: string) => backing.delete(key),
      set: async () => { throw new Error('quota exceeded'); },
    };

    await runGapfillDiff([fakePage('pB', 'Cover', [fakeNode('b1')])], failingWriteStore, stats);

    expect(stats.errorCount).toBe(2);
    expect(stats.firstError).toContain('another file'); // the FIRST cause, kept
  });

  it('an IDLE write later in the SAME session never re-records the boot refusal, but its own write failure still counts', async () => {
    // Same boot as above: foreign baseline (1) + the boot's own write refused (1) = 2. Then
    // main.ts's idle debounce fires later in this SAME session, on the SAME `stats` — its
    // read-back hits the identical foreign-baseline refusal (must NOT become 3 by itself),
    // but its own `set` genuinely fails again too (a REPEATING real failure, not a fact
    // already on record) and that must still count: 2 + 1 = 3, never 4.
    const pagesA = [fakePage('pA', 'Screens', [fakeNode('a1')])];
    installFigma({ pages: pagesA, fileKey: null, fileName: 'VSF - PCP' });
    const backing = createMemoryBaselineStore();
    await runGapfillDiff(pagesA, backing, createGapfillStats());

    const pagesB = [fakePage('pB', 'Cover', [fakeNode('b1')])];
    installFigma({ pages: pagesB, fileKey: null, fileName: 'VSF / PCP' });
    const stats = createGapfillStats();
    const failingWriteStore = {
      get: (key: string) => backing.get(key),
      keys: () => backing.keys(),
      delete: (key: string) => backing.delete(key),
      set: async () => { throw new Error('quota exceeded'); },
    };
    await runGapfillDiff(pagesB, failingWriteStore, stats);
    expect(stats.errorCount).toBe(2); // boot read (1) + boot write refused (1)

    // The idle debounce: main.ts:253 calls `writeBaseline` directly, reusing the session's
    // one `gapfillStats` — never `runGapfillDiff` again, so nothing re-establishes the boot
    // verdict; it must already be on `stats` from the boot call above.
    await writeBaseline(pagesB, snapshotPageBounded, failingWriteStore, stats);

    expect(stats.errorCount).toBe(3); // NOT 4 — the read-back refusal was not re-recorded
    expect(stats.firstError).toContain('another file');
  });

  it('a KEYED file keeps its baseline across a RENAME — the fileKey, not the name, is the identity', async () => {
    const pages = [fakePage('p1', 'Screens', [fakeNode('a'), fakeNode('gone')])];
    installFigma({ pages, fileKey: 'ABC123', fileName: 'Before' });
    const store = createMemoryBaselineStore();
    await runGapfillDiff(pages, store, createGapfillStats());

    const renamed = [fakePage('p1', 'Screens', [fakeNode('a')])];
    installFigma({ pages: renamed, fileKey: 'ABC123', fileName: 'After' });

    const edits = await runGapfillDiff(renamed, store, createGapfillStats());

    expect(edits.map((e) => e.nodeId)).toEqual(['gone']);
  });
});

describe('writeBaseline — a read that REJECTS must not overwrite the previous baseline', () => {
  const previous: FileBaseline = {
    writtenAt: '2026-01-01T00:00:00.000Z', writtenBy: 'Owner',
    fileKey: 'FILEKEY1', fileName: 'Test File',
    pages: [{ id: 'p1', name: 'Screens', truncated: false, records: [['old', 'Old', 'FRAME', 0, 0, null]] }],
  };

  it('a rejecting get withholds the write, so a transient read error never discards usable history', async () => {
    const pages = [fakePage('p1', 'Screens', [fakeNode('a')])];
    installFigma({ pages });
    const key = baselineKeyFor('FILEKEY1', 'Test File');
    const store = createMemoryBaselineStore({ getError: 'clientStorage unavailable' });
    store.map.set(key, previous);
    const stats = createGapfillStats();

    await writeBaseline(pages, snapshotPageBounded, store, stats);

    expect(store.map.get(key)).toBe(previous); // byte-identical, not re-written
    expect(stats.baselineWrittenAt).toBeNull();
    expect(stats.firstError).toContain('baseline read failed');
  });

  it('NOTHING stored is not a read failure — the first write still lands', async () => {
    const pages = [fakePage('p1', 'Screens', [fakeNode('a')])];
    installFigma({ pages });
    const store = createMemoryBaselineStore();
    const stats = createGapfillStats();

    await writeBaseline(pages, snapshotPageBounded, store, stats);

    expect(store.map.has(baselineKeyFor('FILEKEY1', 'Test File'))).toBe(true);
    expect(stats.baselineWrittenAt).not.toBeNull();
    expect(stats.errorCount).toBe(0);
  });

  it('a rejecting get skips this boot honestly: one baseline-unreadable notice, no walk, no write', async () => {
    let walks = 0;
    const page = { id: 'p1', name: 'Screens', type: 'PAGE', get children() { walks += 1; return []; } } as unknown as PageNode;
    const pages = [page];
    installFigma({ pages });
    const key = baselineKeyFor('FILEKEY1', 'Test File');
    const store = createMemoryBaselineStore({ getError: 'clientStorage unavailable' });
    store.map.set(key, previous);
    const stats = createGapfillStats();

    const edits = await runGapfillDiff(pages, store, stats);

    // Never "no previous baseline": one still exists on disk, it merely could not be read.
    expect(edits.map((e) => e.changedProps)).toEqual([['baseline-unreadable']]);
    expect(walks).toBe(0); // a read failure must not cost a full document walk
    expect(store.map.get(key)).toBe(previous);
    expect(stats.baselineWrittenAt).toBeNull();
    expect(stats.firstError).toContain('baseline read failed');
  });

  // The unreadable notice promises "reported on the next successful boot". An idle write
  // later in the SAME session, once the store reads fine again, would bake the closed-window
  // edits into a fresh baseline and make that promise impossible — silently. A session whose
  // boot never diffed against the stored baseline must therefore never overwrite it.
  it('a session whose boot could not read the baseline never overwrites it later, even once reads recover', async () => {
    const pages = [fakePage('p1', 'Screens', [fakeNode('a'), fakeNode('new-this-session')])];
    installFigma({ pages });
    const key = baselineKeyFor('FILEKEY1', 'Test File');
    const opts: { getError?: string } = { getError: 'clientStorage unavailable' };
    const store = createMemoryBaselineStore(opts);
    store.map.set(key, previous);
    const stats = createGapfillStats();

    await runGapfillDiff(pages, store, stats);
    delete opts.getError; // reads recover mid-session (e.g. after the idle window)
    await writeBaseline(pages, snapshotPageBounded, store, stats);

    expect(store.map.get(key)).toBe(previous);
    expect(stats.baselineWrittenAt).toBeNull();
    expect(stats.errorCount).toBeGreaterThanOrEqual(2); // the read failure AND the withheld write are both on record
  });
});

describe('runGapfillDiff — one page whose walk THROWS', () => {
  it('records the failure, still diffs the other pages, and carries the failed page\'s baseline forward', async () => {
    const first = [fakePage('p1', 'Screens', [fakeNode('a'), fakeNode('gone')]), fakePage('p2', 'Archive', [fakeNode('c')])];
    installFigma({ pages: first });
    const store = createMemoryBaselineStore();
    await runGapfillDiff(first, store, createGapfillStats());

    const throwing = { id: 'p2', name: 'Archive', type: 'PAGE' } as unknown as PageNode;
    Object.defineProperty(throwing, 'children', { get: () => { throw new Error('page not loaded'); } });
    const pages2 = [fakePage('p1', 'Screens', [fakeNode('a')]), throwing];
    installFigma({ pages: pages2 });
    const stats = createGapfillStats();

    const edits = await runGapfillDiff(pages2, store, stats);

    expect(edits.map((e) => e.nodeId)).toEqual(['gone']); // the healthy page still reports
    expect(stats.pagesDiffed).toBe(1);
    expect(stats.firstError).toContain('Archive');
    const stored = storedBaseline(store, baselineKeyFor('FILEKEY1', 'Test File'));
    expect(stored.pages.find((p) => p.id === 'p2')!.records).toEqual([['c', 'Node c', 'FRAME', 0, 0, 'p2']]);
  });
});

describe('runGapfillDiff — a page whose walk could not read every node', () => {
  /** A node that refuses its `name`. The walk's per-node guard wraps the record push AND
   *  the `children` read, so this node AND its whole subtree are absent from the walk —
   *  which a diff run against the previous session would report as deletions. */
  function hostileNode(id: string, children: FakeNode[] = []): FakeNode {
    const n = fakeNode(id, { children });
    Object.defineProperty(n, 'name', { get: () => { throw new Error('stale node reference'); } });
    return n;
  }

  it('emits ONE notice, no deletions, and keeps the previous baseline entry verbatim', async () => {
    const before = [fakePage('p1', 'Screens', [fakeNode('a', { children: [fakeNode('b'), fakeNode('c')] })])];
    installFigma({ pages: before });
    const store = createMemoryBaselineStore();
    await runGapfillDiff(before, store, createGapfillStats());
    const key = baselineKeyFor('FILEKEY1', 'Test File');
    const kept = storedBaseline(store, key).pages.find((p) => p.id === 'p1')!.records;

    const after = [fakePage('p1', 'Screens', [hostileNode('a', [fakeNode('b'), fakeNode('c')])])];
    installFigma({ pages: after });
    const stats = createGapfillStats();

    const edits = await runGapfillDiff(after, store, stats);

    expect(edits.filter((e) => e.op === 'deleted')).toEqual([]); // a, b and c are all still there
    expect(edits.map((e) => e.changedProps)).toEqual([['walk-errors']]);
    expect(edits[0]!.nodeName).toBe('Screens');
    expect(stats.pagesWithReadErrors).toBe(1);
    expect(toGapfillStatus(stats).pagesWithReadErrors).toBe(1);
    expect(stats.firstError).toContain('Screens');
    // The baseline is NOT overwritten with the walk that lost those nodes — otherwise the
    // next session reads them as freshly created when they come back.
    expect(storedBaseline(store, key).pages.find((p) => p.id === 'p1')!.records).toEqual(kept);
  });

  it('a page that read cleanly still reports while another page could not be read', async () => {
    const before = [fakePage('p1', 'Screens', [fakeNode('a')]), fakePage('p2', 'Specs', [fakeNode('b'), fakeNode('gone')])];
    installFigma({ pages: before });
    const store = createMemoryBaselineStore();
    await runGapfillDiff(before, store, createGapfillStats());

    const after = [fakePage('p1', 'Screens', [hostileNode('a')]), fakePage('p2', 'Specs', [fakeNode('b')])];
    installFigma({ pages: after });
    const stats = createGapfillStats();

    const edits = await runGapfillDiff(after, store, stats);

    expect(edits.filter((e) => e.op === 'deleted').map((e) => e.nodeId)).toEqual(['gone']);
    expect(stats.pagesDiffed).toBe(1); // the unreadable page was NOT diffed, and does not claim to be
  });

  it('a TOP-LEVEL frame that refuses to be read costs the page its coarse diff, not a fake deletion', async () => {
    const CAP = SNAPSHOT_NODE_CAP_PER_PAGE;
    const filler = () => fakeNode('bulk', { children: Array.from({ length: CAP + 1 }, (_, i) => fakeNode(`filler${i}`)) });
    const before = [fakePage('big', 'Everything', [fakeNode('hero', { name: 'Hero' }), filler()])];
    installFigma({ pages: before });
    const store = createMemoryBaselineStore();
    await runGapfillDiff(before, store, createGapfillStats());

    const after = [fakePage('big', 'Everything', [hostileNode('hero'), filler()])];
    installFigma({ pages: after });
    const stats = createGapfillStats();

    const edits = await runGapfillDiff(after, store, stats);

    expect(edits.filter((e) => e.op === 'deleted')).toEqual([]);
    expect(edits.map((e) => e.changedProps)).toEqual([['walk-errors']]);
    expect(stats.pagesTopLevelOnly).toBe(0); // nothing was covered, and it never claims to be
  });
});

describe('runGapfillDiff — a node that is missing from the walk but still in the file', () => {
  /** The walk now spans macrotask yields, so the scene can change under it: a node
   *  reparented from a not-yet-walked region into an already-walked one is absent from
   *  `records` with nothing thrown and nothing counted. Every `deleted` candidate is
   *  therefore looked up before it is reported. */
  const alive = (ids: readonly string[]) => async (id: string) => ids.includes(id);

  it('does not report a deletion for a node the host can still find', async () => {
    const before = [fakePage('p1', 'Screens', [fakeNode('a'), fakeNode('moved')])];
    installFigma({ pages: before });
    const store = createMemoryBaselineStore();
    await runGapfillDiff(before, store, createGapfillStats());

    const after = [fakePage('p1', 'Screens', [fakeNode('a')])];
    installFigma({ pages: after });
    const stats = createGapfillStats();

    const edits = await runGapfillDiff(after, store, stats, createPerfStats(), { nodeExists: alive(['moved']) });

    expect(edits.filter((e) => e.op === 'deleted')).toEqual([]);
    expect(stats.deletedRechecked).toBe(1);
    expect(toGapfillStatus(stats).deletedRechecked).toBe(1);
  });

  it('a node the host cannot find IS reported deleted — the check only suppresses survivors', async () => {
    const before = [fakePage('p1', 'Screens', [fakeNode('a'), fakeNode('gone')])];
    installFigma({ pages: before });
    const store = createMemoryBaselineStore();
    await runGapfillDiff(before, store, createGapfillStats());

    const after = [fakePage('p1', 'Screens', [fakeNode('a')])];
    installFigma({ pages: after });
    const stats = createGapfillStats();

    const edits = await runGapfillDiff(after, store, stats, createPerfStats(), { nodeExists: alive([]) });

    expect(edits.filter((e) => e.op === 'deleted').map((e) => e.nodeId)).toEqual(['gone']);
    expect(stats.deletedRechecked).toBe(0);
    expect(toGapfillStatus(stats).deletedRechecked).toBeUndefined(); // present only when non-zero
  });

  it('a TOP-LEVEL frame on an oversized page is cross-checked the same way', async () => {
    const CAP = SNAPSHOT_NODE_CAP_PER_PAGE;
    const filler = () => fakeNode('bulk', { children: Array.from({ length: CAP + 1 }, (_, i) => fakeNode(`filler${i}`)) });
    const before = [fakePage('big', 'Everything', [fakeNode('hero'), fakeNode('moved'), filler()])];
    installFigma({ pages: before });
    const store = createMemoryBaselineStore();
    await runGapfillDiff(before, store, createGapfillStats());

    const after = [fakePage('big', 'Everything', [fakeNode('hero'), filler()])];
    installFigma({ pages: after });
    const stats = createGapfillStats();

    const edits = await runGapfillDiff(after, store, stats, createPerfStats(), { nodeExists: alive(['moved']) });

    expect(edits.filter((e) => e.op === 'deleted')).toEqual([]);
    expect(stats.deletedRechecked).toBe(1);
  });
});

describe('nodeStillExists — the only authority on whether a `deleted` candidate is really gone', () => {
  /** Every test that injects `deps.nodeExists` rides PAST this predicate, so without these
   *  four the branch deciding whether a closed-window deletion reaches the feed at all is
   *  never executed. The stub therefore encodes what the host can REFUSE, not just what it
   *  can answer: no getter, a rejected lookup, a live handle, and a handle the host still
   *  resolves for an id that is gone. */
  function installLookup(getNodeByIdAsync: (id: string) => Promise<unknown>): void {
    installFigma();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).figma.getNodeByIdAsync = getNodeByIdAsync;
  }

  it('a host with NO getter cannot answer, so the walk\'s own evidence stands', async () => {
    installFigma(); // no getNodeByIdAsync at all — an older host, FigJam, Slides
    expect(await nodeStillExists('a')).toBe(false);
  });

  it('a getter that REFUSES the lookup leaves that evidence standing too', async () => {
    installLookup(() => Promise.reject(new Error('node lookup refused')));
    expect(await nodeStillExists('a')).toBe(false);
  });

  it('an id that resolves to a LIVE node is a survivor', async () => {
    installLookup(async (id: string) => ({ id, removed: false }));
    expect(await nodeStillExists('a')).toBe(true);
  });

  it('a handle the host still resolves but has REMOVED is gone, not a survivor', async () => {
    // The repo's own convention (executor-exec-js.ts): `.removed` is the honest check, a
    // non-null handle is not. Trusting the handle would suppress EVERY closed-window
    // deletion on such a host and leave the category visible only as an anonymous counter.
    installLookup(async (id: string) => ({ id, removed: true }));
    expect(await nodeStillExists('a')).toBe(false);
  });
});

describe('writeBaseline — the writtenAt stamp eviction ranks by', () => {
  it('stamps the ISO timestamp of the write MOMENT, parseable back to it', async () => {
    const pages = [fakePage('p1', 'Screens', [fakeNode('a')])];
    installFigma({ pages });
    const store = createMemoryBaselineStore();
    const at = Date.parse('2026-09-03T10:15:00.000Z');
    const stats = createGapfillStats();

    await writeBaseline(pages, snapshotPageBounded, store, stats, () => at);

    const stored = storedBaseline(store, baselineKeyFor('FILEKEY1', 'Test File'));
    expect(stored.writtenAt).toBe('2026-09-03T10:15:00.000Z');
    expect(Date.parse(stored.writtenAt)).toBe(at); // an unparseable stamp breaks eviction order
    expect(stats.baselineWrittenAt).toBe(stored.writtenAt);
  });

  it('an UNPARSEABLE writtenAt ranks OLDEST and is the entry eviction drops first', async () => {
    const pages = [fakePage('p1', 'Screens', [fakeNode('a'), fakeNode('b'), fakeNode('c')])];
    installFigma({ pages });
    const undatedKey = `${BASELINE_KEY_PREFIX}undated-file`;
    const datedKey = `${BASELINE_KEY_PREFIX}dated-file`;
    const neighbour: FileBaseline = {
      writtenAt: 'not-a-date', writtenBy: 'Owner', fileKey: 'OTHER', fileName: 'Other',
      pages: [{ id: 'x', name: 'X', truncated: false, top: [], records: [] }],
    };

    const probe = createMemoryBaselineStore();
    await writeBaseline(pages, snapshotPageBounded, probe, createGapfillStats());
    const ourBytes = JSON.stringify(probe.map.get(baselineKeyFor('FILEKEY1', 'Test File'))).length;
    const quotaBytes = JSON.stringify(neighbour).length + ourBytes;

    const seeded = createMemoryBaselineStore({ quotaBytes });
    seeded.map.set(undatedKey, neighbour);
    seeded.map.set(datedKey, { ...neighbour, writtenAt: '2020-01-01T00:00:00.000Z' });
    const stats = createGapfillStats();

    await writeBaseline(pages, snapshotPageBounded, seeded, stats);

    expect(seeded.map.has(undatedKey)).toBe(false); // undated = unusable = cheapest to lose
    expect(seeded.map.has(datedKey)).toBe(true);
    expect(toGapfillStatus(stats).baselineEvicted).toEqual([undatedKey]);
  });
});

describe('the baseline VERSION — a value from the previous shape is never diffed', () => {
  it('a v2 value reads as baseline-missing, is deleted once the v3 write lands, and is COUNTED', async () => {
    const pages = [fakePage('p1', 'Screens', [fakeNode('a'), fakeNode('b')])];
    installFigma({ pages });
    const store = createMemoryBaselineStore();
    const legacyKey = legacyBaselineKeyFor('FILEKEY1', 'Test File');
    // A perfectly VALID value of the previous shape: same file, same pages, no `top`.
    // Diffing it would mix two record vocabularies and report facts neither shape states.
    await store.set(legacyKey, {
      writtenAt: '2026-01-01T00:00:00.000Z', writtenBy: 'Owner',
      fileKey: 'FILEKEY1', fileName: 'Test File',
      pages: [{ id: 'p1', name: 'Screens', truncated: false, records: [['a', 'Node a', 'FRAME', 0, 0, 'p1']] }],
    });
    const stats = createGapfillStats();

    const edits = await runGapfillDiff(pages, store, stats);

    expect(edits.map((e) => e.changedProps)).toEqual([['baseline-missing']]);
    expect(edits.filter((e) => e.op === 'created' || e.op === 'deleted')).toEqual([]);
    expect(store.map.has(legacyKey)).toBe(false); // the stale value is not left to rot
    expect(stats.staleBaselinesCleared).toBe(1); // and its removal is on the record
    expect(toGapfillStatus(stats).staleBaselinesCleared).toBe(1);
    expect(store.map.has(baselineKeyFor('FILEKEY1', 'Test File'))).toBe(true);
  });

  it('a file with no stale value pays nothing and reports no cleanup', async () => {
    const pages = [fakePage('p1', 'Screens', [fakeNode('a')])];
    installFigma({ pages });
    const store = createMemoryBaselineStore();
    const stats = createGapfillStats();

    await runGapfillDiff(pages, store, stats);

    expect(stats.staleBaselinesCleared).toBe(0);
    expect(toGapfillStatus(stats).staleBaselinesCleared).toBeUndefined();
  });
});

describe('a page over the node cap still reports — the top-level signal', () => {
  const CAP = SNAPSHOT_NODE_CAP_PER_PAGE;

  /** `frames` top-level frames plus enough filler INSIDE the first one to blow the cap. */
  function hugePage(frames: FakeNode[]): PageNode {
    const filler = Array.from({ length: CAP + 1 }, (_, i) => fakeNode(`filler${i}`));
    return fakePage('big', 'Everything', [...frames, fakeNode('bulk', { children: filler })]);
  }

  async function seed(frames: FakeNode[]) {
    const pages = [hugePage(frames)];
    installFigma({ pages });
    const store = createMemoryBaselineStore();
    await runGapfillDiff(pages, store, createGapfillStats());
    return store;
  }

  it('the stored baseline keeps the top-level fingerprint even though it keeps no records', async () => {
    const store = await seed([fakeNode('hero', { name: 'Hero' })]);
    const stored = storedBaseline(store, baselineKeyFor('FILEKEY1', 'Test File'));
    const bigPage = stored.pages.find((p) => p.id === 'big')!;
    expect(bigPage.truncated).toBe(true);
    expect('records' in bigPage).toBe(false); // unchanged: records for a truncated page buy nothing
    expect(bigPage.top!.map((t) => t[0])).toEqual(['hero', 'bulk']);
  });

  it('reports created, deleted, renamed, moved and subtree-changed TOP-LEVEL frames', async () => {
    const store = await seed([
      fakeNode('keep', { name: 'Keep' }),
      fakeNode('rename', { name: 'Before' }),
      fakeNode('move', { name: 'Move' }),
      fakeNode('grow', { name: 'Grow', children: [fakeNode('g1')] }),
      fakeNode('resized', { name: 'Resized' }),
      fakeNode('gone', { name: 'Gone' }),
    ]);

    const after = [
      fakeNode('keep', { name: 'Keep' }),
      fakeNode('rename', { name: 'After' }),
      fakeNode('move', { name: 'Move', x: 400, y: 20 }),
      fakeNode('grow', { name: 'Grow', children: [fakeNode('g1'), fakeNode('g2')] }),
      fakeNode('resized', { name: 'Resized', width: 320 }),
      fakeNode('fresh', { name: 'Fresh' }),
    ];
    const pages = [hugePage(after)];
    installFigma({ pages });
    const stats = createGapfillStats();

    const edits = await runGapfillDiff(pages, store, stats);

    const byId = new Map(edits.map((e) => [e.nodeId, e]));
    expect(byId.get('fresh')!.op).toBe('created');
    expect(byId.get('gone')!.op).toBe('deleted');
    expect(byId.get('rename')!.changedProps).toEqual(['name']);
    expect(byId.get('move')!.changedProps).toEqual(['x', 'y']);
    expect(byId.get('grow')!.changedProps).toEqual(['subtree']); // an edit INSIDE the frame
    expect(byId.get('resized')!.changedProps).toEqual(['width']); // a resize is NOT a contents change
    expect(byId.has('keep')).toBe(false); // an unchanged frame is still never a frame in the feed
    expect(byId.has('bulk')).toBe(false); // nor is the container whose children blew the cap
    // The truncation notice stays: the page IS over the cap, and this signal is top-level only.
    expect(byId.get('truncated:big')!.changedProps).toEqual(['truncated']);
    expect(stats.pagesTruncated).toBe(1);
    expect(stats.pagesTopLevelOnly).toBe(1);
    expect(toGapfillStatus(stats).pagesTopLevelOnly).toBe(1);
  });

  it('a rename AND an inner edit on the same frame keeps both facts, one per frame', async () => {
    const store = await seed([fakeNode('f', { name: 'Before', children: [fakeNode('c1')] })]);
    const pages = [hugePage([fakeNode('f', { name: 'After', children: [fakeNode('c1'), fakeNode('c2')] })])];
    installFigma({ pages });

    const edits = await runGapfillDiff(pages, store, createGapfillStats());

    // Merged onto one frame the rename outranks the subtree fact and its sentence is never
    // rendered — on a truncated page, where this is the only signal, that fact would be lost.
    const frames = edits.filter((e) => e.nodeId === 'f');
    expect(frames.map((e) => e.changedProps)).toEqual([['name'], ['subtree']]);
    expect(frames.every((e) => e.op === 'updated')).toBe(true);
  });

  it('the FIRST session over the cap has no previous fingerprint and invents no facts', async () => {
    const pages = [hugePage([fakeNode('hero')])];
    installFigma({ pages });
    const store = createMemoryBaselineStore();
    // A baseline exists for the file, but not for this page — nothing to compare against.
    await store.set(baselineKeyFor('FILEKEY1', 'Test File'), {
      writtenAt: '2026-01-01T00:00:00.000Z', writtenBy: 'Owner',
      fileKey: 'FILEKEY1', fileName: 'Test File',
      pages: [{ id: 'other', name: 'Other', truncated: false, top: [], records: [] }],
    });
    const stats = createGapfillStats();

    const edits = await runGapfillDiff(pages, store, stats);

    expect(edits.filter((e) => e.nodeId === 'hero')).toEqual([]); // never "created"
    expect(stats.pagesTopLevelOnly).toBe(0); // nothing was covered, and it does not claim to be
  });
});

describe('the idle write walks only the pages that CHANGED', () => {
  it('re-walks a dirty page, carries every other page forward verbatim, and writes once', async () => {
    const pages = [
      fakePage('p1', 'Screens', [fakeNode('a')]),
      fakePage('p2', 'Specs', [fakeNode('b')]),
      fakePage('p3', 'Archive', [fakeNode('c')]),
    ];
    installFigma({ pages });
    const store = createMemoryBaselineStore();
    await runGapfillDiff(pages, store, createGapfillStats());

    const edited = [
      fakePage('p1', 'Screens', [fakeNode('a')]),
      fakePage('p2', 'Specs', [fakeNode('b'), fakeNode('b2')]),
      fakePage('p3', 'Archive', [fakeNode('c')]),
    ];
    installFigma({ pages: edited });
    const walked: string[] = [];
    const stats = createGapfillStats();

    await writeBaseline(
      edited,
      (page) => { walked.push(page.id); return snapshotPageBounded(page); },
      store, stats, Date.now, new Set(['p2']),
    );

    expect(walked).toEqual(['p2']); // one edit, one page walked — the other two cost nothing
    const stored = storedBaseline(store, baselineKeyFor('FILEKEY1', 'Test File'));
    expect(stored.pages.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
    expect(stored.pages.find((p) => p.id === 'p2')!.records).toHaveLength(2); // the fresh walk
    expect(stored.pages.find((p) => p.id === 'p3')!.records).toEqual([['c', 'Node c', 'FRAME', 0, 0, 'p3']]);
  });

  it('a page the stored baseline has never heard of is walked even when it is not dirty', async () => {
    const pages = [fakePage('p1', 'Screens', [fakeNode('a')])];
    installFigma({ pages });
    const store = createMemoryBaselineStore();
    await runGapfillDiff(pages, store, createGapfillStats());

    // p2 is missing from the baseline (its boot walk failed). Left unwalked forever, the
    // next boot would read its whole tree as freshly created.
    const withNewPage = [...pages, fakePage('p2', 'Specs', [fakeNode('b')])];
    installFigma({ pages: withNewPage });
    const walked: string[] = [];

    await writeBaseline(
      withNewPage,
      (page) => { walked.push(page.id); return snapshotPageBounded(page); },
      store, createGapfillStats(), Date.now, new Set<string>(),
    );

    expect(walked).toEqual(['p2']);
  });
});

describe('the perf block STATUS reports', () => {
  /** A clock that hands out KNOWN stamps in call order, so every number below is an exact
   *  arithmetic consequence rather than "at least zero" — which is trivially true of a
   *  counter that is never updated at all. */
  function pinnedClock(stamps: readonly number[]): () => number {
    let i = 0;
    return () => stamps[Math.min(i++, stamps.length - 1)]!;
  }

  /** Enough nodes to force three synchronous slices at the real slice size. */
  const manyNodes = (n: number) => Array.from({ length: n }, (_, i) => fakeNode(`n${i}`));
  const hop = () => Promise.resolve();

  it('is absent until boot has completed, then carries the walk numbers', async () => {
    const pages = [fakePage('p1', 'Screens', [fakeNode('a')]), fakePage('p2', 'Specs', [fakeNode('b')])];
    installFigma({ pages });
    const perf = createPerfStats();
    expect(toPerfStatus(perf)).toBeUndefined();

    await runGapfillDiff(pages, createMemoryBaselineStore(), createGapfillStats(), perf);
    markBootComplete(perf);

    const status = toPerfStatus(perf)!;
    expect(status.bootSlices).toBe(2); // one slice per page, both under the slice size
    expect(status.idleWalkMs).toBe(0); // no idle write has happened yet, and it says so
    expect('propertyReadErrors' in status).toBe(false); // present only once non-zero
  });

  it('reports the WORST synchronous slice, the slice count and the total, all to the millisecond', async () => {
    const pages = [
      fakePage('p1', 'Screens', manyNodes(2 * SNAPSHOT_SLICE_SIZE + 1)), // three slices
      fakePage('p2', 'Specs', [fakeNode('b')]),                          // one slice
    ];
    installFigma({ pages });
    const perf = createPerfStats();
    // p1: walk starts at 0 · slices measure 12, 37 and 5 ms · the walk ends at 100.
    // p2: starts at 200 · one 6 ms slice · ends at 210.
    const now = pinnedClock([0, 0, 12, 20, 57, 60, 65, 100, 200, 200, 206, 210]);

    // The budget clock is frozen so the TIME cut can never trip: this test is about the
    // count cut and the slice MEASUREMENTS, and must not depend on how fast the machine is.
    await runGapfillDiff(pages, createMemoryBaselineStore(), createGapfillStats(), perf, { walk: { now, hop, budgetClock: () => 0 } });
    markBootComplete(perf);

    const status = toPerfStatus(perf)!;
    expect(status.bootSlices).toBe(4);
    expect(status.bootWalkMaxSliceMs).toBe(37); // the worst chunk — NOT the mean of four
    expect(status.bootWalkMs).toBe(110);        // 100 + 10, hops included
    expect(status.idleWalkMaxSliceMs).toBe(0);  // no idle walk has happened, and it says so
  });

  it('the walk cuts a slice on the TIME budget, not only on the node count', async () => {
    // Twelve nodes costing 5 ms each: nowhere near SNAPSHOT_SLICE_SIZE, so the count cut
    // would hold the thread for all of them at once — the 65 ms cold-open chunk this budget
    // exists to prevent. The clock advances on each node's own property read.
    let clock = 0;
    const costs = <T extends { x: number }>(n: T): T => {
      Object.defineProperty(n, 'x', { get: () => { clock += 5; return 0; } });
      return n;
    };
    const container = costs(fakeNode('bulk', {
      children: Array.from({ length: 12 }, (_, i) => costs(fakeNode(`n${i}`))),
    }));
    installFigma({ pages: [fakePage('p1', 'Screens', [container])] });
    const perf = createPerfStats();

    await runGapfillDiff(
      [fakePage('p1', 'Screens', [container])], createMemoryBaselineStore(), createGapfillStats(), perf,
      { walk: { hop, budgetClock: () => clock } },
    );
    markBootComplete(perf);

    // 13 nodes at 5 ms, cut every SNAPSHOT_SLICE_BUDGET_MS → 4 chunks, none longer than the
    // budget plus one node's work.
    expect(SNAPSHOT_SLICE_BUDGET_MS).toBe(20);
    expect(toPerfStatus(perf)!.bootSlices).toBe(4);
  });

  it('an IDLE walk lands in the idle numbers, never in the boot ones', async () => {
    const pages = [fakePage('p1', 'Screens', [fakeNode('a')])];
    installFigma({ pages });
    const perf = createPerfStats();
    const now = pinnedClock([0, 0, 8, 30]);

    await writeBaseline(
      pages,
      (page) => snapshotPageBounded(page, perf, 'idle', { now, hop }),
      createMemoryBaselineStore(), createGapfillStats(),
    );
    markBootComplete(perf);

    const status = toPerfStatus(perf)!;
    expect(status.idleWalkMaxSliceMs).toBe(8);
    expect(status.idleWalkMs).toBe(30);
    expect(status.bootWalkMs).toBe(0);
    expect(status.bootSlices).toBe(0);
  });

  it('counts a node whose properties refused to be read, so a dropped node is never silent', async () => {
    const hostile = fakeNode('bad');
    Object.defineProperty(hostile, 'name', { get: () => { throw new Error('stale node reference'); } });
    const pages = [fakePage('p1', 'Screens', [fakeNode('a', { children: [hostile] })])];
    installFigma({ pages });
    const perf = createPerfStats();

    await runGapfillDiff(pages, createMemoryBaselineStore(), createGapfillStats(), perf);
    markBootComplete(perf);

    expect(toPerfStatus(perf)!.propertyReadErrors).toBe(1);
  });
});
