// The page walk gap-fill runs on every page, at boot and on every idle refresh — bounded
// in WORK and sliced so it can never hold the plugin's single thread long enough to be seen
// as a stall.
//
// It replaces `page.findAll(() => true)`. Measured on the owner's 23.7k-node page:
//   · `findAll(() => true)` — 296 ms, and ATOMIC: it materialises the whole tree before the
//     4 000 cap is applied, so the cap bounded the OUTPUT and never the WORK. A page of
//     80 000 nodes paid for 80 000 while storing 4 000.
//   · a manual DFS that STOPS at the cap — 47 ms on the same page. Same records.
//   · property reads per 4 000 nodes: id 1 ms · type 1 · name 60 · x 45 · y 48 ·
//     **parent.id 153**. So `parentId` comes off the DFS stack; `node.parent` is never read.
//   · per-node cost therefore varies by node TYPE and by what else the host is doing, which
//     is why a slice is cut on ELAPSED TIME with the node count as an upper bound — see
//     `PageWalkOptions.sliceBudgetMs`.
//   · `skipInvisibleInstanceChildren` is deliberately NOT used — see `walkPageSliced`.
//
// Split the same way the rest of gap-fill is: `walkPageBounded` is a PURE generator over an
// injected node shape (no figma access, driven directly in tests), and `walkPageSliced` is
// the runner that owns the macrotask hop and the timings.

/** The only node surface the walk touches. Deliberately structural: a real `SceneNode`
 *  satisfies it, and so does a plain fixture object, so the walk is testable without a
 *  sandbox. Every field beyond the identity trio is optional — a node type without `x`
 *  records 0, exactly as the walker this replaces did. */
export interface WalkableNode {
  id: string;
  name: string;
  type: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  children?: readonly WalkableNode[];
}

/** One node as gap-fill records it: existence, name and position only. */
export interface NodeSnapshot {
  id: string;
  name: string;
  type: string;
  x: number;
  y: number;
  parent: string | null;
}

/** `[id, name, type, x, y, width, height, childCount]` — one TOP-LEVEL frame of a page.
 *  O(top-level) to build (8–458 entries per page on the owner's file, sub-ms), and the only
 *  signal a page over the node cap gets: without it a truncated page's whole diff is
 *  suppressed and a closed-window edit there vanishes silently. */
export type TopLevelRecord = [string, string, string, number, number, number, number, number];

/** Rounds to 0.5px — a sub-pixel re-layout must not churn the baseline or spuriously
 *  report a "moved" node between two sessions. */
export function normalizeSnapshotCoord(n: number): number {
  return Math.round(n * 2) / 2;
}

/** An absent coordinate/size records 0 rather than a guess — the same answer the previous
 *  `'x' in node` test produced for a node type that has no position. */
function coord(value: number | undefined): number {
  return typeof value === 'number' ? normalizeSnapshotCoord(value) : 0;
}

/**
 * The top-level fingerprint of one page. Each entry is read inside its own guard: a frame
 * whose properties refuse to be read (a stale node reference, or a host that refuses the
 * read) is SKIPPED and reported to `onError`, never recorded with invented values — an absent entry
 * costs one frame's coverage, a guessed one would report a fake move or resize.
 */
export function topLevelFingerprint(
  children: readonly WalkableNode[],
  // Receives the frame's id when that read itself still works — an unreadable frame is
  // always COUNTED, and named as well whenever naming it is possible.
  onError: (id: string | null) => void = () => {},
): TopLevelRecord[] {
  const top: TopLevelRecord[] = [];
  for (const child of children) {
    try {
      top.push([
        child.id, child.name, child.type,
        coord(child.x), coord(child.y), coord(child.width), coord(child.height),
        child.children ? child.children.length : 0,
      ]);
    } catch {
      onError(readableId(child));
    }
  }
  return top;
}

/** The id of a node whose OTHER properties just threw — itself guarded, because a fully
 *  invalidated reference refuses every read. `null` then, never a guess. */
function readableId(node: WalkableNode): string | null {
  try {
    return typeof node.id === 'string' ? node.id : null;
  } catch {
    return null;
  }
}

/** The slice time budget every caller gets unless it states its own. The plugin's own
 *  walks state it explicitly (`SNAPSHOT_SLICE_BUDGET_MS` re-exports this value), so this is
 *  the fallback for a direct caller — never a second, driftable copy of the number. */
