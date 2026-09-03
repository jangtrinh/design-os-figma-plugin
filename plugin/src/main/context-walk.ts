// The `context` governor: a BREADTH-FIRST, byte-budgeted walk of one node's subtree whose
// reply can always account for itself.
//
// Why breadth-first: an agent writing a component needs the whole skeleton before any leaf
// detail. Depth-first under a budget answers "item 1 in full, items 2-40 absent" — the
// wrong SHAPE of context, and the caller cannot tell that from a small subtree.
//
// Why the budget is spent HERE and not at the CLI: the cost this bounds is `getCSSAsync`,
// ~7-8ms per node measured live, paid inside the plugin. A governor at the CLI boundary
// measures after the money is already spent.
//
// Why the accounting is a law and not a courtesy: every node this walk becomes aware of
// ends in EXACTLY ONE bucket — emitted, budget, deadline or readError — and
// `assertConservation` refuses to return numbers that do not add up. The failure this
// prevents is the one every serializer reaches for first: drop a subtree, return the rest,
// say nothing. A caller cannot ask for what it was never told is missing.
import { utf8ByteLength } from '../../../shared/utf8-byte-length';
import { buildContextRecord, childrenOf, messageOf, type ContextNodeLike } from './context-node-record';
import { safe } from './scan-node-utils';

/** Measured live: `getCSSAsync` costs ~7-8ms per node and `Promise.all` batches of 16 save
 *  only ~12% (the cost is per CALL, not per host round-trip). 16 is kept because that is
 *  where the macrotask hop belongs, not because it is a speed-up. */
export const DEFAULT_CSS_BATCH_SIZE = 16;

/** How many frontier entries travel on the wire. The TOTAL is always reported, so a
 *  capped list never becomes an undercount. */
export const FRONTIER_LIMIT = 50;

/** Why a subtree was not walked. All three mean the same thing to a caller: re-issue
 *  `context <id>` on this id to get it. The cursor is STATELESS — no server-side page
 *  token, nothing to expire, nothing to invalidate when the designer edits. */
export type FrontierReason = 'budget' | 'deadline' | 'depth';

export interface FrontierEntry {
  id: string;
  name: string;
  type: string;
  /** `null` when the node's `children` read REFUSED — an unknown count, never 0. A
   *  frontier entry reading `childCount: 0` is a leaf, and a caller does not re-issue
   *  `context` on a leaf. */
  childCount: number | null;
  reason: FrontierReason;
}

/** Nodes the walk became aware of and did NOT emit. Both buckets have a frontier entry
 *  behind them, so every omission carries its own cursor. A node whose DATA is partial is
 *  not here — it shipped, and is counted in `partial`. */
export interface ContextOmissions {
  /** Nodes the byte budget stopped the walk before. */
  budget: number;
  /** Nodes the soft deadline stopped the walk before. */
  deadline: number;
}

export interface ContextAccounting {
  requestedBytes: number;
  /** Sum of the emitted record sizes, the number the budget decision was made on. Can
   *  exceed `requestedBytes` only via the always-emit-the-root rule below. */
  estimatedBytes: number;
  /** Every node ENQUEUED within the depth bound. Collapsed asset descendants are not
   *  enqueued — they are counted in their parent's `collapsed` instead. */
  visited: number;
  /** ALWAYS `nodes.length`. The one number a caller can check against the array it is
   *  holding — which is why a partial record counts here and not as an omission: on the
   *  wire, "emitted 9, omitted 1" reads as "one node never arrived", and the caller has no
   *  frontier entry for it and re-issues nothing. */
  emitted: number;
  omitted: ContextOmissions;
  /** Records that shipped with an incomplete answer: `cssError`, `mainComponentError`,
   *  `childrenError`, a `collapsed.readErrors > 0`, or a record that could not be built or
   *  serialised at all (which ships as a minimal `{id, readError}`). `complete` is false
   *  whenever this is nonzero. */
  partial: number;
  frontier: FrontierEntry[];
  frontierTotal: number;
  /** `false` on ANY nonzero omission or a nonempty frontier. Never `true` with a count
   *  behind it. */
  complete: boolean;
  walkMs: number;
  /** WALL time spent inside the CSS batches (the sum of per-batch elapsed), so it can
   *  never exceed `walkMs`. Summing per-CALL latencies instead reported 5393ms for a walk
   *  that took 677 — reads as "8x the walk", and is a wrong fact about a batch whose
   *  reads overlapped. The batch also resolves each instance's main component, so this is
   *  the batch's wall time rather than an isolated CSS total. `0` under `--no-css`. */
  cssMs: number;
  /** Synchronous batches, each followed by a macrotask hop — the evidence behind the
   *  "the canvas keeps breathing" claim. */
  batches: number;
}

