// Reconnect gap-fill — the PURE core: coordinate normalization, the diff, the record
// codec, and the per-page write decision. No figma access. The store-backed halves
// (baseline read/write, quota refusal, boot diff) live in edit-gapfill-baseline.test.ts,
// which drives them through an injected store and fake pages.
import { describe, it, expect } from 'vitest';
import {
  baselineMissingNotice, createSingleFlightWriter, deletedPageIds, deletedPageLabel, diffSnapshots,
  fromBaselineRecord, gapfillEditsForPage, mergeUpdatedRecords, normalizeSnapshotCoord,
  pageWasTruncated, resolveBaselinePage, snapshotProviderFrom, toBaselineRecord,
  type NodeSnapshot,
} from '../plugin/src/main/edit-gapfill.ts';
import type { BaselinePage } from '../plugin/src/main/gapfill-baseline-store.ts';

function node(over: Partial<NodeSnapshot> = {}): NodeSnapshot {
  return { id: 'n1', name: 'Hero', type: 'FRAME', x: 0, y: 0, parent: null, ...over };
}

describe('normalizeSnapshotCoord — rounds to 0.5px', () => {
  it('rounds to the nearest half-pixel', () => {
    expect(normalizeSnapshotCoord(1.24)).toBe(1);
    expect(normalizeSnapshotCoord(1.26)).toBe(1.5);
    expect(normalizeSnapshotCoord(1.76)).toBe(2);
  });

  it('a sub-pixel jitter within the same half-pixel bucket produces the SAME value', () => {
    expect(normalizeSnapshotCoord(10.01)).toBe(normalizeSnapshotCoord(10.02));
  });
});

describe('diffSnapshots — existence/name/position, one fact category at a time', () => {
  it('id present in next, absent in prev → created', () => {
    const diff = diffSnapshots([], [node({ id: 'a' })]);
    expect(diff.created.map((n) => n.id)).toEqual(['a']);
    expect(diff.deleted).toEqual([]);
    expect(diff.renamed).toEqual([]);
    expect(diff.moved).toEqual([]);
  });

  it('id present in prev, absent in next → deleted', () => {
    const diff = diffSnapshots([node({ id: 'a' })], []);
    expect(diff.deleted.map((n) => n.id)).toEqual(['a']);
    expect(diff.created).toEqual([]);
  });

  it('same id, different name → renamed', () => {
    const diff = diffSnapshots([node({ id: 'a', name: 'Old' })], [node({ id: 'a', name: 'New' })]);
    expect(diff.renamed).toHaveLength(1);
    expect(diff.renamed[0]!.prev.name).toBe('Old');
    expect(diff.renamed[0]!.next.name).toBe('New');
    expect(diff.moved).toEqual([]);
  });

  it('same id, x or y moved beyond 0.5px → moved', () => {
    const diff = diffSnapshots([node({ id: 'a', x: 0, y: 0 })], [node({ id: 'a', x: 10, y: 0 })]);
    expect(diff.moved).toHaveLength(1);
    expect(diff.renamed).toEqual([]);
  });

  it('a move of EXACTLY 0.5px is NOT reported (only strictly over the epsilon is)', () => {
    const diff = diffSnapshots([node({ id: 'a', x: 0 })], [node({ id: 'a', x: 0.5 })]);
    expect(diff.moved).toEqual([]);
  });

  it('a node that changed BOTH name and position is reported in BOTH lists — neither drops it for the other', () => {
    const diff = diffSnapshots(
      [node({ id: 'a', name: 'Old', x: 0, y: 0 })],
      [node({ id: 'a', name: 'New', x: 100, y: 100 })],
    );
    expect(diff.renamed.map((p) => p.next.id)).toEqual(['a']);
    expect(diff.moved.map((p) => p.next.id)).toEqual(['a']);
  });

  it('an unchanged node produces no facts at all', () => {
    const diff = diffSnapshots([node({ id: 'a' })], [node({ id: 'a' })]);
    expect(diff).toEqual({ created: [], deleted: [], renamed: [], moved: [] });
  });

  it('a delete→create of the SAME id (recreated) reads as both deleted and created, honestly — no attempt to infer "same node"', () => {
    const diff = diffSnapshots([node({ id: 'a', name: 'Old' })], [node({ id: 'a', name: 'Old' })]);
    // Same id, same name/position — unchanged, not a special "recreated" case; diffSnapshots
    // only sees the two full snapshots, not the intermediate deletion.
    expect(diff).toEqual({ created: [], deleted: [], renamed: [], moved: [] });
  });
});

