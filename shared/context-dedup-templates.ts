// `--dedup` step 2: fold REPEATED SUBTREES into `refs.templates[hash]`.
//
// What counts as "the same subtree" is `context-dedup-signature.ts`'s job. This module owns
// the two decisions on top of it:
//
//   - **Which** repeats become templates: the OUTERMOST one wins, and its descendants are not
//     offered again. A signature left with a single surviving occurrence is dropped and its
//     records stay raw — less compression, never a wrong one.
//   - **What an occurrence has to carry back.** Per occurrence: its own id, name, parentId and
//     depth, plus `rootMap` — every descendant's real id, real NAME (excluded from the
//     signature by design) and `at`, its index in the raw breadth-first list. The ruling's
//     literal `{relativeId → realId}` is not enough: an occurrence's descendants are removed
//     from `nodes[]`, so without their positions nothing can put them back, and the
//     round-trip invariant that gates this whole feature would fail.
import { hashCanonical, type HashFn } from './context-dedup-literals.ts';
import { buildSlots, computeSignatures, isPoisoned, subtreeOrder, type Slot } from './context-dedup-signature.ts';

type Record_ = Record<string, unknown>;

/** Per-occurrence identity for one node of a template, keyed by its relative id. */
export interface TemplateNodeIdentity { id: string; name: string; at: number }

export interface ContextTemplate { nodes: Record_[] }

export interface TemplateFoldResult {
  nodes: Record_[];
  /** How many records went INTO a template occurrence and therefore left `nodes[]`. The walk's
   *  `budget.emitted` still counts them, so this is the number that keeps
   *  `emitted === nodes.length + foldedNodes` checkable. `savedBytes` cannot stand in for it:
   *  bytes are not records, and a caller reading `emitted: 9` against five records has no
   *  frontier entry for the other four and would read them as never having arrived. */
  folded: number;
  /** Empty when nothing repeated. The caller adds no `refs.templates` in that case rather
   *  than shipping an empty table. */
  templates: Record<string, ContextTemplate>;
}

/** ≥2 nodes: a one-node "template" is a literal fold with extra indirection. */
const MIN_TEMPLATE_NODES = 2;
/** ≥2 occurrences: one occurrence is strictly bigger deduped than raw. */
const MIN_OCCURRENCES = 2;

/** How many subtrees share each signature — the pre-filter that keeps the candidate pass from
 *  consuming a subtree that occurs only once. */
function countSignatures(slots: readonly Slot[]): Map<string, number> {
  const groups = new Map<string, number>();
  for (const slot of slots) {
    if (!slot.addressable || slot.size < MIN_TEMPLATE_NODES || isPoisoned(slot.sig)) continue;
    groups.set(slot.sig, (groups.get(slot.sig) ?? 0) + 1);
  }
  return groups;
}

/** Pre-order: take the outermost repeated subtree and stop descending into it. */
function collectCandidates(
  slots: readonly Slot[], roots: readonly number[], groups: Map<string, number>,
): Map<string, number[]> {
  const bySig = new Map<string, number[]>();
  const stack = [...roots].reverse();
  while (stack.length > 0) {
    const at = stack.pop() as number;
    const slot = slots[at];
    if (slot.size >= MIN_TEMPLATE_NODES && (groups.get(slot.sig) ?? 0) >= MIN_OCCURRENCES) {
      const list = bySig.get(slot.sig);
      if (list === undefined) bySig.set(slot.sig, [at]);
      else list.push(at);
      continue;
    }
    for (let i = slot.children.length - 1; i >= 0; i -= 1) stack.push(slot.children[i]);
  }
  return bySig;
}

/** The shared structure: relative ids, relative parent links, relative depth, and no `name`. */
function buildTemplate(slots: readonly Slot[], order: readonly number[], root: number): ContextTemplate {
  const relativeOf = new Map<number, string>();
  order.forEach((at, rel) => relativeOf.set(at, String(rel)));
  return {
    nodes: order.map((at, rel) => {
      const shape: Record_ = { ...slots[at].record };
      delete shape.name; // per-occurrence by construction
      shape.id = String(rel);
      const parentIndex = slots[at].parentIndex;
      shape.parentId = rel === 0 || parentIndex === null ? null : (relativeOf.get(parentIndex) ?? null);
      // Relative, so the same template is reusable at any depth; the occurrence supplies the
      // absolute number.
      shape.depth = slots[at].depth - slots[root].depth;
      return shape;
    }),
  };
}

export function foldContextTemplates(
  nodes: readonly Record_[], hash: HashFn = hashCanonical,
): TemplateFoldResult {
  const { slots, roots } = buildSlots(nodes);
  computeSignatures(slots, roots, hash);
  const candidates = collectCandidates(slots, roots, countSignatures(slots));

  const templates: Record<string, ContextTemplate> = {};
  const occurrenceOf = new Map<number, { sig: string; rootMap: Record<string, TemplateNodeIdentity> }>();
  const consumed = new Set<number>();
  for (const [sig, occurrences] of candidates) {
    if (occurrences.length < MIN_OCCURRENCES) continue;
    for (const root of occurrences) {
      const order = subtreeOrder(slots, root);
      const rootMap: Record<string, TemplateNodeIdentity> = {};
      order.forEach((at, rel) => {
        if (rel === 0) return; // the root's own id and name ARE the occurrence record's
        consumed.add(at);
        rootMap[String(rel)] = { id: slots[at].id, name: slots[at].record.name as string, at };
      });
      occurrenceOf.set(root, { sig, rootMap });
      if (templates[sig] === undefined) templates[sig] = buildTemplate(slots, order, root);
    }
  }

  const folded: Record_[] = [];
  for (let at = 0; at < slots.length; at += 1) {
    if (consumed.has(at)) continue;
    const occurrence = occurrenceOf.get(at);
    const slot = slots[at];
    if (occurrence === undefined) { folded.push({ ...slot.record }); continue; }
    folded.push({
      id: slot.id,
      name: slot.record.name as string,
      type: slot.record.type,
      depth: slot.depth,
      parentId: slot.record.parentId,
      templateRef: occurrence.sig,
      rootMap: occurrence.rootMap,
    });
  }
  return { nodes: folded, templates, folded: consumed.size };
}