export interface ContextWalkResult {
  nodes: Record<string, unknown>[];
  accounting: ContextAccounting;
}

export interface ContextWalkOptions {
  budgetBytes: number;
  /** Levels below the requested root. `Number.POSITIVE_INFINITY` = only the budget and the
   *  deadline bound the walk. */
  maxDepth: number;
  /** Absolute time on the injected clock at which to stop expanding. */
  deadlineAt: number;
  includeCss: boolean;
  cssBatchSize?: number;
  /** Injected only by tests that need to observe the per-node reader. */
  buildRecord?: typeof buildContextRecord;
}

export interface ContextWalkDeps {
  now: () => number;
  /** Yields the host's macrotask queue between batches. */
  hop: () => Promise<void>;
}

/**
 * The law: every node the walk became aware of is in exactly one bucket. A violation is a
 * bookkeeping bug, and reporting numbers that do not add up is worse than failing — a
 * caller that trusts a wrong `complete` acts on a tree with silent holes.
 */
export function assertConservation(
  accounting: { visited: number; emitted: number; omitted: ContextOmissions },
): void {
  const { visited, emitted, omitted } = accounting;
  const accounted = emitted + omitted.budget + omitted.deadline;
  if (visited !== accounted) {
    throw new Error(
      `context walk conservation law violated: visited ${visited} !== emitted ${emitted} + `
      + `budget ${omitted.budget} + deadline ${omitted.deadline}`,
    );
  }
}

interface Pending {
  node: ContextNodeLike;
  depth: number;
  parentId: string | null;
  /** Position among its parent's children — the only way to LOCATE a node whose own
   *  identity read refuses. */
  childIndex: number;
}

function childCountOf(node: ContextNodeLike): number | null {
  const read = childrenOf(node);
  return read.refused !== null ? null : read.children.length;
}

/** The id of a node whose record could not be built or serialised. Guarded itself: a fully
 *  invalidated reference refuses even its id, and `''` is then the honest answer. */
function idOf(node: ContextNodeLike, record?: Record<string, unknown>): string {
  const fromRecord = record?.id;
  if (typeof fromRecord === 'string' && fromRecord !== '') return fromRecord;
  const raw = safe(() => node.id);
  return typeof raw === 'string' ? raw : '';
}


