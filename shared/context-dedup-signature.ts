// The subtree signature machinery behind `refs.templates`: turn the flat breadth-first
// `nodes[]` list back into a tree, then give every subtree a key that means "identical
// content" and nothing looser.
//
// Two rules live here rather than in the folding step, because both are about what may be
// COMPARED at all:
//
//   1. The signature covers every emitted field EXCEPT `id`, `name`, `parentId` and `depth`,
//      plus the ordered signatures of the children. `name` is excluded on purpose — 40 rows
//      named "Row 1"…"Row 40" with identical content are the case templating pays for — which
//      is precisely why the folding step has to carry every node's real name back per
//      occurrence.
//   2. A subtree that contains a record which cannot carry an identity is POISONED and can
//      never match anything. The minimal `{id, readError}` record a refused identity read
//      ships has no name, no parentId and no depth; a template claiming to restore them would
//      be inventing them. A poisoned child poisons its ancestors, because a subtree is only
//      foldable when all of it is addressable.
//
// Signatures are interned against their canonical content, so two subtrees whose hashes
// collide land on two different keys. A shared template must mean identical content, never
// merely equal hash.
import { canonicalContent } from './canonical-content-hash.ts';
import { createInterner, type HashFn } from './context-dedup-literals.ts';

type Record_ = Record<string, unknown>;

/** The fields an occurrence owns, and which therefore never enter a signature. */
const PER_OCCURRENCE = ['id', 'name', 'parentId', 'depth'] as const;

/** A poisoned signature is prefixed with a character the interner can never produce (its
 *  keys are base36 plus `#n`), so uniqueness needs no extra bookkeeping. */
const POISON = '!';

export const isPoisoned = (sig: string): boolean => sig.startsWith(POISON);

export interface Slot {
  record: Record_;
  /** Index in the RAW `nodes[]` list. Carried per occurrence as `at` so the folding step can
   *  put a removed descendant back exactly where it was. */
  at: number;
  id: string;
  parentId: string | null;
  depth: number;
  children: number[];
  /** Slot index of the parent within this reply, or `null` for a root of what we can see. */
  parentIndex: number | null;
  addressable: boolean;
  sig: string;
  size: number;
}

/** A record is addressable when a template could honestly put its identity back: a unique
 *  nonempty id, a string name, a numeric depth, and a parent link that is present and is
 *  either an id or an explicit `null` root marker. */
function addressable(record: Record_, id: string, duplicated: boolean): boolean {
  if (duplicated || id === '') return false;
  if (typeof record.name !== 'string') return false;
  if (typeof record.depth !== 'number') return false;
  if (!('parentId' in record)) return false;
  return record.parentId === null || typeof record.parentId === 'string';
}

export function buildSlots(nodes: readonly Record_[]): { slots: Slot[]; roots: number[] } {
  const idCounts = new Map<string, number>();
  for (const record of nodes) {
    if (typeof record.id === 'string' && record.id !== '') {
      idCounts.set(record.id, (idCounts.get(record.id) ?? 0) + 1);
    }
  }
  const slots: Slot[] = nodes.map((record, at) => {
    const id = typeof record.id === 'string' ? record.id : '';
    return {
      record,
      at,
      id,
      parentId: typeof record.parentId === 'string' ? record.parentId : null,
      depth: typeof record.depth === 'number' ? record.depth : 0,
      children: [],
      parentIndex: null,
      addressable: addressable(record, id, (idCounts.get(id) ?? 0) > 1),
      sig: '',
      size: 1,
    };
  });
  const byId = new Map<string, number>();
  slots.forEach((slot, i) => { if (slot.addressable) byId.set(slot.id, i); });
  const roots: number[] = [];
  slots.forEach((slot, i) => {
    const parent = slot.parentId === null ? undefined : byId.get(slot.parentId);
    // A record whose parent is not in this reply is a root of what we can see. That is the
    // normal case for the walk's target, and the honest case for a record whose parent the
    // budget dropped: it is treated as its own tree rather than silently orphaned.
    if (parent === undefined) roots.push(i);
    else { slots[parent].children.push(i); slot.parentIndex = parent; }
  });
  return { slots, roots };
}

/** Post-order, iteratively: a page can be hundreds of levels deep and a recursive signature
 *  pass would put that depth on the JS stack inside the designer's plugin. */
export function computeSignatures(slots: Slot[], roots: readonly number[], hash: HashFn): void {
  const interner = createInterner(hash);
  const stack: { at: number; expanded: boolean }[] = roots.map((at) => ({ at, expanded: false }));
  while (stack.length > 0) {
    const frame = stack.pop() as { at: number; expanded: boolean };
    const slot = slots[frame.at];
    if (!frame.expanded) {
      stack.push({ at: frame.at, expanded: true });
      for (let i = slot.children.length - 1; i >= 0; i -= 1) {
        stack.push({ at: slot.children[i], expanded: false });
      }
      continue;
    }
    slot.size = 1 + slot.children.reduce((sum, child) => sum + slots[child].size, 0);
    if (!slot.addressable || slot.children.some((child) => isPoisoned(slots[child].sig))) {
      slot.sig = `${POISON}${frame.at}`;
      continue;
    }
    const shape: Record_ = { ...slot.record };
    for (const field of PER_OCCURRENCE) delete shape[field];
    slot.sig = interner.intern(`${canonicalContent(shape)}|${slot.children.map((c) => slots[c].sig).join(',')}`);
  }
}

/** Structural breadth-first order within a subtree: root, then its children in order, then
 *  theirs. Identical subtrees therefore number their nodes identically, which is what lets
 *  one occurrence's `rootMap` line up with another's. Raw list position is NOT used for
 *  numbering — it is carried per occurrence as `at` instead. */
export function subtreeOrder(slots: readonly Slot[], root: number): number[] {
  const order: number[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const at = queue.shift() as number;
    order.push(at);
    for (const child of slots[at].children) queue.push(child);
  }
  return order;
}
