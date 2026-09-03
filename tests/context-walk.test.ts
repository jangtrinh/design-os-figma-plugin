// The `context` governor. Everything asserted here is an HONESTY property, not a feature:
// the reply's own numbers must account for every node the walk became aware of, and the
// cursor it hands back must always make progress. The competitor incident this guards
// against is a serializer that dropped every VECTOR subtree with no notice at all — the
// caller's tree was simply missing branches it had no way to ask about.
import { describe, expect, it, vi } from 'vitest';
import {
  assertConservation, DEFAULT_CSS_BATCH_SIZE, FRONTIER_LIMIT, walkContext,
} from '../plugin/src/main/context-walk.ts';
import { utf8ByteLength } from '../shared/utf8-byte-length.ts';

type Fixture = Record<string, unknown>;

/** A node whose `getCSSAsync` resolves with a fixed declaration block. */
function node(id: string, type: string, children: Fixture[] = [], over: Fixture = {}): Fixture {
  return {
    id, name: `n${id}`, type, visible: true, width: 10, height: 10, x: 0, y: 0,
    children,
    getCSSAsync: async () => ({ display: 'flex', color: 'var(--c, #111)' }),
    ...over,
  };
}

function deps(over: Partial<{ now: () => number; hop: () => Promise<void> }> = {}) {
  return { now: () => 0, hop: async () => {}, ...over };
}

const OPTS = {
  budgetBytes: 1_000_000, maxDepth: Number.POSITIVE_INFINITY, deadlineAt: Number.POSITIVE_INFINITY,
  includeCss: true,
};

const bytesOf = (records: readonly Record<string, unknown>[]): number =>
  records.reduce((sum, r) => sum + utf8ByteLength(JSON.stringify(r)), 0);

/** root → 4 children → 2 grandchildren under the first child. */
function tree(): Fixture {
  return node('0', 'FRAME', [
    node('1', 'FRAME', [node('1a', 'TEXT'), node('1b', 'TEXT')]),
    node('2', 'TEXT'), node('3', 'TEXT'), node('4', 'TEXT'),
  ]);
}

describe('context walk — the complete case', () => {
  it('emits every node breadth-first, and reports complete with no omissions', async () => {
    const out = await walkContext(tree(), deps(), OPTS);
    expect(out.nodes.map((n) => n.id)).toEqual(['0', '1', '2', '3', '4', '1a', '1b']);
    expect(out.accounting.visited).toBe(7);
    expect(out.accounting.emitted).toBe(7);
    expect(out.accounting.omitted).toEqual({ budget: 0, deadline: 0 });
    expect(out.accounting.frontier).toEqual([]);
    expect(out.accounting.frontierTotal).toBe(0);
    expect(out.accounting.complete).toBe(true);
  });

  it('every record names its parent and its depth, so the flat list rebuilds the tree', async () => {
    const out = await walkContext(tree(), deps(), OPTS);
    const byId = new Map(out.nodes.map((n) => [n.id, n]));
    expect(byId.get('0')).toMatchObject({ parentId: null, depth: 0 });
    expect(byId.get('3')).toMatchObject({ parentId: '0', depth: 1 });
    expect(byId.get('1b')).toMatchObject({ parentId: '1', depth: 2 });
  });
});