export const DEFAULT_SLICE_BUDGET_MS = 20;

export interface PageWalkOptions {
  /** Maximum nodes VISITED is `cap + 1`: one past the cap is what makes "there was more"
   *  knowable without walking the rest. Records stop at `cap`. */
  cap: number;
  /** The UPPER bound on nodes per synchronous chunk. Not a time budget on its own: per-node
   *  cost varies by node type and by what else the host is doing, so a fixed count buys a
   *  chunk of unknown duration — which is what `sliceBudgetMs` exists to bound. */
  sliceSize: number;
  /** The chunk's TIME budget in ms — the walk yields as soon as this much has elapsed in the
   *  current chunk, whatever the node count. Checked once per node, so the worst chunk is
   *  this budget plus one node's work. Defaults to `DEFAULT_SLICE_BUDGET_MS`. */
  sliceBudgetMs?: number;
  /** The clock the budget is SPENT against, read once per node. Production passes
   *  `Date.now`, whose ≈ µs cost is far below the ≈ 50 µs of work per node it guards.
   *
   *  Deliberately NOT the same seam as `SlicedWalkTiming.now`, which times finished slices
   *  for STATUS: that one is called a fixed handful of times per walk and tests pin it to an
   *  exact stamp SEQUENCE, which a per-node read would consume. One clock for both would
   *  make one of the two impossible to pin. In production they are the same function. */
  budgetClock?: () => number;
}

export interface PageWalkResult {
  records: NodeSnapshot[];
  /** The page holds MORE than `cap` nodes — created/deleted facts past the cut are
   *  unknowable, and saying so is the honest answer. */
  truncated: boolean;
  /** Nodes actually visited (≤ cap + 1). */
  visited: number;
  /** Nodes (and top-level frames) whose properties threw while being read. Counted rather
   *  than silently absent: a stale reference dropping a node would otherwise read as a
   *  deletion in the next session's diff — so gap-fill skips the diff of any page with a
   *  non-zero count here (see gapfill-diff.ts's `resolveBaselinePage`). */
  propertyReadErrors: number;
  /** The ids of those nodes, whenever the id read itself still worked. A SAMPLE, not a
   *  total — `propertyReadErrors` is the authoritative count — carried so the failure can
   *  name nodes instead of leaving "40 nodes dropped" undiagnosable. */
  errorNodeIds: string[];
  top: TopLevelRecord[];
}

/**
 * The walk itself: a pre-order DFS over `page.children`, bounded at `cap + 1` visits and
 * yielding control every `sliceSize` nodes. Pure — no figma access, no timing, no flag.
 *
 * `parentId` is taken from the stack entry that pushed the node, never `node.parent.id`
 * (the most expensive read measured, at 153 ms per 4 000 nodes).
 *
 * A node whose properties throw is counted and skipped; the walk continues. The PAGE's own
 * `children` read is deliberately NOT guarded: a page that cannot enumerate its children
 * has no walk at all, and the caller must see that as a failure (its previous baseline
 * entry then carries forward verbatim) rather than as an empty page, which would read as
 * "every node was deleted".
 */
export function* walkPageBounded(
  page: WalkableNode,
  { cap, sliceSize, sliceBudgetMs = DEFAULT_SLICE_BUDGET_MS, budgetClock = Date.now }: PageWalkOptions,
): Generator<void, PageWalkResult, void> {
  // The top-level fingerprint below is synchronous work in this first chunk, so it is
  // inside the budget rather than free of it.
  let sliceStartedAt = budgetClock();
  const records: NodeSnapshot[] = [];
  let propertyReadErrors = 0;
  const errorNodeIds: string[] = [];
  const noteError = (id: string | null): void => {
    propertyReadErrors += 1;
    if (id !== null) errorNodeIds.push(id);
  };
  const children = page.children ?? [];
  const top = topLevelFingerprint(children, noteError);

  const stack: Array<{ node: WalkableNode; parent: string | null }> = [];
  for (let i = children.length - 1; i >= 0; i -= 1) stack.push({ node: children[i]!, parent: page.id });

  let visited = 0;
  while (stack.length > 0 && visited <= cap) {
    const { node, parent } = stack.pop()!;
    visited += 1;
    try {
      if (records.length < cap) {
        records.push({
          id: node.id, name: node.name, type: node.type,
          x: coord(node.x), y: coord(node.y), parent,
        });
      }
      // Past the cap there is nothing left to record, so descending would only spend
      // reads on nodes no one will look at.
      const kids = visited <= cap ? node.children : undefined;
      if (kids) for (let i = kids.length - 1; i >= 0; i -= 1) stack.push({ node: kids[i]!, parent: node.id });
    } catch {
      noteError(readableId(node));
    }
    // Two cuts, whichever lands first: `sliceSize` bounds the node count and `sliceBudgetMs`
    // bounds the held thread. Time is the one the "no visible stall" target is written in —
    // 500 nodes measured 45 ms in an isolated probe and 65 ms on a real cold open, where the
    // walk competes with iframe and socket startup, so a count alone cannot hold 50 ms.
    // Hand control back BETWEEN slices only: a trailing yield with nothing left to do would
    // buy a macrotask hop for an empty slice.
    if (stack.length > 0 && visited <= cap
      && (visited % sliceSize === 0 || budgetClock() - sliceStartedAt >= sliceBudgetMs)) {
      yield;
      sliceStartedAt = budgetClock();
    }
  }

  return { records, truncated: visited > cap, visited, propertyReadErrors, errorNodeIds, top };
}

