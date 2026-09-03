// The bounded, sliced page walk — the replacement for `page.findAll(() => true)`.
//
// Why it exists, measured on the owner's 23.7k-node page: `findAll` is ATOMIC (296 ms) and
// materialises the whole tree before the 4 000 cap is applied, so the cap bounded OUTPUT
// and never WORK. A manual DFS that stops at the cap costs 47 ms on the same page. The
// three facts every test here defends:
//   1. the cap bounds VISITS (cap + 1, so "there was more" is knowable), not just records;
//   2. no synchronous chunk exceeds `sliceSize` nodes — that is the visible-stall budget;
//   3. `parentId` comes from the DFS stack, never `node.parent.id` (153 ms/4 000 nodes —
//      the single most expensive property read measured).
// Plus the rule that replaced the global `skipInvisibleInstanceChildren` flag: the walk
// reads the tree the host already has and never writes a global to change what it sees.
import { describe, it, expect, afterEach } from 'vitest';
import {
  normalizeSnapshotCoord, topLevelFingerprint, walkPageBounded, walkPageSliced,
  type NodeSnapshot, type WalkableNode,
} from '../plugin/src/main/page-walk-bounded.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A fixture node carrying BOTH shapes: `children` (what the new walker reads) and
 *  `parent` + a flattened `findAll` (what the old walker read). One tree, two walkers,
 *  so "byte-identical records" is a real comparison rather than two fixtures agreeing. */
interface FixtureNode extends WalkableNode {
  id: string; name: string; type: string;
  x?: number; y?: number; width?: number; height?: number;
  children: FixtureNode[];
  parent: FixtureNode | null;
}

function node(id: string, over: Partial<FixtureNode> = {}, kids: FixtureNode[] = []): FixtureNode {
  const self: FixtureNode = {
    id, name: `Node ${id}`, type: 'FRAME', x: 0, y: 0, width: 100, height: 50,
    children: kids, parent: null, ...over,
  };
  for (const kid of kids) kid.parent = self;
  return self;
}

/** Pre-order DFS — Figma's own "document order", which is what `findAll` returns. */
function flatten(nodes: readonly FixtureNode[]): FixtureNode[] {
  const out: FixtureNode[] = [];
  for (const n of nodes) {
    out.push(n);
    out.push(...flatten(n.children));
  }
  return out;
}

function page(id: string, kids: FixtureNode[]): FixtureNode {
  return node(id, { name: 'Screens', type: 'PAGE' }, kids);
}

/** The PRE-phase walker, verbatim, kept here as the oracle: the new walker's records must
 *  be byte-identical to what shipped, or every stored baseline silently changes meaning. */
function legacySnapshotPage(root: FixtureNode, cap: number): { records: NodeSnapshot[]; truncated: boolean } {
  const all = flatten(root.children);
  const truncated = all.length > cap;
  const records: NodeSnapshot[] = [];
  for (const n of all) {
    if (records.length >= cap) break;
    const hasXY = 'x' in n && 'y' in n;
    records.push({
      id: n.id, name: n.name, type: n.type,
      x: hasXY ? normalizeSnapshotCoord(n.x as number) : 0,
      y: hasXY ? normalizeSnapshotCoord(n.y as number) : 0,
      parent: n.parent ? n.parent.id : null,
    });
  }
  return { records, truncated };
}

/** Drives the generator by hand — the pure half, with no flag and no host. */
/** Drives the generator with the TIME budget frozen out of reach, so every slice count
 *  below is a fact about the node-count cut alone. Without this the walk's own elapsed-time
 *  cut decides these numbers, and it did: 4 001 fixture nodes crossed the 20 ms budget under
 *  full-suite load and turned an exact 9 into a 10. The budget has its own tests, with its
 *  own clock. */
function runPure(root: FixtureNode, cap: number, sliceSize: number) {
  const gen = walkPageBounded(root, { cap, sliceSize, budgetClock: () => 0 });
  let slices = 0;
  let step = gen.next();
  while (!step.done) { slices += 1; step = gen.next(); }
  return { result: step.value, slices: slices + 1, yields: slices };
}