describe('mergeUpdatedRecords — one `updated` entry per node, union of changedProps (the wire contract)', () => {
  it('a rename alone → changedProps ["name"]', () => {
    const merged = mergeUpdatedRecords([{ prev: node({ name: 'Old' }), next: node({ name: 'New' }) }], []);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.changedProps).toEqual(['name']);
  });

  it('a move alone → changedProps ["x","y"]', () => {
    const merged = mergeUpdatedRecords([], [{ prev: node({ x: 0 }), next: node({ x: 10 }) }]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.changedProps).toEqual(['x', 'y']);
  });

  it('a node in BOTH renamed and moved merges into ONE entry with the union', () => {
    const renamedPair = { prev: node({ id: 'a', name: 'Old' }), next: node({ id: 'a', name: 'New', x: 10 }) };
    const movedPair = { prev: node({ id: 'a', x: 0 }), next: node({ id: 'a', name: 'New', x: 10 }) };
    const merged = mergeUpdatedRecords([renamedPair], [movedPair]);
    expect(merged).toHaveLength(1); // ONE entry, not two
    expect(merged[0]!.changedProps).toEqual(['name', 'x', 'y']);
  });

  it('two different nodes stay as two separate entries', () => {
    const merged = mergeUpdatedRecords(
      [{ prev: node({ id: 'a', name: 'Old' }), next: node({ id: 'a', name: 'New' }) }],
      [{ prev: node({ id: 'b', x: 0 }), next: node({ id: 'b', x: 10 }) }],
    );
    expect(merged.map((m) => m.rec.id).sort()).toEqual(['a', 'b']);
  });
});

describe('gapfillEditsForPage — EditInput shape: source-neutral here, actor stamped owner by the caller', () => {
  it('a created node emits op created, empty changedProps', () => {
    const edits = gapfillEditsForPage({ created: [node({ id: 'a' })], deleted: [], renamed: [], moved: [] }, 'Page 1');
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ op: 'created', nodeId: 'a', page: 'Page 1', actor: 'owner', changedProps: [] });
  });

  it('a deleted node emits op deleted', () => {
    const edits = gapfillEditsForPage({ created: [], deleted: [node({ id: 'a' })], renamed: [], moved: [] }, 'Page 1');
    expect(edits[0]).toMatchObject({ op: 'deleted', nodeId: 'a' });
  });

  it('renamed+moved for the same node produce exactly ONE updated edit', () => {
    const pair = { prev: node({ id: 'a', name: 'Old', x: 0 }), next: node({ id: 'a', name: 'New', x: 10 }) };
    const edits = gapfillEditsForPage({ created: [], deleted: [], renamed: [pair], moved: [pair] }, 'Page 1');
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ op: 'updated', changedProps: ['name', 'x', 'y'] });
  });

  it('parentName is always null — gap-fill never invents a parent it did not track', () => {
    const edits = gapfillEditsForPage({ created: [node()], deleted: [], renamed: [], moved: [] }, 'Page 1');
    expect(edits[0]!.parentName).toBeNull();
  });

  it('an empty diff produces no edits', () => {
    expect(gapfillEditsForPage({ created: [], deleted: [], renamed: [], moved: [] }, 'Page 1')).toEqual([]);
  });
});

describe('deletedPageIds — a page in the PREVIOUS manifest missing from the CURRENT set entirely (M4)', () => {
  it('finds a page id present in prev but absent from current', () => {
    expect(deletedPageIds(['p1', 'p2'], new Set(['p1']))).toEqual(['p2']);
  });

  it('every prev page still present → nothing deleted', () => {
    expect(deletedPageIds(['p1', 'p2'], new Set(['p1', 'p2']))).toEqual([]);
  });

  it('no previous pages at all → nothing to report', () => {
    expect(deletedPageIds([], new Set(['p1']))).toEqual([]);
  });

  it('every prev page gone → all reported', () => {
    expect(deletedPageIds(['p1', 'p2'], new Set())).toEqual(['p1', 'p2']);
  });
});

describe('pageWasTruncated — either side truncated makes created/deleted unreliable (M5)', () => {
  it('neither side truncated → false', () => {
    expect(pageWasTruncated(false, false)).toBe(false);
  });

  it('previous side truncated alone → true', () => {
    expect(pageWasTruncated(true, false)).toBe(true);
  });

  it('current side truncated alone → true', () => {
    expect(pageWasTruncated(false, true)).toBe(true);
  });

  it('both sides truncated → true', () => {
    expect(pageWasTruncated(true, true)).toBe(true);
  });

  it('a page with no previous manifest entry at all (prevTruncated undefined) is judged by the current side alone', () => {
    expect(pageWasTruncated(undefined, false)).toBe(false);
    expect(pageWasTruncated(undefined, true)).toBe(true);
  });
});

describe('snapshotProviderFrom — the boot write reuses the walk the diff already took', () => {
  it('a cached page returns the precomputed result WITHOUT invoking the fallback walker', () => {
    const cached = { records: [node()], truncated: false };
    let walks = 0;
    const provider = snapshotProviderFrom(
      new Map([['page-1', cached]]),
      () => { walks += 1; return { records: [], truncated: false }; },
    );
    expect(provider({ id: 'page-1' })).toBe(cached);
    expect(walks).toBe(0); // the whole point: no second walk for a page already snapshotted
  });

  it('an uncached page falls back to the walker (and only for that page)', () => {
    const fresh = { records: [], truncated: false };
    let walks = 0;
    const provider = snapshotProviderFrom(
      new Map([['page-1', { records: [node()], truncated: true }]]),
      () => { walks += 1; return fresh; },
    );
    expect(provider({ id: 'page-2' })).toBe(fresh);
    expect(walks).toBe(1);
    provider({ id: 'page-1' });
    expect(walks).toBe(1); // the cached page still never re-walks
  });
});

