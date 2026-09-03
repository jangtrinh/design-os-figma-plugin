// `context --dedup`: the opt-in post-walk transform, and the honest decision about whether
// to ship it.
//
// Where it runs: in the PLUGIN, after the walk, before the wire. That is where the bytes are
// actually paid for. It is a post-walk step by construction, which is why `--budget`'s
// meaning does not change: the budget bounds the RAW records as they are built
// (`budget.estimatedBytes`), and what the deduped payload costs is reported as
// `budget.finalBytes`. A deduped reply is therefore smaller than a bound the caller already
// agreed to, never larger.
//
// The rule that makes it safe to ship at all is Pitfall 2: **a reduction that reduced nothing
// must never be announced as one.** Both forms are measured; if the deduped one is not
// strictly smaller, the RAW payload goes out with `dedup.applied: false` and a `reason` the
// caller can read. `savedBytes` exists only when it is positive.
import { foldContextLiterals } from './context-dedup-literals.ts';
import { foldContextTemplates } from './context-dedup-templates.ts';
import { utf8ByteLength } from './utf8-byte-length.ts';

type Record_ = Record<string, unknown>;

export interface ContextDedupReport {
  /** Always present once `--dedup` was passed — including when the answer is "no". */
  applied: boolean;
  /** Only when > 0. A zero saving is not a saving. */
  savedBytes?: number;
  /** Records folded into a template occurrence, and therefore no longer in `nodes[]`. Present
   *  whenever `applied` is true — INCLUDING as `0`, when only literal blocks folded. An
   *  omitted counter would make `emitted === nodes.length + foldedNodes` unverifiable exactly
   *  when a reader wants to check it. */
  foldedNodes?: number;
  /** Only when `applied` is false: why the raw form went out instead. */
  reason?: string;
}

export interface ContextDedupResult {
  nodes: Record_[];
  refs: Record_;
  dedup: ContextDedupReport;
}

export interface ContextPayload {
  nodes: readonly Record_[];
  refs: Record_;
}

const measure = (nodes: readonly Record_[], refs: Record_): number => utf8ByteLength(JSON.stringify({ nodes, refs }));

/**
 * The reply-level law, after the transform: every record the walk EMITTED is either still in
 * `nodes[]` or accounted for as folded. Thrown rather than reported, for the same reason
 * `assertConservation` throws in the walk — numbers that do not add up are worse than a
 * failure, because a caller trusting them acts on a tree with silent holes.
 */
export function assertDedupConservation(emitted: number, nodeCount: number, foldedNodes: number): void {
  if (emitted !== nodeCount + foldedNodes) {
    throw new Error(
      `context dedup conservation law violated: emitted ${emitted} !== nodes ${nodeCount} + folded ${foldedNodes}`,
    );
  }
}

const raw = (payload: ContextPayload, reason: string): ContextDedupResult => ({
  nodes: payload.nodes.map((record) => ({ ...record })),
  refs: { ...payload.refs },
  dedup: { applied: false, reason },
});

export function dedupContextPayload(payload: ContextPayload): ContextDedupResult {
  const rawBytes = measure(payload.nodes, payload.refs);
  // Literals first: a template's signature then hashes over the short `cssRef` instead of the
  // whole declaration block, and two subtrees that share their CSS still match either way.
  const literalFold = foldContextLiterals(payload.nodes);
  const templateFold = foldContextTemplates(literalFold.nodes);
  const literalCount = Object.keys(literalFold.literals).length;
  const templateCount = Object.keys(templateFold.templates).length;
  if (literalCount === 0 && templateCount === 0) {
    return raw(payload, 'nothing repeated in this subtree — no literal block and no subtree occurs twice');
  }

  const refs: Record_ = {
    ...payload.refs,
    ...(literalCount > 0 && { literals: literalFold.literals }),
    ...(templateCount > 0 && { templates: templateFold.templates }),
  };
  const finalBytes = measure(templateFold.nodes, refs);
  if (finalBytes >= rawBytes) {
    return raw(payload, `the deduped form was not smaller (${finalBytes} bytes against ${rawBytes})`);
  }
  // Derived from the folding pass itself, then checked against the list it produced: two
  // independent counts that must agree, rather than one number defined as the other.
  assertDedupConservation(payload.nodes.length, templateFold.nodes.length, templateFold.folded);
  return {
    nodes: templateFold.nodes,
    refs,
    dedup: { applied: true, savedBytes: rawBytes - finalBytes, foldedNodes: templateFold.folded },
  };
}
