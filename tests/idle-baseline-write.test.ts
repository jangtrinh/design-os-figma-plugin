// The idle baseline write's orchestration, lifted out of main.ts so it can be driven at
// all: main.ts calls `figma.showUI` at module load, so no test can import it live, and
// the two rules this file exists to hold were provably unverified — mutating either
// (writing EVERY page instead of the dirty ones, clearing the dirty set before claiming
// it) left the whole suite green.
//
// The pure parts each rule depends on are tested elsewhere: `writeBaseline`'s
// `onlyPageIds` contract in edit-gapfill-baseline.test.ts, the page-id resolution that
// marks a page dirty in document-change-capture.test.ts. What was missing is the
// composition — which is all this module is.
import { describe, it, expect } from 'vitest';
import { createIdleBaselineWriter } from '../plugin/src/main/idle-baseline-write.ts';

interface FakePage { id: string }

/** One recorded call to the write, plus the lever that lets a test hold it in flight. */
interface WriteCall {
  pages: readonly FakePage[];
  dirty: string[];
  finish: () => void;
}

function harness(pages: FakePage[] = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }]) {
  const dirtyPageIds = new Set<string>();
  const calls: WriteCall[] = [];
  const seenDuringWrite: string[][] = [];
  const trigger = createIdleBaselineWriter<FakePage>({
    dirtyPageIds,
    pages: () => pages,
    write: (writePages, dirty) => new Promise<void>((resolve) => {
      seenDuringWrite.push([...dirtyPageIds]);
      calls.push({ pages: writePages, dirty: [...dirty].sort(), finish: resolve });
    }),
  });
  return { dirtyPageIds, calls, seenDuringWrite, trigger, pages };
}

/** Lets the single-flight writer's own `.then` re-arm run before the next assertion. */
const settle = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

describe('createIdleBaselineWriter — only the pages an edit actually touched', () => {
  it('hands the write exactly the dirty page ids, never every page', async () => {
    const h = harness();
    h.dirtyPageIds.add('p2');

    h.trigger();
    await settle();

    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.dirty).toEqual(['p2']);
    expect(h.calls[0]!.pages.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']); // every page is CARRIED, one is walked
  });

  it('reads the document\'s pages when the write runs, not when the writer was wired', async () => {
    const pages: FakePage[] = [{ id: 'p1' }];
    const h = harness(pages);
    pages.push({ id: 'late' }); // a page added after wiring
    h.dirtyPageIds.add('late');

    h.trigger();
    await settle();

    expect(h.calls[0]!.pages.map((p) => p.id)).toEqual(['p1', 'late']);
  });

  it('nothing dirty writes nothing at all — an idle window with no edits costs no walk', async () => {
    const h = harness();

    h.trigger();
    await settle();

    expect(h.calls).toEqual([]);
  });
});

describe('createIdleBaselineWriter — an edit arriving DURING the write', () => {
  it('claims and clears the dirty set BEFORE the walk, so the write cannot swallow it', async () => {
    const h = harness();
    h.dirtyPageIds.add('p2');

    h.trigger();
    await settle();

    // Claimed by value and cleared in the same synchronous step: while the write runs, the
    // set is empty and ready to record what arrives next.
    expect(h.seenDuringWrite[0]).toEqual([]);
    expect(h.calls[0]!.dirty).toEqual(['p2']); // and the claim itself did not lose the id
  });

  it('stays dirty for the NEXT write rather than being cleared by this one', async () => {
    const h = harness();
    h.dirtyPageIds.add('p2');
    h.trigger();
    await settle();

    h.dirtyPageIds.add('p3'); // an edit lands while the first write is still in flight
    h.trigger();
    h.calls[0]!.finish();
    await settle();

    expect(h.calls.map((c) => c.dirty)).toEqual([['p2'], ['p3']]);
  });

  it('two triggers during one write collapse into a single re-run', async () => {
    const h = harness();
    h.dirtyPageIds.add('p1');
    h.trigger();
    await settle();

    h.dirtyPageIds.add('p2');
    h.trigger();
    h.trigger();
    h.calls[0]!.finish();
    await settle();

    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.dirty).toEqual(['p2']);
  });

  it('a REJECTED write releases the lock — the next idle window still writes', async () => {
    const dirtyPageIds = new Set<string>();
    const dirtyPerCall: string[][] = [];
    let fail = true;
    const trigger = createIdleBaselineWriter<FakePage>({
      dirtyPageIds,
      pages: () => [{ id: 'p1' }],
      write: async (_pages, dirty) => {
        dirtyPerCall.push([...dirty]);
        if (fail) { fail = false; throw new Error('quota'); }
      },
    });

    dirtyPageIds.add('p1');
    trigger();
    await settle();
    dirtyPageIds.add('p1');
    trigger();
    await settle();

    expect(dirtyPerCall).toEqual([['p1'], ['p1']]);
  });
});