function installFigma(): void {
  (globalThis as any).figma = { skipInvisibleInstanceChildren: false };
}

/** A host whose `skipInvisibleInstanceChildren` REFUSES both read and write — FigJam and
 *  Slides, where the property may not exist at all. Defined rather than spread: spreading
 *  an object with a throwing getter would throw at the fixture, not in the walk. */
function installRefusingFigma(): void {
  const host = {};
  Object.defineProperty(host, 'skipInvisibleInstanceChildren', {
    get: () => { throw new Error('not supported'); },
    set: () => { throw new Error('not supported'); },
  });
  (globalThis as any).figma = host;
}

/** A node with NO `x`/`y` keys at all — what a node type without a position really looks
 *  like. Setting them to `undefined` would leave the keys present, which the old walker's
 *  `'x' in node` test read as "has a position" and normalized into NaN. */
function positionlessNode(id: string): FixtureNode {
  const n = node(id);
  delete (n as Partial<FixtureNode>).x;
  delete (n as Partial<FixtureNode>).y;
  return n;
}

afterEach(() => { delete (globalThis as any).figma; });

describe('walkPageBounded — the cap bounds WORK, not just output', () => {
  /** One top-level frame holding `count` children, each counting its own `name` reads. The
   *  children sit BELOW the top level so the page's own top-level fingerprint (which reads
   *  every direct child once, by design) cannot be mistaken for walk work. */
  function countingPage(count: number): { root: FixtureNode; reads: () => number } {
    let reads = 0;
    const kids = Array.from({ length: count }, (_, i) => {
      const kid = node(`n${i}`);
      Object.defineProperty(kid, 'name', { get: () => { reads += 1; return `Node n${i}`; } });
      return kid;
    });
    return { root: page('p1', [node('root', {}, kids)]), reads: () => reads };
  }

  it('visits at most cap + 1 nodes and reads no further node\'s properties', () => {
    const { root, reads } = countingPage(50);
    const { result } = runPure(root, 10, 5);
    expect(result.visited).toBe(11); // cap + 1: enough to KNOW there was more, never more than that
    // 9 of the 50 children were read (the container took the 10th record slot); the other
    // 41 were never touched at all — the cap bounds WORK, which findAll could not do.
    expect(reads()).toBe(9);
    expect(result.records).toHaveLength(10);
    expect(result.truncated).toBe(true);
  });

  it('a page exactly at the cap is NOT truncated', () => {
    const { result } = runPure(page('p1', Array.from({ length: 10 }, (_, i) => node(`n${i}`))), 10, 5);
    expect(result.visited).toBe(10);
    expect(result.truncated).toBe(false);
    expect(result.records).toHaveLength(10);
  });

  it('an empty page walks in one slice and reports nothing', () => {
    const { result, slices } = runPure(page('p1', []), 10, 5);
    expect(result.records).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(slices).toBe(1);
  });
});

describe('walkPageBounded — no synchronous chunk exceeds sliceSize nodes', () => {
  it('splits the walk into ceil(visited / sliceSize) slices, yielding between each pair', () => {
    const { result, slices, yields } = runPure(page('p1', Array.from({ length: 1_001 }, (_, i) => node(`n${i}`))), 4_000, 500);
    expect(result.visited).toBe(1_001);
    expect(slices).toBe(Math.ceil(1_001 / 500)); // 3
    expect(yields).toBe(slices - 1); // control is handed back between every pair of slices
  });

  it('a walk that ends exactly on a slice boundary does not yield a trailing empty slice', () => {
    const { slices } = runPure(page('p1', Array.from({ length: 1_000 }, (_, i) => node(`n${i}`))), 4_000, 500);
    expect(slices).toBe(2);
  });

  it('the truncation cut is a slice boundary too — a 100k page costs the same as a 4k one', () => {
    const { result, slices } = runPure(page('p1', Array.from({ length: 20_000 }, (_, i) => node(`n${i}`))), 4_000, 500);
    expect(result.visited).toBe(4_001);
    expect(slices).toBe(Math.ceil(4_001 / 500)); // 9 — never 40
  });
});