export async function walkContext(
  root: ContextNodeLike, deps: ContextWalkDeps, opts: ContextWalkOptions,
): Promise<ContextWalkResult> {
  const build = opts.buildRecord ?? buildContextRecord;
  const batchSize = Math.max(1, opts.cssBatchSize ?? DEFAULT_CSS_BATCH_SIZE);
  const startedAt = deps.now();
  const queue: Pending[] = [{ node: root, depth: 0, parentId: null, childIndex: 0 }];
  const nodes: Record<string, unknown>[] = [];
  const omitted: ContextOmissions = { budget: 0, deadline: 0 };
  const frontier: FrontierEntry[] = [];
  let frontierTotal = 0;
  let visited = 1; // the root, enqueued above
  let partial = 0;
  let estimatedBytes = 0;
  let cssMs = 0;
  let batches = 0;
  let stopped: 'budget' | 'deadline' | null = null;

  const pushFrontier = (node: ContextNodeLike, reason: FrontierReason): void => {
    frontierTotal += 1;
    if (frontier.length >= FRONTIER_LIMIT) return;
    frontier.push({
      id: String(safe(() => node.id) ?? ''),
      name: String(safe(() => node.name) ?? ''),
      type: String(safe(() => node.type) ?? 'UNKNOWN'),
      childCount: childCountOf(node),
      reason,
    });
  };

  while (queue.length > 0) {
    if (deps.now() >= opts.deadlineAt) { stopped = 'deadline'; break; }
    const batch = queue.splice(0, batchSize);
    batches += 1;
    // ONE `Promise.all` per batch: the CSS reads of a batch overlap, and the hop below
    // hands the thread back before the next one. A batch whose tail the budget then drops
    // still paid for its CSS — that cost is real and is reported in `cssMs`, never hidden.
    // The batch's WALL time is what `cssMs` reports, not the sum of the overlapping
    // per-call latencies (which reads as many times the whole walk).
    const batchStartedAt = deps.now();
    const built = await Promise.all(batch.map((pending) => build(pending.node, {
      depth: pending.depth, parentId: pending.parentId, childIndex: pending.childIndex,
      includeCss: opts.includeCss,
      // A reader that refuses ENTIRELY still owes the caller an identified node: a record
      // silently absent from `nodes[]` with no frontier entry is the hole this walk exists
      // to make impossible.
    }).catch((err: unknown) => ({
      record: { id: idOf(pending.node), readError: messageOf(err) } as Record<string, unknown>,
      children: [] as ContextNodeLike[],
      incomplete: true,
    }))));
    if (opts.includeCss) cssMs += deps.now() - batchStartedAt;

    for (let i = 0; i < built.length; i += 1) {
      let result = built[i];
      const pending = batch[i];
      let bytes: number;
      try {
        bytes = utf8ByteLength(JSON.stringify(result.record));
      } catch (err) {
        // Defense in depth behind `jsonSafe`: one record `JSON.stringify` refuses would
        // otherwise take the WHOLE reply down at the wire. It degrades to an identified
        // minimal record, counted partial.
        result = {
          record: { id: idOf(pending.node, result.record), readError: messageOf(err) },
          children: [], incomplete: true,
        };
        bytes = utf8ByteLength(JSON.stringify(result.record));
      }
      // The FIRST record is emitted whatever the budget says. Otherwise `context <id>
      // --budget 1` answers "0 nodes, frontier: [<id>]" and the caller's only cursor move
      // is the call it just made — an infinite loop. The overrun is not hidden: both
      // `requestedBytes` and `estimatedBytes` are reported.
      if (nodes.length > 0 && estimatedBytes + bytes > opts.budgetBytes) {
        for (let j = i; j < batch.length; j += 1) { pushFrontier(batch[j].node, 'budget'); omitted.budget += 1; }
        for (const rest of queue) { pushFrontier(rest.node, 'budget'); omitted.budget += 1; }
        queue.length = 0;
        stopped = 'budget';
        break;
      }
      nodes.push(result.record);
      estimatedBytes += bytes;
      if (result.incomplete) partial += 1;

      if (result.children.length > 0) {
        if (pending.depth + 1 <= opts.maxDepth) {
          const parentId = String(result.record.id ?? '');
          result.children.forEach((child, childIndex) => {
            queue.push({ node: child, depth: pending.depth + 1, parentId, childIndex });
            visited += 1;
          });
        } else {
          // Depth-clipped: the node itself IS emitted, so nothing is omitted — but its
          // subtree is unwalked, which is exactly what the frontier is for.
          pushFrontier(pending.node, 'depth');
        }
      }
    }
    if (stopped !== null) break;
    await deps.hop();
  }

  if (stopped === 'deadline') {
    for (const rest of queue) { pushFrontier(rest.node, 'deadline'); omitted.deadline += 1; }
    queue.length = 0;
  }

  const accounting: ContextAccounting = {
    requestedBytes: opts.budgetBytes,
    estimatedBytes,
    visited,
    emitted: nodes.length,
    omitted,
    partial,
    frontier,
    frontierTotal,
    complete: frontierTotal === 0 && omitted.budget === 0 && omitted.deadline === 0 && partial === 0,
    walkMs: deps.now() - startedAt,
    cssMs,
    batches,
  };
  assertConservation(accounting);
  return { nodes, accounting };
}