describe('context walk — the conservation law', () => {
  it('visited === emitted + budget + deadline, and emitted === nodes.length', async () => {
    const asset = node('a', 'FRAME', [
      node('a1', 'TEXT'), node('a2', 'FRAME', [node('a3', 'VECTOR'), node('a4', 'VECTOR')]),
    ], { isAsset: true });
    const rejecting = node('r', 'FRAME', [], {
      getCSSAsync: async () => { throw new Error('css refused'); },
    });
    const root = node('0', 'FRAME', [asset, rejecting, node('2', 'TEXT')]);
    const out = await walkContext(root, deps(), OPTS);
    const { visited, emitted, omitted, partial } = out.accounting;
    expect(visited).toBe(emitted + omitted.budget + omitted.deadline);
    // The one number a caller can CHECK against the array it is holding.
    expect(emitted).toBe(out.nodes.length);
    expect(omitted).toEqual({ budget: 0, deadline: 0 });
    // The asset's 4 descendants are COUNTED, not walked — so they are not "visited".
    expect(visited).toBe(4);
    const collapsed = out.nodes.find((n) => n.id === 'a')?.collapsed;
    expect(collapsed).toEqual({ descendants: 4, types: { TEXT: 1, FRAME: 1, VECTOR: 2 }, readErrors: 0 });
    // A node whose CSS read refused is KEPT, carries the message, and is counted PARTIAL —
    // never as an omission, which would read on the wire as "one of them never arrived".
    expect(partial).toBe(1);
    expect(out.nodes.find((n) => n.id === 'r')?.cssError).toBe('css refused');
    // Nothing was dropped, so the frontier is empty — but the reply is still NOT complete:
    // one node is a partial answer.
    expect(out.accounting.frontier).toEqual([]);
    expect(out.accounting.complete).toBe(false);
  });

  it('counts a refused children read as partial, and its frontier childCount is null', async () => {
    const refusing: Fixture = { id: 'p', name: 'Page 1', type: 'PAGE' };
    Object.defineProperty(refusing, 'children', {
      get() { throw new Error('Cannot access children of an unloaded page'); }, enumerable: true,
    });
    const out = await walkContext(node('0', 'FRAME', [refusing, node('2', 'TEXT')]), deps(), {
      ...OPTS, budgetBytes: 1,
    });
    // Budget 1 keeps only the root, so the refusing page reaches the FRONTIER — where a
    // childCount of 0 would read as a leaf nobody re-issues on.
    expect(out.accounting.frontier[0]).toMatchObject({ id: 'p', childCount: null, reason: 'budget' });
    const full = await walkContext(node('0', 'FRAME', [refusing]), deps(), OPTS);
    expect(full.accounting.partial).toBe(1);
    expect(full.nodes.find((n) => n.id === 'p')?.childrenError)
      .toBe('Cannot access children of an unloaded page');
    expect(full.accounting.complete).toBe(false);
    expect(full.accounting.visited).toBe(full.accounting.emitted);
  });

  it('a record that cannot be built or serialised still ships as a minimal identified node', async () => {
    const poisoned = await walkContext(node('0', 'TEXT'), deps(), {
      ...OPTS,
      buildRecord: async () => ({ record: { id: '0', bad: 1n as unknown }, children: [], incomplete: false }),
    });
    expect(poisoned.nodes).toEqual([{ id: '0', readError: expect.stringMatching(/BigInt|serialise|serialize/i) }]);
    expect(poisoned.accounting).toMatchObject({ visited: 1, emitted: 1, partial: 1, complete: false });

    const rejected = await walkContext(node('0', 'TEXT'), deps(), {
      ...OPTS,
      buildRecord: async () => { throw new Error('record build refused'); },
    });
    expect(rejected.nodes).toEqual([{ id: '0', readError: 'record build refused' }]);
    expect(rejected.accounting).toMatchObject({ visited: 1, emitted: 1, partial: 1, complete: false });
  });

  it('refuses to report accounting that does not add up', () => {
    expect(() => assertConservation({ visited: 5, emitted: 3, omitted: { budget: 1, deadline: 0 } }))
      .toThrow(/conservation/i);
    expect(() => assertConservation({ visited: 4, emitted: 3, omitted: { budget: 1, deadline: 0 } }))
      .not.toThrow();
  });
});

