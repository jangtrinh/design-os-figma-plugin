// Reconnect gap-fill, store-backed halves: the boot diff, the baseline write, the storage
// quota refusal, and the one-time legacy in-document cleanup.
//
// These used to be "untestable outside a live sandbox". They are not: the only real figma
// dependencies are a key/value store (now injected) and a page walk (now a fake page whose
// `findAll` returns a fixture tree). What the live sandbox alone can still prove is the
// canvas walk itself — everything else is exercised here, including the refusal path that
// a permissive mock would have hidden.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearLegacyGapfillDocumentData, runGapfillDiff, snapshotPage, writeBaseline,
  SNAPSHOT_NODE_CAP_PER_PAGE, type NodeSnapshot,
} from '../plugin/src/main/edit-gapfill.ts';
import {
  BASELINE_KEY_PREFIX, baselineKeyFor, createMemoryBaselineStore,
  type FileBaseline,
} from '../plugin/src/main/gapfill-baseline-store.ts';
import { createGapfillStats, toGapfillStatus } from '../plugin/src/main/gapfill-status.ts';

interface FakeNode { id: string; name: string; type: string; x: number; y: number; parent: { id: string } | null }

function fakeNode(id: string, over: Partial<FakeNode> = {}): FakeNode {
  return { id, name: `Node ${id}`, type: 'FRAME', x: 0, y: 0, parent: null, ...over };
}

/** A `PageNode`-shaped stub: `findAll` is the only member `snapshotPage` touches. */
function fakePage(id: string, name: string, nodes: FakeNode[]): PageNode {
  return { id, name, findAll: () => nodes } as unknown as PageNode;
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

    await writeBaseline(pages, snapshotPage, store, createGapfillStats());

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
    await writeBaseline(pages, snapshotPage, store, createGapfillStats());

    const stats = createGapfillStats();
    const edits = await runGapfillDiff(pages, store, stats);

    expect(edits).toHaveLength(1);
    expect(edits[0]!.changedProps).toEqual(['truncated']);
    expect(stats.pagesTruncated).toBe(1);
    expect(toGapfillStatus(stats).pagesTruncated).toBe(1);
  });
});

describe('writeBaseline — the storage quota REFUSAL', () => {
  function otherFileBaseline(writtenAt: string): FileBaseline {
    return { writtenAt, writtenBy: 'Owner', pages: [{ id: 'x', name: 'X', truncated: false, records: [] }] };
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
    await writeBaseline(pages, snapshotPage, probe, createGapfillStats());
    const ourBytes = JSON.stringify(probe.map.get(baselineKeyFor('FILEKEY1', 'Test File'))).length;
    const quotaBytes = JSON.stringify(neighbour).length + ourBytes;

    const seeded = createMemoryBaselineStore({ quotaBytes });
    seeded.map.set(oldKey, neighbour);
    seeded.map.set(newKey, otherFileBaseline('2030-01-01T00:00:00.000Z'));
    const stats = createGapfillStats();

    await writeBaseline(pages, snapshotPage, seeded, stats);

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

    await expect(writeBaseline(pages, snapshotPage, store, stats)).resolves.toBeUndefined();

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

    await writeBaseline(pages, snapshotPage, store, stats);

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

describe('snapshotPage — the walk that feeds every record', () => {
  it('normalizes coordinates and carries the parent id', () => {
    const page = fakePage('p1', 'Screens', [fakeNode('child', { x: 10.26, y: 3.1, parent: { id: 'p1' } })]);
    const { records, truncated } = snapshotPage(page);
    expect(truncated).toBe(false);
    expect(records).toEqual<NodeSnapshot[]>([
      { id: 'child', name: 'Node child', type: 'FRAME', x: 10.5, y: 3, parent: 'p1' },
    ]);
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

    await writeBaseline(pages, snapshotPage, store, stats);

    expect(store.map.get(key)).toBe(previous); // byte-identical, not re-written
    expect(stats.baselineWrittenAt).toBeNull();
    expect(stats.firstError).toContain('baseline read failed');
  });

  it('NOTHING stored is not a read failure — the first write still lands', async () => {
    const pages = [fakePage('p1', 'Screens', [fakeNode('a')])];
    installFigma({ pages });
    const store = createMemoryBaselineStore();
    const stats = createGapfillStats();

    await writeBaseline(pages, snapshotPage, store, stats);

    expect(store.map.has(baselineKeyFor('FILEKEY1', 'Test File'))).toBe(true);
    expect(stats.baselineWrittenAt).not.toBeNull();
    expect(stats.errorCount).toBe(0);
  });

  it('a rejecting get skips this boot honestly: one baseline-unreadable notice, no walk, no write', async () => {
    const page = fakePage('p1', 'Screens', [fakeNode('a')]);
    let walks = 0;
    const originalFindAll = page.findAll.bind(page);
    page.findAll = ((...args: Parameters<typeof originalFindAll>) => { walks += 1; return originalFindAll(...args); }) as typeof page.findAll;
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
    await writeBaseline(pages, snapshotPage, store, stats);

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

    const throwing = { id: 'p2', name: 'Archive', findAll: () => { throw new Error('page not loaded'); } } as unknown as PageNode;
    const pages2 = [fakePage('p1', 'Screens', [fakeNode('a')]), throwing];
    installFigma({ pages: pages2 });
    const stats = createGapfillStats();

    const edits = await runGapfillDiff(pages2, store, stats);

    expect(edits.map((e) => e.nodeId)).toEqual(['gone']); // the healthy page still reports
    expect(stats.pagesDiffed).toBe(1);
    expect(stats.firstError).toContain('Archive');
    const stored = storedBaseline(store, baselineKeyFor('FILEKEY1', 'Test File'));
    expect(stored.pages.find((p) => p.id === 'p2')!.records).toEqual([['c', 'Node c', 'FRAME', 0, 0, null]]);
  });
});

describe('writeBaseline — the writtenAt stamp eviction ranks by', () => {
  it('stamps the ISO timestamp of the write MOMENT, parseable back to it', async () => {
    const pages = [fakePage('p1', 'Screens', [fakeNode('a')])];
    installFigma({ pages });
    const store = createMemoryBaselineStore();
    const at = Date.parse('2026-09-03T10:15:00.000Z');
    const stats = createGapfillStats();

    await writeBaseline(pages, snapshotPage, store, stats, () => at);

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
      pages: [{ id: 'x', name: 'X', truncated: false, records: [] }],
    };

    const probe = createMemoryBaselineStore();
    await writeBaseline(pages, snapshotPage, probe, createGapfillStats());
    const ourBytes = JSON.stringify(probe.map.get(baselineKeyFor('FILEKEY1', 'Test File'))).length;
    const quotaBytes = JSON.stringify(neighbour).length + ourBytes;

    const seeded = createMemoryBaselineStore({ quotaBytes });
    seeded.map.set(undatedKey, neighbour);
    seeded.map.set(datedKey, { ...neighbour, writtenAt: '2020-01-01T00:00:00.000Z' });
    const stats = createGapfillStats();

    await writeBaseline(pages, snapshotPage, seeded, stats);

    expect(seeded.map.has(undatedKey)).toBe(false); // undated = unusable = cheapest to lose
    expect(seeded.map.has(datedKey)).toBe(true);
    expect(toGapfillStatus(stats).baselineEvicted).toEqual([undatedKey]);
  });
});