describe('walkPageBounded — a slice is cut on ELAPSED time, not only on node count', () => {
  /** Per-node cost varies by node TYPE, so a node count is not a time budget: the same 500
   *  nodes measured 45 ms in an isolated probe and 65 ms on a real cold open, where the
   *  walk competes with iframe and socket startup. The clock here advances on each node's
   *  own property read — 5 ms of work per node — which is exactly the shape a count-based
   *  cut cannot see. The children sit BELOW the top level so the page's own fingerprint
   *  (one read, by design) is not mistaken for walk work. */
  function costlyPage(count: number, msPerNode: number): { root: FixtureNode; budgetClock: () => number } {
    let clock = 0;
    const kids = Array.from({ length: count }, (_, i) => {
      const kid = node(`n${i}`);
      Object.defineProperty(kid, 'x', { get: () => { clock += msPerNode; return 0; } });
      return kid;
    });
    const root = node('root');
    Object.defineProperty(root, 'x', { get: () => { clock += msPerNode; return 0; } });
    root.children = kids;
    for (const kid of kids) kid.parent = root;
    return { root: page('p1', [root]), budgetClock: () => clock };
  }

  function runTimed(root: FixtureNode, opts: { cap: number; sliceSize: number; sliceBudgetMs?: number; budgetClock: () => number }) {
    const gen = walkPageBounded(root, opts);
    let yields = 0;
    let step = gen.next();
    while (!step.done) { yields += 1; step = gen.next(); }
    return { result: step.value, yields };
  }

  it('yields every 4 nodes at 5 ms each, thousands of nodes before sliceSize would cut', () => {
    const { root, budgetClock } = costlyPage(12, 5);

    const { result, yields } = runTimed(root, { cap: 4_000, sliceSize: 500, sliceBudgetMs: 20, budgetClock });

    // 13 nodes visited, the budget spent every 4 of them (the page's own fingerprint read
    // costs the first slice one node). A count-based cut would have held the thread for
    // all 13 — 65 ms — because 13 is nowhere near 500.
    expect(result.visited).toBe(13);
    expect(yields).toBe(3);
  });

  it('the same walk with the budget out of reach is cut by node count alone', () => {
    const { root, budgetClock } = costlyPage(12, 5);

    const { result, yields } = runTimed(root, { cap: 4_000, sliceSize: 500, sliceBudgetMs: 10_000, budgetClock });

    expect(result.visited).toBe(13);
    expect(yields).toBe(0); // one synchronous chunk — what shipped before the time budget
  });

  it('an omitted budget still cuts: the default is the one the walk ships with', () => {
    const { root, budgetClock } = costlyPage(12, 5);

    const { yields } = runTimed(root, { cap: 4_000, sliceSize: 500, budgetClock });

    expect(yields).toBe(3);
  });

  it('sliceSize stays the UPPER bound — a cheap node stream is still cut at the count', () => {
    // Nothing advances this clock, so the budget can never be reached: the count is the
    // only cut left, and it is still honoured exactly.
    const { result, yields } = runTimed(
      page('p1', Array.from({ length: 1_001 }, (_, i) => node(`n${i}`))),
      { cap: 4_000, sliceSize: 500, budgetClock: () => 0 },
    );

    expect(result.visited).toBe(1_001);
    expect(yields).toBe(2);
  });
});