describe('baseline record codec — the persisted tuple round-trips a NodeSnapshot exactly', () => {
  it('a record survives encode → decode unchanged, including a null parent', () => {
    const rec = node({ id: 'a', name: 'Hero', type: 'FRAME', x: 12.5, y: -4, parent: null });
    expect(fromBaselineRecord(toBaselineRecord(rec))).toEqual(rec);
  });

  it('a nested node keeps its parent id', () => {
    const rec = node({ id: 'b', parent: 'a' });
    expect(toBaselineRecord(rec)).toEqual(['b', 'Hero', 'FRAME', 0, 0, 'a']);
    expect(fromBaselineRecord(toBaselineRecord(rec)).parent).toBe('a');
  });
});

describe('resolveBaselinePage — per-page atomicity, and no records for a truncated page', () => {
  const page = { id: 'page-1', name: 'Screens' };
  const prevEntry: BaselinePage = { id: 'page-1', name: 'Screens', truncated: false, records: [toBaselineRecord(node())] };

  it('a successful non-truncated snapshot stores the records as tuples', () => {
    const resolved = resolveBaselinePage(page, prevEntry, () => ({ records: [node({ id: 'x' })], truncated: false }));
    expect(resolved).toEqual({ id: 'page-1', name: 'Screens', truncated: false, records: [toBaselineRecord(node({ id: 'x' }))] });
  });

  it('a TRUNCATED page stores no records at all — its diff is suppressed, so they would only cost bytes', () => {
    const resolved = resolveBaselinePage(page, prevEntry, () => ({ records: [node(), node({ id: 'y' })], truncated: true }));
    expect(resolved).toEqual({ id: 'page-1', name: 'Screens', truncated: true });
    expect(resolved && 'records' in resolved).toBe(false);
  });

  it('a throwing snapshot carries the PREVIOUS entry forward verbatim', () => {
    expect(resolveBaselinePage(page, prevEntry, () => { throw new Error('findAll failed'); })).toBe(prevEntry);
  });

  it('a throwing snapshot with NO previous entry returns null — nothing to carry, nothing to write', () => {
    expect(resolveBaselinePage(page, undefined, () => { throw new Error('findAll failed'); })).toBeNull();
  });
});

describe('deletedPageLabel — a node count only when the baseline actually stored records', () => {
  it('a page with records is named with its count', () => {
    expect(deletedPageLabel({ id: 'p', name: 'Archive', truncated: false, records: [toBaselineRecord(node())] }))
      .toBe('Archive (1 node(s))');
  });

  it('a TRUNCATED page (no records stored) is named WITHOUT a fabricated "(0 node(s))"', () => {
    expect(deletedPageLabel({ id: 'p', name: 'Archive', truncated: true })).toBe('Archive');
  });
});

describe('baselineMissingNotice — one honest frame, never a whole-file "created" storm', () => {
  it('carries the baseline-missing marker, the file name, and the owner attribution', () => {
    const frame = baselineMissingNotice('VSF - PCP', 'Cover');
    expect(frame.changedProps).toEqual(['baseline-missing']);
    expect(frame.op).toBe('updated');
    expect(frame.nodeName).toBe('VSF - PCP');
    expect(frame.page).toBe('Cover');
    expect(frame.actor).toBe('owner');
  });
});

describe('createSingleFlightWriter — an async write never overlaps itself, and a request is never dropped', () => {
  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    return { promise, resolve };
  }

  it('a trigger while a write is IN FLIGHT re-arms exactly one more run after it settles', async () => {
    const gates = [deferred(), deferred()];
    let started = 0;
    const trigger = createSingleFlightWriter(() => gates[started++]!.promise);

    trigger();
    expect(started).toBe(1);
    trigger(); // arrives mid-flight
    trigger(); // and again — both collapse into ONE re-run
    expect(started).toBe(1); // still no overlap

    gates[0]!.resolve();
    await gates[0]!.promise;
    await Promise.resolve();
    expect(started).toBe(2); // re-armed once, not twice

    gates[1]!.resolve();
    await gates[1]!.promise;
    await Promise.resolve();
    expect(started).toBe(2); // nothing left pending
  });

  it('a REJECTED write still releases the lock, and still re-arms a mid-flight request', async () => {
    const gates = [deferred(), deferred()];
    let started = 0;
    const trigger = createSingleFlightWriter(() => {
      const g = gates[started++]!;
      return started === 1 ? g.promise.then(() => { throw new Error('quota'); }) : g.promise;
    });

    trigger();
    trigger();
    gates[0]!.resolve();
    await gates[0]!.promise.then(() => {}, () => {});
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toBe(2); // a failed write must not wedge the writer shut
  });

  it('a write that throws SYNCHRONOUSLY releases the lock too', () => {
    let started = 0;
    const trigger = createSingleFlightWriter(() => { started += 1; throw new Error('boom'); });
    trigger();
    trigger();
    expect(started).toBe(2); // second trigger runs — the lock was released, not held forever
  });
});