/** The injectable half of a sliced walk: the clock the slice timings are measured on and
 *  the hop taken between slices. Separate from the cap/slice budget, which the caller
 *  always owns, so a test can pin timing without restating the budget — and so the numbers
 *  STATUS reports are assertable as exact values rather than "at least zero". */
export interface SlicedWalkTiming {
  /** Injectable so a test can pin the clock; production reads `Date.now`. Times FINISHED
   *  slices for STATUS — the generator spends its own budget on `budgetClock`, and the two
   *  are separate seams for the reason documented there. */
  now?: () => number;
  /** Forwarded verbatim to the walk generator — see `PageWalkOptions.budgetClock`. Carried
   *  here so a caller that injects walk timing at all can pin BOTH clocks. */
  budgetClock?: () => number;
  /** The between-slices hop. A MACROTASK by default: a microtask would return control to
   *  this walk before the host could paint or deliver an event, which is the whole point. */
  hop?: () => Promise<void>;
}

export interface SlicedPageWalkOptions extends PageWalkOptions, SlicedWalkTiming {}

export interface SlicedPageWalkResult extends PageWalkResult {
  /** Synchronous chunks this walk took — `bootSlices` in STATUS. */
  slices: number;
  /** The WORST synchronous chunk in ms: the number the "no visible stall" target is
   *  actually about. */
  maxSliceMs: number;
  /** Wall-clock across the whole walk, hops included. */
  walkMs: number;
}

/**
 * Runs one page's walk as a sequence of synchronous slices, hopping the host's macrotask
 * queue between them and timing each one. The slices are cut inside the generator (by
 * elapsed time, with the node count as an upper bound); this runner owns only the hop and
 * the measurements STATUS reports.
 *
 * It sets NO global. An earlier version turned `skipInvisibleInstanceChildren` on for the
 * duration of each slice, because that cuts an UNCAPPED `findAll` 4–5×. Under this capped
 * DFS it does not buy that: measured live on the owner's file, the worst slice was 37 ms
 * WITH the flag and the per-node cost is the same without it — the cap, not the flag, is
 * what bounds the work. What the flag did change was WHICH nodes `.children` returns, and
 * `.children` is this walk's only traversal primitive: hidden instance children were
 * absent from the baseline, so un-hiding one between sessions reported a node as
 * `created` that was never created, and re-hiding it reported that node and every
 * descendant as `deleted`. Toggling sub-layer visibility is daily variant work, so that
 * wrong fact recurred; a speed-up worth 0 ms is not worth it.
 */
export async function walkPageSliced(page: WalkableNode, opts: SlicedPageWalkOptions): Promise<SlicedPageWalkResult> {
  const now = opts.now ?? Date.now;
  const hop = opts.hop ?? (() => new Promise<void>((resolve) => { setTimeout(resolve, 0); }));
  const walk = walkPageBounded(page, opts);
  const startedAt = now();
  let slices = 0;
  let maxSliceMs = 0;
  for (;;) {
    const sliceStartedAt = now();
    const step = walk.next();
    slices += 1;
    const sliceMs = now() - sliceStartedAt;
    if (sliceMs > maxSliceMs) maxSliceMs = sliceMs;
    if (step.done) return { ...step.value, slices, maxSliceMs, walkMs: now() - startedAt };
    await hop();
  }
}