describe('walkPageBounded — records identical to the walker this replaces', () => {
  const positionless = positionlessNode('a2');
  positionless.children = [node('a2i', { type: 'VECTOR' })];
  const nested = page('p1', [
    node('a', { x: 10.26, y: 3.1 }, [
      node('a1', { name: 'Child', type: 'TEXT', x: -0.4, y: 99.75 }),
      positionless,
    ]),
    node('b', { name: 'Second', x: 1000, y: 0.25 }),
  ]);
  for (const grand of positionless.children) grand.parent = positionless;

  it('byte-identical to the previous findAll-based walker on the same tree', () => {
    const oracle = legacySnapshotPage(nested, 4_000);
    const { result } = runPure(nested, 4_000, 2);
    expect(JSON.stringify(result.records)).toBe(JSON.stringify(oracle.records));
    expect(result.truncated).toBe(oracle.truncated);
  });

  it('parentId comes from the DFS stack — the walk never reads node.parent', () => {
    const trap = node('a', {}, [node('a1')]);
    Object.defineProperty(trap.children[0]!, 'parent', {
      get: () => { throw new Error('node.parent must never be read — 153 ms per 4 000 nodes'); },
    });
    const { result } = runPure(page('p1', [trap]), 4_000, 500);
    expect(result.records.map((r) => r.parent)).toEqual(['p1', 'a']);
  });

  it('a node without x/y records 0, exactly as the previous walker did', () => {
    const { result } = runPure(page('p1', [positionlessNode('a')]), 4_000, 500);
    expect(result.records[0]).toEqual({ id: 'a', name: 'Node a', type: 'FRAME', x: 0, y: 0, parent: 'p1' });
  });
});

describe('walkPageBounded — a node whose properties refuse to be read', () => {
  it('counts the failure, drops only that node, and finishes the walk', () => {
    const hostile = node('bad');
    Object.defineProperty(hostile, 'name', { get: () => { throw new Error('stale node reference'); } });
    const { result } = runPure(page('p1', [node('a', {}, [hostile, node('c')])]), 4_000, 500);
    expect(result.propertyReadErrors).toBe(1);
    expect(result.records.map((r) => r.id)).toEqual(['a', 'c']); // the walk continued
    expect(result.visited).toBe(3); // the unreadable node still happened, and still counts
  });

  it('a subtree whose children getter throws costs that subtree, not the page', () => {
    const hostile = node('bad');
    Object.defineProperty(hostile, 'children', { get: () => { throw new Error('stale node reference'); } });
    const { result } = runPure(page('p1', [node('a', {}, [hostile, node('c')])]), 4_000, 500);
    expect(result.propertyReadErrors).toBe(1);
    expect(result.records.map((r) => r.id)).toEqual(['a', 'bad', 'c']); // 'bad' itself still read
  });

  it('a PAGE that cannot enumerate its own children is a FAILED walk, not an empty one', () => {
    const broken = page('p1', []);
    Object.defineProperty(broken, 'children', { get: () => { throw new Error('page not loaded'); } });
    expect(() => runPure(broken, 4_000, 500)).toThrow('page not loaded');
  });
});

describe('topLevelFingerprint — the coarse signal a page over the cap still gets', () => {
  it('records id, name, type, position, size and child count per top-level frame', () => {
    const kids = [node('a', { name: 'Hero', x: 10.26, y: 0, width: 320.4, height: 100 }, [node('a1'), node('a2')])];
    expect(topLevelFingerprint(kids)).toEqual([['a', 'Hero', 'FRAME', 10.5, 0, 320.5, 100, 2]]);
  });

  it('a frame whose properties refuse to be read is skipped and counted, never guessed', () => {
    const hostile = node('bad');
    Object.defineProperty(hostile, 'name', { get: () => { throw new Error('stale'); } });
    const errors = { count: 0 };
    const fingerprint = topLevelFingerprint([node('a'), hostile], () => { errors.count += 1; });
    expect(fingerprint.map((f) => f[0])).toEqual(['a']);
    expect(errors.count).toBe(1);
  });
});