describe('context walk — the byte budget', () => {
  it('stops expanding at the first record that would overrun, and lists what it did not walk', async () => {
    const full = await walkContext(tree(), deps(), OPTS);
    const budgetBytes = bytesOf(full.nodes.slice(0, 3));
    const out = await walkContext(tree(), deps(), { ...OPTS, budgetBytes });
    expect(out.nodes.map((n) => n.id)).toEqual(['0', '1', '2']);
    expect(out.accounting.emitted).toBe(3);
    expect(out.accounting.omitted.budget).toBe(4); // 3, 4 and the two grandchildren
    expect(out.accounting.visited).toBe(7);
    expect(out.accounting.frontier.map((f) => f.id)).toEqual(['3', '4', '1a', '1b']);
    expect(out.accounting.frontier[0]).toEqual({ id: '3', name: 'n3', type: 'TEXT', childCount: 0, reason: 'budget' });
    expect(out.accounting.frontierTotal).toBe(4);
    expect(out.accounting.complete).toBe(false);
    expect(out.accounting.estimatedBytes).toBeLessThanOrEqual(budgetBytes);
  });

  it('a nonzero budget omission always has a frontier entry behind it', async () => {
    const out = await walkContext(tree(), deps(), { ...OPTS, budgetBytes: 1 });
    expect(out.accounting.omitted.budget).toBeGreaterThan(0);
    expect(out.accounting.frontier.some((f) => f.reason === 'budget')).toBe(true);
  });

  it('ALWAYS emits the requested root, over budget or not — a cursor must make progress', async () => {
    const out = await walkContext(tree(), deps(), { ...OPTS, budgetBytes: 1 });
    expect(out.nodes.map((n) => n.id)).toEqual(['0']);
    // The overrun is visible in the numbers rather than hidden: an empty answer whose only
    // frontier entry is the node just asked for would loop the caller forever.
    expect(out.accounting.estimatedBytes).toBeGreaterThan(out.accounting.requestedBytes);
    expect(out.accounting.frontier.map((f) => f.id)).toEqual(['1', '2', '3', '4']);
  });

  it('caps the frontier list at 50 entries but never the total', async () => {
    const wide = node('0', 'FRAME', Array.from({ length: 80 }, (_, i) => node(`c${i}`, 'TEXT')));
    const out = await walkContext(wide, deps(), { ...OPTS, budgetBytes: 1 });
    expect(out.accounting.frontier.length).toBe(FRONTIER_LIMIT);
    expect(out.accounting.frontierTotal).toBe(80);
    expect(out.accounting.omitted.budget).toBe(80);
  });
});

describe('context walk — the soft deadline', () => {
  it('returns a partial WITH counts instead of running into the wire timeout', async () => {
    let clock = 0;
    const out = await walkContext(tree(), deps({ now: () => clock, hop: async () => { clock += 100; } }), {
      ...OPTS, deadlineAt: 50, cssBatchSize: 1,
    });
    expect(out.accounting.omitted.deadline).toBeGreaterThan(0);
    expect(out.accounting.omitted.budget).toBe(0);
    expect(out.accounting.frontier.every((f) => f.reason === 'deadline')).toBe(true);
    expect(out.accounting.complete).toBe(false);
    expect(out.accounting.visited).toBe(out.accounting.emitted + out.accounting.omitted.deadline);
  });
});

describe('context walk — depth', () => {
  it('a depth-clipped node is emitted and its unwalked subtree goes on the frontier', async () => {
    const out = await walkContext(tree(), deps(), { ...OPTS, maxDepth: 1 });
    expect(out.nodes.map((n) => n.id)).toEqual(['0', '1', '2', '3', '4']);
    expect(out.accounting.frontier).toEqual([{ id: '1', name: 'n1', type: 'FRAME', childCount: 2, reason: 'depth' }]);
    expect(out.accounting.omitted).toEqual({ budget: 0, deadline: 0 });
    // Depth clipping omits no VISITED node — but the answer is still not the whole subtree.
    expect(out.accounting.complete).toBe(false);
    expect(out.accounting.visited).toBe(5);
  });

  it('depth 0 answers the requested node alone', async () => {
    const out = await walkContext(tree(), deps(), { ...OPTS, maxDepth: 0 });
    expect(out.nodes.map((n) => n.id)).toEqual(['0']);
    expect(out.accounting.frontier.map((f) => f.reason)).toEqual(['depth']);
  });
});

