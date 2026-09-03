// `--dedup` step 1: fold repeated UNBOUND LITERAL blocks — the `css` object and the `layout`
// object — into `refs.literals[hash]`, leaving `cssRef` / `layoutRef` on the record.
//
// The line this module must not cross: **identity is never content.** `bindings`, `styles`
// and the `refs.variables` / `refs.styles` / `refs.components` tables are not touched here,
// ever. Two named styles holding the same colour (`color/text/primary` and
// `color/border/strong`, both #111) folded into one id is how an agent codes the wrong token;
// the ids stay on their own records and only the resolved literal block is shared.
//
// Sharing a block is safe because the block itself is the whole comparison: two records get
// one `cssRef` only when every declaration is identical, and their `styles`/`bindings` rows
// stay where they were. A VARIABLE-bound declaration additionally carries its own token name
// (`var(--color-text-primary, #111111)` against a literal `#111111`), so those two never even
// hash alike — but that is a bonus, not the guarantee. A PAINT-STYLE-bound fill renders as a
// plain hex with no style name in it, which is exactly why the style id may never be folded
// out of the record.
//
// And a hash is never trusted on its own. Every insert compares the CANONICAL JSON of the
// incoming block against the block already stored under that key; a mismatch takes the next
// suffixed key instead of silently reusing the first. A shared ref therefore always means
// byte-identical content, not equal hash — otherwise dedup would be inventing a fact, which
// is the one thing this repo will not ship.
import { canonicalContent, fnv1aHex } from './canonical-content-hash.ts';

/** The two literal blocks worth folding, and the field each becomes. Nothing else on a
 *  record is a self-contained literal: `bindings`/`styles` are identity, `componentProperties`
 *  and `segments` are per-node by nature, and the scalars are already smaller than a ref. */
const LITERAL_FIELDS = [['css', 'cssRef'], ['layout', 'layoutRef']] as const;

type Block = Record<string, unknown>;

/** The one canonicaliser and the one FNV-1a this repo has, shared with
 *  `supervised-memory.ts` (`shared/canonical-content-hash.ts`). Collision quality does not
 *  have to be cryptographic: the interner below compares canonical content before it reuses a
 *  key, so a collision costs a suffix, never a wrong fact. */
export const hashCanonical = (text: string): string => fnv1aHex(text);

export type HashFn = (canonical: string) => string;

/**
 * Content → key, with collisions resolved by suffix rather than by trust.
 *
 * `intern` answers the key for a canonical string, allocating one on first sight. Exposed
 * because the template signatures need the same guarantee: two different subtrees whose
 * hashes collide must end up under two different keys, or one of them is reported as the
 * other.
 */
export function createInterner(hash: HashFn = hashCanonical): {
  intern: (canonical: string) => string;
  contentOf: (key: string) => string | undefined;
} {
  const byKey = new Map<string, string>();
  const byContent = new Map<string, string>();
  return {
    intern: (canonical: string): string => {
      const existing = byContent.get(canonical);
      if (existing !== undefined) return existing;
      const base = hash(canonical);
      let key = base;
      for (let n = 1; byKey.has(key); n += 1) key = `${base}#${n}`;
      byKey.set(key, canonical);
      byContent.set(canonical, key);
      return key;
    },
    contentOf: (key: string): string | undefined => byKey.get(key),
  };
}

export interface LiteralFoldResult {
  nodes: Record<string, unknown>[];
  /** Empty when nothing repeated — the caller then knows there is no `refs.literals` to add,
   *  rather than shipping an empty table that reads as "dedup ran and found nothing" when it
   *  is indistinguishable from "dedup never ran". */
  literals: Record<string, Block>;
}

const isBlock = (value: unknown): value is Block => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value as Block).length > 0
);

/**
 * Two passes, because a block is only worth a ref once it repeats: pass one counts, pass two
 * rewrites. A single-occurrence block folded into `refs.literals` would grow the payload —
 * the transform would then be paying bytes to look like it saved them.
 */
export function foldContextLiterals(
  nodes: readonly Record<string, unknown>[], hash: HashFn = hashCanonical,
): LiteralFoldResult {
  const counts = new Map<string, number>();
  const firstSeen = new Map<string, Block>();
  const order: string[] = [];
  for (const record of nodes) {
    for (const [field] of LITERAL_FIELDS) {
      const value = record[field];
      if (!isBlock(value)) continue;
      const canonical = canonicalContent(value);
      const seen = counts.get(canonical);
      if (seen === undefined) { counts.set(canonical, 1); firstSeen.set(canonical, value); order.push(canonical); }
      else counts.set(canonical, seen + 1);
    }
  }

  const interner = createInterner(hash);
  const keys = new Map<string, string>();
  const literals: Record<string, Block> = {};
  // First-seen order, so two calls on the same subtree allocate the same keys and the reply
  // stays diffable.
  for (const canonical of order) {
    if ((counts.get(canonical) ?? 0) < 2) continue;
    const key = interner.intern(canonical);
    keys.set(canonical, key);
    literals[key] = firstSeen.get(canonical) as Block;
  }
  if (keys.size === 0) return { nodes: nodes.map((record) => ({ ...record })), literals: {} };

  const folded = nodes.map((record) => {
    const out: Record<string, unknown> = { ...record };
    for (const [field, refField] of LITERAL_FIELDS) {
      const value = out[field];
      if (!isBlock(value)) continue;
      const key = keys.get(canonicalContent(value));
      if (key === undefined) continue;
      delete out[field];
      out[refField] = key;
    }
    return out;
  });
  return { nodes: folded, literals };
}

/**
 * The inverse, shared by the CLI-side `inflate`.
 *
 * Each expanded block is a fresh DEEP COPY, never the table's own object. Handing forty
 * records one shared `css` object means an agent that normalises a declaration on one of them
 * silently rewrites the other thirty-nine — a reply that describes forty nodes would in fact
 * describe one. `JSON` round-trip is the right clone here because every value on this path
 * arrived as JSON off the wire.
 *
 * A ref with no table entry is left ALONE rather than dropped or replaced with an empty
 * object: a missing literal is a broken reply, and silently healing it into `{}` would report
 * "this node has no CSS", a wrong fact.
 */
export function expandContextLiterals(
  nodes: readonly Record<string, unknown>[], literals: Record<string, Block>,
): Record<string, unknown>[] {
  return nodes.map((record) => {
    const out: Record<string, unknown> = { ...record };
    for (const [field, refField] of LITERAL_FIELDS) {
      const key = out[refField];
      if (typeof key !== 'string') continue;
      const block = literals[key];
      if (block === undefined) continue;
      delete out[refField];
      out[field] = JSON.parse(JSON.stringify(block)) as Block;
    }
    return out;
  });
}