describe('walkPageSliced — the walk never changes what the host shows it', () => {
  const hop = () => Promise.resolve();

  /** An INSTANCE that behaves the way Figma's own `skipInvisibleInstanceChildren` makes
   *  one behave: while that global is on, `.children` omits the invisible children. The
   *  walk's only traversal primitive IS `.children`, so a walk that turns the global on
   *  stores a different tree than the one the designer sees. */
  function instanceWithHiddenChild(): FixtureNode {
    const shown = node('shown');
    const hidden = node('hidden');
    const inst = node('inst', { type: 'INSTANCE' }, [shown, hidden]);
    Object.defineProperty(inst, 'children', {
      get: () => ((globalThis as any).figma?.skipInvisibleInstanceChildren === true ? [shown] : [shown, hidden]),
    });
    return inst;
  }

  /** A host that RECORDS every write to the global flag, so "the walk never sets it" is a
   *  fact a test can hold rather than an intention a comment states. */
  function installRecordingFigma(initial: boolean): boolean[] {
    const writes: boolean[] = [];
    let value = initial;
    const host = {};
    Object.defineProperty(host, 'skipInvisibleInstanceChildren', {
      get: () => value,
      set: (v: boolean) => { writes.push(v); value = v; },
    });
    (globalThis as any).figma = host;
    return writes;
  }

  it('a hidden instance child is walked and recorded like any other node', async () => {
    installFigma();

    const walk = await walkPageSliced(page('p1', [instanceWithHiddenChild()]), { cap: 4_000, sliceSize: 500, hop });

    // Both children are in the baseline. Otherwise un-hiding one between sessions reports
    // a node that was never created, and re-hiding it reports a deletion that never
    // happened — plus one for every descendant.
    expect(walk.records.map((r) => r.id)).toEqual(['inst', 'shown', 'hidden']);
  });

  it('never writes the global visibility flag — the tree it records is the tree the host has', async () => {
    const writes = installRecordingFigma(false);

    await walkPageSliced(page('p1', [node('a'), node('b')]), { cap: 4_000, sliceSize: 1, hop });

    expect(writes).toEqual([]);
    expect((globalThis as any).figma.skipInvisibleInstanceChildren).toBe(false);
  });

  it('a host whose globals ALL refuse to be read still completes the walk', async () => {
    installRefusingFigma();

    const walk = await walkPageSliced(page('p1', [node('a')]), { cap: 4_000, sliceSize: 500, hop });

    expect(walk.records.map((r) => r.id)).toEqual(['a']);
  });

  it('a page that cannot enumerate its children REJECTS, rather than reporting an empty page', async () => {
    const broken = page('p1', []);
    Object.defineProperty(broken, 'children', { get: () => { throw new Error('page not loaded'); } });
    installFigma();

    await expect(walkPageSliced(broken, { cap: 4_000, sliceSize: 500, hop })).rejects.toThrow('page not loaded');
  });
});

describe('walkPageSliced — the per-slice timings STATUS reports', () => {
  it('counts the slices and keeps the WORST one, which is the visible-stall budget', async () => {
    installFigma();
    let clock = 0;
    const walk = await walkPageSliced(
      page('p1', Array.from({ length: 5 }, (_, i) => node(`n${i}`))),
      // The budget clock is frozen, so the budget can never trip: this pins the COUNT cut
      // and the slice MEASUREMENTS, without a dependency on how fast the machine is.
      { cap: 4_000, sliceSize: 2, hop: () => Promise.resolve(), now: () => (clock += 7), budgetClock: () => 0 },
    );
    expect(walk.slices).toBe(3);
    expect(walk.maxSliceMs).toBeGreaterThan(0);
    expect(walk.walkMs).toBeGreaterThanOrEqual(walk.maxSliceMs);
    expect(walk.top.map((t) => t[0])).toEqual(['n0', 'n1', 'n2', 'n3', 'n4']);
  });

  it('hops between slices on a real macrotask by default', async () => {
    installFigma();
    const walk = await walkPageSliced(page('p1', [node('a'), node('b')]), { cap: 4_000, sliceSize: 1 });
    expect(walk.slices).toBe(2);
    expect(walk.records).toHaveLength(2);
  });
});