describe('context walk — cost control', () => {
  it('skips every getCSSAsync call under --no-css', async () => {
    const spies: ReturnType<typeof vi.fn>[] = [];
    const spied = (id: string, type: string, children: Fixture[] = []): Fixture => {
      const getCSSAsync = vi.fn(async () => ({ display: 'flex' }));
      spies.push(getCSSAsync);
      return node(id, type, children, { getCSSAsync });
    };
    const root = spied('0', 'FRAME', [spied('1', 'TEXT'), spied('2', 'TEXT')]);
    const out = await walkContext(root, deps(), { ...OPTS, includeCss: false });
    expect(out.accounting.emitted).toBe(3);
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(0);
    expect(out.accounting.cssMs).toBe(0);
  });

  it('reads CSS in bounded concurrent batches with a hop between them', async () => {
    let inFlight = 0;
    let peak = 0;
    const settle: (() => void)[] = [];
    const batched = (id: string, children: Fixture[] = []): Fixture => node(id, 'TEXT', children, {
      getCSSAsync: () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        return new Promise<Record<string, string>>((resolve) => {
          settle.push(() => { inFlight -= 1; resolve({ display: 'flex' }); });
        });
      },
    });
    const root = batched('0', Array.from({ length: 40 }, (_, i) => batched(`c${i}`)));
    const hop = vi.fn(async () => {});
    let finished = false;
    const walk = walkContext(root, deps({ hop }), { ...OPTS, cssBatchSize: 8 })
      .then((result) => { finished = true; return result; });
    // Settle whatever the walk currently has in flight, one macrotask at a time, so the
    // peak observed above is the walk's own concurrency and not the drainer's.
    for (let guard = 0; guard < 2000 && !finished; guard += 1) {
      await new Promise((resolve) => { setTimeout(resolve, 0); });
      settle.splice(0).forEach((done) => { done(); });
    }
    const out = await walk;
    expect(out.accounting.emitted).toBe(41);
    // `toBe`, not `toBeLessThanOrEqual`: replacing the Promise.all with a sequential
    // `for … await` loop makes peak 1, and a <= assertion would still pass — leaving the
    // one perf regression the design calls out completely uncovered.
    expect(peak).toBe(8);
    // 1 root batch + 40 children in batches of 8 = 6 batches; a hop after each.
    expect(hop.mock.calls.length).toBe(6);
  });

  it('the default CSS batch size is the measured one', () => {
    expect(DEFAULT_CSS_BATCH_SIZE).toBe(16);
  });

  it('reports cssMs as WALL time in the css batches, never the sum of overlapping latencies', async () => {
    // 16 nodes whose CSS reads each take 10ms of HOST latency but all overlap inside one
    // batch. Summing per-call latencies reports 160ms for a batch that took 10 — a number
    // that reads as 8x the whole walk (observed live: cssMs 5393 vs walkMs 677).
    let clock = 0;
    const pending: (() => void)[] = [];
    const slow = (id: string, children: Fixture[] = []): Fixture => node(id, 'TEXT', children, {
      getCSSAsync: () => new Promise<Record<string, string>>((resolve) => {
        pending.push(() => resolve({ display: 'flex' }));
      }),
    });
    const root = slow('0', Array.from({ length: 16 }, (_, i) => slow(`c${i}`)));
    let finished = false;
    const walk = walkContext(root, { now: () => clock, hop: async () => {} }, { ...OPTS, cssBatchSize: 16 })
      .then((result) => { finished = true; return result; });
    for (let guard = 0; guard < 2000 && !finished; guard += 1) {
      await new Promise((resolve) => { setTimeout(resolve, 0); });
      // One batch = one 10ms tick of wall time, however many calls overlapped in it.
      if (pending.length > 0) { clock += 10; pending.splice(0).forEach((done) => { done(); }); }
    }
    const out = await walk;
    expect(out.accounting.emitted).toBe(17);
    expect(out.accounting.cssMs).toBe(20); // two batches: the root, then its 16 children
    expect(out.accounting.cssMs).toBeLessThanOrEqual(out.accounting.walkMs);
  });

  it('spends no css wall time at all under --no-css', async () => {
    let clock = 0;
    const out = await walkContext(tree(), deps({ now: () => clock, hop: async () => { clock += 5; } }), {
      ...OPTS, includeCss: false,
    });
    expect(out.accounting.cssMs).toBe(0);
    expect(out.accounting.walkMs).toBeGreaterThan(0);
  });
});
